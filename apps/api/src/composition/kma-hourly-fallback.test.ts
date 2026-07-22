import { afterEach, describe, expect, it, vi } from 'vitest';

import { hourlyForecast } from '@life-weather/contracts';
import { KmaForecastProduct } from '@life-weather/weather-core';

import type { KmaForecastRequestClock } from '../services';
import {
  createKmaHourlyFallbackCompositionFromEnv,
  type KmaHourlyFallbackCompositionDependencies,
} from './kma-hourly-fallback';

/**
 * These tests assemble the **real** production components through the new grid fallback composition
 * root — the PR #5 provider-from-env, the PR #7 hourly service, the PR #18 request-plan factory (with
 * the explicitly-injected PR #16 availability-aware candidate selector), the PR #6 hourly normalizer,
 * the PR #17 eligibility classifier, and the PR #19 fallback orchestration service. Nothing is mocked
 * except the network (an injected in-memory `fetchImpl`) and, where a deterministic instant is needed,
 * the clock (an injected fake clock). No real service key, no external network, no mock collaborator,
 * and no fake timers are used.
 */

const SHORT = KmaForecastProduct.SHORT_FORECAST;
const ULTRA = KmaForecastProduct.ULTRA_SHORT_FORECAST;

/** An obviously fake, decoded-shaped service key. Never a real/production key. */
const FAKE_KMA_SERVICE_KEY = 'test-only-decoded-key+slash==';

/** A secret-shaped key marker used only to prove the key never leaks into a result, error, or log. */
const SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR20 =
  'SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR20+slash==';

/** A secret-shaped clock value marker used to prove an invalid epoch never leaks into an error. */
const SECRET_SHAPED_CLOCK_VALUE_MUST_NOT_LEAK_PR20 =
  'SECRET_SHAPED_CLOCK_VALUE_MUST_NOT_LEAK_PR20';

/**
 * A secret-shaped upstream `resultMsg` marker. The provider drops the raw `resultMsg` at its
 * boundary, so this must never reach any composition/service result.
 */
const SECRET_SHAPED_RESULT_MSG_MUST_NOT_LEAK_PR20 =
  'SECRET_SHAPED_RESULT_MSG_MUST_NOT_LEAK_PR20';

/**
 * `2026-07-22T05:10:00.000+09:00` as absolute epoch milliseconds, computed with `Date.UTC` (a pure,
 * deterministic function — not `Date.now`/`new Date`). `05:10 KST` == `2026-07-21T20:10:00.000Z`.
 * Under the production PR #16 candidate selector this instant yields the SHORT candidate pair
 * `{ primary: 20260722/0500, previous: 20260722/0200 }` (the `0500` issuance's 10-minute availability
 * threshold is exactly met, and the one-step-back previous is `0200`).
 */
const CLOCK_AT_0510_KST_20260722 = Date.UTC(2026, 6, 21, 20, 10, 0, 0);

/**
 * `2026-07-22T05:09:59.999+09:00` == `2026-07-21T20:09:59.999Z`. One millisecond before the SHORT
 * `0500` threshold, so the candidate pair shifts back one issuance to
 * `{ primary: 20260722/0200, previous: 20260721/2300 }`.
 */
const CLOCK_AT_050959999_KST_20260722 = Date.UTC(2026, 6, 21, 20, 9, 59, 999);

/**
 * `2026-07-22T06:45:00.000+09:00` == `2026-07-21T21:45:00.000Z`. The ULTRA `0630` issuance's
 * 15-minute threshold is exactly met, so the candidate pair is
 * `{ primary: 20260722/0630, previous: 20260722/0530 }`.
 */
const CLOCK_AT_0645_KST_20260722 = Date.UTC(2026, 6, 21, 21, 45, 0, 0);

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

/**
 * A `fetch` that records the call then rejects with a test-local sentinel (no abort), so the real
 * provider classifies it as `NETWORK_ERROR`. The sentinel message is secret-shaped to prove the raw
 * exception never reaches the provider's error surface.
 */
function rejectingFetch(sentinel: Error) {
  const calls: FetchRecord[] = [];
  const fetchImpl = ((url: unknown, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.reject(sentinel);
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
 * date `20260722`, forecast time `0600`, grid `60/127`. The item base issuance must match the request
 * the production pipeline builds for that attempt, or the provider's correlation check rejects it.
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
        resultMsg: SECRET_SHAPED_RESULT_MSG_MUST_NOT_LEAK_PR20,
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
  dependencies: KmaHourlyFallbackCompositionDependencies,
) {
  const result = createKmaHourlyFallbackCompositionFromEnv(env, dependencies);
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

/** Values that must never appear in a serialized composition/service result. */
const FORBIDDEN_LEAKAGE_STRINGS = [
  FAKE_KMA_SERVICE_KEY,
  SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR20,
  SECRET_SHAPED_RESULT_MSG_MUST_NOT_LEAK_PR20,
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createKmaHourlyFallbackCompositionFromEnv — missing/invalid config', () => {
  it('returns the provider MISSING config error for an empty environment (no throw, no I/O)', () => {
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);

    const result = createKmaHourlyFallbackCompositionFromEnv(makeEnv(), {
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
    // No clock read, no fetch.
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('KMA_SERVICE_KEY');
  });

  it('returns MISSING for a whitespace-only key (no clock read, no fetch)', () => {
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);

    const result = createKmaHourlyFallbackCompositionFromEnv(makeEnv('   '), {
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
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);
    const rawKey = ` ${SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR20} `;

    const result = createKmaHourlyFallbackCompositionFromEnv(makeEnv(rawKey), {
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
      SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR20,
    );
  });

  it('works with a frozen environment and frozen dependencies on config failure', () => {
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);
    const env = Object.freeze(makeEnv());
    const dependencies = Object.freeze<KmaHourlyFallbackCompositionDependencies>({
      fetchImpl,
      clock,
    });

    const result = createKmaHourlyFallbackCompositionFromEnv(env, dependencies);

    expect(result).toEqual({
      ok: false,
      error: { kind: 'CONFIG_ERROR', field: 'serviceKey', reason: 'MISSING' },
    });
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('createKmaHourlyFallbackCompositionFromEnv — success construction', () => {
  it('builds a service exposing only { ok, service } and reads no clock / network at construction', () => {
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);
    const env = makeEnv(FAKE_KMA_SERVICE_KEY);
    const dependencies: KmaHourlyFallbackCompositionDependencies = {
      fetchImpl,
      clock,
    };
    const envSnapshot = JSON.stringify(env);
    const dependenciesSnapshot = { ...dependencies };

    const result = createKmaHourlyFallbackCompositionFromEnv(env, dependencies);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected success');
    }
    expectExactKeys(result, ['ok', 'service']);
    expectExactKeys(result.service, ['fetchHourlyForecastWithFallback']);
    expect(typeof result.service.fetchHourlyForecastWithFallback).toBe('function');

    // No clock read, no fetch, no request-plan build during construction (observable via the counts).
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);

    // No internal collaborator / secret is exposed on the success result.
    for (const forbidden of [
      'provider',
      'requestPlanFactory',
      'hourlyService',
      'classifier',
      'selector',
      'clock',
      'env',
      'fetchImpl',
      'serviceKey',
      'config',
      'url',
      'dependencies',
      'facade',
    ]) {
      expect(forbidden in result).toBe(false);
    }

    // Neither the environment nor the dependencies object was mutated.
    expect(JSON.stringify(env)).toBe(envSnapshot);
    expect(dependencies.fetchImpl).toBe(dependenciesSnapshot.fetchImpl);
    expect(dependencies.clock).toBe(dependenciesSnapshot.clock);
  });

  it('works with a frozen environment and frozen dependencies on success', () => {
    const { fetchImpl } = neverCalledFetch();
    const { clock } = fixedClock(CLOCK_AT_0510_KST_20260722);
    const env = Object.freeze(makeEnv(FAKE_KMA_SERVICE_KEY));
    const dependencies = Object.freeze<KmaHourlyFallbackCompositionDependencies>({
      fetchImpl,
      clock,
    });

    const result = createKmaHourlyFallbackCompositionFromEnv(env, dependencies);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.service.fetchHourlyForecastWithFallback).toBe(
        'function',
      );
    }
  });
});

describe('createKmaHourlyFallbackCompositionFromEnv — fresh independent graph', () => {
  it('builds distinct wrapper/service/method references and shares no cache across calls', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      jsonOk(successBody(completeShortSlotItems({ baseTime: '0500' }))),
    );
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);
    const env = makeEnv(FAKE_KMA_SERVICE_KEY);
    const dependencies: KmaHourlyFallbackCompositionDependencies = {
      fetchImpl,
      clock,
    };

    const first = createKmaHourlyFallbackCompositionFromEnv(env, dependencies);
    const second = createKmaHourlyFallbackCompositionFromEnv(env, dependencies);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      throw new Error('expected both compositions to succeed');
    }

    // Distinct wrapper, service, and method references — no shared singleton.
    expect(first).not.toBe(second);
    expect(first.service).not.toBe(second.service);
    expect(first.service.fetchHourlyForecastWithFallback).not.toBe(
      second.service.fetchHourlyForecastWithFallback,
    );

    // Construction touched neither the clock nor the network for either graph.
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);

    // Each graph drives the collaborators independently and returns a fresh result (no cache reuse).
    const firstResult = await first.service.fetchHourlyForecastWithFallback({
      product: SHORT,
      nx: 60,
      ny: 127,
    });
    const secondResult = await second.service.fetchHourlyForecastWithFallback({
      product: SHORT,
      nx: 60,
      ny: 127,
    });

    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(2);
    expect(fetchCalls).toHaveLength(2);
    expect(firstResult).not.toBe(secondResult);
    expect(firstResult).toEqual(secondResult);
  });
});

describe('createKmaHourlyFallbackCompositionFromEnv — default system clock is lazy', () => {
  it('uses the system clock by default but reads no time at construction', () => {
    const dateNowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValue(CLOCK_AT_0510_KST_20260722);
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();

    // No custom clock injected → the default system clock adapter is selected.
    const result = createKmaHourlyFallbackCompositionFromEnv(
      makeEnv(FAKE_KMA_SERVICE_KEY),
      { fetchImpl },
    );

    expect(result.ok).toBe(true);
    // The default system clock must not read the time until the service actually runs.
    expect(dateNowSpy).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    dateNowSpy.mockRestore();
  });
});

describe('createKmaHourlyFallbackCompositionFromEnv — primary non-empty success (no fallback)', () => {
  it('stops after one attempt when the primary 0500 issuance returns a complete slot', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch((index) =>
      index === 0
        ? jsonOk(successBody(completeShortSlotItems({ baseTime: '0500' })))
        : new Response('unexpected second fetch', { status: 500 }),
    );
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), {
      fetchImpl,
      clock,
    });

    // Construction touched neither the clock nor the network.
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);

    const result = await service.fetchHourlyForecastWithFallback({
      product: SHORT,
      nx: 60,
      ny: 127,
    });

    // Exactly one clock read and one fetch; the previous request is never sent.
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);

    expect(result.fallbackAttempted).toBe(false);
    expectExactKeys(result, ['fallbackAttempted', 'primary']);
    if (result.fallbackAttempted) {
      throw new Error('expected no fallback');
    }
    expect(result.primary.ok).toBe(true);
    if (!result.primary.ok) {
      throw new Error(`expected primary success, got ${JSON.stringify(result)}`);
    }
    expect(result.primary.hourly).toHaveLength(1);
    const forecast = result.primary.hourly[0];
    expect(forecast).toEqual(EXPECTED_SHORT_FORECAST_AT_0600);
    expect(hourlyForecast.safeParse(forecast).success).toBe(true);

    // The primary URL is dated to the availability-aware 0500 issuance and the caller's grid.
    const url = fetchCalls[0].url as URL;
    expect(url.pathname.endsWith('/getVilageFcst')).toBe(true);
    expect(url.searchParams.get('base_date')).toBe('20260722');
    expect(url.searchParams.get('base_time')).toBe('0500');
    expect(url.searchParams.get('nx')).toBe('60');
    expect(url.searchParams.get('ny')).toBe('127');
    // The service key round-trips through the transport URL (percent-decoded back to the fake key)…
    expect(url.searchParams.get('ServiceKey')).toBe(FAKE_KMA_SERVICE_KEY);
    // …but never leaks onto the result surface.
    expectNoLeakage(result);
  });
});

describe('createKmaHourlyFallbackCompositionFromEnv — EMPTY_HOURLY fallback end-to-end', () => {
  it('runs the previous 0200 issuance when the primary 0500 issuance is an empty success', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch((index) =>
      index === 0
        ? jsonOk(emptySuccessBody())
        : jsonOk(successBody(completeShortSlotItems({ baseTime: '0200', fcstTime: '0300' }))),
    );
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), {
      fetchImpl,
      clock,
    });

    const result = await service.fetchHourlyForecastWithFallback({
      product: SHORT,
      nx: 60,
      ny: 127,
    });

    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(2);

    expect(result.fallbackAttempted).toBe(true);
    if (!result.fallbackAttempted) {
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
    expect(primaryUrl.pathname.endsWith('/getVilageFcst')).toBe(true);
    expect(previousUrl.pathname.endsWith('/getVilageFcst')).toBe(true);
    expect(primaryUrl.searchParams.get('base_date')).toBe('20260722');
    expect(primaryUrl.searchParams.get('base_time')).toBe('0500');
    expect(previousUrl.searchParams.get('base_date')).toBe('20260722');
    expect(previousUrl.searchParams.get('base_time')).toBe('0200');
    expect(previousUrl.searchParams.get('nx')).toBe('60');
    expect(previousUrl.searchParams.get('ny')).toBe('127');

    expectNoLeakage(result);
  });
});

describe('createKmaHourlyFallbackCompositionFromEnv — KMA_NO_DATA fallback end-to-end', () => {
  it('runs the previous 0200 issuance when the primary 0500 issuance is upstream resultCode 03', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch((index) =>
      index === 0
        ? jsonOk(upstreamErrorBody('03'))
        : jsonOk(successBody(completeShortSlotItems({ baseTime: '0200', fcstTime: '0300' }))),
    );
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), {
      fetchImpl,
      clock,
    });

    const result = await service.fetchHourlyForecastWithFallback({
      product: SHORT,
      nx: 60,
      ny: 127,
    });

    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(2);

    expect(result.fallbackAttempted).toBe(true);
    if (!result.fallbackAttempted) {
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

    // The raw upstream resultMsg was dropped at the provider boundary; only the code '03' survives.
    expectNoLeakage(result);
  });
});

describe('createKmaHourlyFallbackCompositionFromEnv — representative ineligible primary (no fallback)', () => {
  it('surfaces an HTTP 503 primary as PROVIDER/HTTP_ERROR with no previous attempt', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(
      () => new Response('secret upstream error page', { status: 503 }),
    );
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), {
      fetchImpl,
      clock,
    });

    const result = await service.fetchHourlyForecastWithFallback({
      product: SHORT,
      nx: 60,
      ny: 127,
    });

    expect(result).toEqual({
      fallbackAttempted: false,
      primary: {
        ok: false,
        stage: 'PROVIDER',
        error: { kind: 'HTTP_ERROR', status: 503 },
      },
    });
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);
    expectNoLeakage(result);
  });

  it('surfaces a rejecting fetch as PROVIDER/NETWORK_ERROR without leaking the exception', async () => {
    const sentinel = new Error(SECRET_SHAPED_CLOCK_VALUE_MUST_NOT_LEAK_PR20);
    const { fetchImpl, calls: fetchCalls } = rejectingFetch(sentinel);
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), {
      fetchImpl,
      clock,
    });

    const result = await service.fetchHourlyForecastWithFallback({
      product: SHORT,
      nx: 60,
      ny: 127,
    });

    expect(result).toEqual({
      fallbackAttempted: false,
      primary: {
        ok: false,
        stage: 'PROVIDER',
        error: { kind: 'NETWORK_ERROR' },
      },
    });
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);
    // The raw exception message never reaches the provider error surface.
    expect(JSON.stringify(result)).not.toContain(
      SECRET_SHAPED_CLOCK_VALUE_MUST_NOT_LEAK_PR20,
    );
  });

  it('surfaces a correlated success page missing temperature as a NORMALIZATION failure, no previous', async () => {
    // A complete, correlated provider success whose 0500 slot lacks TMP → the normalizer fails.
    const items = completeShortSlotItems({ baseTime: '0500' }).filter(
      (raw) => raw.category !== 'TMP',
    );
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      jsonOk(successBody(items)),
    );
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), {
      fetchImpl,
      clock,
    });

    const result = await service.fetchHourlyForecastWithFallback({
      product: SHORT,
      nx: 60,
      ny: 127,
    });

    expect(result.fallbackAttempted).toBe(false);
    if (result.fallbackAttempted) {
      throw new Error('expected no fallback');
    }
    expect(result.primary.ok).toBe(false);
    if (result.primary.ok) {
      throw new Error('expected primary failure');
    }
    expect(result.primary.stage).toBe('NORMALIZATION');
    if (result.primary.stage !== 'NORMALIZATION') {
      throw new Error(`expected NORMALIZATION, got ${result.primary.stage}`);
    }
    expect(result.primary.issues).toContainEqual({
      slotKey: 'SHORT_FORECAST|20260722|0500|20260722|0600|60|127',
      field: 'temperatureCelsius',
      reason: 'ABSENT',
    });
    // No partial hourly data on a normalization failure.
    expect('hourly' in result.primary).toBe(false);
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);
    expectNoLeakage(result);
  });
});

describe('createKmaHourlyFallbackCompositionFromEnv — previous result terminates the fallback', () => {
  it('preserves an HTTP 503 previous result and makes no third attempt', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch((index) =>
      index === 0
        ? jsonOk(emptySuccessBody())
        : new Response('x', { status: 503 }),
    );
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), {
      fetchImpl,
      clock,
    });

    const result = await service.fetchHourlyForecastWithFallback({
      product: SHORT,
      nx: 60,
      ny: 127,
    });

    expect(result.fallbackAttempted).toBe(true);
    if (!result.fallbackAttempted) {
      throw new Error('expected a fallback attempt');
    }
    // The primary eligibility reason is preserved regardless of what the previous result is.
    expect(result.fallbackReason).toBe('EMPTY_HOURLY');
    expect(result.previous).toEqual({
      ok: false,
      stage: 'PROVIDER',
      error: { kind: 'HTTP_ERROR', status: 503 },
    });
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(2);
    expectNoLeakage(result);
  });

  it('preserves an empty-success previous result without re-classifying it, no third attempt', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      jsonOk(emptySuccessBody()),
    );
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), {
      fetchImpl,
      clock,
    });

    const result = await service.fetchHourlyForecastWithFallback({
      product: SHORT,
      nx: 60,
      ny: 127,
    });

    expect(result.fallbackAttempted).toBe(true);
    if (!result.fallbackAttempted) {
      throw new Error('expected a fallback attempt');
    }
    expect(result.fallbackReason).toBe('EMPTY_HOURLY');
    // The previous no-data result is preserved verbatim — never re-classified into another attempt.
    expect(result.previous).toEqual({ ok: true, hourly: [] });
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(2);
  });

  it('preserves an upstream-03 previous result when the primary was also upstream 03', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      jsonOk(upstreamErrorBody('03')),
    );
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), {
      fetchImpl,
      clock,
    });

    const result = await service.fetchHourlyForecastWithFallback({
      product: SHORT,
      nx: 60,
      ny: 127,
    });

    expect(result.fallbackAttempted).toBe(true);
    if (!result.fallbackAttempted) {
      throw new Error('expected a fallback attempt');
    }
    expect(result.fallbackReason).toBe('KMA_NO_DATA');
    expect(result.previous).toEqual({
      ok: false,
      stage: 'PROVIDER',
      error: { kind: 'KMA_UPSTREAM_ERROR', resultCode: '03' },
    });
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(2);
    expectNoLeakage(result);
  });
});

describe('createKmaHourlyFallbackCompositionFromEnv — SHORT candidate boundary pair', () => {
  it('05:10:00.000 KST selects the base_time pair 0500 → 0200 (threshold exactly met)', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      jsonOk(emptySuccessBody()),
    );
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), {
      fetchImpl,
      clock,
    });

    const result = await service.fetchHourlyForecastWithFallback({
      product: SHORT,
      nx: 60,
      ny: 127,
    });

    expect(result.fallbackAttempted).toBe(true);
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(2);
    const primaryUrl = fetchCalls[0].url as URL;
    const previousUrl = fetchCalls[1].url as URL;
    expect(primaryUrl.pathname.endsWith('/getVilageFcst')).toBe(true);
    expect(primaryUrl.searchParams.get('base_date')).toBe('20260722');
    expect(primaryUrl.searchParams.get('base_time')).toBe('0500');
    expect(previousUrl.searchParams.get('base_date')).toBe('20260722');
    expect(previousUrl.searchParams.get('base_time')).toBe('0200');
  });

  it('05:09:59.999 KST selects the base_time pair 0200 → previous-day 2300 (one ms before)', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      jsonOk(emptySuccessBody()),
    );
    const { clock, nowEpochMilliseconds } = fixedClock(
      CLOCK_AT_050959999_KST_20260722,
    );
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), {
      fetchImpl,
      clock,
    });

    const result = await service.fetchHourlyForecastWithFallback({
      product: SHORT,
      nx: 60,
      ny: 127,
    });

    expect(result.fallbackAttempted).toBe(true);
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(2);
    const primaryUrl = fetchCalls[0].url as URL;
    const previousUrl = fetchCalls[1].url as URL;
    expect(primaryUrl.searchParams.get('base_date')).toBe('20260722');
    expect(primaryUrl.searchParams.get('base_time')).toBe('0200');
    expect(previousUrl.searchParams.get('base_date')).toBe('20260721');
    expect(previousUrl.searchParams.get('base_time')).toBe('2300');
  });
});

describe('createKmaHourlyFallbackCompositionFromEnv — ULTRA candidate boundary pair', () => {
  it('06:45:00.000 KST selects the getUltraSrtFcst base_time pair 0630 → 0530', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      jsonOk(emptySuccessBody()),
    );
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0645_KST_20260722);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), {
      fetchImpl,
      clock,
    });

    const result = await service.fetchHourlyForecastWithFallback({
      product: ULTRA,
      nx: 60,
      ny: 127,
    });

    expect(result.fallbackAttempted).toBe(true);
    if (!result.fallbackAttempted) {
      throw new Error('expected a fallback attempt');
    }
    expect(result.fallbackReason).toBe('EMPTY_HOURLY');
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(2);
    const primaryUrl = fetchCalls[0].url as URL;
    const previousUrl = fetchCalls[1].url as URL;
    expect(primaryUrl.pathname.endsWith('/getUltraSrtFcst')).toBe(true);
    expect(previousUrl.pathname.endsWith('/getUltraSrtFcst')).toBe(true);
    expect(primaryUrl.searchParams.get('base_date')).toBe('20260722');
    expect(primaryUrl.searchParams.get('base_time')).toBe('0630');
    expect(previousUrl.searchParams.get('base_date')).toBe('20260722');
    expect(previousUrl.searchParams.get('base_time')).toBe('0530');
    // Same grid on both requests.
    expect(primaryUrl.searchParams.get('nx')).toBe('60');
    expect(primaryUrl.searchParams.get('ny')).toBe('127');
    expect(previousUrl.searchParams.get('nx')).toBe('60');
    expect(previousUrl.searchParams.get('ny')).toBe('127');
  });
});

describe('createKmaHourlyFallbackCompositionFromEnv — pre-aborted AbortSignal', () => {
  it('honours a pre-aborted signal as a PROVIDER-stage ABORTED with no fetch and no previous', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      jsonOk(successBody(completeShortSlotItems({ baseTime: '0500' }))),
    );
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0510_KST_20260722);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), {
      fetchImpl,
      clock,
    });

    const controller = new AbortController();
    controller.abort();

    const result = await service.fetchHourlyForecastWithFallback(
      { product: SHORT, nx: 60, ny: 127 },
      { signal: controller.signal },
    );

    expect(result).toEqual({
      fallbackAttempted: false,
      primary: { ok: false, stage: 'PROVIDER', error: { kind: 'ABORTED' } },
    });
    // The request plan was still built (one clock read), but the provider short-circuited before fetch.
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('createKmaHourlyFallbackCompositionFromEnv — injected clock errors', () => {
  it('rejects with the exact error a throwing clock throws and never fetches', async () => {
    const sentinel = new Error('KMA_FALLBACK_COMPOSITION_CLOCK_SENTINEL');
    const nowEpochMilliseconds = vi.fn(() => {
      throw sentinel;
    });
    const clock: KmaForecastRequestClock = { nowEpochMilliseconds };
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const consoleSpy = spyOnConsole();
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), {
      fetchImpl,
      clock,
    });

    await expect(
      service.fetchHourlyForecastWithFallback({ product: SHORT, nx: 60, ny: 127 }),
    ).rejects.toBe(sentinel);

    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(0);
    consoleSpy.expectSilent();
    consoleSpy.restore();
  });

  it('lets the selector RangeError propagate for a NaN epoch, with no fetch', async () => {
    const { clock, nowEpochMilliseconds } = fixedClock(Number.NaN);
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), {
      fetchImpl,
      clock,
    });

    await expect(
      service.fetchHourlyForecastWithFallback({ product: SHORT, nx: 60, ny: 127 }),
    ).rejects.toBeInstanceOf(RangeError);

    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(0);
  });

  it('lets the selector RangeError propagate for a secret-shaped invalid epoch, without leaking it', async () => {
    const nowEpochMilliseconds = vi.fn(
      () => SECRET_SHAPED_CLOCK_VALUE_MUST_NOT_LEAK_PR20 as unknown as number,
    );
    const clock: KmaForecastRequestClock = { nowEpochMilliseconds };
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), {
      fetchImpl,
      clock,
    });

    let caught: unknown;
    try {
      await service.fetchHourlyForecastWithFallback({
        product: SHORT,
        nx: 60,
        ny: 127,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RangeError);
    expect(fetchCalls).toHaveLength(0);
    expect((caught as RangeError).message).not.toContain(
      SECRET_SHAPED_CLOCK_VALUE_MUST_NOT_LEAK_PR20,
    );
  });
});

describe('createKmaHourlyFallbackCompositionFromEnv — exact keys, no secret leakage, no logging', () => {
  it('never surfaces the service key across success and both failure results, and logs nothing', async () => {
    const consoleSpy = spyOnConsole();
    const env = makeEnv(SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR20);

    // 1) Config failure with a secret-shaped key never used (empty env) — checked separately below.
    const configFailure = createKmaHourlyFallbackCompositionFromEnv(makeEnv(), {});
    expect(configFailure.ok).toBe(false);
    if (configFailure.ok) {
      throw new Error('expected config failure');
    }
    expectExactKeys(configFailure, ['ok', 'error']);

    // 2) No-fallback execution (primary non-empty success) with the secret-shaped key.
    const nonEmpty = recordingFetch(() =>
      jsonOk(successBody(completeShortSlotItems({ baseTime: '0500' }))),
    );
    const nonEmptyService = composeOrThrow(env, {
      fetchImpl: nonEmpty.fetchImpl,
      clock: fixedClock(CLOCK_AT_0510_KST_20260722).clock,
    });
    const nonEmptyResult = await nonEmptyService.fetchHourlyForecastWithFallback({
      product: SHORT,
      nx: 60,
      ny: 127,
    });
    expect(nonEmptyResult.fallbackAttempted).toBe(false);
    expectExactKeys(nonEmptyResult, ['fallbackAttempted', 'primary']);
    expectNoLeakage(nonEmptyResult);

    // 3) Fallback execution (primary empty → previous complete) with the secret-shaped key.
    const fallback = recordingFetch((index) =>
      index === 0
        ? jsonOk(emptySuccessBody())
        : jsonOk(successBody(completeShortSlotItems({ baseTime: '0200', fcstTime: '0300' }))),
    );
    const fallbackService = composeOrThrow(env, {
      fetchImpl: fallback.fetchImpl,
      clock: fixedClock(CLOCK_AT_0510_KST_20260722).clock,
    });
    const fallbackResult = await fallbackService.fetchHourlyForecastWithFallback({
      product: SHORT,
      nx: 60,
      ny: 127,
    });
    expect(fallbackResult.fallbackAttempted).toBe(true);
    expectExactKeys(fallbackResult, [
      'fallbackAttempted',
      'fallbackReason',
      'primary',
      'previous',
    ]);
    expectNoLeakage(fallbackResult);

    consoleSpy.expectSilent();
    consoleSpy.restore();
  });

  it('logs nothing when a clock rejection propagates through the service', async () => {
    const consoleSpy = spyOnConsole();
    const sentinel = new Error('KMA_FALLBACK_COMPOSITION_CLOCK_REJECTION');
    const nowEpochMilliseconds = vi.fn(() => {
      throw sentinel;
    });
    const clock: KmaForecastRequestClock = { nowEpochMilliseconds };
    const { fetchImpl } = neverCalledFetch();
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), {
      fetchImpl,
      clock,
    });

    await expect(
      service.fetchHourlyForecastWithFallback({ product: SHORT, nx: 60, ny: 127 }),
    ).rejects.toBe(sentinel);

    consoleSpy.expectSilent();
    consoleSpy.restore();
  });
});
