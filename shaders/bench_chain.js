// Benchmark variant of shaders/thick_chain.js — raymarched smooth-min SDF with
// chain refraction: the transmitted ray is re-injected as a new primary ray up
// to 3 hops, so glass is seen through glass. The shared bench scene replaces
// the fixed 4 bubbles: the SDF is smin over all MAXB spheres from uBubbles and
// the tint comes from GLSL.absorb. MAXB is #defined by js/bench.js to the
// selected bubble count.
window.BENCH_chain = {
	"id": "bench_chain",
	"src": "thick_chain",
	"title": "raymarched smin + chain hops (3)",
	"source": `${GLSL.common}
${GLSL.camera}
${GLSL.env}
${GLSL.absorb}

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
	float d = BIG;
	float m = 0.0;
	int nB = min (uCount, MAXB);
	for (int i = 0; i < nB; i++) {
		vec4 sp = uBubbles[i];
		float h;
		d = sminK (d, length (p - sp.xyz) - sp.w, SMOOTH_K, h);
		m = mix (float (i), m, h);
	}
	return vec2 (d, m);
}

vec3 absorbMix (float m) { return absorbOf (int (m + 0.5)); }

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
	// uniform bound: keeps the ANGLE/HLSL translation from unrolling the loop
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

void mainImage (out vec4 fragColor, in vec2 fragCoord) {
	vec3 ro, rd;
	camera (fragCoord, ro, rd);

	vec3 col = vec3 (0.0);
	vec3 tp = vec3 (1.0);
	bool addTail = true;

	for (int hop = 0; hop < HOPS; hop++) {
		vec2 h = march (ro, rd, 1.0);
		if (h.x >= MAXDIS) break;

		vec3 pos = ro + rd * h.x;
		vec3 n = mapNormal (pos);
		vec3 absorb = absorbMix (h.y);
		float F = fresnel (saturate1 (dot (-rd, n)), F0);

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
			col += tp * envSun (reflect (rdIn, nOut)) * 0.5;
			addTail = false;
			break;
		}

		ro = pOut - nOut * SURF * 3.0;
		rd = rdOut;
		if (max (tp.x, max (tp.y, tp.z)) < 0.02) { addTail = false; break; }
	}

	if (addTail) col += tp * envSun (rd);
	fragColor = vec4 (tonemap (col), 1.0);
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
			{ "name": "uSteps", "type": "int", "def": 48, "hidden": true }
		]
	}
};
