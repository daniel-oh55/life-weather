import { afterEach, describe, expect, it, vi } from 'vitest';

import { hourlyForecast } from '@life-weather/contracts';
import { KmaForecastProduct } from '@life-weather/weather-core';

import type { KmaForecastRequestClock } from '../services';
import {
  createKmaScheduledHourlyCompositionFromEnv,
  type KmaScheduledHourlyCompositionDependencies,
} from './kma-scheduled-hourly';

/**
 * These tests assemble the **real** components — the PR #5 provider-from-env, the PR #7 hourly
 * service, the PR #9 request factory (with the PR #8 issue-time selector), the PR #6 hourly
 * normalizer, and the PR #10 scheduled facade — through the composition root. Nothing is mocked
 * except the network (an injected in-memory `fetchImpl`) and, where a deterministic instant is
 * needed, the clock (an injected fake clock). No real service key, no external network, and no fake
 * timers are used.
 */

const SHORT = KmaForecastProduct.SHORT_FORECAST;
const ULTRA = KmaForecastProduct.ULTRA_SHORT_FORECAST;

/** An obviously fake, decoded-shaped service key. Never a real/production key. */
const FAKE_KMA_SERVICE_KEY = 'test-only-decoded-key+slash==';

/** A secret-shaped key marker used only to prove the key never leaks into a result, error, or log. */
const SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR11 =
  'SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR11+slash==';

/** A secret-shaped clock value marker used to prove an invalid epoch never leaks into an error. */
const SECRET_SHAPED_CLOCK_VALUE_MUST_NOT_LEAK_PR11 =
  'SECRET_SHAPED_CLOCK_VALUE_MUST_NOT_LEAK_PR11';

/**
 * The reference instant `2026-07-18T05:00:00.000+09:00` as absolute epoch milliseconds. Computed
 * with `Date.UTC` (a pure, deterministic function — not `Date.now`/`new Date`), so the value is a
 * fixed constant, not a read of the current time. `05:00 KST` == `2026-07-17T20:00:00.000Z`. Under
 * the production availability-delay selector (PR #14, wired here in PR #15), this instant selects the
 * SHORT `0200` issuance — the `0500` issuance's 10-minute availability threshold has not yet elapsed.
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

/**
 * A raw forecast item matching the 20260718/0200 → 0600 60/127 identity unless overridden. The
 * `0200` base issuance is the availability-delay selector's production choice at 05:00 KST (the
 * 0500 issuance's 10-minute threshold has not yet elapsed), so the fixture's item identity matches
 * the request the production pipeline actually builds.
 */
function item(overrides: Partial<RawItem> = {}): RawItem {
  return {
    baseDate: '20260718',
    baseTime: '0200',
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
  dependencies: KmaScheduledHourlyCompositionDependencies,
) {
  const result = createKmaScheduledHourlyCompositionFromEnv(env, dependencies);
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

describe('createKmaScheduledHourlyCompositionFromEnv — missing/invalid config', () => {
  it('returns the provider MISSING config error for an empty environment (no throw, no I/O)', () => {
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0500_KST_20260718);
    const env = makeEnv();

    const result = createKmaScheduledHourlyCompositionFromEnv(env, {
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
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('KMA_SERVICE_KEY');
  });

  it('returns MISSING for a whitespace-only key (no clock read, no fetch)', () => {
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0500_KST_20260718);

    const result = createKmaScheduledHourlyCompositionFromEnv(makeEnv('   '), {
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

  it('returns INVALID for a key with leading/trailing whitespace, without leaking the raw key', () => {
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0500_KST_20260718);
    const rawKey = ` ${SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR11} `;

    const result = createKmaScheduledHourlyCompositionFromEnv(makeEnv(rawKey), {
      fetchImpl,
      clock,
    });

    expect(result).toEqual({
      ok: false,
      error: { kind: 'CONFIG_ERROR', field: 'serviceKey', reason: 'INVALID' },
    });
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    // The raw (secret-shaped) key never appears in the error serialization.
    expect(JSON.stringify(result)).not.toContain(
      SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR11,
    );
  });
});

describe('createKmaScheduledHourlyCompositionFromEnv — success construction', () => {
  it('builds a facade exposing only { ok, facade } and reads no clock / network at construction', () => {
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0500_KST_20260718);
    const env = makeEnv(FAKE_KMA_SERVICE_KEY);
    const dependencies: KmaScheduledHourlyCompositionDependencies = { fetchImpl, clock };
    const envSnapshot = JSON.stringify(env);
    const dependenciesSnapshot = { ...dependencies };

    const result = createKmaScheduledHourlyCompositionFromEnv(env, dependencies);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected success');
    }
    expectExactKeys(result, ['ok', 'facade']);
    expect(typeof result.facade.fetchScheduledHourlyForecast).toBe('function');

    // No clock read, no fetch during construction.
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);

    // No internal collaborator / secret is exposed on the success result.
    for (const forbidden of [
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
    const dependencies = Object.freeze<KmaScheduledHourlyCompositionDependencies>({
      fetchImpl,
      clock,
    });

    const result = createKmaScheduledHourlyCompositionFromEnv(env, dependencies);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.facade.fetchScheduledHourlyForecast).toBe('function');
    }
  });
});

describe('createKmaScheduledHourlyCompositionFromEnv — default system clock is lazy', () => {
  it('uses the system clock by default but reads no time at construction', () => {
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(CLOCK_AT_0500_KST_20260718);
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();

    // No custom clock injected → the default system clock adapter is selected.
    const result = createKmaScheduledHourlyCompositionFromEnv(makeEnv(FAKE_KMA_SERVICE_KEY), {
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    // The default system clock must not read the time until the facade actually runs.
    expect(dateNowSpy).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    dateNowSpy.mockRestore();
  });
});

describe('createKmaScheduledHourlyCompositionFromEnv — full SHORT pipeline', () => {
  it('assembles the real components and produces one normalized HourlyForecast', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      jsonOk(successBody(fullShortSlotItems())),
    );
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0500_KST_20260718);
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    // Construction touched neither the clock nor the network.
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);

    const result = await facade.fetchScheduledHourlyForecast({ product: SHORT, nx: 60, ny: 127 });

    // Exactly one clock read (to build the request) and one fetch.
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);

    // The URL the provider built from the selector's issue time and the caller's grid.
    const requestedUrl = fetchCalls[0].url;
    expect(requestedUrl).toBeInstanceOf(URL);
    const url = requestedUrl as URL;
    expect(url.pathname.endsWith('/getVilageFcst')).toBe(true);
    expect(url.searchParams.get('base_date')).toBe('20260718');
    // 05:00 KST → the availability-delay selector picks 0200 (0500's 10-minute threshold unmet).
    expect(url.searchParams.get('base_time')).toBe('0200');
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
    // The output passes the contracts schema.
    expect(hourlyForecast.safeParse(forecast).success).toBe(true);

    // No raw KMA item/body/URL/key leaks into the facade result.
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      FAKE_KMA_SERVICE_KEY,
      'apis.data.go.kr',
      'ServiceKey',
      'fcstValue',
      'NORMAL_SERVICE',
      '적설없음',
      '1.0mm',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('createKmaScheduledHourlyCompositionFromEnv — AbortSignal end-to-end', () => {
  it('honours a pre-aborted signal as a PROVIDER-stage ABORTED with no fetch', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      jsonOk(successBody(fullShortSlotItems())),
    );
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0500_KST_20260718);
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const controller = new AbortController();
    controller.abort();

    const result = await facade.fetchScheduledHourlyForecast(
      { product: SHORT, nx: 60, ny: 127 },
      { signal: controller.signal },
    );

    expect(result).toEqual({
      ok: false,
      stage: 'PROVIDER',
      error: { kind: 'ABORTED' },
    });
    // The request was still built (one clock read), but the provider short-circuited before fetch.
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('createKmaScheduledHourlyCompositionFromEnv — provider failure end-to-end', () => {
  it('surfaces an HTTP 503 as a PROVIDER-stage HTTP_ERROR (not re-classified)', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      new Response('secret upstream error page', { status: 503 }),
    );
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0500_KST_20260718);
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const result = await facade.fetchScheduledHourlyForecast({ product: SHORT, nx: 60, ny: 127 });

    expect(result).toEqual({
      ok: false,
      stage: 'PROVIDER',
      error: { kind: 'HTTP_ERROR', status: 503 },
    });
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);

    const serialized = JSON.stringify(result);
    for (const forbidden of [FAKE_KMA_SERVICE_KEY, 'apis.data.go.kr', 'ServiceKey']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('createKmaScheduledHourlyCompositionFromEnv — normalization failure end-to-end', () => {
  it('surfaces a missing required temperature category as a NORMALIZATION-stage issue', async () => {
    // A complete, correlated provider success whose slot lacks TMP → the hourly normalizer fails.
    const items = [
      item({ category: 'SKY', fcstValue: '1' }),
      item({ category: 'PTY', fcstValue: '0' }),
    ];
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      jsonOk(successBody(items)),
    );
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0500_KST_20260718);
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const result = await facade.fetchScheduledHourlyForecast({ product: SHORT, nx: 60, ny: 127 });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected a normalization failure');
    }
    expect(result.stage).toBe('NORMALIZATION');
    if (result.stage !== 'NORMALIZATION') {
      throw new Error(`expected NORMALIZATION stage, got ${result.stage}`);
    }
    // The exact issue the real normalizer produces for an absent required temperature. The slot's
    // base issuance is 0200 — the availability-delay selector's production choice at 05:00 KST.
    expect(result.issues).toContainEqual({
      slotKey: 'SHORT_FORECAST|20260718|0200|20260718|0600|60|127',
      field: 'temperatureCelsius',
      reason: 'ABSENT',
    });
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);

    // No partial hourly data, no raw key/URL/body.
    expect('hourly' in result).toBe(false);
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      FAKE_KMA_SERVICE_KEY,
      'apis.data.go.kr',
      'ServiceKey',
      'fcstValue',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('createKmaScheduledHourlyCompositionFromEnv — injected clock errors', () => {
  it('propagates the exact error a throwing clock throws and never fetches', async () => {
    const sentinel = new Error('KMA_COMPOSITION_CLOCK_SENTINEL_FOR_IDENTITY');
    const nowEpochMilliseconds = vi.fn(() => {
      throw sentinel;
    });
    const clock: KmaForecastRequestClock = { nowEpochMilliseconds };
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const consoleSpy = spyOnConsole();
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    let caught: unknown;
    try {
      await facade.fetchScheduledHourlyForecast({ product: SHORT, nx: 60, ny: 127 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(sentinel);
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(0);
    consoleSpy.expectSilent();
    consoleSpy.restore();
  });

  it('lets the selector RangeError propagate for an invalid epoch, without leaking the raw value', async () => {
    // A runtime cast injects a secret-shaped non-number; the PR #8 selector rejects it.
    const nowEpochMilliseconds = vi.fn(
      () => SECRET_SHAPED_CLOCK_VALUE_MUST_NOT_LEAK_PR11 as unknown as number,
    );
    const clock: KmaForecastRequestClock = { nowEpochMilliseconds };
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    let caught: unknown;
    try {
      await facade.fetchScheduledHourlyForecast({ product: SHORT, nx: 60, ny: 127 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RangeError);
    expect(fetchCalls).toHaveLength(0);
    // The raw (secret-shaped) clock value never appears in the error message.
    expect((caught as RangeError).message).not.toContain(
      SECRET_SHAPED_CLOCK_VALUE_MUST_NOT_LEAK_PR11,
    );
  });

  it('lets the selector RangeError propagate for a NaN epoch', () => {
    const { clock, nowEpochMilliseconds } = fixedClock(Number.NaN);
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    // The factory reads the clock and the selector throws synchronously before any Promise/fetch.
    let caught: unknown;
    try {
      facade.fetchScheduledHourlyForecast({ product: SHORT, nx: 60, ny: 127 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RangeError);
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('createKmaScheduledHourlyCompositionFromEnv — repeated independent calls', () => {
  it('threads two facade calls independently (clock ×2, fetch ×2, distinct result references)', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      jsonOk(successBody(fullShortSlotItems())),
    );
    // Two distinct instants (05:00 and 05:01 KST); both resolve to the 0200 availability bucket on
    // 20260718 under the production selector, but the clock is still read once per call.
    const { clock, nowEpochMilliseconds } = sequenceClock([
      CLOCK_AT_0500_KST_20260718,
      CLOCK_AT_0500_KST_20260718 + 60_000,
    ]);
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const first = await facade.fetchScheduledHourlyForecast({ product: SHORT, nx: 60, ny: 127 });
    const second = await facade.fetchScheduledHourlyForecast({ product: SHORT, nx: 60, ny: 127 });

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
});

describe('createKmaScheduledHourlyCompositionFromEnv — no secret leakage, no logging', () => {
  it('never surfaces the service key across success and both failure results, and logs nothing', async () => {
    const consoleSpy = spyOnConsole();

    // 1) Success pipeline with a secret-shaped key.
    const success = recordingFetch(() => jsonOk(successBody(fullShortSlotItems())));
    const successClock = fixedClock(CLOCK_AT_0500_KST_20260718);
    const successFacade = composeOrThrow(
      makeEnv(SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR11),
      { fetchImpl: success.fetchImpl, clock: successClock.clock },
    );
    const successResult = await successFacade.fetchScheduledHourlyForecast({
      product: SHORT,
      nx: 60,
      ny: 127,
    });
    expect(successResult.ok).toBe(true);
    expect(JSON.stringify(successResult)).not.toContain(
      SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR11,
    );

    // 2) Provider failure with the same secret-shaped key.
    const providerFail = recordingFetch(() => new Response('x', { status: 503 }));
    const providerFailFacade = composeOrThrow(
      makeEnv(SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR11),
      { fetchImpl: providerFail.fetchImpl, clock: fixedClock(CLOCK_AT_0500_KST_20260718).clock },
    );
    const providerFailResult = await providerFailFacade.fetchScheduledHourlyForecast({
      product: SHORT,
      nx: 60,
      ny: 127,
    });
    expect(providerFailResult.ok).toBe(false);
    expect(JSON.stringify(providerFailResult)).not.toContain(
      SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR11,
    );

    // 3) Normalization failure with the same secret-shaped key.
    const normFail = recordingFetch(() =>
      jsonOk(successBody([item({ category: 'SKY', fcstValue: '1' })])),
    );
    const normFailFacade = composeOrThrow(
      makeEnv(SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR11),
      { fetchImpl: normFail.fetchImpl, clock: fixedClock(CLOCK_AT_0500_KST_20260718).clock },
    );
    const normFailResult = await normFailFacade.fetchScheduledHourlyForecast({
      product: SHORT,
      nx: 60,
      ny: 127,
    });
    expect(normFailResult.ok).toBe(false);
    expect(JSON.stringify(normFailResult)).not.toContain(
      SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR11,
    );

    // The composition and system clock never log.
    consoleSpy.expectSilent();
    consoleSpy.restore();
  });
});

describe('createKmaScheduledHourlyCompositionFromEnv — production SHORT availability boundary', () => {
  // The exact inclusive 10-minute SHORT threshold, exercised through the real production wiring:
  // one millisecond before it selects the previous issuance, exactly on it selects the new one.
  // HTTP 503 keeps the assertion on URL selection only (no normalization fixture needed).
  it('05:09:59.999 KST selects base_time 0200 (0500 threshold not yet met)', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(
      () => new Response('x', { status: 503 }),
    );
    // 05:09:59.999 KST == 2026-07-17T20:09:59.999Z.
    const { clock, nowEpochMilliseconds } = fixedClock(
      Date.UTC(2026, 6, 17, 20, 9, 59, 999),
    );
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const result = await facade.fetchScheduledHourlyForecast({ product: SHORT, nx: 60, ny: 127 });

    expect(result).toEqual({
      ok: false,
      stage: 'PROVIDER',
      error: { kind: 'HTTP_ERROR', status: 503 },
    });
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);
    const url = fetchCalls[0].url as URL;
    expect(url.pathname.endsWith('/getVilageFcst')).toBe(true);
    expect(url.searchParams.get('base_date')).toBe('20260718');
    expect(url.searchParams.get('base_time')).toBe('0200');
    expect(url.searchParams.get('nx')).toBe('60');
    expect(url.searchParams.get('ny')).toBe('127');
  });

  it('05:10:00.000 KST selects base_time 0500 (10-minute threshold exactly met)', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(
      () => new Response('x', { status: 503 }),
    );
    // 05:10:00.000 KST == 2026-07-17T20:10:00.000Z.
    const { clock, nowEpochMilliseconds } = fixedClock(
      Date.UTC(2026, 6, 17, 20, 10, 0, 0),
    );
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const result = await facade.fetchScheduledHourlyForecast({ product: SHORT, nx: 60, ny: 127 });

    expect(result).toEqual({
      ok: false,
      stage: 'PROVIDER',
      error: { kind: 'HTTP_ERROR', status: 503 },
    });
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);
    const url = fetchCalls[0].url as URL;
    expect(url.pathname.endsWith('/getVilageFcst')).toBe(true);
    expect(url.searchParams.get('base_date')).toBe('20260718');
    expect(url.searchParams.get('base_time')).toBe('0500');
    expect(url.searchParams.get('nx')).toBe('60');
    expect(url.searchParams.get('ny')).toBe('127');
  });
});

describe('createKmaScheduledHourlyCompositionFromEnv — production ULTRA availability wiring', () => {
  // The 15-minute ULTRA threshold, exercised through the real production wiring. Each reference is
  // an independent composition/fetch/clock; HTTP 503 keeps the assertion on URL selection only.
  it('06:30:00.000 KST selects getUltraSrtFcst base_time 0530 (0630 threshold not yet met)', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(
      () => new Response('x', { status: 503 }),
    );
    // 06:30:00.000 KST == 2026-07-17T21:30:00.000Z.
    const { clock, nowEpochMilliseconds } = fixedClock(
      Date.UTC(2026, 6, 17, 21, 30, 0, 0),
    );
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const result = await facade.fetchScheduledHourlyForecast({ product: ULTRA, nx: 55, ny: 124 });

    expect(result).toEqual({
      ok: false,
      stage: 'PROVIDER',
      error: { kind: 'HTTP_ERROR', status: 503 },
    });
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);
    const url = fetchCalls[0].url as URL;
    expect(url.pathname.endsWith('/getUltraSrtFcst')).toBe(true);
    expect(url.searchParams.get('base_date')).toBe('20260718');
    expect(url.searchParams.get('base_time')).toBe('0530');
    expect(url.searchParams.get('nx')).toBe('55');
    expect(url.searchParams.get('ny')).toBe('124');
  });

  it('06:45:00.000 KST selects getUltraSrtFcst base_time 0630 (15-minute threshold exactly met)', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(
      () => new Response('x', { status: 503 }),
    );
    // 06:45:00.000 KST == 2026-07-17T21:45:00.000Z.
    const { clock, nowEpochMilliseconds } = fixedClock(
      Date.UTC(2026, 6, 17, 21, 45, 0, 0),
    );
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const result = await facade.fetchScheduledHourlyForecast({ product: ULTRA, nx: 55, ny: 124 });

    expect(result).toEqual({
      ok: false,
      stage: 'PROVIDER',
      error: { kind: 'HTTP_ERROR', status: 503 },
    });
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);
    const url = fetchCalls[0].url as URL;
    expect(url.pathname.endsWith('/getUltraSrtFcst')).toBe(true);
    expect(url.searchParams.get('base_date')).toBe('20260718');
    expect(url.searchParams.get('base_time')).toBe('0630');
    expect(url.searchParams.get('nx')).toBe('55');
    expect(url.searchParams.get('ny')).toBe('124');
  });
});
