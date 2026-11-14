'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTrialAccess } = require('../src/trials');
function state() { const data = {}; return { get: (key, fallback) => data[key] ?? fallback, update: async (key, value) => { data[key] = value; }, data }; }
test('allows three completed tries per tool and keeps counters separate', async () => {
  const s = state(), gate = createTrialAccess(s, 'tries');
  for (let i = 0; i < 3; i++) { const access = gate.allow('diff'); assert.ok(access); await access.done(); }
  assert.equal(gate.remaining('diff'), 0);
  assert.ok(gate.allow('export'));
  assert.equal(gate.allow('diff'), false);
});
test('cancelled work costs no try and a completed result costs one only once', async () => {
  const s = state(), gate = createTrialAccess(s, 'tries');
  gate.allow('history'); assert.equal(gate.remaining('history'), 3);
  const access = gate.allow('history'); assert.equal(await access.done(), true); assert.equal(await access.done(), false);
  assert.equal(gate.remaining('history'), 2);
});
test('try counts stay monotonic when globalState returns an older value after a write', async () => {
  let stale = null; const data = {};
  const s = { get: (key, fallback) => stale ?? data[key] ?? fallback, update: async (key, value) => { data[key] = value; } };
  const gate = createTrialAccess(s, 'tries');
  await gate.allow('diff').done();
  stale = {};
  assert.equal(gate.remaining('diff'), 2);
  await gate.allow('diff').done();
  stale = null;
  assert.equal(gate.remaining('diff'), 1);
});
