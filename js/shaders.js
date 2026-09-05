// shaders.js — registry of Shadertoy shaders available to the runner.
// Each shaders/*.js script assigns window.SHADER_<id> = { id, title, ... }.
// The order of buttons is determined by the order of <script> tags in index.html.
// Exposes window.SHADERS = list of those entries.
(function () {
	if (typeof module === 'object' && module.exports) {
		// node: stub (this module is browser-only)
		module.exports = { SHADERS: [] };
		return;
	}
	const list = [];
	for (const k in window) {
		if (k.indexOf('SHADER_') === 0) {
			const s = window[k];
			if (s && s.id) list.push(s);
		}
	}
	window.SHADERS = list;
})();
