// shaders.js — registry of Shadertoy shaders available to the runner.
// Exposes window.SHADERS = list of { id, title, author, channels, source }.
(function () {
	if (typeof module === 'object' && module.exports) {
		// node: stub (this module is browser-only)
		module.exports = { SHADERS: [] };
		return;
	}
	const ids = ['XdXXzB', 'llsSDf', 'ld3SDl'];
	const list = [];
	for (let i = 0; i < ids.length; i++) {
		const s = window['SHADER_' + ids[i]];
		if (s) list.push(s);
	}
	window.SHADERS = list;
})();
