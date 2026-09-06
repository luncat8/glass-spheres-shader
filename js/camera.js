// camera.js — shared orbit camera for the 3D bubble shaders.
// Owns yaw / pitch / distance / target, the auto-orbit modes, and all pointing
// input: press-drag (mouse, pointer, touch), wheel zoom, pinch zoom, and
// click-to-select / click-outside-to-deselect an object (ray pick against the
// same object and spin data the shaders draw, through Shapes.hit). The runner
// uploads the camera basis every frame through the feeds registered below
// (camPos / camRt / camUp / camFw / camSel / camSelRot); shaders declare
// matching `vars` in their metadata.
//
// Only shaders that declare `uCamPos` in `vars` consume that basis, and only
// they are orbited, zoomed, picked and auto-spun (see sharedCam()). Shaders
// that drive their own GLSL camera from iMouse — the Shadertoy ports and the
// own-scene variants — just get their iMouse forwarded and are left alone.
//
// Drag is viewport-relative and follows the cursor ("grab the scene"): both
// axes are normalised by min(clientWidth, clientHeight), so the same physical
// drag turns the camera the same amount at any window size, aspect ratio and
// devicePixelRatio, and a diagonal drag rotates as much as either axis alone.
//
// auto mode (Cam.mode):
//   0 = "auto" — orbit until the user moves the camera manually, then off
//   1 = "on"   — always orbit, manual drag just steers it
//   2 = "off"  — never orbit
(function (root) {
	if (typeof module === 'object' && module.exports) { module.exports = {}; return; }

	const MIN_DIST = 2.2, MAX_DIST = 40.0, PITCH_MAX = 1.45;
	const AUTO_SPEED = 0.15, AUTO_PITCH = 0.15;
	const TAN30 = Math.tan(Math.PI / 6.0); // FOV 60, matches `FOV` in glsl_lib

	// one min-dimension of drag = 180° of turn (header explains the min choice)
	const ORBIT_TURN = Math.PI;
	// click-vs-drag threshold: a fixed pixel count is hair-trigger on 4K and
	// too coarse on a phone, so it scales with the same reference dimension.
	const CLICK_MIN = 6.0, CLICK_FRAC = 0.01;

	const Cam = {
		mode: 0, // see header; 0 = auto-until-first-manual-move (the default)
		yaw: 0.0,
		pitch: AUTO_PITCH,
		autoPitch: AUTO_PITCH, // where auto mode settles; each shared scene sets its own
		dist: 7.5,
		target: [0, 0, 0],
		sel: [0, 0, 0, 0],   // selected object centre + bounding radius (w = 0 => none)
		selRot: [0, 0, 0, 0], // its spin (unit axis, angle); zero axis = a plain sphere
		selSrc: null,       // { kind: <array feed name>, idx } or null
		onModeChange: null, // ui hook to refresh the camera button label
	};

	// preallocated scratch (AGENTS.md: no allocations in per-frame hot paths)
	const fw = [0, 0, 0], rt = [0, 0, 0], up = [0, 0, 0], pos = [0, 0, 0];
	const ray = [0, 0, 0];
	const cagePick = new Float32Array((61 + 3) * 4); // merged only on click
	const noSpin = new Float32Array(4);  // the top balls and spin-less shaders
	const feeds = {};                    // filled below, registered once

	let canvas = null, runner = null;
	let pointers = [];      // active pointer { id, x, y }
	let pinchDist = 0;
	let dragDist = 0, dragging = false;

	// The orbit camera only drives shaders that consume its feeds, and those
	// declare `uCamPos` in `vars` — the same contract the runner uses to upload
	// the basis, so it cannot drift from what the GLSL actually reads. Legacy
	// Shadertoy ports and own-scene shaders orbit inside GLSL from `iMouse`, so
	// for them this module is an input forwarder: no orbit, no zoom, no pick,
	// no auto-spin. Memoised on the meta identity (pointer compare per event).
	let sharedMeta, sharedFlag = false;

	function declaresCamPos(meta) {
		const vs = (meta && meta.vars) || [];
		for (let i = 0; i < vs.length; i++) if (vs[i].name === 'uCamPos') return true;
		return false;
	}

	function sharedCam() {
		const meta = runner ? runner.current : undefined;
		if (meta !== sharedMeta) { sharedMeta = meta; sharedFlag = declaresCamPos(meta); }
		return sharedFlag;
	}

	// reference dimension for every viewport-relative quantity: 0 when the
	// canvas is hidden or not laid out yet, which makes the guards fall out
	function viewDim() {
		if (!canvas) return 0;
		const w = canvas.clientWidth, h = canvas.clientHeight;
		return (w > 0 && h > 0) ? (w < h ? w : h) : 0;
	}

	function clickDrag(dim) { return dim * CLICK_FRAC > CLICK_MIN ? dim * CLICK_FRAC : CLICK_MIN; }

	function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

	function modeLabel() {
		if (!sharedCam()) return 'cam: n/a';
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
		Cam.selRot[0] = 0; Cam.selRot[1] = 0; Cam.selRot[2] = 0; Cam.selRot[3] = 0;
		Cam.selSrc = null;
		Cam.target[0] = 0; Cam.target[1] = 0; Cam.target[2] = 0;
	}

	// selection = the object at buf[j..j+3] with the spin at spin[k..k+3]
	function setSel(buf, j, spin, k) {
		Cam.sel[0] = buf[j]; Cam.sel[1] = buf[j + 1]; Cam.sel[2] = buf[j + 2]; Cam.sel[3] = buf[j + 3];
		Cam.selRot[0] = spin[k]; Cam.selRot[1] = spin[k + 1]; Cam.selRot[2] = spin[k + 2]; Cam.selRot[3] = spin[k + 3];
		Cam.target[0] = buf[j]; Cam.target[1] = buf[j + 1]; Cam.target[2] = buf[j + 2];
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

	// Feeds that carry the "main" sphere set of a shader, mapped to the param
	// that says how many of them are active ('' = the whole array). Adding a
	// new sphere feed only means adding a line here.
	const MAIN_FEEDS = {
		bubbles: 'uCount',
		bubbles61: 'uCount',
		cageInside: 'uCount',
		sceneBubbles4: '',
	};

	function activeCount(meta, arr) {
		const countName = MAIN_FEEDS[arr.feed];
		if (!countName) return arr.count;
		return Math.min(arr.count, Math.max(0, Math.round(paramVal(meta, countName, arr.count))));
	}

	function findArray(meta, feed) {
		const as = (meta && meta.arrays) || [];
		for (let i = 0; i < as.length; i++) if (as[i].feed === feed) return as[i];
		return null;
	}

	function findMainArray(meta) {
		const as = (meta && meta.arrays) || [];
		for (let i = 0; i < as.length; i++) if (MAIN_FEEDS[as[i].feed] !== undefined) return as[i];
		return null;
	}

	// the shader's spin buffer, refreshed for `time`; noSpin when it has none
	function spinBuf(meta, time) {
		const arr = findArray(meta, 'spin');
		if (!arr) return noSpin;
		root.Feeds.spin(time, meta, arr.buf);
		return arr.buf;
	}

	// Locate the pickable object set for the current shader. In the cage scene
	// the top balls are a second uniform, so both active prefixes are copied
	// into one preallocated buffer for the click ray cast. This runs on clicks,
	// never in the frame loop.
	function pickable(meta, time) {
		if (!meta) return null;
		const main = findMainArray(meta);
		const cageTop = findArray(meta, 'cageTop');
		const cageScene = paramVal(meta, 'uScene', -1) === 3;

		if (main) {
			const mainFeed = root.Feeds && root.Feeds[main.feed];
			if (!mainFeed) return null;
			mainFeed(time, meta, main.buf);
			const ni = activeCount(meta, main);
			const spin = spinBuf(meta, time);
			if (!cageScene || !cageTop) return { arr: main.buf, n: ni, kind: main.feed, spin, split: ni };

			const topFeed = root.Feeds && root.Feeds[cageTop.feed];
			if (!topFeed) return { arr: main.buf, n: ni, kind: main.feed, spin, split: ni };
			topFeed(time, meta, cageTop.buf);
			const nt = Math.min(cageTop.count, Math.max(0, Math.round(paramVal(meta, 'uTopCount', cageTop.count))));
			for (let i = 0; i < ni * 4; i++) cagePick[i] = main.buf[i];
			for (let i = 0; i < nt * 4; i++) cagePick[ni * 4 + i] = cageTop.buf[i];
			return { arr: cagePick, n: ni + nt, kind: 'cage', split: ni, insideKind: main.feed, spin };
		}
		return null;
	}

	// keep the selection and the orbit target glued to the (moving, tumbling) object
	function updateSelPos() {
		const s = Cam.selSrc;
		const meta = runner && runner.current;
		if (!s || !meta) return;
		const cageScene = paramVal(meta, 'uScene', -1) === 3;
		// the top balls only exist in the cage scene
		if (s.kind === 'cageTop' && !cageScene) { clearSel(); return; }
		const time = (runner && runner.sceneTime !== undefined) ? runner.sceneTime : (runner.elapsed || 0);
		const arr = findArray(meta, s.kind);
		if (!arr) { clearSel(); return; }
		const src = arr.buf;
		const n = s.kind === 'cageTop'
			? Math.min(arr.count, Math.max(0, Math.round(paramVal(meta, 'uTopCount', arr.count))))
			: activeCount(meta, arr);
		const feed = root.Feeds && root.Feeds[s.kind];
		if (feed) feed(time, meta, src);
		if (s.idx >= n) { clearSel(); return; }
		const spin = s.kind === 'cageTop' ? noSpin : spinBuf(meta, time);
		setSel(src, s.idx * 4, spin, spin === noSpin ? 0 : s.idx * 4);
	}

	// called by runner.frame() every rendered frame
	function tick(dt) {
		if (!sharedCam()) return;
		if (Cam.mode !== 2) {
			Cam.yaw += AUTO_SPEED * dt;
			Cam.pitch += (Cam.autoPitch - Cam.pitch) * Math.min(1.0, dt * 0.5);
		}
		updateSelPos();
		basis();
	}

	// click pick: ray-cast the same objects the shader draws (Shapes.hit, with
	// the shader's uShape; the cage's top balls are always spheres). Select the
	// nearest object under the cursor, or deselect when the click misses.
	// x/y are canvas-relative CSS pixels (PointerEvent offsetX/offsetY).
	function pick(x, y) {
		const meta = runner && runner.current;
		if (!canvas || !meta || !sharedCam()) return;
		const p = pickable(meta, (runner.sceneTime !== undefined) ? runner.sceneTime : (runner.elapsed || 0));
		if (!p) { clearSel(); return; }

		const w = canvas.clientWidth, h = canvas.clientHeight;
		if (!(w > 0 && h > 0)) return;
		basis();
		const minDim = w < h ? w : h;
		const ux = (2.0 * (x / w) - 1.0) * (w / minDim) * TAN30;
		// CSS pointer y grows downward; gl_FragCoord/camera UV y grows upward.
		const uy = (1.0 - 2.0 * (y / h)) * (h / minDim) * TAN30;
		ray[0] = ux * rt[0] + uy * up[0] + fw[0];
		ray[1] = ux * rt[1] + uy * up[1] + fw[1];
		ray[2] = ux * rt[2] + uy * up[2] + fw[2];
		const rl = Math.sqrt(ray[0] * ray[0] + ray[1] * ray[1] + ray[2] * ray[2]) || 1.0;
		ray[0] /= rl; ray[1] /= rl; ray[2] /= rl;

		const shape = paramVal(meta, 'uShape', 0);
		const spinLen = p.spin.length >> 2;
		let best = 1e9, bi = -1;
		const arr = p.arr, n = p.n;
		for (let i = 0; i < n; i++) {
			const j = i * 4;
			if (arr[j + 3] <= 0.0) continue;
			const spun = i < p.split && i < spinLen;
			const t = root.Shapes.hit(spun ? shape : 0, pos, ray, arr, j, spun ? p.spin : noSpin, spun ? j : 0);
			if (t > 0.001 && t < best) { best = t; bi = i; }
		}

		if (bi < 0) { clearSel(); return; }
		const spun = bi < p.split && bi < spinLen;
		setSel(arr, bi * 4, spun ? p.spin : noSpin, spun ? bi * 4 : 0);
		let kind = p.kind, idx = bi;
		if (p.kind === 'cage') {
			kind = bi < p.split ? p.insideKind : 'cageTop';
			idx = bi < p.split ? bi : bi - p.split;
		}
		Cam.selSrc = { kind, idx };
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
		if (pointers.length === 1) { dragDist = 0; dragging = false; }
		if (pointers.length === 2) {
			const a = pointers[0], b = pointers[1];
			pinchDist = Math.hypot(a.x - b.x, a.y - b.y) || 0;
		}
	}

	// the legacy GLSL cameras (XdXXzB, thick_glass, ...) orbit from iMouse, so
	// this stays unconditional and keeps working on touch
	function forwardIMouse(e) {
		if (!runner || !runner.mouse || !canvas) return;
		const w = canvas.clientWidth, h = canvas.clientHeight;
		if (!(w > 0 && h > 0)) return;
		runner.mouse[0] = e.offsetX * (canvas.width / w);
		runner.mouse[1] = e.offsetY * (canvas.height / h);
	}

	function onMove(e) {
		forwardIMouse(e);
		const i = ptrIndex(e.pointerId);
		if (i < 0) return;
		const p = pointers[i];
		const dx = e.clientX - p.x, dy = e.clientY - p.y;
		p.x = e.clientX; p.y = e.clientY;
		if (!sharedCam()) return;

		if (pointers.length === 2) {
			const a = pointers[0], b = pointers[1];
			const d = Math.hypot(a.x - b.x, a.y - b.y);
			if (pinchDist > 0 && d > 0) {
				manual();
				Cam.dist = clamp(Cam.dist * (pinchDist / d), MIN_DIST, MAX_DIST);
			}
			pinchDist = d;
			return;
		}
		if (pointers.length !== 1) return;

		dragDist += Math.hypot(dx, dy);
		const dim = viewDim();
		if (dim <= 0) return;
		if (!dragging && dragDist > clickDrag(dim)) dragging = true;
		if (!dragging) return;
		manual();
		// grab: drag right orbits the eye towards -x, so the scene follows the
		// cursor; drag down raises the eye, so the scene travels down
		Cam.yaw += (dx / dim) * ORBIT_TURN;
		Cam.pitch = clamp(Cam.pitch - (dy / dim) * ORBIT_TURN, -PITCH_MAX, PITCH_MAX);
	}

	function onUp(e) {
		const i = ptrIndex(e.pointerId);
		if (i < 0) return;
		const wasDrag = dragging;
		pointers.splice(i, 1);
		pinchDist = 0;
		dragging = false;
		if (pointers.length === 0 && !wasDrag) pick(e.offsetX, e.offsetY);
	}

	function onWheel(e) {
		e.preventDefault(); // never let the wheel scroll the page behind the stage
		if (!sharedCam()) return;
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

	// called by ui on scene select: each shared scene presents itself from its
	// own default distance and pitch (the land block is far bigger than the
	// cloud and is looked at from above, pitch < 0), and auto mode settles on
	// that pitch; a shader switch never touches the view
	function frame(scene) {
		if (!scene || !(scene.camDist > 0)) return;
		Cam.dist = clamp(scene.camDist, MIN_DIST, MAX_DIST);
		Cam.pitch = clamp(scene.camPitch, -PITCH_MAX, PITCH_MAX);
		Cam.autoPitch = Cam.pitch;
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
	feeds.camSelRot = function (time, meta, out) {
		out[0] = Cam.selRot[0]; out[1] = Cam.selRot[1]; out[2] = Cam.selRot[2]; out[3] = Cam.selRot[3];
	};

	const Feeds = root.Feeds = root.Feeds || {};
	for (const k in feeds) Feeds[k] = feeds[k];

	root.Cam = {
		init, attach, frame, tick, pick,
		shared: sharedCam, // does the selected shader consume the shared basis?
		cycleMode: function () { setMode((Cam.mode + 1) % 3); },
		label: modeLabel,
		get mode() { return Cam.mode; },
		get dist() { return Cam.dist; },
		get yaw() { return Cam.yaw; },
		get pitch() { return Cam.pitch; },
		set onModeChange(f) { Cam.onModeChange = f; },
		state: function () {
			return { mode: Cam.mode, yaw: Cam.yaw, pitch: Cam.pitch, dist: Cam.dist,
				target: Cam.target.slice(), sel: Cam.sel.slice(), selRot: Cam.selRot.slice() };
		},
	};
})(typeof window !== 'undefined' ? window : globalThis);
