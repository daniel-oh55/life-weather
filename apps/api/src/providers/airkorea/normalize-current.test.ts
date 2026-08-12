import { describe, expect, it } from 'vitest';

import { normalizeAirKoreaCurrentAirQuality } from './normalize-current.js';
import type { AirKoreaCurrentAirQualityProviderSuccess } from './provider.js';

const BASE: AirKoreaCurrentAirQualityProviderSuccess = {
  stationName: '종로구',
  dataTime: '2020-11-25 13:00',
  pm10Value: '73',
  pm25Value: '44',
  o3Value: '0.043',
  khaiValue: '75',
  khaiGrade: '2',
  pm10Grade: '2',
  pm25Grade: '3',
  o3Grade: '1',
};

describe('normalizeAirKoreaCurrentAirQuality — measuredAt (KST)', () => {
  it('builds the exact KST ISO measuredAt with a +09:00 offset (never UTC)', () => {
    const result = normalizeAirKoreaCurrentAirQuality(BASE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.current.measuredAt).toBe('2020-11-25T13:00:00+09:00');
    }
  });

  it('the KST timestamp is 9 hours ahead of its UTC equivalent (rejects a UTC-treated mutant)', () => {
    const result = normalizeAirKoreaCurrentAirQuality(BASE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const asDate = new Date(result.current.measuredAt);
      expect(asDate.toISOString()).toBe('2020-11-25T04:00:00.000Z');
    }
  });

  it('handles a leap-day dataTime', () => {
    const result = normalizeAirKoreaCurrentAirQuality({ ...BASE, dataTime: '2024-02-29 09:30' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.current.measuredAt).toBe('2024-02-29T09:30:00+09:00');
    }
  });

  it('fails normalization for a malformed dataTime', () => {
    const result = normalizeAirKoreaCurrentAirQuality({ ...BASE, dataTime: 'not-a-date' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([{ field: 'measuredAt', reason: 'INVALID' }]);
    }
  });

  it('fails normalization for a non-leap-year Feb 29', () => {
    const result = normalizeAirKoreaCurrentAirQuality({ ...BASE, dataTime: '2025-02-29 09:30' });
    expect(result.ok).toBe(false);
  });
});

describe('normalizeAirKoreaCurrentAirQuality — PM10/PM2.5/O3/CAI values', () => {
  it('parses PM10 and PM2.5 into their own distinct fields (rejects a swapped mutant)', () => {
    const result = normalizeAirKoreaCurrentAirQuality({ ...BASE, pm10Value: '73', pm25Value: '44' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.current.pm10MicrogramsPerCubicMeter).toBe(73);
      expect(result.current.pm25MicrogramsPerCubicMeter).toBe(44);
    }
  });

  it('parses a decimal ozone value in ppm', () => {
    const result = normalizeAirKoreaCurrentAirQuality({ ...BASE, o3Value: '0.043' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.current.ozonePartsPerMillion).toBeCloseTo(0.043, 10);
    }
  });

  it('parses the CAI (khaiValue) into comprehensiveAirQualityIndex', () => {
    const result = normalizeAirKoreaCurrentAirQuality({ ...BASE, khaiValue: '75' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.current.comprehensiveAirQualityIndex).toBe(75);
    }
  });

  it('maps the "-" missing sentinel to null, never to zero (rejects a sentinel-to-zero mutant)', () => {
    const result = normalizeAirKoreaCurrentAirQuality({
      ...BASE,
      pm10Value: '-',
      pm25Value: '-',
      o3Value: '-',
      khaiValue: '-',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.current.pm10MicrogramsPerCubicMeter).toBeNull();
      expect(result.current.pm25MicrogramsPerCubicMeter).toBeNull();
      expect(result.current.ozonePartsPerMillion).toBeNull();
      expect(result.current.comprehensiveAirQualityIndex).toBeNull();
      // Explicitly not zero: a mutant collapsing the sentinel to 0 would fail this assertion.
      expect(result.current.pm10MicrogramsPerCubicMeter).not.toBe(0);
    }
  });

  it('treats an absent pm25Value the same as the sentinel (documented optional field)', () => {
    const { pm25Value, ...rest } = BASE;
    const result = normalizeAirKoreaCurrentAirQuality(rest as AirKoreaCurrentAirQualityProviderSuccess);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.current.pm25MicrogramsPerCubicMeter).toBeNull();
    }
  });

  it.each([
    ['malformed text', 'abc'],
    ['negative-looking text', '-5'],
    ['NaN literal text', 'NaN'],
    ['Infinity literal text', 'Infinity'],
    ['a trailing unit suffix', '73ug'],
    ['scientific notation', '1e5'],
  ])('fails normalization for %s in a measurement field', (_label, malformed) => {
    const result = normalizeAirKoreaCurrentAirQuality({ ...BASE, pm10Value: malformed });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.field === 'pm10')).toBe(true);
    }
  });

  it('accepts a zero-valued measurement as a real (not missing) value', () => {
    const result = normalizeAirKoreaCurrentAirQuality({ ...BASE, pm10Value: '0' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.current.pm10MicrogramsPerCubicMeter).toBe(0);
    }
  });
});

describe('normalizeAirKoreaCurrentAirQuality — grades', () => {
  it.each([
    ['1', 'GOOD'],
    ['2', 'MODERATE'],
    ['3', 'BAD'],
    ['4', 'VERY_BAD'],
  ] as const)('pins documented grade code %s to %s', (code, expected) => {
    const result = normalizeAirKoreaCurrentAirQuality({
      ...BASE,
      khaiGrade: code,
      pm10Grade: code,
      pm25Grade: code,
      o3Grade: code,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.current.overallGrade).toBe(expected);
      expect(result.current.pm10Grade).toBe(expected);
      expect(result.current.pm25Grade).toBe(expected);
      expect(result.current.ozoneGrade).toBe(expected);
    }
  });

  it('maps an empty-string missing grade to null', () => {
    const result = normalizeAirKoreaCurrentAirQuality({ ...BASE, khaiGrade: '' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.current.overallGrade).toBeNull();
    }
  });

  it('treats an absent pm25Grade the same as the sentinel (documented optional field)', () => {
    const { pm25Grade, ...rest } = BASE;
    const result = normalizeAirKoreaCurrentAirQuality(rest as AirKoreaCurrentAirQualityProviderSuccess);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.current.pm25Grade).toBeNull();
    }
  });

  it.each(['0', '5', '9', 'GOOD', ' 1', '1.0', '01'])(
    'fails normalization for an undocumented grade code %j (never accepted as a known grade)',
    (badCode) => {
      const result = normalizeAirKoreaCurrentAirQuality({ ...BASE, khaiGrade: badCode });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((issue) => issue.field === 'overallGrade')).toBe(true);
      }
    },
  );
});

/** Return a shallow clone of `obj` with `key` deleted — works around TS's optional-only `delete`. */
function omitKey<T extends object>(obj: T, key: string): T {
  const clone: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
  delete clone[key];
  return clone as T;
}

const REQUIRED_FIELD_TO_ISSUE = {
  pm10Value: 'pm10',
  o3Value: 'ozone',
  khaiValue: 'comprehensiveAirQualityIndex',
  khaiGrade: 'overallGrade',
  pm10Grade: 'pm10Grade',
  o3Grade: 'ozoneGrade',
} as const;

describe('normalizeAirKoreaCurrentAirQuality — required-field runtime bypass (non-vacuity)', () => {
  it.each(Object.entries(REQUIRED_FIELD_TO_ISSUE))(
    'fails with a %s issue when a caller bypasses the type system and omits the raw key',
    (rawField, expectedIssueField) => {
      // Simulate a caller bypassing TypeScript: the exported normalizer must not trust that its
      // input actually has every required key just because the type says so.
      const bypassed = omitKey(BASE, rawField) as AirKoreaCurrentAirQualityProviderSuccess;
      const result = normalizeAirKoreaCurrentAirQuality(bypassed);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues).toEqual([{ field: expectedIssueField, reason: 'INVALID' }]);
      }
    },
  );

  it('never turns a missing required field into a successful null contract value', () => {
    const bypassed = omitKey(BASE, 'khaiGrade') as AirKoreaCurrentAirQualityProviderSuccess;
    const result = normalizeAirKoreaCurrentAirQuality(bypassed);
    expect(result.ok).toBe(false);
  });

  it('does not expose the raw offending value in the issue', () => {
    const bypassed = omitKey(BASE, 'pm10Value') as AirKoreaCurrentAirQualityProviderSuccess;
    const result = normalizeAirKoreaCurrentAirQuality(bypassed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(JSON.stringify(result.issues)).not.toContain('undefined');
      expect(result.issues[0]).toEqual({ field: 'pm10', reason: 'INVALID' });
    }
  });
});

describe('normalizeAirKoreaCurrentAirQuality — required field present as sentinel', () => {
  it('normalizes a required measurement field holding its sentinel to null, not an issue', () => {
    const result = normalizeAirKoreaCurrentAirQuality({ ...BASE, khaiValue: '-' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.current.comprehensiveAirQualityIndex).toBeNull();
    }
  });

  it('normalizes a required grade field holding its sentinel to null, not an issue', () => {
    const result = normalizeAirKoreaCurrentAirQuality({ ...BASE, pm10Grade: '' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.current.pm10Grade).toBeNull();
    }
  });
});

describe('normalizeAirKoreaCurrentAirQuality — determinism, purity, secrecy', () => {
  it('does not mutate the input observation', () => {
    const observation = Object.freeze({ ...BASE });
    expect(() => normalizeAirKoreaCurrentAirQuality(observation)).not.toThrow();
    expect(observation).toEqual(BASE);
  });

  it('returns a fresh result object on every call', () => {
    const a = normalizeAirKoreaCurrentAirQuality(BASE);
    const b = normalizeAirKoreaCurrentAirQuality(BASE);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it('collects multiple issues in one deterministic pass', () => {
    const result = normalizeAirKoreaCurrentAirQuality({
      ...BASE,
      pm10Value: 'bad',
      khaiGrade: 'bad',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThanOrEqual(2);
      const fields = result.issues.map((issue) => issue.field);
      expect(fields).toContain('pm10');
      expect(fields).toContain('overallGrade');
    }
  });

  it('never leaks a station-name-shaped secret marker through any error path', () => {
    const marker = 'SECRET_STATION_MARKER';
    const result = normalizeAirKoreaCurrentAirQuality({
      ...BASE,
      stationName: marker,
      pm10Value: 'bad',
    });
    expect(JSON.stringify(result)).not.toContain(marker);
  });
});
