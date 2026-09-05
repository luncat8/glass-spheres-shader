// ui.js — minimal UI glue: button selection, FPS readout, error surface, browser hooks.
(function () {
	if (typeof module === 'object' && module.exports) { module.exports = {}; return; }

	let canvas, statusEl, metaEl, errEl, fpsEl, bar, buttonsHost, paramsHost;
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

	// slider strip generated from the current shader's `params` metadata.
	// Each slider writes straight into param.value; runner.js uploads it per frame.
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

	function fmt(v, step) {
		return (step >= 1) ? String(v | 0) : v.toFixed(step >= 0.1 ? 1 : (step >= 0.01 ? 2 : 3));
	}

	function pick(id) {
		try {
			const meta = runner.select(id);
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
		// wire buttons
		const btns = buttonsHost.querySelectorAll('button[data-id]');
		for (let i = 0; i < btns.length; i++) {
			const id = btns[i].dataset.id;
			btns[i].addEventListener('click', () => pick(id));
		}
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
		};
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', boot);
	} else {
		boot();
	}
})();
