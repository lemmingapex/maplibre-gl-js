uniform highp float u_intensity;

#pragma maplibre: define highp float weight

void main() {
    #pragma maplibre: initialize highp float weight

    fragColor = vec4(weight * u_intensity, 1.0, 1.0, 1.0);

#ifdef OVERDRAW_INSPECTOR
    fragColor = vec4(1.0);
#endif
}
