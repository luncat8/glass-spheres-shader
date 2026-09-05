// v0.2 B — raymarched solid glass, smin-merged bubbles.
// The 4 bubbles are a single SDF joined with a smooth union, so touching
// bubbles fuse like blobs instead of intersecting hard. Each hit refracts in,
// marches the inside with a negated SDF, refracts out, tints by Beer-Lambert
// over the interior chord, and hands the reflection ray to the next bounce
// (2 bounces).
window.SHADER_thick_raymarch = {
	"id": "thick_raymarch",
	"title": "solid glass bubbles - raymarched sdf, 2 bounces (4)",
	"channels": { "0": "env_cube", "1": "env_cube", "2": "noise", "3": "noise" },
	"source":
`${GLSL.common}
${GLSL.camera}
${GLSL.bubbles4}
${GLSL.env}

#define MAXSTEPS 64
#define MAXDIS   40.0
#define SURF     0.004
#define BOUNCES  2
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

// one glass hit. returns the shaded colour, and leaves the reflection ray in
// ro/rd plus the reflection weight in refl.
vec3 shadeHit (inout vec3 ro, inout vec3 rd, out float refl, out bool hit) {
	vec2 h = march (ro, rd, 1.0);
	hit = h.x < MAXDIS;
	refl = 0.0;
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

	float refl;
	bool hit;
	vec3 col = shadeHit (ro, rd, refl, hit);
	float filt = refl;
	for (int i = 0; i < BOUNCES; i++) {
		if (!hit || filt < 0.02) break;
		vec3 c = shadeHit (ro, rd, refl, hit);
		col += c * filt;
		filt *= refl;
	}

	fragColor = vec4 (tonemap (col), 1.0);
}
`,
};
