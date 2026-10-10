// node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockFlow, RespirationSession } from '../signal.js';

function texture(w, h, shiftY) {
  const img = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const yy = y - shiftY;
    img[y * w + x] = 128 + 40 * Math.sin(x * 0.31 + yy * 0.17) + 30 * Math.cos(yy * 0.23 - x * 0.07) + 20 * Math.sin((x + yy) * 0.11);
  }
  return img;
}

test('blockFlow recovers sub-pixel vertical shift and ignores brightness change', () => {
  const w = 96, h = 96, rect = { x: 8, y: 8, w: 80, h: 80 };
  const a = texture(w, h, 0);
  for (const shift of [-0.4, 0.15, 0.3]) {
    const b = texture(w, h, shift).map((v) => v + 6); // exposure bump
    const v = blockFlow(a, b, w, h, rect);
    assert.ok(Math.abs(v - shift) < 0.05, `shift ${shift} estimated ${v}`);
  }
});

test('blockFlow returns null on a flat region', () => {
  const flat = new Float32Array(64 * 64).fill(100);
  assert.equal(blockFlow(flat, flat, 64, 64, { x: 2, y: 2, w: 60, h: 60 }), null);
});

function simulate(bpmAt, seconds, { fps = 30, noise = 0.02, seed = 1 } = {}) {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5);
  const session = new RespirationSession();
  const boxH = 80, amp = 0.6; // px of chest motion peak-to-peak / 2
  let phase = 0, prevPos = 0;
  for (let i = 1; i <= seconds * fps; i++) {
    const t = i / fps;
    phase += 2 * Math.PI * (bpmAt(t) / 60) / fps;
    const pos = -amp * Math.sin(phase) + 0.002 * t * fps; // +down; slow drift
    const flow = pos - prevPos + noise * rand();
    prevPos = pos;
    session.push(1 / fps, flow, boxH);
  }
  return session;
}

test('tracks a steady 15 bpm for 5 minutes (no 1-minute cap)', () => {
  const s = simulate(() => 15, 300);
  const r = s.currentRate();
  assert.ok(Math.abs(r.bpm - 15) < 0.7, `got ${r.bpm}`);
  assert.ok(Math.abs(s.breaths.length - 75) <= 3, `breaths ${s.breaths.length}`);
  assert.ok(Math.abs(s.averageRate() - 15) < 0.5);
  assert.ok(s.trend.length >= 25);
});

test('follows a rate change from 12 to 20 bpm', () => {
  const s = simulate((t) => (t < 120 ? 12 : 20), 240);
  const early = s.trend.find((p) => p.t >= 100);
  const late = s.trend[s.trend.length - 1];
  assert.ok(Math.abs(early.bpm - 12) < 1, `early ${early.bpm}`);
  assert.ok(Math.abs(late.bpm - 20) < 1, `late ${late.bpm}`);
});

test('irregular frame timing still gives correct rate', () => {
  const s = new RespirationSession();
  let t = 0, prev = 0;
  while (t < 120) {
    const dt = 1 / 30 + (Math.sin(t * 7) > 0.8 ? 0.05 : 0);
    t += dt;
    const pos = -0.5 * Math.sin(2 * Math.PI * (10 / 60) * t);
    s.push(dt, pos - prev, 80);
    prev = pos;
  }
  assert.ok(Math.abs(s.currentRate().bpm - 10) < 0.7, `got ${s.currentRate().bpm}`);
});
