import { afterEach, describe, expect, it, vi } from 'vitest';

import { hourlyForecast } from '@life-weather/contracts';
import { KmaForecastProduct } from '@life-weather/weather-core';

import type { KmaForecastRequestClock } from '../services';
import {
  createKmaLocationScheduledHourlyCompositionFromEnv,
  type KmaLocationScheduledHourlyCompositionDependencies,
} from './kma-location-scheduled-hourly';

/**
 * These tests assemble the **real** components — the PR #12 latitude/longitude → grid converter,
 * the PR #5 provider-from-env, the PR #7 hourly service, the PR #9 request factory (with the PR #8
 * issue-time selector), the PR #6 hourly normalizer, the PR #10 scheduled facade, and the PR #13
 * location facade — through the location composition root. Nothing is mocked except the network (an
 * injected in-memory `fetchImpl`) and, where a deterministic instant is needed, the clock (an
 * injected fake clock). No real service key, no external network, and no fake timers are used.
 */

const SHORT = KmaForecastProduct.SHORT_FORECAST;

/** Seoul: latitude/longitude the PR #12 converter maps onto the KMA grid { nx: 60, ny: 127 }. */
const SEOUL_LATITUDE = 37.5665;
const SEOUL_LONGITUDE = 126.978;

/** Tokyo: a physically valid coordinate outside the KMA forecast grid → converter returns null. */
const TOKYO_LATITUDE = 35.6762;
const TOKYO_LONGITUDE = 139.6503;

/** An obviously fake, decoded-shaped service key. Never a real/production key. */
const FAKE_KMA_SERVICE_KEY = 'test-only-decoded-key+slash==';

/** A secret-shaped key marker used only to prove the key never leaks into a result, error, or log. */
const SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR13 =
  'SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR13+slash==';

/** A secret-shaped coordinate marker used to prove a raw coordinate never leaks into an error. */
const SECRET_SHAPED_LOCATION_MUST_NOT_LEAK_PR13 = 90.000001;

/**
 * The reference instant `2026-07-18T05:00:00.000+09:00` as absolute epoch milliseconds. Computed
 * with `Date.UTC` (a pure, deterministic function — not `Date.now`/`new Date`), so the value is a
 * fixed constant, not a read of the current time. `05:00 KST` == `2026-07-17T20:00:00.000Z`.
 */
const CLOCK_AT_0500_KST_20260718 = Date.UTC(2026, 6, 17, 20, 0, 0, 0);

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

/** A fresh fake clock returning a queued sequence of instants (one per read). */
function sequenceClock(values: readonly number[]) {
  const queue = [...values];
  const nowEpochMilliseconds = vi.fn(() => {
    const next = queue.shift();
    if (next === undefined) {
      throw new Error('test setup: clock read more times than expected');
    }
    return next;
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

/** A raw forecast item matching the 20260718/0500 → 0600 60/127 identity unless overridden. */
function item(overrides: Partial<RawItem> = {}): RawItem {
  return {
    baseDate: '20260718',
    baseTime: '0500',
    category: 'TMP',
    fcstDate: '20260718',
    fcstTime: '0600',
    fcstValue: '25.5',
    nx: 60,
    ny: 127,
    ...overrides,
  };
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

/** The nine categories of a complete SHORT forecast slot for the full-pipeline test. */
function fullShortSlotItems(): RawItem[] {
  return [
    item({ category: 'TMP', fcstValue: '25.5' }),
    item({ category: 'SKY', fcstValue: '1' }),
    item({ category: 'PTY', fcstValue: '0' }),
    item({ category: 'POP', fcstValue: '20' }),
    item({ category: 'PCP', fcstValue: '1.0mm' }),
    item({ category: 'SNO', fcstValue: '적설없음' }),
    item({ category: 'REH', fcstValue: '55' }),
    item({ category: 'WSD', fcstValue: '3.4' }),
    item({ category: 'VEC', fcstValue: '270' }),
  ];
}

function jsonOk(bodyString: string): Response {
  return new Response(bodyString, { status: 200 });
}

/** Compose successfully or fail the test — collapses the result-union narrowing in setup. */
function composeOrThrow(
  env: NodeJS.ProcessEnv,
  dependencies: KmaLocationScheduledHourlyCompositionDependencies,
) {
  const result = createKmaLocationScheduledHourlyCompositionFromEnv(env, dependencies);
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createKmaLocationScheduledHourlyCompositionFromEnv — missing/invalid config', () => {
  it('returns the provider MISSING config error for an empty environment (no throw, no I/O)', () => {
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0500_KST_20260718);

    const result = createKmaLocationScheduledHourlyCompositionFromEnv(makeEnv(), {
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
    // No clock read, no fetch.
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    // No raw env / service-key field on the error.
    expect(JSON.stringify(result)).not.toContain('KMA_SERVICE_KEY');
  });

  it('returns INVALID for a whitespace-padded key, without leaking the raw key or reading the clock', () => {
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0500_KST_20260718);
    const rawKey = ` ${SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR13} `;

    const result = createKmaLocationScheduledHourlyCompositionFromEnv(makeEnv(rawKey), {
      fetchImpl,
      clock,
    });

    expect(result).toEqual({
      ok: false,
      error: { kind: 'CONFIG_ERROR', field: 'serviceKey', reason: 'INVALID' },
    });
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR13);
  });
});

describe('createKmaLocationScheduledHourlyCompositionFromEnv — success construction is lazy', () => {
  it('builds a facade exposing only { ok, facade } and runs no converter/clock/network', () => {
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0500_KST_20260718);
    const env = makeEnv(FAKE_KMA_SERVICE_KEY);
    const dependencies: KmaLocationScheduledHourlyCompositionDependencies = { fetchImpl, clock };
    const envSnapshot = JSON.stringify(env);
    const dependenciesSnapshot = { ...dependencies };

    const result = createKmaLocationScheduledHourlyCompositionFromEnv(env, dependencies);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected success');
    }
    expectExactKeys(result, ['ok', 'facade']);
    expect(typeof result.facade.fetchScheduledHourlyForecastForLocation).toBe('function');

    // No clock read, no fetch during construction (the converter also runs no observable I/O).
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);

    // No internal collaborator / secret is exposed on the success result.
    for (const forbidden of [
      'scheduledFacade',
      'gridConverter',
      'provider',
      'requestFactory',
      'hourlyService',
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
  });

  it('works with a frozen environment and frozen dependencies', () => {
    const { fetchImpl } = neverCalledFetch();
    const { clock } = fixedClock(CLOCK_AT_0500_KST_20260718);
    const env = Object.freeze(makeEnv(FAKE_KMA_SERVICE_KEY));
    const dependencies = Object.freeze<KmaLocationScheduledHourlyCompositionDependencies>({
      fetchImpl,
      clock,
    });

    const result = createKmaLocationScheduledHourlyCompositionFromEnv(env, dependencies);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.facade.fetchScheduledHourlyForecastForLocation).toBe('function');
    }
  });

  it('uses the default system clock lazily when none is injected', () => {
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(CLOCK_AT_0500_KST_20260718);
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();

    const result = createKmaLocationScheduledHourlyCompositionFromEnv(
      makeEnv(FAKE_KMA_SERVICE_KEY),
      { fetchImpl },
    );

    expect(result.ok).toBe(true);
    // The default system clock must not read the time until the facade actually runs.
    expect(dateNowSpy).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    dateNowSpy.mockRestore();
  });
});

describe('createKmaLocationScheduledHourlyCompositionFromEnv — full Seoul SHORT pipeline', () => {
  it('assembles the real components (converter → grid → scheduled facade) and normalizes one HourlyForecast', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      jsonOk(successBody(fullShortSlotItems())),
    );
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0500_KST_20260718);
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    // Construction touched neither the clock nor the network.
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);

    const result = await facade.fetchScheduledHourlyForecastForLocation({
      product: SHORT,
      latitude: SEOUL_LATITUDE,
      longitude: SEOUL_LONGITUDE,
    });

    // Exactly one clock read (to build the request) and one fetch.
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);

    // The URL the provider built from the selector's issue time and the PR #12 converter's grid.
    const requestedUrl = fetchCalls[0].url;
    expect(requestedUrl).toBeInstanceOf(URL);
    const url = requestedUrl as URL;
    expect(url.pathname.endsWith('/getVilageFcst')).toBe(true);
    expect(url.searchParams.get('base_date')).toBe('20260718');
    expect(url.searchParams.get('base_time')).toBe('0500');
    // The Seoul lat/lon projected to nx=60, ny=127.
    expect(url.searchParams.get('nx')).toBe('60');
    expect(url.searchParams.get('ny')).toBe('127');
    expect(url.searchParams.get('pageNo')).toBe('1');
    expect(url.searchParams.get('numOfRows')).toBe('1000');
    expect(url.searchParams.get('dataType')).toBe('JSON');
    // The service key round-trips through the query (percent-decoded back to the fake key).
    expect(url.searchParams.get('ServiceKey')).toBe(FAKE_KMA_SERVICE_KEY);

    // Fetch options: GET + Accept application/json.
    expect(fetchCalls[0].init?.method).toBe('GET');
    expect(fetchCalls[0].init?.headers).toEqual({ Accept: 'application/json' });

    // The normalized result.
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`expected success, got ${JSON.stringify(result)}`);
    }
    expect(result.hourly).toHaveLength(1);
    const forecast = result.hourly[0];
    expect(forecast).toEqual({
      forecastAt: '2026-07-18T06:00:00+09:00',
      condition: 'CLEAR',
      temperatureCelsius: 25.5,
      feelsLikeCelsius: null,
      precipitationProbabilityPercent: 20,
      precipitationAmountMillimeters: 1,
      snowfallAmountCentimeters: 0,
      humidityPercent: 55,
      windSpeedMetersPerSecond: 3.4,
      windDirectionDegrees: 270,
    });
    expect(hourlyForecast.safeParse(forecast).success).toBe(true);

    // No raw coordinate / grid / KMA body / URL / key leaks into the facade result.
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      FAKE_KMA_SERVICE_KEY,
      'apis.data.go.kr',
      'ServiceKey',
      'fcstValue',
      'NORMAL_SERVICE',
      '적설없음',
      '1.0mm',
      'latitude',
      'longitude',
      String(SEOUL_LATITUDE),
      String(SEOUL_LONGITUDE),
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('createKmaLocationScheduledHourlyCompositionFromEnv — unsupported location', () => {
  it('returns a LOCATION/UNSUPPORTED_LOCATION result for Tokyo, with no clock read and no fetch', async () => {
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0500_KST_20260718);
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const result = await facade.fetchScheduledHourlyForecastForLocation({
      product: SHORT,
      latitude: TOKYO_LATITUDE,
      longitude: TOKYO_LONGITUDE,
    });

    expect(result).toEqual({
      ok: false,
      stage: 'LOCATION',
      error: { kind: 'UNSUPPORTED_LOCATION' },
    });
    // The provider was never reached: no clock read, no fetch.
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    // No raw coordinate leaks into the result, and the stage is not misreported.
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      'latitude',
      'longitude',
      String(TOKYO_LATITUDE),
      String(TOKYO_LONGITUDE),
      'PROVIDER',
      'NORMALIZATION',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('createKmaLocationScheduledHourlyCompositionFromEnv — invalid coordinate', () => {
  it('lets the PR #12 RangeError propagate synchronously, without a clock read, fetch, or LOCATION result', async () => {
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0500_KST_20260718);
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    let caught: unknown;
    let returned: unknown;
    try {
      returned = facade.fetchScheduledHourlyForecastForLocation({
        product: SHORT,
        latitude: SECRET_SHAPED_LOCATION_MUST_NOT_LEAK_PR13,
        longitude: 127,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RangeError);
    expect((caught as RangeError).message).toBe('latitude must be within [-90, 90]');
    // The throw happened synchronously — no Promise was returned.
    expect(returned).toBeUndefined();
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    // The out-of-range raw coordinate never appears in the error message.
    expect((caught as RangeError).message).not.toContain(
      String(SECRET_SHAPED_LOCATION_MUST_NOT_LEAK_PR13),
    );
  });
});

describe('createKmaLocationScheduledHourlyCompositionFromEnv — AbortSignal end-to-end', () => {
  it('honours a pre-aborted signal as a PROVIDER-stage ABORTED after a successful conversion', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      jsonOk(successBody(fullShortSlotItems())),
    );
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0500_KST_20260718);
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const controller = new AbortController();
    controller.abort();

    const result = await facade.fetchScheduledHourlyForecastForLocation(
      { product: SHORT, latitude: SEOUL_LATITUDE, longitude: SEOUL_LONGITUDE },
      { signal: controller.signal },
    );

    expect(result).toEqual({
      ok: false,
      stage: 'PROVIDER',
      error: { kind: 'ABORTED' },
    });
    // The conversion succeeded and the request was built (one clock read), but the provider
    // short-circuited on the aborted signal before fetch — not re-classified as a LOCATION stage.
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('createKmaLocationScheduledHourlyCompositionFromEnv — downstream failures', () => {
  it('surfaces an HTTP 503 as a PROVIDER-stage HTTP_ERROR (not re-classified as LOCATION)', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(
      () => new Response('secret upstream error page', { status: 503 }),
    );
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0500_KST_20260718);
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const result = await facade.fetchScheduledHourlyForecastForLocation({
      product: SHORT,
      latitude: SEOUL_LATITUDE,
      longitude: SEOUL_LONGITUDE,
    });

    expect(result).toEqual({
      ok: false,
      stage: 'PROVIDER',
      error: { kind: 'HTTP_ERROR', status: 503 },
    });
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);

    const serialized = JSON.stringify(result);
    for (const forbidden of [
      FAKE_KMA_SERVICE_KEY,
      'apis.data.go.kr',
      'ServiceKey',
      'latitude',
      'longitude',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('surfaces a missing required temperature category as a NORMALIZATION-stage issue', async () => {
    const items = [
      item({ category: 'SKY', fcstValue: '1' }),
      item({ category: 'PTY', fcstValue: '0' }),
    ];
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() => jsonOk(successBody(items)));
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0500_KST_20260718);
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const result = await facade.fetchScheduledHourlyForecastForLocation({
      product: SHORT,
      latitude: SEOUL_LATITUDE,
      longitude: SEOUL_LONGITUDE,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected a normalization failure');
    }
    expect(result.stage).toBe('NORMALIZATION');
    if (result.stage !== 'NORMALIZATION') {
      throw new Error(`expected NORMALIZATION stage, got ${result.stage}`);
    }
    expect(result.issues).toContainEqual({
      slotKey: 'SHORT_FORECAST|20260718|0500|20260718|0600|60|127',
      field: 'temperatureCelsius',
      reason: 'ABSENT',
    });
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);

    expect('hourly' in result).toBe(false);
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      FAKE_KMA_SERVICE_KEY,
      'apis.data.go.kr',
      'ServiceKey',
      'fcstValue',
      'latitude',
      'longitude',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('createKmaLocationScheduledHourlyCompositionFromEnv — repeated independent calls', () => {
  it('threads two facade calls independently (clock ×2, fetch ×2, distinct result references)', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      jsonOk(successBody(fullShortSlotItems())),
    );
    // Two distinct instants; both are 0500 KST on 20260718 (same schedule bucket) but read twice.
    const { clock, nowEpochMilliseconds } = sequenceClock([
      CLOCK_AT_0500_KST_20260718,
      CLOCK_AT_0500_KST_20260718 + 60_000,
    ]);
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const first = await facade.fetchScheduledHourlyForecastForLocation({
      product: SHORT,
      latitude: SEOUL_LATITUDE,
      longitude: SEOUL_LONGITUDE,
    });
    const second = await facade.fetchScheduledHourlyForecastForLocation({
      product: SHORT,
      latitude: SEOUL_LATITUDE,
      longitude: SEOUL_LONGITUDE,
    });

    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(2);
    expect(fetchCalls).toHaveLength(2);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      throw new Error('expected both calls to succeed');
    }
    // Independent result objects and hourly arrays — nothing cached or reused across calls.
    expect(first).not.toBe(second);
    expect(first.hourly).not.toBe(second.hourly);
    expect(first).toEqual(second);
  });

  it('does not mix state between a supported call and a following unsupported call', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      jsonOk(successBody(fullShortSlotItems())),
    );
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0500_KST_20260718);
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const supported = await facade.fetchScheduledHourlyForecastForLocation({
      product: SHORT,
      latitude: SEOUL_LATITUDE,
      longitude: SEOUL_LONGITUDE,
    });
    const unsupported = await facade.fetchScheduledHourlyForecastForLocation({
      product: SHORT,
      latitude: TOKYO_LATITUDE,
      longitude: TOKYO_LONGITUDE,
    });

    expect(supported.ok).toBe(true);
    expect(unsupported).toEqual({
      ok: false,
      stage: 'LOCATION',
      error: { kind: 'UNSUPPORTED_LOCATION' },
    });
    // Only the supported call read the clock and hit the network.
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);
  });
});

describe('createKmaLocationScheduledHourlyCompositionFromEnv — no secret leakage, no logging', () => {
  it('never surfaces the service key or raw coordinate across success/unsupported/failure results, and logs nothing', async () => {
    const consoleSpy = spyOnConsole();

    // 1) Success pipeline with a secret-shaped key.
    const success = recordingFetch(() => jsonOk(successBody(fullShortSlotItems())));
    const successFacade = composeOrThrow(
      makeEnv(SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR13),
      { fetchImpl: success.fetchImpl, clock: fixedClock(CLOCK_AT_0500_KST_20260718).clock },
    );
    const successResult = await successFacade.fetchScheduledHourlyForecastForLocation({
      product: SHORT,
      latitude: SEOUL_LATITUDE,
      longitude: SEOUL_LONGITUDE,
    });
    expect(successResult.ok).toBe(true);
    expect(JSON.stringify(successResult)).not.toContain(SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR13);

    // 2) Unsupported location — the raw coordinate must not leak.
    const unsupportedFacade = composeOrThrow(
      makeEnv(SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR13),
      { fetchImpl: neverCalledFetch().fetchImpl, clock: fixedClock(CLOCK_AT_0500_KST_20260718).clock },
    );
    const unsupportedResult = await unsupportedFacade.fetchScheduledHourlyForecastForLocation({
      product: SHORT,
      latitude: TOKYO_LATITUDE,
      longitude: TOKYO_LONGITUDE,
    });
    expect(unsupportedResult.ok).toBe(false);
    expect(JSON.stringify(unsupportedResult)).not.toContain(String(TOKYO_LATITUDE));
    expect(JSON.stringify(unsupportedResult)).not.toContain(String(TOKYO_LONGITUDE));

    // 3) Provider failure with the same secret-shaped key.
    const providerFail = recordingFetch(() => new Response('x', { status: 503 }));
    const providerFailFacade = composeOrThrow(
      makeEnv(SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR13),
      { fetchImpl: providerFail.fetchImpl, clock: fixedClock(CLOCK_AT_0500_KST_20260718).clock },
    );
    const providerFailResult = await providerFailFacade.fetchScheduledHourlyForecastForLocation({
      product: SHORT,
      latitude: SEOUL_LATITUDE,
      longitude: SEOUL_LONGITUDE,
    });
    expect(providerFailResult.ok).toBe(false);
    expect(JSON.stringify(providerFailResult)).not.toContain(SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR13);

    // The composition and its collaborators never log.
    consoleSpy.expectSilent();
    consoleSpy.restore();
  });
});
