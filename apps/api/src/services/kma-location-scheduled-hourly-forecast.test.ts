import { describe, expect, it, vi } from 'vitest';

import { hourlyForecast, type HourlyForecast } from '@life-weather/contracts';
import {
  KmaForecastProduct,
  type ConvertKmaLatitudeLongitudeToGridInput,
  type KmaForecastGridCoordinate,
} from '@life-weather/weather-core';

import type {
  KmaForecastProviderError,
  KmaHourlyNormalizationIssue,
} from '../providers/kma';
import type {
  KmaScheduledHourlyForecastFacade,
  KmaScheduledHourlyForecastInput,
  KmaScheduledHourlyForecastOptions,
  KmaScheduledHourlyForecastResult,
} from './kma-scheduled-hourly-forecast';
import {
  createKmaLocationScheduledHourlyForecastFacade,
  type KmaLocationScheduledHourlyForecastInput,
} from './kma-location-scheduled-hourly-forecast';

/**
 * These tests exercise the location facade in isolation: the grid converter and the scheduled
 * facade are both fresh fakes built inside each test (never shared at describe scope), so call
 * counts, argument identity, and Promise identity are directly assertable. The facade must add no
 * new rule beyond the LOCATION result — it wires a fresh converter input, a fresh scheduled input,
 * passes `options` by reference, and forwards the scheduled facade's Promise verbatim.
 */

const SHORT = KmaForecastProduct.SHORT_FORECAST;

/** Seoul: a supported KMA location (used only as the caller's raw lat/lon; the fake converter decides the grid). */
const SEOUL_LATITUDE = 37.5665;
const SEOUL_LONGITUDE = 126.978;

/** A grid the fake converter returns for a supported location. */
const SEOUL_GRID: KmaForecastGridCoordinate = { nx: 60, ny: 127 };

/** A secret-shaped coordinate marker used to prove raw coordinates never leak into a result/error. */
const SECRET_SHAPED_LOCATION_MUST_NOT_LEAK_PR13 = 999.000123;

/** A fresh, valid caller input. Each test builds its own so no reference is ever shared across tests. */
function makeInput(): KmaLocationScheduledHourlyForecastInput {
  return { product: SHORT, latitude: SEOUL_LATITUDE, longitude: SEOUL_LONGITUDE };
}

/** A minimal, contracts-valid hourly entry for the success fixture. */
function makeHourly(): HourlyForecast {
  return {
    forecastAt: '2026-07-18T06:00:00+09:00',
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

interface ConverterCall {
  readonly input: ConvertKmaLatitudeLongitudeToGridInput;
}

interface ScheduledCall {
  readonly input: KmaScheduledHourlyForecastInput;
  readonly options: KmaScheduledHourlyForecastOptions | undefined;
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
 * A fresh fake scheduled facade that satisfies the real interface, records each call's
 * `input`/`options` (by reference), and returns the exact `result` Promise it is handed — never a
 * new Promise of its own.
 */
function fakeScheduledFacade(result: Promise<KmaScheduledHourlyForecastResult>) {
  const calls: ScheduledCall[] = [];
  const fetchScheduledHourlyForecast = vi.fn(
    (
      input: KmaScheduledHourlyForecastInput,
      options?: KmaScheduledHourlyForecastOptions,
    ): Promise<KmaScheduledHourlyForecastResult> => {
      calls.push({ input, options });
      return result;
    },
  );
  const facade: KmaScheduledHourlyForecastFacade = { fetchScheduledHourlyForecast };
  return { facade, fetchScheduledHourlyForecast, calls };
}

/** A scheduled facade that must never run — fails the test loudly if it is ever called. */
function neverCalledScheduledFacade() {
  const fetchScheduledHourlyForecast = vi.fn(
    (): Promise<KmaScheduledHourlyForecastResult> => {
      throw new Error('test setup: scheduled facade was called but should not have been');
    },
  );
  const facade: KmaScheduledHourlyForecastFacade = { fetchScheduledHourlyForecast };
  return { facade, fetchScheduledHourlyForecast };
}

describe('createKmaLocationScheduledHourlyForecastFacade — construction is side-effect-free', () => {
  it('does not call the grid converter on construction alone', () => {
    const { convert } = fakeConverter(SEOUL_GRID);
    const { facade: scheduled } = fakeScheduledFacade(
      Promise.resolve({ ok: true, hourly: [makeHourly()] }),
    );
    createKmaLocationScheduledHourlyForecastFacade(convert, scheduled);
    expect(convert).not.toHaveBeenCalled();
  });

  it('does not call the scheduled facade on construction alone', () => {
    const { convert } = fakeConverter(SEOUL_GRID);
    const { facade: scheduled, fetchScheduledHourlyForecast } = fakeScheduledFacade(
      Promise.resolve({ ok: true, hourly: [makeHourly()] }),
    );
    createKmaLocationScheduledHourlyForecastFacade(convert, scheduled);
    expect(fetchScheduledHourlyForecast).not.toHaveBeenCalled();
  });

  it('does not throw on construction and works with frozen collaborators', () => {
    const grid = { ...SEOUL_GRID };
    const convert = vi.fn(() => grid);
    const resultPromise = Promise.resolve<KmaScheduledHourlyForecastResult>({
      ok: true,
      hourly: [makeHourly()],
    });
    const fetchScheduledHourlyForecast = vi.fn(() => resultPromise);
    const scheduled = Object.freeze<KmaScheduledHourlyForecastFacade>({
      fetchScheduledHourlyForecast,
    });

    let facade: unknown;
    expect(() => {
      facade = createKmaLocationScheduledHourlyForecastFacade(convert, scheduled);
    }).not.toThrow();
    expect(convert).not.toHaveBeenCalled();
    expect(fetchScheduledHourlyForecast).not.toHaveBeenCalled();
    expect(facade).toBeDefined();
  });
});

describe('createKmaLocationScheduledHourlyForecastFacade — supported location wiring', () => {
  it('converts once, wires a fresh product/nx/ny input, and returns the scheduled Promise verbatim', async () => {
    const input = makeInput();
    const hourly = [makeHourly()];
    const result: KmaScheduledHourlyForecastResult = { ok: true, hourly };
    const downstreamPromise = Promise.resolve<KmaScheduledHourlyForecastResult>(result);

    const { convert, calls: converterCalls } = fakeConverter(SEOUL_GRID);
    const {
      facade: scheduled,
      fetchScheduledHourlyForecast,
      calls: scheduledCalls,
    } = fakeScheduledFacade(downstreamPromise);
    const facade = createKmaLocationScheduledHourlyForecastFacade(convert, scheduled);

    const options: KmaScheduledHourlyForecastOptions = { signal: new AbortController().signal };
    const returned = facade.fetchScheduledHourlyForecastForLocation(input, options);

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

    // Scheduled facade ran exactly once.
    expect(fetchScheduledHourlyForecast).toHaveBeenCalledTimes(1);
    expect(scheduledCalls).toHaveLength(1);
    // Scheduled input own keys are exactly product/nx/ny — no latitude/longitude.
    expect(Object.keys(scheduledCalls[0].input).sort()).toEqual(['nx', 'ny', 'product']);
    expect('latitude' in scheduledCalls[0].input).toBe(false);
    expect('longitude' in scheduledCalls[0].input).toBe(false);
    // Converter grid values pass through unchanged.
    expect(scheduledCalls[0].input.product).toBe(SHORT);
    expect(scheduledCalls[0].input.nx).toBe(SEOUL_GRID.nx);
    expect(scheduledCalls[0].input.ny).toBe(SEOUL_GRID.ny);
    // Options passed by the same reference.
    expect(scheduledCalls[0].options).toBe(options);

    // The location facade returns the exact Promise the scheduled facade returned.
    expect(returned).toBe(downstreamPromise);
    const resolved = await returned;
    expect(resolved).toBe(result);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.hourly).toBe(hourly);
      expect(hourlyForecast.safeParse(resolved.hourly[0]).success).toBe(true);
    }
  });

  it('forwards exactly undefined (never a synthesized {}) when options are omitted', async () => {
    const { convert } = fakeConverter(SEOUL_GRID);
    const { facade: scheduled, fetchScheduledHourlyForecast, calls } = fakeScheduledFacade(
      Promise.resolve({ ok: true, hourly: [] }),
    );
    const facade = createKmaLocationScheduledHourlyForecastFacade(convert, scheduled);

    await facade.fetchScheduledHourlyForecastForLocation(makeInput());

    expect(convert).toHaveBeenCalledTimes(1);
    expect(fetchScheduledHourlyForecast).toHaveBeenCalledTimes(1);
    // Exactly two positional arguments; the second is literally undefined.
    expect(fetchScheduledHourlyForecast.mock.calls[0]).toHaveLength(2);
    expect(fetchScheduledHourlyForecast.mock.calls[0][1]).toBeUndefined();
    expect(calls[0].options).toBeUndefined();
  });

  it('forwards the exact options object and its signal, wrapping neither', async () => {
    const { convert } = fakeConverter(SEOUL_GRID);
    const { facade: scheduled, calls } = fakeScheduledFacade(
      Promise.resolve({ ok: true, hourly: [] }),
    );
    const facade = createKmaLocationScheduledHourlyForecastFacade(convert, scheduled);

    const controller = new AbortController();
    const signal = controller.signal;
    const options: KmaScheduledHourlyForecastOptions = { signal };

    await facade.fetchScheduledHourlyForecastForLocation(makeInput(), options);

    expect(calls[0].options).toBe(options);
    expect(calls[0].options?.signal).toBe(signal);
  });

  it('passes the converter grid reference values through without mutation or coercion', async () => {
    // A grid whose values are distinctive so a swap/round/clamp would be observable.
    const grid: KmaForecastGridCoordinate = { nx: 3, ny: 251 };
    const { convert } = fakeConverter(grid);
    const { facade: scheduled, calls } = fakeScheduledFacade(
      Promise.resolve({ ok: true, hourly: [] }),
    );
    const facade = createKmaLocationScheduledHourlyForecastFacade(convert, scheduled);

    await facade.fetchScheduledHourlyForecastForLocation(makeInput());

    expect(calls[0].input.nx).toBe(3);
    expect(calls[0].input.ny).toBe(251);
    // The converter's own grid object was not mutated.
    expect(grid).toEqual({ nx: 3, ny: 251 });
  });
});

describe('createKmaLocationScheduledHourlyForecastFacade — downstream result pass-through', () => {
  it('returns a success result unchanged', async () => {
    const hourly = [makeHourly()];
    const result: KmaScheduledHourlyForecastResult = { ok: true, hourly };
    const { convert } = fakeConverter(SEOUL_GRID);
    const { facade: scheduled } = fakeScheduledFacade(Promise.resolve(result));
    const facade = createKmaLocationScheduledHourlyForecastFacade(convert, scheduled);

    const resolved = await facade.fetchScheduledHourlyForecastForLocation(makeInput());
    expect(resolved).toBe(result);
  });

  it('returns a PROVIDER-stage failure unchanged, with the same error reference', async () => {
    const sentinelProviderError: KmaForecastProviderError = { kind: 'TIMEOUT' };
    const result: KmaScheduledHourlyForecastResult = {
      ok: false,
      stage: 'PROVIDER',
      error: sentinelProviderError,
    };
    const { convert } = fakeConverter(SEOUL_GRID);
    const { facade: scheduled } = fakeScheduledFacade(Promise.resolve(result));
    const facade = createKmaLocationScheduledHourlyForecastFacade(convert, scheduled);

    const resolved = await facade.fetchScheduledHourlyForecastForLocation(makeInput());
    expect(resolved).toBe(result);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok && resolved.stage === 'PROVIDER') {
      expect(resolved.error).toBe(sentinelProviderError);
    }
  });

  it('returns a NORMALIZATION-stage failure unchanged, with the same issues reference', async () => {
    const issue: KmaHourlyNormalizationIssue = {
      slotKey: 'SHORT_FORECAST|20260718|0500|20260718|0600|60|127',
      field: 'temperatureCelsius',
      reason: 'ABSENT',
    };
    const sentinelIssues: readonly KmaHourlyNormalizationIssue[] = [issue];
    const result: KmaScheduledHourlyForecastResult = {
      ok: false,
      stage: 'NORMALIZATION',
      issues: sentinelIssues,
    };
    const { convert } = fakeConverter(SEOUL_GRID);
    const { facade: scheduled } = fakeScheduledFacade(Promise.resolve(result));
    const facade = createKmaLocationScheduledHourlyForecastFacade(convert, scheduled);

    const resolved = await facade.fetchScheduledHourlyForecastForLocation(makeInput());
    expect(resolved).toBe(result);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok && resolved.stage === 'NORMALIZATION') {
      expect(resolved.issues).toBe(sentinelIssues);
      expect(resolved.issues[0]).toBe(issue);
    }
  });
});

describe('createKmaLocationScheduledHourlyForecastFacade — unsupported location', () => {
  it('returns the exact LOCATION failure and never calls the scheduled facade', async () => {
    const { convert, calls: converterCalls } = fakeConverter(null);
    const { facade: scheduled, fetchScheduledHourlyForecast } = neverCalledScheduledFacade();
    const facade = createKmaLocationScheduledHourlyForecastFacade(convert, scheduled);

    const options: KmaScheduledHourlyForecastOptions = { signal: new AbortController().signal };
    const resolved = await facade.fetchScheduledHourlyForecastForLocation(makeInput(), options);

    expect(resolved).toEqual({
      ok: false,
      stage: 'LOCATION',
      error: { kind: 'UNSUPPORTED_LOCATION' },
    });
    // Converter ran once; scheduled facade never ran (options never used).
    expect(convert).toHaveBeenCalledTimes(1);
    expect(converterCalls).toHaveLength(1);
    expect(fetchScheduledHourlyForecast).not.toHaveBeenCalled();
  });

  it('never exposes the raw latitude/longitude in the LOCATION result', async () => {
    const { convert } = fakeConverter(null);
    const { facade: scheduled } = neverCalledScheduledFacade();
    const facade = createKmaLocationScheduledHourlyForecastFacade(convert, scheduled);

    const input: KmaLocationScheduledHourlyForecastInput = {
      product: SHORT,
      latitude: SECRET_SHAPED_LOCATION_MUST_NOT_LEAK_PR13,
      longitude: SECRET_SHAPED_LOCATION_MUST_NOT_LEAK_PR13,
    };
    const resolved = await facade.fetchScheduledHourlyForecastForLocation(input);

    // Exactly ok/stage/error, and the error carries only its kind.
    if (resolved.ok || resolved.stage !== 'LOCATION') {
      throw new Error('expected a LOCATION failure');
    }
    expect(Object.keys(resolved).sort()).toEqual(['error', 'ok', 'stage']);
    expect(Object.keys(resolved.error)).toEqual(['kind']);
    const serialized = JSON.stringify(resolved);
    expect(serialized).not.toContain(String(SECRET_SHAPED_LOCATION_MUST_NOT_LEAK_PR13));
    for (const forbidden of ['latitude', 'longitude', 'nx', 'ny']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('builds a fresh Promise, result, and error object on every unsupported call', async () => {
    const { convert } = fakeConverter(null);
    const { facade: scheduled } = neverCalledScheduledFacade();
    const facade = createKmaLocationScheduledHourlyForecastFacade(convert, scheduled);

    const firstPromise = facade.fetchScheduledHourlyForecastForLocation(makeInput());
    const secondPromise = facade.fetchScheduledHourlyForecastForLocation(makeInput());

    expect(firstPromise).not.toBe(secondPromise);

    const first = await firstPromise;
    const second = await secondPromise;

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    if (first.ok || second.ok || first.stage !== 'LOCATION' || second.stage !== 'LOCATION') {
      throw new Error('expected two LOCATION failures');
    }
    // Fresh error object per call (no module-level shared failure singleton).
    expect(first.error).not.toBe(second.error);
    expect(convert).toHaveBeenCalledTimes(2);
  });
});

describe('createKmaLocationScheduledHourlyForecastFacade — converter throw propagation', () => {
  it('propagates a converter RangeError synchronously and never calls the scheduled facade', () => {
    const sentinel = new RangeError('latitude must be within [-90, 90]');
    const convert = vi.fn((): KmaForecastGridCoordinate | null => {
      throw sentinel;
    });
    const { facade: scheduled, fetchScheduledHourlyForecast } = neverCalledScheduledFacade();
    const facade = createKmaLocationScheduledHourlyForecastFacade(convert, scheduled);

    let caught: unknown;
    let returned: unknown;
    try {
      returned = facade.fetchScheduledHourlyForecastForLocation(makeInput());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(sentinel);
    expect(returned).toBeUndefined();
    expect(convert).toHaveBeenCalledTimes(1);
    expect(fetchScheduledHourlyForecast).not.toHaveBeenCalled();
  });

  it('propagates an injected converter sentinel error synchronously (not converted to a result)', () => {
    const sentinel = new Error('GRID_CONVERTER_SENTINEL_FOR_IDENTITY');
    const convert = vi.fn((): KmaForecastGridCoordinate | null => {
      throw sentinel;
    });
    const { facade: scheduled, fetchScheduledHourlyForecast } = neverCalledScheduledFacade();
    const facade = createKmaLocationScheduledHourlyForecastFacade(convert, scheduled);

    let caught: unknown;
    try {
      facade.fetchScheduledHourlyForecastForLocation(makeInput());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(sentinel);
    expect(fetchScheduledHourlyForecast).not.toHaveBeenCalled();
  });
});

describe('createKmaLocationScheduledHourlyForecastFacade — scheduled facade throw / rejection', () => {
  it('propagates a scheduled facade synchronous throw as the same error reference', () => {
    const sentinel = new Error('SCHEDULED_FACADE_SYNC_SENTINEL_FOR_IDENTITY');
    const { convert } = fakeConverter(SEOUL_GRID);
    // The interface expects a Promise return; cast to exercise a runtime collaborator violation.
    const fetchScheduledHourlyForecast = vi.fn((): Promise<KmaScheduledHourlyForecastResult> => {
      throw sentinel;
    });
    const scheduled = { fetchScheduledHourlyForecast } as unknown as KmaScheduledHourlyForecastFacade;
    const facade = createKmaLocationScheduledHourlyForecastFacade(convert, scheduled);

    let caught: unknown;
    try {
      facade.fetchScheduledHourlyForecastForLocation(makeInput());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(sentinel);
    expect(convert).toHaveBeenCalledTimes(1);
    expect(fetchScheduledHourlyForecast).toHaveBeenCalledTimes(1);
  });

  it('returns the same rejected Promise reference without intercepting the rejection', async () => {
    const sentinel = new Error('SCHEDULED_FACADE_REJECTION_SENTINEL_FOR_IDENTITY');
    const rejected = Promise.reject<KmaScheduledHourlyForecastResult>(sentinel);
    // Attach an assertion immediately so the rejection is always handled (no unhandled rejection).
    const assertion = expect(rejected).rejects.toBe(sentinel);

    const { convert } = fakeConverter(SEOUL_GRID);
    const { facade: scheduled } = fakeScheduledFacade(rejected);
    const facade = createKmaLocationScheduledHourlyForecastFacade(convert, scheduled);

    const returned = facade.fetchScheduledHourlyForecastForLocation(makeInput());
    expect(returned).toBe(rejected);
    await expect(returned).rejects.toBe(sentinel);
    await assertion;
  });
});

describe('createKmaLocationScheduledHourlyForecastFacade — immutability and repeated calls', () => {
  it('accepts frozen input and options, mutates neither, and forwards fresh derived objects', async () => {
    const grid = { ...SEOUL_GRID };
    const { convert, calls: converterCalls } = fakeConverter(grid);
    const { facade: scheduled, calls: scheduledCalls } = fakeScheduledFacade(
      Promise.resolve({ ok: true, hourly: [] }),
    );
    const facade = createKmaLocationScheduledHourlyForecastFacade(convert, scheduled);

    const signal = new AbortController().signal;
    const input = Object.freeze<KmaLocationScheduledHourlyForecastInput>({
      product: SHORT,
      latitude: SEOUL_LATITUDE,
      longitude: SEOUL_LONGITUDE,
    });
    const options = Object.freeze<KmaScheduledHourlyForecastOptions>({ signal });
    const inputSnapshot = JSON.stringify(input);

    await facade.fetchScheduledHourlyForecastForLocation(input, options);

    // Derived objects are fresh (distinct from the frozen input).
    expect(converterCalls[0].input).not.toBe(input);
    expect(scheduledCalls[0].input).not.toBe(input);
    // Options is forwarded by reference.
    expect(scheduledCalls[0].options).toBe(options);
    expect(scheduledCalls[0].options?.signal).toBe(signal);
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
    const supportedResult: KmaScheduledHourlyForecastResult = { ok: true, hourly: [makeHourly()] };
    const { facade: scheduled, fetchScheduledHourlyForecast, calls: scheduledCalls } =
      fakeScheduledFacade(Promise.resolve(supportedResult));
    const facade = createKmaLocationScheduledHourlyForecastFacade(convert, scheduled);

    const first = await facade.fetchScheduledHourlyForecastForLocation(makeInput());
    const second = await facade.fetchScheduledHourlyForecastForLocation(makeInput());

    // Converter ran twice; scheduled facade only ran for the supported call.
    expect(convert).toHaveBeenCalledTimes(2);
    expect(fetchScheduledHourlyForecast).toHaveBeenCalledTimes(1);
    expect(scheduledCalls).toHaveLength(1);

    expect(first).toBe(supportedResult);
    if (second.ok || second.stage !== 'LOCATION') {
      throw new Error('expected the second call to be an unsupported LOCATION failure');
    }
    expect(second.error.kind).toBe('UNSUPPORTED_LOCATION');
    // Fresh converter input object per call.
    expect(converterCalls[0].input).not.toBe(converterCalls[1].input);
  });
});
