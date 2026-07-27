import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AirQualityGrade, CurrentAirQuality } from '@life-weather/contracts';

import {
  assessMaskNeed,
  MASK_POLICY,
  type MaskAssessmentInput,
  type MaskParticulateGrade,
} from './index';

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

/** Anchor instant for every scenario. Uses seconds precision to exercise normalization. */
const BASE = '2026-07-15T12:00:00Z';
const MINUTE_IN_MS = 60_000;

/** Canonical UTC ISO for an instant `minutes` after `baseIso` (negative shifts into the past). */
function isoShiftMinutes(baseIso: string, minutes: number): string {
  return new Date(Date.parse(baseIso) + minutes * MINUTE_IN_MS).toISOString();
}

/**
 * Build a current air-quality observation. Defaults are all-`null` PM data measured exactly at
 * `BASE` (age 0 → FRESH); overrides win so an explicit `null` still sticks.
 */
function makeAirQuality(overrides: Partial<CurrentAirQuality> = {}): CurrentAirQuality {
  return {
    measuredAt: BASE,
    pm10MicrogramsPerCubicMeter: null,
    pm25MicrogramsPerCubicMeter: null,
    ozonePartsPerMillion: null,
    comprehensiveAirQualityIndex: null,
    overallGrade: null,
    pm10Grade: null,
    pm25Grade: null,
    ozoneGrade: null,
    ...overrides,
  };
}

function assess(
  airQuality: CurrentAirQuality | null,
  evaluatedAt: string = BASE,
): ReturnType<typeof assessMaskNeed> {
  return assessMaskNeed({ evaluatedAt, airQuality });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 1–11: status, driver and data quality from provider grades
// ---------------------------------------------------------------------------

describe('status and driver', () => {
  it('1. PM2.5 provider VERY_BAD → REQUIRED, driven by PM25', () => {
    const decision = assess(makeAirQuality({ pm25Grade: 'VERY_BAD' }));
    expect(decision.status).toBe('REQUIRED');
    expect(decision.reasonCode).toBe('PARTICULATE_VERY_BAD');
    expect(decision.evidence.driver).toBe('PM25');
  });

  it('2. PM10 provider VERY_BAD → REQUIRED, driven by PM10', () => {
    const decision = assess(makeAirQuality({ pm10Grade: 'VERY_BAD' }));
    expect(decision.status).toBe('REQUIRED');
    expect(decision.reasonCode).toBe('PARTICULATE_VERY_BAD');
    expect(decision.evidence.driver).toBe('PM10');
  });

  it('3. both pollutants VERY_BAD → REQUIRED, driven by BOTH', () => {
    const decision = assess(
      makeAirQuality({ pm10Grade: 'VERY_BAD', pm25Grade: 'VERY_BAD' }),
    );
    expect(decision.status).toBe('REQUIRED');
    expect(decision.evidence.driver).toBe('BOTH');
  });

  it('4. PM2.5 provider BAD → RECOMMENDED, driven by PM25', () => {
    const decision = assess(makeAirQuality({ pm25Grade: 'BAD' }));
    expect(decision.status).toBe('RECOMMENDED');
    expect(decision.reasonCode).toBe('PARTICULATE_BAD');
    expect(decision.evidence.driver).toBe('PM25');
  });

  it('5. PM10 provider BAD → RECOMMENDED, driven by PM10', () => {
    const decision = assess(makeAirQuality({ pm10Grade: 'BAD' }));
    expect(decision.status).toBe('RECOMMENDED');
    expect(decision.evidence.driver).toBe('PM10');
  });

  it('6. VERY_BAD mixed with BAD → the VERY_BAD pollutant is the driver', () => {
    const decision = assess(
      makeAirQuality({ pm10Grade: 'BAD', pm25Grade: 'VERY_BAD' }),
    );
    expect(decision.status).toBe('REQUIRED');
    expect(decision.evidence.driver).toBe('PM25');

    const flipped = assess(
      makeAirQuality({ pm10Grade: 'VERY_BAD', pm25Grade: 'BAD' }),
    );
    expect(flipped.status).toBe('REQUIRED');
    expect(flipped.evidence.driver).toBe('PM10');
  });

  it('7. only GOOD grades → NOT_NEEDED', () => {
    const decision = assess(makeAirQuality({ pm10Grade: 'GOOD', pm25Grade: 'GOOD' }));
    expect(decision.status).toBe('NOT_NEEDED');
    expect(decision.reasonCode).toBe('PARTICULATE_ACCEPTABLE');
  });

  it('8. only MODERATE grades → NOT_NEEDED', () => {
    const decision = assess(
      makeAirQuality({ pm10Grade: 'MODERATE', pm25Grade: 'MODERATE' }),
    );
    expect(decision.status).toBe('NOT_NEEDED');
    expect(decision.reasonCode).toBe('PARTICULATE_ACCEPTABLE');
  });

  it('9. a single usable pollutant still yields a real status with LIMITED quality', () => {
    const decision = assess(makeAirQuality({ pm25Grade: 'BAD' }));
    expect(decision.status).toBe('RECOMMENDED');
    expect(decision.evidence.driver).toBe('PM25');
    expect(decision.evidence.availablePollutantCount).toBe(1);
    expect(decision.dataQuality).toBe('LIMITED');
  });

  it('10. two usable pollutants → SUFFICIENT', () => {
    const decision = assess(makeAirQuality({ pm10Grade: 'GOOD', pm25Grade: 'MODERATE' }));
    expect(decision.status).toBe('NOT_NEEDED');
    expect(decision.evidence.availablePollutantCount).toBe(2);
    expect(decision.dataQuality).toBe('SUFFICIENT');
  });

  it('11. fresh but no particulate evidence → INSUFFICIENT_DATA', () => {
    const decision = assess(makeAirQuality());
    expect(decision.evidence.freshness).toBe('FRESH');
    expect(decision.status).toBe('INSUFFICIENT_DATA');
    expect(decision.reasonCode).toBe('INSUFFICIENT_PARTICULATE_DATA');
    expect(decision.dataQuality).toBe('INSUFFICIENT');
    expect(decision.evidence.availablePollutantCount).toBe(0);
  });

  it('12. a null observation → MISSING / INSUFFICIENT_DATA', () => {
    const decision = assess(null);
    expect(decision.evidence.freshness).toBe('MISSING');
    expect(decision.status).toBe('INSUFFICIENT_DATA');
    expect(decision.reasonCode).toBe('INSUFFICIENT_PARTICULATE_DATA');
    expect(decision.dataQuality).toBe('INSUFFICIENT');
    expect(decision.evidence.driver).toBeNull();
    expect(decision.evidence.measuredAt).toBeNull();
    expect(decision.evidence.availablePollutantCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 13–24: concentration → grade bands (inclusive AirKorea boundaries)
// ---------------------------------------------------------------------------

describe('PM10 concentration bands', () => {
  const boundaries: Array<[number, MaskParticulateGrade]> = [
    [30, 'GOOD'], // 13. exactly the GOOD upper bound
    [30.0001, 'MODERATE'], // 14. just above 30
    [80, 'MODERATE'], // 15. exactly the MODERATE upper bound
    [80.0001, 'BAD'], // 16. just above 80
    [150, 'BAD'], // 17. exactly the BAD upper bound
    [150.0001, 'VERY_BAD'], // 18. just above 150
  ];

  for (const [concentration, grade] of boundaries) {
    it(`PM10 ${concentration}㎍/㎥ → ${grade}`, () => {
      const decision = assess(
        makeAirQuality({ pm10MicrogramsPerCubicMeter: concentration }),
      );
      expect(decision.evidence.pm10.derivedGrade).toBe(grade);
      expect(decision.evidence.pm10.effectiveGrade).toBe(grade);
      expect(decision.evidence.pm10.gradeSource).toBe('CONCENTRATION');
    });
  }
});

describe('PM2.5 concentration bands', () => {
  const boundaries: Array<[number, MaskParticulateGrade]> = [
    [15, 'GOOD'], // 19. exactly the GOOD upper bound
    [15.0001, 'MODERATE'], // 20. just above 15
    [35, 'MODERATE'], // 21. exactly the MODERATE upper bound
    [35.0001, 'BAD'], // 22. just above 35
    [75, 'BAD'], // 23. exactly the BAD upper bound
    [75.0001, 'VERY_BAD'], // 24. just above 75
  ];

  for (const [concentration, grade] of boundaries) {
    it(`PM2.5 ${concentration}㎍/㎥ → ${grade}`, () => {
      const decision = assess(
        makeAirQuality({ pm25MicrogramsPerCubicMeter: concentration }),
      );
      expect(decision.evidence.pm25.derivedGrade).toBe(grade);
      expect(decision.evidence.pm25.effectiveGrade).toBe(grade);
      expect(decision.evidence.pm25.gradeSource).toBe('CONCENTRATION');
    });
  }
});

// ---------------------------------------------------------------------------
// 25–31: combining provider grade and concentration
// ---------------------------------------------------------------------------

describe('provider grade and concentration combination', () => {
  it('25. an UNKNOWN provider grade falls back to the concentration', () => {
    const decision = assess(
      makeAirQuality({ pm10Grade: 'UNKNOWN', pm10MicrogramsPerCubicMeter: 100 }),
    );
    expect(decision.evidence.pm10.providerGrade).toBe('UNKNOWN');
    expect(decision.evidence.pm10.derivedGrade).toBe('BAD');
    expect(decision.evidence.pm10.effectiveGrade).toBe('BAD');
    expect(decision.evidence.pm10.gradeSource).toBe('CONCENTRATION');
    expect(decision.evidence.pm10.gradeDisagreement).toBe(false);
  });

  it('26. a provider grade worse than the derived grade is kept', () => {
    const decision = assess(
      makeAirQuality({ pm10Grade: 'VERY_BAD', pm10MicrogramsPerCubicMeter: 100 }),
    );
    expect(decision.evidence.pm10.derivedGrade).toBe('BAD');
    expect(decision.evidence.pm10.effectiveGrade).toBe('VERY_BAD');
    expect(decision.evidence.pm10.gradeSource).toBe('BOTH');
    expect(decision.evidence.pm10.gradeDisagreement).toBe(true);
  });

  it('27. a derived grade worse than the provider grade is kept', () => {
    const decision = assess(
      makeAirQuality({ pm10Grade: 'MODERATE', pm10MicrogramsPerCubicMeter: 200 }),
    );
    expect(decision.evidence.pm10.providerGrade).toBe('MODERATE');
    expect(decision.evidence.pm10.derivedGrade).toBe('VERY_BAD');
    expect(decision.evidence.pm10.effectiveGrade).toBe('VERY_BAD');
    expect(decision.evidence.pm10.gradeSource).toBe('BOTH');
    expect(decision.evidence.pm10.gradeDisagreement).toBe(true);
  });

  it('28. when both are usable the grade source is BOTH', () => {
    const decision = assess(
      makeAirQuality({ pm25Grade: 'GOOD', pm25MicrogramsPerCubicMeter: 10 }),
    );
    expect(decision.evidence.pm25.effectiveGrade).toBe('GOOD');
    expect(decision.evidence.pm25.gradeSource).toBe('BOTH');
    expect(decision.evidence.pm25.gradeDisagreement).toBe(false);
  });

  it('29. differing provider and derived grades set gradeDisagreement true', () => {
    const decision = assess(
      makeAirQuality({ pm10Grade: 'GOOD', pm10MicrogramsPerCubicMeter: 100 }),
    );
    expect(decision.evidence.pm10.effectiveGrade).toBe('BAD');
    expect(decision.evidence.pm10.gradeSource).toBe('BOTH');
    expect(decision.evidence.pm10.gradeDisagreement).toBe(true);
  });

  it('30. a negative concentration is treated as null', () => {
    const decision = assess(
      makeAirQuality({ pm10MicrogramsPerCubicMeter: -5, pm10Grade: null }),
    );
    expect(decision.evidence.pm10.concentrationMicrogramsPerCubicMeter).toBeNull();
    expect(decision.evidence.pm10.derivedGrade).toBeNull();
    expect(decision.evidence.pm10.effectiveGrade).toBeNull();
    expect(decision.evidence.pm10.gradeSource).toBeNull();
  });

  it('31. NaN and Infinity concentrations are treated as null', () => {
    const decision = assess(
      makeAirQuality({
        pm10MicrogramsPerCubicMeter: Number.NaN,
        pm25MicrogramsPerCubicMeter: Number.POSITIVE_INFINITY,
      }),
    );
    expect(decision.evidence.pm10.concentrationMicrogramsPerCubicMeter).toBeNull();
    expect(decision.evidence.pm25.concentrationMicrogramsPerCubicMeter).toBeNull();
    expect(decision.evidence.availablePollutantCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 32–34: ignored fields (ozone, overallGrade, CAI)
// ---------------------------------------------------------------------------

describe('ignored fields', () => {
  it('32. an ozone VERY_BAD grade does not change the mask status', () => {
    const decision = assess(
      makeAirQuality({ pm10Grade: 'GOOD', pm25Grade: 'GOOD', ozoneGrade: 'VERY_BAD' }),
    );
    expect(decision.status).toBe('NOT_NEEDED');
    expect(JSON.stringify(decision)).not.toContain('ozone');
  });

  it('33. an overallGrade VERY_BAD does not change the mask status', () => {
    const decision = assess(
      makeAirQuality({ pm10Grade: 'GOOD', pm25Grade: 'GOOD', overallGrade: 'VERY_BAD' }),
    );
    expect(decision.status).toBe('NOT_NEEDED');
    expect(JSON.stringify(decision)).not.toContain('overallGrade');
  });

  it('34. a high composite index alone does not produce a mask status', () => {
    const decision = assess(makeAirQuality({ comprehensiveAirQualityIndex: 500 }));
    expect(decision.status).toBe('INSUFFICIENT_DATA');
    expect(decision.reasonCode).toBe('INSUFFICIENT_PARTICULATE_DATA');
    expect(decision.evidence.availablePollutantCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 35–44: measurement time and freshness
// ---------------------------------------------------------------------------

describe('measurement time and freshness', () => {
  it('35. an observation age of exactly 180 minutes is FRESH', () => {
    const decision = assess(
      makeAirQuality({
        measuredAt: isoShiftMinutes(BASE, -180),
        pm25Grade: 'BAD',
      }),
    );
    expect(decision.evidence.observationAgeMinutes).toBe(180);
    expect(decision.evidence.freshness).toBe('FRESH');
    expect(decision.status).toBe('RECOMMENDED');
  });

  it('36. an observation older than 180 minutes is STALE / INSUFFICIENT_DATA', () => {
    const decision = assess(
      makeAirQuality({
        measuredAt: isoShiftMinutes(BASE, -181),
        pm25Grade: 'BAD',
      }),
    );
    expect(decision.evidence.freshness).toBe('STALE');
    expect(decision.status).toBe('INSUFFICIENT_DATA');
    expect(decision.reasonCode).toBe('STALE_AIR_QUALITY');
    expect(decision.dataQuality).toBe('INSUFFICIENT');
  });

  it('37. a future measuredAt is INVALID / INSUFFICIENT_DATA', () => {
    // A parseable offset-bearing future measuredAt: 21:10+09:00 is the instant
    // 2026-07-15T12:10:00.000Z, ten minutes after evaluatedAt. Even though the reading is
    // rejected as future-dated, its canonical UTC evidence is still preserved, and the future
    // VERY_BAD particulate never leaks into a current REQUIRED status.
    const decision = assess(
      makeAirQuality({ measuredAt: '2026-07-15T21:10:00+09:00', pm25Grade: 'VERY_BAD' }),
      '2026-07-15T12:00:00Z',
    );
    expect(decision.evidence.measuredAt).toBe('2026-07-15T12:10:00.000Z');
    expect(decision.evidence.freshness).toBe('INVALID');
    expect(decision.evidence.observationAgeMinutes).toBeNull();
    expect(decision.evidence.driver).toBeNull();
    expect(decision.status).toBe('INSUFFICIENT_DATA');
    expect(decision.reasonCode).toBe('INVALID_MEASUREMENT_TIME');
    expect(decision.dataQuality).toBe('INSUFFICIENT');
  });

  it('38. a malformed measuredAt is INVALID without crashing', () => {
    const observation = makeAirQuality({ pm25Grade: 'BAD' });
    const withBadTime = {
      ...observation,
      measuredAt: 'not-a-timestamp',
    } as unknown as CurrentAirQuality;
    const decision = assess(withBadTime);
    expect(decision.evidence.freshness).toBe('INVALID');
    expect(decision.evidence.measuredAt).toBeNull();
    expect(decision.status).toBe('INSUFFICIENT_DATA');
    expect(decision.reasonCode).toBe('INVALID_MEASUREMENT_TIME');
  });

  it('39. measuredAt equal to evaluatedAt is age 0 / FRESH', () => {
    const decision = assess(makeAirQuality({ measuredAt: BASE, pm10Grade: 'GOOD' }));
    expect(decision.evidence.observationAgeMinutes).toBe(0);
    expect(decision.evidence.freshness).toBe('FRESH');
  });

  it('40. an invalid evaluatedAt throws a fixed RangeError that does not echo the input', () => {
    const invalidInputs = [
      'not-a-date',
      '2026-07-15T12:00Z', // no seconds
      '2026-07-15', // date only
      '2026-07-15T12:00:00', // no timezone
      '2026-13-45T99:99:99Z', // impossible components
      '',
    ];
    for (const evaluatedAt of invalidInputs) {
      expect(() => assessMaskNeed({ evaluatedAt, airQuality: null })).toThrow(RangeError);
    }

    let caught: unknown;
    try {
      assessMaskNeed({ evaluatedAt: '2026-13-45T99:99:99Z', airQuality: null });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RangeError);
    expect((caught as RangeError).message).toBe(
      'evaluatedAt must be an ISO 8601 datetime with a timezone designator',
    );
    expect((caught as RangeError).message).not.toContain('2026-13-45');
  });

  it('41. seconds and exactly-3-digit millisecond ISO datetimes are accepted', () => {
    const seconds = assessMaskNeed({
      evaluatedAt: '2026-07-15T12:00:00Z',
      airQuality: makeAirQuality({ measuredAt: '2026-07-15T11:30:00Z', pm10Grade: 'GOOD' }),
    });
    const millis = assessMaskNeed({
      evaluatedAt: '2026-07-15T12:00:00.000Z',
      airQuality: makeAirQuality({
        measuredAt: '2026-07-15T11:30:00.500Z',
        pm10Grade: 'GOOD',
      }),
    });
    expect(seconds.evidence.freshness).toBe('FRESH');
    expect(millis.evidence.freshness).toBe('FRESH');
  });

  it('42. timezone-less, minute-precision and impossible measuredAt values are rejected', () => {
    // As evaluatedAt these throw.
    for (const evaluatedAt of [
      '2026-07-15T12:00:00',
      '2026-07-15T12:00Z',
      '2026-02-30T12:00:00Z',
    ]) {
      expect(() => assessMaskNeed({ evaluatedAt, airQuality: null })).toThrow(RangeError);
    }
    // As measuredAt they degrade to INVALID rather than throwing.
    for (const measuredAt of [
      '2026-07-15T11:00:00',
      '2026-07-15T11:00Z',
      '2026-02-30T11:00:00Z',
    ]) {
      const decision = assess(makeAirQuality({ measuredAt, pm10Grade: 'BAD' }));
      expect(decision.evidence.freshness).toBe('INVALID');
      expect(decision.evidence.measuredAt).toBeNull();
    }
  });

  it('43. evidence timestamps are canonical UTC even for offset inputs', () => {
    const decision = assessMaskNeed({
      evaluatedAt: '2026-07-15T21:00:00+09:00',
      airQuality: makeAirQuality({
        measuredAt: '2026-07-15T20:30:00+09:00',
        pm10Grade: 'BAD',
      }),
    });
    expect(decision.evidence.measuredAt).toBe('2026-07-15T11:30:00.000Z');
    expect(decision.evidence.observationAgeMinutes).toBe(30);
    expect(decision.evidence.freshness).toBe('FRESH');
  });

  it('44. observationAgeMinutes is not rounded', () => {
    const decision = assess(makeAirQuality({ measuredAt: isoShiftMinutes(BASE, -1.5) }));
    expect(decision.evidence.observationAgeMinutes).toBe(1.5);
  });
});

// ---------------------------------------------------------------------------
// 45–48: purity and runtime defensiveness
// ---------------------------------------------------------------------------

describe('purity and runtime defensiveness', () => {
  it('45. the input observation object is not mutated', () => {
    const observation = makeAirQuality({
      pm10Grade: 'VERY_BAD',
      pm10MicrogramsPerCubicMeter: 200,
      pm25MicrogramsPerCubicMeter: 40,
    });
    const snapshot = JSON.parse(JSON.stringify(observation)) as CurrentAirQuality;
    Object.freeze(observation);

    expect(() => assess(observation)).not.toThrow();
    expect(observation).toEqual(snapshot);
  });

  it('46. extra and unused fields are not copied into the result', () => {
    const observation = {
      ...makeAirQuality({ pm10Grade: 'BAD' }),
      leakedField: 'SHOULD_NOT_APPEAR',
    } as unknown as CurrentAirQuality;
    const input = {
      evaluatedAt: BASE,
      airQuality: observation,
      leakedTopLevel: 'SHOULD_NOT_APPEAR',
    } as unknown as MaskAssessmentInput;

    const decision = assessMaskNeed(input);
    expect(JSON.stringify(decision)).not.toContain('SHOULD_NOT_APPEAR');
    expect(Object.keys(decision.evidence).sort()).toEqual(
      [
        'availablePollutantCount',
        'driver',
        'freshness',
        'measuredAt',
        'observationAgeMinutes',
        'pm10',
        'pm25',
      ].sort(),
    );
    expect(Object.keys(decision.evidence.pm10).sort()).toEqual(
      [
        'concentrationMicrogramsPerCubicMeter',
        'derivedGrade',
        'effectiveGrade',
        'gradeDisagreement',
        'gradeSource',
        'providerGrade',
      ].sort(),
    );
  });

  it('47. runtime-malformed observations are handled safely', () => {
    const malformed: unknown[] = [123, 'AIR', [], true, { foo: 'bar' }];
    for (const airQuality of malformed) {
      expect(() =>
        assessMaskNeed({ evaluatedAt: BASE, airQuality: airQuality as CurrentAirQuality }),
      ).not.toThrow();
    }
    // A non-object degrades to MISSING; a bare object with no fields degrades to INVALID time.
    const number = assess(123 as unknown as CurrentAirQuality);
    expect(number.evidence.freshness).toBe('MISSING');
    expect(number.status).toBe('INSUFFICIENT_DATA');

    const array = assess([] as unknown as CurrentAirQuality);
    expect(array.evidence.freshness).toBe('MISSING');

    const bareObject = assess({ foo: 'bar' } as unknown as CurrentAirQuality);
    expect(bareObject.evidence.freshness).toBe('INVALID');
    expect(bareObject.status).toBe('INSUFFICIENT_DATA');
  });

  it('48. an unknown provider grade string is never exposed verbatim', () => {
    const observation = makeAirQuality({
      pm10Grade: 'HAZARDOUS' as unknown as AirQualityGrade,
      pm10MicrogramsPerCubicMeter: 100,
    });
    const decision = assess(observation);
    expect(decision.evidence.pm10.providerGrade).toBe('UNKNOWN');
    expect(decision.evidence.pm10.effectiveGrade).toBe('BAD'); // from the concentration
    expect(JSON.stringify(decision)).not.toContain('HAZARDOUS');
  });
});

// ---------------------------------------------------------------------------
// 49–50: mixed sources and stale high pollution
// ---------------------------------------------------------------------------

describe('mixed sources and stale data', () => {
  it('49. one pollutant by provider grade and the other by concentration → count 2 / SUFFICIENT', () => {
    const decision = assess(
      makeAirQuality({
        pm10Grade: 'GOOD', // provider only (no PM10 concentration)
        pm25MicrogramsPerCubicMeter: 10, // concentration only (no PM2.5 grade) → GOOD
      }),
    );
    expect(decision.evidence.pm10.gradeSource).toBe('PROVIDER_GRADE');
    expect(decision.evidence.pm25.gradeSource).toBe('CONCENTRATION');
    expect(decision.evidence.availablePollutantCount).toBe(2);
    expect(decision.dataQuality).toBe('SUFFICIENT');
    expect(decision.status).toBe('NOT_NEEDED');
  });

  it('50. stale VERY_BAD data does not produce a current REQUIRED', () => {
    const decision = assess(
      makeAirQuality({
        measuredAt: isoShiftMinutes(BASE, -181),
        pm10Grade: 'VERY_BAD',
        pm25Grade: 'VERY_BAD',
      }),
    );
    expect(decision.status).toBe('INSUFFICIENT_DATA');
    expect(decision.reasonCode).toBe('STALE_AIR_QUALITY');
    expect(decision.evidence.driver).toBeNull();
    // The PM evidence is still reported independently of freshness.
    expect(decision.evidence.pm25.effectiveGrade).toBe('VERY_BAD');
    expect(decision.evidence.availablePollutantCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 51–53: user-facing copy
// ---------------------------------------------------------------------------

describe('user-facing copy', () => {
  it('51. the REQUIRED reason matches the driver', () => {
    expect(assess(makeAirQuality({ pm25Grade: 'VERY_BAD' })).reason).toBe(
      '현재 초미세먼지가 매우 나쁨 수준입니다.',
    );
    expect(assess(makeAirQuality({ pm10Grade: 'VERY_BAD' })).reason).toBe(
      '현재 미세먼지가 매우 나쁨 수준입니다.',
    );
    expect(
      assess(makeAirQuality({ pm10Grade: 'VERY_BAD', pm25Grade: 'VERY_BAD' })).reason,
    ).toBe('현재 초미세먼지와 미세먼지가 매우 나쁨 수준입니다.');
  });

  it('52. the RECOMMENDED reason matches the driver', () => {
    expect(assess(makeAirQuality({ pm25Grade: 'BAD' })).reason).toBe(
      '현재 초미세먼지가 나쁨 수준입니다.',
    );
    expect(assess(makeAirQuality({ pm10Grade: 'BAD' })).reason).toBe(
      '현재 미세먼지가 나쁨 수준입니다.',
    );
    expect(assess(makeAirQuality({ pm10Grade: 'BAD', pm25Grade: 'BAD' })).reason).toBe(
      '현재 초미세먼지와 미세먼지가 나쁨 수준입니다.',
    );
  });

  it('53. recommendation and reason correspond to each status / reason code', () => {
    expect(assess(makeAirQuality({ pm25Grade: 'VERY_BAD' })).recommendation).toBe(
      '외출할 때 식약처 인증 보건용 마스크를 착용하세요.',
    );
    expect(assess(makeAirQuality({ pm25Grade: 'BAD' })).recommendation).toBe(
      '외출할 때 보건용 마스크를 준비해 착용하세요.',
    );

    const notNeeded = assess(makeAirQuality({ pm10Grade: 'GOOD' }));
    expect(notNeeded.reason).toBe('현재 확인 가능한 미세먼지 수준은 좋음 또는 보통입니다.');
    expect(notNeeded.recommendation).toBe('일반적인 외출에서는 마스크가 꼭 필요하지 않습니다.');

    const stale = assess(
      makeAirQuality({ measuredAt: isoShiftMinutes(BASE, -181), pm10Grade: 'BAD' }),
    );
    expect(stale.reason).toBe(
      '대기질 측정값이 오래되어 현재 마스크 필요 여부를 판단하기 어렵습니다.',
    );
    expect(stale.recommendation).toBe('최신 미세먼지 정보를 다시 확인하세요.');

    const invalid = assess(
      makeAirQuality({ measuredAt: isoShiftMinutes(BASE, 10), pm10Grade: 'BAD' }),
    );
    expect(invalid.reason).toBe(
      '대기질 측정 시각을 확인할 수 없어 마스크 필요 여부를 판단하기 어렵습니다.',
    );

    const insufficient = assess(makeAirQuality());
    expect(insufficient.reason).toBe('마스크 필요 여부를 판단할 미세먼지 정보가 부족합니다.');
    expect(insufficient.recommendation).toBe('최신 미세먼지 정보를 다시 확인하세요.');
  });
});

// ---------------------------------------------------------------------------
// 54–56: determinism, policy stability and precision
// ---------------------------------------------------------------------------

describe('determinism, policy and precision', () => {
  it('54. does not call Date.now or the network', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    const fetchSpy = vi.fn(() => {
      throw new Error('network access is not allowed');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const observation = makeAirQuality({ pm10Grade: 'BAD', pm25Grade: 'MODERATE' });
    const first = assess(observation);
    const second = assess(observation);

    expect(nowSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(first).toEqual(second);
  });

  it('55. the policy constants are frozen and the version is returned stably', () => {
    expect(MASK_POLICY).toEqual({
      policyVersion: '1.0.0',
      maximumObservationAgeMinutes: 180,
      pm10GoodMaximumMicrogramsPerCubicMeter: 30,
      pm10ModerateMaximumMicrogramsPerCubicMeter: 80,
      pm10BadMaximumMicrogramsPerCubicMeter: 150,
      pm25GoodMaximumMicrogramsPerCubicMeter: 15,
      pm25ModerateMaximumMicrogramsPerCubicMeter: 35,
      pm25BadMaximumMicrogramsPerCubicMeter: 75,
    });
    expect(Object.isFrozen(MASK_POLICY)).toBe(true);
    expect(() => {
      (MASK_POLICY as { maximumObservationAgeMinutes: number }).maximumObservationAgeMinutes = 9;
    }).toThrow();

    expect(assess(makeAirQuality({ pm10Grade: 'GOOD' })).policyVersion).toBe('1.0.0');
  });

  it('56. concentration precision is preserved and not rounded', () => {
    const decision = assess(
      makeAirQuality({
        pm10MicrogramsPerCubicMeter: 30.123456,
        pm25MicrogramsPerCubicMeter: 15.987654,
      }),
    );
    expect(decision.evidence.pm10.concentrationMicrogramsPerCubicMeter).toBe(30.123456);
    expect(decision.evidence.pm25.concentrationMicrogramsPerCubicMeter).toBe(15.987654);
    expect(decision.evidence.pm10.derivedGrade).toBe('MODERATE');
    expect(decision.evidence.pm25.derivedGrade).toBe('MODERATE');
  });
});
