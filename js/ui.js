// ui.js — minimal UI glue: button selection, FPS readout, error surface, browser hooks.
(function () {
	if (typeof module === 'object' && module.exports) { module.exports = {}; return; }

	let canvas, statusEl, metaEl, errEl, fpsEl, bar, buttonsHost, paramsHost;
	let musicChk, musicWrap, camBtn;
	let runner;
	let firstShader = null;
	let pendingErr = '';

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
			setActive(id);
			setErr('');
			statusEl.textContent = 'rendering';
		} catch (e) {
			setErr(String(e.message || e));
			statusEl.textContent = 'error';
		}
	}

	function tick() {
		const s = runner.stats();
		fpsEl.textContent = (s.fps || 0).toFixed(1) + ' fps · ' + s.res[0] + 'x' + s.res[1] + ' · frame ' + s.frame;
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
		// boot first shader
		pick(firstShader);
		runner.run();
		tick();

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
		};
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', boot);
	} else {
		boot();
	}
})();
