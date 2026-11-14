# Adaptive coach

**v0.10.0 redesign (2026-11-13), after Jacob's first real sessions.** His notes: the line should
keep its natural shape wherever you are in the breath; a 5-1-5-1 pattern should show its flat
holds; the guide once drove the pace up to about 20/min; it should start where you are and slow
you down, always converging on a target pattern; and there should be a plain guide that does not
respond at all, usable with no camera. What changed:

- One number, `cycle` (seconds per breath), scales the whole pattern. Shape is constant.
- Guide mode: fixed pattern, no camera. Coach: starts at clamp(your cycle, 6 s, full) and adds
  0.5 s per breath; after the first catch (first 25 s) the cycle is a ratchet and never shortens.
- Out of step: wait up to three breaths, then continue. It always arrives.
- Display: the line is never bent toward the person. Ball = guide, ring = you.
- Camera failure or "Tracking off" degrades to guiding; `Coach.log` records every decision.
- The 20/min run: the old engine re-caught upward to any measured pace up to 20/min, so noisy
  turn detection could ratchet it up. That path no longer exists; `test/coach.test.mjs` has a
  jitter case for it. We have no log of that session, which is why logging was added.

Ideas not built yet: an ending (a slow closing breath and a one-line result rather than running
until Stop); exhale-lengthening as its own destination; a resonance finder that sweeps 6.5 to
4.5/min and keeps where heart rate swings most; a 60-second "reset" entry for scroll-breaking;
spoken cues; a session history view that plots start pace against end pace over days.

**Built in v0.6.0 (2026-11-13):** engine (`coach.js`) and Lane view, resonance
destination only. Changed from the proposal below at Jacob's direction ("catch
you faster and drop you in; the point is to break out of scrolling"): no silent
Listen stage. It opens with one long breath out, catches the pace from the first
two agreeing breaths, and steps every breath while in step. `?coach` starts it
on load. Still to do: other destinations and holds, end summary, fingertip
variant, Rings view. Not yet tried on a real phone.

## Original proposal

Not built at the time of writing. Design page with live mockups: https://claude.ai/artifact/V4dCRjGHunWdmw7Sf1enWD
(private to Jacob's account).

**Idea:** the guide starts at the breath the person already has and leads from
there. Stages: Listen (30–45 s, no guide, measure rate and in:out ratio) →
Match (pacer at their rate, in step with their turns) → Lead (slow about
0.5/min after each few followed breaths; hold when they lag; step back when
they lose it) → Arrive (hold the target pattern).

**Following:** uses the judged inhale/exhale turns shipped in v0.4.3
(`RespirationSession.turns`). A turn within about 15% of a cycle of the pacer's
turn is in step; sync is the in-step share over the last four breaths. Starting
thresholds, untuned: above 75% advance, 50–75% hold, below 50% twice go back.

**Destinations:** resonance 5.5–6/min (default), long exhale 4:8, box 4-4-4-4,
4-7-8. Bridges change one thing at a time: rate, then ratio, then holds growing
0 → 1 → 2 → 4 s.

**Sensing by mode:** respiration and hands-free see the chest, so the loop
reacts within a breath or two. Fingertip cannot see the breath (browsers give a
page one camera at a time, and the rear camera is used because the torch is
there); it would lead on a schedule and use coherence as the check.

**Views:** Lane (guide scrolls to a now-line, your breath is a dot;
recommended first), Rings (calm, eyes half closed), Column (a filling bar).

**Build order:** 1. `coach.js` engine as a pure, unit-tested module. 2. Lane
view as a fourth mode. 3. Destinations, bridges with holds, end summary.
4. Fingertip variant, Rings, resonance finder.

**Open decisions (Jacob):** which view first; default destination or ask by
goal; spoken cues or tones only.
