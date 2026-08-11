import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  weatherOverview,
  type CurrentWeather,
  type HourlyForecast,
  type WeatherLocation,
  type WeatherOverview,
} from '@life-weather/contracts';
import { KmaForecastProduct } from '@life-weather/weather-core';

import type {
  KmaCurrentNormalizationIssue,
  KmaCurrentObservationProviderError,
} from '../providers/kma/index.js';
import {
  assembleKmaCurrentHourlyWeatherOverview,
  type KmaCurrentHourlyWeatherOverviewInput,
} from './kma-current-hourly-weather-overview.js';
import {
  assembleKmaCurrentWeatherOverview,
  type KmaCurrentSourceMetadataInput,
} from './kma-current-weather-overview.js';
import type { KmaHourlyFallbackSelection } from './kma-hourly-fallback-selection.js';
import type { KmaHourlyFallbackServiceResult } from './kma-hourly-fallback.js';
import {
  assembleKmaHourlyWeatherOverview,
  type KmaHourlySourceMetadataInput,
} from './kma-hourly-weather-overview.js';
import type {
  KmaLocationCurrentOverviewOptions,
  KmaLocationCurrentOverviewResult,
  KmaLocationCurrentOverviewService,
} from './kma-location-current-overview.js';
import type {
  KmaLocationHourlyOverviewInput,
  KmaLocationHourlyOverviewOptions,
  KmaLocationHourlyOverviewResult,
  KmaLocationHourlyOverviewService,
} from './kma-location-hourly-overview.js';
import {
  createKmaLocationCurrentHourlyOverviewService,
  type KmaLocationCurrentHourlyOverviewInput,
  type KmaLocationCurrentHourlyOverviewOptions,
  type KmaLocationCurrentHourlyOverviewResult,
} from './kma-location-current-hourly-overview.js';

/**
 * These tests exercise the PR #77 application orchestration in isolation. The two boundary
 * collaborators — the PR #24 hourly overview service and the PR #74 current overview service —
 * are fresh fakes built inside each test (never shared at describe scope), so call counts,
 * argument identity, and Promise identity are directly assertable. The default aggregation tests
 * use the **real** PR #76 assembler (`assembleKmaCurrentHourlyWeatherOverview`); only the
 * assembler-error-propagation test injects a throwing assembler. Hourly/current success fixtures
 * are themselves built through the **real** PR #23/#72/#73 assemblers (mirroring
 * `kma-current-hourly-weather-overview.test.ts`), so the aggregation tests exercise the actual
 * production `WeatherOverview` shapes rather than hand-invented ones.
 */

const SHORT = KmaForecastProduct.SHORT_FORECAST;

// ---------------------------------------------------------------------------
// Narrowed local aliases.
// ---------------------------------------------------------------------------

type SelectedSelection = Extract<KmaHourlyFallbackSelection, { readonly selected: true }>;
type NoSelection = Extract<KmaHourlyFallbackSelection, { readonly selected: false }>;
type HourlyOverviewSuccess = Extract<KmaLocationHourlyOverviewResult, { readonly ok: true }>;
type HourlyLocationFailure = Extract<
  KmaLocationHourlyOverviewResult,
  { readonly stage: 'LOCATION' }
>;
type CurrentOverviewSuccess = Extract<KmaLocationCurrentOverviewResult, { readonly ok: true }>;
type CurrentFailure = Extract<KmaLocationCurrentOverviewResult, { readonly ok: false }>;

// ---------------------------------------------------------------------------
// Exact key contracts.
// ---------------------------------------------------------------------------

const SUCCESS_KEYS = ['ok', 'overview', 'selection'] as const;
const LOCATION_KEYS = ['error', 'ok', 'stage'] as const;

// ---------------------------------------------------------------------------
// Fixture builders — every mutable fixture is built fresh per call.
// ---------------------------------------------------------------------------

function makeLocation(overrides: Partial<WeatherLocation> = {}): WeatherLocation {
  return {
    id: 'loc_seoul_jung',
    displayName: '서울특별시 중구',
    countryCode: 'KR',
    adminArea1: '서울특별시',
    adminArea2: '중구',
    adminArea3: null,
    latitude: 37.5636,
    longitude: 126.997,
    timezone: 'Asia/Seoul',
    ...overrides,
  };
}

function makeHourly(forecastAt = '2026-08-11T14:00:00+09:00'): HourlyForecast {
  return {
    forecastAt,
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
}

function makeHourlySource(
  overrides: Partial<KmaHourlySourceMetadataInput> = {},
): KmaHourlySourceMetadataInput {
  return {
    sourceId: 'kma-short-forecast-hourly',
    issuedAt: '2026-08-11T05:00:00+09:00',
    fetchedAt: '2026-08-11T05:05:00+09:00',
    retrievalMode: 'LIVE',
    ...overrides,
  };
}

function makePrimarySelection(
  hourly: readonly HourlyForecast[] = [makeHourly()],
): SelectedSelection {
  const result = { ok: true as const, hourly };
  const execution: KmaHourlyFallbackServiceResult = {
    fallbackAttempted: false,
    primaryIssuance: { product: SHORT, baseDate: '20260811', baseTime: '0500' },
    primary: result,
  };
  return {
    selected: true,
    source: 'PRIMARY',
    fallbackUsed: false,
    result,
    execution,
  };
}

function makeNoSelection(): NoSelection {
  const primary = { ok: true as const, hourly: [] };
  const previous = { ok: true as const, hourly: [] };
  const execution: KmaHourlyFallbackServiceResult = {
    fallbackAttempted: true,
    fallbackReason: 'EMPTY_HOURLY',
    primaryIssuance: { product: SHORT, baseDate: '20260811', baseTime: '0500' },
    primary,
    previousIssuance: { product: SHORT, baseDate: '20260811', baseTime: '0200' },
    previous,
  };
  return {
    selected: false,
    source: null,
    fallbackUsed: false,
    result: null,
    execution,
  };
}

/** Build a real hourly-overview application-service success wrapper via the real PR #23 assembler. */
function makeHourlyOverviewSuccess(
  options: {
    readonly location?: WeatherLocation;
    readonly hourly?: readonly HourlyForecast[];
    readonly source?: KmaHourlySourceMetadataInput;
    readonly noSelection?: boolean;
  } = {},
): HourlyOverviewSuccess {
  const location = options.location ?? makeLocation();

  if (options.noSelection) {
    const selection = makeNoSelection();
    const overview = assembleKmaHourlyWeatherOverview({ location, selection, source: null });
    return { ok: true, selection, overview };
  }

  const selection = makePrimarySelection(options.hourly ?? [makeHourly()]);
  const source = options.source ?? makeHourlySource();
  const overview = assembleKmaHourlyWeatherOverview({ location, selection, source });
  return { ok: true, selection, overview };
}

/** A fresh hourly `LOCATION` passthrough failure (value-free discriminator). */
function makeHourlyLocationFailure(): HourlyLocationFailure {
  return { ok: false, stage: 'LOCATION', error: { kind: 'UNSUPPORTED_LOCATION' } };
}

function makeCurrent(overrides: Partial<CurrentWeather> = {}): CurrentWeather {
  return {
    observedAt: '2026-08-11T14:00:00+09:00',
    condition: 'CLEAR',
    temperatureCelsius: 28.4,
    feelsLikeCelsius: 30.1,
    humidityPercent: 55,
    windSpeedMetersPerSecond: 2.3,
    windDirectionDegrees: 180,
    precipitationLastHourMillimeters: 0,
    visibilityMeters: 12000,
    ...overrides,
  };
}

function makeCurrentSource(
  overrides: Partial<KmaCurrentSourceMetadataInput> = {},
): KmaCurrentSourceMetadataInput {
  return {
    sourceId: 'kma-ultra-short-current-observation',
    fetchedAt: '2026-08-11T05:00:00.000Z',
    retrievalMode: 'LIVE',
    ...overrides,
  };
}

/** Build a real current-overview application-service success wrapper via the real PR #72/#73 assembler. */
function makeCurrentOverviewSuccess(
  options: {
    readonly location?: WeatherLocation;
    readonly current?: CurrentWeather;
    readonly source?: KmaCurrentSourceMetadataInput;
  } = {},
): CurrentOverviewSuccess {
  const location = options.location ?? makeLocation();
  const current = options.current ?? makeCurrent();
  const source = options.source ?? makeCurrentSource();
  const overview = assembleKmaCurrentWeatherOverview({ location, current, source });
  return { ok: true, overview };
}

/** A fresh current `LOCATION`-stage failure. */
function makeCurrentLocationFailure(): Extract<CurrentFailure, { readonly stage: 'LOCATION' }> {
  return { ok: false, stage: 'LOCATION', error: { kind: 'UNSUPPORTED_LOCATION' } };
}

/** A fresh current `PROVIDER`-stage failure. */
function makeCurrentProviderFailure(
  error: KmaCurrentObservationProviderError = { kind: 'TIMEOUT' },
): Extract<CurrentFailure, { readonly stage: 'PROVIDER' }> {
  return { ok: false, stage: 'PROVIDER', error };
}

/** A fresh current `NORMALIZATION`-stage failure. */
function makeCurrentNormalizationFailure(
  issues: readonly KmaCurrentNormalizationIssue[] = [
    { field: 'temperatureCelsius', reason: 'ABSENT' },
  ],
): Extract<CurrentFailure, { readonly stage: 'NORMALIZATION' }> {
  return { ok: false, stage: 'NORMALIZATION', issues };
}

/** A fresh caller input (`product` + `location`). */
function makeInput(
  overrides: {
    readonly product?: KmaForecastProduct;
    readonly location?: WeatherLocation;
  } = {},
): KmaLocationCurrentHourlyOverviewInput {
  return {
    product: overrides.product ?? SHORT,
    location: overrides.location ?? makeLocation(),
  };
}

// ---------------------------------------------------------------------------
// Deferred promise helper (for the execution-order test).
// ---------------------------------------------------------------------------

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Collaborator stubs — hourly overview service.
// ---------------------------------------------------------------------------

interface HourlyCall {
  readonly input: KmaLocationHourlyOverviewInput;
  readonly options: KmaLocationHourlyOverviewOptions | undefined;
}

function createHourlyServiceStub(
  respond: (
    input: KmaLocationHourlyOverviewInput,
    options: KmaLocationHourlyOverviewOptions | undefined,
  ) => Promise<KmaLocationHourlyOverviewResult>,
) {
  const calls: HourlyCall[] = [];
  const fetchHourlyWeatherOverviewForLocation = vi.fn(
    (
      input: KmaLocationHourlyOverviewInput,
      options?: KmaLocationHourlyOverviewOptions,
    ): Promise<KmaLocationHourlyOverviewResult> => {
      calls.push({ input, options });
      return respond(input, options);
    },
  );
  const service: KmaLocationHourlyOverviewService = { fetchHourlyWeatherOverviewForLocation };
  return { service, fetchHourlyWeatherOverviewForLocation, calls };
}

function resolvingHourlyService(result: KmaLocationHourlyOverviewResult) {
  return createHourlyServiceStub(() => Promise.resolve(result));
}

function throwingHourlyService(error: unknown) {
  const fetchHourlyWeatherOverviewForLocation = vi.fn((): Promise<KmaLocationHourlyOverviewResult> => {
    throw error;
  });
  const service: KmaLocationHourlyOverviewService = { fetchHourlyWeatherOverviewForLocation };
  return { service, fetchHourlyWeatherOverviewForLocation };
}

// ---------------------------------------------------------------------------
// Collaborator stubs — current overview service.
// ---------------------------------------------------------------------------

interface CurrentCall {
  readonly input: { readonly location: WeatherLocation };
  readonly options: KmaLocationCurrentOverviewOptions | undefined;
}

function createCurrentServiceStub(
  respond: (
    input: { readonly location: WeatherLocation },
    options: KmaLocationCurrentOverviewOptions | undefined,
  ) => Promise<KmaLocationCurrentOverviewResult>,
) {
  const calls: CurrentCall[] = [];
  const fetchCurrentWeatherOverviewForLocation = vi.fn(
    (
      input: { readonly location: WeatherLocation },
      options?: KmaLocationCurrentOverviewOptions,
    ): Promise<KmaLocationCurrentOverviewResult> => {
      calls.push({ input, options });
      return respond(input, options);
    },
  );
  const service: KmaLocationCurrentOverviewService = { fetchCurrentWeatherOverviewForLocation };
  return { service, fetchCurrentWeatherOverviewForLocation, calls };
}

function resolvingCurrentService(result: KmaLocationCurrentOverviewResult) {
  return createCurrentServiceStub(() => Promise.resolve(result));
}

function throwingCurrentService(error: unknown) {
  const fetchCurrentWeatherOverviewForLocation = vi.fn(
    (): Promise<KmaLocationCurrentOverviewResult> => {
      throw error;
    },
  );
  const service: KmaLocationCurrentOverviewService = { fetchCurrentWeatherOverviewForLocation };
  return { service, fetchCurrentWeatherOverviewForLocation };
}

/** A current service that must never run — throws loudly if it is ever called. */
function neverCurrentService() {
  const fetchCurrentWeatherOverviewForLocation = vi.fn(
    (): Promise<KmaLocationCurrentOverviewResult> => {
      throw new Error('test setup: current service was called but should not have been');
    },
  );
  const service: KmaLocationCurrentOverviewService = { fetchCurrentWeatherOverviewForLocation };
  return { service, fetchCurrentWeatherOverviewForLocation };
}

/** A `spyAssembler` wrapping the real PR #76 assembler verbatim, recording inputs and returns. */
function spyAssembler() {
  const calls: KmaCurrentHourlyWeatherOverviewInput[] = [];
  const returns: WeatherOverview[] = [];
  const assemble = vi.fn((input: KmaCurrentHourlyWeatherOverviewInput): WeatherOverview => {
    calls.push(input);
    const overview = assembleKmaCurrentHourlyWeatherOverview(input);
    returns.push(overview);
    return overview;
  });
  return { assemble, calls, returns };
}

// ---------------------------------------------------------------------------
// Assertion helpers.
// ---------------------------------------------------------------------------

function expectSuccess(
  result: KmaLocationCurrentHourlyOverviewResult,
): Extract<KmaLocationCurrentHourlyOverviewResult, { readonly ok: true }> {
  if (!result.ok) {
    throw new Error('expected an application success result');
  }
  return result;
}

function captureSynchronousError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Construction is side-effect-free.
// ---------------------------------------------------------------------------

describe('createKmaLocationCurrentHourlyOverviewService — construction', () => {
  it('calls no collaborator on construction alone', () => {
    const { service: hourlyService, fetchHourlyWeatherOverviewForLocation } =
      resolvingHourlyService(makeHourlyOverviewSuccess());
    const { service: currentService, fetchCurrentWeatherOverviewForLocation } =
      resolvingCurrentService(makeCurrentOverviewSuccess());
    const { assemble } = spyAssembler();

    createKmaLocationCurrentHourlyOverviewService(hourlyService, currentService, assemble);

    expect(fetchHourlyWeatherOverviewForLocation).not.toHaveBeenCalled();
    expect(fetchCurrentWeatherOverviewForLocation).not.toHaveBeenCalled();
    expect(assemble).not.toHaveBeenCalled();
  });

  it('exposes exactly one public method key that is callable', () => {
    const { service: hourlyService } = resolvingHourlyService(makeHourlyOverviewSuccess());
    const { service: currentService } = resolvingCurrentService(makeCurrentOverviewSuccess());

    const service = createKmaLocationCurrentHourlyOverviewService(hourlyService, currentService);

    expect(Object.keys(service)).toEqual(['fetchCurrentHourlyWeatherOverviewForLocation']);
    expect(typeof service.fetchCurrentHourlyWeatherOverviewForLocation).toBe('function');
  });

  it('builds a distinct service and method reference on each construction', () => {
    const { service: hourlyService } = resolvingHourlyService(makeHourlyOverviewSuccess());
    const { service: currentService } = resolvingCurrentService(makeCurrentOverviewSuccess());

    const first = createKmaLocationCurrentHourlyOverviewService(hourlyService, currentService);
    const second = createKmaLocationCurrentHourlyOverviewService(hourlyService, currentService);

    expect(first).not.toBe(second);
    expect(first.fetchCurrentHourlyWeatherOverviewForLocation).not.toBe(
      second.fetchCurrentHourlyWeatherOverviewForLocation,
    );
  });
});

// ---------------------------------------------------------------------------
// Hourly LOCATION failure — current/assembler never run.
// ---------------------------------------------------------------------------

describe('fetchCurrentHourlyWeatherOverviewForLocation — hourly LOCATION failure', () => {
  it('returns the exact hourly LOCATION result and never calls current or assembler', async () => {
    const failure = makeHourlyLocationFailure();
    const { service: hourlyService, fetchHourlyWeatherOverviewForLocation } =
      resolvingHourlyService(failure);
    const { service: currentService, fetchCurrentWeatherOverviewForLocation } =
      neverCurrentService();
    const { assemble } = spyAssembler();
    const service = createKmaLocationCurrentHourlyOverviewService(
      hourlyService,
      currentService,
      assemble,
    );

    const result = await service.fetchCurrentHourlyWeatherOverviewForLocation(makeInput());

    expect(result).toBe(failure);
    expect(fetchHourlyWeatherOverviewForLocation).toHaveBeenCalledTimes(1);
    expect(fetchCurrentWeatherOverviewForLocation).not.toHaveBeenCalled();
    expect(assemble).not.toHaveBeenCalled();

    const record = result as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual([...LOCATION_KEYS]);
    expect(Object.prototype.hasOwnProperty.call(record, 'overview')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(record, 'selection')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Current success — full orchestration and reference identity.
// ---------------------------------------------------------------------------

describe('fetchCurrentHourlyWeatherOverviewForLocation — current success', () => {
  it('runs hourly then current with a fresh current input, aggregates via the real assembler', async () => {
    const hourlyResultFixture = makeHourlyOverviewSuccess();
    const { service: hourlyService, fetchHourlyWeatherOverviewForLocation, calls: hourlyCalls } =
      resolvingHourlyService(hourlyResultFixture);
    const currentResultFixture = makeCurrentOverviewSuccess({
      location: hourlyResultFixture.overview.location,
    });
    const {
      service: currentService,
      fetchCurrentWeatherOverviewForLocation,
      calls: currentCalls,
    } = resolvingCurrentService(currentResultFixture);
    const { assemble, calls: assemblerCalls, returns: assemblerReturns } = spyAssembler();
    const service = createKmaLocationCurrentHourlyOverviewService(
      hourlyService,
      currentService,
      assemble,
    );

    const input = makeInput();
    const options = { signal: new AbortController().signal };

    const result = expectSuccess(
      await service.fetchCurrentHourlyWeatherOverviewForLocation(input, options),
    );

    // Hourly ran exactly once with the exact caller input reference.
    expect(fetchHourlyWeatherOverviewForLocation).toHaveBeenCalledTimes(1);
    expect(hourlyCalls[0].input).toBe(input);
    expect(hourlyCalls[0].options).toBe(options);

    // Current ran exactly once, only after hourly resolved, with a fresh input containing
    // exactly `{ location }` — the hourly baseline's own parsed location by exact reference.
    expect(fetchCurrentWeatherOverviewForLocation).toHaveBeenCalledTimes(1);
    expect(Object.keys(currentCalls[0].input).sort()).toEqual(['location']);
    expect(currentCalls[0].input).not.toBe(input);
    expect(currentCalls[0].input.location).toBe(hourlyResultFixture.overview.location);
    expect(currentCalls[0].options).toBe(options);

    // Assembler ran once with the exact hourly/current success references.
    expect(assemble).toHaveBeenCalledTimes(1);
    expect(assemblerCalls[0].hourly).toBe(hourlyResultFixture);
    expect(assemblerCalls[0].current).toBe(currentResultFixture);
    expect(result.overview).toBe(assemblerReturns[0]);

    // Result stays hourly-result-compatible: exactly ok/selection/overview.
    expect(Object.keys(result).sort()).toEqual([...SUCCESS_KEYS]);
    expect(result.selection).toBe(hourlyResultFixture.selection);

    expect(weatherOverview.safeParse(result.overview).success).toBe(true);
    expect(result.overview.current).toEqual(currentResultFixture.overview.current);
    expect(result.overview.hourly).toEqual(hourlyResultFixture.overview.hourly);
    expect(result.overview.missingSections).not.toContain('CURRENT');
    expect(result.overview.missingSections).not.toContain('HOURLY');
  });
});

// ---------------------------------------------------------------------------
// All current `ok:false` stages degrade uniformly.
// ---------------------------------------------------------------------------

describe('fetchCurrentHourlyWeatherOverviewForLocation — current degradation', () => {
  const currentFailureCases: ReadonlyArray<{
    readonly name: string;
    readonly make: () => CurrentFailure;
  }> = [
    { name: 'LOCATION', make: makeCurrentLocationFailure },
    { name: 'PROVIDER', make: makeCurrentProviderFailure },
    { name: 'NORMALIZATION', make: makeCurrentNormalizationFailure },
  ];

  for (const { name, make } of currentFailureCases) {
    it(`degrades a resolved current ${name} failure to current:null without exposing it`, async () => {
      const hourlyResultFixture = makeHourlyOverviewSuccess();
      const { service: hourlyService } = resolvingHourlyService(hourlyResultFixture);
      const currentFailure = make();
      const { service: currentService, fetchCurrentWeatherOverviewForLocation } =
        resolvingCurrentService(currentFailure);
      const { assemble, calls: assemblerCalls } = spyAssembler();
      const service = createKmaLocationCurrentHourlyOverviewService(
        hourlyService,
        currentService,
        assemble,
      );

      const result = expectSuccess(
        await service.fetchCurrentHourlyWeatherOverviewForLocation(makeInput()),
      );

      expect(fetchCurrentWeatherOverviewForLocation).toHaveBeenCalledTimes(1);
      expect(assemble).toHaveBeenCalledTimes(1);
      expect(assemblerCalls[0].hourly).toBe(hourlyResultFixture);
      expect(assemblerCalls[0].current).toBeNull();

      // Nothing about the failed current stage leaks into the combined result.
      expect(Object.keys(result).sort()).toEqual([...SUCCESS_KEYS]);
      expect(result.selection).toBe(hourlyResultFixture.selection);
      expect(JSON.stringify(result)).not.toContain('stage');
      expect(JSON.stringify(result)).not.toContain(name);

      // The overview reflects current unavailability through the assembler's own policy.
      expect(result.overview.current).toBeNull();
      expect(result.overview.missingSections).toContain('CURRENT');
    });
  }
});

// ---------------------------------------------------------------------------
// Hourly no-selection still attempts current.
// ---------------------------------------------------------------------------

describe('fetchCurrentHourlyWeatherOverviewForLocation — hourly no-selection', () => {
  it('still calls current once, and a current success yields CURRENT present + HOURLY missing', async () => {
    const hourlyResultFixture = makeHourlyOverviewSuccess({ noSelection: true });
    const { service: hourlyService } = resolvingHourlyService(hourlyResultFixture);
    const currentResultFixture = makeCurrentOverviewSuccess({
      location: hourlyResultFixture.overview.location,
    });
    const { service: currentService, fetchCurrentWeatherOverviewForLocation } =
      resolvingCurrentService(currentResultFixture);
    const service = createKmaLocationCurrentHourlyOverviewService(hourlyService, currentService);

    const result = expectSuccess(
      await service.fetchCurrentHourlyWeatherOverviewForLocation(makeInput()),
    );

    expect(fetchCurrentWeatherOverviewForLocation).toHaveBeenCalledTimes(1);
    expect(result.overview.current).not.toBeNull();
    expect(result.overview.missingSections).toContain('HOURLY');
    expect(result.overview.missingSections).not.toContain('CURRENT');
  });

  it('still calls current once, and a current failure yields both CURRENT and HOURLY missing', async () => {
    const hourlyResultFixture = makeHourlyOverviewSuccess({ noSelection: true });
    const { service: hourlyService } = resolvingHourlyService(hourlyResultFixture);
    const { service: currentService, fetchCurrentWeatherOverviewForLocation } =
      resolvingCurrentService(makeCurrentProviderFailure());
    const service = createKmaLocationCurrentHourlyOverviewService(hourlyService, currentService);

    const result = expectSuccess(
      await service.fetchCurrentHourlyWeatherOverviewForLocation(makeInput()),
    );

    expect(fetchCurrentWeatherOverviewForLocation).toHaveBeenCalledTimes(1);
    expect(result.overview.current).toBeNull();
    expect(result.overview.missingSections).toContain('HOURLY');
    expect(result.overview.missingSections).toContain('CURRENT');
  });
});

// ---------------------------------------------------------------------------
// Execution order — sequential, not concurrent.
// ---------------------------------------------------------------------------

describe('fetchCurrentHourlyWeatherOverviewForLocation — execution order', () => {
  it('runs current only after hourly resolves, never eagerly or in parallel', async () => {
    const deferred = createDeferred<KmaLocationHourlyOverviewResult>();
    const { service: hourlyService, fetchHourlyWeatherOverviewForLocation } =
      createHourlyServiceStub(() => deferred.promise);
    const { service: currentService, fetchCurrentWeatherOverviewForLocation } =
      resolvingCurrentService(makeCurrentOverviewSuccess());
    const { assemble } = spyAssembler();
    const service = createKmaLocationCurrentHourlyOverviewService(
      hourlyService,
      currentService,
      assemble,
    );

    const resultPromise = service.fetchCurrentHourlyWeatherOverviewForLocation(makeInput());

    // Before hourly resolves: hourly ran once, current and assembler have not run at all.
    expect(fetchHourlyWeatherOverviewForLocation).toHaveBeenCalledTimes(1);
    expect(fetchCurrentWeatherOverviewForLocation).not.toHaveBeenCalled();
    expect(assemble).not.toHaveBeenCalled();

    deferred.resolve(makeHourlyOverviewSuccess());
    await resultPromise;

    // Only after hourly resolves does current (and then the assembler) run.
    expect(fetchCurrentWeatherOverviewForLocation).toHaveBeenCalledTimes(1);
    expect(assemble).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Options / AbortSignal identity.
// ---------------------------------------------------------------------------

describe('fetchCurrentHourlyWeatherOverviewForLocation — options identity', () => {
  it('forwards the exact same options reference to both hourly and current', async () => {
    const { service: hourlyService, calls: hourlyCalls } = resolvingHourlyService(
      makeHourlyOverviewSuccess(),
    );
    const { service: currentService, calls: currentCalls } = resolvingCurrentService(
      makeCurrentOverviewSuccess(),
    );
    const service = createKmaLocationCurrentHourlyOverviewService(hourlyService, currentService);

    const options: KmaLocationCurrentHourlyOverviewOptions = {
      signal: new AbortController().signal,
    };
    await service.fetchCurrentHourlyWeatherOverviewForLocation(makeInput(), options);

    expect(hourlyCalls[0].options).toBe(options);
    expect(currentCalls[0].options).toBe(options);
    expect(hourlyCalls[0].options?.signal).toBe(options.signal);
    expect(currentCalls[0].options?.signal).toBe(options.signal);
  });

  it('forwards exactly undefined (never a synthesized {}) to both when options are omitted', async () => {
    const { service: hourlyService, fetchHourlyWeatherOverviewForLocation, calls: hourlyCalls } =
      resolvingHourlyService(makeHourlyOverviewSuccess());
    const {
      service: currentService,
      fetchCurrentWeatherOverviewForLocation,
      calls: currentCalls,
    } = resolvingCurrentService(makeCurrentOverviewSuccess());
    const service = createKmaLocationCurrentHourlyOverviewService(hourlyService, currentService);

    await service.fetchCurrentHourlyWeatherOverviewForLocation(makeInput());

    expect(fetchHourlyWeatherOverviewForLocation.mock.calls[0][1]).toBeUndefined();
    expect(fetchCurrentWeatherOverviewForLocation.mock.calls[0][1]).toBeUndefined();
    expect(hourlyCalls[0].options).toBeUndefined();
    expect(currentCalls[0].options).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Throw / rejection propagation.
// ---------------------------------------------------------------------------

describe('fetchCurrentHourlyWeatherOverviewForLocation — error propagation', () => {
  it('propagates a hourly synchronous throw synchronously, running no downstream', () => {
    const sentinel = new Error('HOURLY_SYNC_THROW_SENTINEL');
    const { service: hourlyService, fetchHourlyWeatherOverviewForLocation } =
      throwingHourlyService(sentinel);
    const { service: currentService, fetchCurrentWeatherOverviewForLocation } =
      neverCurrentService();
    const { assemble } = spyAssembler();
    const service = createKmaLocationCurrentHourlyOverviewService(
      hourlyService,
      currentService,
      assemble,
    );

    let returned: unknown;
    const caught = captureSynchronousError(() => {
      returned = service.fetchCurrentHourlyWeatherOverviewForLocation(makeInput());
    });

    expect(caught).toBe(sentinel);
    expect(returned).toBeUndefined();
    expect(fetchHourlyWeatherOverviewForLocation).toHaveBeenCalledTimes(1);
    expect(fetchCurrentWeatherOverviewForLocation).not.toHaveBeenCalled();
    expect(assemble).not.toHaveBeenCalled();
  });

  it('propagates a hourly rejection as the same reference, running no downstream', async () => {
    const sentinel = new Error('HOURLY_REJECTION_SENTINEL');
    const { service: hourlyService } = createHourlyServiceStub(() =>
      Promise.reject<KmaLocationHourlyOverviewResult>(sentinel),
    );
    const { service: currentService, fetchCurrentWeatherOverviewForLocation } =
      neverCurrentService();
    const { assemble } = spyAssembler();
    const service = createKmaLocationCurrentHourlyOverviewService(
      hourlyService,
      currentService,
      assemble,
    );

    await expect(
      service.fetchCurrentHourlyWeatherOverviewForLocation(makeInput()),
    ).rejects.toBe(sentinel);

    expect(fetchCurrentWeatherOverviewForLocation).not.toHaveBeenCalled();
    expect(assemble).not.toHaveBeenCalled();
  });

  it('propagates a current synchronous throw as a rejection (not a synchronous throw)', async () => {
    const sentinel = new Error('CURRENT_SYNC_THROW_SENTINEL');
    const { service: hourlyService } = resolvingHourlyService(makeHourlyOverviewSuccess());
    const { service: currentService, fetchCurrentWeatherOverviewForLocation } =
      throwingCurrentService(sentinel);
    const { assemble } = spyAssembler();
    const service = createKmaLocationCurrentHourlyOverviewService(
      hourlyService,
      currentService,
      assemble,
    );

    const returned = service.fetchCurrentHourlyWeatherOverviewForLocation(makeInput());
    expect(returned).toBeInstanceOf(Promise);

    await expect(returned).rejects.toBe(sentinel);

    expect(fetchCurrentWeatherOverviewForLocation).toHaveBeenCalledTimes(1);
    expect(assemble).not.toHaveBeenCalled();
  });

  it('propagates a current rejection as the same reference, running no assembler', async () => {
    const sentinel = new Error('CURRENT_REJECTION_SENTINEL');
    const { service: hourlyService } = resolvingHourlyService(makeHourlyOverviewSuccess());
    const { service: currentService } = createCurrentServiceStub(() =>
      Promise.reject<KmaLocationCurrentOverviewResult>(sentinel),
    );
    const { assemble } = spyAssembler();
    const service = createKmaLocationCurrentHourlyOverviewService(
      hourlyService,
      currentService,
      assemble,
    );

    await expect(
      service.fetchCurrentHourlyWeatherOverviewForLocation(makeInput()),
    ).rejects.toBe(sentinel);

    expect(assemble).not.toHaveBeenCalled();
  });

  it('propagates an assembler throw as the same rejection', async () => {
    const sentinel = new Error('ASSEMBLER_SENTINEL');
    const throwingAssembler = vi.fn((): WeatherOverview => {
      throw sentinel;
    });
    const { service: hourlyService } = resolvingHourlyService(makeHourlyOverviewSuccess());
    const { service: currentService } = resolvingCurrentService(makeCurrentOverviewSuccess());
    const service = createKmaLocationCurrentHourlyOverviewService(
      hourlyService,
      currentService,
      throwingAssembler,
    );

    await expect(
      service.fetchCurrentHourlyWeatherOverviewForLocation(makeInput()),
    ).rejects.toBe(sentinel);

    expect(throwingAssembler).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Integration-style aggregation, using the real PR #76 assembler by default.
// ---------------------------------------------------------------------------

describe('fetchCurrentHourlyWeatherOverviewForLocation — integration aggregation', () => {
  it('hourly selected + current success: CURRENT and HOURLY both present, current sources first', async () => {
    const hourlyResultFixture = makeHourlyOverviewSuccess();
    const { service: hourlyService } = resolvingHourlyService(hourlyResultFixture);
    const currentResultFixture = makeCurrentOverviewSuccess({
      location: hourlyResultFixture.overview.location,
    });
    const { service: currentService } = resolvingCurrentService(currentResultFixture);
    const service = createKmaLocationCurrentHourlyOverviewService(hourlyService, currentService);

    const result = expectSuccess(
      await service.fetchCurrentHourlyWeatherOverviewForLocation(makeInput()),
    );

    expect(result.overview.current).not.toBeNull();
    expect(result.overview.hourly.length).toBeGreaterThan(0);
    expect(result.overview.sources[0].sections).toEqual(['CURRENT']);
    expect(result.overview.sources[result.overview.sources.length - 1].sections).toEqual([
      'HOURLY',
    ]);
  });

  it('hourly selected + current failure: current null, CURRENT missing, hourly remains present', async () => {
    const hourlyResultFixture = makeHourlyOverviewSuccess();
    const { service: hourlyService } = resolvingHourlyService(hourlyResultFixture);
    const { service: currentService } = resolvingCurrentService(makeCurrentLocationFailure());
    const service = createKmaLocationCurrentHourlyOverviewService(hourlyService, currentService);

    const result = expectSuccess(
      await service.fetchCurrentHourlyWeatherOverviewForLocation(makeInput()),
    );

    expect(result.overview.current).toBeNull();
    expect(result.overview.missingSections).toContain('CURRENT');
    expect(result.overview.hourly.length).toBeGreaterThan(0);
  });

  it('hourly no-selection + current success: current present, HOURLY missing', async () => {
    const hourlyResultFixture = makeHourlyOverviewSuccess({ noSelection: true });
    const { service: hourlyService } = resolvingHourlyService(hourlyResultFixture);
    const currentResultFixture = makeCurrentOverviewSuccess({
      location: hourlyResultFixture.overview.location,
    });
    const { service: currentService } = resolvingCurrentService(currentResultFixture);
    const service = createKmaLocationCurrentHourlyOverviewService(hourlyService, currentService);

    const result = expectSuccess(
      await service.fetchCurrentHourlyWeatherOverviewForLocation(makeInput()),
    );

    expect(result.overview.current).not.toBeNull();
    expect(result.overview.missingSections).toContain('HOURLY');
  });
});

// ---------------------------------------------------------------------------
// Result compatibility — the combined result stays exactly
// KmaLocationHourlyOverviewResult-compatible (compile-time and runtime).
// ---------------------------------------------------------------------------

describe('fetchCurrentHourlyWeatherOverviewForLocation — result compatibility', () => {
  it('is assignable to KmaLocationHourlyOverviewResult and shares its exact key sets', async () => {
    const { service: hourlyService } = resolvingHourlyService(makeHourlyOverviewSuccess());
    const { service: currentService } = resolvingCurrentService(makeCurrentOverviewSuccess());
    const service = createKmaLocationCurrentHourlyOverviewService(hourlyService, currentService);

    const successResult = await service.fetchCurrentHourlyWeatherOverviewForLocation(
      makeInput(),
    );

    // Compile-time: no cast needed — the type alias makes this a structural identity.
    const compatSuccess: KmaLocationHourlyOverviewResult = successResult;
    expect(Object.keys(compatSuccess).sort()).toEqual([...SUCCESS_KEYS]);

    const failure = makeHourlyLocationFailure();
    const { service: locationHourlyService } = resolvingHourlyService(failure);
    const { service: neverCurrent } = neverCurrentService();
    const locationService = createKmaLocationCurrentHourlyOverviewService(
      locationHourlyService,
      neverCurrent,
    );
    const locationResult = await locationService.fetchCurrentHourlyWeatherOverviewForLocation(
      makeInput(),
    );
    const compatFailure: KmaLocationHourlyOverviewResult = locationResult;
    expect(Object.keys(compatFailure).sort()).toEqual([...LOCATION_KEYS]);
  });
});

// ---------------------------------------------------------------------------
// Immutability.
// ---------------------------------------------------------------------------

describe('fetchCurrentHourlyWeatherOverviewForLocation — immutability', () => {
  it('does not mutate the caller input or options across a full run', async () => {
    const { service: hourlyService } = resolvingHourlyService(makeHourlyOverviewSuccess());
    const { service: currentService } = resolvingCurrentService(makeCurrentOverviewSuccess());
    const service = createKmaLocationCurrentHourlyOverviewService(hourlyService, currentService);

    const input = makeInput();
    const options = { signal: new AbortController().signal };
    const inputSnapshot = JSON.stringify(input);

    await service.fetchCurrentHourlyWeatherOverviewForLocation(input, options);

    expect(JSON.stringify(input)).toBe(inputSnapshot);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('assembles correctly from deeply frozen input, options, hourly result, and current result', async () => {
    const hourlyResultFixture = deepFreeze(makeHourlyOverviewSuccess());
    const { service: hourlyService } = resolvingHourlyService(hourlyResultFixture);
    const currentResultFixture = deepFreeze(
      makeCurrentOverviewSuccess({ location: hourlyResultFixture.overview.location }),
    );
    const { service: currentService } = resolvingCurrentService(currentResultFixture);
    const service = createKmaLocationCurrentHourlyOverviewService(hourlyService, currentService);

    const input = deepFreeze(makeInput());
    const options = Object.freeze<KmaLocationCurrentHourlyOverviewOptions>({
      signal: new AbortController().signal,
    });

    const result = expectSuccess(
      await service.fetchCurrentHourlyWeatherOverviewForLocation(input, options),
    );

    expect(weatherOverview.safeParse(result.overview).success).toBe(true);
  });

  it('returns fresh, independent success wrappers on repeated calls', async () => {
    const { service: hourlyService } = resolvingHourlyService(makeHourlyOverviewSuccess());
    const { service: currentService } = resolvingCurrentService(makeCurrentOverviewSuccess());
    const service = createKmaLocationCurrentHourlyOverviewService(hourlyService, currentService);

    const first = expectSuccess(
      await service.fetchCurrentHourlyWeatherOverviewForLocation(makeInput()),
    );
    const second = expectSuccess(
      await service.fetchCurrentHourlyWeatherOverviewForLocation(makeInput()),
    );

    expect(first).not.toBe(second);
    expect(first.overview).not.toBe(second.overview);
  });
});
