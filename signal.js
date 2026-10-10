// Respiration signal processing. No DOM access, so it runs under Node for tests.
//
// Pipeline: per-frame 2D motion of each block in a chest grid (Lucas–Kanade)
// → integrate each block/axis channel to displacement → resample to SAMPLE_HZ
// on an "active" clock that stops while tracking is paused → band-pass
// 0.08–0.9 Hz (≈5–54 breaths/min) per channel → project onto the first
// principal component of the recent window (captures chest rise, expansion
// toward the camera, or any mix) → breath detection + spectral cross-check.

export const SAMPLE_HZ = 10;
const BAND_LO_HZ = 0.08;
const BAND_HI_HZ = 0.9;
const RATE_WINDOW_S = 30;
const PCA_WINDOW_S = 30;
const PCA_CANDIDATES = 3;
const TREND_EVERY_S = 10;
const MIN_BREATH_GAP_S = 1.1;
const MIN_QUALITY = 0.25;     // spectral peak concentration
const MIN_SHARE = 0.2;        // variance share of the shared (breathing) motion
const DISPLAY_HP_HZ = 0.05;
const DISPLAY_LP_HZ = 1.5;

export function rgbaToGray(rgba, out) {
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    out[j] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  }
  return out;
}

// Lucas–Kanade flow (pixels/frame) for each block of a gridX×gridY grid over
// rect. Returns Float32Array [u0, v0, u1, v1, ...]; NaN where a block lacks
// texture. A per-block brightness offset term keeps auto-exposure out of it.
export function blockFlows(prev, cur, width, height, rect, gridX, gridY, minTexture = 0.2) {
  const out = new Float32Array(gridX * gridY * 2).fill(NaN);
  const x0 = Math.max(1, Math.floor(rect.x));
  const y0 = Math.max(1, Math.floor(rect.y));
  const x1 = Math.min(width - 1, Math.floor(rect.x + rect.w));
  const y1 = Math.min(height - 1, Math.floor(rect.y + rect.h));
  const bw = Math.floor((x1 - x0) / gridX);
  const bh = Math.floor((y1 - y0) / gridY);
  if (bw < 4 || bh < 4) return out;

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
      sxx -= sx * sx / n; sxy -= sx * sy / n; syy -= sy * sy / n;
      sxt -= sx * st / n; syt -= sy * st / n;
      const lambdaMin = (sxx + syy) / 2 - Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy);
      if (lambdaMin / n < minTexture) continue;
      const det = sxx * syy - sxy * sxy;
      const k = (gy * gridX + gx) * 2;
      out[k] = (sxy * syt - syy * sxt) / det;
      out[k + 1] = (sxy * sxt - sxx * syt) / det;
    }
  }
  return out;
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

const bandpass = () => {
  const stages = [
    Biquad.highpass(BAND_LO_HZ, SAMPLE_HZ), Biquad.highpass(BAND_LO_HZ, SAMPLE_HZ),
    Biquad.lowpass(BAND_HI_HZ, SAMPLE_HZ), Biquad.lowpass(BAND_HI_HZ, SAMPLE_HZ),
  ];
  return { process: (x) => stages.reduce((y, f) => f.process(y), x) };
};

// Dominant respiratory frequency of the window. quality = share of in-band
// power within ±0.04 Hz of the peak (1 = pure tone, ~0.1 = noise).
const hannCache = new Map();
function hann(n) {
  let w = hannCache.get(n);
  if (!w) {
    w = Float64Array.from({ length: n }, (_, k) => 0.5 - 0.5 * Math.cos(2 * Math.PI * k / (n - 1)));
    hannCache.set(n, w);
  }
  return w;
}

export function spectralRate(samples, fs = SAMPLE_HZ) {
  const n = samples.length;
  if (n < fs * 12) return null;
  let mean = 0;
  for (const v of samples) mean += v;
  mean /= n;
  const win = hann(n);
  const v = new Float64Array(n);
  for (let k = 0; k < n; k++) v[k] = (samples[k] - mean) * win[k];
  const freqs = [], powers = [];
  let best = 0, bestF = 0, total = 0;
  for (let f = BAND_LO_HZ + 0.02; f <= BAND_HI_HZ; f += 0.005) {
    // DFT bin by phasor rotation (no per-sample trig).
    const dc = Math.cos(2 * Math.PI * f / fs), ds = Math.sin(2 * Math.PI * f / fs);
    let c = 1, sn = 0, re = 0, im = 0;
    for (let k = 0; k < n; k++) {
      re += v[k] * c; im -= v[k] * sn;
      const nc = c * dc - sn * ds;
      sn = sn * dc + c * ds; c = nc;
    }
    const p = re * re + im * im;
    freqs.push(f); powers.push(p);
    total += p;
    if (p > best) { best = p; bestF = f; }
  }
  if (total <= 0) return null;
  let near = 0;
  freqs.forEach((f, i) => { if (Math.abs(f - bestF) <= 0.04) near += powers[i]; });
  return { bpm: bestF * 60, quality: near / total };
}

// Leading principal components of rows (each a channel vector), by power
// iteration with deflation, warm-started from inits so components and their
// signs stay stable between windows. share = fraction of total variance a
// component explains: high when the whole chest moves together, near 1/dim
// for independent noise.
export function principalComponents(rows, dim, k = 1, inits = []) {
  const cov = new Float64Array(dim * dim);
  for (const r of rows) {
    for (let i = 0; i < dim; i++) {
      const ri = r[i];
      if (ri === 0) continue;
      for (let j = i; j < dim; j++) cov[i * dim + j] += ri * r[j];
    }
  }
  for (let i = 0; i < dim; i++) for (let j = 0; j < i; j++) cov[i * dim + j] = cov[j * dim + i];
  let trace = 0;
  for (let i = 0; i < dim; i++) trace += cov[i * dim + i];
  if (!(trace > 0)) return [];

  const mul = (w) => {
    const out = new Float64Array(dim);
    for (let i = 0; i < dim; i++) {
      let s = 0;
      for (let j = 0; j < dim; j++) s += cov[i * dim + j] * w[j];
      out[i] = s;
    }
    return out;
  };
  const comps = [];
  for (let c = 0; c < Math.min(k, dim); c++) {
    let w = inits[c] ? Float64Array.from(inits[c]) : Float64Array.from({ length: dim }, (_, i) => Math.sin(i * 1.7 + c + 1));
    for (let it = 0; it < 40; it++) {
      const nw = mul(w);
      const norm = Math.hypot(...nw);
      if (!norm) return comps;
      w = nw.map((v) => v / norm);
    }
    const cw = mul(w);
    let lambda = 0;
    for (let i = 0; i < dim; i++) lambda += w[i] * cw[i];
    comps.push({ w, share: lambda / trace });
    for (let i = 0; i < dim; i++) for (let j = 0; j < dim; j++) cov[i * dim + j] -= lambda * w[i] * w[j];
  }
  return comps;
}

export function principalComponent(rows, dim, init) {
  return principalComponents(rows, dim, 1, init ? [init] : [])[0] ?? null;
}

// Light filtering for the on-screen line: drift removal plus smoothing with
// little delay, so the line moves with the breath you are taking now.
const displayFilter = () => {
  const rc = 1 / (2 * Math.PI * DISPLAY_HP_HZ), a = rc / (rc + 1 / SAMPLE_HZ);
  const lp = Biquad.lowpass(DISPLAY_LP_HZ, SAMPLE_HZ);
  let px = 0, py = 0;
  return { process: (x) => { py = a * (py + x - px); px = x; return lp.process(py); } };
};

export class RespirationSession {
  // channels: number of motion channels per frame (2 × blocks).
  // grid: { x, y } block layout (channels are [u, v] per block, row-major),
  // used to orient the signal so that inhaling reads as up.
  constructor(channels, { paceBpm = null, grid = null } = {}) {
    this.dim = channels;
    this.paceBpm = paceBpm;
    this.grid = grid;
    this.share = 0;
    this.candidates = [];
    this.activeS = 0;
    this.cum = new Float64Array(channels);       // integrated displacement per channel
    this.lastCum = new Float64Array(channels);
    this.nextSampleS = 0;
    this.filters = Array.from({ length: channels }, bandpass);
    this.displayFilters = Array.from({ length: channels }, displayFilter);
    this.display = [];           // lightly filtered projection for the waveform
    this.history = [];           // recent band-passed channel vectors (PCA window)
    this.weights = null;         // current projection (unit vector)
    this.samples = [];           // projected respiration signal at SAMPLE_HZ
    this.breaths = [];           // active-clock seconds of each detected breath
    this.trend = [];             // { t, wallMs, bpm, quality }
    this.startedWallMs = Date.now();
    this.state = 'low';
    this.peakVal = -Infinity;
    this.peakT = 0;
  }

  // dt: seconds since previous tracked frame; flows: per-channel flow (px/frame,
  // NaN = unknown); scalePx: chest box height in the same pixels.
  push(dt, flows, scalePx) {
    const prevS = this.activeS;
    this.activeS += Math.min(dt, 0.25);
    this.lastCum.set(this.cum);
    for (let c = 0; c < this.dim; c++) {
      const f = flows[c];
      if (Number.isFinite(f)) this.cum[c] += (-f / scalePx) * 100;
    }
    while (this.nextSampleS <= this.activeS) {
      const span = this.activeS - prevS;
      const a = span > 0 ? Math.max(0, Math.min(1, (this.nextSampleS - prevS) / span)) : 1;
      const x = new Float32Array(this.dim);
      let shown = 0;
      for (let c = 0; c < this.dim; c++) {
        const raw = this.lastCum[c] + a * (this.cum[c] - this.lastCum[c]);
        x[c] = this.filters[c].process(raw);
        const d = this.displayFilters[c].process(raw);
        if (this.weights) shown += this.weights[c] * d;
      }
      this.display.push(shown);
      if (this.display.length > SAMPLE_HZ * 60) this.display.shift();
      this.#addSample(this.nextSampleS, x);
      this.nextSampleS += 1 / SAMPLE_HZ;
    }
  }

  #addSample(t, x) {
    this.history.push(x);
    if (this.history.length > PCA_WINDOW_S * SAMPLE_HZ) this.history.shift();
    // Refresh the projection every second, skipping filter warm-up.
    if (this.history.length % SAMPLE_HZ === 0 && t >= 4) this.#updateWeights(t);
    let y = 0;
    if (this.weights) for (let c = 0; c < this.dim; c++) y += this.weights[c] * x[c];
    this.samples.push(y);
    this.#detectBreath(t, y);
    if (this.samples.length % (TREND_EVERY_S * SAMPLE_HZ) === 0 && t >= RATE_WINDOW_S / 2) {
      const r = this.currentRate();
      if (r) this.trend.push({ t, wallMs: Date.now(), bpm: r.bpm, quality: r.quality });
    }
  }

  // Pick, among the leading components, the one that looks most like breathing
  // (clearest periodicity), not simply the largest: hand shake or sway can carry
  // more variance than the breath. A small bonus for continuity avoids flipping.
  #updateWeights(t) {
    const rows = this.history.slice(t < 8 ? 0 : SAMPLE_HZ * 2); // drop the oldest edge-effect samples
    const comps = principalComponents(rows, this.dim, PCA_CANDIDATES, this.candidates);
    if (!comps.length) return;
    this.candidates = comps.map((c) => c.w);
    // Only components carrying a real share of the motion compete; a tiny but
    // perfectly regular wobble must not displace the breath.
    const eligible = comps.filter((c) => c.share >= MIN_SHARE);
    let pc = comps[0], bestScore = -Infinity;
    for (const c of eligible) {
      const series = rows.map((r) => { let y = 0; for (let i = 0; i < this.dim; i++) y += c.w[i] * r[i]; return y; });
      const periodic = spectralRate(series)?.quality ?? 0;
      let cont = 0;
      if (this.weights) { for (let i = 0; i < this.dim; i++) cont += c.w[i] * this.weights[i]; }
      const score = periodic + 0.08 * Math.abs(cont) + 0.01 * c.share;
      if (score > bestScore) { bestScore = score; pc = c; }
    }
    const w = Float64Array.from(pc.w);
    this.share = pc.share;
    if (!this.weights) { this.weights = this.#orient(w); return; }
    let dot = 0;
    for (let c = 0; c < this.dim; c++) dot += w[c] * this.weights[c];
    if (dot < 0) for (let c = 0; c < this.dim; c++) w[c] = -w[c];
    // Glide toward the new component so the output does not jump.
    const blended = this.weights.map((v, c) => 0.7 * v + 0.3 * w[c]);
    const norm = Math.hypot(...blended);
    this.weights = this.#orient(blended.map((v) => v / norm));
  }

  // On inhale the upper chest and shoulders rise in the image whether the chest
  // lifts or expands toward the camera, so make upward motion of the top half
  // positive. Channels hold upward displacement already (flow is negated).
  #orient(w) {
    if (!this.grid) return w;
    const { x: gx, y: gy } = this.grid;
    let score = 0;
    for (let row = 0; row < Math.ceil(gy / 2); row++) {
      for (let col = 0; col < gx; col++) score += w[(row * gx + col) * 2 + 1];
    }
    return score < 0 ? w.map((v) => -v) : w;
  }

  #detectBreath(t, y) {
    if (t < 8) return;
    const win = this.samples.slice(-SAMPLE_HZ * 15);
    let ss = 0;
    for (const v of win) ss += v * v;
    const th = 0.4 * Math.sqrt(ss / win.length);
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

  // Rate over the recent window. Breath-interval rate when it agrees with the
  // spectral peak; the spectral rate when only that is clean; null when the
  // signal is too noisy to trust.
  currentRate() {
    const now = this.activeS;
    if (now < 15) return null;
    if (this.dim >= 8 && this.share < MIN_SHARE) return null;
    const spec = spectralRate(this.samples.slice(-SAMPLE_HZ * RATE_WINDOW_S));
    if (!spec || spec.quality < MIN_QUALITY) return null;
    const recent = this.breaths.filter((b) => b >= now - RATE_WINDOW_S);
    if (recent.length >= 3) {
      const counted = ((recent.length - 1) / (recent[recent.length - 1] - recent[0])) * 60;
      if (Math.abs(counted - spec.bpm) / spec.bpm < 0.2) return { bpm: counted, source: 'breaths', quality: spec.quality, share: this.share };
    }
    return { bpm: spec.bpm, source: 'spectrum', quality: spec.quality, share: this.share };
  }

  // Session average from the trend (robust to stretches of missed breaths).
  averageRate() {
    if (this.trend.length) return this.trend.reduce((s, p) => s + p.bpm, 0) / this.trend.length;
    return this.currentRate()?.bpm ?? null;
  }

  recentWaveform(seconds = 12) {
    return this.display.slice(-SAMPLE_HZ * seconds);
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
      paceBpm: this.paceBpm,
      trend: this.trend,
      breathTimes: this.breaths,
      signal: this.samples.map((v) => Math.round(v * 1000) / 1000),
    };
  }
}
