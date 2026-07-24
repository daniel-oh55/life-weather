import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CONTRACT_VERSION,
  isoDateTime,
  weatherErrorResponseV1,
  weatherResponseV1,
  weatherSuccessResponseV1,
  type WeatherLocation,
  type WeatherResponseV1,
} from '@life-weather/contracts';
import { KmaForecastProduct } from '@life-weather/weather-core';

import { createApiApp } from '../app';
import { createWeatherRoute } from '../routes';
import type { KmaForecastRequestClock } from '../services';
import {
  createProductionWeatherRouteDependencies,
  KMA_SERVICE_KEY_REQUIRED_MESSAGE,
  PRODUCTION_WEATHER_PRODUCT,
  type ProductionWeatherRouteOptions,
} from './weather-route';

/**
 * These tests assemble the **real** PR #31 production `/weather` route composition
 * (`createProductionWeatherRouteDependencies`) over the real PR #27 KMA production graph, the real PR #30
 * route factory, and the real PR #31 app factory. Nothing is mocked except the network (an injected
 * in-memory `fetchImpl`) and, where a deterministic instant is needed, the KMA request-plan clock and the
 * response `meta` clock/`requestId` factory. No real service key, no external network, and no fake timers.
 *
 * They cover: the server-owned product policy, the service→route adapter (input + exact AbortSignal +
 * verbatim result), the response `meta` provider (server clock + server `requestId`, inbound headers
 * ignored), the `KMA_SERVICE_KEY` fail-fast, construction side effects, the full app integration
 * (`POST /weather` success / 400 / 413 / 415 / 422 / abort, `GET /health`), and the secret-leak boundary.
 */

const SHORT = KmaForecastProduct.SHORT_FORECAST;
const ULTRA = KmaForecastProduct.ULTRA_SHORT_FORECAST;

/** Seoul: a supported KMA location. The real PR #12 converter projects it to grid `60/127`. */
const SEOUL_LATITUDE = 37.5665;
const SEOUL_LONGITUDE = 126.978;

/** Null Island: physically valid but outside the KMA coverage box → converter returns null. */
const NULL_ISLAND_LATITUDE = 0;
const NULL_ISLAND_LONGITUDE = 0;

/** An obviously fake, decoded-shaped service key. Never a real/production key. */
const FAKE_KMA_SERVICE_KEY = 'test-only-decoded-key+slash==';

/** The task's secret marker: it must never appear in any response body (success or error). */
const SECRET_KEY_MARKER = 'test-kma-secret-marker';

/**
 * `2026-07-22T05:10:00.000+09:00` as absolute epoch ms, computed with `Date.UTC` (pure, deterministic).
 * Under the production candidate selector this SHORT instant yields primary `20260722/0500`. First clock
 * read (request-plan reference).
 */
const CLOCK_AT_0510_KST_20260722 = Date.UTC(2026, 6, 21, 20, 10, 0, 0);

/** A distinct, later instant used as the second clock read (the resolver's `fetchedAt`). */
const FETCHED_AT_EPOCH_MS = Date.UTC(2026, 6, 21, 20, 11, 22, 333);

/** The UTC `Z` ms ISO string the resolver derives from {@link FETCHED_AT_EPOCH_MS}. */
const FETCHED_AT_ISO = '2026-07-21T20:11:22.333Z';

/** The fixed app-internal `sourceId` for a KMA 단기예보 hourly source. */
const SHORT_SOURCE_ID = 'kma-short-forecast-hourly';

/** The injected response-`meta` clock instant (distinct from the KMA data clock) and its ISO string. */
const META_GENERATED_AT_ISO = '2026-07-24T05:05:00.000Z';

/** Internal keys that must never appear at any depth of a serialized `/weather` response. */
const FORBIDDEN_KEYS = [
  'selection',
  'execution',
  'primary',
  'previous',
  'trace',
  'product',
  'fallbackUsed',
  'selected',
  'primaryIssuance',
  'previousIssuance',
  'baseDate',
  'baseTime',
  'nx',
  'ny',
  'grid',
  'serviceKey',
  'ServiceKey',
] as const;

/** Transport secrets / raw-KMA values that must never leak into a response body. */
const FORBIDDEN_LEAKAGE_STRINGS = [
  FAKE_KMA_SERVICE_KEY,
  'apis.data.go.kr',
  'fcstValue',
  'NORMAL_SERVICE',
  '적설없음',
  '1.0mm',
];

const encoder = new TextEncoder();
const byteLen = (value: string): number => encoder.encode(value).length;

// ---------------------------------------------------------------------------
// Fixtures (fresh per call).
// ---------------------------------------------------------------------------

function makeLocation(overrides: Partial<WeatherLocation> = {}): WeatherLocation {
  return {
    id: 'loc_seoul_jung',
    displayName: '서울특별시 중구',
    countryCode: 'KR',
    adminArea1: '서울특별시',
    adminArea2: '중구',
    adminArea3: null,
    latitude: SEOUL_LATITUDE,
    longitude: SEOUL_LONGITUDE,
    timezone: 'Asia/Seoul',
    ...overrides,
  };
}

function requestBody(overrides: Partial<WeatherLocation> = {}): string {
  return JSON.stringify({ location: makeLocation(overrides) });
}

/** A fixed fake KMA request-plan clock with a `vi.fn` so its read count is directly assertable. */
function fixedClock(epochMilliseconds: number) {
  const nowEpochMilliseconds = vi.fn(() => epochMilliseconds);
  const clock: KmaForecastRequestClock = { nowEpochMilliseconds };
  return { clock, nowEpochMilliseconds };
}

/** A fake clock returning `values[i]` on its i-th call (last value repeats). */
function scriptedClock(values: readonly number[]) {
  const nowEpochMilliseconds = vi.fn((): number => {
    const callIndex = nowEpochMilliseconds.mock.calls.length - 1;
    return values[Math.min(callIndex, values.length - 1)];
  });
  const clock: KmaForecastRequestClock = { nowEpochMilliseconds };
  return { clock, nowEpochMilliseconds };
}

/** A fake clock that works for the request plan (first call) but throws on the resolver read. */
function throwingSecondClock(firstValue: number, error: unknown) {
  const nowEpochMilliseconds = vi.fn((): number => {
    const callIndex = nowEpochMilliseconds.mock.calls.length - 1;
    if (callIndex === 0) {
      return firstValue;
    }
    throw error;
  });
  const clock: KmaForecastRequestClock = { nowEpochMilliseconds };
  return { clock, nowEpochMilliseconds };
}

interface FetchRecord {
  readonly url: unknown;
  readonly init: RequestInit | undefined;
}

/** An in-memory `fetch` that records calls and returns a fresh `Response` from `makeResponse(index)`. */
function recordingFetch(makeResponse: (callIndex: number) => Response) {
  const calls: FetchRecord[] = [];
  const fetchImpl = ((url: unknown, init?: RequestInit) => {
    const index = calls.length;
    calls.push({ url, init });
    return Promise.resolve(makeResponse(index));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** A `fetch` that must never run — throws loudly if the provider ever calls it. */
function neverCalledFetch() {
  const calls: FetchRecord[] = [];
  const fetchImpl = ((url: unknown, init?: RequestInit) => {
    calls.push({ url, init });
    throw new Error('test setup: fetch was called but should not have been');
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

interface RawItem {
  baseDate: string;
  baseTime: string;
  category: string;
  fcstDate: string;
  fcstTime: string;
  fcstValue: string | null;
  nx: number;
  ny: number;
}

const SHORT_SLOT_CATEGORY_VALUES: ReadonlyArray<{ category: string; fcstValue: string }> = [
  { category: 'TMP', fcstValue: '25.5' },
  { category: 'SKY', fcstValue: '1' },
  { category: 'PTY', fcstValue: '0' },
  { category: 'POP', fcstValue: '20' },
  { category: 'PCP', fcstValue: '1.0mm' },
  { category: 'SNO', fcstValue: '적설없음' },
  { category: 'REH', fcstValue: '55' },
  { category: 'WSD', fcstValue: '3.4' },
  { category: 'VEC', fcstValue: '270' },
];

/** A complete SHORT slot (all nine categories) dated to `baseTime`, at the Seoul grid `60/127`. */
function completeShortSlotItems(baseTime: string): RawItem[] {
  return SHORT_SLOT_CATEGORY_VALUES.map(({ category, fcstValue }) => ({
    baseDate: '20260722',
    baseTime,
    category,
    fcstDate: '20260722',
    fcstTime: '0600',
    fcstValue,
    nx: 60,
    ny: 127,
  }));
}

function successBody(items: readonly RawItem[], options: { totalCount?: number } = {}): string {
  return JSON.stringify({
    response: {
      header: { resultCode: '00', resultMsg: 'NORMAL_SERVICE' },
      body: {
        dataType: 'JSON',
        pageNo: 1,
        numOfRows: 1000,
        totalCount: options.totalCount ?? items.length,
        items: { item: items },
      },
    },
  });
}

function emptySuccessBody(): string {
  return successBody([], { totalCount: 0 });
}

function jsonOk(bodyString: string): Response {
  return new Response(bodyString, { status: 200 });
}

/** The nine-category slot normalizes to exactly this `HourlyForecast` at forecast time `0600`. */
const EXPECTED_SHORT_FORECAST_AT_0600 = {
  forecastAt: '2026-07-22T06:00:00+09:00',
  condition: 'CLEAR',
  temperatureCelsius: 25.5,
  feelsLikeCelsius: null,
  precipitationProbabilityPercent: 20,
  precipitationAmountMillimeters: 1,
  snowfallAmountCentimeters: 0,
  humidityPercent: 55,
  windSpeedMetersPerSecond: 3.4,
  windDirectionDegrees: 270,
};

// ---------------------------------------------------------------------------
// Assertion helpers.
// ---------------------------------------------------------------------------

function collectKeys(value: unknown, keys: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const element of value) {
      collectKeys(element, keys);
    }
  } else if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      keys.add(key);
      collectKeys((value as Record<string, unknown>)[key], keys);
    }
  }
  return keys;
}

function expectNoForbiddenKeys(response: unknown): void {
  const present = collectKeys(response);
  for (const forbidden of FORBIDDEN_KEYS) {
    expect(present.has(forbidden)).toBe(false);
  }
}

function expectNoLeakage(value: unknown, ...extra: readonly string[]): void {
  const serialized = JSON.stringify(value);
  for (const forbidden of [...FORBIDDEN_LEAKAGE_STRINGS, ...extra]) {
    expect(serialized).not.toContain(forbidden);
  }
}

/** Build the full production app for a given set of options. */
function buildApp(options: ProductionWeatherRouteOptions) {
  return createApiApp({
    weatherRoute: createWeatherRoute(createProductionWeatherRouteDependencies(options)),
  });
}

function postWeather(
  app: ReturnType<typeof buildApp>,
  init: { body?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const requestInit: RequestInit = {
    method: 'POST',
    headers: init.headers ?? { 'content-type': 'application/json' },
  };
  if (init.body !== undefined) {
    requestInit.body = init.body;
  }
  return Promise.resolve(app.request('/weather', requestInit));
}

function spyOnConsole() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  return {
    expectSilent(): void {
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 13.A — server-owned product policy.
// ---------------------------------------------------------------------------

describe('createProductionWeatherRouteDependencies — product policy', () => {
  it('fixes the product to SHORT_FORECAST, independent of any client/request input', () => {
    expect(PRODUCTION_WEATHER_PRODUCT).toBe(KmaForecastProduct.SHORT_FORECAST);

    const deps = createProductionWeatherRouteDependencies({
      serviceKey: FAKE_KMA_SERVICE_KEY,
      fetchImpl: neverCalledFetch().fetchImpl,
    });

    // The dependency product equals the named constant (which equals the enum value), never ULTRA.
    expect(deps.product).toBe(PRODUCTION_WEATHER_PRODUCT);
    expect(deps.product).toBe(SHORT);
    expect(deps.product).not.toBe(ULTRA);
  });
});

// ---------------------------------------------------------------------------
// 13.B — service→route adapter (input + exact AbortSignal + verbatim result).
// ---------------------------------------------------------------------------

describe('createProductionWeatherRouteDependencies — service adapter', () => {
  it('forwards the input to the KMA service unchanged and returns the internal result verbatim', async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonOk(successBody(completeShortSlotItems('0500'))),
    );
    const { clock } = scriptedClock([CLOCK_AT_0510_KST_20260722, FETCHED_AT_EPOCH_MS]);
    const deps = createProductionWeatherRouteDependencies({
      serviceKey: FAKE_KMA_SERVICE_KEY,
      fetchImpl,
      clock,
    });

    const controller = new AbortController();
    const result = await deps.executeOverview(
      { product: PRODUCTION_WEATHER_PRODUCT, location: makeLocation() },
      controller.signal,
    );

    // The input reached the KMA graph unchanged: the request is dated to the availability-aware 0500
    // issuance at the real Seoul grid.
    expect(calls).toHaveLength(1);
    const url = calls[0].url as URL;
    expect(url.searchParams.get('base_time')).toBe('0500');
    expect(url.searchParams.get('nx')).toBe('60');
    expect(url.searchParams.get('ny')).toBe('127');

    // The adapter returns the PR #24 INTERNAL result verbatim (selection + overview), not a presenter
    // body — proving it applies no transformation.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect('selection' in result).toBe(true);
      expect('overview' in result).toBe(true);
      expect(result.overview.hourly).toEqual([EXPECTED_SHORT_FORECAST_AT_0600]);
    }
  });

  it('forwards the exact caller AbortSignal to the service — a pre-aborted signal short-circuits before any fetch (no new controller)', async () => {
    const { fetchImpl, calls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = scriptedClock([
      CLOCK_AT_0510_KST_20260722,
      FETCHED_AT_EPOCH_MS,
    ]);
    const deps = createProductionWeatherRouteDependencies({
      serviceKey: FAKE_KMA_SERVICE_KEY,
      fetchImpl,
      clock,
    });

    const controller = new AbortController();
    controller.abort();

    const result = await deps.executeOverview(
      { product: PRODUCTION_WEATHER_PRODUCT, location: makeLocation() },
      controller.signal,
    );

    // The provider saw the aborted caller signal and short-circuited before fetch → no selection. If the
    // adapter had wrapped the signal in a new controller, the provider would have proceeded to fetch.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.selection.selected).toBe(false);
    }
    expect(calls).toHaveLength(0);
    // The request plan read the clock once; with no selected source the resolver never ran.
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 13.C — response meta: clock / generatedAt.
// ---------------------------------------------------------------------------

describe('createProductionWeatherRouteDependencies — meta clock', () => {
  it('uses an injected clock for generatedAt in exact ISO millisecond Z format, calling it exactly once per meta', () => {
    const now = vi.fn(() => new Date(META_GENERATED_AT_ISO));
    const deps = createProductionWeatherRouteDependencies({
      serviceKey: FAKE_KMA_SERVICE_KEY,
      fetchImpl: neverCalledFetch().fetchImpl,
      now,
    });

    // Not called at construction.
    expect(now).not.toHaveBeenCalled();

    const meta = deps.createMeta(
      new Request('http://localhost/weather', { method: 'POST' }),
    );

    expect(meta.generatedAt).toBe(META_GENERATED_AT_ISO);
    expect(meta.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(isoDateTime.safeParse(meta.generatedAt).success).toBe(true);
    expect(now).toHaveBeenCalledTimes(1);
  });

  it('defaults generatedAt to the real UTC clock (Z form) with no injected clock', () => {
    const deps = createProductionWeatherRouteDependencies({
      serviceKey: FAKE_KMA_SERVICE_KEY,
      fetchImpl: neverCalledFetch().fetchImpl,
    });

    const meta = deps.createMeta(
      new Request('http://localhost/weather', { method: 'POST' }),
    );

    expect(isoDateTime.safeParse(meta.generatedAt).success).toBe(true);
    expect(meta.generatedAt.endsWith('Z')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 13.D — response meta: server-generated requestId, inbound headers ignored.
// ---------------------------------------------------------------------------

describe('createProductionWeatherRouteDependencies — meta requestId', () => {
  it('uses an injected requestId factory (called once) and ignores inbound x-request-id / x-vercel-id', () => {
    const createRequestId = vi.fn(() => 'req-server-generated-777');
    const deps = createProductionWeatherRouteDependencies({
      serviceKey: FAKE_KMA_SERVICE_KEY,
      fetchImpl: neverCalledFetch().fetchImpl,
      createRequestId,
    });

    expect(createRequestId).not.toHaveBeenCalled();

    const meta = deps.createMeta(
      new Request('http://localhost/weather', {
        method: 'POST',
        headers: {
          'x-request-id': 'inbound-x-request-id-MUST-BE-IGNORED',
          'x-vercel-id': 'inbound-x-vercel-id-MUST-BE-IGNORED',
        },
      }),
    );

    expect(meta.requestId).toBe('req-server-generated-777');
    expect(meta.requestId).not.toBe('inbound-x-request-id-MUST-BE-IGNORED');
    expect(meta.requestId).not.toBe('inbound-x-vercel-id-MUST-BE-IGNORED');
    expect(createRequestId).toHaveBeenCalledTimes(1);
  });

  it('defaults requestId to a fresh non-empty UUID string per meta', () => {
    const deps = createProductionWeatherRouteDependencies({
      serviceKey: FAKE_KMA_SERVICE_KEY,
      fetchImpl: neverCalledFetch().fetchImpl,
    });

    const first = deps.createMeta(new Request('http://localhost/weather', { method: 'POST' }));
    const second = deps.createMeta(new Request('http://localhost/weather', { method: 'POST' }));

    expect(typeof first.requestId).toBe('string');
    expect((first.requestId ?? '').length).toBeGreaterThan(0);
    // A UUID is generated freshly per meta, so two metas differ.
    expect(first.requestId).not.toBe(second.requestId);
  });
});

// ---------------------------------------------------------------------------
// 13.E — KMA_SERVICE_KEY validation and fail-fast.
// ---------------------------------------------------------------------------

describe('createProductionWeatherRouteDependencies — service key fail-fast', () => {
  it.each([
    { name: 'empty', key: '' },
    { name: 'whitespace-only (spaces)', key: '   ' },
    { name: 'whitespace-only (tab/newline)', key: '\t\n' },
  ])('throws the fixed safe message for a $name key, with no fetch', ({ key }) => {
    const { fetchImpl, calls } = neverCalledFetch();

    expect(() =>
      createProductionWeatherRouteDependencies({ serviceKey: key, fetchImpl }),
    ).toThrow(KMA_SERVICE_KEY_REQUIRED_MESSAGE);
    expect(calls).toHaveLength(0);
  });

  it('throws for a whitespace-padded secret-shaped key without leaking the key value', () => {
    const { fetchImpl, calls } = neverCalledFetch();
    const paddedSecret = `  ${SECRET_KEY_MARKER}-padded==  `;

    let caught: unknown;
    try {
      createProductionWeatherRouteDependencies({ serviceKey: paddedSecret, fetchImpl });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(KMA_SERVICE_KEY_REQUIRED_MESSAGE);
    expect((caught as Error).message).not.toContain(SECRET_KEY_MARKER);
    expect(calls).toHaveLength(0);
  });

  it('accepts a non-empty key and keeps it off the response body (used only in transport)', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonOk(successBody(completeShortSlotItems('0500'))),
    );
    const { clock } = scriptedClock([CLOCK_AT_0510_KST_20260722, FETCHED_AT_EPOCH_MS]);
    const app = buildApp({ serviceKey: FAKE_KMA_SERVICE_KEY, fetchImpl, clock });

    const res = await postWeather(app, { body: requestBody() });
    const body = (await res.json()) as WeatherResponseV1;

    expect(res.status).toBe(200);
    // The key round-trips through the transport URL but never onto the response surface.
    expectNoLeakage(body);
  });
});

// ---------------------------------------------------------------------------
// 13.F — construction side effects (none).
// ---------------------------------------------------------------------------

describe('createProductionWeatherRouteDependencies — construction is side-effect free', () => {
  it('reads no clock, generates no requestId, calls no fetch, and logs nothing at construction', () => {
    const consoleSpy = spyOnConsole();
    const { fetchImpl, calls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);
    const now = vi.fn(() => new Date(META_GENERATED_AT_ISO));
    const createRequestId = vi.fn(() => 'unused-at-construction');

    createProductionWeatherRouteDependencies({
      serviceKey: FAKE_KMA_SERVICE_KEY,
      fetchImpl,
      clock,
      now,
      createRequestId,
    });

    expect(calls).toHaveLength(0);
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(createRequestId).not.toHaveBeenCalled();
    consoleSpy.expectSilent();
  });
});

// ---------------------------------------------------------------------------
// 14 — full production app integration through POST /weather and GET /health.
// ---------------------------------------------------------------------------

describe('production app integration — POST /weather', () => {
  it('A. valid request → 200 WeatherSuccessResponseV1 with server-owned SHORT_FORECAST source and server meta', async () => {
    const { fetchImpl, calls } = recordingFetch((index) =>
      index === 0
        ? jsonOk(successBody(completeShortSlotItems('0500')))
        : new Response('unexpected second fetch', { status: 500 }),
    );
    const { clock } = scriptedClock([CLOCK_AT_0510_KST_20260722, FETCHED_AT_EPOCH_MS]);
    const app = buildApp({
      serviceKey: FAKE_KMA_SERVICE_KEY,
      fetchImpl,
      clock,
      now: () => new Date(META_GENERATED_AT_ISO),
      createRequestId: () => 'req-integration-success',
    });

    const res = await postWeather(app, { body: requestBody() });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as WeatherResponseV1;
    expect(weatherSuccessResponseV1.safeParse(body).success).toBe(true);
    if (!body.ok) {
      throw new Error('expected a success response');
    }

    // Exactly one upstream call, dated to the server-owned SHORT product's 0500 issuance.
    expect(calls).toHaveLength(1);
    const url = calls[0].url as URL;
    expect(url.pathname.endsWith('/getVilageFcst')).toBe(true);

    // The public overview carries the SHORT hourly source and its provenance.
    expect(body.data.hourly).toEqual([EXPECTED_SHORT_FORECAST_AT_0600]);
    expect(body.data.sources).toHaveLength(1);
    expect(body.data.sources[0].sourceId).toBe(SHORT_SOURCE_ID);
    expect(body.data.sources[0].fetchedAt).toBe(FETCHED_AT_ISO);

    // Server-owned meta: contractVersion from the route, generatedAt from the meta clock, requestId
    // server-generated (distinct from the KMA data clock's fetchedAt).
    expect(body.meta.contractVersion).toBe(CONTRACT_VERSION);
    expect(body.meta.generatedAt).toBe(META_GENERATED_AT_ISO);
    expect(body.meta.requestId).toBe('req-integration-success');

    // No selection/trace/service-key leak.
    expectNoForbiddenKeys(body);
    expectNoLeakage(body);
    expect(Object.keys(body).sort()).toEqual(['data', 'meta', 'ok']);
  });

  it('B. unsupported location (Null Island) → 422 UNSUPPORTED_LOCATION, no fetch', async () => {
    const { fetchImpl, calls } = neverCalledFetch();
    const { clock } = scriptedClock([CLOCK_AT_0510_KST_20260722, FETCHED_AT_EPOCH_MS]);
    const app = buildApp({ serviceKey: FAKE_KMA_SERVICE_KEY, fetchImpl, clock });

    const res = await postWeather(app, {
      body: requestBody({ latitude: NULL_ISLAND_LATITUDE, longitude: NULL_ISLAND_LONGITUDE }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as WeatherResponseV1;
    expect(weatherErrorResponseV1.safeParse(body).success).toBe(true);
    if (body.ok) {
      throw new Error('expected an error response');
    }
    expect(body.error.code).toBe('UNSUPPORTED_LOCATION');
    expect(calls).toHaveLength(0);
    expectNoForbiddenKeys(body);
  });

  it('C. invalid request body → 400 INVALID_REQUEST, no fetch', async () => {
    const { fetchImpl, calls } = neverCalledFetch();
    const { clock } = scriptedClock([CLOCK_AT_0510_KST_20260722, FETCHED_AT_EPOCH_MS]);
    const app = buildApp({ serviceKey: FAKE_KMA_SERVICE_KEY, fetchImpl, clock });

    const res = await postWeather(app, { body: JSON.stringify({}) });

    expect(res.status).toBe(400);
    const body = (await res.json()) as WeatherResponseV1;
    if (body.ok) {
      throw new Error('expected an error response');
    }
    expect(body.error.code).toBe('INVALID_REQUEST');
    expect(calls).toHaveLength(0);
  });

  it('D. unsupported media type → 415, no fetch', async () => {
    const { fetchImpl, calls } = neverCalledFetch();
    const { clock } = scriptedClock([CLOCK_AT_0510_KST_20260722, FETCHED_AT_EPOCH_MS]);
    const app = buildApp({ serviceKey: FAKE_KMA_SERVICE_KEY, fetchImpl, clock });

    const res = await postWeather(app, {
      headers: { 'content-type': 'text/plain' },
      body: requestBody(),
    });

    expect(res.status).toBe(415);
    const body = (await res.json()) as WeatherResponseV1;
    if (body.ok) {
      throw new Error('expected an error response');
    }
    expect(body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(calls).toHaveLength(0);
  });

  it('E. payload too large → 413, no fetch', async () => {
    const { fetchImpl, calls } = neverCalledFetch();
    const { clock } = scriptedClock([CLOCK_AT_0510_KST_20260722, FETCHED_AT_EPOCH_MS]);
    const app = buildApp({ serviceKey: FAKE_KMA_SERVICE_KEY, fetchImpl, clock });

    const base = requestBody();
    const oversized = base + ' '.repeat(16 * 1024 + 1 - byteLen(base));
    expect(byteLen(oversized)).toBe(16 * 1024 + 1);

    const res = await postWeather(app, { body: oversized });

    expect(res.status).toBe(413);
    const body = (await res.json()) as WeatherResponseV1;
    if (body.ok) {
      throw new Error('expected an error response');
    }
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(calls).toHaveLength(0);
  });

  it('F. a pre-aborted request signal reaches the provider through the adapter (no fetch, no new controller)', async () => {
    const { fetchImpl, calls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = scriptedClock([
      CLOCK_AT_0510_KST_20260722,
      FETCHED_AT_EPOCH_MS,
    ]);
    const app = buildApp({ serviceKey: FAKE_KMA_SERVICE_KEY, fetchImpl, clock });

    const request = new Request('http://localhost/weather', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody(),
      signal: AbortSignal.abort(),
    });
    const res = await app.request(request);

    // The primary attempt saw the aborted signal and never fetched → a no-selection 200 overview.
    expect(res.status).toBe(200);
    const body = (await res.json()) as WeatherResponseV1;
    if (!body.ok) {
      throw new Error('expected a success response');
    }
    expect(body.data.hourly).toEqual([]);
    expect(body.data.missingSections).toContain('HOURLY');
    expect(calls).toHaveLength(0);
    // Request plan built once; no selected source → resolver never read the clock.
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
  });
});

describe('production app integration — GET /health', () => {
  it('G. still serves the unchanged deterministic health payload', async () => {
    const app = buildApp({
      serviceKey: FAKE_KMA_SERVICE_KEY,
      fetchImpl: neverCalledFetch().fetchImpl,
    });

    const res = await app.request('/health');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ status: 'ok', service: 'life-weather-api' });
  });
});

// ---------------------------------------------------------------------------
// 16 — secret-leak boundary: the marker key never appears in any response body.
// ---------------------------------------------------------------------------

describe('production /weather — secret marker never leaks into a response', () => {
  const markerKey = `${SECRET_KEY_MARKER}-live==`;

  it('success path: the service key does not appear in the body', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonOk(successBody(completeShortSlotItems('0500'))),
    );
    const { clock } = scriptedClock([CLOCK_AT_0510_KST_20260722, FETCHED_AT_EPOCH_MS]);
    const app = buildApp({ serviceKey: markerKey, fetchImpl, clock });

    const res = await postWeather(app, { body: requestBody() });
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).not.toContain(SECRET_KEY_MARKER);
  });

  it('unsupported-location (422) path: no marker', async () => {
    const { fetchImpl } = neverCalledFetch();
    const { clock } = scriptedClock([CLOCK_AT_0510_KST_20260722, FETCHED_AT_EPOCH_MS]);
    const app = buildApp({ serviceKey: markerKey, fetchImpl, clock });

    const res = await postWeather(app, {
      body: requestBody({ latitude: NULL_ISLAND_LATITUDE, longitude: NULL_ISLAND_LONGITUDE }),
    });
    const text = await res.text();

    expect(res.status).toBe(422);
    expect(text).not.toContain(SECRET_KEY_MARKER);
  });

  it('validation-failure (400) path: no marker', async () => {
    const { fetchImpl } = neverCalledFetch();
    const { clock } = scriptedClock([CLOCK_AT_0510_KST_20260722, FETCHED_AT_EPOCH_MS]);
    const app = buildApp({ serviceKey: markerKey, fetchImpl, clock });

    const res = await postWeather(app, { body: JSON.stringify({}) });
    const text = await res.text();

    expect(res.status).toBe(400);
    expect(text).not.toContain(SECRET_KEY_MARKER);
  });

  it('internal-error (500) path: neither the marker nor the internal error leaks', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const internalSentinel = 'INTERNAL_SENTINEL_MUST_NOT_LEAK';
    const { fetchImpl } = recordingFetch(() =>
      jsonOk(successBody(completeShortSlotItems('0500'))),
    );
    // The primary fetch succeeds, then the resolver's clock read throws → the service rejects → the route
    // collapses it to a fixed INTERNAL_ERROR 500.
    const { clock } = throwingSecondClock(
      CLOCK_AT_0510_KST_20260722,
      new Error(internalSentinel),
    );
    const app = buildApp({ serviceKey: markerKey, fetchImpl, clock });

    const res = await postWeather(app, { body: requestBody() });
    const text = await res.text();

    expect(res.status).toBe(500);
    const body = JSON.parse(text) as WeatherResponseV1;
    expect(weatherResponseV1.safeParse(body).success).toBe(true);
    if (body.ok) {
      throw new Error('expected an error response');
    }
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(text).not.toContain(SECRET_KEY_MARKER);
    expect(text).not.toContain(internalSentinel);
    consoleErrorSpy.mockRestore();
  });
});
