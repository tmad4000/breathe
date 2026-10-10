// npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockFlows, principalComponent, RespirationSession } from '../signal.js';

function texture(w, h, shiftX, shiftY) {
  const img = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const xx = x - shiftX, yy = y - shiftY;
    img[y * w + x] = 128 + 40 * Math.sin(xx * 0.31 + yy * 0.17) + 30 * Math.cos(yy * 0.23 - xx * 0.07) + 20 * Math.sin((xx + yy) * 0.11);
  }
  return img;
}

test('blockFlows recovers sub-pixel 2D shift and ignores brightness change', () => {
  const w = 96, h = 96, rect = { x: 8, y: 8, w: 80, h: 80 };
  const a = texture(w, h, 0, 0);
  for (const [sx, sy] of [[0, -0.4], [0.2, 0.15], [-0.3, 0.3]]) {
    const b = texture(w, h, sx, sy).map((v) => v + 6); // exposure bump
    const f = blockFlows(a, b, w, h, rect, 4, 4);
    for (let k = 0; k < f.length; k += 2) {
      assert.ok(Math.abs(f[k] - sx) < 0.06 && Math.abs(f[k + 1] - sy) < 0.06, `shift ${sx},${sy} got ${f[k]},${f[k + 1]}`);
    }
  }
});

test('blockFlows marks flat blocks as NaN', () => {
  const flat = new Float32Array(64 * 64).fill(100);
  const f = blockFlows(flat, flat, 64, 64, { x: 2, y: 2, w: 60, h: 60 }, 3, 3);
  assert.ok(f.every(Number.isNaN));
});

test('principalComponent finds the dominant direction', () => {
  const dir = [0.6, -0.8, 0];
  const rows = Array.from({ length: 200 }, (_, i) => {
    const s = Math.sin(i * 0.3);
    return dir.map((d) => d * s + 0.01 * Math.cos(i * 1.7));
  });
  const { w } = principalComponent(rows, 3);
  assert.ok(Math.abs(Math.abs(w[0] * dir[0] + w[1] * dir[1]) - 1) < 0.01);
});

// Simulated chest grid: `pattern(block)` gives each block's motion direction
// for one unit of breathing; noise channels and dead blocks are mixed in.
function simulate(bpmAt, seconds, { pattern, blocks = 30, fps = 30, noise = 0.03, seed = 1, sway = 0 } = {}) {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5);
  const session = new RespirationSession(blocks * 2, { grid: { x: 6, y: blocks / 6 } });
  const boxH = 120, amp = 0.8;
  let phase = 0, prev = 0, prevSway = 0;
  for (let i = 1; i <= seconds * fps; i++) {
    const t = i / fps;
    phase += 2 * Math.PI * (bpmAt(t) / 60) / fps;
    const pos = -amp * Math.sin(phase);
    const swayPos = sway * Math.sin(2 * Math.PI * 0.05 * t); // slow drift
    const d = pos - prev, ds = swayPos - prevSway;
    prev = pos; prevSway = swayPos;
    const flows = new Float32Array(blocks * 2);
    for (let b = 0; b < blocks; b++) {
      const [px, py] = pattern(b, blocks);
      flows[2 * b] = px * d + ds + noise * rand();
      flows[2 * b + 1] = py * d + ds + noise * rand();
      if (b % 7 === 3) { flows[2 * b] = NaN; flows[2 * b + 1] = NaN; } // textureless
    }
    session.push(1 / fps, flows, boxH);
  }
  return session;
}

const vertical = () => [0, 1];
// Expansion toward the camera: top rows move up, bottom rows move down, sides spread.
const zoom = (b, n) => {
  const cols = 6, rows = n / cols, gx = b % cols, gy = Math.floor(b / cols);
  return [(gx - (cols - 1) / 2) / cols, (gy - (rows - 1) / 2) / rows];
};

test('tracks a steady 15 bpm for 5 minutes (no time cap)', () => {
  const s = simulate(() => 15, 300, { pattern: vertical });
  const r = s.currentRate();
  assert.ok(Math.abs(r.bpm - 15) < 0.7, `got ${r.bpm}`);
  assert.ok(Math.abs(s.breaths.length - 73) <= 4, `breaths ${s.breaths.length}`);
  assert.ok(s.trend.length >= 25);
});

test('handles chest expansion toward the camera (zero net vertical motion)', () => {
  const s = simulate(() => 12, 120, { pattern: zoom });
  const r = s.currentRate();
  assert.ok(r && Math.abs(r.bpm - 12) < 0.8, `got ${r?.bpm}`);
});

test('follows a rate change from 12 to 20 bpm', () => {
  const s = simulate((t) => (t < 120 ? 12 : 20), 240, { pattern: vertical });
  const early = s.trend.find((p) => p.t >= 100);
  const late = s.trend[s.trend.length - 1];
  assert.ok(Math.abs(early.bpm - 12) < 1, `early ${early.bpm}`);
  assert.ok(Math.abs(late.bpm - 20) < 1, `late ${late.bpm}`);
});

test('reports no rate for pure noise', () => {
  const s = simulate(() => 15, 60, { pattern: () => [0, 0], noise: 0.2 });
  const r = s.currentRate();
  assert.ok(r === null || r.quality < 0.4, `noise gave ${JSON.stringify(r)}`);
});

test('waveform reads inhale as up and keeps pace with the breath', () => {
  // Inhale = upper chest highest in the image. pos = -amp*sin(phase) scales each
  // block's motion; for vertical the top rises most at phase π/2, for zoom (top
  // rows have negative py) at 3π/2.
  for (const [pattern, inhalePhase] of [[vertical, Math.PI / 2], [zoom, 3 * Math.PI / 2]]) {
    const s = simulate(() => 12, 60, { pattern, noise: 0.01 });
    const wave = s.recentWaveform(10);
    const t0 = 60 - wave.length / 10;
    let best = -Infinity, bestT = 0;
    wave.forEach((v, i) => { if (v > best) { best = v; bestT = t0 + i / 10; } });
    const phase = (2 * Math.PI * (12 / 60) * bestT) % (2 * Math.PI);
    const lagS = (((phase - inhalePhase) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) * 5;
    assert.ok(lagS < 0.6 || lagS > 4.8, `${pattern.name}: waveform peak lags inhale peak by ${lagS.toFixed(2)} s`);
  }
});

test('irregular frame timing still gives correct rate', () => {
  const s = new RespirationSession(2);
  let t = 0, prev = 0;
  while (t < 120) {
    const dt = 1 / 30 + (Math.sin(t * 7) > 0.8 ? 0.05 : 0);
    t += dt;
    const pos = -0.5 * Math.sin(2 * Math.PI * (10 / 60) * t);
    s.push(dt, [0.001 * Math.sin(t * 13), pos - prev], 80);
    prev = pos;
  }
  assert.ok(Math.abs(s.currentRate().bpm - 10) < 0.7, `got ${s.currentRate()?.bpm}`);
});
