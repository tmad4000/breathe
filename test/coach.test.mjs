import test from 'node:test';
import assert from 'node:assert/strict';
import { Coach } from '../coach.js';

// Runs a coach against a simulated person. own: their natural breaths/min.
// follows: once caught, they make each guide turn (a little late) instead of their own.
function run({ own = 14, follows = true, tracked = true, seconds = 150 }) {
  const coach = new Coach(0);
  const log = [];
  let nextOwn = 2, ownTop = true, caughtAt = null, done = new Set();
  for (let t = 0; t <= seconds; t += 0.05) {
    if (tracked) {
      if (coach.sensed && follows) {
        caughtAt ??= t;
        for (const s of coach.segs) {
          const at = s.t1 + 0.15;
          if (!s.cut && s.t1 > caughtAt && at <= t && !done.has(s.t1)) { done.add(s.t1); coach.userTurn(at, s.to === 1); }
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
  assert.equal(coach.bpm, 6);
  assert.ok(at('arrive') < 90, `arrived at ${at('arrive')}`);
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
  assert.equal(coach.bpm, 6);
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
