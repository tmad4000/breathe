// Drain judged turns once, even after the signal's rolling 400-turn buffer fills.
// The source time, rather than the array index, identifies each transition.
export class BreathFeedback {
  lastTime = -Infinity;
  take(turns, valid) {
    const fresh = turns.filter(turn => turn.t > this.lastTime);
    if (fresh.length) this.lastTime = fresh.at(-1).t;
    return valid ? fresh : [];
  }
}
