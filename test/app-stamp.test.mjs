import assert from 'node:assert/strict';
import '../app-stamp.js';
const {format} = globalThis.AppStamp;
const now = Date.parse('2026-11-15T12:00:00Z');
const at = (ms) => new Date(now - ms).toISOString();
const L = (ms) => format(at(ms), now, 'en-US', 'UTC').label;
const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;
assert.strictEqual(L(59 * S), 'just now');
assert.strictEqual(L(60 * S), '1m ago');
assert.strictEqual(L(5 * M + 30 * S), '5m ago');
assert.strictEqual(L(59 * M + 59 * S), '59m ago');
assert.strictEqual(L(60 * M), '1h ago');
assert.strictEqual(L(23 * H + 59 * M), '23h ago');
assert.strictEqual(L(24 * H), '1d ago');
assert.strictEqual(L(7 * D - S), '6d ago');
assert.strictEqual(L(7 * D), 'Nov 8');
assert.strictEqual(L(330 * D), 'Dec 20, 2025');                 // other year: year shown
assert.strictEqual(L(-90 * S), 'just now');                     // within 2 min skew
assert.strictEqual(L(-10 * M), 'Nov 15');                       // beyond skew: absolute, never negative
assert.strictEqual(format('2026-11-15', now), null);            // date-only: no fake instant
assert.strictEqual(format('not a date', now), null);
assert.strictEqual(format(undefined, now), null);
const f = format('2026-11-15T01:37:12-08:00', now, 'en-US', 'America/Los_Angeles');
assert.strictEqual(f.datetime, '2026-11-15T09:37:12.000Z');
assert.ok(/Sunday, November 15, 2026 at 1:37:12\sAM PST/.test(f.detail), f.detail);
assert.strictEqual(f.label, '2h ago');
assert.ok(/\d/.test(format(at(5 * M), now, 'de-DE', 'UTC').label));
console.log('app-stamp format: 20 assertions passed');
