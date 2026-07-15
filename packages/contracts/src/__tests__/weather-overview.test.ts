import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  weatherOverview,
  type CurrentWeather,
  type HourlyForecast,
  type WeatherOverview,
} from '../index';
import { fullOverview } from './fixtures';

/** Collect the dotted paths of every validation issue for a rejected parse. */
function issuePaths(value: unknown): string[] {
  const result = weatherOverview.safeParse(value);
  expect(result.success).toBe(false);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join('.'));
}

describe('WeatherOverview — complete payload', () => {
  it('accepts a payload with every section present', () => {
    const overview = fullOverview();
    expect(weatherOverview.safeParse(overview).success).toBe(true);
  });

  it('infers section types from the schema', () => {
    const parsed = weatherOverview.parse(fullOverview());
    expectTypeOf(parsed).toEqualTypeOf<WeatherOverview>();
    expectTypeOf(parsed.current).toEqualTypeOf<CurrentWeather | null>();
    expectTypeOf(parsed.hourly).toEqualTypeOf<HourlyForecast[]>();
  });

  it('strips unknown extra fields at every level', () => {
    const overview = fullOverview() as Record<string, unknown>;
    overview.debugTrace = 'should-be-removed';
    const parsed = weatherOverview.parse(overview);
    expect(parsed).not.toHaveProperty('debugTrace');
  });

  it('keeps a mid-range day state in `overall` without duplicating into morning/afternoon', () => {
    const parsed = weatherOverview.parse(fullOverview());
    const midRange = parsed.daily[1];
    expect(midRange?.overall).not.toBeNull();
    expect(midRange?.morning).toBeNull();
    expect(midRange?.afternoon).toBeNull();
  });
});

describe('WeatherOverview — partial payloads', () => {
  it('accepts a missing CURRENT section', () => {
    const overview = fullOverview();
    overview.current = null;
    overview.missingSections = ['CURRENT'];
    expect(weatherOverview.safeParse(overview).success).toBe(true);
  });

  it('accepts a missing AIR_QUALITY_CURRENT section', () => {
    const overview = fullOverview();
    overview.airQuality.current = null;
    overview.missingSections = ['AIR_QUALITY_CURRENT'];
    expect(weatherOverview.safeParse(overview).success).toBe(true);
  });

  it('accepts a missing HOURLY section (empty array)', () => {
    const overview = fullOverview();
    overview.hourly = [];
    overview.missingSections = ['HOURLY'];
    expect(weatherOverview.safeParse(overview).success).toBe(true);
  });

  it('accepts a missing DAILY section (empty array)', () => {
    const overview = fullOverview();
    overview.daily = [];
    overview.missingSections = ['DAILY'];
    expect(weatherOverview.safeParse(overview).success).toBe(true);
  });

  it('accepts a missing AIR_QUALITY_FORECAST section (empty array)', () => {
    const overview = fullOverview();
    overview.airQuality.daily = [];
    overview.missingSections = ['AIR_QUALITY_FORECAST'];
    expect(weatherOverview.safeParse(overview).success).toBe(true);
  });

  it('accepts an ALERTS fetch failure (empty array + ALERTS missing)', () => {
    const overview = fullOverview();
    overview.alerts = [];
    overview.missingSections = ['ALERTS'];
    expect(weatherOverview.safeParse(overview).success).toBe(true);
  });

  it('accepts a successful response with no alerts (empty array, ALERTS not missing)', () => {
    const overview = fullOverview();
    overview.alerts = [];
    overview.missingSections = [];
    expect(weatherOverview.safeParse(overview).success).toBe(true);
  });

  it('accepts an empty hourly array when HOURLY is not missing', () => {
    const overview = fullOverview();
    overview.hourly = [];
    overview.missingSections = [];
    expect(weatherOverview.safeParse(overview).success).toBe(true);
  });

  it('ignores UNKNOWN entries in missingSections for invariant checks', () => {
    const overview = fullOverview();
    overview.missingSections = ['UNKNOWN'];
    expect(weatherOverview.safeParse(overview).success).toBe(true);
  });
});

describe('WeatherOverview — contradictory payloads are rejected', () => {
  it('rejects current === null with no CURRENT in missingSections', () => {
    const overview = fullOverview();
    overview.current = null;
    overview.missingSections = [];
    expect(issuePaths(overview)).toContain('current');
  });

  it('rejects a present current with CURRENT in missingSections', () => {
    const overview = fullOverview();
    overview.missingSections = ['CURRENT'];
    expect(issuePaths(overview)).toContain('current');
  });

  it('rejects airQuality.current === null with no AIR_QUALITY_CURRENT missing', () => {
    const overview = fullOverview();
    overview.airQuality.current = null;
    overview.missingSections = [];
    expect(issuePaths(overview)).toContain('airQuality.current');
  });

  it('rejects hourly data while HOURLY is marked missing', () => {
    const overview = fullOverview();
    overview.missingSections = ['HOURLY'];
    expect(issuePaths(overview)).toContain('hourly');
  });

  it('rejects daily data while DAILY is marked missing', () => {
    const overview = fullOverview();
    overview.missingSections = ['DAILY'];
    expect(issuePaths(overview)).toContain('daily');
  });

  it('rejects alerts data while ALERTS is marked missing', () => {
    const overview = fullOverview();
    overview.missingSections = ['ALERTS'];
    expect(issuePaths(overview)).toContain('alerts');
  });

  it('rejects duplicate entries in missingSections', () => {
    const overview = fullOverview();
    overview.hourly = [];
    overview.missingSections = ['HOURLY', 'HOURLY'];
    expect(issuePaths(overview)).toContain('missingSections');
  });
});

describe('WeatherOverview — missingSections (forward-compatible section array)', () => {
  // Build a raw payload whose missingSections carries arbitrary (possibly unknown) values.
  function withMissing(missingSections: unknown[]) {
    return weatherOverview.safeParse({ ...fullOverview(), missingSections });
  }

  it('accepts distinct unknown sections without a false duplicate error', () => {
    const result = withMissing(['UV', 'POLLEN']);
    expect(result.success).toBe(true);
    if (result.success) {
      // Both unknowns collapse to a single UNKNOWN, which invariant checks ignore.
      expect(result.data.missingSections).toEqual(['UNKNOWN']);
    }
  });

  it('collapses a real UNKNOWN together with an unknown string', () => {
    const result = withMissing(['UNKNOWN', 'UV']);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.missingSections).toEqual(['UNKNOWN']);
    }
  });

  it('rejects a duplicate raw string (known or unknown)', () => {
    // ['HOURLY','HOURLY'] would otherwise contradict the empty-hourly rule; use empty hourly.
    const dupKnown = weatherOverview.safeParse({
      ...fullOverview(),
      hourly: [],
      missingSections: ['HOURLY', 'HOURLY'],
    });
    expect(dupKnown.success).toBe(false);
    expect(withMissing(['UV', 'UV']).success).toBe(false);
  });

  it('rejects non-string elements', () => {
    expect(withMissing([123]).success).toBe(false);
    expect(withMissing([null]).success).toBe(false);
    expect(withMissing([true]).success).toBe(false);
  });

  it('allows an empty missingSections array', () => {
    expect(withMissing([]).success).toBe(true);
  });
});
