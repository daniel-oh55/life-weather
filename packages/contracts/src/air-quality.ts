import { z } from 'zod';

import { airQualityGrade, isoDate, isoDateTime, nonNegativeNumber } from './common';

/**
 * A current air-quality observation.
 *
 * A measurement is `null` when the upstream value is missing, marked unavailable
 * (AirKorea's `-`), or lost to a communication failure. Grades use the
 * forward-compatible enum and are `null` when absent.
 */
export const currentAirQuality = z.object({
  measuredAt: isoDateTime,
  pm10MicrogramsPerCubicMeter: nonNegativeNumber.nullable(),
  pm25MicrogramsPerCubicMeter: nonNegativeNumber.nullable(),
  ozonePartsPerMillion: nonNegativeNumber.nullable(),
  /**
   * Provider-defined composite index (e.g. AirKorea CAI). May be `null` for providers
   * (e.g. overseas sources) that do not publish an equivalent composite index.
   */
  comprehensiveAirQualityIndex: nonNegativeNumber.nullable(),
  overallGrade: airQualityGrade.compatible.nullable(),
  pm10Grade: airQualityGrade.compatible.nullable(),
  pm25Grade: airQualityGrade.compatible.nullable(),
  ozoneGrade: airQualityGrade.compatible.nullable(),
});

export type CurrentAirQuality = z.infer<typeof currentAirQuality>;

/**
 * A daily air-quality forecast entry. Each grade is a forward-compatible enum or `null`.
 * Use `ozoneGrade: null` for periods where an ozone forecast is not provided.
 */
export const dailyAirQualityForecast = z.object({
  date: isoDate,
  pm10Grade: airQualityGrade.compatible.nullable(),
  pm25Grade: airQualityGrade.compatible.nullable(),
  ozoneGrade: airQualityGrade.compatible.nullable(),
});

export type DailyAirQualityForecast = z.infer<typeof dailyAirQualityForecast>;
