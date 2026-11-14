# Adaptive coach

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
