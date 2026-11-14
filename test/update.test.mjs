import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseVersion, isNewerVersion } from '../update.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('newer versions are offered, compared numerically', () => {
  assert.equal(isNewerVersion('0.9.1', '0.9.0'), true);
  assert.equal(isNewerVersion('0.10.0', '0.9.0'), true);
  assert.equal(isNewerVersion('1.0.0', '0.99.99'), true);
});

test('equal versions are not offered', () => {
  assert.equal(isNewerVersion('0.9.0', '0.9.0'), false);
  assert.equal(isNewerVersion('v0.9.0', '0.9.0'), false);
});

test('older versions are never offered (no downgrade)', () => {
  assert.equal(isNewerVersion('0.9.0', '0.10.0'), false);
  assert.equal(isNewerVersion('0.8.9', '0.9.0'), false);
  assert.equal(isNewerVersion('0.0.1', '1.0.0'), false);
});

test('malformed versions are ignored', () => {
  for (const bad of [undefined, null, '', 'latest', '0.9', '0.9.0.1', '0.9.x', '1.0.0-beta', 10, {}]) {
    assert.equal(isNewerVersion(bad, '0.9.0'), false, String(bad));
    assert.equal(isNewerVersion('9.9.9', bad), false, String(bad));
  }
  assert.equal(parseVersion('0.10.0').join(), '0,10,0');
});

test('package.json, version.json and VERSION in app.js agree', () => {
  const pkg = JSON.parse(read('package.json')).version;
  const file = JSON.parse(read('version.json')).version;
  const app = /^const VERSION = '([^']+)';$/m.exec(read('app.js'))?.[1];
  assert.ok(parseVersion(pkg), `package.json version ${pkg}`);
  assert.equal(file, pkg, 'version.json');
  assert.equal(app, pkg, 'app.js VERSION');
});
