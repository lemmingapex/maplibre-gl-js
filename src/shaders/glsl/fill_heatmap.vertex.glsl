uniform vec2 u_fill_translate;

layout(location = 0) in vec2 a_pos;

void main(void) {
    gl_Position = projectTile(a_pos + u_fill_translate, a_pos);
}
