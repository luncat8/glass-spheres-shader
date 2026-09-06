// v0.2 A — analytic solid-glass bubbles, true back-to-front composite.
// 4 animated spheres; per bubble both ray-sphere roots are solved analytically,
// the chord through the glass drives Beer-Lambert absorption, the front surface
// contributes a Fresnel-weighted env reflection. The four shaded layers are
// depth-sorted with a 5-comparator sorting network (no arrays, no dynamic
// indexing) and composited back to front, so overlaps read correctly.
window.SHADER_thick_analytic = {
	"id": "thick_analytic",
	"title": "solid glass bubbles - analytic, depth sorted (4)",
	"channels": { "0": "env_cube", "1": "env_cube", "2": "noise", "3": "noise" },
	"arrays": [
		{ "name": "uBubbles", "type": "vec4", "count": 4, "feed": "sceneBubbles4" },
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
		{ "name": "uScene", "type": "int", "label": "scene", "def": 0, "hint": "interior behind the bubbles", "options": [
			{ "value": 0, "label": "checker land" },
			{ "value": 1, "label": "rainbow" },
			{ "value": 2, "label": "color box" },
			{ "value": 3, "label": "cage" }
		] },
		{ "name": "uTopCount", "type": "int", "label": "on top", "min": 0, "max": 3, "step": 1, "def": 3, "hint": "balls above the cage" },
		{ "name": "uCageSize", "type": "float", "label": "cage", "min": 2.0, "max": 4.5, "step": 0.1, "def": 2.2, "hint": "cube half-size" },
		{ "name": "uSize", "type": "float", "label": "size", "min": 0.8, "max": 2.4, "step": 0.05, "def": 1.7, "hint": "inside and top sphere scale in the cage scene" },
		{ "name": "uWireWidth", "type": "float", "label": "wire", "min": 0.008, "max": 0.08, "step": 0.002, "def": 0.026, "hint": "cage line thickness" },
		{ "name": "uGravity", "type": "float", "label": "gravity", "min": 2.5, "max": 10.0, "step": 0.25, "def": 4.75, "hint": "top-ball gravity" }
	],
	"source":
`${GLSL.common}
${GLSL.raySphere}
${GLSL.camera}
${GLSL.bubbles4}
${GLSL.env}
${GLSL.cageOverlay}
${GLSL.selGlow}

#define IOR 1.55
#define F0  0.04

struct Layer { float t; vec3 c; float a; };

// shade one solid glass ball hit between t_enter and t_exit
Layer shadeBall (vec3 ro, vec3 rd, vec4 sp, vec3 absorb, vec2 h) {
	Layer L;
	L.t = h.x; L.c = vec3 (0.0); L.a = 0.0;
	if (h.y <= 0.0 || h.y < h.x) return L;

	float tE = max (h.x, 0.0);
	vec3 pe = ro + rd * tE;
	vec3 n = normalize (pe - sp.xyz) * (h.x < 0.0 ? -1.0 : 1.0);
	float ndv = saturate1 (dot (-rd, n));
	float F = fresnel (ndv, F0);

	vec3 reflCol = envSun (reflect (rd, n));

	vec3 rdIn = refract (rd, n, 1.0 / IOR);
	vec3 through = reflCol;
	float chord = max (h.y - tE, 0.0);
	if (dot (rdIn, rdIn) > 0.001) {
		// exit point of the refracted ray inside the same ball
		vec2 hi = ray_sphere (pe - n * 0.001, rdIn, sp.xyz, sp.w);
		chord = max (hi.y, 0.0);
		vec3 px = pe - n * 0.001 + rdIn * chord;
		vec3 nx = normalize (px - sp.xyz);
		vec3 rdOut = refract (rdIn, nx, IOR);
		if (dot (rdOut, rdOut) < 0.001) rdOut = reflect (rdIn, nx);
		vec3 far = env (rdOut);
		// small kick off the inside of the back wall: sells the second surface
		float back = pow (saturate1 (dot (rdIn, nx)), 3.0);
		through = far * exp (-absorb * chord) + envSun (reflect (rdIn, nx)) * back * 0.12;
	}

	L.c = mix (through, reflCol, F);
	// solid glass: everything behind is already accounted for by the refracted
	// sample, so the ball is opaque. Overlaps are resolved by the depth sort.
	L.a = 1.0;
	return L;
}

void cx (inout Layer a, inout Layer b) {
	if (b.t > a.t) { Layer t = a; a = b; b = t; }
}

void mainImage (out vec4 fragColor, in vec2 fragCoord) {
	vec3 ro, rd;
	camera (fragCoord, ro, rd);

	vec4 s0 = uBubbles[0], s1 = uBubbles[1];
	vec4 s2 = uBubbles[2], s3 = uBubbles[3];

	Layer l0 = shadeBall (ro, rd, s0, absorbOf (0), ray_sphere (ro, rd, s0.xyz, s0.w));
	Layer l1 = shadeBall (ro, rd, s1, absorbOf (1), ray_sphere (ro, rd, s1.xyz, s1.w));
	Layer l2 = shadeBall (ro, rd, s2, absorbOf (2), ray_sphere (ro, rd, s2.xyz, s2.w));
	Layer l3 = shadeBall (ro, rd, s3, absorbOf (3), ray_sphere (ro, rd, s3.xyz, s3.w));

	// sorting network -> l0 furthest .. l3 nearest
	cx (l0, l1); cx (l2, l3); cx (l0, l2); cx (l1, l3); cx (l1, l2);

	vec3 col = envSun (rd);
	col = mix (col, l0.c, l0.a);
	col = mix (col, l1.c, l1.a);
	col = mix (col, l2.c, l2.a);
	col = mix (col, l3.c, l3.a);
	col = cageOverlay (col, ro, rd);
	col += selGlow (ro, rd);

	fragColor = vec4 (tonemap (col), 1.0);
}
`,
};
