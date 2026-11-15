import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BreathFeedback } from '../breath-feedback.js';

test('detected inhale/exhale feedback fires once and survives rolling history', () => {
  const f = new BreathFeedback();
  const a = { t: 2, exhale: false }, b = { t: 4, exhale: true }, c = { t: 6, exhale: false };
  assert.deepEqual(f.take([a, b], true), [a, b]);
  assert.deepEqual(f.take([a, b], true), []);
  assert.deepEqual(f.take([b, c], true), [c]);
});

test('invalid tracking drains stale turns silently; a new session starts fresh', () => {
  const f = new BreathFeedback();
  assert.deepEqual(f.take([{ t: 10, exhale: true }], false), []);
  assert.deepEqual(f.take([{ t: 10, exhale: true }], true), []);
  assert.deepEqual(f.take([{ t: 12, exhale: false }], true), [{ t: 12, exhale: false }]);
  assert.equal(new BreathFeedback().take([{ t: 1, exhale: true }], true).length, 1);
});
