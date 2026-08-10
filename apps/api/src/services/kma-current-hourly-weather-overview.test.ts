import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  weatherOverview,
  type CurrentWeather,
  type HourlyForecast,
  type WeatherLocation,
  type WeatherOverview,
} from '@life-weather/contracts';
import { KmaForecastProduct } from '@life-weather/weather-core';

import {
  assembleKmaCurrentWeatherOverview,
  type KmaCurrentSourceMetadataInput,
} from './kma-current-weather-overview.js';
import type { KmaHourlyFallbackSelection } from './kma-hourly-fallback-selection.js';
import type { KmaHourlyFallbackServiceResult } from './kma-hourly-fallback.js';
import type { KmaHourlyForecastServiceResult } from './kma-hourly-forecast.js';
import {
  assembleKmaHourlyWeatherOverview,
  type KmaHourlySourceMetadataInput,
} from './kma-hourly-weather-overview.js';
import type { KmaLocationCurrentOverviewResult } from './kma-location-current-overview.js';
import type { KmaLocationHourlyOverviewResult } from './kma-location-hourly-overview.js';
import {
  assembleKmaCurrentHourlyWeatherOverview,
  type KmaCurrentHourlyWeatherOverviewInput,
} from './kma-current-hourly-weather-overview.js';

// ---------------------------------------------------------------------------
// Narrowed success types (module-local mirrors of the production module's).
// ---------------------------------------------------------------------------

type HourlySuccessResult = Extract<KmaHourlyForecastServiceResult, { readonly ok: true }>;
type SelectedSelection = Extract<KmaHourlyFallbackSelection, { readonly selected: true }>;
type NoSelection = Extract<KmaHourlyFallbackSelection, { readonly selected: false }>;
type HourlyOverviewSuccess = Extract<KmaLocationHourlyOverviewResult, { readonly ok: true }>;
type CurrentOverviewSuccess = Extract<KmaLocationCurrentOverviewResult, { readonly ok: true }>;

const SHORT = KmaForecastProduct.SHORT_FORECAST;

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

/** `missingSections` for a current-present + selected-hourly aggregate: exactly 4, CURRENT and HOURLY absent. */
const CURRENT_AND_SELECTED_HOURLY_MISSING = [
  'DAILY',
  'AIR_QUALITY_CURRENT',
  'AIR_QUALITY_FORECAST',
  'ALERTS',
] as const;

/** `missingSections` for a current-present + no-selection-hourly aggregate: HOURLY missing, CURRENT absent. */
const CURRENT_AND_NO_SELECTION_HOURLY_MISSING = [
  'HOURLY',
  'DAILY',
  'AIR_QUALITY_CURRENT',
  'AIR_QUALITY_FORECAST',
  'ALERTS',
] as const;

/** `missingSections` for a current-absent + selected-hourly aggregate (the unchanged hourly baseline). */
const NO_CURRENT_SELECTED_HOURLY_MISSING = [
  'CURRENT',
  'DAILY',
  'AIR_QUALITY_CURRENT',
  'AIR_QUALITY_FORECAST',
  'ALERTS',
] as const;

/** `missingSections` for a current-absent + no-selection-hourly aggregate (the unchanged hourly baseline). */
const NO_CURRENT_NO_SELECTION_HOURLY_MISSING = [
  'CURRENT',
  'HOURLY',
  'DAILY',
  'AIR_QUALITY_CURRENT',
  'AIR_QUALITY_FORECAST',
  'ALERTS',
] as const;

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

function makeHourly(forecastAt = '2026-08-10T14:00:00+09:00'): HourlyForecast {
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

function makeHourlySuccessResult(
  hourly: readonly HourlyForecast[] = [makeHourly()],
): HourlySuccessResult {
  return { ok: true, hourly };
}

function makeHourlySource(
  overrides: Partial<KmaHourlySourceMetadataInput> = {},
): KmaHourlySourceMetadataInput {
  return {
    sourceId: 'kma-short-forecast-hourly',
    issuedAt: '2026-08-10T05:00:00+09:00',
    fetchedAt: '2026-08-10T05:05:00+09:00',
    retrievalMode: 'LIVE',
    ...overrides,
  };
}

function makePrimarySelection(
  hourly: readonly HourlyForecast[] = [makeHourly()],
): SelectedSelection {
  const result = makeHourlySuccessResult(hourly);
  const execution: KmaHourlyFallbackServiceResult = {
    fallbackAttempted: false,
    primaryIssuance: { product: SHORT, baseDate: '20260810', baseTime: '0500' },
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
  const primary = makeHourlySuccessResult([]);
  const previous = makeHourlySuccessResult([]);
  const execution: KmaHourlyFallbackServiceResult = {
    fallbackAttempted: true,
    fallbackReason: 'EMPTY_HOURLY',
    primaryIssuance: { product: SHORT, baseDate: '20260810', baseTime: '0500' },
    primary,
    previousIssuance: { product: SHORT, baseDate: '20260810', baseTime: '0200' },
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
    const overview = assembleKmaHourlyWeatherOverview({
      location,
      selection,
      source: null,
    });
    return { ok: true, selection, overview };
  }

  const selection = makePrimarySelection(options.hourly ?? [makeHourly()]);
  const source = options.source ?? makeHourlySource();
  const overview = assembleKmaHourlyWeatherOverview({ location, selection, source });
  return { ok: true, selection, overview };
}

function makeCurrent(overrides: Partial<CurrentWeather> = {}): CurrentWeather {
  return {
    observedAt: '2026-08-10T14:00:00+09:00',
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
    fetchedAt: '2026-08-10T05:00:00.000Z',
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

function makeAggregateInput(
  overrides: Partial<KmaCurrentHourlyWeatherOverviewInput> = {},
): KmaCurrentHourlyWeatherOverviewInput {
  return {
    hourly: overrides.hourly ?? makeHourlyOverviewSuccess(),
    current:
      overrides.current === undefined ? makeCurrentOverviewSuccess() : overrides.current,
  };
}

// ---------------------------------------------------------------------------
// Assertion / spy helpers.
// ---------------------------------------------------------------------------

function expectExactOverviewShape(overview: unknown): void {
  expect(typeof overview).toBe('object');
  const record = overview as Record<string, unknown>;
  expect(Object.keys(record).sort()).toEqual([...OVERVIEW_KEYS]);
}

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectZodError(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  expect((error as { name?: string }).name).toBe('ZodError');
  expect(Array.isArray((error as { issues?: unknown }).issues)).toBe(true);
}

function expectRangeError(error: unknown): void {
  expect(error).toBeInstanceOf(RangeError);
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
// Fixture sanity.
// ---------------------------------------------------------------------------

describe('fixture sanity', () => {
  it('builds a real hourly overview success whose overview satisfies the contract', () => {
    const success = makeHourlyOverviewSuccess();
    expect(weatherOverview.safeParse(success.overview).success).toBe(true);
  });

  it('builds a real current overview success whose overview satisfies the contract', () => {
    const success = makeCurrentOverviewSuccess();
    expect(weatherOverview.safeParse(success.overview).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A — current present + selected hourly.
// ---------------------------------------------------------------------------

describe('current present + selected hourly', () => {
  it('parses successfully and combines both sections', () => {
    const hourly = [makeHourly('2026-08-10T14:00:00+09:00'), makeHourly('2026-08-10T15:00:00+09:00')];
    const input = makeAggregateInput({
      hourly: makeHourlyOverviewSuccess({ hourly }),
      current: makeCurrentOverviewSuccess(),
    });

    const overview = assembleKmaCurrentHourlyWeatherOverview(input);

    expect(weatherOverview.safeParse(overview).success).toBe(true);
    expectExactOverviewShape(overview);

    expect(overview.current).not.toBeNull();
    expect(overview.hourly).toEqual(hourly);

    expect(overview.missingSections).not.toContain('CURRENT');
    expect(overview.missingSections).not.toContain('HOURLY');
    expect(overview.missingSections).toContain('DAILY');
    expect(overview.missingSections).toContain('AIR_QUALITY_CURRENT');
    expect(overview.missingSections).toContain('AIR_QUALITY_FORECAST');
    expect(overview.missingSections).toContain('ALERTS');
    expect(overview.missingSections).toHaveLength(4);
    expect(overview.missingSections).toEqual([...CURRENT_AND_SELECTED_HOURLY_MISSING]);
  });

  it('orders sources current-first then hourly-second, with exact preserved values', () => {
    const hourlySuccess = makeHourlyOverviewSuccess();
    const currentSuccess = makeCurrentOverviewSuccess();
    const input = makeAggregateInput({ hourly: hourlySuccess, current: currentSuccess });

    const overview = assembleKmaCurrentHourlyWeatherOverview(input);

    expect(overview.sources).toHaveLength(2);
    expect(overview.sources[0]).toEqual(currentSuccess.overview.sources[0]);
    expect(overview.sources[1]).toEqual(hourlySuccess.overview.sources[0]);
    expect(overview.sources[0].sections).toEqual(['CURRENT']);
    expect(overview.sources[1].sections).toEqual(['HOURLY']);
  });
});

// ---------------------------------------------------------------------------
// B — current present + no-selection hourly.
// ---------------------------------------------------------------------------

describe('current present + no-selection hourly', () => {
  it('current present, hourly empty, CURRENT not missing, HOURLY missing', () => {
    const input = makeAggregateInput({
      hourly: makeHourlyOverviewSuccess({ noSelection: true }),
      current: makeCurrentOverviewSuccess(),
    });

    const overview = assembleKmaCurrentHourlyWeatherOverview(input);

    expect(weatherOverview.safeParse(overview).success).toBe(true);
    expect(overview.current).not.toBeNull();
    expect(overview.hourly).toEqual([]);
    expect(overview.missingSections).not.toContain('CURRENT');
    expect(overview.missingSections).toContain('HOURLY');
    expect(overview.missingSections).toEqual([...CURRENT_AND_NO_SELECTION_HOURLY_MISSING]);
  });

  it('only the current source is present (no-selection hourly contributes no source)', () => {
    const currentSuccess = makeCurrentOverviewSuccess();
    const input = makeAggregateInput({
      hourly: makeHourlyOverviewSuccess({ noSelection: true }),
      current: currentSuccess,
    });

    const overview = assembleKmaCurrentHourlyWeatherOverview(input);

    expect(overview.sources).toHaveLength(1);
    expect(overview.sources[0]).toEqual(currentSuccess.overview.sources[0]);
  });
});

// ---------------------------------------------------------------------------
// C — current absent.
// ---------------------------------------------------------------------------

describe('current absent + selected hourly', () => {
  it('current null, CURRENT missing, hourly and its source preserved, no current source fabricated', () => {
    const hourlySuccess = makeHourlyOverviewSuccess();
    const input = makeAggregateInput({ hourly: hourlySuccess, current: null });

    const overview = assembleKmaCurrentHourlyWeatherOverview(input);

    expect(weatherOverview.safeParse(overview).success).toBe(true);
    expect(overview.current).toBeNull();
    expect(overview.missingSections).toContain('CURRENT');
    expect(overview.missingSections).toEqual([...NO_CURRENT_SELECTED_HOURLY_MISSING]);
    expect(overview.hourly).toEqual(hourlySuccess.overview.hourly);
    expect(overview.sources).toEqual(hourlySuccess.overview.sources);
    expect(overview.sources).toHaveLength(1);
    expect(overview.sources[0].sections).toEqual(['HOURLY']);
    expect(overview).not.toBe(hourlySuccess.overview);
  });
});

describe('current absent + no-selection hourly', () => {
  it('current null, hourly empty, CURRENT and HOURLY missing, sources empty', () => {
    const hourlySuccess = makeHourlyOverviewSuccess({ noSelection: true });
    const input = makeAggregateInput({ hourly: hourlySuccess, current: null });

    const overview = assembleKmaCurrentHourlyWeatherOverview(input);

    expect(weatherOverview.safeParse(overview).success).toBe(true);
    expect(overview.current).toBeNull();
    expect(overview.hourly).toEqual([]);
    expect(overview.missingSections).toEqual([...NO_CURRENT_NO_SELECTION_HOURLY_MISSING]);
    expect(overview.sources).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D — location consistency.
// ---------------------------------------------------------------------------

describe('location consistency', () => {
  it('accepts equal-by-value but different-reference locations', () => {
    const hourlyLocation = makeLocation();
    const currentLocation = makeLocation(); // a distinct object, same values
    expect(hourlyLocation).not.toBe(currentLocation);

    const input = makeAggregateInput({
      hourly: makeHourlyOverviewSuccess({ location: hourlyLocation }),
      current: makeCurrentOverviewSuccess({ location: currentLocation }),
    });

    expect(() => assembleKmaCurrentHourlyWeatherOverview(input)).not.toThrow();
  });

  const mismatches: ReadonlyArray<{
    readonly name: string;
    readonly override: Partial<WeatherLocation>;
  }> = [
    { name: 'id', override: { id: 'loc_other' } },
    { name: 'displayName', override: { displayName: '다른 지역' } },
    { name: 'latitude', override: { latitude: 35.1796 } },
    { name: 'longitude', override: { longitude: 129.0756 } },
    { name: 'timezone', override: { timezone: 'UTC' } },
    { name: 'adminArea1', override: { adminArea1: '부산광역시' } },
    { name: 'adminArea3 (null vs value)', override: { adminArea3: '명동' } },
  ];

  for (const { name, override } of mismatches) {
    it(`throws a synchronous, static, value-free RangeError for a ${name} mismatch`, () => {
      const hourlyLocation = makeLocation();
      const currentLocation = makeLocation(override);

      const input = makeAggregateInput({
        hourly: makeHourlyOverviewSuccess({ location: hourlyLocation }),
        current: makeCurrentOverviewSuccess({ location: currentLocation }),
      });

      const error = captureError(() => assembleKmaCurrentHourlyWeatherOverview(input));

      expectRangeError(error);
      const message = (error as Error).message;
      expect(message).not.toContain(String(hourlyLocation.latitude));
      expect(message).not.toContain(String(hourlyLocation.longitude));
      expect(message).not.toContain(hourlyLocation.id);
      expect(message).not.toContain(hourlyLocation.displayName);
    });
  }

  it('does not call the assembler-under-test on hourly-only mismatch (no side effect before throw)', () => {
    const input = makeAggregateInput({
      current: makeCurrentOverviewSuccess({ location: makeLocation({ id: 'other' }) }),
    });

    expect(() => assembleKmaCurrentHourlyWeatherOverview(input)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// E — internal trace (`hourly.selection`) is never read.
// ---------------------------------------------------------------------------

describe('hourly.selection is never consumed', () => {
  it('does not throw when input.hourly.selection is a getter that throws on read', () => {
    const hourlySuccess = makeHourlyOverviewSuccess();
    const poisoned = { ok: true as const, overview: hourlySuccess.overview };
    Object.defineProperty(poisoned, 'selection', {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error('selection must not be read by the aggregate assembler');
      },
    });

    const input: KmaCurrentHourlyWeatherOverviewInput = {
      hourly: poisoned as unknown as HourlyOverviewSuccess,
      current: makeCurrentOverviewSuccess(),
    };

    expect(() => assembleKmaCurrentHourlyWeatherOverview(input)).not.toThrow();
  });

  it('does not throw when current is null and input.hourly.selection is a throwing getter', () => {
    const hourlySuccess = makeHourlyOverviewSuccess({ noSelection: true });
    const poisoned = { ok: true as const, overview: hourlySuccess.overview };
    Object.defineProperty(poisoned, 'selection', {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error('selection must not be read by the aggregate assembler');
      },
    });

    const input: KmaCurrentHourlyWeatherOverviewInput = {
      hourly: poisoned as unknown as HourlyOverviewSuccess,
      current: null,
    };

    expect(() => assembleKmaCurrentHourlyWeatherOverview(input)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// F — provenance preservation.
// ---------------------------------------------------------------------------

describe('provenance preservation', () => {
  it('preserves current and hourly SourceMetadata values unchanged, with no cross-contamination', () => {
    const current = makeCurrent({ observedAt: '2026-08-10T14:30:00+09:00' });
    const currentSource = makeCurrentSource({
      sourceId: 'kma-ultra-short-current-observation',
      fetchedAt: '2026-08-10T05:31:00.000Z',
      retrievalMode: 'LIVE',
    });
    const hourlySource = makeHourlySource({
      sourceId: 'kma-short-forecast-hourly',
      issuedAt: '2026-08-10T05:00:00+09:00',
      fetchedAt: '2026-08-10T05:05:00+09:00',
      retrievalMode: 'LIVE',
    });

    const currentSuccess = makeCurrentOverviewSuccess({ current, source: currentSource });
    const hourlySuccess = makeHourlyOverviewSuccess({ source: hourlySource });

    const overview = assembleKmaCurrentHourlyWeatherOverview(
      makeAggregateInput({ hourly: hourlySuccess, current: currentSuccess }),
    );

    expect(overview.sources).toHaveLength(2);
    const [currentMetadata, hourlyMetadata] = overview.sources;

    // Current source: canonical id, issuedAt null, observedAt = current.observedAt, distinct fetchedAt.
    expect(currentMetadata.sourceId).toBe('kma-ultra-short-current-observation');
    expect(currentMetadata.issuedAt).toBeNull();
    expect(currentMetadata.observedAt).toBe('2026-08-10T14:30:00+09:00');
    expect(currentMetadata.fetchedAt).toBe('2026-08-10T05:31:00.000Z');
    expect(currentMetadata.retrievalMode).toBe('LIVE');
    expect(currentMetadata.sections).toEqual(['CURRENT']);

    // Hourly source: canonical id, concrete issuedAt, observedAt null, different fetchedAt.
    expect(hourlyMetadata.sourceId).toBe('kma-short-forecast-hourly');
    expect(hourlyMetadata.issuedAt).toBe('2026-08-10T05:00:00+09:00');
    expect(hourlyMetadata.observedAt).toBeNull();
    expect(hourlyMetadata.fetchedAt).toBe('2026-08-10T05:05:00+09:00');
    expect(hourlyMetadata.retrievalMode).toBe('LIVE');
    expect(hourlyMetadata.sections).toEqual(['HOURLY']);

    // No timestamp cross-contamination.
    expect(currentMetadata.observedAt).not.toBe(hourlyMetadata.observedAt);
    expect(currentMetadata.fetchedAt).not.toBe(hourlyMetadata.fetchedAt);
  });
});

// ---------------------------------------------------------------------------
// G — immutability / freshness.
// ---------------------------------------------------------------------------

describe('immutability and freshness', () => {
  it('accepts a deeply frozen aggregate input (current present)', () => {
    const input = deepFreeze(makeAggregateInput());

    expect(() => assembleKmaCurrentHourlyWeatherOverview(input)).not.toThrow();
  });

  it('accepts a deeply frozen aggregate input (current null)', () => {
    const input = deepFreeze(makeAggregateInput({ current: null }));

    expect(() => assembleKmaCurrentHourlyWeatherOverview(input)).not.toThrow();
  });

  it('does not mutate the input, the hourly overview, or the current overview', () => {
    const input = makeAggregateInput();
    const snapshot = JSON.stringify(input);

    assembleKmaCurrentHourlyWeatherOverview(input);

    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('does not mutate the hourly baseline missingSections/sources arrays in place', () => {
    const hourlySuccess = makeHourlyOverviewSuccess();
    const missingSnapshot = [...hourlySuccess.overview.missingSections];
    const sourcesSnapshot = [...hourlySuccess.overview.sources];

    assembleKmaCurrentHourlyWeatherOverview(
      makeAggregateInput({ hourly: hourlySuccess, current: makeCurrentOverviewSuccess() }),
    );

    expect(hourlySuccess.overview.missingSections).toEqual(missingSnapshot);
    expect(hourlySuccess.overview.sources).toEqual(sourcesSnapshot);
  });

  it('returns a fresh overview on each call (value-equal, distinct references)', () => {
    const input = makeAggregateInput();

    const first = assembleKmaCurrentHourlyWeatherOverview(input);
    const second = assembleKmaCurrentHourlyWeatherOverview(input);

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    expect(first.sources).not.toBe(second.sources);
    expect(first.missingSections).not.toBe(second.missingSections);
  });

  it('is unaffected by a caller mutating an earlier returned overview', () => {
    const input = makeAggregateInput();

    const first = assembleKmaCurrentHourlyWeatherOverview(input);
    first.missingSections.push('ALERTS');
    first.sources.push({
      sourceId: 'injected',
      provider: 'KMA',
      sections: ['CURRENT'],
      issuedAt: null,
      observedAt: null,
      fetchedAt: '2026-08-10T15:00:00Z',
      retrievalMode: 'LIVE',
    });

    const second = assembleKmaCurrentHourlyWeatherOverview(input);

    expect(second.missingSections).toEqual([...CURRENT_AND_SELECTED_HOURLY_MISSING]);
    expect(second.sources).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// H — final schema guard (weatherOverview.parse is a real invariant boundary).
// ---------------------------------------------------------------------------

describe('final schema guard', () => {
  it('throws a synchronous ZodError when the hourly baseline carries a malformed location', () => {
    const badOverview: WeatherOverview = {
      location: makeLocation({ timezone: 'Seoul' }),
      current: null,
      hourly: [makeHourly()],
      daily: [],
      airQuality: { current: null, daily: [] },
      alerts: [],
      missingSections: [
        'CURRENT',
        'DAILY',
        'AIR_QUALITY_CURRENT',
        'AIR_QUALITY_FORECAST',
        'ALERTS',
      ],
      sources: [],
    };
    const hourlySuccess: HourlyOverviewSuccess = {
      ok: true,
      selection: makePrimarySelection(),
      overview: badOverview,
    };

    const error = captureError(() =>
      assembleKmaCurrentHourlyWeatherOverview(
        makeAggregateInput({ hourly: hourlySuccess, current: null }),
      ),
    );

    expectZodError(error);
  });

  it('throws a synchronous ZodError when hourly has entries but HOURLY is (contradictorily) marked missing', () => {
    const badOverview: WeatherOverview = {
      location: makeLocation(),
      current: null,
      hourly: [makeHourly()],
      daily: [],
      airQuality: { current: null, daily: [] },
      alerts: [],
      // Contradiction: HOURLY is marked missing even though hourly has an entry.
      missingSections: [
        'CURRENT',
        'HOURLY',
        'DAILY',
        'AIR_QUALITY_CURRENT',
        'AIR_QUALITY_FORECAST',
        'ALERTS',
      ],
      sources: [],
    };
    const hourlySuccess: HourlyOverviewSuccess = {
      ok: true,
      selection: makePrimarySelection(),
      overview: badOverview,
    };

    const error = captureError(() =>
      assembleKmaCurrentHourlyWeatherOverview(
        makeAggregateInput({ hourly: hourlySuccess, current: null }),
      ),
    );

    expectZodError(error);
  });

  it('throws a synchronous ZodError when the current overview carries a malformed source', () => {
    const badOverview: WeatherOverview = {
      location: makeLocation(),
      current: makeCurrent(),
      hourly: [],
      daily: [],
      airQuality: { current: null, daily: [] },
      alerts: [],
      missingSections: [
        'HOURLY',
        'DAILY',
        'AIR_QUALITY_CURRENT',
        'AIR_QUALITY_FORECAST',
        'ALERTS',
      ],
      sources: [
        {
          // Empty sourceId is invalid per contracts `nonEmptyString`.
          sourceId: '',
          provider: 'KMA',
          sections: ['CURRENT'],
          issuedAt: null,
          observedAt: makeCurrent().observedAt,
          fetchedAt: '2026-08-10T05:00:00.000Z',
          retrievalMode: 'LIVE',
        },
      ],
    };
    const currentSuccess: CurrentOverviewSuccess = { ok: true, overview: badOverview };

    const error = captureError(() =>
      assembleKmaCurrentHourlyWeatherOverview(
        makeAggregateInput({ hourly: makeHourlyOverviewSuccess(), current: currentSuccess }),
      ),
    );

    expectZodError(error);
  });
});

// ---------------------------------------------------------------------------
// H2 — current:null boundary is enforced even when the hourly baseline itself
// is a schema-valid general WeatherOverview that (contrary to the real PR #23
// assembler's invariant) already carries current data. This baseline is built
// by hand, not via assembleKmaHourlyWeatherOverview, because that real
// assembler always produces `current: null` / `CURRENT` missing and would
// hide the regression.
// ---------------------------------------------------------------------------

describe('current:null boundary is enforced independently of the hourly baseline', () => {
  it('throws a synchronous ZodError instead of leaking baseline current data through', () => {
    const maliciousBaseline: WeatherOverview = {
      location: makeLocation(),
      current: makeCurrent(),
      hourly: [makeHourly()],
      daily: [],
      airQuality: { current: null, daily: [] },
      alerts: [],
      // Schema-valid on its own: current is present, so CURRENT is correctly
      // absent from missingSections.
      missingSections: [
        'DAILY',
        'AIR_QUALITY_CURRENT',
        'AIR_QUALITY_FORECAST',
        'ALERTS',
      ],
      sources: [
        {
          sourceId: 'kma-ultra-short-current-observation',
          provider: 'KMA',
          sections: ['CURRENT'],
          issuedAt: null,
          observedAt: makeCurrent().observedAt,
          fetchedAt: '2026-08-10T05:00:00.000Z',
          retrievalMode: 'LIVE',
        },
      ],
    };
    expect(weatherOverview.safeParse(maliciousBaseline).success).toBe(true);

    const hourlySuccess: HourlyOverviewSuccess = {
      ok: true,
      selection: makePrimarySelection(),
      overview: maliciousBaseline,
    };

    const error = captureError(() =>
      assembleKmaCurrentHourlyWeatherOverview(
        makeAggregateInput({ hourly: hourlySuccess, current: null }),
      ),
    );

    expectZodError(error);
  });
});

// ---------------------------------------------------------------------------
// I — synchronous, side-effect-free contract.
// ---------------------------------------------------------------------------

describe('synchronous contract', () => {
  it('returns a plain value, not a Promise or thenable', () => {
    const overview = assembleKmaCurrentHourlyWeatherOverview(makeAggregateInput());

    expect(overview instanceof Promise).toBe(false);
    expect('then' in (overview as object)).toBe(false);
  });

  it('never reads the system clock (Date.now)', () => {
    const nowSpy = vi.spyOn(Date, 'now');

    assembleKmaCurrentHourlyWeatherOverview(makeAggregateInput());
    assembleKmaCurrentHourlyWeatherOverview(makeAggregateInput({ current: null }));

    expect(nowSpy).not.toHaveBeenCalled();
  });

  it('never reads process.env', () => {
    const envSpy = vi.spyOn(process, 'env', 'get');

    assembleKmaCurrentHourlyWeatherOverview(makeAggregateInput());

    expect(envSpy).not.toHaveBeenCalled();
  });

  it('never calls console.log / info / warn / error / debug', () => {
    const spies = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      info: vi.spyOn(console, 'info').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
      debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
    };

    assembleKmaCurrentHourlyWeatherOverview(makeAggregateInput());

    expect(spies.log).not.toHaveBeenCalled();
    expect(spies.info).not.toHaveBeenCalled();
    expect(spies.warn).not.toHaveBeenCalled();
    expect(spies.error).not.toHaveBeenCalled();
    expect(spies.debug).not.toHaveBeenCalled();
  });

  it('never calls fetch', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    assembleKmaCurrentHourlyWeatherOverview(makeAggregateInput());

    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
