import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApiApp, type ApiAppDependencies } from './app';

/**
 * These tests exercise the PR #31 app factory (`createApiApp`) with a **fake** `/weather` sub-app, so the
 * app wiring is verified without `process.env`, a KMA service, a clock, or any network. They pin the
 * unchanged `GET /health` contract, the exact `/weather` mount (`POST /weather` → the sub-app's `POST /`,
 * never `/weather/weather`), factory isolation, and the absence of any new global `onError`/`notFound`.
 */

// ---------------------------------------------------------------------------
// A fake weather sub-app: records the calls its own `POST /` receives and returns a marker body. This is
// the exact shape the real PR #30 `createWeatherRoute(...)` returns — a mountable Hono sub-app owning
// `POST /` — so the factory cannot tell the fake from the real one.
// ---------------------------------------------------------------------------

function fakeWeatherRoute(marker: string): { route: Hono; calls: string[] } {
  const calls: string[] = [];
  const route = new Hono();
  route.post('/', (c) => {
    calls.push(marker);
    return c.json({ weather: marker }, 200);
  });
  return { route, calls };
}

function makeDeps(overrides: Partial<ApiAppDependencies> = {}): ApiAppDependencies {
  return {
    weatherRoute: fakeWeatherRoute('default').route,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// A — health regression.
// ---------------------------------------------------------------------------

describe('createApiApp — GET /health regression', () => {
  it('returns the exact deterministic 200 JSON health payload, unchanged by the weather mount', async () => {
    const app = createApiApp(makeDeps());

    const res = await app.request('/health');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('life-weather-api');
    // Exactly the two health keys — mounting /weather adds nothing to the health body.
    expect(Object.keys(body).sort()).toEqual(['service', 'status']);
  });

  it('serves health identically whichever weather sub-app is mounted', async () => {
    const appA = createApiApp(makeDeps({ weatherRoute: fakeWeatherRoute('A').route }));
    const appB = createApiApp(makeDeps({ weatherRoute: fakeWeatherRoute('B').route }));

    const [a, b] = await Promise.all([appA.request('/health'), appB.request('/health')]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await a.json()).toEqual({ status: 'ok', service: 'life-weather-api' });
    expect(await b.json()).toEqual({ status: 'ok', service: 'life-weather-api' });
  });
});

// ---------------------------------------------------------------------------
// B — weather mount (exactly at /weather, never /weather/weather).
// ---------------------------------------------------------------------------

describe('createApiApp — /weather mount', () => {
  it('routes POST /weather to the sub-app POST / (mounted exactly once)', async () => {
    const weather = fakeWeatherRoute('mounted');
    const app = createApiApp(makeDeps({ weatherRoute: weather.route }));

    const res = await app.request('/weather', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ weather: 'mounted' });
    expect(weather.calls).toEqual(['mounted']);
  });

  it('does NOT create a doubled /weather/weather path', async () => {
    const weather = fakeWeatherRoute('mounted');
    const app = createApiApp(makeDeps({ weatherRoute: weather.route }));

    const res = await app.request('/weather/weather', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(404);
    expect(weather.calls).toHaveLength(0);
  });

  it('does not reach the weather handler for POST / on the parent', async () => {
    const weather = fakeWeatherRoute('mounted');
    const app = createApiApp(makeDeps({ weatherRoute: weather.route }));

    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(404);
    expect(weather.calls).toHaveLength(0);
  });

  it('does not reach the weather handler for POST /unknown', async () => {
    const weather = fakeWeatherRoute('mounted');
    const app = createApiApp(makeDeps({ weatherRoute: weather.route }));

    const res = await app.request('/unknown', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(404);
    expect(weather.calls).toHaveLength(0);
  });

  it('does not reach the weather POST handler for GET /weather', async () => {
    const weather = fakeWeatherRoute('mounted');
    const app = createApiApp(makeDeps({ weatherRoute: weather.route }));

    const res = await app.request('/weather', { method: 'GET' });

    expect(res.status).toBe(404);
    expect(weather.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// C — factory isolation (no shared module state).
// ---------------------------------------------------------------------------

describe('createApiApp — factory isolation', () => {
  it('keeps two apps independent — each routes to its own weather sub-app', async () => {
    const weatherA = fakeWeatherRoute('A');
    const weatherB = fakeWeatherRoute('B');
    const appA = createApiApp(makeDeps({ weatherRoute: weatherA.route }));
    const appB = createApiApp(makeDeps({ weatherRoute: weatherB.route }));

    const [resA, resB] = await Promise.all([
      appA.request('/weather', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      appB.request('/weather', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    ]);

    expect(await resA.json()).toEqual({ weather: 'A' });
    expect(await resB.json()).toEqual({ weather: 'B' });
    expect(weatherA.calls).toEqual(['A']);
    expect(weatherB.calls).toEqual(['B']);

    // Distinct app instances — no shared singleton.
    expect(appA).not.toBe(appB);
  });
});

// ---------------------------------------------------------------------------
// D — no new global onError / notFound, no leaked top-level behavior change.
// ---------------------------------------------------------------------------

describe('createApiApp — no new global policy', () => {
  it('returns Hono default 404 for an unknown route (no custom notFound)', async () => {
    const app = createApiApp(makeDeps());

    const res = await app.request('/does-not-exist');

    expect(res.status).toBe(404);
    // Hono's default notFound is a plain-text "404 Not Found", not a JSON envelope of the factory's.
    const text = await res.text();
    expect(text).toBe('404 Not Found');
  });

  it('does not install a custom global onError — a sub-app throw surfaces as Hono default 500', async () => {
    // A sub-app whose POST / throws models an uncaught error reaching the parent. The factory adds no
    // onError, so Hono's own default error handling (a 500) applies — no custom envelope, no logging.
    const throwing = new Hono();
    throwing.post('/', () => {
      throw new Error('sub-app boom');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = createApiApp(makeDeps({ weatherRoute: throwing }));

    const res = await app.request('/weather', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(500);
    // The raw error message is not surfaced by any custom factory handler.
    const text = await res.text();
    expect(text).not.toContain('sub-app boom');
    errorSpy.mockRestore();
  });
});
