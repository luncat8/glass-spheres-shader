// bench.js — GUI benchmark for the multi-bubble shaders.
//
// Every bench entry is a variant of one of the project's multi-bubble shaders
// (multi_fresnel, thick_glass, hollow_bubbles, multi_thinfilm, thick_chain)
// re-targeted at one shared scene: the same N bubbles (uBubbles uploaded from
// Feeds.bubbles64), the same fixed camera basis, the same procedural env and
// the same pixel resolution. Only the rendering technique differs, so the
// measured cost is a fair comparison of those techniques.
//
// Scoring (why not just FPS):
//   * wall FPS is capped by the display refresh (60/120/144 Hz), so it is
//     reported for context but NOT used for the score.
//   * the score is the median GPU ms per frame, measured by gl.finish() after
//     each draw — the real work the GPU did, independent of vsync.
//   * throughput (Mpx/s) is derived from the same measurement.
//
// Freeze protection:
//   * the benchmark runs on its own offscreen canvas; the main runner is
//     paused, never killed, and resumed when the run ends (or aborts).
//   * adaptive resolution: a cheap calibration pass picks a resolution that
//     keeps frames inside a comfortable budget; entries that still time out
//     are reported as "too heavy" and skipped instead of hanging the page.
//   * every frame is driven by requestAnimationFrame, so the UI stays
//     responsive between frames and the run can be aborted at any time.
(function (root) {
	if (typeof module === 'object' && module.exports) { module.exports = {}; return; }

	const RES = [
		{ label: '320 × 180', w: 320, h: 180 },
		{ label: '640 × 360', w: 640, h: 360 },
		{ label: '1024 × 576', w: 1024, h: 576 },
		{ label: '2560 × 1440', w: 2560, h: 1440 },
		{ label: '3840 × 2160', w: 3840, h: 2160 },
	];
	// pixel-proportional resolution thresholds (calibrated at CALIB_RES):
	//   cheap shaders scale linearly with pixels, so the median at 640x360
	//   predicts whether the next resolution step will stay inside budget.
	//   each step multiplies pixels by ~2.5x (RES[1]->RES[2]) or ~6.9x (RES[2]->RES[3])
	//   top tier (RES[4], 4K) is ~9.4x pixels above the calib resolution;
	//   "one step down" from top = 2560x1440.
	const STEP_DOWN_MS = 18;        // predicted cost >25ms => drop one res step
	const SKIP_ONE_STEP_MS = 8;     // calib <8ms at 640x360 => can jump one step up
	const SKIP_TWO_STEPS_MS = 2.5;  // calib <2.5ms at 640x360 => can jump to top res
	const CALIB_RES = RES[1];       // cheap entry is calibrated at 640x360
	const CALIB_FRAMES = 18;        // measured frames during calibration
	const WARMUP = 6;               // warm-up frames per entry (driver caches, JIT)
	const DEFAULT_SAMPLES = 40;     // measured frames per entry
	const HARD_FRAME_MS = 400;      // a single frame above this aborts the entry
	const MIN_SAMPLES = 6;          // fewer samples than this => "timeout"
	const ENTRY_TIMEOUT_MS = 20000; // wall-clock budget per entry (incl. warm-up)
	const SANITY_EDGE = 4;          // rgb range below this => "blank?" warning

	// fixed bench camera, identical for every entry and every machine
	const CAM = { yaw: 0.62, pitch: 0.14, dist: 9.0 };

	// ------------------------------------------------------------------ state

	const S = {
		open: false,
		running: false,
		cv: null, gl: null, vao: null,
		entries: [],
		results: [],
		st: null,          // per-run state
	};

	const basis = {
		pos: new Float32Array(3), rt: new Float32Array(3),
		up: new Float32Array(3), fw: new Float32Array(3),
	};

	// DOM handles (created once)
	let panel = null, rowsHost = null, noteEl = null, summaryEl = null;
	let countSel = null, resSel = null, samplesSel = null;
	let runBtn = null, abortBtn = null, closeBtn = null;

	// ------------------------------------------------------------- small utils

	function el(tag, cls, text) {
		const n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text) n.textContent = text;
		return n;
	}

	function addOpt(sel, value, label) {
		const o = document.createElement('option');
		o.value = value;
		o.textContent = label;
		sel.appendChild(o);
	}

	function median(arr) {
		if (!arr.length) return 0;
		const a = arr.slice().sort((x, y) => x - y);
		return a[a.length >> 1];
	}

	function fmtMs(v) { return (v || 0) < 10 ? v.toFixed(2) : v.toFixed(1); }

	// same rig math as js/camera.js, but fixed values so all entries match
	function makeCamera() {
		const cp = Math.cos(CAM.pitch);
		const fx = Math.sin(CAM.yaw) * cp, fy = Math.sin(CAM.pitch), fz = Math.cos(CAM.yaw) * cp;
		let rx = fz, rz = -fx;
		const rl = Math.sqrt(rx * rx + rz * rz) || 1.0;
		rx /= rl; rz /= rl;
		basis.pos[0] = -fx * CAM.dist; basis.pos[1] = -fy * CAM.dist; basis.pos[2] = -fz * CAM.dist;
		basis.rt[0] = rx; basis.rt[1] = 0.0; basis.rt[2] = rz;
		basis.up[0] = fy * rz; basis.up[1] = fz * rx - fx * rz; basis.up[2] = -fy * rx;
		basis.fw[0] = fx; basis.fw[1] = fy; basis.fw[2] = fz;
	}

	function collectEntries() {
		const ids = ['fresnel', 'thick', 'hollow', 'thinfilm', 'chain'];
		const out = [];
		for (let i = 0; i < ids.length; i++) {
			const e = root['BENCH_' + ids[i]];
			if (e && e.source) out.push(e);
		}
		return out;
	}

	// --------------------------------------------------------- build the GUI

	function buildRows() {
		rowsHost.textContent = '';
		for (let i = 0; i < S.entries.length; i++) {
			const e = S.entries[i];
			const row = el('div', 'bench-row');
			const name = el('div', 'bench-name', e.title);
			const src = el('span', 'bench-src', ' source: ' + (e.src || e.id));
			name.appendChild(src);
			const m = el('div', 'bench-metrics', 'queued');
			row.appendChild(name);
			row.appendChild(m);
			rowsHost.appendChild(row);
			e._row = row;
			e._met = m;
		}
	}

	function rowText(e, text) {
		if (e && e._met) e._met.textContent = text;
	}

	function setRow(e, cls) {
		if (!e || !e._row) return;
		if (cls) e._row.className = 'bench-row ' + cls;
		else e._row.className = 'bench-row';
	}

	function buildUI() {
		makeCamera();

		panel = el('div', 'bench-panel');
		panel.id = 'bench-panel';

		const head = el('div', 'bench-head');
		head.appendChild(el('b', '', 'GPU benchmark'));
		closeBtn = el('button', '', 'close');
		closeBtn.title = 'close the benchmark panel';
		head.appendChild(closeBtn);
		panel.appendChild(head);

		// settings
		const set = el('div', 'bench-settings');
		set.appendChild(el('label', '', 'bubbles '));
		countSel = el('select');
		addOpt(countSel, '16', '16');
		addOpt(countSel, '32', '32');
		addOpt(countSel, '64', '64');
		addOpt(countSel, '128', '128');
		countSel.value = '64';
		set.appendChild(countSel);
		set.appendChild(el('label', '', ' render '));
		resSel = el('select');
		addOpt(resSel, 'auto', 'auto');
		for (let i = 0; i < RES.length; i++) addOpt(resSel, String(i), RES[i].label);
		resSel.value = 'auto';
		set.appendChild(resSel);
		set.appendChild(el('label', '', ' frames '));
		samplesSel = el('select');
		addOpt(samplesSel, '20', '20');
		addOpt(samplesSel, '40', '40');
		addOpt(samplesSel, '60', '60');
		samplesSel.value = '60';
		set.appendChild(samplesSel);
		panel.appendChild(set);

		// buttons
		const btns = el('div', 'bench-buttons');
		runBtn = el('button', '', 'run benchmark');
		abortBtn = el('button', '', 'abort');
		abortBtn.disabled = true;
		btns.appendChild(runBtn);
		btns.appendChild(abortBtn);
		panel.appendChild(btns);

		// live preview (the offscreen bench canvas itself, CSS-scaled)
		const prevWrap = el('div', 'bench-preview');
		S.cv = document.createElement('canvas');
		S.cv.width = 320; S.cv.height = 180;
		prevWrap.appendChild(S.cv);
		panel.appendChild(prevWrap);

		noteEl = el('div', 'bench-note',
			'All entries render the same bubble cloud (same positions, camera, env and resolution). ' +
			'Score = median GPU ms/frame — measured with EXT_disjoint_timer_query_webgl2 when available, otherwise via gl.finish() — so display refresh limits don\'t skew it. ' +
			'Resolution adapts and heavy shaders are skipped instead of freezing.');
		panel.appendChild(noteEl);

		rowsHost = el('div', 'bench-rows');
		panel.appendChild(rowsHost);

		summaryEl = el('div', 'bench-summary');
		panel.appendChild(summaryEl);

		document.body.appendChild(panel);

		closeBtn.addEventListener('click', close);
		runBtn.addEventListener('click', run);
		abortBtn.addEventListener('click', abort);

		const barBtn = document.getElementById('bench');
		if (barBtn) barBtn.addEventListener('click', toggle);
	}

	function note(text) { if (noteEl) noteEl.textContent = text; }

	// ------------------------------------------------------------ GL helpers

	function compile(gl, type, src) {
		const sh = gl.createShader(type);
		gl.shaderSource(sh, src);
		gl.compileShader(sh);
		if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
			const log = gl.getShaderInfoLog(sh);
			gl.deleteShader(sh);
			throw new Error('shader compile failed:\n' + log);
		}
		return sh;
	}

	function link(gl, vs, fs) {
		const prog = gl.createProgram();
		gl.attachShader(prog, vs);
		gl.attachShader(prog, fs);
		gl.linkProgram(prog);
		if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
			const log = gl.getProgramInfoLog(prog);
			gl.deleteProgram(prog);
			throw new Error('program link failed:\n' + log);
		}
		return prog;
	}

	function entryMeta(e, count) {
		const base = e.meta || {};
		const out = { arrays: [], params: [], vars: [] };
		const as = base.arrays || [];
		for (let i = 0; i < as.length; i++) {
			const a = Object.assign({}, as[i], { count: count });
			// pick a feed that can actually fill `count` slots, so 128 bubbles
			// get 128 distinct positions instead of 64 + 64 zero-vectors
			if (a.feed === 'bubbles64' && count > 64) a.feed = 'bubbles128';
			if (a.feed === 'bubbles128' && count <= 64) a.feed = 'bubbles64';
			out.arrays.push(a);
		}
		const ps = base.params || [];
		for (let i = 0; i < ps.length; i++) {
			const p = Object.assign({}, ps[i]);
			if (p.name === 'uCount') p.def = count;
			p.value = undefined;
			out.params.push(p);
		}
		const vs = base.vars || [];
		for (let i = 0; i < vs.length; i++) out.vars.push(Object.assign({}, vs[i]));
		return out;
	}

	function compileEntry(gl, e, count) {
		const H = root.Runner && root.Runner.helpers;
		if (!H) throw new Error('Runner.helpers missing (runner.js not loaded)');
		const t0 = performance.now();
		const meta = entryMeta(e, count);
		const src = '#define MAXB ' + count + '\n' + e.source;
		const header = H.buildFSHeader(src, [false, false, false, false]) + H.buildUniformDecls(meta);
		const full = header + src + H.FS_FOOTER;
		const vs = compile(gl, gl.VERTEX_SHADER, H.VS);
		const fs = compile(gl, gl.FRAGMENT_SHADER, full);
		const prog = link(gl, vs, fs);
		gl.deleteShader(vs);
		gl.deleteShader(fs);
		return { prog: prog, meta: meta, compileMs: performance.now() - t0 };
	}

	function makeLocs(gl, prog, meta) {
		const out = { base: {}, params: [], arrays: [], vars: [] };
		const base = ['iResolution', 'iTime', 'iTimeDelta', 'iFrame', 'iFrameRate'];
		for (let i = 0; i < base.length; i++) out.base[base[i]] = gl.getUniformLocation(prog, base[i]);
		const ps = meta.params;
		for (let i = 0; i < ps.length; i++) out.params.push(gl.getUniformLocation(prog, ps[i].name));
		const as = meta.arrays;
		for (let i = 0; i < as.length; i++) {
			out.arrays.push(gl.getUniformLocation(prog, as[i].name) || gl.getUniformLocation(prog, as[i].name + '[0]'));
		}
		const vs = meta.vars;
		for (let i = 0; i < vs.length; i++) out.vars.push(gl.getUniformLocation(prog, vs[i].name));
		return out;
	}

	const VAR_SLOT = { uCamPos: 0, uCamRt: 1, uCamUp: 2, uCamFw: 3 };

	// optional true GPU timer: EXT_disjoint_timer_query_webgl2.
	// Falls back to gl.finish() wall time if the extension is missing.
	let GPU_TIMER_EXT = null;
	let gpuTimerAvail = false;
	function initTimerQuery(gl) {
		GPU_TIMER_EXT = gl.getExtension('EXT_disjoint_timer_query_webgl2');
		gpuTimerAvail = !!GPU_TIMER_EXT;
	}
	const pendingQueries = []; // queries whose result hasn't been read yet
	const gpuQueryPool = [];   // reusable WebGLQuery objects

	function getQuery(gl) {
		if (gpuQueryPool.length) return gpuQueryPool.pop();
		return gl.createQuery && gl.createQuery();
	}
	function recycleQuery(gl, q) {
		if (q) gpuQueryPool.push(q);
	}

	function beginGpuTimer(gl) {
		if (!gpuTimerAvail) return null;
		const q = getQuery(gl);
		if (!q) return null;
		gl.beginQuery(GPU_TIMER_EXT.TIME_ELAPSED_EXT, q);
		return q;
	}
	function endGpuTimer(gl, q) {
		if (!gpuTimerAvail || !q) return;
		gl.endQuery(GPU_TIMER_EXT.TIME_ELAPSED_EXT);
		pendingQueries.push(q);
	}

	// read all finished queries; returns an array of nanosecond durations and
	// recycles the query objects. Polls ~1ms at most per call.
	function pollGpuTimers(gl) {
		if (!gpuTimerAvail) return [];
		const out = [];
		for (let i = pendingQueries.length - 1; i >= 0; i--) {
			const q = pendingQueries[i];
			const avail = gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE);
			const disjoint = gl.getParameter(GPU_TIMER_EXT.GPU_DISJOINT_EXT);
			if (avail && !disjoint) {
				const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
				out.push(ns);
				pendingQueries.splice(i, 1);
				recycleQuery(gl, q);
			} else if (!avail) {
				// leave in queue; try again next poll
			} else {
				// disjoint (timestamp unreliable): drop the sample
				pendingQueries.splice(i, 1);
				recycleQuery(gl, q);
			}
		}
		return out;
	}

	function drawFrame(gl, cur, w, h, frame) {
		if (S.cv.width !== w || S.cv.height !== h) {
			S.cv.width = w;
			S.cv.height = h;
		}
		gl.viewport(0, 0, w, h);
		gl.useProgram(cur.prog);

		const t = frame / 60.0; // fixed sim clock: identical scene for every entry
		const b = cur.locs.base;
		if (b.iResolution) gl.uniform3f(b.iResolution, w, h, 1.0);
		if (b.iTime) gl.uniform1f(b.iTime, t);
		if (b.iTimeDelta) gl.uniform1f(b.iTimeDelta, 1.0 / 60.0);
		if (b.iFrame) gl.uniform1i(b.iFrame, frame);
		if (b.iFrameRate) gl.uniform1f(b.iFrameRate, 60.0);

		const ps = cur.meta.params;
		for (let i = 0; i < ps.length; i++) {
			const loc = cur.locs.params[i];
			if (!loc) continue;
			const v = ps[i].value !== undefined ? ps[i].value : ps[i].def;
			if (ps[i].type === 'int') gl.uniform1i(loc, v | 0);
			else gl.uniform1f(loc, v);
		}
		const as = cur.meta.arrays;
		for (let i = 0; i < as.length; i++) {
			const loc = cur.locs.arrays[i];
			if (!loc) continue;
			const feed = root.Feeds && root.Feeds[as[i].feed];
			if (feed) feed(t, cur.meta, cur.buf);
			gl.uniform4fv(loc, cur.buf);
		}
		const vs = cur.meta.vars;
		for (let i = 0; i < vs.length; i++) {
			const loc = cur.locs.vars[i];
			if (!loc) continue;
			const slot = VAR_SLOT[vs[i].name];
			if (slot === 0) gl.uniform3fv(loc, basis.pos);
			else if (slot === 1) gl.uniform3fv(loc, basis.rt);
			else if (slot === 2) gl.uniform3fv(loc, basis.up);
			else if (slot === 3) gl.uniform3fv(loc, basis.fw);
		}

		gl.bindVertexArray(S.vao);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		// only finish() when we have no GPU timer (the timer query already
		// provides a precise GPU-completion signal, and finish() adds a stall)
		if (!gpuTimerAvail) gl.finish();
	}

	// measures one frame and returns {gpuMs, query} where query is a pending
	// GPU timer query (consumed on a later step) or null when no timer.
	function measureFrame(gl, cur, w, h, frame) {
		const q = beginGpuTimer(gl);
		const t0 = performance.now();
		drawFrame(gl, cur, w, h, frame);
		const gpuWall = performance.now() - t0;
		if (q) {
			endGpuTimer(gl, q);
			return { gpuMs: null, query: q, wallMs: gpuWall };
		}
		return { gpuMs: gpuWall, query: null, wallMs: gpuWall };
	}

	const readBuf = new Uint8Array(8 * 8 * 4);
	function looksBlank(gl) {
		const w = S.cv.width, h = S.cv.height;
		gl.readPixels((w >> 1) - 4, (h >> 1) - 4, 8, 8, gl.RGBA, gl.UNSIGNED_BYTE, readBuf);
		let mn = 255, mx = 0;
		for (let i = 0; i < readBuf.length; i += 4) {
			for (let c = 0; c < 3; c++) {
				const v = readBuf[i + c];
				if (v < mn) mn = v;
				if (v > mx) mx = v;
			}
		}
		return mx - mn < SANITY_EDGE;
	}

	// -------------------------------------------------------------- run flow

	function initGL() {
		if (S.gl) return true;
		const gl = S.cv.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false });
		if (!gl) return false;
		S.gl = gl;
		const vao = gl.createVertexArray();
		gl.bindVertexArray(vao);
		gl.bindVertexArray(null);
		S.vao = vao;
		initTimerQuery(gl);
		return true;
	}

	function run() {
		if (S.running) return;
		if (!panel) return; // UI not built yet
		S.entries = collectEntries();
		if (!S.entries.length) { note('no benchmark shaders loaded'); return; }

		S.running = true;
		S.results.length = 0;
		summaryEl.textContent = '';
		buildRows();
		runBtn.disabled = true;
		abortBtn.disabled = false;
		closeBtn.disabled = true;
		countSel.disabled = true;
		resSel.disabled = true;
		samplesSel.disabled = true;

		const settings = {
			count: parseInt(countSel.value, 10),
			autoRes: resSel.value === 'auto',
			resIdx: parseInt(resSel.value, 10) || 0,
			samples: parseInt(samplesSel.value, 10) || DEFAULT_SAMPLES,
		};

		S.st = {
			settings: settings,
			idx: -1,
			phase: 'compile',   // compile -> warmup -> measure
			isCalib: settings.autoRes,
			res: settings.autoRes ? CALIB_RES : RES[settings.resIdx],
			cur: null,
			entry: null,
			frame: 0,
			samples: [],
			wall: [],
			entryStart: 0,
			lastTs: 0,
			sane: true,
			aborted: false,
		};

		try {
			if (!initGL()) { note('benchmark needs WebGL2'); throw new Error('webgl2 unavailable'); }
			if (root.Runner) root.Runner.stop(); // pause the live preview while measuring
		} catch (err) {
			// GL init / scene pause failed: roll back the running flag so the user
			// can recover instead of being stuck with disabled buttons.
			S.running = false;
			runBtn.disabled = false;
			abortBtn.disabled = true;
			closeBtn.disabled = false;
			countSel.disabled = false;
			resSel.disabled = false;
			samplesSel.disabled = false;
			note('benchmark error: ' + String(err.message || err));
			return;
		}

		note('preparing…');
		requestAnimationFrame(step);
	}

	function nextEntry() {
		const st = S.st;
		if (!st) return;
		st.idx++;
		if (st.idx >= S.entries.length) { finish(); return; }
		st.phase = 'compile';
		st.cur = null;
		st.entry = S.entries[st.idx];
		st.frame = 0;
		st.samples.length = 0;
		st.wall.length = 0;
		st.sane = true;
		rowText(st.entry, 'waiting');
		setRow(st.entry, '');
	}

	function doCompile() {
		const st = S.st;
		const entry = st.entry || S.entries[0];
		rowText(entry, 'compiling…');
		st.phase = 'warmup';
		st.frame = 0;
		st.samples.length = 0;
		st.wall.length = 0;
		st.sane = true;
		if (st.cur && st.cur.prog) S.gl.deleteProgram(st.cur.prog); // old run / old count
		st.cur = compileEntry(S.gl, entry, st.settings.count);
		st.cur.locs = makeLocs(S.gl, st.cur.prog, st.cur.meta);
		st.cur.buf = new Float32Array(st.cur.meta.arrays[0].count * 4);
		st.entryStart = performance.now();
		st.lastTs = 0;
	}

	function entryDone(hardReason) {
		const st = S.st;
		const e = st && st.entry;
		if (!e) return;
		const gpu = median(st.samples);
		const wall = median(st.wall);
		const fps = wall > 0 ? 1000.0 / wall : 0;
		const mpix = gpu > 0 ? st.res.w * st.res.h / (gpu * 1000.0) : 0;
		const ok = st.samples.length >= MIN_SAMPLES && !hardReason;
		S.results.push({
			id: e.id, title: e.title, src: e.srcTitle || e.id,
			gpu: gpu, fps: fps, mpix: mpix, resLabel: st.res.label,
			frames: st.samples.length, sane: st.sane, ok: ok,
			status: ok ? 'done' : (hardReason || 'timeout'),
		});
		const txt = (ok ? 'done · ' : (hardReason || 'timeout') + ' · ') +
			'gpu ' + fmtMs(gpu) + ' ms · ' + fps.toFixed(1) + ' fps · ' +
			mpix.toFixed(2) + ' Mpx/s' + (st.sane ? '' : ' · blank?');
		rowText(e, txt);
		setRow(e, ok && st.res.label === RES[0].label ? 'slow' : ok ? '' : 'timeout');
	}

	function finish() {
		const st = S.st;
		st.phase = 'done';
		S.running = false;
		runBtn.disabled = false;
		abortBtn.disabled = true;
		closeBtn.disabled = false;
		countSel.disabled = false;
		resSel.disabled = false;
		samplesSel.disabled = false;
		// drain in-flight GPU timer queries so they don't leak
		while (pendingQueries.length) {
			recycleQuery(S.gl, pendingQueries.pop());
		}
		if (root.Runner) root.Runner.run(); // resume the live preview

		const ok = S.results.filter((r) => r.ok);
		if (!ok.length) { note('no entry finished — try fewer bubbles or a lower resolution'); return; }
		ok.sort((a, b) => a.gpu - b.gpu);
		const best = ok[0];
		note('run done — fastest: ' + best.title + ' @ ' + best.resLabel +
			' (' + fmtMs(best.gpu) + ' ms/frame, ' + best.mpix.toFixed(2) + ' Mpx/s)');

		// ranked summary: same condition, lower GPU ms = faster
		const lines = ['ranked by median GPU ms/frame @ ' + best.resLabel + ' (' + st.settings.count + ' bubbles):'];
		for (let i = 0; i < ok.length; i++) {
			const r = ok[i];
			lines.push((i + 1) + '. ' + r.title + ' — ' + fmtMs(r.gpu) + ' ms, ' +
				r.mpix.toFixed(2) + ' Mpx/s' + (r.sane ? '' : ' (blank?)'));
		}
		summaryEl.textContent = lines.join('\n');

		// highlight the winner
		for (let i = 0; i < S.entries.length; i++) {
			const e = S.entries[i];
			if (e.id === best.id && e._row) e._row.className = 'bench-row winner';
		}
	}

	function fail(msg) {
		const st = S.st;
		if (st) st.aborted = true;
		S.running = false;
		runBtn.disabled = false;
		abortBtn.disabled = true;
		closeBtn.disabled = false;
		countSel.disabled = false;
		resSel.disabled = false;
		samplesSel.disabled = false;
		while (pendingQueries.length) {
			recycleQuery(S.gl, pendingQueries.pop());
		}
		if (root.Runner) root.Runner.run();
		note('benchmark error: ' + msg);
	}

	function abort() {
		if (!S.running) return;
		const st = S.st;
		if (st) {
			st.aborted = true;
			if (st.entry) rowText(st.entry, 'aborted');
			for (let i = st.idx + 1; i < S.entries.length; i++) {
				rowText(S.entries[i], 'aborted');
			}
		}
		S.running = false;
		runBtn.disabled = false;
		abortBtn.disabled = true;
		closeBtn.disabled = false;
		countSel.disabled = false;
		resSel.disabled = false;
		samplesSel.disabled = false;
		while (pendingQueries.length) {
			recycleQuery(S.gl, pendingQueries.pop());
		}
		if (root.Runner) root.Runner.run();
		note('benchmark aborted');
	}

	// per-run frame driver
	function step(ts) {
		const st = S.st;
		if (!st || st.aborted || st.phase === 'done') return;
		const wallMs = st.lastTs > 0 ? ts - st.lastTs : 1000.0 / 60.0;
		st.lastTs = ts;

		// tab hidden or long stall: skip this tick instead of polluting stats
		if (document.hidden || wallMs > 2500) {
			requestAnimationFrame(step);
			return;
		}

		try {
			if (st.phase === 'compile') {
				// one tick later than the status update so the browser can paint
				// the "compiling…" row before the synchronous GLSL compile blocks
				try {
					doCompile();
				} catch (err) {
					// one bad driver/entry must not kill the whole run
					const e = st.entry;
					if (e) { rowText(e, 'compile error'); setRow(e, 'timeout'); }
					note('compile error (' + (e ? e.title : 'shader') + '): ' + String(err.message || err));
					nextEntry();
				}
			} else if (st.phase === 'warmup') {
				drawFrame(S.gl, st.cur, st.res.w, st.res.h, st.frame);
				st.frame++;
				if (st.frame >= WARMUP) {
					st.phase = 'measure';
					st.frame = 0;
					st.samples.length = 0;
					st.wall.length = 0;
					st.entryStart = performance.now();
				}
			} else { // measure
				// poll any finished timer-query frames and fold them into samples
				if (gpuTimerAvail && pendingQueries.length) {
					const ns = pollGpuTimers(S.gl);
					for (let i = 0; i < ns.length; i++) {
						st.samples.push(ns[i] / 1e6); // ns -> ms
					}
				}

				const m = measureFrame(S.gl, st.cur, st.res.w, st.res.h, st.frame);
				st.wall.push(wallMs);
				// without a GPU timer, every frame contributes a sample now
				// (drawFrame calls gl.finish() so this is honest GPU work)
				if (!gpuTimerAvail) st.samples.push(m.gpuMs);
				st.frame++;
				if (st.samples.length === 1) st.sane = !looksBlank(S.gl);

				const e = st.entry;
				const elTotal = performance.now() - st.entryStart;
				const isCalibEnd = st.isCalib && st.samples.length >= CALIB_FRAMES;
				const isEntryEnd = st.samples.length >= st.settings.samples || elTotal > ENTRY_TIMEOUT_MS;
				// wall-time check: with timer queries we don't know per-frame
				// GPU ms yet, so fall back to wall for the heavy-cut
				const heavy = m.wallMs > HARD_FRAME_MS;

				if (st.isCalib) {
					if (isCalibEnd || heavy) {
						const med = median(st.samples);
						// pick the highest resolution that should still finish in budget.
						// start at the top (RES.length-1) and walk down until the predicted
						// cost at calib-res * pixel-ratio is under STEP_DOWN_MS.
						let pick = RES.length - 1;
						while (pick > 0) {
							const px = RES[pick].w * RES[pick].h;
							const calPx = CALIB_RES.w * CALIB_RES.h;
							const predicted = med * (px / calPx);
							if (predicted <= STEP_DOWN_MS) break;
							pick--;
						}
						// but if calib was so cheap we could've skipped a step, jump up
						if (med < SKIP_TWO_STEPS_MS && RES.length >= 4) pick = RES.length - 1;
						else if (med < SKIP_ONE_STEP_MS && RES.length >= 3) pick = Math.max(pick, RES.length - 2);
						st.res = RES[pick];
						note('calibrated to ' + st.res.label + ' (median ' + fmtMs(med) + ' ms @ ' + CALIB_RES.label + ') — ' +
							'now measuring ' + S.entries.length + ' shaders at ' + st.settings.count + ' bubbles');
						st.isCalib = false;
						st.idx = -1;
						// drop any pending queries: calibration is no longer representative
						while (pendingQueries.length) {
							recycleQuery(S.gl, pendingQueries.pop());
						}
						nextEntry();
					}
				} else {
					if (heavy) {
						entryDone('frame too heavy');
						note('entry skipped — too heavy at ' + st.res.label + ' with ' + st.settings.count +
							' bubbles; try a smaller count/resolution');
						nextEntry();
					} else if (isEntryEnd) {
						entryDone(st.samples.length >= MIN_SAMPLES ? null : 'timeout');
						nextEntry();
					} else {
						const fps = median(st.wall) > 0 ? 1000.0 / median(st.wall) : 0;
						rowText(e, 'measuring ' + st.samples.length + '/' + st.settings.samples +
							' · gpu ' + fmtMs(median(st.samples)) + ' ms · ' + fps.toFixed(1) + ' fps');
					}
				}
			}
		} catch (err) {
			fail(String(err.message || err));
			return;
		}

		if (S.st === st && !st.aborted && st.phase !== 'done') requestAnimationFrame(step);
	}

	// ----------------------------------------------------------- open / close

	function open() {
		if (S.open) return;
		S.open = true;
		if (panel) panel.classList.add('open');
	}

	function close() {
		if (S.running) abort();
		S.open = false;
		if (panel) panel.classList.remove('open');
	}

	function toggle() {
		if (S.open) close();
		else open();
	}

	// public API
	root.Bench = {
		open, close, toggle, run, abort,
		isOpen: () => S.open,
		isRunning: () => S.running,
		results: () => S.results.slice(),
	};

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', buildUI);
	} else {
		buildUI();
	}
})(typeof window !== 'undefined' ? window : globalThis);
