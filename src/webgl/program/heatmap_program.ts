import {mat4} from 'gl-matrix';
import {
    Uniform1i,
    Uniform1f,
    Uniform2f,
    UniformMatrix4f
} from '../uniform_binding.ts';
import {pixelsToTileUnits} from '../../source/pixels_to_tile_units.ts';
import {EXTENT} from '../../data/extent.ts';

import type {Context} from '../../webgl/context.ts';
import type {Tile} from '../../tile/tile.ts';
import type {UniformValues, UniformLocations} from '../uniform_binding.ts';
import type {Painter} from '../../render/painter.ts';
import type {HeatmapStyleLayer} from '../../style/style_layer/heatmap_style_layer.ts';

export type HeatmapUniformsType = {
    'u_extrude_scale': Uniform1f;
    'u_intensity': Uniform1f;
    'u_globe_extrude_scale': Uniform1f;
};

export type HeatmapTextureUniformsType = {
    'u_matrix': UniformMatrix4f;
    'u_image': Uniform1i;
    'u_color_ramp': Uniform1i;
    'u_opacity': Uniform1f;
};

export type HeatmapLineUniformsType = {
    'u_extrude_scale': Uniform1f;
    'u_intensity': Uniform1f;
};

export type HeatmapFillUniformsType = {
    'u_intensity': Uniform1f;
};

export type HeatmapBlurUniformsType = {
    'u_image': Uniform1i;
    'u_step': Uniform2f;
    'u_sigma': Uniform1f;
};

const heatmapUniforms = (context: Context, locations: UniformLocations): HeatmapUniformsType => ({
    'u_extrude_scale': new Uniform1f(context, locations.u_extrude_scale),
    'u_intensity': new Uniform1f(context, locations.u_intensity),
    'u_globe_extrude_scale': new Uniform1f(context, locations.u_globe_extrude_scale)
});

const heatmapTextureUniforms = (context: Context, locations: UniformLocations): HeatmapTextureUniformsType => ({
    'u_matrix': new UniformMatrix4f(context, locations.u_matrix),
    'u_image': new Uniform1i(context, locations.u_image),
    'u_color_ramp': new Uniform1i(context, locations.u_color_ramp),
    'u_opacity': new Uniform1f(context, locations.u_opacity)
});

const heatmapLineUniforms = (context: Context, locations: UniformLocations): HeatmapLineUniformsType => ({
    'u_extrude_scale': new Uniform1f(context, locations.u_extrude_scale),
    'u_intensity': new Uniform1f(context, locations.u_intensity)
});

const heatmapFillUniforms = (context: Context, locations: UniformLocations): HeatmapFillUniformsType => ({
    'u_intensity': new Uniform1f(context, locations.u_intensity)
});

const heatmapBlurUniforms = (context: Context, locations: UniformLocations): HeatmapBlurUniformsType => ({
    'u_image': new Uniform1i(context, locations.u_image),
    'u_step': new Uniform2f(context, locations.u_step),
    'u_sigma': new Uniform1f(context, locations.u_sigma)
});

const heatmapUniformValues = (tile: Tile, zoom: number, intensity: number, radiusCorrectionFactor: number): UniformValues<HeatmapUniformsType> => {
    const pixelRatio = pixelsToTileUnits(tile, 1, zoom);
    // See comment in circle_program.ts
    const globeExtrudeScale = pixelRatio / (EXTENT * Math.pow(2, tile.tileID.overscaledZ)) * 2.0 * Math.PI * radiusCorrectionFactor;
    return {
        'u_extrude_scale': pixelsToTileUnits(tile, 1, zoom),
        'u_intensity': intensity,
        'u_globe_extrude_scale': globeExtrudeScale
    };
};

const heatmapTextureUniformValues = (
    painter: Painter,
    layer: HeatmapStyleLayer,
    textureUnit: number,
    colorRampUnit: number
): UniformValues<HeatmapTextureUniformsType> => {
    const matrix = mat4.create();
    mat4.ortho(matrix, 0, painter.width, painter.height, 0, 0, 1);

    return {
        'u_matrix': matrix,
        'u_image': textureUnit,
        'u_color_ramp': colorRampUnit,
        'u_opacity': layer.paint.get('heatmap-opacity')
    };
};

/**
 * Returns the uniforms of a line's kernel. `extrudeScale` converts pixels to tile units, including
 * any correction the projection needs at the tile, so that lines and points share one kernel size.
 */
const heatmapLineUniformValues = (extrudeScale: number, intensity: number): UniformValues<HeatmapLineUniformsType> => ({
    'u_extrude_scale': extrudeScale,
    'u_intensity': intensity
});

const heatmapFillUniformValues = (intensity: number): UniformValues<HeatmapFillUniformsType> => ({
    'u_intensity': intensity
});

/**
 * Returns the uniforms of one direction of the blur: `step` is one texel of the source texture in
 * the blur's direction, in texture coordinates, and `sigma` the kernel's spread in those texels.
 */
const heatmapBlurUniformValues = (textureUnit: number, step: [number, number], sigma: number): UniformValues<HeatmapBlurUniformsType> => ({
    'u_image': textureUnit,
    'u_step': step,
    'u_sigma': sigma
});

export {
    heatmapUniforms,
    heatmapTextureUniforms,
    heatmapLineUniforms,
    heatmapFillUniforms,
    heatmapBlurUniforms,
    heatmapUniformValues,
    heatmapTextureUniformValues,
    heatmapLineUniformValues,
    heatmapFillUniformValues,
    heatmapBlurUniformValues
};
