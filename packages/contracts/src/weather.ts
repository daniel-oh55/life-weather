import { z } from 'zod';

import { currentAirQuality, dailyAirQualityForecast } from './air-quality';
import { weatherAlert } from './alerts';
import {
  isoDate,
  isoDateTime,
  nonEmptyString,
  nonNegativeNumber,
  percent,
  retrievalMode,
  sourceProvider,
  temperatureCelsius,
  weatherCondition,
  weatherDataSection,
  windDirectionDegrees,
  type WeatherDataSection,
} from './common';
import { weatherLocation } from './location';

/**
 * Provenance for a slice of the weather payload.
 *
 * `sourceId` is an app-internal identifier — provider-native source codes are not exposed
 * to the mobile response. Forecast data typically has `issuedAt` with `observedAt: null`;
 * observed (실황) data has `observedAt` with `issuedAt: null`; DERIVED data may have both
 * `null`.
 */
export const sourceMetadata = z.object({
  sourceId: nonEmptyString,
  provider: sourceProvider.compatible,
  /** Sections this source contributed; at least one, no duplicates. */
  sections: z
    .array(weatherDataSection.compatible)
    .min(1)
    .refine((sections) => new Set(sections).size === sections.length, {
      message: 'sections must not contain duplicate values',
    }),
  issuedAt: isoDateTime.nullable(),
  observedAt: isoDateTime.nullable(),
  fetchedAt: isoDateTime,
  retrievalMode: retrievalMode.compatible,
});

export type SourceMetadata = z.infer<typeof sourceMetadata>;

/**
 * Current conditions. A measurement is `null` when the provider does not supply it or it
 * cannot be normalized. `feelsLikeCelsius` is a derived value and is `null` when absent.
 */
export const currentWeather = z.object({
  observedAt: isoDateTime,
  condition: weatherCondition.compatible,
  temperatureCelsius,
  feelsLikeCelsius: temperatureCelsius.nullable(),
  humidityPercent: percent.nullable(),
  windSpeedMetersPerSecond: nonNegativeNumber.nullable(),
  windDirectionDegrees: windDirectionDegrees.nullable(),
  precipitationLastHourMillimeters: nonNegativeNumber.nullable(),
  visibilityMeters: nonNegativeNumber.nullable(),
});

export type CurrentWeather = z.infer<typeof currentWeather>;

/**
 * One hourly forecast step. A confirmed no-precipitation / no-snowfall value is `0`; a
 * value the provider does not supply or that cannot be converted is `null`.
 */
export const hourlyForecast = z.object({
  forecastAt: isoDateTime,
  condition: weatherCondition.compatible,
  temperatureCelsius,
  feelsLikeCelsius: temperatureCelsius.nullable(),
  precipitationProbabilityPercent: percent.nullable(),
  precipitationAmountMillimeters: nonNegativeNumber.nullable(),
  snowfallAmountCentimeters: nonNegativeNumber.nullable(),
  humidityPercent: percent.nullable(),
  windSpeedMetersPerSecond: nonNegativeNumber.nullable(),
  windDirectionDegrees: windDirectionDegrees.nullable(),
});

export type HourlyForecast = z.infer<typeof hourlyForecast>;

/**
 * A condition + precipitation-probability summary for part of a day (overall, morning or
 * afternoon of a {@link dailyForecast}).
 */
export const forecastPeriod = z.object({
  condition: weatherCondition.compatible,
  precipitationProbabilityPercent: percent.nullable(),
});

export type ForecastPeriod = z.infer<typeof forecastPeriod>;

/**
 * One day of the daily forecast.
 *
 * A single all-day state (mid-range forecast D+8~D+10) goes in `overall`, never duplicated
 * into `morning`/`afternoon`. Days with distinct morning/afternoon states (D+3~D+7) use
 * `morning`/`afternoon`. All three periods may be `null` — a day with temperatures but no
 * condition data.
 */
export const dailyForecast = z.object({
  date: isoDate,
  minimumTemperatureCelsius: temperatureCelsius.nullable(),
  maximumTemperatureCelsius: temperatureCelsius.nullable(),
  overall: forecastPeriod.nullable(),
  morning: forecastPeriod.nullable(),
  afternoon: forecastPeriod.nullable(),
  sunriseAt: isoDateTime.nullable(),
  sunsetAt: isoDateTime.nullable(),
});

export type DailyForecast = z.infer<typeof dailyForecast>;

/**
 * The aggregate weather payload for a location.
 *
 * Every list field is an array (never `null`). `missingSections` records which sections
 * failed to load; the `superRefine` below rejects any payload where the presence of data
 * and the `missingSections` set contradict each other. `UNKNOWN` entries in
 * `missingSections` are ignored by the invariant checks.
 */
export const weatherOverview = z
  .object({
    location: weatherLocation,
    current: currentWeather.nullable(),
    hourly: z.array(hourlyForecast),
    daily: z.array(dailyForecast),
    airQuality: z.object({
      current: currentAirQuality.nullable(),
      daily: z.array(dailyAirQualityForecast),
    }),
    alerts: z.array(weatherAlert),
    missingSections: z.array(weatherDataSection.compatible),
    sources: z.array(sourceMetadata),
  })
  .superRefine((overview, ctx) => {
    const missingSet = new Set<WeatherDataSection>(overview.missingSections);
    const isMissing = (section: WeatherDataSection): boolean =>
      missingSet.has(section);

    // No duplicate sections in missingSections.
    if (overview.missingSections.length !== missingSet.size) {
      ctx.addIssue({
        code: 'custom',
        path: ['missingSections'],
        message: 'missingSections must not contain duplicate sections',
      });
    }

    // current <-> CURRENT (biconditional).
    if (overview.current === null && !isMissing('CURRENT')) {
      ctx.addIssue({
        code: 'custom',
        path: ['current'],
        message: 'current is null but missingSections does not include CURRENT',
      });
    }
    if (overview.current !== null && isMissing('CURRENT')) {
      ctx.addIssue({
        code: 'custom',
        path: ['current'],
        message: 'current is present but missingSections includes CURRENT',
      });
    }

    // airQuality.current <-> AIR_QUALITY_CURRENT (biconditional).
    if (
      overview.airQuality.current === null &&
      !isMissing('AIR_QUALITY_CURRENT')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['airQuality', 'current'],
        message:
          'airQuality.current is null but missingSections does not include AIR_QUALITY_CURRENT',
      });
    }
    if (
      overview.airQuality.current !== null &&
      isMissing('AIR_QUALITY_CURRENT')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['airQuality', 'current'],
        message:
          'airQuality.current is present but missingSections includes AIR_QUALITY_CURRENT',
      });
    }

    // A missing list section must carry no data; data implies the section is not missing.
    if (isMissing('HOURLY') && overview.hourly.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['hourly'],
        message: 'hourly has entries but missingSections includes HOURLY',
      });
    }
    if (isMissing('DAILY') && overview.daily.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['daily'],
        message: 'daily has entries but missingSections includes DAILY',
      });
    }
    if (
      isMissing('AIR_QUALITY_FORECAST') &&
      overview.airQuality.daily.length > 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['airQuality', 'daily'],
        message:
          'airQuality.daily has entries but missingSections includes AIR_QUALITY_FORECAST',
      });
    }
    if (isMissing('ALERTS') && overview.alerts.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['alerts'],
        message: 'alerts has entries but missingSections includes ALERTS',
      });
    }
  });

export type WeatherOverview = z.infer<typeof weatherOverview>;
