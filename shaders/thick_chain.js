// v0.2 C — chain refraction: the ray keeps travelling after it leaves a bubble.
// Same smin-merged SDF as the raymarched variant, but instead of stopping at
// the first ball the exiting refracted ray is re-injected as a new primary ray,
// up to 3 hops. Glass seen through glass, with the throughput carrying the
// Fresnel loss and the Beer-Lambert tint of every wall crossed so far.
window.SHADER_thick_chain = {
	"id": "thick_chain",
	"title": "solid glass bubbles - chain refraction, 3 hops (4)",
	"channels": { "0": "env_cube", "1": "env_cube", "2": "noise", "3": "noise" },
	"source":
`${GLSL.common}
${GLSL.camera}
${GLSL.bubbles4}
${GLSL.env}

#define MAXSTEPS 64
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
	float t = iTime;
	vec4 s0 = bubble (0, t), s1 = bubble (1, t), s2 = bubble (2, t), s3 = bubble (3, t);
	float d0 = length (p - s0.xyz) - s0.w;
	float d1 = length (p - s1.xyz) - s1.w;
	float d2 = length (p - s2.xyz) - s2.w;
	float d3 = length (p - s3.xyz) - s3.w;
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

	vec3 col = vec3 (0.0);
	vec3 tp = vec3 (1.0);   // throughput carried along the chain
	bool addTail = true;    // does the surviving ray still see the environment?

	for (int hop = 0; hop < HOPS; hop++) {
		vec2 h = march (ro, rd, 1.0);
		if (h.x >= MAXDIS) break;

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

	fragColor = vec4 (tonemap (col), 1.0);
}
`,
};
