// v0.2 B — raymarched solid glass, smin-merged objects.
// The 4 objects (any shape, GLSL.shape's shapeSdf) are a single SDF joined with
// a smooth union, so touching objects fuse like blobs instead of intersecting
// hard. Each hit refracts in,
// marches the inside with a negated SDF, refracts out, tints by Beer-Lambert
// over the interior chord, and hands the reflection ray to the next bounce
// (2 bounces).
window.SHADER_thick_raymarch = {
	"id": "thick_raymarch",
	"title": "solid glass bubbles - raymarched sdf, 2 bounces (4)",
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
		{ "name": "uBounces", "type": "int", "def": 2, "hidden": true },
		{ "name": "uSteps", "type": "int", "def": 48, "hidden": true, "hint": "raymarch step budget (uniform loop bound, keeps the driver from unrolling)" },
		{ "name": "uSpread", "type": "float", "label": "spread", "min": 0.5, "max": 2.0, "step": 0.05, "def": 1.0, "scenes": ["checker", "rainbow", "colorbox"], "hint": "how far the four bubbles travel" },
		{ "name": "uTopCount", "type": "int", "label": "on top", "min": 0, "max": 3, "step": 1, "def": 3, "scenes": ["cage"], "hint": "balls bouncing on the top face of the cage" },
		{ "name": "uCageSize", "type": "float", "label": "cage", "min": 2.0, "max": 4.5, "step": 0.1, "def": 2.2, "scenes": ["cage"], "hint": "cube half-size" },
		{ "name": "uSize", "type": "float", "label": "size", "min": 0.8, "max": 2.4, "step": 0.05, "def": 1.7, "scenes": ["cage"], "hint": "cage sphere radius scale" },
		{ "name": "uWireWidth", "type": "float", "label": "wire", "min": 0.008, "max": 0.08, "step": 0.002, "def": 0.026, "scenes": ["cage"], "hint": "cage line thickness" },
		{ "name": "uGravity", "type": "float", "label": "gravity", "min": 2.5, "max": 10.0, "step": 0.25, "def": 4.75, "scenes": ["cage"], "hint": "top-ball gravity" },
		...GLSL.cageParams(),
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
#define IOR      1.52
#define F0       0.04
#define SMOOTH_K 0.35

float sminK (float a, float b, float k, out float m) {
	float h = saturate1 (0.5 + 0.5 * (b - a) / k);
	m = h;
	return mix (b, a, h) - k * h * (1.0 - h);
}

// x = distance, y = material id (0..3, fractional where bubbles merge)
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
	// blend the 4 tints by the fractional material id
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

// side = +1 outside (surface from air), -1 inside the glass
vec2 march (vec3 ro, vec3 rd, float side) {
	float t = 0.02;
	float m = 0.0;
	// Keep the trip count unknown to discourage expansion of the four-object
	// SDF. The outer trace must stay compact too (see COMPILE_DEBUG.md).
	for (int i = 0; i < uSteps; i++) {
		vec2 h = map (ro + rd * t);
		m = h.y;
		float d = side * h.x;
		if (d < SURF) break;
		t += d;
		if (t > MAXDIS) break;
	}
	return vec2 (t, m);
}

// one glass hit. returns the shaded colour, and leaves the reflection ray in
// ro/rd plus the reflection weight in refl and the hit depth in tHit.
vec3 shadeHit (inout vec3 ro, inout vec3 rd, out float refl, out bool hit, out float tHit) {
	vec2 h = march (ro, rd, 1.0);
	hit = h.x < MAXDIS;
	refl = 0.0;
	tHit = hit ? h.x : BIG;
	if (!hit) return envSun (rd);

	vec3 pos = ro + rd * h.x;
	vec3 n = mapNormal (pos);
	vec3 absorb = absorbMix (h.y);
	float ndv = saturate1 (dot (-rd, n));
	float F = fresnel (ndv, F0);

	vec3 reflCol = envSun (reflect (rd, n));

	vec3 rdIn = refract (rd, n, 1.0 / IOR);
	vec3 through = reflCol;
	if (dot (rdIn, rdIn) > 0.001) {
		vec3 pIn = pos - n * SURF * 3.0;
		vec2 hi = march (pIn, rdIn, -1.0);
		vec3 pOut = pIn + rdIn * hi.x;
		vec3 nOut = -mapNormal (pOut);
		vec3 rdOut = refract (rdIn, nOut, IOR);
		if (dot (rdOut, rdOut) < 0.001) rdOut = reflect (rdIn, nOut);
		through = env (rdOut) * exp (-absorb * hi.x);
		// inner back-surface sheen
		through += envSun (reflect (rdIn, nOut)) * fresnel (saturate1 (dot (-rdIn, nOut)), F0) * 0.5;
	}

	refl = 0.65 * F + 0.05;
	ro = pos + n * SURF * 3.0;
	rd = reflect (rd, n);
	return mix (through, reflCol, F);
}

void mainImage (out vec4 fragColor, in vec2 fragCoord) {
	vec3 ro, rd;
	camera (fragCoord, ro, rd);
	vec3 viewRo = ro, viewRd = rd;

	float firstT = BIG;
	float filt = 1.0;
	bool hit = true;
	vec3 col = vec3 (0.0);
	// The primary ray and reflection rays share one compiled shadeHit body.
	int passes = 1 + clamp (uBounces, 0, 2);
	for (int i = 0; i < passes; i++) {
		if (!hit || filt < 0.02) break;
		float refl, tHit;
		vec3 c = shadeHit (ro, rd, refl, hit, tHit);
		if (i == 0) firstT = tHit;
		col += c * filt;
		filt *= refl;
	}
	col = landOverlay (col, viewRo, viewRd, firstT);
	col = cageOverlay (col, viewRo, viewRd);
	col += selGlow (viewRo, viewRd);

	fragColor = vec4 (tonemap (col), 1.0);
}
`,
};
