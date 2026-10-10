#!/usr/bin/env bash
# Builds synthetic breathing clips from a still photo: the region below the chin
# moves vertically at a known rate; optional whole-frame sway simulates a handheld phone.
# Usage: test/make-fixtures.sh path/to/portrait.png   (expects a phone screenshot like Google Fit's)
set -euo pipefail
src=${1:?photo}; out=$(dirname "$0")/fixtures; mkdir -p "$out"
mk() { # bpm out sway_px
  local f; f=$(python3 -c "print($1/60)")
  ffmpeg -v error -y -loop 1 -i "$src" -filter_complex "[0]crop=1290:1879:0:917,scale=360:526,split[a][b];[b]crop=360:322:0:203[chest];[a][chest]overlay=x=0:y='203+2.2*sin(2*PI*$f*t)',noise=alls=4:allf=t,pad=376:542:8:8,crop=360:526:'8+$3*sin(2*PI*0.75*t)':'8+$3*sin(2*PI*0.5*t)',format=yuv420p" -t 40 -r 30 -c:v libx264 -crf 16 -preset fast -movflags +faststart "$out/$2"
}
mk 15 b15.mp4 0
mk 24 b24.mp4 0
mk 9 b9-sway.mp4 1.5
# Chest expanding toward the camera (scale change, no net vertical motion) at 12/min.
ffmpeg -v error -y -loop 1 -i "$src" -filter_complex "[0]crop=1290:1879:0:917,scale=360:526,split[a][b];[b]crop=360:322:0:203,scale=w='trunc(360*(1+0.012*(1+sin(2*PI*0.2*t)))/2)*2':h='trunc(322*(1+0.012*(1+sin(2*PI*0.2*t)))/2)*2':eval=frame[chest];[a][chest]overlay=x='(360-overlay_w)/2':y='203+(322-overlay_h)/2',noise=alls=4:allf=t,format=yuv420p" -t 40 -r 30 -c:v libx264 -crf 16 -preset fast -movflags +faststart "$out/b12-zoom.mp4"
