// Analytic layered glass — an *object shader* (how the objects are drawn),
// usable in every shared scene and with every analytic shape.
//
// One ray/shape pass keeps the nearest three layers and composites them back to
// front, which preserves overlap depth without multiplying work by layer count.
// Up to 61 objects stay bounded because nothing marches and nothing recurses.
//
// Scene (where it draws + how the objects move) is chosen independently in the
// toolbar and arrives as `uScene`:
//   0/1/2 — shared interiors, objects drift on tilted Lissajous orbits
//   3     — cage: pastel sky, black wire cube, elastic bounces off the six walls
//           and three balls bouncing on the top face
//   4     — glass land: a simplex heightfield block with a lake, objects above it
// Shape (sphere / cube / tetra) arrives as `uShape`; positions and spins always
// come from js/scene.js (feeds `bubbles61`, `spin`).
window.SHADER_analytic_layers = {
	"id": "analytic_layers",
	"title": "analytic layered glass - nearest 3 layers, up to 61 objects",
	"group": "scene",
	"scenes": ["checker", "rainbow", "colorbox", "cage", "terrain"],
	"nativeScene": "cage",
	"shapes": ["sphere", "cube", "tetra"],
	"nativeShape": "sphere",
	"channels": {},
	"arrays": [
		{ "name": "uInside", "type": "vec4", "count": 61, "feed": "bubbles61" },
		{ "name": "uSpin", "type": "vec4", "count": 61, "feed": "spin" },
		{ "name": "uTop", "type": "vec4", "count": 3, "feed": "cageTop" }
	],
	"vars": [
		{ "name": "uCamPos", "type": "vec3", "feed": "camPos" },
		{ "name": "uCamRt", "type": "vec3", "feed": "camRt" },
		{ "name": "uCamUp", "type": "vec3", "feed": "camUp" },
		{ "name": "uCamFw", "type": "vec3", "feed": "camFw" },
		{ "name": "uSel", "type": "vec4", "feed": "camSel" },
		{ "name": "uSelRot", "type": "vec4", "feed": "camSelRot" }
	],
	"params": [
		{ "name": "uScene", "type": "int", "def": 3, "hidden": true },
		{ "name": "uShape", "type": "int", "def": 0, "hidden": true },
		{ "name": "uCount", "type": "int", "label": "objects", "min": 1, "max": 61, "step": 1, "def": 14, "hint": "active objects" },
		{ "name": "uTopCount", "type": "int", "label": "on top", "min": 0, "max": 3, "step": 1, "def": 3, "scenes": ["cage"], "hint": "balls bouncing vertically on the top face" },
		{ "name": "uCageSize", "type": "float", "label": "cage", "min": 2.0, "max": 4.5, "step": 0.1, "def": 2.2, "scenes": ["cage"], "hint": "cube half-size" },
		{ "name": "uWireWidth", "type": "float", "label": "wire", "min": 0.008, "max": 0.08, "step": 0.002, "def": 0.026, "scenes": ["cage"], "hint": "cage line thickness in world units" },
		{ "name": "uGravity", "type": "float", "label": "gravity", "min": 2.5, "max": 10.0, "step": 0.25, "def": 4.75, "scenes": ["cage"], "hint": "gravity for the balls on top" },
		{ "name": "uSpread", "type": "float", "label": "spread", "min": 0.5, "max": 2.0, "step": 0.05, "def": 1.0, "scenes": ["checker", "rainbow", "colorbox"], "hint": "how far the drifting spheres wander" },
		{ "name": "uSize", "type": "float", "label": "size", "min": 0.5, "max": 1.6, "step": 0.05, "def": 1.0, "hint": "object size scale" },
		{ "name": "uWall", "type": "float", "label": "wall", "min": 0.005, "max": 0.25, "step": 0.005, "def": 0.045, "hint": "glass membrane thickness as a fraction of the size" },
		{ "name": "uIor", "type": "float", "label": "ior", "min": 1.0, "max": 2.0, "step": 0.01, "def": 1.42, "hint": "index of refraction" },
		{ "name": "uDensity", "type": "float", "label": "tint", "min": 0.0, "max": 3.0, "step": 0.05, "def": 0.55, "hint": "glass membrane absorption" },
		{ "name": "uIrid", "type": "float", "label": "iris", "min": 0.0, "max": 1.0, "step": 0.05, "def": 0.55, "hint": "thin-film colour on the rims" },
		{ "name": "uAA", "type": "float", "label": "render AA", "min": 0, "max": 1, "step": 1, "def": 0, "hint": "optional 2x2 shader supersampling in addition to the global AA button" },
		...GLSL.cageParams(),
		...GLSL.landParams()
	],
	"source":
`${GLSL.common}
${GLSL.raySphere}
${GLSL.shape}
${GLSL.camera}
${GLSL.env}
${GLSL.cageOverlay}
${GLSL.selGlow}
${GLSL.simplex}
${GLSL.land}

#define MAX_INSIDE 61
#define MAX_TOP 3
#define LAYERS 3
#define EPS 0.002
#define GOLDEN 0.61803398875

vec3 sphereTint (float id) {
	float h = fract (id * GOLDEN + 0.12);
	return 0.56 + 0.34 * cos (2.0 * PI * (h + vec3 (0.0, 0.33, 0.67)));
}

vec3 filmTint (float phase) {
	return 0.52 + 0.48 * cos (2.0 * PI * (phase * vec3 (1.0, 0.81, 0.64) + vec3 (0.02, 0.31, 0.58)));
}

// Sort only (entry, exit, id, kind), not normals and whole objects. Rebuild
// the two normals for the <= 3 survivors instead of moving 42 live scalars
// through every insertion. kind 0 = glass object, 1 = opaque cage top ball.
void pushLayer (inout vec4 hits[LAYERS], vec4 h) {
	if (h.x < hits[0].x) {
		hits[2] = hits[1]; hits[1] = hits[0]; hits[0] = h;
		return;
	}
	if (h.x < hits[1].x) {
		hits[2] = hits[1]; hits[1] = h;
		return;
	}
	hits[2] = h;
}

int sphereHits (vec3 ro, vec3 rd, out vec4 hits[LAYERS]) {
	for (int i = 0; i < LAYERS; i++) hits[i] = vec4 (BIG, BIG, -1.0, -1.0);
	int count = 0;
	int nInside = clamp (uCount, 0, MAX_INSIDE);
	int topN = (uScene == 3) ? clamp (uTopCount, 0, MAX_TOP) : 0;
	for (int i = 0; i < nInside + topN; i++) {
		bool top = i >= nInside;
		int id = top ? i - nInside : i;
		vec2 h;
		vec3 nA, nB;
		if (top) h = ray_sphere (ro, rd, uTop[id].xyz, uTop[id].w);
		else h = shapeHit (uShape, ro, rd, uInside[id], uSpin[id], nA, nB);
		if (h.y <= EPS || h.y < h.x) continue;
		float t = h.x > EPS ? h.x : h.y;
		if (t >= hits[2].x) continue;
		pushLayer (hits, vec4 (t, h.y, float (id), top ? 1.0 : 0.0));
		count = min (count + 1, LAYERS);
	}
	return count;
}

vec3 shadeGlass (vec3 behind, vec3 ro, vec3 rd, float t, float tx, vec3 n, vec3 nx, vec4 sph, float id) {
	vec3 p = ro + rd * t;
	float ndv = saturate1 (dot (-rd, n));
	float f0 = pow ((uIor - 1.0) / (uIor + 1.0), 2.0);
	float F = fresnel (ndv, f0);
	float wallPath = uWall * sph.w / max (ndv, 0.13);
	vec3 tint = sphereTint (id);
	vec3 transmit = behind * exp (-(vec3 (1.08) - tint) * uDensity * wallPath * 8.0);

	vec3 refr = refract (rd, n, 1.0 / max (uIor, 1.001));
	if (dot (refr, refr) > 0.001) {
		// A small directional contribution suggests refraction without replacing
		// geometry already composed behind this transparent shell.
		transmit = mix (transmit, transmit * env (refr), 0.08 * (1.0 - F));
	}

	float sw = swirl ((p - sph.xyz) / sph.w * 4.0
		+ vec3 (0.0, iTime * 0.08, id * 1.7));
	float optical = wallPath * 12.0 * (1.0 + 0.35 * sw);
	vec3 film = mix (vec3 (1.0), filmTint (optical), uIrid);
	vec3 reflected = envSun (reflect (rd, n)) * film;
	vec3 col = mix (transmit, reflected, F);
	col = mix (col, col * (0.78 + 0.38 * tint), 0.22);
	vec3 glassBody = behind * 0.72 + tint * 0.32;
	col = mix (col, glassBody, 0.12 + 0.08 * (1.0 - ndv));

	float rim = pow (1.0 - ndv, 2.4);
	float backRim = 0.0;
	if (tx > t + EPS) backRim = pow (1.0 - abs (dot (rd, nx)), 4.0);
	col += film * (0.085 + 0.42 * rim + 0.12 * backRim) * tint;
	return col;
}

vec3 shadeLayer (vec3 behind, vec3 ro, vec3 rd, vec4 hit) {
	int id = int (hit.z);
	if (hit.w > 0.5) return cageShadeTop (behind, ro, rd, uTop[id], hit.x, hit.z);
	vec4 sph = uInside[id];
	vec3 n, nx;
	vec2 h = shapeHit (uShape, ro, rd, sph, uSpin[id], n, nx);
	if (h.x <= EPS) n = -nx;
	return shadeGlass (behind, ro, rd, hit.x, hit.y, n, nx, sph, hit.z);
}

vec3 trace (vec3 ro, vec3 rd) {
	vec4 hits[LAYERS];
	int count = sphereHits (ro, rd, hits);
	float wireT = BIG, wireMask = 0.0;
	// the wire cube is world-space geometry, so it only exists in the cage scene
	if (uScene == 3) cageWireHit (ro, rd, wireT, wireMask);

	// the land block is composed at its depth: it replaces the sky behind the
	// layers, and the layers it stands in front of
	vec3 col = envSun (rd);
	float landT = BIG;
	if (uScene == 4) {
		vec3 ln;
		int lid;
		landHit (ro, rd, landT, ln, lid);
		if (lid < 0) landT = BIG;
		else col = landShade (ro, rd, landT, ln, lid);
	}
	bool wireDone = wireMask <= 0.0;
	// A hit-count bound keeps ONE copy of the material/env path, not three
	// manually inlined copies. Insert the wire at its measured ray depth.
	for (int i = count - 1; i >= 0; i--) {
		vec4 h = hits[i];
		if (landT < h.x) continue;
		if (!wireDone && wireT > h.x) { col = cageDrawWire (col, wireMask); wireDone = true; }
		col = shadeLayer (col, ro, rd, h);
	}
	if (!wireDone) col = cageDrawWire (col, wireMask);
	return col;
}

void mainImage (out vec4 fragColor, in vec2 fragCoord) {
	vec3 ro, rd, col;
	col = vec3 (0.0);
	// Keep one trace call site even with AA off; a constant 4-tap loop plus
	// an else trace can expand the entire scene five times in the backend.
	int samples = uAA > 0.5 ? 4 : 1;
	for (int i = 0; i < samples; i++) {
		vec2 o = samples == 1 ? vec2 (0.0) : vec2 (float (i & 1), float (i >> 1)) * 0.5 - 0.25;
		camera (fragCoord + o, ro, rd);
		col += trace (ro, rd);
	}
	col /= float (samples);
	// Use the centre ray for a stable click-selection rim after supersampling.
	camera (fragCoord, ro, rd);
	col += selGlow (ro, rd);
	fragColor = vec4 (tonemap (col), 1.0);
}
`,
};
