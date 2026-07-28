import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Orchestration regression guard for the **shared-runtime-package bootstrap** contract.
 *
 * PR #36 moved `@life-weather/contracts` and `@life-weather/weather-core` from raw `.ts` entrypoints to
 * compiled `dist/` (so the Vercel Node runtime can import them). The trade-off surfaced on a clean checkout:
 * `dist` is gitignored and `pnpm install` alone did not build it, so the standard `typecheck`/`test` commands
 * failed with `Cannot find module '@life-weather/contracts'` (tsc) / `Failed to resolve entry for package`
 * (Vitest) until `build:api-runtime-packages` was run by hand.
 *
 * The fix wires the build into the install/dev lifecycle:
 *   - a root `postinstall` builds the shared `dist` right after every `pnpm install`, so the existing
 *     root/API `typecheck` and `test` commands work on a fresh checkout with no manual bootstrap;
 *   - `dev:api` rebuilds the shared packages before starting the dev server, so it never serves stale `dist`;
 *   - `apps/api/vercel.json`'s install command builds the shared `dist` explicitly and then runs the
 *     Node-native `verify` as a fail-closed gate. Vercel caches `node_modules`, so a warm-cache
 *     `pnpm install` can no-op and skip the root `postinstall`; the explicit build keeps the deploy
 *     correct regardless, and `verify` aborts the deploy if `dist` is ever unresolvable.
 *
 * This test locks that wiring in place. It parses `package.json` / `vercel.json` as JSON (never a loose
 * string search of file bytes), touches no network / environment / Vercel API, and asserts full strings or
 * explicit orderings — so it passes identically on Windows and CI Linux.
 */

// This file lives at `apps/api/src/deployment-runtime-package-bootstrap.test.ts`: its parent is the api
// package root, and three levels up is the monorepo root that owns the orchestration scripts.
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(SRC_DIR, '..');
const REPO_ROOT = resolve(SRC_DIR, '..', '..', '..');

const rootScripts = (
  JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  }
).scripts ?? {};

const vercelConfig = JSON.parse(readFileSync(join(API_DIR, 'vercel.json'), 'utf8')) as Record<
  string,
  unknown
>;
const installCommand = typeof vercelConfig.installCommand === 'string' ? vercelConfig.installCommand : '';

describe('shared runtime package bootstrap', () => {
  it('builds the shared runtime dist after every install via a root postinstall', () => {
    expect(rootScripts.postinstall).toBe('pnpm run build:api-runtime-packages');
  });

  it('build:api-runtime-packages compiles contracts before weather-core', () => {
    const build = rootScripts['build:api-runtime-packages'] ?? '';
    expect(build).toBe(
      'pnpm --filter @life-weather/contracts run build && pnpm --filter @life-weather/weather-core run build',
    );
    expect(build.indexOf('@life-weather/contracts')).toBeLessThan(
      build.indexOf('@life-weather/weather-core'),
    );
  });

  it('dev:api rebuilds the shared packages before starting the API dev server', () => {
    const dev = rootScripts['dev:api'] ?? '';
    expect(dev).toBe('pnpm run build:api-runtime-packages && pnpm --filter @life-weather/api dev');
    expect(dev.indexOf('build:api-runtime-packages')).toBeLessThan(dev.indexOf('@life-weather/api dev'));
  });

  it('check keeps the build -> verify -> lint -> typecheck -> test order', () => {
    const check = rootScripts.check ?? '';
    const order = [
      check.indexOf('build:api-runtime-packages'),
      check.indexOf('verify:api-runtime-packages'),
      check.indexOf('run lint'),
      check.indexOf('run typecheck'),
      check.indexOf('run test'),
    ];
    for (const index of order) {
      expect(index).toBeGreaterThanOrEqual(0);
    }
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i - 1]).toBeLessThan(order[i]!);
    }
  });

  it('vercel install does a frozen install, then builds the shared dist, then Node-native verifies it', () => {
    const install = installCommand.indexOf('pnpm install --frozen-lockfile');
    const build = installCommand.indexOf('build:api-runtime-packages');
    const verify = installCommand.indexOf('verify:api-runtime-packages');
    // Vercel caches node_modules, so a warm-cache install can skip the root postinstall; the deploy must
    // build dist explicitly and only then verify it resolves, in that order.
    expect(install).toBeGreaterThanOrEqual(0);
    expect(build).toBeGreaterThan(install);
    expect(verify).toBeGreaterThan(build);
  });

  it('vercel.json stays zero-config (no build/output/functions/includeFiles/env overrides)', () => {
    expect(vercelConfig.buildCommand).toBeUndefined();
    expect(vercelConfig.outputDirectory).toBeUndefined();
    expect(vercelConfig.functions).toBeUndefined();
    expect(vercelConfig.includeFiles).toBeUndefined();
    expect(vercelConfig.env).toBeUndefined();
  });
});
