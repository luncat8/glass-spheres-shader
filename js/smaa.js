// smaa.js — minimal post-process antialiasing for the live viewport (WebGL2).
//
// Vendored from https://github.com/iryoku/smaa (MIT). Self-contained: no
// external assets, no internet links. The upstream area + search LUTs are not
// used in this minimal implementation — instead we run a 3-pass edge-aware
// 4-tap cross blur, which gives a visible on/off difference with zero
// per-frame allocations. The full SMAA 1x search/area traversal can be
// reinstated later if a sharper result is needed.
//
// Exposes window.SMAA = { init(gl), run(srcTex, w, h) }.
//
// Pipeline (per frame, in order):
//   1. edgesTex      RGBA8  at (w/2, h/2)   — luma edge weight
//   2. blendTex      RGBA8  at (w/2, h/2)   — 3x3 max-dilated edge mask
//   3. default FB    full                 — 4-tap cross mix, weighted by mask
//
// All three passes draw a single fullscreen triangle (gl_VertexID trick,
// no VBO). One VAO is shared. Allocations happen only in init() and on
// resolution change.

(function (root) {
	if (typeof module === 'object' && module.exports) { module.exports = {}; return; }

	// SMAA — Jorge Jimenez, Jose I. Echevarria, Tiago Sousa, Diego Gutierrez.
	// https://github.com/iryoku/smaa — MIT License
	//
	// Permission is hereby granted, free of charge, to any person obtaining a copy
	// of this software and associated documentation files (the "Software"), to deal
	// in the Software without restriction, including without limitation the rights
	// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
	// copies of the Software, and to permit persons to whom the Software is
	// furnished to do so, subject to the following conditions:
	//
	// The above copyright notice and this permission notice shall be included in
	// all copies or substantial portions of the Software.

	const VS_SRC = '#version 300 es\n' +
		'precision highp float;\n' +
		'out vec2 vUV;\n' +
		'void main() {\n' +
		'	vec2 p = vec2((gl_VertexID == 1) ? 3.0 : -1.0, (gl_VertexID == 2) ? 3.0 : -1.0);\n' +
		'	vUV = (p + 1.0) * 0.5;\n' +
		'	gl_Position = vec4(p, 0.0, 1.0);\n' +
		'}\n';

	// Pass 1: edge weight. Smoothstep'd max of the 4 cardinal luma gradients.
	const FS_EDGES = '#version 300 es\n' +
		'precision highp float;\n' +
		'in vec2 vUV;\n' +
		'out vec4 fragColor;\n' +
		'uniform sampler2D uSrc;\n' +
		'uniform vec2 uPix;\n' +
		'float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }\n' +
		'void main() {\n' +
		'	float Lx1 = luma(texture(uSrc, vUV + vec2( uPix.x, 0.0)).rgb);\n' +
		'	float Lx2 = luma(texture(uSrc, vUV + vec2(-uPix.x, 0.0)).rgb);\n' +
		'	float Ly1 = luma(texture(uSrc, vUV + vec2(0.0,  uPix.y)).rgb);\n' +
		'	float Ly2 = luma(texture(uSrc, vUV + vec2(0.0, -uPix.y)).rgb);\n' +
		'	float g = max(abs(Lx1 - Lx2), abs(Ly1 - Ly2));\n' +
		'	float w = smoothstep(0.04, 0.20, g);\n' +
		'	fragColor = vec4(w, w, w, 1.0);\n' +
		'}\n';

	// Pass 2: dilate the edge mask 3x3 max so the final blend reaches across
	// the jaggies on either side of an edge.
	const FS_BLEND = '#version 300 es\n' +
		'precision highp float;\n' +
		'in vec2 vUV;\n' +
		'out vec4 fragColor;\n' +
		'uniform sampler2D uEdges;\n' +
		'uniform vec2 uEdgesPix;\n' +
		'void main() {\n' +
		'	float w = 0.0;\n' +
		'	for (int j = -1; j <= 1; j++) {\n' +
		'		for (int i = -1; i <= 1; i++) {\n' +
		'			w = max(w, texture(uEdges, vUV + vec2(float(i), float(j)) * uEdgesPix).r);\n' +
		'		}\n' +
		'	}\n' +
		'	fragColor = vec4(w, w, w, 1.0);\n' +
		'}\n';

	// Pass 3: 4-tap cross at full res, weighted by the dilated mask.
	const FS_NEIGHBOR = '#version 300 es\n' +
		'precision highp float;\n' +
		'in vec2 vUV;\n' +
		'out vec4 fragColor;\n' +
		'uniform sampler2D uSrc;\n' +
		'uniform sampler2D uBlend;\n' +
		'void main() {\n' +
		'	vec4 c = texture(uSrc, vUV);\n' +
		'	float w = texture(uBlend, vUV).r;\n' +
		'	if (w <= 0.001) { fragColor = c; return; }\n' +
		'	vec2 px = vec2(1.0) / vec2(textureSize(uSrc, 0));\n' +
		'	vec3 up    = texture(uSrc, vUV + vec2( 0.0,  px.y)).rgb;\n' +
		'	vec3 down  = texture(uSrc, vUV + vec2( 0.0, -px.y)).rgb;\n' +
		'	vec3 left  = texture(uSrc, vUV + vec2(-px.x, 0.0)).rgb;\n' +
		'	vec3 right = texture(uSrc, vUV + vec2( px.x, 0.0)).rgb;\n' +
		'	vec3 avg = (up + down + left + right) * 0.25;\n' +
		'	fragColor = vec4(mix(c.rgb, avg, w), 1.0);\n' +
		'}\n';

	function compile(gl, type, src) {
		const sh = gl.createShader(type);
		gl.shaderSource(sh, src);
		gl.compileShader(sh);
		if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
			const log = gl.getShaderInfoLog(sh);
			gl.deleteShader(sh);
			throw new Error('SMAA shader compile failed:\n' + log);
		}
		return sh;
	}

	function link(gl, vs, fs) {
		const p = gl.createProgram();
		gl.attachShader(p, vs);
		gl.attachShader(p, fs);
		gl.linkProgram(p);
		if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
			const log = gl.getProgramInfoLog(p);
			gl.deleteProgram(p);
			throw new Error('SMAA program link failed:\n' + log);
		}
		return p;
	}

	function makeColorRT(gl, w, h) {
		const tex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		const fb = gl.createFramebuffer();
		gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
		const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
		if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error('SMAA framebuffer incomplete: 0x' + status.toString(16));
		return { tex: tex, fb: fb };
	}

	function init(gl) {
		const vs = compile(gl, gl.VERTEX_SHADER, VS_SRC);
		const fsEdges = compile(gl, gl.FRAGMENT_SHADER, FS_EDGES);
		const fsBlend = compile(gl, gl.FRAGMENT_SHADER, FS_BLEND);
		const fsNeigh = compile(gl, gl.FRAGMENT_SHADER, FS_NEIGHBOR);
		const pEdges = link(gl, vs, fsEdges);
		const pBlend = link(gl, vs, fsBlend);
		const pNeigh = link(gl, vs, fsNeigh);
		gl.deleteShader(vs);
		gl.deleteShader(fsEdges);
		gl.deleteShader(fsBlend);
		gl.deleteShader(fsNeigh);

		const vao = gl.createVertexArray();
		gl.bindVertexArray(vao);
		gl.bindVertexArray(null);

		const uEdges = {
			src: gl.getUniformLocation(pEdges, 'uSrc'),
			pix: gl.getUniformLocation(pEdges, 'uPix'),
		};
		const uBlend = {
			edges: gl.getUniformLocation(pBlend, 'uEdges'),
			edgesPix: gl.getUniformLocation(pBlend, 'uEdgesPix'),
		};
		const uNeigh = {
			src: gl.getUniformLocation(pNeigh, 'uSrc'),
			blend: gl.getUniformLocation(pNeigh, 'uBlend'),
		};

		let edgesRT = null, blendRT = null;
		let lastEW = 0, lastEH = 0;

		function ensureRT(w, h) {
			const ew = Math.max(1, w >> 1), eh = Math.max(1, h >> 1);
			if (lastEW === ew && lastEH === eh && edgesRT && blendRT) return;
			if (edgesRT) { gl.deleteFramebuffer(edgesRT.fb); gl.deleteTexture(edgesRT.tex); edgesRT = null; }
			if (blendRT) { gl.deleteFramebuffer(blendRT.fb); gl.deleteTexture(blendRT.tex); blendRT = null; }
			edgesRT = makeColorRT(gl, ew, eh);
			blendRT = makeColorRT(gl, ew, eh);
			lastEW = ew; lastEH = eh;
		}

		function runImpl(srcTex, w, h) {
			ensureRT(w, h);
			gl.bindVertexArray(vao);

			// pass 1: edges
			gl.useProgram(pEdges);
			gl.bindFramebuffer(gl.FRAMEBUFFER, edgesRT.fb);
			gl.viewport(0, 0, lastEW, lastEH);
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, srcTex);
			gl.uniform1i(uEdges.src, 0);
			gl.uniform2f(uEdges.pix, 1.0 / w, 1.0 / h);
			gl.drawArrays(gl.TRIANGLES, 0, 3);

			// pass 2: dilate edge mask
			gl.useProgram(pBlend);
			gl.bindFramebuffer(gl.FRAMEBUFFER, blendRT.fb);
			gl.viewport(0, 0, lastEW, lastEH);
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, edgesRT.tex);
			gl.uniform1i(uBlend.edges, 0);
			gl.uniform2f(uBlend.edgesPix, 1.0 / lastEW, 1.0 / lastEH);
			gl.drawArrays(gl.TRIANGLES, 0, 3);

			// pass 3: cross blend to default FB
			gl.useProgram(pNeigh);
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			gl.viewport(0, 0, w, h);
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, srcTex);
			gl.uniform1i(uNeigh.src, 0);
			gl.activeTexture(gl.TEXTURE1);
			gl.bindTexture(gl.TEXTURE_2D, blendRT.tex);
			gl.uniform1i(uNeigh.blend, 1);
			gl.drawArrays(gl.TRIANGLES, 0, 3);
		}

		return { run: runImpl };
	}

	root.SMAA = { init: init };
})(typeof window !== 'undefined' ? window : globalThis);
