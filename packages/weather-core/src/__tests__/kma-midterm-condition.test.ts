import { describe, expect, it } from 'vitest';

import type { WeatherCondition } from '@life-weather/contracts';

import {
  normalizeKmaMidtermWeatherCondition,
  type KmaMidtermWeatherCondition,
} from '../index';

describe('normalizeKmaMidtermWeatherCondition — sky-only phrases', () => {
  const skyCases: Array<[string, KmaMidtermWeatherCondition]> = [
    ['맑음', 'CLEAR'],
    ['구름조금', 'PARTLY_CLOUDY'],
    ['구름많음', 'PARTLY_CLOUDY'],
    ['흐림', 'CLOUDY'],
  ];

  it.each(skyCases)('%s → %s', (phrase, expected) => {
    expect(normalizeKmaMidtermWeatherCondition(phrase)).toBe(expected);
  });

  it('supports mid-term 구름조금 even though short-term numeric SKY code 2 is retired', () => {
    // The sibling short-term normalizer (`condition.ts`) treats numeric SKY `2` as UNKNOWN
    // because it was retired from the current short-term guide. Mid-term is a separate policy
    // and the official mid-term DB definition still explicitly lists WB02 = 구름조금.
    expect(normalizeKmaMidtermWeatherCondition('구름조금')).toBe('PARTLY_CLOUDY');
  });
});

describe('normalizeKmaMidtermWeatherCondition — basic precipitation', () => {
  const precipCases: Array<[string, KmaMidtermWeatherCondition]> = [
    ['비', 'RAIN'],
    ['소나기', 'SHOWER'],
    ['비/눈', 'SLEET'],
    ['눈/비', 'SLEET'],
    ['눈', 'SNOW'],
  ];

  it.each(precipCases)('%s → %s', (phrase, expected) => {
    expect(normalizeKmaMidtermWeatherCondition(phrase)).toBe(expected);
  });
});

describe('normalizeKmaMidtermWeatherCondition — composite phrases', () => {
  const compositeCases: Array<[string, KmaMidtermWeatherCondition]> = [
    ['구름많고 비', 'RAIN'],
    ['흐리고 비', 'RAIN'],
    ['흐리고비', 'RAIN'],
    ['흐리고 한때 비', 'RAIN'],
    ['흐리고 가끔 비', 'RAIN'],
    ['구름많고 소나기', 'SHOWER'],
    ['흐리고 눈', 'SNOW'],
    ['흐리고 비/눈', 'SLEET'],
    ['흐리고 눈/비', 'SLEET'],
  ];

  it.each(compositeCases)('%s → %s', (phrase, expected) => {
    expect(normalizeKmaMidtermWeatherCondition(phrase)).toBe(expected);
  });
});

describe('normalizeKmaMidtermWeatherCondition — precedence', () => {
  it('mixed rain+snow wins over standalone rain or snow', () => {
    expect(normalizeKmaMidtermWeatherCondition('비/눈')).toBe('SLEET');
    expect(normalizeKmaMidtermWeatherCondition('눈/비')).toBe('SLEET');
  });

  it('소나기 wins over generic rain detection when both tokens occur', () => {
    // 소나기 does not itself contain the 비 character, so this proves the SHOWER check runs
    // before the RAIN check would otherwise apply to a co-occurring standalone 비 mention.
    expect(normalizeKmaMidtermWeatherCondition('소나기 후 비')).toBe('SHOWER');
  });

  it('precipitation wins over sky, even when sky and precipitation wording contradict', () => {
    expect(normalizeKmaMidtermWeatherCondition('맑고 비')).toBe('RAIN');
  });
});

describe('normalizeKmaMidtermWeatherCondition — whitespace handling', () => {
  it('tolerates leading/trailing whitespace', () => {
    expect(normalizeKmaMidtermWeatherCondition('  맑음  ')).toBe('CLEAR');
  });

  it('tolerates spaces between Korean words', () => {
    expect(normalizeKmaMidtermWeatherCondition('흐리고 비')).toBe('RAIN');
  });

  it('tolerates tabs and newlines supplied synthetically', () => {
    expect(normalizeKmaMidtermWeatherCondition('흐리고\t한때\n비')).toBe('RAIN');
  });

  it('does not mutate the original string', () => {
    const phrase = '  흐리고 비  ';
    const snapshot = phrase;

    normalizeKmaMidtermWeatherCondition(phrase);

    expect(phrase).toBe(snapshot);
  });
});

describe('normalizeKmaMidtermWeatherCondition — unknown / defensive runtime inputs', () => {
  it('returns UNKNOWN for null', () => {
    expect(normalizeKmaMidtermWeatherCondition(null)).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for undefined', () => {
    expect(normalizeKmaMidtermWeatherCondition(undefined)).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for an empty string', () => {
    expect(normalizeKmaMidtermWeatherCondition('')).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for a whitespace-only string', () => {
    expect(normalizeKmaMidtermWeatherCondition('   ')).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for 안개 (not grounded in mid-term sky/precipitation semantics)', () => {
    expect(normalizeKmaMidtermWeatherCondition('안개')).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for 천둥번개 (not grounded in mid-term sky/precipitation semantics)', () => {
    expect(normalizeKmaMidtermWeatherCondition('천둥번개')).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for arbitrary unknown Korean text', () => {
    expect(normalizeKmaMidtermWeatherCondition('알 수 없는 문구')).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for arbitrary English text', () => {
    expect(normalizeKmaMidtermWeatherCondition('cloudy with a chance of rain')).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for a runtime non-string value', () => {
    expect(normalizeKmaMidtermWeatherCondition(42 as unknown as string)).toBe('UNKNOWN');
  });

  it('does not throw for any of the above', () => {
    for (const input of [null, undefined, '', '   ', '안개', 42 as unknown as string]) {
      expect(() => normalizeKmaMidtermWeatherCondition(input)).not.toThrow();
    }
  });
});

describe('normalizeKmaMidtermWeatherCondition — determinism', () => {
  it('returns the same result for the same input across repeated calls', () => {
    const results = new Set([
      normalizeKmaMidtermWeatherCondition('흐리고 한때 비'),
      normalizeKmaMidtermWeatherCondition('흐리고 한때 비'),
      normalizeKmaMidtermWeatherCondition('흐리고 한때 비'),
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

describe('normalizeKmaMidtermWeatherCondition — contract type compatibility', () => {
  it('has a return type assignable to WeatherCondition and never `any`', () => {
    const returnAssignable: AssertAssignableNotAny<
      ReturnType<typeof normalizeKmaMidtermWeatherCondition>,
      WeatherCondition
    > = true;
    const unionAssignable: AssertAssignableNotAny<
      KmaMidtermWeatherCondition,
      WeatherCondition
    > = true;

    expect(returnAssignable).toBe(true);
    expect(unionAssignable).toBe(true);
  });
});
