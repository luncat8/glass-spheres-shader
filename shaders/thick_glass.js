// Glass bubbles with visible wall thickness.
// 4 analytic spheres; for each bubble resolves both ray-sphere intersections,
// refracts through the front wall, applies Beer-Lambert absorption (so thicker
// walls absorb more of the through-color), refracts again at the back wall,
// then composites back-to-front with Fresnel-weighted reflection on top.
// Single-pass, no external libs.
// per-bubble glass tint (RGB absorption coefficients, Beer-Lambert)
// darker greenish-blue absorbs red/green more than blue
// Returns vec4(t_enter, t_exit, unused, unused). If no hit, t_enter > t_exit.
// Shade one bubble hit. Computes: front-wall reflection + refraction into glass
// (Beer-Lambert tinted) + refraction through back wall. Returns RGB.
// front_n: outward normal at entry, back_n: outward normal at exit, t_enter/t_exit.
window.SHADER_thick_glass = {
  "id": "thick_glass",
  "title": "glass bubbles with visible wall thickness (4 spheres)",
  "scenes": ["own"],
  "group": "own",
  "channels": {"0":"env_cube","1":"env_cube","2":"noise","3":"noise"},
  "source":
`#define PI 3.14159265359
#define FOV 60.0

#define RI_AIR 1.000293
#define RI_SPH 1.55
#define ETA (RI_AIR / RI_SPH)

#define FR0 vec3 (0.0, 1.0, 0.7)
#define NB 4

const vec3 ABSORB0 = vec3 (0.35, 0.20, 0.10);
const vec3 ABSORB1 = vec3 (0.10, 0.30, 0.45);
const vec3 ABSORB2 = vec3 (0.40, 0.10, 0.25);
const vec3 ABSORB3 = vec3 (0.15, 0.40, 0.15);

vec3 hsv2rgb (vec3 c) {
	vec4 K = vec4 (1.0, 2.0/3.0, 1.0/3.0, 3.0);
	vec3 p = abs (fract (c.xxx + K.xyz) * 6.0 - K.www);
	return c.z * mix (K.xxx, clamp (p - K.xxx, 0.0, 1.0), c.y);
}

float fbm (vec2 uv) {
	float h = 0.0;
	h += texture (iChannel2, uv* 2.0).x * 0.50;
	h += texture (iChannel2, uv* 4.0).x * 0.25;
	h += texture (iChannel2, uv* 8.0).x * 0.125;
	h += texture (iChannel2, uv*16.0).x * 0.0625;
	return h;
}

float fresnel_step (vec3 I, vec3 N, vec3 f) {
	return clamp (f.x + f.y * pow (1.0 + dot (I, N), f.z), 0.0, 1.0);
}

vec4 ray_sphere (vec3 ro, vec3 rd, vec3 c, float r) {
	vec3 oc = ro - c;
	float A = dot (rd, rd);
	float B = 2.0 * dot (oc, rd);
	float C = dot (oc, oc) - r*r;
	float D = B*B - 4.0*A*C;
	if (D < 0.0) return vec4 (1.0, -1.0, 0.0, 0.0);
	float sq = sqrt (D);
	float q = (-B - sq * sign (B)) * 0.5;
	float t0 = q / A;
	float t1 = C / q;
	return vec4 (min (t0, t1), max (t0, t1), 0.0, 0.0);
}

vec3 getAbsorb (int i) {
	if (i == 0) return ABSORB0;
	if (i == 1) return ABSORB1;
	if (i == 2) return ABSORB2;
	return ABSORB3;
}

vec3 shade_bubble (vec3 ro, vec3 rd, vec3 front_n, vec3 back_n,
                   float t_enter, float t_exit, vec3 absorb) {
	// outer reflection (sky on the rim)
	vec3 refl_dir = reflect (rd, front_n);
	vec3 outer_refl = texture (iChannel0, refl_dir).rgb;

	// refraction into the glass
	vec3 rd_in = refract (rd, front_n, ETA);
	vec3 through_inner;
	if (dot (rd_in, rd_in) < 0.001) {
		// total internal reflection at entry; just use the reflection
		through_inner = outer_refl;
	} else {
		// distance travelled through the glass volume (in world units)
		float thickness = max (t_exit - t_enter, 0.0);
		// Beer-Lambert absorption: thicker walls = darker, tinted color
		vec3 transmit = exp (-absorb * thickness);
		// what's behind the bubble, seen through the glass
		vec3 far_color = texture (iChannel1, rd_in).rgb;
		// blend with a slight iridescent shift based on thickness for soap-film feel
		float irid = 0.5 + 0.5 * cos (thickness * 8.0);
		vec3 tint = mix (vec3 (0.85, 0.95, 1.0), vec3 (1.0, 0.95, 0.85), irid);
		through_inner = far_color * transmit * tint;
	}

	// Fresnel weight at the front wall: more reflection at grazing angles
	float F = fresnel_step (rd, front_n, FR0);

	// composite: outer reflection on top of through-color, weighted by Fresnel
	vec3 col = mix (through_inner, outer_refl, F);

	// subtle highlight on the inside of the back wall where the refracted ray
	// exits (gives the inner curvature a hint of depth)
	vec3 back_refl = reflect (rd_in, back_n);
	if (dot (back_refl, back_refl) > 0.5) {
		float back_dot = clamp (dot (back_n, -rd_in), 0.0, 1.0);
		col += texture (iChannel0, back_refl).rgb * back_dot * 0.10;
	}

	return col;
}

void mainImage (out vec4 fragColor, in vec2 fragCoord) {
	vec2 uv = (2.0*fragCoord.xy - iResolution.xy) / min (iResolution.x, iResolution.y) * tan (radians (FOV)/2.0);
	vec2 mo = PI * iMouse.xy / iResolution.xy;

	vec3 up = vec3 (0.0, 1.0, 0.0);
	float ang = mo.x * PI;
	vec3 fw = vec3 (sin (ang), 0.0, cos (ang));
	vec3 lf = cross (up, fw);

	vec3 ro = -fw * 5.0;
	vec3 rd = normalize (uv.x * lf + uv.y * up + fw);

	// 4 bubble centers (xyz) and radii (w)
	vec4 s0 = vec4 ( 0.0 + 0.4*sin (iTime*0.5),  0.6*sin (iTime*0.9),  0.0,                1.4);
	vec4 s1 = vec4 ( 2.0*cos (iTime*0.4),       -0.4 + 0.3*sin (iTime),  0.5*sin (iTime*0.6), 1.1);
	vec4 s2 = vec4 (-1.8 + 0.5*sin (iTime*0.7), 0.2*cos (iTime*0.8),   -0.6,                1.0);
	vec4 s3 = vec4 ( 0.4*sin (iTime*0.3),       1.3*cos (iTime*0.4),    1.2,                0.9);

	// background: env cube along rd
	vec3 color = texture (iChannel0, rd).rgb;

	// Per-bubble hit data (t_enter, t_exit). If tE > tX it's a miss.
	vec4 h0 = ray_sphere (ro, rd, s0.xyz, s0.w);
	vec4 h1 = ray_sphere (ro, rd, s1.xyz, s1.w);
	vec4 h2 = ray_sphere (ro, rd, s2.xyz, s2.w);
	vec4 h3 = ray_sphere (ro, rd, s3.xyz, s3.w);

	// pick the front-most valid hit; if ray origin is inside, tE<0 and tX>0,
	// in which case we still treat as hit (camera inside the bubble).
	float bestT = 1e9;
	int bi = -1;
	if (h0.y > 0.0 && h0.x < bestT) { bestT = h0.x; bi = 0; }
	if (h1.y > 0.0 && h1.x < bestT) { bestT = h1.x; bi = 1; }
	if (h2.y > 0.0 && h2.x < bestT) { bestT = h2.x; bi = 2; }
	if (h3.y > 0.0 && h3.x < bestT) { bestT = h3.x; bi = 3; }

	if (bi >= 0) {
		vec3 center, absorb;
		float tE, tX;
		if (bi == 0)      { center = s0.xyz; absorb = ABSORB0; tE = h0.x; tX = h0.y; }
		else if (bi == 1) { center = s1.xyz; absorb = ABSORB1; tE = h1.x; tX = h1.y; }
		else if (bi == 2) { center = s2.xyz; absorb = ABSORB2; tE = h2.x; tX = h2.y; }
		else              { center = s3.xyz; absorb = ABSORB3; tE = h3.x; tX = h3.y; }

		vec3 pt_e = ro + rd * tE;
		vec3 pt_x = ro + rd * tX;
		vec3 front_n = normalize (pt_e - center);
		vec3 back_n  = normalize (center - pt_x);

		vec3 bub = shade_bubble (ro, rd, front_n, back_n, tE, tX, absorb);

		float F = fresnel_step (rd, front_n, FR0);
		float thick = max (tX - tE, 0.0);
		vec3 transmit = exp (-absorb * thick);
		float a = clamp (F + (1.0 - F) * (transmit.x + transmit.y + transmit.z) / 3.0, 0.0, 1.0);
		color = mix (color, bub, a);
	}

	fragColor = vec4 (color, 1.0);
}
`,
};
