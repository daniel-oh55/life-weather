import { describe, expect, it } from 'vitest';

import {
  parseKmaPercentage,
  parseKmaTemperatureCelsius,
  parseKmaWindDirectionDegrees,
  parseKmaWindSpeedMetersPerSecond,
} from '../index';

/**
 * A runtime-bypass value: something whose *TypeScript* type would be rejected but which can still
 * reach a parser at runtime through a cast. Every parser must be total on these (never throw).
 */
const NUMBER_BYPASS = 25 as unknown as string;

describe('parseKmaTemperatureCelsius — numeric grammar', () => {
  it('accepts a plain integer', () => {
    expect(parseKmaTemperatureCelsius('25')).toBe(25);
    expect(parseKmaTemperatureCelsius('0')).toBe(0);
  });

  it('accepts a positive decimal', () => {
    expect(parseKmaTemperatureCelsius('25.5')).toBe(25.5);
  });

  it('accepts a negative integer and decimal', () => {
    expect(parseKmaTemperatureCelsius('-3')).toBe(-3);
    expect(parseKmaTemperatureCelsius('-3.5')).toBe(-3.5);
  });

  it('accepts a leading plus sign', () => {
    expect(parseKmaTemperatureCelsius('+3')).toBe(3);
    expect(parseKmaTemperatureCelsius('+3.5')).toBe(3.5);
  });

  it('trims surrounding whitespace', () => {
    expect(parseKmaTemperatureCelsius('  25.5  ')).toBe(25.5);
    expect(parseKmaTemperatureCelsius('\t-3\n')).toBe(-3);
  });

  it('returns null for empty and whitespace-only strings', () => {
    expect(parseKmaTemperatureCelsius('')).toBeNull();
    expect(parseKmaTemperatureCelsius('   ')).toBeNull();
  });

  it('returns null for null and undefined', () => {
    expect(parseKmaTemperatureCelsius(null)).toBeNull();
    expect(parseKmaTemperatureCelsius(undefined)).toBeNull();
  });

  it('returns null for a non-string runtime bypass (number)', () => {
    expect(parseKmaTemperatureCelsius(NUMBER_BYPASS)).toBeNull();
  });

  it('rejects exponent notation (no official basis)', () => {
    expect(parseKmaTemperatureCelsius('2.5e1')).toBeNull();
    expect(parseKmaTemperatureCelsius('1e3')).toBeNull();
  });

  it('rejects trailing junk and unit suffixes', () => {
    expect(parseKmaTemperatureCelsius('25℃')).toBeNull();
    expect(parseKmaTemperatureCelsius('25 C')).toBeNull();
    expect(parseKmaTemperatureCelsius('25 degrees')).toBeNull();
    expect(parseKmaTemperatureCelsius('25.5.5')).toBeNull();
  });

  it('rejects NaN/Infinity literal strings', () => {
    expect(parseKmaTemperatureCelsius('NaN')).toBeNull();
    expect(parseKmaTemperatureCelsius('Infinity')).toBeNull();
    expect(parseKmaTemperatureCelsius('-Infinity')).toBeNull();
  });

  it('rejects a bare sign', () => {
    expect(parseKmaTemperatureCelsius('+')).toBeNull();
    expect(parseKmaTemperatureCelsius('-')).toBeNull();
  });
});

describe('parseKmaTemperatureCelsius — Missing sentinel (|value| >= 900)', () => {
  it('treats +900 and beyond as Missing (null)', () => {
    expect(parseKmaTemperatureCelsius('900')).toBeNull();
    expect(parseKmaTemperatureCelsius('900.0')).toBeNull();
    expect(parseKmaTemperatureCelsius('999')).toBeNull();
  });

  it('treats -900 and below as Missing (null)', () => {
    expect(parseKmaTemperatureCelsius('-900')).toBeNull();
    expect(parseKmaTemperatureCelsius('-999')).toBeNull();
  });

  it('accepts values just inside the Missing band', () => {
    expect(parseKmaTemperatureCelsius('899.9')).toBe(899.9);
    expect(parseKmaTemperatureCelsius('-899.9')).toBe(-899.9);
  });
});

describe('parseKmaPercentage — POP / REH', () => {
  it('accepts the range bounds 0 and 100', () => {
    expect(parseKmaPercentage('0')).toBe(0);
    expect(parseKmaPercentage('100')).toBe(100);
  });

  it('accepts a decimal within range', () => {
    expect(parseKmaPercentage('55.5')).toBe(55.5);
  });

  it('returns null below 0 and above 100', () => {
    expect(parseKmaPercentage('-1')).toBeNull();
    expect(parseKmaPercentage('101')).toBeNull();
    expect(parseKmaPercentage('100.1')).toBeNull();
  });

  it('returns null for a malformed value', () => {
    expect(parseKmaPercentage('70%')).toBeNull();
    expect(parseKmaPercentage('abc')).toBeNull();
    expect(parseKmaPercentage('5e1')).toBeNull();
  });

  it('returns null for the Missing sentinel and missing input', () => {
    expect(parseKmaPercentage('900')).toBeNull();
    expect(parseKmaPercentage('')).toBeNull();
    expect(parseKmaPercentage('   ')).toBeNull();
    expect(parseKmaPercentage(null)).toBeNull();
    expect(parseKmaPercentage(undefined)).toBeNull();
  });
});

describe('parseKmaWindSpeedMetersPerSecond — WSD', () => {
  it('accepts 0 and positive decimals', () => {
    expect(parseKmaWindSpeedMetersPerSecond('0')).toBe(0);
    expect(parseKmaWindSpeedMetersPerSecond('3.4')).toBe(3.4);
  });

  it('returns null for a negative value', () => {
    expect(parseKmaWindSpeedMetersPerSecond('-1')).toBeNull();
    expect(parseKmaWindSpeedMetersPerSecond('-0.1')).toBeNull();
  });

  it('returns null for a malformed or unit-carrying value', () => {
    expect(parseKmaWindSpeedMetersPerSecond('3.4m/s')).toBeNull();
    expect(parseKmaWindSpeedMetersPerSecond('breezy')).toBeNull();
  });

  it('returns null for the Missing sentinel and missing input', () => {
    expect(parseKmaWindSpeedMetersPerSecond('900')).toBeNull();
    expect(parseKmaWindSpeedMetersPerSecond('')).toBeNull();
    expect(parseKmaWindSpeedMetersPerSecond(null)).toBeNull();
    expect(parseKmaWindSpeedMetersPerSecond(undefined)).toBeNull();
  });

  it('accepts a value just below the Missing bound', () => {
    expect(parseKmaWindSpeedMetersPerSecond('899.9')).toBe(899.9);
  });
});

describe('parseKmaWindDirectionDegrees — VEC', () => {
  it('accepts 0 (due north) and mid-range values', () => {
    expect(parseKmaWindDirectionDegrees('0')).toBe(0);
    expect(parseKmaWindDirectionDegrees('45')).toBe(45);
    expect(parseKmaWindDirectionDegrees('359.9')).toBe(359.9);
  });

  it('folds the official 360 to 0 (360 == 0 == 북/N)', () => {
    // Official 풍향 conversion maps both 0 and 360 to N; contracts requires [0, 360).
    expect(parseKmaWindDirectionDegrees('360')).toBe(0);
    expect(parseKmaWindDirectionDegrees('360.0')).toBe(0);
  });

  it('returns null for a negative value', () => {
    expect(parseKmaWindDirectionDegrees('-1')).toBeNull();
  });

  it('returns null for a value greater than 360', () => {
    expect(parseKmaWindDirectionDegrees('360.1')).toBeNull();
    expect(parseKmaWindDirectionDegrees('400')).toBeNull();
  });

  it('returns null for a malformed value and the Missing sentinel', () => {
    expect(parseKmaWindDirectionDegrees('NNW')).toBeNull();
    expect(parseKmaWindDirectionDegrees('45deg')).toBeNull();
    expect(parseKmaWindDirectionDegrees('900')).toBeNull();
  });

  it('returns null for missing input', () => {
    expect(parseKmaWindDirectionDegrees('')).toBeNull();
    expect(parseKmaWindDirectionDegrees('   ')).toBeNull();
    expect(parseKmaWindDirectionDegrees(null)).toBeNull();
    expect(parseKmaWindDirectionDegrees(undefined)).toBeNull();
  });
});

describe('parseKma* scalars — purity and determinism', () => {
  it('does not mutate a frozen input string wrapper', () => {
    // Strings are immutable primitives; this asserts the contract stays value-only.
    const raw = '  25.5  ';
    parseKmaTemperatureCelsius(raw);
    expect(raw).toBe('  25.5  ');
  });

  it('is deterministic — the same input always yields the same result', () => {
    const results = new Set([
      parseKmaWindDirectionDegrees('360'),
      parseKmaWindDirectionDegrees('360'),
      parseKmaWindDirectionDegrees('360'),
    ]);
    expect(results.size).toBe(1);
  });

  it('always returns a value in-range or null (no NaN/Infinity leaks)', () => {
    const samples = [
      '25',
      '-3.5',
      '+3',
      '900',
      '-900',
      '2.5e1',
      '25℃',
      'NaN',
      'Infinity',
      '',
      '   ',
      null,
      undefined,
      NUMBER_BYPASS,
    ];
    for (const sample of samples) {
      for (const parse of [
        parseKmaTemperatureCelsius,
        parseKmaPercentage,
        parseKmaWindSpeedMetersPerSecond,
        parseKmaWindDirectionDegrees,
      ]) {
        const result = parse(sample);
        expect(result === null || Number.isFinite(result)).toBe(true);
      }
    }
  });
});
