# Saved breathing UI design — 2026-11-15

Jacob asked to preserve the current design before a camera-first Respiration
Tracker follow-up. This folder archives Fable's interactive mockup and actual
390px browser screenshots from the implementation. The screenshots show Coach,
not a real respiration camera session; they contain no person or camera data.

The mockup supports multiple mode and tracking-state simulations. It is design
reference, not an accuracy test or the final camera-first layout.

Provenance: Fable 2e8b269a, mockup-breathe.html; implementation cfd4bfbf;
root d3caa262 relayed Jacob's save request on 2026-11-15. Source screenshot
versions: initial/refined working-tree Coach, and live Breathe 0.12.1 (PR21,
ebca55cf328eb8d4d99d101b0597614a18cc0a55).

Follow-up direction: Respiration Tracker defaults to large camera coverage,
translucent rate/phase overlays and a slim trace at the bottom. A remembered
Chart focus option swaps to a large chart with a camera inset. Implemented from Fable's updated v2 camera-first mockup in Breathe0.13.0. Other modes retain their own layout.

`mockup-breathe-v2-camera-first.html` archives the updated design.
`camera-first-synthetic.png` and `chart-focus-synthetic.png` show the running
implementation with Chromium's synthetic green test camera. They contain no
real-person video and do not establish camera accuracy.
