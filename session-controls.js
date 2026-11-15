// Display vocabulary only. Stored mode IDs and session records stay compatible.
export const MODE_NAMES = Object.freeze({coach:'Adaptive breathing',guide:'Fixed breathing',respiration:'Respiration Tracker',finger:'Coherence · fingertip',remote:'Coherence · hands-free',dual:'Coherence · two cameras'});
export const modeName = id => MODE_NAMES[id] ?? id;
export const PATTERN_NAMES = Object.freeze({
  '5-1-5-1': {short:'5–1–5–1',full:'5 seconds in, hold 1, 5 out, hold 1'},
  '5-0-5': {short:'5–5',full:'5 seconds in, 5 out, no holds'},
  '4-7-8': {short:'4–7–8',full:'4 seconds in, hold 7, 8 out'},
});
export const PACES = Object.freeze(['0','5','5.5','6','8','10','12','15','20']);
export function nextPaceBoundary(now, start, bpm) {
  const cycle = bpm ? 60000 / bpm : 0;
  return cycle ? start + (Math.floor(Math.max(0, now - start) / cycle) + 1) * cycle : now;
}
