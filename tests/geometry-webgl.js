// GPU results versus the original scalar half-space definition. Loaded only
// by the optional browser smoke test, never by the app.
(function (root) {
	function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
	function normalize(a) { const n = Math.hypot(...a); return a.map(x => x / n); }
	function f32(a) { return a.map(Math.fround); }
	const s = Math.fround(0.57735027);
	const cube = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
	const tetra = [[-s, -s, -s], [-s, s, s], [s, -s, s], [s, s, -s]];

	function reference(mode, shape, ro, rd, obj, spin) {
		const p = ro.map((x, i) => x - obj[i]);
		const b = dot(p, rd), h = b * b - (dot(p, p) - obj[3] * obj[3]);
		if (h < 0) return { span: [1, -1] };
		const t = [-b - Math.sqrt(h), -b + Math.sqrt(h)];
		let nA = normalize(p.map((x, i) => x + rd[i] * t[0]));
		let nB = normalize(p.map((x, i) => x + rd[i] * t[1]));
		if (shape === 0 || mode === 0 || mode === 3) return { span: t, nA, nB };
		const [x, y, z, angle] = spin, c = Math.cos(angle), si = Math.sin(angle), k = 1 - c;
		const rot = [
			[c + x*x*k, x*y*k - z*si, x*z*k + y*si],
			[y*x*k + z*si, c + y*y*k, y*z*k - x*si],
			[z*x*k - y*si, z*y*k + x*si, c + z*z*k],
		];
		const local = a => [0, 1, 2].map(i => a[0] * rot[0][i] + a[1] * rot[1][i] + a[2] * rot[2][i]);
		const world = a => rot.map(r => dot(r, a));
		const lo = local(p), ld = local(rd);
		const planes = mode === 1 ? cube : tetra;
		const d = Math.fround(obj[3] * (mode === 1 ? s : Math.fround(0.33333333)));
		for (const n of planes) {
			const den = Math.fround(dot(ld, n)), num = Math.fround(d - Math.fround(dot(lo, n)));
			if (Math.abs(den) < 1e-7) {
				if (num < -1e-8) return { span: [1, -1] };
				continue;
			}
			const tp = num / den;
			if (den < 0 && tp > t[0]) { t[0] = tp; nA = world(n); }
			if (den > 0 && tp < t[1]) { t[1] = tp; nB = world(n); }
		}
		return { span: t, nA, nB };
	}

	function checkGeometry(gl) {
		const cases = [];
		const identity = [0, 1, 0, 0], origin = [0, 0, 0, 1];
		for (const ro of [[0, 0, -3], [0, 0, 0], [0.8, 0, -3], [2, 0, -3], [s, 0, -3], [-s, 0, -3], [0, s, -3]]) {
			for (const rd of [[0, 0, 1], [1e-9, 0, 1], [0, 1, 0]]) cases.push({ ro: f32(ro), rd: f32(normalize(rd)), obj: origin, spin: identity });
		}
		let seed = 81257;
		function random() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }
		for (let i = 0; i < 100; i++) {
			const ro = f32([random() * 5 - 2.5, random() * 5 - 2.5, -3]);
			const target = [random() - 0.5, random() - 0.5, random() - 0.5];
			cases.push({ ro, rd: f32(normalize(target.map((x, j) => x - ro[j]))), obj: f32([0.12, -0.17, 0.21, 0.9]), spin: f32([...normalize([1, 2, 3]), random() * 6]) });
		}
		const fragmentSource = '#version 300 es\nprecision highp float; out vec4 color; void main() { color = vec4(1.0); }';
		const vao = gl.createVertexArray(), buffer = gl.createBuffer(), feedback = gl.createTransformFeedback();
		gl.bindVertexArray(vao);
		gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, feedback);
		gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, buffer);
		gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER, 8 * 4, gl.STREAM_READ);
		gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, buffer);
		gl.enable(gl.RASTERIZER_DISCARD);
		let checked = 0;
		try {
			for (let mode = 0; mode < 4; mode++) {
				const vertexSource = '#version 300 es\nprecision highp float; precision highp int;\n#define SHAPE_MODE ' + mode + '\n' + root.GLSL.raySphere + root.GLSL.shape + `
					uniform vec3 uRo, uRd;
					uniform vec4 uObject, uRotation;
					uniform int uTestShape;
					out vec2 vSpan; out vec3 vEnter, vExit;
					void main() { vSpan = shapeHit(uTestShape, uRo, uRd, uObject, uRotation, vEnter, vExit); gl_Position = vec4(0.0, 0.0, 0.0, 1.0); }`;
				const program = gl.createProgram(), shaders = [];
				try {
					for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
						const shader = gl.createShader(type); shaders.push(shader);
						gl.shaderSource(shader, source); gl.compileShader(shader);
						if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
						gl.attachShader(program, shader);
					}
					gl.transformFeedbackVaryings(program, ['vSpan', 'vEnter', 'vExit'], gl.INTERLEAVED_ATTRIBS);
					gl.linkProgram(program);
					if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
					gl.useProgram(program);
					const loc = Object.fromEntries(['uRo', 'uRd', 'uObject', 'uRotation', 'uTestShape'].map(name => [name, gl.getUniformLocation(program, name)]));
					const data = new Float32Array(8);
					for (const shape of mode === 1 || mode === 2 ? [mode, 0] : [mode]) {
						for (let i = 0; i < cases.length; i++) {
							const ray = cases[i], expected = reference(mode, shape, ray.ro, ray.rd, ray.obj, ray.spin);
							gl.uniform3fv(loc.uRo, ray.ro); gl.uniform3fv(loc.uRd, ray.rd);
							gl.uniform4fv(loc.uObject, ray.obj); gl.uniform4fv(loc.uRotation, ray.spin);
							gl.uniform1i(loc.uTestShape, shape);
							gl.beginTransformFeedback(gl.POINTS); gl.drawArrays(gl.POINTS, 0, 1); gl.endTransformFeedback();
							gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, data);
							const label = 'mode=' + mode + ' shape=' + shape + ' ray=' + i;
							if (expected.span[1] < expected.span[0]) {
								if (!(data[1] < data[0])) throw new Error(label + ': expected miss, got ' + [...data]);
								checked++; continue;
							}
							const wanted = [...expected.span, ...expected.nA, ...expected.nB];
							for (let j = 0; j < 8; j++) {
								if (!Number.isFinite(data[j]) || Math.abs(wanted[j] - data[j]) > 0.001) throw new Error(label + ' component=' + j + ': expected ' + wanted[j] + ', got ' + data[j]);
							}
							checked++;
						}
					}
				} finally {
					gl.useProgram(null); gl.deleteProgram(program);
					for (const shader of shaders) gl.deleteShader(shader);
				}
			}
			const error = gl.getError();
			if (error !== gl.NO_ERROR) throw new Error('Geometry GL error: ' + error);
			return checked;
		} finally {
			gl.disable(gl.RASTERIZER_DISCARD);
			gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
			gl.deleteTransformFeedback(feedback); gl.deleteBuffer(buffer); gl.deleteVertexArray(vao);
		}
	}
	root.checkShaderGeometry = checkGeometry;
})(window);
