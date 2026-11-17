# Breathe — continuous camera respiration tracker

A web app that works like Google Fit's camera respiratory-rate check, but
**keeps running for as long as you want** instead of stopping after 30–60 s.

**Use it:** https://jacobcole.ai/breathe/ — open in Safari on an iPhone
(or any phone browser), allow the camera, then Share → Add to Home Screen.

## Current session controls (v0.14.0)

The top menu stays in the same place before, during and after a pause:
**Adaptive breathing**, **Fixed breathing**, **Respiration Tracker**,
**Coherence · fingertip**, and **Coherence · hands-free**. Adaptive breathing
slows gradually toward a target; without camera tracking it follows a schedule.
Fixed breathing follows the selected timing and never requests a camera.
Existing `?coach` / `?guide` links and saved mode IDs remain compatible.

One current-value **Pattern** or **Pace** button above Start/Pause/Resume opens
the choices without moving the view. Changes wait for the next breath boundary,
including after Resume, with five seconds to Undo. The speaker opens **Sound**:
master mute, guide tone and detected breath ticks. M still mutes globally;
muting preserves each tone preference and does not alter guide timing.
Settings links open these same controls. The tiny debug indicator opens local
recording details; recording continues to log events while a session is paused.

The design handoff is [DECISION.md](https://github.com/tmad4000/breathe/blob/main/docs/design/stable-session-controls.md).
The older version notes below describe earlier releases, not the current UI.

## How it works

Same idea as Google's: the front camera follows the small rise and fall of your
chest (optical flow). Everything runs on the phone; no video leaves the device. During debugging, derived breathing signals and app events save automatically in this browser (no video or audio); the visible Debug control turns this off and opens local review, export and deletion. Nothing is uploaded. Debug history lasts 14 days or up to 100 MB; Pinned sessions are never auto-deleted. The age and 100 MB cap apply to unpinned sessions.

1. **Find you:** MediaPipe face detector (`@mediapipe/tasks-vision` 1.0.1,
   vendored in `vendor/`, BlazeFace short-range model in `models/`) finds your
   face every 4th frame. A chest box is placed below the chin, about 2.6 face
   widths wide. The box stays put unless you move.
2. **Measure motion:** the chest box is cropped from the 720p camera feed at
   200 px wide, so sub-millimetre motion is still measurable. Lucas–Kanade
   optical flow gives 2D motion for each block of a 6×5 grid (60 channels),
   with a brightness-offset term so auto-exposure is ignored.
3. **Combine:** each channel is integrated into displacement, resampled to
   10 Hz on an "active" clock that pauses when you're out of frame, and
   band-passed to 0.08–0.9 Hz (≈5–54 breaths/min). The respiration signal is
   whichever of the top 3 principal components of the last 30 s (among those
   carrying ≥20% of the motion) is most periodic. That captures the chest
   lifting, expanding toward the camera, or any mix, and avoids locking onto
   hand sway that carries more motion than the breath. It is oriented so that the
   upper chest rising (inhale) reads as up. The on-screen line uses lighter,
   low-delay filtering so it moves with the breath you're taking now.
4. **Rate and quality:** breaths are counted at end-of-inhale peaks. The
   current rate (last 30 s) is the counted rate when it agrees with the
   spectral peak, otherwise the spectral peak. "--" shows when the signal is
   weak: the shared chest motion explains <20% of the variance or the spectrum
   has no clear peak. It also blanks the moment tracking is lost or you move,
   and returns only after 5 s of steady tracking. Every 10 s the rate is logged
   to a trend.

**Checking accuracy:** choose Guide pace from the Pace button above Start. Follow the ring
in and out at a known pace (e.g. 10/min); soft tones mark each breath in and
out, so you can follow it without watching. The measured rate should match.
Turn on "Record the first 2 minutes" to save a clip you can share for tuning,
then replay it with `?src=`.

**Coach (v0.6.0):** Mode → Coach, or open `https://jacobcole.ai/breathe/?coach`
to start it straight away (for a home-screen icon or an iOS Shortcut). It opens
with one long breath out, reads your pace from your first agreeing breaths
(about 12–15 s in), sets the guide to your rhythm, then slows it toward 6/min:
one step per breath while you are clearly in step, every second breath
otherwise. If you fall out of step it holds, and if that lasts it comes back to
your pace. With no tracking it still guides, on a schedule. The view is a lane:
the blue guide scrolls toward a "now" line and your breath is the white trace
and dot, over a dimmed camera picture. The logic is `coach.js` (pure, tested in
`test/coach.test.mjs` against simulated people). Thresholds are first guesses.

**v0.9.0, settings and updates:** the top-left gear opens Settings & history
(settings first). Next to it is the running version in small grey text. When a
newer version is deployed, that text becomes **Update · tap to reload**. It never
reloads by itself, and tapping it ends a running session the usual way (saving
it) before reloading. The page checks `version.json` on load, every 10 minutes
and when the tab comes back into view. The checks are silent when offline and
never offer an older version. Releases bump the version in `package.json`,
`version.json` and `VERSION` in `app.js` together; `npm test` fails if they
differ.

**v0.11.0, calmer controls:** a speaker button at the top turns all sound on or
off (also the M key; remembered on this device). Guide could be silent on iPhones:
iOS mutes Web Audio with the silent switch, so a session now asks for the
"playback" audio session (iOS 17+, or one silent media play on older iOS) and
starts the AudioContext inside the Start tap; if the browser still holds sound
back (e.g. `?guide` opened with no tap) the speaker turns amber and any tap lets
it play. Stop shows a small "Session saved" card over the stage with Details,
instead of opening the summary sheet. Sheets have a fixed header with a close
button and also close with Esc, a tap outside or a swipe down. The camera-switch
button only appears in Respiration. In Coach the camera keeps one fixed slot top
right: switching tracking off leaves a quiet "Tracking off" tile there, so the
lane does not move. The mode menu always shows a chevron, and the pattern chips
are captioned "Pattern · tap to switch". `node test/ux-e2e.mjs` checks all of this.

**v0.10.1, start screen, camera tile, your own in/out:** Guide and Coach are one
dark screen. Before Start it shows the pattern large, chips to switch pattern, and
one line about what will happen; the white card is gone in these modes, and on
wide windows the other modes keep a narrow column. With tracking on, the camera
is a small tile at the top right with the face and chest boxes and a plain
status under it ("Face and chest in view", "Move back: chest not in view",
"Looking for you", "Hold still"); Settings can hide the tile, the status stays.
Your ring says which way your own breath is going ("you ↑ in"). Settings also
has an optional short tick for your own breath turning, distinct from the
guide's soft tones.

**v0.10.0, Guide and a redesigned Coach** (this replaces the coach behaviour
described in the older paragraphs below):

- **Guide (no camera)** plays the chosen pattern and nothing else. It never asks
  for the camera and does not respond to you. `?guide` starts it on load.
- **Coach** shows the same line. It opens with one long breath out, measures
  your pace, and starts a *shorter version of the same pattern* near it (never
  faster than 10 breaths/min), then lengthens the breath by half a second at a
  time until it is the full pattern. After the first catch the breath only ever
  gets longer: the guide can wait for you (at most three breaths), but it cannot
  speed up, and it always ends at the target.
- **The line never bends.** It is the pattern itself: up, flat hold, down, flat
  hold, always from completely empty to completely full, with holds at every
  pace. The yellow ball rides the line; a white ring marked "you" shows your
  measured breath when the camera has you.
- **No camera is not an error.** If the camera fails, Coach carries on as a
  guide. The "Tracking on/off" button on the stage releases or reopens the
  camera mid-session.
- **Session log.** Every guided session saves what the guide did and why
  (caught pace, each longer breath, waiting, tracking lost). Open a session in
  History → "What the guide did", or export the CSV (rows of type `coach`).

**v0.8.0, coach patterns and full-height targets:** Settings → Coach pattern
chooses the destination: 5 in · hold 1 · 5 out · hold 1 (default), 5 in · 5 out,
or 4-7-8. At your own pace there are no holds; they grow to full length as the
pace comes down. Every guided breath goes completely full and completely empty:
the line ahead starts at your ball but always runs to the full top or bottom
line, and the guide never turns back part-way, even while catching you.

**v0.7.0:** Coach is the default mode (the app reopens in the mode used last).
Its default view is **Path**, after the breathing videos with a thick line of
up and down stages, a ball and a big word: the ball is your own breath, and the
line ahead starts at the ball and bends back onto the guide, so it shows where
to go from where you are. Settings → Coach view switches to the smooth Lane.
A landscape camera (a laptop) is now shown whole instead of cropped, so the
face and chest boxes are fully on screen.

**Fixed axis:** the breath line is drawn against a visible resting line and an
in/out scale that stay put; the frame is taken from the chest box, which only
moves when you do, not from the face box.

**Breath line size:** Settings → Breath line. "Large" (default) draws
the line across both boxes, "Fills the chest box" keeps it inside the lower
box, "Small" is the compact upper-chest line. It always stays above the
Pause/Stop buttons.

**Seeing what it judged:** each time the tracker decides a breath has turned,
it marks the spot on the breath line (solid dot: inhale became exhale; open dot:
exhale became inhale), the ring flashes, and the ring and chest box say "in" or
"out". The turn is called once the line has come back from its extreme by a
margin scaled to recent breath size, so it trails the real turn by roughly a
tenth of a breath. The breath count still uses the stricter peak detector.

Sessions save to `localStorage` (History). The summary shows the trend chart
and exports CSV through the iOS share sheet. Screen Wake Lock keeps the phone
awake. If iOS kills the camera when you switch apps, it restarts when you come back.

## Run

```bash
./serve.py 8968                      # loopback static server (no-cache)
tailscale serve --bg --https=8968 http://127.0.0.1:8968   # HTTPS for the camera
```

Any static host over HTTPS works (the camera needs a secure origin). Production
is GitHub Pages from `main`.

## Test

```bash
npm test                                         # signal-processing unit tests
test/make-fixtures.sh path/to/screenshot.png     # synthetic breathing clips (ffmpeg)
node test/e2e.mjs http://127.0.0.1:8968/ test/fixtures/b15.mp4 15 60
node test/update-e2e.mjs                         # version text and update notice
node test/ux-e2e.mjs                             # sound switch, stop card, sheets, fixed coach slot
```

Browser tests use the global `playwright` and installed Chrome by default.
Elsewhere, set `PLAYWRIGHT_MODULE=/path/to/node_modules/playwright-core` and
`BROWSER_PATH=/path/to/chrome`. Browser tests require the Chromium sandbox; they reject `--no-sandbox`.

`?src=clip.mp4` replaces the camera with a looping video file, which is useful
for end-to-end tests and for analyzing recorded clips. Chrome's fake camera
can't be used for rate tests: in headless mode it delivers about 5 fps and its
content clock runs slow.

Verified 2026-10-10 (v0.3.0): 15 → 15.00, 24 → 24.10, 9 bpm with ±1.5 px
whole-frame sinusoidal sway → 9.13, 12 bpm chest expansion → 12.00. Synthetic
clips only; real-phone accuracy still needs guided sessions. Background research
(Google's published method, open-source code, handheld evidence):
`docs/research-camera-respiration.md`.

Not a medical device.

## Coherence prototype (v0.4.3)

Choose **Coherence · fingertip** for rear-camera contact PPG, HR, pulse-interval RMSSD and a 64-second spectral coherence ratio. Cover the lens gently; the torch is enabled when supported, otherwise use bright light. Choose **Coherence · hands-free** for experimental face POS pulse estimation alongside chest respiration. Its score combines slow HR spectral concentration and segmented breath–heart coherence; it does not report beat-level RMSSD. Neither mode is calibrated to HeartMath devices.

Signal loss, pauses and poor-quality windows blank estimates. Brief analysis failures retain history; gaps of three seconds or more invalidate continuity. Scores need a valid 64-second window after pulse acquisition. Hands-free HR and breathing rate display independently before coherence becomes available. Settings provides 5, 5.5 and 6 breaths/min pacing with existing ring/audio cues. Coherence sessions currently display live only; respiration history/export remains unchanged. Stop releases camera and torch.

Validation design and real-device comparison plan: [docs/coherence-design.md](docs/coherence-design.md). Unit tests: `npm test`. Synthetic clip browser test: `node test/coherence-e2e.mjs` with the local server running and `test/fixtures/pulse72.mp4` generated as documented in the test. Camera accuracy on actual phones is unvalidated.

Fingertip ring: heart rate during warmup, coherence ratio when available; the arc continues following the breathing guide. Warmup shows the seconds of usable signal still needed. Contact beat times are refined against original video sample timestamps. The constant-72-bpm clip regression requires RMSSD below 10 ms; this is not an accuracy guarantee for phone cameras.

## iOS shell: two cameras at once (`ios/`, unbuilt as of 2026-11-13)

A browser gets one camera at a time. The shell in `ios/` is a small Swift app
that shows this same web app in a web view and runs the front and rear cameras
together (`AVCaptureMultiCamSession`, iPhone XS/XR or later). Inside it the
mode menu gains **Coherence · two cameras**: hold the phone facing you with a
fingertip on the rear lens. The front camera follows your chest for breathing;
the rear camera and torch read your pulse beat by beat.

- The page asks for the cameras with `webkit.messageHandlers.breathe.postMessage({cmd: 'start' | 'stop'})`.
- The shell calls `__breatheNative.frame(jpegBase64, seconds)` with front frames
  (480 px wide, one at a time) and `__breatheNative.pulse(seconds, r, g, b)` with
  the mean colour of the centre of each rear frame.
- The shell loads the live site, so web updates reach it without an app update.
  `-BreatheURL https://…` as a launch argument points it at a dev server.

Build: `cd ios && xcodegen generate`, then open `Breathe.xcodeproj` in Xcode
and run on a phone (the simulator has no cameras). `node test/native-e2e.mjs`
checks the page's side of the bridge in Chrome with a stand-in for the shell.

Status: the page side is tested. The Swift has only been syntax-checked, never
compiled against the iOS SDK or run on a phone. To verify on a device: torch
works while both cameras run, the fingertip colour is not clipped, frame rate
holds near 30, and the phone does not get hot.

## v0.12.0: debugging and accuracy controls

Respiration Tracker has on-screen guide pace, guide-tone mute and detected
inhale/exhale ticks. The top speaker remains master mute. Pattern and pace
changes keep the session and apply after the current breath, with Undo. Mode
changes save even short sessions and continue in a new linked session; while
paused, switching leaves the new mode ready for Start. Tracking failures show
an actionable large message in tracking-dependent modes and a quiet advisory
in Coach. Debug sessions are device-local, not an authenticated remote owner
dashboard: anyone using the same browser profile can review them. See
[debug recording boundaries](docs/debug-recording.md).

The Settings **Send feedback** link is part of Jacob's separate feedback rollout.
It loads World Issue Tracker code only when tapped and opens the Breathe board.
Ordinary app use makes no request to WIT. Submitting feedback is an explicit user
action; debug recordings are not attached or uploaded by this integration.

## v0.13.0: camera-first Respiration Tracker

The camera fills the Tracker view by default. Rate, phase and session readings
float above it, with a slim breath trace along the bottom. While running, Tune
opens the pace and tone controls without taking height from the camera.
**Chart focus** swaps to a large trace and small camera inset; **Camera** switches
back. This preference is remembered for Respiration Tracker only. Coach, Guide
and Coherence retain their own views. The original design and the new mockup
are saved under `docs/design/2026-11-15-respiration-tracker/`.

Send feedback loads the World Issue Tracker widget from worldissuetracker.com.
Camera cover is display-only: capture and optical-flow input remain unchanged.
Cover stays full-size. A valid tracked chest gently pans the display crop toward it; blocked tracking and the Chart focus thumbnail retain centered cover. Capture and optical-flow inputs are unchanged.
Rendering telemetry records 10-second fps/processing-time windows. Glass blur
starts off, is enabled only after a healthy baseline, and is dropped if frame
rate or processing time deteriorates. The dark translucent fill remains without
blur or browser support.

## Version and update time

Settings shows the deployed version and a relative update time. Tap or press
Enter for the exact local time, zone and commit. The date is the deployed
commit's committer date, with build time used only when Git is unavailable or
the source is dirty; missing/invalid metadata shows version alone.

GitHub Pages now publishes an Actions artifact from `main` at the same URL.
`scripts/build-pages.sh` copies only public runtime assets and runs
`scripts/stamp-version.sh`; generated `version.json` records the exact source
commit, `commitTime` (also `committerTime`), `buildTime` and `event`.
The source-controlled `version.json` is an unstamped local-development template;
its null timestamps are never replaced with a guessed visit time. The shared
stamp renderer comes from the app-principles kit, without a new dependency.

## Camera choice & Heart (0.15.0)

Use **Camera ON / Camera OFF** above the main view. OFF is remembered in this
browser, releases tracks and image processing, and uses the existing breathing
guide. Bluetooth remains available without camera permission. Fingertip PPG
requires Camera ON and an actual rear camera (no front-camera fallback). Starting a camera-only mode while OFF switches to Fixed breathing; guide
rates are labeled as guide rates, not measured breathing. Turning ON makes camera
tracking available on the next start or explicit Tracking on action.

**Heart** is a separate no-face-camera section with a source selector. Fingertip
uses the rear camera plus torch when available; Bluetooth uses no camera. The
existing main Fingertip mode and Heart consume the same source contract. Connect
Bluetooth in Heart and choose **Use Bluetooth in Coherence** for the main view.
Coherence uses the existing 64-second RR spectral calculation and degrades to HR
only when RR is missing or PPG quality is poor, with an explicit explanation.
Fingertip PPG is experimental and not medical; pressure, motion, light and camera
timing affect accuracy. Connect a BLE strap/watch advertising
the standard Heart Rate Service in supported Chrome desktop/Android environments
over HTTPS. The browser's device chooser requires a click. HR comes from the
sensor; RMSSD uses successive RR differences over up to 60 seconds, after 20
intervals. RR outside 300–2000 ms clears the contiguous segment; no advanced
artifact correction is claimed. Missing contact, disconnect, invalid packets,
backgrounding, or stale data clears live values. HR-only sensors cannot provide
RMSSD or coupling. No HR-to-RR conversion is used. Sensor data stays in page
memory and is cleared when disconnected or leaving Heart; it is not sent to the
camera session recorder or uploaded.

The breathing guide offers 5–7 breaths/min. The plot overlays measured HR and a
clearly labeled guide reference. Coupling is squared correlation of RR against
sine/cosine at the chosen guide frequency (at least 30 seconds / 25 RR intervals),
not measured breathing, a validated resonance score or medical advice. Changing
pace resets the RR window. HR swing is observed HR range, not a resonance score.

Safari on iPhone lacks Web Bluetooth. Apple Watch via a native HealthKit wrapper
is **planned**, with no simulated connection or data. See
[the native follow-up design](docs/heart-native-follow-up.md).
