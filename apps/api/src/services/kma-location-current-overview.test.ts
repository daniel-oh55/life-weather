import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  currentWeather,
  weatherLocation,
  weatherOverview,
  type CurrentWeather,
  type WeatherLocation,
  type WeatherOverview,
} from '@life-weather/contracts';

import type {
  KmaCurrentNormalizationIssue,
  KmaCurrentObservationProviderError,
} from '../providers/kma/index.js';
import type { KmaCurrentSourceMetadataInput } from './kma-current-weather-overview.js';
import type { KmaCurrentSourceMetadataResolver } from './kma-current-source-metadata.js';
import type {
  KmaLocationScheduledCurrentObservationFacade,
  KmaLocationScheduledCurrentObservationInput,
  KmaLocationScheduledCurrentObservationOptions,
  KmaLocationScheduledCurrentObservationResult,
} from './kma-location-scheduled-current-observation.js';
import {
  createKmaLocationCurrentOverviewService,
  type KmaLocationCurrentOverviewInput,
  type KmaLocationCurrentOverviewOptions,
  type KmaLocationCurrentOverviewResult,
} from './kma-location-current-overview.js';
import { assembleKmaCurrentWeatherOverview } from './kma-current-weather-overview.js';

/**
 * These tests exercise the PR #74 application service in isolation. The two boundary collaborators —
 * the PR #70 location scheduled current-observation facade and the nullary current source metadata
 * resolver — are fresh fakes built inside each test (never shared at describe scope), so call
 * counts, argument identity, and Promise identity are directly assertable. The default integration
 * tests use the **real** PR #72/#73 assembler; only the error-propagation tests inject a throwing
 * assembler.
 */

// ---------------------------------------------------------------------------
// Exact key contracts.
// ---------------------------------------------------------------------------

/** The exact top-level own keys of an application success result, sorted. */
const SUCCESS_KEYS = ['ok', 'overview'] as const;

/** The exact top-level own keys of a LOCATION passthrough result, sorted. */
const LOCATION_KEYS = ['error', 'ok', 'stage'] as const;

/** The exact top-level own keys of a PROVIDER passthrough result, sorted. */
const PROVIDER_KEYS = ['error', 'ok', 'stage'] as const;

/** The exact top-level own keys of a NORMALIZATION passthrough result, sorted. */
const NORMALIZATION_KEYS = ['issues', 'ok', 'stage'] as const;

/** Fields that must never appear at the top level of a success result. */
const FORBIDDEN_TOP_LEVEL_KEYS = [
  'current',
  'source',
  'metadata',
  'request',
  'grid',
  'nx',
  'ny',
  'latitude',
  'longitude',
  'coordinates',
  'stage',
  'error',
  'issues',
] as const;

// ---------------------------------------------------------------------------
// Fixture builders — every mutable fixture is built fresh per call.
// ---------------------------------------------------------------------------

/** A fresh, complete, schema-valid `WeatherLocation`; overridable per field for edge cases. */
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

/** A fresh caller input (`location` only). */
function makeInput(
  overrides: { readonly location?: WeatherLocation } = {},
): KmaLocationCurrentOverviewInput {
  return {
    location: overrides.location ?? makeLocation(),
  };
}

/** A fresh, complete, schema-valid `CurrentWeather`. */
function makeCurrent(overrides: Partial<CurrentWeather> = {}): CurrentWeather {
  return {
    observedAt: '2026-08-10T06:00:00+09:00',
    condition: 'CLEAR',
    temperatureCelsius: 23.5,
    feelsLikeCelsius: null,
    humidityPercent: null,
    windSpeedMetersPerSecond: null,
    windDirectionDegrees: null,
    precipitationLastHourMillimeters: null,
    visibilityMeters: null,
    ...overrides,
  };
}

/** A fresh success facade result carrying the given (or a fresh default) `CurrentWeather`. */
function makeSuccessResult(
  current: CurrentWeather = makeCurrent(),
): Extract<KmaLocationScheduledCurrentObservationResult, { readonly ok: true }> {
  return { ok: true, current };
}

/** A fresh `LOCATION`-stage failure (value-free discriminator). */
function makeLocationFailure(): Extract<
  KmaLocationScheduledCurrentObservationResult,
  { readonly ok: false; readonly stage: 'LOCATION' }
> {
  return { ok: false, stage: 'LOCATION', error: { kind: 'UNSUPPORTED_LOCATION' } };
}

/** A fresh `PROVIDER`-stage failure wrapping the given provider error. */
function makeProviderFailure(
  error: KmaCurrentObservationProviderError = { kind: 'TIMEOUT' },
): Extract<
  KmaLocationScheduledCurrentObservationResult,
  { readonly ok: false; readonly stage: 'PROVIDER' }
> {
  return { ok: false, stage: 'PROVIDER', error };
}

/** A fresh `NORMALIZATION`-stage failure carrying the given (or a fresh default) issues. */
function makeNormalizationFailure(
  issues: readonly KmaCurrentNormalizationIssue[] = [
    { field: 'temperatureCelsius', reason: 'ABSENT' },
  ],
): Extract<
  KmaLocationScheduledCurrentObservationResult,
  { readonly ok: false; readonly stage: 'NORMALIZATION' }
> {
  return { ok: false, stage: 'NORMALIZATION', issues };
}

/** A fresh source metadata resolver output. */
function makeSourceMetadata(
  overrides: Partial<KmaCurrentSourceMetadataInput> = {},
): KmaCurrentSourceMetadataInput {
  return {
    sourceId: 'kma-ultra-short-current-observation',
    fetchedAt: '2026-08-10T06:05:00.000Z',
    retrievalMode: 'LIVE',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Collaborator stubs.
// ---------------------------------------------------------------------------

interface FacadeCall {
  readonly input: KmaLocationScheduledCurrentObservationInput;
  readonly options: KmaLocationScheduledCurrentObservationOptions | undefined;
}

/**
 * A fresh fake location facade that records each `input`/`options` (by reference) and defers to
 * `respond` for the returned Promise (or a synchronous throw). Uses `vi.fn` so call count and
 * argument identity are directly assertable.
 */
function createFacadeStub(
  respond: (
    input: KmaLocationScheduledCurrentObservationInput,
    options: KmaLocationScheduledCurrentObservationOptions | undefined,
  ) => Promise<KmaLocationScheduledCurrentObservationResult>,
) {
  const calls: FacadeCall[] = [];
  const fetchScheduledCurrentWeatherForLocation = vi.fn(
    (
      input: KmaLocationScheduledCurrentObservationInput,
      options?: KmaLocationScheduledCurrentObservationOptions,
    ): Promise<KmaLocationScheduledCurrentObservationResult> => {
      calls.push({ input, options });
      return respond(input, options);
    },
  );
  const facade: KmaLocationScheduledCurrentObservationFacade = {
    fetchScheduledCurrentWeatherForLocation,
  };
  return { facade, fetchScheduledCurrentWeatherForLocation, calls };
}

/** A facade stub that always resolves with the given result. */
function resolvingFacade(result: KmaLocationScheduledCurrentObservationResult) {
  return createFacadeStub(() => Promise.resolve(result));
}

/** A fresh resolver stub that records call count and returns `output`. */
function createResolver(output: KmaCurrentSourceMetadataInput = makeSourceMetadata()) {
  const resolver = vi.fn((): KmaCurrentSourceMetadataInput => output);
  return { resolver, output };
}

/** A resolver that must never run — throws loudly if it is ever called. */
function neverResolver() {
  return vi.fn((): KmaCurrentSourceMetadataInput => {
    throw new Error('test setup: resolver was called but should not have been');
  });
}

/** A `spyAssembler` wrapping the real PR #72/#73 assembler verbatim, recording inputs and returns. */
function spyAssembler() {
  const calls: Parameters<typeof assembleKmaCurrentWeatherOverview>[0][] = [];
  const returns: WeatherOverview[] = [];
  const assemble = vi.fn(
    (input: Parameters<typeof assembleKmaCurrentWeatherOverview>[0]): WeatherOverview => {
      calls.push(input);
      const overview = assembleKmaCurrentWeatherOverview(input);
      returns.push(overview);
      return overview;
    },
  );
  return { assemble, calls, returns };
}

// ---------------------------------------------------------------------------
// Assertion / spy helpers.
// ---------------------------------------------------------------------------

/** Assert a success result has exactly `ok`/`overview` and no forbidden top-level key. */
function expectSuccessKeys(result: KmaLocationCurrentOverviewResult): void {
  const record = result as Record<string, unknown>;
  expect(Object.keys(record).sort()).toEqual([...SUCCESS_KEYS]);
  for (const key of FORBIDDEN_TOP_LEVEL_KEYS) {
    expect(Object.prototype.hasOwnProperty.call(record, key)).toBe(false);
  }
}

/** Narrow a result to the success arm or fail the test loudly. */
function expectSuccess(
  result: KmaLocationCurrentOverviewResult,
): Extract<KmaLocationCurrentOverviewResult, { readonly ok: true }> {
  if (!result.ok) {
    throw new Error('expected an application success result');
  }
  return result;
}

/** Capture whatever a thunk throws synchronously, or `undefined` when it does not throw. */
function captureSynchronousError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Spy on the three console methods; each returns a no-op mock. */
function spyOnConsole() {
  return {
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
  };
}

/** Assert none of the three console spies was called. */
function expectSilent(spies: ReturnType<typeof spyOnConsole>): void {
  expect(spies.log).not.toHaveBeenCalled();
  expect(spies.warn).not.toHaveBeenCalled();
  expect(spies.error).not.toHaveBeenCalled();
}

/** Recursively freeze so any attempted mutation would throw in strict mode. */
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
// Fixture sanity.
// ---------------------------------------------------------------------------

describe('fixture sanity', () => {
  it('builds contracts-valid CurrentWeather and WeatherLocation fixtures', () => {
    expect(currentWeather.safeParse(makeCurrent()).success).toBe(true);
    expect(weatherLocation.safeParse(makeLocation()).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Construction is side-effect-free.
// ---------------------------------------------------------------------------

describe('createKmaLocationCurrentOverviewService — construction', () => {
  it('calls no collaborator and reads no clock/console on construction alone', () => {
    const spies = spyOnConsole();
    const nowSpy = vi.spyOn(Date, 'now');
    const { facade, fetchScheduledCurrentWeatherForLocation } = resolvingFacade(
      makeSuccessResult(),
    );
    const { resolver } = createResolver();
    const { assemble } = spyAssembler();

    createKmaLocationCurrentOverviewService(facade, resolver, assemble);

    expect(fetchScheduledCurrentWeatherForLocation).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
    expect(assemble).not.toHaveBeenCalled();
    expect(nowSpy).not.toHaveBeenCalled();
    expectSilent(spies);
  });

  it('exposes exactly one public method key that is callable', () => {
    const { facade } = resolvingFacade(makeSuccessResult());
    const { resolver } = createResolver();

    const service = createKmaLocationCurrentOverviewService(facade, resolver);

    expect(Object.keys(service)).toEqual(['fetchCurrentWeatherOverviewForLocation']);
    expect(typeof service.fetchCurrentWeatherOverviewForLocation).toBe('function');
  });

  it('builds a distinct service and method reference on each construction', () => {
    const { facade } = resolvingFacade(makeSuccessResult());
    const { resolver } = createResolver();

    const first = createKmaLocationCurrentOverviewService(facade, resolver);
    const second = createKmaLocationCurrentOverviewService(facade, resolver);

    expect(first).not.toBe(second);
    expect(first.fetchCurrentWeatherOverviewForLocation).not.toBe(
      second.fetchCurrentWeatherOverviewForLocation,
    );
  });
});

// ---------------------------------------------------------------------------
// Success path.
// ---------------------------------------------------------------------------

describe('fetchCurrentWeatherOverviewForLocation — success', () => {
  it('resolves once, assembles once, and returns a valid current-only overview', async () => {
    const current = makeCurrent();
    const { facade, fetchScheduledCurrentWeatherForLocation } = resolvingFacade(
      makeSuccessResult(current),
    );
    const source = makeSourceMetadata();
    const { resolver } = createResolver(source);
    const { assemble, calls: assemblerCalls, returns: assemblerReturns } = spyAssembler();

    const service = createKmaLocationCurrentOverviewService(facade, resolver, assemble);

    const result = expectSuccess(
      await service.fetchCurrentWeatherOverviewForLocation(makeInput()),
    );

    expect(fetchScheduledCurrentWeatherForLocation).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith();
    expect(assemble).toHaveBeenCalledTimes(1);

    // Assembler receives exact references.
    expect(assemblerCalls[0].current).toBe(current);
    expect(assemblerCalls[0].source).toBe(source);
    expect(result.overview).toBe(assemblerReturns[0]);

    expect(weatherOverview.safeParse(result.overview).success).toBe(true);
    expect(result.overview.current).toEqual(current);
    expect(result.overview.missingSections).toEqual([
      'HOURLY',
      'DAILY',
      'AIR_QUALITY_CURRENT',
      'AIR_QUALITY_FORECAST',
      'ALERTS',
    ]);
    expect(result.overview.sources).toHaveLength(1);
    expect(result.overview.sources[0].sourceId).toBe(source.sourceId);

    expectSuccessKeys(result);
  });

  it('passes the parsed location (not the caller original) to the assembler', async () => {
    const { facade } = resolvingFacade(makeSuccessResult());
    const { resolver } = createResolver();
    const { assemble, calls: assemblerCalls } = spyAssembler();
    const service = createKmaLocationCurrentOverviewService(facade, resolver, assemble);

    const input = makeInput();
    await service.fetchCurrentWeatherOverviewForLocation(input);

    expect(assemblerCalls[0].location).not.toBe(input.location);
    expect(assemblerCalls[0].location).toEqual(input.location);
  });

  it('resolver receives no arguments (nullary call)', async () => {
    const { facade } = resolvingFacade(makeSuccessResult());
    const { resolver } = createResolver();
    const service = createKmaLocationCurrentOverviewService(facade, resolver);

    await service.fetchCurrentWeatherOverviewForLocation(makeInput());

    expect(resolver.mock.calls[0]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Failure passthrough — LOCATION / PROVIDER / NORMALIZATION.
// ---------------------------------------------------------------------------

describe('fetchCurrentWeatherOverviewForLocation — failure passthrough', () => {
  const failureCases: ReadonlyArray<{
    readonly name: string;
    readonly make: () => Extract<
      KmaLocationScheduledCurrentObservationResult,
      { readonly ok: false }
    >;
    readonly keys: readonly string[];
  }> = [
    { name: 'LOCATION', make: makeLocationFailure, keys: LOCATION_KEYS },
    { name: 'PROVIDER', make: makeProviderFailure, keys: PROVIDER_KEYS },
    { name: 'NORMALIZATION', make: makeNormalizationFailure, keys: NORMALIZATION_KEYS },
  ];

  for (const { name, make, keys } of failureCases) {
    it(`returns the exact ${name} facade result and never runs resolver/assembler`, async () => {
      const failure = make();
      const { facade, fetchScheduledCurrentWeatherForLocation } = resolvingFacade(failure);
      const resolver = neverResolver();
      const { assemble } = spyAssembler();
      const service = createKmaLocationCurrentOverviewService(facade, resolver, assemble);

      const result = await service.fetchCurrentWeatherOverviewForLocation(makeInput());

      expect(result).toBe(failure);
      expect(fetchScheduledCurrentWeatherForLocation).toHaveBeenCalledTimes(1);
      expect(resolver).not.toHaveBeenCalled();
      expect(assemble).not.toHaveBeenCalled();

      const record = result as Record<string, unknown>;
      expect(Object.keys(record).sort()).toEqual([...keys].sort());
      expect(Object.prototype.hasOwnProperty.call(record, 'overview')).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Invalid WeatherLocation (synchronous ZodError, no collaborator runs).
// ---------------------------------------------------------------------------

describe('fetchCurrentWeatherOverviewForLocation — invalid WeatherLocation', () => {
  const invalidLocations: ReadonlyArray<{
    readonly name: string;
    readonly location: () => WeatherLocation;
  }> = [
    { name: 'invalid timezone', location: () => makeLocation({ timezone: 'Seoul' }) },
    { name: 'out-of-range latitude', location: () => makeLocation({ latitude: 999 }) },
    { name: 'out-of-range longitude', location: () => makeLocation({ longitude: 999 }) },
    { name: 'empty id', location: () => makeLocation({ id: '' }) },
    { name: 'empty displayName', location: () => makeLocation({ displayName: '' }) },
    { name: 'invalid countryCode', location: () => makeLocation({ countryCode: 'kr' }) },
  ];

  for (const { name, location } of invalidLocations) {
    it(`throws a synchronous ZodError for a ${name} and runs no collaborator`, () => {
      const spies = spyOnConsole();
      const { facade, fetchScheduledCurrentWeatherForLocation } = resolvingFacade(
        makeSuccessResult(),
      );
      const resolver = neverResolver();
      const { assemble } = spyAssembler();
      const service = createKmaLocationCurrentOverviewService(facade, resolver, assemble);

      const input = makeInput({ location: location() });
      const snapshot = JSON.stringify(input);

      const error = captureSynchronousError(() =>
        service.fetchCurrentWeatherOverviewForLocation(input),
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as { name?: string }).name).toBe('ZodError');
      expect(fetchScheduledCurrentWeatherForLocation).not.toHaveBeenCalled();
      expect(resolver).not.toHaveBeenCalled();
      expect(assemble).not.toHaveBeenCalled();
      expect(JSON.stringify(input)).toBe(snapshot);
      expectSilent(spies);
    });
  }
});

// ---------------------------------------------------------------------------
// Facade call boundary.
// ---------------------------------------------------------------------------

describe('fetchCurrentWeatherOverviewForLocation — facade call boundary', () => {
  it('passes a fresh { latitude, longitude } object with parsed coordinates', async () => {
    const { facade, fetchScheduledCurrentWeatherForLocation, calls } = resolvingFacade(
      makeSuccessResult(),
    );
    const { resolver } = createResolver();
    const service = createKmaLocationCurrentOverviewService(facade, resolver);

    const input = makeInput();
    await service.fetchCurrentWeatherOverviewForLocation(input);

    expect(fetchScheduledCurrentWeatherForLocation).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].input).sort()).toEqual(['latitude', 'longitude']);
    for (const forbidden of [
      'id',
      'displayName',
      'countryCode',
      'timezone',
      'adminArea1',
      'location',
    ]) {
      expect(forbidden in calls[0].input).toBe(false);
    }
    expect(calls[0].input.latitude).toBe(input.location.latitude);
    expect(calls[0].input.longitude).toBe(input.location.longitude);
    expect(calls[0].input).not.toBe(input);
    expect(calls[0].input as unknown).not.toBe(input.location);
  });

  it('forwards options by the same reference', async () => {
    const { facade, calls } = resolvingFacade(makeSuccessResult());
    const { resolver } = createResolver();
    const service = createKmaLocationCurrentOverviewService(facade, resolver);

    const options: KmaLocationCurrentOverviewOptions = {
      signal: new AbortController().signal,
    };
    await service.fetchCurrentWeatherOverviewForLocation(makeInput(), options);

    expect(calls[0].options).toBe(options);
    expect(calls[0].options?.signal).toBe(options.signal);
  });

  it('forwards exactly undefined (never a synthesized {}) when options are omitted', async () => {
    const { facade, fetchScheduledCurrentWeatherForLocation, calls } = resolvingFacade(
      makeSuccessResult(),
    );
    const { resolver } = createResolver();
    const service = createKmaLocationCurrentOverviewService(facade, resolver);

    await service.fetchCurrentWeatherOverviewForLocation(makeInput());

    expect(fetchScheduledCurrentWeatherForLocation.mock.calls[0]).toHaveLength(2);
    expect(fetchScheduledCurrentWeatherForLocation.mock.calls[0][1]).toBeUndefined();
    expect(calls[0].options).toBeUndefined();
  });

  it('accepts frozen input and options and forwards a fresh derived facade input', async () => {
    const { facade, calls } = resolvingFacade(makeSuccessResult());
    const { resolver } = createResolver();
    const service = createKmaLocationCurrentOverviewService(facade, resolver);

    const input = deepFreeze(makeInput());
    const options = Object.freeze<KmaLocationCurrentOverviewOptions>({
      signal: new AbortController().signal,
    });
    const snapshot = JSON.stringify(input);

    await service.fetchCurrentWeatherOverviewForLocation(input, options);

    expect(calls[0].input).not.toBe(input);
    expect(calls[0].options).toBe(options);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// Error / rejection propagation.
// ---------------------------------------------------------------------------

describe('fetchCurrentWeatherOverviewForLocation — error propagation', () => {
  it('propagates a facade synchronous throw synchronously, running no downstream', () => {
    const sentinel = new Error('FACADE_SYNC_THROW_SENTINEL');
    const { facade, fetchScheduledCurrentWeatherForLocation } = createFacadeStub(() => {
      throw sentinel;
    });
    const resolver = neverResolver();
    const { assemble } = spyAssembler();
    const service = createKmaLocationCurrentOverviewService(facade, resolver, assemble);

    let returned: unknown;
    const caught = captureSynchronousError(() => {
      returned = service.fetchCurrentWeatherOverviewForLocation(makeInput());
    });

    expect(caught).toBe(sentinel);
    expect(returned).toBeUndefined();
    expect(fetchScheduledCurrentWeatherForLocation).toHaveBeenCalledTimes(1);
    expect(resolver).not.toHaveBeenCalled();
    expect(assemble).not.toHaveBeenCalled();
  });

  it('propagates a facade rejection as the same rejection reason, running no downstream', async () => {
    const sentinel = new Error('FACADE_REJECTION_SENTINEL');
    const rejected =
      Promise.reject<KmaLocationScheduledCurrentObservationResult>(sentinel);
    const assertion = expect(rejected).rejects.toBe(sentinel);

    const { facade } = createFacadeStub(() => rejected);
    const resolver = neverResolver();
    const { assemble } = spyAssembler();
    const service = createKmaLocationCurrentOverviewService(facade, resolver, assemble);

    const returned = service.fetchCurrentWeatherOverviewForLocation(makeInput());
    await expect(returned).rejects.toBe(sentinel);
    await assertion;

    expect(resolver).not.toHaveBeenCalled();
    expect(assemble).not.toHaveBeenCalled();
  });

  it('propagates a resolver throw as a rejection, running no assembler', async () => {
    const sentinel = new Error('RESOLVER_SENTINEL');
    const throwingResolver: KmaCurrentSourceMetadataResolver = vi.fn(() => {
      throw sentinel;
    });
    const { facade } = resolvingFacade(makeSuccessResult());
    const { assemble } = spyAssembler();
    const service = createKmaLocationCurrentOverviewService(
      facade,
      throwingResolver,
      assemble,
    );

    await expect(
      service.fetchCurrentWeatherOverviewForLocation(makeInput()),
    ).rejects.toBe(sentinel);

    expect(throwingResolver).toHaveBeenCalledTimes(1);
    expect(assemble).not.toHaveBeenCalled();
  });

  it('propagates an assembler throw as the same rejection', async () => {
    const sentinel = new Error('ASSEMBLER_SENTINEL');
    const throwingAssembler = vi.fn((): WeatherOverview => {
      throw sentinel;
    });
    const { facade } = resolvingFacade(makeSuccessResult());
    const { resolver } = createResolver();
    const service = createKmaLocationCurrentOverviewService(
      facade,
      resolver,
      throwingAssembler,
    );

    await expect(
      service.fetchCurrentWeatherOverviewForLocation(makeInput()),
    ).rejects.toBe(sentinel);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(throwingAssembler).toHaveBeenCalledTimes(1);
  });

  it('logs nothing on any error path', async () => {
    const spies = spyOnConsole();
    const sentinel = new Error('QUIET_SENTINEL');
    const { facade } = createFacadeStub(() =>
      Promise.reject<KmaLocationScheduledCurrentObservationResult>(sentinel),
    );
    const { resolver } = createResolver();
    const service = createKmaLocationCurrentOverviewService(facade, resolver);

    await service.fetchCurrentWeatherOverviewForLocation(makeInput()).catch(() => {});

    expectSilent(spies);
  });
});

// ---------------------------------------------------------------------------
// Exact keys and leakage.
// ---------------------------------------------------------------------------

describe('fetchCurrentWeatherOverviewForLocation — exact keys and leakage', () => {
  it('success has exactly ok/overview and no forbidden top-level field', async () => {
    const { facade } = resolvingFacade(makeSuccessResult());
    const { resolver } = createResolver();
    const service = createKmaLocationCurrentOverviewService(facade, resolver);

    const result = expectSuccess(
      await service.fetchCurrentWeatherOverviewForLocation(makeInput()),
    );

    expectSuccessKeys(result);
  });

  it('LOCATION failure has exactly error/ok/stage', async () => {
    const { facade } = resolvingFacade(makeLocationFailure());
    const { resolver } = createResolver();
    const service = createKmaLocationCurrentOverviewService(facade, resolver);

    const result = await service.fetchCurrentWeatherOverviewForLocation(makeInput());

    const record = result as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual([...LOCATION_KEYS]);
  });
});

// ---------------------------------------------------------------------------
// Freshness and immutability.
// ---------------------------------------------------------------------------

describe('fetchCurrentWeatherOverviewForLocation — freshness and immutability', () => {
  it('assembles correctly from deeply frozen input and resolver output', async () => {
    const successResult = deepFreeze(makeSuccessResult());
    const { facade } = resolvingFacade(successResult);
    const output = deepFreeze(makeSourceMetadata());
    const { resolver } = createResolver(output);
    const service = createKmaLocationCurrentOverviewService(facade, resolver);

    const input = deepFreeze(makeInput());
    const options = Object.freeze<KmaLocationCurrentOverviewOptions>({
      signal: new AbortController().signal,
    });

    const result = expectSuccess(
      await service.fetchCurrentWeatherOverviewForLocation(input, options),
    );

    expect(weatherOverview.safeParse(result.overview).success).toBe(true);
    if (successResult.ok) {
      expect(result.overview.current).toEqual(successResult.current);
    }
  });

  it('does not mutate the caller input across a full run', async () => {
    const { facade } = resolvingFacade(makeSuccessResult());
    const { resolver } = createResolver();
    const service = createKmaLocationCurrentOverviewService(facade, resolver);

    const input = makeInput();
    const snapshot = JSON.stringify(input);

    await service.fetchCurrentWeatherOverviewForLocation(input);

    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('returns fresh, independent success wrappers on repeated calls', async () => {
    const { facade } = resolvingFacade(makeSuccessResult());
    const { resolver } = createResolver();
    const service = createKmaLocationCurrentOverviewService(facade, resolver);

    const first = expectSuccess(
      await service.fetchCurrentWeatherOverviewForLocation(makeInput()),
    );
    const second = expectSuccess(
      await service.fetchCurrentWeatherOverviewForLocation(makeInput()),
    );

    expect(first).not.toBe(second);
    expect(first.overview).not.toBe(second.overview);
    expect(first).toEqual(second);
  });
});

// ---------------------------------------------------------------------------
// No logging on any path.
// ---------------------------------------------------------------------------

describe('fetchCurrentWeatherOverviewForLocation — no logging', () => {
  it('never calls console.log / warn / error on success or failure paths', async () => {
    const spies = spyOnConsole();

    const success = createKmaLocationCurrentOverviewService(
      resolvingFacade(makeSuccessResult()).facade,
      createResolver().resolver,
    );
    const location = createKmaLocationCurrentOverviewService(
      resolvingFacade(makeLocationFailure()).facade,
      createResolver().resolver,
    );

    await success.fetchCurrentWeatherOverviewForLocation(makeInput());
    await location.fetchCurrentWeatherOverviewForLocation(makeInput());

    expectSilent(spies);
  });

  it('never reads the system clock (Date.now) on a full run', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    const { facade } = resolvingFacade(makeSuccessResult());
    const { resolver } = createResolver();
    const service = createKmaLocationCurrentOverviewService(facade, resolver);

    await service.fetchCurrentWeatherOverviewForLocation(makeInput());

    expect(nowSpy).not.toHaveBeenCalled();
  });
});
