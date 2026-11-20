import {Texture} from '../texture.ts';
import {Color} from '@maplibre/maplibre-gl-style-spec';
import {DepthMode} from '../depth_mode.ts';
import {StencilMode} from '../stencil_mode.ts';
import {ColorMode} from '../color_mode.ts';
import {CullFaceMode} from '../cull_face_mode.ts';
import {
    fillHeatmapUniformValues,
    fillHeatmapTextureUniformValues
} from '../program/fill_heatmap_program.ts';

import type {FrameRenderContext} from '../../render/frame_render_context.ts';
import type {Context} from '../context.ts';
import type {Framebuffer} from '../framebuffer.ts';
import type {Painter} from '../../render/painter.ts';
import type {TileManager} from '../../tile/tile_manager.ts';
import type {FillHeatmapStyleLayer} from '../../style/style_layer/fill_heatmap_style_layer.ts';
import type {FillHeatmapBucket} from '../../data/bucket/fill_heatmap_bucket.ts';
import type {OverscaledTileID} from '../../tile/tile_id.ts';

/** How much smaller than the screen the offscreen density textures are, which also widens the blur. */
const scaleFactor = 1.5;

/**
 * Draws a fill heatmap in three steps. The offscreen pass adds every polygon into the first
 * framebuffer, so each pixel holds the number of polygons covering it. The translucent pass then
 * blurs that count horizontally into the second framebuffer, and blurs it vertically onto the map
 * while mapping it through `fill-heatmap-color`.
 */
export function drawFillHeatmap(painter: Painter, tileManager: TileManager, layer: FillHeatmapStyleLayer, coords: OverscaledTileID[], frameRenderContext: FrameRenderContext): void {
    if (layer.paint.get('fill-heatmap-opacity') === 0) return;

    const context = frameRenderContext.context;

    if (frameRenderContext.currentPass === 'offscreen') {
        bindFramebuffer(context, painter, layer, 0);

        context.clear({color: Color.transparent});
        frameRenderContext.clearStencil();
        frameRenderContext.renderTileClippingMasks(layer, coords);

        drawFillTiles(tileManager, layer, coords, frameRenderContext);

        context.viewport.set([0, 0, painter.width, painter.height]);
    } else if (frameRenderContext.currentPass === 'translucent') {
        bindFramebuffer(context, painter, layer, 1);

        context.clear({color: Color.transparent});
        context.setColorMode(frameRenderContext.colorModeForRenderPass());

        renderTexture(painter, layer, 0, frameRenderContext);

        context.viewport.set([0, 0, painter.width, painter.height]);
        context.bindFramebuffer.set(null);

        renderTexture(painter, layer, 1, frameRenderContext);
    }
}

/**
 * Draws each tile's polygons with additive blending, so that overlapping polygons sum, which is
 * what makes the result a density.
 */
function drawFillTiles(tileManager: TileManager, layer: FillHeatmapStyleLayer, coords: OverscaledTileID[], frameRenderContext: FrameRenderContext) {
    const context = frameRenderContext.context;
    const gl = context.gl;
    const zoom = frameRenderContext.projectedCamera.zoom;
    const colorMode = new ColorMode([gl.ONE, gl.ONE], Color.transparent, [true, true, true, true]);

    for (const coord of coords) {
        const tile = tileManager.getTile(coord);
        const bucket: FillHeatmapBucket = (tile.getBucket(layer) as any);
        if (!bucket) continue;

        const programConfiguration = bucket.programConfigurations.get(layer.id);
        const program = frameRenderContext.useProgram('fillHeatmap', programConfiguration);
        const stencilMode = frameRenderContext.stencilModeForClipping(coord);
        const terrainData = frameRenderContext.getTerrainDataForTile(coord);
        const projectionData = frameRenderContext.getProjectionDataForTile(coord);

        program.draw(context, gl.TRIANGLES, DepthMode.disabled, stencilMode, colorMode, CullFaceMode.disabled,
            fillHeatmapUniformValues([0, 0]), terrainData, projectionData, layer.id, bucket.layoutVertexBuffer, bucket.indexBuffer, bucket.segments,
            layer.paint, zoom, programConfiguration);
    }
}

/**
 * Binds one of the layer's two downscaled framebuffers, creating it on first use. The first holds
 * the summed polygon counts, the second the result of the horizontal blur.
 */
function bindFramebuffer(context: Context, painter: Painter, layer: FillHeatmapStyleLayer, fboId: 0 | 1) {
    const gl = context.gl;
    const width = painter.width / scaleFactor;
    const height = painter.height / scaleFactor;
    context.activeTexture.set(gl.TEXTURE1);
    context.viewport.set([0, 0, width, height]);

    const fbo = layer.heatmapFbos[fboId];
    if (fbo) {
        gl.bindTexture(gl.TEXTURE_2D, fbo.colorAttachment.get());
        context.bindFramebuffer.set(fbo.framebuffer);
        return;
    }

    layer.heatmapFbos[fboId] = createFillHeatmapFbo(context, width, height);
}

/**
 * Creates a half-float framebuffer, so that counts above 1 survive without clamping, with a
 * depth-stencil attachment for the tile clipping masks.
 */
function createFillHeatmapFbo(context: Context, width: number, height: number): Framebuffer {
    const gl = context.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);

    const fbo = context.createFramebuffer(width, height, true, true);
    fbo.depthAttachment.set(context.createRenderbuffer(gl.DEPTH_STENCIL, width, height));
    fbo.colorAttachment.set(texture);
    return fbo;
}

/**
 * Runs one blur pass over the given framebuffer's texture, in the direction the framebuffer's
 * index names: 0 blurs horizontally, 1 blurs vertically and applies the color ramp.
 */
function renderTexture(painter: Painter, layer: FillHeatmapStyleLayer, fboId: 0 | 1, frameRenderContext: FrameRenderContext) {
    const context = frameRenderContext.context;
    const gl = context.gl;

    const fbo = layer.heatmapFbos[fboId];
    if (!fbo) return;
    context.activeTexture.set(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fbo.colorAttachment.get());

    context.activeTexture.set(gl.TEXTURE1);
    layer.colorRampTexture ||= new Texture(context, layer.colorRamp, gl.RGBA);
    layer.colorRampTexture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);

    const limitCount = layer.paint.get('fill-heatmap-limit-count').constantOr(100);
    frameRenderContext.useProgram('fillHeatmapTexture').draw(context, gl.TRIANGLES,
        DepthMode.disabled, StencilMode.disabled, frameRenderContext.colorModeForRenderPass(), CullFaceMode.disabled,
        fillHeatmapTextureUniformValues(painter, layer, 0, 1, scaleFactor, fboId, limitCount), null, null,
        layer.id, painter.viewportBuffer, painter.quadTriangleIndexBuffer,
        painter.viewportSegments, layer.paint, frameRenderContext.projectedCamera.zoom);
}
