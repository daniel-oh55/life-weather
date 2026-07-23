import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  weatherLocation,
  weatherRequestV1,
  type WeatherLocation,
  type WeatherRequestV1,
} from '../index';

/**
 * A valid V1 request body, matching the shape in `docs/contracts.md`. Returned fresh each
 * call so a test can mutate/extend it (or freeze it) without leaking into other tests.
 */
function validRequest() {
  return {
    location: {
      id: 'seoul-jongno',
      displayName: '서울 종로구',
      countryCode: 'KR',
      adminArea1: '서울특별시',
      adminArea2: '종로구',
      adminArea3: '청운효자동',
      latitude: 37.5729,
      longitude: 126.9794,
      timezone: 'Asia/Seoul',
    },
  };
}

/** The exact own keys a parsed `location` must have, sorted for a stable comparison. */
const LOCATION_KEYS = [
  'id',
  'displayName',
  'countryCode',
  'adminArea1',
  'adminArea2',
  'adminArea3',
  'latitude',
  'longitude',
  'timezone',
].sort();

/**
 * Recursively freeze a value so any attempt to mutate it during parsing throws in strict
 * mode. Uses only built-ins — no new dependency (see PR scope).
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

describe('weatherRequestV1 — valid input', () => {
  it('accepts a complete Korean location (all adminArea values are strings)', () => {
    const result = weatherRequestV1.safeParse(validRequest());
    expect(result.success).toBe(true);
  });

  it('accepts explicit null for the nullable adminArea fields', () => {
    const request = validRequest();
    request.location.adminArea1 = null as unknown as string;
    request.location.adminArea2 = null as unknown as string;
    request.location.adminArea3 = null as unknown as string;
    expect(weatherRequestV1.safeParse(request).success).toBe(true);
  });

  it('accepts coordinates at the valid boundaries', () => {
    const request = validRequest();
    request.location.latitude = 90;
    request.location.longitude = 180;
    expect(weatherRequestV1.safeParse(request).success).toBe(true);

    const request2 = validRequest();
    request2.location.latitude = -90;
    request2.location.longitude = -180;
    expect(weatherRequestV1.safeParse(request2).success).toBe(true);
  });

  it('accepts the named Asia/Seoul timezone and the KR country code', () => {
    const request = validRequest();
    expect(request.location.timezone).toBe('Asia/Seoul');
    expect(request.location.countryCode).toBe('KR');
    expect(weatherRequestV1.safeParse(request).success).toBe(true);
  });

  it('parses to exactly one own key: `location`', () => {
    const parsed = weatherRequestV1.parse(validRequest());
    expect(Object.keys(parsed)).toEqual(['location']);
  });

  it('parses a location with exactly the nine WeatherLocation own keys', () => {
    const parsed = weatherRequestV1.parse(validRequest());
    expect(Object.keys(parsed.location).sort()).toEqual(LOCATION_KEYS);
  });
});

describe('weatherRequestV1 — top-level structure', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['string', 'seoul'],
    ['number', 42],
    ['boolean', true],
    ['array', [validRequest()]],
    ['empty object', {}],
  ])('rejects a top-level %s', (_label, input) => {
    expect(weatherRequestV1.safeParse(input).success).toBe(false);
  });

  it.each([
    ['missing location', {}],
    ['location: null', { location: null }],
    ['location: array', { location: [validRequest().location] }],
    ['location: string', { location: 'seoul-jongno' }],
    ['location: number', { location: 1 }],
  ])('rejects a body with %s', (_label, input) => {
    expect(weatherRequestV1.safeParse(input).success).toBe(false);
  });
});

describe('weatherRequestV1 — top-level unknown keys', () => {
  it.each([
    'product',
    'provider',
    'contractVersion',
    'requestId',
    'nx',
    'ny',
    'serviceKey',
    'sections',
  ])('rejects (not strips) the unexpected top-level key %j', (key) => {
    const request = { ...validRequest(), [key]: 'unexpected' } as Record<
      string,
      unknown
    >;
    const result = weatherRequestV1.safeParse(request);
    expect(result.success).toBe(false);
  });
});

describe('weatherRequestV1 — nested location unknown keys', () => {
  it.each([
    'product',
    'nx',
    'ny',
    'kmaGrid',
    'stationId',
    'airKoreaStationId',
    'isCurrent',
    'sortOrder',
    'serviceKey',
    'provider',
  ])('rejects (not strips) the provider/local-only location key %j', (key) => {
    const request = validRequest();
    (request.location as Record<string, unknown>)[key] = 'unexpected';
    const result = weatherRequestV1.safeParse(request);
    expect(result.success).toBe(false);
  });
});

describe('weatherRequestV1 — inherited WeatherLocation validation', () => {
  it('rejects an empty id', () => {
    const request = validRequest();
    request.location.id = '';
    expect(weatherRequestV1.safeParse(request).success).toBe(false);
  });

  it('rejects an empty displayName', () => {
    const request = validRequest();
    request.location.displayName = '';
    expect(weatherRequestV1.safeParse(request).success).toBe(false);
  });

  it.each(['kr', 'KOR', 'K', 'Kr'])(
    'rejects the invalid country code %j',
    (countryCode) => {
      const request = validRequest();
      request.location.countryCode = countryCode;
      expect(weatherRequestV1.safeParse(request).success).toBe(false);
    },
  );

  it.each([
    ['latitude', 91],
    ['latitude', -91],
    ['longitude', 181],
    ['longitude', -181],
  ])('rejects out-of-range %s (%d)', (field, value) => {
    const request = validRequest();
    (request.location as Record<string, unknown>)[field] = value;
    expect(weatherRequestV1.safeParse(request).success).toBe(false);
  });

  it.each([
    ['NaN', Number.NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('rejects a non-finite latitude (%s)', (_label, value) => {
    const request = validRequest();
    request.location.latitude = value;
    expect(weatherRequestV1.safeParse(request).success).toBe(false);
  });

  // Timezone cases reuse the runtime-stable values from the common contracts tests: a
  // fixed UTC offset, a non-IANA name, a local datetime, and the empty string are rejected
  // on every platform's Intl data (they never depend on a specific zone being present).
  it.each([
    '+09:00',
    '+0900',
    'Seoul',
    'Not/AZone',
    '2026-07-15T10:00:00',
    '',
  ])('rejects the invalid timezone %j', (timezone) => {
    const request = validRequest();
    request.location.timezone = timezone;
    expect(weatherRequestV1.safeParse(request).success).toBe(false);
  });
});

describe('weatherRequestV1 — null vs. missing for nullable fields', () => {
  it.each(['adminArea1', 'adminArea2', 'adminArea3'] as const)(
    'accepts %s: null but rejects the field being missing',
    (field) => {
      const withNull = validRequest();
      withNull.location[field] = null as unknown as string;
      expect(weatherRequestV1.safeParse(withNull).success).toBe(true);

      const missing = validRequest();
      delete (missing.location as Record<string, unknown>)[field];
      expect(weatherRequestV1.safeParse(missing).success).toBe(false);
    },
  );
});

describe('weatherRequestV1 — does not mutate caller input', () => {
  it('leaves a deep-frozen valid input unmodified on a successful parse', () => {
    const input = deepFreeze(validRequest());
    const parsed = weatherRequestV1.parse(input);
    expect(parsed).toEqual(validRequest());
    // A fresh output object — reference identity is intentionally not part of the contract.
    expect(parsed).not.toBe(input);
  });

  it('leaves a deep-frozen invalid input unmodified on a failed safeParse', () => {
    const input = deepFreeze({
      ...validRequest(),
      serviceKey: 'unexpected',
    });
    const result = weatherRequestV1.safeParse(input);
    expect(result.success).toBe(false);
    // deepFreeze would have thrown on any write attempt during parsing; reaching here is
    // the assertion that no mutation was attempted.
  });
});

describe('weatherRequestV1 — does not leak an unknown field value', () => {
  const MARKER = 'PR28_SECRET_MARKER_MUST_NOT_LEAK';

  it('rejects a serviceKey field without surfacing its value in the error', () => {
    const request = { ...validRequest(), serviceKey: MARKER };
    const result = weatherRequestV1.safeParse(request);
    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error('expected the request to be rejected');
    }

    // The rejected key *name* may appear; its value must not, however we stringify the error.
    const serialized = JSON.stringify(result.error);
    expect(serialized).not.toContain(MARKER);
    expect(result.error.message).not.toContain(MARKER);
    expect(String(result.error)).not.toContain(MARKER);
  });
});

describe('weatherRequestV1 — type contract', () => {
  it('infers exactly { location: WeatherLocation }', () => {
    expectTypeOf<WeatherRequestV1>().toEqualTypeOf<{
      location: WeatherLocation;
    }>();
  });

  it('has a required (non-optional) location and no request-only extras', () => {
    expectTypeOf<WeatherRequestV1>().toHaveProperty('location');
    expectTypeOf<WeatherRequestV1>().not.toHaveProperty('product');
    expectTypeOf<WeatherRequestV1>().not.toHaveProperty('contractVersion');
    expectTypeOf<WeatherRequestV1>().not.toHaveProperty('requestId');
    // `location` is required: the type is not satisfied by an optional-location shape.
    expectTypeOf<WeatherRequestV1>().not.toEqualTypeOf<{
      location?: WeatherLocation;
    }>();
  });
});

describe('weatherRequestV1 — leaves the shared weatherLocation schema unchanged', () => {
  it('still strips unknown keys on the shared schema (strictness is request-only)', () => {
    const parsed = weatherLocation.parse({
      ...validRequest().location,
      kmaGrid: { nx: 60, ny: 127 },
    });
    expect(parsed).not.toHaveProperty('kmaGrid');
  });
});
