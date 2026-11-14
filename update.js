// Update notice: compares the deployed version.json with the running version.
// Pure, so it can be unit-tested without a browser.

// "0.10.0" → [0, 10, 0]; anything that is not three whole numbers → null.
export function parseVersion(v) {
  const m = typeof v === 'string' && /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? m.slice(1).map(Number) : null;
}

// True only when `available` is a valid version strictly newer than `running`.
// Equal, older (never offer a downgrade) or malformed input → false.
export function isNewerVersion(available, running) {
  const a = parseVersion(available), r = parseVersion(running);
  if (!a || !r) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== r[i]) return a[i] > r[i];
  return false;
}
