import {mat4} from 'gl-matrix';
import {
    Uniform1i,
    Uniform1f,
    Uniform2f,
    UniformMatrix4f
} from '../uniform_binding.ts';

import type {Context} from '../../webgl/context.ts';
import type {UniformValues, UniformLocations} from '../uniform_binding.ts';
import type {Painter} from '../../render/painter.ts';
import type {FillHeatmapStyleLayer} from '../../style/style_layer/fill_heatmap_style_layer.ts';

export type FillHeatmapUniformsType = {
    'u_fill_translate': Uniform2f;
};

export type FillHeatmapTextureUniformsType = {
    'u_matrix': UniformMatrix4f;
    'u_image': Uniform1i;
    'u_color_ramp': Uniform1i;
    'u_opacity': Uniform1f;
    'u_width': Uniform1f;
    'u_height': Uniform1f;
    'u_dir': Uniform1f;
    'u_limit_count': Uniform1f;
};

const fillHeatmapUniforms = (context: Context, locations: UniformLocations): FillHeatmapUniformsType => ({
    'u_fill_translate': new Uniform2f(context, locations.u_fill_translate)
});

const fillHeatmapTextureUniforms = (context: Context, locations: UniformLocations): FillHeatmapTextureUniformsType => ({
    'u_matrix': new UniformMatrix4f(context, locations.u_matrix),
    'u_image': new Uniform1i(context, locations.u_image),
    'u_color_ramp': new Uniform1i(context, locations.u_color_ramp),
    'u_opacity': new Uniform1f(context, locations.u_opacity),
    'u_width': new Uniform1f(context, locations.u_width),
    'u_height': new Uniform1f(context, locations.u_height),
    'u_dir': new Uniform1f(context, locations.u_dir),
    'u_limit_count': new Uniform1f(context, locations.u_limit_count)
});

const fillHeatmapUniformValues = (translate: [number, number]): UniformValues<FillHeatmapUniformsType> => ({
    'u_fill_translate': translate,
});

/**
 * Returns the uniforms for one blur pass over a density texture that is `scaleFactor` times smaller
 * than the drawing buffer. `dir` is 0 for the horizontal pass and 1 for the vertical one, and
 * `limitCount` is the count that maps to the top of the color ramp.
 */
const fillHeatmapTextureUniformValues = (
    painter: Painter,
    layer: FillHeatmapStyleLayer,
    textureUnit: number,
    colorRampUnit: number,
    scaleFactor: number,
    dir: number,
    limitCount: number,
): UniformValues<FillHeatmapTextureUniformsType> => {
    const matrix = mat4.create();
    mat4.ortho(matrix, 0, painter.width, painter.height, 0, 0, 1);

    const gl = painter.context.gl;

    return {
        'u_matrix': matrix,
        'u_image': textureUnit,
        'u_color_ramp': colorRampUnit,
        'u_opacity': layer.paint.get('fill-heatmap-opacity'),
        'u_width': gl.drawingBufferWidth / scaleFactor,
        'u_height': gl.drawingBufferHeight / scaleFactor,
        'u_dir': dir,
        'u_limit_count': limitCount
    };
};

export {
    fillHeatmapUniforms,
    fillHeatmapTextureUniforms,
    fillHeatmapUniformValues,
    fillHeatmapTextureUniformValues
};
