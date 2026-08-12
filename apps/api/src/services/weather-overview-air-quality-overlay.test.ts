import { describe, expect, it } from 'vitest';

import {
  weatherOverview,
  type CurrentAirQuality,
  type HourlyForecast,
  type SourceMetadata,
  type WeatherLocation,
  type WeatherOverview,
} from '@life-weather/contracts';

import {
  overlayAirKoreaCurrentAirQualityOnWeatherOverview,
  type AirKoreaCurrentSourceMetadataInput,
  type AirQualityCurrentOverlayInput,
} from './weather-overview-air-quality-overlay.js';

// ---------------------------------------------------------------------------
// Fixture builders — every mutable fixture is built fresh per call.
// ---------------------------------------------------------------------------

function makeLocation(overrides: Partial<WeatherLocation> = {}): WeatherLocation {
  return {
    id: 'loc_seoul_hyehwa',
    displayName: '서울특별시 종로구 혜화동',
    countryCode: 'KR',
    adminArea1: '서울특별시',
    adminArea2: '종로구',
    adminArea3: '혜화동',
    latitude: 37.5861,
    longitude: 127.0022,
    timezone: 'Asia/Seoul',
    ...overrides,
  };
}

function makeHourly(): HourlyForecast {
  return {
    forecastAt: '2026-08-10T14:00:00+09:00',
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

const HOURLY_SOURCE: SourceMetadata = {
  sourceId: 'kma-short-forecast-hourly',
  provider: 'KMA',
  sections: ['HOURLY'],
  issuedAt: '2026-08-10T05:00:00+09:00',
  observedAt: null,
  fetchedAt: '2026-08-10T05:05:00+09:00',
  retrievalMode: 'LIVE',
};

/** A baseline WeatherOverview shaped exactly like the existing KMA combined-pipeline output: current +
 * hourly present, air-quality entirely missing. */
function makeBaseline(
  overrides: {
    readonly location?: WeatherLocation;
    readonly airQualityCurrent?: CurrentAirQuality | null;
    readonly missingSections?: WeatherOverview['missingSections'];
    readonly sources?: SourceMetadata[];
  } = {},
): WeatherOverview {
  const airQualityCurrent = overrides.airQualityCurrent ?? null;
  const missingSections =
    overrides.missingSections ??
    (airQualityCurrent === null
      ? (['CURRENT', 'DAILY', 'AIR_QUALITY_CURRENT', 'AIR_QUALITY_FORECAST', 'ALERTS'] as const)
      : (['CURRENT', 'DAILY', 'AIR_QUALITY_FORECAST', 'ALERTS'] as const));

  const overview = {
    location: overrides.location ?? makeLocation(),
    current: null,
    hourly: [makeHourly()],
    daily: [],
    airQuality: {
      current: airQualityCurrent,
      daily: [],
    },
    alerts: [],
    missingSections,
    sources: overrides.sources ?? [HOURLY_SOURCE],
  } satisfies WeatherOverview;

  return weatherOverview.parse(overview);
}

function makeCurrentAirQuality(
  overrides: Partial<CurrentAirQuality> = {},
): CurrentAirQuality {
  return {
    measuredAt: '2026-08-10T14:00:00+09:00',
    pm10MicrogramsPerCubicMeter: 30,
    pm25MicrogramsPerCubicMeter: 15,
    ozonePartsPerMillion: 0.03,
    comprehensiveAirQualityIndex: 60,
    overallGrade: 'MODERATE',
    pm10Grade: 'GOOD',
    pm25Grade: 'MODERATE',
    ozoneGrade: 'GOOD',
    ...overrides,
  };
}

function makeSource(
  overrides: Partial<AirKoreaCurrentSourceMetadataInput> = {},
): AirKoreaCurrentSourceMetadataInput {
  return {
    sourceId: 'airkorea-current-air-quality',
    fetchedAt: '2026-08-10T05:10:00.000Z',
    retrievalMode: 'LIVE',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// airQuality: null — no-op degradation.
// ---------------------------------------------------------------------------

describe('overlayAirKoreaCurrentAirQualityOnWeatherOverview — airQuality: null (degraded)', () => {
  it('returns the baseline unchanged: airQuality.current stays null, AIR_QUALITY_CURRENT stays missing', () => {
    const baseline = makeBaseline();
    const input: AirQualityCurrentOverlayInput = { baseline, airQuality: null };

    const result = overlayAirKoreaCurrentAirQualityOnWeatherOverview(input);

    expect(result.airQuality.current).toBeNull();
    expect(result.missingSections).toContain('AIR_QUALITY_CURRENT');
    expect(result).toEqual(baseline);
  });

  it('adds no AIR_KOREA source and preserves every other baseline field verbatim', () => {
    const baseline = makeBaseline();

    const result = overlayAirKoreaCurrentAirQualityOnWeatherOverview({
      baseline,
      airQuality: null,
    });

    expect(result.sources).toEqual([HOURLY_SOURCE]);
    expect(result.sources.some((source) => source.provider === 'AIR_KOREA')).toBe(false);
    expect(result.hourly).toEqual(baseline.hourly);
    expect(result.current).toBeNull();
    expect(result.location).toEqual(baseline.location);
  });

  it('returns a fresh object reference, not the caller baseline', () => {
    const baseline = makeBaseline();

    const result = overlayAirKoreaCurrentAirQualityOnWeatherOverview({
      baseline,
      airQuality: null,
    });

    expect(result).not.toBe(baseline);
  });
});

// ---------------------------------------------------------------------------
// airQuality present — success overlay.
// ---------------------------------------------------------------------------

describe('overlayAirKoreaCurrentAirQualityOnWeatherOverview — airQuality present (success)', () => {
  it('overlays current, removes AIR_QUALITY_CURRENT from missingSections, preserves airQuality.daily', () => {
    const baseline = makeBaseline();
    const current = makeCurrentAirQuality();
    const source = makeSource();

    const result = overlayAirKoreaCurrentAirQualityOnWeatherOverview({
      baseline,
      airQuality: { current, source },
    });

    expect(result.airQuality.current).toEqual(current);
    expect(result.missingSections).not.toContain('AIR_QUALITY_CURRENT');
    expect(result.airQuality.daily).toEqual(baseline.airQuality.daily);
  });

  it('appends exactly one AIR_KOREA SourceMetadata entry, preserving existing KMA sources', () => {
    const baseline = makeBaseline();
    const current = makeCurrentAirQuality();
    const source = makeSource();

    const result = overlayAirKoreaCurrentAirQualityOnWeatherOverview({
      baseline,
      airQuality: { current, source },
    });

    expect(result.sources).toHaveLength(2);
    expect(result.sources[0]).toEqual(HOURLY_SOURCE);
    const airKoreaSource = result.sources[1]!;
    expect(airKoreaSource).toEqual({
      sourceId: source.sourceId,
      provider: 'AIR_KOREA',
      sections: ['AIR_QUALITY_CURRENT'],
      issuedAt: null,
      observedAt: current.measuredAt,
      fetchedAt: source.fetchedAt,
      retrievalMode: source.retrievalMode,
    });
  });

  it('sets source.observedAt to exactly CurrentAirQuality.measuredAt', () => {
    const baseline = makeBaseline();
    const current = makeCurrentAirQuality({ measuredAt: '2026-08-10T14:30:00+09:00' });
    const source = makeSource();

    const result = overlayAirKoreaCurrentAirQualityOnWeatherOverview({
      baseline,
      airQuality: { current, source },
    });

    const airKoreaSource = result.sources.find((entry) => entry.provider === 'AIR_KOREA')!;
    expect(airKoreaSource.observedAt).toBe('2026-08-10T14:30:00+09:00');
  });

  it('preserves every KMA current/hourly/daily/alerts field of the baseline unchanged', () => {
    const baseline = makeBaseline();
    const current = makeCurrentAirQuality();
    const source = makeSource();

    const result = overlayAirKoreaCurrentAirQualityOnWeatherOverview({
      baseline,
      airQuality: { current, source },
    });

    expect(result.current).toEqual(baseline.current);
    expect(result.hourly).toEqual(baseline.hourly);
    expect(result.daily).toEqual(baseline.daily);
    expect(result.alerts).toEqual(baseline.alerts);
    expect(result.location).toEqual(baseline.location);
  });

  it('builds SourceMetadata from explicit named fields — extra properties on the caller source never leak', () => {
    const baseline = makeBaseline();
    const current = makeCurrentAirQuality();
    const pollutedSource = {
      ...makeSource(),
      provider: 'DERIVED',
      sections: ['HOURLY'],
      issuedAt: '2099-01-01T00:00:00.000Z',
      observedAt: '2099-01-01T00:00:00.000Z',
      stationName: 'leaked-station',
    } as unknown as AirKoreaCurrentSourceMetadataInput;

    const result = overlayAirKoreaCurrentAirQualityOnWeatherOverview({
      baseline,
      airQuality: { current, source: pollutedSource },
    });

    const airKoreaSource = result.sources.find((entry) => entry.provider === 'AIR_KOREA')!;
    expect(airKoreaSource.provider).toBe('AIR_KOREA');
    expect(airKoreaSource.sections).toEqual(['AIR_QUALITY_CURRENT']);
    expect(airKoreaSource.issuedAt).toBeNull();
    expect(airKoreaSource.observedAt).toBe(current.measuredAt);
    expect(JSON.stringify(result)).not.toContain('leaked-station');
  });

  it('produces a payload that passes weatherOverview.parse (the sole runtime invariant guard)', () => {
    const baseline = makeBaseline();
    const result = overlayAirKoreaCurrentAirQualityOnWeatherOverview({
      baseline,
      airQuality: { current: makeCurrentAirQuality(), source: makeSource() },
    });

    expect(weatherOverview.safeParse(result).success).toBe(true);
  });

  it('returns a fresh object reference every call, for identical inputs', () => {
    const baseline = makeBaseline();
    const current = makeCurrentAirQuality();
    const source = makeSource();

    const first = overlayAirKoreaCurrentAirQualityOnWeatherOverview({
      baseline,
      airQuality: { current, source },
    });
    const second = overlayAirKoreaCurrentAirQualityOnWeatherOverview({
      baseline,
      airQuality: { current, source },
    });

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.sources).not.toBe(second.sources);
  });

  it('does not mutate the caller baseline or current input', () => {
    const baseline = makeBaseline();
    const baselineSnapshot = structuredClone(baseline);
    const current = makeCurrentAirQuality();
    const currentSnapshot = structuredClone(current);

    overlayAirKoreaCurrentAirQualityOnWeatherOverview({
      baseline,
      airQuality: { current, source: makeSource() },
    });

    expect(baseline).toEqual(baselineSnapshot);
    expect(current).toEqual(currentSnapshot);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed precondition.
// ---------------------------------------------------------------------------

describe('overlayAirKoreaCurrentAirQualityOnWeatherOverview — fail-closed precondition', () => {
  it('throws a static, value-free RangeError when the baseline already carries airQuality.current (present-overlay branch)', () => {
    const baseline = makeBaseline({ airQualityCurrent: makeCurrentAirQuality() });

    expect(() =>
      overlayAirKoreaCurrentAirQualityOnWeatherOverview({
        baseline,
        airQuality: { current: makeCurrentAirQuality(), source: makeSource() },
      }),
    ).toThrow(RangeError);
  });

  it('throws the same static RangeError when the baseline already carries airQuality.current, even for a null overlay', () => {
    const baseline = makeBaseline({ airQualityCurrent: makeCurrentAirQuality() });

    let firstMessage: string | undefined;
    let secondMessage: string | undefined;
    try {
      overlayAirKoreaCurrentAirQualityOnWeatherOverview({ baseline, airQuality: null });
    } catch (error) {
      firstMessage = (error as Error).message;
    }
    try {
      overlayAirKoreaCurrentAirQualityOnWeatherOverview({
        baseline,
        airQuality: { current: makeCurrentAirQuality(), source: makeSource() },
      });
    } catch (error) {
      secondMessage = (error as Error).message;
    }

    expect(firstMessage).toBeDefined();
    expect(firstMessage).toBe(secondMessage);
  });

  it('the thrown message never contains a raw value from the input', () => {
    const baseline = makeBaseline({ airQualityCurrent: makeCurrentAirQuality() });

    let caught: unknown;
    try {
      overlayAirKoreaCurrentAirQualityOnWeatherOverview({ baseline, airQuality: null });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RangeError);
    expect((caught as Error).message).not.toMatch(/\d/);
  });
});
