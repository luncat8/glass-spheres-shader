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
			tech: 'Raymarched smooth-min union of animated objects (soap-film merge; sphere, cube, tetra or torus knot via the shared shape SDF), 6-wavelength thin-film interference and chromatic dispersion resampled to RGB; ~24 march steps with a 4-tap SDF normal.',
			file: 'multi_thinfilm.js',
		},
		analytic_layers: {
			tech: 'Analytic layered glass: one bounded ray/shape pass (sphere, spun cube or tetra, exact enter/exit with normals) over up to 61 objects keeps the nearest three layers and composites them back to front. Scene-aware — in the cage scene it also draws depth-correct ray/segment wireframe edges, three gravity-driven vertical bounces on the top face and a procedural pastel-cloud sky; in the glass-land scene a simplex heightfield block with a lake is composed at its depth.',
			file: 'analytic_layers.js',
		},
		hollow_bubbles: {
			tech: 'Analytic membrane tracing: each ray crosses thin glass shells (outer + inner surface per object — sphere, spun cube or tetra — up to 10 layers), refracting through the wall with Fresnel, Beer-Lambert tint and thin-film iridescence; JS feeds uBubbles / uSpin vec4[32] array uniforms; scene-aware (cage, glass-land heightfield).',
			file: 'hollow_bubbles.js',
		},
		thick_glass: {
			tech: 'Single-pass analytic glass spheres: per bubble the ray-sphere roots give the wall chord, Beer-Lambert absorption tints the transmitted env colour by chord length, refraction into/out of the wall plus Fresnel-weighted reflection on top.',
			file: 'thick_glass.js',
		},
		thick_analytic: {
			tech: 'Solid-glass objects (sphere, spun cube or tetra) shaded analytically from exact enter/exit crossings and depth-sorted back-to-front with a 5-comparator sorting network, then composited over a shared procedural environment and the scene geometry (cage, glass-land heightfield).',
			file: 'thick_analytic.js',
		},
		thick_chain: {
			tech: 'Raymarched smooth-min SDF of the objects (sphere, cube, tetra or torus knot) with up to 3 refraction hops: the transmitted ray re-enters the scene carrying Fresnel loss and Beer-Lambert throughput between hops; scene-aware (cage, glass-land heightfield).',
			file: 'thick_chain.js',
		},
		thick_raymarch: {
			tech: 'Raymarched smooth-min SDF of the objects (sphere, cube, tetra or torus knot) with an inside march (negated SDF) per hit, refraction out, Beer-Lambert tint over the interior chord and up to 2 reflection bounces; scene-aware (cage, glass-land heightfield).',
			file: 'thick_raymarch.js',
		},
		XdXXzB: {
			tech: 'Original Shadertoy: one refractive sphere with an analytic ray-sphere hit, fbm-hued surface lookup and fresnel-step reflection; orbit camera driven by iMouse.',
			file: 'XdXXzB.js',
		},
		XdVSRV: {
			tech: 'Original Shadertoy: a single glass-gold bubble — analytic shell traced with bump-mapped normals, two-lamp + ambient shading and up to 7 refraction/reflection hops against the gold pattern and env-cube sky.',
			file: 'XdVSRV.js',
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

	function fmtVal(v, step) {
		if (v === undefined || v === null) return '';
		if (step !== undefined) {
			return (step >= 1) ? String(v | 0) : v.toFixed(step >= 0.1 ? 1 : (step >= 0.01 ? 2 : 3));
		}
		if (Math.abs(v - Math.round(v)) < 0.0005) return String(Math.round(v));
		return String(v);
	}

	// long prompt to hand to an LLM
	function textFor(meta) {
		const id = (meta && meta.id) || 'shader';
		const t = T[id] || { tech: describe(meta), file: id + '.js' };
		const title = (meta && meta.title) || id;

		// current scene / shape, if the UI is up
		let curScene = null, curShape = null;
		try {
			if (root.__app) {
				if (typeof root.__app.scene === 'function') curScene = root.__app.scene();
				if (typeof root.__app.shape === 'function') curShape = root.__app.shape();
			}
		} catch (e) {}

		const lines = [
			'Implement a bubble shader similar to the currently selected shader in this project.',
			'',
			'Project: glass-spheres-shader  https://github.com/luncat8/glass-spheres-shader',
			'Selected shader: ' + title + '  [id: ' + id + ']',
			'Tech summary: ' + t.tech,
			'Reference shader file: ' + GIT_BASE + t.file,
			'',
			'selected settings:',
		];
		if (curScene) lines.push('scene ' + curScene);
		if (curShape) lines.push('shape ' + curShape);
		const ps = (meta && meta.params) || [];
		for (let i = 0; i < ps.length; i++) {
			const p = ps[i];
			if (p.hidden) continue;
			if (p.scenes && curScene && p.scenes.indexOf(curScene) === -1) continue;
			if (p.shapes && curShape && p.shapes.indexOf(curShape) === -1) continue;
			const label = p.label || p.name;
			let v = (p.value !== undefined ? p.value : p.def);
			if (v === undefined) continue;
			let vStr;
			if (p.options && p.options.length) {
				const opt = p.options.find((o) => o.value === v || String(o.value) === String(v));
				if (opt) vStr = opt.label + ' (' + fmtVal(v, p.step) + ')';
				else vStr = fmtVal(v, p.step);
			} else {
				vStr = fmtVal(v, p.step);
			}
			lines.push(label + ' ' + vStr);
		}
		lines.push('');
		lines.push('Follow the project conventions:');
		lines.push('  * classic <script>, no modules and no build; work from file://.');
		lines.push('  * expose window.SHADER_<id> = { id, title, channels, arrays, vars, params, source }.');
		lines.push('  * WebGL2; fragment entry mainImage(out vec4 fragColor, in vec2 fragCoord) with Shadertoy-style uniforms (iResolution, iTime, iMouse, iChannel0..3).');
		lines.push('  * the per-frame loop must allocate nothing (reuse preallocated Float32Array buffers for array uniforms).');
		lines.push('  * keep it safe on old/integrated GPUs: bounded loops, analytic or few-step marcher, adaptive quality instead of unbounded marching.');
		lines.push('  * match the visuals of the selected shader, and keep provided params as new default.');
		lines.push('');
		lines.push('complete shaders/' + t.file + ' wrapper (GLSL inside a template literal) that drops into the project untouched.');
		return lines.join('\n');
	}

	// short one-liner, used as the button tooltip
	function summary(meta) {
		const id = (meta && meta.id) || 'shader';
		const t = T[id] || { tech: '', file: id + '.js' };
		return (t.tech ? t.tech + ' — ' : '') + GIT_BASE + t.file;
	}

	root.Prompts = { textFor, summary };
})(typeof window !== 'undefined' ? window : globalThis);
