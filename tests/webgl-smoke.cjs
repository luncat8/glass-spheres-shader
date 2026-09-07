// Optional: npm install --no-save playwright && npx playwright install chromium
// CHROME can select an installed executable; CHROME_ARGS is a JSON array.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const { root } = require('./helpers.cjs');

(async function () {
	const browser = await chromium.launch({
		headless: true,
		executablePath: process.env.CHROME || undefined,
		args: ['--no-sandbox', '--disable-gpu-shader-disk-cache', ...JSON.parse(process.env.CHROME_ARGS || '[]')],
	});
	try {
		const page = await browser.newPage();
		const errors = [];
		page.on('pageerror', e => errors.push(e.message));
		await page.goto(pathToFileURL(path.join(root, 'debug.html')).href);
		await page.addScriptTag({ path: path.join(__dirname, 'geometry-webgl.js') });
		const count = await page.evaluate(() => {
			const gl = document.getElementById('c').getContext('webgl2', { powerPreference: 'high-performance' });
			return checkShaderGeometry(gl);
		});
		console.log('GPU/scalar-reference geometry cases:', count);
		const results = await page.evaluate(async () => {
			const gl = document.getElementById('c').getContext('webgl2');
			const results = [];
			for (const meta of SHADERS) {
				for (const variant of CompileDebug.variantsFor(meta)) {
					const r = await CompileDebug.compileVariant(gl, Runner.helpers, meta, variant, { firstUse: true });
					if (!r.ok) throw new Error(r.id + ' ' + r.key + ': ' + r.err);
					results.push({ id: r.id, key: r.key, ready: Math.round(r.readyMs), firstUse: Math.round(r.firstUseMs) });
				}
			}
			const meta = SHADERS.find(s => s.id === 'analytic_layers');
			const variant = { terrain: 1, shape: 1 };
			for (const ablation of CompileDebug.ablationsFor(meta, variant)) {
				const r = await CompileDebug.compileVariant(gl, Runner.helpers, meta, variant, { ablation, literal: '0.91234567' });
				if (!r.ok) throw new Error(ablation + ': ' + r.err);
			}
			return { environment: CompileDebug.contextInfo(gl), results };
		});
		console.log(results.environment.unmaskedRenderer);
		console.table(results.results);
		console.log('Supported programs linked/drawn:', results.results.length);
		await page.check('#translated');
		await page.selectOption('#shape', '1');
		await page.click('#runSelected');
		await page.waitForFunction(() => document.getElementById('status').textContent === 'done', null, { timeout: 180000 });
		assert.match(await page.locator('#log').textContent(), /analytic_layers t0:1 full.*ok=true/);
		assert.equal(await page.locator('#save').isEnabled(), true);
		assert.deepEqual(errors, []);
		console.log('Debug UI and file:// loading passed.');
	} finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
