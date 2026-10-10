# Camera respiration: what the literature says, and what to change in Breathe

Research date: 2026-10-10. Applies to pipeline v0.3 (`signal.js`, `app.js`).
The primary sources were read in full where they were accessible. Items marked
*inference* are engineering judgement, not published results.

## 1. Google's published method

The DOI 10.1038/s43856-022-00102-x resolves to **Bae et al., "Prospective validation of
smartphone-based heart rate and respiratory rate measurement algorithms",
Communications Medicine 2022**. The title in the brief was slightly different.
Full text: https://pmc.ncbi.nlm.nih.gov/articles/PMC9053269/.
Supplement: https://static-content.springer.com/esm/art%3A10.1038%2Fs43856-022-00102-x/MediaObjects/43856_2022_102_MOESM1_ESM.pdf. It has study tables only and adds no RR method detail.

- **ROI:** BlazeFace face box. The torso ROI is extrapolated with constant
  coefficients and is **1.4 × face height by 2.5 × face width**. The paper does
  not give the vertical offset.
- **Resolution and fps:** The ROI is converted to luma and **resampled to about 15k
  pixels** (roughly 150 × 100), at **15 fps**.
- **Flow:** They use Eulerian phase-based motion (Riesz pyramids). Spatial phase in
  several scales is converted to optical flow, then averaged across scales.
  Processing takes 1–4 ms per frame on a Pixel 3a or 4 (Halide). **Only the vertical
  component is used.**
- **Combination:** A "spectral-spatial ensemble". Vertical flow is averaged over the
  full ROI and over each of its 4 quadrants, giving 5 waveforms. The FFT power
  spectra of the five are **summed**, with a band of 6–60 bpm.
- **Window:** A rolling FFT of 900 samples (60 s at 15 fps), although each
  measurement lasted only 30 s.
- **Estimator and quality:** Rate is the peak of the summed spectrum. An SNR is
  computed from the same spectrum. If the SNR is below **−6 dB (version A)** or
  **−4 dB (version B)**, the algorithm falls back to **counting zero crossings** of the
  full-ROI waveform. The full-ROI waveform is also the one displayed. The paper
  describes no abstention, and every participant received an estimate.
- **Results:** 50 participants (40 with asthma or COPD), Pixel 4. The phone was
  **propped on a table**, with no clothing rules. The reference was two blinded
  manual counters. MAE was **0.84 ± 0.97 (A)** and **0.78 ± 0.61 bpm (B)**, and all
  version-B errors were within 2 bpm. **The paper reports no handheld data.** The
  Fit app also tells users to lean the phone on a stable surface
  (https://www.androidcentral.com/how-measure-your-heart-and-respiratory-rates-your-android-phones-cameras-google-fit).

## 2. Open-source implementations

| Repo | Licence | Method | Accuracy | Port to JS? |
|---|---|---|---|---|
| resPyre (https://github.com/phuselab/resPyre), with benchmark paper (ACM Comput. Surv. 2025, https://iris.unimore.it/retrieve/f4558809-2694-4029-9859-170165db5d9c/3771763.pdf) | GPL-3.0 | Chest ROI is a strip centred on the MediaPipe Pose shoulder line, with height 20% of shoulder width. Methods: Farneback, then the **median vertical flow** per frame; DoF; profile1D (cross-correlation of row profiles); 6 deep-flow models (RAFT and others); rPPG RIV/BSS; MTTS-CAN; BigSmall. Rate is the Welch peak over 30 s windows. | Optical flow wins on all 3 datasets. RAFT MAE is 1.40 / 0.64 / 2.06 bpm (BP4D+ / COHFACE / MAHNOB). Farneback is 1.87 / 1.02 / 2.71. **rPPG-derived: PCC < 0.2, MAPE > 20%.** Deep nets do worse than flow. | The method is easy to port; the code is GPL. Profile1D has the best ratio of accuracy to cost. |
| Wang & den Brinker, "Algorithmic principles of camera-based respiratory motion extraction" (https://arxiv.org/abs/2105.07537) | Pseudo-code only | OF-M1D: DC-normalise each column. Vertical 1-D LK: v = Σ(Dy·Dt)/Σ(Dy²) with a 1×2 kernel. **The frame pair is 200 ms apart, not 67 ms.** Integrate with cumsum. 12×30 px blocks are chosen by SNR over a 30 s window. | Phantom test, within ±2 bpm: 88% precision by day. **2-D flow did not help** and hurt slightly at night. Large kernels performed worse. | About 10 lines of code. |
| MSPM / Zhan et al. EMBC 2020 (https://arxiv.org/abs/2402.02224) | Dataset licence | Static "upper-clothes" box, dense vertical flow downsampled to a 10×10 grid, then **ZCA**. The 3 components with the highest SNR are averaged. | MAE 1.09 bpm, r = 0.79 (guided 10–20 bpm breathing). | Yes. Close to our PCA. |
| Massaroni group (Molinaro et al., Sensors 2022, https://pmc.ncbi.nlm.nih.gov/articles/PMC9002464/) | No code | iPhone 6s on a tripod, 720p30, exposure locked. ROI is the torso from the pit of the neck. Horn–Schunck vertical velocity, averaged, then integrated. Band 0.05–2 Hz. **Lomb periodogram, 20 s window, 1 s step.** Outliers removed with 1.5 × IQR. | MAE 0.42–0.68 bpm, continuous output. | Yes. |
| rPPG-Toolbox (https://github.com/ubicomplab/rPPG-Toolbox) | RAIL-style "Other" licence | Respiration only through BigSmall (multi-task, BP4D+). | See the resPyre benchmark: weak. | No. |
| vitallens.js | Proprietary API | Face-video RR through a cloud API. VitalLens 2.0 reports RR MAE 1.08 bpm (https://arxiv.org/abs/2510.27028). | — | API only. It sends video off the device. |
| OpenCV.js | Apache-2.0 | `calcOpticalFlowFarneback` and `calcOpticalFlowPyrLK` are in the JS build whitelist. | — | Yes, but it costs about 8 MB of WASM. |

## 3. Which signal sources work for a handheld front camera

- **The only handheld numbers found** come from CalibrationPhys
  (https://arxiv.org/abs/2310.15043, Pixel 5, 20 subjects). At rest (task T1), chest
  optical-flow MAE was **1.56 bpm on a stand and 5.83 bpm handheld**. Across all
  tasks it was 3.95 and 6.34. Their best model's RR correlation fell from 0.73 to
  0.37. The authors attribute this to camera shake: "subtle respiratory movements
  of the chest cannot be captured". **Shake is the dominant problem, not the
  choice of flow method.**
- **Chest beats head motion.** Samsung (EMBC 2022,
  https://sra.samsung.com/publications/motion-based-respiratory-rate-estimation-with-motion-artifact-removal-technique-in-a-facial-video-with-an-rgb-camera)
  measured MAE **1.28 bpm from chest motion and 1.95 from head motion**.
- **Pose landmarks:** A nose-to-shoulder-midpoint distance signal from MediaPipe
  scored MAE 3.2–4.9 bpm in 10 s windows (https://arxiv.org/abs/2512.14093).
  Landmark jitter is coarse compared with sub-pixel flow. **Use pose to place the
  ROI, not as the signal.**
- **Intensity:** Flow outperformed intensity in Zhan 2020 and in the webcam study.
  One finding matters for us: in the dual-camera intensity study (Nam et al.,
  https://pmc.ncbi.nlm.nih.gov/articles/PMC4786286/), **striped shirts gave stronger
  signals than plain ones**.
- **Respiration derived from rPPG:** The benchmark reports PCC < 0.2. Even
  **finger-on-camera** PPG with Smart Fusion reached RMSE **6 bpm**, against 2.3 bpm
  for a pulse oximeter (Karlen et al., IEEE JBHI 2015). Face rPPG from a shaking
  handheld phone will be worse.
- **Fusion:** Gains are real but modest. Quality-aware selection across 10 pipelines
  cut MAE from 3.03 to 2.37 (arXiv 2512.14093). Kalman fusion with an SQI
  outperformed every single source (Nemati et al. 2010,
  https://pmc.ncbi.nlm.nih.gov/articles/PMC2929127/). **Fuse several motion
  regions before adding rPPG.**

## 4. Robust rate estimation and quality indices

- **Windows:** Molinaro used 20 s windows with a 1 s step; Nemati 20 s with a 5 s
  step; resPyre 30 s with Welch segments of 20 s; Google about 30–60 s.
  **20–30 s windows updated every 1 s** are the norm.
- **Spectral SNR gate with a time-domain fallback** (Google): SNR = peak power over
  the rest of the band, in dB, with a threshold of about −4 to −6 dB.
- **Spectral purity (Hjorth):** Γ = ω₂² / (ω₀·ω₄), where ω₀ = var(x), ω₂ = var(x′)
  and ω₄ = var(x″). It is 1 for a pure sinusoid and approaches 0 for noise. It is
  cheap to compute in the time domain (Nemati). Hjorth mobility and band power
  ratio were the most transferable SQIs in arXiv 2512.14093.
- **Kalman tracking of rate:** Use a random-walk state on rate. Inflate the
  measurement noise as **R_k ← R_k·exp(SQI_k⁻² − 1)**. Fuse sources by inverse
  innovation variance, with σ² = (r/SQI)² (Nemati).
- **Agreement rule:** Drop the window when source estimates disagree by more than
  4 bpm SD (Karlen's Smart Fusion). The covariance-intersection version keeps 90%
  of windows instead of 46% (https://arxiv.org/abs/2004.09934).
- **Outliers:** 1.5 × IQR on recent estimates, holding the last valid value
  (Molinaro).
- **Harmonic check** (*inference*, standard practice): when the peak is at f and
  P(f/2) > 0.5·P(f), and the waveform has about half as many zero crossings as
  2f·T, report f/2. Also cross-check against the first autocorrelation peak. Nam
  et al. chose ROIs by mean autocorrelation.

## 5. Practical pitfalls

- **iOS camera controls:** WebKit's `AVVideoCaptureSource.mm` exposes
  `frameRate`, `zoom`, `torch` (rear camera only),
  **`whiteBalanceMode` ('manual' maps to `AVCaptureWhiteBalanceModeLocked`)**,
  `backgroundBlur` and `powerEfficient`. It has **no exposureMode or focusMode, and
  no exposure or focus lock** (source:
  https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/mediastream/cocoa/AVVideoCaptureSource.mm).
  So keep the brightness-offset term and add per-block DC and contrast
  normalisation, as Wang does with per-column means. *Inference:* continuous
  autofocus on newer front cameras can produce small scale changes ("focus
  breathing"), and these look like expansion.
- **Low-texture white shirt:** Motion can only be measured where reflectance varies
  along the direction of motion (Wang). On a plain shirt the signal comes from
  **edges**: the shoulder silhouette against the background, the neckline and
  collar, and folds. resPyre's shoulder-line strip deliberately covers those edges.
- **Shake compensation:** The only handheld study proposes stabilisation but does
  not test it, and no paper tests background-reference or gyro compensation.
  *Inference:* the face sits at almost the same depth as the chest, so camera
  rotation and translation shift both by the same amount. The background is
  farther away, so it handles rotation but not translation. `DeviceMotionEvent`
  rotation rate (permission required on iOS) captures rotation only. Hand
  translation of about 1 mm at 40 cm is as large as the breathing motion itself.
  Separately, a phone braced against the body may move *with* the breath. Check
  this on recorded clips.
- **Frame-to-frame integration:** *Inference:* integrating per-frame LK noise
  produces 1/f² (Brownian) noise, which is strongest exactly in the 0.1–0.3 Hz
  breathing band. Wang's result that 200 ms frame pairs beat 67 ms supports using
  longer baselines.

## Top 5 changes, ranked

1. **Cancel camera motion with a reference region.** Track vertical (and
   horizontal) flow on the face box plus two background strips beside the
   shoulders. For each chest channel, fit the coupling gains to the reference
   channels by least squares over the 30 s window in the **1–3 Hz band**, where
   there is shake but no breathing. Then subtract the scaled reference in the
   breathing band. This is the published failure mode (MAE 1.56 → 5.83 when
   handheld). Log gyro `rotationRate` as an extra regressor if permission is
   granted.
2. **Vertical-only displacement over a long baseline.** Drop the u channels as
   signal and keep them only as nuisance regressors, which matches Google, Wang,
   MSPM and resPyre. Compute LK between frame t and t − 200 ms, or against a
   keyframe refreshed every 5–10 s, instead of summing per-frame flow. Add
   per-block DC and contrast normalisation.
3. **ROI from the shoulders, weighted by edges.** Run Pose landmarker about once
   per second to place a box spanning the shoulder silhouettes and neckline
   (resPyre strip, or Google's 2.5 × 1.4 face box). Weight blocks by texture
   (λ_min) and per-block SNR. Combine as Google does, by summing the spectra of
   the full box and its quadrants, or by averaging the top-3 SNR components as in
   MSPM.
4. **Rate tracker with SQI.** Use a 30 s window updated every 1 s. Gate on SNR in dB
   plus Hjorth purity, with a zero-crossing fallback and a harmonic and
   autocorrelation check. Track with a Kalman filter whose R is SQI-inflated, and
   apply the 1.5 × IQR outlier rule. Show "--" only after the SQI has stayed low
   for several seconds. Orient the display from the reference-cancelled vertical
   displacement of the top rows, not from the PCA sign.
5. **Capture setup and UX.** Apply `whiteBalanceMode: 'manual'` once AWB settles.
   Process at about 15 fps (Google's rate, and gentler on the battery over long
   sessions). Use `requestVideoFrameCallback` metadata timestamps. Tell users to
   brace the phone or prop it up, and show a live quality meter. Leave
   rPPG-derived fusion for later: the evidence says it adds little and is costly.
