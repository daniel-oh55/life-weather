import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HourlyForecast } from '@life-weather/contracts';

import {
  assessOutfitRecommendation,
  OUTFIT_POLICY,
  type OutfitAssessmentInput,
  type OutfitStatus,
} from './index';

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

/** Anchor instant for every scenario. Uses seconds precision to exercise normalization. */
const BASE = '2026-07-15T12:00:00Z';
const HOUR_IN_MS = 3_600_000;

/** Canonical UTC ISO for an instant `hours` after `baseIso` — matches the engine's output. */
function isoPlusHours(baseIso: string, hours: number): string {
  return new Date(Date.parse(baseIso) + hours * HOUR_IN_MS).toISOString();
}

/** Canonical UTC ISO for an instant `minutes` after `baseIso`. */
function isoPlusMinutes(baseIso: string, minutes: number): string {
  return new Date(Date.parse(baseIso) + minutes * 60_000).toISOString();
}

/** Build a forecast with a finite, usable default temperature; overrides win (so `0` sticks). */
function makeForecast(
  overrides: Partial<HourlyForecast> & { forecastAt: string },
): HourlyForecast {
  return {
    condition: 'CLEAR',
    temperatureCelsius: 15,
    feelsLikeCelsius: null,
    precipitationProbabilityPercent: null,
    precipitationAmountMillimeters: null,
    snowfallAmountCentimeters: null,
    humidityPercent: null,
    windSpeedMetersPerSecond: null,
    windDirectionDegrees: null,
    ...overrides,
  };
}

function assess(
  hourlyForecasts: readonly HourlyForecast[],
  evaluatedAt: string = BASE,
): ReturnType<typeof assessOutfitRecommendation> {
  return assessOutfitRecommendation({ evaluatedAt, hourlyForecasts });
}

/** A single usable forecast at +2h with the given effective (feels-like) temperature. */
function singleAt(feelsLikeCelsius: number): HourlyForecast[] {
  return [makeForecast({ forecastAt: isoPlusHours(BASE, 2), feelsLikeCelsius })];
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 1–9: temperature bands and inclusive boundaries
// ---------------------------------------------------------------------------

describe('temperature bands', () => {
  const boundaries: Array<[number, OutfitStatus]> = [
    [-10, 'EXTREME_COLD'], // 1. reference -10 → EXTREME_COLD
    [0, 'VERY_COLD'], // 2. reference 0 → VERY_COLD
    [8, 'COLD'], // 3. reference 8 → COLD
    [14, 'COOL'], // 4. reference 14 → COOL
    [20, 'MILD'], // 5. reference 20 → MILD
    [24, 'WARM'], // 6. reference 24 → WARM
    [28, 'HOT'], // 7. reference 28 → HOT
    [28.1, 'VERY_HOT'], // 8. above 28 → VERY_HOT
  ];

  for (const [reference, status] of boundaries) {
    it(`reference ${reference}°C → ${status} (upper bound inclusive)`, () => {
      const decision = assess(singleAt(reference));
      expect(decision.status).toBe(status);
      expect(decision.evidence.referenceTemperatureCelsius).toBe(reference);
    });
  }

  it('9. just above -10 is VERY_COLD, not EXTREME_COLD', () => {
    expect(assess(singleAt(-9.9)).status).toBe('VERY_COLD');
    // And the lower side of each adjacent band steps down by exactly one classification.
    expect(assess(singleAt(-10.0001)).status).toBe('EXTREME_COLD');
    expect(assess(singleAt(0.1)).status).toBe('COLD');
  });
});

// ---------------------------------------------------------------------------
// 10–13: effective temperature priority
// ---------------------------------------------------------------------------

describe('effective temperature priority', () => {
  it('10. feelsLikeCelsius takes priority over temperatureCelsius', () => {
    const decision = assess([
      makeForecast({
        forecastAt: isoPlusHours(BASE, 2),
        feelsLikeCelsius: 5,
        temperatureCelsius: 25,
      }),
    ]);
    expect(decision.evidence.referenceTemperatureCelsius).toBe(5);
    expect(decision.evidence.referenceTemperatureSource).toBe('FEELS_LIKE');
    expect(decision.status).toBe('COLD');
  });

  it('11. a null feelsLikeCelsius falls back to temperatureCelsius', () => {
    const decision = assess([
      makeForecast({
        forecastAt: isoPlusHours(BASE, 2),
        feelsLikeCelsius: null,
        temperatureCelsius: 10,
      }),
    ]);
    expect(decision.evidence.referenceTemperatureCelsius).toBe(10);
    expect(decision.evidence.referenceTemperatureSource).toBe('AIR_TEMPERATURE');
  });

  it('12. a NaN feelsLikeCelsius falls back to a finite temperatureCelsius', () => {
    const decision = assess([
      makeForecast({
        forecastAt: isoPlusHours(BASE, 2),
        feelsLikeCelsius: Number.NaN,
        temperatureCelsius: 10,
      }),
    ]);
    expect(decision.evidence.referenceTemperatureCelsius).toBe(10);
    expect(decision.evidence.referenceTemperatureSource).toBe('AIR_TEMPERATURE');
  });

  it('13. non-finite feelsLike and temperature make the instant unusable', () => {
    const decision = assess([
      makeForecast({
        forecastAt: isoPlusHours(BASE, 2),
        feelsLikeCelsius: Number.NaN,
        temperatureCelsius: Number.POSITIVE_INFINITY,
      }),
    ]);
    expect(decision.evidence.consideredForecastCount).toBe(1);
    expect(decision.evidence.usableForecastCount).toBe(0);
    expect(decision.status).toBe('INSUFFICIENT_DATA');
    expect(decision.evidence.referenceTemperatureCelsius).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 14–16: reference selection (lowest, earliest, source tie-break)
// ---------------------------------------------------------------------------

describe('reference temperature selection', () => {
  it('14. the lowest representative temperature in the window decides the status', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(BASE, 1), feelsLikeCelsius: 18 }),
      makeForecast({ forecastAt: isoPlusHours(BASE, 2), feelsLikeCelsius: 3 }),
      makeForecast({ forecastAt: isoPlusHours(BASE, 3), feelsLikeCelsius: 12 }),
    ]);
    expect(decision.evidence.referenceTemperatureCelsius).toBe(3);
    expect(decision.evidence.referenceAt).toBe(isoPlusHours(BASE, 2));
    expect(decision.status).toBe('COLD');
  });

  it('15. on a tie for the lowest, the earliest instant is the reference', () => {
    const early = [
      makeForecast({ forecastAt: isoPlusHours(BASE, 2), feelsLikeCelsius: 5 }),
      makeForecast({ forecastAt: isoPlusHours(BASE, 4), feelsLikeCelsius: 5 }),
    ];
    const decision = assess(early);
    expect(decision.evidence.referenceTemperatureCelsius).toBe(5);
    expect(decision.evidence.referenceAt).toBe(isoPlusHours(BASE, 2));
    // Order-independent: reversing the input keeps the earliest instant as reference.
    expect(assess([...early].reverse()).evidence.referenceAt).toBe(
      isoPlusHours(BASE, 2),
    );
  });

  it('16. when a source ties at the minimum, FEELS_LIKE wins the reference source', () => {
    const instant = isoPlusHours(BASE, 2);
    const feelsLikeForecast = makeForecast({
      forecastAt: instant,
      feelsLikeCelsius: 5,
      temperatureCelsius: 25,
    });
    const airForecast = makeForecast({
      forecastAt: instant,
      feelsLikeCelsius: null,
      temperatureCelsius: 5,
    });
    const forward = assess([feelsLikeForecast, airForecast]);
    const reversed = assess([airForecast, feelsLikeForecast]);
    expect(forward.evidence.referenceTemperatureSource).toBe('FEELS_LIKE');
    expect(reversed.evidence.referenceTemperatureSource).toBe('FEELS_LIKE');
    expect(forward).toEqual(reversed);
  });
});

// ---------------------------------------------------------------------------
// 17–19: layering
// ---------------------------------------------------------------------------

describe('layering', () => {
  it('17. a temperature range of exactly 8 recommends layering', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(BASE, 1), feelsLikeCelsius: 10 }),
      makeForecast({ forecastAt: isoPlusHours(BASE, 3), feelsLikeCelsius: 18 }),
    ]);
    expect(decision.evidence.temperatureRangeCelsius).toBe(8);
    expect(decision.layeringRecommended).toBe(true);
    expect(decision.additionalRecommendation).toBe(
      '시간대별 온도 차가 커서 벗고 입기 쉬운 겉옷을 준비하세요.',
    );
  });

  it('18. a temperature range below 8 does not recommend layering', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(BASE, 1), feelsLikeCelsius: 10 }),
      makeForecast({ forecastAt: isoPlusHours(BASE, 3), feelsLikeCelsius: 17 }),
    ]);
    expect(decision.evidence.temperatureRangeCelsius).toBe(7);
    expect(decision.layeringRecommended).toBe(false);
    expect(decision.additionalRecommendation).toBeNull();
  });

  it('19. a null range disables layering and clears the additional recommendation', () => {
    const decision = assess([]);
    expect(decision.evidence.temperatureRangeCelsius).toBeNull();
    expect(decision.layeringRecommended).toBe(false);
    expect(decision.additionalRecommendation).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 20–23: data quality
// ---------------------------------------------------------------------------

describe('data quality', () => {
  it('20. sparse usable data still returns a recommendation with LIMITED quality', () => {
    const decision = assess(singleAt(10));
    expect(decision.status).toBe('COOL');
    expect(decision.dataQuality).toBe('LIMITED');
  });

  it('21. three usable instants with the last at exactly +2h → SUFFICIENT', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(BASE, 1), feelsLikeCelsius: 15 }),
      makeForecast({ forecastAt: isoPlusMinutes(BASE, 90), feelsLikeCelsius: 15 }),
      makeForecast({ forecastAt: isoPlusHours(BASE, 2), feelsLikeCelsius: 15 }),
    ]);
    expect(decision.evidence.usableForecastCount).toBe(3);
    expect(decision.dataQuality).toBe('SUFFICIENT');
  });

  it('22. three usable instants but the last is under +2h → LIMITED', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusMinutes(BASE, 30), feelsLikeCelsius: 15 }),
      makeForecast({ forecastAt: isoPlusHours(BASE, 1), feelsLikeCelsius: 15 }),
      makeForecast({ forecastAt: isoPlusMinutes(BASE, 90), feelsLikeCelsius: 15 }),
    ]);
    expect(decision.evidence.usableForecastCount).toBe(3);
    expect(decision.dataQuality).toBe('LIMITED');
  });

  it('23. no usable instant → INSUFFICIENT_DATA / INSUFFICIENT', () => {
    const decision = assess([
      makeForecast({
        forecastAt: isoPlusHours(BASE, 2),
        feelsLikeCelsius: Number.NaN,
        temperatureCelsius: Number.NaN,
      }),
    ]);
    expect(decision.status).toBe('INSUFFICIENT_DATA');
    expect(decision.dataQuality).toBe('INSUFFICIENT');
    expect(decision.reasonCode).toBe('INSUFFICIENT_FORECAST');
  });
});

// ---------------------------------------------------------------------------
// 24–26: evaluation window bounds
// ---------------------------------------------------------------------------

describe('evaluation window', () => {
  it('24. past forecasts are excluded', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(BASE, -2), feelsLikeCelsius: -5 }),
    ]);
    expect(decision.evidence.consideredForecastCount).toBe(0);
    expect(decision.status).toBe('INSUFFICIENT_DATA');
  });

  it('25. a forecast at exactly +6h is included', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(BASE, 6), feelsLikeCelsius: 10 }),
    ]);
    expect(decision.evidence.consideredForecastCount).toBe(1);
    expect(decision.evidence.usableForecastCount).toBe(1);
    expect(decision.evidence.referenceAt).toBe(isoPlusHours(BASE, 6));
    expect(decision.status).toBe('COOL');
  });

  it('26. a forecast beyond +6h is excluded', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusMinutes(BASE, 361), feelsLikeCelsius: 10 }),
    ]);
    expect(decision.evidence.consideredForecastCount).toBe(0);
    expect(decision.status).toBe('INSUFFICIENT_DATA');
  });
});

// ---------------------------------------------------------------------------
// 27–32: ordering, duplicates, distinct-instant counts, purity
// ---------------------------------------------------------------------------

describe('ordering, duplicates and purity', () => {
  const sorted = [
    makeForecast({ forecastAt: isoPlusHours(BASE, 1), feelsLikeCelsius: 12 }),
    makeForecast({ forecastAt: isoPlusHours(BASE, 2), feelsLikeCelsius: 6 }),
    makeForecast({ forecastAt: isoPlusHours(BASE, 3), feelsLikeCelsius: 18 }),
  ];

  it('27. an unsorted input yields the same result as a sorted one', () => {
    const shuffled = [sorted[2], sorted[0], sorted[1]];
    expect(assess(shuffled)).toEqual(assess(sorted));
  });

  it('28. duplicate instants are order-independent', () => {
    const instant = isoPlusHours(BASE, 2);
    const a = makeForecast({ forecastAt: instant, feelsLikeCelsius: 6 });
    const b = makeForecast({ forecastAt: instant, feelsLikeCelsius: 14 });
    expect(assess([a, b])).toEqual(assess([b, a]));
  });

  it('29. a duplicate instant keeps the lowest effective temperature', () => {
    const instant = isoPlusHours(BASE, 2);
    const warm = makeForecast({ forecastAt: instant, feelsLikeCelsius: 15 });
    const cold = makeForecast({ forecastAt: instant, feelsLikeCelsius: 5 });
    const decision = assess([warm, cold]);
    expect(decision.evidence.referenceTemperatureCelsius).toBe(5);
    expect(decision.evidence.consideredForecastCount).toBe(1);
    expect(decision.evidence.usableForecastCount).toBe(1);
  });

  it('30. different timezone spellings of one instant collapse to a single instant', () => {
    // 2026-07-15T21:30:00+09:00 is the same absolute instant as 12:30:00Z.
    const utcForm = makeForecast({
      forecastAt: '2026-07-15T12:30:00Z',
      feelsLikeCelsius: 10,
    });
    const offsetForm = makeForecast({
      forecastAt: '2026-07-15T21:30:00+09:00',
      feelsLikeCelsius: 4,
    });
    const decision = assess([utcForm, offsetForm]);
    expect(decision.evidence.consideredForecastCount).toBe(1);
    expect(decision.evidence.usableForecastCount).toBe(1);
    expect(decision.evidence.referenceTemperatureCelsius).toBe(4);
    expect(assess([utcForm, offsetForm])).toEqual(assess([offsetForm, utcForm]));
  });

  it('31. considered and usable counts are over distinct instants', () => {
    const instant = isoPlusHours(BASE, 2);
    const decision = assess([
      makeForecast({ forecastAt: instant, feelsLikeCelsius: 10 }),
      makeForecast({ forecastAt: instant, feelsLikeCelsius: 12 }),
      makeForecast({ forecastAt: isoPlusHours(BASE, 3), feelsLikeCelsius: 11 }),
      makeForecast({
        forecastAt: isoPlusHours(BASE, 4),
        feelsLikeCelsius: Number.NaN,
        temperatureCelsius: Number.NaN,
      }),
    ]);
    expect(decision.evidence.consideredForecastCount).toBe(3);
    expect(decision.evidence.usableForecastCount).toBe(2);
  });

  it('32. neither the input array nor its objects are mutated', () => {
    const forecasts = [
      makeForecast({ forecastAt: isoPlusHours(BASE, 3), feelsLikeCelsius: 18 }),
      makeForecast({ forecastAt: isoPlusHours(BASE, 1), feelsLikeCelsius: 5 }),
    ];
    const snapshot = JSON.parse(JSON.stringify(forecasts)) as HourlyForecast[];
    Object.freeze(forecasts);
    forecasts.forEach((forecast) => Object.freeze(forecast));

    expect(() =>
      assessOutfitRecommendation({ evaluatedAt: BASE, hourlyForecasts: forecasts }),
    ).not.toThrow();
    expect(forecasts).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// 33–38: input validation and canonical timestamps
// ---------------------------------------------------------------------------

describe('input validation and timestamps', () => {
  it('33. an invalid evaluatedAt throws a fixed RangeError that does not echo the input', () => {
    const invalidInputs = [
      'not-a-date',
      '2026-07-15T12:00Z', // no seconds
      '2026-07-15', // date only
      '2026-07-15T12:00:00', // no timezone
      '2026-13-45T99:99:99Z', // impossible components
      '',
    ];
    for (const evaluatedAt of invalidInputs) {
      expect(() =>
        assessOutfitRecommendation({ evaluatedAt, hourlyForecasts: [] }),
      ).toThrow(RangeError);
    }

    let caught: unknown;
    try {
      assessOutfitRecommendation({
        evaluatedAt: '2026-13-45T99:99:99Z',
        hourlyForecasts: [],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RangeError);
    expect((caught as RangeError).message).toBe(
      'evaluatedAt must be an ISO 8601 datetime with a timezone designator',
    );
    expect((caught as RangeError).message).not.toContain('2026-13-45');
  });

  it('34. an invalid individual forecastAt is excluded without crashing the function', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(BASE, 1), feelsLikeCelsius: 12 }),
      makeForecast({ forecastAt: isoPlusHours(BASE, 2), feelsLikeCelsius: 6 }),
      makeForecast({ forecastAt: 'garbage-timestamp', feelsLikeCelsius: -30 }),
      // A runtime-invalid (non-string) forecastAt is also tolerated.
      {
        ...makeForecast({ forecastAt: BASE }),
        forecastAt: null,
      } as unknown as HourlyForecast,
    ]);
    expect(decision.evidence.consideredForecastCount).toBe(2);
    expect(decision.evidence.usableForecastCount).toBe(2);
    // The -30°C forecast with an invalid timestamp must not drive the reference.
    expect(decision.evidence.referenceTemperatureCelsius).toBe(6);
    expect(decision.status).toBe('COLD');
  });

  it('35. seconds and exactly-3-digit millisecond ISO datetimes are accepted', () => {
    const secondsDecision = assess(
      [makeForecast({ forecastAt: '2026-07-15T12:30:00Z', feelsLikeCelsius: 10 })],
      '2026-07-15T12:00:00Z',
    );
    const millisDecision = assess(
      [makeForecast({ forecastAt: '2026-07-15T12:30:00.500Z', feelsLikeCelsius: 10 })],
      '2026-07-15T12:00:00.000Z',
    );
    expect(secondsDecision.evidence.usableForecastCount).toBe(1);
    expect(millisDecision.evidence.usableForecastCount).toBe(1);
  });

  it('36. timezone-less and minute-precision datetimes are rejected', () => {
    for (const evaluatedAt of ['2026-07-15T12:00:00', '2026-07-15T12:00Z']) {
      expect(() =>
        assessOutfitRecommendation({ evaluatedAt, hourlyForecasts: [] }),
      ).toThrow(RangeError);
    }
    // A bad forecastAt of these shapes is dropped rather than throwing.
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(BASE, 2), feelsLikeCelsius: 10 }),
      makeForecast({ forecastAt: '2026-07-15T13:00:00', feelsLikeCelsius: -20 }),
      makeForecast({ forecastAt: '2026-07-15T13:00Z', feelsLikeCelsius: -20 }),
    ]);
    expect(decision.evidence.consideredForecastCount).toBe(1);
    expect(decision.evidence.referenceTemperatureCelsius).toBe(10);
  });

  it('37. impossible calendar dates are rejected', () => {
    expect(() =>
      assessOutfitRecommendation({
        evaluatedAt: '2026-02-30T12:00:00Z',
        hourlyForecasts: [],
      }),
    ).toThrow(RangeError);
    // A bad forecastAt calendar date is dropped, not thrown.
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(BASE, 2), feelsLikeCelsius: 10 }),
      makeForecast({ forecastAt: '2026-02-30T12:30:00Z', feelsLikeCelsius: -20 }),
    ]);
    expect(decision.evidence.consideredForecastCount).toBe(1);
  });

  it('38. evidence timestamps are canonical UTC even for offset inputs', () => {
    const decision = assess(
      [makeForecast({ forecastAt: '2026-07-15T21:30:00+09:00', feelsLikeCelsius: 10 })],
      '2026-07-15T21:00:00+09:00',
    );
    expect(decision.evidence.windowStartAt).toBe('2026-07-15T12:00:00.000Z');
    expect(decision.evidence.windowEndAt).toBe('2026-07-15T18:00:00.000Z');
    expect(decision.evidence.referenceAt).toBe('2026-07-15T12:30:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// 39–40: user-facing copy and output shape
// ---------------------------------------------------------------------------

describe('user-facing copy and output shape', () => {
  const scenarios: Record<OutfitStatus, HourlyForecast[]> = {
    EXTREME_COLD: singleAt(-15),
    VERY_COLD: singleAt(-5),
    COLD: singleAt(5),
    COOL: singleAt(12),
    MILD: singleAt(18),
    WARM: singleAt(22),
    HOT: singleAt(26),
    VERY_HOT: singleAt(32),
    INSUFFICIENT_DATA: [],
  };

  const expectedCopy: Record<
    OutfitStatus,
    { reasonCode: string; reason: string; recommendation: string }
  > = {
    EXTREME_COLD: {
      reasonCode: 'EXTREME_COLD_CONDITIONS',
      reason: '앞으로 6시간 동안 매우 추운 날씨가 예상됩니다.',
      recommendation: '두꺼운 패딩과 보온 내의를 착용하세요.',
    },
    VERY_COLD: {
      reasonCode: 'VERY_COLD_CONDITIONS',
      reason: '앞으로 6시간 동안 영하권 또는 매우 낮은 기온이 예상됩니다.',
      recommendation: '패딩이나 두꺼운 코트와 보온용품을 준비하세요.',
    },
    COLD: {
      reasonCode: 'COLD_CONDITIONS',
      reason: '앞으로 6시간 동안 쌀쌀한 날씨가 예상됩니다.',
      recommendation: '코트나 두꺼운 재킷을 입으세요.',
    },
    COOL: {
      reasonCode: 'COOL_CONDITIONS',
      reason: '앞으로 6시간 동안 서늘한 날씨가 예상됩니다.',
      recommendation: '재킷이나 가벼운 코트를 걸치세요.',
    },
    MILD: {
      reasonCode: 'MILD_CONDITIONS',
      reason: '앞으로 6시간 동안 비교적 온화한 날씨가 예상됩니다.',
      recommendation: '긴소매 옷이나 얇은 겉옷이 적절합니다.',
    },
    WARM: {
      reasonCode: 'WARM_CONDITIONS',
      reason: '앞으로 6시간 동안 따뜻한 날씨가 예상됩니다.',
      recommendation: '얇은 긴소매나 반소매 옷이 적절합니다.',
    },
    HOT: {
      reasonCode: 'HOT_CONDITIONS',
      reason: '앞으로 6시간 동안 더운 날씨가 예상됩니다.',
      recommendation: '가볍고 통풍이 잘되는 옷을 입으세요.',
    },
    VERY_HOT: {
      reasonCode: 'VERY_HOT_CONDITIONS',
      reason: '앞으로 6시간 동안 매우 더운 날씨가 예상됩니다.',
      recommendation: '매우 가볍고 통풍이 잘되는 옷을 입고 더위에 대비하세요.',
    },
    INSUFFICIENT_DATA: {
      reasonCode: 'INSUFFICIENT_FORECAST',
      reason: '옷차림을 판단할 온도 예보가 부족합니다.',
      recommendation: '최신 기온과 체감온도를 다시 확인하세요.',
    },
  };

  it('39. reason, recommendation and reasonCode correspond exactly to each status', () => {
    for (const status of Object.keys(scenarios) as OutfitStatus[]) {
      const decision = assess(scenarios[status]);
      expect(decision.status).toBe(status);
      expect(decision.reasonCode).toBe(expectedCopy[status].reasonCode);
      expect(decision.reason).toBe(expectedCopy[status].reason);
      expect(decision.recommendation).toBe(expectedCopy[status].recommendation);
    }
  });

  it('40. extra properties on the input are not copied into the result', () => {
    const forecast = {
      ...makeForecast({ forecastAt: isoPlusHours(BASE, 2), feelsLikeCelsius: 5 }),
      leakedField: 'SHOULD_NOT_APPEAR',
    } as unknown as HourlyForecast;
    const input = {
      evaluatedAt: BASE,
      hourlyForecasts: [forecast],
      leakedTopLevel: 'SHOULD_NOT_APPEAR',
    } as unknown as OutfitAssessmentInput;

    const decision = assessOutfitRecommendation(input);
    expect(JSON.stringify(decision)).not.toContain('SHOULD_NOT_APPEAR');
    expect(Object.keys(decision.evidence).sort()).toEqual(
      [
        'consideredForecastCount',
        'maximumEffectiveTemperatureCelsius',
        'minimumEffectiveTemperatureCelsius',
        'referenceAt',
        'referenceTemperatureCelsius',
        'referenceTemperatureSource',
        'temperatureRangeCelsius',
        'usableForecastCount',
        'windowEndAt',
        'windowStartAt',
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// 41–44: purity, policy stability, precision, temperature-only sensitivity
// ---------------------------------------------------------------------------

describe('purity, policy and precision', () => {
  it('41. does not call Date.now, the network, or otherwise behave non-deterministically', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    const fetchSpy = vi.fn(() => {
      throw new Error('network access is not allowed');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const forecasts = [
      makeForecast({ forecastAt: isoPlusHours(BASE, 1), feelsLikeCelsius: 12 }),
      makeForecast({ forecastAt: isoPlusHours(BASE, 3), feelsLikeCelsius: 6 }),
    ];
    const first = assess(forecasts);
    const second = assess(forecasts);

    expect(nowSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(first).toEqual(second);
  });

  it('42. the policy constants are frozen and the version is returned stably', () => {
    expect(OUTFIT_POLICY).toEqual({
      policyVersion: '1.0.0',
      assessmentWindowHours: 6,
      minimumForecastCount: 3,
      minimumCoverageHours: 2,
      layeringTemperatureRangeThresholdCelsius: 8,
      extremeColdMaximumCelsius: -10,
      veryColdMaximumCelsius: 0,
      coldMaximumCelsius: 8,
      coolMaximumCelsius: 14,
      mildMaximumCelsius: 20,
      warmMaximumCelsius: 24,
      hotMaximumCelsius: 28,
    });
    expect(Object.isFrozen(OUTFIT_POLICY)).toBe(true);
    expect(() => {
      (OUTFIT_POLICY as { assessmentWindowHours: number }).assessmentWindowHours = 99;
    }).toThrow();

    expect(assess(singleAt(5)).policyVersion).toBe('1.0.0');
  });

  it('43. temperatures are not rounded — input precision is preserved', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(BASE, 1), feelsLikeCelsius: 13.7 }),
      makeForecast({ forecastAt: isoPlusHours(BASE, 3), feelsLikeCelsius: 22.25 }),
    ]);
    expect(decision.evidence.referenceTemperatureCelsius).toBe(13.7);
    expect(decision.evidence.minimumEffectiveTemperatureCelsius).toBe(13.7);
    expect(decision.evidence.maximumEffectiveTemperatureCelsius).toBe(22.25);
    expect(decision.evidence.temperatureRangeCelsius).toBeCloseTo(8.55, 10);
  });

  it('44. condition/precipitation/humidity/wind do not change the result at equal temperatures', () => {
    const plain = [
      makeForecast({ forecastAt: isoPlusHours(BASE, 2), feelsLikeCelsius: 6 }),
    ];
    const decorated = [
      makeForecast({
        forecastAt: isoPlusHours(BASE, 2),
        feelsLikeCelsius: 6,
        condition: 'THUNDERSTORM',
        precipitationProbabilityPercent: 90,
        precipitationAmountMillimeters: 12,
        snowfallAmountCentimeters: 3,
        humidityPercent: 95,
        windSpeedMetersPerSecond: 14,
        windDirectionDegrees: 270,
      }),
    ];
    expect(assess(decorated)).toEqual(assess(plain));
  });
});
