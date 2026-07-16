import { describe, expect, it } from 'vitest';

import {
  parseKmaPrecipitationAmountMillimeters,
  parseKmaSnowfallAmountCentimeters,
} from '../index';

/**
 * A result is valid iff it is `null` or a finite number in `[0, 900)` — non-negative and below
 * the official Missing bound (`>= 900` is Missing → `null`, never a real amount).
 */
function isValidAmountOrNull(value: number | null): boolean {
  return value === null || (Number.isFinite(value) && value >= 0 && value < 900);
}

describe('parseKmaPrecipitationAmountMillimeters — recognized values', () => {
  it('returns 0 for the "강수없음" no-precipitation token', () => {
    expect(parseKmaPrecipitationAmountMillimeters('강수없음')).toBe(0);
  });

  it('returns 0 for the official "-" no-amount token (trimmed)', () => {
    expect(parseKmaPrecipitationAmountMillimeters('-')).toBe(0);
    expect(parseKmaPrecipitationAmountMillimeters(' - ')).toBe(0);
  });

  it('returns 0 for the raw zero readings', () => {
    expect(parseKmaPrecipitationAmountMillimeters('0')).toBe(0);
    expect(parseKmaPrecipitationAmountMillimeters('0.0')).toBe(0);
  });

  it('returns the exact number for a "<value>mm" reading', () => {
    expect(parseKmaPrecipitationAmountMillimeters('6.2mm')).toBe(6.2);
    expect(parseKmaPrecipitationAmountMillimeters('1.0mm')).toBe(1);
    expect(parseKmaPrecipitationAmountMillimeters('29.0mm')).toBe(29);
  });

  it('returns the exact number for a bare number with no unit', () => {
    // The guide documents raw values such as "PCP = 6.2" for the mm field.
    expect(parseKmaPrecipitationAmountMillimeters('6.2')).toBe(6.2);
    expect(parseKmaPrecipitationAmountMillimeters('30')).toBe(30);
  });

  it('returns threshold / 2 for the official minimum bucket "1mm 미만"', () => {
    // The official 2607 minimum PCP category is "1mm 미만" → 0.5 (T/2).
    expect(parseKmaPrecipitationAmountMillimeters('1mm 미만')).toBe(0.5);
    expect(parseKmaPrecipitationAmountMillimeters('1mm미만')).toBe(0.5);
  });

  it('also accepts the defensively-allowed decimal equivalent "1.0mm 미만"', () => {
    // Not the official spelling, but the same numeric bucket; the grammar tolerates it.
    expect(parseKmaPrecipitationAmountMillimeters('1.0mm 미만')).toBe(0.5);
    expect(parseKmaPrecipitationAmountMillimeters('1.0mm미만')).toBe(0.5);
  });

  it('returns the lower bound for a "<L>~<U>mm" range (PCP has an official range)', () => {
    expect(parseKmaPrecipitationAmountMillimeters('1~29mm')).toBe(1);
    expect(parseKmaPrecipitationAmountMillimeters('30~50mm')).toBe(30);
    expect(parseKmaPrecipitationAmountMillimeters('30.0~50.0mm')).toBe(30);
    expect(parseKmaPrecipitationAmountMillimeters('1.0~29.0mm')).toBe(1);
  });

  it('returns the lower bound for a "<T>mm 이상" bucket (spaced and unspaced)', () => {
    expect(parseKmaPrecipitationAmountMillimeters('50mm 이상')).toBe(50);
    expect(parseKmaPrecipitationAmountMillimeters('50.0mm 이상')).toBe(50);
    expect(parseKmaPrecipitationAmountMillimeters('50.0mm이상')).toBe(50);
  });

  it('accepts the guide’s spaced number/unit form', () => {
    expect(parseKmaPrecipitationAmountMillimeters('50.0 mm 이상')).toBe(50);
  });

  it('returns a fractional value unchanged', () => {
    expect(parseKmaPrecipitationAmountMillimeters('0.5mm')).toBe(0.5);
  });

  it('accepts values just below the Missing bound', () => {
    expect(parseKmaPrecipitationAmountMillimeters('899')).toBe(899);
    expect(parseKmaPrecipitationAmountMillimeters('899.9')).toBe(899.9);
    expect(parseKmaPrecipitationAmountMillimeters('899.999mm')).toBe(899.999);
  });
});

describe('parseKmaPrecipitationAmountMillimeters — official Missing sentinels (>= 900)', () => {
  it('treats a bare number >= 900 as Missing (null)', () => {
    expect(parseKmaPrecipitationAmountMillimeters('900')).toBeNull();
    expect(parseKmaPrecipitationAmountMillimeters('901')).toBeNull();
    expect(parseKmaPrecipitationAmountMillimeters('900.0')).toBeNull();
  });

  it('treats a unit-carrying number >= 900 as Missing (null)', () => {
    expect(parseKmaPrecipitationAmountMillimeters('900mm')).toBeNull();
    expect(parseKmaPrecipitationAmountMillimeters('901mm')).toBeNull();
  });

  it('treats a "이상" threshold >= 900 as Missing (null)', () => {
    expect(parseKmaPrecipitationAmountMillimeters('900mm 이상')).toBeNull();
    expect(parseKmaPrecipitationAmountMillimeters('900mm이상')).toBeNull();
  });

  it('treats a range whose upper bound is >= 900 as Missing (null)', () => {
    expect(parseKmaPrecipitationAmountMillimeters('30~900mm')).toBeNull();
    expect(parseKmaPrecipitationAmountMillimeters('1~900mm')).toBeNull();
  });

  it('never accepts the signed Missing sentinels "+900" / "-900"', () => {
    expect(parseKmaPrecipitationAmountMillimeters('+900')).toBeNull();
    expect(parseKmaPrecipitationAmountMillimeters('-900')).toBeNull();
  });
});

describe('parseKmaPrecipitationAmountMillimeters — rejected values', () => {
  it('returns null for null and undefined', () => {
    expect(parseKmaPrecipitationAmountMillimeters(null)).toBeNull();
    expect(parseKmaPrecipitationAmountMillimeters(undefined)).toBeNull();
  });

  it('returns null for empty and whitespace-only strings', () => {
    expect(parseKmaPrecipitationAmountMillimeters('')).toBeNull();
    expect(parseKmaPrecipitationAmountMillimeters('   ')).toBeNull();
  });

  it('returns null for a value in the wrong unit (cm)', () => {
    expect(parseKmaPrecipitationAmountMillimeters('5.0cm')).toBeNull();
    expect(parseKmaPrecipitationAmountMillimeters('1.0cm 미만')).toBeNull();
    expect(parseKmaPrecipitationAmountMillimeters('5.0cm 이상')).toBeNull();
  });

  it('returns null for an unknown unit', () => {
    expect(parseKmaPrecipitationAmountMillimeters('5.0kg')).toBeNull();
  });

  it('returns null for a negative value', () => {
    expect(parseKmaPrecipitationAmountMillimeters('-1.0mm')).toBeNull();
    expect(parseKmaPrecipitationAmountMillimeters('-3')).toBeNull();
  });

  it('does not confuse "-" with other hyphenated strings', () => {
    expect(parseKmaPrecipitationAmountMillimeters('--')).toBeNull();
    expect(parseKmaPrecipitationAmountMillimeters('-1')).toBeNull();
    expect(parseKmaPrecipitationAmountMillimeters('-1mm')).toBeNull();
  });

  it('returns null when extra characters are appended', () => {
    expect(parseKmaPrecipitationAmountMillimeters('6.2mm 정도')).toBeNull();
    expect(parseKmaPrecipitationAmountMillimeters('약 6.2mm')).toBeNull();
    expect(parseKmaPrecipitationAmountMillimeters('6.2mmm')).toBeNull();
  });

  it('returns null for a malformed range whose lower bound exceeds its upper bound', () => {
    expect(parseKmaPrecipitationAmountMillimeters('50.0~30.0mm')).toBeNull();
  });

  it('returns null for an unparseable Korean phrase', () => {
    expect(parseKmaPrecipitationAmountMillimeters('조금')).toBeNull();
    expect(parseKmaPrecipitationAmountMillimeters('약간')).toBeNull();
  });

  it('returns null for an arbitrary English phrase', () => {
    expect(parseKmaPrecipitationAmountMillimeters('rain')).toBeNull();
    expect(parseKmaPrecipitationAmountMillimeters('none')).toBeNull();
  });

  it('returns null for the snowfall no-amount token', () => {
    expect(parseKmaPrecipitationAmountMillimeters('적설없음')).toBeNull();
  });

  it('does not loosely parse a leading number (no parseFloat behavior)', () => {
    expect(parseKmaPrecipitationAmountMillimeters('6.2 abc')).toBeNull();
  });
});

describe('parseKmaSnowfallAmountCentimeters — recognized values', () => {
  it('returns 0 for the "적설없음" no-snow token', () => {
    expect(parseKmaSnowfallAmountCentimeters('적설없음')).toBe(0);
  });

  it('returns 0 for the official "-" no-amount token (trimmed)', () => {
    expect(parseKmaSnowfallAmountCentimeters('-')).toBe(0);
    expect(parseKmaSnowfallAmountCentimeters(' - ')).toBe(0);
  });

  it('returns 0 for the raw zero readings', () => {
    expect(parseKmaSnowfallAmountCentimeters('0')).toBe(0);
    expect(parseKmaSnowfallAmountCentimeters('0.0')).toBe(0);
  });

  it('returns the exact number for a "<value>cm" reading', () => {
    expect(parseKmaSnowfallAmountCentimeters('3.5cm')).toBe(3.5);
    expect(parseKmaSnowfallAmountCentimeters('4.9cm')).toBe(4.9);
  });

  it('returns the exact number for a bare number with no unit', () => {
    expect(parseKmaSnowfallAmountCentimeters('3.5')).toBe(3.5);
  });

  it('returns threshold / 2 for the official minimum bucket "0.5cm 미만"', () => {
    // The official 2607 minimum SNO category is "0.5cm 미만" → 0.25 (T/2).
    expect(parseKmaSnowfallAmountCentimeters('0.5cm 미만')).toBe(0.25);
    expect(parseKmaSnowfallAmountCentimeters('0.5cm미만')).toBe(0.25);
  });

  it('also accepts a defensively-allowed decimal "미만" bucket', () => {
    expect(parseKmaSnowfallAmountCentimeters('1.0cm 미만')).toBe(0.5);
  });

  it('returns the lower bound for a "<T>cm 이상" bucket (spaced and unspaced)', () => {
    expect(parseKmaSnowfallAmountCentimeters('5cm 이상')).toBe(5);
    expect(parseKmaSnowfallAmountCentimeters('5.0cm 이상')).toBe(5);
    expect(parseKmaSnowfallAmountCentimeters('5.0cm이상')).toBe(5);
  });

  it('accepts values just below the Missing bound', () => {
    expect(parseKmaSnowfallAmountCentimeters('899')).toBe(899);
    expect(parseKmaSnowfallAmountCentimeters('899.9')).toBe(899.9);
    expect(parseKmaSnowfallAmountCentimeters('899.999cm')).toBe(899.999);
  });
});

describe('parseKmaSnowfallAmountCentimeters — range strings are rejected (no official SNO range)', () => {
  it('returns null for a well-formed range (the 2607 guide defines no SNO range)', () => {
    expect(parseKmaSnowfallAmountCentimeters('1.0~4.9cm')).toBeNull();
    expect(parseKmaSnowfallAmountCentimeters('1~29cm')).toBeNull();
  });

  it('returns null for any range shape, well-formed or not', () => {
    expect(parseKmaSnowfallAmountCentimeters('5.0~1.0cm')).toBeNull();
    expect(parseKmaSnowfallAmountCentimeters('1~900cm')).toBeNull();
  });
});

describe('parseKmaSnowfallAmountCentimeters — official Missing sentinels (>= 900)', () => {
  it('treats a bare number >= 900 as Missing (null)', () => {
    expect(parseKmaSnowfallAmountCentimeters('900')).toBeNull();
    expect(parseKmaSnowfallAmountCentimeters('901')).toBeNull();
    expect(parseKmaSnowfallAmountCentimeters('900.0')).toBeNull();
  });

  it('treats a unit-carrying number >= 900 as Missing (null)', () => {
    expect(parseKmaSnowfallAmountCentimeters('900cm')).toBeNull();
    expect(parseKmaSnowfallAmountCentimeters('901cm')).toBeNull();
  });

  it('treats a "이상" threshold >= 900 as Missing (null)', () => {
    expect(parseKmaSnowfallAmountCentimeters('900cm 이상')).toBeNull();
    expect(parseKmaSnowfallAmountCentimeters('900cm이상')).toBeNull();
  });

  it('never accepts the signed Missing sentinels "+900" / "-900"', () => {
    expect(parseKmaSnowfallAmountCentimeters('+900')).toBeNull();
    expect(parseKmaSnowfallAmountCentimeters('-900')).toBeNull();
  });
});

describe('parseKmaSnowfallAmountCentimeters — rejected values', () => {
  it('returns null for null and undefined', () => {
    expect(parseKmaSnowfallAmountCentimeters(null)).toBeNull();
    expect(parseKmaSnowfallAmountCentimeters(undefined)).toBeNull();
  });

  it('returns null for empty and whitespace-only strings', () => {
    expect(parseKmaSnowfallAmountCentimeters('')).toBeNull();
    expect(parseKmaSnowfallAmountCentimeters('   ')).toBeNull();
  });

  it('returns null for a value in the wrong unit (mm)', () => {
    expect(parseKmaSnowfallAmountCentimeters('1.0mm')).toBeNull();
    expect(parseKmaSnowfallAmountCentimeters('1.0mm 미만')).toBeNull();
    expect(parseKmaSnowfallAmountCentimeters('5.0mm 이상')).toBeNull();
  });

  it('returns null for a negative value', () => {
    expect(parseKmaSnowfallAmountCentimeters('-1.0cm')).toBeNull();
    expect(parseKmaSnowfallAmountCentimeters('-3')).toBeNull();
  });

  it('does not confuse "-" with other hyphenated strings', () => {
    expect(parseKmaSnowfallAmountCentimeters('--')).toBeNull();
    expect(parseKmaSnowfallAmountCentimeters('-1')).toBeNull();
    expect(parseKmaSnowfallAmountCentimeters('-1cm')).toBeNull();
  });

  it('returns null for an unparseable Korean phrase', () => {
    expect(parseKmaSnowfallAmountCentimeters('조금')).toBeNull();
  });

  it('returns null for the precipitation no-amount token', () => {
    expect(parseKmaSnowfallAmountCentimeters('강수없음')).toBeNull();
  });
});

describe('parseKma*Amount — "-" no-amount vs. missing argument (semantic distinction)', () => {
  // The official "-" category is a real, present "no amount" reading → 0. A JavaScript
  // null/undefined argument (or an empty/whitespace string) means the caller supplied no
  // value → null. These must never collapse into one another.
  it('maps the official "-" token to 0 for both units', () => {
    expect(parseKmaPrecipitationAmountMillimeters('-')).toBe(0);
    expect(parseKmaSnowfallAmountCentimeters('-')).toBe(0);
  });

  it('maps a missing argument to null (never 0)', () => {
    expect(parseKmaPrecipitationAmountMillimeters(null)).toBeNull();
    expect(parseKmaPrecipitationAmountMillimeters(undefined)).toBeNull();
    expect(parseKmaPrecipitationAmountMillimeters('')).toBeNull();
    expect(parseKmaPrecipitationAmountMillimeters('   ')).toBeNull();
    expect(parseKmaSnowfallAmountCentimeters(null)).toBeNull();
    expect(parseKmaSnowfallAmountCentimeters(undefined)).toBeNull();
    expect(parseKmaSnowfallAmountCentimeters('')).toBeNull();
    expect(parseKmaSnowfallAmountCentimeters('   ')).toBeNull();
  });

  it('maps an official Missing sentinel to null (never 0)', () => {
    expect(parseKmaPrecipitationAmountMillimeters('900mm 이상')).toBeNull();
    expect(parseKmaSnowfallAmountCentimeters('900cm 이상')).toBeNull();
  });
});

describe('parseKma*Amount — purity and invariants', () => {
  it('does not mutate the input string', () => {
    const raw = '  1.0mm 미만  ';
    parseKmaPrecipitationAmountMillimeters(raw);
    expect(raw).toBe('  1.0mm 미만  ');
  });

  it('is deterministic — the same input always yields the same result', () => {
    const results = new Set([
      parseKmaPrecipitationAmountMillimeters('30.0~50.0mm'),
      parseKmaPrecipitationAmountMillimeters('30.0~50.0mm'),
      parseKmaPrecipitationAmountMillimeters('30.0~50.0mm'),
    ]);
    expect(results.size).toBe(1);
  });

  it('always returns a non-negative finite number below 900, or null (precipitation)', () => {
    const samples = [
      '강수없음',
      '-',
      ' - ',
      '6.2mm',
      '6.2',
      '1mm 미만',
      '30.0~50.0mm',
      '50.0mm 이상',
      '899.999mm',
      '900',
      '900mm 이상',
      '30~900mm',
      '+900',
      '-1.0mm',
      '5.0cm',
      'rain',
      '',
      '   ',
      '50.0~30.0mm',
      null,
      undefined,
    ];
    for (const sample of samples) {
      expect(isValidAmountOrNull(parseKmaPrecipitationAmountMillimeters(sample))).toBe(true);
    }
  });

  it('always returns a non-negative finite number below 900, or null (snowfall)', () => {
    const samples = [
      '적설없음',
      '-',
      ' - ',
      '3.5cm',
      '3.5',
      '0.5cm 미만',
      '5.0cm 이상',
      '899.999cm',
      '900',
      '900cm 이상',
      '1.0~4.9cm',
      '+900',
      '-1.0cm',
      '1.0mm',
      '조금',
      '',
      null,
      undefined,
    ];
    for (const sample of samples) {
      expect(isValidAmountOrNull(parseKmaSnowfallAmountCentimeters(sample))).toBe(true);
    }
  });
});
