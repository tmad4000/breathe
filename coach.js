// Breath guide and adaptive coach. Times are seconds on any steady clock.
// No camera or DOM in here.
//
// The guide is always the chosen pattern, scaled as a whole: every stage
// (in, hold, out, hold) keeps its share, so the shape never changes, only its
// length. One number drives it: `cycle`, the seconds one whole breath takes.
//
//   Guide  (adaptive: false)  cycle is the pattern's own length from the start.
//   Coach  (adaptive: true)   opens with one long breath out, starts a shorter
//                             version of the pattern near the person's own
//                             pace, then lengthens it breath by breath to the
//                             full pattern. After the first catch the cycle
//                             never gets shorter: the guide can wait, but it
//                             cannot speed up.

const DROP_S = 4.5;              // the coach's opening breath out
const READY_S = 1.5;             // the guide's pause before its first breath in
const MIN_CYCLE_S = 6;           // the fastest any guide runs: 10 breaths/min
const STEP_S = 0.5;              // how much longer each breath gets while leading
const CATCH_WINDOW_S = 25;       // only this early may a catch shorten the cycle
const HOLD_LIMIT = 3;            // breaths to wait for someone out of step before moving on
const ease = (x) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, x)));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Seconds of [in, hold full, out, hold empty] at the destination.
export const PATTERNS = {
  '5-1-5-1': [5, 1, 5, 1],
  '5-0-5': [5, 0, 5, 0],
  '4-7-8': [4, 7, 8, 0],
};

export class Coach {
  constructor(now, { pattern = PATTERNS['5-1-5-1'], adaptive = true } = {}) {
    this.pattern = pattern;
    this.full = pattern.reduce((s, x) => s + x, 0);          // seconds of the full pattern
    this.minCycle = Math.min(this.full, MIN_CYCLE_S);
    this.adaptive = adaptive;
    this.cycle = adaptive ? clamp(0.7 * this.full, this.minCycle, this.full) : this.full;
    this.t0 = now;
    this.stage = adaptive ? 'drop' : 'guide';                // drop → find → match → lead → arrive
    this.sensed = false;         // true once measured turns are steering it
    this.caught = false;
    this.firstBpm = null;        // the person's pace when first caught
    this.holding = false;
    this.breathCount = 0;        // guided breaths completed
    this.log = [];               // what the coach did and why, for review
    this.segs = [adaptive
      ? { t0: now, t1: now + DROP_S, from: 1, to: 0, kind: 'out', wait: 0 }
      : { t0: now, t1: now + READY_S, from: 0, to: 0, kind: 'ready' }];
    this.turns = [];             // the person's judged turns: { t, exhale }
    this.hits = [];              // 1/0 for each recent guide turn they matched
    this.checked = this.segs[0].t1;
    this.breaths = 0;            // breaths since the last change of pace
    this.holds = 0;
    this.#note(now, 'start');
    this.#extend(now);
  }

  get bpm() { return 60 / this.cycle; }
  get target() { return 60 / this.full; }

  #note(now, ev, extra = {}) {
    const user = this.userCycle(now);
    this.log.push({ t: +(now - this.t0).toFixed(1), ev, cycle: +this.cycle.toFixed(2),
      user: user ? +user.toFixed(2) : null, sync: this.sync === null ? null : +this.sync.toFixed(2), ...extra });
    if (this.log.length > 400) this.log.shift();
  }

  // A turn the tracker judged: exhale = true when an inhale became an exhale.
  userTurn(t, exhale) {
    const last = this.turns[this.turns.length - 1];
    if (last && (t <= last.t || exhale === last.exhale)) return;
    this.turns.push({ t, exhale });
    if (this.turns.length > 12) this.turns.shift();
  }

  // Seconds per breath of the person, from their two latest whole breaths, or
  // null if unknown. The two must agree: a tracker's first turns after it locks
  // on, and stray wobbles, are often misplaced.
  userCycle(now) {
    const recent = this.turns.filter((u) => u.t > now - 30 && u.t > this.t0);
    const n = recent.length;
    if (n < 4) return null;
    const a = recent[n - 1].t - recent[n - 3].t, b = recent[n - 2].t - recent[n - 4].t;
    if (Math.abs(a - b) > 0.25 * Math.max(a, b)) return null;
    const c = (a + b) / 2;
    return c >= 2 && c <= 24 ? c : null;
  }

  userRate(now) { const c = this.userCycle(now); return c ? 60 / c : null; }

  // Is the tracker still delivering turns? (It goes quiet when the camera loses the person.)
  #tracking(now) {
    const last = this.turns[this.turns.length - 1];
    return this.sensed && !!last && now - last.t < Math.max(12, 1.5 * this.cycle);
  }

  // The camera was switched off (or on) by the person.
  setTracking(on, now) {
    if (!on) { this.sensed = false; this.hits = []; this.holding = false; this.turns = []; }
    this.#note(now, on ? 'tracking-on' : 'tracking-off');
  }

  // Share of the last few guide turns the person matched (0–1), or null.
  get sync() {
    return this.hits.length >= 2 ? this.hits.reduce((s, x) => s + x, 0) / this.hits.length : null;
  }

  // Stage lengths now: the pattern, scaled as a whole to the current cycle.
  durations() {
    const k = this.cycle / this.full, [a, h1, b, h2] = this.pattern;
    return { in: a * k, top: h1 * k, out: b * k, bottom: h2 * k };
  }

  // The guide stage in force at time t: { t0, t1, from, to, kind }.
  seg(t) {
    for (let i = this.segs.length - 1; i >= 0; i--) if (t >= this.segs[i].t0) return this.segs[i];
    return this.segs[0];
  }

  // Guide level 0 (empty) to 1 (full) at time t, past or planned.
  // straight = true gives straight-line stages instead of eased ones.
  level(t, straight = false) {
    const s = this.seg(t);
    const x = (t - s.t0) / (s.t1 - s.t0);
    return s.from + (s.to - s.from) * (straight ? clamp(x, 0, 1) : ease(x));
  }

  phase(t) { return this.seg(t).kind; }
  inhaling(t) { return this.seg(t).kind === 'in'; }

  // Plan stages at the current cycle until a few seconds past t.
  #extend(t) {
    for (;;) {
      const last = this.segs[this.segs.length - 1];
      const end = last.cut ?? last.t1;
      if (end > t + Math.max(9, this.cycle)) break;
      const d = this.durations();
      const add = (len, to, kind) => this.segs.push({ t0: end, t1: end + len, from: last.to, to, kind });
      if (last.kind === 'in') { last.wait = d.top; d.top > 0.05 ? add(d.top, 1, 'hold') : add(d.out, 0, 'out'); }
      else if (last.kind === 'out') { last.wait = d.bottom; d.bottom > 0.05 ? add(d.bottom, 0, 'hold') : add(d.in, 1, 'in'); }
      else last.to >= 0.5 ? add(d.out, 0, 'out') : add(d.in, 1, 'in');
    }
    while (this.segs.length > 2 && (this.segs[1].cut ?? this.segs[1].t1) < t - 25) this.segs.shift();
  }

  // Apply the current cycle after the breath out now in progress or next to come.
  #repace(now) {
    let i = this.segs.findIndex((s) => now < (s.cut ?? s.t1));
    if (i < 0) return;
    while (i < this.segs.length && this.segs[i].kind !== 'out') i++;
    this.segs.length = Math.min(this.segs.length, i + 1);
    this.#extend(now);
  }

  // Bend the plan so the guide's next full or empty point lands on the person's.
  // The guide keeps moving the way it is already going and arrives at that end
  // (completely full or completely empty), so it never turns back part-way.
  #align(now, userCycle) {
    const cur = this.seg(now);
    const from = this.level(now);
    const wantTop = cur.kind === 'in' || (cur.kind !== 'out' && cur.to === 0);
    const same = [...this.turns].reverse().find((u) => u.exhale === wantTop);
    let t = same ? same.t : this.turns[this.turns.length - 1].t + userCycle / 2;
    while (t < now + 0.8) t += userCycle;
    this.segs.length = this.segs.indexOf(cur) + 1;
    cur.cut = now;
    this.segs.push({ t0: now, t1: t, from, to: wantTop ? 1 : 0, kind: wantTop ? 'in' : 'out' });
    this.checked = t;                            // the bridge itself is not scored
    this.hits = [];
    this.breaths = 0;
    this.holds = 0;
    this.holding = false;
    this.#extend(now);
  }

  // Lengthen the breath by d seconds, never past the full pattern.
  #advance(now, d, why) {
    this.cycle = Math.min(this.full, this.cycle + d);
    this.#repace(now);
    if (this.cycle >= this.full - 1e-9) { this.cycle = this.full; this.stage = 'arrive'; this.#note(now, 'arrive'); }
    else this.#note(now, why);
  }

  // Call every frame.
  update(now) {
    this.#extend(now);
    if (!this.adaptive) { this.#score(now); return; }
    if (this.stage === 'drop' && now >= this.t0 + DROP_S) this.stage = 'find';

    const user = this.userCycle(now);
    if (!this.sensed && user && this.stage !== 'drop') {
      // First catch, early on: take their pace, within limits. Later, or after
      // the first time: measured turns may steer the guide but never shorten it.
      const early = !this.caught && now - this.t0 <= CATCH_WINDOW_S;
      const next = clamp(user, this.minCycle, this.full);
      this.firstBpm ??= 60 / user;
      this.sensed = true;
      if (early || next > this.cycle) {
        this.cycle = early ? next : Math.max(this.cycle, next);
        this.#align(now, user);
      }
      this.caught = true;
      this.#note(now, 'catch');
      if (this.stage !== 'arrive') { this.stage = this.cycle >= this.full ? 'arrive' : 'match'; this.breaths = 0; }
      return;
    }
    if (this.sensed && !this.#tracking(now)) {
      this.sensed = false; this.hits = []; this.holding = false;
      this.#note(now, 'tracking-lost');
    }
    if (this.stage === 'find' && now - this.t0 > 15) { this.stage = 'lead'; this.breaths = 0; this.#note(now, 'lead-untracked'); }
    this.#score(now);
  }

  // Score each guide turn (the end of an in or an out) once the person has had
  // time to make theirs. Their turn may fall anywhere in a hold that follows.
  #score(now) {
    const tol = clamp(0.15 * this.cycle, 0.5, 1);
    for (const s of this.segs) {
      if (s.cut || s.t1 <= this.checked) continue;
      const wait = s.kind === 'in' || s.kind === 'out' ? s.wait ?? 0 : 0;
      if (s.t1 + wait > now - tol) break;
      this.checked = s.t1;
      if (s.kind !== 'in' && s.kind !== 'out') continue;
      if (this.sensed) {
        const top = s.kind === 'in';
        this.hits.push(this.turns.some((u) => u.exhale === top && u.t >= s.t1 - tol && u.t <= s.t1 + wait + tol) ? 1 : 0);
        if (this.hits.length > 4) this.hits.shift();
      }
      if (s.kind === 'out') { this.breathCount++; if (this.adaptive) this.#breathDone(now); }
    }
  }

  #breathDone(now) {
    this.breaths++;
    if (this.stage === 'match') {
      if (this.breaths >= 2) { this.stage = 'lead'; this.breaths = 0; }
      return;
    }
    if (this.stage !== 'lead') return;
    const sync = this.sync, user = this.userCycle(now);
    // They have slowed past the guide on their own: go to them (toward the target).
    if (this.sensed && user && user > this.cycle + 1) {
      this.cycle = Math.min(this.full, user);
      this.#align(now, user);
      if (this.cycle >= this.full) { this.stage = 'arrive'; this.#note(now, 'arrive'); } else this.#note(now, 'slower-catch');
      return;
    }
    // In step means their turns land on the guide's and their pace is close to it;
    // turn timing alone can match by chance when the guide is much slower.
    const paceOk = !user || Math.abs(user - this.cycle) <= 0.2 * this.cycle;
    const following = !this.sensed || sync === null || (sync >= 0.5 && paceOk);
    // One step per breath when they are clearly with it, or when nobody is being
    // tracked (there is no one to wait for); every second breath when unsure.
    if (this.breaths < (!this.sensed || (sync !== null && sync >= 0.75) ? 1 : 2)) return;
    this.breaths = 0;
    if (following || this.holds >= HOLD_LIMIT) {
      // Either they are with it, or it has waited long enough: it always ends at the target.
      this.holding = false;
      if (following) this.holds = 0;
      this.#advance(now, STEP_S, following ? 'step' : 'step-after-wait');
      return;
    }
    this.holding = true;
    this.holds++;
    this.#note(now, 'hold');
  }
}
