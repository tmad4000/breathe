# Debug sessions

Source and route audit (2026-11-15): this is `tmad4000/breathe`, GitHub Pages
from `main` at `/`, served at https://jacobcole.ai/breathe/. GitHub's Pages API
and the live HTTPS route agree. `BoxBreathingApp` is a separate native timer;
`entrain` is a separate movement prototype. Neither is this camera coach.

## Capture boundary

Record derived breathing waveform, judged inhale/exhale transitions, estimated
rate, tracking validity, frame intervals/processing time, guide events, mode,
pattern, pace, pause/resume, visibility and coarse browser/camera capabilities.
No raw camera frames, face landmarks, pixel crops, microphone audio, device IDs,
camera labels or third-party analytics are needed for this debugging pass.
The existing two-minute raw camera clip is a separate explicit opt-in; debug
recording never enables it.

## Private means device-local

This static site has no authenticated server or telemetry backend. Debug data
stays in this browser's origin storage; it is not uploaded or available to the
site operator remotely. Review and export require access to this device/browser.
This is device-owner access, not a signed-in Jacob-only account boundary. Other
people using the same browser profile can access its stored sessions. Export is
an explicit user action. No recording data belongs in the public Git repository.

## Verification boundary

Linux checks cover JavaScript and sandboxed Chromium behavior. Camera signal
accuracy and iPhone audio behavior require real-device testing; Linux does not
verify macOS/iOS integration or clinical accuracy.

## Format and lifecycle

`private-session-store.js` is the shared dependency-free store vendored by
Harmony. Breathe's `debug-recorder.js` adapter captures named signal/event channels.
The 10 Hz signal event contains the projected trace, rate/phase, grid and a
`sourceFrames` batch of every source optical-flow vector with its original `dt`
and `scalePx`. This avoids losing displacement/time between the 10 Hz exports;
feed those source frames back through `RespirationSession.push` to replay.
No image data is stored. A final partial motion batch flushes on Stop.

Snapshots commit every two seconds and at Stop. An abrupt process kill can lose
the final two seconds. Recordings are limited to 60,000 events per take and
100 MB overall; reaching a limit stops debug capture with an explicit status.
Long sessions remain usable without debug recording. Keep protects age expiry;
unkept sessions are evicted oldest first to satisfy the cap. Kept-only overflow
stops capture rather than silently deleting pinned evidence.

Review includes a trace plot and event timeline. K marks a problem (M is mute).
Exports are a user action; agents cannot read the phone's browser database.
Private ingest is a later gated phase; no host routing or credentials change here.
