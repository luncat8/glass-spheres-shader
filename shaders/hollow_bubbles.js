// v0.4 — hollow glass bubbles with a real membrane wall.
//
// Up to 32 concentric-shell bubbles (outer radius R, inner radius R*(1-uWall)).
// A ray does not hit "bubbles", it crosses *membranes*: at every step the nearest
// sphere crossing ahead is resolved, the wall is traversed with two refractions
// (outer face -> glass -> inner face), and the bent ray carries on. Near wall and
// far wall are separate events, so the far side of the shell is visible through
// the near side - the thing that makes a bubble read as hollow rather than solid.
// Depth order is exact (events are consumed in increasing t), and intersecting or
// nested bubbles need no special case: they are simply the next event.
//
// Everything is analytic - no marching, no stochastic sampling, no noise.
window.SHADER_hollow_bubbles = {
	"id": "hollow_bubbles",
	"title": "hollow glass bubbles - membrane wall, 32 spheres, sliders",
	"group": "scene",
	"scenes": ["checker", "rainbow", "colorbox", "cage"],
	"nativeScene": "checker",
	"channels": { "0": "env_cube", "1": "env_cube", "2": "noise", "3": "noise" },
	"arrays": [
		{ "name": "uBubbles", "type": "vec4", "count": 32, "feed": "bubbles" },
		{ "name": "uTop", "type": "vec4", "count": 3, "feed": "cageTop" }
	],
	"vars": [
		{ "name": "uCamPos", "type": "vec3", "feed": "camPos" },
		{ "name": "uCamRt", "type": "vec3", "feed": "camRt" },
		{ "name": "uCamUp", "type": "vec3", "feed": "camUp" },
		{ "name": "uCamFw", "type": "vec3", "feed": "camFw" },
		{ "name": "uSel", "type": "vec4", "feed": "camSel" }
	],
	"params": [
		{ "name": "uScene", "type": "int", "def": 0, "hidden": true },
		{ "name": "uCount", "type": "int", "label": "bubbles", "min": 1, "max": 32, "step": 1, "def": 14, "hint": "active bubbles" },
		{ "name": "uTopCount", "type": "int", "label": "on top", "min": 0, "max": 3, "step": 1, "def": 3, "scenes": ["cage"], "hint": "balls bouncing on the top face of the cage" },
		{ "name": "uCageSize", "type": "float", "label": "cage", "min": 2.0, "max": 4.5, "step": 0.1, "def": 2.2, "scenes": ["cage"], "hint": "cube half-size" },
		{ "name": "uWireWidth", "type": "float", "label": "wire", "min": 0.008, "max": 0.08, "step": 0.002, "def": 0.026, "scenes": ["cage"], "hint": "cage line thickness" },
		{ "name": "uGravity", "type": "float", "label": "gravity", "min": 2.5, "max": 10.0, "step": 0.25, "def": 4.75, "scenes": ["cage"], "hint": "top-ball gravity" },
		{ "name": "uWall", "type": "float", "label": "wall", "min": 0.005, "max": 0.5, "step": 0.005, "def": 0.06, "hint": "glass wall thickness, as a fraction of the bubble radius" },
		{ "name": "uIor", "type": "float", "label": "ior", "min": 1.0, "max": 2.0, "step": 0.01, "def": 1.45, "hint": "index of refraction of the glass" },
		{ "name": "uDensity", "type": "float", "label": "tint", "min": 0.0, "max": 3.0, "step": 0.05, "def": 0.7, "hint": "Beer-Lambert absorption through the wall" },
		{ "name": "uIrid", "type": "float", "label": "iris", "min": 0.0, "max": 1.0, "step": 0.05, "def": 0.55, "hint": "thin-film iridescence on the membrane" },
		{ "name": "uDisp", "type": "float", "label": "disp", "min": 0.0, "max": 1.0, "step": 0.05, "def": 0.35, "hint": "chromatic dispersion of the transmitted ray" },
		{ "name": "uLayers", "type": "float", "label": "layers", "min": 1, "max": 10, "step": 1, "def": 6, "hint": "max wall crossings per ray (depth of see-through)" },
		{ "name": "uSpread", "type": "float", "label": "spread", "min": 0.5, "max": 2.0, "step": 0.05, "def": 1.0, "scenes": ["checker", "rainbow", "colorbox"], "hint": "how far the drifting bubbles wander" },
		{ "name": "uSize", "type": "float", "label": "size", "min": 0.4, "max": 1.6, "step": 0.05, "def": 1.0, "hint": "bubble radius scale" },
		{ "name": "uAA", "type": "float", "label": "AA", "min": 0, "max": 1, "step": 1, "def": 0, "hint": "2x2 supersampling (4x cost)" }
	],
	"source":
`${GLSL.common}
${GLSL.raySphere}
${GLSL.camera}
${GLSL.env}
${GLSL.cageOverlay}
${GLSL.selGlow}

#define MAXB   32
#define EPS    0.0025
#define GOLDEN 0.6180339887

// per-bubble absorption coefficients, hue spread over the golden ratio
vec3 tintOf (float i) {
	float h = fract (i * GOLDEN);
	vec3 c = 0.5 + 0.5 * cos (2.0 * PI * (h + vec3 (0.0, 0.33, 0.67)));
	return mix (vec3 (0.45), vec3 (1.0) - c, 0.55);
}

// thin-film interference palette, d = optical thickness of the wall
vec3 filmTint (float d) {
	return 0.5 + 0.5 * cos (2.0 * PI * (d * vec3 (1.0, 0.82, 0.66) + vec3 (0.0, 0.28, 0.55)));
}

// One membrane crossing: refract in at face A, traverse the glass, refract out at
// face B. Adds the two Fresnel reflections, attenuates the throughput by the
// Beer-Lambert tint of the glass actually travelled, and leaves the bent ray in
// (ro, rd). \`bend\` accumulates the deviation, used for dispersion at the tail.
vec3 crossWall (inout vec3 ro, inout vec3 rd, inout vec3 tp, inout vec3 bend,
                vec4 sp, float idx, bool entering, float tHit) {
	vec3 col = vec3 (0.0);
	vec3 c = sp.xyz;
	float R = sp.w;
	float Ri = max (R * (1.0 - uWall), R * 0.02);
	vec3 rd0 = rd;
	float f0 = pow ((uIor - 1.0) / (uIor + 1.0), 2.0);

	// --- face A: where the ray meets this membrane -------------------------
	vec3 pA, nA;
	if (entering) {
		pA = ro + rd * tHit;
		nA = normalize (pA - c);
	} else {
		// inside this bubble: the wall we are about to cross starts at the far
		// side of the cavity (inner sphere); if there is none we are already in
		// the glass, so face A is the outer sphere itself.
		vec2 hi = ray_sphere (ro, rd, c, Ri);
		float tA = (hi.y > EPS && hi.y < tHit) ? hi.y : tHit;
		pA = ro + rd * tA;
		nA = -normalize (pA - c);
	}

	float ndv = saturate1 (dot (-rd, nA));
	float F = fresnel (ndv, f0);
	// optical thickness of the wall along this ray, with a slow soap-film swirl
	// riding on the bubble so the iridescence is not a flat angular ramp
	float sw = 1.0 + 0.55 * swirl ((pA - c) / R * 2.6 + vec3 (0.0, iTime * 0.05, idx * 3.1));
	float optical = uWall * R * 9.0 * sw / max (ndv, 0.16);
	vec3 film = mix (vec3 (1.0), filmTint (optical), uIrid);

	col += tp * F * envSun (reflect (rd, nA)) * film;
	// what the film reflects, it does not transmit: tint the throughput with the
	// complementary colour so the bands are visible through the bubble too
	tp *= (1.0 - F) * mix (vec3 (1.0), clamp (vec3 (1.45) - film, 0.0, 1.0), uIrid * 0.8);

	vec3 rd1 = refract (rd, nA, 1.0 / uIor);
	if (dot (rd1, rd1) < 1e-5) {           // total internal reflection: mirror off
		rd = reflect (rd, nA);
		ro = pA + rd * EPS;
		return col;
	}

	// --- through the glass to face B ---------------------------------------
	float chord;
	vec3 pB, nB;
	vec2 hin = ray_sphere (pA + rd1 * EPS, rd1, c, Ri);
	if (entering && hin.x > 0.0 && hin.y > hin.x) {
		chord = hin.x;                     // reached the cavity
		pB = pA + rd1 * (chord + EPS);
		nB = normalize (pB - c);
	} else {
		vec2 hout = ray_sphere (pA + rd1 * EPS, rd1, c, R);
		chord = max (hout.y, 0.0);         // thick rim / leaving the shell
		pB = pA + rd1 * (chord + EPS);
		nB = -normalize (pB - c);
	}

	tp *= exp (-tintOf (idx) * uDensity * chord * 3.5);

	float F2 = fresnel (saturate1 (dot (-rd1, nB)), f0);
	col += tp * F2 * envSun (reflect (rd1, nB)) * film * 0.85;
	tp *= (1.0 - F2);

	vec3 rd2 = refract (rd1, nB, uIor);
	if (dot (rd2, rd2) < 1e-5) rd2 = reflect (rd1, nB);

	bend += rd2 - rd0;
	ro = pB + rd2 * EPS;
	rd = normalize (rd2);
	return col;
}

vec3 trace (vec3 ro, vec3 rd) {
	vec3 col = vec3 (0.0);
	vec3 tp = vec3 (1.0);
	vec3 bend = vec3 (0.0);
	int layers = int (uLayers + 0.5);

	for (int L = 0; L < 10; L++) {
		if (L >= layers) break;

		// nearest membrane crossing ahead, over all active bubbles
		float bestT = BIG;
		int bi = -1;
		bool entering = true;
		for (int i = 0; i < MAXB; i++) {
			if (i >= uCount) break;
			vec4 sp = uBubbles[i];
			vec2 h = ray_sphere (ro, rd, sp.xyz, sp.w);
			if (h.y < h.x) continue;
			bool ent = h.x > EPS;
			float te = ent ? h.x : h.y;
			if (te <= EPS || te >= bestT) continue;
			bestT = te; bi = i; entering = ent;
		}
		if (bi < 0) break;

		col += crossWall (ro, rd, tp, bend, uBubbles[bi], float (bi), entering, bestT);
		if (max (tp.x, max (tp.y, tp.z)) < 0.02) return col;
	}

	// tail: what the surviving ray sees, split into three wavelengths along the
	// accumulated refraction bend (smooth chromatic fringes, no sampling noise)
	float k = uDisp * 0.4;
	if (k > 0.001 && dot (bend, bend) > 1e-6) {
		vec3 a = normalize (rd + bend * k);
		vec3 b = normalize (rd - bend * k);
		col += tp * vec3 (envSun (a).r, envSun (rd).g, envSun (b).b);
	} else {
		col += tp * envSun (rd);
	}
	return col;
}

void mainImage (out vec4 fragColor, in vec2 fragCoord) {
	vec3 ro, rd, col;
	if (uAA > 0.5) {
		col = vec3 (0.0);
		for (int j = 0; j < 4; j++) {
			vec2 o = vec2 (float (j / 2), float (j - (j / 2) * 2)) * 0.5 - 0.25;
			camera (fragCoord + o, ro, rd);
			col += cageOverlay (trace (ro, rd), ro, rd);
		}
		col *= 0.25;
	} else {
		camera (fragCoord, ro, rd);
		col = cageOverlay (trace (ro, rd), ro, rd);
	}
	col += selGlow (ro, rd);
	fragColor = vec4 (tonemap (col), 1.0);
}
`,
};
