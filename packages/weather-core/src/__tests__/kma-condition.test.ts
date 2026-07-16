import { describe, expect, it } from 'vitest';

import type { WeatherCondition } from '@life-weather/contracts';

import {
  KmaForecastProduct,
  normalizeKmaWeatherCondition,
  type KmaWeatherCondition,
  type NormalizeKmaWeatherConditionInput,
} from '../index';

const SHORT = KmaForecastProduct.SHORT_FORECAST;
const ULTRA = KmaForecastProduct.ULTRA_SHORT_FORECAST;

/** The official "no precipitation" (없음) PTY code, shared by both products. */
const NO_PRECIP = '0';

describe('normalizeKmaWeatherCondition — SKY codes (explicit no precipitation)', () => {
  // With PTY = 0 (없음) the sky code decides the condition. SKY is identical for both
  // products: 맑음(1), 구름많음(3), 흐림(4).
  const skyCases: Array<[string, KmaWeatherCondition, string]> = [
    ['1', 'CLEAR', '맑음'],
    ['3', 'PARTLY_CLOUDY', '구름많음'],
    ['4', 'CLOUDY', '흐림'],
  ];

  describe('short forecast (단기예보)', () => {
    it.each(skyCases)('SKY %s (%s → %s)', (skyCode, expected) => {
      expect(
        normalizeKmaWeatherCondition({
          product: SHORT,
          skyCode,
          precipitationTypeCode: NO_PRECIP,
        }),
      ).toBe(expected);
    });
  });

  describe('ultra-short forecast (초단기예보)', () => {
    it.each(skyCases)('SKY %s (%s → %s)', (skyCode, expected) => {
      expect(
        normalizeKmaWeatherCondition({
          product: ULTRA,
          skyCode,
          precipitationTypeCode: NO_PRECIP,
        }),
      ).toBe(expected);
    });
  });

  it('treats retired SKY code 2 (구름조금) as UNKNOWN for both products', () => {
    expect(
      normalizeKmaWeatherCondition({
        product: SHORT,
        skyCode: '2',
        precipitationTypeCode: NO_PRECIP,
      }),
    ).toBe('UNKNOWN');
    expect(
      normalizeKmaWeatherCondition({
        product: ULTRA,
        skyCode: '2',
        precipitationTypeCode: NO_PRECIP,
      }),
    ).toBe('UNKNOWN');
  });
});

describe('normalizeKmaWeatherCondition — PTY codes for short forecast (단기예보)', () => {
  // 0(없음), 비(1), 비/눈(2), 눈(3), 소나기(4). A precipitation PTY ignores SKY, so a
  // deliberately mismatched SKY (맑음) is supplied to prove PTY precedence.
  const precipCases: Array<[string, KmaWeatherCondition, string]> = [
    ['1', 'RAIN', '비'],
    ['2', 'SLEET', '비/눈'],
    ['3', 'SNOW', '눈'],
    ['4', 'SHOWER', '소나기'],
  ];

  it.each(precipCases)('PTY %s (%s → %s), ignoring SKY', (ptyCode, expected) => {
    expect(
      normalizeKmaWeatherCondition({
        product: SHORT,
        skyCode: '1',
        precipitationTypeCode: ptyCode,
      }),
    ).toBe(expected);
  });

  it('PTY 0 (없음) defers to SKY', () => {
    expect(
      normalizeKmaWeatherCondition({
        product: SHORT,
        skyCode: '4',
        precipitationTypeCode: NO_PRECIP,
      }),
    ).toBe('CLOUDY');
  });

  it('treats ultra-short-only PTY codes 5, 6, 7 as UNKNOWN under short forecast', () => {
    for (const ptyCode of ['5', '6', '7']) {
      expect(
        normalizeKmaWeatherCondition({
          product: SHORT,
          skyCode: '1',
          precipitationTypeCode: ptyCode,
        }),
      ).toBe('UNKNOWN');
    }
  });
});

describe('normalizeKmaWeatherCondition — PTY codes for ultra-short forecast (초단기예보)', () => {
  // 0(없음), 비(1), 비/눈(2), 눈(3), 빗방울(5), 빗방울눈날림(6), 눈날림(7). No 소나기(4).
  const precipCases: Array<[string, KmaWeatherCondition, string]> = [
    ['1', 'RAIN', '비'],
    ['2', 'SLEET', '비/눈'],
    ['3', 'SNOW', '눈'],
    ['5', 'RAIN', '빗방울'],
    ['6', 'SLEET', '빗방울눈날림'],
    ['7', 'SNOW', '눈날림'],
  ];

  it.each(precipCases)('PTY %s (%s → %s), ignoring SKY', (ptyCode, expected) => {
    expect(
      normalizeKmaWeatherCondition({
        product: ULTRA,
        skyCode: '1',
        precipitationTypeCode: ptyCode,
      }),
    ).toBe(expected);
  });

  it('PTY 0 (없음) defers to SKY', () => {
    expect(
      normalizeKmaWeatherCondition({
        product: ULTRA,
        skyCode: '3',
        precipitationTypeCode: NO_PRECIP,
      }),
    ).toBe('PARTLY_CLOUDY');
  });

  it('treats short-only PTY code 4 (소나기) as UNKNOWN under ultra-short forecast', () => {
    expect(
      normalizeKmaWeatherCondition({
        product: ULTRA,
        skyCode: '1',
        precipitationTypeCode: '4',
      }),
    ).toBe('UNKNOWN');
  });
});

describe('normalizeKmaWeatherCondition — precipitation precedence over sky', () => {
  it('returns the precipitation condition even when SKY says 맑음(1)', () => {
    expect(
      normalizeKmaWeatherCondition({
        product: SHORT,
        skyCode: '1',
        precipitationTypeCode: '1',
      }),
    ).toBe('RAIN');
  });

  it('returns the precipitation condition even when SKY is unknown', () => {
    expect(
      normalizeKmaWeatherCondition({
        product: SHORT,
        skyCode: '99',
        precipitationTypeCode: '3',
      }),
    ).toBe('SNOW');
  });

  it('returns the precipitation condition even when SKY is null', () => {
    expect(
      normalizeKmaWeatherCondition({
        product: ULTRA,
        skyCode: null,
        precipitationTypeCode: '1',
      }),
    ).toBe('RAIN');
  });
});

describe('normalizeKmaWeatherCondition — no fallback to SKY on missing/unknown PTY', () => {
  it('returns UNKNOWN for null PTY even with a recognized SKY', () => {
    expect(
      normalizeKmaWeatherCondition({
        product: SHORT,
        skyCode: '1',
        precipitationTypeCode: null,
      }),
    ).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for undefined PTY even with a recognized SKY', () => {
    expect(
      normalizeKmaWeatherCondition({
        product: SHORT,
        skyCode: '1',
        precipitationTypeCode: undefined,
      }),
    ).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for an unknown PTY code even with a recognized SKY', () => {
    expect(
      normalizeKmaWeatherCondition({
        product: SHORT,
        skyCode: '1',
        precipitationTypeCode: '9',
      }),
    ).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for an empty-string PTY even with a recognized SKY', () => {
    expect(
      normalizeKmaWeatherCondition({
        product: SHORT,
        skyCode: '1',
        precipitationTypeCode: '',
      }),
    ).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for a whitespace-only PTY even with a recognized SKY', () => {
    expect(
      normalizeKmaWeatherCondition({
        product: SHORT,
        skyCode: '1',
        precipitationTypeCode: '   ',
      }),
    ).toBe('UNKNOWN');
  });
});

describe('normalizeKmaWeatherCondition — no precipitation with missing/unknown SKY', () => {
  it('returns UNKNOWN for no-precipitation PTY 0 with null SKY', () => {
    expect(
      normalizeKmaWeatherCondition({
        product: SHORT,
        skyCode: null,
        precipitationTypeCode: NO_PRECIP,
      }),
    ).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for no-precipitation PTY 0 with undefined SKY', () => {
    expect(
      normalizeKmaWeatherCondition({
        product: SHORT,
        skyCode: undefined,
        precipitationTypeCode: NO_PRECIP,
      }),
    ).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for no-precipitation PTY 0 with an unknown SKY code', () => {
    expect(
      normalizeKmaWeatherCondition({
        product: SHORT,
        skyCode: '7',
        precipitationTypeCode: NO_PRECIP,
      }),
    ).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for no-precipitation PTY 0 with an empty-string SKY', () => {
    expect(
      normalizeKmaWeatherCondition({
        product: SHORT,
        skyCode: '',
        precipitationTypeCode: NO_PRECIP,
      }),
    ).toBe('UNKNOWN');
  });
});

describe('normalizeKmaWeatherCondition — input string handling', () => {
  it('trims surrounding whitespace on otherwise-valid codes', () => {
    expect(
      normalizeKmaWeatherCondition({
        product: SHORT,
        skyCode: '  1  ',
        precipitationTypeCode: ' 0 ',
      }),
    ).toBe('CLEAR');
    expect(
      normalizeKmaWeatherCondition({
        product: SHORT,
        skyCode: '1',
        precipitationTypeCode: '\t1\n',
      }),
    ).toBe('RAIN');
  });

  it('does not fold a zero-padded code: PTY "01" is not PTY "1"', () => {
    expect(
      normalizeKmaWeatherCondition({
        product: SHORT,
        skyCode: '1',
        precipitationTypeCode: '01',
      }),
    ).toBe('UNKNOWN');
  });

  it('does not fold a zero-padded SKY code: SKY "01" is not SKY "1"', () => {
    expect(
      normalizeKmaWeatherCondition({
        product: SHORT,
        skyCode: '01',
        precipitationTypeCode: NO_PRECIP,
      }),
    ).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for an unrecognized forecast product', () => {
    expect(
      normalizeKmaWeatherCondition({
        // A product value that is not part of the union (guards runtime misuse).
        product: 'ULTRA_SHORT_NOWCAST' as KmaForecastProduct,
        skyCode: '1',
        precipitationTypeCode: '1',
      }),
    ).toBe('UNKNOWN');
  });
});

describe('normalizeKmaWeatherCondition — purity', () => {
  it('does not mutate its input object', () => {
    const input: NormalizeKmaWeatherConditionInput = {
      product: SHORT,
      skyCode: '  1  ',
      precipitationTypeCode: ' 0 ',
    };
    const snapshot = { ...input };
    Object.freeze(input);

    normalizeKmaWeatherCondition(input);

    expect(input).toEqual(snapshot);
  });

  it('is deterministic — the same input always yields the same result', () => {
    const input: NormalizeKmaWeatherConditionInput = {
      product: ULTRA,
      skyCode: '3',
      precipitationTypeCode: '6',
    };
    const results = new Set([
      normalizeKmaWeatherCondition(input),
      normalizeKmaWeatherCondition(input),
      normalizeKmaWeatherCondition(input),
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

describe('normalizeKmaWeatherCondition — contract type compatibility', () => {
  it('has a return type assignable to WeatherCondition and never `any`', () => {
    const returnAssignable: AssertAssignableNotAny<
      ReturnType<typeof normalizeKmaWeatherCondition>,
      WeatherCondition
    > = true;
    const unionAssignable: AssertAssignableNotAny<
      KmaWeatherCondition,
      WeatherCondition
    > = true;

    expect(returnAssignable).toBe(true);
    expect(unionAssignable).toBe(true);
  });
});
