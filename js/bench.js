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
	];
	const CALIB_RES = RES[1];       // cheap entry is calibrated at 640x360
	const CALIB_FRAMES = 18;        // measured frames during calibration
	const WARMUP = 6;               // warm-up frames per entry (driver caches, JIT)
	const DEFAULT_SAMPLES = 40;     // measured frames per entry
	const HARD_FRAME_MS = 400;      // a single frame above this aborts the entry
	const MIN_SAMPLES = 6;          // fewer samples than this => "timeout"
	const ENTRY_TIMEOUT_MS = 20000; // wall-clock budget per entry (incl. warm-up)
	const STEP_DOWN_MS = 26;        // median above this at 640x360 => drop res
	const STEP_UP_MS = 5;           // median below this at 640x360 => raise res
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
		if (e._met) e._met.textContent = text;
	}

	function setRow(e, cls) {
		if (!e._row) return;
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
		samplesSel.value = '40';
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
			'Score = median GPU ms/frame via gl.finish(), so display refresh limits don\'t skew it. ' +
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
		for (let i = 0; i < as.length; i++) out.arrays.push(Object.assign({}, as[i], { count: count }));
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
		gl.finish();
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
		return true;
	}

	function run() {
		if (S.running) return;
		if (!panel) return; // UI not built yet
		S.entries = collectEntries();
		if (!S.entries.length) { note('no benchmark shaders loaded'); return; }
		if (!initGL()) { note('benchmark needs WebGL2'); return; }
		if (root.Runner) root.Runner.stop(); // pause the live preview while measuring

		S.running = true;
		S.results.length = 0;
		summaryEl.textContent = '';
		buildRows();
		runBtn.disabled = true;
		abortBtn.disabled = false;
		closeBtn.disabled = true;

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
		const e = st.entry;
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
		if (root.Runner) root.Runner.run();
		note('benchmark error: ' + msg);
	}

	function abort() {
		if (!S.running) return;
		const st = S.st;
		if (st) {
			st.aborted = true;
			if (st.entry && st.entry._met) rowText(st.entry, 'aborted');
			for (let i = st.idx + 1; i < S.entries.length; i++) {
				const e = S.entries[i];
				if (e._met) rowText(e, 'aborted');
			}
		}
		S.running = false;
		runBtn.disabled = false;
		abortBtn.disabled = true;
		closeBtn.disabled = false;
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
				const t0 = performance.now();
				drawFrame(S.gl, st.cur, st.res.w, st.res.h, st.frame);
				const gpu = performance.now() - t0;
				st.wall.push(wallMs);
				st.samples.push(gpu);
				st.frame++;
				if (st.samples.length === 1) st.sane = !looksBlank(S.gl);

				const e = st.entry;
				const elTotal = performance.now() - st.entryStart;
				const isCalibEnd = st.isCalib && st.samples.length >= CALIB_FRAMES;
				const isEntryEnd = st.samples.length >= st.settings.samples || elTotal > ENTRY_TIMEOUT_MS;
				const heavy = gpu > HARD_FRAME_MS;

				if (st.isCalib) {
					if (isCalibEnd || heavy) {
						const med = median(st.samples);
						st.res = med > STEP_DOWN_MS ? RES[0]
							: med < STEP_UP_MS ? RES[2] : RES[1];
						note('calibrated to ' + st.res.label + ' (median ' + fmtMs(med) + ' ms) — ' +
							'now measuring ' + S.entries.length + ' shaders at ' + st.settings.count + ' bubbles');
						st.isCalib = false;
						st.idx = -1;
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
