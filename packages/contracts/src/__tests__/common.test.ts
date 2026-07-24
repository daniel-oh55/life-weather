import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  apiErrorCode,
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
  type ApiErrorCode,
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

describe('apiErrorCode', () => {
  // The full set of known codes, sorted, as of PR #29. `UNSUPPORTED_LOCATION` was added
  // additively; every other code and the `UNKNOWN` fallback are unchanged.
  const KNOWN_CODES = [
    'DATA_UNAVAILABLE',
    'INTERNAL_ERROR',
    'INVALID_REQUEST',
    'LOCATION_NOT_FOUND',
    'PROVIDER_UNAVAILABLE',
    'RATE_LIMITED',
    'UNKNOWN',
    'UNSUPPORTED_CONTRACT_VERSION',
    'UNSUPPORTED_LOCATION',
    'UPSTREAM_TIMEOUT',
  ] as const;

  it('accepts UNSUPPORTED_LOCATION in the strict schema (additive known value)', () => {
    expect(apiErrorCode.strict.parse('UNSUPPORTED_LOCATION')).toBe(
      'UNSUPPORTED_LOCATION',
    );
  });

  it('preserves UNSUPPORTED_LOCATION in the compatible schema (not mapped to UNKNOWN)', () => {
    expect(apiErrorCode.compatible.parse('UNSUPPORTED_LOCATION')).toBe(
      'UNSUPPORTED_LOCATION',
    );
  });

  it('keeps every pre-existing known code unchanged', () => {
    for (const code of KNOWN_CODES) {
      expect(apiErrorCode.strict.parse(code)).toBe(code);
      expect(apiErrorCode.compatible.parse(code)).toBe(code);
    }
    // The known set is exactly these ten codes and no more.
    expect(apiErrorCode.strict.options.length).toBe(KNOWN_CODES.length);
    expect([...apiErrorCode.strict.options].sort()).toEqual([...KNOWN_CODES]);
  });

  it('still maps an unknown string to UNKNOWN (compatible) and rejects it (strict)', () => {
    expect(apiErrorCode.compatible.parse('SOME_FUTURE_CODE')).toBe('UNKNOWN');
    expect(apiErrorCode.strict.safeParse('SOME_FUTURE_CODE').success).toBe(false);
  });

  it('rejects a missing value, null, and numbers in both schemas', () => {
    for (const schema of [apiErrorCode.strict, apiErrorCode.compatible]) {
      expect(schema.safeParse(undefined).success).toBe(false);
      expect(schema.safeParse(null).success).toBe(false);
      expect(schema.safeParse(42).success).toBe(false);
    }
  });

  it('infers the literal union type (UNSUPPORTED_LOCATION assignable, string is not)', () => {
    // The annotation itself is a compile-time proof the literal is a member of the union.
    const code: ApiErrorCode = 'UNSUPPORTED_LOCATION';
    expect(code).toBe('UNSUPPORTED_LOCATION');
    expectTypeOf<ApiErrorCode>().not.toEqualTypeOf<string>();
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

  // Timestamp precision policy: seconds are required, and fractional seconds are
  // either absent or exactly 3 digits (milliseconds). This mirrors classifyFreshness,
  // which requires the same precision. See docs/contracts.md.
  it.each([
    '2026-07-15T12:00:00Z', // seconds precision, UTC
    '2026-07-15T12:00:00.123Z', // milliseconds precision, UTC
    '2026-07-15T21:00:00+09:00', // seconds precision, numeric offset
    '2026-07-15T21:00:00.123+09:00', // milliseconds precision, numeric offset
  ])('accepts the seconds/milliseconds-precision datetime %j', (value) => {
    expect(isoDateTime.safeParse(value).success).toBe(true);
  });

  it.each([
    '2026-07-15T12:00Z', // no seconds (minute precision)
    '2026-07-15T12:00:00.1Z', // 1 fractional digit
    '2026-07-15T12:00:00.12Z', // 2 fractional digits
    '2026-07-15T12:00:00.0001Z', // 4 fractional digits (sub-millisecond)
    '2026-07-15T12:00:00.1234Z', // 4 fractional digits
  ])('rejects the wrong-precision datetime %j', (value) => {
    expect(isoDateTime.safeParse(value).success).toBe(false);
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
  it.each(['Asia/Seoul', 'Asia/Tokyo', 'America/New_York', 'UTC'])(
    'accepts the valid named IANA zone %s',
    (zone) => {
      expect(ianaTimeZone.safeParse(zone).success).toBe(true);
    },
  );

  it.each(['+09:00', '-05:30', '+0900'])(
    'rejects the fixed UTC-offset identifier %j',
    (zone) => {
      expect(ianaTimeZone.safeParse(zone).success).toBe(false);
    },
  );

  it.each(['Seoul', 'Not/AZone', ''])(
    'rejects the invalid zone %j',
    (zone) => {
      expect(ianaTimeZone.safeParse(zone).success).toBe(false);
    },
  );
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

  it('rejects a fixed UTC-offset timezone', () => {
    expect(
      weatherLocation.safeParse({ ...seoul, timezone: '+09:00' }).success,
    ).toBe(false);
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
