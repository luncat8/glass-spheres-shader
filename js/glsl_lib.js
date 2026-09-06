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

	// Shape constants shared by GLSL.shape and js/shapes.js (plan 0.4.3). Every
	// shape is inscribed in its object's bounding ball, so `w` keeps meaning
	// "radius" for the feeds, the picker and the cage bounds whatever the shape.
	const S3 = 1 / Math.sqrt(3);
	const SHAPE = {
		SPHERE: 0, CUBE: 1, TETRA: 2, KNOT: 3,
		CUBE_INSCRIBE: S3,        // half-edge per unit radius
		TETRA_INRADIUS: 1 / 3,    // inradius per unit circumradius
		TETRA_N: [[-S3, -S3, -S3], [-S3, S3, S3], [S3, -S3, S3], [S3, S3, -S3]], // outward face normals
		KNOT_R: 0.60, KNOT_A: 0.25, KNOT_TUBE: 0.15, // (2,3) torus knot, R + A + TUBE = 1
		KNOT_LIP: 0.45,           // step scale that makes the tangent estimate safe to sphere-trace (measured)
		KNOT_HULL: 0.43,          // meridian radius of the exact torus that contains the whole tube
	};
	GLSL.SHAPE = SHAPE;

	function lit(v) { return v.toFixed(8); }
	function vec3lit(v) { return 'vec3 (' + lit(v[0]) + ', ' + lit(v[1]) + ', ' + lit(v[2]) + ')'; }

	// Object shapes. Requires GLSL.raySphere and nothing else, so self-authored
	// shaders can draw a cube without migrating onto GLSL.common.
	//   shapeHit — drop-in for ray_sphere: vec2 (t_enter, t_exit), miss when
	//              y < x, plus the outward normals at both crossings
	//   shapeSdf — signed distance for the marchers (exact for sphere and cube,
	//              a lower bound near tetra edges and everywhere on the knot)
	// obj = (centre, bounding radius), spin = (unit axis, angle) from Feeds.spin.
	GLSL.shape = `#define SHAPE_SPHERE ${SHAPE.SPHERE}
#define SHAPE_CUBE ${SHAPE.CUBE}
#define SHAPE_TETRA ${SHAPE.TETRA}
#define SHAPE_KNOT ${SHAPE.KNOT}
#define CUBE_INSCRIBE ${lit(SHAPE.CUBE_INSCRIBE)}
#define TETRA_INRADIUS ${lit(SHAPE.TETRA_INRADIUS)}
#define TETRA_N0 ${vec3lit(SHAPE.TETRA_N[0])}
#define TETRA_N1 ${vec3lit(SHAPE.TETRA_N[1])}
#define TETRA_N2 ${vec3lit(SHAPE.TETRA_N[2])}
#define TETRA_N3 ${vec3lit(SHAPE.TETRA_N[3])}
#define KNOT_R ${lit(SHAPE.KNOT_R)}
#define KNOT_A ${lit(SHAPE.KNOT_A)}
#define KNOT_TUBE ${lit(SHAPE.KNOT_TUBE)}
#define KNOT_LIP ${lit(SHAPE.KNOT_LIP)}
#define KNOT_HULL ${lit(SHAPE.KNOT_HULL)}

// Rodrigues rotation from (unit axis, angle). World -> local is \`v * m\`,
// local -> world is \`m * v\`.
mat3 spinMat (vec4 s) {
	vec3 a = s.xyz;
	float c = cos (s.w), si = sin (s.w), k = 1.0 - c;
	return mat3 (
		c + a.x * a.x * k,        a.y * a.x * k + a.z * si, a.z * a.x * k - a.y * si,
		a.x * a.y * k - a.z * si, c + a.y * a.y * k,        a.z * a.y * k + a.x * si,
		a.x * a.z * k + a.y * si, a.y * a.z * k - a.x * si, c + a.z * a.z * k);
}

float sdBox (vec3 p, vec3 b) {
	vec3 q = abs (p) - b;
	return length (max (q, 0.0)) + min (max (q.x, max (q.y, q.z)), 0.0);
}

// regular tetrahedron: exact at the faces, a lower bound near edges and vertices
float sdTetra (vec3 p, float inradius) {
	float d = max (max (dot (p, TETRA_N0), dot (p, TETRA_N1)), max (dot (p, TETRA_N2), dot (p, TETRA_N3)));
	return d - inradius;
}

// (2,3) torus knot around y inside the unit ball. The knot crosses every
// meridian half-plane exactly twice, at +e and -e; the distance to each strand
// is measured normal to its tangent there. That estimate is not Lipschitz-1
// near the hole, so it is scaled by KNOT_LIP, and the exact torus hull keeps
// the steps big in empty space (measured safe: no overstep, see plan 0.4.3).
float sdKnot (vec3 p) {
	vec2 m = vec2 (length (p.xz) - KNOT_R, p.y);
	float u = 1.5 * atan (p.z, p.x);
	vec2 e = KNOT_A * vec2 (cos (u), sin (u));
	vec3 t1 = normalize (vec3 (-1.5 * e.y, 1.5 * e.x, KNOT_R + e.x));
	vec3 t2 = normalize (vec3 (1.5 * e.y, -1.5 * e.x, KNOT_R - e.x));
	vec3 o1 = vec3 (m - e, 0.0);
	vec3 o2 = vec3 (m + e, 0.0);
	float d1 = length (o1 - t1 * dot (o1, t1));
	float d2 = length (o2 - t2 * dot (o2, t2));
	return max (KNOT_LIP * (min (d1, d2) - KNOT_TUBE), length (m) - KNOT_HULL);
}

// clip the ray span [t.x, t.y] against the half-space dot (p, n) <= d,
// remembering which plane bounds each end
void planeClip (vec3 ro, vec3 rd, vec3 n, float d, inout vec2 t, inout vec3 nEnter, inout vec3 nExit) {
	float den = dot (rd, n);
	float num = d - dot (ro, n);
	if (abs (den) < 1e-7) { if (num < 0.0) t = vec2 (1.0, -1.0); return; }
	float tp = num / den;
	if (den < 0.0) { if (tp > t.x) { t.x = tp; nEnter = n; } return; }
	if (tp < t.y) { t.y = tp; nExit = n; }
}

// axis-aligned box: vec2 (t_enter, t_exit), miss when y < x, outward normals
vec2 boxHit (vec3 ro, vec3 rd, vec3 c, vec3 h, out vec3 nEnter, out vec3 nExit) {
	vec3 m = 1.0 / rd;
	vec3 n = m * (ro - c);
	vec3 k = abs (m) * h;
	vec3 t1 = -n - k;
	vec3 t2 = -n + k;
	nEnter = -sign (rd) * step (t1.yzx, t1.xyz) * step (t1.zxy, t1.xyz);
	nExit = sign (rd) * step (t2.xyz, t2.yzx) * step (t2.xyz, t2.zxy);
	return vec2 (max (max (t1.x, t1.y), t1.z), min (min (t2.x, t2.y), t2.z));
}

vec2 shapeHit (int shape, vec3 ro, vec3 rd, vec4 obj, vec4 spin, out vec3 nEnter, out vec3 nExit) {
	vec2 t = ray_sphere (ro, rd, obj.xyz, obj.w);
	nEnter = normalize (ro + rd * t.x - obj.xyz);
	nExit = normalize (ro + rd * t.y - obj.xyz);
	// the ball is the shape for the sphere and the pick/halo proxy of the knot;
	// for the polytopes it is the pre-test that bounds the clipped span
	if (t.y < t.x || shape == SHAPE_SPHERE || shape == SHAPE_KNOT) return t;
	mat3 rot = spinMat (spin);
	vec3 lo = (ro - obj.xyz) * rot;
	vec3 ld = rd * rot;
	vec3 nA = nEnter * rot, nB = nExit * rot;
	if (shape == SHAPE_CUBE) {
		float h = obj.w * CUBE_INSCRIBE;
		planeClip (lo, ld, vec3 (1.0, 0.0, 0.0), h, t, nA, nB);
		planeClip (lo, ld, vec3 (-1.0, 0.0, 0.0), h, t, nA, nB);
		planeClip (lo, ld, vec3 (0.0, 1.0, 0.0), h, t, nA, nB);
		planeClip (lo, ld, vec3 (0.0, -1.0, 0.0), h, t, nA, nB);
		planeClip (lo, ld, vec3 (0.0, 0.0, 1.0), h, t, nA, nB);
		planeClip (lo, ld, vec3 (0.0, 0.0, -1.0), h, t, nA, nB);
	} else {
		float h = obj.w * TETRA_INRADIUS;
		planeClip (lo, ld, TETRA_N0, h, t, nA, nB);
		planeClip (lo, ld, TETRA_N1, h, t, nA, nB);
		planeClip (lo, ld, TETRA_N2, h, t, nA, nB);
		planeClip (lo, ld, TETRA_N3, h, t, nA, nB);
	}
	nEnter = rot * nA;
	nExit = rot * nB;
	return t;
}

float shapeSdf (int shape, vec3 p, vec4 obj, vec4 spin) {
	vec3 q = p - obj.xyz;
	if (shape == SHAPE_SPHERE) return length (q) - obj.w;
	q = q * spinMat (spin);
	if (shape == SHAPE_CUBE) return sdBox (q, vec3 (obj.w * CUBE_INSCRIBE));
	if (shape == SHAPE_TETRA) return sdTetra (q, obj.w * TETRA_INRADIUS);
	return sdKnot (q / obj.w) * obj.w;
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

	// selection halo: rim glow on the selected object. uSel = (centre, bounding
	// radius), w <= 0 disables it; uSelRot = its spin, a zero axis means a plain
	// sphere (the cage's top balls). Requires GLSL.shape.
	GLSL.selGlow = `vec3 selGlow (vec3 ro, vec3 rd) {
	if (uSel.w <= 0.0) return vec3 (0.0);
	int shape = dot (uSelRot.xyz, uSelRot.xyz) > 0.5 ? uShape : SHAPE_SPHERE;
	vec3 nA, nB;
	vec2 h = shapeHit (shape, ro, rd, uSel, uSelRot, nA, nB);
	if (h.y < h.x || h.x <= 0.0) return vec3 (0.0);
	float rim = pow (1.0 - abs (dot (nA, rd)), 3.0);
	return vec3 (0.28, 1.0, 0.62) * rim * 0.45;
}
`;

	// 2D simplex gradient noise (Ashima Arts / Stefan Gustavson, MIT) and a
	// three-octave fbm. Procedural, no texture, |fbm3| <= 1 by construction —
	// the motion feed of the terrain scene relies on that bound.
	GLSL.simplex = `vec3 mod289 (vec3 x) { return x - floor (x * (1.0 / 289.0)) * 289.0; }
vec2 mod289 (vec2 x) { return x - floor (x * (1.0 / 289.0)) * 289.0; }
vec3 permute (vec3 x) { return mod289 (((x * 34.0) + 10.0) * x); }

float snoise (vec2 v) {
	const vec4 C = vec4 (0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
	vec2 i = floor (v + dot (v, C.yy));
	vec2 x0 = v - i + dot (i, C.xx);
	vec2 i1 = (x0.x > x0.y) ? vec2 (1.0, 0.0) : vec2 (0.0, 1.0);
	vec4 x12 = x0.xyxy + C.xxzz;
	x12.xy -= i1;
	i = mod289 (i);
	vec3 p = permute (permute (i.y + vec3 (0.0, i1.y, 1.0)) + i.x + vec3 (0.0, i1.x, 1.0));
	vec3 m = max (0.5 - vec3 (dot (x0, x0), dot (x12.xy, x12.xy), dot (x12.zw, x12.zw)), 0.0);
	m = m * m;
	m = m * m;
	vec3 x = 2.0 * fract (p * C.www) - 1.0;
	vec3 h = abs (x) - 0.5;
	vec3 ox = floor (x + 0.5);
	vec3 a0 = x - ox;
	m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
	vec3 g;
	g.x = a0.x * x0.x + h.x * x0.y;
	g.yz = a0.yz * x12.xz + h.yz * x12.yw;
	return 130.0 * dot (m, g);
}

// octaves rotated and doubled; drift slides them against each other so the
// relief morphs instead of scrolling
float fbm3 (vec2 p, float drift) {
	const mat2 ROT = mat2 (0.8, 0.6, -0.6, 0.8);
	float a = snoise (p + vec2 (drift, 0.0));
	p = ROT * p * 2.0;
	a += 0.5 * snoise (p - vec2 (0.0, drift));
	p = ROT * p * 2.0;
	a += 0.25 * snoise (p + vec2 (drift));
	return a / 1.75;
}
`;

	// The terrain scene (uScene == 4): a block whose top face is a simplex
	// heightfield, with a lake filling the valleys below uLakeLevel. Shared
	// world geometry like GLSL.cageOverlay: the renderer keeps drawing its own
	// objects and composites the land at its measured depth. Requires
	// GLSL.common, GLSL.env, GLSL.shape (boxHit) and GLSL.simplex.
	// LAND_MAX_STEPS was 96 — reduced to 64 after reports of very slow first
	// compile (driver shader cache makes later runs fast). The param still
	// offers 32/64, 96 would force a 96-unroll that some drivers choke on.
	GLSL.land = `#define LAND_SKIRT 1.0
#define LAND_IOR 1.45
#define WATER_IOR 1.33
#define LAND_TINT vec3 (0.16, 0.05, 0.09)
#define WATER_TINT vec3 (1.50, 0.55, 0.25)
#define WATER_BODY vec3 (0.02, 0.10, 0.16)
// the shared tonemap lifts midtones hard, so the opaque land is lit dim on
// purpose: these give a saturated green / grey / sand after tonemapping
#define LAND_SUN vec3 (0.50, 0.46, 0.40)
#define LAND_AMBIENT vec3 (0.18, 0.21, 0.26)
#define LAND_OFFSET vec2 (17.3, 9.1)
#define LAND_MAX_STEPS 64

float landHeight (vec2 xz) {
	return uLandBase + uLandAmp * fbm3 ((xz + LAND_OFFSET) * uLandFreq, iTime * uLandDrift);
}

// bounding box: the footprint, one skirt under the deepest valley, up to the
// highest possible ridge (|fbm3| <= 1) or the lake if that is higher
void landBox (out vec3 c, out vec3 h) {
	float bottom = uLandBase - uLandAmp - LAND_SKIRT;
	float top = max (uLandBase + uLandAmp, uLakeLevel);
	c = vec3 (0.0, 0.5 * (bottom + top), 0.0);
	h = vec3 (uLandSize, 0.5 * (top - bottom), uLandSize);
}

vec3 landNormal (vec2 xz) {
	vec2 e = vec2 (0.01, 0.0);
	float dx = landHeight (xz + e.xy) - landHeight (xz - e.xy);
	float dz = landHeight (xz + e.yx) - landHeight (xz - e.yx);
	return normalize (vec3 (-dx, 2.0 * e.x, -dz));
}

// first crossing of the terrain on [t0, t1] (the start is above it): equal
// steps, then four bisections. -1.0 when the ray stays above the terrain.
// (was 5 bisections + 96 max steps — reduced after slow-compile reports)
float landMarch (vec3 ro, vec3 rd, float t0, float t1, int steps) {
	float dt = (t1 - t0) / float (steps);
	if (dt <= 0.0) return -1.0;
	float a = t0;
	for (int i = 1; i <= LAND_MAX_STEPS; i++) {
		if (i > steps) break;
		float b = t0 + dt * float (i);
		vec3 p = ro + rd * b;
		if (p.y > landHeight (p.xz)) { a = b; continue; }
		for (int j = 0; j < 4; j++) {
			float m = 0.5 * (a + b);
			p = ro + rd * m;
			if (p.y > landHeight (p.xz)) a = m; else b = m;
		}
		return 0.5 * (a + b);
	}
	return -1.0;
}

// nearest surface of the block on the ray. id: -1 = miss, 0 = land, 1 = water.
// The lake plane and the block faces are analytic; only the terrain between
// the entry point and the lake plane (or the exit) is marched.
void landHit (vec3 ro, vec3 rd, out float t, out vec3 n, out int id) {
	t = -1.0;
	n = vec3 (0.0, 1.0, 0.0);
	id = -1;
	vec3 c, h, nA, nB;
	landBox (c, h);
	vec2 span = boxHit (ro, rd, c, h, nA, nB);
	if (span.y < span.x || span.y <= 0.0) return;
	float t0 = max (span.x, 0.0);
	vec3 p = ro + rd * t0;
	float lh = landHeight (p.xz);
	if (p.y <= max (lh, uLakeLevel)) {
		// through a side or the bottom below the surface, or starting inside
		t = t0;
		n = span.x > 0.0 ? nA : -rd;
		id = p.y <= lh ? 0 : 1;
		return;
	}
	float t1 = span.y;
	float tLake = -1.0;
	if (rd.y < 0.0 && ro.y > uLakeLevel) {
		tLake = (uLakeLevel - ro.y) / rd.y;
		if (tLake < t1) t1 = tLake; else tLake = -1.0;
	}
	float tm = landMarch (ro, rd, t0, t1, uLandSteps);
	if (tm >= 0.0) {
		t = tm;
		n = landNormal ((ro + rd * tm).xz);
		id = 0;
		return;
	}
	if (tLake < 0.0) return;
	t = tLake;
	id = 1;
}

// height- and slope-colourised land: sand at the shore, grass, rock on the
// slopes, snow near the highest possible ridge
vec3 landColour (vec3 p, vec3 n) {
	float rel = (p.y - uLakeLevel) / max (uLandBase + uLandAmp - uLakeLevel, 0.25);
	float slope = 1.0 - n.y;
	vec3 col = mix (vec3 (0.78, 0.71, 0.52), vec3 (0.24, 0.46, 0.19), smoothstep (0.02, 0.14, rel));
	col = mix (col, vec3 (0.44, 0.41, 0.39), smoothstep (0.22, 0.55, slope));
	return mix (col, vec3 (1.4, 1.42, 1.45), smoothstep (0.55, 0.80, rel) * (1.0 - smoothstep (0.35, 0.65, slope)));
}

vec3 landLit (vec3 p, vec3 n) {
	float diff = max (dot (n, SUN_DIR), 0.0);
	return landColour (p, n) * (diff * LAND_SUN + LAND_AMBIENT * (0.55 + 0.45 * n.y));
}

// glass block: Fresnel sky reflection over the refracted ray carried to the
// exit face, Beer-Lambert over the chord. Water is the same with the lake bed
// (a second, coarser march) as what lies behind the water column.
vec3 landGlass (vec3 ro, vec3 rd, float t, vec3 n, int id) {
	vec3 p = ro + rd * t;
	float ior = id == 1 ? WATER_IOR : LAND_IOR;
	float f0 = pow ((ior - 1.0) / (ior + 1.0), 2.0);
	float F = fresnel (saturate1 (dot (-rd, n)), f0);
	vec3 refl = envSun (reflect (rd, n));
	vec3 rr = refract (rd, n, 1.0 / ior);
	vec3 c, h, nA, nB;
	landBox (c, h);
	vec3 q = p - n * 0.002;
	float chord = max (boxHit (q, rr, c, h, nA, nB).y, 0.0);
	vec3 rOut = refract (rr, -nB, ior);
	if (dot (rOut, rOut) < 1e-5) rOut = reflect (rr, -nB);
	vec3 far = env (rOut);
	// a faint sun-lit volume scatter: under the near-uniform pastel sky the
	// refraction alone would not let the relief read
	vec3 scatter = vec3 (0.9, 1.0, 0.95) * (0.10 * max (dot (n, SUN_DIR), 0.0));
	if (id == 0) return mix (far * exp (-LAND_TINT * chord) + scatter, refl, F);
	float tb = landMarch (q, rr, 0.0, chord, uLandSteps / 2);
	float depth = tb >= 0.0 ? tb : chord;
	vec3 bed = far * exp (-LAND_TINT * (chord - depth));
	if (tb >= 0.0) {
		vec3 bp = q + rr * tb;
		vec3 lit = landLit (bp, landNormal (bp.xz));
		bed = uLandStyle == 1 ? lit : mix (bed, lit, 0.15);
	}
	vec3 through = mix (WATER_BODY, bed, exp (-WATER_TINT * depth));
	return mix (through, refl, F);
}

vec3 landShade (vec3 ro, vec3 rd, float t, vec3 n, int id) {
	if (uLandStyle == 1 && id == 0) return landLit (ro + rd * t, n);
	return landGlass (ro, rd, t, n, id);
}

// composite the block at its depth against the renderer's nearest object
// (objT = BIG when nothing was hit). No-op outside the terrain scene.
vec3 landOverlay (vec3 behind, vec3 ro, vec3 rd, float objT) {
	if (uScene != 4) return behind;
	float t;
	vec3 n;
	int id;
	landHit (ro, rd, t, n, id);
	if (id < 0 || t >= objT) return behind;
	return landShade (ro, rd, t, n, id);
}
`;

	// the uniforms GLSL.land reads, declared once; each scene-aware shader
	// spreads a fresh copy into its params so values stay per shader
	GLSL.landParams = function () {
		return [
			{ name: 'uLandSize', type: 'float', label: 'land', min: 3.0, max: 10.0, step: 0.5, def: 5.0, scenes: ['terrain'], hint: 'half-size of the land block' },
			{ name: 'uLandAmp', type: 'float', label: 'relief', min: 0.2, max: 3.0, step: 0.1, def: 1.1, scenes: ['terrain'], hint: 'ridge amplitude around the base height' },
			{ name: 'uLandBase', type: 'float', label: 'base', min: -2.0, max: 2.0, step: 0.1, def: 0.0, scenes: ['terrain'], hint: 'height of the mid plane the relief sits on' },
			{ name: 'uLandFreq', type: 'float', label: 'detail', min: 0.05, max: 0.6, step: 0.01, def: 0.18, scenes: ['terrain'], hint: 'noise frequency: smaller features to the right' },
			{ name: 'uLakeLevel', type: 'float', label: 'lake', min: -1.5, max: 1.5, step: 0.05, def: 0.15, scenes: ['terrain'], hint: 'water level: valleys below it fill' },
			{ name: 'uLandStyle', type: 'int', label: 'look', def: 0, scenes: ['terrain'], hint: 'glass land: the whole block is glass; colour land: opaque height-colourised land with glass water',
				options: [{ value: 0, label: 'glass land' }, { value: 1, label: 'colour land' }] },
			{ name: 'uLandSteps', type: 'int', label: 'land steps', def: 64, scenes: ['terrain'], hint: 'march budget of the terrain per ray (lower on integrated GPUs)',
				options: [{ value: 32, label: '32' }, { value: 64, label: '64' }] },
			{ name: 'uLandDrift', type: 'float', label: 'drift', min: 0.0, max: 0.3, step: 0.01, def: 0.0, scenes: ['terrain'], hint: 'slow morphing of the relief' },
		];
	};

	if (typeof module === 'object' && module.exports) module.exports = GLSL;
	root.GLSL = GLSL;
})(typeof window !== 'undefined' ? window : globalThis);
