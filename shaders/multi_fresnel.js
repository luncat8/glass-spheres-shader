// Multi-bubble variant of XdXXzB (refractive sphere + fbm fresnel).
// Same single-pass fullscreen pipeline; analytic ray-sphere intersections for
// N animated centers, composed with Fresnel. No external libs.
window.SHADER_multi_fresnel = {
  "id": "multi_fresnel",
  "title": "multi-bubble refractive spheres with fbm fresnel",
  "scenes": ["own"],
  "group": "own",
  "camDist": 5.0,
  "camPitch": 0.0,
  "channels": {"0":"env_cube","1":"env_cube","2":"noise","3":"noise"},
  "vars": [
    { "name": "uCamPos", "type": "vec3", "feed": "camPos" },
    { "name": "uCamRt", "type": "vec3", "feed": "camRt" },
    { "name": "uCamUp", "type": "vec3", "feed": "camUp" },
    { "name": "uCamFw", "type": "vec3", "feed": "camFw" }
  ],
  "params": [
    { "name": "uFov", "type": "float", "label": "fov", "group": "camera", "min": 30, "max": 110, "step": 0.5, "def": 60.0, "hint": "vertical field of view in degrees" },
    { "name": "uCount", "type": "int", "label": "spheres", "group": "objects", "min": 1, "max": 4, "step": 1, "def": 4, "hint": "how many of the 4 animated spheres are traced" }
  ],
  "source":
`#define PI 3.14159265359
// FOV and the sphere count are GUI uniforms (see metadata above). FR0 (vec3
// fresnel weights) stays a constant because the parameter strip is scalar.
#define FR0 vec3 (0.0, 1.0, 0.7)
float noise (vec2 co) {
	return length (texture (iChannel2, co));
}
vec3 hsv2rgb (vec3 c) {
	vec4 K = vec4 (1.0, 2.0/3.0, 1.0/3.0, 3.0);
	vec3 p = abs (fract (c.xxx + K.xyz) * 6.0 - K.www);
	return c.z * mix (K.xxx, clamp (p - K.xxx, 0.0, 1.0), c.y);
}
float fbm (vec2 uv) {
	return (
		+noise (uv*2.0)/2.0
		+noise (uv*4.0)/4.0
		+noise (uv*8.0)/8.0
		+noise (uv*16.0)/16.0
		+noise (uv*32.0)/32.0);
}
vec4 compute (vec2 uv, float iTime) {
	uv = (iTime+uv)/196.0;
	vec3 col = vec3 (fbm (uv)*PI*2.0, 1.0, 1.0);
	return vec4 (hsv2rgb (col), 1.0);
}
void nearest_hits (vec3 ro, vec3 rd, vec4 s0, vec4 s1, vec4 s2, vec4 s3,
                   out float bestFront, out float bestBack,
                   out int fi, out int bi) {
	bestFront = 1e9;
	bestBack = -1.0;
	fi = -1; bi = -1;
	for (int i = 0; i < uCount; i++) {
		vec4 sp = (i == 0) ? s0 : (i == 1) ? s1 : (i == 2) ? s2 : s3;
		vec3 oc = ro - sp.xyz;
		float A = dot (rd, rd);
		float B = 2.0 * dot (oc, rd);
		float C = dot (oc, oc) - sp.w;
		float D = B*B - 4.0*A*C;
		if (D < 0.0) continue;
		float sq = sqrt (D);
		float q = (-B - sq * sign (B)) * 0.5;
		float t0 = q / A;
		float t1 = C / q;
		float a = min (t0, t1);
		float b = max (t0, t1);
		if (a < 0.0) a = b;
		if (b <= 0.0) continue;
		if (a < bestFront) { bestFront = a; fi = i; }
		if (b > bestBack)  { bestBack  = b; bi = i; }
	}
}
vec4 fetch_sphere (int i, vec4 s0, vec4 s1, vec4 s2, vec4 s3) {
	return (i == 0) ? s0 : (i == 1) ? s1 : (i == 2) ? s2 : s3;
}
float fresnel_step (vec3 I, vec3 N, vec3 f) {
	return clamp (f.x + f.y * pow (1.0 + dot (I, N), f.z), 0.0, 1.0);
}
void mainImage (out vec4 fragColor, in vec2 fragCoord) {
	vec2 uv = (2.0*fragCoord.xy - iResolution.xy) / min (iResolution.x, iResolution.y) * tan (radians (uFov)/2.0);
	vec3 up = uCamUp;
	vec3 fw = uCamFw;
	vec3 lf = cross (up, fw);
	vec3 ro = uCamPos; // shared orbit camera
	vec3 rd = normalize (uv.x * lf + uv.y * up + fw);
	vec4 c0, c1, c2, c3;
	c0 = vec4 ( 0.0 + sin (iTime*0.7),  1.0*sin (iTime),            0.0, 2.0);
	c1 = vec4 ( 2.3*cos (iTime*0.5),   -0.6 + 0.5*sin (iTime*0.9),  0.4, 1.6);
	c2 = vec4 (-2.0 + 0.7*sin (iTime*0.6), 0.4*cos (iTime*1.1),   -0.8, 1.4);
	c3 = vec4 ( 0.5*sin (iTime*0.4),    1.6*cos (iTime*0.3),        1.6, 1.2);
	vec4 color = texture (iChannel0, rd);
	float t_front, t_back;
	int fi, bi;
	nearest_hits (ro, rd, c0, c1, c2, c3, t_front, t_back, fi, bi);
	if (fi >= 0) {
		vec4 sp_f = fetch_sphere (fi, c0, c1, c2, c3);
		vec3 pt0 = ro + rd * t_front;
		vec3 pn0 = normalize (pt0 - sp_f.xyz);
		vec3 r0 = reflect (rd, pn0);
		vec2 sp = vec2 (atan (pn0.z, pn0.x), asin (pn0.y)) * 0.5;
		vec4 s0 = compute (sp + sp_f.xy*0.01, iTime/8.0 + sp_f.x);
		vec4 env0 = texture (iChannel1, r0);
		color = mix (color, env0 + env0*s0, fresnel_step (rd, pn0, FR0));
		if (bi >= 0 && bi != fi && t_back > t_front) {
			vec4 sp_b = fetch_sphere (bi, c0, c1, c2, c3);
			vec3 pt1 = ro + rd * t_back;
			vec3 pn1 = normalize (sp_b.xyz - pt1);
			vec3 r1 = reflect (rd, pn1);
			vec2 sp1 = vec2 (atan (pn1.z, pn1.x), asin (pn1.y)) * 0.5;
			vec4 s1 = compute (sp1 + sp_b.xy*0.01, iTime/8.0 + sp_b.x);
			vec4 env1 = texture (iChannel1, r1);
			color = mix (color, env1 + env1*s1, fresnel_step (rd, pn1, FR0) * 0.6);
		}
	}
	fragColor = color;
}
`,
};
