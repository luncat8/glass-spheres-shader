// v0.2 A — analytic solid-glass objects. The refracted environment already
// accounts for transmission, so each shaded object is an opaque layer. Select
// the nearest of the four objects before shading it: shading and sorting all
// four only to overwrite the farther three duplicated the costly material path.
window.SHADER_thick_analytic = {
	"id": "thick_analytic",
	"title": "solid glass bubbles - analytic, depth sorted (4)",
	"group": "scene",
	"scenes": ["checker", "rainbow", "colorbox", "cage", "terrain"],
	"nativeScene": "checker",
	"shapes": ["sphere", "cube", "tetra"],
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
		{ "name": "uCount", "type": "int", "def": 4, "hidden": true },
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

#define IOR 1.55
#define F0  0.04

// shade one solid glass object: both crossings of the view ray, then the
// refracted ray's own exit through the same object
vec3 shadeBall (vec3 ro, vec3 rd, vec4 sp, vec4 spin, vec3 absorb, vec2 h, vec3 nA) {
	vec3 nB;
	float tE = max (h.x, 0.0);
	vec3 pe = ro + rd * tE;
	vec3 n = h.x < 0.0 ? -rd : nA;
	float ndv = saturate1 (dot (-rd, n));
	float F = fresnel (ndv, F0);

	vec3 reflCol = envSun (reflect (rd, n));

	vec3 rdIn = refract (rd, n, 1.0 / IOR);
	vec3 through = reflCol;
	float chord = max (h.y - tE, 0.0);
	if (dot (rdIn, rdIn) > 0.001) {
		// exit point of the refracted ray inside the same object
		vec2 hi = shapeHit (uShape, pe - n * 0.001, rdIn, sp, spin, nA, nB);
		chord = max (hi.y, 0.0);
		vec3 nx = nB;
		vec3 rdOut = refract (rdIn, nx, IOR);
		if (dot (rdOut, rdOut) < 0.001) rdOut = reflect (rdIn, nx);
		vec3 far = env (rdOut);
		// small kick off the inside of the back wall: sells the second surface
		float back = pow (saturate1 (dot (rdIn, nx)), 3.0);
		through = far * exp (-absorb * chord) + envSun (reflect (rdIn, nx)) * back * 0.12;
	}

	return mix (through, reflCol, F);
}

void mainImage (out vec4 fragColor, in vec2 fragCoord) {
	vec3 ro, rd;
	camera (fragCoord, ro, rd);

	int nearestId = -1;
	vec2 nearestHit = vec2 (BIG);
	vec3 nearestN = vec3 (0.0);
	for (int i = 0; i < clamp (uCount, 0, 4); i++) {
		vec3 nA, nB;
		vec2 h = shapeHit (uShape, ro, rd, uBubbles[i], uSpin[i], nA, nB);
		if (h.y <= 0.0 || h.y < h.x || h.x >= nearestHit.x) continue;
		nearestId = i; nearestHit = h; nearestN = nA;
	}
	vec3 col = envSun (rd);
	if (nearestId >= 0) col = shadeBall (ro, rd, uBubbles[nearestId], uSpin[nearestId], absorbOf (nearestId), nearestHit, nearestN);
	float nearest = nearestHit.x;
	col = landOverlay (col, ro, rd, nearest);
	col = cageOverlay (col, ro, rd);
	col += selGlow (ro, rd);

	fragColor = vec4 (tonemap (col), 1.0);
}
`,
};
