import test from 'node:test';
import assert from 'node:assert/strict';
import { Coach, PATTERNS } from '../coach.js';

// Runs a coach against a simulated person. own: their natural breaths/min.
// follows: once caught, they make each guide turn (a little late) instead of their own.
function run({ own = 14, follows = true, tracked = true, seconds = 150, pattern = '5-1-5-1' }) {
  const coach = new Coach(0, { pattern: PATTERNS[pattern] });
  const log = [];
  let nextOwn = 2, ownTop = true, caughtAt = null, done = new Set();
  for (let t = 0; t <= seconds; t += 0.05) {
    if (tracked) {
      if (coach.sensed && follows) {
        caughtAt ??= t;
        for (const s of coach.segs) {
          const at = s.t1 + 0.15;
          if (!s.cut && s.kind !== 'hold' && s.t1 > caughtAt && at <= t && !done.has(s.t1)) { done.add(s.t1); coach.userTurn(at, s.kind === 'in'); }
        }
      } else if (t >= nextOwn) {
        coach.userTurn(nextOwn, ownTop);
        nextOwn += (60 / own) * (ownTop ? 0.58 : 0.42);
        ownTop = !ownTop;
      }
    }
    coach.update(t);
    log.push({ t, stage: coach.stage, bpm: coach.bpm, level: coach.level(t) });
  }
  return { coach, log, at: (stage) => log.find((x) => x.stage === stage)?.t };
}

test('opens with a long breath out, then catches the person within about 15 s', () => {
  const { coach, log, at } = run({ own: 14 });
  assert.ok(log[0].level > 0.99 && log.find((x) => x.t >= 4.4).level < 0.05, 'first 4.5 s is one breath out');
  assert.ok(at('match') < 16, `caught at ${at('match')}`);
  assert.ok(Math.abs(coach.firstBpm - 14) < 1, `first pace ${coach.firstBpm}`);
});

test('a person who follows is led to the target in about a minute', () => {
  const { coach, log, at } = run({ own: 14 });
  assert.equal(coach.stage, 'arrive');
  assert.equal(coach.bpm, 5);
  assert.ok(at('arrive') < 110, `arrived at ${at('arrive')}`);
  const d = coach.durations();
  for (const [k, want] of [['in', 5], ['top', 1], ['out', 5], ['bottom', 1]]) assert.ok(Math.abs(d[k] - want) < 1e-6, `${k} ${d[k]}`);
  assert.ok(coach.sync >= 0.75, `sync ${coach.sync}`);
  for (let i = 1; i < log.length; i++) assert.ok(Math.abs(log[i].level - log[i - 1].level) < 0.08, `guide jumps at ${log[i].t}`);
});

test('a person who keeps their own pace is not dragged: the guide waits and returns to them', () => {
  const { coach, log } = run({ own: 12, follows: false, seconds: 180 });
  assert.notEqual(coach.stage, 'arrive');
  const late = log.filter((x) => x.t > 60).map((x) => x.bpm);
  assert.ok(Math.min(...late) >= 8.5, `guide fell to ${Math.min(...late)}`);
  assert.ok(Math.abs(late[late.length - 1] - 12) < 3.5);
});

test('with no tracking it still leads, on a schedule', () => {
  const { coach, at } = run({ tracked: false, seconds: 140 });
  assert.equal(coach.sensed, false);
  assert.equal(coach.bpm, 5);
  assert.ok(at('lead') >= 15 && at('arrive') < 120, `lead ${at('lead')} arrive ${at('arrive')}`);
});

test('tracking that appears late is picked up', () => {
  const coach = new Coach(0);
  let next = 30, top = true;
  for (let t = 0; t <= 60; t += 0.05) {
    if (t >= next) { coach.userTurn(next, top); next += top ? 2.9 : 2.1; top = !top; }
    coach.update(t);
  }
  assert.equal(coach.sensed, true);
});

test('every breath reaches completely full and completely empty, whatever the pace', () => {
  const { log } = run({ own: 14 });
  let lo = 1, hi = 0, dir = 0, prev = log[0].level;
  for (const x of log.slice(1)) {
    const d = Math.sign(x.level - prev);
    if (d && dir && d !== dir) { if (dir > 0) hi = Math.min(hi || 1, prev); else lo = Math.max(lo === 1 ? 0 : lo, prev); }
    if (d) dir = d;
    prev = x.level;
  }
  assert.ok(hi > 0.999, `lowest peak ${hi}`);
  assert.ok(lo < 0.001, `highest valley ${lo}`);
});

test('holds are absent at the catch and full length on arrival; 5-0-5 and 4-7-8 arrive at their own shapes', () => {
  const early = run({ own: 14, seconds: 20 }).coach.durations();
  assert.ok(early.top < 0.05 && early.bottom < 0.05, `early holds ${early.top} ${early.bottom}`);
  const plain = run({ own: 14, pattern: '5-0-5' }).coach;
  assert.equal(plain.bpm, 6);
  assert.ok(plain.segs.every((s) => s.kind !== 'hold'));
  const long = run({ own: 14, pattern: '4-7-8', seconds: 260 }).coach;
  assert.equal(long.stage, 'arrive');
  const d = long.durations();
  assert.ok(Math.abs(d.in - 4) < 1e-6 && Math.abs(d.top - 7) < 1e-6 && Math.abs(d.out - 8) < 1e-6, JSON.stringify(d));
});
