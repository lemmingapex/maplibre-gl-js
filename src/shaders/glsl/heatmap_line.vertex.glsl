uniform float u_extrude_scale;
uniform float u_intensity;

layout(location = 0) in vec4 a_segment;
in vec2 a_corner;

out vec2 v_coord;
out float v_length;

#pragma maplibre: define highp float weight
#pragma maplibre: define mediump float radius

// Effective "0" in the kernel density texture, as in heatmap.vertex.glsl: the quad reaches as far
// from the segment as the kernel stays above it.
const highp float ZERO = 1.0 / 255.0 / 16.0;

void main(void) {
    #pragma maplibre: initialize highp float weight
    #pragma maplibre: initialize mediump float radius

    // The kernel is a Gaussian with sigma = radius / 3, in tile units like the point kernel.
    float sigma = radius / 3.0 * u_extrude_scale;
    float reach = sqrt(max(-2.0 * log(ZERO / (weight * u_intensity)), 0.0));

    vec2 start = a_segment.xy;
    vec2 end = a_segment.zw;
    float len = length(end - start);
    vec2 dir = (end - start) / len;
    vec2 normal = vec2(-dir.y, dir.x);

    float along = a_corner.x * len + (a_corner.x * 2.0 - 1.0) * reach * sigma;
    float across = a_corner.y * reach * sigma;
    vec2 pos = start + dir * along + normal * across;

    v_coord = vec2(along, across) / sigma;
    v_length = len / sigma;

    // Extend the segment's slope past its ends, so that both ends sit at their own elevation and
    // the segments of a line meet.
    float startElevation = get_elevation(start);
    float elevation = startElevation + (get_elevation(end) - startElevation) * along / len;

    gl_Position = projectTileFor3D(pos, elevation);
}
