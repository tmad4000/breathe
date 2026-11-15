// Shared Playwright setup for the browser tests.
// PLAYWRIGHT_MODULE: path to a playwright or playwright-core package (default: the global `playwright`).
// BROWSER_PATH: Chrome executable to launch (default: the installed Chrome channel).
// Chromium sandbox stays enabled for all browser tests.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const modulePath = process.env.PLAYWRIGHT_MODULE ?? `${execSync('npm root -g').toString().trim()}/playwright`;
export const { chromium } = require(modulePath);

export function launch(options = {}) {
  const { channel = 'chrome', ...rest } = options;
  const args = [...(rest.args ?? [])];
  if (args.includes('--no-sandbox') || process.env.BROWSER_NO_SANDBOX === '1') throw new Error('Browser tests require the Chromium sandbox');
  return chromium.launch({
    ...rest,
    chromiumSandbox: true,
    ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : { channel }),
    ...(args.length ? { args } : {}),
  });
}
