// ui.js — minimal UI glue: button selection, FPS readout, error surface, browser hooks.
(function () {
	if (typeof module === 'object' && module.exports) { module.exports = {}; return; }

	let canvas, statusEl, metaEl, errEl, fpsEl, bar, buttonsHost, paramsHost;
	let musicChk, musicWrap, camBtn, movBtn, aaBtn, copyBtn;
	let runner;
	let firstShader = null;
	let pendingErr = '';
	let lastFpsTick = 0;

	function setErr(msg) {
		errEl.textContent = msg || '';
		errEl.style.display = msg ? 'block' : 'none';
	}

	function setActive(id) {
		const btns = buttonsHost.querySelectorAll('button[data-id]');
		for (let i = 0; i < btns.length; i++) {
			btns[i].classList.toggle('active', btns[i].dataset.id === id);
		}
	}

	function shortLabel(meta) {
		const id = meta.id;
		const t = meta.title || id;
		// strip leading "<ID> - " prefix
		const dash = t.indexOf(' - ');
		const tail = dash >= 0 ? t.slice(dash + 3) : t;
		return id + ' (' + tail + ')';
	}

	function buildButton(meta) {
		const item = document.createElement('span');
		item.className = 'shader-item';

		const btn = document.createElement('button');
		btn.dataset.id = meta.id;
		btn.textContent = shortLabel(meta);
		btn.title = meta.title || meta.id;
		item.appendChild(btn);

		if (meta.url) {
			const a = document.createElement('a');
			a.className = 'stlink';
			a.href = meta.url;
			a.target = '_blank';
			a.rel = 'noopener noreferrer';
			a.textContent = 'shadertoy';
			a.title = meta.url;
			item.appendChild(a);
		}
		return item;
	}

	function renderButtons(list) {
		buttonsHost.textContent = '';
		for (let i = 0; i < list.length; i++) buttonsHost.appendChild(buildButton(list[i]));
	}

	// parameter strip generated from the current shader's `params` metadata.
	// Sliders write straight into param.value; options params (p.options) render
	// as a <select>. runner.js uploads the values per frame.
	function buildParams(meta) {
		paramsHost.textContent = '';
		const ps = meta.params || [];
		paramsHost.style.display = ps.length ? 'flex' : 'none';
		for (let i = 0; i < ps.length; i++) {
			const p = ps[i];
			if (p.value === undefined) p.value = p.def;
			const wrap = document.createElement('label');
			wrap.className = 'param';
			wrap.title = p.hint || p.name;
			const name = document.createElement('span');
			name.textContent = p.label || p.name;
			if (p.options && p.options.length) {
				const sel = document.createElement('select');
				for (let o = 0; o < p.options.length; o++) {
					const opt = document.createElement('option');
					opt.value = p.options[o].value;
					opt.textContent = p.options[o].label;
					if (p.options[o].value === p.value) opt.selected = true;
					sel.appendChild(opt);
				}
				sel.addEventListener('change', () => { p.value = parseFloat(sel.value); });
				wrap.appendChild(name); wrap.appendChild(sel);
				paramsHost.appendChild(wrap);
				continue;
			}
			const slider = document.createElement('input');
			slider.type = 'range';
			slider.min = p.min; slider.max = p.max; slider.step = p.step;
			slider.value = p.value;
			const read = document.createElement('b');
			read.textContent = fmt(p.value, p.step);
			slider.addEventListener('input', () => {
				p.value = parseFloat(slider.value);
				read.textContent = fmt(p.value, p.step);
			});
			wrap.appendChild(name); wrap.appendChild(slider); wrap.appendChild(read);
			paramsHost.appendChild(wrap);
		}
	}

	// music is off by default; only shaders with `music: true` have a piece.
	// `restart` = the shader was just picked (piece starts at 0); otherwise the
	// piece seeks to the current shader time so toggling mid-run stays in sync.
	function syncMusic(meta, restart) {
		const has = !!(meta && meta.music);
		musicChk.disabled = !has;
		musicWrap.classList.toggle('off', !has);
		musicWrap.title = has ? 'play the shader\'s procedural music (off by default)'
			: 'this shader has no music (llsSDf does)';
		const want = has && musicChk.checked;
		if (!window.AudioM) return;
		if (!want) { window.AudioM.setEnabled(false); return; }
		if (restart) window.AudioM.reset();
		else if (runner && runner.current) window.AudioM.seek(runner.elapsed || 0);
		window.AudioM.setEnabled(true);
	}

	function updateCam() {
		camBtn.textContent = window.Cam ? window.Cam.label() : 'cam';
	}
	function updateMov() {
		movBtn.textContent = runner.getMov() ? 'mov: on' : 'mov: off';
	}

	function updateAA() {
		aaBtn.textContent = runner.getAA() ? 'aa: on' : 'aa: off';
	}

	// -------------------------------------------------- copy prompt button

	function flashBtn(btn, text, ms) {
		const old = btn.textContent;
		btn.textContent = text;
		setTimeout(() => { btn.textContent = old; }, ms || 1200);
	}

	function fallbackCopy(text, cb) {
		const ta = document.createElement('textarea');
		ta.value = text;
		ta.style.position = 'fixed';
		ta.style.opacity = '0';
		document.body.appendChild(ta);
		ta.select();
		let ok = false;
		try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
		document.body.removeChild(ta);
		cb(ok);
	}

	function copyText(text, cb) {
		if (navigator.clipboard && navigator.clipboard.writeText) {
			navigator.clipboard.writeText(text).then(() => cb(true), () => fallbackCopy(text, cb));
		} else if (fallbackCopy) {
			fallbackCopy(text, cb);
		} else {
			cb(false);
		}
	}

	// "copy prompt": copies a prompt that asks an LLM to implement a shader
	// like the currently selected one, with a short tech description and the
	// GitHub link to that shader file.
	function copyPrompt() {
		const meta = runner && runner.current;
		if (!meta) { flashBtn(copyBtn, 'no shader', 1200); return; }
		const text = window.Prompts ? window.Prompts.textFor(meta) : '';
		copyText(text, (ok) => flashBtn(copyBtn, ok ? 'copied ✓' : 'copy failed', 1500));
	}

	function promptText() {
		const meta = runner && runner.current;
		return meta && window.Prompts ? window.Prompts.textFor(meta) : '';
	}

	function fmt(v, step) {
		return (step >= 1) ? String(v | 0) : v.toFixed(step >= 0.1 ? 1 : (step >= 0.01 ? 2 : 3));
	}

	function pick(id) {
		try {
			const meta = runner.select(id);
			if (window.Cam) window.Cam.attach(meta);
			metaEl.textContent = meta.title || meta.id;
			if (meta.url) {
				const a = document.createElement('a');
				a.className = 'stlink';
				a.href = meta.url;
				a.target = '_blank';
				a.rel = 'noopener noreferrer';
				a.textContent = 'shadertoy';
				a.title = meta.url;
				metaEl.appendChild(a);
			}
			buildParams(meta);
			syncMusic(meta, true);
			updateCam();
			if (copyBtn) copyBtn.title = window.Prompts ? window.Prompts.summary(meta) : '';
			setActive(id);
			setErr('');
			statusEl.textContent = 'rendering';
		} catch (e) {
			setErr(String(e.message || e));
			statusEl.textContent = 'error';
		}
	}

	function tick() {
		const now = performance.now();
		// throttle DOM updates to ~4Hz; the FPS itself is already a 500ms
		// average so a faster refresh adds noise without adding signal
		if (now - lastFpsTick >= 250) {
			lastFpsTick = now;
			const s = runner.stats();
			fpsEl.textContent = (s.fps || 0).toFixed(1) + ' fps · ' + s.res[0] + 'x' + s.res[1] + ' · frame ' + s.frame;
		}
		requestAnimationFrame(tick);
	}

	function boot() {
		canvas = document.getElementById('c');
		statusEl = document.getElementById('status');
		metaEl = document.getElementById('meta');
		errEl = document.getElementById('err');
		fpsEl = document.getElementById('fps');
		bar = document.getElementById('bar');
		buttonsHost = document.getElementById('shader-buttons');
		paramsHost = document.getElementById('params');
		musicChk = document.getElementById('music');
		musicWrap = document.getElementById('music-wrap');
		camBtn = document.getElementById('cam');
		movBtn = document.getElementById('mov');
		aaBtn = document.getElementById('aa');
		copyBtn = document.getElementById('copy-prompt');

		const list = window.SHADERS || [];
		if (!list.length) {
			setErr('no shaders registered (check shaders/*.js loaded)');
			return;
		}
		renderButtons(list);
		firstShader = list[0].id;
		try {
			runner = window.Runner.init(canvas);
		} catch (e) {
			setErr('runner init failed: ' + (e.message || e));
			return;
		}
		runner.onError = (m) => setErr(m);
		if (window.Cam) {
			window.Cam.init(canvas, runner);
			window.Cam.onModeChange = updateCam;
		}
		// wire buttons
		const btns = buttonsHost.querySelectorAll('button[data-id]');
		for (let i = 0; i < btns.length; i++) {
			const id = btns[i].dataset.id;
			btns[i].addEventListener('click', () => pick(id));
		}
		musicChk.addEventListener('change', () => syncMusic(runner.current));
		camBtn.addEventListener('click', () => {
			if (window.Cam) { window.Cam.cycleMode(); updateCam(); }
		});
		movBtn.addEventListener('click', () => { runner.setMov(!runner.getMov()); updateMov(); });
		aaBtn.addEventListener('click', () => { runner.setAA(!runner.getAA()); updateAA(); });
		runner.onAAChangeSetter(updateAA);
		if (copyBtn) {
			copyBtn.title = window.Prompts ? window.Prompts.summary(runner.current) : 'copy the LLM prompt for the current shader';
			copyBtn.addEventListener('click', copyPrompt);
		}
		// boot first shader
		pick(firstShader);
		runner.run();
		tick();
		updateAA();
		updateMov();

		// expose for the browser check
		window.__app = {
			pick,
			stats: () => runner.stats(),
			list: () => (window.SHADERS || []).map((s) => s.id),
			current: () => runner.current && runner.current.id,
			getCanvas: () => canvas,
			cam: () => (window.Cam ? window.Cam.state() : null),
			cycleCam: () => { if (window.Cam) { window.Cam.cycleMode(); updateCam(); } },
			music: () => (window.AudioM ? window.AudioM.isActive() : false),
			setMusic: (v) => { musicChk.checked = !!v; syncMusic(runner.current); },
			aa: () => runner.getAA(),
			setAA: (v) => { runner.setAA(!!v); updateAA(); },
			mov: () => runner.getMov(),
			setMov: (v) => { runner.setMov(!!v); updateMov(); },
			copyPrompt,
			promptText,
		};
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', boot);
	} else {
		boot();
	}
})();
