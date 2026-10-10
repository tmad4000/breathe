// Respiration signal processing. No DOM access, so it runs under Node for tests.
//
// Pipeline: per-frame vertical chest motion (block Lucas–Kanade) → integrate to
// displacement → resample to SAMPLE_HZ on an "active" clock that stops while
// tracking is paused → band-pass 0.08–0.9 Hz (≈5–54 breaths/min) → breath
// detection with hysteresis + spectral cross-check.

export const SAMPLE_HZ = 10;
const BAND_LO_HZ = 0.08;
const BAND_HI_HZ = 0.9;
const RATE_WINDOW_S = 30;
const TREND_EVERY_S = 10;
const MIN_BREATH_GAP_S = 1.1;

export function rgbaToGray(rgba, out) {
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    out[j] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  }
  return out;
}

// Median vertical flow (pixels/frame, +down) inside rect, estimated by
// Lucas–Kanade on a grid of blocks with a per-block brightness offset term so
// auto-exposure changes do not read as motion. Returns null without texture.
export function blockFlow(prev, cur, width, height, rect, gridX = 4, gridY = 4) {
  const x0 = Math.max(1, Math.floor(rect.x));
  const y0 = Math.max(1, Math.floor(rect.y));
  const x1 = Math.min(width - 1, Math.floor(rect.x + rect.w));
  const y1 = Math.min(height - 1, Math.floor(rect.y + rect.h));
  const bw = Math.floor((x1 - x0) / gridX);
  const bh = Math.floor((y1 - y0) / gridY);
  if (bw < 4 || bh < 4) return null;

  const flows = [];
  for (let gy = 0; gy < gridY; gy++) {
    for (let gx = 0; gx < gridX; gx++) {
      const bx0 = x0 + gx * bw, by0 = y0 + gy * bh;
      let n = 0, sx = 0, sy = 0, st = 0;
      let sxx = 0, sxy = 0, syy = 0, sxt = 0, syt = 0;
      for (let y = by0; y < by0 + bh; y++) {
        let i = y * width + bx0;
        for (let x = bx0; x < bx0 + bw; x++, i++) {
          const ix = (cur[i + 1] - cur[i - 1] + prev[i + 1] - prev[i - 1]) * 0.25;
          const iy = (cur[i + width] - cur[i - width] + prev[i + width] - prev[i - width]) * 0.25;
          const it = cur[i] - prev[i];
          n++; sx += ix; sy += iy; st += it;
          sxx += ix * ix; sxy += ix * iy; syy += iy * iy;
          sxt += ix * it; syt += iy * it;
        }
      }
      // Centre the sums: equivalent to solving for a per-block brightness offset.
      sxx -= sx * sx / n; sxy -= sx * sy / n; syy -= sy * sy / n;
      sxt -= sx * st / n; syt -= sy * st / n;
      const half = (sxx + syy) / 2;
      const lambdaMin = half - Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy);
      if (lambdaMin / n < 0.4) continue;
      const det = sxx * syy - sxy * sxy;
      flows.push((sxy * sxt - sxx * syt) / det);
    }
  }
  if (flows.length < 3) return null;
  flows.sort((a, b) => a - b);
  const m = flows.length >> 1;
  return flows.length % 2 ? flows[m] : (flows[m - 1] + flows[m]) / 2;
}

export class Biquad {
  static lowpass(fc, fs, q = Math.SQRT1_2) { return Biquad.#rbj(fc, fs, q, false); }
  static highpass(fc, fs, q = Math.SQRT1_2) { return Biquad.#rbj(fc, fs, q, true); }
  static #rbj(fc, fs, q, high) {
    const w0 = 2 * Math.PI * fc / fs, c = Math.cos(w0), alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    const b0 = (high ? (1 + c) : (1 - c)) / 2;
    const b1 = high ? -(1 + c) : (1 - c);
    return new Biquad(b0 / a0, b1 / a0, b0 / a0, (-2 * c) / a0, (1 - alpha) / a0);
  }
  constructor(b0, b1, b2, a1, a2) {
    Object.assign(this, { b0, b1, b2, a1, a2 });
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

// Respiratory rate from the dominant spectral peak of the last window of samples.
export function spectralRate(samples, fs = SAMPLE_HZ) {
  const n = samples.length;
  if (n < fs * 12) return null;
  let mean = 0;
  for (const v of samples) mean += v;
  mean /= n;
  let best = 0, bestF = 0, total = 0;
  for (let f = BAND_LO_HZ + 0.02; f <= BAND_HI_HZ; f += 0.005) {
    let re = 0, im = 0;
    for (let k = 0; k < n; k++) {
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * k / (n - 1));
      const v = (samples[k] - mean) * w;
      const ph = 2 * Math.PI * f * k / fs;
      re += v * Math.cos(ph); im -= v * Math.sin(ph);
    }
    const p = re * re + im * im;
    total += p;
    if (p > best) { best = p; bestF = f; }
  }
  return total > 0 ? { bpm: bestF * 60, confidence: best / total } : null;
}

export class RespirationSession {
  constructor() {
    this.activeS = 0;            // seconds of actual tracking
    this.cumDisp = 0;            // integrated chest displacement (% of box height, +up)
    this.lastDisp = 0;
    this.nextSampleS = 0;
    this.filters = [
      Biquad.highpass(BAND_LO_HZ, SAMPLE_HZ), Biquad.highpass(BAND_LO_HZ, SAMPLE_HZ),
      Biquad.lowpass(BAND_HI_HZ, SAMPLE_HZ), Biquad.lowpass(BAND_HI_HZ, SAMPLE_HZ),
    ];
    this.samples = [];           // filtered signal at SAMPLE_HZ
    this.breaths = [];           // active-clock seconds of each end-of-inhale peak
    this.trend = [];             // { t, wallMs, bpm }
    this.startedWallMs = Date.now();
    this.state = 'low';
    this.peakVal = -Infinity;
    this.peakT = 0;
  }

  // dt: seconds since previous tracked frame; flowPx: vertical flow (+down);
  // boxHeightPx: chest box height in the same pixel units.
  push(dt, flowPx, boxHeightPx) {
    const prevS = this.activeS;
    this.activeS += Math.min(dt, 0.25);
    this.lastDisp = this.cumDisp;
    this.cumDisp += (-flowPx / boxHeightPx) * 100;
    while (this.nextSampleS <= this.activeS) {
      const span = this.activeS - prevS;
      const a = span > 0 ? (this.nextSampleS - prevS) / span : 1;
      const raw = this.lastDisp + Math.max(0, Math.min(1, a)) * (this.cumDisp - this.lastDisp);
      this.#addSample(this.nextSampleS, raw);
      this.nextSampleS += 1 / SAMPLE_HZ;
    }
  }

  #addSample(t, raw) {
    let y = raw;
    for (const f of this.filters) y = f.process(y);
    this.samples.push(y);
    this.#detectBreath(t, y);
    if (this.samples.length % (TREND_EVERY_S * SAMPLE_HZ) === 0 && t >= RATE_WINDOW_S / 2) {
      const bpm = this.currentRate()?.bpm;
      if (bpm) this.trend.push({ t, wallMs: Date.now(), bpm });
    }
  }

  #detectBreath(t, y) {
    // Skip filter warm-up, then use an adaptive threshold from the recent RMS.
    if (t < 6) return;
    const win = this.samples.slice(-SAMPLE_HZ * 15);
    let ss = 0;
    for (const v of win) ss += v * v;
    const th = 0.45 * Math.sqrt(ss / win.length);
    if (this.state === 'low') {
      if (y > th) { this.state = 'high'; this.peakVal = y; this.peakT = t; }
    } else {
      if (y > this.peakVal) { this.peakVal = y; this.peakT = t; }
      if (y < -th) {
        this.state = 'low';
        const last = this.breaths[this.breaths.length - 1];
        if (last === undefined || this.peakT - last >= MIN_BREATH_GAP_S) this.breaths.push(this.peakT);
      }
    }
  }

  // Rate over the recent window: from breath intervals when there are enough
  // breaths, falling back to the spectral peak while warming up.
  currentRate() {
    const now = this.activeS;
    const recent = this.breaths.filter((b) => b >= now - RATE_WINDOW_S);
    const spec = spectralRate(this.samples.slice(-SAMPLE_HZ * RATE_WINDOW_S));
    if (recent.length >= 3) {
      const bpm = ((recent.length - 1) / (recent[recent.length - 1] - recent[0])) * 60;
      return { bpm, source: 'breaths', confidence: spec?.confidence ?? 0 };
    }
    if (spec && now >= 15) return { bpm: spec.bpm, source: 'spectrum', confidence: spec.confidence };
    return null;
  }

  averageRate() {
    const b = this.breaths;
    if (b.length < 3) return null;
    return ((b.length - 1) / (b[b.length - 1] - b[0])) * 60;
  }

  recentWaveform(seconds = 12) {
    return this.samples.slice(-SAMPLE_HZ * seconds);
  }

  summary() {
    const rates = this.trend.map((p) => p.bpm);
    return {
      startedAt: new Date(this.startedWallMs).toISOString(),
      durationS: this.activeS,
      breaths: this.breaths.length,
      avgBpm: this.averageRate(),
      minBpm: rates.length ? Math.min(...rates) : null,
      maxBpm: rates.length ? Math.max(...rates) : null,
      trend: this.trend,
      breathTimes: this.breaths,
    };
  }
}
