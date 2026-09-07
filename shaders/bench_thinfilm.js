// Benchmark variant of shaders/multi_thinfilm.js — raymarched smooth-min SDF
// of the bubble cloud with 6-wavelength thin-film interference.
// Same optical pipeline as the production shader (films at 6 wavelengths,
// filmic gamma, spectral resample to RGB, sigmoid contrast), but:
//   * the SDF is min/smooth-min over all MAXB spheres from uBubbles,
//   * the cube/env lookups use the shared procedural GLSL.env (no textures),
//   * the film thickness is procedural (swirl) instead of a channel lookup.
// MAXB is #defined by js/bench.js to the selected bubble count.
window.BENCH_thinfilm = {
	"id": "bench_thinfilm",
	"src": "multi_thinfilm",
	"title": "raymarched smin + thin-film (6λ)",
	"source": `${GLSL.common}
${GLSL.camera}
${GLSL.env}

#define INTERSECTION_PRECISION 0.01
#define ITERATIONS 20
#define BOUND 7.0
#define DIST_SCALE 0.9

#define DISPERSION 0.05
#define IOR 1.0
#define THICKNESS_SCALE 24.0
#define REFLECTANCE_SCALE 3.0
#define REFLECTANCE_GAMMA_SCALE 2.0
#define FRESNEL_RATIO 0.7
#define SIGMOID_CONTRAST 8.0

#define TWO_PI 6.28318530718
#define WAVELENGTHS 6
#define SMOOTH_K 0.35

float hash (float n) { return fract (sin (n) * 43758.5453); }

float noise (in vec3 x) {
	vec3 p = floor (x);
	vec3 f = fract (x);
	f = f * f * (3.0 - 2.0 * f);
	float n = p.x + p.y * 57.0 + 113.0 * p.z;
	return mix (mix (mix (hash (n +  0.0), hash (n +  1.0), f.x),
	                  mix (hash (n + 57.0), hash (n + 58.0), f.x), f.y),
	            mix (mix (hash (n + 113.0), hash (n + 114.0), f.x),
	                  mix (hash (n + 170.0), hash (n + 171.0), f.x), f.y), f.z);
}

vec3 noise3 (vec3 x) {
	return vec3 (noise (x + vec3 (123.456, 0.567, 0.37)),
	             noise (x + vec3 (0.11, 47.43, 19.17)),
	             noise (x));
}

float smin (float a, float b, float k) {
	float h = max (k - abs (a - b), 0.0) / k;
	return min (a, b) - h * h * k * 0.25;
}

float sdf (vec3 p) {
	vec3 q = 0.1 * (noise3 (p + vec3 (0.0, iTime * 0.1, 0.0)) - 0.5);
	vec3 pp = q + p;
	float d = BIG;
	int nB = min (uCount, MAXB);
	for (int i = 0; i < nB; i++) {
		vec4 sp = uBubbles[i];
		d = smin (d, length (pp - sp.xyz) - sp.w, SMOOTH_K);
	}
	return d;
}

vec3 fresnel (vec3 rd, vec3 norm, vec3 n2) {
	vec3 r0 = pow ((1.0 - n2) / (1.0 + n2), vec3 (2.0));
	return r0 + (1.0 - r0) * pow (clamp (1.0 + dot (rd, norm), 0.0, 1.0), 5.0);
}

vec3 calcNormal (in vec3 pos) {
	const float eps = INTERSECTION_PRECISION;
	const vec3 v1 = vec3 ( 1.0, -1.0, -1.0);
	const vec3 v2 = vec3 (-1.0, -1.0,  1.0);
	const vec3 v3 = vec3 (-1.0,  1.0, -1.0);
	const vec3 v4 = vec3 ( 1.0,  1.0,  1.0);
	return normalize (v1 * sdf (pos + v1 * eps) +
	                  v2 * sdf (pos + v2 * eps) +
	                  v3 * sdf (pos + v3 * eps) +
	                  v4 * sdf (pos + v4 * eps));
}

#define GAMMA_CURVE 50.0
#define GAMMA_SCALE 4.5
vec3 filmic_gamma (vec3 x) { return log (GAMMA_CURVE * x + 1.0) / GAMMA_SCALE; }
vec3 filmic_gamma_inverse (vec3 y) { return (1.0 / GAMMA_CURVE) * (exp (GAMMA_SCALE * y) - 1.0); }

#define GREEN_WEIGHT 2.8
vec3 texCubeSampleWeights (float i) {
	vec3 w = vec3 ((1.0 - i) * (1.0 - i), GREEN_WEIGHT * i * (1.0 - i), i * i);
	return w / dot (w, vec3 (1.0));
}

vec3 sampleCubeMap (vec3 i, vec3 rd) {
	vec3 col = env (rd);
	return vec3 (
		dot (texCubeSampleWeights (i.x), col),
		dot (texCubeSampleWeights (i.y), col),
		dot (texCubeSampleWeights (i.z), col));
}

vec3 sampleCubeMap (vec3 i, vec3 rd0, vec3 rd1, vec3 rd2) {
	vec3 col0 = env (rd0);
	vec3 col1 = env (rd1);
	vec3 col2 = env (rd2);
	return vec3 (
		dot (texCubeSampleWeights (i.x), col0),
		dot (texCubeSampleWeights (i.y), col1),
		dot (texCubeSampleWeights (i.z), col2));
}

vec3 sampleWeights (float i) {
	return vec3 ((1.0 - i) * (1.0 - i), GREEN_WEIGHT * i * (1.0 - i), i * i);
}

vec3 resample (vec3 wl0, vec3 wl1, vec3 i0, vec3 i1) {
	vec3 w0 = sampleWeights (wl0.x);
	vec3 w1 = sampleWeights (wl0.y);
	vec3 w2 = sampleWeights (wl0.z);
	vec3 w3 = sampleWeights (wl1.x);
	vec3 w4 = sampleWeights (wl1.y);
	vec3 w5 = sampleWeights (wl1.z);
	return i0.x * w0 + i0.y * w1 + i0.z * w2
	     + i1.x * w3 + i1.y * w4 + i1.z * w5;
}

vec3 resampleColor (vec3[WAVELENGTHS] rds, vec3 refl0, vec3 refl1, vec3 wl0, vec3 wl1) {
	vec3 cube0 = sampleCubeMap (wl0, rds[0], rds[1], rds[2]);
	vec3 cube1 = sampleCubeMap (wl1, rds[3], rds[4], rds[5]);
	vec3 intensity0 = filmic_gamma_inverse (cube0) + refl0;
	vec3 intensity1 = filmic_gamma_inverse (cube1) + refl1;
	vec3 col = resample (wl0, wl1, intensity0, intensity1);
	return 1.4 * filmic_gamma (col / float (WAVELENGTHS));
}

vec3 resampleColorSimple (vec3 rd, vec3 wl0, vec3 wl1) {
	vec3 cube0 = sampleCubeMap (wl0, rd);
	vec3 cube1 = sampleCubeMap (wl1, rd);
	vec3 intensity0 = filmic_gamma_inverse (cube0);
	vec3 intensity1 = filmic_gamma_inverse (cube1);
	vec3 col = resample (wl0, wl1, intensity0, intensity1);
	return 1.4 * filmic_gamma (col / float (WAVELENGTHS));
}

vec3 iorCurve (vec3 x) { return x; }

vec3 attenuation (float filmThickness, vec3 wavelengths, vec3 normal, vec3 rd) {
	return 0.5 + 0.5 * cos (((THICKNESS_SCALE * filmThickness) / (wavelengths + 1.0)) * dot (normal, rd));
}

vec3 contrast (vec3 x) {
	return 1.0 / (1.0 + exp (-SIGMOID_CONTRAST * (x - 0.5)));
}

void mainImage (out vec4 fragColor, in vec2 fragCoord) {
	vec3 ro, rd;
	camera (fragCoord, ro, rd);

	vec3 wl0 = vec3 (1.0, 0.8, 0.6);
	vec3 wl1 = vec3 (0.4, 0.2, 0.0);
	vec3 iors0 = IOR + iorCurve (wl0) * DISPERSION;
	vec3 iors1 = IOR + iorCurve (wl1) * DISPERSION;

	vec3 pos = ro;
	bool hit = false;
	// uniform bound: keeps the ANGLE/HLSL translation from unrolling the loop
	for (int j = 0; j < uSteps; j++) {
		float t = DIST_SCALE * sdf (pos);
		pos += t * rd;
		hit = t < INTERSECTION_PRECISION;
		if (clamp (pos, -BOUND, BOUND) != pos || hit) break;
	}

	vec3 col;
	if (hit) {
		vec3 normal = calcNormal (pos);
		float filmThickness = 0.2 + 0.1 * swirl (normal * 2.6);

		vec3 att0 = attenuation (filmThickness, wl0, normal, rd);
		vec3 att1 = attenuation (filmThickness, wl1, normal, rd);

		vec3 f0 = (1.0 - FRESNEL_RATIO) + FRESNEL_RATIO * fresnel (rd, normal, 1.0 / iors0);
		vec3 f1 = (1.0 - FRESNEL_RATIO) + FRESNEL_RATIO * fresnel (rd, normal, 1.0 / iors1);

		vec3 rrd = reflect (rd, normal);

		vec3 cube0 = REFLECTANCE_GAMMA_SCALE * att0 * sampleCubeMap (wl0, rrd);
		vec3 cube1 = REFLECTANCE_GAMMA_SCALE * att1 * sampleCubeMap (wl1, rrd);

		vec3 refl0 = REFLECTANCE_SCALE * filmic_gamma_inverse (mix (vec3 (0.0), cube0, f0));
		vec3 refl1 = REFLECTANCE_SCALE * filmic_gamma_inverse (mix (vec3 (0.0), cube1, f1));

		vec3 rds[WAVELENGTHS];
		rds[0] = refract (rd, normal, iors0.x);
		rds[1] = refract (rd, normal, iors0.y);
		rds[2] = refract (rd, normal, iors0.z);
		rds[3] = refract (rd, normal, iors1.x);
		rds[4] = refract (rd, normal, iors1.y);
		rds[5] = refract (rd, normal, iors1.z);

		col = resampleColor (rds, refl0, refl1, wl0, wl1);
	} else {
		col = resampleColorSimple (rd, wl0, wl1);
	}

	fragColor = vec4 (contrast (col), 1.0);
}
`,
	"meta": {
		"arrays": [{ "name": "uBubbles", "type": "vec4", "count": 64, "feed": "bubbles64" }],
		"vars": [
			{ "name": "uCamPos", "type": "vec3", "feed": "camPos" },
			{ "name": "uCamRt", "type": "vec3", "feed": "camRt" },
			{ "name": "uCamUp", "type": "vec3", "feed": "camUp" },
			{ "name": "uCamFw", "type": "vec3", "feed": "camFw" }
		],
		"params": [
			{ "name": "uCount", "type": "int", "def": 64 },
			{ "name": "uScene", "type": "int", "def": 0 },
			{ "name": "uSteps", "type": "int", "def": 20, "hidden": true }
		]
	}
};
