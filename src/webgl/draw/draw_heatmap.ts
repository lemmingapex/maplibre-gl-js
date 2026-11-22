import {Texture} from '../texture.ts';
import {Color, latest as styleSpec} from '@maplibre/maplibre-gl-style-spec';
import {DepthMode} from '../depth_mode.ts';
import {StencilMode} from '../stencil_mode.ts';
import {ColorMode} from '../color_mode.ts';
import {CullFaceMode} from '../cull_face_mode.ts';
import {
    heatmapUniformValues,
    heatmapTextureUniformValues,
    heatmapLineUniformValues,
    heatmapFillUniformValues,
    heatmapBlurUniformValues
} from '../program/heatmap_program.ts';
import {HEATMAP_FULL_RENDER_FBO_KEY} from '../../style/style_layer/heatmap_style_layer.ts';
import {getCameraMath} from '../../camera/camera_math_factory.ts';
import {pixelsToTileUnits} from '../../source/pixels_to_tile_units.ts';
import {clamp} from '../../util/util.ts';

import type {FrameRenderContext} from '../../render/frame_render_context.ts';
import type {Context} from '../context.ts';
import type {Framebuffer} from '../framebuffer.ts';
import type {Tile} from '../../tile/tile.ts';
import type {Painter} from '../../render/painter.ts';
import type {TileManager} from '../../tile/tile_manager.ts';
import type {HeatmapStyleLayer} from '../../style/style_layer/heatmap_style_layer.ts';
import type {HeatmapBucket} from '../../data/bucket/heatmap_bucket.ts';
import type {OverscaledTileID} from '../../tile/tile_id.ts';

/** How many times smaller than the screen the density texture is with `heatmap-geometry: vertices`. */
const VERTICES_DENSITY_SCALE = 4;

/**
 * How many times smaller than the screen the density texture is with `heatmap-geometry: shapes`:
 * finer than for vertices, so that polygon edges stay sharp when the radius is small.
 */
const SHAPES_DENSITY_SCALE = 2;

/**
 * The spread of the polygon blur in texels of its own textures. Their size is chosen from the
 * radius so that the blur always spans about this many texels, which keeps its cost the same at
 * every radius; the coverage is smooth enough at that point for a coarser texture to lose nothing.
 */
const POLYGON_BLUR_TEXELS = 3;

/** The coarsest the polygon textures get, as a fraction of the screen, unless the blur needs coarser. */
const MAX_POLYGON_SCALE = 16;

/**
 * The widest spread, in texels, that the blur shader reaches 3σ for: it samples at most 32 texels
 * to each side. Past this the polygon textures get coarser rather than the blur getting cut short.
 */
const MAX_POLYGON_BLUR_TEXELS = 10;

/** The radius polygons are blurred with when `heatmap-radius` depends on feature properties. */
const DEFAULT_HEATMAP_RADIUS = styleSpec.paint_heatmap['heatmap-radius'].default;

const POLYGON_COVERAGE_FBO_KEY = 'polygon-coverage';
const POLYGON_BLUR_FBO_KEY = 'polygon-blur';

export function drawHeatmap(painter: Painter, tileManager: TileManager, layer: HeatmapStyleLayer, tileIDs: OverscaledTileID[], frameRenderContext: FrameRenderContext): void {
    if (layer.paint.get('heatmap-opacity') === 0) {
        return;
    }
    const context = frameRenderContext.context;

    if (!layer.drawsShapes()) releasePolygonFramebuffers(layer);

    if (frameRenderContext.terrain && !layer.drawsShapes()) {
        for (const coord of tileIDs) {
            const tile = tileManager.getTile(coord);
            // Skip tiles that have uncovered parents to avoid flickering; we don't need
            // to use complex tile masking here because the change between zoom levels is subtle,
            // so it's fine to simply render the parent until all its 4 children are loaded
            if (tileManager.hasRenderableParent(coord)) continue;
            if (frameRenderContext.currentPass === 'offscreen') {
                prepareHeatmapTerrain(tile, layer, coord, frameRenderContext);
            } else if (frameRenderContext.currentPass === 'translucent') {
                renderHeatmapTerrain(painter, layer, coord, frameRenderContext);
            }
        }
        context.viewport.set([0, 0, painter.width, painter.height]);
    } else {
        if (frameRenderContext.currentPass === 'offscreen') {
            prepareHeatmapFlat(painter, tileManager, layer, tileIDs, frameRenderContext);
        } else if (frameRenderContext.currentPass === 'translucent') {
            renderHeatmapFlat(painter, layer, frameRenderContext);
        }

    }
}

/** Additive blending, which is what turns overlapping kernels into a density. */
function additiveColorMode(context: Context): ColorMode {
    const gl = context.gl;
    return new ColorMode([gl.ONE, gl.ONE], Color.transparent, [true, true, true, true]);
}

/**
 * Returns the tiles to draw and their buckets, leaving out tiles that have a renderable parent:
 * the parent is drawn until all its children are loaded, so nothing is counted twice.
 */
function bucketsToDraw(tileManager: TileManager, layer: HeatmapStyleLayer, coords: OverscaledTileID[]): Array<{coord: OverscaledTileID; tile: Tile; bucket: HeatmapBucket}> {
    const result = [];
    for (const coord of coords) {
        if (tileManager.hasRenderableParent(coord)) continue;
        const tile = tileManager.getTile(coord);
        const bucket = tile.getBucket(layer) as HeatmapBucket;
        if (bucket) result.push({coord, tile, bucket});
    }
    return result;
}

function prepareHeatmapFlat(painter: Painter, tileManager: TileManager, layer: HeatmapStyleLayer, coords: OverscaledTileID[], frameRenderContext: FrameRenderContext) {
    const context = frameRenderContext.context;

    if (layer.drawsShapes()) {
        prepareShapesFlat(painter, tileManager, layer, coords, frameRenderContext);
        context.viewport.set([0, 0, painter.width, painter.height]);
        return;
    }

    bindFramebuffer(context, painter, layer);
    context.clear({color: Color.transparent});
    drawPointKernelsFlat(tileManager, layer, coords, frameRenderContext);

    context.viewport.set([0, 0, painter.width, painter.height]);
}

/** Draws each point (or each vertex, with `heatmap-geometry: vertices`) as a kernel into the bound density texture. */
function drawPointKernelsFlat(tileManager: TileManager, layer: HeatmapStyleLayer, coords: OverscaledTileID[], frameRenderContext: FrameRenderContext) {
    const context = frameRenderContext.context;
    const gl = context.gl;
    const projectedCamera = frameRenderContext.projectedCamera;

    // Allow kernels to be drawn across boundaries, so that
    // large kernels are not clipped to tiles
    const stencilMode = StencilMode.disabled;
    const colorMode = additiveColorMode(context);

    for (const coord of coords) {

        // Skip tiles that have uncovered parents to avoid flickering; we don't need
        // to use complex tile masking here because the change between zoom levels is subtle,
        // so it's fine to simply render the parent until all its 4 children are loaded
        if (tileManager.hasRenderableParent(coord)) continue;

        const tile = tileManager.getTile(coord);
        const bucket: HeatmapBucket = (tile.getBucket(layer) as any);
        if (!bucket) continue;

        const programConfiguration = bucket.programConfigurations.get(layer.id);
        const program = frameRenderContext.useProgram('heatmap', programConfiguration);

        const projectionData = frameRenderContext.getProjectionDataForTile(coord, {applyTerrainMatrix: false});

        const radiusCorrectionFactor = getCameraMath(projectedCamera).getCircleRadiusCorrection(projectedCamera);

        program.draw(context, gl.TRIANGLES, DepthMode.disabled, stencilMode, colorMode, CullFaceMode.backCCW,
            heatmapUniformValues(tile, projectedCamera.zoom, layer.paint.get('heatmap-intensity'), radiusCorrectionFactor),
            frameRenderContext.getTerrainDataForTile(coord), projectionData,
            layer.id, bucket.layoutVertexBuffer, bucket.indexBuffer,
            bucket.segments, layer.paint, projectedCamera.zoom,
            programConfiguration);
    }
}

/**
 * Builds the density texture of a layer with `heatmap-geometry: shapes`: polygons first, because
 * their blur passes use framebuffers of their own and end by adding into the density texture, then
 * lines and points straight into it.
 *
 * The texture is an image of the screen, with or without terrain: every vertex is projected at its
 * elevation, so shapes that cross tiles land where the terrain puts them.
 */
function prepareShapesFlat(painter: Painter, tileManager: TileManager, layer: HeatmapStyleLayer, coords: OverscaledTileID[], frameRenderContext: FrameRenderContext) {
    const context = frameRenderContext.context;
    const width = Math.ceil(painter.width / SHAPES_DENSITY_SCALE);
    const height = Math.ceil(painter.height / SHAPES_DENSITY_SCALE);
    const density = layerFramebuffer(context, layer, HEATMAP_FULL_RENDER_FBO_KEY, width, height);
    useFramebuffer(context, density);
    context.clear({color: Color.transparent});

    const buckets = bucketsToDraw(tileManager, layer, coords);
    drawPolygonDensityFlat(painter, layer, buckets, density, frameRenderContext);

    useFramebuffer(context, density);
    drawLineKernels(layer, buckets, frameRenderContext);
    drawPointKernelsFlat(tileManager, layer, coords, frameRenderContext);
}

/**
 * Returns the radius, in pixels, that polygons are blurred with. Polygons are blurred once for the
 * whole layer, so a radius that depends on feature properties gives way to its default.
 */
function polygonBlurRadius(layer: HeatmapStyleLayer): number {
    return layer.paint.get('heatmap-radius').constantOr(DEFAULT_HEATMAP_RADIUS);
}

/**
 * Returns the polygon blur's spread in screen pixels: a third of the radius, as for the point kernel.
 *
 * The spread is the same everywhere on the screen, whereas a line or point kernel is sized in tile
 * units and shrinks with distance, so under pitch or on the globe a polygon's edge fades over more
 * of the map towards the horizon than a line of the same radius does.
 */
function polygonBlurSigma(layer: HeatmapStyleLayer, frameRenderContext: FrameRenderContext): number {
    return polygonBlurRadius(layer) / 3 * frameRenderContext.data.pixelRatio;
}

/**
 * Draws polygon coverage into a texture sized from the blur, then blurs it in two passes, the
 * second adding the result into `target`. Each tile holds only its own part of a polygon, so no
 * part is drawn twice.
 */
function drawPolygonDensityFlat(painter: Painter, layer: HeatmapStyleLayer, buckets: ReturnType<typeof bucketsToDraw>, target: Framebuffer, frameRenderContext: FrameRenderContext) {
    const withPolygons = buckets.filter(({bucket}) => bucket.fillSegments.get().length > 0);
    if (!withPolygons.length) {
        releasePolygonFramebuffers(layer);
        return;
    }

    const context = frameRenderContext.context;
    const gl = context.gl;
    const sigma = polygonBlurSigma(layer, frameRenderContext);
    const scale = polygonTextureScale(sigma);
    const width = Math.ceil(painter.width / scale);
    const height = Math.ceil(painter.height / scale);

    const coverage = layerFramebuffer(context, layer, POLYGON_COVERAGE_FBO_KEY, width, height);
    useFramebuffer(context, coverage);
    context.clear({color: Color.transparent});

    const zoom = frameRenderContext.projectedCamera.zoom;
    const intensity = layer.paint.get('heatmap-intensity');
    const colorMode = additiveColorMode(context);
    for (const {coord, bucket} of withPolygons) {
        const programConfiguration = bucket.fillProgramConfigurations.get(layer.id);
        frameRenderContext.useProgram('heatmapFill', programConfiguration).draw(context, gl.TRIANGLES,
            DepthMode.disabled, StencilMode.disabled, colorMode, CullFaceMode.disabled,
            heatmapFillUniformValues(intensity), frameRenderContext.getTerrainDataForTile(coord), frameRenderContext.getProjectionDataForTile(coord, {applyTerrainMatrix: false}),
            layer.id, bucket.fillLayoutVertexBuffer, bucket.fillIndexBuffer, bucket.fillSegments,
            layer.paint, zoom, programConfiguration);
    }

    const blurred = layerFramebuffer(context, layer, POLYGON_BLUR_FBO_KEY, width, height);
    blurPolygonCoverage(painter, layer, coverage, blurred, target, sigma / scale, frameRenderContext);
}

/**
 * Returns how many times smaller than the screen the polygon textures are for a blur of `sigma`
 * screen pixels: about `POLYGON_BLUR_TEXELS` texels per σ, and never so fine that the blur shader
 * falls short of 3σ.
 */
function polygonTextureScale(sigma: number): number {
    const scale = clamp(Math.round(sigma / POLYGON_BLUR_TEXELS), SHAPES_DENSITY_SCALE, MAX_POLYGON_SCALE);
    return Math.max(scale, Math.ceil(sigma / MAX_POLYGON_BLUR_TEXELS));
}

/** Frees the polygon coverage and blur textures, for a frame that draws no polygons. */
function releasePolygonFramebuffers(layer: HeatmapStyleLayer) {
    for (const key of [POLYGON_COVERAGE_FBO_KEY, POLYGON_BLUR_FBO_KEY]) {
        layer.heatmapFbos.get(key)?.destroy();
        layer.heatmapFbos.delete(key);
    }
}

/**
 * Blurs `coverage` in place, horizontally into `scratch` and vertically back, then adds it into
 * `target` with one filtered sample per pixel. `sigma` is in texels of `coverage`. Both blur passes
 * run at the coverage texture's size, which coarsens as the radius grows, so a large radius blurs
 * fewer texels than a small one.
 */
function blurPolygonCoverage(painter: Painter, layer: HeatmapStyleLayer, coverage: Framebuffer, scratch: Framebuffer, target: Framebuffer, sigma: number, frameRenderContext: FrameRenderContext) {
    const context = frameRenderContext.context;
    const gl = context.gl;
    const program = frameRenderContext.useProgram('heatmapBlur');
    const zoom = frameRenderContext.projectedCamera.zoom;

    const pass = (source: Framebuffer, destination: Framebuffer, step: [number, number], passSigma: number, colorMode: Readonly<ColorMode>) => {
        useFramebuffer(context, destination);
        context.activeTexture.set(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, source.colorAttachment.get());
        program.draw(context, gl.TRIANGLES, DepthMode.disabled, StencilMode.disabled, colorMode, CullFaceMode.disabled,
            heatmapBlurUniformValues(0, step, passSigma), null, null,
            layer.id, painter.viewportBuffer, painter.quadTriangleIndexBuffer, painter.viewportSegments, layer.paint, zoom);
    };

    pass(coverage, scratch, [1 / coverage.width, 0], sigma, ColorMode.unblended);
    pass(scratch, coverage, [0, 1 / scratch.height], sigma, ColorMode.unblended);
    pass(coverage, target, [0, 0], 0, additiveColorMode(context));
}

/**
 * Draws each line segment's kernel into the bound density texture. On the globe the shader scales
 * each segment by its own latitude, so the scale passed here carries only the camera's part.
 */
function drawLineKernels(layer: HeatmapStyleLayer, buckets: ReturnType<typeof bucketsToDraw>, frameRenderContext: FrameRenderContext) {
    const context = frameRenderContext.context;
    const gl = context.gl;
    const projectedCamera = frameRenderContext.projectedCamera;
    const pixelScale = getCameraMath(projectedCamera).getPixelScale(projectedCamera);
    const intensity = layer.paint.get('heatmap-intensity');
    const colorMode = additiveColorMode(context);

    for (const {coord, tile, bucket} of buckets) {
        if (!bucket.lineSegments.get().length) continue;

        const programConfiguration = bucket.lineProgramConfigurations.get(layer.id);
        const program = frameRenderContext.useProgram('heatmapLine', programConfiguration);
        const projectionData = frameRenderContext.getProjectionDataForTile(coord, {applyTerrainMatrix: false});
        const extrudeScale = pixelsToTileUnits(tile, 1, projectedCamera.zoom) / pixelScale;

        program.draw(context, gl.TRIANGLES, DepthMode.disabled, StencilMode.disabled, colorMode, CullFaceMode.disabled,
            heatmapLineUniformValues(extrudeScale, intensity),
            frameRenderContext.getTerrainDataForTile(coord), projectionData,
            layer.id, bucket.lineLayoutVertexBuffer, bucket.lineIndexBuffer, bucket.lineSegments,
            layer.paint, projectedCamera.zoom, programConfiguration);
    }
}

function renderHeatmapFlat(painter: Painter, layer: HeatmapStyleLayer, frameRenderContext: FrameRenderContext) {
    const context = frameRenderContext.context;
    const gl = context.gl;

    context.setColorMode(frameRenderContext.colorModeForRenderPass());

    // Here we bind two different textures from which we'll sample in drawing
    // heatmaps: the kernel texture, prepared in the offscreen pass, and a
    // color ramp texture.
    const fbo = layer.heatmapFbos.get(HEATMAP_FULL_RENDER_FBO_KEY);
    if (!fbo) return;
    context.activeTexture.set(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fbo.colorAttachment.get());

    context.activeTexture.set(gl.TEXTURE1);
    const colorRampTexture = getColorRampTexture(context, layer);
    colorRampTexture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);

    frameRenderContext.useProgram('heatmapTexture').draw(context, gl.TRIANGLES,
        DepthMode.disabled, StencilMode.disabled, frameRenderContext.colorModeForRenderPass(), CullFaceMode.disabled,
        heatmapTextureUniformValues(painter, layer, 0, 1), null, null,
        layer.id, painter.viewportBuffer, painter.quadTriangleIndexBuffer,
        painter.viewportSegments, layer.paint, frameRenderContext.projectedCamera.zoom);
}

function prepareHeatmapTerrain(tile: Tile, layer: HeatmapStyleLayer, coord: OverscaledTileID, frameRenderContext: FrameRenderContext) {
    const context = frameRenderContext.context;
    const gl = context.gl;

    const stencilMode = StencilMode.disabled;
    // Turn on additive blending for kernels, which is a key aspect of kernel density estimation formula
    const colorMode = new ColorMode([gl.ONE, gl.ONE], Color.transparent, [true, true, true, true]);

    const bucket: HeatmapBucket = (tile.getBucket(layer) as any);
    if (!bucket) return;

    const tileKey = coord.key;
    let fbo = layer.heatmapFbos.get(tileKey);
    if (!fbo) {
        fbo = createHeatmapFbo(context, tile.tileSize, tile.tileSize);
        layer.heatmapFbos.set(tileKey, fbo);
    }

    context.bindFramebuffer.set(fbo.framebuffer);
    context.viewport.set([0, 0, tile.tileSize, tile.tileSize]);

    context.clear({color: Color.transparent});

    const programConfiguration = bucket.programConfigurations.get(layer.id);
    const program = frameRenderContext.useProgram('heatmap', programConfiguration, !frameRenderContext.data.isRenderingGlobe);

    const projectionData = frameRenderContext.getProjectionDataForTile(tile.tileID);

    const terrainData = frameRenderContext.getTerrainDataForTile(coord);
    program.draw(context, gl.TRIANGLES, DepthMode.disabled, stencilMode, colorMode, CullFaceMode.disabled,
        heatmapUniformValues(tile, frameRenderContext.projectedCamera.zoom, layer.paint.get('heatmap-intensity'), 1.0), terrainData, projectionData,
        layer.id, bucket.layoutVertexBuffer, bucket.indexBuffer,
        bucket.segments, layer.paint, frameRenderContext.projectedCamera.zoom,
        programConfiguration);
}

function renderHeatmapTerrain(painter: Painter, layer: HeatmapStyleLayer, coord: OverscaledTileID, frameRenderContext: FrameRenderContext) {
    const context = frameRenderContext.context;
    const gl = context.gl;
    const projectedCamera = frameRenderContext.projectedCamera;

    context.setColorMode(frameRenderContext.colorModeForRenderPass());

    const colorRampTexture = getColorRampTexture(context, layer);

    // Here we bind two different textures from which we'll sample in drawing
    // heatmaps: the kernel texture, prepared in the offscreen pass, and a
    // color ramp texture.
    const tileKey = coord.key;
    const fbo = layer.heatmapFbos.get(tileKey);
    if (!fbo) return;

    context.activeTexture.set(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fbo.colorAttachment.get());

    context.activeTexture.set(gl.TEXTURE1);
    colorRampTexture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);

    const projectionData = frameRenderContext.getProjectionDataForTile(coord, {applyTerrainMatrix: frameRenderContext.data.isRenderingGlobe});

    frameRenderContext.useProgram('heatmapTexture').draw(context, gl.TRIANGLES,
        DepthMode.disabled, StencilMode.disabled, frameRenderContext.colorModeForRenderPass(), CullFaceMode.disabled,
        heatmapTextureUniformValues(painter, layer, 0, 1), null, projectionData,
        layer.id, painter.rasterBoundsBuffer, painter.quadTriangleIndexBuffer,
        painter.rasterBoundsSegments, layer.paint, projectedCamera.zoom);

    // destroy the FBO after rendering
    fbo.destroy();
    layer.heatmapFbos.delete(tileKey);
}

function bindFramebuffer(context: Context, painter: Painter, layer: HeatmapStyleLayer) {
    const gl = context.gl;
    context.activeTexture.set(gl.TEXTURE1);

    // Use a 4x downscaled screen texture for better performance
    const width = painter.width / VERTICES_DENSITY_SCALE;
    const height = painter.height / VERTICES_DENSITY_SCALE;
    context.viewport.set([0, 0, width, height]);

    let fbo = layer.heatmapFbos.get(HEATMAP_FULL_RENDER_FBO_KEY);

    if (fbo && (fbo.width !== width || fbo.height !== height)) {
        fbo.destroy();
        fbo = undefined;
    }

    if (!fbo) {
        fbo = createHeatmapFbo(context, width, height);
        layer.heatmapFbos.set(HEATMAP_FULL_RENDER_FBO_KEY, fbo);
    } else {
        gl.bindTexture(gl.TEXTURE_2D, fbo.colorAttachment.get());
        context.bindFramebuffer.set(fbo.framebuffer);
    }
}

/** Returns the layer's framebuffer under `key`, creating it, or replacing one of another size. */
function layerFramebuffer(context: Context, layer: HeatmapStyleLayer, key: string, width: number, height: number): Framebuffer {
    let fbo = layer.heatmapFbos.get(key);
    if (fbo?.width === width && fbo.height === height) return fbo;

    fbo?.destroy();
    fbo = createHeatmapFbo(context, width, height);
    layer.heatmapFbos.set(key, fbo);
    return fbo;
}

function useFramebuffer(context: Context, fbo: Framebuffer) {
    context.bindFramebuffer.set(fbo.framebuffer);
    context.viewport.set([0, 0, fbo.width, fbo.height]);
}

function createHeatmapFbo(context: Context, width: number, height: number): Framebuffer {
    const gl = context.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, width, height);

    const fbo = context.createFramebuffer(width, height, false, false);
    fbo.colorAttachment.set(texture);

    return fbo;
}

function getColorRampTexture(context: Context, layer: HeatmapStyleLayer): Texture {
    layer.colorRampTexture ||= new Texture(context, layer.colorRamp, context.gl.RGBA);
    return layer.colorRampTexture;
}
