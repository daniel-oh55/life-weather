import { afterEach, describe, expect, it, vi } from 'vitest';

import { weatherLocation, type WeatherLocation } from '@life-weather/contracts';

import {
  createAirKoreaLocationCurrentAirQualityCompositionFromEnv,
  type AirKoreaLocationCurrentAirQualityCompositionDependencies,
} from './airkorea-location-current-air-quality.js';

/**
 * These tests assemble the **real** components: the three PR #82/#83/#84 provider-from-env
 * factories, the PR #85 application service, and the live AirKorea source metadata resolver — through
 * the statically-imported composition function. Nothing is mocked except the network (an injected
 * in-memory `fetchImpl`) and the clock (an injected fake clock). No real service key and no external
 * network.
 */

/** An obviously fake, decoded-shaped service key. Never a real/production key. */
const FAKE_AIRKOREA_SERVICE_KEY = 'test-only-airkorea-composition-decoded-key+slash==';

/** A secret-shaped key marker used only to prove the key never leaks into a result or log. */
const SECRET_SHAPED_KEY_MUST_NOT_LEAK = 'SECRET_SHAPED_AIRKOREA_COMPOSITION_KEY_MUST_NOT_LEAK+slash==';

function makeEnv(serviceKey?: string): NodeJS.ProcessEnv {
  return serviceKey === undefined
    ? ({} as NodeJS.ProcessEnv)
    : ({ AIRKOREA_SERVICE_KEY: serviceKey } as NodeJS.ProcessEnv);
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
  return { clock: { nowEpochMilliseconds }, nowEpochMilliseconds };
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

/** Dispatch across the three AirKorea endpoints by URL path, recording every call. */
function dispatchAirKoreaFetch(handlers: {
  readonly tmCoordinate: () => Response;
  readonly nearbyStation: () => Response;
  readonly currentAirQuality: () => Response;
}) {
  const calls: FetchRecord[] = [];
  const fetchImpl = ((url: unknown) => {
    const requestUrl = url as URL;
    calls.push({ url: requestUrl });
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

function jsonOk(bodyString: string): Response {
  return new Response(bodyString, { status: 200 });
}

function tmCoordinateSuccessBody(items: readonly Record<string, unknown>[]): string {
  return JSON.stringify({
    response: {
      header: { resultCode: '00', resultMsg: 'NORMAL_CODE' },
      body: { numOfRows: 100, pageNo: 1, totalCount: items.length, items: { item: items } },
    },
  });
}

function tmCoordinateItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
      body: { numOfRows: 10, pageNo: 1, totalCount: items.length, items: { item: items } },
    },
  });
}

function nearbyStationItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tm: '8.2',
    stationName: '종로구',
    addr: '서울특별시 종로구',
    ...overrides,
  };
}

function currentAirQualitySuccessBody(items: readonly Record<string, unknown>[]): string {
  return JSON.stringify({
    response: {
      header: { resultCode: '00', resultMsg: 'NORMAL_SERVICE' },
      body: { numOfRows: 100, pageNo: 1, totalCount: items.length, items: { item: items } },
    },
  });
}

function currentAirQualityItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

const FORBIDDEN_LEAKAGE_STRINGS = [
  FAKE_AIRKOREA_SERVICE_KEY,
  SECRET_SHAPED_KEY_MUST_NOT_LEAK,
  'apis.data.go.kr',
  'ServiceKey',
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

describe('fixture sanity', () => {
  it('builds a contracts-valid WeatherLocation fixture', () => {
    expect(weatherLocation.safeParse(makeLocation()).success).toBe(true);
  });
});

describe('createAirKoreaLocationCurrentAirQualityCompositionFromEnv — missing/invalid config', () => {
  it('returns MISSING for an empty environment, with no clock read and no fetch', () => {
    const { fetchImpl, calls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = scriptedClock([Date.UTC(2026, 7, 11, 5, 10, 0)]);

    const result = createAirKoreaLocationCurrentAirQualityCompositionFromEnv(makeEnv(), {
      fetchImpl,
      clock,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected a config failure');
    }
    expect(result.error).toEqual({ kind: 'CONFIG_ERROR', field: 'serviceKey', reason: 'MISSING' });
    expectExactKeys(result, ['ok', 'error']);
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('returns INVALID for a whitespace-padded key without leaking the raw key', () => {
    const { fetchImpl, calls } = neverCalledFetch();
    const rawKey = ` ${SECRET_SHAPED_KEY_MUST_NOT_LEAK} `;

    const result = createAirKoreaLocationCurrentAirQualityCompositionFromEnv(makeEnv(rawKey), {
      fetchImpl,
    });

    expect(result).toEqual({
      ok: false,
      error: { kind: 'CONFIG_ERROR', field: 'serviceKey', reason: 'INVALID' },
    });
    expect(calls).toHaveLength(0);
    expectNoLeakage(result);
  });
});

describe('createAirKoreaLocationCurrentAirQualityCompositionFromEnv — success construction is lazy', () => {
  it('exposes only { ok, service, sourceMetadataResolver } and reads no clock/network at construction', () => {
    const { fetchImpl, calls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = scriptedClock([Date.UTC(2026, 7, 11, 5, 10, 0)]);

    const result = createAirKoreaLocationCurrentAirQualityCompositionFromEnv(
      makeEnv(FAKE_AIRKOREA_SERVICE_KEY),
      { fetchImpl, clock },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected success');
    }
    expectExactKeys(result, ['ok', 'service', 'sourceMetadataResolver']);
    expect(typeof result.service.fetchCurrentAirQualityForLocation).toBe('function');
    expect(typeof result.sourceMetadataResolver).toBe('function');
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('builds a fresh default system clock lazily when none is injected (no time read at construction)', () => {
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 7, 11, 5, 10, 0));
    const { fetchImpl } = neverCalledFetch();

    const result = createAirKoreaLocationCurrentAirQualityCompositionFromEnv(
      makeEnv(FAKE_AIRKOREA_SERVICE_KEY),
      { fetchImpl },
    );

    expect(result.ok).toBe(true);
    expect(dateNowSpy).not.toHaveBeenCalled();
    dateNowSpy.mockRestore();
  });
});

describe('createAirKoreaLocationCurrentAirQualityCompositionFromEnv — full success pipeline', () => {
  it('resolves a CurrentAirQuality after exactly three provider calls, and the resolver reads the clock exactly once', async () => {
    const { fetchImpl, calls } = dispatchAirKoreaFetch({
      tmCoordinate: () => jsonOk(tmCoordinateSuccessBody([tmCoordinateItem()])),
      nearbyStation: () =>
        jsonOk(
          nearbyStationSuccessBody([
            nearbyStationItem({ stationName: '먼측정소', tm: '5.0' }),
            nearbyStationItem({ stationName: '종로구', tm: '1.2' }),
          ]),
        ),
      currentAirQuality: () => jsonOk(currentAirQualitySuccessBody([currentAirQualityItem()])),
    });
    const { clock, nowEpochMilliseconds } = scriptedClock([Date.UTC(2026, 7, 11, 5, 10, 0)]);

    const result = createAirKoreaLocationCurrentAirQualityCompositionFromEnv(
      makeEnv(FAKE_AIRKOREA_SERVICE_KEY),
      { fetchImpl, clock },
    );
    if (!result.ok) {
      throw new Error('expected success');
    }

    const outcome = await result.service.fetchCurrentAirQualityForLocation({
      location: makeLocation(),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error(`expected success, got ${JSON.stringify(outcome)}`);
    }
    // Closest station (1.2km) is selected, not the farther one (5.0km) or upstream[0].
    expect(calls).toHaveLength(3);
    expect(outcome.current.pm10MicrogramsPerCubicMeter).toBe(73);
    expect(outcome.current.pm25MicrogramsPerCubicMeter).toBe(44);

    const source = result.sourceMetadataResolver();
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(source.sourceId).toBe('airkorea-current-air-quality');
    expect(source.retrievalMode).toBe('LIVE');

    expectNoLeakage(outcome);
  });

  it('returns the exact provider error reference on an upstream failure, without leaking the key', async () => {
    const { fetchImpl } = dispatchAirKoreaFetch({
      tmCoordinate: () => jsonOk(tmCoordinateSuccessBody([])),
      nearbyStation: () => {
        throw new Error('must not be called — TM lookup failed first');
      },
      currentAirQuality: () => {
        throw new Error('must not be called — TM lookup failed first');
      },
    });

    const result = createAirKoreaLocationCurrentAirQualityCompositionFromEnv(
      makeEnv(FAKE_AIRKOREA_SERVICE_KEY),
      { fetchImpl },
    );
    if (!result.ok) {
      throw new Error('expected success');
    }

    const outcome = await result.service.fetchCurrentAirQualityForLocation({
      location: makeLocation(),
    });

    expect(outcome).toEqual({
      ok: false,
      stage: 'TM_COORDINATE_PROVIDER',
      error: { kind: 'NO_DATA' },
    });
    expectNoLeakage(outcome);
  });
});

describe('createAirKoreaLocationCurrentAirQualityCompositionFromEnv — fresh independent graphs', () => {
  it('builds distinct result/service references across calls with no shared cache', () => {
    const { fetchImpl } = neverCalledFetch();
    const env = makeEnv(FAKE_AIRKOREA_SERVICE_KEY);
    const dependencies: AirKoreaLocationCurrentAirQualityCompositionDependencies = { fetchImpl };

    const first = createAirKoreaLocationCurrentAirQualityCompositionFromEnv(env, dependencies);
    const second = createAirKoreaLocationCurrentAirQualityCompositionFromEnv(env, dependencies);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      throw new Error('expected both compositions to succeed');
    }
    expect(first).not.toBe(second);
    expect(first.service).not.toBe(second.service);
  });
});
