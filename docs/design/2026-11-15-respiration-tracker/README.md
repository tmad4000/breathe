# Respiration Tracker design, saved 2026-11-15

Jacob on this design: "it's really pretty and we should probably save it."

This folder keeps the first layout mockup for breathe's Respiration Tracker as it stood on 2026-11-15, before the camera-first revision.

- `mockup-breathe-v1.html`: the interactive mockup (open in a browser; use the state buttons beside the phone).
- `v1-respiration-tracker-idle.png`, `-running.png`, `-blocked.png`: the mockup at 390 px wide.
- `build-0.12.1-respiration-tracker-idle.png`: the shipped 0.12.1 build in the same mode, for comparison.

What it shows: mode tabs with "Respiration Tracker", a large ring with the rate, a small camera tile top right, a large amber block when tracking cannot work, and on-screen chips for pace, Guide tone and Detection tone.

What changed afterwards: Jacob asked that the camera fill most of the screen by default. This look survives as the "Chart focus" option (big number and chart, small camera inset). The camera-first mockup is `mockup-breathe.html` in the design folder of the 2026-11-15 request.

Design: Fable (Paseo 2e8b269). The person and the breathing signal in the mockup are simulated.
