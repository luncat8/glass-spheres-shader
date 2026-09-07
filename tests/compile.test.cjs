const assert = require('node:assert/strict');
const test = require('node:test');
const helpers = require('../js/runner.js');
const debug = require('../js/compile_debug.js');
const { loadShaders } = require('./helpers.cjs');
const shaders = loadShaders();
const analytic = shaders.find(s => s.id === 'analytic_layers');

test('diagnostics use the exact production assembler for every supported variant', () => {
	assert.equal(shaders.length, 12);
	for (const meta of shaders) {
		const names = [...meta.params || [], ...meta.arrays || [], ...meta.vars || []].map(p => p.name);
		assert.equal(new Set(names).size, names.length, meta.id + ': duplicate uniforms');
		for (const variant of debug.variantsFor(meta)) {
			const source = helpers.variantSource(meta, variant);
			assert.equal(debug.buildSource(helpers, meta, variant, 'full'), source);
			assert.ok(source.startsWith('#version 300 es\n'));
			assert.ok(source.endsWith(helpers.FS_FOOTER));
			assert.ok(source.includes('#define SHAPE_MODE ' + variant.shape + '\n'));
			assert.ok(source.includes('#define USE_TERRAIN ' + variant.terrain + '\n'));
			assert.ok(!source.includes('COMPILE_DEBUG_NONCE'));
		}
	}
	assert.equal(debug.variantsFor(analytic).length, 6);
	assert.ok(!debug.variantsFor(analytic).some(v => v.shape === 3));
});

test('cache probes change a live output literal; exact production source is unchanged', () => {
	const variant = { terrain: 0, shape: 1 };
	const source = helpers.variantSource(analytic, variant);
	const a = debug.buildSource(helpers, analytic, variant, 'full', '0.91234567');
	const b = debug.buildSource(helpers, analytic, variant, 'full', '0.98765432');
	assert.match(a, /fragColor\.rgb \*= 0\.91234567;/);
	assert.notEqual(debug.hashSource(a), debug.hashSource(b));
	assert.equal(helpers.variantSource(analytic, variant), source);
	assert.throws(() => debug.buildSource(helpers, analytic, variant, 'full', 'not a number'));
});

test('component stubs replace only their function, including nested/comment braces', () => {
	assert.equal(debug.replaceBody('void f () { if (true) { /* } */ x(); } // {\n}\nvoid g () {}', 'f', 'return;'), 'void f () {\nreturn;\n}\nvoid g () {}');
	assert.throws(() => debug.replaceBody('void g () {}', 'f', 'return;'));
	for (const variant of debug.variantsFor(analytic)) {
		for (const ablation of debug.ablationsFor(analytic, variant)) {
			const source = debug.buildSource(helpers, analytic, variant, ablation);
			assert.ok(source.endsWith(helpers.FS_FOOTER));
			if (ablation === 'full') continue;
			assert.notEqual(source, helpers.variantSource(analytic, variant));
		}
	}
});

test('heavy paths have one call site and retain the original work budgets', () => {
	const byId = Object.fromEntries(shaders.map(s => [s.id, s]));
	assert.equal((analytic.source.match(/\btrace \(ro, rd\)/g) || []).length, 1);
	assert.equal((byId.hollow_bubbles.source.match(/\bshadeRay \(ro, rd\)/g) || []).length, 1);
	assert.equal((byId.thick_raymarch.source.match(/\bshadeHit \(ro, rd,/g) || []).length, 1);
	assert.equal((analytic.source.match(/cageEdgeHit \(ro, rd,/g) || []).length, 1);
	assert.match(analytic.source, /i = count - 1; i >= 0/);
	for (const id of ['analytic_layers', 'hollow_bubbles']) assert.match(byId[id].source, /samples = uAA > 0\.5 \? 4 : 1/);
	assert.equal(analytic.params.find(p => p.name === 'uCount').max, 61);
	assert.equal(byId.hollow_bubbles.params.find(p => p.name === 'uLayers').max, 10);
	assert.equal(byId.thick_chain.params.find(p => p.name === 'uHops').def, 3);
	assert.equal(byId.thick_raymarch.params.find(p => p.name === 'uBounces').def, 2);
	assert.equal(byId.thick_analytic.params.find(p => p.name === 'uCount').def, 4);
	for (const meta of shaders.filter(s => s.group === 'scene')) assert.equal(meta.params.find(p => p.name === 'uCageEdges').def, 12);
});

function fakeGL(options = {}) {
	const polls = new Map();
	const deleted = [];
	const events = [];
	const ext = { COMPLETION_STATUS_KHR: 37297 };
	const gl = {
		VERTEX_SHADER: 35633, FRAGMENT_SHADER: 35632, COMPILE_STATUS: 35713, LINK_STATUS: 35714,
		getExtension: name => name === 'KHR_parallel_shader_compile' && !options.sync ? ext : null,
		createShader: type => ({ type }), shaderSource() {}, compileShader() {},
		createProgram: () => { events.push('createProgram'); return {}; },
		attachShader() {}, linkProgram() {},
		getShaderInfoLog: () => 'shader failure', getProgramInfoLog: () => 'link failure',
		isContextLost: () => !!options.lost,
		deleteShader: object => deleted.push(object), deleteProgram: object => deleted.push(object),
		getShaderParameter(object, key) {
			assert.notEqual(key, undefined, 'must use extension enum, not gl.COMPLETION_STATUS_KHR');
			if (key === gl.COMPILE_STATUS) {
				if (!options.sync) assert.ok(polls.get(object) >= 2, 'status queried before completion');
				return !(options.shaderFailure && object.type === gl.FRAGMENT_SHADER);
			}
			assert.equal(key, ext.COMPLETION_STATUS_KHR);
			if (options.badEnum) return null;
			polls.set(object, (polls.get(object) || 0) + 1);
			return polls.get(object) >= 2;
		},
		getProgramParameter(object, key) {
			if (key === gl.LINK_STATUS) {
				if (!options.sync) assert.ok(polls.get(object) >= 2, 'link status queried before completion');
				return !options.linkFailure;
			}
			assert.equal(key, ext.COMPLETION_STATUS_KHR);
			polls.set(object, (polls.get(object) || 0) + 1);
			return polls.get(object) >= 2;
		},
	};
	return { gl, deleted, events };
}

const tiny = { id: 'tiny', source: 'void mainImage (out vec4 col, vec2 p) { col = vec4 (1.0); }' };

test('parallel diagnostic waits for both shaders and program; cleans up once', async () => {
	const { gl, deleted } = fakeGL();
	const result = await debug.compileVariant(gl, helpers, tiny, { terrain: 0, shape: 0 });
	assert.equal(result.ok, true, result.err);
	assert.equal(result.async, true);
	assert.ok(result.compileWait >= 0 && result.linkWait >= 0);
	assert.ok(result.polls >= 6);
	assert.equal(deleted.length, 3);
});

test('synchronous diagnostic records stage waits instead of reporting zero', async () => {
	const { gl, deleted } = fakeGL({ sync: true });
	const result = await debug.compileVariant(gl, helpers, tiny, { terrain: 0, shape: 0 });
	assert.equal(result.ok, true, result.err);
	assert.equal(result.async, false);
	assert.ok(result.compileWait > 0 && result.linkWait > 0);
	assert.equal(deleted.length, 3);
});

for (const failure of ['shaderFailure', 'linkFailure', 'badEnum', 'lost']) {
	test('diagnostic handles ' + failure + ' without leaking or polling forever', async () => {
		const { gl, deleted, events } = fakeGL({ [failure]: true });
		const result = await debug.compileVariant(gl, helpers, tiny, { terrain: 0, shape: 0 });
		assert.equal(result.ok, false);
		assert.ok(result.err.length > 0);
		assert.equal(deleted.length, failure === 'linkFailure' ? 3 : 2);
		assert.equal(events.length, failure === 'linkFailure' ? 1 : 0);
	});
}
