// Benchmark variant of shaders/thick_glass.js — analytic glass spheres with a
// visible wall chord: per bubble the two ray-sphere roots give the glass
// thickness, Beer-Lambert absorption tints the transmitted env colour, the
// front wall reflects Fresnel-weighted. The camera/env are the shared bench
// scene (GLSL.camera / GLSL.env), the bubbles come from uBubbles[MAXB], and
// MAXB is #defined by js/bench.js to the selected bubble count.
window.BENCH_thick = {
	"id": "bench_thick",
	"src": "thick_glass",
	"title": "analytic walls + Beer-Lambert",
	"source": `${GLSL.common}
${GLSL.raySphere}
${GLSL.camera}
${GLSL.env}
${GLSL.absorb}

#define ETA (1.000293 / 1.55)

vec3 shadeBubble (vec3 ro, vec3 rd, vec4 sp, vec2 h, vec3 absorb) {
	float tE = max (h.x, 0.0);
	float tX = h.y;
	vec3 pe = ro + rd * tE;
	vec3 n = normalize (pe - sp.xyz);

	vec3 outer = envSun (reflect (rd, n));

	vec3 rdIn = refract (rd, n, ETA);
	vec3 through = outer;
	if (dot (rdIn, rdIn) > 0.001) {
		// wall chord drives the tint: thick rim reads denser than the middle
		float thickness = max (tX - tE, 0.0);
		vec3 transmit = exp (-absorb * thickness);
		float irid = 0.5 + 0.5 * cos (thickness * 8.0);
		vec3 tint = mix (vec3 (0.85, 0.95, 1.0), vec3 (1.0, 0.95, 0.85), irid);
		through = env (rdIn) * transmit * tint;
	}

	float F = fresnel (saturate1 (dot (-rd, n)), 0.04);
	vec3 col = mix (through, outer, F);

	// inner back-wall sheen where the refracted ray exits
	vec3 px = ro + rd * tX;
	vec3 bn = normalize (sp.xyz - px);
	vec3 backRefl = reflect (rdIn, bn);
	if (dot (backRefl, backRefl) > 0.5) {
		float bd = clamp (dot (bn, -rdIn), 0.0, 1.0);
		col += envSun (backRefl) * bd * 0.10;
	}
	return col;
}

void mainImage (out vec4 fragColor, in vec2 fragCoord) {
	vec3 ro, rd;
	camera (fragCoord, ro, rd);

	vec3 col = env (rd);

	float bestT = BIG;
	int bi = -1;
	vec2 bestH = vec2 (1.0, -1.0);
	int nB = min (uCount, MAXB);
	for (int i = 0; i < nB; i++) {
		vec4 sp = uBubbles[i];
		vec2 h = ray_sphere (ro, rd, sp.xyz, sp.w);
		if (h.y <= 0.0) continue;
		float te = max (h.x, 0.0);
		if (te < bestT) { bestT = te; bi = i; bestH = h; }
	}

	if (bi >= 0) {
		vec4 sp = uBubbles[bi];
		vec3 bub = shadeBubble (ro, rd, sp, bestH, absorbOf (bi));
		float tc = max (bestH.y - max (bestH.x, 0.0), 0.0);
		vec3 transmit = exp (-absorbOf (bi) * tc);
		float F = fresnel (saturate1 (dot (-rd, normalize (ro + rd * max (bestH.x, 0.0) - sp.xyz))), 0.04);
		float a = clamp (F + (1.0 - F) * (transmit.x + transmit.y + transmit.z) / 3.0, 0.0, 1.0);
		col = mix (col, bub, a);
	}

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
			{ "name": "uScene", "type": "int", "def": 0 }
		]
	}
};
