// scenes.js — the scene registry, and the compatibility rules between the two
// independent selectors in the toolbar.
//
// The project has two orthogonal choices:
//
//   * shader — HOW the bubbles are drawn (membrane tracing, analytic layers,
//     raymarched SDF, chain refraction, ...). One entry per shaders/*.js.
//   * scene  — WHERE they are drawn (interior / land / background) and HOW they
//     move (free drift, or bouncing inside the cage). One entry in the list
//     below.
//
// They are kept independent wherever that is cheap: a scene-aware shader
// declares `scenes: [...]` in its metadata and simply reads `uScene`. Shaders
// whose pipeline cannot express the shared scenes (the original Shadertoy ports
// and the cubemap-only variants) declare `scenes: ['own']` and keep their
// built-in look.
//
// When the user picks a combination that does not exist, we do NOT silently
// ignore the click. The selector the user just touched always wins and the
// other one falls back to its native partner:
//
//   picked a shader that cannot do the current scene -> scene  := nativeScene(shader)
//   picked a scene  that the current shader cannot do -> shader := nativeShader(scene)
//
// so a click always changes something visible, and the UI reports the fallback.
(function (root) {
	if (typeof module === 'object' && module.exports) { module.exports = {}; return; }

	// `uScene` is the int uniform every scene-aware shader declares; `own` has
	// no uniform because those shaders never look at it.
	// `native` is the shader picked when the user selects this scene while an
	// incompatible shader is active.
	const LIST = [
		{
			id: 'own', label: 'shader\'s own', uScene: -1, native: null,
			hint: 'the shader draws its own built-in background and motion; only the original Shadertoy ports and the cubemap variants use this',
		},
		{
			id: 'checker', label: 'checker land', uScene: 0, native: 'hollow_bubbles',
			hint: 'sky gradient over an infinite checkered ground plane; bubbles drift on tilted Lissajous orbits',
		},
		{
			id: 'rainbow', label: 'rainbow', uScene: 1, native: 'hollow_bubbles',
			hint: 'hue-around-the-horizon rainbow interior with soft cellular blobs; bubbles drift on tilted Lissajous orbits',
		},
		{
			id: 'colorbox', label: 'color box', uScene: 2, native: 'hollow_bubbles',
			hint: 'fbm-hued colour all around the camera; bubbles drift on tilted Lissajous orbits',
		},
		{
			id: 'cage', label: 'cage', uScene: 3, native: 'analytic_layers',
			hint: 'pastel cloud sky plus a black wire cube: spheres bounce elastically off the six inner walls and three balls bounce on the top face',
		},
	];

	const BY_ID = {};
	for (let i = 0; i < LIST.length; i++) BY_ID[LIST[i].id] = LIST[i];

	function get(id) { return BY_ID[id] || BY_ID.own; }

	// scenes a shader can render. Undefined metadata means "own scene only",
	// which is the safe default for a freshly imported Shadertoy port.
	function supported(meta) {
		const s = meta && meta.scenes;
		return (s && s.length) ? s : ['own'];
	}

	function supports(meta, sceneId) {
		return supported(meta).indexOf(sceneId) >= 0;
	}

	// the scene a shader falls back to when the current one is incompatible
	function nativeScene(meta) {
		const s = supported(meta);
		const want = meta && meta.nativeScene;
		return (want && s.indexOf(want) >= 0) ? want : s[0];
	}

	// the shader a scene falls back to when the current one is incompatible.
	// Prefers the scene's declared native shader, otherwise the first shader in
	// the registry that can render it.
	//
	// `own` deliberately has none: it is not a scene you choose, it is what you
	// get when the chosen shader brings its own background and motion. Picking
	// an arbitrary Shadertoy port because the user clicked it would be a
	// surprise, so the UI disables that button instead.
	function nativeShader(sceneId, list) {
		if (sceneId === 'own') return null;
		const want = get(sceneId).native;
		let first = null;
		for (let i = 0; i < list.length; i++) {
			if (!supports(list[i], sceneId)) continue;
			if (list[i].id === want) return list[i].id;
			if (!first) first = list[i].id;
		}
		return first;
	}

	// write the scene's uniform value into the shader's hidden `uScene` param.
	// No-op for shaders that do not declare one.
	function apply(meta, sceneId) {
		const ps = (meta && meta.params) || [];
		const v = get(sceneId).uScene;
		if (v < 0) return;
		for (let i = 0; i < ps.length; i++) {
			if (ps[i].name === 'uScene') { ps[i].value = v; return; }
		}
	}

	// Should this param be shown for the active scene? A param may declare
	// `scenes: [...]` to restrict itself (the cage sliders only make sense in
	// the cage scene). `uScene` itself is driven by the toolbar, never shown.
	function paramVisible(p, sceneId) {
		if (!p || p.name === 'uScene' || p.hidden) return false;
		if (!p.scenes || !p.scenes.length) return true;
		return p.scenes.indexOf(sceneId) >= 0;
	}

	root.Scenes = { list: LIST, get, supported, supports, nativeScene, nativeShader, apply, paramVisible };
})(typeof window !== 'undefined' ? window : globalThis);
