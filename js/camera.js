// camera.js — shared orbit camera for the 3D bubble shaders.
// Owns yaw / pitch / distance / target, the auto-orbit modes, and all pointing
// input: press-drag (mouse, pointer, touch), wheel zoom, pinch zoom, and
// click-to-select / click-outside-to-deselect a bubble (ray pick against the
// same sphere data the shaders draw). The runner uploads the camera basis
// every frame through the feeds registered below (camPos / camRt / camUp /
// camFw / camSel); shaders declare matching `vars` in their metadata.
//
// auto mode (Cam.mode):
//   0 = "auto" — orbit until the user moves the camera manually, then off
//   1 = "on"   — always orbit, manual drag just steers it
//   2 = "off"  — never orbit
(function (root) {
	if (typeof module === 'object' && module.exports) { module.exports = {}; return; }

	const Cam = {
		mode: 0, // see header; 0 = auto-until-first-manual-move (the default)
		yaw: 0.0,
		pitch: 0.15,
		dist: 7.5,
		target: [0, 0, 0],
		sel: [0, 0, 0, 0],   // selected bubble centre + radius (w = 0 => none)
		selSrc: null,       // { kind: 'bubbles' | 'fixed4' | cage feed, idx } or null
		onModeChange: null, // ui hook to refresh the camera button label
	};

	const TAU = 2.0 * Math.PI;
	const MIN_DIST = 2.2, MAX_DIST = 40.0, PITCH_MAX = 1.45;
	const AUTO_SPEED = 0.15, CLICK_DRAG = 6.0;
	const TAN30 = Math.tan(Math.PI / 6.0); // FOV 60, matches `FOV` in glsl_lib

	// preallocated scratch (AGENTS.md: no allocations in per-frame hot paths)
	const fw = [0, 0, 0], rt = [0, 0, 0], up = [0, 0, 0], pos = [0, 0, 0];
	const ray = [0, 0, 0];
	const fixed4 = new Float32Array(16); // mirror of GLSL.bubbles4 (thick_*)
	const cagePick = new Float32Array((61 + 3) * 4); // merged only on click
	const feeds = {};                    // filled below, registered once

	let canvas = null, runner = null;
	let pointers = [];      // active pointer { id, x, y }
	let pinchDist = 0;
	let downX = 0, downY = 0, dragDist = 0, dragging = false;

	function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

	function modeLabel() {
		return Cam.mode === 1 ? 'cam: on' : Cam.mode === 2 ? 'cam: off' : 'cam: auto';
	}

	function setMode(m) {
		Cam.mode = m;
		if (Cam.onModeChange) Cam.onModeChange();
	}

	// any manual camera input ends "auto" mode (the plan's default: auto until
	// the user moves the camera), unless the user forced it to stay on
	function manual() {
		if (Cam.mode === 0) setMode(2);
	}

	function clearSel() {
		Cam.sel[0] = 0; Cam.sel[1] = 0; Cam.sel[2] = 0; Cam.sel[3] = 0;
		Cam.selSrc = null;
		Cam.target[0] = 0; Cam.target[1] = 0; Cam.target[2] = 0;
	}

	// eye / basis from yaw-pitch-distance, same rig as the old iMouse camera
	function basis() {
		const cp = Math.cos(Cam.pitch);
		fw[0] = Math.sin(Cam.yaw) * cp;
		fw[1] = Math.sin(Cam.pitch);
		fw[2] = Math.cos(Cam.yaw) * cp;
		// right = normalize(cross(worldUp, fw))
		let rx = fw[2], rz = -fw[0];
		const rl = Math.sqrt(rx * rx + rz * rz) || 1.0;
		rt[0] = rx / rl; rt[1] = 0; rt[2] = rz / rl;
		// up = cross(fw, right)
		up[0] = fw[1] * rt[2];
		up[1] = fw[2] * rt[0] - fw[0] * rt[2];
		up[2] = -fw[1] * rt[0];
		pos[0] = Cam.target[0] - fw[0] * Cam.dist;
		pos[1] = Cam.target[1] - fw[1] * Cam.dist;
		pos[2] = Cam.target[2] - fw[2] * Cam.dist;
	}

	function paramVal(meta, name, fallback) {
		const ps = (meta && meta.params) || [];
		for (let i = 0; i < ps.length; i++) {
			if (ps[i].name !== name) continue;
			const v = ps[i].value !== undefined ? ps[i].value : ps[i].def;
			if (typeof v === 'number' && isFinite(v)) return v;
		}
		return fallback;
	}

	// exact mirror of GLSL.bubbles4 (the thick_* shaders draw these four, so the
	// JS pick, the selected-bubble orbit target and the highlighting all agree
	// with what the GPU renders)
	function bubble4(i, t) {
		const j = i * 4;
		if (i === 0) {
			fixed4[j] = 0.4 * Math.sin(t * 0.50);
			fixed4[j + 1] = 0.6 * Math.sin(t * 0.90);
			fixed4[j + 2] = 0.0; fixed4[j + 3] = 1.4;
		} else if (i === 1) {
			fixed4[j] = 2.0 * Math.cos(t * 0.40);
			fixed4[j + 1] = -0.4 + 0.3 * Math.sin(t);
			fixed4[j + 2] = 0.5 * Math.sin(t * 0.6);
			fixed4[j + 3] = 1.1;
		} else if (i === 2) {
			fixed4[j] = -1.8 + 0.5 * Math.sin(t * 0.70);
			fixed4[j + 1] = 0.2 * Math.cos(t * 0.80);
			fixed4[j + 2] = -0.6; fixed4[j + 3] = 1.0;
		} else {
			fixed4[j] = 0.4 * Math.sin(t * 0.30);
			fixed4[j + 1] = 1.3 * Math.cos(t * 0.40);
			fixed4[j + 2] = 1.2; fixed4[j + 3] = 0.9;
		}
	}

	// Locate the pickable sphere set for the current shader. Cage has two
	// uniforms, so its active prefixes are copied into one preallocated buffer
	// for the click ray cast. This function runs on clicks, not in the frame loop.
	function pickable(meta, time) {
		if (!meta) return null;
		const as = (meta && meta.arrays) || [];
		let bubbles = null, scene4 = null, cageInside = null, cageTop = null;
		for (let i = 0; i < as.length; i++) {
			if (as[i].feed === 'bubbles') bubbles = as[i];
			if (as[i].feed === 'sceneBubbles4') scene4 = as[i];
			if (as[i].feed === 'cageInside') cageInside = as[i];
			if (as[i].feed === 'cageTop') cageTop = as[i];
		}

		const cageScene = paramVal(meta, 'uScene', -1) === 3;
		const inside = cageInside || (cageScene ? (bubbles || scene4) : null);
		if (inside && cageTop) {
			const insideFeed = root.Feeds && root.Feeds[inside.feed];
			const topFeed = root.Feeds && root.Feeds[cageTop.feed];
			if (!insideFeed || !topFeed) return null;
			insideFeed(time, meta, inside.buf);
			topFeed(time, meta, cageTop.buf);
			const countName = inside.feed === 'bubbles' || inside.feed === 'cageInside' ? 'uCount' : '';
			const ni = countName ? Math.min(inside.count, Math.max(0, Math.round(paramVal(meta, countName, inside.count)))) : inside.count;
			const nt = Math.min(cageTop.count, Math.max(0, Math.round(paramVal(meta, 'uTopCount', cageTop.count))));
			for (let i = 0; i < ni * 4; i++) cagePick[i] = inside.buf[i];
			for (let i = 0; i < nt * 4; i++) cagePick[ni * 4 + i] = cageTop.buf[i];
			return { arr: cagePick, n: ni + nt, kind: 'cage', split: ni, insideKind: inside.feed };
		}
		const regular = bubbles || scene4;
		if (regular) {
			const feed = root.Feeds && root.Feeds[regular.feed];
			if (!feed) return null;
			feed(time, meta, regular.buf);
			const n = regular.feed === 'bubbles'
				? Math.min(regular.count, Math.round(paramVal(meta, 'uCount', regular.count)))
				: regular.count;
			return { arr: regular.buf, n, kind: regular.feed };
		}
		if (meta.fixed4) {
			for (let i = 0; i < 4; i++) bubble4(i, time);
			return { arr: fixed4, n: 4, kind: 'fixed4' };
		}
		return null;
	}

	// keep the selection and the orbit target glued to the (moving) bubble
	function updateSelPos() {
		const s = Cam.selSrc;
		const meta = runner && runner.current;
		if (!s || !meta) return;
		if (s.kind === 'cageTop' && meta.id !== 'cage' && paramVal(meta, 'uScene', -1) !== 3) {
			clearSel();
			return;
		}
		const time = (runner && runner.sceneTime !== undefined) ? runner.sceneTime : (runner.elapsed || 0);
		let src = null, n = 0;
		if (s.kind === 'bubbles' || s.kind === 'sceneBubbles4') {
			const as = meta.arrays || [];
			for (let i = 0; i < as.length; i++) {
				if (as[i].feed !== s.kind) continue;
				src = as[i].buf;
				n = s.kind === 'bubbles'
					? Math.min(as[i].count, Math.round(paramVal(meta, 'uCount', as[i].count)))
					: as[i].count;
				const feed = root.Feeds && root.Feeds[s.kind];
				if (feed) feed(time, meta, src);
				break;
			}
		} else if (s.kind === 'cageInside' || s.kind === 'cageTop') {
			const feedName = s.kind;
			const countName = s.kind === 'cageInside' ? 'uCount' : 'uTopCount';
			const as = meta.arrays || [];
			for (let i = 0; i < as.length; i++) {
				if (as[i].feed !== feedName) continue;
				src = as[i].buf;
				n = Math.min(as[i].count, Math.max(0, Math.round(paramVal(meta, countName, as[i].count))));
				const feed = root.Feeds && root.Feeds[feedName];
				if (feed) feed(time, meta, src);
				break;
			}
		} else {
			for (let i = 0; i < 4; i++) bubble4(i, time);
			src = fixed4; n = 4;
		}
		if (!src || s.idx >= n) { clearSel(); return; }
		const j = s.idx * 4;
		Cam.sel[0] = src[j]; Cam.sel[1] = src[j + 1]; Cam.sel[2] = src[j + 2]; Cam.sel[3] = src[j + 3];
		Cam.target[0] = src[j]; Cam.target[1] = src[j + 1]; Cam.target[2] = src[j + 2];
	}

	// called by runner.frame() every rendered frame
	function tick(dt, elapsed) {
		if (Cam.mode !== 2) {
			Cam.yaw += AUTO_SPEED * dt;
			Cam.pitch += (0.15 - Cam.pitch) * Math.min(1.0, dt * 0.5);
		}
		updateSelPos();
		basis();
	}

	// click pick: ray-cast the same spheres the shader draws. Select the
	// nearest bubble under the cursor, or deselect when the click misses.
	function pick(cssX, cssY) {
		const meta = runner && runner.current;
		if (!canvas || !meta) return;
		const p = pickable(meta, (runner.sceneTime !== undefined) ? runner.sceneTime : (runner.elapsed || 0));
		if (!p) { clearSel(); return; }

		basis();
		const r = canvas.getBoundingClientRect();
		const rx = (cssX - r.left) / r.width;
		const ry = (cssY - r.top) / r.height;
		const minDim = Math.min(r.width, r.height);
		const ux = (2.0 * rx - 1.0) * (r.width / minDim) * TAN30;
		// CSS pointer y grows downward; gl_FragCoord/camera UV y grows upward.
		const uy = (1.0 - 2.0 * ry) * (r.height / minDim) * TAN30;
		ray[0] = ux * rt[0] + uy * up[0] + fw[0];
		ray[1] = ux * rt[1] + uy * up[1] + fw[1];
		ray[2] = ux * rt[2] + uy * up[2] + fw[2];
		const rl = Math.sqrt(ray[0] * ray[0] + ray[1] * ray[1] + ray[2] * ray[2]) || 1.0;
		ray[0] /= rl; ray[1] /= rl; ray[2] /= rl;

		let best = 1e9, bi = -1;
		const arr = p.arr, n = p.n;
		for (let i = 0; i < n; i++) {
			const j = i * 4;
			const rr = arr[j + 3];
			if (rr <= 0.0) continue;
			const ox = pos[0] - arr[j], oy = pos[1] - arr[j + 1], oz = pos[2] - arr[j + 2];
			const B = 2.0 * (ox * ray[0] + oy * ray[1] + oz * ray[2]);
			const C = ox * ox + oy * oy + oz * oz - rr * rr;
			const D = B * B - 4.0 * C;
			if (D < 0.0) continue;
			const t = (-B - Math.sqrt(D)) * 0.5;
			if (t > 0.001 && t < best) { best = t; bi = i; }
		}

		if (bi >= 0) {
			const j = bi * 4;
			Cam.sel[0] = arr[j]; Cam.sel[1] = arr[j + 1]; Cam.sel[2] = arr[j + 2]; Cam.sel[3] = arr[j + 3];
			let kind = p.kind, idx = bi;
			if (p.kind === 'cage') {
				kind = bi < p.split ? p.insideKind : 'cageTop';
				idx = bi < p.split ? bi : bi - p.split;
			}
			Cam.selSrc = { kind, idx };
			Cam.target[0] = arr[j]; Cam.target[1] = arr[j + 1]; Cam.target[2] = arr[j + 2];
		} else {
			clearSel();
		}
	}

	// ---------------------------------------------------------------- input

	function ptrIndex(id) {
		for (let i = 0; i < pointers.length; i++) if (pointers[i].id === id) return i;
		return -1;
	}

	function onDown(e) {
		if (e.pointerType === 'mouse' && e.button !== 0) return; // LMB only
		if (canvas.setPointerCapture) {
			try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ok */ }
		}
		pointers.push({ id: e.pointerId, x: e.clientX, y: e.clientY });
		if (pointers.length === 1) {
			downX = e.clientX; downY = e.clientY;
			dragDist = 0; dragging = false;
		}
		if (pointers.length === 2) {
			const a = pointers[0], b = pointers[1];
			pinchDist = Math.hypot(a.x - b.x, a.y - b.y) || 0;
		}
	}

	function onMove(e) {
		// keep the legacy iMouse camera (XdXXzB, thick_glass, ...) alive on touch
		if (runner && runner.mouse && canvas) {
			const r = canvas.getBoundingClientRect();
			runner.mouse[0] = (e.clientX - r.left) * (canvas.width / r.width);
			runner.mouse[1] = (e.clientY - r.top) * (canvas.height / r.height);
		}
		const i = ptrIndex(e.pointerId);
		if (i < 0) return;
		const p = pointers[i];
		const dx = e.clientX - p.x, dy = e.clientY - p.y;
		p.x = e.clientX; p.y = e.clientY;

		if (pointers.length === 1) {
			dragDist += Math.hypot(dx, dy);
			if (!dragging && dragDist > CLICK_DRAG) dragging = true;
			if (dragging) {
				manual();
				Cam.yaw -= dx * 0.006;
				Cam.pitch = clamp(Cam.pitch - dy * 0.005, -PITCH_MAX, PITCH_MAX);
			}
		} else if (pointers.length === 2) {
			const a = pointers[0], b = pointers[1];
			const d = Math.hypot(a.x - b.x, a.y - b.y);
			if (pinchDist > 0 && d > 0) {
				manual();
				Cam.dist = clamp(Cam.dist * (pinchDist / d), MIN_DIST, MAX_DIST);
			}
			pinchDist = d;
		}
	}

	function onUp(e) {
		const i = ptrIndex(e.pointerId);
		if (i < 0) return;
		const wasDrag = dragging;
		pointers.splice(i, 1);
		pinchDist = 0;
		dragging = false;
		if (pointers.length === 0 && !wasDrag) pick(e.clientX, e.clientY);
	}

	function onWheel(e) {
		e.preventDefault();
		manual();
		Cam.dist = clamp(Cam.dist * Math.exp(e.deltaY * 0.0012), MIN_DIST, MAX_DIST);
	}

	function init(c, r) {
		canvas = c;
		runner = r;
		canvas.addEventListener('pointerdown', onDown);
		canvas.addEventListener('pointermove', onMove);
		canvas.addEventListener('pointerup', onUp);
		canvas.addEventListener('pointercancel', onUp);
		canvas.addEventListener('wheel', onWheel, { passive: false });
	}

	// called by ui on shader select: keep yaw/pitch/distance, drop selection
	function attach() {
		clearSel();
	}

	// ---------------------------------------------- per-frame uniform feeds

	function writeVec(out, a) {
		out[0] = a[0]; out[1] = a[1]; out[2] = a[2];
	}
	feeds.camPos = function (time, meta, out) { writeVec(out, pos); };
	feeds.camRt = function (time, meta, out) { writeVec(out, rt); };
	feeds.camUp = function (time, meta, out) { writeVec(out, up); };
	feeds.camFw = function (time, meta, out) { writeVec(out, fw); };
	feeds.camSel = function (time, meta, out) {
		out[0] = Cam.sel[0]; out[1] = Cam.sel[1]; out[2] = Cam.sel[2]; out[3] = Cam.sel[3];
	};

	const Feeds = root.Feeds = root.Feeds || {};
	for (const k in feeds) Feeds[k] = feeds[k];

	root.Cam = {
		init, attach, tick, pick,
		cycleMode: function () { setMode((Cam.mode + 1) % 3); },
		label: modeLabel,
		get mode() { return Cam.mode; },
		get dist() { return Cam.dist; },
		get yaw() { return Cam.yaw; },
		get pitch() { return Cam.pitch; },
		set onModeChange(f) { Cam.onModeChange = f; },
		state: function () {
			return { mode: Cam.mode, yaw: Cam.yaw, pitch: Cam.pitch, dist: Cam.dist,
				target: Cam.target.slice(), sel: Cam.sel.slice() };
		},
	};
})(typeof window !== 'undefined' ? window : globalThis);
