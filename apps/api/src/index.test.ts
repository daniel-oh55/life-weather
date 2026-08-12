import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * These tests exercise the real production entrypoint `apps/api/src/index.ts` — its default-exported Hono
 * app and the exported `createProductionApiApp` composition root. Because the module reads
 * `process.env.KMA_SERVICE_KEY` and builds the app at import time (fail-fast on a missing key), each case
 * sets a test-only env, `vi.resetModules()`, and dynamically imports the module, then restores the
 * environment and module cache afterwards. No real service key, no external `fetch`, and no test-order
 * coupling: the `/weather` mount is verified only via paths that fail before the network (a `400`
 * validation failure), and `globalThis.fetch` is spied to fail loudly if startup ever touches the network.
 */

/** A test-only, obviously fake decoded-shaped key. Never a real/production key. */
const DUMMY_KMA_SERVICE_KEY = 'test-only-index-decoded-key==';

/** A test-only, obviously fake decoded-shaped AirKorea key. Never a real/production key. */
const DUMMY_AIRKOREA_SERVICE_KEY = 'test-only-index-airkorea-decoded-key==';

let originalKey: string | undefined;
let originalAirKoreaKey: string | undefined;

beforeEach(() => {
  originalKey = process.env.KMA_SERVICE_KEY;
  originalAirKoreaKey = process.env.AIRKOREA_SERVICE_KEY;
});

afterEach(() => {
  if (originalKey === undefined) {
    delete process.env.KMA_SERVICE_KEY;
  } else {
    process.env.KMA_SERVICE_KEY = originalKey;
  }
  if (originalAirKoreaKey === undefined) {
    delete process.env.AIRKOREA_SERVICE_KEY;
  } else {
    process.env.AIRKOREA_SERVICE_KEY = originalAirKoreaKey;
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

/**
 * Reset the module cache, set (or clear) both env keys, and dynamically (re-)import the entrypoint.
 * Both keys must be passed explicitly — `airKoreaKey` has no default, so a KMA-only fail-fast test
 * must still pass a valid `DUMMY_AIRKOREA_SERVICE_KEY` to avoid masking which key is under test.
 */
async function importIndexWith(key: string | undefined, airKoreaKey: string | undefined) {
  vi.resetModules();
  if (key === undefined) {
    delete process.env.KMA_SERVICE_KEY;
  } else {
    process.env.KMA_SERVICE_KEY = key;
  }
  if (airKoreaKey === undefined) {
    delete process.env.AIRKOREA_SERVICE_KEY;
  } else {
    process.env.AIRKOREA_SERVICE_KEY = airKoreaKey;
  }
  return import('./index.js');
}

/** A `globalThis.fetch` spy that throws if called — proves startup / a routed request touches no network. */
function guardFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((() => {
    throw new Error('fetch must not be called');
  }) as typeof fetch);
}

describe('apps/api/src/index.ts — production entrypoint', () => {
  it('default-exports a Hono app that serves the unchanged GET /health payload', async () => {
    const fetchSpy = guardFetch();
    const mod = await importIndexWith(DUMMY_KMA_SERVICE_KEY, DUMMY_AIRKOREA_SERVICE_KEY);

    expect(typeof mod.default.request).toBe('function');
    const res = await mod.default.request('/health');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ status: 'ok', service: 'life-weather-api' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('mounts POST /weather (reachable; an invalid body fails before any network)', async () => {
    const fetchSpy = guardFetch();
    const mod = await importIndexWith(DUMMY_KMA_SERVICE_KEY, DUMMY_AIRKOREA_SERVICE_KEY);

    const res = await mod.default.request('/weather', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    // The weather route is mounted (the request reached it) and rejected the empty body before the
    // service / provider ran — so no upstream fetch happened.
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('registers only POST on /weather (GET /weather is a 404)', async () => {
    guardFetch();
    const mod = await importIndexWith(DUMMY_KMA_SERVICE_KEY, DUMMY_AIRKOREA_SERVICE_KEY);

    const res = await mod.default.request('/weather', { method: 'GET' });
    expect(res.status).toBe(404);
  });

  it('issues no external fetch at import/startup', async () => {
    const fetchSpy = guardFetch();

    const mod = await importIndexWith(DUMMY_KMA_SERVICE_KEY, DUMMY_AIRKOREA_SERVICE_KEY);

    expect(mod.default).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails fast when KMA_SERVICE_KEY is missing (import rejects, no fetch)', async () => {
    const fetchSpy = guardFetch();

    await expect(importIndexWith(undefined, DUMMY_AIRKOREA_SERVICE_KEY)).rejects.toThrow('KMA_SERVICE_KEY');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails fast when KMA_SERVICE_KEY is empty', async () => {
    await expect(importIndexWith('', DUMMY_AIRKOREA_SERVICE_KEY)).rejects.toThrow('KMA_SERVICE_KEY');
  });

  it('fails fast when AIRKOREA_SERVICE_KEY is missing (import rejects, no fetch)', async () => {
    const fetchSpy = guardFetch();

    await expect(
      importIndexWith(DUMMY_KMA_SERVICE_KEY, undefined),
    ).rejects.toThrow('AIRKOREA_SERVICE_KEY');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails fast when AIRKOREA_SERVICE_KEY is empty', async () => {
    await expect(importIndexWith(DUMMY_KMA_SERVICE_KEY, '')).rejects.toThrow(
      'AIRKOREA_SERVICE_KEY',
    );
  });

  it('checks KMA_SERVICE_KEY before AIRKOREA_SERVICE_KEY: both missing still reports KMA_SERVICE_KEY', async () => {
    await expect(importIndexWith(undefined, undefined)).rejects.toThrow('KMA_SERVICE_KEY');
  });
});

describe('apps/api/src/index.ts — createProductionApiApp', () => {
  it('builds an app from an explicit environment and serves /health + /weather', async () => {
    const fetchSpy = guardFetch();
    const mod = await importIndexWith(DUMMY_KMA_SERVICE_KEY, DUMMY_AIRKOREA_SERVICE_KEY);

    const app = mod.createProductionApiApp({
      KMA_SERVICE_KEY: DUMMY_KMA_SERVICE_KEY,
      AIRKOREA_SERVICE_KEY: DUMMY_AIRKOREA_SERVICE_KEY,
    } as NodeJS.ProcessEnv);

    const health = await app.request('/health');
    expect(health.status).toBe(200);

    const weather = await app.request('/weather', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(weather.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails fast (throws) when the explicit environment has no KMA_SERVICE_KEY', async () => {
    const mod = await importIndexWith(DUMMY_KMA_SERVICE_KEY, DUMMY_AIRKOREA_SERVICE_KEY);

    expect(() =>
      mod.createProductionApiApp({ AIRKOREA_SERVICE_KEY: DUMMY_AIRKOREA_SERVICE_KEY } as NodeJS.ProcessEnv),
    ).toThrow('KMA_SERVICE_KEY');
  });

  it('fails fast (throws) when the explicit environment has no AIRKOREA_SERVICE_KEY', async () => {
    const mod = await importIndexWith(DUMMY_KMA_SERVICE_KEY, DUMMY_AIRKOREA_SERVICE_KEY);

    expect(() =>
      mod.createProductionApiApp({ KMA_SERVICE_KEY: DUMMY_KMA_SERVICE_KEY } as NodeJS.ProcessEnv),
    ).toThrow('AIRKOREA_SERVICE_KEY');
  });
});
