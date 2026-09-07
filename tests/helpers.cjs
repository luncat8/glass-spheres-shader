const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

function loadShaders() {
	const context = vm.createContext({});
	context.window = context;
	vm.runInContext(fs.readFileSync(path.join(root, 'js/glsl_lib.js'), 'utf8'), context);
	for (const file of fs.readdirSync(path.join(root, 'shaders'))) {
		if (!file.endsWith('.js')) continue;
		vm.runInContext(fs.readFileSync(path.join(root, 'shaders', file), 'utf8'), context);
	}
	return Object.keys(context).filter(k => k.startsWith('SHADER_')).map(k => context[k]);
}

module.exports = { root, loadShaders };
