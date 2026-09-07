// runner.js — WebGL2 runner for Shadertoy `mainImage` fragment shaders.
// Exposes window.Runner = { init(canvas), select(id), run(), stop(), stats() }.
//
// Design (per AGENTS.md):
//   * classic <script>, no modules; node-compatible (module.exports stub).
//   * WebGL2 only, zero deps.
//   * fullscreen triangle (no allocations per frame).
//   * allocate-once: 4 channel textures + 1 ping FBOs reused across shaders.
//   * no {}/[]/closures inside requestAnimationFrame (mutate preallocated buffers).
//
// Shadertoy compatibility: each shader's `mainImage(out vec4 fragColor, vec2 fragCoord)`
// is wrapped in a WebGL2 `main()` that supplies the standard uniforms and calls it.
// We rename Shadertoy iChannel* to WebGL2 sampler uniforms and provide four
// pre-allocated 256x256 placeholder textures (procedural noise / cubemap / gradient).

(function (root) {
	const IS_NODE = typeof module === 'object' && !!module.exports;

	const VS = `#version 300 es
precision highp float;
out vec2 vUV;
void main() {
	// fullscreen tri covering clip-space [-1,1]
	vec2 p = vec2((gl_VertexID == 1) ? 3.0 : -1.0, (gl_VertexID == 2) ? 3.0 : -1.0);
	vUV = (p + 1.0) * 0.5;
	gl_Position = vec4(p, 0.0, 1.0);
}`;

	// Detect which iChannel*N* a shader uses as samplerCube by scanning the
	// GLSL source for `texture*(iChannelN, vec3)`-style lookups. Returns
	// 4-element array of booleans. Falls back to all-2D when nothing matches.
	function detectCubeChannels(src) {
		const flags = [false, false, false, false];
		const re = /\btexture(?:Lod)?\s*\(\s*([A-Za-z_]\w*)\s*,\s*([^,)]+)/g;
		let m;
		while ((m = re.exec(src))) {
			const sampler = m[1];
			const idx = sampler === 'iChannel0' ? 0 : sampler === 'iChannel1' ? 1 : sampler === 'iChannel2' ? 2 : sampler === 'iChannel3' ? 3 : -1;
			if (idx < 0) continue;
			const coord = m[2];
			if (/\bvec3\s*\(/.test(coord) || /\.[xyz]{2,3}\b/.test(coord)) {
				flags[idx] = true;
			}
		}
		return flags;
	}

	// Merge channel metadata hints (cube vs 2D) from the shader record.
	// The metadata uses channel role names: "env_cube" -> samplerCube,
	// everything else ("noise", "thickness", ...) -> sampler2D.
	function resolveChannelKinds(src, channelsMeta) {
		const auto = detectCubeChannels(src);
		const out = [false, false, false, false];
		for (let i = 0; i < 4; i++) {
			if (channelsMeta && channelsMeta[String(i)] === 'env_cube') out[i] = true;
			else out[i] = auto[i];
		}
		return out;
	}

	// Header we prepend to every shader. Declares uniforms matching Shadertoy.
	// iChannel types are patched per-shader by buildFSHeader() to match detectCubeChannels.
	function buildFSHeader(src, flags) {
		// flags is the resolved [isCube0..3] array; default to all-2D
		const lines = [
			'#version 300 es',
			'precision highp float;',
			'precision highp int;',
			'precision highp sampler2D;',
			'precision highp samplerCube;',
			'',
			'uniform vec3  iResolution;',
			'uniform float iTime;',
			'uniform float iTimeDelta;',
			'uniform int   iFrame;',
			'uniform float iFrameRate;',
			'uniform vec4  iMouse;',
			'uniform vec4  iDate;',
			'uniform ' + (flags[0] ? 'samplerCube' : 'sampler2D') + ' iChannel0;',
			'uniform ' + (flags[1] ? 'samplerCube' : 'sampler2D') + ' iChannel1;',
			'uniform ' + (flags[2] ? 'samplerCube' : 'sampler2D') + ' iChannel2;',
			'uniform ' + (flags[3] ? 'samplerCube' : 'sampler2D') + ' iChannel3;',
			'',
			'out vec4 fragColor;',
			'',
		];
		return lines.join('\n');
	}

	// Optional shader-declared uniforms. `meta.params` are scalars driven by the
	// GUI sliders, `meta.arrays` are per-frame data uniforms (e.g. bubble centres)
	// and `meta.vars` are per-frame scalar-family uniforms (e.g. the camera basis)
	// filled by a feed function. Shaders never redeclare them.
	function buildUniformDecls(meta) {
		const ps = (meta && meta.params) || [];
		const as = (meta && meta.arrays) || [];
		const vs = (meta && meta.vars) || [];
		if (!ps.length && !as.length && !vs.length) return '';
		const lines = [];
		for (let i = 0; i < ps.length; i++) lines.push('uniform ' + (ps[i].type || 'float') + ' ' + ps[i].name + ';');
		for (let i = 0; i < as.length; i++) lines.push('uniform ' + (as[i].type || 'vec4') + ' ' + as[i].name + '[' + as[i].count + '];');
		for (let i = 0; i < vs.length; i++) lines.push('uniform ' + (vs[i].type || 'vec4') + ' ' + vs[i].name + ';');
		lines.push('', '');
		return lines.join('\n');
	}

	const FS_FOOTER = `
void main() {
	mainImage(fragColor, gl_FragCoord.xy);
	fragColor.a = 1.0;
}`;

	// node (tests/tooling): export only the pure source-assembly helpers, so
	// tools_GPU/check-glsl.mjs can rebuild the exact fragment source the browser
	// would compile. Browser behaviour below is untouched.
	if (IS_NODE) {
		module.exports = { detectCubeChannels, resolveChannelKinds, buildFSHeader, buildUniformDecls, FS_FOOTER, VS };
		return;
	}

	const Runner = {
		canvas: null,
		gl: null,
		program: null,
		vao: null,
		channels2D: null, // 4 preallocated sampler2D textures (RGBA8, 256x256)
		channelsCube: null, // 4 preallocated samplerCube textures
		channelIsCube: [false, false, false, false], // per-shader
		uniformLocs: null,
		current: null, // { id, title, ... }
		variantKey: '',
		wantedKey: '',       // the variant the user most recently asked for
		variants: Object.create(null), // compiled base/terrain/shape variants for current shader
		parallel: false,      // KHR_parallel_shader_compile available (async compile/link)
		jobs: [],             // in-flight compile jobs
		pendingSelect: null,  // select() waiting for its variant to link
		primeQueue: [],       // variants to compile in the background, one at a time
		primeActive: null,    // the background (prime) job currently compiling
		running: false,
		startTime: 0,
		lastTime: 0,
		frame: 0,
		fpsSamples: [],
		elapsed: 0, // seconds since the current shader was selected
		mov: true,        // sphere-movement toggle (false = freeze feed time)
		sceneTime: 0,     // feed time; accumulates only while mov is true
		mouse: [0, 0, 0, 0], // x, y, clickX, clickY in pixels
		onError: null,
		aa: true,           // AA toggle (settable via setAA)
		onAAChange: null,   // ui hook to refresh the AA button label
		smaa: null,         // result of SMAA.init(gl) if SMAA loaded
		smaaMaxW: 2560,
		smaaMaxH: 1440,
		sceneFBO: null,
		sceneTex: null,
		sceneW: 0,
		sceneH: 0,
	};

	function makeNoiseTexture(gl) {
		const N = 256;
		const data = new Uint8Array(N * N * 4);
		// value noise via cheap hash (deterministic, no allocations later)
		// pre-bake once, mutate never
		let s = 1;
		for (let i = 0; i < N * N; i++) {
			s = (s * 1664525 + 1013904223) >>> 0;
			const r = (s & 0xff);
			s = (s * 1664525 + 1013904223) >>> 0;
			const g = (s & 0xff);
			s = (s * 1664525 + 1013904223) >>> 0;
			const b = (s & 0xff);
			const j = i * 4;
			data[j] = r; data[j+1] = g; data[j+2] = b; data[j+3] = 255;
		}
		// simple 3x3 box blur to soften
		const out = new Uint8Array(N * N * 4);
		for (let y = 0; y < N; y++) {
			for (let x = 0; x < N; x++) {
				let rr = 0, gg = 0, bb = 0, ct = 0;
				for (let dy = -1; dy <= 1; dy++) {
					for (let dx = -1; dx <= 1; dx++) {
						const xx = (x + dx + N) % N;
						const yy = (y + dy + N) % N;
						const idx = (yy * N + xx) * 4;
						rr += data[idx]; gg += data[idx+1]; bb += data[idx+2]; ct++;
					}
				}
				const j = (y * N + x) * 4;
				out[j] = rr / ct; out[j+1] = gg / ct; out[j+2] = bb / ct; out[j+3] = 255;
			}
		}
		const tex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, out);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
		return tex;
	}

	function makeGradientTexture(gl, hueA, hueB) {
		// 256x1 thin gradient stripe: useful for `thickness` lookups
		const N = 256;
		const data = new Uint8Array(N * 4);
		for (let i = 0; i < N; i++) {
			const t = i / (N - 1);
			const r = Math.round(255 * (hueA[0] * (1 - t) + hueB[0] * t));
			const g = Math.round(255 * (hueA[1] * (1 - t) + hueB[1] * t));
			const b = Math.round(255 * (hueA[2] * (1 - t) + hueB[2] * t));
			const j = i * 4;
			data[j] = r; data[j+1] = g; data[j+2] = b; data[j+3] = 255;
		}
		const tex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, N, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
		return tex;
	}

	// Cheap procedural cubemap: 32x32 per face, painted with a horizon gradient
	// tinted by face direction. Looks like a "sky" — adequate stand-in for the
	// Shadertoy envmap that thin-film shaders expect.
	function makeCubeTexture(gl) {
		const F = 32;
		const tex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_CUBE_MAP, tex);
		// colors per face (px+, nx+, py+, ny+, pz+, nz+)
		const palette = [
			[0.95, 0.70, 0.50], // +x warm
			[0.30, 0.45, 0.70], // -x cool
			[0.90, 0.92, 0.98], // +y bright sky
			[0.20, 0.18, 0.22], // -y dark floor
			[0.80, 0.85, 0.55], // +z yellow
			[0.55, 0.40, 0.65], // -z purple
		];
		const faceData = [];
		for (let f = 0; f < 6; f++) {
			const data = new Uint8Array(F * F * 4);
			for (let y = 0; y < F; y++) {
				for (let x = 0; x < F; x++) {
					// y goes 0 (top) -> F-1 (bottom); invert for sky-to-floor
					const t = y / (F - 1);
					const base = palette[f];
					const dim = 0.55 + 0.45 * (1 - t); // top brighter
					const j = (y * F + x) * 4;
					data[j]   = Math.min(255, Math.round(255 * base[0] * dim));
					data[j+1] = Math.min(255, Math.round(255 * base[1] * dim));
					data[j+2] = Math.min(255, Math.round(255 * base[2] * dim));
					data[j+3] = 255;
				}
			}
			faceData.push({ face: f, data: data });
		}
		const faces = [gl.TEXTURE_CUBE_MAP_POSITIVE_X, gl.TEXTURE_CUBE_MAP_NEGATIVE_X,
			gl.TEXTURE_CUBE_MAP_POSITIVE_Y, gl.TEXTURE_CUBE_MAP_NEGATIVE_Y,
			gl.TEXTURE_CUBE_MAP_POSITIVE_Z, gl.TEXTURE_CUBE_MAP_NEGATIVE_Z];
		for (let i = 0; i < 6; i++) {
			gl.texImage2D(faces[i], 0, gl.RGBA8, F, F, 0, gl.RGBA, gl.UNSIGNED_BYTE, faceData[i].data);
		}
		gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		return tex;
	}

	// ---- variant compilation ------------------------------------------------
	//
	// A variant is one (shader × scene-terrain × shape) combination. On many
	// drivers compiling a variant blocks the page: the link alone was measured
	// at seconds-to-tens-of-seconds on integrated GPUs, even for the default
	// sphere/sky program. Where KHR_parallel_shader_compile is available the
	// driver compiles and links on its own threads, a job below is polled until
	// ready while the previous program keeps rendering, and the swap happens
	// only after the new program has actually linked. Without the extension a
	// job is finished synchronously inside makeJob, preserving the old blocking
	// behaviour rather than regressing it.

	const SHAPE_VALUES = { sphere: 0, cube: 1, tetra: 2, knot: 3 };

	function shapeValue(id) {
		const v = SHAPE_VALUES[id];
		return v === undefined ? 0 : v;
	}

	function makeJob(meta, variant, store, active, onDone) {
		const gl = Runner.gl;
		const src = variantSource(meta, variant);
		const job = {
			meta: meta,
			variant: variant,
			key: variant.key,
			store: store,
			active: active,
			onDone: onDone,
			flags: resolveChannelKinds(meta.source, meta.channels),
			vs: null, fs: null, prog: null,
			phase: 'compile',
			ok: true, err: null, stale: false,
			srcLen: src.length,
			t0: (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0,
		};
		Runner.jobs.push(job);
		job.vs = gl.createShader(gl.VERTEX_SHADER);
		gl.shaderSource(job.vs, VS);
		gl.compileShader(job.vs);
		job.fs = gl.createShader(gl.FRAGMENT_SHADER);
		gl.shaderSource(job.fs, src);
		gl.compileShader(job.fs);
		if (Runner.parallel) ensurePoll();
		else {
			// finish on the next tick so the caller can store the returned job
			// before onDone fires (onDone may reference the job object)
			setTimeout(function () { finishJobSync(job); }, 0);
		}
		return job;
	}

	function finishJobSync(job) {
		if (job.phase === 'done') return; // may be called again by a deferred tick
		const gl = Runner.gl;
		if (!gl) { job.stale = true; finishJob(job); return; }
		if (gl.getShaderParameter(job.vs, gl.COMPILE_STATUS)) {
			if (gl.getShaderParameter(job.fs, gl.COMPILE_STATUS)) {
				job.prog = gl.createProgram();
				gl.attachShader(job.prog, job.vs);
				gl.attachShader(job.prog, job.fs);
				gl.linkProgram(job.prog);
				if (!gl.getProgramParameter(job.prog, gl.LINK_STATUS)) {
					job.err = 'program link failed:\n' + gl.getProgramInfoLog(job.prog);
					job.ok = false;
				}
			} else {
				job.err = 'fragment shader compile failed:\n' + gl.getShaderInfoLog(job.fs);
				job.ok = false;
			}
		} else {
			job.err = 'vertex shader compile failed:\n' + gl.getShaderInfoLog(job.vs);
			job.ok = false;
		}
		removeJob(job);
		finishJob(job);
	}

	// advance a parallel job one stage; returns true when it is done
	function advanceJob(job) {
		const gl = Runner.gl;
		if (!gl) { job.stale = true; finishJob(job); return true; }
		if (job.phase === 'compile') {
			if (!gl.getShaderParameter(job.vs, gl.COMPLETION_STATUS_KHR)) return false;
			if (!gl.getShaderParameter(job.fs, gl.COMPLETION_STATUS_KHR)) return false;
			if (!gl.getShaderParameter(job.vs, gl.COMPILE_STATUS)) {
				job.err = 'vertex shader compile failed:\n' + gl.getShaderInfoLog(job.vs);
				job.ok = false;
			} else if (!gl.getShaderParameter(job.fs, gl.COMPILE_STATUS)) {
				job.err = 'fragment shader compile failed:\n' + gl.getShaderInfoLog(job.fs);
				job.ok = false;
			} else {
				job.prog = gl.createProgram();
				gl.attachShader(job.prog, job.vs);
				gl.attachShader(job.prog, job.fs);
				gl.linkProgram(job.prog);
				job.phase = 'link';
				return false;
			}
		} else if (job.phase === 'link') {
			if (!gl.getProgramParameter(job.prog, gl.COMPLETION_STATUS_KHR)) return false;
			if (!gl.getProgramParameter(job.prog, gl.LINK_STATUS)) {
				job.err = 'program link failed:\n' + gl.getProgramInfoLog(job.prog);
				job.ok = false;
			}
		} else {
			return true;
		}
		finishJob(job);
		return true;
	}

	function finishJob(job) {
		const gl = Runner.gl;
		job.phase = 'done';
		if (job.vs) { gl.deleteShader(job.vs); job.vs = null; }
		if (job.fs) { gl.deleteShader(job.fs); job.fs = null; }
		const dt = (typeof performance !== 'undefined' && performance.now) ? (performance.now() - job.t0) : 0;
		if (dt > 1000) {
			try { console.log('[Runner] ' + job.meta.id + ' variant ' + job.key + ' ' + (job.active ? 'active' : 'background') + ' ready in ' + dt.toFixed(0) + 'ms' + (job.ok ? '' : ' FAILED')); } catch (e) {}
		}
		if (job.ok && !job.stale) {
			const item = {
				program: job.prog,
				locs: getUniformLocs(gl, job.prog, job.meta),
				srcLen: job.srcLen,
				flags: job.flags,
			};
			if (job.onDone) job.onDone(null, item);
		} else {
			if (job.prog) { gl.deleteProgram(job.prog); job.prog = null; }
			if (job.onDone) job.onDone(new Error(job.err || 'variant compile was abandoned'), null);
		}
	}

	function removeJob(job) {
		const jobs = Runner.jobs;
		for (let i = 0; i < jobs.length; i++) if (jobs[i] === job) { jobs.splice(i, 1); return; }
	}

	function jobFor(meta, key) {
		const jobs = Runner.jobs;
		for (let i = 0; i < jobs.length; i++) {
			const j = jobs[i];
			if (j.meta === meta && j.key === key && !j.stale) return j;
		}
		return null;
	}

	function stepJobs() {
		const gl = Runner.gl;
		if (!gl) return false;
		const jobs = Runner.jobs;
		for (let i = jobs.length - 1; i >= 0; i--) {
			if (advanceJob(jobs[i])) jobs.splice(i, 1);
		}
		return jobs.length > 0;
	}

	let pollScheduled = false;
	function ensurePoll() {
		if (pollScheduled) return;
		pollScheduled = true;
		const tick = function () {
			pollScheduled = false;
			if (stepJobs()) ensurePoll();
		};
		if (typeof requestAnimationFrame === 'function') requestAnimationFrame(tick);
		else setTimeout(tick, 16);
	}

	function getUniformLocs(gl, prog, meta) {
		const names = [
			'iResolution', 'iTime', 'iTimeDelta', 'iFrame', 'iFrameRate',
			'iMouse', 'iDate',
			'iChannel0', 'iChannel1', 'iChannel2', 'iChannel3',
		];
		const out = {};
		for (let i = 0; i < names.length; i++) out[names[i]] = gl.getUniformLocation(prog, names[i]);
		const ps = (meta && meta.params) || [];
		for (let i = 0; i < ps.length; i++) out[ps[i].name] = gl.getUniformLocation(prog, ps[i].name);
		const as = (meta && meta.arrays) || [];
		for (let i = 0; i < as.length; i++) {
			out[as[i].name] = gl.getUniformLocation(prog, as[i].name) || gl.getUniformLocation(prog, as[i].name + '[0]');
		}
		const vs = (meta && meta.vars) || [];
		for (let i = 0; i < vs.length; i++) out[vs[i].name] = gl.getUniformLocation(prog, vs[i].name);
		return out;
	}

	// components per GLSL type, for array uploads
	const TYPE_COMPS = { float: 1, vec2: 2, vec3: 3, vec4: 4 };

	// initialise slider-backed params to their declared defaults (the UI may not
	// have built the sliders yet when the first frame runs)
	function prepareParams(meta) {
		const ps = (meta && meta.params) || [];
		for (let i = 0; i < ps.length; i++) if (ps[i].value === undefined) ps[i].value = ps[i].def;
	}

	// allocate the CPU-side buffer of every array uniform once, at select() time
	function prepareArrays(meta) {
		const as = (meta && meta.arrays) || [];
		for (let i = 0; i < as.length; i++) {
			const comps = TYPE_COMPS[as[i].type || 'vec4'] || 4;
			if (!as[i].buf || as[i].buf.length !== as[i].count * comps) as[i].buf = new Float32Array(as[i].count * comps);
		}
	}

	// same for scalar-family var uniforms (vec2/vec3/vec4/float)
	function prepareVars(meta) {
		const vs = (meta && meta.vars) || [];
		for (let i = 0; i < vs.length; i++) {
			const comps = TYPE_COMPS[vs[i].type || 'vec4'] || 4;
			if (!vs[i].buf || vs[i].buf.length !== comps) vs[i].buf = new Float32Array(comps);
		}
	}

	// one uniform upload for a fed buffer (arrays and vars share it)
	function uploadBuf(gl, loc, type, buf) {
		if (type === 'vec4') gl.uniform4fv(loc, buf);
		else if (type === 'vec3') gl.uniform3fv(loc, buf);
		else if (type === 'vec2') gl.uniform2fv(loc, buf);
		else gl.uniform1fv(loc, buf);
	}

	// per-frame upload of shader-declared uniforms (no allocation)
	function uploadShaderUniforms(gl, locs, meta, time) {
		const ps = (meta && meta.params) || [];
		for (let i = 0; i < ps.length; i++) {
			const loc = locs[ps[i].name];
			if (!loc) continue;
			if (ps[i].type === 'int') gl.uniform1i(loc, ps[i].value | 0);
			else gl.uniform1f(loc, ps[i].value);
		}
		const as = (meta && meta.arrays) || [];
		for (let i = 0; i < as.length; i++) {
			const loc = locs[as[i].name];
			if (!loc) continue;
			const feed = root.Feeds && root.Feeds[as[i].feed];
			if (feed) feed(time, meta, as[i].buf);
			uploadBuf(gl, loc, as[i].type || 'vec4', as[i].buf);
		}
		const vs = (meta && meta.vars) || [];
		for (let i = 0; i < vs.length; i++) {
			const loc = locs[vs[i].name];
			if (!loc) continue;
			const feed = root.Feeds && root.Feeds[vs[i].feed];
			if (feed) feed(time, meta, vs[i].buf);
			uploadBuf(gl, loc, vs[i].type || 'vec4', vs[i].buf);
		}
	}

	function resize(canvas) {
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
		const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
		}
		return [w, h];
	}

	function dateVec() {
		const d = new Date();
		return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()];
	}

	function init(canvas) {
		Runner.canvas = canvas;
		const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
		if (!gl) throw new Error('WebGL2 not supported');
		Runner.gl = gl;
		// Where supported, compile+link run on driver threads and are polled
		// here instead of blocking the page (see makeJob below).
		Runner.parallel = !!(gl.getExtension && gl.getExtension('KHR_parallel_shader_compile'));

		// pre-allocated VAO (fullscreen tri via gl_VertexID)
		const vao = gl.createVertexArray();
		gl.bindVertexArray(vao);
		gl.bindVertexArray(null);
		Runner.vao = vao;

		// SMAA is optional: if smaa.js is not loaded, AA is force-disabled.
		if (root.SMAA) {
			try {
				Runner.smaa = root.SMAA.init(gl);
			} catch (e) {
				Runner.smaa = null;
				Runner.aa = false;
				if (Runner.onError) Runner.onError('SMAA init failed: ' + (e.message || e));
			}
		} else {
			Runner.aa = false;
		}

		// preallocated channel textures
		const channels2D = [
			makeNoiseTexture(gl),                         // ch0
			makeGradientTexture(gl, [0.1,0.4,1.0], [1,1,0.2]), // ch1 thin-film thickness-ish
			makeNoiseTexture(gl),                         // ch2 noise variant
			makeNoiseTexture(gl),                         // ch3 spare
		];
		const channelsCube = [
			makeCubeTexture(gl),
			makeCubeTexture(gl),
			makeCubeTexture(gl),
			makeCubeTexture(gl),
		];
		Runner.channels2D = channels2D;
		Runner.channelsCube = channelsCube;

		Runner.onError = Runner.onError || function () {};
		window.addEventListener('resize', () => { /* handled in frame */ });
		canvas.addEventListener('mousemove', (e) => {
			const r = canvas.getBoundingClientRect();
			Runner.mouse[0] = (e.clientX - r.left) * (canvas.width / r.width);
			Runner.mouse[1] = (e.clientY - r.top) * (canvas.height / r.height);
		});
		canvas.addEventListener('mousedown', (e) => {
			const r = canvas.getBoundingClientRect();
			Runner.mouse[2] = (e.clientX - r.left) * (canvas.width / r.width);
			Runner.mouse[3] = (e.clientY - r.top) * (canvas.height / r.height);
		});
		canvas.addEventListener('mouseup', () => { Runner.mouse[2] = 0; Runner.mouse[3] = 0; });

		return root.Runner;
	}

	function paramValue(meta, name, fallback) {
		const ps = (meta && meta.params) || [];
		for (let i = 0; i < ps.length; i++) {
			if (ps[i].name !== name) continue;
			const v = ps[i].value !== undefined ? ps[i].value : ps[i].def;
			return typeof v === 'number' && isFinite(v) ? v : fallback;
		}
		return fallback;
	}

	// Terrain and shape code are compile-time variants. The normal startup
	// program therefore does not make the driver optimise the terrain marcher,
	// cube, tetra and knot implementations just to render spheres over a sky.
	function variantOf(meta) {
		const terrain = paramValue(meta, 'uScene', 0) === 4 ? 1 : 0;
		const shape = Math.max(0, Math.min(3, paramValue(meta, 'uShape', 0) | 0));
		return { terrain: terrain, shape: shape, key: terrain + ':' + shape };
	}

	function variantSource(meta, variant) {
		const flags = resolveChannelKinds(meta.source, meta.channels);
		const header = buildFSHeader(meta.source, flags) + buildUniformDecls(meta);
		return header + '#define USE_TERRAIN ' + variant.terrain + '\n#define SHAPE_MODE ' + variant.shape + '\n' + meta.source + FS_FOOTER;
	}

	function disposeVariants(variants) {
		const keys = Object.keys(variants);
		for (let i = 0; i < keys.length; i++) {
			const item = variants[keys[i]];
			if (item && item.program) Runner.gl.deleteProgram(item.program);
		}
	}

	function activateVariant(meta, key, item) {
		Runner.program = item.program;
		Runner.uniformLocs = item.locs;
		Runner.variantKey = key;
		for (let i = 0; i < 4; i++) Runner.channelIsCube[i] = item.flags[i];
	}

	// runs when the active program becomes ready: reset the per-shader clock and
	// pre-allocate the CPU-side buffers the frame loop will feed
	function commitSelect(meta) {
		prepareParams(meta);
		prepareArrays(meta);
		prepareVars(meta);
		Runner.startTime = performance.now();
		Runner.lastTime = Runner.startTime;
		Runner.frame = 0;
		Runner.fpsSamples.length = 0;
		Runner.sceneTime = 0;
	}

	// Compile the variants this shader will probably be switched to next, one at
	// a time in the background, so a later scene/shape click finds a linked
	// program waiting. The glass-land (terrain) variant of the current shape is
	// primed first because it is the most expensive switch.
	function primeVariants(meta) {
		const scenes = meta.scenes || [];
		const shapes = meta.shapes || ['sphere'];
		const hasTerrain = scenes.indexOf('terrain') >= 0;
		const cur = variantOf(meta);
		const queue = [];
		const push = function (terrain, shape) {
			const key = terrain + ':' + shape;
			if (key === Runner.variantKey) return;
			if (Runner.variants[key] || jobFor(meta, key)) return;
			queue.push({ terrain: terrain, shape: shape, key: key });
		};
		if (hasTerrain && !cur.terrain) push(1, cur.shape);
		for (let i = 0; i < shapes.length; i++) push(cur.terrain, shapeValue(shapes[i]));
		if (hasTerrain) for (let i = 0; i < shapes.length; i++) push(1, shapeValue(shapes[i]));
		Runner.primeQueue = queue;
		Runner.primeActive = null;
		pumpPrimeQueue();
	}

	function pumpPrimeQueue() {
		if (Runner.primeActive) return;
		const meta = Runner.current;
		if (!meta) return;
		while (Runner.primeQueue.length) {
			const v = Runner.primeQueue.shift();
			if (Runner.variants[v.key] || jobFor(meta, v.key)) continue;
			const store = Runner.variants;
			const job = makeJob(meta, v, store, false, function (err, item) {
				if (Runner.primeActive === job) Runner.primeActive = null;
				if (!err && item) {
					if (job.store === Runner.variants) job.store[job.key] = item;
					else Runner.gl.deleteProgram(item.program); // shader switched mid-prime
				}
				pumpPrimeQueue();
			});
			Runner.primeActive = job;
			return;
		}
	}

	function select(id, onReady) {
		const list = window.SHADERS || [];
		let meta = null;
		for (let i = 0; i < list.length; i++) if (list[i].id === id) { meta = list[i]; break; }
		if (!meta) throw new Error('unknown shader id: ' + id);
		const variant = variantOf(meta);
		const key = variant.key;

		Runner.wantedKey = key;

		// a previous select may still be compiling; abandon it. The old program
		// keeps rendering until the new one has actually linked.
		if (Runner.pendingSelect) {
			Runner.pendingSelect.abandoned = true;
			const aj = Runner.pendingSelect.activeJob;
			if (aj) aj.stale = true;
		}

		// re-selecting the active shader: the program is already linked
		if (Runner.current === meta && Runner.variants[key]) {
			activateVariant(meta, key, Runner.variants[key]);
			commitSelect(meta);
			if (onReady) onReady(null, meta);
			return meta;
		}

		const store = Object.create(null);
		const pending = { meta: meta, store: store, key: key, onReady: onReady, abandoned: false, activeJob: null };
		Runner.pendingSelect = pending;

		const job = makeJob(meta, variant, store, true, function (err, item) {
			pending.activeJob = null;
			if (pending.abandoned || job.stale) {
				if (item && item.program) Runner.gl.deleteProgram(item.program);
				return;
			}
			if (err) {
				Runner.pendingSelect = null;
				disposeVariants(store);
				if (onReady) onReady(err, null);
				return;
			}
			store[key] = item;
			disposeVariants(Runner.variants);
			Runner.variants = store;
			Runner.current = meta;
			Runner.pendingSelect = null;
			activateVariant(meta, key, item);
			commitSelect(meta);
			if (onReady) onReady(null, meta);
			primeVariants(meta);
		});
		pending.activeJob = job;
		// Nothing is rendering yet (boot): build the first program right here so
		// the axes, camera and picker see a fully loaded shader the moment this
		// returns, exactly as before the async change.
		if (!Runner.current) finishJobSync(job);
		return meta;
	}

	// Called after the scene or shape toolbar changes. A linked variant is
	// activated immediately; otherwise its compile job is created (or an
	// in-flight background prime is promoted to it) and the swap happens when
	// the program is ready, leaving the old program rendering meanwhile.
	function setVariant(onReady) {
		const meta = Runner.current;
		if (!meta) return;
		const variant = variantOf(meta);
		const key = variant.key;
		if (key === Runner.variantKey) { if (onReady) onReady(null, meta); return; }
		Runner.wantedKey = key;
		const item = Runner.variants[key];
		if (item) {
			activateVariant(meta, key, item);
			if (onReady) onReady(null, meta);
			return;
		}
		const existing = jobFor(meta, key);
		if (existing) {
			existing.active = true;
			existing.onDone = function (err, it) {
				if (Runner.primeActive === existing) Runner.primeActive = null;
				pumpPrimeQueue();
				if (err || existing.stale) {
					if (it && it.program) Runner.gl.deleteProgram(it.program);
					if (onReady) onReady(err, null);
					return;
				}
				if (existing.meta !== Runner.current) { Runner.gl.deleteProgram(it.program); return; }
				Runner.variants[key] = it;
				// a newer shape/scene click superseded this one: keep it cached
				// but do not activate it over the newer choice
				if (key !== Runner.wantedKey) return;
				activateVariant(meta, key, it);
				if (onReady) onReady(null, meta);
			};
			return;
		}
		makeJob(meta, variant, Runner.variants, true, function (err, it) {
			if (err) {
				if (onReady) onReady(err, null);
				return;
			}
			if (meta !== Runner.current) { Runner.gl.deleteProgram(it.program); return; }
			Runner.variants[key] = it;
			if (key !== Runner.wantedKey) return;
			activateVariant(meta, key, it);
			if (onReady) onReady(null, meta);
		});
	}

	function bindChannel(gl, prog, locs, idx) {
		const unit = gl.TEXTURE0 + idx;
		gl.activeTexture(unit);
		if (Runner.channelIsCube[idx]) {
			gl.bindTexture(gl.TEXTURE_CUBE_MAP, Runner.channelsCube[idx]);
		} else {
			gl.bindTexture(gl.TEXTURE_2D, Runner.channels2D[idx]);
		}
		gl.uniform1i(locs['iChannel' + idx], idx);
	}

	// allocate or re-allocate the AA scene FBO at the given size.
	// WebGL2 defaults FBO color attachments to NEAREST — SMAA needs LINEAR.
	function ensureSceneFBO(gl, w, h) {
		if (Runner.sceneW === w && Runner.sceneH === h && Runner.sceneFBO) return;
		if (Runner.sceneFBO) {
			gl.deleteFramebuffer(Runner.sceneFBO);
			gl.deleteTexture(Runner.sceneTex);
			Runner.sceneFBO = null;
			Runner.sceneTex = null;
		}
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
		if (status !== gl.FRAMEBUFFER_COMPLETE) {
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			throw new Error('scene FBO incomplete: 0x' + status.toString(16));
		}
		Runner.sceneFBO = fb;
		Runner.sceneTex = tex;
		Runner.sceneW = w;
		Runner.sceneH = h;
	}

	// the user shader draw. Called twice when AA is on (scene FBO then SMAA
	// blits to default FB) or once when AA is off (default FB).
	function drawScene(gl) {
		gl.bindVertexArray(Runner.vao);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
	}

	function frame() {
		if (!Runner.running) return;
		const gl = Runner.gl;
		// the first program may still be compiling (async): render nothing until
		// it is ready, but keep the loop alive so it resumes the moment it links
		if (!Runner.program) { requestAnimationFrame(frame); return; }
		const t = performance.now();
		const dt = (t - Runner.lastTime) / 1000;
		Runner.lastTime = t;
		const elapsed = (t - Runner.startTime) / 1000;
		Runner.elapsed = elapsed;
		if (Runner.mov) Runner.sceneTime += dt;

		// orbit camera: advance auto-motion, refresh basis and feeds
		if (root.Cam && root.Cam.tick) root.Cam.tick(dt);

		const wh = resize(Runner.canvas);
		gl.viewport(0, 0, wh[0], wh[1]);

		gl.useProgram(Runner.program);
		const u = Runner.uniformLocs;
		if (u.iResolution) gl.uniform3f(u.iResolution, wh[0], wh[1], 1.0);
		if (u.iTime) gl.uniform1f(u.iTime, elapsed);
		if (u.iTimeDelta) gl.uniform1f(u.iTimeDelta, dt);
		if (u.iFrame) gl.uniform1i(u.iFrame, Runner.frame);
		if (u.iFrameRate) gl.uniform1f(u.iFrameRate, dt > 0 ? 1.0 / dt : 0);
		if (u.iMouse) gl.uniform4fv(u.iMouse, Runner.mouse);
		if (u.iDate) {
			const d = dateVec();
			gl.uniform4f(u.iDate, d[0], d[1], d[2], d[3]);
		}
		uploadShaderUniforms(gl, u, Runner.current, Runner.sceneTime);
		bindChannel(gl, Runner.program, u, 0);
		bindChannel(gl, Runner.program, u, 1);
		bindChannel(gl, Runner.program, u, 2);
		bindChannel(gl, Runner.program, u, 3);

		const w = wh[0], h = wh[1];
		const useAA = Runner.aa && Runner.smaa && w <= Runner.smaaMaxW && h <= Runner.smaaMaxH;
		if (useAA) {
			ensureSceneFBO(gl, w, h);
			gl.bindFramebuffer(gl.FRAMEBUFFER, Runner.sceneFBO);
			drawScene(gl);
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			Runner.smaa.run(Runner.sceneTex, w, h);
		} else {
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			drawScene(gl);
		}

		Runner.frame++;
		// raw frame timestamps; the smoothed FPS is computed in ui.tick()
		Runner.fpsSamples.push(t);
		if (Runner.fpsSamples.length > 240) Runner.fpsSamples.shift();
		requestAnimationFrame(frame);
	}

	function run() {
		Runner.running = true;
		Runner.startTime = performance.now();
		Runner.lastTime = Runner.startTime;
		requestAnimationFrame(frame);
	}

	function stop() { Runner.running = false; Runner.fpsSamples.length = 0; }

	// 500ms sliding-window FPS — averages over enough frames to be stable but
	// still reacts within half a second to a sustained change.
	const FPS_WINDOW_MS = 500;
	function smoothFps() {
		const s = Runner.fpsSamples;
		const n = s.length;
		if (n < 2) return 0;
		const newest = s[n - 1];
		let i = n - 2;
		while (i > 0 && newest - s[i] < FPS_WINDOW_MS) i--;
		const span = (newest - s[i]) / 1000;
		const frames = (n - 1) - i;
		return span > 0 ? frames / span : 0;
	}

	function stats() {
		return {
			id: Runner.current ? Runner.current.id : null,
			fps: smoothFps(),
			frame: Runner.frame,
			res: [Runner.canvas.width, Runner.canvas.height],
		};
	}

	// `current` is a live getter so external code (ui, browser checks) sees the
	// meta of the selected shader without a manual refresh; `mouse` shares the
	// internal iMouse array (pointer/touch handling in camera.js writes to it).
	// `helpers` exposes the pure source-assembly functions so the benchmark
	// (js/bench.js) can build and compile the very same GLSL on its own context.
	// AA toggle. Flips Runner.aa; if going off→on and the canvas has a non-zero
	// size, the scene FBO is allocated immediately so the first AA frame
	// doesn't stall on first-use FBO creation.
	function setAA(on) {
		const next = !!on && !!Runner.smaa;
		if (Runner.aa === next) return;
		Runner.aa = next;
		if (next && Runner.canvas) {
			const w = Runner.canvas.width, h = Runner.canvas.height;
			if (w > 0 && h > 0) ensureSceneFBO(Runner.gl, w, h);
		}
		if (Runner.onAAChange) Runner.onAAChange();
	}
	function getAA() { return Runner.aa; }

	function setMov(on) { Runner.mov = !!on; }
	function getMov() { return Runner.mov; }

	const api = { init, select, setVariant, run, stop, stats, setAA, getAA, setMov, getMov, mouse: Runner.mouse };
	api.onAAChangeSetter = (f) => { Runner.onAAChange = f; };
	api.helpers = { VS, FS_FOOTER, buildFSHeader, buildUniformDecls, resolveChannelKinds, detectCubeChannels };
	Object.defineProperty(api, 'current', { get: () => Runner.current });
	Object.defineProperty(api, 'elapsed', { get: () => Runner.elapsed });
	Object.defineProperty(api, 'sceneTime', { get: () => Runner.sceneTime });
	root.Runner = api;
})(typeof window !== 'undefined' ? window : globalThis);
