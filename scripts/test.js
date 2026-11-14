'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = fs.readdirSync(path.join(root, 'test')).filter(name => name.endsWith('.test.js')).map(name => path.join('test', name));
const result = spawnSync(process.execPath, ['--test', '--test-reporter=dot', ...files], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
