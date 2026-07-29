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
 * A follow-up (Codex P2) closed a **stale-dist developer-workflow regression** the dist entrypoint opened:
 * once the package entrypoints pointed at compiled `dist` instead of source, running a standalone
 * `pnpm typecheck` / `pnpm test` (or a package-scoped `--filter ... run typecheck/test`) after editing shared
 * `src` re-read the *previous* `dist`, so the checks could go false-green against stale artifacts. The fix
 * splits every check into a public **build-first** command and an internal **`:workspace`** command that runs
 * the raw checker with no build:
 *   - root `typecheck` / `test` rebuild the shared `dist` first, then fan out to the recursive
 *     `typecheck:workspace` / `test:workspace` runners;
 *   - `check` builds the shared `dist` exactly once, then runs `verify`, `lint`, and the recursive
 *     `:workspace` runners directly (never the public build-first commands), so the shared build is not
 *     repeated inside a single `check`;
 *   - consumer packages of the compiled shared packages (`apps/api`, `apps/mobile`,
 *     `packages/lifestyle-engine`, `packages/weather-core`) get a build-first public `typecheck` / `test`
 *     wrapper (`pnpm -w run
 *     build:api-runtime-packages && pnpm run <check>:workspace`) so a package-scoped run also refreshes
 *     `dist`. The build wrapper only calls package `build` scripts (never `typecheck`/`test`), so it cannot
 *     recurse.
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

const readScripts = (relPath: string): Record<string, string> =>
  (
    JSON.parse(readFileSync(join(REPO_ROOT, relPath, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    }
  ).scripts ?? {};

const countOccurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

const rootScripts = readScripts('.');
const apiScripts = readScripts('apps/api');
const mobileScripts = readScripts('apps/mobile');
const configScripts = readScripts('packages/config');
const contractsScripts = readScripts('packages/contracts');
const lifestyleScripts = readScripts('packages/lifestyle-engine');
const weatherCoreScripts = readScripts('packages/weather-core');

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

describe('stale-dist regression: public build-first vs internal :workspace scripts', () => {
  it('root public typecheck rebuilds the shared dist, then runs the recursive :workspace runner', () => {
    expect(rootScripts.typecheck).toBe(
      'pnpm run build:api-runtime-packages && pnpm run typecheck:workspace',
    );
    const typecheck = rootScripts.typecheck ?? '';
    expect(typecheck.indexOf('build:api-runtime-packages')).toBeLessThan(
      typecheck.indexOf('typecheck:workspace'),
    );
  });

  it('root public test rebuilds the shared dist, then runs the recursive :workspace runner', () => {
    expect(rootScripts.test).toBe('pnpm run build:api-runtime-packages && pnpm run test:workspace');
    const test = rootScripts.test ?? '';
    expect(test.indexOf('build:api-runtime-packages')).toBeLessThan(test.indexOf('test:workspace'));
  });

  it('root typecheck:workspace fans out to each package typecheck:workspace with no build', () => {
    expect(rootScripts['typecheck:workspace']).toBe('pnpm -r --if-present run typecheck:workspace');
    expect(rootScripts['typecheck:workspace']).not.toContain('build:api-runtime-packages');
  });

  it('root test:workspace fans out to each package test:workspace with no build', () => {
    expect(rootScripts['test:workspace']).toBe('pnpm -r --if-present run test:workspace');
    expect(rootScripts['test:workspace']).not.toContain('build:api-runtime-packages');
  });

  it('check keeps the build -> verify -> lint -> typecheck:workspace -> test:workspace order', () => {
    const check = rootScripts.check ?? '';
    const order = [
      check.indexOf('build:api-runtime-packages'),
      check.indexOf('verify:api-runtime-packages'),
      check.indexOf('run lint'),
      check.indexOf('run typecheck:workspace'),
      check.indexOf('run test:workspace'),
    ];
    for (const index of order) {
      expect(index).toBeGreaterThanOrEqual(0);
    }
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i - 1]).toBeLessThan(order[i]!);
    }
  });

  it('check calls the internal :workspace runners, never the public build-first typecheck/test', () => {
    const check = rootScripts.check ?? '';
    // `pnpm run typecheck` / `pnpm run test` NOT immediately followed by `:workspace` would re-trigger the
    // shared build a second time inside a single `check`; assert they never appear.
    expect(check).not.toMatch(/pnpm run typecheck(?!:workspace)/);
    expect(check).not.toMatch(/pnpm run test(?!:workspace)/);
    expect(check).toContain('pnpm run typecheck:workspace');
    expect(check).toContain('pnpm run test:workspace');
  });

  it('check builds the shared runtime packages exactly once', () => {
    const check = rootScripts.check ?? '';
    expect(countOccurrences(check, 'build:api-runtime-packages')).toBe(1);
  });

  const consumerCases: Array<[string, Record<string, string>]> = [
    ['apps/api', apiScripts],
    // apps/mobile became a compiled-contracts consumer when the mobile weather API client started
    // importing `@life-weather/contracts` at runtime, so its public checks are build-first too.
    ['apps/mobile', mobileScripts],
    ['packages/lifestyle-engine', lifestyleScripts],
    ['packages/weather-core', weatherCoreScripts],
  ];

  for (const [name, scripts] of consumerCases) {
    describe(`consumer package ${name}`, () => {
      it('public typecheck is build-first, then the internal :workspace runner', () => {
        expect(scripts.typecheck).toBe(
          'pnpm -w run build:api-runtime-packages && pnpm run typecheck:workspace',
        );
      });

      it('public test is build-first, then the internal :workspace runner', () => {
        expect(scripts.test).toBe('pnpm -w run build:api-runtime-packages && pnpm run test:workspace');
      });

      it('internal typecheck:workspace runs the raw checker with no build', () => {
        expect(scripts['typecheck:workspace']).toBe('tsc --noEmit');
      });

      it('internal test:workspace runs the raw runner with no build', () => {
        expect(scripts['test:workspace']).toBe('vitest run');
      });
    });
  }

  it('non-consumer packages keep source-only public checks and add :workspace aliases', () => {
    // config consumes no compiled shared package, so its public command stays source-only (no build
    // wrapper) and the alias mirrors it for the root recursive runner. (apps/mobile used to be here but
    // is now a build-first consumer — see the consumer cases above.)
    expect(configScripts.typecheck).toBe('tsc --noEmit');
    expect(configScripts['typecheck:workspace']).toBe('tsc --noEmit');
    expect(configScripts.typecheck).not.toContain('build:api-runtime-packages');

    // contracts is the root of the shared dependency chain (it consumes no compiled shared package), so its
    // public checks stay source-only; it still exposes both :workspace aliases for the root runners.
    expect(contractsScripts.typecheck).toBe('tsc --noEmit');
    expect(contractsScripts['typecheck:workspace']).toBe('tsc --noEmit');
    expect(contractsScripts.test).toBe('vitest run');
    expect(contractsScripts['test:workspace']).toBe('vitest run');
    expect(contractsScripts.typecheck).not.toContain('build:api-runtime-packages');
    expect(contractsScripts.test).not.toContain('build:api-runtime-packages');
  });

  it('the build-first wrapper only calls package build scripts, so it cannot recurse into checks', () => {
    const build = rootScripts['build:api-runtime-packages'] ?? '';
    expect(build).not.toContain('typecheck');
    expect(build).not.toContain('run test');
  });
});
