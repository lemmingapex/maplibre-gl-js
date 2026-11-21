layout(location = 0) in vec2 a_pos;

#pragma maplibre: define highp float weight

void main() {
    #pragma maplibre: initialize highp float weight

#ifdef TERRAIN3D
    gl_Position = projectTileFor3D(a_pos, get_elevation(a_pos));
#else
    gl_Position = projectTile(a_pos, a_pos);
#endif
}
