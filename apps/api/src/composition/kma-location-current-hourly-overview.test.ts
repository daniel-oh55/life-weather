import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  weatherLocation,
  weatherOverview,
  type WeatherLocation,
} from '@life-weather/contracts';
import { KmaForecastProduct } from '@life-weather/weather-core';

import {
  createKmaLocationCurrentHourlyOverviewCompositionFromEnv,
  type KmaLocationCurrentHourlyOverviewCompositionDependencies,
} from './kma-location-current-hourly-overview.js';

/**
 * Layer A (below) isolates this composition's **wiring** — which of the two upstream compositions and
 * the PR #77 service factory it calls, in what order, with which exact references — by mocking the
 * three modules it imports directly (`../services/index.js`, `./kma-location-hourly-overview.js`,
 * `./kma-location-current-overview.js`) via `vi.doMock` + `vi.resetModules()` + a dynamic `import()`,
 * the same pattern the two upstream composition test files already use. Layer B (further below)
 * assembles the **real** PR #27 + PR #75 + PR #77 + PR #76 graph through the statically-imported
 * composition function above and mocks nothing except the network (an injected in-memory dispatching
 * `fetchImpl`) and the clock (an injected fake clock) — so together the two layers prove both the
 * wiring contract and the actual combined pipeline behaviour.
 */

const SHORT = KmaForecastProduct.SHORT_FORECAST;

/** A minimal structural clock port shared by both the hourly and current request factories. */
interface SharedRequestClock {
  readonly nowEpochMilliseconds: () => number;
}

/** An obviously fake, decoded-shaped service key. Never a real/production key. */
const FAKE_KMA_SERVICE_KEY = 'test-only-decoded-current-hourly-overview-key+slash==';

/** A secret-shaped key marker used only to prove the key never leaks into a result, error, or log. */
const SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR78 =
  'SECRET_SHAPED_KMA_CURRENT_HOURLY_OVERVIEW_KEY_MUST_NOT_LEAK_PR78+slash==';

/** Seoul: the real PR #12 converter projects this onto the KMA grid `{ nx: 60, ny: 127 }`. */
const SEOUL_LATITUDE = 37.5665;
const SEOUL_LONGITUDE = 126.978;

/** Null Island: a physically valid coordinate outside KMA coverage → converter returns null. */
const NULL_ISLAND_LATITUDE = 0;
const NULL_ISLAND_LONGITUDE = 0;

/** The fixed app-internal `sourceId` for a KMA 단기예보 hourly source. */
const SHORT_SOURCE_ID = 'kma-short-forecast-hourly';

/** The fixed app-internal `sourceId` for the KMA 초단기실황 (`getUltraSrtNcst`) endpoint. */
const CURRENT_SOURCE_ID = 'kma-ultra-short-current-observation';

/**
 * `2026-07-22T05:10:00.000+09:00` as absolute epoch milliseconds — the **first** clock read (the
 * hourly request-plan reference instant). Under the production PR #16 candidate selector this SHORT
 * instant yields the candidate pair `{ primary: 20260722/0500, previous: 20260722/0200 }`, matching
 * the same fixture already established in `kma-location-hourly-overview.test.ts`.
 */
const CLOCK_AT_0510_KST_20260722 = Date.UTC(2026, 6, 21, 20, 10, 0, 0);

/** The **second** clock read — the hourly PR #26 metadata resolver's `fetchedAt` materialization. */
const HOURLY_FETCHED_AT_EPOCH_MS = Date.UTC(2026, 6, 21, 20, 11, 22, 333);
const HOURLY_FETCHED_AT_ISO = '2026-07-21T20:11:22.333Z';

/**
 * The **third** clock read — the current PR #66 request factory's reference instant. Still within the
 * same KST hour (05:xx) as the first read, so the PR #64 schedule-only selector also truncates to the
 * same `0500` issuance.
 */
const CURRENT_REQUEST_EPOCH_MS = Date.UTC(2026, 6, 21, 20, 12, 10, 0);

/** The **fourth** clock read — the current PR #73 metadata resolver's `fetchedAt` materialization. */
const CURRENT_FETCHED_AT_EPOCH_MS = Date.UTC(2026, 6, 21, 20, 13, 45, 678);
const CURRENT_FETCHED_AT_ISO = '2026-07-21T20:13:45.678Z';

/** A fresh environment object per call, so no test shares a mutable env reference. */
function makeEnv(serviceKey?: string): NodeJS.ProcessEnv {
  return serviceKey === undefined
    ? ({} as NodeJS.ProcessEnv)
    : ({ KMA_SERVICE_KEY: serviceKey } as NodeJS.ProcessEnv);
}

/** A fresh, complete, schema-valid `WeatherLocation` at Seoul; overridable per field for edge cases. */
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

/** A fresh caller input (`product` + full `WeatherLocation`). */
function makeInput(overrides: Partial<WeatherLocation> = {}) {
  return {
    product: SHORT,
    location: makeLocation(overrides),
  };
}

/** A fresh fixed fake clock at one instant, with a `vi.fn` so read count is directly assertable. */
function fixedClock(epochMilliseconds: number) {
  const nowEpochMilliseconds = vi.fn(() => epochMilliseconds);
  const clock: SharedRequestClock = { nowEpochMilliseconds };
  return { clock, nowEpochMilliseconds };
}

/**
 * A fresh fake clock that returns `values[i]` on its i-th call (the last value repeats for any extra
 * call). Used to give the four distinct roles (hourly request-plan, hourly resolver, current request,
 * current resolver) distinct instants from one shared clock object.
 */
function scriptedClock(values: readonly number[]) {
  const nowEpochMilliseconds = vi.fn((): number => {
    const callIndex = nowEpochMilliseconds.mock.calls.length - 1;
    return values[Math.min(callIndex, values.length - 1)];
  });
  const clock: SharedRequestClock = { nowEpochMilliseconds };
  return { clock, nowEpochMilliseconds };
}

interface FetchRecord {
  readonly url: URL;
  readonly init: RequestInit | undefined;
}

/** A `fetch` that must never run — fails the test loudly if either provider ever calls it. */
function neverCalledFetch() {
  const calls: FetchRecord[] = [];
  const fetchImpl = ((url: unknown, init?: RequestInit) => {
    calls.push({ url: url as URL, init });
    throw new Error('test setup: fetch was called but should not have been');
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/**
 * A fresh in-memory `fetch` that inspects the request URL path to dispatch between the hourly
 * `getVilageFcst` endpoint and the current `getUltraSrtNcst` endpoint, recording every call (in
 * invocation order, across both endpoints) and returning a fresh `Response` per call from the matching
 * handler. Each handler receives its own **per-endpoint** call index.
 */
function dispatchFetch(handlers: {
  readonly vilageFcst: (callIndex: number) => Response;
  readonly ultraSrtNcst: (callIndex: number) => Response;
}) {
  const calls: FetchRecord[] = [];
  let vilageFcstCallCount = 0;
  let ultraSrtNcstCallCount = 0;
  const fetchImpl = ((url: unknown, init?: RequestInit) => {
    const requestUrl = url as URL;
    calls.push({ url: requestUrl, init });
    if (requestUrl.pathname.endsWith('/getVilageFcst')) {
      const index = vilageFcstCallCount;
      vilageFcstCallCount += 1;
      return Promise.resolve(handlers.vilageFcst(index));
    }
    if (requestUrl.pathname.endsWith('/getUltraSrtNcst')) {
      const index = ultraSrtNcstCallCount;
      ultraSrtNcstCallCount += 1;
      return Promise.resolve(handlers.ultraSrtNcst(index));
    }
    throw new Error(`test setup: unexpected fetch path ${requestUrl.pathname}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

interface HourlyRawItem {
  baseDate: string;
  baseTime: string;
  category: string;
  fcstDate: string;
  fcstTime: string;
  fcstValue: string | null;
  nx: number;
  ny: number;
}

/** The nine categories (with values) of a complete SHORT forecast slot. */
const SHORT_SLOT_CATEGORY_VALUES: ReadonlyArray<{
  category: string;
  fcstValue: string;
}> = [
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

interface HourlySlotIdentity {
  readonly baseTime: string;
  readonly baseDate?: string;
  readonly fcstDate?: string;
  readonly fcstTime?: string;
  readonly nx?: number;
  readonly ny?: number;
}

/** A complete SHORT slot (all nine categories) dated to `identity.baseTime`, at the Seoul grid. */
function completeShortSlotItems(identity: HourlySlotIdentity): HourlyRawItem[] {
  const baseDate = identity.baseDate ?? '20260722';
  const fcstDate = identity.fcstDate ?? '20260722';
  const fcstTime = identity.fcstTime ?? '0600';
  const nx = identity.nx ?? 60;
  const ny = identity.ny ?? 127;
  return SHORT_SLOT_CATEGORY_VALUES.map(({ category, fcstValue }) => ({
    baseDate,
    baseTime: identity.baseTime,
    category,
    fcstDate,
    fcstTime,
    fcstValue,
    nx,
    ny,
  }));
}

interface CurrentRawItem {
  baseDate: string;
  baseTime: string;
  category: string;
  obsrValue: string | null;
  nx: number;
  ny: number;
}

/** A raw current-observation item at the `20260722`/`0500` issuance, Seoul grid `{ nx: 60, ny: 127 }`. */
function currentItem(overrides: Partial<CurrentRawItem> = {}): CurrentRawItem {
  return {
    baseDate: '20260722',
    baseTime: '0500',
    category: 'T1H',
    obsrValue: '23.5',
    nx: 60,
    ny: 127,
    ...overrides,
  };
}

/** The full set of categories 초단기실황 provides for the full-pipeline test. */
function fullCurrentSlotItems(): CurrentRawItem[] {
  return [
    currentItem({ category: 'T1H', obsrValue: '23.5' }),
    currentItem({ category: 'PTY', obsrValue: '0' }),
    currentItem({ category: 'REH', obsrValue: '55' }),
    currentItem({ category: 'WSD', obsrValue: '3.4' }),
    currentItem({ category: 'VEC', obsrValue: '270' }),
    currentItem({ category: 'RN1', obsrValue: '0' }),
  ];
}

/** Serialize a KMA success envelope (matching both providers' shared success shape). */
function successBody(items: readonly unknown[], options: { totalCount?: number } = {}): string {
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

/** A success envelope with `totalCount: 0` and an empty item array → normalizes to `hourly: []`. */
function emptySuccessBody(): string {
  return successBody([], { totalCount: 0 });
}

function jsonOk(bodyString: string): Response {
  return new Response(bodyString, { status: 200 });
}

/** The full nine-category slot normalizes to exactly this `HourlyForecast` at forecast time `0600`. */
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

/** `missingSections` when both HOURLY and CURRENT sources are present. */
const BOTH_PRESENT_MISSING = ['DAILY', 'AIR_QUALITY_CURRENT', 'AIR_QUALITY_FORECAST', 'ALERTS'];

/** `missingSections` when hourly has no selection but current is present. */
const HOURLY_MISSING_CURRENT_PRESENT = [
  'HOURLY',
  'DAILY',
  'AIR_QUALITY_CURRENT',
  'AIR_QUALITY_FORECAST',
  'ALERTS',
];

/** `missingSections` when hourly is present but current degraded to `null`. */
const CURRENT_MISSING_HOURLY_PRESENT = [
  'CURRENT',
  'DAILY',
  'AIR_QUALITY_CURRENT',
  'AIR_QUALITY_FORECAST',
  'ALERTS',
];

/**
 * Secret / raw-transport values that must never appear in a serialized composition/service result or
 * on the console. The overview legitimately echoes the caller's `location` (with its coordinates), so
 * raw latitude/longitude are **not** listed here — only transport secrets and raw KMA body fields.
 */
const FORBIDDEN_LEAKAGE_STRINGS = [
  FAKE_KMA_SERVICE_KEY,
  SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR78,
  'apis.data.go.kr',
  'ServiceKey',
  'fcstValue',
  'obsrValue',
  'NORMAL_SERVICE',
  '적설없음',
  '1.0mm',
];

function expectNoLeakage(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const forbidden of FORBIDDEN_LEAKAGE_STRINGS) {
    expect(serialized).not.toContain(forbidden);
  }
}

/** Compose successfully or fail the test — collapses the result-union narrowing in setup. */
function composeOrThrow(
  env: NodeJS.ProcessEnv,
  dependencies: KmaLocationCurrentHourlyOverviewCompositionDependencies,
) {
  const result = createKmaLocationCurrentHourlyOverviewCompositionFromEnv(env, dependencies);
  if (!result.ok) {
    throw new Error(
      `test setup: expected composition to succeed, got ${JSON.stringify(result)}`,
    );
  }
  return result.service;
}

/** Assert an object's own enumerable keys are exactly `keys` (order-independent). */
function expectExactKeys(value: object, keys: readonly string[]): void {
  expect(Object.keys(value).sort()).toEqual([...keys].sort());
}

/** Recursively freeze so any attempted mutation would throw in strict mode. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** Capture whatever a thunk throws synchronously, or `undefined` when it does not throw. */
function captureSynchronousError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Spy on all five console methods and provide silence assertion + restore. */
function spyOnConsole() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

  return {
    expectSilent(): void {
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
      expect(debug).not.toHaveBeenCalled();
    },
    restore(): void {
      log.mockRestore();
      error.mockRestore();
      warn.mockRestore();
      info.mockRestore();
      debug.mockRestore();
    },
  };
}

/** A `vi.fn()` that throws a labeled error the instant it is called — proves a stage never runs. */
function neverCalled(label: string) {
  return vi.fn(() => {
    throw new Error(`isolated wiring test: ${label} must not be called`);
  });
}

/**
 * Run `action` and return whatever it threw, by exact reference — `undefined` if it didn't throw.
 * `toThrow(sentinel)` only compares `name`/`message`, not object identity; this captures the actual
 * thrown value so callers can assert exact-reference propagation with `toBe`.
 */
function captureThrown(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixture sanity.
// ---------------------------------------------------------------------------

describe('fixture sanity', () => {
  it('builds a contracts-valid WeatherLocation fixture', () => {
    expect(weatherLocation.safeParse(makeLocation()).success).toBe(true);
  });

  it('ties the hourly/current fetchedAt epochs to their ISO strings', () => {
    expect(new Date(HOURLY_FETCHED_AT_EPOCH_MS).toISOString()).toBe(HOURLY_FETCHED_AT_ISO);
    expect(new Date(CURRENT_FETCHED_AT_EPOCH_MS).toISOString()).toBe(CURRENT_FETCHED_AT_ISO);
  });
});

// ---------------------------------------------------------------------------
// Layer A: isolated composition wiring.
// ---------------------------------------------------------------------------

interface IsolatedMocks {
  readonly services?: Record<string, unknown>;
  readonly hourlyComposition?: Record<string, unknown>;
  readonly currentComposition?: Record<string, unknown>;
}

/**
 * Reset the module registry, install the requested partial mocks (spread over the real module so
 * unmocked exports stay real), and dynamically re-import the composition module. Every isolated test
 * gets a fresh module instance — no cross-test mock leakage.
 */
async function loadIsolatedComposition(
  mocks: IsolatedMocks,
): Promise<typeof import('./kma-location-current-hourly-overview.js')> {
  vi.resetModules();
  if (mocks.services) {
    vi.doMock('../services/index.js', async () => {
      const actual = await vi.importActual<typeof import('../services/index.js')>(
        '../services/index.js',
      );
      return { ...actual, ...mocks.services };
    });
  }
  if (mocks.hourlyComposition) {
    vi.doMock('./kma-location-hourly-overview.js', async () => {
      const actual = await vi.importActual<
        typeof import('./kma-location-hourly-overview.js')
      >('./kma-location-hourly-overview.js');
      return { ...actual, ...mocks.hourlyComposition };
    });
  }
  if (mocks.currentComposition) {
    vi.doMock('./kma-location-current-overview.js', async () => {
      const actual = await vi.importActual<
        typeof import('./kma-location-current-overview.js')
      >('./kma-location-current-overview.js');
      return { ...actual, ...mocks.currentComposition };
    });
  }
  return import('./kma-location-current-hourly-overview.js');
}

describe('createKmaLocationCurrentHourlyOverviewCompositionFromEnv — isolated wiring', () => {
  afterEach(() => {
    vi.doUnmock('../services/index.js');
    vi.doUnmock('./kma-location-hourly-overview.js');
    vi.doUnmock('./kma-location-current-overview.js');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('performs no composition/service/clock call and no direct env/time/logging/timer/listener/network side effect merely by importing the module', async () => {
    const hourlyCompositionFactory = vi.fn();
    const currentCompositionFactory = vi.fn();
    const serviceFactory = vi.fn();

    const KMA_SERVICE_KEY_PROPERTY = 'KMA_SERVICE_KEY';
    const originalEnvDescriptor = Object.getOwnPropertyDescriptor(process, 'env');
    const originalEnv = process.env;
    const kmaServiceKeyGet = vi.fn();
    const proxiedEnv = new Proxy(originalEnv, {
      get(target, property, receiver) {
        if (property === KMA_SERVICE_KEY_PROPERTY) {
          kmaServiceKeyGet();
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const dateNowSpy = vi.spyOn(Date, 'now');
    const consoleSpy = spyOnConsole();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const setImmediateSpy = vi.spyOn(globalThis, 'setImmediate');
    const addEventListenerSpy = vi.spyOn(EventTarget.prototype, 'addEventListener');
    const processOnSpy = vi.spyOn(process, 'on');
    const processAddListenerSpy = vi.spyOn(process, 'addListener');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error(
        'isolated wiring test: global fetch must not be called merely by importing the module',
      );
    });

    try {
      if (originalEnvDescriptor) {
        Object.defineProperty(process, 'env', {
          ...originalEnvDescriptor,
          value: proxiedEnv,
        });
      }

      await loadIsolatedComposition({
        services: {
          createKmaLocationCurrentHourlyOverviewService: serviceFactory,
        },
        hourlyComposition: {
          createKmaLocationHourlyOverviewCompositionFromEnv: hourlyCompositionFactory,
        },
        currentComposition: {
          createKmaLocationCurrentOverviewCompositionFromEnv: currentCompositionFactory,
        },
      });

      expect(hourlyCompositionFactory).not.toHaveBeenCalled();
      expect(currentCompositionFactory).not.toHaveBeenCalled();
      expect(serviceFactory).not.toHaveBeenCalled();
      expect(kmaServiceKeyGet).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(dateNowSpy).not.toHaveBeenCalled();
      consoleSpy.expectSilent();
      expect(setTimeoutSpy).not.toHaveBeenCalled();
      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(setImmediateSpy).not.toHaveBeenCalled();
      expect(addEventListenerSpy).not.toHaveBeenCalled();
      expect(processOnSpy).not.toHaveBeenCalled();
      expect(processAddListenerSpy).not.toHaveBeenCalled();
    } finally {
      if (originalEnvDescriptor) {
        Object.defineProperty(process, 'env', originalEnvDescriptor);
      }
      dateNowSpy.mockRestore();
      consoleSpy.restore();
      setTimeoutSpy.mockRestore();
      setIntervalSpy.mockRestore();
      setImmediateSpy.mockRestore();
      addEventListenerSpy.mockRestore();
      processOnSpy.mockRestore();
      processAddListenerSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  describe('hourly config failure', () => {
    it('returns the hourly composition config error by exact reference, never calls the current composition, and builds no service', async () => {
      const sentinelError = Object.freeze({
        kind: 'CONFIG_ERROR',
        field: 'serviceKey',
        reason: 'MISSING',
      } as const);
      const hourlyCompositionFactory = vi.fn((..._args: unknown[]) => ({
        ok: false as const,
        error: sentinelError,
      }));
      const currentCompositionFactory = neverCalled('current composition factory');
      const serviceFactory = neverCalled('service factory');
      const consoleSpy = spyOnConsole();

      const {
        createKmaLocationCurrentHourlyOverviewCompositionFromEnv: composeIsolated,
      } = await loadIsolatedComposition({
        services: { createKmaLocationCurrentHourlyOverviewService: serviceFactory },
        hourlyComposition: {
          createKmaLocationHourlyOverviewCompositionFromEnv: hourlyCompositionFactory,
        },
        currentComposition: {
          createKmaLocationCurrentOverviewCompositionFromEnv: currentCompositionFactory,
        },
      });

      const env = Object.freeze({}) as NodeJS.ProcessEnv;
      const dependencies =
        Object.freeze<KmaLocationCurrentHourlyOverviewCompositionDependencies>({});
      const result = composeIsolated(env, dependencies);

      expect(hourlyCompositionFactory).toHaveBeenCalledTimes(1);
      expect(hourlyCompositionFactory.mock.calls[0]?.[0]).toBe(env);
      expect(hourlyCompositionFactory.mock.calls[0]?.[1]).toBe(dependencies);

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error('expected a config failure');
      }
      expect(result.error).toBe(sentinelError);
      expectExactKeys(result, ['ok', 'error']);

      expect(currentCompositionFactory).not.toHaveBeenCalled();
      expect(serviceFactory).not.toHaveBeenCalled();

      consoleSpy.expectSilent();
      consoleSpy.restore();
    });
  });

  describe('current config failure', () => {
    it('calls hourly first, then current with the exact same env/dependencies, returns the current error by reference, and never builds the combined service', async () => {
      const hourlyServiceSentinel = Object.freeze({ marker: 'HOURLY_SERVICE_SENTINEL' });
      const hourlyCompositionFactory = vi.fn((..._args: unknown[]) => ({
        ok: true as const,
        service: hourlyServiceSentinel,
      }));
      const sentinelError = Object.freeze({
        kind: 'CONFIG_ERROR',
        field: 'serviceKey',
        reason: 'INVALID',
      } as const);
      const currentCompositionFactory = vi.fn((..._args: unknown[]) => ({
        ok: false as const,
        error: sentinelError,
      }));
      const serviceFactory = neverCalled('service factory');
      const consoleSpy = spyOnConsole();

      const {
        createKmaLocationCurrentHourlyOverviewCompositionFromEnv: composeIsolated,
      } = await loadIsolatedComposition({
        services: { createKmaLocationCurrentHourlyOverviewService: serviceFactory },
        hourlyComposition: {
          createKmaLocationHourlyOverviewCompositionFromEnv: hourlyCompositionFactory,
        },
        currentComposition: {
          createKmaLocationCurrentOverviewCompositionFromEnv: currentCompositionFactory,
        },
      });

      const env = Object.freeze(makeEnv(FAKE_KMA_SERVICE_KEY));
      const dependencies =
        Object.freeze<KmaLocationCurrentHourlyOverviewCompositionDependencies>({});
      const result = composeIsolated(env, dependencies);

      expect(hourlyCompositionFactory).toHaveBeenCalledTimes(1);
      expect(currentCompositionFactory).toHaveBeenCalledTimes(1);
      expect(hourlyCompositionFactory.mock.calls[0]?.[0]).toBe(env);
      expect(hourlyCompositionFactory.mock.calls[0]?.[1]).toBe(dependencies);
      expect(currentCompositionFactory.mock.calls[0]?.[0]).toBe(env);
      expect(currentCompositionFactory.mock.calls[0]?.[1]).toBe(dependencies);

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error('expected a config failure');
      }
      expect(result.error).toBe(sentinelError);
      expectExactKeys(result, ['ok', 'error']);

      expect(serviceFactory).not.toHaveBeenCalled();
      consoleSpy.expectSilent();
      consoleSpy.restore();
    });
  });

  describe('success wiring — exact call order and references', () => {
    it('calls hourly, then current, then the PR #77 factory with exactly the two service references and no third argument', async () => {
      const callOrder: string[] = [];
      const hourlyServiceSentinel = Object.freeze({ marker: 'HOURLY_SERVICE_SENTINEL' });
      const hourlyCompositionFactory = vi.fn((..._args: unknown[]) => {
        callOrder.push('hourly');
        return { ok: true as const, service: hourlyServiceSentinel };
      });
      const currentServiceSentinel = Object.freeze({ marker: 'CURRENT_SERVICE_SENTINEL' });
      const currentCompositionFactory = vi.fn((..._args: unknown[]) => {
        callOrder.push('current');
        return { ok: true as const, service: currentServiceSentinel };
      });
      const combinedServiceSentinel = Object.freeze({ marker: 'COMBINED_SERVICE_SENTINEL' });
      const serviceFactory = vi.fn((..._args: unknown[]) => {
        callOrder.push('service');
        return combinedServiceSentinel;
      });

      const {
        createKmaLocationCurrentHourlyOverviewCompositionFromEnv: composeIsolated,
      } = await loadIsolatedComposition({
        services: { createKmaLocationCurrentHourlyOverviewService: serviceFactory },
        hourlyComposition: {
          createKmaLocationHourlyOverviewCompositionFromEnv: hourlyCompositionFactory,
        },
        currentComposition: {
          createKmaLocationCurrentOverviewCompositionFromEnv: currentCompositionFactory,
        },
      });

      const env = Object.freeze(makeEnv(FAKE_KMA_SERVICE_KEY));
      const dependencies =
        Object.freeze<KmaLocationCurrentHourlyOverviewCompositionDependencies>({});
      const result = composeIsolated(env, dependencies);

      expect(callOrder).toEqual(['hourly', 'current', 'service']);

      expect(hourlyCompositionFactory.mock.calls[0]?.[0]).toBe(env);
      expect(hourlyCompositionFactory.mock.calls[0]?.[1]).toBe(dependencies);
      expect(currentCompositionFactory.mock.calls[0]?.[0]).toBe(env);
      expect(currentCompositionFactory.mock.calls[0]?.[1]).toBe(dependencies);

      expect(serviceFactory).toHaveBeenCalledTimes(1);
      expect(serviceFactory.mock.calls[0]).toHaveLength(2);
      expect(serviceFactory.mock.calls[0]?.[0]).toBe(hourlyServiceSentinel);
      expect(serviceFactory.mock.calls[0]?.[1]).toBe(currentServiceSentinel);

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error('expected success');
      }
      expect(result.service).toBe(combinedServiceSentinel);
      expectExactKeys(result, ['ok', 'service']);

      for (const forbidden of [
        'hourlyService',
        'currentService',
        'hourlyComposition',
        'currentComposition',
        'provider',
        'facade',
        'resolver',
        'clock',
        'fetchImpl',
        'serviceKey',
        'env',
        'dependencies',
        'assembler',
        'converter',
      ]) {
        expect(forbidden in result).toBe(false);
      }
    });
  });

  describe('frozen env/dependencies', () => {
    it('reaches both compositions with the exact frozen references and mutates neither on success', async () => {
      const hourlyServiceSentinel = Object.freeze({ marker: 'FROZEN_HOURLY' });
      const hourlyCompositionFactory = vi.fn((..._args: unknown[]) => ({
        ok: true as const,
        service: hourlyServiceSentinel,
      }));
      const currentServiceSentinel = Object.freeze({ marker: 'FROZEN_CURRENT' });
      const currentCompositionFactory = vi.fn((..._args: unknown[]) => ({
        ok: true as const,
        service: currentServiceSentinel,
      }));
      const combinedServiceSentinel = Object.freeze({ marker: 'FROZEN_COMBINED' });
      const serviceFactory = vi.fn((..._args: unknown[]) => combinedServiceSentinel);

      const {
        createKmaLocationCurrentHourlyOverviewCompositionFromEnv: composeIsolated,
      } = await loadIsolatedComposition({
        services: { createKmaLocationCurrentHourlyOverviewService: serviceFactory },
        hourlyComposition: {
          createKmaLocationHourlyOverviewCompositionFromEnv: hourlyCompositionFactory,
        },
        currentComposition: {
          createKmaLocationCurrentOverviewCompositionFromEnv: currentCompositionFactory,
        },
      });

      const env = Object.freeze(makeEnv(FAKE_KMA_SERVICE_KEY));
      const dependencies =
        Object.freeze<KmaLocationCurrentHourlyOverviewCompositionDependencies>({});
      const envSnapshot = JSON.stringify(env);

      const result = composeIsolated(env, dependencies);

      expect(hourlyCompositionFactory.mock.calls[0]?.[0]).toBe(env);
      expect(hourlyCompositionFactory.mock.calls[0]?.[1]).toBe(dependencies);
      expect(currentCompositionFactory.mock.calls[0]?.[0]).toBe(env);
      expect(currentCompositionFactory.mock.calls[0]?.[1]).toBe(dependencies);
      expect(result.ok).toBe(true);
      expect(JSON.stringify(env)).toBe(envSnapshot);
    });
  });

  describe('fresh composition', () => {
    it('builds independent hourly/current/combined graphs on each call with no shared cache', async () => {
      let hourlyCallIndex = 0;
      const hourlyCompositionFactory = vi.fn((..._args: unknown[]) => {
        hourlyCallIndex += 1;
        return { ok: true as const, service: { marker: `HOURLY_${hourlyCallIndex}` } };
      });
      let currentCallIndex = 0;
      const currentCompositionFactory = vi.fn((..._args: unknown[]) => {
        currentCallIndex += 1;
        return { ok: true as const, service: { marker: `CURRENT_${currentCallIndex}` } };
      });
      let serviceCallIndex = 0;
      const serviceFactory = vi.fn((..._args: unknown[]) => {
        serviceCallIndex += 1;
        return { marker: `COMBINED_${serviceCallIndex}` };
      });

      const {
        createKmaLocationCurrentHourlyOverviewCompositionFromEnv: composeIsolated,
      } = await loadIsolatedComposition({
        services: { createKmaLocationCurrentHourlyOverviewService: serviceFactory },
        hourlyComposition: {
          createKmaLocationHourlyOverviewCompositionFromEnv: hourlyCompositionFactory,
        },
        currentComposition: {
          createKmaLocationCurrentOverviewCompositionFromEnv: currentCompositionFactory,
        },
      });

      const env = makeEnv(FAKE_KMA_SERVICE_KEY);
      const first = composeIsolated(env, {});
      const second = composeIsolated(env, {});

      expect(first).not.toBe(second);
      if (!first.ok || !second.ok) {
        throw new Error('expected both compositions to succeed');
      }
      expect(first.service).not.toBe(second.service);
      expect(hourlyCompositionFactory).toHaveBeenCalledTimes(2);
      expect(currentCompositionFactory).toHaveBeenCalledTimes(2);
      expect(serviceFactory).toHaveBeenCalledTimes(2);
    });
  });

  describe('unexpected collaborator factory throws', () => {
    it('propagates the exact thrown reference from the hourly composition factory, calling nothing downstream', async () => {
      const sentinel = new Error('KMA_LOCATION_CURRENT_HOURLY_HOURLY_FACTORY_SENTINEL');
      const hourlyCompositionFactory = vi.fn(() => {
        throw sentinel;
      });
      const currentCompositionFactory = neverCalled('current composition factory');
      const serviceFactory = neverCalled('service factory');
      const consoleSpy = spyOnConsole();

      const {
        createKmaLocationCurrentHourlyOverviewCompositionFromEnv: composeIsolated,
      } = await loadIsolatedComposition({
        services: { createKmaLocationCurrentHourlyOverviewService: serviceFactory },
        hourlyComposition: {
          createKmaLocationHourlyOverviewCompositionFromEnv: hourlyCompositionFactory,
        },
        currentComposition: {
          createKmaLocationCurrentOverviewCompositionFromEnv: currentCompositionFactory,
        },
      });

      const thrown = captureThrown(() =>
        composeIsolated(makeEnv(FAKE_KMA_SERVICE_KEY), {}),
      );

      expect(thrown).toBe(sentinel);
      expect(hourlyCompositionFactory).toHaveBeenCalledTimes(1);
      expect(currentCompositionFactory).not.toHaveBeenCalled();
      expect(serviceFactory).not.toHaveBeenCalled();
      consoleSpy.expectSilent();
      consoleSpy.restore();
    });

    it('propagates the exact thrown reference from the current composition factory, after hourly already succeeded', async () => {
      const hourlyServiceSentinel = Object.freeze({ marker: 'THROW_HOURLY' });
      const hourlyCompositionFactory = vi.fn((..._args: unknown[]) => ({
        ok: true as const,
        service: hourlyServiceSentinel,
      }));
      const sentinel = new Error('KMA_LOCATION_CURRENT_HOURLY_CURRENT_FACTORY_SENTINEL');
      const currentCompositionFactory = vi.fn(() => {
        throw sentinel;
      });
      const serviceFactory = neverCalled('service factory');
      const consoleSpy = spyOnConsole();

      const {
        createKmaLocationCurrentHourlyOverviewCompositionFromEnv: composeIsolated,
      } = await loadIsolatedComposition({
        services: { createKmaLocationCurrentHourlyOverviewService: serviceFactory },
        hourlyComposition: {
          createKmaLocationHourlyOverviewCompositionFromEnv: hourlyCompositionFactory,
        },
        currentComposition: {
          createKmaLocationCurrentOverviewCompositionFromEnv: currentCompositionFactory,
        },
      });

      const thrown = captureThrown(() =>
        composeIsolated(makeEnv(FAKE_KMA_SERVICE_KEY), {}),
      );

      expect(thrown).toBe(sentinel);
      expect(hourlyCompositionFactory).toHaveBeenCalledTimes(1);
      expect(currentCompositionFactory).toHaveBeenCalledTimes(1);
      expect(serviceFactory).not.toHaveBeenCalled();
      consoleSpy.expectSilent();
      consoleSpy.restore();
    });

    it('propagates the exact thrown reference from the PR #77 service factory, after both compositions already succeeded', async () => {
      const hourlyServiceSentinel = Object.freeze({ marker: 'THROW_SERVICE_HOURLY' });
      const hourlyCompositionFactory = vi.fn((..._args: unknown[]) => ({
        ok: true as const,
        service: hourlyServiceSentinel,
      }));
      const currentServiceSentinel = Object.freeze({ marker: 'THROW_SERVICE_CURRENT' });
      const currentCompositionFactory = vi.fn((..._args: unknown[]) => ({
        ok: true as const,
        service: currentServiceSentinel,
      }));
      const sentinel = new Error('KMA_LOCATION_CURRENT_HOURLY_SERVICE_FACTORY_SENTINEL');
      const serviceFactory = vi.fn(() => {
        throw sentinel;
      });
      const consoleSpy = spyOnConsole();

      const {
        createKmaLocationCurrentHourlyOverviewCompositionFromEnv: composeIsolated,
      } = await loadIsolatedComposition({
        services: { createKmaLocationCurrentHourlyOverviewService: serviceFactory },
        hourlyComposition: {
          createKmaLocationHourlyOverviewCompositionFromEnv: hourlyCompositionFactory,
        },
        currentComposition: {
          createKmaLocationCurrentOverviewCompositionFromEnv: currentCompositionFactory,
        },
      });

      const thrown = captureThrown(() =>
        composeIsolated(makeEnv(FAKE_KMA_SERVICE_KEY), {}),
      );

      expect(thrown).toBe(sentinel);
      expect(hourlyCompositionFactory).toHaveBeenCalledTimes(1);
      expect(currentCompositionFactory).toHaveBeenCalledTimes(1);
      expect(serviceFactory).toHaveBeenCalledTimes(1);
      consoleSpy.expectSilent();
      consoleSpy.restore();
    });
  });
});

// ---------------------------------------------------------------------------
// Layer B: real full-pipeline tests.
// ---------------------------------------------------------------------------

/**
 * These tests assemble the **real** PR #27 location hourly-overview composition, the **real** PR #75
 * location current-overview composition, and the **real** PR #77 combined application service (with
 * its own real PR #76 assembler default) through the statically-imported composition function above.
 * Nothing is mocked except the network (an injected in-memory dispatching `fetchImpl`) and the clock
 * (an injected fake clock). No real service key, no external network, and no fake timers are used.
 */

describe('createKmaLocationCurrentHourlyOverviewCompositionFromEnv — missing/invalid config', () => {
  it('returns the hourly MISSING config error for an empty environment (no fetch, no clock read)', () => {
    const consoleSpy = spyOnConsole();
    const { fetchImpl, calls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);

    const result = createKmaLocationCurrentHourlyOverviewCompositionFromEnv(makeEnv(), {
      fetchImpl,
      clock,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected a config failure');
    }
    expect(result.error).toEqual({
      kind: 'CONFIG_ERROR',
      field: 'serviceKey',
      reason: 'MISSING',
    });
    expectExactKeys(result, ['ok', 'error']);
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    consoleSpy.expectSilent();
    consoleSpy.restore();
  });

  it('works with a frozen environment and frozen dependencies on config failure', () => {
    const { fetchImpl, calls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);
    const env = Object.freeze(makeEnv());
    const dependencies =
      Object.freeze<KmaLocationCurrentHourlyOverviewCompositionDependencies>({
        fetchImpl,
        clock,
      });

    const result = createKmaLocationCurrentHourlyOverviewCompositionFromEnv(env, dependencies);

    expect(result).toEqual({
      ok: false,
      error: { kind: 'CONFIG_ERROR', field: 'serviceKey', reason: 'MISSING' },
    });
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});

describe('createKmaLocationCurrentHourlyOverviewCompositionFromEnv — success construction is lazy', () => {
  it('builds a service exposing only { ok, service } and reads no clock / network at construction', () => {
    const consoleSpy = spyOnConsole();
    const { fetchImpl, calls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);
    const env = makeEnv(FAKE_KMA_SERVICE_KEY);
    const dependencies: KmaLocationCurrentHourlyOverviewCompositionDependencies = {
      fetchImpl,
      clock,
    };
    const envSnapshot = JSON.stringify(env);
    const dependenciesSnapshot = { ...dependencies };

    const result = createKmaLocationCurrentHourlyOverviewCompositionFromEnv(env, dependencies);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected success');
    }
    expectExactKeys(result, ['ok', 'service']);
    expectExactKeys(result.service, ['fetchCurrentHourlyWeatherOverviewForLocation']);
    expect(typeof result.service.fetchCurrentHourlyWeatherOverviewForLocation).toBe('function');

    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);

    for (const forbidden of [
      'hourlyService',
      'currentService',
      'facade',
      'resolver',
      'assembler',
      'provider',
      'clock',
      'fetchImpl',
      'environment',
      'env',
      'config',
      'converter',
      'request',
      'dependencies',
      'serviceKey',
    ]) {
      expect(forbidden in result).toBe(false);
    }

    expect(JSON.stringify(env)).toBe(envSnapshot);
    expect(dependencies.fetchImpl).toBe(dependenciesSnapshot.fetchImpl);
    expect(dependencies.clock).toBe(dependenciesSnapshot.clock);
    consoleSpy.expectSilent();
    consoleSpy.restore();
  });
});

describe('createKmaLocationCurrentHourlyOverviewCompositionFromEnv — real graph: PRIMARY hourly + current success', () => {
  it('fetches hourly before current, reads the one shared clock exactly four times, and both sections are present with CURRENT preceding HOURLY in sources', async () => {
    const { fetchImpl, calls } = dispatchFetch({
      vilageFcst: () => jsonOk(successBody(completeShortSlotItems({ baseTime: '0500' }))),
      ultraSrtNcst: () => jsonOk(successBody(fullCurrentSlotItems())),
    });
    const { clock, nowEpochMilliseconds } = scriptedClock([
      CLOCK_AT_0510_KST_20260722,
      HOURLY_FETCHED_AT_EPOCH_MS,
      CURRENT_REQUEST_EPOCH_MS,
      CURRENT_FETCHED_AT_EPOCH_MS,
    ]);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    // Construction touched neither the clock nor the network.
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);

    const result = await service.fetchCurrentHourlyWeatherOverviewForLocation(makeInput());

    // Hourly runs to completion before current starts: the first fetch is the hourly endpoint, the
    // second is the current endpoint.
    expect(calls).toHaveLength(2);
    expect(calls[0].url.pathname.endsWith('/getVilageFcst')).toBe(true);
    expect(calls[1].url.pathname.endsWith('/getUltraSrtNcst')).toBe(true);

    // The one shared clock object is read exactly four times: hourly request-plan, hourly resolver,
    // current request, current resolver — no fifth, composition-owned read.
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(4);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected an application success');
    }
    expectExactKeys(result, ['ok', 'overview', 'selection']);

    expect(weatherOverview.safeParse(result.overview).success).toBe(true);
    expect(result.overview.hourly).toEqual([EXPECTED_SHORT_FORECAST_AT_0600]);
    expect(result.overview.current).not.toBeNull();
    expect(result.overview.missingSections).toEqual(BOTH_PRESENT_MISSING);
    expect(result.overview.missingSections).not.toContain('CURRENT');
    expect(result.overview.missingSections).not.toContain('HOURLY');

    // PR #76 assembler ordering: current source precedes the hourly baseline source.
    expect(result.overview.sources).toHaveLength(2);
    expect(result.overview.sources[0].sections).toEqual(['CURRENT']);
    expect(result.overview.sources[0].sourceId).toBe(CURRENT_SOURCE_ID);
    expect(result.overview.sources[0].fetchedAt).toBe(CURRENT_FETCHED_AT_ISO);
    expect(result.overview.sources[1].sections).toEqual(['HOURLY']);
    expect(result.overview.sources[1].sourceId).toBe(SHORT_SOURCE_ID);
    expect(result.overview.sources[1].fetchedAt).toBe(HOURLY_FETCHED_AT_ISO);

    expectNoLeakage(result);
  });
});

describe('createKmaLocationCurrentHourlyOverviewCompositionFromEnv — real graph: current failure degrades', () => {
  it('keeps ok:true with hourly populated and current degraded to null when current resolves a PROVIDER failure', async () => {
    const { fetchImpl, calls } = dispatchFetch({
      vilageFcst: () => jsonOk(successBody(completeShortSlotItems({ baseTime: '0500' }))),
      ultraSrtNcst: () => new Response('secret upstream error page', { status: 503 }),
    });
    const { clock, nowEpochMilliseconds } = scriptedClock([
      CLOCK_AT_0510_KST_20260722,
      HOURLY_FETCHED_AT_EPOCH_MS,
      CURRENT_REQUEST_EPOCH_MS,
      CURRENT_FETCHED_AT_EPOCH_MS,
    ]);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const result = await service.fetchCurrentHourlyWeatherOverviewForLocation(makeInput());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected an application success');
    }
    expectExactKeys(result, ['ok', 'overview', 'selection']);
    expect(result.overview.hourly).toEqual([EXPECTED_SHORT_FORECAST_AT_0600]);
    expect(result.overview.current).toBeNull();
    expect(result.overview.missingSections).toEqual(CURRENT_MISSING_HOURLY_PRESENT);
    expect(result.overview.missingSections).not.toContain('HOURLY');

    // Current failed with no usable source → only the hourly source is present, never fabricated.
    expect(result.overview.sources).toHaveLength(1);
    expect(result.overview.sources[0].sections).toEqual(['HOURLY']);

    // The failure stage/error is never exposed in the combined result.
    expect('currentResult' in result).toBe(false);
    expect('currentFailure' in result).toBe(false);
    expect('stage' in result).toBe(false);

    // Hourly reads its usual two (request-plan + resolver); current reads only its request clock —
    // the current resolver never runs because the current provider itself failed.
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(3);
    expect(calls).toHaveLength(2);

    expectNoLeakage(result);
  });
});

describe('createKmaLocationCurrentHourlyOverviewCompositionFromEnv — real graph: unsupported location', () => {
  it('returns the exact hourly LOCATION failure with zero fetches, and the current pipeline never runs', async () => {
    const consoleSpy = spyOnConsole();
    const { fetchImpl, calls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = scriptedClock([
      CLOCK_AT_0510_KST_20260722,
      HOURLY_FETCHED_AT_EPOCH_MS,
      CURRENT_REQUEST_EPOCH_MS,
      CURRENT_FETCHED_AT_EPOCH_MS,
    ]);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const result = await service.fetchCurrentHourlyWeatherOverviewForLocation(
      makeInput({ latitude: NULL_ISLAND_LATITUDE, longitude: NULL_ISLAND_LONGITUDE }),
    );

    expect(result).toEqual({
      ok: false,
      stage: 'LOCATION',
      error: { kind: 'UNSUPPORTED_LOCATION' },
    });
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect('overview' in result).toBe(false);
    expect('selection' in result).toBe(false);
    consoleSpy.expectSilent();
    consoleSpy.restore();
  });
});

describe('createKmaLocationCurrentHourlyOverviewCompositionFromEnv — real graph: hourly no-selection still attempts current', () => {
  it('leaves HOURLY missing while CURRENT is present when the primary and previous hourly issuances are both empty', async () => {
    const { fetchImpl, calls } = dispatchFetch({
      vilageFcst: () => jsonOk(emptySuccessBody()),
      ultraSrtNcst: () => jsonOk(successBody(fullCurrentSlotItems())),
    });
    const { clock, nowEpochMilliseconds } = scriptedClock([
      CLOCK_AT_0510_KST_20260722,
      CURRENT_REQUEST_EPOCH_MS,
      CURRENT_FETCHED_AT_EPOCH_MS,
    ]);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const result = await service.fetchCurrentHourlyWeatherOverviewForLocation(makeInput());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected an application success');
    }
    expect(result.overview.hourly).toEqual([]);
    expect(result.overview.missingSections).toEqual(HOURLY_MISSING_CURRENT_PRESENT);
    expect(result.overview.current).not.toBeNull();
    expect(result.overview.missingSections).not.toContain('CURRENT');

    // Two hourly attempts (primary + previous, both empty) plus one current attempt = 3 fetches.
    expect(calls).toHaveLength(3);
    // Hourly's request-plan clock (1 read, no resolver since nothing was selected) plus current's
    // request + resolver reads = 3.
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(3);
  });
});

describe('createKmaLocationCurrentHourlyOverviewCompositionFromEnv — no secret leakage, no logging', () => {
  it('never surfaces the service key across success / current-degraded / config-failure results, and logs nothing', async () => {
    const consoleSpy = spyOnConsole();

    const success = dispatchFetch({
      vilageFcst: () => jsonOk(successBody(completeShortSlotItems({ baseTime: '0500' }))),
      ultraSrtNcst: () => jsonOk(successBody(fullCurrentSlotItems())),
    });
    const successService = composeOrThrow(
      makeEnv(SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR78),
      {
        fetchImpl: success.fetchImpl,
        clock: scriptedClock([
          CLOCK_AT_0510_KST_20260722,
          HOURLY_FETCHED_AT_EPOCH_MS,
          CURRENT_REQUEST_EPOCH_MS,
          CURRENT_FETCHED_AT_EPOCH_MS,
        ]).clock,
      },
    );
    const successResult =
      await successService.fetchCurrentHourlyWeatherOverviewForLocation(makeInput());
    expect(successResult.ok).toBe(true);
    expectNoLeakage(successResult);

    const degraded = dispatchFetch({
      vilageFcst: () => jsonOk(successBody(completeShortSlotItems({ baseTime: '0500' }))),
      ultraSrtNcst: () => new Response('x', { status: 503 }),
    });
    const degradedService = composeOrThrow(
      makeEnv(SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR78),
      {
        fetchImpl: degraded.fetchImpl,
        clock: scriptedClock([
          CLOCK_AT_0510_KST_20260722,
          HOURLY_FETCHED_AT_EPOCH_MS,
          CURRENT_REQUEST_EPOCH_MS,
          CURRENT_FETCHED_AT_EPOCH_MS,
        ]).clock,
      },
    );
    const degradedResult =
      await degradedService.fetchCurrentHourlyWeatherOverviewForLocation(makeInput());
    expect(degradedResult.ok).toBe(true);
    expectNoLeakage(degradedResult);

    const configResult = createKmaLocationCurrentHourlyOverviewCompositionFromEnv(
      makeEnv(` ${SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR78} `),
      { fetchImpl: neverCalledFetch().fetchImpl },
    );
    expect(configResult.ok).toBe(false);
    expectNoLeakage(configResult);

    consoleSpy.expectSilent();
    consoleSpy.restore();
  });
});

describe('createKmaLocationCurrentHourlyOverviewCompositionFromEnv — deeply frozen input', () => {
  it('assembles correctly from a deeply frozen input and does not mutate it', async () => {
    const { fetchImpl } = dispatchFetch({
      vilageFcst: () => jsonOk(successBody(completeShortSlotItems({ baseTime: '0500' }))),
      ultraSrtNcst: () => jsonOk(successBody(fullCurrentSlotItems())),
    });
    const { clock } = scriptedClock([
      CLOCK_AT_0510_KST_20260722,
      HOURLY_FETCHED_AT_EPOCH_MS,
      CURRENT_REQUEST_EPOCH_MS,
      CURRENT_FETCHED_AT_EPOCH_MS,
    ]);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const input = deepFreeze(makeInput());
    const snapshot = JSON.stringify(input);

    const result = await service.fetchCurrentHourlyWeatherOverviewForLocation(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.overview.current).not.toBeNull();
      expect(result.overview.hourly).toHaveLength(1);
    }
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('createKmaLocationCurrentHourlyOverviewCompositionFromEnv — invalid WeatherLocation', () => {
  it('throws a synchronous ZodError for an invalid location, with no clock read and no fetch', () => {
    const consoleSpy = spyOnConsole();
    const { fetchImpl, calls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = scriptedClock([
      CLOCK_AT_0510_KST_20260722,
      HOURLY_FETCHED_AT_EPOCH_MS,
      CURRENT_REQUEST_EPOCH_MS,
      CURRENT_FETCHED_AT_EPOCH_MS,
    ]);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const input = makeInput({ timezone: 'Seoul' });
    const snapshot = JSON.stringify(input);

    let returned: unknown;
    const caught = captureSynchronousError(() => {
      returned = service.fetchCurrentHourlyWeatherOverviewForLocation(input);
    });

    expect(caught).toBeInstanceOf(Error);
    expect((caught as { name?: string }).name).toBe('ZodError');
    expect(returned).toBeUndefined();
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(input)).toBe(snapshot);
    consoleSpy.expectSilent();
    consoleSpy.restore();
  });
});
