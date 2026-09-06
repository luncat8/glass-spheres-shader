# AGENTS.md

guidance for LLM agents

## style

	use a single tab indentation. LF end

	avoid deep nesting of braces { } and long if-else.
	flatten with early returns, helper functions, or flat data tables.

	avoid duplication of code.

	avoid allocations in the hot path (per-frame loop, sim, render).
		no new {}, [], object literals, closures, or string concat
		inside the frame loop.
		reuse preallocated buffers / typed arrays / scratch objects.
		allocate once at setup, mutate in place per frame.

## runtime

	file:// friendly, classic <script> tags, no modules, no build.
	guard module.exports so files also run under node.
	no internet links; vendor any lib as a local js file.
	WebGL2 only, zero dependencies.

## concepts

	two orthogonal selectors, both global, both in the toolbar:

		shader — HOW the bubbles are drawn (one shaders/*.js each).
		scene  — WHERE they are drawn (interior / land / background)
		         and HOW they move (drift, or bounce inside the cage).

	a shader declares what it can render:
		scenes: ['checker','rainbow','colorbox','cage']   + nativeScene
		scenes: ['own']   -> brings its own background and motion
	the registry and the fallback rules live in js/scenes.js.

	when a combination does not exist, the selector the user just
	clicked wins and the other one falls back to its native partner.
	never silently ignore the click.

	a param may declare scenes: [...] to hide itself in other scenes.
	uScene is hidden: the scene row owns it.


