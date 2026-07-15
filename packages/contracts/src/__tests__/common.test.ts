import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  ianaTimeZone,
  isoDate,
  isoDateTime,
  latitude,
  longitude,
  nonNegativeNumber,
  percent,
  weatherAlertType,
  weatherCondition,
  weatherLocation,
  windDirectionDegrees,
  type WeatherAlertType,
  type WeatherCondition,
  type WeatherLocation,
} from '../index';

describe('forward-compatible enums', () => {
  it('keeps a known value unchanged (compatible)', () => {
    expect(weatherCondition.compatible.parse('RAIN')).toBe('RAIN');
    expect(weatherAlertType.compatible.parse('TYPHOON')).toBe('TYPHOON');
  });

  it('maps an unknown string to the fallback (compatible)', () => {
    expect(weatherCondition.compatible.parse('ACID_RAIN')).toBe('UNKNOWN');
    expect(weatherAlertType.compatible.parse('METEOR_SHOWER')).toBe('OTHER');
  });

  it('rejects an unknown string in the strict schema', () => {
    expect(weatherCondition.strict.safeParse('ACID_RAIN').success).toBe(false);
    expect(weatherCondition.strict.parse('SNOW')).toBe('SNOW');
  });

  it('rejects a missing value (undefined), null, numbers and booleans', () => {
    for (const schema of [
      weatherCondition.compatible,
      weatherCondition.strict,
    ]) {
      expect(schema.safeParse(undefined).success).toBe(false);
      expect(schema.safeParse(null).success).toBe(false);
      expect(schema.safeParse(42).success).toBe(false);
      expect(schema.safeParse(true).success).toBe(false);
      expect(schema.safeParse({}).success).toBe(false);
    }
  });

  it('infers the literal union as the compatible output type', () => {
    const condition = weatherCondition.compatible.parse('CLEAR');
    expectTypeOf(condition).toEqualTypeOf<WeatherCondition>();

    const alertType = weatherAlertType.compatible.parse('HEAVY_RAIN');
    expectTypeOf(alertType).toEqualTypeOf<WeatherAlertType>();

    // The output is a finite literal union, not `string`.
    expectTypeOf<WeatherCondition>().not.toEqualTypeOf<string>();
  });
});

describe('date and time schemas', () => {
  it('accepts a UTC "Z" datetime', () => {
    expect(isoDateTime.safeParse('2026-07-15T01:00:00Z').success).toBe(true);
  });

  it('accepts a numeric +09:00 offset datetime', () => {
    expect(isoDateTime.safeParse('2026-07-15T10:00:00+09:00').success).toBe(
      true,
    );
  });

  it('rejects a datetime with no timezone', () => {
    expect(isoDateTime.safeParse('2026-07-15T10:00:00').success).toBe(false);
  });

  it('rejects a malformed datetime', () => {
    expect(isoDateTime.safeParse('not-a-datetime').success).toBe(false);
  });

  it('accepts a valid local date and rejects an invalid one', () => {
    expect(isoDate.safeParse('2026-07-15').success).toBe(true);
    expect(isoDate.safeParse('2026-13-40').success).toBe(false);
  });
});

describe('numeric range schemas', () => {
  it('accepts percent 0 and 100 and rejects out-of-range', () => {
    expect(percent.safeParse(0).success).toBe(true);
    expect(percent.safeParse(100).success).toBe(true);
    expect(percent.safeParse(-1).success).toBe(false);
    expect(percent.safeParse(101).success).toBe(false);
  });

  it('accepts wind direction 0 and 359.999 and rejects 360', () => {
    expect(windDirectionDegrees.safeParse(0).success).toBe(true);
    expect(windDirectionDegrees.safeParse(359.999).success).toBe(true);
    expect(windDirectionDegrees.safeParse(360).success).toBe(false);
  });

  it('accepts non-negative amounts (incl. 0) and rejects negatives', () => {
    expect(nonNegativeNumber.safeParse(0).success).toBe(true);
    expect(nonNegativeNumber.safeParse(12.5).success).toBe(true);
    expect(nonNegativeNumber.safeParse(-0.1).success).toBe(false);
  });

  it('rejects NaN and Infinity for every finite numeric schema', () => {
    for (const schema of [percent, windDirectionDegrees, nonNegativeNumber]) {
      expect(schema.safeParse(Number.NaN).success).toBe(false);
      expect(schema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
      expect(schema.safeParse(Number.NEGATIVE_INFINITY).success).toBe(false);
    }
  });

  it('accepts latitude/longitude boundaries', () => {
    expect(latitude.safeParse(90).success).toBe(true);
    expect(latitude.safeParse(-90).success).toBe(true);
    expect(longitude.safeParse(180).success).toBe(true);
    expect(longitude.safeParse(-180).success).toBe(true);
  });
});

describe('ianaTimeZone', () => {
  it.each(['Asia/Seoul', 'Asia/Tokyo', 'America/New_York'])(
    'accepts the valid IANA zone %s',
    (zone) => {
      expect(ianaTimeZone.safeParse(zone).success).toBe(true);
    },
  );

  it.each(['Not/AZone', 'Seoul', ''])('rejects the invalid zone %j', (zone) => {
    expect(ianaTimeZone.safeParse(zone).success).toBe(false);
  });
});

describe('weatherLocation', () => {
  const seoul: WeatherLocation = {
    id: 'loc_seoul_jung',
    displayName: '서울특별시 중구',
    countryCode: 'KR',
    adminArea1: '서울특별시',
    adminArea2: '중구',
    adminArea3: null,
    latitude: 37.5636,
    longitude: 126.997,
    timezone: 'Asia/Seoul',
  };

  it('accepts a valid Korean location', () => {
    expect(weatherLocation.parse(seoul)).toEqual(seoul);
  });

  it('accepts an overseas location', () => {
    const tokyo: WeatherLocation = {
      id: 'loc_tokyo',
      displayName: 'Tokyo',
      countryCode: 'JP',
      adminArea1: 'Tokyo',
      adminArea2: null,
      adminArea3: null,
      latitude: 35.6762,
      longitude: 139.6503,
      timezone: 'Asia/Tokyo',
    };
    expect(weatherLocation.safeParse(tokyo).success).toBe(true);
  });

  it('accepts latitude and longitude boundary values', () => {
    expect(
      weatherLocation.safeParse({ ...seoul, latitude: 90, longitude: 180 })
        .success,
    ).toBe(true);
    expect(
      weatherLocation.safeParse({ ...seoul, latitude: -90, longitude: -180 })
        .success,
    ).toBe(true);
  });

  it('rejects out-of-range coordinates', () => {
    expect(weatherLocation.safeParse({ ...seoul, latitude: 91 }).success).toBe(
      false,
    );
    expect(
      weatherLocation.safeParse({ ...seoul, longitude: -181 }).success,
    ).toBe(false);
  });

  it('rejects a lowercase country code', () => {
    expect(weatherLocation.safeParse({ ...seoul, countryCode: 'kr' }).success).toBe(
      false,
    );
  });

  it('rejects an invalid IANA timezone', () => {
    expect(weatherLocation.safeParse({ ...seoul, timezone: 'Seoul' }).success).toBe(
      false,
    );
  });

  it('strips unknown extra fields such as kmaGrid', () => {
    const parsed = weatherLocation.parse({
      ...seoul,
      kmaGrid: { nx: 60, ny: 127 },
      isCurrentLocation: true,
    });
    expect(parsed).not.toHaveProperty('kmaGrid');
    expect(parsed).not.toHaveProperty('isCurrentLocation');
    expect(parsed).toEqual(seoul);
  });

  it('infers the location field types from the schema', () => {
    // `adminArea*` are `string | null` (required, nullable) and coordinates are numbers.
    expectTypeOf<WeatherLocation['adminArea1']>().toEqualTypeOf<string | null>();
    expectTypeOf<WeatherLocation['latitude']>().toEqualTypeOf<number>();
  });
});
