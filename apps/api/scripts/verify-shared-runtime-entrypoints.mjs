#!/usr/bin/env node
/**
 * Node-native (pure Node 22 ESM) verification of the shared workspace packages'
 * runtime entrypoints.
 *
 * This intentionally does NOT use Vitest. Vitest runs through Vite's resolver,
 * which happily maps a `.js` specifier back to `.ts` source and would hide the
 * exact failure that broke the Vercel Node runtime:
 *
 *   Error: Cannot find package '.../@life-weather/weather-core/src/index.ts'
 *
 * Here we ask Node itself to resolve and import the packages the same way the
 * Vercel Node runtime does, and assert they land on compiled `dist` JavaScript
 * rather than raw TypeScript source.
 *
 * Pure and offline: no network calls, no environment access, no file writes.
 * Must be run AFTER `build:api-runtime-packages` so the dist artifacts exist.
 */

const PACKAGES = ['@life-weather/contracts', '@life-weather/weather-core'];

const failures = [];

for (const name of PACKAGES) {
  let resolved;
  try {
    // import.meta.resolve is synchronous and stable on Node 20.6+ / Node 22.
    resolved = import.meta.resolve(name);
  } catch (error) {
    failures.push(`${name}: import.meta.resolve failed — ${error?.message ?? error}`);
    continue;
  }

  if (!resolved.endsWith('/dist/index.js')) {
    failures.push(`${name}: resolved to ${resolved}, expected a path ending in /dist/index.js`);
  }

  if (/\/src\/.*\.ts(?:\?|$)/.test(resolved)) {
    failures.push(`${name}: resolved URL still points at raw TypeScript source — ${resolved}`);
  }

  try {
    const mod = await import(name);
    if (mod === null || typeof mod !== 'object') {
      failures.push(`${name}: dynamic import did not return a module namespace object`);
    }
  } catch (error) {
    failures.push(`${name}: dynamic import failed — ${error?.message ?? error}`);
    continue;
  }

  console.log(`ok  ${name} -> ${resolved}`);
}

if (failures.length > 0) {
  console.error('\nShared runtime entrypoint verification FAILED:');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log('\nAll shared runtime entrypoints resolve to compiled dist JavaScript.');
