import { afterEach, describe, expect, it, vi } from 'vitest';

import { currentWeather, type CurrentWeather } from '@life-weather/contracts';
import {
  convertKmaLatitudeLongitudeToGrid,
  type ConvertKmaLatitudeLongitudeToGridInput,
  type KmaForecastGridCoordinate,
} from '@life-weather/weather-core';

import type {
  KmaCurrentNormalizationIssue,
  KmaCurrentObservationProviderError,
} from '../providers/kma/index.js';
import type {
  KmaScheduledCurrentObservationFacade,
  KmaScheduledCurrentObservationInput,
  KmaScheduledCurrentObservationOptions,
  KmaScheduledCurrentObservationResult,
} from './kma-scheduled-current-observation.js';
import {
  createKmaLocationScheduledCurrentObservationFacade,
  type KmaLocationScheduledCurrentObservationInput,
} from './kma-location-scheduled-current-observation.js';

/**
 * These tests exercise the location facade in isolation: the grid converter and the scheduled
 * facade are both fresh fakes built inside each test (never shared at describe scope), so call
 * counts, argument identity, and Promise identity are directly assertable. The facade must add no
 * new rule beyond the LOCATION result — it wires a fresh converter input, a fresh scheduled input,
 * passes `options` by reference, and forwards the scheduled facade's Promise verbatim.
 */

/** Seoul: a supported KMA location (used only as the caller's raw lat/lon; the fake converter decides the grid). */
const SEOUL_LATITUDE = 37.5665;
const SEOUL_LONGITUDE = 126.978;

/** A grid the fake converter returns for a supported location. */
const SEOUL_GRID: KmaForecastGridCoordinate = { nx: 60, ny: 127 };

/** A secret-shaped coordinate marker used to prove raw coordinates never leak into a result/error. */
const SECRET_SHAPED_LOCATION_MUST_NOT_LEAK_PR70 = 999.000456;

/** A fresh, valid caller input. Each test builds its own so no reference is ever shared across tests. */
function makeInput(): KmaLocationScheduledCurrentObservationInput {
  return { latitude: SEOUL_LATITUDE, longitude: SEOUL_LONGITUDE };
}

/** A minimal, contracts-valid current-observation entry for the success fixture. */
function makeCurrent(): CurrentWeather {
  return {
    observedAt: '2026-07-18T06:00:00+09:00',
    condition: 'CLEAR',
    temperatureCelsius: 23.5,
    feelsLikeCelsius: null,
    humidityPercent: null,
    windSpeedMetersPerSecond: null,
    windDirectionDegrees: null,
    precipitationLastHourMillimeters: null,
    visibilityMeters: null,
  };
}

interface ConverterCall {
  readonly input: ConvertKmaLatitudeLongitudeToGridInput;
}

interface ScheduledCall {
  readonly input: KmaScheduledCurrentObservationInput;
  readonly options: KmaScheduledCurrentObservationOptions | undefined;
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
function fakeScheduledFacade(result: Promise<KmaScheduledCurrentObservationResult>) {
  const calls: ScheduledCall[] = [];
  const fetchScheduledCurrentWeather = vi.fn(
    (
      input: KmaScheduledCurrentObservationInput,
      options?: KmaScheduledCurrentObservationOptions,
    ): Promise<KmaScheduledCurrentObservationResult> => {
      calls.push({ input, options });
      return result;
    },
  );
  const facade: KmaScheduledCurrentObservationFacade = {
    fetchScheduledCurrentWeather,
  };
  return { facade, fetchScheduledCurrentWeather, calls };
}

/** A scheduled facade that must never run — fails the test loudly if it is ever called. */
function neverCalledScheduledFacade() {
  const fetchScheduledCurrentWeather = vi.fn(
    (): Promise<KmaScheduledCurrentObservationResult> => {
      throw new Error('test setup: scheduled facade was called but should not have been');
    },
  );
  const facade: KmaScheduledCurrentObservationFacade = {
    fetchScheduledCurrentWeather,
  };
  return { facade, fetchScheduledCurrentWeather };
}

/** Silences and records every console channel the facade must never write to. */
function spyOnConsoleOutput() {
  return [
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'info').mockImplementation(() => undefined),
    vi.spyOn(console, 'debug').mockImplementation(() => undefined),
  ];
}

function expectNoConsoleOutput(spies: readonly ReturnType<typeof vi.spyOn>[]): void {
  for (const spy of spies) {
    expect(spy).not.toHaveBeenCalled();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createKmaLocationScheduledCurrentObservationFacade — construction is side-effect-free', () => {
  it('does not call the grid converter on construction alone', () => {
    const { convert } = fakeConverter(SEOUL_GRID);
    const { facade: scheduled } = fakeScheduledFacade(
      Promise.resolve({ ok: true, current: makeCurrent() }),
    );
    createKmaLocationScheduledCurrentObservationFacade(convert, scheduled);
    expect(convert).not.toHaveBeenCalled();
  });

  it('does not call the scheduled facade on construction alone', () => {
    const { convert } = fakeConverter(SEOUL_GRID);
    const { facade: scheduled, fetchScheduledCurrentWeather } = fakeScheduledFacade(
      Promise.resolve({ ok: true, current: makeCurrent() }),
    );
    createKmaLocationScheduledCurrentObservationFacade(convert, scheduled);
    expect(fetchScheduledCurrentWeather).not.toHaveBeenCalled();
  });

  it('does not throw on construction and works with frozen collaborators', () => {
    const grid = { ...SEOUL_GRID };
    const convert = vi.fn(() => grid);
    const resultPromise = Promise.resolve<KmaScheduledCurrentObservationResult>({
      ok: true,
      current: makeCurrent(),
    });
    const fetchScheduledCurrentWeather = vi.fn(() => resultPromise);
    const scheduled = Object.freeze<KmaScheduledCurrentObservationFacade>({
      fetchScheduledCurrentWeather,
    });

    let facade: unknown;
    expect(() => {
      facade = createKmaLocationScheduledCurrentObservationFacade(convert, scheduled);
    }).not.toThrow();
    expect(convert).not.toHaveBeenCalled();
    expect(fetchScheduledCurrentWeather).not.toHaveBeenCalled();
    expect(facade).toBeDefined();
  });

  it('does not read the console on construction', () => {
    const consoleSpies = spyOnConsoleOutput();
    const { convert } = fakeConverter(SEOUL_GRID);
    const { facade: scheduled } = fakeScheduledFacade(
      Promise.resolve({ ok: true, current: makeCurrent() }),
    );
    createKmaLocationScheduledCurrentObservationFacade(convert, scheduled);
    expectNoConsoleOutput(consoleSpies);
  });

  it('keeps two facade instances independent (no global mutable state)', async () => {
    const a = fakeConverter(SEOUL_GRID);
    const b = fakeConverter(SEOUL_GRID);
    const sa = fakeScheduledFacade(
      Promise.resolve({ ok: true, current: makeCurrent() }),
    );
    const sb = fakeScheduledFacade(
      Promise.resolve({ ok: true, current: makeCurrent() }),
    );

    const facadeA = createKmaLocationScheduledCurrentObservationFacade(a.convert, sa.facade);
    const facadeB = createKmaLocationScheduledCurrentObservationFacade(b.convert, sb.facade);

    await facadeA.fetchScheduledCurrentWeatherForLocation(makeInput());

    expect(a.convert).toHaveBeenCalledTimes(1);
    expect(sa.fetchScheduledCurrentWeather).toHaveBeenCalledTimes(1);
    expect(b.convert).not.toHaveBeenCalled();
    expect(sb.fetchScheduledCurrentWeather).not.toHaveBeenCalled();
  });
});

describe('createKmaLocationScheduledCurrentObservationFacade — supported location wiring', () => {
  it('converts once, wires a fresh nx/ny input, and returns the scheduled Promise verbatim', async () => {
    const input = makeInput();
    const current = Object.freeze(makeCurrent());
    const result = Object.freeze<KmaScheduledCurrentObservationResult>({
      ok: true,
      current,
    });
    const downstreamPromise = Promise.resolve<KmaScheduledCurrentObservationResult>(result);

    const { convert, calls: converterCalls } = fakeConverter(SEOUL_GRID);
    const {
      facade: scheduled,
      fetchScheduledCurrentWeather,
      calls: scheduledCalls,
    } = fakeScheduledFacade(downstreamPromise);
    const facade = createKmaLocationScheduledCurrentObservationFacade(convert, scheduled);

    const options: KmaScheduledCurrentObservationOptions = {
      signal: new AbortController().signal,
    };
    const returned = facade.fetchScheduledCurrentWeatherForLocation(input, options);

    // Converter ran exactly once.
    expect(convert).toHaveBeenCalledTimes(1);
    expect(converterCalls).toHaveLength(1);
    // Converter input own keys are exactly latitude/longitude — no nx/ny/options/signal/extra.
    expect(Object.keys(converterCalls[0].input).sort()).toEqual(['latitude', 'longitude']);
    expect(converterCalls[0].input.latitude).toBe(SEOUL_LATITUDE);
    expect(converterCalls[0].input.longitude).toBe(SEOUL_LONGITUDE);
    // Converter input is a distinct object from the caller input.
    expect(converterCalls[0].input).not.toBe(input);

    // Scheduled facade ran exactly once.
    expect(fetchScheduledCurrentWeather).toHaveBeenCalledTimes(1);
    expect(scheduledCalls).toHaveLength(1);
    // Scheduled input own keys are exactly nx/ny — no latitude/longitude.
    expect(Object.keys(scheduledCalls[0].input).sort()).toEqual(['nx', 'ny']);
    expect('latitude' in scheduledCalls[0].input).toBe(false);
    expect('longitude' in scheduledCalls[0].input).toBe(false);
    // Converter grid values pass through unchanged.
    expect(scheduledCalls[0].input.nx).toBe(SEOUL_GRID.nx);
    expect(scheduledCalls[0].input.ny).toBe(SEOUL_GRID.ny);
    // Options passed by the same reference.
    expect(scheduledCalls[0].options).toBe(options);

    // The location facade returns the exact Promise the scheduled facade returned.
    expect(returned).toBe(downstreamPromise);
    const resolved = await returned;
    // Give a same-Promise `.then()` side effect (a mutation regression) a turn to run before asserting.
    await Promise.resolve();

    expect(resolved).toBe(result);
    expect(resolved.ok).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(current)).toBe(true);
    if (resolved.ok) {
      expect(resolved.current).toBe(current);
      expect(currentWeather.safeParse(resolved.current).success).toBe(true);
    }
  });

  it('does not forward a caller extra enumerable own property into the converter input (rejects input spreading)', async () => {
    // A caller input with a distinct, enumerable extra own property beyond latitude/longitude —
    // proves the converter input is freshly built field-by-field, not `{ ...input }`.
    const input = Object.freeze({
      latitude: SEOUL_LATITUDE,
      longitude: SEOUL_LONGITUDE,
      boundarySentinel: 'must-not-cross-converter-boundary',
    });
    const { convert, calls: converterCalls } = fakeConverter(SEOUL_GRID);
    const { facade: scheduled } = fakeScheduledFacade(
      Promise.resolve({ ok: true, current: makeCurrent() }),
    );
    const facade = createKmaLocationScheduledCurrentObservationFacade(convert, scheduled);

    await facade.fetchScheduledCurrentWeatherForLocation(input);

    expect(convert).toHaveBeenCalledTimes(1);
    expect(converterCalls).toHaveLength(1);
    const converterInput = converterCalls[0].input;

    // A fresh object, not the caller's input reference.
    expect(converterInput).not.toBe(input);
    // Own keys are exactly latitude/longitude — the extra sentinel never crosses the boundary.
    expect(Object.keys(converterInput)).toEqual(['latitude', 'longitude']);
    expect(converterInput).toEqual({
      latitude: input.latitude,
      longitude: input.longitude,
    });
    expect(converterInput).not.toHaveProperty('boundarySentinel');
  });

  it('forwards exactly undefined (never a synthesized {}) when options are omitted', async () => {
    const { convert } = fakeConverter(SEOUL_GRID);
    const { facade: scheduled, fetchScheduledCurrentWeather, calls } = fakeScheduledFacade(
      Promise.resolve({ ok: true, current: makeCurrent() }),
    );
    const facade = createKmaLocationScheduledCurrentObservationFacade(convert, scheduled);

    await facade.fetchScheduledCurrentWeatherForLocation(makeInput());

    expect(convert).toHaveBeenCalledTimes(1);
    expect(fetchScheduledCurrentWeather).toHaveBeenCalledTimes(1);
    // Exactly two positional arguments; the second is literally undefined.
    expect(fetchScheduledCurrentWeather.mock.calls[0]).toHaveLength(2);
    expect(fetchScheduledCurrentWeather.mock.calls[0][1]).toBeUndefined();
    expect(calls[0].options).toBeUndefined();
  });

  it('forwards the exact options object and its signal, wrapping neither', async () => {
    const { convert } = fakeConverter(SEOUL_GRID);
    const { facade: scheduled, calls } = fakeScheduledFacade(
      Promise.resolve({ ok: true, current: makeCurrent() }),
    );
    const facade = createKmaLocationScheduledCurrentObservationFacade(convert, scheduled);

    const controller = new AbortController();
    const signal = controller.signal;
    const options: KmaScheduledCurrentObservationOptions = { signal };

    await facade.fetchScheduledCurrentWeatherForLocation(makeInput(), options);

    expect(calls[0].options).toBe(options);
    expect(calls[0].options?.signal).toBe(signal);
  });

  it('passes the converter grid reference values through without mutation or coercion', async () => {
    // A grid whose values are distinctive so a swap/round/clamp would be observable.
    const grid: KmaForecastGridCoordinate = { nx: 3, ny: 251 };
    const { convert } = fakeConverter(grid);
    const { facade: scheduled, calls } = fakeScheduledFacade(
      Promise.resolve({ ok: true, current: makeCurrent() }),
    );
    const facade = createKmaLocationScheduledCurrentObservationFacade(convert, scheduled);

    await facade.fetchScheduledCurrentWeatherForLocation(makeInput());

    expect(calls[0].input.nx).toBe(3);
    expect(calls[0].input.ny).toBe(251);
    // The converter's own grid object was not mutated.
    expect(grid).toEqual({ nx: 3, ny: 251 });
  });
});

describe('createKmaLocationScheduledCurrentObservationFacade — downstream result pass-through', () => {
  it('returns a success result unchanged', async () => {
    const current = makeCurrent();
    const result: KmaScheduledCurrentObservationResult = { ok: true, current };
    const { convert } = fakeConverter(SEOUL_GRID);
    const { facade: scheduled } = fakeScheduledFacade(Promise.resolve(result));
    const facade = createKmaLocationScheduledCurrentObservationFacade(convert, scheduled);

    const resolved = await facade.fetchScheduledCurrentWeatherForLocation(makeInput());
    expect(resolved).toBe(result);
  });

  it('returns a PROVIDER-stage failure unchanged, with the same error reference', async () => {
    const sentinelProviderError = Object.freeze<KmaCurrentObservationProviderError>({
      kind: 'TIMEOUT',
    });
    const result = Object.freeze<KmaScheduledCurrentObservationResult>({
      ok: false,
      stage: 'PROVIDER',
      error: sentinelProviderError,
    });
    const { convert } = fakeConverter(SEOUL_GRID);
    const { facade: scheduled } = fakeScheduledFacade(Promise.resolve(result));
    const facade = createKmaLocationScheduledCurrentObservationFacade(convert, scheduled);

    const resolved = await facade.fetchScheduledCurrentWeatherForLocation(makeInput());
    // Give a same-Promise `.then()` side effect (a mutation regression) a turn to run before asserting.
    await Promise.resolve();

    expect(resolved).toBe(result);
    expect(resolved.ok).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(sentinelProviderError)).toBe(true);
    if (!resolved.ok && resolved.stage === 'PROVIDER') {
      expect(resolved.error).toBe(sentinelProviderError);
    }
  });

  it('returns a NORMALIZATION-stage failure unchanged, with the same issues reference', async () => {
    const firstIssue = Object.freeze<KmaCurrentNormalizationIssue>({
      field: 'observedAt',
      reason: 'INVALID',
    });
    const secondIssue = Object.freeze<KmaCurrentNormalizationIssue>({
      field: 'temperatureCelsius',
      reason: 'ABSENT',
    });
    const sentinelIssues = Object.freeze<readonly KmaCurrentNormalizationIssue[]>([
      firstIssue,
      secondIssue,
    ]);
    const result = Object.freeze<KmaScheduledCurrentObservationResult>({
      ok: false,
      stage: 'NORMALIZATION',
      issues: sentinelIssues,
    });
    const { convert } = fakeConverter(SEOUL_GRID);
    const { facade: scheduled } = fakeScheduledFacade(Promise.resolve(result));
    const facade = createKmaLocationScheduledCurrentObservationFacade(convert, scheduled);

    const resolved = await facade.fetchScheduledCurrentWeatherForLocation(makeInput());
    // Give a same-Promise `.then()` side effect (a mutation regression) a turn to run before asserting.
    await Promise.resolve();

    expect(resolved).toBe(result);
    expect(resolved.ok).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(firstIssue)).toBe(true);
    expect(Object.isFrozen(secondIssue)).toBe(true);
    if (!resolved.ok && resolved.stage === 'NORMALIZATION') {
      expect(resolved.issues).toBe(sentinelIssues);
      expect(resolved.issues).toHaveLength(2);
      expect(resolved.issues[0]).toBe(firstIssue);
      expect(resolved.issues[1]).toBe(secondIssue);
    }
  });
});

describe('createKmaLocationScheduledCurrentObservationFacade — unsupported location', () => {
  it('returns the exact LOCATION failure and never calls the scheduled facade', async () => {
    const { convert, calls: converterCalls } = fakeConverter(null);
    const { facade: scheduled, fetchScheduledCurrentWeather } = neverCalledScheduledFacade();
    const facade = createKmaLocationScheduledCurrentObservationFacade(convert, scheduled);

    const options: KmaScheduledCurrentObservationOptions = {
      signal: new AbortController().signal,
    };
    const resolved = await facade.fetchScheduledCurrentWeatherForLocation(makeInput(), options);

    expect(resolved).toEqual({
      ok: false,
      stage: 'LOCATION',
      error: { kind: 'UNSUPPORTED_LOCATION' },
    });
    // Converter ran once; scheduled facade never ran (options never used).
    expect(convert).toHaveBeenCalledTimes(1);
    expect(converterCalls).toHaveLength(1);
    expect(fetchScheduledCurrentWeather).not.toHaveBeenCalled();
  });

  it('never exposes the raw latitude/longitude/grid in the LOCATION result and logs nothing', async () => {
    const consoleSpies = spyOnConsoleOutput();
    const { convert } = fakeConverter(null);
    const { facade: scheduled } = neverCalledScheduledFacade();
    const facade = createKmaLocationScheduledCurrentObservationFacade(convert, scheduled);

    const input: KmaLocationScheduledCurrentObservationInput = {
      latitude: SECRET_SHAPED_LOCATION_MUST_NOT_LEAK_PR70,
      longitude: SECRET_SHAPED_LOCATION_MUST_NOT_LEAK_PR70,
    };
    const resolved = await facade.fetchScheduledCurrentWeatherForLocation(input);

    // Exactly ok/stage/error, and the error carries only its kind.
    if (resolved.ok || resolved.stage !== 'LOCATION') {
      throw new Error('expected a LOCATION failure');
    }
    expect(Object.keys(resolved).sort()).toEqual(['error', 'ok', 'stage']);
    expect(Object.keys(resolved.error)).toEqual(['kind']);
    const serialized = JSON.stringify(resolved);
    expect(serialized).not.toContain(String(SECRET_SHAPED_LOCATION_MUST_NOT_LEAK_PR70));
    for (const forbidden of ['latitude', 'longitude', 'nx', 'ny']) {
      expect(serialized).not.toContain(forbidden);
    }
    expectNoConsoleOutput(consoleSpies);
  });

  it('builds a fresh Promise, result, and error object on every unsupported call', async () => {
    const { convert } = fakeConverter(null);
    const { facade: scheduled } = neverCalledScheduledFacade();
    const facade = createKmaLocationScheduledCurrentObservationFacade(convert, scheduled);

    const firstPromise = facade.fetchScheduledCurrentWeatherForLocation(makeInput());
    const secondPromise = facade.fetchScheduledCurrentWeatherForLocation(makeInput());

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

  it('keeps the caller input untouched for an unsupported location', async () => {
    const { convert } = fakeConverter(null);
    const { facade: scheduled } = neverCalledScheduledFacade();
    const facade = createKmaLocationScheduledCurrentObservationFacade(convert, scheduled);

    const input = Object.freeze(makeInput());
    const inputSnapshot = JSON.stringify(input);

    await facade.fetchScheduledCurrentWeatherForLocation(input);

    expect(JSON.stringify(input)).toBe(inputSnapshot);
  });
});

describe('createKmaLocationScheduledCurrentObservationFacade — converter throw propagation', () => {
  it('propagates a converter RangeError synchronously and never calls the scheduled facade', () => {
    const consoleSpies = spyOnConsoleOutput();
    const sentinel = new RangeError('latitude must be within [-90, 90]');
    const convert = vi.fn((): KmaForecastGridCoordinate | null => {
      throw sentinel;
    });
    const { facade: scheduled, fetchScheduledCurrentWeather } = neverCalledScheduledFacade();
    const facade = createKmaLocationScheduledCurrentObservationFacade(convert, scheduled);

    let caught: unknown;
    let returned: unknown;
    try {
      returned = facade.fetchScheduledCurrentWeatherForLocation(makeInput());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(sentinel);
    expect(returned).toBeUndefined();
    expect(convert).toHaveBeenCalledTimes(1);
    expect(fetchScheduledCurrentWeather).not.toHaveBeenCalled();
    expectNoConsoleOutput(consoleSpies);
  });

  it('propagates an injected converter sentinel error synchronously (not converted to a result)', () => {
    const consoleSpies = spyOnConsoleOutput();
    const sentinel = new Error('GRID_CONVERTER_SENTINEL_FOR_IDENTITY');
    const convert = vi.fn((): KmaForecastGridCoordinate | null => {
      throw sentinel;
    });
    const { facade: scheduled, fetchScheduledCurrentWeather } = neverCalledScheduledFacade();
    const facade = createKmaLocationScheduledCurrentObservationFacade(convert, scheduled);

    let caught: unknown;
    try {
      facade.fetchScheduledCurrentWeatherForLocation(makeInput());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(sentinel);
    expect(fetchScheduledCurrentWeather).not.toHaveBeenCalled();
    expectNoConsoleOutput(consoleSpies);
  });
});

describe('createKmaLocationScheduledCurrentObservationFacade — scheduled facade throw / rejection', () => {
  it('propagates a scheduled facade synchronous throw as the same error reference', () => {
    const consoleSpies = spyOnConsoleOutput();
    const sentinel = new Error('SCHEDULED_FACADE_SYNC_SENTINEL_FOR_IDENTITY');
    const { convert } = fakeConverter(SEOUL_GRID);
    // The interface expects a Promise return; cast to exercise a runtime collaborator violation.
    const fetchScheduledCurrentWeather = vi.fn((): Promise<KmaScheduledCurrentObservationResult> => {
      throw sentinel;
    });
    const scheduled = {
      fetchScheduledCurrentWeather,
    } as unknown as KmaScheduledCurrentObservationFacade;
    const facade = createKmaLocationScheduledCurrentObservationFacade(convert, scheduled);

    let caught: unknown;
    try {
      facade.fetchScheduledCurrentWeatherForLocation(makeInput());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(sentinel);
    expect(convert).toHaveBeenCalledTimes(1);
    expect(fetchScheduledCurrentWeather).toHaveBeenCalledTimes(1);
    expectNoConsoleOutput(consoleSpies);
  });

  it('returns the same rejected Promise reference without intercepting the rejection', async () => {
    const consoleSpies = spyOnConsoleOutput();
    const sentinel = new Error('SCHEDULED_FACADE_REJECTION_SENTINEL_FOR_IDENTITY');
    const rejected = Promise.reject<KmaScheduledCurrentObservationResult>(sentinel);
    // Attach an assertion immediately so the rejection is always handled (no unhandled rejection).
    const assertion = expect(rejected).rejects.toBe(sentinel);

    const { convert } = fakeConverter(SEOUL_GRID);
    const { facade: scheduled } = fakeScheduledFacade(rejected);
    const facade = createKmaLocationScheduledCurrentObservationFacade(convert, scheduled);

    const returned = facade.fetchScheduledCurrentWeatherForLocation(makeInput());
    expect(returned).toBe(rejected);
    await expect(returned).rejects.toBe(sentinel);
    await assertion;
    expectNoConsoleOutput(consoleSpies);
  });
});

describe('createKmaLocationScheduledCurrentObservationFacade — immutability and repeated calls', () => {
  it('accepts frozen input and options, mutates neither, and forwards fresh derived objects', async () => {
    const grid = { ...SEOUL_GRID };
    const { convert, calls: converterCalls } = fakeConverter(grid);
    const { facade: scheduled, calls: scheduledCalls } = fakeScheduledFacade(
      Promise.resolve({ ok: true, current: makeCurrent() }),
    );
    const facade = createKmaLocationScheduledCurrentObservationFacade(convert, scheduled);

    const signal = new AbortController().signal;
    const input = Object.freeze<KmaLocationScheduledCurrentObservationInput>({
      latitude: SEOUL_LATITUDE,
      longitude: SEOUL_LONGITUDE,
    });
    const options = Object.freeze<KmaScheduledCurrentObservationOptions>({ signal });
    const inputSnapshot = JSON.stringify(input);

    await facade.fetchScheduledCurrentWeatherForLocation(input, options);

    // Derived objects are fresh (distinct from the frozen input).
    expect(converterCalls[0].input).not.toBe(input);
    expect(scheduledCalls[0].input).not.toBe(input);
    // Options is forwarded by reference.
    expect(scheduledCalls[0].options).toBe(options);
    expect(scheduledCalls[0].options?.signal).toBe(signal);
    // The caller's input was not mutated and carries no extra property.
    expect(JSON.stringify(input)).toBe(inputSnapshot);
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
    const supportedResult: KmaScheduledCurrentObservationResult = {
      ok: true,
      current: makeCurrent(),
    };
    const { facade: scheduled, fetchScheduledCurrentWeather, calls: scheduledCalls } =
      fakeScheduledFacade(Promise.resolve(supportedResult));
    const facade = createKmaLocationScheduledCurrentObservationFacade(convert, scheduled);

    const first = await facade.fetchScheduledCurrentWeatherForLocation(makeInput());
    const second = await facade.fetchScheduledCurrentWeatherForLocation(makeInput());

    // Converter ran twice; scheduled facade only ran for the supported call.
    expect(convert).toHaveBeenCalledTimes(2);
    expect(fetchScheduledCurrentWeather).toHaveBeenCalledTimes(1);
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

describe('createKmaLocationScheduledCurrentObservationFacade — non-vacuity (frozen scheduled-result clone regression)', () => {
  it('would fail if the facade spread the scheduled facade result instead of forwarding it by reference', async () => {
    const result = Object.freeze<KmaScheduledCurrentObservationResult>({
      ok: true,
      current: Object.freeze(makeCurrent()),
    });
    const { convert } = fakeConverter(SEOUL_GRID);
    const { facade: scheduled } = fakeScheduledFacade(Promise.resolve(result));
    const facade = createKmaLocationScheduledCurrentObservationFacade(convert, scheduled);

    const resolved = await facade.fetchScheduledCurrentWeatherForLocation(makeInput());

    // A buggy implementation that does
    // `.then((result) => ({ ...result }))` would produce a new object here and fail this check.
    expect(resolved).toBe(result);
  });
});

describe('createKmaLocationScheduledCurrentObservationFacade — real converter integration (synthetic coordinates)', () => {
  it('supported coordinate: the real converter feeds a valid nx/ny to the scheduled facade', async () => {
    const { facade: scheduled, calls } = fakeScheduledFacade(
      Promise.resolve({ ok: true, current: makeCurrent() }),
    );
    const facade = createKmaLocationScheduledCurrentObservationFacade(
      convertKmaLatitudeLongitudeToGrid,
      scheduled,
    );

    await facade.fetchScheduledCurrentWeatherForLocation({
      latitude: SEOUL_LATITUDE,
      longitude: SEOUL_LONGITUDE,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].input).toEqual({ nx: 60, ny: 127 });
  });

  it('invalid coordinate: the real converter throws RangeError and the scheduled facade never runs', () => {
    const consoleSpies = spyOnConsoleOutput();
    const { facade: scheduled, fetchScheduledCurrentWeather } = neverCalledScheduledFacade();
    const facade = createKmaLocationScheduledCurrentObservationFacade(
      convertKmaLatitudeLongitudeToGrid,
      scheduled,
    );

    let caught: unknown;
    try {
      facade.fetchScheduledCurrentWeatherForLocation({
        latitude: 999,
        longitude: SEOUL_LONGITUDE,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RangeError);
    expect(fetchScheduledCurrentWeather).not.toHaveBeenCalled();
    expectNoConsoleOutput(consoleSpies);
  });
});
