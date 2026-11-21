uniform highp float u_intensity;

in vec2 v_coord;
in float v_length;

#pragma maplibre: define highp float weight

#define INV_SQRT2 0.7071067811865476

// Abramowitz and Stegun 7.1.26, accurate to 1.5e-7.
float erf_approx(float x) {
    float a = abs(x);
    float t = 1.0 / (1.0 + 0.3275911 * a);
    float y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-a * a);
    return sign(x) * y;
}

void main() {
    #pragma maplibre: initialize highp float weight

    // The point kernel integrated along the segment, with distances in units of sigma: a Gaussian
    // across the line, times the share of the kernel that falls between the segment's two ends.
    // A long line reaches weight * intensity.
    float across = exp(-0.5 * v_coord.y * v_coord.y);
    float along = 0.5 * (erf_approx((v_length - v_coord.x) * INV_SQRT2) + erf_approx(v_coord.x * INV_SQRT2));

    fragColor = vec4(weight * u_intensity * across * along, 1.0, 1.0, 1.0);

#ifdef OVERDRAW_INSPECTOR
    fragColor = vec4(1.0);
#endif
}
