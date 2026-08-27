// Shared Chromium resolution for the Phase 7 browser tools.

import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const SYSTEM_CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/opt/google/chrome/chrome',
  '/snap/bin/chromium',
];

/** Resolve an installed Chromium without downloading a browser implicitly. */
export function resolveChromium() {
  const override = process.env.CHROMIUM_PATH;
  if (override) {
    if (existsSync(override)) return override;
    throw new Error(`CHROMIUM_PATH does not exist: ${override}`);
  }

  for (const candidate of SYSTEM_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }

  const managed = chromium.executablePath();
  if (managed && existsSync(managed)) return managed;

  throw new Error(
    'No Chromium executable found. Install system Chromium or set CHROMIUM_PATH.',
  );
}
