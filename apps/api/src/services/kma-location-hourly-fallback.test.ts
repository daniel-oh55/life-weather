import { afterEach, describe, expect, it, vi } from 'vitest';

import { hourlyForecast, type HourlyForecast } from '@life-weather/contracts';
import {
  KmaForecastProduct,
  convertKmaLatitudeLongitudeToGrid,
  type ConvertKmaLatitudeLongitudeToGridInput,
  type KmaForecastGridCoordinate,
} from '@life-weather/weather-core';

import type {
  KmaHourlyFallbackService,
  KmaHourlyFallbackServiceInput,
  KmaHourlyFallbackServiceOptions,
  KmaHourlyFallbackServiceResult,
} from './kma-hourly-fallback';
import {
  createKmaLocationHourlyFallbackFacade,
  type KmaLocationHourlyFallbackInput,
} from './kma-location-hourly-fallback';

/**
 * These tests exercise the location fallback facade in isolation: the grid converter and the
 * fallback service are both fresh fakes built inside each test (never shared at describe scope), so
 * call counts, argument identity, and Promise identity are directly assertable. The facade must add
 * no new rule beyond the LOCATION result — it wires a fresh converter input, a fresh fallback-service
 * input, passes `options` by reference, and forwards the fallback service's Promise verbatim. Where a
 * test needs the real projection (converter-error cases), it injects the actual PR #12
 * `convertKmaLatitudeLongitudeToGrid`, still with a fake fallback service, so no network runs.
 */

const SHORT = KmaForecastProduct.SHORT_FORECAST;

/** Seoul: a supported KMA location (used only as the caller's raw lat/lon; the fake converter decides the grid). */
const SEOUL_LATITUDE = 37.5665;
const SEOUL_LONGITUDE = 126.978;

/** A grid the fake converter returns for a supported location. */
const SEOUL_GRID: KmaForecastGridCoordinate = { nx: 60, ny: 127 };

/** A secret-shaped coordinate marker used to prove raw coordinates never leak into a result/error. */
const SECRET_SHAPED_LOCATION_MUST_NOT_LEAK_PR21 = 999.000123;

/** A fresh, valid caller input. Each test builds its own so no reference is ever shared across tests. */
function makeInput(): KmaLocationHourlyFallbackInput {
  return { product: SHORT, latitude: SEOUL_LATITUDE, longitude: SEOUL_LONGITUDE };
}

/** A minimal, contracts-valid hourly entry for the success fixtures. */
function makeHourly(): HourlyForecast {
  return {
    forecastAt: '2026-07-22T06:00:00+09:00',
    condition: 'CLEAR',
    temperatureCelsius: 25.5,
    feelsLikeCelsius: null,
    precipitationProbabilityPercent: null,
    precipitationAmountMillimeters: null,
    snowfallAmountCentimeters: null,
    humidityPercent: null,
    windSpeedMetersPerSecond: null,
    windDirectionDegrees: null,
  };
}

/** A fresh no-fallback execution trace (primary non-empty success, previous never run). */
function makeNoFallbackResult(): KmaHourlyFallbackServiceResult {
  return { fallbackAttempted: false, primary: { ok: true, hourly: [makeHourly()] } };
}

/** A fresh fallback execution trace (primary empty success → previous complete success). */
function makeFallbackResult(): KmaHourlyFallbackServiceResult {
  return {
    fallbackAttempted: true,
    fallbackReason: 'EMPTY_HOURLY',
    primary: { ok: true, hourly: [] },
    previous: { ok: true, hourly: [makeHourly()] },
  };
}

interface ConverterCall {
  readonly input: ConvertKmaLatitudeLongitudeToGridInput;
}

interface FallbackCall {
  readonly input: KmaHourlyFallbackServiceInput;
  readonly options: KmaHourlyFallbackServiceOptions | undefined;
}

/**
 * A fresh fake grid converter that records each `input` (by reference) and returns `grid`. Uses
 * `vi.fn` so call count and argument identity are directly assertable.
 */
function fakeConverter(grid: KmaForecastGridCoordinate | null) {
  const calls: ConverterCall[] = [];
  const convert = vi.fn((input: ConvertKmaLatitudeLongitudeToGridInput) => {
    calls.push({ input });
    return grid;
  });
  return { convert, calls };
}

/**
 * A fresh fake fallback service that satisfies the real interface, records each call's
 * `input`/`options` (by reference), and returns the exact `result` Promise it is handed — never a new
 * Promise of its own.
 */
function fakeFallbackService(result: Promise<KmaHourlyFallbackServiceResult>) {
  const calls: FallbackCall[] = [];
  const fetchHourlyForecastWithFallback = vi.fn(
    (
      input: KmaHourlyFallbackServiceInput,
      options?: KmaHourlyFallbackServiceOptions,
    ): Promise<KmaHourlyFallbackServiceResult> => {
      calls.push({ input, options });
      return result;
    },
  );
  const service: KmaHourlyFallbackService = { fetchHourlyForecastWithFallback };
  return { service, fetchHourlyForecastWithFallback, calls };
}

/** A fallback service that must never run — fails the test loudly if it is ever called. */
function neverCalledFallbackService() {
  const fetchHourlyForecastWithFallback = vi.fn(
    (): Promise<KmaHourlyFallbackServiceResult> => {
      throw new Error('test setup: fallback service was called but should not have been');
    },
  );
  const service: KmaHourlyFallbackService = { fetchHourlyForecastWithFallback };
  return { service, fetchHourlyForecastWithFallback };
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

describe('createKmaLocationHourlyFallbackFacade — construction is side-effect-free', () => {
  it('does not call the grid converter on construction alone', () => {
    const { convert } = fakeConverter(SEOUL_GRID);
    const { service } = fakeFallbackService(Promise.resolve(makeNoFallbackResult()));
    createKmaLocationHourlyFallbackFacade(convert, service);
    expect(convert).not.toHaveBeenCalled();
  });

  it('does not call the fallback service on construction alone', () => {
    const { convert } = fakeConverter(SEOUL_GRID);
    const { service, fetchHourlyForecastWithFallback } = fakeFallbackService(
      Promise.resolve(makeNoFallbackResult()),
    );
    createKmaLocationHourlyFallbackFacade(convert, service);
    expect(fetchHourlyForecastWithFallback).not.toHaveBeenCalled();
  });

  it('exposes exactly one public method key and logs nothing', () => {
    const consoleSpy = spyOnConsole();
    const { convert } = fakeConverter(SEOUL_GRID);
    const { service } = fakeFallbackService(Promise.resolve(makeNoFallbackResult()));

    const facade = createKmaLocationHourlyFallbackFacade(convert, service);

    expect(Object.keys(facade)).toEqual(['fetchHourlyForecastWithFallbackForLocation']);
    expect(typeof facade.fetchHourlyForecastWithFallbackForLocation).toBe('function');
    consoleSpy.expectSilent();
    consoleSpy.restore();
  });

  it('does not throw on construction and works with frozen collaborators', () => {
    const grid = { ...SEOUL_GRID };
    const convert = vi.fn(() => grid);
    const resultPromise = Promise.resolve<KmaHourlyFallbackServiceResult>(
      makeNoFallbackResult(),
    );
    const fetchHourlyForecastWithFallback = vi.fn(() => resultPromise);
    const service = Object.freeze<KmaHourlyFallbackService>({
      fetchHourlyForecastWithFallback,
    });

    let facade: unknown;
    expect(() => {
      facade = createKmaLocationHourlyFallbackFacade(convert, service);
    }).not.toThrow();
    expect(convert).not.toHaveBeenCalled();
    expect(fetchHourlyForecastWithFallback).not.toHaveBeenCalled();
    expect(facade).toBeDefined();
  });

  it('builds a distinct facade and method reference on each construction (no shared state)', () => {
    const { convert } = fakeConverter(SEOUL_GRID);
    const { service } = fakeFallbackService(Promise.resolve(makeNoFallbackResult()));

    const first = createKmaLocationHourlyFallbackFacade(convert, service);
    const second = createKmaLocationHourlyFallbackFacade(convert, service);

    expect(first).not.toBe(second);
    expect(first.fetchHourlyForecastWithFallbackForLocation).not.toBe(
      second.fetchHourlyForecastWithFallbackForLocation,
    );
  });
});

describe('createKmaLocationHourlyFallbackFacade — supported location wiring', () => {
  it('converts once, wires a fresh product/nx/ny input, and returns the fallback Promise verbatim (no fallback)', async () => {
    const input = makeInput();
    const result = makeNoFallbackResult();
    const downstreamPromise = Promise.resolve<KmaHourlyFallbackServiceResult>(result);

    const { convert, calls: converterCalls } = fakeConverter(SEOUL_GRID);
    const {
      service,
      fetchHourlyForecastWithFallback,
      calls: fallbackCalls,
    } = fakeFallbackService(downstreamPromise);
    const facade = createKmaLocationHourlyFallbackFacade(convert, service);

    const options: KmaHourlyFallbackServiceOptions = { signal: new AbortController().signal };
    const returned = facade.fetchHourlyForecastWithFallbackForLocation(input, options);

    // Converter ran exactly once.
    expect(convert).toHaveBeenCalledTimes(1);
    expect(converterCalls).toHaveLength(1);
    // Converter input own keys are exactly latitude/longitude — no product / extra property.
    expect(Object.keys(converterCalls[0].input).sort()).toEqual(['latitude', 'longitude']);
    expect('product' in converterCalls[0].input).toBe(false);
    expect(converterCalls[0].input.latitude).toBe(SEOUL_LATITUDE);
    expect(converterCalls[0].input.longitude).toBe(SEOUL_LONGITUDE);
    // Converter input is a distinct object from the caller input.
    expect(converterCalls[0].input).not.toBe(input);

    // Fallback service ran exactly once.
    expect(fetchHourlyForecastWithFallback).toHaveBeenCalledTimes(1);
    expect(fallbackCalls).toHaveLength(1);
    // Fallback input own keys are exactly product/nx/ny — no latitude/longitude.
    expect(Object.keys(fallbackCalls[0].input).sort()).toEqual(['nx', 'ny', 'product']);
    expect('latitude' in fallbackCalls[0].input).toBe(false);
    expect('longitude' in fallbackCalls[0].input).toBe(false);
    // Converter grid values pass through unchanged.
    expect(fallbackCalls[0].input.product).toBe(SHORT);
    expect(fallbackCalls[0].input.nx).toBe(SEOUL_GRID.nx);
    expect(fallbackCalls[0].input.ny).toBe(SEOUL_GRID.ny);
    // Fallback input is a distinct object from both caller input and the converter grid.
    expect(fallbackCalls[0].input).not.toBe(input);
    // Options passed by the same reference; its signal by the same reference.
    expect(fallbackCalls[0].options).toBe(options);
    expect(fallbackCalls[0].options?.signal).toBe(options.signal);

    // The location facade returns the exact Promise the fallback service returned.
    expect(returned).toBe(downstreamPromise);
    const resolved = await returned;
    expect(resolved).toBe(result);
    if (!('fallbackAttempted' in resolved) || resolved.fallbackAttempted) {
      throw new Error('expected a no-fallback trace');
    }
    expect(resolved.primary.ok).toBe(true);
    if (resolved.primary.ok) {
      expect(hourlyForecast.safeParse(resolved.primary.hourly[0]).success).toBe(true);
    }
  });

  it('returns the fallback-attempted execution trace unchanged (fallback branch)', async () => {
    const result = makeFallbackResult();
    const downstreamPromise = Promise.resolve<KmaHourlyFallbackServiceResult>(result);

    const { convert } = fakeConverter(SEOUL_GRID);
    const { service, calls: fallbackCalls } = fakeFallbackService(downstreamPromise);
    const facade = createKmaLocationHourlyFallbackFacade(convert, service);

    const returned = facade.fetchHourlyForecastWithFallbackForLocation(makeInput());

    // Exact downstream Promise and result identity — the location facade changes neither branch.
    expect(returned).toBe(downstreamPromise);
    const resolved = await returned;
    expect(resolved).toBe(result);
    expect(fallbackCalls[0].input.nx).toBe(SEOUL_GRID.nx);
    expect(fallbackCalls[0].input.ny).toBe(SEOUL_GRID.ny);
    if (!('fallbackAttempted' in resolved) || !resolved.fallbackAttempted) {
      throw new Error('expected a fallback trace');
    }
    expect(resolved.fallbackReason).toBe('EMPTY_HOURLY');
    expect(resolved.primary.ok).toBe(true);
    expect(resolved.previous.ok).toBe(true);
  });

  it('passes the converter grid reference values through without mutation or coercion', async () => {
    // A grid whose values are distinctive so a swap/round/clamp would be observable.
    const grid: KmaForecastGridCoordinate = { nx: 3, ny: 251 };
    const { convert } = fakeConverter(grid);
    const { service, calls } = fakeFallbackService(
      Promise.resolve(makeNoFallbackResult()),
    );
    const facade = createKmaLocationHourlyFallbackFacade(convert, service);

    await facade.fetchHourlyForecastWithFallbackForLocation(makeInput());

    expect(calls[0].input.nx).toBe(3);
    expect(calls[0].input.ny).toBe(251);
    // The converter's own grid object was not mutated.
    expect(grid).toEqual({ nx: 3, ny: 251 });
  });
});

describe('createKmaLocationHourlyFallbackFacade — options omitted', () => {
  it('forwards exactly undefined (never a synthesized {}) when options are omitted', async () => {
    const { convert } = fakeConverter(SEOUL_GRID);
    const { service, fetchHourlyForecastWithFallback, calls } = fakeFallbackService(
      Promise.resolve(makeNoFallbackResult()),
    );
    const facade = createKmaLocationHourlyFallbackFacade(convert, service);

    await facade.fetchHourlyForecastWithFallbackForLocation(makeInput());

    expect(convert).toHaveBeenCalledTimes(1);
    expect(fetchHourlyForecastWithFallback).toHaveBeenCalledTimes(1);
    // Exactly two positional arguments; the second is literally undefined.
    expect(fetchHourlyForecastWithFallback.mock.calls[0]).toHaveLength(2);
    expect(fetchHourlyForecastWithFallback.mock.calls[0][1]).toBeUndefined();
    expect(calls[0].options).toBeUndefined();
  });
});

describe('createKmaLocationHourlyFallbackFacade — unsupported location', () => {
  it('returns the exact LOCATION failure and never calls the fallback service', async () => {
    const { convert, calls: converterCalls } = fakeConverter(null);
    const { service, fetchHourlyForecastWithFallback } = neverCalledFallbackService();
    const facade = createKmaLocationHourlyFallbackFacade(convert, service);

    const options: KmaHourlyFallbackServiceOptions = { signal: new AbortController().signal };
    const resolved = await facade.fetchHourlyForecastWithFallbackForLocation(
      makeInput(),
      options,
    );

    expect(resolved).toEqual({
      ok: false,
      stage: 'LOCATION',
      error: { kind: 'UNSUPPORTED_LOCATION' },
    });
    // Converter ran once; fallback service never ran (options never used).
    expect(convert).toHaveBeenCalledTimes(1);
    expect(converterCalls).toHaveLength(1);
    expect(fetchHourlyForecastWithFallback).not.toHaveBeenCalled();
  });

  it('returns a Promise and exact keys, never exposing raw latitude/longitude/grid, and logs nothing', async () => {
    const consoleSpy = spyOnConsole();
    const { convert } = fakeConverter(null);
    const { service } = neverCalledFallbackService();
    const facade = createKmaLocationHourlyFallbackFacade(convert, service);

    const input: KmaLocationHourlyFallbackInput = {
      product: SHORT,
      latitude: SECRET_SHAPED_LOCATION_MUST_NOT_LEAK_PR21,
      longitude: SECRET_SHAPED_LOCATION_MUST_NOT_LEAK_PR21,
    };
    const returned = facade.fetchHourlyForecastWithFallbackForLocation(input);
    expect(returned).toBeInstanceOf(Promise);
    const resolved = await returned;

    // Exactly ok/stage/error, and the error carries only its kind.
    if (!('stage' in resolved) || resolved.stage !== 'LOCATION') {
      throw new Error('expected a LOCATION failure');
    }
    expect(Object.keys(resolved).sort()).toEqual(['error', 'ok', 'stage']);
    expect(Object.keys(resolved.error)).toEqual(['kind']);
    const serialized = JSON.stringify(resolved);
    expect(serialized).not.toContain(String(SECRET_SHAPED_LOCATION_MUST_NOT_LEAK_PR21));
    for (const forbidden of ['latitude', 'longitude', 'nx', 'ny', 'product', 'signal']) {
      expect(serialized).not.toContain(forbidden);
    }
    consoleSpy.expectSilent();
    consoleSpy.restore();
  });

  it('builds a fresh Promise, result, and error object on every unsupported call', async () => {
    const { convert } = fakeConverter(null);
    const { service } = neverCalledFallbackService();
    const facade = createKmaLocationHourlyFallbackFacade(convert, service);

    const firstPromise = facade.fetchHourlyForecastWithFallbackForLocation(makeInput());
    const secondPromise = facade.fetchHourlyForecastWithFallbackForLocation(makeInput());

    expect(firstPromise).not.toBe(secondPromise);

    const first = await firstPromise;
    const second = await secondPromise;

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    if (
      'fallbackAttempted' in first ||
      'fallbackAttempted' in second ||
      !('stage' in first) ||
      !('stage' in second)
    ) {
      throw new Error('expected two LOCATION failures');
    }
    // Fresh error object per call (no module-level shared failure singleton).
    expect(first.error).not.toBe(second.error);
    expect(convert).toHaveBeenCalledTimes(2);
  });
});

describe('createKmaLocationHourlyFallbackFacade — converter throw propagation', () => {
  it('propagates an injected converter sentinel Error synchronously and never calls the fallback service', () => {
    const sentinel = new Error('GRID_CONVERTER_SENTINEL_FOR_IDENTITY');
    const convert = vi.fn((): KmaForecastGridCoordinate | null => {
      throw sentinel;
    });
    const { service, fetchHourlyForecastWithFallback } = neverCalledFallbackService();
    const facade = createKmaLocationHourlyFallbackFacade(convert, service);

    let caught: unknown;
    let returned: unknown;
    try {
      returned = facade.fetchHourlyForecastWithFallbackForLocation(makeInput());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(sentinel);
    // A throw is never converted to a Promise.
    expect(returned).toBeUndefined();
    expect(convert).toHaveBeenCalledTimes(1);
    expect(fetchHourlyForecastWithFallback).not.toHaveBeenCalled();
  });

  it('propagates an injected converter sentinel RangeError synchronously', () => {
    const sentinel = new RangeError('latitude must be within [-90, 90]');
    const convert = vi.fn((): KmaForecastGridCoordinate | null => {
      throw sentinel;
    });
    const { service, fetchHourlyForecastWithFallback } = neverCalledFallbackService();
    const facade = createKmaLocationHourlyFallbackFacade(convert, service);

    let caught: unknown;
    try {
      facade.fetchHourlyForecastWithFallbackForLocation(makeInput());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(sentinel);
    expect(fetchHourlyForecastWithFallback).not.toHaveBeenCalled();
  });

  it('lets the real PR #12 converter throw RangeError synchronously for a NaN latitude, no fallback call', () => {
    const { service, fetchHourlyForecastWithFallback } = neverCalledFallbackService();
    const facade = createKmaLocationHourlyFallbackFacade(
      convertKmaLatitudeLongitudeToGrid,
      service,
    );

    let caught: unknown;
    let returned: unknown;
    try {
      returned = facade.fetchHourlyForecastWithFallbackForLocation({
        product: SHORT,
        latitude: Number.NaN,
        longitude: SEOUL_LONGITUDE,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RangeError);
    expect(returned).toBeUndefined();
    expect(fetchHourlyForecastWithFallback).not.toHaveBeenCalled();
  });

  it('lets the real PR #12 converter throw RangeError synchronously for an Infinity longitude', () => {
    const { service, fetchHourlyForecastWithFallback } = neverCalledFallbackService();
    const facade = createKmaLocationHourlyFallbackFacade(
      convertKmaLatitudeLongitudeToGrid,
      service,
    );

    let caught: unknown;
    try {
      facade.fetchHourlyForecastWithFallbackForLocation({
        product: SHORT,
        latitude: SEOUL_LATITUDE,
        longitude: Number.POSITIVE_INFINITY,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RangeError);
    expect(fetchHourlyForecastWithFallback).not.toHaveBeenCalled();
  });

  it('lets the real PR #12 converter throw RangeError synchronously for a physical-range latitude, without leaking the raw value', () => {
    const { service, fetchHourlyForecastWithFallback } = neverCalledFallbackService();
    const facade = createKmaLocationHourlyFallbackFacade(
      convertKmaLatitudeLongitudeToGrid,
      service,
    );

    let caught: unknown;
    try {
      facade.fetchHourlyForecastWithFallbackForLocation({
        product: SHORT,
        latitude: SECRET_SHAPED_LOCATION_MUST_NOT_LEAK_PR21,
        longitude: SEOUL_LONGITUDE,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RangeError);
    expect((caught as RangeError).message).not.toContain(
      String(SECRET_SHAPED_LOCATION_MUST_NOT_LEAK_PR21),
    );
    expect(fetchHourlyForecastWithFallback).not.toHaveBeenCalled();
  });

  it('lets the real PR #12 converter throw RangeError synchronously for an out-of-range longitude', () => {
    const { service, fetchHourlyForecastWithFallback } = neverCalledFallbackService();
    const facade = createKmaLocationHourlyFallbackFacade(
      convertKmaLatitudeLongitudeToGrid,
      service,
    );

    let caught: unknown;
    try {
      facade.fetchHourlyForecastWithFallbackForLocation({
        product: SHORT,
        latitude: SEOUL_LATITUDE,
        longitude: 181,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RangeError);
    expect(fetchHourlyForecastWithFallback).not.toHaveBeenCalled();
  });
});

describe('createKmaLocationHourlyFallbackFacade — fallback service throw / rejection', () => {
  it('propagates a fallback service synchronous throw as the same error reference', () => {
    const sentinel = new Error('FALLBACK_SERVICE_SYNC_SENTINEL_FOR_IDENTITY');
    const { convert } = fakeConverter(SEOUL_GRID);
    // The interface expects a Promise return; cast to exercise a runtime collaborator violation.
    const fetchHourlyForecastWithFallback = vi.fn(
      (): Promise<KmaHourlyFallbackServiceResult> => {
        throw sentinel;
      },
    );
    const service = {
      fetchHourlyForecastWithFallback,
    } as unknown as KmaHourlyFallbackService;
    const facade = createKmaLocationHourlyFallbackFacade(convert, service);

    let caught: unknown;
    try {
      facade.fetchHourlyForecastWithFallbackForLocation(makeInput());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(sentinel);
    expect(convert).toHaveBeenCalledTimes(1);
    expect(fetchHourlyForecastWithFallback).toHaveBeenCalledTimes(1);
  });

  it('returns the same rejected Promise reference without intercepting the rejection', async () => {
    const sentinel = new Error('FALLBACK_SERVICE_REJECTION_SENTINEL_FOR_IDENTITY');
    const rejected = Promise.reject<KmaHourlyFallbackServiceResult>(sentinel);
    // Attach an assertion immediately so the rejection is always handled (no unhandled rejection).
    const assertion = expect(rejected).rejects.toBe(sentinel);

    const { convert } = fakeConverter(SEOUL_GRID);
    const { service } = fakeFallbackService(rejected);
    const facade = createKmaLocationHourlyFallbackFacade(convert, service);

    const returned = facade.fetchHourlyForecastWithFallbackForLocation(makeInput());
    expect(returned).toBe(rejected);
    await expect(returned).rejects.toBe(sentinel);
    await assertion;
  });

  it('forwards a pre-aborted options/signal by reference and never inspects the signal itself', async () => {
    const { convert } = fakeConverter(SEOUL_GRID);
    const { service, calls } = fakeFallbackService(
      Promise.resolve(makeNoFallbackResult()),
    );
    const facade = createKmaLocationHourlyFallbackFacade(convert, service);

    const controller = new AbortController();
    controller.abort();
    const signal = controller.signal;
    const options: KmaHourlyFallbackServiceOptions = { signal };

    await facade.fetchHourlyForecastWithFallbackForLocation(makeInput(), options);

    // The same options and signal reference reach the fallback service; the facade added no check.
    expect(calls[0].options).toBe(options);
    expect(calls[0].options?.signal).toBe(signal);
  });
});

describe('createKmaLocationHourlyFallbackFacade — immutability and repeated calls', () => {
  it('accepts frozen input and options, mutates neither, and forwards fresh derived objects', async () => {
    const grid = { ...SEOUL_GRID };
    const { convert, calls: converterCalls } = fakeConverter(grid);
    const { service, calls: fallbackCalls } = fakeFallbackService(
      Promise.resolve(makeNoFallbackResult()),
    );
    const facade = createKmaLocationHourlyFallbackFacade(convert, service);

    const signal = new AbortController().signal;
    const input = Object.freeze<KmaLocationHourlyFallbackInput>({
      product: SHORT,
      latitude: SEOUL_LATITUDE,
      longitude: SEOUL_LONGITUDE,
    });
    const options = Object.freeze<KmaHourlyFallbackServiceOptions>({ signal });
    const inputSnapshot = JSON.stringify(input);

    await facade.fetchHourlyForecastWithFallbackForLocation(input, options);

    // Derived objects are fresh (distinct from the frozen input).
    expect(converterCalls[0].input).not.toBe(input);
    expect(fallbackCalls[0].input).not.toBe(input);
    // Options is forwarded by reference.
    expect(fallbackCalls[0].options).toBe(options);
    expect(fallbackCalls[0].options?.signal).toBe(signal);
    // The caller's input was not mutated and carries no extra property.
    expect(JSON.stringify(input)).toBe(inputSnapshot);
    expect(input.product).toBe(SHORT);
    expect(input.latitude).toBe(SEOUL_LATITUDE);
    expect(input.longitude).toBe(SEOUL_LONGITUDE);
    // The converter's grid object was not mutated.
    expect(grid).toEqual(SEOUL_GRID);
  });

  it('re-invokes both collaborators on each call, mixing supported then unsupported without shared state', async () => {
    const gridQueue: (KmaForecastGridCoordinate | null)[] = [SEOUL_GRID, null];
    const converterCalls: ConverterCall[] = [];
    const convert = vi.fn((input: ConvertKmaLatitudeLongitudeToGridInput) => {
      converterCalls.push({ input });
      if (gridQueue.length === 0) {
        throw new Error('test setup: converter called more than twice');
      }
      return gridQueue.shift() as KmaForecastGridCoordinate | null;
    });
    const supportedResult = makeNoFallbackResult();
    const { service, fetchHourlyForecastWithFallback, calls: fallbackCalls } =
      fakeFallbackService(Promise.resolve(supportedResult));
    const facade = createKmaLocationHourlyFallbackFacade(convert, service);

    const first = await facade.fetchHourlyForecastWithFallbackForLocation(makeInput());
    const second = await facade.fetchHourlyForecastWithFallbackForLocation(makeInput());

    // Converter ran twice; fallback service only ran for the supported call.
    expect(convert).toHaveBeenCalledTimes(2);
    expect(fetchHourlyForecastWithFallback).toHaveBeenCalledTimes(1);
    expect(fallbackCalls).toHaveLength(1);

    expect(first).toBe(supportedResult);
    if ('fallbackAttempted' in second || !('stage' in second) || second.stage !== 'LOCATION') {
      throw new Error('expected the second call to be an unsupported LOCATION failure');
    }
    expect(second.error.kind).toBe('UNSUPPORTED_LOCATION');
    // Fresh converter input object per call.
    expect(converterCalls[0].input).not.toBe(converterCalls[1].input);
  });
});
