'use strict';
const { spawnSync } = require('node:child_process');
const output = process.argv[2] || 'dist/';
const result = spawnSync('npx', ['-y', '@vscode/vsce@3', 'package', '-o', output], { stdio: 'inherit' });
process.exit(result.status ?? 1);
