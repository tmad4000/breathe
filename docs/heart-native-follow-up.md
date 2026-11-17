# Apple Watch / iPhone Heart follow-up

Status: design only, no native sensor implementation shipped in 0.15.0.

The web Heart section uses the Bluetooth SIG Heart Rate Service. iOS Safari does
not implement Web Bluetooth; Apple Watch is not assumed to broadcast that service.
Do not show a working Connect button or synthetic values on unsupported browsers.

Extend the existing `ios/` wrapper with a watchOS companion. The watch owns an
explicit user-started HealthKit workout session and HKLiveWorkoutBuilder delegate
for live heart-rate samples. Request narrowly scoped HealthKit read permission
for heart rate and workout authorization, with clear purpose strings and a
Stop action. Mirror the workout to the iPhone using Apple's supported workout
session mirroring APIs; bridge timestamped bpm and connection/permission state to
the WKWebView Heart UI. Restrict the bridge to trusted bundled app content.
Stop collection on explicit stop/disconnect; handle denial, background delivery,
watch disconnect, stale samples, reconnection and workout lifecycle without
claiming that old samples are live. Do not start either camera.

No server, cloud sync, analytics or automatic data persistence. Native stores may
be used only with a separately explicit user choice. HealthKit writes must be
scoped to the intended workout behavior; do not quietly save health data merely
because the web page is open. Clear UI data on stop and isolate it from camera
session/debug recordings.

Live bpm does not imply beat-to-beat RR access. HealthKit's HRV quantity is SDNN,
not RMSSD. Show HR-only capability until a verified source provides actual RR or
heartbeat-series timing with sufficient cadence, provenance and consent. Never
fabricate RR as 60000/bpm, label SDNN as RMSSD, or claim continuous RMSSD from
occasional HRV samples. Guide-coupling is an exploratory view, not a diagnosis or
proof of resonance. Validate latency, timestamps, dropped samples, permissions,
staleness and physical Apple Watch behavior on the Apple build host and devices.
Linux web tests do not verify native behavior.

Sources:
- https://developer.apple.com/documentation/healthkit/running-workout-sessions
- https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier/heartratevariabilitysdnn
- https://developer.apple.com/videos/play/wwdc2025/322/
- https://bugs.webkit.org/show_bug.cgi?id=238049
- https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/HRS_v1.0/out/en/index-en.html
