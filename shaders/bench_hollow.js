// Benchmark variant of shaders/hollow_bubbles.js — real hollow membrane walls.
// Same analytic membrane tracing as the production shader (nearest wall crossing
// among all active bubbles, refract in / traverse the glass / refract out, up to
// uLayers crossings), but up to MAXB bubbles from the shared uBubbles array and
// the shared procedural environment. No selection halo, AA fixed at 1 so every
// bench entry pays exactly one ray per pixel.
// MAXB is #defined by js/bench.js to the selected bubble count.
window.BENCH_hollow = {
	"id": "bench_hollow",
	"src": "hollow_bubbles",
	"title": "hollow membranes (event loop)",
	"source": `${GLSL.common}
${GLSL.raySphere}
${GLSL.camera}
${GLSL.env}

#define EPS    0.0025
#define GOLDEN 0.6180339887

vec3 tintOf (float i) {
	float h = fract (i * GOLDEN);
	vec3 c = 0.5 + 0.5 * cos (2.0 * PI * (h + vec3 (0.0, 0.33, 0.67)));
	return mix (vec3 (0.45), vec3 (1.0) - c, 0.55);
}

vec3 filmTint (float d) {
	return 0.5 + 0.5 * cos (2.0 * PI * (d * vec3 (1.0, 0.82, 0.66) + vec3 (0.0, 0.28, 0.55)));
}

vec3 crossWall (inout vec3 ro, inout vec3 rd, inout vec3 tp, inout vec3 bend,
                vec4 sp, float idx, bool entering, float tHit) {
	vec3 col = vec3 (0.0);
	vec3 c = sp.xyz;
	float R = sp.w;
	float Ri = max (R * (1.0 - uWall), R * 0.02);
	vec3 rd0 = rd;
	float f0 = pow ((uIor - 1.0) / (uIor + 1.0), 2.0);

	vec3 pA, nA;
	if (entering) {
		pA = ro + rd * tHit;
		nA = normalize (pA - c);
	} else {
		vec2 hi = ray_sphere (ro, rd, c, Ri);
		float tA = (hi.y > EPS && hi.y < tHit) ? hi.y : tHit;
		pA = ro + rd * tA;
		nA = -normalize (pA - c);
	}

	float ndv = saturate1 (dot (-rd, nA));
	float F = fresnel (ndv, f0);
	float sw = 1.0 + 0.55 * swirl ((pA - c) / R * 2.6 + vec3 (0.0, iTime * 0.05, idx * 3.1));
	float optical = uWall * R * 9.0 * sw / max (ndv, 0.16);
	vec3 film = mix (vec3 (1.0), filmTint (optical), uIrid);

	col += tp * F * envSun (reflect (rd, nA)) * film;
	tp *= (1.0 - F) * mix (vec3 (1.0), clamp (vec3 (1.45) - film, 0.0, 1.0), uIrid * 0.8);

	vec3 rd1 = refract (rd, nA, 1.0 / uIor);
	if (dot (rd1, rd1) < 1e-5) {
		rd = reflect (rd, nA);
		ro = pA + rd * EPS;
		return col;
	}

	float chord;
	vec3 pB, nB;
	vec2 hin = ray_sphere (pA + rd1 * EPS, rd1, c, Ri);
	if (entering && hin.x > 0.0 && hin.y > hin.x) {
		chord = hin.x;
		pB = pA + rd1 * (chord + EPS);
		nB = normalize (pB - c);
	} else {
		vec2 hout = ray_sphere (pA + rd1 * EPS, rd1, c, R);
		chord = max (hout.y, 0.0);
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
	int layers = clamp (int (uLayers + 0.5), 1, 10);
	int nB = min (uCount, MAXB);

	// uniform loop bounds keep ANGLE/HLSL from unrolling 10 x MAXB iterations
	for (int L = 0; L < layers; L++) {
		float bestT = BIG;
		int bi = -1;
		bool entering = true;
		for (int i = 0; i < nB; i++) {
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
	vec3 ro, rd;
	camera (fragCoord, ro, rd);
	fragColor = vec4 (tonemap (trace (ro, rd)), 1.0);
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
			{ "name": "uWall", "type": "float", "def": 0.06 },
			{ "name": "uIor", "type": "float", "def": 1.45 },
			{ "name": "uDensity", "type": "float", "def": 0.7 },
			{ "name": "uIrid", "type": "float", "def": 0.55 },
			{ "name": "uDisp", "type": "float", "def": 0.35 },
			{ "name": "uLayers", "type": "float", "def": 6 }
		]
	}
};
