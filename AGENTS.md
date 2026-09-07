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
		these are not strict rules, use best.

	plan.md is NOT the implementation log. if need - update/improve plan, but keep final plan as artifact for possible fork or reimplementation without referring of what was and what done, without referring chat, etc.

	only essential concise comments in code that really helpful i.e. explain why and decision. prefer descriptive naming.

	no legacy support, no old versions, no outdated browsers, no leftovers and no over protecting from unreal edge cases. we need clean architecture.

## runtime

	file:// friendly, classic <script> tags, no modules, no build.
	guard module.exports so files also run under node.
	no internet links; vendor any lib as a local js file.
	WebGL2

## concepts

	three orthogonal selectors, all global, all in the toolbar:

		shader — HOW the objects are drawn (one shaders/*.js each).
		scene  — WHERE they are drawn (interior / land / background)
		         and HOW they move (drift, bounce inside the cage,
		         float above the glass land).
		shape  — WHAT every object is (sphere, cube, tetra, knot).

	a shader declares what it can render:
		scenes: ['checker','rainbow','colorbox','cage','terrain'] + nativeScene
		scenes: ['own']   -> brings its own background and motion
		shapes: ['sphere','cube','tetra','knot']                  + nativeShape
		(no shapes -> sphere only)
	the fallback rules live in js/caps.js; js/scenes.js and
	js/shapes.js are the registries. shapes are analytic formulas
	inscribed in the object's bounding ball (GLSL.shape), never meshes;
	the per-object spin is a feed (Feeds.spin), shared by the shader
	and the click picker.

	when a combination does not exist, the selector the user just
	clicked wins and the others fall back to their native partner.
	never silently ignore the click.

	a param may declare scenes: [...] / shapes: [...] to hide itself
	elsewhere. uScene and uShape are hidden: their rows own them.

	shared world geometry (cage wires, land block) lives in glsl_lib.js
	blocks that are no-ops outside their scene and are composed at their
	measured depth against the renderer's nearest object.

## files

findings-pitfalls-skills.md - notes and pitfalls for LLM agents. write here if found good way to do something.

archive/ - for implemented plans
