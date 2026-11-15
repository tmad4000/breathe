#!/bin/sh
# Explicit public runtime files only; no .git, .beads, tests or private task data.
set -eu
out="${1:-_site}"
if [ -e "$out" ]; then echo 'Output already exists; choose a new task-owned directory' >&2; exit 1; fi
mkdir -p "$out"
cp index.html ./*.js ./*.css ./*.svg ./*.webmanifest "$out/"
cp -R vendor models "$out/"
sh scripts/stamp-version.sh "$out/version.json"
