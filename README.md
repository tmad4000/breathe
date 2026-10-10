# Breathe — continuous camera respiration tracker

A web app that works like Google Fit's camera respiratory-rate check, but
**keeps running for as long as you want** instead of stopping after 30–60 s.

**Use it:** https://tmad4000.github.io/breathe/ — open in Safari on an iPhone
(or any phone browser), allow the camera, then Share → Add to Home Screen.

## How it works

Same idea as Google's: the front camera follows the small rise and fall of your
chest (optical flow). Everything runs on the phone; no video leaves the device.

1. **Find you:** MediaPipe face detector (`@mediapipe/tasks-vision` 1.0.1,
   vendored in `vendor/`, BlazeFace short-range model in `models/`) finds your
   face every 4th frame. A chest box is placed below the chin, about 2.6 face
   widths wide. The box stays put unless you move.
2. **Measure motion:** each frame is downscaled to 256 px. Vertical motion in
   the chest box comes from block Lucas–Kanade optical flow (4×4 blocks, median,
   brightness-offset term so auto-exposure is ignored). Face motion is
   subtracted to cancel hand shake (toggle in History).
3. **Signal:** motion is integrated into chest displacement, resampled to
   10 Hz on an "active" clock that pauses when you're out of frame, and
   band-passed to 0.08–0.9 Hz (≈5–54 breaths/min).
4. **Rate:** breaths are counted at end-of-inhale peaks (adaptive hysteresis).
   The current rate covers the last 30 s; while warming up it uses the spectral
   peak. Every 10 s the rate is logged to a trend.

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
```

`?src=clip.mp4` replaces the camera with a looping video file, which is useful
for end-to-end tests and for analyzing recorded clips. Chrome's fake camera
can't be used for rate tests: in headless mode it delivers about 5 fps and its
content clock runs slow.

Verified 2026-10-10: 15 → 14.94, 24 → 23.90, 9 bpm with ±1.5 px whole-frame
handheld sway → 8.96.

Not a medical device.
