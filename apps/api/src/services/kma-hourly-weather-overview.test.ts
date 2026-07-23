import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  hourlyForecast,
  weatherOverview,
  type HourlyForecast,
  type WeatherLocation,
} from '@life-weather/contracts';
import { KmaForecastProduct } from '@life-weather/weather-core';

import type { KmaHourlyFallbackReason } from './kma-hourly-fallback-eligibility';
import type { KmaHourlyFallbackSelection } from './kma-hourly-fallback-selection';
import type { KmaHourlyFallbackServiceResult } from './kma-hourly-fallback';
import type { KmaHourlyForecastServiceResult } from './kma-hourly-forecast';
import {
  assembleKmaHourlyWeatherOverview,
  type KmaHourlySourceMetadataInput,
  type KmaHourlyWeatherOverviewInput,
} from './kma-hourly-weather-overview';

// ---------------------------------------------------------------------------
// Key contracts — the exact own keys the assembler must emit, and the
// application/selection fields that must never leak onto the overview payload.
// ---------------------------------------------------------------------------

/** The exact top-level own keys of every assembled overview, sorted for a stable comparison. */
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

/** The exact own keys of `airQuality`, sorted. */
const AIR_QUALITY_KEYS = ['current', 'daily'] as const;

/** The exact own keys of a selected KMA `HOURLY` source metadata entry, sorted. */
const SOURCE_KEYS = [
  'fetchedAt',
  'issuedAt',
  'observedAt',
  'provider',
  'retrievalMode',
  'sections',
  'sourceId',
] as const;

/** The exact `missingSections` for a selected hourly source (HOURLY is present, so not missing). */
const SELECTED_MISSING = [
  'CURRENT',
  'DAILY',
  'AIR_QUALITY_CURRENT',
  'AIR_QUALITY_FORECAST',
  'ALERTS',
] as const;

/** The exact `missingSections` when no hourly source was selected (HOURLY is missing too). */
const NO_SELECTION_MISSING = [
  'CURRENT',
  'HOURLY',
  'DAILY',
  'AIR_QUALITY_CURRENT',
  'AIR_QUALITY_FORECAST',
  'ALERTS',
] as const;

/**
 * Application/selection-internal fields that must never appear on the overview or its source metadata:
 * selection-trace fields (they stay with the caller) and every transport/selection alias the design
 * forbids on the `WeatherOverview` payload.
 */
const FORBIDDEN_TOP_LEVEL_KEYS = [
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
  'error',
  'ok',
  'stale',
  'metadata',
  'grid',
  'request',
  'plan',
] as const;

/** The forecast product every fixture trace uses. */
const SHORT = KmaForecastProduct.SHORT_FORECAST;

// ---------------------------------------------------------------------------
// Fixture builders — every mutable fixture is built fresh per call, so no test
// shares a mutable input/selection/hourly/source object.
// ---------------------------------------------------------------------------

/** The success branch of a hourly-forecast service result (the only branch a selection carries). */
type SuccessResult = Extract<KmaHourlyForecastServiceResult, { readonly ok: true }>;

/** The selected arm of a fallback selection (PRIMARY or PREVIOUS). */
type SelectedSelection = Extract<KmaHourlyFallbackSelection, { readonly selected: true }>;

/** The no-selection arm of a fallback selection. */
type NoSelection = Extract<KmaHourlyFallbackSelection, { readonly selected: false }>;

/** The selected arm of the assembler input (source is a provenance context, `selection.result` non-null). */
type SelectedOverviewInput = Extract<
  KmaHourlyWeatherOverviewInput,
  { readonly source: KmaHourlySourceMetadataInput }
>;

/**
 * A fresh, complete, schema-valid `HourlyForecast` literal. `forecastAt` is overridable so a test can
 * build distinct, ordered entries; every other field is a concrete value.
 */
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

/** A fresh, complete, schema-valid `WeatherLocation` literal; overridable per field for edge cases. */
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

/** A fresh non-empty success result carrying the given (or a fresh default) hourly array. */
function makeSuccessResult(
  hourly: readonly HourlyForecast[] = [makeHourly()],
): SuccessResult {
  return { ok: true, hourly };
}

/** A fresh empty success result (used as the unusable primary behind a PREVIOUS/none selection). */
function makeEmptySuccessResult(): SuccessResult {
  return { ok: true, hourly: [] };
}

/** A fresh PRIMARY selection whose selected `result` carries the given hourly array. */
function makePrimarySelection(
  hourly: readonly HourlyForecast[] = [makeHourly()],
): SelectedSelection {
  const result = makeSuccessResult(hourly);
  const execution: KmaHourlyFallbackServiceResult = {
    fallbackAttempted: false,
    primaryIssuance: { product: SHORT, baseDate: '20260722', baseTime: '0500' },
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

/**
 * A fresh PREVIOUS selection: an unusable (empty) primary, a usable `previous` carrying the given
 * hourly array, and the `previous` result as the selected `result`.
 */
function makePreviousSelection(
  previousHourly: readonly HourlyForecast[] = [makeHourly('2026-07-22T13:00:00+09:00')],
  fallbackReason: KmaHourlyFallbackReason = 'EMPTY_HOURLY',
): SelectedSelection {
  const primary = makeEmptySuccessResult();
  const previous = makeSuccessResult(previousHourly);
  const execution: KmaHourlyFallbackServiceResult = {
    fallbackAttempted: true,
    fallbackReason,
    primaryIssuance: { product: SHORT, baseDate: '20260722', baseTime: '0500' },
    primary,
    previousIssuance: { product: SHORT, baseDate: '20260722', baseTime: '0200' },
    previous,
  };
  return {
    selected: true,
    source: 'PREVIOUS',
    fallbackUsed: true,
    result: previous,
    execution,
  };
}

/** A fresh no-selection outcome (both attempts unusable). */
function makeNoSelection(): NoSelection {
  const primary = makeEmptySuccessResult();
  const previous = makeEmptySuccessResult();
  const execution: KmaHourlyFallbackServiceResult = {
    fallbackAttempted: true,
    fallbackReason: 'EMPTY_HOURLY',
    primaryIssuance: { product: SHORT, baseDate: '20260722', baseTime: '0500' },
    primary,
    previousIssuance: { product: SHORT, baseDate: '20260722', baseTime: '0200' },
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

/** A fresh selected-source provenance context; overridable per field. */
function makeSource(
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

/** A fresh selected (PRIMARY) assembler input. */
function makePrimaryInput(options: {
  readonly location?: WeatherLocation;
  readonly hourly?: readonly HourlyForecast[];
  readonly source?: KmaHourlySourceMetadataInput;
} = {}): SelectedOverviewInput {
  return {
    location: options.location ?? makeLocation(),
    selection: makePrimarySelection(options.hourly ?? [makeHourly()]),
    source: options.source ?? makeSource(),
  };
}

/** A fresh selected (PREVIOUS) assembler input using a distinct default provenance. */
function makePreviousInput(options: {
  readonly location?: WeatherLocation;
  readonly hourly?: readonly HourlyForecast[];
  readonly source?: KmaHourlySourceMetadataInput;
} = {}): SelectedOverviewInput {
  return {
    location: options.location ?? makeLocation(),
    selection: makePreviousSelection(
      options.hourly ?? [makeHourly('2026-07-22T13:00:00+09:00')],
    ),
    source:
      options.source ??
      makeSource({
        sourceId: 'kma-hourly-previous',
        issuedAt: '2026-07-22T02:00:00+09:00',
        fetchedAt: '2026-07-22T05:05:00+09:00',
        retrievalMode: 'CACHE',
      }),
  };
}

/** A fresh no-selection assembler input (source is exactly `null`). */
function makeNoSelectionInput(
  location: WeatherLocation = makeLocation(),
): KmaHourlyWeatherOverviewInput {
  return {
    location,
    selection: makeNoSelection(),
    source: null,
  };
}

// ---------------------------------------------------------------------------
// Assertion / spy helpers.
// ---------------------------------------------------------------------------

/** Assert the overview has exactly the eight top-level keys and none of the forbidden ones. */
function expectExactOverviewShape(overview: unknown): void {
  expect(typeof overview).toBe('object');
  const record = overview as Record<string, unknown>;
  expect(Object.keys(record).sort()).toEqual([...OVERVIEW_KEYS]);
  for (const key of FORBIDDEN_TOP_LEVEL_KEYS) {
    expect(Object.prototype.hasOwnProperty.call(record, key)).toBe(false);
  }
  expect(Object.keys(record.airQuality as object).sort()).toEqual([
    ...AIR_QUALITY_KEYS,
  ]);
}

/** Capture whatever a thunk throws, or `undefined` when it does not throw. */
function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Assert a captured error is a Zod validation error (matched by name, not cross-instance identity). */
function expectZodError(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  expect((error as { name?: string }).name).toBe('ZodError');
  expect(Array.isArray((error as { issues?: unknown }).issues)).toBe(true);
}

/** Spy on the three console methods used in a run; each returns a no-op mock. */
function spyOnConsole(): {
  log: ReturnType<typeof vi.spyOn>;
  warn: ReturnType<typeof vi.spyOn>;
  error: ReturnType<typeof vi.spyOn>;
} {
  return {
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
  };
}

/** Recursively freeze so any attempted mutation of the input would throw in strict mode. */
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
// Fixture sanity — the fixtures satisfy the real contracts before use.
// ---------------------------------------------------------------------------

describe('fixture sanity', () => {
  it('builds HourlyForecast fixtures that satisfy the real contracts schema', () => {
    expect(hourlyForecast.safeParse(makeHourly()).success).toBe(true);
    expect(
      hourlyForecast.safeParse(makeHourly('2026-07-22T15:00:00+09:00')).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §15 — PRIMARY selected.
// ---------------------------------------------------------------------------

describe('PRIMARY selected', () => {
  it('assembles a valid hourly-only overview from a PRIMARY selection', () => {
    const hourly = [
      makeHourly('2026-07-22T14:00:00+09:00'),
      makeHourly('2026-07-22T15:00:00+09:00'),
    ];
    const source = makeSource();
    const input = makePrimaryInput({ hourly, source });

    const overview = assembleKmaHourlyWeatherOverview(input);

    // Re-validates against the real contract (idempotent parse of the assembled payload).
    expect(weatherOverview.safeParse(overview).success).toBe(true);

    // Placeholders for the not-yet-collected sections.
    expect(overview.current).toBeNull();
    expect(overview.daily).toEqual([]);
    expect(overview.airQuality.current).toBeNull();
    expect(overview.airQuality.daily).toEqual([]);
    expect(overview.alerts).toEqual([]);

    // Hourly value and order preserved.
    expect(overview.hourly).toEqual(hourly);
    expect(overview.hourly.map((entry) => entry.forecastAt)).toEqual([
      '2026-07-22T14:00:00+09:00',
      '2026-07-22T15:00:00+09:00',
    ]);

    // missingSections is exact and does not include HOURLY.
    expect(overview.missingSections).toEqual([...SELECTED_MISSING]);
    expect(overview.missingSections).not.toContain('HOURLY');

    // Exactly one KMA HOURLY source with the caller's provenance verbatim.
    expect(overview.sources).toHaveLength(1);
    const [metadata] = overview.sources;
    expect(metadata.provider).toBe('KMA');
    expect(metadata.sections).toEqual(['HOURLY']);
    expect(metadata.observedAt).toBeNull();
    expect(metadata.sourceId).toBe(source.sourceId);
    expect(metadata.issuedAt).toBe(source.issuedAt);
    expect(metadata.fetchedAt).toBe(source.fetchedAt);
    expect(metadata.retrievalMode).toBe(source.retrievalMode);

    // No application/selection trace leaked onto the payload.
    expectExactOverviewShape(overview);
  });

  it('accepts and preserves an explicit null issuedAt on a selected source', () => {
    const input = makePrimaryInput({ source: makeSource({ issuedAt: null }) });

    const overview = assembleKmaHourlyWeatherOverview(input);

    expect(weatherOverview.safeParse(overview).success).toBe(true);
    expect(overview.sources[0].issuedAt).toBeNull();
    expect(overview.sources[0].observedAt).toBeNull();
  });

  it('does not mutate the input when assembling a PRIMARY overview', () => {
    const input = makePrimaryInput();
    const snapshot = JSON.stringify(input);

    assembleKmaHourlyWeatherOverview(input);

    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// §16 — PREVIOUS selected.
// ---------------------------------------------------------------------------

describe('PREVIOUS selected', () => {
  it('uses the selected previous hourly and the caller-provided provenance', () => {
    const previousHourly = [makeHourly('2026-07-22T11:00:00+09:00')];
    const source = makeSource({
      sourceId: 'kma-hourly-previous',
      issuedAt: '2026-07-22T02:00:00+09:00',
      fetchedAt: '2026-07-22T05:05:00+09:00',
      retrievalMode: 'CACHE',
    });
    const input = makePreviousInput({ hourly: previousHourly, source });

    const overview = assembleKmaHourlyWeatherOverview(input);

    expect(weatherOverview.safeParse(overview).success).toBe(true);

    // The output hourly is the selected previous result, not the empty primary.
    expect(overview.hourly).toEqual(previousHourly);
    expect(overview.missingSections).not.toContain('HOURLY');
    expect(overview.missingSections).toEqual([...SELECTED_MISSING]);

    // Metadata matches the caller's selected-source context (a distinct source from the PRIMARY test).
    expect(overview.sources).toHaveLength(1);
    const [metadata] = overview.sources;
    expect(metadata.provider).toBe('KMA');
    expect(metadata.sections).toEqual(['HOURLY']);
    expect(metadata.observedAt).toBeNull();
    expect(metadata.sourceId).toBe('kma-hourly-previous');
    expect(metadata.issuedAt).toBe('2026-07-22T02:00:00+09:00');
    expect(metadata.fetchedAt).toBe('2026-07-22T05:05:00+09:00');
    expect(metadata.retrievalMode).toBe('CACHE');

    expectExactOverviewShape(overview);
  });

  it('assembles identically for PRIMARY and PREVIOUS given the same hourly and provenance', () => {
    // The assembler consumes only `selection.result.hourly`; it never re-judges the PRIMARY/PREVIOUS
    // policy, so the emitted overview does not depend on the selection `source` discriminant.
    const hourly = [
      makeHourly('2026-07-22T14:00:00+09:00'),
      makeHourly('2026-07-22T15:00:00+09:00'),
    ];
    const source = makeSource();

    const primaryOverview = assembleKmaHourlyWeatherOverview({
      location: makeLocation(),
      selection: makePrimarySelection(hourly),
      source,
    });
    const previousOverview = assembleKmaHourlyWeatherOverview({
      location: makeLocation(),
      selection: makePreviousSelection(hourly),
      source,
    });

    expect(primaryOverview).toEqual(previousOverview);
  });
});

// ---------------------------------------------------------------------------
// §17 — no selection.
// ---------------------------------------------------------------------------

describe('no selection', () => {
  it('assembles a valid empty-hourly overview that marks HOURLY missing', () => {
    const input = makeNoSelectionInput();

    const overview = assembleKmaHourlyWeatherOverview(input);

    expect(weatherOverview.safeParse(overview).success).toBe(true);

    expect(overview.hourly).toEqual([]);
    expect(overview.sources).toEqual([]);

    // All six sections — including HOURLY — are missing.
    expect(overview.missingSections).toEqual([...NO_SELECTION_MISSING]);
    for (const section of NO_SELECTION_MISSING) {
      expect(overview.missingSections).toContain(section);
    }
    expect(overview.missingSections).toContain('HOURLY');

    // Placeholders.
    expect(overview.current).toBeNull();
    expect(overview.daily).toEqual([]);
    expect(overview.airQuality.current).toBeNull();
    expect(overview.airQuality.daily).toEqual([]);
    expect(overview.alerts).toEqual([]);

    expectExactOverviewShape(overview);
  });

  it('does not mutate a no-selection input', () => {
    const input = makeNoSelectionInput();
    const snapshot = JSON.stringify(input);

    assembleKmaHourlyWeatherOverview(input);

    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// §18 — exact keys.
// ---------------------------------------------------------------------------

describe('exact keys', () => {
  it('selected output has exactly the eight top-level keys, two airQuality keys, seven source keys', () => {
    const overview = assembleKmaHourlyWeatherOverview(makePrimaryInput());

    expect(Object.keys(overview).sort()).toEqual([...OVERVIEW_KEYS]);
    expect(Object.keys(overview.airQuality).sort()).toEqual([
      ...AIR_QUALITY_KEYS,
    ]);
    expect(overview.sources).toHaveLength(1);
    expect(Object.keys(overview.sources[0]).sort()).toEqual([...SOURCE_KEYS]);

    for (const key of FORBIDDEN_TOP_LEVEL_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(overview, key)).toBe(false);
    }
  });

  it('no-selection output has exactly the eight top-level keys, two airQuality keys, empty sources', () => {
    const overview = assembleKmaHourlyWeatherOverview(makeNoSelectionInput());

    expect(Object.keys(overview).sort()).toEqual([...OVERVIEW_KEYS]);
    expect(Object.keys(overview.airQuality).sort()).toEqual([
      ...AIR_QUALITY_KEYS,
    ]);
    expect(overview.sources).toEqual([]);

    for (const key of FORBIDDEN_TOP_LEVEL_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(overview, key)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// §19 — synchronous validation failures via the typed boundary.
// ---------------------------------------------------------------------------

describe('validation failures', () => {
  const invalidCases: ReadonlyArray<{
    readonly name: string;
    readonly input: () => KmaHourlyWeatherOverviewInput;
  }> = [
    {
      name: 'malformed location timezone',
      // A non-IANA zone: the contract type is `string`, so this is a runtime-only violation.
      input: () => makePrimaryInput({ location: makeLocation({ timezone: 'Seoul' }) }),
    },
    {
      name: 'out-of-range latitude',
      input: () => makePrimaryInput({ location: makeLocation({ latitude: 999 }) }),
    },
    {
      name: 'empty sourceId',
      input: () => makePrimaryInput({ source: makeSource({ sourceId: '' }) }),
    },
    {
      name: 'malformed issuedAt',
      input: () =>
        makePrimaryInput({ source: makeSource({ issuedAt: 'not-a-timestamp' }) }),
    },
    {
      name: 'malformed fetchedAt',
      input: () => makePrimaryInput({ source: makeSource({ fetchedAt: 'nope' }) }),
    },
    {
      // A directly-constructed selected PRIMARY input with an empty `hourly` — the public selected type
      // allows it (its `result.hourly` is a plain `readonly HourlyForecast[]`, no cast needed here), but
      // the assembler's module-local nonempty guard rejects it before any overview/source is built.
      name: 'selected PRIMARY with empty hourly',
      input: () => makePrimaryInput({ hourly: [] }),
    },
    {
      // Same nonempty boundary regardless of the selected source discriminator: a selected PREVIOUS
      // input with an empty `hourly` is rejected identically.
      name: 'selected PREVIOUS with empty hourly',
      input: () => makePreviousInput({ hourly: [] }),
    },
  ];

  for (const { name, input } of invalidCases) {
    it(`throws a synchronous ZodError for a ${name} and leaves the input unmutated`, () => {
      const built = input();
      const snapshot = JSON.stringify(built);
      const spies = spyOnConsole();

      const error = captureError(() => assembleKmaHourlyWeatherOverview(built));

      expectZodError(error);
      expect(JSON.stringify(built)).toBe(snapshot);
      expect(spies.log).not.toHaveBeenCalled();
      expect(spies.warn).not.toHaveBeenCalled();
      expect(spies.error).not.toHaveBeenCalled();
    });
  }

  it('still validates the location on a no-selection input (no source to validate)', () => {
    const input = makeNoSelectionInput(makeLocation({ timezone: 'Seoul' }));

    const error = captureError(() => assembleKmaHourlyWeatherOverview(input));

    expectZodError(error);
  });

  it('does not validate any source on a valid no-selection input', () => {
    // No source metadata exists to validate on the no-selection branch, so a valid location assembles.
    const input = makeNoSelectionInput();

    expect(() => assembleKmaHourlyWeatherOverview(input)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// §20 — immutability and output freshness.
// ---------------------------------------------------------------------------

describe('immutability and freshness', () => {
  it('accepts a deeply frozen selected input and assembles correctly', () => {
    const input = deepFreeze(makePrimaryInput());

    expect(() => assembleKmaHourlyWeatherOverview(input)).not.toThrow();

    const overview = assembleKmaHourlyWeatherOverview(input);
    expect(overview.hourly).toEqual([...input.selection.result.hourly]);
    expect(weatherOverview.safeParse(overview).success).toBe(true);
  });

  it('accepts a deeply frozen PREVIOUS input and no-selection input', () => {
    const previous = deepFreeze(makePreviousInput());
    const none = deepFreeze(makeNoSelectionInput());

    expect(() => assembleKmaHourlyWeatherOverview(previous)).not.toThrow();
    expect(() => assembleKmaHourlyWeatherOverview(none)).not.toThrow();
  });

  it('does not mutate the frozen input snapshot', () => {
    const input = deepFreeze(makePrimaryInput());
    const snapshot = JSON.stringify(input);

    assembleKmaHourlyWeatherOverview(input);

    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('returns a fresh overview with fresh nested arrays/objects on each call', () => {
    const input = makePrimaryInput();

    const first = assembleKmaHourlyWeatherOverview(input);
    const second = assembleKmaHourlyWeatherOverview(input);

    // Distinct top-level references but deep-equal values.
    expect(first).not.toBe(second);
    expect(first).toEqual(second);

    // Every nested array/object is freshly allocated per call.
    expect(first.hourly).not.toBe(second.hourly);
    expect(first.daily).not.toBe(second.daily);
    expect(first.alerts).not.toBe(second.alerts);
    expect(first.sources).not.toBe(second.sources);
    expect(first.airQuality).not.toBe(second.airQuality);
    expect(first.airQuality.daily).not.toBe(second.airQuality.daily);
    expect(first.missingSections).not.toBe(second.missingSections);

    // The output hourly array is not the input's readonly service-result array.
    expect(first.hourly).not.toBe(input.selection.result.hourly);
  });

  it('is unaffected by a caller mutating an earlier returned overview', () => {
    const input = makePrimaryInput();

    const first = assembleKmaHourlyWeatherOverview(input);
    // Mutate the first result's nested collections — a fresh call must be untouched.
    first.hourly.push(makeHourly('2026-07-22T23:00:00+09:00'));
    first.missingSections.push('HOURLY');
    first.sources.pop();

    const second = assembleKmaHourlyWeatherOverview(input);

    expect(second.hourly).toHaveLength(input.selection.result.hourly.length);
    expect(second.missingSections).toEqual([...SELECTED_MISSING]);
    expect(second.sources).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// §21 — synchronous, side-effect-free contract.
// ---------------------------------------------------------------------------

describe('synchronous contract', () => {
  it('returns a plain value, not a Promise or thenable', () => {
    const overview = assembleKmaHourlyWeatherOverview(makePrimaryInput());

    expect(overview instanceof Promise).toBe(false);
    expect('then' in (overview as object)).toBe(false);
  });

  it('never reads the system clock (Date.now)', () => {
    const nowSpy = vi.spyOn(Date, 'now');

    assembleKmaHourlyWeatherOverview(makePrimaryInput());
    assembleKmaHourlyWeatherOverview(makePreviousInput());
    assembleKmaHourlyWeatherOverview(makeNoSelectionInput());

    expect(nowSpy).not.toHaveBeenCalled();
  });

  it('never calls console.log / console.warn / console.error', () => {
    const spies = spyOnConsole();

    assembleKmaHourlyWeatherOverview(makePrimaryInput());
    assembleKmaHourlyWeatherOverview(makePreviousInput());
    assembleKmaHourlyWeatherOverview(makeNoSelectionInput());

    expect(spies.log).not.toHaveBeenCalled();
    expect(spies.warn).not.toHaveBeenCalled();
    expect(spies.error).not.toHaveBeenCalled();
  });
});
