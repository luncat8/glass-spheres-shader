// shapes.js — the shape registry: WHAT every object is. One global choice,
// written into the shader's hidden `uShape` int; a shader declares
// `shapes: [...]` (default: sphere only). The fallback rules between the shape
// row and the shader row live in js/caps.js.
//
// Shapes.hit() is the click picker's version of GLSL shapeHit (js/glsl_lib.js):
// same constants, same bounding ball first, same half-space clips, so a click
// lands on what the shader drew. The knot is picked by its bounding ball.
(function (root) {
	if (typeof module === 'object' && module.exports) { module.exports = {}; return; }

	const K = root.GLSL.SHAPE;

	const LIST = [
		{
			id: 'sphere', label: 'sphere', value: K.SPHERE, native: 'analytic_layers',
			hint: 'the classic bubble: the bounding ball itself',
		},
		{
			id: 'cube', label: 'cube', value: K.CUBE, native: 'analytic_layers',
			hint: 'a tumbling cube inscribed in the bounding ball',
		},
		{
			id: 'tetra', label: 'tetra', value: K.TETRA, native: 'analytic_layers',
			hint: 'a tumbling regular tetrahedron inscribed in the bounding ball',
		},
		{
			id: 'knot', label: 'knot', value: K.KNOT, native: 'thick_raymarch',
			hint: 'a tumbling (2,3) torus knot inside the bounding ball; only the raymarched renderers can draw it',
		},
	];

	const CUBE_N = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

	// scratch for the click ray cast (never allocates per call)
	const rot = new Float64Array(9);
	const lo = new Float64Array(3), ld = new Float64Array(3);
	const span = new Float64Array(2);

	// Rodrigues matrix of (unit axis, angle), row-major in `rot`
	function spinMat(s, si) {
		const ax = s[si], ay = s[si + 1], az = s[si + 2];
		const c = Math.cos(s[si + 3]), sn = Math.sin(s[si + 3]), k = 1 - c;
		rot[0] = c + ax * ax * k; rot[1] = ax * ay * k - az * sn; rot[2] = ax * az * k + ay * sn;
		rot[3] = ay * ax * k + az * sn; rot[4] = c + ay * ay * k; rot[5] = ay * az * k - ax * sn;
		rot[6] = az * ax * k - ay * sn; rot[7] = az * ay * k + ax * sn; rot[8] = c + az * az * k;
	}

	// world -> local: transpose(rot) * v
	function toLocal(out, x, y, z) {
		out[0] = rot[0] * x + rot[3] * y + rot[6] * z;
		out[1] = rot[1] * x + rot[4] * y + rot[7] * z;
		out[2] = rot[2] * x + rot[5] * y + rot[8] * z;
	}

	// clip span against the half-space dot (p, n) <= d
	function planeClip(n, d) {
		const den = ld[0] * n[0] + ld[1] * n[1] + ld[2] * n[2];
		const num = d - (lo[0] * n[0] + lo[1] * n[1] + lo[2] * n[2]);
		if (Math.abs(den) < 1e-7) { if (num < 0) { span[0] = 1; span[1] = -1; } return; }
		const tp = num / den;
		if (den < 0) { if (tp > span[0]) span[0] = tp; return; }
		if (tp < span[1]) span[1] = tp;
	}

	function clipAll(normals, d) {
		for (let i = 0; i < normals.length; i++) planeClip(normals[i], d);
	}

	// entry t of the ray (ro, rd unit) on object objs[oi..oi+3] with spin
	// spins[si..si+3]; -1 on a miss. Negative when the ray starts inside.
	function hit(shape, ro, rd, objs, oi, spins, si) {
		const w = objs[oi + 3];
		const ox = ro[0] - objs[oi], oy = ro[1] - objs[oi + 1], oz = ro[2] - objs[oi + 2];
		const b = ox * rd[0] + oy * rd[1] + oz * rd[2];
		const h = b * b - (ox * ox + oy * oy + oz * oz - w * w);
		if (h < 0) return -1;
		const sq = Math.sqrt(h);
		span[0] = -b - sq; span[1] = -b + sq;
		if (shape === K.SPHERE || shape === K.KNOT) return span[0];
		spinMat(spins, si);
		toLocal(lo, ox, oy, oz);
		toLocal(ld, rd[0], rd[1], rd[2]);
		if (shape === K.CUBE) clipAll(CUBE_N, w * K.CUBE_INSCRIBE);
		else clipAll(K.TETRA_N, w * K.TETRA_INRADIUS);
		return span[1] < span[0] ? -1 : span[0];
	}

	root.Shapes = root.Caps.axis({ list: LIST, metaKey: 'shapes', paramName: 'uShape', nativeKey: 'nativeShape', fallback: ['sphere'] });
	root.Shapes.hit = hit;
})(typeof window !== 'undefined' ? window : globalThis);
