# Breathe — continuous camera respiration tracker

A web app that works like Google Fit's camera respiratory-rate check, but
**keeps running for as long as you want** instead of stopping after 30–60 s.

**Use it:** https://jacobcole.ai/breathe/ — open in Safari on an iPhone
(or any phone browser), allow the camera, then Share → Add to Home Screen.

## How it works

Same idea as Google's: the front camera follows the small rise and fall of your
chest (optical flow). Everything runs on the phone; no video leaves the device.

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

**Checking accuracy:** History & settings → Breathing guide. Follow the ring
in and out at a known pace (e.g. 10/min); soft tones mark each breath in and
out, so you can follow it without watching. The measured rate should match.
Turn on "Record the first 2 minutes" to save a clip you can share for tuning,
then replay it with `?src=`.

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

Verified 2026-10-10 (v0.3.0): 15 → 15.00, 24 → 24.10, 9 bpm with ±1.5 px
whole-frame sinusoidal sway → 9.13, 12 bpm chest expansion → 12.00. Synthetic
clips only; real-phone accuracy still needs guided sessions. Background research
(Google's published method, open-source code, handheld evidence):
`docs/research-camera-respiration.md`.

Not a medical device.
