'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core');

test('reads LCOV line and branch hits', () => {
  const rows = core.parseReport('TN:\nSF:src/app.js\nDA:2,4\nDA:3,0\nBRDA:2,0,0,1\nBRDA:2,0,1,0\nend_of_record\n', 'lcov');
  assert.equal(rows.length, 1);
  assert.deepEqual([...rows[0].lines], [[2, 4], [3, 0]]);
  assert.equal(core.stats(rows[0]).percent, 50);
});

test('reads Cobertura, JaCoCo and Clover lines', () => {
  const cobertura = core.parseReport('<coverage><packages><package><classes><class filename="src/a.js"><lines><line number="1" hits="1"/><line number="2" hits="0"/></lines></class></classes></package></packages></coverage>', 'cobertura');
  const jacoco = core.parseReport('<report><package name="x"><sourcefile name="B.java"><line nr="8" mi="1" ci="2" mb="0" cb="1"/></sourcefile></package></report>', 'jacoco');
  const clover = core.parseReport('<coverage><project><file name="src/c.js"><line num="4" type="stmt" count="3"/></file></project></coverage>', 'clover');
  assert.deepEqual([...cobertura[0].lines], [[1, 1], [2, 0]]);
  assert.deepEqual([...jacoco[0].lines], [[8, 1]]);
  assert.deepEqual([...clover[0].lines], [[4, 3]]);
});

test('merges reports by workspace path and computes totals', () => {
  const root = '/repo';
  const files = core.mergeReports([core.lcov('SF:src/a.js\nDA:1,1\nDA:2,0\nend_of_record')], root);
  const t = core.totals(files);
  assert.equal(files[0].absolute, '/repo/src/a.js');
  assert.equal(t.percent, 50);
  assert.deepEqual(files[0].missed, [2]);
});

test('finds uncovered changed lines and writes Markdown', () => {
  const files = core.mergeReports([core.lcov('SF:src/a.js\nDA:1,1\nDA:2,0\nend_of_record')], '/repo');
  const diff = core.diffCoverage(files, { '/repo/src/a.js': [1, 2, 3] });
  assert.ok(Math.abs(diff.percent - 100 / 3) < 1e-12);
  assert.deepEqual(diff.missed.map(x => [x.line, x.reported]), [[2, true], [3, false]]);
  assert.match(core.markdownReport(files), /50\.0%/);
  assert.match(core.htmlReport(files), /<table>/);
  assert.match(core.htmlReport([{ ...files[0], path: '<img src=x>' }]), /&lt;img src=x&gt;/);
});

test('reads one report per folder and prefers lcov.info over a clover.xml written by the same run', () => {
  const picked = core.pickReports(['/r/coverage/clover.xml', '/r/coverage/lcov.info', '/r/py/coverage.xml', '/r/java/jacoco.xml', '/r/java/clover.xml']);
  assert.deepEqual(picked.sort(), ['/r/coverage/lcov.info', '/r/java/jacoco.xml', '/r/py/coverage.xml']);
});

test('clover file paths use the path attribute and map an absolute path from another machine into the workspace', () => {
  const rows = core.parseReport('<coverage><project><package name="src"><file name="a.tsx" path="/ci/build/app/src/a.tsx"><line num="1" type="stmt" count="1"/><line num="2" type="stmt" count="0"/></file></package></project></coverage>', 'clover');
  assert.equal(rows[0].path, '/ci/build/app/src/a.tsx');
  const exists = p => p === '/repo/src/a.tsx';
  const files = core.mergeReports([rows, core.lcov('SF:src/a.tsx\nDA:1,1\nDA:2,0\nend_of_record')], '/repo', exists);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'src/a.tsx');
  assert.equal(core.totals(files).total, 2);
});

test('relative and in-workspace absolute paths resolve as before', () => {
  assert.equal(core.resolveReportPath('src/a.js', '/repo'), '/repo/src/a.js');
  assert.equal(core.resolveReportPath('/repo/src/a.js', '/repo'), '/repo/src/a.js');
  assert.equal(core.resolveReportPath('/elsewhere/x.js', '/repo'), '/elsewhere/x.js');
});

test('package.json has palette-hidden Zovo Pro Explorer wrappers, one per Pro tool', () => {
  const pkg = require('../package.json');
  const ids = ['diff', 'export', 'history'].map(id => `codeCoverage.zovoPro.${id}`);
  for (const id of ids) {
    const cmd = pkg.contributes.commands.find(c => c.command === id);
    assert.ok(cmd && /^Zovo Pro: /.test(cmd.title), id);
    assert.ok(pkg.contributes.menus.commandPalette.some(m => m.command === id && m.when === 'false'), `${id} hidden in palette`);
    const menu = pkg.contributes.menus['explorer/context'].find(m => m.command === id);
    assert.ok(menu && !('title' in menu) && /config\.codeCoverage\.showProTools/.test(menu.when) && /lcov/.test(menu.when), `${id} explorer entry`);
  }
});

test('files with no instrumented lines sort after real files and are not listed as least covered', () => {
  const files = core.mergeReports([core.lcov('SF:src/types.d.ts\nend_of_record\nSF:src/a.js\nDA:1,1\nDA:2,0\nend_of_record')], '/repo');
  assert.deepEqual(files.map(f => f.path), ['src/a.js', 'src/types.d.ts']);
  assert.deepEqual(core.totals(files).leastCovered.map(f => f.path), ['src/a.js']);
});
