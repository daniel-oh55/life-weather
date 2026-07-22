import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  hourlyForecast,
  weatherLocation,
  weatherOverview,
  type HourlyForecast,
  type WeatherLocation,
  type WeatherOverview,
} from '@life-weather/contracts';
import { KmaForecastProduct } from '@life-weather/weather-core';

import type {
  KmaForecastProviderError,
  KmaHourlyNormalizationIssue,
} from '../providers/kma';
import type { KmaHourlyFallbackReason } from './kma-hourly-fallback-eligibility';
import {
  selectKmaHourlyFallbackResult,
  type KmaHourlyFallbackSelection,
} from './kma-hourly-fallback-selection';
import type { KmaHourlyFallbackServiceResult } from './kma-hourly-fallback';
import type { KmaHourlyForecastServiceResult } from './kma-hourly-forecast';
import {
  assembleKmaHourlyWeatherOverview,
  type KmaHourlySourceMetadataInput,
  type KmaHourlyWeatherOverviewInput,
} from './kma-hourly-weather-overview';
import type {
  KmaLocationHourlyFallbackFacade,
  KmaLocationHourlyFallbackInput,
  KmaLocationHourlyFallbackOptions,
  KmaLocationHourlyFallbackResult,
} from './kma-location-hourly-fallback';
import {
  createKmaLocationHourlyOverviewService,
  type KmaLocationHourlyOverviewInput,
  type KmaLocationHourlyOverviewOptions,
  type KmaLocationHourlyOverviewResult,
  type KmaSelectedHourlySourceMetadataResolver,
  type KmaSelectedHourlySourceMetadataResolverInput,
} from './kma-location-hourly-overview';

/**
 * These tests exercise the PR #24 application service in isolation. The two boundary collaborators —
 * the PR #21 location fallback facade and the selected-source metadata resolver — are fresh fakes built
 * inside each test (never shared at describe scope), so call counts, argument identity, and Promise
 * identity are directly assertable. The default integration tests use the **real** PR #22 selector and
 * PR #23 assembler; only the specific selector/assembler error-propagation and PR #23 guard tests inject
 * custom collaborators. The `spySelector` / `spyAssembler` helpers wrap the real implementations
 * verbatim so a test can assert call counts and reference identity without changing behavior.
 */

const SHORT = KmaForecastProduct.SHORT_FORECAST;

// ---------------------------------------------------------------------------
// Exact key contracts — success and LOCATION own keys, and the top-level fields
// that must never leak onto a success result or its overview.
// ---------------------------------------------------------------------------

/** The exact top-level own keys of an application success result, sorted. */
const SUCCESS_KEYS = ['ok', 'overview', 'selection'] as const;

/** The exact top-level own keys of a LOCATION passthrough result, sorted. */
const LOCATION_KEYS = ['error', 'ok', 'stage'] as const;

/**
 * Fields that must never appear at the top level of a success result: the selection-trace fields (they
 * live inside `selection`), coordinates, and every transport/selection alias the design forbids.
 */
const FORBIDDEN_TOP_LEVEL_KEYS = [
  'source',
  'metadata',
  'fallbackUsed',
  'fallbackAttempted',
  'fallbackReason',
  'execution',
  'primary',
  'previous',
  'result',
  'product',
  'latitude',
  'longitude',
  'grid',
  'request',
  'plan',
  'stale',
  'error',
  'stage',
  'coordinates',
] as const;

/** The exact top-level own keys of every assembled overview, sorted. */
const OVERVIEW_KEYS = [
  'airQuality',
  'alerts',
  'current',
  'daily',
  'hourly',
  'location',
  'missingSections',
  'sources',
] as const;

/** Selection/application-trace fields that must never leak onto the overview payload. */
const FORBIDDEN_OVERVIEW_KEYS = [
  'selected',
  'selection',
  'source',
  'fallbackUsed',
  'fallbackAttempted',
  'fallbackReason',
  'execution',
  'primary',
  'previous',
  'result',
  'stage',
  'ok',
] as const;

/** `missingSections` for a selected hourly source (HOURLY present → not missing). */
const SELECTED_MISSING = [
  'CURRENT',
  'DAILY',
  'AIR_QUALITY_CURRENT',
  'AIR_QUALITY_FORECAST',
  'ALERTS',
] as const;

/** `missingSections` when no hourly source was selected (HOURLY is missing too). */
const NO_SELECTION_MISSING = [
  'CURRENT',
  'HOURLY',
  'DAILY',
  'AIR_QUALITY_CURRENT',
  'AIR_QUALITY_FORECAST',
  'ALERTS',
] as const;

// ---------------------------------------------------------------------------
// Narrowed local aliases.
// ---------------------------------------------------------------------------

/** The success branch of a hourly-forecast service result. */
type SuccessResult = Extract<KmaHourlyForecastServiceResult, { readonly ok: true }>;

/** The PR #19 execution trace the facade resolves on a supported location. */
type ExecutionTrace = KmaHourlyFallbackServiceResult;

/** The LOCATION passthrough arm of the facade / service result. */
type LocationFailure = Extract<
  KmaLocationHourlyFallbackResult,
  { readonly stage: 'LOCATION' }
>;

// ---------------------------------------------------------------------------
// Fixture builders — every mutable fixture is built fresh per call, so no test
// shares a mutable input/location/trace/hourly/source object.
// ---------------------------------------------------------------------------

/** A fresh, complete, schema-valid `HourlyForecast`; `forecastAt` overridable for distinct entries. */
function makeHourly(forecastAt = '2026-07-22T14:00:00+09:00'): HourlyForecast {
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

/** A fresh caller input (`product` + `location`). */
function makeInput(
  overrides: {
    readonly product?: KmaForecastProduct;
    readonly location?: WeatherLocation;
  } = {},
): KmaLocationHourlyOverviewInput {
  return {
    product: overrides.product ?? SHORT,
    location: overrides.location ?? makeLocation(),
  };
}

/** A fresh non-empty success result carrying the given (or a fresh default) hourly array. */
function makeSuccessResult(
  hourly: readonly HourlyForecast[] = [makeHourly()],
): SuccessResult {
  return { ok: true, hourly };
}

/** A fresh empty (usable-failing) success result. */
function makeEmptySuccessResult(): SuccessResult {
  return { ok: true, hourly: [] };
}

/** A fresh `PROVIDER`-stage error result wrapping the given provider error. */
function makeProviderError(
  error: KmaForecastProviderError,
): KmaHourlyForecastServiceResult {
  return { ok: false, stage: 'PROVIDER', error };
}

/** A fresh `NORMALIZATION`-stage error result carrying the given (or a fresh default) issues. */
function makeNormalizationError(
  issues: readonly KmaHourlyNormalizationIssue[] = [
    {
      slotKey: 'SHORT_FORECAST|20260722|0500|20260722|1400|60|127',
      field: 'temperatureCelsius',
      reason: 'ABSENT',
    },
  ],
): KmaHourlyForecastServiceResult {
  return { ok: false, stage: 'NORMALIZATION', issues };
}

/** A fresh no-fallback trace whose primary is a usable (non-empty) success. */
function makePrimaryExecution(
  hourly: readonly HourlyForecast[] = [makeHourly()],
): { readonly fallbackAttempted: false; readonly primary: SuccessResult } {
  return { fallbackAttempted: false, primary: makeSuccessResult(hourly) };
}

/** A fresh fallback trace: an unusable (empty) primary and a usable previous success. */
function makePreviousExecution(
  previousHourly: readonly HourlyForecast[] = [makeHourly('2026-07-22T13:00:00+09:00')],
  fallbackReason: KmaHourlyFallbackReason = 'EMPTY_HOURLY',
): {
  readonly fallbackAttempted: true;
  readonly fallbackReason: KmaHourlyFallbackReason;
  readonly primary: SuccessResult;
  readonly previous: SuccessResult;
} {
  return {
    fallbackAttempted: true,
    fallbackReason,
    primary: makeEmptySuccessResult(),
    previous: makeSuccessResult(previousHourly),
  };
}

/** A fresh selected-source provenance context; overridable per field. */
function makeSourceMetadata(
  overrides: Partial<KmaHourlySourceMetadataInput> = {},
): KmaHourlySourceMetadataInput {
  return {
    sourceId: 'kma-hourly-primary',
    issuedAt: '2026-07-22T05:00:00+09:00',
    fetchedAt: '2026-07-22T05:05:00+09:00',
    retrievalMode: 'LIVE',
    ...overrides,
  };
}

/** A fresh LOCATION passthrough failure (value-free discriminator). */
function makeLocationFailure(): LocationFailure {
  return {
    ok: false,
    stage: 'LOCATION',
    error: { kind: 'UNSUPPORTED_LOCATION' },
  };
}

// ---------------------------------------------------------------------------
// Collaborator stubs.
// ---------------------------------------------------------------------------

interface FacadeCall {
  readonly input: KmaLocationHourlyFallbackInput;
  readonly options: KmaLocationHourlyFallbackOptions | undefined;
}

/**
 * A fresh fake location fallback facade that records each `input`/`options` (by reference) and defers
 * to `respond` for the returned Promise (or a synchronous throw). Uses `vi.fn` so call count and
 * argument identity are directly assertable.
 */
function createFacadeStub(
  respond: (
    input: KmaLocationHourlyFallbackInput,
    options: KmaLocationHourlyFallbackOptions | undefined,
  ) => Promise<KmaLocationHourlyFallbackResult>,
) {
  const calls: FacadeCall[] = [];
  const fetchHourlyForecastWithFallbackForLocation = vi.fn(
    (
      input: KmaLocationHourlyFallbackInput,
      options?: KmaLocationHourlyFallbackOptions,
    ): Promise<KmaLocationHourlyFallbackResult> => {
      calls.push({ input, options });
      return respond(input, options);
    },
  );
  const facade: KmaLocationHourlyFallbackFacade = {
    fetchHourlyForecastWithFallbackForLocation,
  };
  return { facade, fetchHourlyForecastWithFallbackForLocation, calls };
}

/** A facade stub that always resolves with the given result. */
function resolvingFacade(result: KmaLocationHourlyFallbackResult) {
  return createFacadeStub(() => Promise.resolve(result));
}

/** A fresh resolver stub that records each input (by reference) and returns `output`. */
function createResolver(output: KmaHourlySourceMetadataInput = makeSourceMetadata()) {
  const calls: KmaSelectedHourlySourceMetadataResolverInput[] = [];
  const resolver = vi.fn(
    (
      input: KmaSelectedHourlySourceMetadataResolverInput,
    ): KmaHourlySourceMetadataInput => {
      calls.push(input);
      return output;
    },
  );
  return { resolver, calls, output };
}

/** A resolver that must never run — throws loudly if it is ever called. */
function neverResolver() {
  return vi.fn((): KmaHourlySourceMetadataInput => {
    throw new Error('test setup: resolver was called but should not have been');
  });
}

/** A `spySelector` wrapping the real PR #22 selector verbatim, recording inputs and returns. */
function spySelector() {
  const calls: ExecutionTrace[] = [];
  const returns: KmaHourlyFallbackSelection[] = [];
  const select = vi.fn((execution: ExecutionTrace): KmaHourlyFallbackSelection => {
    calls.push(execution);
    const selection = selectKmaHourlyFallbackResult(execution);
    returns.push(selection);
    return selection;
  });
  return { select, calls, returns };
}

/** A `spyAssembler` wrapping the real PR #23 assembler verbatim, recording inputs and returns. */
function spyAssembler() {
  const calls: KmaHourlyWeatherOverviewInput[] = [];
  const returns: WeatherOverview[] = [];
  const assemble = vi.fn((input: KmaHourlyWeatherOverviewInput): WeatherOverview => {
    calls.push(input);
    const overview = assembleKmaHourlyWeatherOverview(input);
    returns.push(overview);
    return overview;
  });
  return { assemble, calls, returns };
}

// ---------------------------------------------------------------------------
// Assertion / spy helpers.
// ---------------------------------------------------------------------------

/** Assert a success result has exactly `ok`/`overview`/`selection` and no forbidden top-level key. */
function expectSuccessKeys(result: KmaLocationHourlyOverviewResult): void {
  const record = result as Record<string, unknown>;
  expect(Object.keys(record).sort()).toEqual([...SUCCESS_KEYS]);
  for (const key of FORBIDDEN_TOP_LEVEL_KEYS) {
    expect(Object.prototype.hasOwnProperty.call(record, key)).toBe(false);
  }
}

/** Assert a LOCATION result has exactly `error`/`ok`/`stage` and no overview/selection. */
function expectLocationKeys(result: KmaLocationHourlyOverviewResult): void {
  const record = result as Record<string, unknown>;
  expect(Object.keys(record).sort()).toEqual([...LOCATION_KEYS]);
  expect(Object.prototype.hasOwnProperty.call(record, 'overview')).toBe(false);
  expect(Object.prototype.hasOwnProperty.call(record, 'selection')).toBe(false);
}

/** Assert the overview has exactly the eight top-level keys and none of the trace fields. */
function expectExactOverviewShape(overview: WeatherOverview): void {
  const record = overview as unknown as Record<string, unknown>;
  expect(Object.keys(record).sort()).toEqual([...OVERVIEW_KEYS]);
  for (const key of FORBIDDEN_OVERVIEW_KEYS) {
    expect(Object.prototype.hasOwnProperty.call(record, key)).toBe(false);
  }
}

/** Narrow a result to the success arm or fail the test loudly. */
function expectSuccess(
  result: KmaLocationHourlyOverviewResult,
): Extract<KmaLocationHourlyOverviewResult, { readonly ok: true }> {
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
// Fixture sanity — fixtures satisfy the real contracts before use.
// ---------------------------------------------------------------------------

describe('fixture sanity', () => {
  it('builds contracts-valid HourlyForecast and WeatherLocation fixtures', () => {
    expect(hourlyForecast.safeParse(makeHourly()).success).toBe(true);
    expect(weatherLocation.safeParse(makeLocation()).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §21 — construction is side-effect-free.
// ---------------------------------------------------------------------------

describe('createKmaLocationHourlyOverviewService — construction', () => {
  it('calls no collaborator and reads no clock/console on construction alone', () => {
    const spies = spyOnConsole();
    const nowSpy = vi.spyOn(Date, 'now');
    const { facade, fetchHourlyForecastWithFallbackForLocation } = resolvingFacade(
      makePrimaryExecution(),
    );
    const { resolver } = createResolver();
    const { select } = spySelector();
    const { assemble } = spyAssembler();

    createKmaLocationHourlyOverviewService(facade, resolver, select, assemble);

    expect(fetchHourlyForecastWithFallbackForLocation).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(assemble).not.toHaveBeenCalled();
    expect(nowSpy).not.toHaveBeenCalled();
    expectSilent(spies);
  });

  it('exposes exactly one public method key that is callable', () => {
    const { facade } = resolvingFacade(makePrimaryExecution());
    const { resolver } = createResolver();

    const service = createKmaLocationHourlyOverviewService(facade, resolver);

    expect(Object.keys(service)).toEqual(['fetchHourlyWeatherOverviewForLocation']);
    expect(typeof service.fetchHourlyWeatherOverviewForLocation).toBe('function');
  });

  it('builds a distinct service and method reference on each construction', () => {
    const { facade } = resolvingFacade(makePrimaryExecution());
    const { resolver } = createResolver();

    const first = createKmaLocationHourlyOverviewService(facade, resolver);
    const second = createKmaLocationHourlyOverviewService(facade, resolver);

    expect(first).not.toBe(second);
    expect(first.fetchHourlyWeatherOverviewForLocation).not.toBe(
      second.fetchHourlyWeatherOverviewForLocation,
    );
  });
});

// ---------------------------------------------------------------------------
// §22 — PRIMARY selected.
// ---------------------------------------------------------------------------

describe('fetchHourlyWeatherOverviewForLocation — PRIMARY selected', () => {
  it('selects PRIMARY, resolves once, and assembles a valid hourly-only overview', async () => {
    const hourly = [
      makeHourly('2026-07-22T14:00:00+09:00'),
      makeHourly('2026-07-22T15:00:00+09:00'),
    ];
    const trace = makePrimaryExecution(hourly);
    const { facade, fetchHourlyForecastWithFallbackForLocation } =
      resolvingFacade(trace);
    const source = makeSourceMetadata();
    const { resolver, calls: resolverCalls } = createResolver(source);
    const { assemble, calls: assemblerCalls, returns: assemblerReturns } =
      spyAssembler();

    const service = createKmaLocationHourlyOverviewService(
      facade,
      resolver,
      selectKmaHourlyFallbackResult,
      assemble,
    );

    const result = expectSuccess(
      await service.fetchHourlyWeatherOverviewForLocation(makeInput()),
    );

    // Facade ran exactly once; selector produced PRIMARY (fallback not used).
    expect(fetchHourlyForecastWithFallbackForLocation).toHaveBeenCalledTimes(1);
    expect(result.selection.selected).toBe(true);
    expect(result.selection.source).toBe('PRIMARY');
    expect(result.selection.fallbackUsed).toBe(false);
    // Selection preserves the facade's exact execution trace and primary result references.
    expect(result.selection.execution).toBe(trace);
    if (result.selection.selected) {
      expect(result.selection.result).toBe(trace.primary);
    }

    // Resolver ran exactly once with exact keys and references.
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolverCalls).toHaveLength(1);
    expect(Object.keys(resolverCalls[0]).sort()).toEqual([
      'location',
      'product',
      'selection',
    ]);
    expect(resolverCalls[0].product).toBe(SHORT);
    expect(resolverCalls[0].selection).toBe(result.selection);

    // Assembler ran once with the resolver output by reference; overview is that exact return.
    expect(assemble).toHaveBeenCalledTimes(1);
    expect(assemblerCalls[0].source).toBe(source);
    expect(assemblerCalls[0].selection).toBe(result.selection);
    expect(result.overview).toBe(assemblerReturns[0]);

    // The overview is a valid hourly-only WeatherOverview with the caller's provenance.
    expect(weatherOverview.safeParse(result.overview).success).toBe(true);
    expect(result.overview.hourly).toEqual(hourly);
    expect(result.overview.hourly.map((entry) => entry.forecastAt)).toEqual([
      '2026-07-22T14:00:00+09:00',
      '2026-07-22T15:00:00+09:00',
    ]);
    expect(result.overview.missingSections).toEqual([...SELECTED_MISSING]);
    expect(result.overview.missingSections).not.toContain('HOURLY');
    expect(result.overview.sources).toHaveLength(1);
    expect(result.overview.sources[0].provider).toBe('KMA');
    expect(result.overview.sources[0].sections).toEqual(['HOURLY']);
    expect(result.overview.sources[0].sourceId).toBe(source.sourceId);

    expectSuccessKeys(result);
  });

  it('passes the parsed location (not the caller original) to resolver and assembler', async () => {
    const trace = makePrimaryExecution();
    const { facade } = resolvingFacade(trace);
    const { resolver, calls: resolverCalls } = createResolver();
    const { assemble, calls: assemblerCalls } = spyAssembler();
    const service = createKmaLocationHourlyOverviewService(
      facade,
      resolver,
      selectKmaHourlyFallbackResult,
      assemble,
    );

    const input = makeInput();
    await service.fetchHourlyWeatherOverviewForLocation(input);

    // Neither collaborator receives the caller's original location object: `weatherLocation.parse`
    // produces a fresh parsed value, so both see a different reference than `input.location`.
    expect(resolverCalls[0].location).not.toBe(input.location);
    expect(assemblerCalls[0].location).not.toBe(input.location);
    // The resolver and assembler share that one parsed location, structurally equal to the caller's.
    expect(resolverCalls[0].location).toBe(assemblerCalls[0].location);
    expect(resolverCalls[0].location).toEqual(input.location);
  });
});

// ---------------------------------------------------------------------------
// §23 — PREVIOUS selected.
// ---------------------------------------------------------------------------

describe('fetchHourlyWeatherOverviewForLocation — PREVIOUS selected', () => {
  it('selects PREVIOUS, resolves previous provenance, and assembles previous hourly', async () => {
    const previousHourly = [makeHourly('2026-07-22T11:00:00+09:00')];
    const trace = makePreviousExecution(previousHourly);
    const { facade } = resolvingFacade(trace);
    const source = makeSourceMetadata({
      sourceId: 'kma-hourly-previous',
      issuedAt: '2026-07-22T02:00:00+09:00',
      retrievalMode: 'CACHE',
    });
    const { resolver, calls: resolverCalls } = createResolver(source);

    const service = createKmaLocationHourlyOverviewService(facade, resolver);

    const result = expectSuccess(
      await service.fetchHourlyWeatherOverviewForLocation(makeInput()),
    );

    // Real selector reports PREVIOUS with fallback used.
    expect(result.selection.selected).toBe(true);
    expect(result.selection.source).toBe('PREVIOUS');
    expect(result.selection.fallbackUsed).toBe(true);
    expect(result.selection.execution).toBe(trace);
    if (result.selection.selected) {
      expect(result.selection.result).toBe(trace.previous);
    }

    // Resolver saw the PREVIOUS selection reference and returned the previous-issuance provenance.
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolverCalls[0].selection.source).toBe('PREVIOUS');

    // Overview uses the previous hourly and the resolver's provenance values.
    expect(result.overview.hourly).toEqual(previousHourly);
    expect(result.overview.missingSections).not.toContain('HOURLY');
    expect(result.overview.sources).toHaveLength(1);
    expect(result.overview.sources[0].sourceId).toBe('kma-hourly-previous');
    expect(result.overview.sources[0].issuedAt).toBe('2026-07-22T02:00:00+09:00');
    expect(result.overview.sources[0].retrievalMode).toBe('CACHE');

    // top-level fallbackUsed is never exposed (it lives inside `selection`).
    expectSuccessKeys(result);
  });

  it('accepts an explicit null issuedAt from the resolver on a selected source', async () => {
    const trace = makePreviousExecution();
    const { facade } = resolvingFacade(trace);
    const { resolver } = createResolver(makeSourceMetadata({ issuedAt: null }));
    const service = createKmaLocationHourlyOverviewService(facade, resolver);

    const result = expectSuccess(
      await service.fetchHourlyWeatherOverviewForLocation(makeInput()),
    );

    expect(weatherOverview.safeParse(result.overview).success).toBe(true);
    expect(result.overview.sources[0].issuedAt).toBeNull();
    expect(result.overview.sources[0].observedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §24 — no-selection matrices.
// ---------------------------------------------------------------------------

describe('fetchHourlyWeatherOverviewForLocation — no selection', () => {
  const noSelectionTraces: ReadonlyArray<{
    readonly name: string;
    readonly make: () => ExecutionTrace;
  }> = [
    {
      name: 'no fallback + primary empty',
      make: () => ({ fallbackAttempted: false, primary: makeEmptySuccessResult() }),
    },
    {
      name: 'no fallback + primary Provider error',
      make: () => ({
        fallbackAttempted: false,
        primary: makeProviderError({ kind: 'HTTP_ERROR', status: 500 }),
      }),
    },
    {
      name: 'fallback attempted + previous empty',
      make: () => ({
        fallbackAttempted: true,
        fallbackReason: 'EMPTY_HOURLY',
        primary: makeEmptySuccessResult(),
        previous: makeEmptySuccessResult(),
      }),
    },
    {
      name: 'fallback attempted + previous Provider error',
      make: () => ({
        fallbackAttempted: true,
        fallbackReason: 'KMA_NO_DATA',
        primary: makeProviderError({ kind: 'KMA_UPSTREAM_ERROR', resultCode: '03' }),
        previous: makeProviderError({ kind: 'HTTP_ERROR', status: 503 }),
      }),
    },
    {
      name: 'fallback attempted + previous NORMALIZATION error',
      make: () => ({
        fallbackAttempted: true,
        fallbackReason: 'EMPTY_HOURLY',
        primary: makeEmptySuccessResult(),
        previous: makeNormalizationError(),
      }),
    },
  ];

  for (const { name, make } of noSelectionTraces) {
    it(`returns ok:true partial overview and never resolves for a ${name} trace`, async () => {
      const trace = make();
      const { facade } = resolvingFacade(trace);
      const resolver = neverResolver();
      const { assemble } = spyAssembler();
      const service = createKmaLocationHourlyOverviewService(
        facade,
        resolver,
        selectKmaHourlyFallbackResult,
        assemble,
      );

      const result = expectSuccess(
        await service.fetchHourlyWeatherOverviewForLocation(makeInput()),
      );

      // Application orchestration succeeded even with no usable data.
      expect(result.selection.selected).toBe(false);
      expect(resolver).not.toHaveBeenCalled();
      expect(assemble).toHaveBeenCalledTimes(1);
      expect(assemble.mock.calls[0][0].source).toBeNull();

      // The "no usable hourly data" fact is expressed inside the result, not as a top-level error.
      expect(result.overview.hourly).toEqual([]);
      expect(result.overview.sources).toEqual([]);
      expect(result.overview.missingSections).toEqual([...NO_SELECTION_MISSING]);
      expect(result.overview.missingSections).toContain('HOURLY');

      // The full execution trace is preserved inside the selection.
      expect(result.selection.execution).toBe(trace);
      expectSuccessKeys(result);
    });
  }

  it('never promotes a Provider failure to a top-level error', async () => {
    const trace: ExecutionTrace = {
      fallbackAttempted: false,
      primary: makeProviderError({ kind: 'KMA_UPSTREAM_ERROR', resultCode: '07' }),
    };
    const { facade } = resolvingFacade(trace);
    const { resolver } = createResolver();
    const service = createKmaLocationHourlyOverviewService(facade, resolver);

    const result = await service.fetchHourlyWeatherOverviewForLocation(makeInput());

    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §25 — LOCATION passthrough.
// ---------------------------------------------------------------------------

describe('fetchHourlyWeatherOverviewForLocation — LOCATION passthrough', () => {
  it('returns the exact facade LOCATION result and never runs the downstream pipeline', async () => {
    const failure = makeLocationFailure();
    const { facade, fetchHourlyForecastWithFallbackForLocation } =
      resolvingFacade(failure);
    const resolver = neverResolver();
    const { select } = spySelector();
    const { assemble } = spyAssembler();
    const service = createKmaLocationHourlyOverviewService(
      facade,
      resolver,
      select,
      assemble,
    );

    const result = await service.fetchHourlyWeatherOverviewForLocation(makeInput());

    // The exact facade result reference is returned.
    expect(result).toBe(failure);
    expect(fetchHourlyForecastWithFallbackForLocation).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
    expect(assemble).not.toHaveBeenCalled();

    // Exact LOCATION keys; no overview/selection.
    expectLocationKeys(result);
    if ('stage' in result && result.stage === 'LOCATION') {
      expect(result.error.kind).toBe('UNSUPPORTED_LOCATION');
    }
  });
});

// ---------------------------------------------------------------------------
// §26 — invalid WeatherLocation (synchronous ZodError, no collaborator runs).
// ---------------------------------------------------------------------------

describe('fetchHourlyWeatherOverviewForLocation — invalid WeatherLocation', () => {
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
      const { facade, fetchHourlyForecastWithFallbackForLocation } =
        resolvingFacade(makePrimaryExecution());
      const resolver = neverResolver();
      const { select } = spySelector();
      const { assemble } = spyAssembler();
      const service = createKmaLocationHourlyOverviewService(
        facade,
        resolver,
        select,
        assemble,
      );

      const input = makeInput({ location: location() });
      const snapshot = JSON.stringify(input);

      const error = captureSynchronousError(() =>
        service.fetchHourlyWeatherOverviewForLocation(input),
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as { name?: string }).name).toBe('ZodError');
      expect(fetchHourlyForecastWithFallbackForLocation).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();
      expect(resolver).not.toHaveBeenCalled();
      expect(assemble).not.toHaveBeenCalled();
      // The caller's input is not mutated and nothing is logged.
      expect(JSON.stringify(input)).toBe(snapshot);
      expectSilent(spies);
    });
  }
});

// ---------------------------------------------------------------------------
// §27 — facade call boundary.
// ---------------------------------------------------------------------------

describe('fetchHourlyWeatherOverviewForLocation — facade call boundary', () => {
  it('passes a fresh { product, latitude, longitude } object with parsed coordinates', async () => {
    const { facade, fetchHourlyForecastWithFallbackForLocation, calls } =
      resolvingFacade(makePrimaryExecution());
    const { resolver } = createResolver();
    const service = createKmaLocationHourlyOverviewService(facade, resolver);

    const input = makeInput();
    await service.fetchHourlyWeatherOverviewForLocation(input);

    expect(fetchHourlyForecastWithFallbackForLocation).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    // Exact keys — no location object fields leak into the facade input.
    expect(Object.keys(calls[0].input).sort()).toEqual([
      'latitude',
      'longitude',
      'product',
    ]);
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
    // Parsed coordinate values, product forwarded verbatim.
    expect(calls[0].input.product).toBe(SHORT);
    expect(calls[0].input.latitude).toBe(input.location.latitude);
    expect(calls[0].input.longitude).toBe(input.location.longitude);
    // Fresh object, distinct from the caller input and its location.
    expect(calls[0].input).not.toBe(input);
    expect(calls[0].input as unknown).not.toBe(input.location);
  });

  it('forwards options by the same reference', async () => {
    const { facade, calls } = resolvingFacade(makePrimaryExecution());
    const { resolver } = createResolver();
    const service = createKmaLocationHourlyOverviewService(facade, resolver);

    const options: KmaLocationHourlyOverviewOptions = {
      signal: new AbortController().signal,
    };
    await service.fetchHourlyWeatherOverviewForLocation(makeInput(), options);

    expect(calls[0].options).toBe(options);
    expect(calls[0].options?.signal).toBe(options.signal);
  });

  it('forwards exactly undefined (never a synthesized {}) when options are omitted', async () => {
    const { facade, fetchHourlyForecastWithFallbackForLocation, calls } =
      resolvingFacade(makePrimaryExecution());
    const { resolver } = createResolver();
    const service = createKmaLocationHourlyOverviewService(facade, resolver);

    await service.fetchHourlyWeatherOverviewForLocation(makeInput());

    expect(fetchHourlyForecastWithFallbackForLocation.mock.calls[0]).toHaveLength(2);
    expect(fetchHourlyForecastWithFallbackForLocation.mock.calls[0][1]).toBeUndefined();
    expect(calls[0].options).toBeUndefined();
  });

  it('accepts frozen input and options and forwards a fresh derived facade input', async () => {
    const { facade, calls } = resolvingFacade(makePrimaryExecution());
    const { resolver } = createResolver();
    const service = createKmaLocationHourlyOverviewService(facade, resolver);

    const input = deepFreeze(makeInput());
    const options = Object.freeze<KmaLocationHourlyOverviewOptions>({
      signal: new AbortController().signal,
    });
    const snapshot = JSON.stringify(input);

    await service.fetchHourlyWeatherOverviewForLocation(input, options);

    expect(calls[0].input).not.toBe(input);
    expect(calls[0].options).toBe(options);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// §28 — error propagation (each preserves the exact error reference).
// ---------------------------------------------------------------------------

describe('fetchHourlyWeatherOverviewForLocation — error propagation', () => {
  it('propagates a facade synchronous throw synchronously, running no downstream', () => {
    const sentinel = new Error('FACADE_SYNC_THROW_SENTINEL');
    const { facade, fetchHourlyForecastWithFallbackForLocation } = createFacadeStub(
      () => {
        throw sentinel;
      },
    );
    const resolver = neverResolver();
    const { select } = spySelector();
    const { assemble } = spyAssembler();
    const service = createKmaLocationHourlyOverviewService(
      facade,
      resolver,
      select,
      assemble,
    );

    let returned: unknown;
    const caught = captureSynchronousError(() => {
      returned = service.fetchHourlyWeatherOverviewForLocation(makeInput());
    });

    expect(caught).toBe(sentinel);
    // A synchronous throw is never converted to a Promise.
    expect(returned).toBeUndefined();
    expect(fetchHourlyForecastWithFallbackForLocation).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
    expect(assemble).not.toHaveBeenCalled();
  });

  it('propagates a facade rejection as the same rejection reason, running no downstream', async () => {
    const sentinel = new Error('FACADE_REJECTION_SENTINEL');
    const rejected = Promise.reject<KmaLocationHourlyFallbackResult>(sentinel);
    const assertion = expect(rejected).rejects.toBe(sentinel);

    const { facade } = createFacadeStub(() => rejected);
    const resolver = neverResolver();
    const { select } = spySelector();
    const { assemble } = spyAssembler();
    const service = createKmaLocationHourlyOverviewService(
      facade,
      resolver,
      select,
      assemble,
    );

    const returned = service.fetchHourlyWeatherOverviewForLocation(makeInput());
    await expect(returned).rejects.toBe(sentinel);
    await assertion;

    expect(select).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
    expect(assemble).not.toHaveBeenCalled();
  });

  it('propagates a selector throw as a rejection, running neither resolver nor assembler', async () => {
    const sentinel = new Error('SELECTOR_SENTINEL');
    const throwingSelector = vi.fn((): KmaHourlyFallbackSelection => {
      throw sentinel;
    });
    const { facade } = resolvingFacade(makePrimaryExecution());
    const resolver = neverResolver();
    const { assemble } = spyAssembler();
    const service = createKmaLocationHourlyOverviewService(
      facade,
      resolver,
      throwingSelector,
      assemble,
    );

    await expect(
      service.fetchHourlyWeatherOverviewForLocation(makeInput()),
    ).rejects.toBe(sentinel);

    expect(throwingSelector).toHaveBeenCalledTimes(1);
    expect(resolver).not.toHaveBeenCalled();
    expect(assemble).not.toHaveBeenCalled();
  });

  it('propagates a resolver throw as a rejection, running no assembler', async () => {
    const sentinel = new Error('RESOLVER_SENTINEL');
    const throwingResolver = vi.fn((): KmaHourlySourceMetadataInput => {
      throw sentinel;
    });
    const { facade } = resolvingFacade(makePrimaryExecution());
    const { assemble } = spyAssembler();
    const service = createKmaLocationHourlyOverviewService(
      facade,
      throwingResolver,
      selectKmaHourlyFallbackResult,
      assemble,
    );

    await expect(
      service.fetchHourlyWeatherOverviewForLocation(makeInput()),
    ).rejects.toBe(sentinel);

    expect(throwingResolver).toHaveBeenCalledTimes(1);
    expect(assemble).not.toHaveBeenCalled();
  });

  it('propagates an assembler throw (selected branch) as the same rejection', async () => {
    const sentinel = new Error('ASSEMBLER_SELECTED_SENTINEL');
    const throwingAssembler = vi.fn((): WeatherOverview => {
      throw sentinel;
    });
    const { facade } = resolvingFacade(makePrimaryExecution());
    const { resolver } = createResolver();
    const service = createKmaLocationHourlyOverviewService(
      facade,
      resolver,
      selectKmaHourlyFallbackResult,
      throwingAssembler,
    );

    await expect(
      service.fetchHourlyWeatherOverviewForLocation(makeInput()),
    ).rejects.toBe(sentinel);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(throwingAssembler).toHaveBeenCalledTimes(1);
  });

  it('propagates an assembler throw (no-selection branch) as the same rejection', async () => {
    const sentinel = new Error('ASSEMBLER_NO_SELECTION_SENTINEL');
    const throwingAssembler = vi.fn((): WeatherOverview => {
      throw sentinel;
    });
    const trace: ExecutionTrace = {
      fallbackAttempted: false,
      primary: makeEmptySuccessResult(),
    };
    const { facade } = resolvingFacade(trace);
    const resolver = neverResolver();
    const service = createKmaLocationHourlyOverviewService(
      facade,
      resolver,
      selectKmaHourlyFallbackResult,
      throwingAssembler,
    );

    await expect(
      service.fetchHourlyWeatherOverviewForLocation(makeInput()),
    ).rejects.toBe(sentinel);
    expect(resolver).not.toHaveBeenCalled();
    expect(throwingAssembler).toHaveBeenCalledTimes(1);
  });

  it('logs nothing on any error path', async () => {
    const spies = spyOnConsole();
    const sentinel = new Error('QUIET_SENTINEL');
    const { facade } = createFacadeStub(() =>
      Promise.reject<KmaLocationHourlyFallbackResult>(sentinel),
    );
    const { resolver } = createResolver();
    const service = createKmaLocationHourlyOverviewService(facade, resolver);

    await service.fetchHourlyWeatherOverviewForLocation(makeInput()).catch(() => {});

    expectSilent(spies);
  });
});

// ---------------------------------------------------------------------------
// §29 — PR #23 selected-empty guard survives integration.
// ---------------------------------------------------------------------------

describe('fetchHourlyWeatherOverviewForLocation — PR #23 selected-empty guard', () => {
  it('rejects with a ZodError when a custom selector reports a selected-empty result', async () => {
    // A structurally-valid selected result whose `result.hourly` is empty. The public selected type
    // allows it, but the REAL PR #23 assembler's nonempty guard must still reject it.
    const emptySelectedSelector = vi.fn(
      (execution: ExecutionTrace): KmaHourlyFallbackSelection => ({
        selected: true,
        source: 'PRIMARY',
        fallbackUsed: false,
        result: { ok: true, hourly: [] },
        execution,
      }),
    );
    const { facade } = resolvingFacade(makePrimaryExecution());
    const { resolver } = createResolver();
    const service = createKmaLocationHourlyOverviewService(
      facade,
      resolver,
      emptySelectedSelector,
      // real assembler (default)
    );

    const input = makeInput();
    const snapshot = JSON.stringify(input);

    const error = await service
      .fetchHourlyWeatherOverviewForLocation(input)
      .then(
        () => {
          throw new Error('expected a rejection, not a partial success');
        },
        (rejected: unknown) => rejected,
      );

    expect((error as { name?: string }).name).toBe('ZodError');
    // No input mutation; the guard fires before any overview is produced.
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// §30 — exact keys and leakage.
// ---------------------------------------------------------------------------

describe('fetchHourlyWeatherOverviewForLocation — exact keys and leakage', () => {
  it('success has exactly ok/overview/selection and no forbidden top-level field', async () => {
    const { facade } = resolvingFacade(makePrimaryExecution());
    const { resolver } = createResolver();
    const service = createKmaLocationHourlyOverviewService(facade, resolver);

    const result = expectSuccess(
      await service.fetchHourlyWeatherOverviewForLocation(makeInput()),
    );

    expectSuccessKeys(result);
    // No application/selection trace leaked onto the overview payload either.
    expectExactOverviewShape(result.overview);
  });

  it('no-selection success has exactly ok/overview/selection and a trace-free overview', async () => {
    const trace: ExecutionTrace = {
      fallbackAttempted: false,
      primary: makeEmptySuccessResult(),
    };
    const { facade } = resolvingFacade(trace);
    const { resolver } = createResolver();
    const service = createKmaLocationHourlyOverviewService(facade, resolver);

    const result = expectSuccess(
      await service.fetchHourlyWeatherOverviewForLocation(makeInput()),
    );

    expectSuccessKeys(result);
    expectExactOverviewShape(result.overview);
  });

  it('LOCATION has exactly error/ok/stage', async () => {
    const { facade } = resolvingFacade(makeLocationFailure());
    const { resolver } = createResolver();
    const service = createKmaLocationHourlyOverviewService(facade, resolver);

    const result = await service.fetchHourlyWeatherOverviewForLocation(makeInput());

    expectLocationKeys(result);
  });
});

// ---------------------------------------------------------------------------
// §31 — freshness and immutability.
// ---------------------------------------------------------------------------

describe('fetchHourlyWeatherOverviewForLocation — freshness and immutability', () => {
  it('assembles correctly from deeply frozen input, trace, selection, and resolver output', async () => {
    const trace = deepFreeze(makePrimaryExecution());
    const { facade } = resolvingFacade(trace);
    const output = deepFreeze(makeSourceMetadata());
    const { resolver } = createResolver(output);
    const service = createKmaLocationHourlyOverviewService(facade, resolver);

    const input = deepFreeze(makeInput());
    const options = Object.freeze<KmaLocationHourlyOverviewOptions>({
      signal: new AbortController().signal,
    });

    const result = expectSuccess(
      await service.fetchHourlyWeatherOverviewForLocation(input, options),
    );

    expect(weatherOverview.safeParse(result.overview).success).toBe(true);
    expect(result.overview.hourly).toEqual([...trace.primary.hourly]);
  });

  it('does not mutate the caller input across a full run', async () => {
    const { facade } = resolvingFacade(makePrimaryExecution());
    const { resolver } = createResolver();
    const service = createKmaLocationHourlyOverviewService(facade, resolver);

    const input = makeInput();
    const snapshot = JSON.stringify(input);

    await service.fetchHourlyWeatherOverviewForLocation(input);

    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('returns fresh, independent success wrappers on repeated calls', async () => {
    const trace = makePrimaryExecution();
    const { facade } = resolvingFacade(trace);
    const { resolver } = createResolver();
    const service = createKmaLocationHourlyOverviewService(facade, resolver);

    const first = expectSuccess(
      await service.fetchHourlyWeatherOverviewForLocation(makeInput()),
    );
    const second = expectSuccess(
      await service.fetchHourlyWeatherOverviewForLocation(makeInput()),
    );

    // Distinct wrappers and distinct freshly-allocated nested collections.
    expect(first).not.toBe(second);
    expect(first.selection).not.toBe(second.selection);
    expect(first.overview).not.toBe(second.overview);
    expect(first.overview.hourly).not.toBe(second.overview.hourly);
    expect(first).toEqual(second);
  });

  it('is unaffected by a caller mutating an earlier returned overview', async () => {
    const trace = makePrimaryExecution();
    const { facade } = resolvingFacade(trace);
    const { resolver } = createResolver();
    const service = createKmaLocationHourlyOverviewService(facade, resolver);

    const first = expectSuccess(
      await service.fetchHourlyWeatherOverviewForLocation(makeInput()),
    );
    first.overview.hourly.push(makeHourly('2026-07-22T23:00:00+09:00'));
    first.overview.missingSections.push('HOURLY');
    first.overview.sources.pop();

    const second = expectSuccess(
      await service.fetchHourlyWeatherOverviewForLocation(makeInput()),
    );

    expect(second.overview.hourly).toHaveLength(trace.primary.hourly.length);
    expect(second.overview.missingSections).toEqual([...SELECTED_MISSING]);
    expect(second.overview.sources).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// §32 — no logging on any path.
// ---------------------------------------------------------------------------

describe('fetchHourlyWeatherOverviewForLocation — no logging', () => {
  it('never calls console.log / warn / error on success, no-selection, or LOCATION paths', async () => {
    const spies = spyOnConsole();

    const primary = createKmaLocationHourlyOverviewService(
      resolvingFacade(makePrimaryExecution()).facade,
      createResolver().resolver,
    );
    const none = createKmaLocationHourlyOverviewService(
      resolvingFacade({
        fallbackAttempted: false,
        primary: makeEmptySuccessResult(),
      }).facade,
      createResolver().resolver,
    );
    const location = createKmaLocationHourlyOverviewService(
      resolvingFacade(makeLocationFailure()).facade,
      createResolver().resolver,
    );

    await primary.fetchHourlyWeatherOverviewForLocation(makeInput());
    await none.fetchHourlyWeatherOverviewForLocation(makeInput());
    await location.fetchHourlyWeatherOverviewForLocation(makeInput());

    expectSilent(spies);
  });

  it('never reads the system clock (Date.now) on a full run', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    const { facade } = resolvingFacade(makePrimaryExecution());
    const { resolver } = createResolver();
    const service = createKmaLocationHourlyOverviewService(facade, resolver);

    await service.fetchHourlyWeatherOverviewForLocation(makeInput());

    expect(nowSpy).not.toHaveBeenCalled();
  });
});
