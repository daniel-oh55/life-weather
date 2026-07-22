import { afterEach, describe, expect, it, vi } from 'vitest';

import { hourlyForecast } from '@life-weather/contracts';
import { KmaForecastProduct } from '@life-weather/weather-core';

import type { KmaForecastRequestClock } from '../services';
import {
  createKmaLocationHourlyFallbackCompositionFromEnv,
  type KmaLocationHourlyFallbackCompositionDependencies,
} from './kma-location-hourly-fallback';

/**
 * These tests assemble the **real** production components through the new location fallback
 * composition root — the actual PR #12 latitude/longitude → grid converter, the PR #20 grid fallback
 * composition it reuses (provider-from-env, PR #7 hourly service, PR #18 request-plan factory with
 * the explicitly-injected PR #16 candidate selector, PR #6 normalizer, PR #17 classifier, PR #19
 * fallback orchestration), and the PR #21 location fallback facade in front. Nothing is mocked except
 * the network (an injected in-memory `fetchImpl`) and, where a deterministic instant is needed, the
 * clock (an injected fake clock). No real service key, no external network, no mock collaborator, and
 * no fake timers are used.
 *
 * The full HTTP 503 / network / normalization / previous-termination matrix already lives in the
 * PR #20 grid fallback composition tests; this file's focus is the new wiring: the real converter,
 * supported / unsupported / invalid locations, the one-attempt and two-attempt paths, abort
 * pass-through, config/laziness, fresh graphs, and leakage.
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
const SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR21 =
  'SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR21+slash==';

/**
 * A secret-shaped upstream `resultMsg` marker. The provider drops the raw `resultMsg` at its
 * boundary, so this must never reach any composition/facade result.
 */
const SECRET_SHAPED_RESULT_MSG_MUST_NOT_LEAK_PR21 =
  'SECRET_SHAPED_RESULT_MSG_MUST_NOT_LEAK_PR21';

/**
 * `2026-07-22T05:10:00.000+09:00` as absolute epoch milliseconds, computed with `Date.UTC` (a pure,
 * deterministic function — not `Date.now`/`new Date`). Under the production PR #16 candidate selector
 * this SHORT instant yields the candidate pair `{ primary: 20260722/0500, previous: 20260722/0200 }`.
 */
const CLOCK_AT_0510_KST_20260722 = Date.UTC(2026, 6, 21, 20, 10, 0, 0);

/** A fresh environment object per call, so no test shares a mutable env reference. */
function makeEnv(serviceKey?: string): NodeJS.ProcessEnv {
  return serviceKey === undefined
    ? ({} as NodeJS.ProcessEnv)
    : ({ KMA_SERVICE_KEY: serviceKey } as NodeJS.ProcessEnv);
}

/** A fresh fake clock fixed at one instant, with a `vi.fn` so read count is directly assertable. */
function fixedClock(epochMilliseconds: number) {
  const nowEpochMilliseconds = vi.fn(() => epochMilliseconds);
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

/**
 * A structurally-valid KMA upstream-error envelope with the given two-digit `resultCode`. The
 * `resultMsg` is secret-shaped to prove the provider drops it. `03` is 기상청 `NODATA_ERROR`.
 */
function upstreamErrorBody(resultCode: string): string {
  return JSON.stringify({
    response: {
      header: {
        resultCode,
        resultMsg: SECRET_SHAPED_RESULT_MSG_MUST_NOT_LEAK_PR21,
      },
    },
  });
}

function jsonOk(bodyString: string): Response {
  return new Response(bodyString, { status: 200 });
}

/** Compose successfully or fail the test — collapses the result-union narrowing in setup. */
function composeOrThrow(
  env: NodeJS.ProcessEnv,
  dependencies: KmaLocationHourlyFallbackCompositionDependencies,
) {
  const result = createKmaLocationHourlyFallbackCompositionFromEnv(env, dependencies);
  if (!result.ok) {
    throw new Error(
      `test setup: expected composition to succeed, got ${JSON.stringify(result)}`,
    );
  }
  return result.facade;
}

/** Assert an object's own enumerable keys are exactly `keys` (order-independent). */
function expectExactKeys(value: object, keys: readonly string[]): void {
  expect(Object.keys(value).sort()).toEqual([...keys].sort());
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

/** Values that must never appear in a serialized composition/facade result. */
const FORBIDDEN_LEAKAGE_STRINGS = [
  FAKE_KMA_SERVICE_KEY,
  SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR21,
  SECRET_SHAPED_RESULT_MSG_MUST_NOT_LEAK_PR21,
  'apis.data.go.kr',
  'ServiceKey',
  'fcstValue',
  'NORMAL_SERVICE',
  '적설없음',
  '1.0mm',
  // Raw location coordinates and grid must never surface on the result.
  String(SEOUL_LATITUDE),
  String(SEOUL_LONGITUDE),
  'latitude',
  'longitude',
];

function expectNoLeakage(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const forbidden of FORBIDDEN_LEAKAGE_STRINGS) {
    expect(serialized).not.toContain(forbidden);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createKmaLocationHourlyFallbackCompositionFromEnv — missing/invalid config', () => {
  it('returns the provider MISSING config error for an empty environment (no facade, no I/O)', () => {
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);

    const result = createKmaLocationHourlyFallbackCompositionFromEnv(makeEnv(), {
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
    // Exactly ok/error — no facade, no leaked internals.
    expectExactKeys(result, ['ok', 'error']);
    expect('facade' in result).toBe(false);
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('KMA_SERVICE_KEY');
  });

  it('returns MISSING for a whitespace-only key (no clock read, no fetch)', () => {
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);

    const result = createKmaLocationHourlyFallbackCompositionFromEnv(makeEnv('   '), {
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

  it('returns INVALID for a key with leading/trailing whitespace, without leaking the raw key, and logs nothing', () => {
    const consoleSpy = spyOnConsole();
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);
    const rawKey = ` ${SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR21} `;

    const result = createKmaLocationHourlyFallbackCompositionFromEnv(makeEnv(rawKey), {
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
      SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR21,
    );
    consoleSpy.expectSilent();
    consoleSpy.restore();
  });

  it('works with a frozen environment and frozen dependencies on config failure', () => {
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);
    const env = Object.freeze(makeEnv());
    const dependencies = Object.freeze<KmaLocationHourlyFallbackCompositionDependencies>({
      fetchImpl,
      clock,
    });

    const result = createKmaLocationHourlyFallbackCompositionFromEnv(env, dependencies);

    expect(result).toEqual({
      ok: false,
      error: { kind: 'CONFIG_ERROR', field: 'serviceKey', reason: 'MISSING' },
    });
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('createKmaLocationHourlyFallbackCompositionFromEnv — success construction', () => {
  it('builds a facade exposing only { ok, facade } and reads no clock / network / converter at construction', () => {
    const consoleSpy = spyOnConsole();
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);
    const env = makeEnv(FAKE_KMA_SERVICE_KEY);
    const dependencies: KmaLocationHourlyFallbackCompositionDependencies = {
      fetchImpl,
      clock,
    };
    const envSnapshot = JSON.stringify(env);
    const dependenciesSnapshot = { ...dependencies };

    const result = createKmaLocationHourlyFallbackCompositionFromEnv(env, dependencies);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected success');
    }
    expectExactKeys(result, ['ok', 'facade']);
    expectExactKeys(result.facade, ['fetchHourlyForecastWithFallbackForLocation']);
    expect(typeof result.facade.fetchHourlyForecastWithFallbackForLocation).toBe(
      'function',
    );

    // No clock read, no fetch, no converter run during construction (observable via the counts).
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);

    // No internal collaborator / secret is exposed on the success result.
    for (const forbidden of [
      'service',
      'provider',
      'requestPlanFactory',
      'hourlyService',
      'classifier',
      'selector',
      'converter',
      'clock',
      'env',
      'fetchImpl',
      'serviceKey',
      'config',
      'url',
      'dependencies',
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

  it('works with a frozen environment and frozen dependencies on success', () => {
    const { fetchImpl } = neverCalledFetch();
    const { clock } = fixedClock(CLOCK_AT_0510_KST_20260722);
    const env = Object.freeze(makeEnv(FAKE_KMA_SERVICE_KEY));
    const dependencies = Object.freeze<KmaLocationHourlyFallbackCompositionDependencies>({
      fetchImpl,
      clock,
    });

    const result = createKmaLocationHourlyFallbackCompositionFromEnv(env, dependencies);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        typeof result.facade.fetchHourlyForecastWithFallbackForLocation,
      ).toBe('function');
    }
  });

  it('uses the default system clock lazily when none is injected (no time read at construction)', () => {
    const dateNowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValue(CLOCK_AT_0510_KST_20260722);
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();

    const result = createKmaLocationHourlyFallbackCompositionFromEnv(
      makeEnv(FAKE_KMA_SERVICE_KEY),
      { fetchImpl },
    );

    expect(result.ok).toBe(true);
    expect(dateNowSpy).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    dateNowSpy.mockRestore();
  });
});

describe('createKmaLocationHourlyFallbackCompositionFromEnv — supported Seoul, primary non-empty (no fallback)', () => {
  it('converts Seoul to 60/127 and stops after one attempt when the primary 0500 issuance is complete', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch((index) =>
      index === 0
        ? jsonOk(successBody(completeShortSlotItems({ baseTime: '0500' })))
        : new Response('unexpected second fetch', { status: 500 }),
    );
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    // Construction touched neither the clock nor the network.
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);

    const result = await facade.fetchHourlyForecastWithFallbackForLocation({
      product: SHORT,
      latitude: SEOUL_LATITUDE,
      longitude: SEOUL_LONGITUDE,
    });

    // Exactly one clock read and one fetch; the previous request is never sent.
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);

    if (!('fallbackAttempted' in result)) {
      throw new Error(`expected a fallback execution trace, got ${JSON.stringify(result)}`);
    }
    expect(result.fallbackAttempted).toBe(false);
    expectExactKeys(result, ['fallbackAttempted', 'primary']);
    if (result.fallbackAttempted) {
      throw new Error('expected no fallback');
    }
    expect(result.primary.ok).toBe(true);
    if (!result.primary.ok) {
      throw new Error('expected primary success');
    }
    expect(result.primary.hourly).toHaveLength(1);
    const forecast = result.primary.hourly[0];
    expect(forecast).toEqual(EXPECTED_SHORT_FORECAST_AT_0600);
    expect(hourlyForecast.safeParse(forecast).success).toBe(true);

    // The primary URL is dated to the availability-aware 0500 issuance and the real Seoul grid.
    const url = fetchCalls[0].url as URL;
    expect(url.pathname.endsWith('/getVilageFcst')).toBe(true);
    expect(url.searchParams.get('base_date')).toBe('20260722');
    expect(url.searchParams.get('base_time')).toBe('0500');
    expect(url.searchParams.get('nx')).toBe('60');
    expect(url.searchParams.get('ny')).toBe('127');
    // The service key round-trips through the transport URL…
    expect(url.searchParams.get('ServiceKey')).toBe(FAKE_KMA_SERVICE_KEY);
    // …but neither it nor the raw coordinates/grid leak onto the result surface.
    expectNoLeakage(result);
  });
});

describe('createKmaLocationHourlyFallbackCompositionFromEnv — supported Seoul, EMPTY_HOURLY fallback end-to-end', () => {
  it('runs the previous 0200 issuance when the primary 0500 issuance is an empty success', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch((index) =>
      index === 0
        ? jsonOk(emptySuccessBody())
        : jsonOk(successBody(completeShortSlotItems({ baseTime: '0200', fcstTime: '0300' }))),
    );
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const result = await facade.fetchHourlyForecastWithFallbackForLocation({
      product: SHORT,
      latitude: SEOUL_LATITUDE,
      longitude: SEOUL_LONGITUDE,
    });

    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(2);

    if (!('fallbackAttempted' in result) || !result.fallbackAttempted) {
      throw new Error('expected a fallback attempt');
    }
    expectExactKeys(result, [
      'fallbackAttempted',
      'fallbackReason',
      'primary',
      'previous',
    ]);
    expect(result.fallbackReason).toBe('EMPTY_HOURLY');
    expect(result.primary).toEqual({ ok: true, hourly: [] });
    expect(result.previous.ok).toBe(true);
    if (!result.previous.ok) {
      throw new Error('expected previous success');
    }
    expect(result.previous.hourly).toHaveLength(1);
    const previousForecast = result.previous.hourly[0];
    expect(previousForecast.forecastAt).toBe('2026-07-22T03:00:00+09:00');
    expect(hourlyForecast.safeParse(previousForecast).success).toBe(true);

    // First URL is the primary 0500 issuance, second is the previous 0200 issuance, same endpoint/grid.
    const primaryUrl = fetchCalls[0].url as URL;
    const previousUrl = fetchCalls[1].url as URL;
    expect(primaryUrl.searchParams.get('base_date')).toBe('20260722');
    expect(primaryUrl.searchParams.get('base_time')).toBe('0500');
    expect(previousUrl.searchParams.get('base_date')).toBe('20260722');
    expect(previousUrl.searchParams.get('base_time')).toBe('0200');
    expect(primaryUrl.searchParams.get('nx')).toBe('60');
    expect(primaryUrl.searchParams.get('ny')).toBe('127');
    expect(previousUrl.searchParams.get('nx')).toBe('60');
    expect(previousUrl.searchParams.get('ny')).toBe('127');
    // No third fetch.
    expect(fetchCalls).toHaveLength(2);

    expectNoLeakage(result);
  });
});

describe('createKmaLocationHourlyFallbackCompositionFromEnv — supported Seoul, KMA_NO_DATA fallback end-to-end', () => {
  it('runs the previous 0200 issuance when the primary 0500 issuance is upstream resultCode 03', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch((index) =>
      index === 0
        ? jsonOk(upstreamErrorBody('03'))
        : jsonOk(successBody(completeShortSlotItems({ baseTime: '0200', fcstTime: '0300' }))),
    );
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const result = await facade.fetchHourlyForecastWithFallbackForLocation({
      product: SHORT,
      latitude: SEOUL_LATITUDE,
      longitude: SEOUL_LONGITUDE,
    });

    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(2);

    if (!('fallbackAttempted' in result) || !result.fallbackAttempted) {
      throw new Error('expected a fallback attempt');
    }
    expect(result.fallbackReason).toBe('KMA_NO_DATA');
    expect(result.primary).toEqual({
      ok: false,
      stage: 'PROVIDER',
      error: { kind: 'KMA_UPSTREAM_ERROR', resultCode: '03' },
    });
    expect(result.previous.ok).toBe(true);

    const primaryUrl = fetchCalls[0].url as URL;
    const previousUrl = fetchCalls[1].url as URL;
    expect(primaryUrl.searchParams.get('base_time')).toBe('0500');
    expect(previousUrl.searchParams.get('base_time')).toBe('0200');
    // No third fetch; the raw upstream resultMsg was dropped at the provider boundary.
    expect(fetchCalls).toHaveLength(2);
    expectNoLeakage(result);
  });
});

describe('createKmaLocationHourlyFallbackCompositionFromEnv — unsupported valid location', () => {
  it('returns the LOCATION failure for Null Island, with no clock read and no fetch', async () => {
    const consoleSpy = spyOnConsole();
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const returned = facade.fetchHourlyForecastWithFallbackForLocation({
      product: SHORT,
      latitude: NULL_ISLAND_LATITUDE,
      longitude: NULL_ISLAND_LONGITUDE,
    });
    expect(returned).toBeInstanceOf(Promise);
    const result = await returned;

    expect(result).toEqual({
      ok: false,
      stage: 'LOCATION',
      error: { kind: 'UNSUPPORTED_LOCATION' },
    });
    // Location conversion runs before any clock read or request-plan build: no clock, no fetch.
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    // No coordinates or grid leak.
    const serialized = JSON.stringify(result);
    for (const forbidden of ['latitude', 'longitude', 'nx', 'ny']) {
      expect(serialized).not.toContain(forbidden);
    }
    consoleSpy.expectSilent();
    consoleSpy.restore();
  });
});

describe('createKmaLocationHourlyFallbackCompositionFromEnv — invalid location', () => {
  const INVALID_CASES: ReadonlyArray<{
    readonly label: string;
    readonly latitude: number;
    readonly longitude: number;
  }> = [
    { label: 'NaN latitude', latitude: Number.NaN, longitude: SEOUL_LONGITUDE },
    {
      label: 'Infinity longitude',
      latitude: SEOUL_LATITUDE,
      longitude: Number.POSITIVE_INFINITY,
    },
    { label: 'latitude 91 (out of [-90, 90])', latitude: 91, longitude: SEOUL_LONGITUDE },
    {
      label: 'longitude 181 (out of [-180, 180])',
      latitude: SEOUL_LATITUDE,
      longitude: 181,
    },
  ];

  for (const testCase of INVALID_CASES) {
    it(`throws the production converter RangeError synchronously for ${testCase.label}, with no clock read and no fetch`, () => {
      const consoleSpy = spyOnConsole();
      const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
      const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);
      const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

      let caught: unknown;
      let returned: unknown;
      try {
        returned = facade.fetchHourlyForecastWithFallbackForLocation({
          product: SHORT,
          latitude: testCase.latitude,
          longitude: testCase.longitude,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(RangeError);
      // The throw is synchronous — no facade result / Promise was produced.
      expect(returned).toBeUndefined();
      expect(nowEpochMilliseconds).not.toHaveBeenCalled();
      expect(fetchCalls).toHaveLength(0);
      // The value-free RangeError message never echoes the raw runtime-invalid coordinate.
      expect((caught as RangeError).message).not.toContain(String(testCase.latitude));
      expect((caught as RangeError).message).not.toContain(String(testCase.longitude));
      consoleSpy.expectSilent();
      consoleSpy.restore();
    });
  }
});

describe('createKmaLocationHourlyFallbackCompositionFromEnv — pre-aborted supported location', () => {
  it('honours a pre-aborted signal as a PROVIDER-stage ABORTED with a converted grid, one clock read, no fetch', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      jsonOk(successBody(completeShortSlotItems({ baseTime: '0500' }))),
    );
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const controller = new AbortController();
    controller.abort();

    const result = await facade.fetchHourlyForecastWithFallbackForLocation(
      { product: SHORT, latitude: SEOUL_LATITUDE, longitude: SEOUL_LONGITUDE },
      { signal: controller.signal },
    );

    expect(result).toEqual({
      fallbackAttempted: false,
      primary: { ok: false, stage: 'PROVIDER', error: { kind: 'ABORTED' } },
    });
    // The converter ran and the request plan was built (one clock read), but the provider
    // short-circuited before any fetch, and no previous attempt ran.
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('createKmaLocationHourlyFallbackCompositionFromEnv — fresh independent graphs', () => {
  it('builds distinct wrapper/facade/method references and shares no cache across calls', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      jsonOk(successBody(completeShortSlotItems({ baseTime: '0500' }))),
    );
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);
    const env = makeEnv(FAKE_KMA_SERVICE_KEY);
    const dependencies: KmaLocationHourlyFallbackCompositionDependencies = {
      fetchImpl,
      clock,
    };

    const first = createKmaLocationHourlyFallbackCompositionFromEnv(env, dependencies);
    const second = createKmaLocationHourlyFallbackCompositionFromEnv(env, dependencies);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      throw new Error('expected both compositions to succeed');
    }

    // Distinct wrapper, facade, and method references — no shared singleton.
    expect(first).not.toBe(second);
    expect(first.facade).not.toBe(second.facade);
    expect(first.facade.fetchHourlyForecastWithFallbackForLocation).not.toBe(
      second.facade.fetchHourlyForecastWithFallbackForLocation,
    );

    // Construction touched neither the clock nor the network for either graph.
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);

    // Each graph drives the converter → grid → fallback pipeline independently (no cache reuse).
    const input = {
      product: SHORT,
      latitude: SEOUL_LATITUDE,
      longitude: SEOUL_LONGITUDE,
    };
    const firstResult = await first.facade.fetchHourlyForecastWithFallbackForLocation(input);
    const secondResult =
      await second.facade.fetchHourlyForecastWithFallbackForLocation(input);

    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(2);
    expect(fetchCalls).toHaveLength(2);
    expect(firstResult).not.toBe(secondResult);
    expect(firstResult).toEqual(secondResult);
  });
});
