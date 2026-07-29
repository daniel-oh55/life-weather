import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Configuration regression guard for the Vercel Hono **TypeScript compiler-option** contract.
 *
 * The PR #31 zero-config entrypoint fix (see `deployment-entrypoint.test.ts`) let Vercel find the single
 * production entrypoint, but the Hono build then reported a wave of errors the repo-local typecheck never
 * sees: the Web `Request`/`Response` lib types (`headers`/`body`/`signal`/`ok`/`status`) were missing, and
 * `boolean` literal discriminated unions (`result.error`/`issues`/`stage`, the selected `true`/`false` arm)
 * failed to narrow. Both are symptoms of Vercel resolving `apps/api`'s effective compiler options differently
 * from `pnpm --filter @life-weather/api typecheck` — i.e. the `extends` chain or a preset override not landing
 * the same way in the deployment sandbox.
 *
 * The fix pins the deployment-critical options **directly** on `apps/api/tsconfig.json` (not only inherited
 * from `tsconfig.base.json`), so the DOM lib and strict null-narrowing are guaranteed regardless of how the
 * build resolves `extends`. This test locks those explicit values in place. It parses the tsconfig as JSON
 * (never a string search), touches no network / environment / Vercel API, requires no `vercel.json`, and does
 * not force the file to duplicate every inherited base option — so it passes identically on Windows and CI Linux.
 */

// This test file lives at `apps/api/src/deployment-tsconfig.test.ts`, so its parent directory is the api
// package root — where `tsconfig.json` sits beside `src/`.
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(SRC_DIR, '..');
const TSCONFIG_PATH = join(PKG_ROOT, 'tsconfig.json');

const compilerOptions = JSON.parse(readFileSync(TSCONFIG_PATH, 'utf8')).compilerOptions as Record<
  string,
  unknown
>;

describe('Vercel Hono deployment tsconfig', () => {
  it('pins the deployment-critical compiler options directly on apps/api/tsconfig.json', () => {
    // target/module/resolution the Hono preset expects.
    expect(compilerOptions.target).toBe('ES2022');
    expect(compilerOptions.module).toBe('ESNext');
    expect(compilerOptions.moduleResolution).toBe('Bundler');

    // DOM lib — provides the Web Request/Response types the Vercel build was missing.
    expect(compilerOptions.lib).toEqual(['ES2022', 'DOM', 'DOM.Iterable']);

    // strict null-checking — enables the boolean-literal discriminated-union narrowing.
    expect(compilerOptions.strict).toBe(true);
    expect(compilerOptions.strictNullChecks).toBe(true);

    // node types and the src rootDir the package already depended on.
    expect(compilerOptions.types).toContain('node');
    expect(compilerOptions.rootDir).toBe('./src');
  });
});
