import { describe, expect, it } from 'vitest';

import {
  currentAirQuality,
  dailyAirQualityForecast,
  dailyForecast,
  sourceMetadata,
  type CurrentAirQuality,
} from '../index';

// --- sourceMetadata.sections -------------------------------------------------

function parseSections(sections: unknown) {
  return sourceMetadata.safeParse({
    sourceId: 'src_test',
    provider: 'KMA',
    sections,
    issuedAt: null,
    observedAt: '2026-07-15T01:00:00Z',
    fetchedAt: '2026-07-15T01:05:00Z',
    retrievalMode: 'LIVE',
  });
}

describe('sourceMetadata.sections (forward-compatible section array)', () => {
  it('accepts distinct unknown sections and collapses them to a single UNKNOWN', () => {
    const result = parseSections(['UV', 'POLLEN']);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sections).toEqual(['UNKNOWN']);
    }
  });

  it('keeps a known section and maps an unknown one to UNKNOWN', () => {
    const result = parseSections(['HOURLY', 'UV']);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sections).toEqual(['HOURLY', 'UNKNOWN']);
    }
  });

  it('collapses a real UNKNOWN together with an unknown string', () => {
    const result = parseSections(['UNKNOWN', 'UV']);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sections).toEqual(['UNKNOWN']);
    }
  });

  it('rejects a duplicate known raw string', () => {
    expect(parseSections(['HOURLY', 'HOURLY']).success).toBe(false);
  });

  it('rejects a duplicate unknown raw string', () => {
    expect(parseSections(['UV', 'UV']).success).toBe(false);
  });

  it('rejects non-string elements', () => {
    expect(parseSections([123]).success).toBe(false);
    expect(parseSections([null]).success).toBe(false);
    expect(parseSections([true]).success).toBe(false);
    expect(parseSections([{}]).success).toBe(false);
  });

  it('requires at least one element', () => {
    expect(parseSections([]).success).toBe(false);
    expect(parseSections(['CURRENT']).success).toBe(true);
  });
});

// --- air quality -------------------------------------------------------------

function airQuality(overrides: Partial<CurrentAirQuality> = {}): unknown {
  return {
    measuredAt: '2026-07-15T01:00:00Z',
    pm10MicrogramsPerCubicMeter: 34,
    pm25MicrogramsPerCubicMeter: 18,
    ozonePartsPerMillion: 0.032,
    comprehensiveAirQualityIndex: 58,
    overallGrade: 'MODERATE',
    pm10Grade: 'GOOD',
    pm25Grade: 'MODERATE',
    ozoneGrade: 'MODERATE',
    ...overrides,
  };
}

describe('currentAirQuality', () => {
  it('rejects negative measurements', () => {
    expect(
      currentAirQuality.safeParse(airQuality({ pm10MicrogramsPerCubicMeter: -1 }))
        .success,
    ).toBe(false);
    expect(
      currentAirQuality.safeParse(airQuality({ pm25MicrogramsPerCubicMeter: -1 }))
        .success,
    ).toBe(false);
    expect(
      currentAirQuality.safeParse(airQuality({ ozonePartsPerMillion: -0.001 }))
        .success,
    ).toBe(false);
    expect(
      currentAirQuality.safeParse(
        airQuality({ comprehensiveAirQualityIndex: -1 }),
      ).success,
    ).toBe(false);
  });

  it('accepts null for every measurement and grade (AirKorea "-", unavailable, overseas)', () => {
    const result = currentAirQuality.safeParse(
      airQuality({
        pm10MicrogramsPerCubicMeter: null,
        pm25MicrogramsPerCubicMeter: null,
        ozonePartsPerMillion: null,
        comprehensiveAirQualityIndex: null,
        overallGrade: null,
        pm10Grade: null,
        pm25Grade: null,
        ozoneGrade: null,
      }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts 0 as a valid measurement (distinct from null)', () => {
    expect(
      currentAirQuality.safeParse(airQuality({ pm10MicrogramsPerCubicMeter: 0 }))
        .success,
    ).toBe(true);
  });
});

describe('dailyAirQualityForecast', () => {
  it('accepts null ozone grade for periods with no ozone forecast', () => {
    const result = dailyAirQualityForecast.safeParse({
      date: '2026-07-16',
      pm10Grade: 'MODERATE',
      pm25Grade: 'MODERATE',
      ozoneGrade: null,
    });
    expect(result.success).toBe(true);
  });
});

// --- dailyForecast min/max invariant ----------------------------------------

function day(
  minimumTemperatureCelsius: number | null,
  maximumTemperatureCelsius: number | null,
): unknown {
  return {
    date: '2026-07-15',
    minimumTemperatureCelsius,
    maximumTemperatureCelsius,
    overall: null,
    morning: null,
    afternoon: null,
    sunriseAt: null,
    sunsetAt: null,
  };
}

describe('dailyForecast temperature invariant', () => {
  it('rejects a minimum greater than the maximum', () => {
    expect(dailyForecast.safeParse(day(31, 25)).success).toBe(false);
  });

  it('accepts minimum <= maximum and equal temperatures', () => {
    expect(dailyForecast.safeParse(day(25, 31)).success).toBe(true);
    expect(dailyForecast.safeParse(day(25, 25)).success).toBe(true);
  });

  it('does not check the invariant when either temperature is null', () => {
    expect(dailyForecast.safeParse(day(null, 25)).success).toBe(true);
    expect(dailyForecast.safeParse(day(31, null)).success).toBe(true);
    expect(dailyForecast.safeParse(day(null, null)).success).toBe(true);
  });
});
