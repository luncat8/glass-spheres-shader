// prompts.js — builds the text for the "copy prompt" button.
// The prompt asks an LLM to implement a bubble shader similar to the currently
// selected one, gives a short tech description and links the exact shader file
// on GitHub, plus the project's hard conventions so the reply drops in as-is.
(function (root) {
	if (typeof module === 'object' && module.exports) { module.exports = {}; return; }

	const GIT_BASE = 'https://github.com/luncat8/glass-spheres-shader/blob/main/shaders/';

	// id → { tech, file } ; file defaults to 'shaders/' + id + '.js'
	const T = {
		multi_fresnel: {
			tech: 'Single-pass analytic ray-sphere intersections for N animated bubbles, composited with a Schlick-style fresnel step and an fbm-tinted environment reflection; every bubble is tested per pixel in a constant-bound loop.',
			file: 'multi_fresnel.js',
		},
		multi_thinfilm: {
			tech: 'Raymarched smooth-min union of animated spheres (soap-film merge), 6-wavelength thin-film interference and chromatic dispersion resampled to RGB; ~24 march steps with a 4-tap SDF normal.',
			file: 'multi_thinfilm.js',
		},
		cage: {
			tech: 'Analytic cage scene: up to 61 independently reflected sphere trajectories inside an AABB, three gravity-driven vertical bounces on its top face, depth-aware ray/segment wireframe edges, and a smooth procedural pastel-cloud environment.',
			file: 'cage.js',
		},
		hollow_bubbles: {
			tech: 'Analytic membrane tracing: each ray crosses thin glass shells (outer + inner sphere per bubble, up to 10 layers), refracting through the wall with Fresnel, Beer-Lambert tint and thin-film iridescence; JS feeds a uBubbles vec4[32] array uniform.',
			file: 'hollow_bubbles.js',
		},
		thick_glass: {
			tech: 'Single-pass analytic glass spheres: per bubble the ray-sphere roots give the wall chord, Beer-Lambert absorption tints the transmitted env colour by chord length, refraction into/out of the wall plus Fresnel-weighted reflection on top.',
			file: 'thick_glass.js',
		},
		thick_analytic: {
			tech: 'Solid-glass spheres shaded analytically and depth-sorted back-to-front with a 5-comparator sorting network, then composited over a shared procedural environment.',
			file: 'thick_analytic.js',
		},
		thick_chain: {
			tech: 'Raymarched smooth-min SDF of the bubbles with up to 3 refraction hops: the transmitted ray re-enters the scene carrying Fresnel loss and Beer-Lambert throughput between hops.',
			file: 'thick_chain.js',
		},
		thick_raymarch: {
			tech: 'Raymarched smooth-min SDF with an inside march (negated SDF) per hit, refraction out, Beer-Lambert tint over the interior chord and up to 2 reflection bounces.',
			file: 'thick_raymarch.js',
		},
		XdXXzB: {
			tech: 'Original Shadertoy: one refractive sphere with an analytic ray-sphere hit, fbm-hued surface lookup and fresnel-step reflection; orbit camera driven by iMouse.',
			file: 'XdXXzB.js',
		},
		ld3SDl: {
			tech: 'Original Shadertoy: raymarched single warped sphere with 6-wavelength thin-film interference, iq-style cube lookup and filmic resample to RGB.',
			file: 'ld3SDl.js',
		},
		llsSDf: {
			tech: 'Original Shadertoy: 2D cellular-meta-noise "bubbles" (multi-octave cell fields, no ray tracing) plus a procedural soundtrack.',
			file: 'llsSDf.js',
		},
		bench_fresnel: { tech: 'Benchmark variant of multi_fresnel: analytic spheres over a shared uBubbles array.', file: 'multi_fresnel.js' },
		bench_thick: { tech: 'Benchmark variant of thick_glass: analytic walls over a shared uBubbles array.', file: 'thick_glass.js' },
		bench_hollow: { tech: 'Benchmark variant of hollow_bubbles: membrane event loop over a shared uBubbles array.', file: 'hollow_bubbles.js' },
		bench_thinfilm: { tech: 'Benchmark variant of multi_thinfilm: raymarched smooth-min SDF + 6λ thin film over a shared uBubbles array.', file: 'multi_thinfilm.js' },
		bench_chain: { tech: 'Benchmark variant of thick_chain: raymarched smooth-min SDF + 3 refraction hops over a shared uBubbles array.', file: 'thick_chain.js' },
	};

	function describe(meta) {
		const n = (meta && meta.arrays && meta.arrays[0] && meta.arrays[0].count) || 1;
		const ps = (meta && meta.params) || [];
		return ((n > 1 ? 'Multi-bubble (' + n + ' spheres) ' : 'Single-bubble ') +
			'single-pass WebGL2 fragment shader with Shadertoy-style uniforms' +
			(ps.length ? ', GUI-driven parameters' : '') + '; see the reference file for details.');
	}

	// long prompt to hand to an LLM
	function textFor(meta) {
		const id = (meta && meta.id) || 'shader';
		const t = T[id] || { tech: describe(meta), file: id + '.js' };
		const title = (meta && meta.title) || id;
		return [
			'Implement a bubble shader similar to the currently selected shader in this project.',
			'',
			'Project: glass-spheres-shader  https://github.com/luncat8/glass-spheres-shader',
			'Selected shader: ' + title + '  [id: ' + id + ']',
			'Tech summary: ' + t.tech,
			'Reference shader file: ' + GIT_BASE + t.file,
			'',
			'Follow the project conventions:',
			'  * classic <script>, no modules and no build; must work from file://.',
			'  * expose window.SHADER_<id> = { id, title, channels, arrays, vars, params, source }.',
			'  * WebGL2 only; fragment entry mainImage(out vec4 fragColor, in vec2 fragCoord) with Shadertoy-style uniforms (iResolution, iTime, iMouse, iChannel0..3).',
			'  * single pass; the per-frame loop must allocate nothing (reuse preallocated Float32Array buffers for array uniforms).',
			'  * keep it safe on old/integrated GPUs: bounded loops, analytic or few-step marcher, adaptive quality instead of unbounded marching.',
			'  * match the visuals and behaviour of the selected shader, and keep the same slider params where they exist.',
			'',
			'Reply with one complete shaders/' + t.file + ' wrapper (GLSL inside a template literal) that drops into the project untouched.',
		].join('\n');
	}

	// short one-liner, used as the button tooltip
	function summary(meta) {
		const id = (meta && meta.id) || 'shader';
		const t = T[id] || { tech: '', file: id + '.js' };
		return (t.tech ? t.tech + ' — ' : '') + GIT_BASE + t.file;
	}

	root.Prompts = { textFor, summary };
})(typeof window !== 'undefined' ? window : globalThis);
