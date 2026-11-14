'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { withSurface, runAs, isToolbarArg } = require('../src/reach');

test('a Pro tool run from the Explorer or the summary row tags the Zovo Pro panel with its surface', async () => {
  assert.equal(withSurface('x'), 'x');
  await runAs('ctx', async () => assert.deepEqual(withSurface({ detail: 'd' }), { detail: 'd', surface: 'ctx' }));
  await runAs('toolbar', async () => assert.deepEqual(withSurface('d'), { detail: 'd', surface: 'toolbar' }));
  assert.equal(isToolbarArg([{ surface: 'toolbar' }]), true);
  assert.equal(isToolbarArg({ scheme: 'file', surface: 'toolbar' }), false);
});
