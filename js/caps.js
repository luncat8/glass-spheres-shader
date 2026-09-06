// caps.js — one capability registry for the toolbar's orthogonal axes (scene,
// shape). An axis is a list of entries a shader may or may not support, plus
// the fallback rules between that axis and the shader selector:
//
//   picked a shader that cannot do the current entry -> entry  := nativeOf(shader)
//   picked an entry the current shader cannot do     -> shader := nativeShader(entry)
//
// so the selector the user just touched always wins, and the UI reports what
// the other one fell back to. js/scenes.js and js/shapes.js are thin bindings.
(function (root) {
	if (typeof module === 'object' && module.exports) { module.exports = {}; return; }

	// entry: { id, label, value, native, hint, ... }
	//   value  — the int written into the shader's hidden param (< 0 writes nothing)
	//   native — shader chosen when the user selects this entry while an
	//            incompatible shader is active; null = never chosen by fallback
	//            (the UI disables the button instead)
	// axis: { list, metaKey, paramName, nativeKey, fallback }
	//   metaKey   — the shader metadata list (`scenes`, `shapes`); also the key a
	//               param uses to restrict itself to some entries
	//   fallback  — what a shader without metadata supports
	function axis(def) {
		const byId = {};
		for (let i = 0; i < def.list.length; i++) byId[def.list[i].id] = def.list[i];
		const first = def.list[0];

		function get(id) { return byId[id] || first; }

		function supported(meta) {
			const s = meta && meta[def.metaKey];
			return (s && s.length) ? s : def.fallback;
		}

		function supports(meta, id) { return supported(meta).indexOf(id) >= 0; }

		// the entry a shader falls back to when the current one is incompatible
		function nativeOf(meta) {
			const s = supported(meta);
			const want = meta && meta[def.nativeKey];
			return (want && s.indexOf(want) >= 0) ? want : s[0];
		}

		// the shader an entry falls back to: its declared native shader when
		// that one supports it, otherwise the first shader in the list that does
		function nativeShader(id, shaders) {
			const want = get(id).native;
			if (!want) return null;
			let firstOk = null;
			for (let i = 0; i < shaders.length; i++) {
				if (!supports(shaders[i], id)) continue;
				if (shaders[i].id === want) return want;
				if (!firstOk) firstOk = shaders[i].id;
			}
			return firstOk;
		}

		// write the entry's value into the shader's hidden param, if declared
		function apply(meta, id) {
			const ps = (meta && meta.params) || [];
			const v = get(id).value;
			if (v < 0) return;
			for (let i = 0; i < ps.length; i++) {
				if (ps[i].name === def.paramName) { ps[i].value = v; return; }
			}
		}

		// should this param be shown for the active entry? The axis' own param
		// is driven by the toolbar and never shown.
		function paramVisible(p, id) {
			if (!p || p.name === def.paramName || p.hidden) return false;
			const only = p[def.metaKey];
			if (!only || !only.length) return true;
			return only.indexOf(id) >= 0;
		}

		return { list: def.list, paramName: def.paramName, get, supported, supports, nativeOf, nativeShader, apply, paramVisible };
	}

	root.Caps = { axis };
})(typeof window !== 'undefined' ? window : globalThis);
