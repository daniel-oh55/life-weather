import { describe, expect, it } from 'vitest';

import {
  createWeatherRequestFromSavedLocation,
  mobileKmaGrid,
  mobileSavedLocation,
  type MobileSavedLocation,
} from './index';
import { weatherRequestV1 } from '@life-weather/contracts';

// ---------------------------------------------------------------------------
// Synthetic fixtures. Everything here is fabricated — synthetic ids, display names, and
// coordinates, and a non-sensitive standard timezone — so no real user location, stored place,
// or device identifier is ever used. Each builder returns a *fresh* object so a test can freeze
// or mutate it without leaking into another test.
// ---------------------------------------------------------------------------

/** A marker asserted absent from any invalid result — proves nothing input-derived leaks out. */
const SECRET_MARKER = 'SYNTHETIC_SAVED_LOCATION_SECRET_MUST_NOT_LEAK';

/** The nine shared `WeatherLocation` fields, all synthetic. */
function syntheticSharedFields() {
  return {
    id: 'saved-location-1',
    displayName: 'Synthetic City',
    countryCode: 'KR',
    adminArea1: 'Synthetic Province',
    adminArea2: 'Synthetic District',
    adminArea3: null,
    latitude: 12.34,
    longitude: 56.78,
    timezone: 'Asia/Seoul',
  };
}

/** A fully valid, fresh saved location. */
function syntheticSavedLocation(): MobileSavedLocation {
  return {
    ...syntheticSharedFields(),
    kmaGrid: { nx: 60, ny: 127 },
    isCurrent: false,
    sortOrder: 0,
  };
}

// ---------------------------------------------------------------------------
// 8.1 — valid schema
// ---------------------------------------------------------------------------

describe('mobileSavedLocation — valid input', () => {
  it('parses a complete saved location', () => {
    expect(mobileSavedLocation.safeParse(syntheticSavedLocation()).success).toBe(true);
  });

  it('parses a kmaGrid object', () => {
    const result = mobileSavedLocation.safeParse({
      ...syntheticSavedLocation(),
      kmaGrid: { nx: 0, ny: 0 },
    });
    expect(result.success).toBe(true);
  });

  it('parses kmaGrid: null', () => {
    const result = mobileSavedLocation.safeParse({ ...syntheticSavedLocation(), kmaGrid: null });
    expect(result.success).toBe(true);
  });

  it('parses null adminArea fields', () => {
    const result = mobileSavedLocation.safeParse({
      ...syntheticSavedLocation(),
      adminArea1: null,
      adminArea2: null,
      adminArea3: null,
    });
    expect(result.success).toBe(true);
  });

  it.each([true, false])('parses isCurrent: %s', (isCurrent) => {
    expect(mobileSavedLocation.safeParse({ ...syntheticSavedLocation(), isCurrent }).success).toBe(
      true,
    );
  });

  it.each([0, 3])('parses sortOrder: %s', (sortOrder) => {
    expect(mobileSavedLocation.safeParse({ ...syntheticSavedLocation(), sortOrder }).success).toBe(
      true,
    );
  });

  it('accepts mobileKmaGrid with nx/ny of 0', () => {
    expect(mobileKmaGrid.safeParse({ nx: 0, ny: 0 }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8.2 — invalid schema
// ---------------------------------------------------------------------------

describe('mobileSavedLocation — invalid input', () => {
  it('rejects an unknown top-level field', () => {
    const result = mobileSavedLocation.safeParse({ ...syntheticSavedLocation(), extra: 'nope' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown field nested in kmaGrid', () => {
    const result = mobileSavedLocation.safeParse({
      ...syntheticSavedLocation(),
      kmaGrid: { nx: 60, ny: 127, extra: 'nope' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing required field', () => {
    const { latitude: _omitted, ...withoutLatitude } = syntheticSavedLocation();
    expect(mobileSavedLocation.safeParse(withoutLatitude).success).toBe(false);
  });

  it('rejects kmaGrid: undefined (required)', () => {
    const result = mobileSavedLocation.safeParse({
      ...syntheticSavedLocation(),
      kmaGrid: undefined,
    });
    expect(result.success).toBe(false);
  });

  it('rejects isCurrent: undefined', () => {
    const result = mobileSavedLocation.safeParse({
      ...syntheticSavedLocation(),
      isCurrent: undefined,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-boolean isCurrent', () => {
    const result = mobileSavedLocation.safeParse({ ...syntheticSavedLocation(), isCurrent: 'yes' });
    expect(result.success).toBe(false);
  });

  it('rejects a negative sortOrder', () => {
    expect(mobileSavedLocation.safeParse({ ...syntheticSavedLocation(), sortOrder: -1 }).success).toBe(
      false,
    );
  });

  it('rejects a fractional sortOrder', () => {
    expect(mobileSavedLocation.safeParse({ ...syntheticSavedLocation(), sortOrder: 1.5 }).success).toBe(
      false,
    );
  });

  it.each([
    ['nx', { nx: -1, ny: 127 }],
    ['ny', { nx: 60, ny: -1 }],
  ])('rejects a negative %s in kmaGrid', (_label, kmaGrid) => {
    expect(mobileSavedLocation.safeParse({ ...syntheticSavedLocation(), kmaGrid }).success).toBe(
      false,
    );
  });

  it.each([
    ['nx', { nx: 60.5, ny: 127 }],
    ['ny', { nx: 60, ny: 127.5 }],
  ])('rejects a fractional %s in kmaGrid', (_label, kmaGrid) => {
    expect(mobileSavedLocation.safeParse({ ...syntheticSavedLocation(), kmaGrid }).success).toBe(
      false,
    );
  });

  it('rejects an invalid country code', () => {
    const result = mobileSavedLocation.safeParse({ ...syntheticSavedLocation(), countryCode: 'kr' });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid timezone', () => {
    const result = mobileSavedLocation.safeParse({ ...syntheticSavedLocation(), timezone: 'Seoul' });
    expect(result.success).toBe(false);
  });

  it.each([
    ['latitude', { latitude: 91 }],
    ['longitude', { longitude: 181 }],
  ])('rejects out-of-range %s', (_label, override) => {
    expect(mobileSavedLocation.safeParse({ ...syntheticSavedLocation(), ...override }).success).toBe(
      false,
    );
  });

  it('rejects null in a non-nullable field', () => {
    const result = mobileSavedLocation.safeParse({ ...syntheticSavedLocation(), displayName: null });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8.3 — request transformation
// ---------------------------------------------------------------------------

describe('createWeatherRequestFromSavedLocation — valid input', () => {
  it('returns exactly a single { location } request', () => {
    const result = createWeatherRequestFromSavedLocation(syntheticSavedLocation());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.request)).toEqual(['location']);
  });

  it('includes only the nine shared fields in location', () => {
    const result = createWeatherRequestFromSavedLocation(syntheticSavedLocation());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.request.location).sort()).toEqual(
      [
        'adminArea1',
        'adminArea2',
        'adminArea3',
        'countryCode',
        'displayName',
        'id',
        'latitude',
        'longitude',
        'timezone',
      ].sort(),
    );
  });

  it('never carries local-only or provider-native fields into location', () => {
    const result = createWeatherRequestFromSavedLocation(syntheticSavedLocation());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const location = result.request.location as Record<string, unknown>;
    for (const forbidden of ['kmaGrid', 'isCurrent', 'sortOrder', 'nx', 'ny']) {
      expect(location).not.toHaveProperty(forbidden);
    }
  });

  it('preserves null adminArea fields', () => {
    const result = createWeatherRequestFromSavedLocation({
      ...syntheticSavedLocation(),
      adminArea1: null,
      adminArea2: null,
      adminArea3: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.location.adminArea1).toBeNull();
    expect(result.request.location.adminArea2).toBeNull();
    expect(result.request.location.adminArea3).toBeNull();
  });

  it('returns fresh objects distinct from the input', () => {
    const input = syntheticSavedLocation();
    const result = createWeatherRequestFromSavedLocation(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request).not.toBe(input);
    expect(result.request.location as unknown).not.toBe(input);
  });

  it('does not mutate the input', () => {
    const input = syntheticSavedLocation();
    const snapshot = JSON.stringify(input);
    createWeatherRequestFromSavedLocation(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(Object.keys(input).sort()).toEqual(
      ['adminArea1', 'adminArea2', 'adminArea3', 'countryCode', 'displayName', 'id', 'isCurrent', 'kmaGrid', 'latitude', 'longitude', 'sortOrder', 'timezone'].sort(),
    );
  });

  it('returns a request that passes weatherRequestV1', () => {
    const result = createWeatherRequestFromSavedLocation(syntheticSavedLocation());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(weatherRequestV1.safeParse(result.request).success).toBe(true);
  });
});

describe('createWeatherRequestFromSavedLocation — invalid input', () => {
  const fixedInvalid = { ok: false, error: { kind: 'INVALID_SAVED_LOCATION' } } as const;

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'not a location'],
    ['a number', 42],
    ['an empty object', {}],
    ['an array', []],
  ])('does not throw and returns the fixed error for %s', (_label, input) => {
    let result: ReturnType<typeof createWeatherRequestFromSavedLocation>;
    expect(() => {
      result = createWeatherRequestFromSavedLocation(input as unknown);
    }).not.toThrow();
    expect(result!).toEqual(fixedInvalid);
  });

  it('returns the fixed error for a saved location with a bad local-only field', () => {
    const result = createWeatherRequestFromSavedLocation({
      ...syntheticSavedLocation(),
      sortOrder: -1,
    });
    expect(result).toEqual(fixedInvalid);
  });

  it('does not leak the secret marker, coordinates, or original values in the error', () => {
    const result = createWeatherRequestFromSavedLocation({
      ...syntheticSavedLocation(),
      displayName: SECRET_MARKER,
      countryCode: 'not-a-country',
    });
    expect(result).toEqual(fixedInvalid);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET_MARKER);
    expect(serialized).not.toContain('12.34');
    expect(serialized).not.toContain('56.78');
  });
});
