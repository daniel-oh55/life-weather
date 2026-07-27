import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Filesystem regression guard for the Vercel Hono **zero-config entrypoint** contract.
 *
 * Vercel's Hono preset auto-detects a serverless function entrypoint by scanning the project root and its
 * `src/` for files whose basename is `app` / `index` / `server` and whose extension is one of
 * `js` / `cjs` / `mjs` / `ts` / `cts` / `mts`. When more than one matches it warns
 * (`Multiple entrypoints found: …`) and silently picks the first — which is how PR #31's real composition
 * root (`src/index.ts`, the only module that reads `KMA_SERVICE_KEY` and default-exports the production
 * app) lost the entrypoint to the pure DI factory that used to live at `src/app.ts`.
 *
 * This test pins the invariant so the collision cannot regress: within the `apps/api` **package root** (not
 * the repo root) and its `src/`, the sole recognized entrypoint is `src/index.ts`; the pure factory lives at
 * `src/api-app.ts` (a non-recognized basename) and does not default-export a production app. It touches no
 * network, no environment, and no Vercel API, and reads source as text (never importing `index.ts`, which
 * would require a service key), so it passes identically on Windows and CI Linux.
 */

// This test file lives at `apps/api/src/deployment-entrypoint.test.ts`, so its directory is the api `src/`
// and its parent is the api package root — the two locations Vercel scans for this deployment.
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(SRC_DIR, '..');
const SCAN_DIRS = [PKG_ROOT, SRC_DIR];

// The exact basenames and extensions Vercel's Hono zero-config recognizes as an entrypoint candidate.
const RECOGNIZED_BASENAMES = ['app', 'index', 'server'] as const;
const RECOGNIZED_EXTENSIONS = ['js', 'cjs', 'mjs', 'ts', 'cts', 'mts'] as const;

// The set of *whole filenames* that count as a candidate. Membership is exact, so `index.test.ts` and
// `api-app.ts` are correctly NOT candidates — only `index.ts`, `app.ts`, `server.mjs`, etc. are.
const RECOGNIZED_FILENAMES = new Set<string>(
  RECOGNIZED_BASENAMES.flatMap((base) => RECOGNIZED_EXTENSIONS.map((ext) => `${base}.${ext}`)),
);

/** Absolute paths of Vercel-recognized entrypoint candidates directly inside `dir` (non-recursive). */
function recognizedEntrypointsIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && RECOGNIZED_FILENAMES.has(entry.name))
    .map((entry) => join(dir, entry.name));
}

describe('Vercel Hono deployment entrypoint', () => {
  it('recognizes exactly one entrypoint — apps/api/src/index.ts — across the package root and src/', () => {
    const found = SCAN_DIRS.flatMap(recognizedEntrypointsIn).sort();

    expect(found).toEqual([join(SRC_DIR, 'index.ts')]);
  });

  it('keeps the pure DI factory at a non-recognized filename (api-app.ts), never app.ts', () => {
    expect(existsSync(join(SRC_DIR, 'api-app.ts'))).toBe(true);
    // The old recognized-basename location must be gone, or Vercel would find two entrypoints again.
    expect(existsSync(join(SRC_DIR, 'app.ts'))).toBe(false);
  });

  it('src/index.ts default-exports the production Hono app (it is the intended entrypoint)', () => {
    const indexSource = readFileSync(join(SRC_DIR, 'index.ts'), 'utf8');

    expect(indexSource).toMatch(/^export default /m);
  });

  it('src/api-app.ts does not default-export a production app (named factory only)', () => {
    const apiAppSource = readFileSync(join(SRC_DIR, 'api-app.ts'), 'utf8');

    expect(apiAppSource).not.toMatch(/^export default /m);
    expect(apiAppSource).toMatch(/export function createApiApp/);
  });
});
