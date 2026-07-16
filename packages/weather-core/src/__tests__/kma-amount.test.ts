import { describe, expect, it } from 'vitest';

import {
  parseKmaPrecipitationAmountMillimeters,
  parseKmaSnowfallAmountCentimeters,
} from '../index';

/** A result is valid iff it is `null` or a finite number `>= 0`. */
function isNonNegativeFiniteOrNull(value: number | null): boolean {
  return value === null || (Number.isFinite(value) && value >= 0);
}

describe('parseKmaPrecipitationAmountMillimeters — recognized values', () => {
  it('returns 0 for the "강수없음" no-precipitation token', () => {
    expect(parseKmaPrecipitationAmountMillimeters('강수없음')).toBe(0);
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

  it('returns threshold / 2 for a "<T>mm 미만" bucket (spaced and unspaced)', () => {
    expect(parseKmaPrecipitationAmountMillimeters('1.0mm 미만')).toBe(0.5);
    expect(parseKmaPrecipitationAmountMillimeters('1.0mm미만')).toBe(0.5);
  });

  it('returns the lower bound for a "<L>~<U>mm" range', () => {
    expect(parseKmaPrecipitationAmountMillimeters('30.0~50.0mm')).toBe(30);
    expect(parseKmaPrecipitationAmountMillimeters('1.0~29.0mm')).toBe(1);
  });

  it('returns the lower bound for a "<T>mm 이상" bucket (spaced and unspaced)', () => {
    expect(parseKmaPrecipitationAmountMillimeters('50.0mm 이상')).toBe(50);
    expect(parseKmaPrecipitationAmountMillimeters('50.0mm이상')).toBe(50);
  });

  it('accepts the guide’s spaced number/unit form', () => {
    expect(parseKmaPrecipitationAmountMillimeters('50.0 mm 이상')).toBe(50);
  });

  it('returns 0 for the raw zero readings', () => {
    expect(parseKmaPrecipitationAmountMillimeters('0')).toBe(0);
    expect(parseKmaPrecipitationAmountMillimeters('0.0')).toBe(0);
  });

  it('returns a fractional value unchanged', () => {
    expect(parseKmaPrecipitationAmountMillimeters('0.5mm')).toBe(0.5);
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

  it('returns the exact number for a "<value>cm" reading', () => {
    expect(parseKmaSnowfallAmountCentimeters('3.5cm')).toBe(3.5);
    expect(parseKmaSnowfallAmountCentimeters('4.9cm')).toBe(4.9);
  });

  it('returns the exact number for a bare number with no unit', () => {
    expect(parseKmaSnowfallAmountCentimeters('3.5')).toBe(3.5);
  });

  it('returns threshold / 2 for a "<T>cm 미만" bucket (spaced and unspaced)', () => {
    expect(parseKmaSnowfallAmountCentimeters('1.0cm 미만')).toBe(0.5);
    expect(parseKmaSnowfallAmountCentimeters('1.0cm미만')).toBe(0.5);
  });

  it('returns the lower bound for a "<L>~<U>cm" range', () => {
    expect(parseKmaSnowfallAmountCentimeters('1.0~4.9cm')).toBe(1);
  });

  it('returns the lower bound for a "<T>cm 이상" bucket (spaced and unspaced)', () => {
    expect(parseKmaSnowfallAmountCentimeters('5.0cm 이상')).toBe(5);
    expect(parseKmaSnowfallAmountCentimeters('5.0cm이상')).toBe(5);
  });

  it('returns 0 for the raw zero readings', () => {
    expect(parseKmaSnowfallAmountCentimeters('0')).toBe(0);
    expect(parseKmaSnowfallAmountCentimeters('0.0')).toBe(0);
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

  it('returns null for a malformed range whose lower bound exceeds its upper bound', () => {
    expect(parseKmaSnowfallAmountCentimeters('5.0~1.0cm')).toBeNull();
  });

  it('returns null for an unparseable Korean phrase', () => {
    expect(parseKmaSnowfallAmountCentimeters('조금')).toBeNull();
  });

  it('returns null for the precipitation no-amount token', () => {
    expect(parseKmaSnowfallAmountCentimeters('강수없음')).toBeNull();
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

  it('always returns a non-negative finite number or null (precipitation)', () => {
    const samples = [
      '강수없음',
      '6.2mm',
      '6.2',
      '1.0mm 미만',
      '30.0~50.0mm',
      '50.0mm 이상',
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
      expect(isNonNegativeFiniteOrNull(parseKmaPrecipitationAmountMillimeters(sample))).toBe(
        true,
      );
    }
  });

  it('always returns a non-negative finite number or null (snowfall)', () => {
    const samples = [
      '적설없음',
      '3.5cm',
      '3.5',
      '1.0cm 미만',
      '5.0cm 이상',
      '-1.0cm',
      '1.0mm',
      '조금',
      '',
      null,
      undefined,
    ];
    for (const sample of samples) {
      expect(isNonNegativeFiniteOrNull(parseKmaSnowfallAmountCentimeters(sample))).toBe(true);
    }
  });
});
