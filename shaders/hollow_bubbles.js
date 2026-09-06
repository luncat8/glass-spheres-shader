// v0.4 — hollow glass objects with a real membrane wall.
//
// Up to 32 concentric-shell objects (outer size R, inner shell = the same shape
// scaled by 1-uWall). A ray does not hit "bubbles", it crosses *membranes*: at
// every step the nearest surface crossing ahead is resolved, the wall is
// traversed with two refractions (outer face -> glass -> inner face), and the
// bent ray carries on. Near wall and far wall are separate events, so the far
// side of the shell is visible through the near side - the thing that makes a
// bubble read as hollow rather than solid. Depth order is exact (events are
// consumed in increasing t), and intersecting or nested objects need no special
// case: they are simply the next event.
//
// Everything is analytic - no marching, no stochastic sampling, no noise - so
// the shapes are the analytic ones (sphere, cube, tetra via GLSL.shape).
window.SHADER_hollow_bubbles = {
	"id": "hollow_bubbles",
	"title": "hollow glass bubbles - membrane wall, 32 objects, sliders",
	"group": "scene",
	"scenes": ["checker", "rainbow", "colorbox", "cage", "terrain"],
	"nativeScene": "checker",
	"shapes": ["sphere", "cube", "tetra"],
	"nativeShape": "sphere",
	"channels": { "0": "env_cube", "1": "env_cube", "2": "noise", "3": "noise" },
	"arrays": [
		{ "name": "uBubbles", "type": "vec4", "count": 32, "feed": "bubbles" },
		{ "name": "uSpin", "type": "vec4", "count": 32, "feed": "spin" },
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
		{ "name": "uCount", "type": "int", "label": "bubbles", "min": 1, "max": 32, "step": 1, "def": 14, "hint": "active objects" },
		{ "name": "uTopCount", "type": "int", "label": "on top", "min": 0, "max": 3, "step": 1, "def": 3, "scenes": ["cage"], "hint": "balls bouncing on the top face of the cage" },
		{ "name": "uCageSize", "type": "float", "label": "cage", "min": 2.0, "max": 4.5, "step": 0.1, "def": 2.2, "scenes": ["cage"], "hint": "cube half-size" },
		{ "name": "uWireWidth", "type": "float", "label": "wire", "min": 0.008, "max": 0.08, "step": 0.002, "def": 0.026, "scenes": ["cage"], "hint": "cage line thickness" },
		{ "name": "uGravity", "type": "float", "label": "gravity", "min": 2.5, "max": 10.0, "step": 0.25, "def": 4.75, "scenes": ["cage"], "hint": "top-ball gravity" },
		{ "name": "uWall", "type": "float", "label": "wall", "min": 0.005, "max": 0.5, "step": 0.005, "def": 0.06, "hint": "glass wall thickness, as a fraction of the object size" },
		{ "name": "uIor", "type": "float", "label": "ior", "min": 1.0, "max": 2.0, "step": 0.01, "def": 1.45, "hint": "index of refraction of the glass" },
		{ "name": "uDensity", "type": "float", "label": "tint", "min": 0.0, "max": 3.0, "step": 0.05, "def": 0.7, "hint": "Beer-Lambert absorption through the wall" },
		{ "name": "uIrid", "type": "float", "label": "iris", "min": 0.0, "max": 1.0, "step": 0.05, "def": 0.55, "hint": "thin-film iridescence on the membrane" },
		{ "name": "uDisp", "type": "float", "label": "disp", "min": 0.0, "max": 1.0, "step": 0.05, "def": 0.35, "hint": "chromatic dispersion of the transmitted ray" },
		{ "name": "uLayers", "type": "float", "label": "layers", "min": 1, "max": 10, "step": 1, "def": 6, "hint": "max wall crossings per ray (depth of see-through)" },
		{ "name": "uSpread", "type": "float", "label": "spread", "min": 0.5, "max": 2.0, "step": 0.05, "def": 1.0, "scenes": ["checker", "rainbow", "colorbox"], "hint": "how far the drifting bubbles wander" },
		{ "name": "uSize", "type": "float", "label": "size", "min": 0.4, "max": 1.6, "step": 0.05, "def": 1.0, "hint": "object size scale" },
		{ "name": "uAA", "type": "float", "label": "AA", "min": 0, "max": 1, "step": 1, "def": 0, "hint": "2x2 supersampling (4x cost)" },
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

#define MAXB   32
#define EPS    0.0025
#define GOLDEN 0.6180339887

// per-bubble absorption coefficients, hue spread over the golden ratio
vec3 tintOf (float i) {
\tfloat h = fract (i * GOLDEN);
\tvec3 c = 0.5 + 0.5 * cos (2.0 * PI * (h + vec3 (0.0, 0.33, 0.67)));
\treturn mix (vec3 (0.45), vec3 (1.0) - c, 0.55);
}

// thin-film interference palette, d = optical thickness of the wall
vec3 filmTint (float d) {
\treturn 0.5 + 0.5 * cos (2.0 * PI * (d * vec3 (1.0, 0.82, 0.66) + vec3 (0.0, 0.28, 0.55)));
}

// the cavity: the same shape around the same centre, scaled by the wall fraction
vec4 innerOf (vec4 sp) { return vec4 (sp.xyz, max (sp.w * (1.0 - uWall), sp.w * 0.02)); }

// One membrane crossing: refract in at face A, traverse the glass, refract out at
// face B. Adds the two Fresnel reflections, attenuates the throughput by the
// Beer-Lambert tint of the glass actually travelled, and leaves the bent ray in
// (ro, rd). \`bend\` accumulates the deviation, used for dispersion at the tail.
// nHit is the outer surface normal at the event, facing the ray.
vec3 crossWall (inout vec3 ro, inout vec3 rd, inout vec3 tp, inout vec3 bend,
                vec4 sp, vec4 spin, float idx, bool entering, float tHit, vec3 nHit) {
\tvec3 col = vec3 (0.0);
\tvec3 c = sp.xyz;
\tfloat R = sp.w;
\tvec4 inner = innerOf (sp);
\tvec3 rd0 = rd;
\tfloat f0 = pow ((uIor - 1.0) / (uIor + 1.0), 2.0);
\tvec3 n1, n2;

\t// --- face A: where the ray meets this membrane -------------------------
\tvec3 pA, nA;
\tif (entering) {
\t\tpA = ro + rd * tHit;
\t\tnA = nHit;
\t} else {
\t\t// inside this object: the wall we are about to cross starts at the far
\t\t// side of the cavity (inner surface); if there is none we are already
\t\t// in the glass, so face A is the outer surface itself.
\t\tvec2 hi = shapeHit (uShape, ro, rd, inner, spin, n1, n2);
\t\tbool cavity = hi.y > EPS && hi.y < tHit && hi.y >= hi.x;
\t\tpA = ro + rd * (cavity ? hi.y : tHit);
\t\tnA = cavity ? -n2 : nHit;
\t}

\tfloat ndv = saturate1 (dot (-rd, nA));
\tfloat F = fresnel (ndv, f0);
\t// optical thickness of the wall along this ray, with a slow soap-film swirl
\t// riding on the bubble so the iridescence is not a flat angular ramp
\tfloat sw = 1.0 + 0.55 * swirl ((pA - c) / R * 2.6 + vec3 (0.0, iTime * 0.05, idx * 3.1));
\tfloat optical = uWall * R * 9.0 * sw / max (ndv, 0.16);
\tvec3 film = mix (vec3 (1.0), filmTint (optical), uIrid);

\tcol += tp * F * envSun (reflect (rd, nA)) * film;
\t// what the film reflects, it does not transmit: tint the throughput with the
\t// complementary colour so the bands are visible through the bubble too
\ttp *= (1.0 - F) * mix (vec3 (1.0), clamp (vec3 (1.45) - film, 0.0, 1.0), uIrid * 0.8);

\tvec3 rd1 = refract (rd, nA, 1.0 / uIor);
\tif (dot (rd1, rd1) < 1e-5) {           // total internal reflection: mirror off
\t\trd = reflect (rd, nA);
\t\tro = pA + rd * EPS;
\t\treturn col;
\t}

\t// --- through the glass to face B ---------------------------------------
\tfloat chord;
\tvec3 q = pA + rd1 * EPS;
\tvec3 pB, nB;
\tvec2 hin = shapeHit (uShape, q, rd1, inner, spin, n1, n2);
\tif (entering && hin.x > 0.0 && hin.y > hin.x) {
\t\tchord = hin.x;                     // reached the cavity
\t\tpB = q + rd1 * chord;
\t\tnB = n1;
\t} else {
\t\tvec2 hout = shapeHit (uShape, q, rd1, sp, spin, n1, n2);
\t\tchord = max (hout.y, 0.0);         // thick rim / leaving the shell
\t\tpB = q + rd1 * chord;
\t\tnB = -n2;
\t}

\ttp *= exp (-tintOf (idx) * uDensity * chord * 3.5);

\tfloat F2 = fresnel (saturate1 (dot (-rd1, nB)), f0);
\tcol += tp * F2 * envSun (reflect (rd1, nB)) * film * 0.85;
\ttp *= (1.0 - F2);

\tvec3 rd2 = refract (rd1, nB, uIor);
\tif (dot (rd2, rd2) < 1e-5) rd2 = reflect (rd1, nB);

\tbend += rd2 - rd0;
\tro = pB + rd2 * EPS;
\trd = normalize (rd2);
\treturn col;
}

// membrane tracing with land culling: membranes behind the land block are
// skipped, so a heightfield in front occludes bubbles behind it, while one
// behind stays visible through the transparent shells (bug fix: old code
// used landOverlay(firstT) which hid land behind the first membrane).
vec3 traceMembranes (vec3 ro0, vec3 rd0, float landT,
                     out float firstT,
                     out vec3 finalRo, out vec3 finalRd,
                     out vec3 finalTp, out vec3 finalBend) {
\tvec3 col = vec3 (0.0);
\tvec3 tp = vec3 (1.0);
\tvec3 bend = vec3 (0.0);
\tint layers = int (uLayers + 0.5);
\tfirstT = BIG;
\tvec3 ro = ro0;
\tvec3 rd = rd0;

\tfor (int L = 0; L < 10; L++) {
\t\tif (L >= layers) break;

\t\tfloat bestT = BIG;
\t\tint bi = -1;
\t\tbool entering = true;
\t\tvec3 bestN = vec3 (0.0);
\t\tvec3 nA, nB;
\t\tfor (int i = 0; i < MAXB; i++) {
\t\t\tif (i >= uCount) break;
\t\t\tvec2 h = shapeHit (uShape, ro, rd, uBubbles[i], uSpin[i], nA, nB);
\t\t\tif (h.y < h.x) continue;
\t\t\tbool ent = h.x > EPS;
\t\t\tfloat te = ent ? h.x : h.y;
\t\t\tif (te <= EPS || te >= bestT) continue;
\t\t\tbestT = te; bi = i; entering = ent; bestN = ent ? nA : -nB;
\t\t}
\t\tif (bi < 0) break;
\t\tif (bestT >= landT) break;
\t\tif (L == 0) firstT = bestT;

\t\tcol += crossWall (ro, rd, tp, bend, uBubbles[bi], uSpin[bi], float (bi), entering, bestT, bestN);
\t\tif (max (tp.x, max (tp.y, tp.z)) < 0.02) {
\t\t\tfinalRo = ro; finalRd = rd; finalTp = tp; finalBend = bend;
\t\t\treturn col;
\t\t}
\t}
\tfinalRo = ro; finalRd = rd; finalTp = tp; finalBend = bend;
\treturn col;
}

vec3 shadeRay (vec3 ro, vec3 rd) {
\tfloat tLand; vec3 nLand; int idLand;
\tlandHit (ro, rd, tLand, nLand, idLand);
\tfloat landT = idLand >= 0 ? tLand : BIG;

\tfloat firstT;
\tvec3 finalRo, finalRd, finalTp, finalBend;
\tvec3 col = traceMembranes (ro, rd, landT, firstT, finalRo, finalRd, finalTp, finalBend);

\tvec3 tailBg;
\t{
\t\tfloat t2; vec3 n2; int id2;
\t\tlandHit (finalRo, finalRd, t2, n2, id2);
\t\tif (id2 >= 0) tailBg = landShade (finalRo, finalRd, t2, n2, id2);
\t\telse tailBg = envSun (finalRd);
\t}

\tfloat k = uDisp * 0.4;
\tif (k > 0.001 && dot (finalBend, finalBend) > 1e-6) {
\t\tvec3 a = normalize (finalRd + finalBend * k);
\t\tvec3 b = normalize (finalRd - finalBend * k);
\t\tfloat tA; vec3 nA; int idA;
\t\tlandHit (finalRo, a, tA, nA, idA);
\t\tvec3 bgA = idA >= 0 ? landShade (finalRo, a, tA, nA, idA) : envSun (a);
\t\tfloat tB; vec3 nB; int idB;
\t\tlandHit (finalRo, b, tB, nB, idB);
\t\tvec3 bgB = idB >= 0 ? landShade (finalRo, b, tB, nB, idB) : envSun (b);
\t\tcol += finalTp * vec3 (bgA.r, tailBg.g, bgB.b);
\t} else {
\t\tcol += finalTp * tailBg;
\t}

\treturn cageOverlay (col, ro, rd);
}

void mainImage (out vec4 fragColor, in vec2 fragCoord) {
\tvec3 ro, rd, col;
\tif (uAA > 0.5) {
\t\tcol = vec3 (0.0);
\t\tfor (int j = 0; j < 4; j++) {
\t\t\tvec2 o = vec2 (float (j / 2), float (j - (j / 2) * 2)) * 0.5 - 0.25;
\t\t\tcamera (fragCoord + o, ro, rd);
\t\t\tcol += shadeRay (ro, rd);
\t\t}
\t\tcol *= 0.25;
\t} else {
\t\tcamera (fragCoord, ro, rd);
\t\tcol = shadeRay (ro, rd);
\t}
\tcol += selGlow (ro, rd);
\tfragColor = vec4 (tonemap (col), 1.0);
}
`,
};
