import { afterEach, describe, expect, it, vi } from 'vitest';

import { weatherLocation, type WeatherLocation } from '@life-weather/contracts';
import { KmaForecastProduct } from '@life-weather/weather-core';

import type { KmaForecastRequestClock } from '../services/index.js';
import {
  createKmaAirKoreaWeatherOverviewCompositionFromEnv,
  type KmaAirKoreaWeatherOverviewCompositionDependencies,
} from './kma-airkorea-weather-overview.js';

/**
 * These tests assemble the **real** combined production graph — the PR #78 KMA combined
 * current+hourly composition and the AirKorea location current air-quality composition (this PR),
 * wired through the cross-provider service. Nothing is mocked except the network (an injected
 * in-memory `fetchImpl`) and the clock (an injected fake clock). No real service key and no external
 * network.
 */

const SHORT = KmaForecastProduct.SHORT_FORECAST;

const FAKE_KMA_SERVICE_KEY = 'test-only-combined-kma-decoded-key+slash==';
const FAKE_AIRKOREA_SERVICE_KEY = 'test-only-combined-airkorea-decoded-key+slash==';

function makeEnv(kmaKey?: string, airKoreaKey?: string): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  if (kmaKey !== undefined) env.KMA_SERVICE_KEY = kmaKey;
  if (airKoreaKey !== undefined) env.AIRKOREA_SERVICE_KEY = airKoreaKey;
  return env as NodeJS.ProcessEnv;
}

function makeLocation(overrides: Partial<WeatherLocation> = {}): WeatherLocation {
  return {
    id: 'loc_seoul_hyehwa',
    displayName: '서울특별시 종로구 혜화동',
    countryCode: 'KR',
    adminArea1: '서울특별시',
    adminArea2: '종로구',
    adminArea3: '혜화동',
    latitude: 37.5861,
    longitude: 127.0022,
    timezone: 'Asia/Seoul',
    ...overrides,
  };
}

function expectExactKeys(value: object, keys: readonly string[]): void {
  expect(Object.keys(value).sort()).toEqual([...keys].sort());
}

function scriptedClock(values: readonly number[]) {
  const nowEpochMilliseconds = vi.fn((): number => {
    const callIndex = nowEpochMilliseconds.mock.calls.length - 1;
    return values[Math.min(callIndex, values.length - 1)];
  });
  const clock: KmaForecastRequestClock = { nowEpochMilliseconds };
  return { clock, nowEpochMilliseconds };
}

interface FetchRecord {
  readonly url: unknown;
}

function neverCalledFetch() {
  const calls: FetchRecord[] = [];
  const fetchImpl = ((url: unknown) => {
    calls.push({ url });
    throw new Error('test setup: fetch was called but should not have been');
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function jsonOk(bodyString: string): Response {
  return new Response(bodyString, { status: 200 });
}

// ---------------------------------------------------------------------------
// KMA raw fixtures.
// ---------------------------------------------------------------------------

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

function completeShortSlotItems(baseTime: string) {
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

function currentItem(overrides: Record<string, unknown> = {}) {
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

function fullCurrentSlotItems() {
  return [
    currentItem({ category: 'T1H', obsrValue: '23.5' }),
    currentItem({ category: 'PTY', obsrValue: '0' }),
    currentItem({ category: 'REH', obsrValue: '55' }),
    currentItem({ category: 'WSD', obsrValue: '3.4' }),
    currentItem({ category: 'VEC', obsrValue: '270' }),
    currentItem({ category: 'RN1', obsrValue: '0' }),
  ];
}

function kmaSuccessBody(items: readonly Record<string, unknown>[], options: { totalCount?: number } = {}): string {
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

function kmaEmptySuccessBody(): string {
  return kmaSuccessBody([], { totalCount: 0 });
}

// ---------------------------------------------------------------------------
// AirKorea raw fixtures.
// ---------------------------------------------------------------------------

function tmCoordinateSuccessBody(items: readonly Record<string, unknown>[]): string {
  return JSON.stringify({
    response: {
      header: { resultCode: '00', resultMsg: 'NORMAL_CODE' },
      body: { numOfRows: 100, pageNo: 1, totalCount: items.length, items },
    },
  });
}

function tmCoordinateItem(overrides: Record<string, unknown> = {}) {
  return {
    sidoName: '서울특별시',
    sggName: '종로구',
    umdName: '혜화동',
    tmX: '200089.126044',
    tmY: '453946.42329',
    ...overrides,
  };
}

function nearbyStationSuccessBody(items: readonly Record<string, unknown>[]): string {
  return JSON.stringify({
    response: {
      header: { resultCode: '00', resultMsg: 'NORMAL_CODE' },
      body: { numOfRows: 10, pageNo: 1, totalCount: items.length, items },
    },
  });
}

function nearbyStationItem(overrides: Record<string, unknown> = {}) {
  return { tm: 1.2, stationName: '종로구', addr: '서울특별시 종로구', ...overrides };
}

function currentAirQualitySuccessBody(items: readonly Record<string, unknown>[]): string {
  return JSON.stringify({
    response: {
      header: { resultCode: '00', resultMsg: 'NORMAL_SERVICE' },
      body: { numOfRows: 100, pageNo: 1, totalCount: items.length, items },
    },
  });
}

function currentAirQualityItem(overrides: Record<string, unknown> = {}) {
  return {
    dataTime: '2026-08-11 14:00',
    stationName: '종로구',
    pm10Value: '73',
    pm25Value: '44',
    o3Value: '0.043',
    khaiValue: '75',
    khaiGrade: '2',
    pm10Grade: '2',
    pm25Grade: '3',
    o3Grade: '1',
    ...overrides,
  };
}

/**
 * Dispatch across all five upstream endpoints (KMA `getVilageFcst`/`getUltraSrtNcst`, AirKorea
 * `getTMStdrCrdnt`/`getNearbyMsrstnList`/`getMsrstnAcctoRltmMesureDnsty`) by URL path, recording every
 * call in invocation order with a per-endpoint call index.
 */
function dispatchFetch(handlers: {
  readonly vilageFcst: (callIndex: number) => Response;
  readonly ultraSrtNcst: (callIndex: number) => Response;
  readonly tmCoordinate: () => Response;
  readonly nearbyStation: () => Response;
  readonly currentAirQuality: () => Response;
}) {
  const calls: FetchRecord[] = [];
  let vilageFcstCallCount = 0;
  let ultraSrtNcstCallCount = 0;
  const fetchImpl = ((url: unknown) => {
    const requestUrl = url as URL;
    calls.push({ url: requestUrl });
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
    if (requestUrl.pathname.endsWith('/getTMStdrCrdnt')) {
      return Promise.resolve(handlers.tmCoordinate());
    }
    if (requestUrl.pathname.endsWith('/getNearbyMsrstnList')) {
      return Promise.resolve(handlers.nearbyStation());
    }
    if (requestUrl.pathname.endsWith('/getMsrstnAcctoRltmMesureDnsty')) {
      return Promise.resolve(handlers.currentAirQuality());
    }
    throw new Error(`test setup: unexpected fetch path ${requestUrl.pathname}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** `2026-07-22T05:10:00.000+09:00` — yields primary hourly issuance `20260722/0500`. */
const CLOCK_AT_0510_KST_20260722 = Date.UTC(2026, 6, 21, 20, 10, 0, 0);
const HOURLY_FETCHED_AT_EPOCH_MS = Date.UTC(2026, 6, 21, 20, 11, 0, 0);
const CURRENT_REQUEST_EPOCH_MS = Date.UTC(2026, 6, 21, 20, 12, 10, 0);
const CURRENT_FETCHED_AT_EPOCH_MS = Date.UTC(2026, 6, 21, 20, 13, 0, 0);
const AIRKOREA_FETCHED_AT_EPOCH_MS = Date.UTC(2026, 6, 21, 20, 14, 0, 0);

function composeOrThrow(
  env: NodeJS.ProcessEnv,
  dependencies: KmaAirKoreaWeatherOverviewCompositionDependencies,
) {
  const result = createKmaAirKoreaWeatherOverviewCompositionFromEnv(env, dependencies);
  if (!result.ok) {
    throw new Error(`test setup: expected composition to succeed, got ${JSON.stringify(result)}`);
  }
  return result.service;
}

const FORBIDDEN_LEAKAGE_STRINGS = [FAKE_KMA_SERVICE_KEY, FAKE_AIRKOREA_SERVICE_KEY, 'apis.data.go.kr'];

function expectNoLeakage(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const forbidden of FORBIDDEN_LEAKAGE_STRINGS) {
    expect(serialized).not.toContain(forbidden);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fixture sanity', () => {
  it('builds a contracts-valid WeatherLocation fixture', () => {
    expect(weatherLocation.safeParse(makeLocation()).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Config failure ordering.
// ---------------------------------------------------------------------------

describe('createKmaAirKoreaWeatherOverviewCompositionFromEnv — config failure ordering', () => {
  it('reports stage KMA when only the KMA key is missing, with no fetch', () => {
    const { fetchImpl, calls } = neverCalledFetch();

    const result = createKmaAirKoreaWeatherOverviewCompositionFromEnv(
      makeEnv(undefined, FAKE_AIRKOREA_SERVICE_KEY),
      { fetchImpl },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a config failure');
    expect(result.stage).toBe('KMA');
    expect(calls).toHaveLength(0);
    expectNoLeakage(result);
  });

  it('reports stage AIRKOREA when only the AirKorea key is missing (KMA succeeded), with no fetch at composition time', () => {
    const { fetchImpl, calls } = neverCalledFetch();

    const result = createKmaAirKoreaWeatherOverviewCompositionFromEnv(
      makeEnv(FAKE_KMA_SERVICE_KEY, undefined),
      { fetchImpl },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a config failure');
    expect(result.stage).toBe('AIRKOREA');
    expect(calls).toHaveLength(0);
    expectNoLeakage(result);
  });

  it('never returns a partial success graph when only one key is valid', () => {
    const kmaOnly = createKmaAirKoreaWeatherOverviewCompositionFromEnv(
      makeEnv(FAKE_KMA_SERVICE_KEY, undefined),
      { fetchImpl: neverCalledFetch().fetchImpl },
    );
    const airKoreaOnly = createKmaAirKoreaWeatherOverviewCompositionFromEnv(
      makeEnv(undefined, FAKE_AIRKOREA_SERVICE_KEY),
      { fetchImpl: neverCalledFetch().fetchImpl },
    );

    expect(kmaOnly.ok).toBe(false);
    expect(airKoreaOnly.ok).toBe(false);
    expect('service' in kmaOnly).toBe(false);
    expect('service' in airKoreaOnly).toBe(false);
  });

  it('reports stage KMA when both keys are missing (KMA is checked first, deterministically)', () => {
    const result = createKmaAirKoreaWeatherOverviewCompositionFromEnv(makeEnv(), {
      fetchImpl: neverCalledFetch().fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a config failure');
    expect(result.stage).toBe('KMA');
  });
});

// ---------------------------------------------------------------------------
// Success construction is lazy.
// ---------------------------------------------------------------------------

describe('createKmaAirKoreaWeatherOverviewCompositionFromEnv — success construction is lazy', () => {
  it('exposes only { ok, service } and reads no clock/network at construction', () => {
    const { fetchImpl, calls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = scriptedClock([CLOCK_AT_0510_KST_20260722]);

    const result = createKmaAirKoreaWeatherOverviewCompositionFromEnv(
      makeEnv(FAKE_KMA_SERVICE_KEY, FAKE_AIRKOREA_SERVICE_KEY),
      { fetchImpl, clock },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expectExactKeys(result, ['ok', 'service']);
    expect(typeof result.service.fetchCurrentHourlyWeatherOverviewForLocation).toBe('function');
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Full success pipeline — up to the documented 6-call provider ceiling.
// ---------------------------------------------------------------------------

describe('createKmaAirKoreaWeatherOverviewCompositionFromEnv — full success pipeline', () => {
  it('overlays AirKorea current air quality onto the KMA hourly+current overview', async () => {
    const { fetchImpl, calls } = dispatchFetch({
      vilageFcst: () => jsonOk(kmaSuccessBody(completeShortSlotItems('0500'))),
      ultraSrtNcst: () => jsonOk(kmaSuccessBody(fullCurrentSlotItems())),
      tmCoordinate: () => jsonOk(tmCoordinateSuccessBody([tmCoordinateItem()])),
      nearbyStation: () => jsonOk(nearbyStationSuccessBody([nearbyStationItem()])),
      currentAirQuality: () => jsonOk(currentAirQualitySuccessBody([currentAirQualityItem()])),
    });
    const { clock } = scriptedClock([
      CLOCK_AT_0510_KST_20260722,
      HOURLY_FETCHED_AT_EPOCH_MS,
      CURRENT_REQUEST_EPOCH_MS,
      CURRENT_FETCHED_AT_EPOCH_MS,
      AIRKOREA_FETCHED_AT_EPOCH_MS,
    ]);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY, FAKE_AIRKOREA_SERVICE_KEY), {
      fetchImpl,
      clock,
    });

    const result = await service.fetchCurrentHourlyWeatherOverviewForLocation({
      product: SHORT,
      location: makeLocation(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result)}`);

    // One hourly + one current + three AirKorea calls (no hourly fallback needed here).
    expect(calls).toHaveLength(5);

    expect(result.overview.hourly.length).toBeGreaterThan(0);
    expect(result.overview.current).not.toBeNull();
    expect(result.overview.airQuality.current).not.toBeNull();
    expect(result.overview.missingSections).not.toContain('AIR_QUALITY_CURRENT');
    expect(result.overview.missingSections).not.toContain('CURRENT');
    expect(result.overview.missingSections).not.toContain('HOURLY');

    const airKoreaSource = result.overview.sources.find((source) => source.provider === 'AIR_KOREA');
    expect(airKoreaSource).toBeDefined();
    expect(airKoreaSource!.sections).toEqual(['AIR_QUALITY_CURRENT']);
    expect(airKoreaSource!.sourceId).toBe('airkorea-current-air-quality');

    expectNoLeakage(result);
  });

  it('reaches the documented maximum of 6 provider calls when the KMA hourly fallback is exhausted', async () => {
    const { fetchImpl, calls } = dispatchFetch({
      // Both hourly attempts (primary + previous) come back empty → 2 hourly fetches, no selection.
      vilageFcst: () => jsonOk(kmaEmptySuccessBody()),
      ultraSrtNcst: () => jsonOk(kmaSuccessBody(fullCurrentSlotItems())),
      tmCoordinate: () => jsonOk(tmCoordinateSuccessBody([tmCoordinateItem()])),
      nearbyStation: () => jsonOk(nearbyStationSuccessBody([nearbyStationItem()])),
      currentAirQuality: () => jsonOk(currentAirQualitySuccessBody([currentAirQualityItem()])),
    });
    const { clock } = scriptedClock([
      CLOCK_AT_0510_KST_20260722,
      CURRENT_REQUEST_EPOCH_MS,
      CURRENT_FETCHED_AT_EPOCH_MS,
      AIRKOREA_FETCHED_AT_EPOCH_MS,
    ]);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY, FAKE_AIRKOREA_SERVICE_KEY), {
      fetchImpl,
      clock,
    });

    const result = await service.fetchCurrentHourlyWeatherOverviewForLocation({
      product: SHORT,
      location: makeLocation(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result)}`);

    // 2 hourly (primary + previous, both empty) + 1 current + 3 AirKorea = 6, the documented ceiling.
    expect(calls).toHaveLength(6);
    expect(result.overview.hourly).toEqual([]);
    expect(result.overview.missingSections).toContain('HOURLY');
    expect(result.overview.current).not.toBeNull();
    expect(result.overview.airQuality.current).not.toBeNull();
  });

  it('degrades to airQuality missing (never fails the request) when AirKorea cannot resolve a TM candidate', async () => {
    const { fetchImpl, calls } = dispatchFetch({
      vilageFcst: () => jsonOk(kmaSuccessBody(completeShortSlotItems('0500'))),
      ultraSrtNcst: () => jsonOk(kmaSuccessBody(fullCurrentSlotItems())),
      tmCoordinate: () => jsonOk(tmCoordinateSuccessBody([])),
      nearbyStation: () => {
        throw new Error('must not be called — TM lookup returned NO_DATA');
      },
      currentAirQuality: () => {
        throw new Error('must not be called — TM lookup returned NO_DATA');
      },
    });
    const { clock } = scriptedClock([
      CLOCK_AT_0510_KST_20260722,
      HOURLY_FETCHED_AT_EPOCH_MS,
      CURRENT_REQUEST_EPOCH_MS,
      CURRENT_FETCHED_AT_EPOCH_MS,
    ]);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY, FAKE_AIRKOREA_SERVICE_KEY), {
      fetchImpl,
      clock,
    });

    const result = await service.fetchCurrentHourlyWeatherOverviewForLocation({
      product: SHORT,
      location: makeLocation(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result)}`);
    expect(result.overview.airQuality.current).toBeNull();
    expect(result.overview.missingSections).toContain('AIR_QUALITY_CURRENT');
    // Hourly + current + the one AirKorea TM call — nearby-station and current-AQ never called.
    expect(calls).toHaveLength(3);
  });

  it('district-level location (adminArea3 null): KMA succeeds, AirKorea degrades without any AirKorea fetch', async () => {
    const { fetchImpl, calls } = dispatchFetch({
      vilageFcst: () => jsonOk(kmaSuccessBody(completeShortSlotItems('0500'))),
      ultraSrtNcst: () => jsonOk(kmaSuccessBody(fullCurrentSlotItems())),
      tmCoordinate: () => {
        throw new Error('must not be called — adminArea3 is null');
      },
      nearbyStation: () => {
        throw new Error('must not be called — adminArea3 is null');
      },
      currentAirQuality: () => {
        throw new Error('must not be called — adminArea3 is null');
      },
    });
    const { clock } = scriptedClock([
      CLOCK_AT_0510_KST_20260722,
      HOURLY_FETCHED_AT_EPOCH_MS,
      CURRENT_REQUEST_EPOCH_MS,
      CURRENT_FETCHED_AT_EPOCH_MS,
    ]);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY, FAKE_AIRKOREA_SERVICE_KEY), {
      fetchImpl,
      clock,
    });

    const result = await service.fetchCurrentHourlyWeatherOverviewForLocation({
      product: SHORT,
      location: makeLocation({ adminArea3: null }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result)}`);
    expect(result.overview.airQuality.current).toBeNull();
    expect(result.overview.missingSections).toContain('AIR_QUALITY_CURRENT');
    expect(result.overview.current).not.toBeNull();
    // Hourly + current only — AirKorea's own upfront LOCATION check rejects before any fetch.
    expect(calls).toHaveLength(2);
  });
});

describe('createKmaAirKoreaWeatherOverviewCompositionFromEnv — fresh independent graphs', () => {
  it('builds distinct result/service references across calls with no shared cache', () => {
    const env = makeEnv(FAKE_KMA_SERVICE_KEY, FAKE_AIRKOREA_SERVICE_KEY);
    const dependencies: KmaAirKoreaWeatherOverviewCompositionDependencies = {
      fetchImpl: neverCalledFetch().fetchImpl,
    };

    const first = createKmaAirKoreaWeatherOverviewCompositionFromEnv(env, dependencies);
    const second = createKmaAirKoreaWeatherOverviewCompositionFromEnv(env, dependencies);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('expected both compositions to succeed');
    expect(first).not.toBe(second);
    expect(first.service).not.toBe(second.service);
  });
});
