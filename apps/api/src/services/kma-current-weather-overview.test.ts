import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  currentWeather,
  weatherOverview,
  type CurrentWeather,
  type WeatherLocation,
} from '@life-weather/contracts';

import {
  assembleKmaCurrentWeatherOverview,
  type KmaCurrentWeatherOverviewInput,
} from './kma-current-weather-overview.js';

// ---------------------------------------------------------------------------
// Key contracts — the exact own keys the assembler must emit, and the exact
// missingSections set for a current-only overview.
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

/** The exact own keys of a `CurrentWeather` value, sorted. */
const CURRENT_KEYS = [
  'condition',
  'feelsLikeCelsius',
  'humidityPercent',
  'observedAt',
  'precipitationLastHourMillimeters',
  'temperatureCelsius',
  'visibilityMeters',
  'windDirectionDegrees',
  'windSpeedMetersPerSecond',
] as const;

/** The exact `missingSections` this assembler ever produces — CURRENT is never in this set. */
const MISSING_SECTIONS = [
  'HOURLY',
  'DAILY',
  'AIR_QUALITY_CURRENT',
  'AIR_QUALITY_FORECAST',
  'ALERTS',
] as const;

/** Provenance fields this assembler must never invent on a source metadata entry. */
const FORBIDDEN_SOURCE_KEYS = [
  'sourceId',
  'provider',
  'sections',
  'issuedAt',
  'fetchedAt',
  'retrievalMode',
] as const;

// ---------------------------------------------------------------------------
// Fixture builders — every mutable fixture is built fresh per call, so no test
// shares a mutable input/location/current object.
// ---------------------------------------------------------------------------

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

/**
 * A fresh, complete, schema-valid `CurrentWeather` literal with every field non-null by default, so
 * a mutant that swaps a value for `null` is caught; overridable per field for edge cases (e.g.
 * exercising the nullable fields).
 */
function makeCurrent(overrides: Partial<CurrentWeather> = {}): CurrentWeather {
  return {
    observedAt: '2026-08-09T14:00:00+09:00',
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

/** A fresh assembler input; overridable per field. */
function makeInput(
  overrides: Partial<KmaCurrentWeatherOverviewInput> = {},
): KmaCurrentWeatherOverviewInput {
  return {
    location: overrides.location ?? makeLocation(),
    current: overrides.current ?? makeCurrent(),
  };
}

// ---------------------------------------------------------------------------
// Assertion / spy helpers.
// ---------------------------------------------------------------------------

/** Assert the overview has exactly the eight top-level keys. */
function expectExactOverviewShape(overview: unknown): void {
  expect(typeof overview).toBe('object');
  const record = overview as Record<string, unknown>;
  expect(Object.keys(record).sort()).toEqual([...OVERVIEW_KEYS]);
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

/** Spy on the console methods that must never be called by a pure assembler. */
function spyOnConsole(): {
  log: ReturnType<typeof vi.spyOn>;
  info: ReturnType<typeof vi.spyOn>;
  warn: ReturnType<typeof vi.spyOn>;
  error: ReturnType<typeof vi.spyOn>;
  debug: ReturnType<typeof vi.spyOn>;
} {
  return {
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    info: vi.spyOn(console, 'info').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
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
  it('builds a CurrentWeather fixture that satisfies the real contracts schema', () => {
    expect(currentWeather.safeParse(makeCurrent()).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A — valid current-only WeatherOverview.
// ---------------------------------------------------------------------------

describe('valid assembly', () => {
  it('assembles a valid current-only overview from a WeatherLocation and CurrentWeather', () => {
    const input = makeInput();

    const overview = assembleKmaCurrentWeatherOverview(input);

    expect(weatherOverview.safeParse(overview).success).toBe(true);
    expectExactOverviewShape(overview);
  });

  it('preserves the location value verbatim', () => {
    const location = makeLocation({ displayName: '부산광역시 해운대구' });
    const overview = assembleKmaCurrentWeatherOverview(makeInput({ location }));

    expect(overview.location).toEqual(location);
  });
});

// ---------------------------------------------------------------------------
// B — CURRENT is present.
// ---------------------------------------------------------------------------

describe('CURRENT is present', () => {
  it('current is not null and CURRENT is absent from missingSections', () => {
    const overview = assembleKmaCurrentWeatherOverview(makeInput());

    expect(overview.current).not.toBeNull();
    expect(overview.missingSections).not.toContain('CURRENT');
  });
});

// ---------------------------------------------------------------------------
// C — missingSections exact.
// ---------------------------------------------------------------------------

describe('missingSections exact', () => {
  it('is exactly HOURLY, DAILY, AIR_QUALITY_CURRENT, AIR_QUALITY_FORECAST, ALERTS in order', () => {
    const overview = assembleKmaCurrentWeatherOverview(makeInput());

    expect(overview.missingSections).toEqual([...MISSING_SECTIONS]);
  });
});

// ---------------------------------------------------------------------------
// D — all CurrentWeather values preserved.
// ---------------------------------------------------------------------------

describe('CurrentWeather values preserved', () => {
  it('preserves every field verbatim with a fully non-null fixture', () => {
    const current = makeCurrent();
    const overview = assembleKmaCurrentWeatherOverview(makeInput({ current }));

    expect(overview.current).toEqual(current);
    expect(Object.keys(overview.current as object).sort()).toEqual([
      ...CURRENT_KEYS,
    ]);
  });

  it('preserves a mix of null and non-null optional fields exactly (no accidental defaulting)', () => {
    const current = makeCurrent({
      feelsLikeCelsius: null,
      humidityPercent: 0,
      windSpeedMetersPerSecond: null,
      windDirectionDegrees: 0,
      precipitationLastHourMillimeters: null,
      visibilityMeters: 0,
    });

    const overview = assembleKmaCurrentWeatherOverview(makeInput({ current }));

    expect(overview.current?.feelsLikeCelsius).toBeNull();
    expect(overview.current?.humidityPercent).toBe(0);
    expect(overview.current?.windSpeedMetersPerSecond).toBeNull();
    expect(overview.current?.windDirectionDegrees).toBe(0);
    expect(overview.current?.precipitationLastHourMillimeters).toBeNull();
    expect(overview.current?.visibilityMeters).toBe(0);
    expect(overview.current).toEqual(current);
  });

  it('preserves observedAt and condition verbatim', () => {
    const current = makeCurrent({
      observedAt: '2026-08-09T09:00:00+09:00',
      condition: 'RAIN',
    });

    const overview = assembleKmaCurrentWeatherOverview(makeInput({ current }));

    expect(overview.current?.observedAt).toBe('2026-08-09T09:00:00+09:00');
    expect(overview.current?.condition).toBe('RAIN');
  });
});

// ---------------------------------------------------------------------------
// E — other data sections fixed empty.
// ---------------------------------------------------------------------------

describe('other data sections fixed empty', () => {
  it('hourly, daily, alerts are empty and airQuality is fully absent', () => {
    const overview = assembleKmaCurrentWeatherOverview(makeInput());

    expect(overview.hourly).toEqual([]);
    expect(overview.daily).toEqual([]);
    expect(overview.alerts).toEqual([]);
    expect(overview.airQuality.current).toBeNull();
    expect(overview.airQuality.daily).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// F — sources exact empty.
// ---------------------------------------------------------------------------

describe('sources exact empty', () => {
  it('sources is exactly [] — no provenance is fabricated', () => {
    const overview = assembleKmaCurrentWeatherOverview(makeInput());

    expect(overview.sources).toEqual([]);
    expect(overview.sources).toHaveLength(0);
  });

  it('never produces a source metadata entry carrying any provenance field', () => {
    const overview = assembleKmaCurrentWeatherOverview(makeInput());
    const serialized = JSON.stringify(overview);

    for (const key of FORBIDDEN_SOURCE_KEYS) {
      // sources is empty, so none of these keys can appear at all in the serialized payload's
      // sources array; this also guards against a mutant that fabricates a lone source entry.
      expect(serialized.includes(`"${key}"`)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// G — exact top-level own keys.
// ---------------------------------------------------------------------------

describe('exact keys', () => {
  it('has exactly the eight top-level keys and two airQuality keys', () => {
    const overview = assembleKmaCurrentWeatherOverview(makeInput());

    expect(Object.keys(overview).sort()).toEqual([...OVERVIEW_KEYS]);
    expect(Object.keys(overview.airQuality).sort()).toEqual([
      ...AIR_QUALITY_KEYS,
    ]);
  });
});

// ---------------------------------------------------------------------------
// H / I — malformed location / current → synchronous Zod error.
// ---------------------------------------------------------------------------

describe('validation failures', () => {
  const invalidCases: ReadonlyArray<{
    readonly name: string;
    readonly input: () => KmaCurrentWeatherOverviewInput;
  }> = [
    {
      name: 'malformed location timezone',
      input: () => makeInput({ location: makeLocation({ timezone: 'Seoul' }) }),
    },
    {
      name: 'out-of-range latitude',
      input: () => makeInput({ location: makeLocation({ latitude: 999 }) }),
    },
    {
      name: 'malformed observedAt',
      input: () => makeInput({ current: makeCurrent({ observedAt: 'not-a-timestamp' }) }),
    },
    {
      name: 'non-finite temperature',
      input: () =>
        makeInput({
          current: {
            ...makeCurrent(),
            temperatureCelsius: Number.NaN,
          },
        }),
    },
    {
      name: 'out-of-range humidity',
      input: () => makeInput({ current: makeCurrent({ humidityPercent: 150 }) }),
    },
    {
      name: 'out-of-range wind direction',
      input: () => makeInput({ current: makeCurrent({ windDirectionDegrees: 400 }) }),
    },
  ];

  for (const { name, input } of invalidCases) {
    it(`throws a synchronous ZodError for a ${name} and leaves the input unmutated`, () => {
      const built = input();
      const snapshot = JSON.stringify(built);
      const spies = spyOnConsole();

      const error = captureError(() => assembleKmaCurrentWeatherOverview(built));

      expectZodError(error);
      expect(JSON.stringify(built)).toBe(snapshot);
      expect(spies.log).not.toHaveBeenCalled();
      expect(spies.info).not.toHaveBeenCalled();
      expect(spies.warn).not.toHaveBeenCalled();
      expect(spies.error).not.toHaveBeenCalled();
      expect(spies.debug).not.toHaveBeenCalled();
    });
  }
});

// ---------------------------------------------------------------------------
// J / K — frozen input / no mutation.
// ---------------------------------------------------------------------------

describe('immutability', () => {
  it('accepts a deeply frozen input and assembles correctly', () => {
    const input = deepFreeze(makeInput());

    expect(() => assembleKmaCurrentWeatherOverview(input)).not.toThrow();

    const overview = assembleKmaCurrentWeatherOverview(input);
    expect(weatherOverview.safeParse(overview).success).toBe(true);
    expect(overview.current).toEqual(input.current);
  });

  it('does not mutate the input, location, or current weather', () => {
    const input = makeInput();
    const snapshot = JSON.stringify(input);

    assembleKmaCurrentWeatherOverview(input);

    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// L — repeated call fresh result.
// ---------------------------------------------------------------------------

describe('fresh output per call', () => {
  it('returns a fresh overview with fresh nested arrays/objects on each call', () => {
    const input = makeInput();

    const first = assembleKmaCurrentWeatherOverview(input);
    const second = assembleKmaCurrentWeatherOverview(input);

    expect(first).not.toBe(second);
    expect(first).toEqual(second);

    expect(first.hourly).not.toBe(second.hourly);
    expect(first.daily).not.toBe(second.daily);
    expect(first.alerts).not.toBe(second.alerts);
    expect(first.sources).not.toBe(second.sources);
    expect(first.airQuality).not.toBe(second.airQuality);
    expect(first.airQuality.daily).not.toBe(second.airQuality.daily);
    expect(first.missingSections).not.toBe(second.missingSections);
  });

  it('is unaffected by a caller mutating an earlier returned overview', () => {
    const input = makeInput();

    const first = assembleKmaCurrentWeatherOverview(input);
    first.hourly.push({
      forecastAt: '2026-08-09T15:00:00+09:00',
      condition: 'CLEAR',
      temperatureCelsius: 29,
      feelsLikeCelsius: null,
      precipitationProbabilityPercent: null,
      precipitationAmountMillimeters: null,
      snowfallAmountCentimeters: null,
      humidityPercent: null,
      windSpeedMetersPerSecond: null,
      windDirectionDegrees: null,
    });
    first.missingSections.push('CURRENT');
    first.sources.push({
      sourceId: 'injected',
      provider: 'KMA',
      sections: ['CURRENT'],
      issuedAt: null,
      observedAt: null,
      fetchedAt: '2026-08-09T15:00:00Z',
      retrievalMode: 'LIVE',
    });

    const second = assembleKmaCurrentWeatherOverview(input);

    expect(second.hourly).toEqual([]);
    expect(second.missingSections).toEqual([...MISSING_SECTIONS]);
    expect(second.sources).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// M — synchronous, side-effect-free contract.
// ---------------------------------------------------------------------------

describe('synchronous contract', () => {
  it('returns a plain value, not a Promise or thenable', () => {
    const overview = assembleKmaCurrentWeatherOverview(makeInput());

    expect(overview instanceof Promise).toBe(false);
    expect('then' in (overview as object)).toBe(false);
  });

  it('never reads the system clock (Date.now)', () => {
    const nowSpy = vi.spyOn(Date, 'now');

    assembleKmaCurrentWeatherOverview(makeInput());

    expect(nowSpy).not.toHaveBeenCalled();
  });

  it('never calls console.log / info / warn / error / debug', () => {
    const spies = spyOnConsole();

    assembleKmaCurrentWeatherOverview(makeInput());

    expect(spies.log).not.toHaveBeenCalled();
    expect(spies.info).not.toHaveBeenCalled();
    expect(spies.warn).not.toHaveBeenCalled();
    expect(spies.error).not.toHaveBeenCalled();
    expect(spies.debug).not.toHaveBeenCalled();
  });

  it('never calls fetch', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    assembleKmaCurrentWeatherOverview(makeInput());

    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
