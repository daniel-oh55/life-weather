import { describe, expect, it } from 'vitest';

import {
  convertKmaLatitudeLongitudeToGrid,
  type ConvertKmaLatitudeLongitudeToGridInput,
  type KmaForecastGridCoordinate,
} from '../index';

/**
 * Fixture provenance — none of the expected grids below are produced by the function under test
 * (no self-verification) or by inverse-projecting inside a test:
 *
 * - The origin invariant `(38, 126) -> (43, 136)` is the projection's definitional anchor: the
 *   official origin latitude/longitude maps to the official origin grid cell (`OLAT`/`OLON` ->
 *   `XO`/`YO`).
 * - The representative Korean grids (Seoul 60/127, Busan 98/76, Jeju 53/38, Incheon 55/124,
 *   Daejeon 67/100, Gwangju 58/74) are the widely published official 동네예보 grids for those
 *   coordinates, matching the KMA DFS contract. The API-hub sample 36.5/127.5 -> 69/104 uses the
 *   example input published by the KMA API hub; the grid follows from applying the official DFS
 *   formula (the hub documents the sample input, not the resulting grid on the page).
 * - The four grid-corner fixtures are not captured authenticated API responses. The official KMA
 *   grid-area PDF confirms the corner locations at approximately four decimal places. Their
 *   six-decimal tuples are fixed validation fixtures prepared through an independent inverse DFS
 *   calculation using the official projection constants; selected extreme components are aligned
 *   with the latitude/longitude coverage endpoints published by the KMA API hub — 31.651814
 *   (min lat), 43.393490 (max lat), 123.310165 (min lon), 132.774963 (max lon). They are kept
 *   separate from the production forward implementation and are not generated during the tests.
 *   See `docs/kma-grid-conversion.md`.
 */
const SUCCESS_FIXTURES = [
  {
    name: 'origin invariant (OLAT/OLON -> XO/YO)',
    latitude: 38,
    longitude: 126,
    nx: 43,
    ny: 136,
  },
  { name: 'Seoul', latitude: 37.5665, longitude: 126.978, nx: 60, ny: 127 },
  { name: 'Busan', latitude: 35.1796, longitude: 129.0756, nx: 98, ny: 76 },
  { name: 'Jeju', latitude: 33.4996, longitude: 126.5312, nx: 53, ny: 38 },
  {
    name: 'API hub sample input',
    latitude: 36.5,
    longitude: 127.5,
    nx: 69,
    ny: 104,
  },
  { name: 'Incheon', latitude: 37.4563, longitude: 126.7052, nx: 55, ny: 124 },
  { name: 'Daejeon', latitude: 36.3504, longitude: 127.3845, nx: 67, ny: 100 },
  { name: 'Gwangju', latitude: 35.1595, longitude: 126.8526, nx: 58, ny: 74 },
] as const;

/**
 * The four grid corners. The official KMA grid-area PDF supports these corner locations at
 * approximately four decimal places. The six-decimal values below are independently calculated
 * inverse-DFS fixtures using the official projection constants, not direct API response
 * artifacts; their extreme components are compared with the published KMA coverage endpoints
 * where applicable: (149,1) latitude = 31.651814; (1,253) latitude = 43.393490 and longitude =
 * 123.310165; (149,253) longitude = 132.774963.
 */
const BOUNDARY_FIXTURES = [
  {
    name: 'grid SW corner',
    latitude: 31.794423,
    longitude: 123.761264,
    nx: 1,
    ny: 1,
  },
  {
    name: 'grid SE corner',
    latitude: 31.651814,
    longitude: 131.642258,
    nx: 149,
    ny: 1,
  },
  {
    name: 'grid NW corner',
    latitude: 43.39349,
    longitude: 123.310165,
    nx: 1,
    ny: 253,
  },
  {
    name: 'grid NE corner',
    latitude: 43.217546,
    longitude: 132.774963,
    nx: 149,
    ny: 253,
  },
] as const;

const ALL_ON_GRID_FIXTURES = [...SUCCESS_FIXTURES, ...BOUNDARY_FIXTURES] as const;

describe('convertKmaLatitudeLongitudeToGrid — origin projection invariant', () => {
  it('maps the official origin latitude/longitude to the origin grid cell', () => {
    expect(
      convertKmaLatitudeLongitudeToGrid({ latitude: 38, longitude: 126 }),
    ).toEqual({ nx: 43, ny: 136 });
  });
});

describe('convertKmaLatitudeLongitudeToGrid — representative Korean locations', () => {
  it.each(SUCCESS_FIXTURES)(
    '$name ($latitude, $longitude) -> ($nx, $ny)',
    ({ latitude, longitude, nx, ny }) => {
      expect(
        convertKmaLatitudeLongitudeToGrid({ latitude, longitude }),
      ).toEqual({ nx, ny });
    },
  );
});

describe('convertKmaLatitudeLongitudeToGrid — four grid boundaries', () => {
  it.each(BOUNDARY_FIXTURES)(
    '$name ($latitude, $longitude) -> ($nx, $ny)',
    ({ latitude, longitude, nx, ny }) => {
      expect(
        convertKmaLatitudeLongitudeToGrid({ latitude, longitude }),
      ).toEqual({ nx, ny });
    },
  );

  it('reaches each of the four extreme grid cells exactly once', () => {
    const corners = BOUNDARY_FIXTURES.map(({ latitude, longitude }) =>
      convertKmaLatitudeLongitudeToGrid({ latitude, longitude }),
    );
    expect(corners).toEqual([
      { nx: 1, ny: 1 },
      { nx: 149, ny: 1 },
      { nx: 1, ny: 253 },
      { nx: 149, ny: 253 },
    ]);
  });
});

describe('convertKmaLatitudeLongitudeToGrid — outside KMA coverage returns null', () => {
  it.each([
    { name: 'Tokyo', latitude: 35.6762, longitude: 139.6503 },
    { name: 'London', latitude: 51.5074, longitude: -0.1278 },
    { name: 'New York', latitude: 40.7128, longitude: -74.006 },
    { name: 'Sydney', latitude: -33.8688, longitude: 151.2093 },
    { name: 'latitude below KMA range but physically valid', latitude: 20, longitude: 127 },
    { name: 'latitude above KMA range but physically valid', latitude: 45, longitude: 127 },
    { name: 'longitude below KMA range but physically valid', latitude: 37, longitude: 100 },
    { name: 'longitude above KMA range but physically valid', latitude: 37, longitude: 140 },
  ])('$name -> null (no throw)', ({ latitude, longitude }) => {
    expect(
      convertKmaLatitudeLongitudeToGrid({ latitude, longitude }),
    ).toBeNull();
  });
});

describe('convertKmaLatitudeLongitudeToGrid — inside coverage box but projected off-grid', () => {
  it('returns null (never clamps) for the coverage-box corner that projects off-grid', () => {
    // Both components sit at official coverage endpoints (min latitude, min longitude), so the
    // fast coverage box accepts them; the projection lands outside [1,149] x [1,253].
    const result = convertKmaLatitudeLongitudeToGrid({
      latitude: 31.651814,
      longitude: 123.310165,
    });
    expect(result).toBeNull();
    expect(result).not.toEqual({ nx: 1, ny: 1 });
  });

  it('never emits a zero, negative, or over-maximum grid cell', () => {
    // A sweep across the coverage box: every returned cell is a fresh valid on-grid coordinate,
    // and any off-grid location is null — never a clamped or out-of-range cell.
    for (let latitude = 31.7; latitude <= 43.3; latitude += 0.5) {
      for (let longitude = 123.4; longitude <= 132.7; longitude += 0.5) {
        const result = convertKmaLatitudeLongitudeToGrid({ latitude, longitude });
        if (result !== null) {
          expect(result.nx).toBeGreaterThanOrEqual(1);
          expect(result.nx).toBeLessThanOrEqual(149);
          expect(result.ny).toBeGreaterThanOrEqual(1);
          expect(result.ny).toBeLessThanOrEqual(253);
        }
      }
    }
  });
});

describe('convertKmaLatitudeLongitudeToGrid — non-finite numbers throw RangeError', () => {
  const nonFinite: readonly { name: string; value: number }[] = [
    { name: 'NaN', value: Number.NaN },
    { name: 'Infinity', value: Number.POSITIVE_INFINITY },
    { name: '-Infinity', value: Number.NEGATIVE_INFINITY },
    { name: 'runtime string cast', value: '37' as unknown as number },
    { name: 'runtime null field cast', value: null as unknown as number },
    { name: 'runtime undefined field cast', value: undefined as unknown as number },
  ];

  it.each(nonFinite)('latitude $name -> RangeError', ({ value }) => {
    expect(() =>
      convertKmaLatitudeLongitudeToGrid({ latitude: value, longitude: 126.978 }),
    ).toThrow(new RangeError('latitude must be a finite number'));
  });

  it.each(nonFinite)('longitude $name -> RangeError', ({ value }) => {
    expect(() =>
      convertKmaLatitudeLongitudeToGrid({ latitude: 37.5665, longitude: value }),
    ).toThrow(new RangeError('longitude must be a finite number'));
  });
});

describe('convertKmaLatitudeLongitudeToGrid — error messages never leak the raw value', () => {
  const SECRET_MARKER = 'SECRET_SHAPED_COORDINATE_MUST_NOT_LEAK_PR12';

  /** A non-number whose every string/number coercion yields the secret marker. */
  function secretShaped(): number {
    return {
      toString: () => SECRET_MARKER,
      valueOf: () => SECRET_MARKER,
    } as unknown as number;
  }

  function messageFor(input: ConvertKmaLatitudeLongitudeToGridInput): string {
    let thrown: unknown;
    try {
      convertKmaLatitudeLongitudeToGrid(input);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RangeError);
    return (thrown as RangeError).message;
  }

  it('does not reflect a secret-shaped latitude in the message', () => {
    const message = messageFor({ latitude: secretShaped(), longitude: 126.978 });
    expect(message).toBe('latitude must be a finite number');
    expect(message).not.toContain(SECRET_MARKER);
  });

  it('does not reflect a secret-shaped longitude in the message', () => {
    const message = messageFor({ latitude: 37.5665, longitude: secretShaped() });
    expect(message).toBe('longitude must be a finite number');
    expect(message).not.toContain(SECRET_MARKER);
  });

  it('does not reflect a raw out-of-physical-range value in the message', () => {
    const message = messageFor({ latitude: 999.123456, longitude: 126.978 });
    expect(message).toBe('latitude must be within [-90, 90]');
    expect(message).not.toContain('999');
  });
});

describe('convertKmaLatitudeLongitudeToGrid — physical range vs KMA coverage', () => {
  it.each([
    { name: 'latitude 90', latitude: 90, longitude: 127 },
    { name: 'latitude -90', latitude: -90, longitude: 127 },
    { name: 'longitude 180', latitude: 37, longitude: 180 },
    { name: 'longitude -180', latitude: 37, longitude: -180 },
  ])('$name is physically valid but outside KMA coverage -> null', ({ latitude, longitude }) => {
    expect(
      convertKmaLatitudeLongitudeToGrid({ latitude, longitude }),
    ).toBeNull();
  });

  it.each([
    { name: 'latitude 90.000001', latitude: 90.000001, longitude: 127, message: 'latitude must be within [-90, 90]' },
    { name: 'latitude -90.000001', latitude: -90.000001, longitude: 127, message: 'latitude must be within [-90, 90]' },
    { name: 'longitude 180.000001', latitude: 37, longitude: 180.000001, message: 'longitude must be within [-180, 180]' },
    { name: 'longitude -180.000001', latitude: 37, longitude: -180.000001, message: 'longitude must be within [-180, 180]' },
  ])('$name is physically out of range -> RangeError', ({ latitude, longitude, message }) => {
    expect(() =>
      convertKmaLatitudeLongitudeToGrid({ latitude, longitude }),
    ).toThrow(new RangeError(message));
  });
});

describe('convertKmaLatitudeLongitudeToGrid — immutability and fresh result', () => {
  it('works on a frozen input and does not mutate it', () => {
    const input = Object.freeze({ latitude: 37.5665, longitude: 126.978 });
    expect(convertKmaLatitudeLongitudeToGrid(input)).toEqual({ nx: 60, ny: 127 });
    expect(input).toEqual({ latitude: 37.5665, longitude: 126.978 });
  });

  it('does not read or expose extra input properties', () => {
    const input = {
      latitude: 37.5665,
      longitude: 126.978,
      nx: 999,
      ny: 999,
      note: 'ignored',
    } as unknown as ConvertKmaLatitudeLongitudeToGridInput;
    const result = convertKmaLatitudeLongitudeToGrid(input);
    expect(result).toEqual({ nx: 60, ny: 127 });
    expect(Object.keys(result as KmaForecastGridCoordinate).sort()).toEqual([
      'nx',
      'ny',
    ]);
  });

  it('returns a deep-equal but distinct object on repeated calls', () => {
    const input = { latitude: 35.1796, longitude: 129.0756 };
    const first = convertKmaLatitudeLongitudeToGrid(input);
    const second = convertKmaLatitudeLongitudeToGrid(input);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it('mutating one result never affects a later call', () => {
    const input = { latitude: 37.5665, longitude: 126.978 };
    const first = convertKmaLatitudeLongitudeToGrid(input) as { nx: number; ny: number };
    first.nx = -1;
    first.ny = -1;
    expect(convertKmaLatitudeLongitudeToGrid(input)).toEqual({ nx: 60, ny: 127 });
  });

  it('does not carry state across calls for different locations', () => {
    const seoul = { latitude: 37.5665, longitude: 126.978 };
    const busan = { latitude: 35.1796, longitude: 129.0756 };
    const seoulFirst = convertKmaLatitudeLongitudeToGrid(seoul);
    const busanResult = convertKmaLatitudeLongitudeToGrid(busan);
    const seoulAgain = convertKmaLatitudeLongitudeToGrid(seoul);
    expect(seoulFirst).toEqual({ nx: 60, ny: 127 });
    expect(busanResult).toEqual({ nx: 98, ny: 76 });
    expect(seoulAgain).toEqual({ nx: 60, ny: 127 });
  });
});

describe('convertKmaLatitudeLongitudeToGrid — output invariant on every on-grid fixture', () => {
  it.each(ALL_ON_GRID_FIXTURES)(
    '$name has integer nx/ny within the official grid and no extra keys',
    ({ latitude, longitude }) => {
      const result = convertKmaLatitudeLongitudeToGrid({ latitude, longitude });
      expect(result).not.toBeNull();
      const grid = result as KmaForecastGridCoordinate;

      expect(Number.isInteger(grid.nx)).toBe(true);
      expect(Number.isInteger(grid.ny)).toBe(true);
      expect(grid.nx).toBeGreaterThanOrEqual(1);
      expect(grid.nx).toBeLessThanOrEqual(149);
      expect(grid.ny).toBeGreaterThanOrEqual(1);
      expect(grid.ny).toBeLessThanOrEqual(253);

      expect(Object.keys(grid).sort()).toEqual(['nx', 'ny']);
      expect(grid).not.toHaveProperty('latitude');
      expect(grid).not.toHaveProperty('longitude');
      expect(grid).not.toHaveProperty('source');
    },
  );
});
