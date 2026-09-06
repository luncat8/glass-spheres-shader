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

	// JS-driven orbit camera (js/camera.js). The runner uploads the eye and the
	// right/up/forward basis every frame, so drag-orbit, zoom and bubble
	// selection live in one place and work with mouse, pointer and wheel.
	GLSL.camera = `void camera (vec2 fragCoord, out vec3 ro, out vec3 rd) {
	vec2 uv = (2.0 * fragCoord.xy - iResolution.xy) / min (iResolution.x, iResolution.y) * tan (radians (FOV) / 2.0);
	ro = uCamPos;
	rd = normalize (uv.x * uCamRt + uv.y * uCamUp + uCamFw);
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

	// shared per-bubble Beer-Lambert tint (used by the thick-wall / chain variants;
	// hue spreads over the golden ratio so overlapping bubbles stay readable)
	GLSL.absorb = `vec3 absorbOf (int i) {
	float f = fract (float (i) * 0.6180339887);
	vec3 a = vec3 (0.35, 0.20, 0.10);
	vec3 b = vec3 (0.10, 0.30, 0.45);
	vec3 c = vec3 (0.40, 0.10, 0.25);
	vec3 d = vec3 (0.15, 0.40, 0.15);
	if (f < 0.33) return mix (a, b, f / 0.33);
	if (f < 0.66) return mix (b, c, (f - 0.33) / 0.33);
	return mix (c, d, (f - 0.66) / 0.34);
}
`;

	// Analytic environments for the glass scenes, with four selectable
	// "interiors" (uScene int, see each shader's scene param):
	//   0 = checker land, 1 = rainbow, 2 = colour box, 3 = pastel cage sky.
	// Direction-only, exactly like a cubemap, so it can be sampled from
	// anywhere. Procedural instead of the runner's 32px placeholder cube,
	// because glass is only convincing when there is structure behind it to
	// bend. envSun() adds the sun on top.
	GLSL.env = `#define SUN_DIR normalize (vec3 (0.35, 0.62, -0.70))

// smooth analytic 3D wobble in [-1,1]. No texture, no hash, no noise grain -
// used for soap-film thickness swirls and for soft cloud banding.
float swirl (vec3 p) {
	float a = sin (p.x * 1.7 + sin (p.z * 1.3) * 1.2);
	float b = cos (p.y * 1.9 - sin (p.x * 1.1) * 0.9);
	float c = sin (p.z * 1.4 + cos (p.y * 1.6) * 1.1);
	return (a * b + c) * 0.5;
}

vec3 hsv2rgb (vec3 c) {
	vec4 K = vec4 (1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
	vec3 p = abs (fract (c.xxx + K.xyz) * 6.0 - K.www);
	return c.z * mix (K.xxx, clamp (p - K.xxx, 0.0, 1.0), c.y);
}

// theme 0: sky gradient + a checkered ground plane at y = -3, fading into
// the horizon haze (the hollow_bubbles interior, unchanged).
vec3 envChecker (vec3 d) {
	d = normalize (d);
	if (d.y < -0.02) {
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

// theme 1: llsSDf-style rainbow — the hue rides the azimuth, with soft
// cellular blobs and bright bubble-like highlights on top.
vec3 envRainbow (vec3 d) {
	d = normalize (d);
	float hue = fract (atan (d.z, d.x) / (2.0 * PI) + 0.5 * d.y + iTime * 0.02);
	vec3 col = hsv2rgb (vec3 (hue, 0.60, 0.50 + 0.30 * saturate1 (d.y)));
	float c1 = 0.5 + 0.5 * swirl (d * 3.0 + vec3 (0.0, iTime * 0.04, 1.7));
	float c2 = 0.5 + 0.5 * swirl (d * 6.5 - vec3 (iTime * 0.03, 0.8, 0.0));
	vec3 top = 0.5 + 0.5 * cos (2.0 * PI * (hue + vec3 (0.0, 0.33, 0.67)));
	col = mix (col, top * 1.25, 0.30 * c1);
	col += vec3 (1.0) * pow (c2, 6.0) * 0.12;
	return col;
}

// theme 2: XdXXzB-style colour box — fbm-hued colour all around the camera.
vec3 envColorBox (vec3 d) {
	d = normalize (d);
	vec3 p = d * 2.4 + vec3 (iTime * 0.05, iTime * 0.03, 0.0);
	float n = swirl (p * 1.6)
		+ 0.5 * swirl (p * 3.1 + vec3 (4.7, 2.9, 1.3))
		+ 0.25 * swirl (p * 6.3 - vec3 (1.9, 5.1, 3.7));
	n = n * 0.57 + 0.5;
	vec3 col = hsv2rgb (vec3 (fract (n * 1.4), 0.85, 0.92));
	col *= 0.80 + 0.20 * saturate1 (d.y * 0.5 + 0.5);
	return col;
}

// theme 3: smooth pastel clouds for the cage scene. Direction-only so all
// compatible glass renderers can use it for reflection/refraction as well as
// their primary background; world-space cage edges are composed separately.
vec3 envPastel (vec3 d) {
	d = normalize (d);
	float h = d.y * 0.5 + 0.5;
	vec3 sky = mix (vec3 (0.96, 0.70, 0.68), vec3 (0.54, 0.73, 0.94), smoothstep (0.08, 0.92, h));
	float az = 0.5 + 0.5 * sin (atan (d.z, d.x) * 1.5 - 0.35);
	sky = mix (sky, vec3 (0.78, 0.66, 0.91), az * 0.16);
	vec3 drift = vec3 (iTime * 0.018, -iTime * 0.011, iTime * 0.014);
	float n = 0.58 * swirl (d * 3.1 + drift)
		+ 0.28 * swirl (d * 6.0 - drift.yzx * 1.7 + vec3 (2.1, 0.7, 4.3))
		+ 0.14 * swirl (d * 11.0 + drift.zxy * 2.2 - vec3 (1.4, 3.8, 0.5));
	float cloud = smoothstep (-0.16, 0.50, n);
	float shadow = 1.0 - smoothstep (-0.46, -0.04, n);
	vec3 cream = mix (vec3 (1.0, 0.88, 0.83), vec3 (0.91, 0.96, 1.0), h);
	sky = mix (sky, vec3 (0.64, 0.69, 0.86), shadow * 0.34);
	return mix (sky, cream, cloud * 0.78);
}

// the selected interior, driven by the uScene param
vec3 env (vec3 d) {
	if (uScene >= 3) return envPastel (d);
	if (uScene == 2) return envColorBox (d);
	if (uScene == 1) return envRainbow (d);
	return envChecker (d);
}

// env + the sun itself: a tight disc plus a broad glow, so reflections sparkle
vec3 envSun (vec3 d) {
	d = normalize (d);
	float s = saturate1 (dot (d, SUN_DIR));
	return env (d) + vec3 (1.25, 1.10, 0.90) * (pow (s, 3000.0) * 14.0 + pow (s, 20.0) * 0.30);
}
`;

	// World-space part of the cage scene shared by renderers that already use
	// GLSL.env. The material renderer still draws its own inside spheres; this
	// pass adds the twelve black edges and the three generic opaque top balls.
	// It is intentionally a no-op unless uScene == 3.
	GLSL.cageOverlay = `#define CAGE_TOP_MAX 3

vec3 cageTopTint (float id) {
	float h = fract (id * 0.61803398875 + 0.19);
	return 0.56 + 0.34 * cos (2.0 * PI * (h + vec3 (0.0, 0.33, 0.67)));
}

void cageEdgeHit (vec3 ro, vec3 rd, vec3 a, vec3 b,
                  inout float bestT, inout float bestMask) {
	vec3 v = b - a;
	vec3 w = ro - a;
	float vv = dot (v, v);
	float rv = dot (rd, v);
	float rw = dot (rd, w);
	float vw = dot (v, w);
	float den = max (vv - rv * rv, 0.0);
	float q = den > 1e-6 ? (vw - rv * rw) / den : vw / vv;
	q = clamp (q, 0.0, 1.0);
	float t = max (rv * q - rw, 0.0);
	float d = length (w + rd * t - v * q);
	float pixel = 2.0 * max (t, 1.0) * tan (radians (FOV) * 0.5) / min (iResolution.x, iResolution.y);
	float aa = max (pixel * 1.15, 0.0015);
	float mask = 1.0 - smoothstep (uWireWidth - aa, uWireWidth + aa, d);
	if (mask <= 0.0) return;
	float surfaceT = max (t - sqrt (max ((uWireWidth + aa) * (uWireWidth + aa) - d * d, 0.0)), 0.0);
	if (surfaceT > bestT + aa) return;
	if (abs (surfaceT - bestT) <= aa) bestMask = max (bestMask, mask);
	else bestMask = mask;
	bestT = min (bestT, surfaceT);
}

void cageWireHit (vec3 ro, vec3 rd, out float t, out float mask) {
	t = BIG;
	mask = 0.0;
	float c = uCageSize;
	cageEdgeHit (ro, rd, vec3 (-c, -c, -c), vec3 ( c, -c, -c), t, mask);
	cageEdgeHit (ro, rd, vec3 (-c, -c,  c), vec3 ( c, -c,  c), t, mask);
	cageEdgeHit (ro, rd, vec3 (-c,  c, -c), vec3 ( c,  c, -c), t, mask);
	cageEdgeHit (ro, rd, vec3 (-c,  c,  c), vec3 ( c,  c,  c), t, mask);
	cageEdgeHit (ro, rd, vec3 (-c, -c, -c), vec3 (-c,  c, -c), t, mask);
	cageEdgeHit (ro, rd, vec3 (-c, -c,  c), vec3 (-c,  c,  c), t, mask);
	cageEdgeHit (ro, rd, vec3 ( c, -c, -c), vec3 ( c,  c, -c), t, mask);
	cageEdgeHit (ro, rd, vec3 ( c, -c,  c), vec3 ( c,  c,  c), t, mask);
	cageEdgeHit (ro, rd, vec3 (-c, -c, -c), vec3 (-c, -c,  c), t, mask);
	cageEdgeHit (ro, rd, vec3 (-c,  c, -c), vec3 (-c,  c,  c), t, mask);
	cageEdgeHit (ro, rd, vec3 ( c, -c, -c), vec3 ( c, -c,  c), t, mask);
	cageEdgeHit (ro, rd, vec3 ( c,  c, -c), vec3 ( c,  c,  c), t, mask);
}

vec3 cageDrawWire (vec3 behind, float mask) {
	return mix (behind, vec3 (0.006, 0.008, 0.012), mask * 0.96);
}

vec3 cageShadeTop (vec3 behind, vec3 ro, vec3 rd, vec4 sphere, float t, float id) {
	vec3 p = ro + rd * t;
	vec3 n = normalize (p - sphere.xyz);
	vec3 lightDir = normalize (vec3 (-0.45, 0.72, -0.53));
	float diffuse = 0.34 + 0.66 * max (dot (n, lightDir), 0.0);
	float rim = pow (1.0 - saturate1 (dot (-rd, n)), 2.2);
	vec3 base = cageTopTint (id);
	vec3 solid = base * diffuse * 0.82 + envSun (reflect (rd, n)) * (0.16 + 0.32 * rim);
	vec3 film = 0.52 + 0.48 * cos (2.0 * PI * (rim * 2.2 + id * 0.17 + iTime * 0.025
		+ vec3 (0.02, 0.31, 0.58)));
	solid += film * rim * 0.24;
	float spec = pow (max (dot (reflect (-lightDir, n), -rd), 0.0), 90.0);
	solid += vec3 (1.0, 0.91, 0.78) * spec * 1.4;
	return mix (behind, solid, 0.96);
}

vec3 cageOverlay (vec3 behind, vec3 ro, vec3 rd) {
	if (uScene != 3) return behind;
	float wireT, wireMask;
	cageWireHit (ro, rd, wireT, wireMask);

	float topT = BIG;
	vec4 topSphere = vec4 (0.0);
	float topId = -1.0;
	for (int i = 0; i < CAGE_TOP_MAX; i++) {
		if (i >= uTopCount) break;
		vec2 h = ray_sphere (ro, rd, uTop[i].xyz, uTop[i].w);
		float t = h.x > 0.002 ? h.x : h.y;
		if (h.y <= 0.002 || h.y < h.x || t >= topT) continue;
		topT = t;
		topSphere = uTop[i];
		topId = float (i);
	}

	vec3 col = behind;
	if (wireMask > 0.0 && wireT > topT) col = cageDrawWire (col, wireMask);
	if (topId >= 0.0) col = cageShadeTop (col, ro, rd, topSphere, topT, topId);
	if (wireMask > 0.0 && wireT <= topT) col = cageDrawWire (col, wireMask);
	return col;
}
`;

	// selection halo: analytic rim glow on the currently selected bubble.
	// uSel = vec4 (centre, radius); w <= 0 disables it (nothing selected).
	GLSL.selGlow = `vec3 selGlow (vec3 ro, vec3 rd) {
	if (uSel.w <= 0.0) return vec3 (0.0);
	vec3 oc = ro - uSel.xyz;
	float A = dot (rd, rd);
	float B = 2.0 * dot (oc, rd);
	float C = dot (oc, oc) - uSel.w * uSel.w;
	float D = B * B - 4.0 * A * C;
	if (D < 0.0) return vec3 (0.0);
	float t = (-B - sqrt (D)) / (2.0 * A);
	if (t <= 0.0) return vec3 (0.0);
	vec3 n = normalize (ro + rd * t - uSel.xyz);
	float rim = pow (1.0 - abs (dot (n, rd)), 3.0);
	return vec3 (0.28, 1.0, 0.62) * rim * 0.45;
}
`;

	if (typeof module === 'object' && module.exports) module.exports = GLSL;
	root.GLSL = GLSL;
})(typeof window !== 'undefined' ? window : globalThis);
