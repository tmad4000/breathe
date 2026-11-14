// Shared Playwright setup for the browser tests.
// PLAYWRIGHT_MODULE: path to a playwright or playwright-core package (default: the global `playwright`).
// BROWSER_PATH: Chrome executable to launch (default: the installed Chrome channel).
// BROWSER_NO_SANDBOX=1: pass --no-sandbox (only for hosts where headless Chrome needs it).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const modulePath = process.env.PLAYWRIGHT_MODULE ?? `${execSync('npm root -g').toString().trim()}/playwright`;
export const { chromium } = require(modulePath);

export function launch(options = {}) {
  const { channel = 'chrome', ...rest } = options;
  const args = [...(rest.args ?? [])];
  if (process.env.BROWSER_NO_SANDBOX === '1') args.push('--no-sandbox');
  return chromium.launch({
    ...rest,
    ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : { channel }),
    ...(args.length ? { args } : {}),
  });
}
