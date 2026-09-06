// v0.2 C — chain refraction: the ray keeps travelling after it leaves an object.
// Same smin-merged SDF as the raymarched variant (any shape), but instead of stopping at
// the first ball the exiting refracted ray is re-injected as a new primary ray,
// up to 3 hops. Glass seen through glass, with the throughput carrying the
// Fresnel loss and the Beer-Lambert tint of every wall crossed so far.
window.SHADER_thick_chain = {
	"id": "thick_chain",
	"title": "solid glass bubbles - chain refraction, 3 hops (4)",
	"group": "scene",
	"scenes": ["checker", "rainbow", "colorbox", "cage", "terrain"],
	"nativeScene": "checker",
	"shapes": ["sphere", "cube", "tetra", "knot"],
	"nativeShape": "sphere",
	"channels": { "0": "env_cube", "1": "env_cube", "2": "noise", "3": "noise" },
	"arrays": [
		{ "name": "uBubbles", "type": "vec4", "count": 4, "feed": "sceneBubbles4" },
		{ "name": "uSpin", "type": "vec4", "count": 4, "feed": "spin" },
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
		{ "name": "uScene", "type": "int", "def": 0, "hidden": true },
		{ "name": "uShape", "type": "int", "def": 0, "hidden": true },
		{ "name": "uSpread", "type": "float", "label": "spread", "min": 0.5, "max": 2.0, "step": 0.05, "def": 1.0, "scenes": ["checker", "rainbow", "colorbox"], "hint": "how far the four bubbles travel" },
		{ "name": "uTopCount", "type": "int", "label": "on top", "min": 0, "max": 3, "step": 1, "def": 3, "scenes": ["cage"], "hint": "balls bouncing on the top face of the cage" },
		{ "name": "uCageSize", "type": "float", "label": "cage", "min": 2.0, "max": 4.5, "step": 0.1, "def": 2.2, "scenes": ["cage"], "hint": "cube half-size" },
		{ "name": "uSize", "type": "float", "label": "size", "min": 0.8, "max": 2.4, "step": 0.05, "def": 1.7, "scenes": ["cage"], "hint": "cage sphere radius scale" },
		{ "name": "uWireWidth", "type": "float", "label": "wire", "min": 0.008, "max": 0.08, "step": 0.002, "def": 0.026, "scenes": ["cage"], "hint": "cage line thickness" },
		{ "name": "uGravity", "type": "float", "label": "gravity", "min": 2.5, "max": 10.0, "step": 0.25, "def": 4.75, "scenes": ["cage"], "hint": "top-ball gravity" },
		...GLSL.landParams()
	],
	"source":
`${GLSL.common}
${GLSL.raySphere}
${GLSL.shape}
${GLSL.camera}
${GLSL.bubbles4}
${GLSL.env}
${GLSL.cageOverlay}
${GLSL.selGlow}
${GLSL.simplex}
${GLSL.land}

#define MAXSTEPS 48
#define MAXDIS   40.0
#define SURF     0.004
#define HOPS     3
#define IOR      1.52
#define F0       0.04
#define SMOOTH_K 0.35

float sminK (float a, float b, float k, out float m) {
	float h = saturate1 (0.5 + 0.5 * (b - a) / k);
	m = h;
	return mix (b, a, h) - k * h * (1.0 - h);
}

vec2 map (vec3 p) {
	float d0 = shapeSdf (uShape, p, uBubbles[0], uSpin[0]);
	float d1 = shapeSdf (uShape, p, uBubbles[1], uSpin[1]);
	float d2 = shapeSdf (uShape, p, uBubbles[2], uSpin[2]);
	float d3 = shapeSdf (uShape, p, uBubbles[3], uSpin[3]);
	float h;
	float d = sminK (d0, d1, SMOOTH_K, h);
	float m = mix (1.0, 0.0, h);
	d = sminK (d, d2, SMOOTH_K, h);
	m = mix (2.0, m, h);
	d = sminK (d, d3, SMOOTH_K, h);
	m = mix (3.0, m, h);
	return vec2 (d, m);
}

vec3 absorbMix (float m) {
	vec3 a = mix (absorbOf (0), absorbOf (1), saturate1 (m));
	a = mix (a, absorbOf (2), saturate1 (m - 1.0));
	a = mix (a, absorbOf (3), saturate1 (m - 2.0));
	return a;
}

vec3 mapNormal (vec3 p) {
	vec2 e = vec2 (0.0015, 0.0);
	return normalize (vec3 (
		map (p + e.xyy).x - map (p - e.xyy).x,
		map (p + e.yxy).x - map (p - e.yxy).x,
		map (p + e.yyx).x - map (p - e.yyx).x));
}

vec2 march (vec3 ro, vec3 rd, float side) {
	float t = 0.02;
	float m = 0.0;
	for (int i = 0; i < MAXSTEPS; i++) {
		vec2 h = map (ro + rd * t);
		m = h.y;
		float d = side * h.x;
		if (d < SURF) break;
		t += d;
		if (t > MAXDIS) break;
	}
	return vec2 (t, m);
}

void mainImage (out vec4 fragColor, in vec2 fragCoord) {
	vec3 ro, rd;
	camera (fragCoord, ro, rd);
	vec3 viewRo = ro, viewRd = rd;

	vec3 col = vec3 (0.0);
	vec3 tp = vec3 (1.0);   // throughput carried along the chain
	bool addTail = true;    // does the surviving ray still see the environment?
	float firstT = BIG;     // depth of the primary hit, for the land block

	for (int hop = 0; hop < HOPS; hop++) {
		vec2 h = march (ro, rd, 1.0);
		if (h.x >= MAXDIS) break;
		if (hop == 0) firstT = h.x;

		vec3 pos = ro + rd * h.x;
		vec3 n = mapNormal (pos);
		vec3 absorb = absorbMix (h.y);
		float F = fresnel (saturate1 (dot (-rd, n)), F0);

		// reflective part leaves the chain here
		col += tp * F * envSun (reflect (rd, n));
		tp *= (1.0 - F);

		vec3 rdIn = refract (rd, n, 1.0 / IOR);
		if (dot (rdIn, rdIn) < 0.001) { rd = reflect (rd, n); ro = pos + n * SURF * 3.0; continue; }

		vec3 pIn = pos - n * SURF * 3.0;
		vec2 hi = march (pIn, rdIn, -1.0);
		vec3 pOut = pIn + rdIn * hi.x;
		vec3 nOut = -mapNormal (pOut);

		tp *= exp (-absorb * hi.x);

		vec3 rdOut = refract (rdIn, nOut, IOR);
		if (dot (rdOut, rdOut) < 0.001) {
			// total internal reflection: bounce back inside, treat as a rim glow
			col += tp * envSun (reflect (rdIn, nOut)) * 0.5;
			addTail = false;
			break;
		}

		ro = pOut - nOut * SURF * 3.0;
		rd = rdOut;
		if (max (tp.x, max (tp.y, tp.z)) < 0.02) { addTail = false; break; }
	}

	if (addTail) col += tp * envSun (rd);
	col = landOverlay (col, viewRo, viewRd, firstT);
	col = cageOverlay (col, viewRo, viewRd);
	col += selGlow (viewRo, viewRd);

	fragColor = vec4 (tonemap (col), 1.0);
}
`,
};
