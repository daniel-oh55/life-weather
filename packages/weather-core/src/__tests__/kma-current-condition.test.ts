import { describe, expect, it } from 'vitest';

import type { WeatherCondition } from '@life-weather/contracts';

import {
  normalizeKmaCurrentWeatherCondition,
  type KmaCurrentWeatherCondition,
} from '../index';

describe('normalizeKmaCurrentWeatherCondition — official PTY codes', () => {
  const cases: Array<[string, KmaCurrentWeatherCondition, string]> = [
    ['1', 'RAIN', '비'],
    ['5', 'RAIN', '빗방울'],
    ['2', 'SLEET', '비/눈'],
    ['6', 'SLEET', '빗방울눈날림'],
    ['3', 'SNOW', '눈'],
    ['7', 'SNOW', '눈날림'],
  ];

  it.each(cases)('PTY %s (%s → %s)', (code, expected) => {
    expect(normalizeKmaCurrentWeatherCondition(code)).toBe(expected);
  });
});

describe('normalizeKmaCurrentWeatherCondition — PTY 0 (no precipitation)', () => {
  it('returns UNKNOWN rather than guessing a sky state', () => {
    expect(normalizeKmaCurrentWeatherCondition('0')).toBe('UNKNOWN');
  });
});

describe('normalizeKmaCurrentWeatherCondition — missing / blank / malformed input', () => {
  it('returns UNKNOWN for null', () => {
    expect(normalizeKmaCurrentWeatherCondition(null)).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for undefined', () => {
    expect(normalizeKmaCurrentWeatherCondition(undefined)).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for the empty string', () => {
    expect(normalizeKmaCurrentWeatherCondition('')).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for a whitespace-only string', () => {
    expect(normalizeKmaCurrentWeatherCondition('   ')).toBe('UNKNOWN');
  });

  it('trims surrounding whitespace before matching a known code', () => {
    expect(normalizeKmaCurrentWeatherCondition('  1  ')).toBe('RAIN');
  });

  it('does not fold "01" to "1"', () => {
    expect(normalizeKmaCurrentWeatherCondition('01')).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for a code not defined for current observation (forecast-only 4/소나기)', () => {
    expect(normalizeKmaCurrentWeatherCondition('4')).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for an arbitrary unknown code', () => {
    expect(normalizeKmaCurrentWeatherCondition('9')).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for a non-string runtime input (number)', () => {
    expect(
      normalizeKmaCurrentWeatherCondition(1 as unknown as string),
    ).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for a non-string runtime input (boolean)', () => {
    expect(
      normalizeKmaCurrentWeatherCondition(true as unknown as string),
    ).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for a non-string runtime input (object)', () => {
    expect(
      normalizeKmaCurrentWeatherCondition({} as unknown as string),
    ).toBe('UNKNOWN');
  });
});

describe('normalizeKmaCurrentWeatherCondition — purity and determinism', () => {
  it('does not mutate a string input', () => {
    const input = ' 1 ';
    normalizeKmaCurrentWeatherCondition(input);
    expect(input).toBe(' 1 ');
  });

  it('returns the same result for the same input across repeated calls', () => {
    const results = new Set([
      normalizeKmaCurrentWeatherCondition('5'),
      normalizeKmaCurrentWeatherCondition('5'),
      normalizeKmaCurrentWeatherCondition('5'),
    ]);
    expect(results.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Compile-time contract compatibility (Method B).
//
// These assertions are verified by `tsc --noEmit` (the package `typecheck` script) when it
// compiles this test file, and also run trivially at test time. `AssertAssignableNotAny`
// resolves to `never` — a compile error at `const … = true` — if the return type is `any` or
// is not assignable to the contract's `WeatherCondition`, so an `any` return cannot pass.
// ---------------------------------------------------------------------------
type IsAny<T> = 0 extends 1 & T ? true : false;
type AssertAssignableNotAny<Actual, Expected> = IsAny<Actual> extends true
  ? never
  : Actual extends Expected
    ? true
    : never;

describe('normalizeKmaCurrentWeatherCondition — contract type compatibility', () => {
  it('has a return type assignable to WeatherCondition and never `any`', () => {
    const returnAssignable: AssertAssignableNotAny<
      ReturnType<typeof normalizeKmaCurrentWeatherCondition>,
      WeatherCondition
    > = true;
    const unionAssignable: AssertAssignableNotAny<
      KmaCurrentWeatherCondition,
      WeatherCondition
    > = true;

    expect(returnAssignable).toBe(true);
    expect(unionAssignable).toBe(true);
  });
});
