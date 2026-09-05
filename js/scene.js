// scene.js — per-frame data feeds for shader array uniforms.
// A feed fills a preallocated Float32Array in place; it must not allocate.
// Registered under window.Feeds and referenced by name from a shader's
// `arrays: [{ name, type, count, feed }]` metadata.
(function (root) {
	if (typeof module === 'object' && module.exports) { module.exports = {}; return; }

	const Feeds = {};

	// deterministic per-index constants, computed once (golden-angle placement so
	// no two bubbles share an orbit or a phase)
	const N = 32;
	const orbR = new Float32Array(N);
	const orbS = new Float32Array(N);
	const phA = new Float32Array(N);
	const phB = new Float32Array(N);
	const phC = new Float32Array(N);
	const rad = new Float32Array(N);
	const yOff = new Float32Array(N);
	(function bake() {
		const GA = 2.399963229728653; // golden angle
		for (let i = 0; i < N; i++) {
			const f = (i + 0.5) / N;
			orbR[i] = 0.7 + 2.9 * Math.sqrt(f);
			orbS[i] = 0.11 + 0.29 * (1 - f) + 0.05 * ((i * 7) % 5) / 5;
			phA[i] = GA * i;
			phB[i] = GA * i * 1.7 + 1.3;
			phC[i] = GA * i * 0.6 + 2.7;
			rad[i] = 0.30 + 0.60 * (0.3 + 0.7 * Math.abs(Math.sin(GA * i * 2.1)));
			yOff[i] = Math.sin(GA * i * 1.3) * 1.7;
		}
	})();

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
	Feeds.bubbles = function (time, meta, out) {
		const spread = paramVal(meta, 'uSpread', 1.0);
		const size = paramVal(meta, 'uSize', 1.0);
		for (let i = 0; i < N; i++) {
			const a = time * orbS[i] + phA[i];
			const b = time * orbS[i] * 0.63 + phB[i];
			const c = time * orbS[i] * 0.41 + phC[i];
			const j = i * 4;
			out[j]     = spread * (Math.cos(a) * orbR[i] + 0.35 * Math.sin(c * 1.7));
			out[j + 1] = spread * (yOff[i] + 0.55 * Math.sin(b));
			out[j + 2] = spread * (Math.sin(a) * orbR[i] * 0.9 + 0.35 * Math.cos(c));
			out[j + 3] = rad[i] * size * (0.85 + 0.15 * Math.sin(c * 0.9));
		}
	};

	root.Feeds = Feeds;
})(typeof window !== 'undefined' ? window : globalThis);
