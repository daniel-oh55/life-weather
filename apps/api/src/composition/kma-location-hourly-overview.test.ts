import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  weatherLocation,
  weatherOverview,
  type WeatherLocation,
} from '@life-weather/contracts';
import { KmaForecastProduct } from '@life-weather/weather-core';

import type { KmaForecastRequestClock } from '../services';
import {
  createKmaLocationHourlyOverviewCompositionFromEnv,
  type KmaLocationHourlyOverviewCompositionDependencies,
} from './kma-location-hourly-overview';

/**
 * These tests assemble the **real** production graph through the new location hourly-overview
 * composition root — the PR #21 location fallback composition it reuses (provider-from-env, PR #7
 * hourly service, PR #18 request-plan factory with the explicitly-injected PR #16 candidate selector,
 * PR #6 normalizer, PR #17 classifier, PR #19 fallback orchestration, PR #12 latitude/longitude →
 * grid converter, PR #21 location facade), the PR #26 live selected-source metadata resolver, the
 * PR #22 selector and PR #23 assembler (the PR #24 service's own defaults), and the PR #24 location
 * hourly-overview application service on top. Nothing is mocked except the network (an injected
 * in-memory `fetchImpl`) and, where a deterministic instant is needed, the clock (an injected fake
 * clock). No real service key, no external network, no mock collaborator, and no fake timers.
 *
 * This file focuses on the PR #27 wiring: config/laziness, the PRIMARY / PREVIOUS / no-selection /
 * LOCATION paths through the overview service, the injected clock's two roles (request-plan reference
 * vs metadata materialization), the invalid-location and pre-aborted boundaries, resolver clock
 * throw, fresh graphs, and leakage. The exhaustive Provider HTTP-error matrix already lives in the
 * PR #20/#21 fallback composition tests, and the resolver's malformed-input matrix in the PR #26
 * resolver tests — neither is duplicated here.
 */

const SHORT = KmaForecastProduct.SHORT_FORECAST;

/** Seoul: a supported KMA location. The real PR #12 converter projects it to grid `60/127`. */
const SEOUL_LATITUDE = 37.5665;
const SEOUL_LONGITUDE = 126.978;

/** Null Island: a physically valid coordinate outside the KMA coverage box → converter returns null. */
const NULL_ISLAND_LATITUDE = 0;
const NULL_ISLAND_LONGITUDE = 0;

/** An obviously fake, decoded-shaped service key. Never a real/production key. */
const FAKE_KMA_SERVICE_KEY = 'test-only-decoded-key+slash==';

/** A secret-shaped key marker used only to prove the key never leaks into a result, error, or log. */
const SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR27 =
  'SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR27+slash==';

/**
 * A secret-shaped upstream `resultMsg` marker. The provider drops the raw `resultMsg` at its
 * boundary, so this must never reach any composition/service result.
 */
const SECRET_SHAPED_RESULT_MSG_MUST_NOT_LEAK_PR27 =
  'SECRET_SHAPED_RESULT_MSG_MUST_NOT_LEAK_PR27';

/**
 * `2026-07-22T05:10:00.000+09:00` as absolute epoch milliseconds, computed with `Date.UTC` (a pure,
 * deterministic function — not `Date.now`/`new Date`). Under the production PR #16 candidate selector
 * this SHORT instant yields the candidate pair `{ primary: 20260722/0500, previous: 20260722/0200 }`.
 * This is the **first** clock read (the request-plan reference instant).
 */
const CLOCK_AT_0510_KST_20260722 = Date.UTC(2026, 6, 21, 20, 10, 0, 0);

/**
 * `2026-07-22T05:11:22.333+09:00` as absolute epoch milliseconds — a **distinct, later** instant used
 * as the **second** clock read (the metadata resolver's `fetchedAt` materialization). Keeping it
 * distinct from the request-plan instant proves `issuedAt` comes from the preserved issuance identity,
 * not a recomputation off this later reading.
 */
const FETCHED_AT_EPOCH_MS = Date.UTC(2026, 6, 21, 20, 11, 22, 333);

/** The UTC `Z` millisecond ISO string the resolver derives from {@link FETCHED_AT_EPOCH_MS}. */
const FETCHED_AT_ISO = '2026-07-21T20:11:22.333Z';

/** The fixed app-internal `sourceId` for a KMA 단기예보 hourly source. */
const SHORT_SOURCE_ID = 'kma-short-forecast-hourly';

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
  const clock: KmaForecastRequestClock = { nowEpochMilliseconds };
  return { clock, nowEpochMilliseconds };
}

/**
 * A fresh fake clock that returns `values[i]` on its i-th call (the last value repeats for any extra
 * call). Used to give the request-plan read and the metadata-resolver read distinct instants.
 */
function scriptedClock(values: readonly number[]) {
  const nowEpochMilliseconds = vi.fn((): number => {
    const callIndex = nowEpochMilliseconds.mock.calls.length - 1;
    return values[Math.min(callIndex, values.length - 1)];
  });
  const clock: KmaForecastRequestClock = { nowEpochMilliseconds };
  return { clock, nowEpochMilliseconds };
}

/**
 * A fresh fake clock that returns `firstValue` on its first call and throws `error` on every later
 * call — models a clock that works for the request plan but fails at metadata materialization.
 */
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

/**
 * A fresh in-memory `fetch` that records each call (url + init by reference) and returns a **fresh**
 * `Response` per call from `makeResponse(callIndex)`. The returned `calls` array doubles as the call
 * counter. Created inside each test — never shared at describe scope.
 */
function recordingFetch(makeResponse: (callIndex: number) => Response) {
  const calls: FetchRecord[] = [];
  const fetchImpl = ((url: unknown, init?: RequestInit) => {
    const index = calls.length;
    calls.push({ url, init });
    return Promise.resolve(makeResponse(index));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** A `fetch` that must never run — fails the test loudly if the provider ever calls it. */
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

interface SlotIdentity {
  readonly baseTime: string;
  readonly baseDate?: string;
  readonly fcstDate?: string;
  readonly fcstTime?: string;
  readonly nx?: number;
  readonly ny?: number;
}

/**
 * A complete SHORT slot (all nine categories) dated to `identity.baseTime`. Defaults: base/forecast
 * date `20260722`, forecast time `0600`, grid `60/127` (the real converter's Seoul grid). The item
 * base issuance must match the request the production pipeline builds for that attempt, or the
 * provider's correlation check rejects it.
 */
function completeShortSlotItems(identity: SlotIdentity): RawItem[] {
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

/** Serialize a KMA success envelope (matching the provider's expected success shape). */
function successBody(
  items: readonly RawItem[],
  options: { totalCount?: number } = {},
): string {
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

/** `missingSections` for a selected hourly source (HOURLY present → not missing). */
const SELECTED_MISSING = [
  'CURRENT',
  'DAILY',
  'AIR_QUALITY_CURRENT',
  'AIR_QUALITY_FORECAST',
  'ALERTS',
];

/** `missingSections` when no hourly source was selected (HOURLY is missing too). */
const NO_SELECTION_MISSING = [
  'CURRENT',
  'HOURLY',
  'DAILY',
  'AIR_QUALITY_CURRENT',
  'AIR_QUALITY_FORECAST',
  'ALERTS',
];

/**
 * Secret / raw-transport values that must never appear in a serialized composition/service result or
 * on the console. The overview legitimately echoes the caller's `location` (with its coordinates), so
 * raw latitude/longitude are **not** listed here — only the transport secrets and raw KMA body.
 */
const FORBIDDEN_LEAKAGE_STRINGS = [
  FAKE_KMA_SERVICE_KEY,
  SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR27,
  SECRET_SHAPED_RESULT_MSG_MUST_NOT_LEAK_PR27,
  'apis.data.go.kr',
  'ServiceKey',
  'fcstValue',
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
  dependencies: KmaLocationHourlyOverviewCompositionDependencies,
) {
  const result = createKmaLocationHourlyOverviewCompositionFromEnv(env, dependencies);
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

/** Spy on the three console methods and provide silence assertion + restore. */
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
    restore(): void {
      log.mockRestore();
      error.mockRestore();
      warn.mockRestore();
    },
  };
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

  it('ties the fetchedAt epoch to its ISO string', () => {
    expect(new Date(FETCHED_AT_EPOCH_MS).toISOString()).toBe(FETCHED_AT_ISO);
  });
});

// ---------------------------------------------------------------------------
// A — config failure.
// ---------------------------------------------------------------------------

describe('createKmaLocationHourlyOverviewCompositionFromEnv — missing/invalid config', () => {
  it('returns the provider MISSING config error for an empty environment (no service, no I/O)', () => {
    const consoleSpy = spyOnConsole();
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);

    const result = createKmaLocationHourlyOverviewCompositionFromEnv(makeEnv(), {
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
    // Exactly ok/error — no service, no leaked internals.
    expectExactKeys(result, ['ok', 'error']);
    expect('service' in result).toBe(false);
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('KMA_SERVICE_KEY');
    consoleSpy.expectSilent();
    consoleSpy.restore();
  });

  it('returns MISSING for a whitespace-only key (no clock read, no fetch)', () => {
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);

    const result = createKmaLocationHourlyOverviewCompositionFromEnv(makeEnv('   '), {
      fetchImpl,
      clock,
    });

    expect(result).toEqual({
      ok: false,
      error: { kind: 'CONFIG_ERROR', field: 'serviceKey', reason: 'MISSING' },
    });
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
  });

  it('returns INVALID for a key with surrounding whitespace, without leaking the raw key, and logs nothing', () => {
    const consoleSpy = spyOnConsole();
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);
    const rawKey = ` ${SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR27} `;

    const result = createKmaLocationHourlyOverviewCompositionFromEnv(makeEnv(rawKey), {
      fetchImpl,
      clock,
    });

    expect(result).toEqual({
      ok: false,
      error: { kind: 'CONFIG_ERROR', field: 'serviceKey', reason: 'INVALID' },
    });
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(
      SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR27,
    );
    consoleSpy.expectSilent();
    consoleSpy.restore();
  });

  it('works with a frozen environment and frozen dependencies on config failure', () => {
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);
    const env = Object.freeze(makeEnv());
    const dependencies =
      Object.freeze<KmaLocationHourlyOverviewCompositionDependencies>({
        fetchImpl,
        clock,
      });

    const result = createKmaLocationHourlyOverviewCompositionFromEnv(env, dependencies);

    expect(result).toEqual({
      ok: false,
      error: { kind: 'CONFIG_ERROR', field: 'serviceKey', reason: 'MISSING' },
    });
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// B — successful construction laziness.
// ---------------------------------------------------------------------------

describe('createKmaLocationHourlyOverviewCompositionFromEnv — success construction', () => {
  it('builds a service exposing only { ok, service } and reads no clock / network at construction', () => {
    const consoleSpy = spyOnConsole();
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);
    const env = makeEnv(FAKE_KMA_SERVICE_KEY);
    const dependencies: KmaLocationHourlyOverviewCompositionDependencies = {
      fetchImpl,
      clock,
    };
    const envSnapshot = JSON.stringify(env);
    const dependenciesSnapshot = { ...dependencies };

    const result = createKmaLocationHourlyOverviewCompositionFromEnv(env, dependencies);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected success');
    }
    expectExactKeys(result, ['ok', 'service']);
    expectExactKeys(result.service, ['fetchHourlyWeatherOverviewForLocation']);
    expect(typeof result.service.fetchHourlyWeatherOverviewForLocation).toBe(
      'function',
    );

    // No clock read and no fetch during construction (observable via the counts).
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);

    // No internal collaborator / secret is exposed on the success result.
    for (const forbidden of [
      'facade',
      'resolver',
      'selector',
      'assembler',
      'provider',
      'clock',
      'fetchImpl',
      'environment',
      'env',
      'config',
      'converter',
      'request',
      'plan',
      'dependencies',
      'serviceKey',
    ]) {
      expect(forbidden in result).toBe(false);
    }

    // Neither the environment nor the dependencies object was mutated.
    expect(JSON.stringify(env)).toBe(envSnapshot);
    expect(dependencies.fetchImpl).toBe(dependenciesSnapshot.fetchImpl);
    expect(dependencies.clock).toBe(dependenciesSnapshot.clock);
    consoleSpy.expectSilent();
    consoleSpy.restore();
  });

  it('uses the default system clock lazily when none is injected (no time read at construction)', () => {
    const dateNowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValue(CLOCK_AT_0510_KST_20260722);
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();

    const result = createKmaLocationHourlyOverviewCompositionFromEnv(
      makeEnv(FAKE_KMA_SERVICE_KEY),
      { fetchImpl },
    );

    expect(result.ok).toBe(true);
    // Neither the fallback root's internal system clock nor the resolver's fresh system clock reads
    // the wall clock at construction.
    expect(dateNowSpy).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    dateNowSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// C — PRIMARY selected full pipeline.
// ---------------------------------------------------------------------------

describe('createKmaLocationHourlyOverviewCompositionFromEnv — PRIMARY selected full pipeline', () => {
  it('assembles a PRIMARY hourly overview, issuedAt from the preserved issuance and fetchedAt from the second clock read', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch((index) =>
      index === 0
        ? jsonOk(successBody(completeShortSlotItems({ baseTime: '0500' })))
        : new Response('unexpected second fetch', { status: 500 }),
    );
    // First read → request-plan reference (0510 → primary 0500); second read → fetchedAt materialize.
    const { clock, nowEpochMilliseconds } = scriptedClock([
      CLOCK_AT_0510_KST_20260722,
      FETCHED_AT_EPOCH_MS,
    ]);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    // Construction touched neither the clock nor the network.
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);

    const result = await service.fetchHourlyWeatherOverviewForLocation(makeInput());

    // The injected clock is read exactly twice (request plan + metadata) and one fetch is sent.
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(2);
    expect(fetchCalls).toHaveLength(1);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected an application success');
    }

    // Selection: the availability-aware primary 0500 issuance was usable → PRIMARY, no fallback.
    expect(result.selection.selected).toBe(true);
    expect(result.selection.source).toBe('PRIMARY');
    expect(result.selection.fallbackUsed).toBe(false);
    if (result.selection.selected) {
      expect(result.selection.execution.primaryIssuance).toEqual({
        product: SHORT,
        baseDate: '20260722',
        baseTime: '0500',
      });
    }

    // Overview: a valid hourly-only WeatherOverview with the selected forecast.
    expect(weatherOverview.safeParse(result.overview).success).toBe(true);
    expect(result.overview.hourly).toEqual([EXPECTED_SHORT_FORECAST_AT_0600]);
    expect(result.overview.missingSections).toEqual(SELECTED_MISSING);
    expect(result.overview.missingSections).not.toContain('HOURLY');

    // Exactly one KMA HOURLY source with the resolver's provenance.
    expect(result.overview.sources).toHaveLength(1);
    const source = result.overview.sources[0];
    expect(source.provider).toBe('KMA');
    expect(source.sections).toEqual(['HOURLY']);
    expect(source.sourceId).toBe(SHORT_SOURCE_ID);
    expect(source.observedAt).toBeNull();
    expect(source.retrievalMode).toBe('LIVE');
    // issuedAt is derived from the preserved primary issuance (0500 KST), NOT the second clock read.
    expect(source.issuedAt).toBe('2026-07-22T05:00:00+09:00');
    // fetchedAt is derived from the second clock read (a distinct, later instant).
    expect(source.fetchedAt).toBe(FETCHED_AT_ISO);

    // The primary URL is dated to the availability-aware 0500 issuance and the real Seoul grid.
    const url = fetchCalls[0].url as URL;
    expect(url.pathname.endsWith('/getVilageFcst')).toBe(true);
    expect(url.searchParams.get('base_date')).toBe('20260722');
    expect(url.searchParams.get('base_time')).toBe('0500');
    expect(url.searchParams.get('nx')).toBe('60');
    expect(url.searchParams.get('ny')).toBe('127');
    // The service key round-trips through the transport URL…
    expect(url.searchParams.get('ServiceKey')).toBe(FAKE_KMA_SERVICE_KEY);
    // …but neither it nor any raw KMA body value leaks onto the result surface.
    expectNoLeakage(result);
  });

  it('assembles correctly from a deeply frozen input and does not mutate it', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonOk(successBody(completeShortSlotItems({ baseTime: '0500' }))),
    );
    const { clock } = scriptedClock([CLOCK_AT_0510_KST_20260722, FETCHED_AT_EPOCH_MS]);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const input = deepFreeze(makeInput());
    const snapshot = JSON.stringify(input);

    const result = await service.fetchHourlyWeatherOverviewForLocation(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.overview.hourly).toEqual([EXPECTED_SHORT_FORECAST_AT_0600]);
    }
    // The caller input was echoed as `overview.location` but never mutated.
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// D — PREVIOUS selected fallback full pipeline.
// ---------------------------------------------------------------------------

describe('createKmaLocationHourlyOverviewCompositionFromEnv — PREVIOUS selected fallback', () => {
  it('runs the previous 0200 issuance when the primary 0500 issuance is an empty success, and materializes previous provenance', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch((index) =>
      index === 0
        ? jsonOk(emptySuccessBody())
        : jsonOk(
            successBody(completeShortSlotItems({ baseTime: '0200', fcstTime: '0300' })),
          ),
    );
    const { clock, nowEpochMilliseconds } = scriptedClock([
      CLOCK_AT_0510_KST_20260722,
      FETCHED_AT_EPOCH_MS,
    ]);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const result = await service.fetchHourlyWeatherOverviewForLocation(makeInput());

    // Two fetches (primary 0500 → previous 0200); the clock is still read only twice — the request
    // plan builds both requests from a single first read, and the resolver adds the second.
    expect(fetchCalls).toHaveLength(2);
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(2);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected an application success');
    }

    expect(result.selection.selected).toBe(true);
    expect(result.selection.source).toBe('PREVIOUS');
    expect(result.selection.fallbackUsed).toBe(true);
    if (result.selection.selected && result.selection.execution.fallbackAttempted) {
      expect(result.selection.execution.previousIssuance).toEqual({
        product: SHORT,
        baseDate: '20260722',
        baseTime: '0200',
      });
    }

    // Overview uses the previous issuance's forecast and provenance.
    expect(weatherOverview.safeParse(result.overview).success).toBe(true);
    expect(result.overview.hourly).toHaveLength(1);
    expect(result.overview.hourly[0].forecastAt).toBe('2026-07-22T03:00:00+09:00');
    expect(result.overview.missingSections).not.toContain('HOURLY');
    expect(result.overview.sources).toHaveLength(1);
    const source = result.overview.sources[0];
    expect(source.sourceId).toBe(SHORT_SOURCE_ID);
    // issuedAt is the previous 0200 issuance; fetchedAt is the resolver's second clock read.
    expect(source.issuedAt).toBe('2026-07-22T02:00:00+09:00');
    expect(source.fetchedAt).toBe(FETCHED_AT_ISO);
    expect(source.retrievalMode).toBe('LIVE');

    // First URL is the primary 0500 issuance, second is the previous 0200 issuance, same grid.
    const primaryUrl = fetchCalls[0].url as URL;
    const previousUrl = fetchCalls[1].url as URL;
    expect(primaryUrl.searchParams.get('base_time')).toBe('0500');
    expect(previousUrl.searchParams.get('base_time')).toBe('0200');
    expect(previousUrl.searchParams.get('nx')).toBe('60');
    expect(previousUrl.searchParams.get('ny')).toBe('127');

    expectNoLeakage(result);
  });
});

// ---------------------------------------------------------------------------
// E — no-selection.
// ---------------------------------------------------------------------------

describe('createKmaLocationHourlyOverviewCompositionFromEnv — no selection', () => {
  it('returns an ok:true partial overview with HOURLY missing and never reads the metadata clock', async () => {
    // Primary empty (EMPTY_HOURLY → eligible) then previous empty → neither usable → no selection.
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() => jsonOk(emptySuccessBody()));
    const { clock, nowEpochMilliseconds } = scriptedClock([
      CLOCK_AT_0510_KST_20260722,
      FETCHED_AT_EPOCH_MS,
    ]);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const result = await service.fetchHourlyWeatherOverviewForLocation(makeInput());

    // Fallback was attempted (two fetches), but the clock was read only once — the resolver never ran,
    // so no second (metadata) clock read happened.
    expect(fetchCalls).toHaveLength(2);
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected an application success');
    }
    expect(result.selection.selected).toBe(false);
    expect(result.overview.hourly).toEqual([]);
    expect(result.overview.sources).toEqual([]);
    expect(result.overview.missingSections).toEqual(NO_SELECTION_MISSING);
    expect(result.overview.missingSections).toContain('HOURLY');
    expect(weatherOverview.safeParse(result.overview).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F — unsupported location.
// ---------------------------------------------------------------------------

describe('createKmaLocationHourlyOverviewCompositionFromEnv — unsupported location', () => {
  it('returns the exact LOCATION failure for Null Island, with no clock read and no fetch', async () => {
    const consoleSpy = spyOnConsole();
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = scriptedClock([
      CLOCK_AT_0510_KST_20260722,
      FETCHED_AT_EPOCH_MS,
    ]);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const result = await service.fetchHourlyWeatherOverviewForLocation(
      makeInput({
        latitude: NULL_ISLAND_LATITUDE,
        longitude: NULL_ISLAND_LONGITUDE,
      }),
    );

    expect(result).toEqual({
      ok: false,
      stage: 'LOCATION',
      error: { kind: 'UNSUPPORTED_LOCATION' },
    });
    // Conversion fails before any request plan or resolver → clock 0, fetch 0.
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    // No overview / selection was assembled, and no grid/coordinate detail leaked.
    expect('overview' in result).toBe(false);
    expect('selection' in result).toBe(false);
    const serialized = JSON.stringify(result);
    for (const forbidden of ['latitude', 'longitude', 'nx', 'ny']) {
      expect(serialized).not.toContain(forbidden);
    }
    consoleSpy.expectSilent();
    consoleSpy.restore();
  });
});

// ---------------------------------------------------------------------------
// G — invalid WeatherLocation (synchronous ZodError, no collaborator runs).
// ---------------------------------------------------------------------------

describe('createKmaLocationHourlyOverviewCompositionFromEnv — invalid WeatherLocation', () => {
  const invalidLocations: ReadonlyArray<{
    readonly name: string;
    readonly overrides: Partial<WeatherLocation>;
  }> = [
    { name: 'invalid timezone', overrides: { timezone: 'Seoul' } },
    { name: 'out-of-range latitude', overrides: { latitude: 999 } },
    { name: 'out-of-range longitude', overrides: { longitude: 999 } },
    { name: 'empty id', overrides: { id: '' } },
    { name: 'invalid countryCode', overrides: { countryCode: 'kr' } },
  ];

  for (const { name, overrides } of invalidLocations) {
    it(`throws a synchronous ZodError for a ${name} with no clock read and no fetch`, () => {
      const consoleSpy = spyOnConsole();
      const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
      const { clock, nowEpochMilliseconds } = scriptedClock([
        CLOCK_AT_0510_KST_20260722,
        FETCHED_AT_EPOCH_MS,
      ]);
      const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), {
        fetchImpl,
        clock,
      });

      const input = makeInput(overrides);
      const snapshot = JSON.stringify(input);

      let returned: unknown;
      const caught = captureSynchronousError(() => {
        returned = service.fetchHourlyWeatherOverviewForLocation(input);
      });

      expect(caught).toBeInstanceOf(Error);
      expect((caught as { name?: string }).name).toBe('ZodError');
      // The throw is synchronous — no Promise was produced, and no collaborator ran.
      expect(returned).toBeUndefined();
      expect(nowEpochMilliseconds).not.toHaveBeenCalled();
      expect(fetchCalls).toHaveLength(0);
      // The caller input is not mutated and nothing is logged.
      expect(JSON.stringify(input)).toBe(snapshot);
      consoleSpy.expectSilent();
      consoleSpy.restore();
    });
  }
});

// ---------------------------------------------------------------------------
// H — pre-aborted invocation.
// ---------------------------------------------------------------------------

describe('createKmaLocationHourlyOverviewCompositionFromEnv — pre-aborted supported location', () => {
  it('honours a pre-aborted signal (primary ABORTED → no selection), reads the request-plan clock once, and never reads the metadata clock', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      jsonOk(successBody(completeShortSlotItems({ baseTime: '0500' }))),
    );
    const { clock, nowEpochMilliseconds } = scriptedClock([
      CLOCK_AT_0510_KST_20260722,
      FETCHED_AT_EPOCH_MS,
    ]);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const controller = new AbortController();
    controller.abort();

    const result = await service.fetchHourlyWeatherOverviewForLocation(makeInput(), {
      signal: controller.signal,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected an application success');
    }
    // The primary aborted before any fetch; nothing was selected.
    expect(result.selection.selected).toBe(false);
    expect(result.overview.hourly).toEqual([]);
    expect(result.overview.missingSections).toContain('HOURLY');
    // The request plan was built (one clock read), the provider short-circuited before any fetch, and
    // with no selected source the resolver never ran → no second clock read.
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// I — metadata clock throw.
// ---------------------------------------------------------------------------

describe('createKmaLocationHourlyOverviewCompositionFromEnv — metadata clock throw', () => {
  it('rejects the returned Promise with the exact sentinel when the second (metadata) clock read throws', async () => {
    const consoleSpy = spyOnConsole();
    const sentinel = new Error('METADATA_CLOCK_SENTINEL');
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      jsonOk(successBody(completeShortSlotItems({ baseTime: '0500' }))),
    );
    // First read builds the request plan normally; the second (resolver) read throws.
    const { clock, nowEpochMilliseconds } = throwingSecondClock(
      CLOCK_AT_0510_KST_20260722,
      sentinel,
    );
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    let returned: unknown;
    const caught = captureSynchronousError(() => {
      returned = service.fetchHourlyWeatherOverviewForLocation(makeInput());
    });

    // The method call itself does not become a synchronous throw — it returns a Promise…
    expect(caught).toBeUndefined();
    expect(returned).toBeInstanceOf(Promise);
    // …that rejects with the exact sentinel reference (no wrapping, no partial overview).
    await expect(returned).rejects.toBe(sentinel);

    // The clock was read twice (request plan + failed metadata) and one primary fetch occurred.
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(2);
    expect(fetchCalls).toHaveLength(1);
    consoleSpy.expectSilent();
    consoleSpy.restore();
  });
});

// ---------------------------------------------------------------------------
// J — fresh graph.
// ---------------------------------------------------------------------------

describe('createKmaLocationHourlyOverviewCompositionFromEnv — fresh independent graphs', () => {
  it('builds distinct result, service, and method references across calls with no shared cache', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      jsonOk(successBody(completeShortSlotItems({ baseTime: '0500' }))),
    );
    const { clock, nowEpochMilliseconds } = scriptedClock([
      CLOCK_AT_0510_KST_20260722,
      FETCHED_AT_EPOCH_MS,
    ]);
    const env = makeEnv(FAKE_KMA_SERVICE_KEY);
    const dependencies: KmaLocationHourlyOverviewCompositionDependencies = {
      fetchImpl,
      clock,
    };

    const first = createKmaLocationHourlyOverviewCompositionFromEnv(env, dependencies);
    const second = createKmaLocationHourlyOverviewCompositionFromEnv(env, dependencies);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      throw new Error('expected both compositions to succeed');
    }

    // Distinct wrapper, service, and method references — no shared singleton.
    expect(first).not.toBe(second);
    expect(first.service).not.toBe(second.service);
    expect(first.service.fetchHourlyWeatherOverviewForLocation).not.toBe(
      second.service.fetchHourlyWeatherOverviewForLocation,
    );

    // Construction touched neither the clock nor the network for either graph.
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);

    // Each graph runs its own pipeline independently and returns fresh, equal results.
    const firstResult =
      await first.service.fetchHourlyWeatherOverviewForLocation(makeInput());
    const secondResult =
      await second.service.fetchHourlyWeatherOverviewForLocation(makeInput());

    expect(firstResult).not.toBe(secondResult);
    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    if (firstResult.ok && secondResult.ok) {
      expect(firstResult.overview).not.toBe(secondResult.overview);
      expect(firstResult.overview).toEqual(secondResult.overview);
    }
  });
});

// ---------------------------------------------------------------------------
// K — exact keys and leakage.
// ---------------------------------------------------------------------------

describe('createKmaLocationHourlyOverviewCompositionFromEnv — keys and leakage', () => {
  it('keeps the success result at exactly ok/service and leaks no secret on a full PRIMARY run', async () => {
    const consoleSpy = spyOnConsole();
    const { fetchImpl } = recordingFetch(() =>
      jsonOk(successBody(completeShortSlotItems({ baseTime: '0500' }))),
    );
    const { clock } = scriptedClock([CLOCK_AT_0510_KST_20260722, FETCHED_AT_EPOCH_MS]);

    const composition = createKmaLocationHourlyOverviewCompositionFromEnv(
      makeEnv(FAKE_KMA_SERVICE_KEY),
      { fetchImpl, clock },
    );
    expect(composition.ok).toBe(true);
    if (!composition.ok) {
      throw new Error('expected success');
    }
    expectExactKeys(composition, ['ok', 'service']);

    const result = await composition.service.fetchHourlyWeatherOverviewForLocation(
      makeInput(),
    );

    // The PR #24 internal application result keeps its selection/execution trace — this PR does not
    // strip it or turn it overview-only. Its own keys are exactly ok/overview/selection.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expectExactKeys(result, ['ok', 'overview', 'selection']);
      expect('execution' in result.selection).toBe(true);
    }

    // No service key, ServiceKey param, URL, query, raw body, or upstream resultMsg leaks.
    expectNoLeakage(result);
    consoleSpy.expectSilent();
    consoleSpy.restore();
  });
});
