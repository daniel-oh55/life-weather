import { describe, expect, it } from 'vitest';

import { currentWeather } from '@life-weather/contracts';

import type {
  KmaCurrentObservationField,
  KmaCurrentObservationSlot,
} from './group-current-observation-items.js';
import { normalizeKmaCurrentObservation } from './normalize-current.js';
import type { KmaCurrentObservationProviderSuccess } from './provider.js';

/**
 * A category's raw presence in a test slot:
 * - a `string`  → a present `VALUE`,
 * - `null`      → a present but explicitly-`NULL` field,
 * - omitted key → `ABSENT` (no field at all).
 */
type FieldSpec = Record<string, string | null>;

/** Build a slot's `fields` array from a {@link FieldSpec}, sorted by category like the real grouper. */
function toFields(spec: FieldSpec): KmaCurrentObservationField[] {
  return Object.keys(spec)
    .sort()
    .map((category) => {
      const value = spec[category]!;
      return value === null
        ? { category, state: 'NULL' as const }
        : { category, state: 'VALUE' as const, value };
    });
}

/** Build one current-observation slot. `fields` defaults to a full, valid field set. */
function makeSlot(
  overrides: {
    baseDate?: string;
    baseTime?: string;
    nx?: number;
    ny?: number;
    fields?: FieldSpec;
  } = {},
): KmaCurrentObservationSlot {
  const {
    baseDate = '20260717',
    baseTime = '0600',
    nx = 60,
    ny = 127,
    fields = {
      T1H: '23.5',
      PTY: '0',
      REH: '55',
      WSD: '3.4',
      VEC: '270',
      RN1: '0',
    },
  } = overrides;
  return { baseDate, baseTime, nx, ny, fields: toFields(fields) };
}

/** Wrap a slot into a provider success (or `null` for the defensive empty-page case). */
function makeObservation(
  slot: KmaCurrentObservationSlot | null,
  overrides: Partial<Omit<KmaCurrentObservationProviderSuccess, 'slot'>> = {},
): KmaCurrentObservationProviderSuccess {
  return {
    baseDate: overrides.baseDate ?? slot?.baseDate ?? '20260717',
    baseTime: overrides.baseTime ?? slot?.baseTime ?? '0600',
    nx: overrides.nx ?? slot?.nx ?? 60,
    ny: overrides.ny ?? slot?.ny ?? 127,
    totalCount: overrides.totalCount ?? (slot === null ? 0 : 1),
    slot,
  };
}

describe('normalizeKmaCurrentObservation — full observation', () => {
  const result = normalizeKmaCurrentObservation(makeObservation(makeSlot()));

  it('succeeds', () => {
    expect(result.ok).toBe(true);
  });

  it('builds the KST observedAt from baseDate/baseTime', () => {
    if (result.ok) {
      expect(result.current.observedAt).toBe('2026-07-17T06:00:00+09:00');
    } else {
      expect.fail('expected ok');
    }
  });

  it('parses every field', () => {
    if (result.ok) {
      expect(result.current.temperatureCelsius).toBe(23.5);
      expect(result.current.humidityPercent).toBe(55);
      expect(result.current.windSpeedMetersPerSecond).toBe(3.4);
      expect(result.current.windDirectionDegrees).toBe(270);
      expect(result.current.precipitationLastHourMillimeters).toBe(0);
    } else {
      expect.fail('expected ok');
    }
  });

  it('always sets feelsLikeCelsius and visibilityMeters to null', () => {
    if (result.ok) {
      expect(result.current.feelsLikeCelsius).toBeNull();
      expect(result.current.visibilityMeters).toBeNull();
    } else {
      expect.fail('expected ok');
    }
  });

  it('validates against the shared currentWeather contract', () => {
    if (result.ok) {
      expect(currentWeather.safeParse(result.current).success).toBe(true);
    } else {
      expect.fail('expected ok');
    }
  });
});

describe('normalizeKmaCurrentObservation — minimum required T1H only', () => {
  it('succeeds with only T1H present, all optional fields null', () => {
    const result = normalizeKmaCurrentObservation(
      makeObservation(makeSlot({ fields: { T1H: '10' } })),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.current.temperatureCelsius).toBe(10);
      expect(result.current.condition).toBe('UNKNOWN');
      expect(result.current.humidityPercent).toBeNull();
      expect(result.current.windSpeedMetersPerSecond).toBeNull();
      expect(result.current.windDirectionDegrees).toBeNull();
      expect(result.current.precipitationLastHourMillimeters).toBeNull();
    }
  });
});

describe('normalizeKmaCurrentObservation — negative and zero temperature', () => {
  it('preserves a negative temperature', () => {
    const result = normalizeKmaCurrentObservation(
      makeObservation(makeSlot({ fields: { T1H: '-12.3' } })),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.current.temperatureCelsius).toBe(-12.3);
    }
  });

  it('preserves a zero temperature', () => {
    const result = normalizeKmaCurrentObservation(
      makeObservation(makeSlot({ fields: { T1H: '0' } })),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.current.temperatureCelsius).toBe(0);
    }
  });
});

describe('normalizeKmaCurrentObservation — humidity/wind/direction/RN1 zero', () => {
  it('preserves a confirmed zero for every optional numeric field', () => {
    const result = normalizeKmaCurrentObservation(
      makeObservation(
        makeSlot({
          fields: { T1H: '15', REH: '0', WSD: '0', VEC: '0', RN1: '0' },
        }),
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.current.humidityPercent).toBe(0);
      expect(result.current.windSpeedMetersPerSecond).toBe(0);
      expect(result.current.windDirectionDegrees).toBe(0);
      expect(result.current.precipitationLastHourMillimeters).toBe(0);
    }
  });
});

describe('normalizeKmaCurrentObservation — optional absent/invalid → null', () => {
  it('maps ABSENT optional categories to null', () => {
    const result = normalizeKmaCurrentObservation(
      makeObservation(makeSlot({ fields: { T1H: '15' } })),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.current.humidityPercent).toBeNull();
      expect(result.current.windSpeedMetersPerSecond).toBeNull();
      expect(result.current.windDirectionDegrees).toBeNull();
      expect(result.current.precipitationLastHourMillimeters).toBeNull();
    }
  });

  it('maps explicit-NULL optional categories to null', () => {
    const result = normalizeKmaCurrentObservation(
      makeObservation(
        makeSlot({ fields: { T1H: '15', REH: null, WSD: null, VEC: null, RN1: null } }),
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.current.humidityPercent).toBeNull();
      expect(result.current.windSpeedMetersPerSecond).toBeNull();
      expect(result.current.windDirectionDegrees).toBeNull();
      expect(result.current.precipitationLastHourMillimeters).toBeNull();
    }
  });

  it('maps an unparseable optional value to null rather than failing', () => {
    const result = normalizeKmaCurrentObservation(
      makeObservation(makeSlot({ fields: { T1H: '15', REH: 'not-a-number' } })),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.current.humidityPercent).toBeNull();
    }
  });

  it('maps an out-of-range optional percentage to null', () => {
    const result = normalizeKmaCurrentObservation(
      makeObservation(makeSlot({ fields: { T1H: '15', REH: '150' } })),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.current.humidityPercent).toBeNull();
    }
  });

  it('maps a negative precipitation amount to null', () => {
    const result = normalizeKmaCurrentObservation(
      makeObservation(makeSlot({ fields: { T1H: '15', RN1: '-1' } })),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.current.precipitationLastHourMillimeters).toBeNull();
    }
  });
});

describe('normalizeKmaCurrentObservation — T1H absent/null/invalid → failure', () => {
  it('fails when T1H is absent', () => {
    const result = normalizeKmaCurrentObservation(
      makeObservation(makeSlot({ fields: { REH: '55' } })),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({
        field: 'temperatureCelsius',
        reason: 'ABSENT',
      });
    }
  });

  it('fails when T1H is explicitly null', () => {
    const result = normalizeKmaCurrentObservation(
      makeObservation(makeSlot({ fields: { T1H: null } })),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({ field: 'temperatureCelsius', reason: 'NULL' });
    }
  });

  it('fails when T1H is unparseable', () => {
    const result = normalizeKmaCurrentObservation(
      makeObservation(makeSlot({ fields: { T1H: 'not-a-number' } })),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({ field: 'temperatureCelsius', reason: 'INVALID' });
    }
  });

  it('fails when the slot is null (empty success page)', () => {
    const result = normalizeKmaCurrentObservation(makeObservation(null));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({ field: 'temperatureCelsius', reason: 'ABSENT' });
    }
  });
});

describe('normalizeKmaCurrentObservation — invalid observedAt → failure', () => {
  it('fails on a malformed baseDate', () => {
    const result = normalizeKmaCurrentObservation(
      makeObservation(makeSlot({ baseDate: '2026-07-17' })),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({ field: 'observedAt', reason: 'INVALID' });
    }
  });

  it('fails on a malformed baseTime', () => {
    const result = normalizeKmaCurrentObservation(
      makeObservation(makeSlot({ baseTime: '2400' })),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({ field: 'observedAt', reason: 'INVALID' });
    }
  });

  it.each(['0030', '0530', '2359'])(
    'fails on a structurally valid but non-hour baseTime %s (defensive: raw schema normally already rejects this)',
    (baseTime) => {
      const result = normalizeKmaCurrentObservation(makeObservation(makeSlot({ baseTime })));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues).toContainEqual({ field: 'observedAt', reason: 'INVALID' });
      }
    },
  );

  it.each([
    ['0000', '2026-07-17T00:00:00+09:00'],
    ['2300', '2026-07-17T23:00:00+09:00'],
  ])('builds a valid KST observedAt for the on-the-hour boundary baseTime %s', (baseTime, expected) => {
    const result = normalizeKmaCurrentObservation(makeObservation(makeSlot({ baseTime })));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.current.observedAt).toBe(expected);
    }
  });
});

describe('normalizeKmaCurrentObservation — PTY precipitation mappings', () => {
  it.each([
    ['1', 'RAIN'],
    ['5', 'RAIN'],
    ['2', 'SLEET'],
    ['6', 'SLEET'],
    ['3', 'SNOW'],
    ['7', 'SNOW'],
  ])('PTY %s → %s', (pty, expected) => {
    const result = normalizeKmaCurrentObservation(
      makeObservation(makeSlot({ fields: { T1H: '15', PTY: pty } })),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.current.condition).toBe(expected);
    }
  });
});

describe('normalizeKmaCurrentObservation — PTY 0/absent/unknown → UNKNOWN', () => {
  it('PTY 0 does not guess a sky state', () => {
    const result = normalizeKmaCurrentObservation(
      makeObservation(makeSlot({ fields: { T1H: '15', PTY: '0' } })),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.current.condition).toBe('UNKNOWN');
    }
  });

  it('absent PTY → UNKNOWN', () => {
    const result = normalizeKmaCurrentObservation(
      makeObservation(makeSlot({ fields: { T1H: '15' } })),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.current.condition).toBe('UNKNOWN');
    }
  });

  it('unknown PTY code → UNKNOWN', () => {
    const result = normalizeKmaCurrentObservation(
      makeObservation(makeSlot({ fields: { T1H: '15', PTY: '9' } })),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.current.condition).toBe('UNKNOWN');
    }
  });
});

describe('normalizeKmaCurrentObservation — contract validation', () => {
  it('the returned CurrentWeather is exactly the schema-parsed candidate (no raw KMA leakage)', () => {
    const result = normalizeKmaCurrentObservation(makeObservation(makeSlot()));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const parsed = currentWeather.safeParse(result.current);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(result.current).toEqual(parsed.data);
      }
      // No provider-internal fields (raw obsrValue, category, slot identity) leak onto the
      // returned object — only the fixed CurrentWeather contract keys are present.
      expect(Object.keys(result.current).sort()).toEqual(
        [
          'condition',
          'feelsLikeCelsius',
          'humidityPercent',
          'observedAt',
          'precipitationLastHourMillimeters',
          'temperatureCelsius',
          'visibilityMeters',
          'windDirectionDegrees',
          'windSpeedMetersPerSecond',
        ].sort(),
      );
    }
  });
});

describe('normalizeKmaCurrentObservation — deterministic issue ordering', () => {
  it('sorts multiple issues by field then reason', () => {
    const result = normalizeKmaCurrentObservation(
      makeObservation(makeSlot({ baseTime: '2400', fields: { T1H: null } })),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        { field: 'observedAt', reason: 'INVALID' },
        { field: 'temperatureCelsius', reason: 'NULL' },
      ]);
    }
  });

  it('produces the same issues for the same input across repeated calls', () => {
    const observation = makeObservation(makeSlot({ fields: { T1H: null } }));
    const first = normalizeKmaCurrentObservation(observation);
    const second = normalizeKmaCurrentObservation(observation);
    expect(first).toEqual(second);
  });
});

describe('normalizeKmaCurrentObservation — input immutability', () => {
  it('does not mutate the observation or its slot', () => {
    const observation = makeObservation(makeSlot());
    const snapshot = structuredClone(observation);
    normalizeKmaCurrentObservation(observation);
    expect(observation).toEqual(snapshot);
  });
});
