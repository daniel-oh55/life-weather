import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HourlyForecast } from '@life-weather/contracts';

import {
  assessLaundryDryingSuitability,
  LAUNDRY_POLICY,
  type LaundryDecision,
  type LaundryDriver,
  type LaundryReasonCode,
  type LaundryStatus,
} from './index';

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

/** Anchor instant for every scenario. Uses seconds precision to exercise normalization. */
const BASE = '2026-07-15T12:00:00Z';
const HOUR_IN_MS = 3_600_000;

/** Canonical UTC ISO for an instant `hours` after `baseIso` — matches the engine's output. */
function isoPlusHours(hours: number, baseIso: string = BASE): string {
  return new Date(Date.parse(baseIso) + hours * HOUR_IN_MS).toISOString();
}

/**
 * Build a forecast with benign, drying-capable defaults: a dry known condition, a usable
 * temperature and humidity that classify as EXCELLENT, and no precipitation / wind signal.
 * Overrides win (so an explicit `0` sticks).
 */
function makeForecast(
  overrides: Partial<HourlyForecast> & { forecastAt: string },
): HourlyForecast {
  return {
    condition: 'CLEAR',
    temperatureCelsius: 20,
    feelsLikeCelsius: null,
    precipitationProbabilityPercent: 0,
    precipitationAmountMillimeters: 0,
    snowfallAmountCentimeters: 0,
    humidityPercent: 50,
    windSpeedMetersPerSecond: 0,
    windDirectionDegrees: null,
    ...overrides,
  };
}

/**
 * Four drying-capable forecasts at +1h..+4h — the minimum that meets coverage (4 distinct drying
 * instants, the last exactly at +4h). `overrides` is applied to every instant (never `forecastAt`).
 */
function coverageRun(overrides: Partial<HourlyForecast> = {}): HourlyForecast[] {
  return [1, 2, 3, 4].map((h) => makeForecast({ forecastAt: isoPlusHours(h), ...overrides }));
}

function assess(
  hourlyForecasts: readonly HourlyForecast[],
  evaluatedAt: string = BASE,
): LaundryDecision {
  return assessLaundryDryingSuitability({ evaluatedAt, hourlyForecasts });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// A. Strong precipitation (1–10)
// ---------------------------------------------------------------------------

describe('A. strong precipitation', () => {
  const wetConditions: HourlyForecast['condition'][] = [
    'RAIN',
    'SNOW',
    'SLEET',
    'SHOWER',
    'THUNDERSTORM',
  ];

  for (const [index, condition] of wetConditions.entries()) {
    it(`${index + 1}. ${condition} condition → NOT_RECOMMENDED`, () => {
      const decision = assess([makeForecast({ forecastAt: isoPlusHours(2), condition })]);
      expect(decision.status).toBe('NOT_RECOMMENDED');
      expect(decision.reasonCode).toBe('PRECIPITATION_EXPECTED');
      expect(decision.driver).toBe('PRECIPITATION');
    });
  }

  it('6. precipitation amount > 0 → NOT_RECOMMENDED (dry condition, no POP)', () => {
    const decision = assess([
      makeForecast({
        forecastAt: isoPlusHours(2),
        condition: 'CLOUDY',
        precipitationAmountMillimeters: 0.2,
      }),
    ]);
    expect(decision.status).toBe('NOT_RECOMMENDED');
    expect(decision.reasonCode).toBe('PRECIPITATION_EXPECTED');
  });

  it('7. snowfall amount > 0 → NOT_RECOMMENDED', () => {
    const decision = assess([
      makeForecast({
        forecastAt: isoPlusHours(2),
        condition: 'CLOUDY',
        snowfallAmountCentimeters: 0.1,
      }),
    ]);
    expect(decision.status).toBe('NOT_RECOMMENDED');
    expect(decision.reasonCode).toBe('PRECIPITATION_EXPECTED');
  });

  it('8. POP exactly 60 → NOT_RECOMMENDED (strong boundary inclusive)', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(2), precipitationProbabilityPercent: 60 }),
    ]);
    expect(decision.status).toBe('NOT_RECOMMENDED');
    expect(decision.reasonCode).toBe('PRECIPITATION_EXPECTED');
  });

  it('9. POP 59.9999 is not a strong signal (falls through to POSSIBLE)', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(2), precipitationProbabilityPercent: 59.9999 }),
    ]);
    expect(decision.status).toBe('POOR');
    expect(decision.reasonCode).toBe('PRECIPITATION_POSSIBLE');
  });

  it('10. amount and snowfall of exactly 0 are not signals', () => {
    const decision = assess([
      makeForecast({
        forecastAt: isoPlusHours(2),
        precipitationAmountMillimeters: 0,
        snowfallAmountCentimeters: 0,
        precipitationProbabilityPercent: 0,
      }),
    ]);
    expect(decision.status).not.toBe('NOT_RECOMMENDED');
    expect(decision.status).not.toBe('POOR');
  });
});

// ---------------------------------------------------------------------------
// B. Possible precipitation and priority (11–16)
// ---------------------------------------------------------------------------

describe('B. possible precipitation and priority', () => {
  it('11. POP exactly 30 → POOR (possible boundary inclusive)', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(2), precipitationProbabilityPercent: 30 }),
    ]);
    expect(decision.status).toBe('POOR');
    expect(decision.reasonCode).toBe('PRECIPITATION_POSSIBLE');
    expect(decision.driver).toBe('PRECIPITATION');
  });

  it('12. POP 29.9999 is not a possible signal', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(2), precipitationProbabilityPercent: 29.9999 }),
    ]);
    // No adverse signal and no coverage → INSUFFICIENT_DATA, not POOR.
    expect(decision.status).toBe('INSUFFICIENT_DATA');
  });

  it('13. strong precipitation + strong wind → precipitation reason wins', () => {
    const decision = assess([
      makeForecast({
        forecastAt: isoPlusHours(2),
        condition: 'RAIN',
        windSpeedMetersPerSecond: 15,
      }),
    ]);
    expect(decision.status).toBe('NOT_RECOMMENDED');
    expect(decision.reasonCode).toBe('PRECIPITATION_EXPECTED');
    expect(decision.driver).toBe('PRECIPITATION');
  });

  it('14. strong wind + moderate precipitation → strong wind wins', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(2), precipitationProbabilityPercent: 40 }),
      makeForecast({ forecastAt: isoPlusHours(3), windSpeedMetersPerSecond: 12 }),
    ]);
    expect(decision.status).toBe('NOT_RECOMMENDED');
    expect(decision.reasonCode).toBe('STRONG_WIND');
    expect(decision.driver).toBe('WIND');
  });

  it('15. moderate precipitation + high humidity → precipitation wins', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(2), precipitationProbabilityPercent: 40 }),
      makeForecast({ forecastAt: isoPlusHours(3), humidityPercent: 90 }),
    ]);
    expect(decision.status).toBe('POOR');
    expect(decision.reasonCode).toBe('PRECIPITATION_POSSIBLE');
    expect(decision.driver).toBe('PRECIPITATION');
  });

  it('16. a sparse precipitation signal still returns a real status with LIMITED quality', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(2), precipitationProbabilityPercent: 40 }),
    ]);
    expect(decision.status).toBe('POOR');
    expect(decision.dataQuality).toBe('LIMITED');
    expect(decision.evidence.dryingCoverageMet).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C. Strong wind (17–21)
// ---------------------------------------------------------------------------

describe('C. strong wind', () => {
  it('17. wind exactly 10 → NOT_RECOMMENDED (strong-wind boundary inclusive)', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(2), windSpeedMetersPerSecond: 10 }),
    ]);
    expect(decision.status).toBe('NOT_RECOMMENDED');
    expect(decision.reasonCode).toBe('STRONG_WIND');
    expect(decision.driver).toBe('WIND');
  });

  it('18. wind 9.9999 is not a strong-wind signal', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(2), windSpeedMetersPerSecond: 9.9999 }),
    ]);
    expect(decision.reasonCode).not.toBe('STRONG_WIND');
  });

  it('19. the earliest strong-wind instant is firstAdverseAt', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(1) }),
      makeForecast({ forecastAt: isoPlusHours(5), windSpeedMetersPerSecond: 13 }),
      makeForecast({ forecastAt: isoPlusHours(2), windSpeedMetersPerSecond: 11 }),
    ]);
    expect(decision.reasonCode).toBe('STRONG_WIND');
    expect(decision.evidence.firstAdverseAt).toBe(isoPlusHours(2));
  });

  it('20. strong wind on sparse data → LIMITED', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(2), windSpeedMetersPerSecond: 12 }),
    ]);
    expect(decision.status).toBe('NOT_RECOMMENDED');
    expect(decision.dataQuality).toBe('LIMITED');
  });

  it('21. strong wind with sufficient coverage → SUFFICIENT', () => {
    const decision = assess(coverageRun({ windSpeedMetersPerSecond: 12 }));
    expect(decision.status).toBe('NOT_RECOMMENDED');
    expect(decision.reasonCode).toBe('STRONG_WIND');
    expect(decision.dataQuality).toBe('SUFFICIENT');
    expect(decision.evidence.dryingCoverageMet).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D. Humidity / temperature states (22–32)
// ---------------------------------------------------------------------------

describe('D. humidity and temperature states', () => {
  it('22. humidity exactly 85 → POOR (high-humidity boundary inclusive)', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(2), humidityPercent: 85 }),
    ]);
    expect(decision.status).toBe('POOR');
    expect(decision.reasonCode).toBe('HIGH_HUMIDITY');
    expect(decision.driver).toBe('HUMIDITY');
  });

  it('23. humidity 84.9999 is not a high-humidity signal', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(2), humidityPercent: 84.9999 }),
    ]);
    expect(decision.reasonCode).not.toBe('HIGH_HUMIDITY');
  });

  it('24. max humidity 55 and min temperature 18 → EXCELLENT', () => {
    const decision = assess(coverageRun({ humidityPercent: 55, temperatureCelsius: 18 }));
    expect(decision.status).toBe('EXCELLENT');
    expect(decision.reasonCode).toBe('EXCELLENT_DRYING_CONDITIONS');
    expect(decision.driver).toBe('TEMPERATURE_HUMIDITY');
  });

  it('25. humidity above 55 is not EXCELLENT (→ GOOD)', () => {
    const decision = assess(coverageRun({ humidityPercent: 56, temperatureCelsius: 20 }));
    expect(decision.status).toBe('GOOD');
  });

  it('26. temperature below 18 is not EXCELLENT (→ GOOD)', () => {
    const decision = assess(coverageRun({ humidityPercent: 50, temperatureCelsius: 17 }));
    expect(decision.status).toBe('GOOD');
  });

  it('27. humidity 70 and temperature 10 → GOOD', () => {
    const decision = assess(coverageRun({ humidityPercent: 70, temperatureCelsius: 10 }));
    expect(decision.status).toBe('GOOD');
    expect(decision.reasonCode).toBe('FAVORABLE_DRYING_CONDITIONS');
    expect(decision.driver).toBe('TEMPERATURE_HUMIDITY');
  });

  it('28. humidity above 70 is not GOOD (→ FAIR)', () => {
    const decision = assess(coverageRun({ humidityPercent: 71, temperatureCelsius: 20 }));
    expect(decision.status).toBe('FAIR');
  });

  it('29. temperature below 10 is not GOOD (→ FAIR)', () => {
    const decision = assess(coverageRun({ humidityPercent: 50, temperatureCelsius: 9 }));
    expect(decision.status).toBe('FAIR');
  });

  it('30. sufficient coverage but middling conditions → FAIR', () => {
    const decision = assess(coverageRun({ humidityPercent: 72, temperatureCelsius: 12 }));
    expect(decision.status).toBe('FAIR');
    expect(decision.reasonCode).toBe('MARGINAL_DRYING_CONDITIONS');
    expect(decision.driver).toBe('TEMPERATURE_HUMIDITY');
    expect(decision.dataQuality).toBe('SUFFICIENT');
  });

  it('31. a single instant at/above 85 still yields the high-humidity reason', () => {
    const run = coverageRun();
    run[2] = makeForecast({ forecastAt: isoPlusHours(3), humidityPercent: 88 });
    const decision = assess(run);
    expect(decision.status).toBe('POOR');
    expect(decision.reasonCode).toBe('HIGH_HUMIDITY');
    // The adverse status is still reported with the coverage it had.
    expect(decision.dataQuality).toBe('SUFFICIENT');
  });

  it('32. maximum humidity and minimum temperature use conservative per-instant representatives', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(2), humidityPercent: 40, temperatureCelsius: 22 }),
      makeForecast({ forecastAt: isoPlusHours(2), humidityPercent: 90, temperatureCelsius: 8 }),
    ]);
    expect(decision.evidence.maximumHumidityPercent).toBe(90);
    expect(decision.evidence.minimumTemperatureCelsius).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// E. Coverage (33–44)
// ---------------------------------------------------------------------------

describe('E. drying coverage', () => {
  it('33. exactly 4 drying instants with the last exactly at +4h → coverage met', () => {
    const decision = assess(coverageRun());
    expect(decision.evidence.dryingForecastCount).toBe(4);
    expect(decision.evidence.lastDryingForecastAt).toBe(isoPlusHours(4));
    expect(decision.evidence.dryingCoverageMet).toBe(true);
    expect(decision.status).toBe('EXCELLENT');
  });

  it('34. only 3 drying instants → coverage not met', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(2) }),
      makeForecast({ forecastAt: isoPlusHours(3) }),
      makeForecast({ forecastAt: isoPlusHours(4) }),
    ]);
    expect(decision.evidence.dryingForecastCount).toBe(3);
    expect(decision.evidence.dryingCoverageMet).toBe(false);
    expect(decision.status).toBe('INSUFFICIENT_DATA');
  });

  it('35. 4 drying instants but the last is before +4h → coverage not met', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(1) }),
      makeForecast({ forecastAt: isoPlusHours(2) }),
      makeForecast({ forecastAt: isoPlusHours(3) }),
      makeForecast({ forecastAt: isoPlusHours(3.5) }),
    ]);
    expect(decision.evidence.dryingForecastCount).toBe(4);
    expect(decision.evidence.dryingCoverageMet).toBe(false);
    expect(decision.status).toBe('INSUFFICIENT_DATA');
  });

  it('36. no adverse signal and insufficient coverage → INSUFFICIENT_DATA', () => {
    const decision = assess([makeForecast({ forecastAt: isoPlusHours(2) })]);
    expect(decision.status).toBe('INSUFFICIENT_DATA');
    expect(decision.reasonCode).toBe('INSUFFICIENT_FORECAST');
    expect(decision.dataQuality).toBe('INSUFFICIENT');
    expect(decision.driver).toBeNull();
  });

  it('37. a positive verdict is never returned without coverage', () => {
    // Ideal EXCELLENT conditions but only one instant → still INSUFFICIENT_DATA.
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(2), humidityPercent: 40, temperatureCelsius: 24 }),
    ]);
    expect(decision.status).toBe('INSUFFICIENT_DATA');
  });

  it('38. usable temperature but no humidity is excluded from the drying count', () => {
    const decision = assess(coverageRun({ humidityPercent: null }));
    expect(decision.evidence.dryingForecastCount).toBe(0);
    expect(decision.status).toBe('INSUFFICIENT_DATA');
  });

  it('39. usable humidity but no temperature is excluded from the drying count', () => {
    const decision = assess(coverageRun({ temperatureCelsius: Number.NaN }));
    expect(decision.evidence.dryingForecastCount).toBe(0);
    expect(decision.status).toBe('INSUFFICIENT_DATA');
  });

  it('40. temperature and humidity but no precipitation assessability is excluded', () => {
    const decision = assess(
      coverageRun({
        condition: 'UNKNOWN',
        precipitationProbabilityPercent: null,
        precipitationAmountMillimeters: null,
        snowfallAmountCentimeters: null,
      }),
    );
    expect(decision.evidence.dryingForecastCount).toBe(0);
    expect(decision.status).toBe('INSUFFICIENT_DATA');
  });

  it('41. a known dry condition satisfies precipitation assessability', () => {
    const decision = assess(
      coverageRun({
        condition: 'CLEAR',
        precipitationProbabilityPercent: null,
        precipitationAmountMillimeters: null,
        snowfallAmountCentimeters: null,
      }),
    );
    expect(decision.evidence.dryingForecastCount).toBe(4);
    expect(decision.status).toBe('EXCELLENT');
  });

  it('42. a numeric precipitation field alone satisfies precipitation assessability', () => {
    const decision = assess(
      coverageRun({
        condition: 'UNKNOWN',
        precipitationProbabilityPercent: null,
        precipitationAmountMillimeters: 0,
        snowfallAmountCentimeters: null,
      }),
    );
    expect(decision.evidence.dryingForecastCount).toBe(4);
    expect(decision.status).toBe('EXCELLENT');
  });

  it('43. lastDryingForecastAt is a canonical UTC timestamp', () => {
    const decision = assess(coverageRun());
    expect(decision.evidence.lastDryingForecastAt).toBe('2026-07-15T16:00:00.000Z');
  });

  it('44. the drying count is over distinct instants (duplicates collapse)', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(1) }),
      makeForecast({ forecastAt: isoPlusHours(2) }),
      makeForecast({ forecastAt: isoPlusHours(3) }),
      makeForecast({ forecastAt: isoPlusHours(4) }),
      makeForecast({ forecastAt: isoPlusHours(4) }),
    ]);
    expect(decision.evidence.dryingForecastCount).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// F. Duplicate instants (45–54)
// ---------------------------------------------------------------------------

describe('F. duplicate instants', () => {
  it('45. the same absolute instant in different timezones is merged', () => {
    const decision = assess([
      makeForecast({ forecastAt: '2026-07-15T14:00:00Z' }),
      makeForecast({ forecastAt: '2026-07-15T23:00:00+09:00' }),
    ]);
    expect(decision.evidence.consideredForecastCount).toBe(1);
  });

  it('46. a duplicated POP uses the maximum', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(2), precipitationProbabilityPercent: 20 }),
      makeForecast({ forecastAt: isoPlusHours(2), precipitationProbabilityPercent: 45 }),
    ]);
    expect(decision.evidence.peakPrecipitationProbabilityPercent).toBe(45);
  });

  it('47. a duplicated precipitation amount uses the maximum', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(2), precipitationAmountMillimeters: 0.3 }),
      makeForecast({ forecastAt: isoPlusHours(2), precipitationAmountMillimeters: 1.2 }),
    ]);
    expect(decision.evidence.peakPrecipitationAmountMillimeters).toBe(1.2);
  });

  it('48. a duplicated snowfall amount uses the maximum', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(2), snowfallAmountCentimeters: 0.5 }),
      makeForecast({ forecastAt: isoPlusHours(2), snowfallAmountCentimeters: 2 }),
    ]);
    expect(decision.evidence.peakSnowfallAmountCentimeters).toBe(2);
  });

  it('49. a duplicated humidity uses the maximum', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(2), humidityPercent: 40 }),
      makeForecast({ forecastAt: isoPlusHours(2), humidityPercent: 62 }),
    ]);
    expect(decision.evidence.maximumHumidityPercent).toBe(62);
  });

  it('50. a duplicated temperature uses the minimum', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(2), temperatureCelsius: 21 }),
      makeForecast({ forecastAt: isoPlusHours(2), temperatureCelsius: 6 }),
    ]);
    expect(decision.evidence.minimumTemperatureCelsius).toBe(6);
  });

  it('51. a duplicated wind uses the maximum', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(2), windSpeedMetersPerSecond: 3 }),
      makeForecast({ forecastAt: isoPlusHours(2), windSpeedMetersPerSecond: 8 }),
    ]);
    expect(decision.evidence.maximumWindSpeedMetersPerSecond).toBe(8);
  });

  it('52. if any duplicate at an instant is a wet condition, the instant is wet', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(2), condition: 'CLEAR' }),
      makeForecast({ forecastAt: isoPlusHours(2), condition: 'RAIN' }),
    ]);
    expect(decision.status).toBe('NOT_RECOMMENDED');
    expect(decision.reasonCode).toBe('PRECIPITATION_EXPECTED');
  });

  it('53. shuffling the input order does not change the result', () => {
    const forecasts = [
      makeForecast({ forecastAt: isoPlusHours(1), humidityPercent: 60, temperatureCelsius: 16 }),
      makeForecast({ forecastAt: isoPlusHours(2), precipitationProbabilityPercent: 35 }),
      makeForecast({ forecastAt: isoPlusHours(3), windSpeedMetersPerSecond: 4 }),
      makeForecast({ forecastAt: isoPlusHours(4), humidityPercent: 65, temperatureCelsius: 14 }),
    ];
    const forward = assess(forecasts);
    const reversed = assess([...forecasts].reverse());
    expect(reversed).toEqual(forward);
  });

  it('54. consideredForecastCount is over distinct instants', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(2) }),
      makeForecast({ forecastAt: isoPlusHours(2) }),
      makeForecast({ forecastAt: isoPlusHours(3) }),
    ]);
    expect(decision.evidence.consideredForecastCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// G. Time and runtime defence (55–72)
// ---------------------------------------------------------------------------

describe('G. time window and runtime defence', () => {
  it('55. a forecast exactly at evaluatedAt is included', () => {
    const decision = assess([makeForecast({ forecastAt: isoPlusHours(0) })]);
    expect(decision.evidence.consideredForecastCount).toBe(1);
  });

  it('56. a forecast exactly at +8h is included', () => {
    const decision = assess([makeForecast({ forecastAt: isoPlusHours(8) })]);
    expect(decision.evidence.consideredForecastCount).toBe(1);
  });

  it('57. a past forecast is excluded', () => {
    const decision = assess([makeForecast({ forecastAt: isoPlusHours(-0.5) })]);
    expect(decision.evidence.consideredForecastCount).toBe(0);
  });

  it('58. a forecast beyond +8h is excluded', () => {
    const decision = assess([makeForecast({ forecastAt: isoPlusHours(8.5) })]);
    expect(decision.evidence.consideredForecastCount).toBe(0);
  });

  it('59. a seconds-precision ISO evaluatedAt is accepted', () => {
    const decision = assess([makeForecast({ forecastAt: isoPlusHours(2) })], '2026-07-15T12:00:00Z');
    expect(decision.evidence.windowStartAt).toBe('2026-07-15T12:00:00.000Z');
  });

  it('60. an exactly-3-digit millisecond ISO evaluatedAt is accepted', () => {
    const decision = assess([], '2026-07-15T12:00:00.250Z');
    expect(decision.evidence.windowStartAt).toBe('2026-07-15T12:00:00.250Z');
  });

  it('61. a timezone offset is converted to canonical UTC', () => {
    const decision = assess([], '2026-07-15T21:00:00+09:00');
    expect(decision.evidence.windowStartAt).toBe('2026-07-15T12:00:00.000Z');
    expect(decision.evidence.windowEndAt).toBe('2026-07-15T20:00:00.000Z');
  });

  it('62. minute-precision evaluatedAt is rejected', () => {
    expect(() => assess([], '2026-07-15T12:00Z')).toThrow(RangeError);
  });

  it('63. a timezone-less evaluatedAt is rejected', () => {
    expect(() => assess([], '2026-07-15T12:00:00')).toThrow(RangeError);
  });

  it('64. an impossible calendar date is rejected', () => {
    expect(() => assess([], '2026-02-30T12:00:00Z')).toThrow(RangeError);
  });

  it('65. an invalid evaluatedAt throws a fixed RangeError that does not echo the input', () => {
    const secret = 'not-a-date-πββ';
    expect(() => assess([], secret)).toThrow(RangeError);
    try {
      assess([], secret);
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).toBe(
        'evaluatedAt must be an ISO 8601 datetime with a timezone designator',
      );
    }
  });

  it('66. an invalid individual forecastAt is excluded, not fatal', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(2) }),
      makeForecast({ forecastAt: 'garbage' }),
    ]);
    expect(decision.evidence.consideredForecastCount).toBe(1);
  });

  it('67. a non-array hourlyForecasts is handled safely', () => {
    const decision = assess(null as unknown as HourlyForecast[]);
    expect(decision.status).toBe('INSUFFICIENT_DATA');
    expect(decision.evidence.consideredForecastCount).toBe(0);
  });

  it('68. malformed forecast items are excluded safely', () => {
    const items = [null, 42, 'x', true, [], {}] as unknown as HourlyForecast[];
    const decision = assess(items);
    expect(decision.status).toBe('INSUFFICIENT_DATA');
    expect(decision.evidence.consideredForecastCount).toBe(0);
  });

  it('69. NaN / Infinity / negative values on non-negative fields degrade to null', () => {
    const decision = assess([
      makeForecast({
        forecastAt: isoPlusHours(2),
        humidityPercent: Number.NaN,
        precipitationProbabilityPercent: Number.POSITIVE_INFINITY,
        windSpeedMetersPerSecond: -5,
        precipitationAmountMillimeters: -1,
      }),
    ]);
    expect(decision.evidence.maximumHumidityPercent).toBeNull();
    expect(decision.evidence.peakPrecipitationProbabilityPercent).toBeNull();
    expect(decision.evidence.maximumWindSpeedMetersPerSecond).toBeNull();
    expect(decision.evidence.peakPrecipitationAmountMillimeters).toBeNull();
  });

  it('70. a negative temperature is allowed', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(2), temperatureCelsius: -12 }),
    ]);
    expect(decision.evidence.minimumTemperatureCelsius).toBe(-12);
  });

  it('71. percent values outside 0–100 are excluded', () => {
    const decision = assess([
      makeForecast({
        forecastAt: isoPlusHours(2),
        humidityPercent: 150,
        precipitationProbabilityPercent: 120,
      }),
    ]);
    expect(decision.evidence.maximumHumidityPercent).toBeNull();
    expect(decision.evidence.peakPrecipitationProbabilityPercent).toBeNull();
  });

  it('72. an unknown condition string is never exposed and drives no precipitation', () => {
    const decision = assess([
      makeForecast({
        forecastAt: isoPlusHours(2),
        condition: 'TORNADO' as HourlyForecast['condition'],
        precipitationProbabilityPercent: null,
        precipitationAmountMillimeters: null,
        snowfallAmountCentimeters: null,
      }),
    ]);
    // Unknown condition → no wet signal, and not assessable via condition alone.
    expect(decision.status).not.toBe('NOT_RECOMMENDED');
    expect(JSON.stringify(decision)).not.toContain('TORNADO');
  });
});

// ---------------------------------------------------------------------------
// H. Evidence, purity, and copy (73–84)
// ---------------------------------------------------------------------------

describe('H. evidence, purity, and copy', () => {
  it('73. peak figures are null-ignoring maxima across instants', () => {
    const decision = assess([
      makeForecast({ forecastAt: isoPlusHours(1), precipitationProbabilityPercent: 10 }),
      makeForecast({ forecastAt: isoPlusHours(2), precipitationProbabilityPercent: null }),
      makeForecast({ forecastAt: isoPlusHours(3), precipitationProbabilityPercent: 45 }),
    ]);
    expect(decision.evidence.peakPrecipitationProbabilityPercent).toBe(45);
  });

  it('74. numeric precision is preserved (nothing is rounded)', () => {
    const decision = assess([
      makeForecast({
        forecastAt: isoPlusHours(2),
        precipitationProbabilityPercent: 59.9999,
        humidityPercent: 84.9999,
        precipitationAmountMillimeters: 0.123,
        temperatureCelsius: -3.7,
        windSpeedMetersPerSecond: 9.9999,
      }),
    ]);
    expect(decision.evidence.peakPrecipitationProbabilityPercent).toBe(59.9999);
    expect(decision.evidence.maximumHumidityPercent).toBe(84.9999);
    expect(decision.evidence.peakPrecipitationAmountMillimeters).toBe(0.123);
    expect(decision.evidence.minimumTemperatureCelsius).toBe(-3.7);
    expect(decision.evidence.maximumWindSpeedMetersPerSecond).toBe(9.9999);
  });

  it('75. a positive status has a null firstAdverseAt', () => {
    const decision = assess(coverageRun());
    expect(decision.status).toBe('EXCELLENT');
    expect(decision.evidence.firstAdverseAt).toBeNull();
  });

  it('76. an insufficient status has a null firstAdverseAt', () => {
    const decision = assess([makeForecast({ forecastAt: isoPlusHours(2) })]);
    expect(decision.status).toBe('INSUFFICIENT_DATA');
    expect(decision.evidence.firstAdverseAt).toBeNull();
  });

  it('77. each reason code maps to the exact Korean reason and recommendation', () => {
    const cases: Array<[LaundryReasonCode, () => LaundryDecision]> = [
      ['PRECIPITATION_EXPECTED', () => assess([makeForecast({ forecastAt: isoPlusHours(2), condition: 'RAIN' })])],
      ['STRONG_WIND', () => assess([makeForecast({ forecastAt: isoPlusHours(2), windSpeedMetersPerSecond: 12 })])],
      ['PRECIPITATION_POSSIBLE', () => assess([makeForecast({ forecastAt: isoPlusHours(2), precipitationProbabilityPercent: 40 })])],
      ['HIGH_HUMIDITY', () => assess([makeForecast({ forecastAt: isoPlusHours(2), humidityPercent: 90 })])],
      ['MARGINAL_DRYING_CONDITIONS', () => assess(coverageRun({ humidityPercent: 72, temperatureCelsius: 12 }))],
      ['FAVORABLE_DRYING_CONDITIONS', () => assess(coverageRun({ humidityPercent: 65, temperatureCelsius: 12 }))],
      ['EXCELLENT_DRYING_CONDITIONS', () => assess(coverageRun())],
      ['INSUFFICIENT_FORECAST', () => assess([makeForecast({ forecastAt: isoPlusHours(2) })])],
    ];
    const expected: Record<LaundryReasonCode, { reason: string; recommendation: string }> = {
      PRECIPITATION_EXPECTED: {
        reason: '평가 시간대에 비나 눈이 예상됩니다.',
        recommendation: '실외 건조는 미루고 실내 건조를 준비하세요.',
      },
      STRONG_WIND: {
        reason: '평가 시간대에 바람이 강해 빨래가 날리거나 떨어질 수 있습니다.',
        recommendation: '실외 건조는 피하고 실내에서 건조하세요.',
      },
      PRECIPITATION_POSSIBLE: {
        reason: '평가 시간대에 비나 눈이 올 가능성이 있습니다.',
        recommendation: '실외 건조는 권하지 않으며 최신 강수예보를 다시 확인하세요.',
      },
      HIGH_HUMIDITY: {
        reason: '평가 시간대의 습도가 높아 빨래가 잘 마르기 어렵습니다.',
        recommendation: '환기가 가능한 실내 건조나 건조기 사용을 고려하세요.',
      },
      MARGINAL_DRYING_CONDITIONS: {
        reason: '빨래를 말릴 수 있지만 건조 속도가 빠르지는 않겠습니다.',
        recommendation: '통풍이 잘되는 곳에 널고 충분한 건조 시간을 확보하세요.',
      },
      FAVORABLE_DRYING_CONDITIONS: {
        reason: '기온과 습도가 실외 건조에 무난한 편입니다.',
        recommendation: '지금부터 실외에 널어 건조해도 좋습니다.',
      },
      EXCELLENT_DRYING_CONDITIONS: {
        reason: '기온이 충분하고 습도가 낮아 빨래가 잘 마르겠습니다.',
        recommendation: '실외 건조에 좋은 시간대입니다.',
      },
      INSUFFICIENT_FORECAST: {
        reason: '빨래 건조 가능 여부를 판단할 시간별 예보가 부족합니다.',
        recommendation: '최신 시간별 날씨를 다시 확인하세요.',
      },
    };
    for (const [reasonCode, run] of cases) {
      const decision = run();
      expect(decision.reasonCode).toBe(reasonCode);
      expect(decision.reason).toBe(expected[reasonCode].reason);
      expect(decision.recommendation).toBe(expected[reasonCode].recommendation);
    }
  });

  it('78. the driver matches the reason code', () => {
    const expectedDriver: Partial<Record<LaundryReasonCode, LaundryDriver | null>> = {
      PRECIPITATION_EXPECTED: 'PRECIPITATION',
      STRONG_WIND: 'WIND',
      PRECIPITATION_POSSIBLE: 'PRECIPITATION',
      HIGH_HUMIDITY: 'HUMIDITY',
      MARGINAL_DRYING_CONDITIONS: 'TEMPERATURE_HUMIDITY',
      FAVORABLE_DRYING_CONDITIONS: 'TEMPERATURE_HUMIDITY',
      EXCELLENT_DRYING_CONDITIONS: 'TEMPERATURE_HUMIDITY',
      INSUFFICIENT_FORECAST: null,
    };
    const decisions: LaundryDecision[] = [
      assess([makeForecast({ forecastAt: isoPlusHours(2), condition: 'RAIN' })]),
      assess([makeForecast({ forecastAt: isoPlusHours(2), windSpeedMetersPerSecond: 12 })]),
      assess([makeForecast({ forecastAt: isoPlusHours(2), precipitationProbabilityPercent: 40 })]),
      assess([makeForecast({ forecastAt: isoPlusHours(2), humidityPercent: 90 })]),
      assess(coverageRun({ humidityPercent: 72, temperatureCelsius: 12 })),
      assess(coverageRun({ humidityPercent: 65, temperatureCelsius: 12 })),
      assess(coverageRun()),
      assess([makeForecast({ forecastAt: isoPlusHours(2) })]),
    ];
    for (const decision of decisions) {
      expect(decision.driver).toBe(expectedDriver[decision.reasonCode]);
    }
  });

  it('79. the input array and its objects are never mutated', () => {
    const forecasts = [
      makeForecast({ forecastAt: isoPlusHours(2), condition: 'RAIN', windSpeedMetersPerSecond: 12 }),
      makeForecast({ forecastAt: isoPlusHours(4), humidityPercent: 90 }),
    ];
    const snapshot = JSON.parse(JSON.stringify(forecasts));
    assess(forecasts);
    expect(forecasts).toEqual(snapshot);
  });

  it('80. extra properties and unused windDirection are not copied into the result', () => {
    const forecast = {
      ...makeForecast({ forecastAt: isoPlusHours(2), windDirectionDegrees: 180 }),
      unexpectedExtra: 'leak',
    } as unknown as HourlyForecast;
    const decision = assess([forecast]);
    expect(Object.keys(decision).sort()).toEqual(
      [
        'dataQuality',
        'driver',
        'evidence',
        'policyVersion',
        'reason',
        'reasonCode',
        'recommendation',
        'status',
      ].sort(),
    );
    expect(Object.keys(decision.evidence).sort()).toEqual(
      [
        'consideredForecastCount',
        'dryingCoverageMet',
        'dryingForecastCount',
        'firstAdverseAt',
        'lastDryingForecastAt',
        'maximumHumidityPercent',
        'maximumWindSpeedMetersPerSecond',
        'minimumTemperatureCelsius',
        'peakPrecipitationAmountMillimeters',
        'peakPrecipitationProbabilityPercent',
        'peakSnowfallAmountCentimeters',
        'windowEndAt',
        'windowStartAt',
      ].sort(),
    );
    expect(JSON.stringify(decision)).not.toContain('unexpectedExtra');
    expect(JSON.stringify(decision)).not.toContain('windDirection');
  });

  it('81. Date.now and fetch are never called', () => {
    const dateNowSpy = vi.spyOn(Date, 'now');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    assess(coverageRun());
    assess([makeForecast({ forecastAt: isoPlusHours(2), condition: 'RAIN' })]);
    expect(dateNowSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('82. LAUNDRY_POLICY is frozen', () => {
    expect(Object.isFrozen(LAUNDRY_POLICY)).toBe(true);
    expect(() => {
      (LAUNDRY_POLICY as { policyVersion: string }).policyVersion = '9.9.9';
    }).toThrow();
  });

  it('83. policyVersion is returned stably', () => {
    expect(LAUNDRY_POLICY.policyVersion).toBe('1.0.0');
    expect(assess(coverageRun()).policyVersion).toBe('1.0.0');
  });

  it('84. the same input returns the same output on repeated calls', () => {
    const forecasts = coverageRun({ humidityPercent: 60, temperatureCelsius: 16 });
    const first = assess(forecasts);
    const second = assess(forecasts);
    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// Extra data-quality regression coverage
// ---------------------------------------------------------------------------

describe('data quality matrix', () => {
  const cases: Array<[string, LaundryDecision, LaundryStatus, string]> = [
    [
      'a single clear precipitation forecast is NOT_RECOMMENDED / LIMITED',
      assess([makeForecast({ forecastAt: isoPlusHours(2), condition: 'RAIN' })]),
      'NOT_RECOMMENDED',
      'LIMITED',
    ],
    [
      'sufficient forecasts with rain are NOT_RECOMMENDED / SUFFICIENT',
      assess(coverageRun({ condition: 'RAIN' })),
      'NOT_RECOMMENDED',
      'SUFFICIENT',
    ],
    ['a positive verdict is always SUFFICIENT', assess(coverageRun()), 'EXCELLENT', 'SUFFICIENT'],
    [
      'no signal and no coverage is INSUFFICIENT_DATA / INSUFFICIENT',
      assess([makeForecast({ forecastAt: isoPlusHours(2) })]),
      'INSUFFICIENT_DATA',
      'INSUFFICIENT',
    ],
  ];

  for (const [name, decision, status, dataQuality] of cases) {
    it(name, () => {
      expect(decision.status).toBe(status);
      expect(decision.dataQuality).toBe(dataQuality);
    });
  }
});
