// Cage scene: pastel clouds, a black wire cube, freely bouncing glass spheres,
// and three opaque balls bouncing vertically on its top face.
//
// Sphere positions are supplied by js/scene.js. Rendering stays analytic: one
// ray/sphere pass keeps the nearest three layers and twelve ray/segment tests
// draw the cage edges, so the full 61-sphere setting remains bounded.
window.SHADER_cage = {
	"id": "cage",
	"title": "cage - pastel cloud cube and bouncing spheres",
	"channels": {},
	"arrays": [
		{ "name": "uInside", "type": "vec4", "count": 61, "feed": "cageInside" },
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
		{ "name": "uCount", "type": "int", "label": "inside", "min": 1, "max": 61, "step": 1, "def": 14, "hint": "spheres moving freely inside the cage" },
		{ "name": "uTopCount", "type": "int", "label": "on top", "min": 0, "max": 3, "step": 1, "def": 3, "hint": "balls bouncing vertically on the top face" },
		{ "name": "uCageSize", "type": "float", "label": "cage", "min": 2.0, "max": 4.5, "step": 0.1, "def": 2.2, "hint": "cube half-size" },
		{ "name": "uSize", "type": "float", "label": "size", "min": 0.5, "max": 1.6, "step": 0.05, "def": 1.0, "hint": "sphere radius scale" },
		{ "name": "uWireWidth", "type": "float", "label": "wire", "min": 0.008, "max": 0.08, "step": 0.002, "def": 0.026, "hint": "cage line thickness in world units" },
		{ "name": "uGravity", "type": "float", "label": "gravity", "min": 2.5, "max": 10.0, "step": 0.25, "def": 4.75, "hint": "gravity for the balls on top" },
		{ "name": "uWall", "type": "float", "label": "wall", "min": 0.005, "max": 0.25, "step": 0.005, "def": 0.045, "hint": "glass membrane thickness as a fraction of radius" },
		{ "name": "uIor", "type": "float", "label": "ior", "min": 1.0, "max": 2.0, "step": 0.01, "def": 1.42, "hint": "inside-sphere index of refraction" },
		{ "name": "uDensity", "type": "float", "label": "tint", "min": 0.0, "max": 3.0, "step": 0.05, "def": 0.55, "hint": "glass membrane absorption" },
		{ "name": "uIrid", "type": "float", "label": "iris", "min": 0.0, "max": 1.0, "step": 0.05, "def": 0.55, "hint": "thin-film colour on sphere rims" },
		{ "name": "uAA", "type": "float", "label": "render AA", "min": 0, "max": 1, "step": 1, "def": 0, "hint": "optional 2x2 shader supersampling in addition to the global AA button" }
	],
	"source":
`${GLSL.common}
#define uScene 3
${GLSL.raySphere}
${GLSL.camera}
${GLSL.env}
${GLSL.cageOverlay}

#define MAX_INSIDE 61
#define MAX_TOP 3
#define EPS 0.002
#define GOLDEN 0.61803398875

vec3 sphereTint (float id) {
	float h = fract (id * GOLDEN + 0.12);
	return 0.56 + 0.34 * cos (2.0 * PI * (h + vec3 (0.0, 0.33, 0.67)));
}

vec3 filmTint (float phase) {
	return 0.52 + 0.48 * cos (2.0 * PI * (phase * vec3 (1.0, 0.81, 0.64) + vec3 (0.02, 0.31, 0.58)));
}

struct Hit {
	float t;
	float tx;
	vec4 sphere;
	float id;
	float kind;
};

Hit noHit () {
	Hit h;
	h.t = BIG;
	h.tx = BIG;
	h.sphere = vec4 (0.0);
	h.id = -1.0;
	h.kind = -1.0;
	return h;
}

// Keep only the nearest three sphere layers. Three transparent shells are
// enough to preserve overlap depth without multiplying work by layer count.
void addHit (float t, float tx, vec4 sphere, float id, float kind,
             inout Hit h0, inout Hit h1, inout Hit h2) {
	Hit h;
	h.t = t;
	h.tx = tx;
	h.sphere = sphere;
	h.id = id;
	h.kind = kind;
	if (t < h0.t) {
		h2 = h1;
		h1 = h0;
		h0 = h;
		return;
	}
	if (t < h1.t) {
		h2 = h1;
		h1 = h;
		return;
	}
	if (t < h2.t) h2 = h;
}

void sphereHits (vec3 ro, vec3 rd, out Hit h0, out Hit h1, out Hit h2) {
	h0 = noHit ();
	h1 = noHit ();
	h2 = noHit ();
	for (int i = 0; i < MAX_INSIDE; i++) {
		if (i >= uCount) break;
		vec4 sphere = uInside[i];
		vec2 h = ray_sphere (ro, rd, sphere.xyz, sphere.w);
		if (h.y <= EPS || h.y < h.x) continue;
		float t = h.x > EPS ? h.x : h.y;
		addHit (t, h.y, sphere, float (i), 0.0, h0, h1, h2);
	}
	for (int i = 0; i < MAX_TOP; i++) {
		if (i >= uTopCount) break;
		vec4 sphere = uTop[i];
		vec2 h = ray_sphere (ro, rd, sphere.xyz, sphere.w);
		if (h.y <= EPS || h.y < h.x) continue;
		float t = h.x > EPS ? h.x : h.y;
		addHit (t, h.y, sphere, float (i), 1.0, h0, h1, h2);
	}
}

vec3 shadeGlass (vec3 behind, vec3 ro, vec3 rd, Hit h) {
	vec3 p = ro + rd * h.t;
	vec3 n = normalize (p - h.sphere.xyz);
	float ndv = saturate1 (dot (-rd, n));
	float f0 = pow ((uIor - 1.0) / (uIor + 1.0), 2.0);
	float F = fresnel (ndv, f0);
	float wallPath = uWall * h.sphere.w / max (ndv, 0.13);
	vec3 tint = sphereTint (h.id);
	vec3 transmit = behind * exp (-(vec3 (1.08) - tint) * uDensity * wallPath * 8.0);

	vec3 refr = refract (rd, n, 1.0 / max (uIor, 1.001));
	if (dot (refr, refr) > 0.001) {
		// A small directional contribution suggests refraction without replacing
		// geometry already composed behind this transparent shell.
		transmit = mix (transmit, transmit * envPastel (refr), 0.08 * (1.0 - F));
	}

	float sw = swirl ((p - h.sphere.xyz) / h.sphere.w * 4.0
		+ vec3 (0.0, iTime * 0.08, h.id * 1.7));
	float optical = wallPath * 12.0 * (1.0 + 0.35 * sw);
	vec3 film = mix (vec3 (1.0), filmTint (optical), uIrid);
	vec3 reflected = envSun (reflect (rd, n)) * film;
	vec3 col = mix (transmit, reflected, F);
	col = mix (col, col * (0.78 + 0.38 * tint), 0.22);
	vec3 glassBody = behind * 0.72 + tint * 0.32;
	col = mix (col, glassBody, 0.12 + 0.08 * (1.0 - ndv));

	float rim = pow (1.0 - ndv, 2.4);
	float backRim = 0.0;
	if (h.tx > h.t + EPS) {
		vec3 nx = normalize (ro + rd * h.tx - h.sphere.xyz);
		backRim = pow (1.0 - abs (dot (rd, nx)), 4.0);
	}
	col += film * (0.085 + 0.42 * rim + 0.12 * backRim) * tint;
	return col;
}

vec3 shadeSphere (vec3 behind, vec3 ro, vec3 rd, Hit h) {
	if (h.kind > 0.5) return cageShadeTop (behind, ro, rd, h.sphere, h.t, h.id);
	return shadeGlass (behind, ro, rd, h);
}

vec3 selectionGlow (vec3 ro, vec3 rd) {
	if (uSel.w <= 0.0) return vec3 (0.0);
	vec2 h = ray_sphere (ro, rd, uSel.xyz, uSel.w);
	if (h.y <= EPS || h.y < h.x) return vec3 (0.0);
	float t = h.x > EPS ? h.x : h.y;
	vec3 n = normalize (ro + rd * t - uSel.xyz);
	float rim = pow (1.0 - abs (dot (n, rd)), 2.5);
	return vec3 (0.24, 1.0, 0.57) * rim * 0.48;
}

vec3 trace (vec3 ro, vec3 rd) {
	Hit h0, h1, h2;
	sphereHits (ro, rd, h0, h1, h2);
	float wireT, wireMask;
	cageWireHit (ro, rd, wireT, wireMask);

	vec3 col = envSun (rd);
	bool wireDone = wireMask <= 0.0;
	// Compose from far to near. The wire is inserted at its measured ray depth
	// instead of being an always-on-top screen overlay.
	if (h2.kind >= 0.0) {
		if (!wireDone && wireT > h2.t) { col = cageDrawWire (col, wireMask); wireDone = true; }
		col = shadeSphere (col, ro, rd, h2);
	}
	if (h1.kind >= 0.0) {
		if (!wireDone && wireT > h1.t) { col = cageDrawWire (col, wireMask); wireDone = true; }
		col = shadeSphere (col, ro, rd, h1);
	}
	if (h0.kind >= 0.0) {
		if (!wireDone && wireT > h0.t) { col = cageDrawWire (col, wireMask); wireDone = true; }
		col = shadeSphere (col, ro, rd, h0);
	}
	if (!wireDone) col = cageDrawWire (col, wireMask);
	return col;
}

void mainImage (out vec4 fragColor, in vec2 fragCoord) {
	vec3 ro, rd, col;
	if (uAA > 0.5) {
		col = vec3 (0.0);
		for (int i = 0; i < 4; i++) {
			vec2 o = vec2 (float (i & 1), float (i >> 1)) * 0.5 - 0.25;
			camera (fragCoord + o, ro, rd);
			col += trace (ro, rd);
		}
		col *= 0.25;
	} else {
		camera (fragCoord, ro, rd);
		col = trace (ro, rd);
	}
	// Use the centre ray for a stable click-selection rim after supersampling.
	camera (fragCoord, ro, rd);
	col += selectionGlow (ro, rd);
	fragColor = vec4 (tonemap (col), 1.0);
}
`,
};
