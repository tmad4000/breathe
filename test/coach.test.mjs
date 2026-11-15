import test from 'node:test';
import assert from 'node:assert/strict';
import { Coach, PATTERNS } from '../coach.js';

// Runs a coach against a simulated person. own: their natural breaths/min.
// follows: once caught, they make each guide turn (a little late) instead of their own.
// turns(t): optional custom turn source for odd cases.
function run({ own = 14, follows = true, tracked = true, seconds = 200, pattern = '5-1-5-1', adaptive = true, from = 2 }) {
  const coach = new Coach(0, { pattern: PATTERNS[pattern], adaptive });
  const log = [];
  let nextOwn = from, ownTop = true, caughtAt = null;
  const done = new Set();
  for (let t = 0; t <= seconds; t += 0.05) {
    if (tracked) {
      if (coach.sensed && follows) {
        caughtAt ??= t;
        for (const s of coach.segs) {
          const at = s.t1 + 0.15;
          if (!s.cut && (s.kind === 'in' || s.kind === 'out') && s.t1 > caughtAt && at <= t && !done.has(s.t1)) { done.add(s.t1); coach.userTurn(at, s.kind === 'in'); }
        }
      } else if (t >= nextOwn) {
        coach.userTurn(nextOwn, ownTop);
        nextOwn += (60 / own) * (ownTop ? 0.58 : 0.42);
        ownTop = !ownTop;
      }
    }
    coach.update(t);
    log.push({ t, stage: coach.stage, bpm: coach.bpm, cycle: coach.cycle, level: coach.level(t, true), kind: coach.phase(t) });
  }
  return { coach, log, at: (stage) => log.find((x) => x.stage === stage)?.t };
}
const maxBpm = (log, after = 0) => Math.max(...log.filter((x) => x.t >= after).map((x) => x.bpm));
const neverShortens = (log, after) => log.filter((x) => x.t >= after).every((x, i, a) => !i || x.cycle >= a[i - 1].cycle - 1e-9);

test('guide: the plain pattern, with flat holds, and it never changes', () => {
  const { coach, log } = run({ adaptive: false, tracked: false, seconds: 60 });
  assert.equal(coach.stage, 'guide');
  assert.ok(log.every((x) => x.cycle === 12));
  // After the ready pause: in 5, hold 1, out 5, hold 1.
  const at = (t) => log.find((x) => Math.abs(x.t - t) < 0.026);
  assert.equal(at(1.5 + 2.5).kind, 'in'); assert.ok(Math.abs(at(1.5 + 2.5).level - 0.5) < 0.02);
  assert.equal(at(1.5 + 5.5).kind, 'hold'); assert.equal(at(1.5 + 5.5).level, 1);
  assert.equal(at(1.5 + 8.5).kind, 'out'); assert.ok(Math.abs(at(1.5 + 8.5).level - 0.5) < 0.02);
  assert.equal(at(1.5 + 11.5).kind, 'hold'); assert.equal(at(1.5 + 11.5).level, 0);
  assert.equal(coach.breathCount, 4);
});

test('guide ignores the person completely', () => {
  const { coach, log } = run({ adaptive: false, own: 18, follows: false, seconds: 90 });
  assert.ok(log.every((x) => x.cycle === 12) && coach.stage === 'guide' && coach.sensed === false);
});

test('coach: opens with a long breath out, catches a fast breather, and starts no faster than 10/min', () => {
  const { coach, log, at } = run({ own: 14 });
  assert.ok(log[0].level > 0.99 && log.find((x) => x.t >= 4.4).level < 0.05, 'first 4.5 s is one breath out');
  assert.ok(at('match') < 16, `caught at ${at('match')}`);
  assert.ok(Math.abs(coach.firstBpm - 14) < 1, `first pace ${coach.firstBpm}`);
  assert.ok(maxBpm(log) <= 10 + 1e-9, `guide reached ${maxBpm(log)}/min`);
});

test('coach: the shape is the pattern at every pace, holds included, from the first breath', () => {
  const { log } = run({ own: 14, seconds: 40 });
  const holdAtTop = log.filter((x) => x.t > 5 && x.t < 40 && x.kind === 'hold' && x.level === 1).length * 0.05;
  assert.ok(holdAtTop > 1.2, `seconds held full in the first 40 s: ${holdAtTop}`);
});

test('coach: a follower is led to the full pattern, the breath only ever getting longer', () => {
  const { coach, log, at } = run({ own: 14 });
  assert.equal(coach.stage, 'arrive');
  assert.ok(at('arrive') < 150, `arrived at ${at('arrive')}`);
  const d = coach.durations();
  for (const [k, want] of [['in', 5], ['top', 1], ['out', 5], ['bottom', 1]]) assert.ok(Math.abs(d[k] - want) < 1e-6, `${k} ${d[k]}`);
  assert.ok(neverShortens(log, at('match')), 'cycle shortened after the catch');
  assert.ok(coach.sync >= 0.75, `sync ${coach.sync}`);
});

test('coach: someone who keeps their own fast pace is never chased; it waits, then still converges', () => {
  const { coach, log, at } = run({ own: 16, follows: false, seconds: 420 });
  assert.ok(maxBpm(log) <= 10 + 1e-9, `guide reached ${maxBpm(log)}/min`);
  assert.ok(neverShortens(log, 26), 'cycle shortened after the catch window');
  assert.equal(coach.stage, 'arrive');
  assert.ok(coach.log.some((e) => e.ev === 'hold'), 'it should have waited at least once');
});

test('coach: a slow breather is met where they are, not sped up', () => {
  const { coach, log } = run({ own: 7, seconds: 120 });
  assert.ok(Math.abs(log.find((x) => x.stage === 'match').cycle - 60 / 7) < 0.6);
  assert.ok(maxBpm(log, 20) <= 7.6, `guide reached ${maxBpm(log, 20)}/min`);
  assert.equal(coach.stage, 'arrive');
});

test('coach: jittery fast turns cannot drive the guide up', () => {
  const coach = new Coach(0);
  let next = 1, top = true, peak = 0;
  for (let t = 0; t <= 240; t += 0.05) {
    if (t >= next) { coach.userTurn(next, top); next += 1.5; top = !top; }   // reads as 20 breaths/min
    coach.update(t);
    peak = Math.max(peak, coach.bpm);
  }
  assert.ok(peak <= 10 + 1e-9, `guide reached ${peak}/min`);
  assert.equal(coach.stage, 'arrive');
});

test('coach: with no tracking it leads on a schedule; tracking that appears late never speeds it up', () => {
  const blind = run({ tracked: false, seconds: 200 });
  assert.equal(blind.coach.sensed, false);
  assert.equal(blind.coach.stage, 'arrive');
  assert.ok(neverShortens(blind.log, 0));
  const late = run({ own: 15, follows: false, from: 50, seconds: 200 });
  assert.equal(late.coach.sensed, true);
  assert.ok(neverShortens(late.log, 0), 'late tracking shortened the breath');
});

test('coach: turning tracking off mid-session carries on as a guide toward the target', () => {
  const coach = new Coach(0);
  let next = 2, top = true;
  for (let t = 0; t <= 200; t += 0.05) {
    if (t < 40 && t >= next) { coach.userTurn(next, top); next += top ? 2.5 : 1.8; top = !top; }
    if (Math.abs(t - 40) < 0.026) coach.setTracking(false, t);
    coach.update(t);
  }
  assert.equal(coach.sensed, false);
  assert.equal(coach.stage, 'arrive');
});

test('every breath goes completely full and completely empty', () => {
  for (const opts of [{ own: 14 }, { own: 16, follows: false, seconds: 300 }, { adaptive: false, tracked: false }]) {
    const { log } = run(opts);
    let dir = 0, prev = log[0].level, hi = 1, lo = 0;
    for (const x of log.slice(1)) {
      const d = Math.sign(x.level - prev);
      if (d && dir && d !== dir) { if (dir > 0) hi = Math.min(hi, prev); else lo = Math.max(lo, prev); }
      if (d) dir = d;
      prev = x.level;
    }
    assert.ok(hi > 0.999 && lo < 0.001, `lowest peak ${hi}, highest valley ${lo}`);
  }
});

test('5-0-5 and 4-7-8 arrive at their own shapes', () => {
  const plain = run({ own: 14, pattern: '5-0-5' }).coach;
  assert.equal(plain.stage, 'arrive'); assert.equal(plain.cycle, 10);
  assert.ok(plain.segs.every((s) => s.kind !== 'hold'));
  const long = run({ own: 14, pattern: '4-7-8', seconds: 420 });
  assert.equal(long.coach.stage, 'arrive');
  const d = long.coach.durations();
  assert.ok(Math.abs(d.in - 4) < 1e-6 && Math.abs(d.top - 7) < 1e-6 && Math.abs(d.out - 8) < 1e-6, JSON.stringify(d));
  assert.ok(maxBpm(long.log) <= 10 + 1e-9);
});

test('the log records what happened and why', () => {
  const { coach } = run({ own: 14 });
  const events = coach.log.map((e) => e.ev);
  for (const ev of ['start', 'catch', 'step', 'arrive']) assert.ok(events.includes(ev), `missing ${ev} in ${events}`);
  const c = coach.log.find((e) => e.ev === 'catch');
  assert.ok(c.t > 4 && c.cycle === 6 && Math.abs(c.user - 60 / 14) < 0.4, JSON.stringify(c));
});

test('pattern switching preserves the current breath and replans future breaths', () => {
  const c = new Coach(0, {adaptive:false});
  c.update(4);
  const level = c.level(4), phase = c.phase(4), t0=c.t0;
  c.setPattern(PATTERNS['4-7-8'],4);
  assert.equal(c.level(4),level);
  assert.equal(c.phase(4),phase);
  assert.equal(c.t0,t0,'same session');
  assert.equal(c.full,19);
  assert.ok(c.log.some(x=>x.ev==='pattern-change'));
  c.update(100);
  assert.deepEqual(c.durations(),{in:4,top:7,out:8,bottom:0});
});

test('pause shifts the guide clock without jumping phase', () => {
  const c = new Coach(0,{adaptive:false}); c.update(5);
  const level=c.level(5),phase=c.phase(5);
  c.shiftTime(120); c.update(125);
  assert.equal(c.level(125),level);
  assert.equal(c.phase(125),phase);
});
