uniform sampler2D u_image;
uniform highp vec2 u_step;
uniform highp float u_sigma;

in vec2 v_pos;

void main() {
    if (u_sigma < 0.01) {
        fragColor = vec4(texture(u_image, v_pos).r, 1.0, 1.0, 1.0);
        return;
    }

    // One direction of a separable Gaussian; normalised so that a flat area keeps its value.
    int reach = min(int(ceil(3.0 * u_sigma)), 32);
    highp float sum = 0.0;
    highp float total = 0.0;
    for (int i = -reach; i <= reach; i++) {
        float offset = float(i);
        float w = exp(-0.5 * offset * offset / (u_sigma * u_sigma));
        sum += w * texture(u_image, v_pos + offset * u_step).r;
        total += w;
    }

    fragColor = vec4(sum / total, 1.0, 1.0, 1.0);
}
