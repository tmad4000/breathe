// Adaptive pacer. It opens with one long breath out, finds the person's own
// rhythm from their first judged turns, snaps the guide to it, then leads the
// pace down to a target pattern, waiting or coming back whenever they fall out
// of step. Times are seconds on any steady clock. No camera or DOM in here.

const DROP_S = 4.5;              // the opening breath out
const FIND_LIMIT_S = 15;         // lead on a schedule if no rhythm was found by then
const ease = (x) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, x)));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Seconds of [in, hold full, out, hold empty] at the destination.
export const PATTERNS = {
  '5-1-5-1': [5, 1, 5, 1],
  '5-0-5': [5, 0, 5, 0],
  '4-7-8': [4, 7, 8, 0],
};

export class Coach {
  constructor(now, { pattern = PATTERNS['5-1-5-1'], startBpm = 10, maxBpm = 20 } = {}) {
    this.pattern = pattern;
    this.target = 60 / pattern.reduce((s, x) => s + x, 0);   // breaths/min of the full pattern
    this.maxBpm = maxBpm;
    this.bpm = Math.max(startBpm, this.target);              // the guide's pace
    this.catchBpm = this.bpm;    // pace where the lead began; holds grow in from there
    this.t0 = now;
    this.stage = 'drop';         // drop → find → match → lead → arrive
    this.sensed = false;         // true once the guide is following measured turns
    this.firstBpm = null;        // the person's pace when first caught
    this.holding = false;
    // Every stage of the guide: kind is 'in', 'out' or 'hold'; the level runs from → to.
    this.segs = [{ t0: now, t1: now + DROP_S, from: 1, to: 0, kind: 'out', wait: 0 }];
    this.turns = [];             // the person's judged turns: { t, exhale }
    this.hits = [];              // 1/0 for each recent guide turn they matched
    this.checked = now + DROP_S; // guide turns up to here have been scored
    this.breaths = 0;            // guided breaths since the last change of pace
    this.holds = 0;
    this.#extend(now);
  }

  // A turn the tracker judged: exhale = true when an inhale became an exhale.
  userTurn(t, exhale) {
    const last = this.turns[this.turns.length - 1];
    if (last && (t <= last.t || exhale === last.exhale)) return;
    this.turns.push({ t, exhale });
    if (this.turns.length > 12) this.turns.shift();
  }

  // The person's pace from their latest whole breaths, or null if unknown.
  userRate(now) {
    const recent = this.turns.filter((u) => u.t > now - 25 && u.t > this.t0);
    const n = recent.length;
    if (n < 4) return null;
    // Whole breaths only (same kind of turn to same kind), so an uneven in:out
    // split does not bias it. The two latest must agree: a tracker's first
    // turns after it locks on are often misplaced.
    const a = recent[n - 1].t - recent[n - 3].t, b = recent[n - 2].t - recent[n - 4].t;
    if (Math.abs(a - b) > 0.25 * Math.max(a, b)) return null;
    const bpm = 60 / ((a + b) / 2);
    return bpm >= 2.5 && bpm <= 30 ? bpm : null;
  }

  // Share of the last few guide turns the person matched (0–1), or null.
  get sync() {
    return this.hits.length >= 2 ? this.hits.reduce((s, x) => s + x, 0) / this.hits.length : null;
  }

  // Stage lengths at the current pace. At the pace where the lead began there
  // are no holds, only the pattern's in:out balance; the holds grow to full
  // length as the pace comes down to the target.
  durations() {
    const [a, h1, b, h2] = this.pattern;
    const p = 60 / this.bpm, sum = a + h1 + b + h2;
    const span = this.catchBpm - this.target;
    const k = span > 1e-6 ? clamp((this.catchBpm - this.bpm) / span, 0, 1) : 1;
    const top = (h1 / sum) * p * k, bottom = (h2 / sum) * p * k, rest = p - top - bottom;
    return { in: (rest * a) / (a + b), top, out: (rest * b) / (a + b), bottom };
  }

  // The guide stage in force at time t: { t0, t1, from, to, kind }.
  seg(t) {
    for (let i = this.segs.length - 1; i >= 0; i--) if (t >= this.segs[i].t0) return this.segs[i];
    return this.segs[0];
  }

  // Guide level 0 (empty) to 1 (full) at time t, past or planned.
  // straight = true gives straight-line stages (for the path view) instead of eased ones.
  level(t, straight = false) {
    const s = this.seg(t);
    const x = (t - s.t0) / (s.t1 - s.t0);
    return s.from + (s.to - s.from) * (straight ? clamp(x, 0, 1) : ease(x));
  }

  phase(t) { return this.seg(t).kind; }
  inhaling(t) { return this.seg(t).kind === 'in'; }

  // Plan stages at the current pace until a few seconds past t.
  #extend(t) {
    for (;;) {
      const last = this.segs[this.segs.length - 1];
      const end = last.cut ?? last.t1;
      if (end > t + 9) break;
      const d = this.durations();
      const at = last.to;                        // 1 = full, 0 = empty
      const add = (len, to, kind) => this.segs.push({ t0: end, t1: end + len, from: at, to, kind });
      if (last.kind === 'in') { last.wait = d.top; d.top > 0.05 ? add(d.top, 1, 'hold') : add(d.out, 0, 'out'); }
      else if (last.kind === 'out') { last.wait = d.bottom; d.bottom > 0.05 ? add(d.bottom, 0, 'hold') : add(d.in, 1, 'in'); }
      else at >= 0.5 ? add(d.out, 0, 'out') : add(d.in, 1, 'in');
    }
    while (this.segs.length > 2 && (this.segs[1].cut ?? this.segs[1].t1) < t - 20) this.segs.shift();
  }

  // Apply the current pace after the breath out now in progress or next to come.
  #repace(now) {
    let i = this.segs.findIndex((s) => now < (s.cut ?? s.t1));
    if (i < 0) return;
    while (i < this.segs.length && this.segs[i].kind !== 'out') i++;
    this.segs.length = Math.min(this.segs.length, i + 1);
    this.#extend(now);
  }

  // Take the person's pace and bend the plan so the guide's next turn lands on theirs.
  #align(now, rate) {
    this.bpm = clamp(rate, this.target, this.maxBpm);
    this.catchBpm = this.bpm;
    const d = this.durations();                  // no holds at the catch pace
    const u = this.turns[this.turns.length - 1];
    const cur = this.seg(now);
    const from = this.level(now);
    // Keep moving the way the guide is already going and arrive at that end
    // (completely full or completely empty) on their next turn of that kind,
    // so the guide never turns back part-way.
    const wantTop = cur.kind === 'in' || (cur.kind === 'hold' && cur.to === 0);
    let t = u.t, top = u.exhale;                 // walk their predicted turns forward
    while (t < now + 0.8 || top !== wantTop) { t += top ? d.out : d.in; top = !top; }
    this.segs.length = this.segs.indexOf(cur) + 1;
    cur.cut = now;
    this.segs.push({ t0: now, t1: t, from, to: top ? 1 : 0, kind: top ? 'in' : 'out' });
    this.checked = t;                            // the bridge itself is not scored
    this.hits = [];
    this.breaths = 0;
    this.holds = 0;
    this.holding = false;
    this.sensed = true;
    this.stage = 'match';
    this.#extend(now);
  }

  // Call every frame.
  update(now) {
    this.#extend(now);
    if (this.stage === 'drop' && now >= this.t0 + DROP_S) this.stage = 'find';

    const rate = this.userRate(now);
    if (!this.sensed && rate && this.stage !== 'drop' && this.stage !== 'arrive') {
      this.firstBpm ??= rate;
      this.#align(now, rate);
      return;
    }
    if (this.stage === 'find' && now - this.t0 > FIND_LIMIT_S) { this.stage = 'lead'; this.breaths = 0; }

    // Score each guide turn (the end of an in or an out) once the person has
    // had time to make theirs. Their turn may fall anywhere in a hold that follows.
    const tol = clamp(0.15 * 60 / this.bpm, 0.5, 1);
    for (const s of this.segs) {
      if (s.cut || s.t1 <= this.checked) continue;
      const wait = s.kind === 'hold' ? 0 : s.wait ?? 0;
      if (s.t1 + wait > now - tol) break;
      this.checked = s.t1;
      if (s.kind === 'hold') continue;
      if (this.sensed) {
        const top = s.kind === 'in';
        this.hits.push(this.turns.some((u) => u.exhale === top && u.t >= s.t1 - tol && u.t <= s.t1 + wait + tol) ? 1 : 0);
        if (this.hits.length > 4) this.hits.shift();
      }
      if (s.kind === 'out') this.#breathDone(now);
    }
  }

  #breathDone(now) {
    this.breaths++;
    if (this.stage === 'match') {
      // Caught at the wrong pace (an early misread): catch again straight away.
      const seen = this.userRate(now);
      if (seen && Math.abs(seen - this.bpm) > 2) { this.#align(now, seen); return; }
      if (this.breaths >= 2) { this.stage = 'lead'; this.breaths = 0; }
      return;
    }
    if (this.stage !== 'lead') return;
    const sync = this.sync;
    // In step means their turns land on the guide's and their pace is close to it;
    // turn timing alone can match by chance when the guide is much slower.
    const rate = this.userRate(now);
    const paceOk = rate === null || Math.abs(rate - this.bpm) <= (this.bpm > 10 ? 2 : 1.6);
    const following = !this.sensed || sync === null || (sync >= 0.5 && paceOk);
    if (this.breaths < (this.sensed && sync !== null && sync >= 0.75 ? 1 : 2)) return;
    this.breaths = 0;
    if (following) {
      this.holds = 0; this.holding = false;
      this.bpm = Math.max(this.target, this.bpm - (this.bpm > 10 ? 1.5 : 1));
      this.#repace(now);
      if (this.bpm === this.target) this.stage = 'arrive';
      return;
    }
    // Out of step: wait here, and if it lasts, go back to their pace.
    this.holding = true;
    if (++this.holds < 2) return;
    if (rate && Math.abs(rate - this.bpm) > 1.5) this.#align(now, rate);
    else this.holds = 0;
  }
}
