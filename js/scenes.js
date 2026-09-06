// scenes.js — the scene registry: WHERE the objects are drawn (interior, land,
// background) and HOW they move. One entry per shared scene; `own` is what a
// shader gets when it brings its own background and motion (the Shadertoy ports
// and the cubemap-only variants declare `scenes: ['own']`).
//
// A scene-aware shader declares `scenes: [...]` and reads the hidden `uScene`
// int. The fallback rules between the scene row and the shader row live in
// js/caps.js. Each shared scene also carries its camera framing (distance and
// pitch; pitch > 0 looks up from below the target, < 0 down from above),
// applied by Cam.frame() when the scene is picked.
(function (root) {
	if (typeof module === 'object' && module.exports) { module.exports = {}; return; }

	// `own` deliberately has no native shader: it is not a scene you choose, it
	// is what you get from the chosen shader, so its button is disabled while a
	// scene-aware shader is active instead of jumping to an arbitrary port.
	const LIST = [
		{
			id: 'own', label: 'shader\'s own', value: -1, native: null,
			hint: 'the shader draws its own built-in background and motion; only the original Shadertoy ports and the cubemap variants use this',
		},
		{
			id: 'checker', label: 'checker land', value: 0, native: 'hollow_bubbles', camDist: 7.5, camPitch: 0.15,
			hint: 'sky gradient over an infinite checkered ground plane; objects drift on tilted Lissajous orbits',
		},
		{
			id: 'rainbow', label: 'rainbow', value: 1, native: 'hollow_bubbles', camDist: 7.5, camPitch: 0.15,
			hint: 'hue-around-the-horizon rainbow interior with soft cellular blobs; objects drift on tilted Lissajous orbits',
		},
		{
			id: 'colorbox', label: 'color box', value: 2, native: 'hollow_bubbles', camDist: 7.5, camPitch: 0.15,
			hint: 'fbm-hued colour all around the camera; objects drift on tilted Lissajous orbits',
		},
		{
			id: 'cage', label: 'cage', value: 3, native: 'analytic_layers', camDist: 7.5, camPitch: 0.15,
			hint: 'pastel cloud sky plus a black wire cube: objects bounce elastically off the six inner walls and three balls bounce on the top face',
		},
		{
			id: 'terrain', label: 'glass land', value: 4, native: 'analytic_layers', camDist: 16.0, camPitch: -0.30,
			hint: 'pastel sky over a finite block of simplex terrain with a lake in its valleys, drawn as glass or as colourised land; objects drift above the ridge line',
		},
	];

	root.Scenes = root.Caps.axis({ list: LIST, metaKey: 'scenes', paramName: 'uScene', nativeKey: 'nativeScene', fallback: ['own'] });
})(typeof window !== 'undefined' ? window : globalThis);
