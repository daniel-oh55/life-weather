import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HourlyForecast } from '@life-weather/contracts';

import {
  assessUmbrellaNeed,
  UMBRELLA_POLICY,
  type UmbrellaAssessmentInput,
  type UmbrellaStatus,
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

/** Build a forecast with dry, defined defaults; overrides win (so `0` is honored). */
function makeForecast(
  overrides: Partial<HourlyForecast> & { forecastAt: string },
): HourlyForecast {
  return {
    condition: 'CLEAR',
    temperatureCelsius: 20,
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

/** `count` dry, usable (CLEAR) forecasts at +1h, +2h, ... hours from BASE. */
function dryHourlyForecasts(count: number): HourlyForecast[] {
  return Array.from({ length: count }, (_, index) =>
    makeForecast({ forecastAt: isoPlusHours(BASE, index + 1) }),
  );
}

function assess(hourlyForecasts: readonly HourlyForecast[]): ReturnType<
  typeof assessUmbrellaNeed
> {
  return assessUmbrellaNeed({ evaluatedAt: BASE, hourlyForecasts });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 1–14: precipitation signal classification and priority
// ---------------------------------------------------------------------------

describe('signal classification and decision priority', () => {
  it('1. rain at the current instant → REQUIRED_NOW', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusMinutes(BASE, 30), condition: 'RAIN' }),
    ]);
    expect(decision.status).toBe('REQUIRED_NOW');
    expect(decision.reasonCode).toBe('PRECIPITATION_IMMINENT');
  });

  it('2. probability of exactly 60% within 1h → REQUIRED_NOW', () => {
    const decision = assess([
      makeForecast({
        forecastAt: isoPlusMinutes(BASE, 30),
        condition: 'CLOUDY',
        precipitationProbabilityPercent: 60,
      }),
    ]);
    expect(decision.status).toBe('REQUIRED_NOW');
  });

  it('3. the 1h boundary is inclusive (strong signal at +1h → REQUIRED_NOW)', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(BASE, 1), condition: 'RAIN' }),
    ]);
    expect(decision.status).toBe('REQUIRED_NOW');
  });

  it('4. a strong signal after 1h → REQUIRED_LATER', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(BASE, 3), condition: 'RAIN' }),
    ]);
    expect(decision.status).toBe('REQUIRED_LATER');
    expect(decision.reasonCode).toBe('PRECIPITATION_LATER');
  });

  it('5. a strong signal at exactly +12h is included', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(BASE, 12), condition: 'RAIN' }),
    ]);
    expect(decision.status).toBe('REQUIRED_LATER');
    expect(decision.evidence.firstRiskAt).toBe(isoPlusHours(BASE, 12));
  });

  it('6. a strong signal beyond +12h is excluded', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(BASE, 13), condition: 'RAIN' }),
    ]);
    expect(decision.status).toBe('INSUFFICIENT_DATA');
    expect(decision.evidence.consideredForecastCount).toBe(0);
    expect(decision.evidence.firstRiskAt).toBeNull();
  });

  it('7. probability of exactly 30% → RECOMMENDED', () => {
    const decision = assess([
      makeForecast({
        forecastAt: isoPlusHours(BASE, 2),
        condition: 'CLOUDY',
        precipitationProbabilityPercent: 30,
      }),
    ]);
    expect(decision.status).toBe('RECOMMENDED');
    expect(decision.reasonCode).toBe('PRECIPITATION_POSSIBLE');
  });

  it('8. probability of 59% → RECOMMENDED', () => {
    const decision = assess([
      makeForecast({
        forecastAt: isoPlusHours(BASE, 2),
        condition: 'CLOUDY',
        precipitationProbabilityPercent: 59,
      }),
    ]);
    expect(decision.status).toBe('RECOMMENDED');
  });

  it('9. probability of 29% is not a signal (does not trigger RECOMMENDED)', () => {
    const forecasts = Array.from({ length: 6 }, (_, index) =>
      makeForecast({
        forecastAt: isoPlusHours(BASE, index + 1),
        condition: 'CLOUDY',
        precipitationProbabilityPercent: 29,
      }),
    );
    const decision = assess(forecasts);
    expect(decision.status).toBe('NOT_NEEDED');
    expect(decision.evidence.firstRiskAt).toBeNull();
  });

  it('10. positive precipitation amount with null probability is a strong signal', () => {
    const decision = assess([
      makeForecast({
        forecastAt: isoPlusMinutes(BASE, 30),
        condition: 'CLOUDY',
        precipitationProbabilityPercent: null,
        precipitationAmountMillimeters: 0.4,
      }),
    ]);
    expect(decision.status).toBe('REQUIRED_NOW');
  });

  it('11. positive snowfall amount is a strong signal', () => {
    const decision = assess([
      makeForecast({
        forecastAt: isoPlusHours(BASE, 2),
        condition: 'CLOUDY',
        snowfallAmountCentimeters: 0.5,
      }),
    ]);
    expect(decision.status).toBe('REQUIRED_LATER');
  });

  it('12. precipitation and snowfall of exactly 0 are not signals', () => {
    const forecasts = Array.from({ length: 6 }, (_, index) =>
      makeForecast({
        forecastAt: isoPlusHours(BASE, index + 1),
        condition: 'CLEAR',
        precipitationProbabilityPercent: 0,
        precipitationAmountMillimeters: 0,
        snowfallAmountCentimeters: 0,
      }),
    );
    const decision = assess(forecasts);
    expect(decision.status).toBe('NOT_NEEDED');
    expect(decision.evidence.firstRiskAt).toBeNull();
    expect(decision.evidence.peakPrecipitationAmountMillimeters).toBe(0);
    expect(decision.evidence.peakSnowfallAmountCentimeters).toBe(0);
  });

  it('13. THUNDERSTORM, SHOWER and SLEET are treated as precipitation', () => {
    for (const condition of ['THUNDERSTORM', 'SHOWER', 'SLEET'] as const) {
      const decision = assess([
        makeForecast({ forecastAt: isoPlusMinutes(BASE, 30), condition }),
      ]);
      expect(decision.status).toBe('REQUIRED_NOW');
    }
  });

  it('14. FOG and CLOUDY are not precipitation conditions', () => {
    for (const condition of ['FOG', 'CLOUDY'] as const) {
      const forecasts = Array.from({ length: 6 }, (_, index) =>
        makeForecast({ forecastAt: isoPlusHours(BASE, index + 1), condition }),
      );
      const decision = assess(forecasts);
      expect(decision.status).toBe('NOT_NEEDED');
      expect(decision.evidence.firstRiskAt).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// 15–19: window bounds, dry coverage and data quality
// ---------------------------------------------------------------------------

describe('window bounds, coverage and data quality', () => {
  it('15. past forecasts are excluded', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(BASE, -2), condition: 'RAIN' }),
    ]);
    expect(decision.status).toBe('INSUFFICIENT_DATA');
    expect(decision.evidence.consideredForecastCount).toBe(0);
    expect(decision.evidence.firstRiskAt).toBeNull();
  });

  it('16. sufficient dry coverage → NOT_NEEDED / SUFFICIENT', () => {
    const decision = assess(dryHourlyForecasts(6));
    expect(decision.status).toBe('NOT_NEEDED');
    expect(decision.dataQuality).toBe('SUFFICIENT');

    // The +5h coverage boundary is inclusive: 6 forecasts whose last is exactly +5h suffices.
    const atBoundary = [
      makeForecast({ forecastAt: isoPlusMinutes(BASE, 30) }),
      makeForecast({ forecastAt: isoPlusHours(BASE, 1) }),
      makeForecast({ forecastAt: isoPlusHours(BASE, 2) }),
      makeForecast({ forecastAt: isoPlusHours(BASE, 3) }),
      makeForecast({ forecastAt: isoPlusHours(BASE, 4) }),
      makeForecast({ forecastAt: isoPlusHours(BASE, 5) }),
    ];
    const boundaryDecision = assess(atBoundary);
    expect(boundaryDecision.status).toBe('NOT_NEEDED');
    expect(boundaryDecision.dataQuality).toBe('SUFFICIENT');
  });

  it('17. dry but insufficient coverage → INSUFFICIENT_DATA / INSUFFICIENT', () => {
    // (a) too few usable forecasts.
    const tooFew = assess(dryHourlyForecasts(3));
    expect(tooFew.status).toBe('INSUFFICIENT_DATA');
    expect(tooFew.dataQuality).toBe('INSUFFICIENT');

    // (b) enough forecasts, but the coverage span is under 5h.
    const shortSpan = [
      makeForecast({ forecastAt: isoPlusMinutes(BASE, 30) }),
      makeForecast({ forecastAt: isoPlusHours(BASE, 1) }),
      makeForecast({ forecastAt: isoPlusHours(BASE, 2) }),
      makeForecast({ forecastAt: isoPlusHours(BASE, 3) }),
      makeForecast({ forecastAt: isoPlusHours(BASE, 4) }),
      makeForecast({ forecastAt: isoPlusMinutes(BASE, 270) }), // +4.5h
    ];
    const shortSpanDecision = assess(shortSpan);
    expect(shortSpanDecision.evidence.usableForecastCount).toBe(6);
    expect(shortSpanDecision.status).toBe('INSUFFICIENT_DATA');
  });

  it('18. UNKNOWN with all precipitation fields null is unusable', () => {
    const forecasts = [
      ...dryHourlyForecasts(6),
      makeForecast({
        forecastAt: isoPlusHours(BASE, 7),
        condition: 'UNKNOWN',
        precipitationProbabilityPercent: null,
        precipitationAmountMillimeters: null,
        snowfallAmountCentimeters: null,
      }),
    ];
    const decision = assess(forecasts);
    expect(decision.evidence.consideredForecastCount).toBe(7);
    expect(decision.evidence.usableForecastCount).toBe(6);
    expect(decision.status).toBe('NOT_NEEDED');
  });

  it('19. a precipitation signal in sparse data still recommends an umbrella (LIMITED)', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusMinutes(BASE, 30), condition: 'RAIN' }),
    ]);
    expect(decision.status).toBe('REQUIRED_NOW');
    expect(decision.dataQuality).toBe('LIMITED');
  });
});

// ---------------------------------------------------------------------------
// 20–24: ordering, duplicates, evidence
// ---------------------------------------------------------------------------

describe('ordering, duplicates and evidence', () => {
  it('20. an unsorted input yields the same result as a sorted one', () => {
    const sorted = [
      makeForecast({ forecastAt: isoPlusHours(BASE, 1) }),
      makeForecast({
        forecastAt: isoPlusHours(BASE, 2),
        condition: 'CLOUDY',
        precipitationProbabilityPercent: 40,
      }),
      makeForecast({ forecastAt: isoPlusHours(BASE, 3) }),
      makeForecast({ forecastAt: isoPlusHours(BASE, 4) }),
      makeForecast({ forecastAt: isoPlusHours(BASE, 5) }),
      makeForecast({ forecastAt: isoPlusHours(BASE, 6) }),
    ];
    const shuffled = [sorted[4], sorted[0], sorted[3], sorted[1], sorted[5], sorted[2]];
    expect(assess(shuffled)).toEqual(assess(sorted));
  });

  it('21. duplicate forecastAt is order-independent (strongest signal + max evidence win)', () => {
    const instant = isoPlusMinutes(BASE, 30);
    const strong = makeForecast({
      forecastAt: instant,
      condition: 'RAIN',
      precipitationProbabilityPercent: 70,
    });
    const weak = makeForecast({
      forecastAt: instant,
      condition: 'CLEAR',
      precipitationProbabilityPercent: 40,
    });
    const decisionA = assess([strong, weak]);
    const decisionB = assess([weak, strong]);
    expect(decisionA).toEqual(decisionB);
    expect(decisionA.status).toBe('REQUIRED_NOW');
    expect(decisionA.evidence.peakPrecipitationProbabilityPercent).toBe(70);
    expect(decisionA.evidence.consideredForecastCount).toBe(1);
  });

  it('22. neither the input array nor its objects are mutated', () => {
    const forecasts = [
      makeForecast({ forecastAt: isoPlusHours(BASE, 2), condition: 'RAIN' }),
      makeForecast({ forecastAt: isoPlusHours(BASE, 1) }),
    ];
    const snapshot = JSON.parse(JSON.stringify(forecasts)) as HourlyForecast[];
    Object.freeze(forecasts);
    forecasts.forEach((forecast) => Object.freeze(forecast));

    expect(() =>
      assessUmbrellaNeed({ evaluatedAt: BASE, hourlyForecasts: forecasts }),
    ).not.toThrow();
    expect(forecasts).toEqual(snapshot);
  });

  it('23. peak evidence ignores nulls and returns the maximum', () => {
    const forecasts = [
      makeForecast({
        forecastAt: isoPlusHours(BASE, 1),
        condition: 'CLOUDY',
        precipitationProbabilityPercent: null,
        precipitationAmountMillimeters: null,
        snowfallAmountCentimeters: null,
      }),
      makeForecast({
        forecastAt: isoPlusHours(BASE, 2),
        condition: 'CLOUDY',
        precipitationProbabilityPercent: 40,
        precipitationAmountMillimeters: 1.5,
      }),
      makeForecast({
        forecastAt: isoPlusHours(BASE, 3),
        condition: 'CLOUDY',
        precipitationProbabilityPercent: 20,
        precipitationAmountMillimeters: 0.2,
      }),
    ];
    const decision = assess(forecasts);
    expect(decision.evidence.peakPrecipitationProbabilityPercent).toBe(40);
    expect(decision.evidence.peakPrecipitationAmountMillimeters).toBe(1.5);
    expect(decision.evidence.peakSnowfallAmountCentimeters).toBeNull();
  });

  it('24. firstRiskAt is the earliest moderate-or-strong signal instant', () => {
    const forecasts = [
      makeForecast({ forecastAt: isoPlusHours(BASE, 1) }),
      makeForecast({
        forecastAt: isoPlusHours(BASE, 3),
        condition: 'CLOUDY',
        precipitationProbabilityPercent: 40,
      }),
      makeForecast({ forecastAt: isoPlusHours(BASE, 5), condition: 'RAIN' }),
    ];
    const decision = assess(forecasts);
    expect(decision.status).toBe('REQUIRED_LATER');
    expect(decision.evidence.firstRiskAt).toBe(isoPlusHours(BASE, 3));
  });
});

// ---------------------------------------------------------------------------
// 25–28: robustness, purity, policy stability
// ---------------------------------------------------------------------------

describe('robustness, purity and policy', () => {
  it('25. an invalid evaluatedAt throws a fixed RangeError that does not echo the input', () => {
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
        assessUmbrellaNeed({ evaluatedAt, hourlyForecasts: [] }),
      ).toThrow(RangeError);
    }

    let caught: unknown;
    try {
      assessUmbrellaNeed({ evaluatedAt: '2026-13-45T99:99:99Z', hourlyForecasts: [] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RangeError);
    expect((caught as RangeError).message).toBe(
      'evaluatedAt must be an ISO 8601 datetime with a timezone designator',
    );
    expect((caught as RangeError).message).not.toContain('2026-13-45');
  });

  it('26. an invalid individual forecastAt is excluded without crashing the function', () => {
    const forecasts = [
      ...dryHourlyForecasts(6),
      makeForecast({ forecastAt: 'garbage-timestamp', condition: 'RAIN' }),
      // A runtime-invalid (non-string) forecastAt is also tolerated.
      { ...makeForecast({ forecastAt: BASE }), forecastAt: null } as unknown as HourlyForecast,
    ];
    const decision = assess(forecasts);
    expect(decision.evidence.consideredForecastCount).toBe(6);
    expect(decision.evidence.usableForecastCount).toBe(6);
    // The RAIN forecast with an invalid timestamp must not force an umbrella.
    expect(decision.status).toBe('NOT_NEEDED');
  });

  it('27. does not call Date.now, the network, or otherwise behave non-deterministically', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    const fetchSpy = vi.fn(() => {
      throw new Error('network access is not allowed');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const forecasts = [
      makeForecast({ forecastAt: isoPlusHours(BASE, 2), condition: 'RAIN' }),
      ...dryHourlyForecasts(6),
    ];
    const first = assess(forecasts);
    const second = assess(forecasts);

    expect(nowSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(first).toEqual(second);
  });

  it('28. the policy version and constants are frozen and returned stably', () => {
    expect(UMBRELLA_POLICY).toEqual({
      policyVersion: '1.0.0',
      assessmentWindowHours: 12,
      immediateWindowHours: 1,
      highProbabilityThresholdPercent: 60,
      moderateProbabilityThresholdPercent: 30,
      minimumDryForecastCount: 6,
      minimumDryCoverageHours: 5,
    });
    expect(Object.isFrozen(UMBRELLA_POLICY)).toBe(true);
    expect(() => {
      (UMBRELLA_POLICY as { assessmentWindowHours: number }).assessmentWindowHours = 99;
    }).toThrow();

    const decision = assess([makeForecast({ forecastAt: isoPlusHours(BASE, 2), condition: 'RAIN' })]);
    expect(decision.policyVersion).toBe('1.0.0');
  });
});

// ---------------------------------------------------------------------------
// 29–30: user-facing copy and output shape
// ---------------------------------------------------------------------------

describe('user-facing copy and output shape', () => {
  const scenarios: Record<UmbrellaStatus, HourlyForecast[]> = {
    REQUIRED_NOW: [makeForecast({ forecastAt: isoPlusMinutes(BASE, 30), condition: 'RAIN' })],
    REQUIRED_LATER: [makeForecast({ forecastAt: isoPlusHours(BASE, 3), condition: 'RAIN' })],
    RECOMMENDED: [
      makeForecast({
        forecastAt: isoPlusHours(BASE, 2),
        condition: 'CLOUDY',
        precipitationProbabilityPercent: 40,
      }),
    ],
    NOT_NEEDED: dryHourlyForecasts(6),
    INSUFFICIENT_DATA: dryHourlyForecasts(2),
  };

  const expectedCopy: Record<
    UmbrellaStatus,
    { reasonCode: string; reason: string; recommendation: string }
  > = {
    REQUIRED_NOW: {
      reasonCode: 'PRECIPITATION_IMMINENT',
      reason: '현재부터 1시간 이내에 비나 눈이 예상됩니다.',
      recommendation: '외출할 때 우산을 꼭 챙기세요.',
    },
    REQUIRED_LATER: {
      reasonCode: 'PRECIPITATION_LATER',
      reason: '앞으로 12시간 안에 비나 눈 가능성이 높습니다.',
      recommendation: '지금 비가 오지 않아도 우산을 준비하세요.',
    },
    RECOMMENDED: {
      reasonCode: 'PRECIPITATION_POSSIBLE',
      reason: '앞으로 12시간 동안 비나 눈 가능성이 있습니다.',
      recommendation: '접이식 우산을 챙기면 좋습니다.',
    },
    NOT_NEEDED: {
      reasonCode: 'LOW_PRECIPITATION_RISK',
      reason: '확인 가능한 예보에서 비나 눈 가능성이 낮습니다.',
      recommendation: '우산 없이 외출해도 무리가 적겠습니다.',
    },
    INSUFFICIENT_DATA: {
      reasonCode: 'INSUFFICIENT_FORECAST',
      reason: '우산 필요 여부를 판단할 예보가 부족합니다.',
      recommendation: '최신 예보를 다시 확인하세요.',
    },
  };

  it('29. reason, recommendation and reasonCode correspond exactly to each status', () => {
    for (const status of Object.keys(scenarios) as UmbrellaStatus[]) {
      const decision = assess(scenarios[status]);
      expect(decision.status).toBe(status);
      expect(decision.reasonCode).toBe(expectedCopy[status].reasonCode);
      expect(decision.reason).toBe(expectedCopy[status].reason);
      expect(decision.recommendation).toBe(expectedCopy[status].recommendation);
    }
  });

  it('30. extra properties on the input are not copied into the result', () => {
    const forecast = {
      ...makeForecast({ forecastAt: isoPlusHours(BASE, 2), condition: 'RAIN' }),
      leakedField: 'SHOULD_NOT_APPEAR',
    } as unknown as HourlyForecast;
    const input = {
      evaluatedAt: BASE,
      hourlyForecasts: [forecast],
      leakedTopLevel: 'SHOULD_NOT_APPEAR',
    } as unknown as UmbrellaAssessmentInput;

    const decision = assessUmbrellaNeed(input);
    expect(JSON.stringify(decision)).not.toContain('SHOULD_NOT_APPEAR');
    expect(Object.keys(decision.evidence).sort()).toEqual(
      [
        'consideredForecastCount',
        'firstRiskAt',
        'peakPrecipitationAmountMillimeters',
        'peakPrecipitationProbabilityPercent',
        'peakSnowfallAmountCentimeters',
        'usableForecastCount',
        'windowEndAt',
        'windowStartAt',
      ].sort(),
    );
  });
});
