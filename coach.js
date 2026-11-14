// Adaptive pacer. It opens with one long breath out, finds the person's own
// rhythm from their first judged turns, snaps the guide to it, then leads the
// pace down to a target, waiting or coming back whenever they fall out of step.
// Times are seconds on any steady clock. No camera or DOM in here.

const IN = 0.42;                 // inhale share of a guided breath
const DROP_S = 4.5;              // the opening breath out
const FIND_LIMIT_S = 15;         // lead on a schedule if no rhythm was found by then
const ease = (x) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, x)));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class Coach {
  constructor(now, { target = 6, startBpm = 10, maxBpm = 20 } = {}) {
    this.target = target;
    this.maxBpm = maxBpm;
    this.bpm = startBpm;         // the guide's pace
    this.t0 = now;
    this.stage = 'drop';         // drop → find → match → lead → arrive
    this.sensed = false;         // true once the guide is following measured turns
    this.firstBpm = null;        // the person's pace when first caught
    this.holding = false;
    this.segs = [{ t0: now, t1: now + DROP_S, from: 1, to: 0, inhale: false }];
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

  // The person's pace from their latest half-breaths, or null if unknown.
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
    return bpm >= 4 && bpm <= 30 ? bpm : null;
  }

  // Share of the last few guide turns the person matched (0–1), or null.
  get sync() {
    return this.hits.length >= 2 ? this.hits.reduce((s, x) => s + x, 0) / this.hits.length : null;
  }

  #seg(t) {
    for (let i = this.segs.length - 1; i >= 0; i--) if (t >= this.segs[i].t0) return this.segs[i];
    return this.segs[0];
  }

  // Guide level 0 (empty) to 1 (full) at time t, past or planned.
  // straight = true gives straight-line stages (for the path view) instead of eased ones.
  level(t, straight = false) {
    const s = this.#seg(t);
    const x = (t - s.t0) / (s.t1 - s.t0);
    return s.from + (s.to - s.from) * (straight ? Math.min(1, Math.max(0, x)) : ease(x));
  }

  inhaling(t) { return this.#seg(t).inhale; }

  // Plan breaths at the current pace until a few seconds past t.
  #extend(t) {
    for (;;) {
      const last = this.segs[this.segs.length - 1];
      const end = last.cut ?? last.t1;
      if (end > t + 9) break;
      const p = 60 / this.bpm;
      if (last.to === 0 && !last.cut) this.segs.push({ t0: end, t1: end + p * IN, from: 0, to: 1, inhale: true });
      else this.segs.push({ t0: end, t1: end + p * (1 - IN), from: this.level(end), to: 0, inhale: false });
    }
    while (this.segs.length > 2 && (this.segs[1].cut ?? this.segs[1].t1) < t - 20) this.segs.shift();
  }

  // Apply the current pace after the breath now in progress.
  #repace(now) {
    let i = this.segs.findIndex((s) => now < (s.cut ?? s.t1));
    if (i < 0) return;
    while (i < this.segs.length && this.segs[i].to !== 0) i++;
    this.segs.length = Math.min(this.segs.length, i + 1);
    this.#extend(now);
  }

  // Take the person's pace and bend the plan so the guide's next turn lands on theirs.
  #align(now, rate) {
    this.bpm = clamp(rate, this.target, this.maxBpm);
    const p = 60 / this.bpm;
    const u = this.turns[this.turns.length - 1];
    let t = u.t, top = u.exhale;                 // walk their predicted turns forward
    while (t < now + 0.8) { t += top ? p * (1 - IN) : p * IN; top = !top; }
    const cur = this.#seg(now);
    const from = this.level(now);
    this.segs.length = this.segs.indexOf(cur) + 1;
    cur.cut = now;
    this.segs.push({ t0: now, t1: t, from, to: top ? 1 : 0, inhale: top });
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

    // Score each guide turn once the person has had time to make theirs.
    const tol = clamp(0.15 * 60 / this.bpm, 0.5, 1);
    for (const s of this.segs) {
      if (s.cut || s.t1 <= this.checked) continue;
      if (s.t1 > now - tol) break;
      this.checked = s.t1;
      if (this.sensed) {
        const top = s.to === 1;
        this.hits.push(this.turns.some((u) => u.exhale === top && Math.abs(u.t - s.t1) <= tol) ? 1 : 0);
        if (this.hits.length > 4) this.hits.shift();
      }
      if (s.to === 0) this.#breathDone(now);
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
