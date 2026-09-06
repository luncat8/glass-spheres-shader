// ui.js — minimal UI glue: button selection, FPS readout, error surface, browser hooks.
(function () {
	if (typeof module === 'object' && module.exports) { module.exports = {}; return; }

	let canvas, statusEl, metaEl, errEl, fpsEl, bar, buttonsHost, sceneHost, noteEl, paramsHost;
	let musicChk, musicWrap, camBtn, movBtn, aaBtn, copyBtn;
	let runner;
	let firstShader = null;
	let pendingErr = '';
	let lastFpsTick = 0;
	let curScene = 'checker';   // the scene selector's state, shared by every shader

	function setErr(msg) {
		errEl.textContent = msg || '';
		errEl.style.display = msg ? 'block' : 'none';
	}

	function shaderById(id) {
		const list = window.SHADERS || [];
		for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
		return null;
	}

	// notes and tooltips name shaders by id, which is what the buttons show
	function shaderName(id) { return id; }

	// the note under the selectors explains any fallback the last click forced,
	// so a combination that does not exist never looks like a broken click
	function setNote(msg) {
		if (!noteEl) return;
		noteEl.textContent = msg || '';
		noteEl.style.display = msg ? 'inline' : 'none';
	}

	// ------------------------------------------------- selector button state

	function refreshSelectors() {
		const meta = runner && runner.current;
		const btns = buttonsHost.querySelectorAll('button[data-id]');
		for (let i = 0; i < btns.length; i++) {
			const m = shaderById(btns[i].dataset.id);
			const ok = window.Scenes.supports(m, curScene);
			btns[i].classList.toggle('active', !!meta && btns[i].dataset.id === meta.id);
			btns[i].classList.toggle('alt', !ok);
			btns[i].title = shortLabel(m) +
				(ok ? '' : ' — cannot draw the "' + window.Scenes.get(curScene).label +
					'" scene; picking it switches the scene to "' + window.Scenes.get(window.Scenes.nativeScene(m)).label + '"');
		}
		const sbtns = sceneHost.querySelectorAll('button[data-scene]');
		for (let i = 0; i < sbtns.length; i++) {
			const sc = window.Scenes.get(sbtns[i].dataset.scene);
			const ok = window.Scenes.supports(meta, sc.id);
			const fallback = ok ? null : window.Scenes.nativeShader(sc.id, window.SHADERS || []);
			sbtns[i].classList.toggle('active', sc.id === curScene);
			sbtns[i].classList.toggle('alt', !ok && !!fallback);
			sbtns[i].disabled = !ok && !fallback;
			sbtns[i].title = sc.hint +
				(ok || !fallback ? '' : ' — the current shader cannot draw it; picking it switches the shader to ' + shaderName(fallback)) +
				(!ok && !fallback ? ' — pick one of the "own scene" or "shadertoy originals" shaders to use it' : '');
		}
	}

	// emoji() renders the primary glyph onto an offscreen canvas and inspects the
	// pixels: a glyph the system can't draw comes back blank (flat alpha), so we
	// fall back to the ASCII/unicode-safe twin. The probe runs once per pair and
	// is cached for the rest of the session — it is called from the hot
	// shortLabel() path, so caching matters.
	const emojiCache = Object.create(null);

	function emoji(primary, fallback) {
		const key = primary + '\u0000' + fallback;
		if (emojiCache[key] !== undefined) return emojiCache[key];
		emojiCache[key] = fallback; // pessimistic default before the probe runs
		if (typeof document === 'undefined') return fallback;

		const canvas = document.createElement('canvas');
		const ctx = canvas.getContext('2d');
		if (!ctx) return fallback;

		canvas.width = 50;
		canvas.height = 50;
		ctx.font = '40px sans-serif';
		ctx.textBaseline = 'top';
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.fillText(primary, 0, 0);

		const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
		for (let i = 0; i < data.length; i += 4) {
			if (data[i + 3] > 0 && (data[i] !== data[i + 1] || data[i + 1] !== data[i + 2])) {
				emojiCache[key] = primary;
				return primary;
			}
		}
		return fallback;
	}

	function bubbleCount(meta) {
		if (!meta) return 1;
		const ps = meta.params || [];
		for (let i = 0; i < ps.length; i++) {
			if (ps[i].name === 'uCount' && ps[i].max) return ps[i].max;
		}
		const arr = meta.arrays || [];
		for (let i = 0; i < arr.length; i++) {
			if (arr[i].name === 'uBubbles' && arr[i].count) return arr[i].count;
		}
		const m = (meta.title || '').match(/\((\d+)\s*(?:sphere|bubble)/i);
		return m ? parseInt(m[1]) : 1;
	}

	function isAdjustable(meta) {
		if (!meta) return false;
		const ps = meta.params || [];
		for (let i = 0; i < ps.length; i++) {
			if (ps[i].name !== 'uScene' && !ps[i].hidden) return true;
		}
		return false;
	}

	function shortLabel(meta) {
		const id = meta.id;
		const t = meta.title || id;
		const dash = t.indexOf(' - ');
		let tail = dash >= 0 ? t.slice(dash + 3) : t;
		tail = tail.split(',')[0].trim();
		tail = tail.replace(/\([^)]*\)/g, '').trim();
		const count = bubbleCount(meta);
		const adj = isAdjustable(meta);
		return id + ', ' + tail + ', ' + emoji('🪩', '💿') + ' ' + count + (adj ? ', adj' : '');
	}

	function buildButton(meta) {
		const item = document.createElement('span');
		item.className = 'shader-item';

		const btn = document.createElement('button');
		btn.dataset.id = meta.id;
		btn.textContent = shortLabel(meta);
		btn.title = shortLabel(meta);
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

	// shaders are grouped by how they relate to the scene selector, so the row
	// itself explains which buttons are combinable with which scene
	const GROUPS = [
		{ id: 'scene', label: 'scene-aware:', hint: 'these renderers work with every scene in the row below' },
		{ id: 'own', label: 'own scene:', hint: 'cubemap/iMouse pipelines that bring their own background and motion' },
		{ id: 'orig', label: 'shadertoy originals:', hint: 'unmodified ports; they bring their own background and motion' },
	];

	function renderButtons(list) {
		buttonsHost.textContent = '';
		for (let g = 0; g < GROUPS.length; g++) {
			const members = list.filter((s) => (s.group || 'orig') === GROUPS[g].id);
			if (!members.length) continue;
			const tag = document.createElement('span');
			tag.className = 'group-tag';
			tag.textContent = GROUPS[g].label;
			tag.title = GROUPS[g].hint;
			buttonsHost.appendChild(tag);
			for (let i = 0; i < members.length; i++) buttonsHost.appendChild(buildButton(members[i]));
		}
	}

	function renderScenes() {
		sceneHost.textContent = '';
		const scenes = window.Scenes.list;
		for (let i = 0; i < scenes.length; i++) {
			const btn = document.createElement('button');
			btn.dataset.scene = scenes[i].id;
			btn.textContent = scenes[i].label;
			btn.title = scenes[i].hint;
			btn.addEventListener('click', () => pickScene(scenes[i].id));
			sceneHost.appendChild(btn);
		}
	}

	// parameter strip generated from the current shader's `params` metadata.
	// Sliders write straight into param.value; options params (p.options) render
	// as a <select>. Params that only apply to some scenes (the cage sliders)
	// are hidden in the others, and `uScene` never appears — the scene row owns
	// it. runner.js uploads the values per frame.
	function buildParams(meta) {
		paramsHost.textContent = '';
		const ps = (meta && meta.params) || [];
		let shown = 0;
		for (let i = 0; i < ps.length; i++) {
			const p = ps[i];
			if (p.value === undefined) p.value = p.def;
			if (!window.Scenes.paramVisible(p, curScene)) continue;
			shown++;
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
		paramsHost.style.display = 'flex';
		if (shown) return;
		// an empty strip used to look like a bug; say why it is empty instead
		const hint = document.createElement('span');
		hint.className = 'param-empty';
		hint.textContent = (meta && meta.params && meta.params.length)
			? 'no parameters for this shader in the "' + window.Scenes.get(curScene).label + '" scene'
			: 'this shader has no parameters';
		paramsHost.appendChild(hint);
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

	// the cam button belongs to the shared orbit camera only; a shader that
	// drives its own GLSL camera from iMouse gets a disabled button that says
	// so, instead of a click that silently does nothing
	const CAM_TIP_OWN = 'this shader orbits from iMouse inside its own GLSL camera — ' +
		'the shared orbit camera (drag, wheel, pinch, auto-orbit, click-to-select) does not apply';
	let camTipShared = '';

	function updateCam() {
		const shared = !!window.Cam && window.Cam.shared();
		camBtn.disabled = !shared;
		camBtn.title = shared ? camTipShared : CAM_TIP_OWN;
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

	// ------------------------------------------------------ the two selectors
	//
	// shader = HOW the bubbles are drawn, scene = WHERE they are drawn and HOW
	// they move. They are independent: `curScene` is global, so switching the
	// shader keeps the scene and switching the scene keeps the shader.
	//
	// Not every pair exists. The selector the user just clicked always wins and
	// the other one falls back to its native partner, with a note saying so.

	function pick(id, note) {
		const meta = shaderById(id);
		if (!meta) { setErr('unknown shader id: ' + id); return; }
		let msg = note || '';
		if (!window.Scenes.supports(meta, curScene)) {
			const from = window.Scenes.get(curScene).label;
			const next = window.Scenes.nativeScene(meta);
			curScene = next;
			msg = meta.id + ' cannot draw the "' + from + '" scene — scene switched to "' +
				window.Scenes.get(next).label + '"';
		}
		window.Scenes.apply(meta, curScene);
		try {
			runner.select(id);
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
			refreshSelectors();
			setNote(msg);
			setErr('');
			statusEl.textContent = 'rendering';
		} catch (e) {
			setErr(String(e.message || e));
			statusEl.textContent = 'error';
		}
	}

	// Switching the scene never recompiles: the shader already declares the
	// hidden `uScene` uniform and its sphere feed is scene-aware, so only the
	// param value, the visible sliders and the selection need refreshing.
	function pickScene(sceneId) {
		const meta = runner && runner.current;
		if (!meta) return;
		const sc = window.Scenes.get(sceneId);
		if (!window.Scenes.supports(meta, sceneId)) {
			const next = window.Scenes.nativeShader(sceneId, window.SHADERS || []);
			if (!next) {
				setNote('"' + sc.label + '" is not a shared scene — pick a shader from the "own scene" or "shadertoy originals" group');
				return;
			}
			curScene = sceneId;
			pick(next, 'scene "' + sc.label + '" needs another renderer — shader switched to ' + shaderName(next));
			return;
		}
		if (curScene === sceneId) return;
		curScene = sceneId;
		window.Scenes.apply(meta, curScene);
		if (window.Cam) window.Cam.attach(meta); // motion model changed: drop the selection
		buildParams(meta);
		refreshSelectors();
		setNote('');
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
		sceneHost = document.getElementById('scene-buttons');
		noteEl = document.getElementById('combo-note');
		paramsHost = document.getElementById('params');
		musicChk = document.getElementById('music');
		musicWrap = document.getElementById('music-wrap');
		camBtn = document.getElementById('cam');
		camTipShared = camBtn.title;
		movBtn = document.getElementById('mov');
		aaBtn = document.getElementById('aa');
		copyBtn = document.getElementById('copy-prompt');

		const list = window.SHADERS || [];
		if (!list.length) {
			setErr('no shaders registered (check shaders/*.js loaded)');
			return;
		}
		renderButtons(list);
		renderScenes();
		firstShader = (list.filter((s) => (s.group || 'orig') === 'scene')[0] || list[0]).id;
		curScene = window.Scenes.nativeScene(shaderById(firstShader));
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
			pickScene,
			scene: () => curScene,
			scenes: () => window.Scenes.list.map((s) => s.id),
			setScene: pickScene,
			sceneOf: (id) => window.Scenes.supported(shaderById(id)),
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
