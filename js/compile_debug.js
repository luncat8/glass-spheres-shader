// Standalone diagnostics. Never loaded by the renderer; stubs/probes cannot
// affect production sources. Classic script + pure helpers for Node tests.
(function (root) {
	const SHAPES = { sphere: 0, cube: 1, tetra: 2, knot: 3 };

	function hashSource(source) {
		let h = 2166136261;
		for (let i = 0; i < source.length; i++) h = Math.imul(h ^ source.charCodeAt(i), 16777619);
		return (h >>> 0).toString(16).padStart(8, '0');
	}

	function replaceBody(source, name, body) {
		const definition = new RegExp('\\b(?:void|vec[234]|float|int)\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
		const match = definition.exec(source);
		if (!match) throw new Error('Cannot isolate function: ' + name);
		const start = match.index + match[0].length;
		let depth = 1, end = start;
		// Ignore braces in comments while locating the matching function end.
		const tokens = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|[{}]/g;
		tokens.lastIndex = start;
		let token;
		while ((token = tokens.exec(source))) {
			if (token[0] === '{') depth++;
			if (token[0] === '}') depth--;
			if (depth !== 0) continue;
			end = token.index;
			break;
		}
		if (depth) throw new Error('Unclosed function: ' + name);
		return source.slice(0, start) + '\n' + body + '\n' + source.slice(end);
	}

	function buildSource(helpers, meta, variant, ablation, literal) {
		let source = helpers.variantSource(meta, variant);
		if (ablation === 'flat-env') source = replaceBody(source, 'env', '\treturn vec3 (0.5);');
		if (ablation === 'no-wires') source = replaceBody(source, 'cageWireHit', '\tt = BIG; mask = 0.0;');
		if (ablation === 'no-glass-shading') source = replaceBody(source, 'shadeGlass', '\treturn behind;');
		if (ablation === 'no-terrain') source = replaceBody(source, 'landHit', '\tt = -1.0; n = vec3 (0.0, 1.0, 0.0); id = -1;');
		if (ablation === 'bounding-sphere') source = source.replace(/#define SHAPE_MODE \d+/, '#define SHAPE_MODE 0');
		if (!literal) return source;
		// A used float survives preprocessing into native compiler input; an
		// unused nonce define did not. Still a probe, NOT a cache-miss guarantee.
		const value = Number(literal);
		if (!Number.isFinite(value) || value < 0.9 || value >= 1) throw new Error('Invalid probe multiplier');
		const footer = helpers.FS_FOOTER.replace('fragColor.a = 1.0;', 'fragColor.rgb *= ' + value.toFixed(8) + ';\n\tfragColor.a = 1.0;');
		return source.slice(0, -helpers.FS_FOOTER.length) + footer;
	}

	function variantsFor(meta) {
		const shapes = meta.shapes || ['sphere'];
		const terrains = (meta.scenes || []).includes('terrain') ? [0, 1] : [0];
		const out = [];
		for (const terrain of terrains) {
			for (const shape of shapes) out.push({ terrain, shape: SHAPES[shape] });
		}
		return out;
	}

	function ablationsFor(meta, variant) {
		const out = ['full'];
		if (/vec3 env\s*\(/.test(meta.source)) out.push('flat-env');
		if (/void cageWireHit\s*\(/.test(meta.source)) out.push('no-wires');
		if (/vec3 shadeGlass\s*\(/.test(meta.source)) out.push('no-glass-shading');
		if (variant.terrain && /void landHit\s*\(/.test(meta.source)) out.push('no-terrain');
		if (variant.shape) out.push('bounding-sphere');
		return out;
	}

	function contextInfo(gl) {
		const renderer = gl.getExtension('WEBGL_debug_renderer_info');
		const parallel = gl.getExtension('KHR_parallel_shader_compile');
		return {
			userAgent: root.navigator.userAgent,
			vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER),
			unmaskedVendor: renderer ? gl.getParameter(renderer.UNMASKED_VENDOR_WEBGL) : 'unavailable',
			unmaskedRenderer: renderer ? gl.getParameter(renderer.UNMASKED_RENDERER_WEBGL) : 'unavailable (privacy/driver restriction)',
			version: gl.getParameter(gl.VERSION), glslVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
			contextAttributes: gl.getContextAttributes(),
			parallel: !!parallel, completionEnum: parallel ? parallel.COMPLETION_STATUS_KHR : null,
		};
	}

	function firstUse(gl, program, meta, variant, helpers) {
		const textures = [], vao = gl.createVertexArray();
		const pixel = new Uint8Array([127, 127, 127, 255]);
		try {
			gl.useProgram(program);
			for (const p of meta.params || []) {
				const loc = gl.getUniformLocation(program, p.name);
				if (p.type === 'int') gl.uniform1i(loc, p.def);
				else gl.uniform1f(loc, p.def);
			}
			gl.uniform1i(gl.getUniformLocation(program, 'uShape'), variant.shape);
			gl.uniform1i(gl.getUniformLocation(program, 'uScene'), variant.terrain ? 4 : 3);
			gl.uniform3f(gl.getUniformLocation(program, 'iResolution'), 1, 1, 1);
			gl.uniform3f(gl.getUniformLocation(program, 'uCamPos'), 0, 0, -8);
			gl.uniform3f(gl.getUniformLocation(program, 'uCamRt'), 1, 0, 0);
			gl.uniform3f(gl.getUniformLocation(program, 'uCamUp'), 0, 1, 0);
			gl.uniform3f(gl.getUniformLocation(program, 'uCamFw'), 0, 0, 1);
			// Valid placeholder objects, not zero-radius shells (which can
			// produce NaNs and fail to exercise the material path at first use).
			for (const a of meta.arrays || []) {
				const data = new Float32Array(a.count * 4);
				for (let i = 0; i < a.count; i++) {
					if (a.name === 'uSpin') data.set([0, 1, 0, 0.2 * i], i * 4);
					else if (a.name === 'uTop') data.set([(i - 1) * 1.2, 3, 0, 0.4], i * 4);
					else data.set([(i % 3 - 1) * 0.7, (Math.floor(i / 3) % 3 - 1) * 0.7, i * 0.1, 0.4], i * 4);
				}
				gl.uniform4fv(gl.getUniformLocation(program, a.name), data);
			}
			const flags = helpers.resolveChannelKinds(meta.source, meta.channels);
			for (let i = 0; i < 4; i++) {
				const target = flags[i] ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D;
				const texture = gl.createTexture();
				textures.push(texture);
				gl.activeTexture(gl.TEXTURE0 + i);
				gl.bindTexture(target, texture);
				for (let face = 0; face < (flags[i] ? 6 : 1); face++) {
					gl.texImage2D(flags[i] ? gl.TEXTURE_CUBE_MAP_POSITIVE_X + face : target, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
				}
				gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
				gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
				gl.uniform1i(gl.getUniformLocation(program, 'iChannel' + i), i);
			}
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			gl.bindVertexArray(vao);
			gl.viewport(0, 0, 1, 1);
			gl.drawArrays(gl.TRIANGLES, 0, 3);
			// gl.finish() can merely enqueue a finish command in Chromium;
			// readback forces the work (including deferred compilation) to finish.
			gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
			const error = gl.getError();
			if (error !== gl.NO_ERROR) throw new Error('First draw/readback GL error: 0x' + error.toString(16));
		} finally {
			for (const texture of textures) gl.deleteTexture(texture);
			gl.deleteVertexArray(vao);
		}
	}

	// The same staged API operations as Runner, on a separate context. API
	// call times are subsets of stage waits, NOT extra durations to add to them.
	function compileVariant(gl, helpers, meta, variant, options) {
		const opts = options || {};
		const source = buildSource(helpers, meta, variant, opts.ablation, opts.literal);
		const ext = gl.getExtension('KHR_parallel_shader_compile');
		const completion = ext && ext.COMPLETION_STATUS_KHR;
		const st = {
			id: meta.id, key: variant.terrain + ':' + variant.shape, ablation: opts.ablation || 'full',
			literal: opts.literal || null, source, sourceHash: hashSource(source),
			srcLen: source.length, lines: source.split('\n').length,
			async: typeof completion === 'number', ok: true, err: '',
			compileCall: 0, linkCall: 0, compileWait: 0, linkWait: 0,
			pollMax: 0, polls: 0, readyMs: 0, firstUseMs: null, total: 0,
		};
		return new Promise(function (resolve) {
			let vs = null, fs = null, program = null, timer = null;
			let phase = 'compile', finished = false, linkStart = 0;
			const start = performance.now();

			function done(object, shader) {
				const t = performance.now();
				const value = shader ? gl.getShaderParameter(object, completion) : gl.getProgramParameter(object, completion);
				st.pollMax = Math.max(st.pollMax, performance.now() - t);
				st.polls++;
				if (typeof value !== 'boolean') throw new Error('Driver rejected ext.COMPLETION_STATUS_KHR');
				return value;
			}

			function finish(error) {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				st.total = performance.now() - start;
				if (error) { st.ok = false; st.err = phase + ': ' + error.message; }
				// Do not query translated source or logs while a job is pending.
				if (st.ok && opts.translated) {
					const dumpStart = performance.now();
					try {
						const debug = gl.getExtension('WEBGL_debug_shaders');
						st.translatedSource = debug ? debug.getTranslatedShaderSource(fs) : '';
						st.translatedHash = hashSource(st.translatedSource);
						st.translatedLength = st.translatedSource.length;
					} catch (e) { st.translationError = e.message; }
					st.dumpMs = performance.now() - dumpStart;
				}
				if (vs) gl.deleteShader(vs);
				if (fs) gl.deleteShader(fs);
				if (program) gl.deleteProgram(program);
				resolve(st);
			}

			function step() {
				try {
					if (gl.isContextLost()) throw new Error('WebGL context lost');
					if (performance.now() - start > (opts.timeoutMs || 180000)) throw new Error('Timed out; native work may still be running. Restart the browser before another cold test.');
					if (phase === 'compile') {
						if (st.async) {
							const vsDone = done(vs, true), fsDone = done(fs, true);
							if (!vsDone || !fsDone) { timer = setTimeout(step, 16); return; }
						}
						const vsOK = gl.getShaderParameter(vs, gl.COMPILE_STATUS);
						const fsOK = gl.getShaderParameter(fs, gl.COMPILE_STATUS);
						st.compileWait = performance.now() - start;
						if (!vsOK) throw new Error('VS: ' + gl.getShaderInfoLog(vs));
						if (!fsOK) throw new Error('FS: ' + gl.getShaderInfoLog(fs));
						phase = 'link';
						linkStart = performance.now();
						program = gl.createProgram();
						gl.attachShader(program, vs); gl.attachShader(program, fs);
						gl.linkProgram(program);
						st.linkCall = performance.now() - linkStart;
					}
					if (st.async && !done(program, false)) { timer = setTimeout(step, 16); return; }
					const linked = gl.getProgramParameter(program, gl.LINK_STATUS);
					st.linkWait = performance.now() - linkStart;
					if (!linked) throw new Error('LINK: ' + gl.getProgramInfoLog(program));
					st.readyMs = performance.now() - start;
					if (opts.firstUse) {
						phase = 'first-use';
						const drawStart = performance.now();
						try { firstUse(gl, program, meta, variant, helpers); }
						finally { st.firstUseMs = performance.now() - drawStart; }
					}
					finish();
				} catch (e) { finish(e); }
			}

			try {
				const t = performance.now();
				vs = gl.createShader(gl.VERTEX_SHADER);
				gl.shaderSource(vs, helpers.VS); gl.compileShader(vs);
				fs = gl.createShader(gl.FRAGMENT_SHADER);
				gl.shaderSource(fs, source); gl.compileShader(fs);
				st.compileCall = performance.now() - t;
				timer = setTimeout(step, 0);
			} catch (e) { finish(e); }
		});
	}

	const api = { hashSource, replaceBody, buildSource, variantsFor, ablationsFor, contextInfo, compileVariant };
	if (typeof module === 'object' && module.exports) { module.exports = api; return; }
	root.CompileDebug = api;

	const byId = Object.create(null), shaders = root.SHADERS;
	const el = id => document.getElementById(id);
	const log = s => { el('log').textContent += s + '\n'; console.log(s); };
	const shaderSelect = el('shader'), shapeSelect = el('shape'), terrainSelect = el('terrain');
	let running = false, stopped = false, report = null, poisoned = false;

	function addOption(select, value, label) {
		const option = document.createElement('option');
		option.value = value; option.textContent = label;
		select.appendChild(option);
	}
	for (const meta of shaders) { byId[meta.id] = meta; addOption(shaderSelect, meta.id, meta.id); }
	shaderSelect.value = 'analytic_layers';

	function updateShapes() {
		const previous = shapeSelect.value, meta = byId[shaderSelect.value];
		shapeSelect.textContent = '';
		for (const shape of meta.shapes || ['sphere']) addOption(shapeSelect, SHAPES[shape], shape);
		if ([...shapeSelect.options].some(o => o.value === previous)) shapeSelect.value = previous;
		terrainSelect.disabled = !(meta.scenes || []).includes('terrain');
		if (terrainSelect.disabled) terrainSelect.value = '0';
	}
	shaderSelect.addEventListener('change', updateShapes);
	updateShapes();

	function selected() {
		return { meta: byId[shaderSelect.value], variant: { terrain: +terrainSelect.value, shape: +shapeSelect.value }, ablation: 'full' };
	}
	function setBusy(busy) {
		running = busy;
		for (const button of document.querySelectorAll('[data-run]')) button.disabled = busy || poisoned;
		el('stop').disabled = !busy;
		el('save').disabled = busy || !report || !report.results.length;
	}
	function fmt(r) {
		return '[' + r.id + ' t' + r.key + ' ' + r.ablation + '] hash=' + r.sourceHash + ' len=' + r.srcLen +
			' ready=' + r.readyMs.toFixed(0) + 'ms total=' + r.total.toFixed(0) + 'ms' +
			' compileWait=' + r.compileWait.toFixed(0) + 'ms linkWait/backend=' + r.linkWait.toFixed(0) + 'ms' +
			' compileCall=' + r.compileCall.toFixed(1) + 'ms linkCall=' + r.linkCall.toFixed(1) + 'ms' +
			(r.async ? ' pollMax=' + r.pollMax.toFixed(1) + 'ms polls=' + r.polls : ' [SYNC; no KHR extension]') +
			(r.firstUseMs === null ? '' : ' firstDraw/readback=' + r.firstUseMs.toFixed(0) + 'ms') +
			(r.translatedLength === undefined ? '' : ' translated=' + r.translatedLength + ' hash=' + r.translatedHash) +
			(r.literal ? ' probeMultiplier=' + r.literal : '') + ' ok=' + r.ok + (r.err ? '\n  ' + r.err : '');
	}

	async function runCases(cases) {
		if (running || poisoned) return;
		const gl = el('c').getContext('webgl2', { antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
		if (!gl) { log('WebGL2 unavailable'); return; }
		el('log').textContent = '';
		stopped = false;
		const mode = el('cacheMode').value;
		const opts = { translated: el('translated').checked, firstUse: el('firstUse').checked };
		report = { date: new Date().toISOString(), environment: contextInfo(gl), mode, options: opts, results: [] };
		log(JSON.stringify(report.environment, null, '\t'));
		log('\nCache mode: ' + mode + '. Cold cache is NOT asserted. Keep this tab visible; do not run other shader tests concurrently.');
		setBusy(true);
		try {
			for (let i = 0; i < cases.length && !stopped; i++) {
				const c = cases[i];
				el('status').textContent = (i + 1) + '/' + cases.length + ' — ' + c.meta.id + ' t' + c.variant.terrain + ':' + c.variant.shape + ' ' + c.ablation;
				const literal = mode === 'literal' ? Math.fround(0.91 + Math.random() * 0.08).toFixed(8) : null;
				const result = await compileVariant(gl, root.Runner.helpers, c.meta, c.variant, { ...opts, ablation: c.ablation, literal });
				report.results.push(result);
				log(fmt(result));
				if (result.ok) continue;
				stopped = true;
				// Deleting a program is not cancellation of native compiler work.
				poisoned = gl.isContextLost() || /Timed out/.test(result.err);
			}
			log('\n--- slowest first (ready + optional first use) ---');
			for (const r of report.results.slice().sort((a, b) => b.total - a.total)) log(r.id + ' t' + r.key + ' ' + r.ablation + ': ' + r.total.toFixed(0) + 'ms' + (r.ok ? '' : ' FAILED'));
			el('status').textContent = poisoned ? 'restart browser before testing again' : stopped ? 'stopped' : 'done';
		} catch (e) { log('ERROR: ' + e.message); el('status').textContent = 'failed'; }
		finally { setBusy(false); }
	}

	el('runSelected').addEventListener('click', () => runCases([selected()]));
	el('runVariants').addEventListener('click', () => {
		const meta = byId[shaderSelect.value];
		runCases(variantsFor(meta).map(variant => ({ meta, variant, ablation: 'full' })));
	});
	el('runAll').addEventListener('click', () => runCases(shaders.map(meta => ({ meta, variant: { terrain: 0, shape: 0 }, ablation: 'full' }))));
	el('runAblations').addEventListener('click', () => {
		const c = selected();
		runCases(ablationsFor(c.meta, c.variant).map(ablation => ({ ...c, ablation })));
	});
	el('stop').addEventListener('click', () => { stopped = true; el('stop').disabled = true; el('status').textContent = 'stopping after current native job'; });
	el('clear').addEventListener('click', () => { el('log').textContent = ''; });
	el('save').addEventListener('click', () => {
		const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, '\t')], { type: 'application/json' }));
		const a = document.createElement('a');
		a.href = url; a.download = 'shader-compile-' + Date.now() + '.json'; a.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	});
	if (new URLSearchParams(location.search).has('auto')) setTimeout(() => el('runAll').click(), 100);
})(typeof window !== 'undefined' ? window : globalThis);
