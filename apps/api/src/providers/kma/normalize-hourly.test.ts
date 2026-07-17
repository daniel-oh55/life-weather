import { describe, expect, it } from 'vitest';

import { hourlyForecast } from '@life-weather/contracts';
import { KmaForecastProduct } from '@life-weather/weather-core';

import type {
  KmaForecastField,
  KmaForecastSlot,
} from './group-forecast-items';
import { normalizeKmaHourlyForecast } from './normalize-hourly';
import type { KmaForecastProviderSuccess } from './provider';

const SHORT = KmaForecastProduct.SHORT_FORECAST;
const ULTRA = KmaForecastProduct.ULTRA_SHORT_FORECAST;

/**
 * A category's raw presence in a test slot:
 * - a `string`  → a present `VALUE`,
 * - `null`      → a present but explicitly-`NULL` field,
 * - omitted key → `ABSENT` (no field at all).
 */
type FieldSpec = Record<string, string | null>;

/** Build a slot's `fields` array from a {@link FieldSpec}, sorted by category like the real grouper. */
function toFields(spec: FieldSpec): KmaForecastField[] {
  return Object.keys(spec)
    .sort()
    .map((category) => {
      const value = spec[category];
      return value === null
        ? { category, state: 'NULL' as const }
        : { category, state: 'VALUE' as const, value };
    });
}

/** Build one forecast slot. `fields` defaults to a full, valid 단기예보 field set. */
function makeSlot(overrides: {
  product?: KmaForecastProduct;
  baseDate?: string;
  baseTime?: string;
  forecastDate?: string;
  forecastTime?: string;
  nx?: number;
  ny?: number;
  fields?: FieldSpec;
} = {}): KmaForecastSlot {
  const {
    product = SHORT,
    baseDate = '20260717',
    baseTime = '0500',
    forecastDate = '20260717',
    forecastTime = '1400',
    nx = 60,
    ny = 127,
    fields = {
      TMP: '25',
      SKY: '1',
      PTY: '0',
      POP: '20',
      PCP: '강수없음',
      SNO: '적설없음',
      REH: '55',
      WSD: '3.4',
      VEC: '270',
    },
  } = overrides;
  return {
    product,
    baseDate,
    baseTime,
    forecastDate,
    forecastTime,
    nx,
    ny,
    fields: toFields(fields),
  };
}

/** Wrap slots into a provider success. */
function makeForecast(
  slots: readonly KmaForecastSlot[],
  overrides: Partial<Omit<KmaForecastProviderSuccess, 'slots'>> = {},
): KmaForecastProviderSuccess {
  const first = slots[0];
  return {
    product: overrides.product ?? first?.product ?? SHORT,
    baseDate: overrides.baseDate ?? first?.baseDate ?? '20260717',
    baseTime: overrides.baseTime ?? first?.baseTime ?? '0500',
    nx: overrides.nx ?? first?.nx ?? 60,
    ny: overrides.ny ?? first?.ny ?? 127,
    totalCount: overrides.totalCount ?? slots.length,
    slots,
  };
}

describe('normalizeKmaHourlyForecast — short forecast (단기예보) full slot', () => {
  const result = normalizeKmaHourlyForecast(
    makeForecast([
      makeSlot({
        fields: {
          TMP: '25.5',
          SKY: '1',
          PTY: '0',
          POP: '20',
          PCP: '1.0mm',
          SNO: '적설없음',
          REH: '55',
          WSD: '3.4',
          VEC: '270',
        },
      }),
    ]),
  );

  it('normalizes every field from the correct category', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const [entry] = result.hourly;
    expect(entry.forecastAt).toBe('2026-07-17T14:00:00+09:00');
    expect(entry.condition).toBe('CLEAR');
    expect(entry.temperatureCelsius).toBe(25.5);
    expect(entry.precipitationProbabilityPercent).toBe(20);
    expect(entry.precipitationAmountMillimeters).toBe(1);
    expect(entry.snowfallAmountCentimeters).toBe(0);
    expect(entry.humidityPercent).toBe(55);
    expect(entry.windSpeedMetersPerSecond).toBe(3.4);
    expect(entry.windDirectionDegrees).toBe(270);
    expect(entry.feelsLikeCelsius).toBeNull();
  });

  it('produces output that passes the contracts hourlyForecast schema', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    for (const entry of result.hourly) {
      expect(hourlyForecast.safeParse(entry).success).toBe(true);
    }
  });
});

describe('normalizeKmaHourlyForecast — ultra-short forecast (초단기예보) full slot', () => {
  it('uses T1H for temperature, RN1 for precipitation, and has no snowfall', () => {
    const result = normalizeKmaHourlyForecast(
      makeForecast([
        makeSlot({
          product: ULTRA,
          fields: {
            T1H: '18.2',
            SKY: '4',
            PTY: '1',
            POP: '60',
            RN1: '30.0~50.0mm',
            REH: '80',
            WSD: '2.1',
            VEC: '90',
          },
        }),
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const [entry] = result.hourly;
    expect(entry.temperatureCelsius).toBe(18.2);
    expect(entry.condition).toBe('RAIN'); // PTY 1 wins over SKY
    // 초단기예보 POP is officially provided since 2026-06-23 12 KST: a present POP VALUE is parsed
    // like any other product, with no date-based branching (absence stays nullable — see below).
    expect(entry.precipitationProbabilityPercent).toBe(60);
    expect(entry.precipitationAmountMillimeters).toBe(30); // RN1 lower bound, same grammar as PCP
    expect(entry.snowfallAmountCentimeters).toBeNull(); // no 신적설 in 초단기예보
    expect(entry.humidityPercent).toBe(80);
    expect(entry.windSpeedMetersPerSecond).toBe(2.1);
    expect(entry.windDirectionDegrees).toBe(90);
    expect(entry.feelsLikeCelsius).toBeNull();
    expect(hourlyForecast.safeParse(entry).success).toBe(true);
  });

  it('treats an ABSENT ultra-short POP as null for pre-rollout, partial, or defensively incomplete responses', () => {
    const result = normalizeKmaHourlyForecast(
      makeForecast([
        makeSlot({
          product: ULTRA,
          fields: { T1H: '18', SKY: '1', PTY: '0', REH: '70', WSD: '1.0', VEC: '10' },
        }),
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.hourly[0].precipitationProbabilityPercent).toBeNull();
  });

  it('even a SNO present in an ultra-short slot is ignored (no 신적설 mapping)', () => {
    const result = normalizeKmaHourlyForecast(
      makeForecast([
        makeSlot({
          product: ULTRA,
          fields: { T1H: '18', SKY: '1', PTY: '0', SNO: '3.5cm', RN1: '강수없음' },
        }),
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.hourly[0].snowfallAmountCentimeters).toBeNull();
  });
});

describe('normalizeKmaHourlyForecast — condition (SKY + PTY)', () => {
  function conditionOf(
    fields: FieldSpec,
    product: KmaForecastProduct = SHORT,
  ): string | null {
    const result = normalizeKmaHourlyForecast(
      makeForecast([makeSlot({ product, fields: { TMP: '10', T1H: '10', ...fields } })]),
    );
    return result.ok ? result.hourly[0].condition : null;
  }

  it('lets a precipitation PTY win over SKY', () => {
    expect(conditionOf({ SKY: '1', PTY: '1' })).toBe('RAIN');
    expect(conditionOf({ SKY: '1', PTY: '3' })).toBe('SNOW');
  });

  it('uses SKY when PTY is explicitly 0 (없음)', () => {
    expect(conditionOf({ SKY: '1', PTY: '0' })).toBe('CLEAR');
    expect(conditionOf({ SKY: '3', PTY: '0' })).toBe('PARTLY_CLOUDY');
    expect(conditionOf({ SKY: '4', PTY: '0' })).toBe('CLOUDY');
  });

  it('is UNKNOWN when PTY is ABSENT even with a valid SKY', () => {
    expect(conditionOf({ SKY: '1' })).toBe('UNKNOWN');
  });

  it('is UNKNOWN when PTY is NULL even with a valid SKY', () => {
    expect(conditionOf({ SKY: '1', PTY: null })).toBe('UNKNOWN');
  });

  it('is UNKNOWN for an unknown PTY code', () => {
    expect(conditionOf({ SKY: '1', PTY: '9' })).toBe('UNKNOWN');
  });

  it('keeps the product-specific PTY difference (5/6/7 only valid for 초단기예보)', () => {
    expect(conditionOf({ SKY: '1', PTY: '5' }, SHORT)).toBe('UNKNOWN'); // undefined in 단기
    expect(conditionOf({ SKY: '1', PTY: '5' }, ULTRA)).toBe('RAIN'); // 빗방울 in 초단기
  });

  it('still assembles an HourlyForecast when the condition is UNKNOWN', () => {
    const result = normalizeKmaHourlyForecast(
      makeForecast([makeSlot({ fields: { TMP: '10', SKY: '1' } })]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hourly[0].condition).toBe('UNKNOWN');
    }
  });
});

describe('normalizeKmaHourlyForecast — nullable field presence', () => {
  const nullableCases: Array<{
    field: keyof ReturnType<typeof pickHourly>;
    category: string;
    valid: string;
    expected: number;
    invalid: string;
  }> = [
    { field: 'precipitationProbabilityPercent', category: 'POP', valid: '40', expected: 40, invalid: '150' },
    { field: 'precipitationAmountMillimeters', category: 'PCP', valid: '6.2mm', expected: 6.2, invalid: '조금' },
    { field: 'snowfallAmountCentimeters', category: 'SNO', valid: '3.5cm', expected: 3.5, invalid: '1.0~4.9cm' },
    { field: 'humidityPercent', category: 'REH', valid: '77', expected: 77, invalid: '-5' },
    { field: 'windSpeedMetersPerSecond', category: 'WSD', valid: '5.5', expected: 5.5, invalid: '-1' },
    { field: 'windDirectionDegrees', category: 'VEC', valid: '180', expected: 180, invalid: '400' },
  ];

  function pickHourly() {
    return {
      precipitationProbabilityPercent: 0,
      precipitationAmountMillimeters: 0,
      snowfallAmountCentimeters: 0,
      humidityPercent: 0,
      windSpeedMetersPerSecond: 0,
      windDirectionDegrees: 0,
    };
  }

  function fieldValue(category: string, spec: string | null | undefined) {
    const base: FieldSpec = { TMP: '10', SKY: '1', PTY: '0' };
    if (spec !== undefined) {
      base[category] = spec;
    }
    const result = normalizeKmaHourlyForecast(makeForecast([makeSlot({ fields: base })]));
    return result;
  }

  for (const testCase of nullableCases) {
    describe(`${testCase.field} (${testCase.category})`, () => {
      it('is null when ABSENT', () => {
        const result = fieldValue(testCase.category, undefined);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.hourly[0][testCase.field]).toBeNull();
        }
      });

      it('is null when NULL', () => {
        const result = fieldValue(testCase.category, null);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.hourly[0][testCase.field]).toBeNull();
        }
      });

      it('is the parsed number for a valid VALUE', () => {
        const result = fieldValue(testCase.category, testCase.valid);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.hourly[0][testCase.field]).toBe(testCase.expected);
        }
      });

      it('is null for an invalid VALUE (never the raw string)', () => {
        const result = fieldValue(testCase.category, testCase.invalid);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.hourly[0][testCase.field]).toBeNull();
        }
      });
    });
  }
});

describe('normalizeKmaHourlyForecast — required temperature', () => {
  function tempResult(spec: string | null | undefined, product: KmaForecastProduct = SHORT) {
    const category = product === SHORT ? 'TMP' : 'T1H';
    const fields: FieldSpec = { SKY: '1', PTY: '0' };
    if (spec !== undefined) {
      fields[category] = spec;
    }
    return normalizeKmaHourlyForecast(makeForecast([makeSlot({ product, fields })]));
  }

  it('is an ABSENT error when the temperature category is missing', () => {
    const result = tempResult(undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].field).toBe('temperatureCelsius');
      expect(result.issues[0].reason).toBe('ABSENT');
    }
  });

  it('is a NULL error when the temperature is explicitly null', () => {
    const result = tempResult(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].reason).toBe('NULL');
    }
  });

  it('is an INVALID error when the temperature cannot be parsed', () => {
    const result = tempResult('warm');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].reason).toBe('INVALID');
    }
  });

  it('is an INVALID error for a Missing-sentinel temperature', () => {
    const result = tempResult('-900');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].reason).toBe('INVALID');
    }
  });

  it('accepts a valid negative temperature', () => {
    const result = tempResult('-3.5');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hourly[0].temperatureCelsius).toBe(-3.5);
    }
  });

  it('uses T1H (not TMP) for the ultra-short product', () => {
    const result = tempResult('12', ULTRA);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hourly[0].temperatureCelsius).toBe(12);
    }
  });
});

describe('normalizeKmaHourlyForecast — amount categories', () => {
  function amounts(fields: FieldSpec, product: KmaForecastProduct = SHORT) {
    const result = normalizeKmaHourlyForecast(
      makeForecast([makeSlot({ product, fields: { TMP: '10', T1H: '10', SKY: '1', PTY: '0', ...fields } })]),
    );
    return result.ok ? result.hourly[0] : null;
  }

  it('maps 강수없음 / 적설없음 to 0 (present no-amount)', () => {
    const entry = amounts({ PCP: '강수없음', SNO: '적설없음' });
    expect(entry?.precipitationAmountMillimeters).toBe(0);
    expect(entry?.snowfallAmountCentimeters).toBe(0);
  });

  it('maps a parse failure or Missing value to null', () => {
    const entry = amounts({ PCP: '조금', SNO: '900cm 이상' });
    expect(entry?.precipitationAmountMillimeters).toBeNull();
    expect(entry?.snowfallAmountCentimeters).toBeNull();
  });

  it('applies the shared 1시간 강수량 grammar to PCP (단기) and RN1 (초단기)', () => {
    expect(amounts({ PCP: '50mm 이상' }, SHORT)?.precipitationAmountMillimeters).toBe(50);
    expect(amounts({ RN1: '50mm 이상' }, ULTRA)?.precipitationAmountMillimeters).toBe(50);
  });
});

describe('normalizeKmaHourlyForecast — KST forecastAt timestamp', () => {
  function forecastAt(forecastDate: string, forecastTime: string): string | null {
    const result = normalizeKmaHourlyForecast(
      makeForecast([makeSlot({ forecastDate, forecastTime })]),
    );
    return result.ok ? result.hourly[0].forecastAt : null;
  }

  it('formats midnight', () => {
    expect(forecastAt('20260717', '0000')).toBe('2026-07-17T00:00:00+09:00');
  });

  it('zero-pads single-digit months and days', () => {
    expect(forecastAt('20260105', '0900')).toBe('2026-01-05T09:00:00+09:00');
  });

  it('handles a leap day', () => {
    expect(forecastAt('20240229', '2300')).toBe('2024-02-29T23:00:00+09:00');
  });

  it('always uses the fixed +09:00 KST offset and :00 seconds', () => {
    const value = forecastAt('20260717', '1430');
    expect(value).toMatch(/\+09:00$/);
    expect(value).toMatch(/:00\+09:00$/);
  });

  it('returns a forecastAt issue for a malformed date/time (defensive)', () => {
    const slot = makeSlot();
    const malformed: KmaForecastSlot = { ...slot, forecastDate: '20260230' }; // Feb 30
    const result = normalizeKmaHourlyForecast(makeForecast([malformed]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.field === 'forecastAt' && issue.reason === 'INVALID')).toBe(true);
    }
  });

  it('is independent of the host time zone (fixed KST, no Date construction)', () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = 'America/New_York';
      expect(forecastAt('20260717', '1400')).toBe('2026-07-17T14:00:00+09:00');
      process.env.TZ = 'Asia/Kolkata';
      expect(forecastAt('20260717', '1400')).toBe('2026-07-17T14:00:00+09:00');
    } finally {
      process.env.TZ = original;
    }
  });
});

describe('normalizeKmaHourlyForecast — ordering and immutability', () => {
  it('sorts output by forecastAt ascending regardless of input order', () => {
    const slots = [
      makeSlot({ forecastTime: '1500', fields: { TMP: '3', SKY: '1', PTY: '0' } }),
      makeSlot({ forecastTime: '1300', fields: { TMP: '1', SKY: '1', PTY: '0' } }),
      makeSlot({ forecastTime: '1400', fields: { TMP: '2', SKY: '1', PTY: '0' } }),
    ];
    const result = normalizeKmaHourlyForecast(makeForecast(slots));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hourly.map((entry) => entry.forecastAt)).toEqual([
        '2026-07-17T13:00:00+09:00',
        '2026-07-17T14:00:00+09:00',
        '2026-07-17T15:00:00+09:00',
      ]);
    }
  });

  it('orders across multiple dates and times', () => {
    const slots = [
      makeSlot({ forecastDate: '20260718', forecastTime: '0000', fields: { TMP: '2', SKY: '1', PTY: '0' } }),
      makeSlot({ forecastDate: '20260717', forecastTime: '2300', fields: { TMP: '1', SKY: '1', PTY: '0' } }),
    ];
    const result = normalizeKmaHourlyForecast(makeForecast(slots));
    if (result.ok) {
      expect(result.hourly.map((entry) => entry.forecastAt)).toEqual([
        '2026-07-17T23:00:00+09:00',
        '2026-07-18T00:00:00+09:00',
      ]);
    }
  });

  it('is deterministic — repeated calls on the same input give an equal result', () => {
    const forecast = makeForecast([
      makeSlot({ forecastTime: '1500' }),
      makeSlot({ forecastTime: '1300' }),
    ]);
    const a = normalizeKmaHourlyForecast(forecast);
    const b = normalizeKmaHourlyForecast(forecast);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('does not mutate the input forecast, slots, or fields', () => {
    const slot = makeSlot();
    const forecast = makeForecast([slot]);
    const snapshot = JSON.stringify(forecast);
    normalizeKmaHourlyForecast(forecast);
    expect(JSON.stringify(forecast)).toBe(snapshot);
    // A deep-frozen input must not throw either.
    const frozen = makeForecast([makeSlot()]);
    deepFreeze(frozen);
    expect(() => normalizeKmaHourlyForecast(frozen)).not.toThrow();
  });
});

/** Recursively freeze so any mutation of the input would throw. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

describe('normalizeKmaHourlyForecast — empty input', () => {
  it('returns an empty success for an empty slots array', () => {
    const result = normalizeKmaHourlyForecast(makeForecast([]));
    expect(result).toEqual({ ok: true, hourly: [] });
  });
});

describe('normalizeKmaHourlyForecast — unknown categories', () => {
  it('ignores unknown categories and never leaks a raw category or value', () => {
    const result = normalizeKmaHourlyForecast(
      makeForecast([
        makeSlot({
          fields: { TMP: '10', SKY: '1', PTY: '0', ZZZ: 'garbage', UUU: '1.2', WAV: '0.5' },
        }),
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const serialized = JSON.stringify(result.hourly[0]);
    expect(serialized).not.toContain('garbage');
    expect(serialized).not.toContain('ZZZ');
    expect(serialized).not.toContain('WAV');
    // The assembled object carries exactly the contract's keys — no raw KMA passthrough.
    expect(Object.keys(result.hourly[0]).sort()).toEqual(
      [
        'condition',
        'feelsLikeCelsius',
        'forecastAt',
        'humidityPercent',
        'precipitationAmountMillimeters',
        'precipitationProbabilityPercent',
        'snowfallAmountCentimeters',
        'temperatureCelsius',
        'windDirectionDegrees',
        'windSpeedMetersPerSecond',
      ].sort(),
    );
  });
});

describe('normalizeKmaHourlyForecast — issue sanitization and determinism', () => {
  it('collects every slot problem and sorts issues deterministically', () => {
    const slots = [
      makeSlot({ forecastTime: '1500', fields: { SKY: '1', PTY: '0' } }), // TMP absent
      makeSlot({ forecastTime: '1300', fields: { TMP: null, SKY: '1', PTY: '0' } }), // TMP null
    ];
    const a = normalizeKmaHourlyForecast(makeForecast(slots));
    const b = normalizeKmaHourlyForecast(makeForecast([...slots].reverse()));
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    if (!a.ok && !b.ok) {
      expect(a.issues).toHaveLength(2);
      // Same input set in a different order → identical issue list.
      expect(JSON.stringify(a.issues)).toBe(JSON.stringify(b.issues));
    }
  });

  it('never leaks a raw fcstValue in an issue', () => {
    const result = normalizeKmaHourlyForecast(
      makeForecast([makeSlot({ fields: { TMP: 'SECRET_RAW_VALUE', SKY: '1', PTY: '0' } })]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const serialized = JSON.stringify(result.issues);
      expect(serialized).not.toContain('SECRET_RAW_VALUE');
      expect(result.issues[0]).toMatchObject({ field: 'temperatureCelsius', reason: 'INVALID' });
    }
  });

  it('exposes a slotKey that carries slot identity but no raw value', () => {
    const result = normalizeKmaHourlyForecast(
      makeForecast([makeSlot({ fields: { SKY: '1', PTY: '0' } })]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].slotKey).toBe(
        'SHORT_FORECAST|20260717|0500|20260717|1400|60|127',
      );
    }
  });
});
