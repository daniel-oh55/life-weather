import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  hourlyForecast,
  weatherLocation,
  weatherOverview,
  type HourlyForecast,
  type WeatherLocation,
} from '@life-weather/contracts';
import { KmaForecastProduct } from '@life-weather/weather-core';

import type { KmaForecastIssuanceIdentity } from './kma-forecast-issuance-identity';
import type { KmaHourlyFallbackReason } from './kma-hourly-fallback-eligibility';
import type { KmaHourlyFallbackServiceResult } from './kma-hourly-fallback';
import {
  selectKmaHourlyFallbackResult,
  type KmaHourlyFallbackSelection,
} from './kma-hourly-fallback-selection';
import type { KmaHourlyForecastServiceResult } from './kma-hourly-forecast';
import {
  createKmaLocationHourlyOverviewService,
  type KmaLocationHourlyOverviewInput,
  type KmaSelectedHourlySourceMetadataResolver,
  type KmaSelectedHourlySourceMetadataResolverInput,
} from './kma-location-hourly-overview';
import type {
  KmaLocationHourlyFallbackFacade,
  KmaLocationHourlyFallbackInput,
  KmaLocationHourlyFallbackOptions,
  KmaLocationHourlyFallbackResult,
} from './kma-location-hourly-fallback';
import {
  convertKmaForecastIssuanceToIssuedAt,
  createKmaLiveSelectedHourlySourceMetadataResolver,
  type KmaSelectedHourlySourceMetadataClock,
} from './kma-selected-hourly-source-metadata';

/**
 * These tests exercise the PR #26 live selected-source metadata resolver and its public issuedAt
 * converter in isolation, then the resolver wired into the REAL PR #24 service, PR #22 selector, and
 * PR #23 assembler (only the PR #21 facade is faked). Every fixture is built fresh per test — no shared
 * mutable trace/selection/issuance/clock — so call counts, references, and mutation are directly
 * assertable. The static error-message strings the runtime uses are duplicated here as constants;
 * they are module-local in the runtime and are asserted for their exact static value (never carrying
 * the raw malformed input).
 */

const SHORT = KmaForecastProduct.SHORT_FORECAST;
const ULTRA = KmaForecastProduct.ULTRA_SHORT_FORECAST;

// ---------------------------------------------------------------------------
// Static error messages (duplicated from the runtime; asserted verbatim).
// ---------------------------------------------------------------------------

const INVALID_ISSUANCE_MESSAGE = 'Invalid KMA forecast issuance identity';
const INVALID_SELECTION_MESSAGE = 'Invalid selected KMA hourly source selection';
const PREVIOUS_REQUIRES_FALLBACK_MESSAGE =
  'Selected PREVIOUS source requires a fallback execution';
const PRODUCT_MISMATCH_MESSAGE =
  'Selected KMA issuance product does not match resolver input';
const UNSUPPORTED_PRODUCT_MESSAGE = 'Unsupported KMA forecast product';
const INVALID_CLOCK_MESSAGE = 'Invalid KMA source metadata clock value';

// ---------------------------------------------------------------------------
// Fixed source IDs and exact metadata key contracts.
// ---------------------------------------------------------------------------

const SHORT_SOURCE_ID = 'kma-short-forecast-hourly';
const ULTRA_SOURCE_ID = 'kma-ultra-short-forecast-hourly';

/** The exact sorted own keys of the resolver's output metadata object. */
const METADATA_KEYS = ['fetchedAt', 'issuedAt', 'retrievalMode', 'sourceId'] as const;

/** Fields that must never appear on the resolver output (no transport/selection/location leakage). */
const FORBIDDEN_METADATA_KEYS = [
  'provider',
  'sections',
  'observedAt',
  'product',
  'location',
  'selection',
  'execution',
  'fallbackUsed',
  'fallbackAttempted',
  'fallbackReason',
  'source',
  'baseDate',
  'baseTime',
  'nx',
  'ny',
  'request',
  'plan',
  'ServiceKey',
  'serviceKey',
  'url',
  'query',
  'rawBody',
  'stale',
  'primaryIssuance',
  'previousIssuance',
  'issuance',
  'result',
  'latitude',
  'longitude',
  'id',
] as const;

// ---------------------------------------------------------------------------
// A fixed clock instant: 2026-07-22T01:23:45.678Z. `Date.UTC` is a pure static
// computation (not a global-Date replacement), so the epoch and its ISO string
// are tied together for the assertions.
// ---------------------------------------------------------------------------

const FETCHED_AT_EPOCH_MS = Date.UTC(2026, 6, 22, 1, 23, 45, 678);
const FETCHED_AT_ISO = '2026-07-22T01:23:45.678Z';

/** UTC `Z` with exactly three fractional-second digits. */
const UTC_MILLISECONDS_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ---------------------------------------------------------------------------
// Narrowed local aliases.
// ---------------------------------------------------------------------------

type SelectedSelection = Extract<
  KmaHourlyFallbackSelection,
  { readonly selected: true }
>;
type ExecutionTrace = KmaHourlyFallbackServiceResult;
type SuccessResult = Extract<KmaHourlyForecastServiceResult, { readonly ok: true }>;
type LocationFailure = Extract<
  KmaLocationHourlyFallbackResult,
  { readonly stage: 'LOCATION' }
>;

// ---------------------------------------------------------------------------
// Fixture builders — fresh per call, so no test shares a mutable object.
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

/** A fresh, complete, schema-valid `WeatherLocation`; overridable per field. */
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

/** A fresh issuance identity; overridable per field for edge cases. */
function makeIssuance(
  overrides: Partial<KmaForecastIssuanceIdentity> = {},
): KmaForecastIssuanceIdentity {
  return {
    product: SHORT,
    baseDate: '20260722',
    baseTime: '0500',
    ...overrides,
  };
}

/** The sanitized primary issuance a fresh trace carries (SHORT / 20260722 / 0500). */
function makePrimaryIssuance(): KmaForecastIssuanceIdentity {
  return { product: SHORT, baseDate: '20260722', baseTime: '0500' };
}

/** The sanitized previous issuance a fallback-attempted trace carries (SHORT / 20260722 / 0200). */
function makePreviousIssuance(): KmaForecastIssuanceIdentity {
  return { product: SHORT, baseDate: '20260722', baseTime: '0200' };
}

/** A fresh non-empty success result. */
function makeSuccessResult(
  hourly: readonly HourlyForecast[] = [makeHourly()],
): SuccessResult {
  return { ok: true, hourly };
}

/** A fresh empty (usable-failing) success result. */
function makeEmptySuccessResult(): SuccessResult {
  return { ok: true, hourly: [] };
}

/** A fresh no-fallback trace whose primary is a usable (non-empty) success. */
function makePrimaryExecution(
  hourly: readonly HourlyForecast[] = [makeHourly()],
  primaryIssuance: KmaForecastIssuanceIdentity = makePrimaryIssuance(),
): ExecutionTrace {
  return {
    fallbackAttempted: false,
    primaryIssuance,
    primary: makeSuccessResult(hourly),
  };
}

/** A fresh fallback trace: an unusable (empty) primary and a usable previous success. */
function makePreviousExecution(
  previousHourly: readonly HourlyForecast[] = [makeHourly('2026-07-22T13:00:00+09:00')],
  fallbackReason: KmaHourlyFallbackReason = 'EMPTY_HOURLY',
  previousIssuance: KmaForecastIssuanceIdentity = makePreviousIssuance(),
): ExecutionTrace {
  return {
    fallbackAttempted: true,
    fallbackReason,
    primaryIssuance: makePrimaryIssuance(),
    primary: makeEmptySuccessResult(),
    previousIssuance,
    previous: makeSuccessResult(previousHourly),
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

/** Run the REAL PR #22 selector on a trace and narrow to the selected arm (or fail the test loudly). */
function selectOrThrow(execution: ExecutionTrace): SelectedSelection {
  const selection = selectKmaHourlyFallbackResult(execution);
  if (!selection.selected) {
    throw new Error('test setup: expected a selected selection');
  }
  return selection;
}

/** A fresh resolver input (`product` + `location` + selected `selection`). */
function makeResolverInput(overrides: {
  readonly product?: KmaForecastProduct;
  readonly location?: WeatherLocation;
  readonly selection: SelectedSelection;
}): KmaSelectedHourlySourceMetadataResolverInput {
  return {
    product: overrides.product ?? SHORT,
    location: overrides.location ?? makeLocation(),
    selection: overrides.selection,
  };
}

/** A fresh overview-service input (`product` + `location`). */
function makeServiceInput(
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

// ---------------------------------------------------------------------------
// Clock stubs.
// ---------------------------------------------------------------------------

/** A fresh fake clock that returns a fixed epoch and records its calls. */
function makeClock(value: number = FETCHED_AT_EPOCH_MS) {
  const nowEpochMilliseconds = vi.fn((): number => value);
  const clock: KmaSelectedHourlySourceMetadataClock = { nowEpochMilliseconds };
  return { clock, nowEpochMilliseconds };
}

/** A fresh fake clock that throws the given error, recording its calls. */
function makeThrowingClock(error: unknown) {
  const nowEpochMilliseconds = vi.fn((): number => {
    throw error;
  });
  const clock: KmaSelectedHourlySourceMetadataClock = { nowEpochMilliseconds };
  return { clock, nowEpochMilliseconds };
}

// ---------------------------------------------------------------------------
// Facade stub (mirrors the PR #24 test's shape; only the facade is faked).
// ---------------------------------------------------------------------------

interface FacadeCall {
  readonly input: KmaLocationHourlyFallbackInput;
  readonly options: KmaLocationHourlyFallbackOptions | undefined;
}

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

/**
 * Wrap the real live resolver in a `vi.fn` so integration tests can assert whether PR #24 called it,
 * without changing its behavior.
 */
function spyResolver(clock: KmaSelectedHourlySourceMetadataClock) {
  const live = createKmaLiveSelectedHourlySourceMetadataResolver(clock);
  const resolver = vi.fn(
    (input: KmaSelectedHourlySourceMetadataResolverInput) => live(input),
  );
  return { resolver: resolver as KmaSelectedHourlySourceMetadataResolver, spy: resolver };
}

// ---------------------------------------------------------------------------
// Assertion helpers.
// ---------------------------------------------------------------------------

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
  it('builds contracts-valid HourlyForecast and WeatherLocation fixtures', () => {
    expect(hourlyForecast.safeParse(makeHourly()).success).toBe(true);
    expect(weatherLocation.safeParse(makeLocation()).success).toBe(true);
  });

  it('ties the fixed clock epoch to its ISO string', () => {
    expect(new Date(FETCHED_AT_EPOCH_MS).toISOString()).toBe(FETCHED_AT_ISO);
  });
});

// ---------------------------------------------------------------------------
// convertKmaForecastIssuanceToIssuedAt.
// ---------------------------------------------------------------------------

describe('convertKmaForecastIssuanceToIssuedAt — valid conversions', () => {
  it('converts a SHORT_FORECAST issuance to a +09:00 seconds instant', () => {
    expect(
      convertKmaForecastIssuanceToIssuedAt(
        makeIssuance({ product: SHORT, baseDate: '20260722', baseTime: '0200' }),
      ),
    ).toBe('2026-07-22T02:00:00+09:00');
  });

  it('converts an ULTRA_SHORT_FORECAST issuance identically for the same date/time', () => {
    const shortIssuedAt = convertKmaForecastIssuanceToIssuedAt(
      makeIssuance({ product: SHORT, baseDate: '20260722', baseTime: '0200' }),
    );
    const ultraIssuedAt = convertKmaForecastIssuanceToIssuedAt(
      makeIssuance({ product: ULTRA, baseDate: '20260722', baseTime: '0200' }),
    );
    expect(ultraIssuedAt).toBe('2026-07-22T02:00:00+09:00');
    expect(ultraIssuedAt).toBe(shortIssuedAt);
  });

  it('converts a leap-day issuance', () => {
    expect(
      convertKmaForecastIssuanceToIssuedAt(
        makeIssuance({ baseDate: '20240229', baseTime: '2359' }),
      ),
    ).toBe('2024-02-29T23:59:00+09:00');
  });

  it('converts a 0000 base time', () => {
    expect(
      convertKmaForecastIssuanceToIssuedAt(
        makeIssuance({ baseDate: '20260101', baseTime: '0000' }),
      ),
    ).toBe('2026-01-01T00:00:00+09:00');
  });

  it('converts a 2359 base time', () => {
    expect(
      convertKmaForecastIssuanceToIssuedAt(
        makeIssuance({ baseDate: '20260722', baseTime: '2359' }),
      ),
    ).toBe('2026-07-22T23:59:00+09:00');
  });

  it('converts a structurally valid non-canonical schedule time (0615)', () => {
    expect(
      convertKmaForecastIssuanceToIssuedAt(
        makeIssuance({ baseDate: '20260722', baseTime: '0615' }),
      ),
    ).toBe('2026-07-22T06:15:00+09:00');
  });

  it('is deterministic — the same input yields the same value', () => {
    const issuance = makeIssuance({ baseDate: '20260722', baseTime: '0500' });
    expect(convertKmaForecastIssuanceToIssuedAt(issuance)).toBe(
      convertKmaForecastIssuanceToIssuedAt(issuance),
    );
  });
});

describe('convertKmaForecastIssuanceToIssuedAt — invalid inputs (static RangeError)', () => {
  const invalidCases: ReadonlyArray<{
    readonly name: string;
    readonly issuance: () => KmaForecastIssuanceIdentity;
  }> = [
    {
      name: 'non-leap Feb 29',
      issuance: () => makeIssuance({ baseDate: '20260229', baseTime: '1200' }),
    },
    {
      name: 'month 13',
      issuance: () => makeIssuance({ baseDate: '20261301', baseTime: '0000' }),
    },
    {
      name: 'month 00',
      issuance: () => makeIssuance({ baseDate: '20260001', baseTime: '0000' }),
    },
    {
      name: 'day 00',
      issuance: () => makeIssuance({ baseDate: '20260700', baseTime: '0000' }),
    },
    {
      name: 'baseDate with dashes',
      issuance: () =>
        makeIssuance({ baseDate: '2026-07-22' as string, baseTime: '0500' }),
    },
    {
      name: 'baseDate too short',
      issuance: () => makeIssuance({ baseDate: '2026072', baseTime: '0500' }),
    },
    {
      name: 'empty baseDate',
      issuance: () => makeIssuance({ baseDate: '', baseTime: '0500' }),
    },
    {
      name: 'hour 24',
      issuance: () => makeIssuance({ baseDate: '20260722', baseTime: '2400' }),
    },
    {
      name: 'minute 60',
      issuance: () => makeIssuance({ baseDate: '20260722', baseTime: '1260' }),
    },
    {
      name: 'baseTime too short',
      issuance: () => makeIssuance({ baseDate: '20260722', baseTime: '200' }),
    },
    {
      name: 'empty baseTime',
      issuance: () => makeIssuance({ baseDate: '20260722', baseTime: '' }),
    },
  ];

  for (const { name, issuance } of invalidCases) {
    it(`throws a static RangeError for ${name}`, () => {
      const error = captureSynchronousError(() =>
        convertKmaForecastIssuanceToIssuedAt(issuance()),
      );
      expect(error).toBeInstanceOf(RangeError);
      expect((error as Error).message).toBe(INVALID_ISSUANCE_MESSAGE);
    });
  }

  it('throws a static RangeError for an unsupported product', () => {
    const error = captureSynchronousError(() =>
      convertKmaForecastIssuanceToIssuedAt({
        product: 'ULTRA_SHORT_NCST',
        baseDate: '20260722',
        baseTime: '0500',
      } as unknown as KmaForecastIssuanceIdentity),
    );
    expect(error).toBeInstanceOf(RangeError);
    expect((error as Error).message).toBe(INVALID_ISSUANCE_MESSAGE);
  });

  const nonObjectInputs: ReadonlyArray<{ readonly name: string; readonly value: unknown }> =
    [
      { name: 'null', value: null },
      { name: 'undefined', value: undefined },
      { name: 'string', value: 'not-an-object' },
      { name: 'number', value: 42 },
    ];

  for (const { name, value } of nonObjectInputs) {
    it(`throws a static RangeError for a ${name} runtime cast`, () => {
      const error = captureSynchronousError(() =>
        convertKmaForecastIssuanceToIssuedAt(
          value as unknown as KmaForecastIssuanceIdentity,
        ),
      );
      expect(error).toBeInstanceOf(RangeError);
      expect((error as Error).message).toBe(INVALID_ISSUANCE_MESSAGE);
    });
  }

  it('never leaks the raw malformed value into the error message', () => {
    const error = captureSynchronousError(() =>
      convertKmaForecastIssuanceToIssuedAt(
        makeIssuance({ baseDate: '99999999', baseTime: 'SEKRET' as string }),
      ),
    );
    expect((error as Error).message).toBe(INVALID_ISSUANCE_MESSAGE);
    expect((error as Error).message).not.toContain('99999999');
    expect((error as Error).message).not.toContain('SEKRET');
  });
});

describe('convertKmaForecastIssuanceToIssuedAt — purity', () => {
  it('does not mutate the input and works on a frozen input', () => {
    const issuance = deepFreeze(makeIssuance({ baseDate: '20260722', baseTime: '0500' }));
    const snapshot = JSON.stringify(issuance);

    expect(convertKmaForecastIssuanceToIssuedAt(issuance)).toBe(
      '2026-07-22T05:00:00+09:00',
    );
    expect(JSON.stringify(issuance)).toBe(snapshot);
  });

  it('reads no clock and logs nothing', () => {
    const spies = spyOnConsole();
    const nowSpy = vi.spyOn(Date, 'now');

    convertKmaForecastIssuanceToIssuedAt(makeIssuance());

    expect(nowSpy).not.toHaveBeenCalled();
    expectSilent(spies);
  });
});

// ---------------------------------------------------------------------------
// Resolver — PRIMARY selected.
// ---------------------------------------------------------------------------

describe('createKmaLiveSelectedHourlySourceMetadataResolver — construction', () => {
  it('reads no clock on construction alone', () => {
    const { clock, nowEpochMilliseconds } = makeClock();
    createKmaLiveSelectedHourlySourceMetadataResolver(clock);
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
  });
});

describe('resolver — PRIMARY selected', () => {
  it('uses the actual primaryIssuance, fixed SHORT sourceId, LIVE, and clock fetchedAt', () => {
    const selection = selectOrThrow(makePrimaryExecution());
    const { clock, nowEpochMilliseconds } = makeClock();
    const resolve = createKmaLiveSelectedHourlySourceMetadataResolver(clock);

    const metadata = resolve(makeResolverInput({ selection }));

    expect(metadata.issuedAt).toBe('2026-07-22T05:00:00+09:00');
    expect(metadata.sourceId).toBe(SHORT_SOURCE_ID);
    expect(metadata.retrievalMode).toBe('LIVE');
    expect(metadata.fetchedAt).toBe(FETCHED_AT_ISO);
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(Object.keys(metadata).sort()).toEqual([...METADATA_KEYS]);
  });

  it('honors PRIMARY precedence even on a fallback-attempted trace and ignores previousIssuance', () => {
    // A structurally-valid trace with a usable primary AND a usable previous. The real selector picks
    // PRIMARY; the resolver must use primaryIssuance, never previousIssuance.
    const trace: ExecutionTrace = {
      fallbackAttempted: true,
      fallbackReason: 'EMPTY_HOURLY',
      primaryIssuance: { product: SHORT, baseDate: '20260722', baseTime: '0500' },
      primary: makeSuccessResult(),
      previousIssuance: { product: SHORT, baseDate: '20260722', baseTime: '0200' },
      previous: makeSuccessResult(),
    };
    const selection = selectOrThrow(trace);
    expect(selection.source).toBe('PRIMARY');

    const { clock } = makeClock();
    const resolve = createKmaLiveSelectedHourlySourceMetadataResolver(clock);
    const metadata = resolve(makeResolverInput({ selection }));

    expect(metadata.issuedAt).toBe('2026-07-22T05:00:00+09:00');
    expect(metadata.issuedAt).not.toBe('2026-07-22T02:00:00+09:00');
  });

  it('maps the ULTRA_SHORT_FORECAST sourceId', () => {
    const selection = selectOrThrow(
      makePrimaryExecution([makeHourly()], makeIssuance({ product: ULTRA })),
    );
    const { clock } = makeClock();
    const resolve = createKmaLiveSelectedHourlySourceMetadataResolver(clock);

    const metadata = resolve(makeResolverInput({ product: ULTRA, selection }));

    expect(metadata.sourceId).toBe(ULTRA_SOURCE_ID);
  });

  it('produces output with no forbidden leakage keys', () => {
    const selection = selectOrThrow(makePrimaryExecution());
    const { clock } = makeClock();
    const resolve = createKmaLiveSelectedHourlySourceMetadataResolver(clock);

    const metadata = resolve(makeResolverInput({ selection }));

    const record = metadata as unknown as Record<string, unknown>;
    for (const key of FORBIDDEN_METADATA_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(record, key)).toBe(false);
    }
  });

  it('returns fresh, independent output on repeated calls with the same input and clock value', () => {
    const selection = selectOrThrow(makePrimaryExecution());
    const { clock, nowEpochMilliseconds } = makeClock();
    const resolve = createKmaLiveSelectedHourlySourceMetadataResolver(clock);
    const input = makeResolverInput({ selection });

    const first = resolve(input);
    const second = resolve(input);

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(2);
  });

  it('does not mutate the input/selection/issuance and works on frozen input', () => {
    const selection = selectOrThrow(makePrimaryExecution());
    const input = deepFreeze(makeResolverInput({ selection }));
    const snapshot = JSON.stringify(input);
    const { clock } = makeClock();
    const resolve = createKmaLiveSelectedHourlySourceMetadataResolver(clock);

    const metadata = resolve(input);

    expect(metadata.issuedAt).toBe('2026-07-22T05:00:00+09:00');
    expect(JSON.stringify(input)).toBe(snapshot);
    // The output embeds no issuance object reference.
    if (input.selection.selected) {
      const record = metadata as unknown as Record<string, unknown>;
      for (const value of Object.values(record)) {
        expect(value).not.toBe(input.selection.execution.primaryIssuance);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Resolver — PREVIOUS selected.
// ---------------------------------------------------------------------------

describe('resolver — PREVIOUS selected', () => {
  it('uses the actual previousIssuance and a fixed sourceId that does not reflect PREVIOUS', () => {
    const selection = selectOrThrow(makePreviousExecution());
    expect(selection.source).toBe('PREVIOUS');
    const { clock, nowEpochMilliseconds } = makeClock();
    const resolve = createKmaLiveSelectedHourlySourceMetadataResolver(clock);

    const metadata = resolve(makeResolverInput({ selection }));

    // previous issuance drives issuedAt; primary issuance is not used.
    expect(metadata.issuedAt).toBe('2026-07-22T02:00:00+09:00');
    expect(metadata.issuedAt).not.toBe('2026-07-22T05:00:00+09:00');
    // sourceId is the fixed logical id — it does not encode PREVIOUS or fallbackUsed.
    expect(metadata.sourceId).toBe(SHORT_SOURCE_ID);
    expect(JSON.stringify(metadata)).not.toContain('PREVIOUS');
    expect(JSON.stringify(metadata)).not.toContain('fallbackUsed');
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Resolver — invalid correlation (synchronous RangeError, clock zero times).
// ---------------------------------------------------------------------------

describe('resolver — invalid correlation (static RangeError, clock zero times)', () => {
  it('rejects a PREVIOUS source on a no-fallback execution', () => {
    // Type-valid: the PREVIOUS arm allows any execution. The resolver defends the correlation.
    const selection: SelectedSelection = {
      selected: true,
      source: 'PREVIOUS',
      fallbackUsed: true,
      result: makeSuccessResult(),
      execution: makePrimaryExecution(),
    };
    const { clock, nowEpochMilliseconds } = makeClock();
    const resolve = createKmaLiveSelectedHourlySourceMetadataResolver(clock);

    const error = captureSynchronousError(() =>
      resolve(makeResolverInput({ selection })),
    );
    expect(error).toBeInstanceOf(RangeError);
    expect((error as Error).message).toBe(PREVIOUS_REQUIRES_FALLBACK_MESSAGE);
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
  });

  it('rejects a caller product that mismatches the primary issuance product', () => {
    const selection = selectOrThrow(makePrimaryExecution()); // primaryIssuance is SHORT
    const { clock, nowEpochMilliseconds } = makeClock();
    const resolve = createKmaLiveSelectedHourlySourceMetadataResolver(clock);

    const error = captureSynchronousError(() =>
      resolve(makeResolverInput({ product: ULTRA, selection })),
    );
    expect(error).toBeInstanceOf(RangeError);
    expect((error as Error).message).toBe(PRODUCT_MISMATCH_MESSAGE);
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
  });

  it('rejects a caller product that mismatches the previous issuance product', () => {
    const selection = selectOrThrow(makePreviousExecution()); // previousIssuance is SHORT
    const { clock, nowEpochMilliseconds } = makeClock();
    const resolve = createKmaLiveSelectedHourlySourceMetadataResolver(clock);

    const error = captureSynchronousError(() =>
      resolve(makeResolverInput({ product: ULTRA, selection })),
    );
    expect(error).toBeInstanceOf(RangeError);
    expect((error as Error).message).toBe(PRODUCT_MISMATCH_MESSAGE);
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
  });

  it('rejects a selected:false runtime cast', () => {
    const selection = {
      selected: false,
      source: null,
      fallbackUsed: false,
      result: null,
      execution: makePrimaryExecution(),
    } as unknown as SelectedSelection;
    const { clock, nowEpochMilliseconds } = makeClock();
    const resolve = createKmaLiveSelectedHourlySourceMetadataResolver(clock);

    const error = captureSynchronousError(() =>
      resolve(makeResolverInput({ selection })),
    );
    expect(error).toBeInstanceOf(RangeError);
    expect((error as Error).message).toBe(INVALID_SELECTION_MESSAGE);
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
  });

  it('rejects an unknown source runtime cast', () => {
    const selection = {
      selected: true,
      source: 'SECONDARY',
      fallbackUsed: false,
      result: makeSuccessResult(),
      execution: makePrimaryExecution(),
    } as unknown as SelectedSelection;
    const { clock, nowEpochMilliseconds } = makeClock();
    const resolve = createKmaLiveSelectedHourlySourceMetadataResolver(clock);

    const error = captureSynchronousError(() =>
      resolve(makeResolverInput({ selection })),
    );
    expect(error).toBeInstanceOf(RangeError);
    expect((error as Error).message).toBe(INVALID_SELECTION_MESSAGE);
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
  });

  it('rejects a selected issuance with a malformed date/time before reading the clock', () => {
    const trace = makePrimaryExecution(
      [makeHourly()],
      makeIssuance({ baseDate: '20261399', baseTime: '0500' }),
    );
    const selection = selectOrThrow(trace);
    const { clock, nowEpochMilliseconds } = makeClock();
    const resolve = createKmaLiveSelectedHourlySourceMetadataResolver(clock);

    const error = captureSynchronousError(() =>
      resolve(makeResolverInput({ selection })),
    );
    expect(error).toBeInstanceOf(RangeError);
    expect((error as Error).message).toBe(INVALID_ISSUANCE_MESSAGE);
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
  });

  it('rejects an unsupported issuance product before reading the clock', () => {
    const unsupported = 'ULTRA_SHORT_NCST' as unknown as KmaForecastProduct;
    const trace = makePrimaryExecution(
      [makeHourly()],
      makeIssuance({ product: unsupported }),
    );
    const selection = selectOrThrow(trace);
    const { clock, nowEpochMilliseconds } = makeClock();
    const resolve = createKmaLiveSelectedHourlySourceMetadataResolver(clock);

    // Caller product matches the (unsupported) issuance product, so correlation passes and the fixed
    // sourceId mapping is the guard that rejects it.
    const error = captureSynchronousError(() =>
      resolve(makeResolverInput({ product: unsupported, selection })),
    );
    expect(error).toBeInstanceOf(RangeError);
    expect((error as Error).message).toBe(UNSUPPORTED_PRODUCT_MESSAGE);
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
  });

  it('logs nothing and returns no partial object on an invalid input', () => {
    const spies = spyOnConsole();
    const selection = selectOrThrow(makePrimaryExecution());
    const { clock } = makeClock();
    const resolve = createKmaLiveSelectedHourlySourceMetadataResolver(clock);

    let returned: unknown;
    captureSynchronousError(() => {
      returned = resolve(makeResolverInput({ product: ULTRA, selection }));
    });

    expect(returned).toBeUndefined();
    expectSilent(spies);
  });
});

// ---------------------------------------------------------------------------
// Resolver — clock handling.
// ---------------------------------------------------------------------------

describe('resolver — clock handling', () => {
  it('propagates a throwing clock as the same error reference (read once)', () => {
    const sentinel = new Error('CLOCK_THROW_SENTINEL');
    const { clock, nowEpochMilliseconds } = makeThrowingClock(sentinel);
    const selection = selectOrThrow(makePrimaryExecution());
    const resolve = createKmaLiveSelectedHourlySourceMetadataResolver(clock);

    const error = captureSynchronousError(() =>
      resolve(makeResolverInput({ selection })),
    );
    expect(error).toBe(sentinel);
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
  });

  const invalidClockValues: ReadonlyArray<{ readonly name: string; readonly value: number }> =
    [
      { name: 'NaN', value: NaN },
      { name: 'Infinity', value: Infinity },
      { name: '-Infinity', value: -Infinity },
      { name: 'fractional epoch', value: 1_784_000_000_000.5 },
      { name: 'unsafe integer', value: Number.MAX_SAFE_INTEGER + 2 },
      { name: 'out-of-Date-range safe integer', value: 8_700_000_000_000_000 },
    ];

  for (const { name, value } of invalidClockValues) {
    it(`rejects a ${name} clock value with a static RangeError`, () => {
      const { clock, nowEpochMilliseconds } = makeClock(value);
      const selection = selectOrThrow(makePrimaryExecution());
      const resolve = createKmaLiveSelectedHourlySourceMetadataResolver(clock);

      const error = captureSynchronousError(() =>
        resolve(makeResolverInput({ selection })),
      );
      expect(error).toBeInstanceOf(RangeError);
      expect((error as Error).message).toBe(INVALID_CLOCK_MESSAGE);
      expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    });
  }

  it('accepts epoch 0', () => {
    const { clock } = makeClock(0);
    const selection = selectOrThrow(makePrimaryExecution());
    const resolve = createKmaLiveSelectedHourlySourceMetadataResolver(clock);

    expect(resolve(makeResolverInput({ selection })).fetchedAt).toBe(
      '1970-01-01T00:00:00.000Z',
    );
  });

  it('accepts a negative valid epoch', () => {
    const { clock } = makeClock(-1);
    const selection = selectOrThrow(makePrimaryExecution());
    const resolve = createKmaLiveSelectedHourlySourceMetadataResolver(clock);

    expect(resolve(makeResolverInput({ selection })).fetchedAt).toBe(
      '1969-12-31T23:59:59.999Z',
    );
  });

  it('emits UTC Z with exactly three millisecond digits', () => {
    const { clock } = makeClock();
    const selection = selectOrThrow(makePrimaryExecution());
    const resolve = createKmaLiveSelectedHourlySourceMetadataResolver(clock);

    const fetchedAt = resolve(makeResolverInput({ selection })).fetchedAt;
    expect(fetchedAt).toBe(FETCHED_AT_ISO);
    expect(fetchedAt).toMatch(UTC_MILLISECONDS_PATTERN);
  });
});

// ---------------------------------------------------------------------------
// Integration with the REAL PR #24 service, PR #22 selector, PR #23 assembler.
// Only the PR #21 facade is faked.
// ---------------------------------------------------------------------------

describe('integration with the PR #24 location hourly-overview service', () => {
  it('PRIMARY selected — one KMA HOURLY source with the actual primary issuance and LIVE clock', async () => {
    const hourly = [makeHourly('2026-07-22T14:00:00+09:00')];
    const { facade } = resolvingFacade(makePrimaryExecution(hourly));
    const { clock, nowEpochMilliseconds } = makeClock();
    const resolver = createKmaLiveSelectedHourlySourceMetadataResolver(clock);
    const service = createKmaLocationHourlyOverviewService(facade, resolver);

    const result = await service.fetchHourlyWeatherOverviewForLocation(
      makeServiceInput(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected an application success');
    }
    expect(weatherOverview.safeParse(result.overview).success).toBe(true);
    expect(result.overview.sources).toHaveLength(1);
    const source = result.overview.sources[0];
    expect(source.provider).toBe('KMA');
    expect(source.sections).toEqual(['HOURLY']);
    expect(source.observedAt).toBeNull();
    expect(source.issuedAt).toBe('2026-07-22T05:00:00+09:00');
    expect(source.sourceId).toBe(SHORT_SOURCE_ID);
    expect(source.fetchedAt).toBe(FETCHED_AT_ISO);
    expect(source.retrievalMode).toBe('LIVE');
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
  });

  it('PREVIOUS selected — uses the actual previous issuance, and no PREVIOUS string leaks into the overview', async () => {
    const { facade } = resolvingFacade(makePreviousExecution());
    const { clock } = makeClock();
    const resolver = createKmaLiveSelectedHourlySourceMetadataResolver(clock);
    const service = createKmaLocationHourlyOverviewService(facade, resolver);

    const result = await service.fetchHourlyWeatherOverviewForLocation(
      makeServiceInput(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected an application success');
    }
    expect(result.selection.selected).toBe(true);
    expect(result.selection.fallbackUsed).toBe(true);
    const source = result.overview.sources[0];
    expect(source.issuedAt).toBe('2026-07-22T02:00:00+09:00');
    expect(source.sourceId).toBe(SHORT_SOURCE_ID);
    // fallbackUsed / PRIMARY-PREVIOUS distinction live only inside `selection`, never the overview.
    expect(JSON.stringify(result.overview)).not.toContain('PREVIOUS');
    expect(JSON.stringify(result.overview)).not.toContain('fallbackUsed');
  });

  it('no selection — resolver and clock are never invoked and HOURLY is missing', async () => {
    const trace: ExecutionTrace = {
      fallbackAttempted: false,
      primaryIssuance: makePrimaryIssuance(),
      primary: makeEmptySuccessResult(),
    };
    const { facade } = resolvingFacade(trace);
    const { clock, nowEpochMilliseconds } = makeClock();
    const { resolver, spy } = spyResolver(clock);
    const service = createKmaLocationHourlyOverviewService(facade, resolver);

    const result = await service.fetchHourlyWeatherOverviewForLocation(
      makeServiceInput(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected an application success');
    }
    expect(spy).not.toHaveBeenCalled();
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(result.overview.sources).toEqual([]);
    expect(result.overview.hourly).toEqual([]);
    expect(result.overview.missingSections).toContain('HOURLY');
  });

  it('LOCATION — resolver and clock are never invoked and the facade result passes through exactly', async () => {
    const failure = makeLocationFailure();
    const { facade } = resolvingFacade(failure);
    const { clock, nowEpochMilliseconds } = makeClock();
    const { resolver, spy } = spyResolver(clock);
    const service = createKmaLocationHourlyOverviewService(facade, resolver);

    const result = await service.fetchHourlyWeatherOverviewForLocation(
      makeServiceInput(),
    );

    expect(result).toBe(failure);
    expect(spy).not.toHaveBeenCalled();
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
  });

  it('malformed selected issuance — PR #24 returns a rejected Promise (RangeError), no assembler success', async () => {
    const trace = makePrimaryExecution(
      [makeHourly()],
      makeIssuance({ baseDate: '20261399', baseTime: '0500' }),
    );
    const { facade } = resolvingFacade(trace);
    const { clock, nowEpochMilliseconds } = makeClock();
    const resolver = createKmaLiveSelectedHourlySourceMetadataResolver(clock);
    const service = createKmaLocationHourlyOverviewService(facade, resolver);

    const error = await service
      .fetchHourlyWeatherOverviewForLocation(makeServiceInput())
      .then(
        () => {
          throw new Error('expected a rejection, not a success');
        },
        (rejected: unknown) => rejected,
      );

    expect(error).toBeInstanceOf(RangeError);
    expect((error as Error).message).toBe(INVALID_ISSUANCE_MESSAGE);
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
  });

  it('clock throw — PR #24 returns a rejected Promise with the same reason and no partial overview', async () => {
    const sentinel = new Error('INTEGRATION_CLOCK_SENTINEL');
    const { clock } = makeThrowingClock(sentinel);
    const { facade } = resolvingFacade(makePrimaryExecution());
    const resolver = createKmaLiveSelectedHourlySourceMetadataResolver(clock);
    const service = createKmaLocationHourlyOverviewService(facade, resolver);

    await expect(
      service.fetchHourlyWeatherOverviewForLocation(makeServiceInput()),
    ).rejects.toBe(sentinel);
  });
});
