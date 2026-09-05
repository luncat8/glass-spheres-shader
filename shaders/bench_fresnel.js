// Benchmark variant of shaders/multi_fresnel.js — analytic refractive spheres
// with an fbm-tinted fresnel environment reflection.
// The hard-coded 4 bubbles are replaced by the shared uBubbles[MAXB] array, so
// this entry can be measured against every other technique on the same scene:
// same cloud, same camera basis, same procedural environment (GLSL.env),
// same resolution. No iChannel textures in the bench — the surface tint is a
// local 2D value-noise fbm, so the measured cost is the bubble algorithm only.
// MAXB is #defined by js/bench.js to the selected bubble count.
window.BENCH_fresnel = {
	"id": "bench_fresnel",
	"src": "multi_fresnel",
	"title": "analytic spheres + fresnel",
	"source": `${GLSL.common}
${GLSL.raySphere}
${GLSL.camera}
${GLSL.env}

float hash21 (vec2 p) {
	p = fract (p * vec2 (123.34, 345.45));
	p += dot (p, p + 34.345);
	return fract (p.x * p.y);
}

float vnoise (vec2 p) {
	vec2 i = floor (p);
	vec2 f = fract (p);
	f = f * f * (3.0 - 2.0 * f);
	float a = hash21 (i);
	float b = hash21 (i + vec2 (1.0, 0.0));
	float c = hash21 (i + vec2 (0.0, 1.0));
	float d = hash21 (i + vec2 (1.0, 1.0));
	return mix (mix (a, b, f.x), mix (c, d, f.x), f.y);
}

float fbm (vec2 p) {
	return 0.5 * vnoise (p) + 0.25 * vnoise (p * 2.03) + 0.125 * vnoise (p * 4.07);
}

vec3 surfTint (vec3 n, float i) {
	vec2 sp = vec2 (atan (n.z, n.x), asin (n.y)) * 0.5;
	return hsv2rgb (vec3 (fract (i * 0.618 + fbm (sp * 2.0) * 1.7), 1.0, 1.0));
}

float fresnelStep (vec3 I, vec3 N) {
	return clamp (pow (1.0 + dot (I, N), 0.7), 0.0, 1.0);
}

void mainImage (out vec4 fragColor, in vec2 fragCoord) {
	vec3 ro, rd;
	camera (fragCoord, ro, rd);

	vec3 col = env (rd);

	// nearest front hit and furthest back hit over all active bubbles
	float tF = BIG, tB = -1.0;
	int fi = -1, bi = -1;
	for (int i = 0; i < MAXB; i++) {
		if (i >= uCount) break;
		vec4 sp = uBubbles[i];
		vec2 h = ray_sphere (ro, rd, sp.xyz, sp.w);
		if (h.y <= 0.0) continue;
		float a = max (h.x, 0.0);
		if (a < tF) { tF = a; fi = i; }
		if (h.y > tB) { tB = h.y; bi = i; }
	}

	if (fi >= 0) {
		vec4 spf = uBubbles[fi];
		vec2 hf = ray_sphere (ro, rd, spf.xyz, spf.w);
		vec3 pt0 = ro + rd * max (hf.x, 0.0);
		vec3 n0 = normalize (pt0 - spf.xyz);
		vec3 r0 = reflect (rd, n0);
		vec3 s0 = surfTint (n0, float (fi));
		vec3 refl0 = envSun (r0);
		col = mix (col, refl0 + refl0 * s0, fresnelStep (rd, n0));
		if (bi >= 0 && bi != fi) {
			vec4 spb = uBubbles[bi];
			vec2 hb = ray_sphere (ro, rd, spb.xyz, spb.w);
			vec3 pt1 = ro + rd * hb.y;
			vec3 n1 = normalize (spb.xyz - pt1);
			vec3 r1 = reflect (rd, n1);
			vec3 refl1 = envSun (r1);
			col = mix (col, refl1 + refl1 * surfTint (n1, float (bi)), fresnelStep (rd, n1) * 0.6);
		}
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
