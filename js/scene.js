// scene.js — per-frame data feeds for shader array uniforms.
// A feed fills a preallocated Float32Array in place; it must not allocate.
// Registered under window.Feeds and referenced by name from a shader's
// `arrays: [{ name, type, count, feed }]` metadata.
//
// Feeds write as many bubbles as fit into the output buffer (out.length / 4),
// so a shader declaring 16/32/64 bubbles gets exactly the leading slice of the
// same deterministic cloud — the benchmark uses this to give every entry the
// identical scene.
(function (root) {
	if (typeof module === 'object' && module.exports) { module.exports = {}; return; }

	const Feeds = {};

	const GA = 2.399963229728653; // golden angle

	// deterministic per-index constants, computed once (golden-angle placement so
	// no two bubbles share an orbit or a phase). Clouds of >=64 bubbles get a
	// wider orbital spread and a thicker vertical band so the scene doesn't read
	// as one crowded shell — scales as pow(n/32, 0.45).
	function makeCloud(n) {
		const orbR = new Float32Array(n);
		const orbS = new Float32Array(n);
		const phA = new Float32Array(n);
		const phB = new Float32Array(n);
		const phC = new Float32Array(n);
		const rad = new Float32Array(n);
		const yOff = new Float32Array(n);
		const spread = n >= 64 ? Math.pow(n / 32, 0.45) : 1.0;
		const vspread = n >= 64 ? Math.pow(n / 32, 0.35) : 1.0;
		const sizeJitter = n >= 64 ? 1.0 / Math.sqrt(n / 64) : 1.0;
		for (let i = 0; i < n; i++) {
			const f = (i + 0.5) / n;
			orbR[i] = (0.7 + 2.9 * Math.sqrt(f)) * spread;
			orbS[i] = (0.11 + 0.29 * (1 - f) + 0.05 * ((i * 7) % 5) / 5) * (n >= 64 ? 1.0 / spread : 1.0);
			phA[i] = GA * i;
			phB[i] = GA * i * 1.7 + 1.3;
			phC[i] = GA * i * 0.6 + 2.7;
			rad[i] = (0.30 + 0.60 * (0.3 + 0.7 * Math.abs(Math.sin(GA * i * 2.1)))) * sizeJitter;
			yOff[i] = Math.sin(GA * i * 1.3) * 1.7 * vspread;
		}
		return { orbR, orbS, phA, phB, phC, rad, yOff };
	}
	const C32 = makeCloud(32);
	const C64 = makeCloud(64);
	const C128 = makeCloud(128);

	// current value of a declared param, falling back to its default
	function paramVal(meta, name, fallback) {
		const ps = (meta && meta.params) || [];
		for (let i = 0; i < ps.length; i++) {
			if (ps[i].name !== name) continue;
			const v = ps[i].value !== undefined ? ps[i].value : ps[i].def;
			return (typeof v === 'number' && isFinite(v)) ? v : fallback;
		}
		return fallback;
	}

	// vec4 per bubble: xyz = centre, w = outer radius. Scaled by uSpread / uSize
	// when the shader declares those params.
	function feedCloud(c, time, meta, out) {
		const n = Math.min(c.orbR.length, out.length >> 2);
		const spread = paramVal(meta, 'uSpread', 1.0);
		const size = paramVal(meta, 'uSize', 1.0);
		for (let i = 0; i < n; i++) {
			const a = time * c.orbS[i] + c.phA[i];
			const b = time * c.orbS[i] * 0.63 + c.phB[i];
			const cn = time * c.orbS[i] * 0.41 + c.phC[i];
			const j = i * 4;
			out[j]     = spread * (Math.cos(a) * c.orbR[i] + 0.35 * Math.sin(cn * 1.7));
			out[j + 1] = spread * (c.yOff[i] + 0.55 * Math.sin(b));
			out[j + 2] = spread * (Math.sin(a) * c.orbR[i] * 0.9 + 0.35 * Math.cos(cn));
			out[j + 3] = c.rad[i] * size * (0.85 + 0.15 * Math.sin(cn * 0.9));
		}
	}

	Feeds.bubbles = function (time, meta, out) { feedCloud(C32, time, meta, out); };
	Feeds.bubbles64 = function (time, meta, out) { feedCloud(C64, time, meta, out); };
	Feeds.bubbles128 = function (time, meta, out) { feedCloud(C128, time, meta, out); };

	root.Feeds = Feeds;
})(typeof window !== 'undefined' ? window : globalThis);
