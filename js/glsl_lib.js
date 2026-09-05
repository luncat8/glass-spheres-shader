// glsl_lib.js — reusable GLSL ES 3.0 snippets shared by the local shaders.
// Loaded before shaders/*.js; each shader interpolates the pieces it needs into
// its template-literal `source`. Keeps ray_sphere / camera / fresnel / tonemap
// in one place instead of a copy per shader (AGENTS.md: avoid duplication).
(function (root) {
	const GLSL = {};

	// constants + small math helpers
	GLSL.common = `#define PI 3.14159265359
#define FOV 60.0
#define BIG 1e9

float saturate1 (float x) { return clamp (x, 0.0, 1.0); }

// Schlick fresnel for an air->glass interface. c = dot (-rd, n).
float fresnel (float c, float f0) {
	return f0 + (1.0 - f0) * pow (saturate1 (1.0 - c), 5.0);
}

// filmic-ish tonemap + gamma, keeps the highlights of the env cube from clipping flat
vec3 tonemap (vec3 c) {
	c = max (c, vec3 (0.0));
	c = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
	return pow (clamp (c, vec3 (0.0), vec3 (1.0)), vec3 (1.0 / 2.2));
}
`;

	// analytic ray/sphere. returns vec2 (t_enter, t_exit); miss when y < x.
	GLSL.raySphere = `vec2 ray_sphere (vec3 ro, vec3 rd, vec3 c, float r) {
	vec3 oc = ro - c;
	float b = dot (oc, rd);
	float cc = dot (oc, oc) - r * r;
	float h = b * b - cc;
	if (h < 0.0) return vec2 (1.0, -1.0);
	h = sqrt (h);
	return vec2 (-b - h, -b + h);
}
`;

	// iMouse-orbited camera, identical rig to XdXXzB
	GLSL.camera = `void camera (vec2 fragCoord, out vec3 ro, out vec3 rd) {
	vec2 uv = (2.0 * fragCoord.xy - iResolution.xy) / min (iResolution.x, iResolution.y) * tan (radians (FOV) / 2.0);
	vec2 mo = iMouse.xy / iResolution.xy;
	float ang = (iMouse.x + iMouse.y > 0.0) ? mo.x * 2.0 * PI : iTime * 0.15;
	float ele = (iMouse.x + iMouse.y > 0.0) ? (mo.y - 0.5) * 1.6 : 0.15;
	vec3 fw = normalize (vec3 (sin (ang) * cos (ele), sin (ele), cos (ang) * cos (ele)));
	vec3 lf = normalize (cross (vec3 (0.0, 1.0, 0.0), fw));
	vec3 up = cross (fw, lf);
	ro = -fw * 7.5;
	rd = normalize (uv.x * lf + uv.y * up + fw);
}
`;

	// the 4 animated bubbles shared by every v0.2 variant
	GLSL.bubbles4 = `vec4 bubble (int i, float t) {
	if (i == 0) return vec4 ( 0.0 + 0.4 * sin (t * 0.50),  0.6 * sin (t * 0.90),  0.0,                1.4);
	if (i == 1) return vec4 ( 2.0 * cos (t * 0.40),       -0.4 + 0.3 * sin (t),   0.5 * sin (t * 0.6), 1.1);
	if (i == 2) return vec4 (-1.8 + 0.5 * sin (t * 0.70),  0.2 * cos (t * 0.80), -0.6,                1.0);
	return             vec4 ( 0.4 * sin (t * 0.30),        1.3 * cos (t * 0.40),  1.2,                0.9);
}

vec3 absorbOf (int i) {
	if (i == 0) return vec3 (0.35, 0.20, 0.10);
	if (i == 1) return vec3 (0.10, 0.30, 0.45);
	if (i == 2) return vec3 (0.40, 0.10, 0.25);
	return vec3 (0.15, 0.40, 0.15);
}
`;

	// Analytic environment: sky gradient + sun + a checkered ground plane.
	// Procedural instead of the runner's 32px placeholder cube, because glass is
	// only convincing when there is structure behind it to bend. Direction-only,
	// exactly like a cube map, so it can be sampled from anywhere.
	GLSL.env = `#define SUN_DIR normalize (vec3 (0.35, 0.62, -0.70))

// smooth analytic 3D wobble in [-1,1]. No texture, no hash, no noise grain -
// used for soap-film thickness swirls and for soft cloud banding.
float swirl (vec3 p) {
	float a = sin (p.x * 1.7 + sin (p.z * 1.3) * 1.2);
	float b = cos (p.y * 1.9 - sin (p.x * 1.1) * 0.9);
	float c = sin (p.z * 1.4 + cos (p.y * 1.6) * 1.1);
	return (a * b + c) * 0.5;
}

vec3 env (vec3 d) {
	d = normalize (d);
	if (d.y < -0.02) {
		// ground plane at y = -3, checkered, fading into the horizon haze
		float t = -3.0 / d.y;
		vec2 q = d.xz * t;
		float chk = mod (floor (q.x * 0.35) + floor (q.y * 0.35), 2.0);
		vec3 floorCol = mix (vec3 (0.06, 0.07, 0.09), vec3 (0.80, 0.78, 0.74), chk);
		float fog = exp (-t * 0.022);
		return mix (vec3 (0.58, 0.66, 0.78), floorCol, fog);
	}
	float h = saturate1 (d.y);
	vec3 sky = mix (vec3 (0.70, 0.78, 0.90), vec3 (0.10, 0.26, 0.60), pow (h, 0.6));
	sky += vec3 (0.45, 0.28, 0.15) * pow (1.0 - h, 10.0) * 0.7;
	// soft cloud banding so reflections and refractions have something to carry
	float cl = saturate1 (0.5 + 0.5 * swirl (d * 4.5 + vec3 (0.0, 1.7, 0.0)));
	sky = mix (sky, vec3 (0.92, 0.94, 0.98), cl * cl * 0.35 * saturate1 (d.y * 3.0));
	return sky;
}

// env + the sun itself: a tight disc plus a broad glow, so reflections sparkle
vec3 envSun (vec3 d) {
	d = normalize (d);
	float s = saturate1 (dot (d, SUN_DIR));
	return env (d) + vec3 (1.25, 1.10, 0.90) * (pow (s, 3000.0) * 14.0 + pow (s, 20.0) * 0.30);
}
`;

	if (typeof module === 'object' && module.exports) module.exports = GLSL;
	root.GLSL = GLSL;
})(typeof window !== 'undefined' ? window : globalThis);
