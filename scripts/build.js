'use strict';
const esbuild = require('esbuild');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
esbuild.build({ entryPoints: [path.join(root, 'src/extension.js')], outfile: path.join(root, 'dist/extension.js'), bundle: true, minify: true, platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'], logLevel: 'warning' }).catch(e => { console.error(e); process.exit(1); });
