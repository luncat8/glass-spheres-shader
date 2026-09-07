// portdiff.cjs — compare the original Shadertoy sources in example-shadertoy/
// against the GLSL embedded in shaders/<id>.js wrappers. The ports are allowed
// to differ only in comments/whitespace and in compile-driven loop reworks
// (uniform loop bounds); anything else shows up here for review.
// node tests/portdiff.cjs [id ...]
(function () {
	const fs = require('fs');
	const path = require('path');

	const ROOT = path.join(__dirname, '..');
	const PAIRS = [
		{ txt: 'example-shadertoy/XdXXzB.txt', js: 'shaders/XdXXzB.js', id: 'XdXXzB' },
		{ txt: 'example-shadertoy/llsSDf.txt', js: 'shaders/llsSDf.js', id: 'llsSDf' },
		{ txt: 'example-shadertoy/ld3SDl.txt', js: 'shaders/ld3SDl.js', id: 'ld3SDl' },
		{ txt: 'example-shadertoy/XdVSRV.txt', js: 'shaders/XdVSRV.js', id: 'XdVSRV' },
	];
	const ONLY = process.argv.slice(2);

	// extract the template-literal GLSL from a shaders/*.js wrapper
	function glslOf(jsFile) {
		let src = fs.readFileSync(path.join(ROOT, jsFile), 'utf8');
		const start = src.search(/"source"\s*:/);
		if (start < 0) throw new Error('no source literal in ' + jsFile);
		const open = src.indexOf('`', start);
		const close = src.lastIndexOf('`');
		if (open < 0 || close <= open) throw new Error('no source literal in ' + jsFile);
		return src.slice(open + 1, close).replace(/^\n+/, '').replace(/\s+$/, '');
	}

	// strip // comments, collapse whitespace, drop empty lines
	function norm(s) {
		return s
			.replace(/\/\/[^\n]*/g, '')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l.length)
			.join('\n');
	}

	// LCS-based diff output of changed lines (only -/+ lines, deduped runs)
	function changedLines(a, b) {
		const al = a.split('\n'), bl = b.split('\n');
		const N = al.length, M = bl.length;
		const dp = new Uint32Array((N + 1) * (M + 1));
		for (let i = N - 1; i >= 0; i--) {
			for (let j = M - 1; j >= 0; j--) {
				dp[i * (M + 1) + j] = al[i] === bl[j]
					? dp[(i + 1) * (M + 1) + j + 1] + 1
					: Math.max(dp[(i + 1) * (M + 1) + j], dp[i * (M + 1) + j + 1]);
			}
		}
		const out = [];
		let i = 0, j = 0;
		while (i < N && j < M) {
			if (al[i] === bl[j]) { i++; j++; continue; }
			if (dp[(i + 1) * (M + 1) + j] >= dp[i * (M + 1) + j + 1]) { out.push('  - ' + al[i]); i++; }
			else { out.push('  + ' + bl[j]); j++; }
		}
		while (i < N) { out.push('  - ' + al[i]); i++; }
		while (j < M) { out.push('  + ' + bl[j]); j++; }
		return out;
	}

	let bad = 0;
	for (const p of PAIRS) {
		if (ONLY.length && ONLY.indexOf(p.id) === -1) continue;
		const orig = norm(fs.readFileSync(path.join(ROOT, p.txt), 'utf8'));
		const port = norm(glslOf(p.js));
		console.log('\n==== ' + p.id + '  orig ' + orig.length + ' vs port ' + port.length + ' chars');
		if (orig === port) { console.log('identical after comment/whitespace stripping'); continue; }
		bad++;
		const lines = changedLines(orig, port);
		console.log(lines.slice(0, 200).join('\n'));
		if (lines.length > 200) console.log('... +' + (lines.length - 200) + ' more diff lines');
	}
	console.log(bad ? '\n' + bad + ' port(s) differ (see hunks above)' : '\nall ports faithful');
})();
