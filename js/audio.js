// audio.js — procedural music player for shaders that declare `music: true`.
// Off by default (the UI checkbox enables it). The piece is a faithful JS port
// of the mainSound() composer in example-shadertoy/llsSDf_mus.txt (the music
// attached to the llsSDf cellular-metaballs shader), so it needs no GPU,
// no fetch and no modules: a ScriptProcessor node renders the samples into a
// preallocated pair of buffers at the AudioContext rate.
(function (root) {
	if (typeof module === 'object' && module.exports) { module.exports = {}; return; }

	const PI = Math.PI;
	const AudioCtx = root.AudioContext || root.webkitAudioContext;
	const BUFFER = 2048;

	const AudioM = {
		enabled: false,
		active: false,
		time: 0,          // seconds of the piece, reset when a shader is picked
	};

	let ctx = null, node = null;
	let scratchL = null, scratchR = null;
	let rate = 44100;

	// --------------------------------------------------- note-table helpers
	// Pitch names used by the composer (d# variants are unused by the piece).
	const DO = 261.63, RE = 293.66, MI = 329.63, FA = 349.2, SOL = 392.00,
		LYA = 440.00, SI = 493.88;

	function fract(x) { return x - Math.floor(x); }
	function fmod(x, m) { return x - m * Math.floor(x / m); }

	// base piano (Instr1), light piano (Instr3) — same partials, Instr3 sings
	// a touch longer; note the 4th partial is unused in the original too
	function instr1(de, t) {
		const f0 = 440.0 * de * 0.001953125;
		const piT = PI * 2.0 * f0 * t;
		const a = Math.sin(piT);
		const b = Math.sin(2.0 * piT) * 0.08;
		const c = Math.sin(4.0 * piT) * 0.04;
		const e = Math.sin(16.0 * piT) * 0.001;
		const f = Math.sin(piT * 0.5) * 0.02;
		return (a + b + c + e + f) * 0.5 * Math.exp(-1.0 * t);
	}
	function instr3(de, t) {
		const f0 = 440.0 * de * 0.001953125;
		const piT = PI * 2.0 * f0 * t;
		const a = Math.sin(piT);
		const b = Math.sin(2.0 * piT) * 0.08;
		const c = Math.sin(4.0 * piT) * 0.04;
		const e = Math.sin(16.0 * piT) * 0.001;
		const f = Math.sin(piT * 0.5) * 0.02;
		return (a + b + c + e + f) * 0.5 * Math.exp(-0.6 * t) * Math.exp(-1.0 * t);
	}
	// bass (Instr2)
	function instr2(de, t) {
		const f0 = de * 110.0 * 0.015625;
		const a = Math.sin(2.0 * f0 * PI * t);
		const c = 0.2 * t + 0.25 * a;
		const b = Math.sin(a * c * 2.0 * PI);
		return b * 0.9 * Math.exp(-0.3 * t) * Math.exp(-0.3 * t) * Math.exp(-0.1 * t);
	}

	// note emitters, table-driven mirrors of the #define PI1/PI2/PI3 macros
	function n1(f, ms, a, de, len, v) {
		if (f < a || f >= a + len) return 0;
		return instr1(de, fract(ms) + (f - a)) * v;
	}
	function n2(f, ms, a, de, len, v) {
		if (f < a || f >= a + len) return 0;
		return instr2(de, fract(ms) + (f - a)) * v;
	}
	function n3(f, ms, a, de, len, v) {
		if (f < a || f >= a + len) return 0;
		return instr3(de, fract(ms) + (f - a)) * v;
	}

	// PathPiano1 (fd == 2 only; light piano + a soft bass line)
	function pathPiano1(ms) {
		const f = fmod(Math.floor(ms), 64);
		const fd = fmod(Math.floor(ms * 0.015625), 64);
		if (fd !== 2) return 0;
		const v = 0.7;
		let r = 0;
		r += n3(f, ms, 0, DO * 1.0, 20, v);
		r += n3(f, ms, 0, SOL * 0.5, 20, v);
		r += n3(f, ms, 0, MI * 0.5, 20, v);
		r += n3(f, ms, 3, MI * 1.0, 20, v);
		r += n3(f, ms, 6, SOL * 1.0, 20, v);
		r += n3(f, ms, 9, DO * 1.0, 20, v);
		r += n3(f, ms, 16, DO * 1.0, 20, v);
		r += n3(f, ms, 16, LYA * 0.5, 20, v);
		r += n3(f, ms, 16, MI * 0.5, 20, v);
		r += n3(f, ms, 19, SI * 1.0, 20, v);
		r += n3(f, ms, 22, LYA * 1.0, 20, v);
		r += n3(f, ms, 32, DO * 1.0, 20, v);
		r += n3(f, ms, 32, SOL * 0.5, 20, v);
		r += n3(f, ms, 32, MI * 0.5, 20, v);
		r += n3(f, ms, 36, DO * 2.0, 20, v);
		r += n3(f, ms, 46, SOL * 1.0, 20, v);
		r += n3(f, ms, 47, LYA * 1.0, 20, v);
		r += n3(f, ms, 48, MI * 1.0, 20, v);
		r += n3(f, ms, 48, SI * 0.5, 20, v);
		r += n3(f, ms, 48, SOL * 0.5, 20, v);
		r += n3(f, ms, 56, RE * 1.0, 20, v);
		r += n2(f, ms, 0, DO * 0.25, 20, 0.2);
		r += n2(f, ms, 16, LYA * 0.125, 20, 0.15);
		r += n2(f, ms, 32, MI * 0.25, 20, 0.2);
		r += n2(f, ms, 48, SI * 0.125, 20, 0.2);
		return r;
	}

	// PathPiano2 (fd == 0 or 1; a base piano phrase)
	function pathPiano2(ms) {
		const f = fmod(Math.floor(ms), 64);
		const fd = fmod(Math.floor(ms * 0.015625), 64);
		if (fd !== 0 && fd !== 1) return 0;
		let r = 0;
		r += n1(f, ms, 0, DO * 0.25, 7, 1);
		r += n1(f, ms, 1, SOL * 0.125, 7, 1);
		r += n1(f, ms, 2, MI * 0.125, 7, 1);
		r += n1(f, ms, 3, MI * 0.25, 7, 1);
		r += n1(f, ms, 4, DO * 0.25, 7, 1);
		r += n1(f, ms, 5, SOL * 0.125, 7, 1);
		r += n1(f, ms, 6, SOL * 0.25, 7, 1);
		r += n1(f, ms, 7, RE * 0.25, 7, 1);
		r += n1(f, ms, 8, SI * 0.125, 7, 1);
		r += n1(f, ms, 16, DO * 0.25, 7, 1);
		r += n1(f, ms, 17, LYA * 0.125, 7, 1);
		r += n1(f, ms, 18, MI * 0.125, 7, 1);
		r += n1(f, ms, 19, RE * 0.25, 7, 1);
		r += n1(f, ms, 20, SI * 0.125, 7, 1);
		r += n1(f, ms, 21, SOL * 0.125, 7, 1);
		r += n1(f, ms, 22, DO * 0.25, 7, 1);
		r += n1(f, ms, 23, LYA * 0.125, 7, 1);
		r += n1(f, ms, 24, MI * 0.25, 7, 1);
		r += n1(f, ms, 32, DO * 0.25, 7, 1);
		r += n1(f, ms, 33, SOL * 0.125, 7, 1);
		r += n1(f, ms, 34, MI * 0.125, 7, 1);
		r += n1(f, ms, 35, MI * 0.25, 7, 1);
		r += n1(f, ms, 36, SI * 0.125, 7, 1);
		r += n1(f, ms, 37, SOL * 0.125, 7, 1);
		r += n1(f, ms, 38, FA * 0.25, 7, 1);
		r += n1(f, ms, 39, DO * 0.25, 7, 1);
		r += n1(f, ms, 40, LYA * 0.125, 7, 1);
		r += n1(f, ms, 48, MI * 0.25, 7, 1);
		r += n1(f, ms, 49, SI * 0.125, 7, 1);
		r += n1(f, ms, 50, SOL * 0.125, 7, 1);
		r += n1(f, ms, 51, DO * 0.25, 7, 1);
		r += n1(f, ms, 52, LYA * 0.125, 7, 1);
		r += n1(f, ms, 53, MI * 0.125, 7, 1);
		r += n1(f, ms, 54, SI * 0.125, 7, 1);
		r += n1(f, ms, 55, SOL * 0.125, 7, 1);
		r += n1(f, ms, 56, LYA * 0.125, 7, 1);
		return r;
	}

	// mainSound(t) — full stereo composer, ported note-for-note
	function mainSound(t, out) {
		const ms = t * 4.0;
		const f = fmod(Math.floor(ms), 64);
		const fd = fmod(Math.floor(ms * 0.015625), 64);

		const p1 = pathPiano1(ms);
		const p1a = pathPiano1(ms - 1.5);
		const p1b = pathPiano1(ms - 3.0);
		const p1c = pathPiano1(ms - 4.5);
		const p2 = pathPiano2(ms);
		const p2a = pathPiano2(ms - 1.5);
		const p2b = pathPiano2(ms - 3.0);
		const p2c = pathPiano2(ms - 4.5);

		let bass = 0;
		if (fd === 1) {
			bass += n2(f, ms, 0, DO * 0.0625, 20, 1.2);
			bass += n2(f, ms, 8, SI * 0.03125, 20, 0.3);
			bass += n2(f, ms, 16, LYA * 0.03125, 20, 1.2);
			bass += n2(f, ms, 24, MI * 0.03125, 20, 0.8);
			bass += n2(f, ms, 32, MI * 0.0625, 20, 1.0);
			bass += n2(f, ms, 40, DO * 0.0625, 20, 0.3);
			bass += n2(f, ms, 48, SI * 0.03125, 20, 1.2);
			bass += n2(f, ms, 56, LYA * 0.03125, 20, 0.3);
		}

		const l = p1 + p1a * 0.01 + p1b * 0.15 + p1c * 0.01
			+ p2 + p2a * 0.01 + p2b * 0.05 + p2c * 0.01 + bass;
		const r = p1 + p1a * 0.2 + p1b * 0.01 + p1c * 0.01
			+ p2 + p2a * 0.1 + p2b * 0.01 + p2c * 0.01 + bass;

		// headroom + soft clip; the original clips hard at 1.0
		out[0] = Math.max(-1.0, Math.min(1.0, l * 0.3));
		out[1] = Math.max(-1.0, Math.min(1.0, r * 0.3));
	}

	// --------------------------------------------------------- WebAudio glue

	function onProc(e) {
		const L = e.outputBuffer.getChannelData(0);
		const R = e.outputBuffer.getChannelData(1);
		const n = L.length;
		const dt = 1.0 / rate;
		for (let i = 0; i < n; i++) {
			mainSound(AudioM.time, scratchL);
			L[i] = scratchL[0];
			R[i] = scratchL[1];
			AudioM.time += dt;
		}
	}

	function start() {
		if (!AudioM.enabled || AudioM.active) return;
		if (!ctx) {
			if (!AudioCtx) return;
			ctx = new AudioCtx();
			rate = ctx.sampleRate || 44100;
			scratchL = [0, 0]; // shared output scratch (2 floats)
		}
		if (!node) {
			node = ctx.createScriptProcessor(BUFFER, 0, 2);
			node.onaudioprocess = onProc;
			node.connect(ctx.destination);
		}
		if (ctx.state === 'suspended') ctx.resume();
		AudioM.time = 0;
		AudioM.active = true;
	}

	function stop() {
		AudioM.active = false;
		if (node) node.disconnect();
		node = null;
	}

	// set by ui.js from the music checkbox (off by default)
	function setEnabled(on) {
		AudioM.enabled = !!on;
		if (on) start();
		else stop();
	}

	function reset() { AudioM.time = 0; }

	// jump the piece to an arbitrary second (used to join a running shader
	// without restarting the melody)
	function seek(t) {
		if (typeof t === 'number' && isFinite(t)) AudioM.time = Math.max(0, t);
	}

	root.AudioM = { setEnabled, reset, seek, isActive: function () { return AudioM.active; } };
})(typeof window !== 'undefined' ? window : globalThis);
