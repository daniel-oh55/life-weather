/**
 * Deterministic, synthetic fixtures for the weather API client tests.
 *
 * Everything here is fabricated — synthetic identifiers, display names, and coordinates, plus
 * the `example.test` origin — so no real user location, stored place, or device identifier is
 * ever used. Each builder returns a *fresh* object so a test can freeze or mutate it without
 * leaking into another test.
 *
 * This file has no `.test.` in its name, so Vitest does not collect it as a suite.
 */

import type {
  WeatherErrorResponseV1,
  WeatherLocation,
  WeatherRequestV1,
  WeatherSuccessResponseV1,
} from '@life-weather/contracts';

/** A synthetic origin for building the client. Never a real domain. */
export const SYNTHETIC_BASE_URL = 'https://example.test';

/** The exact endpoint the client must POST to for {@link SYNTHETIC_BASE_URL}. */
export const SYNTHETIC_WEATHER_URL = 'https://example.test/weather';

/**
 * A marker used to prove the client never leaks caller/upstream content into an error. Placed
 * in a rejected request's extra field and in a response body; asserted absent from any error.
 */
export const SECRET_MARKER = 'SYNTHETIC_SECRET_MARKER_MUST_NOT_LEAK';

/** A fully synthetic {@link WeatherLocation}. */
export function syntheticLocation(): WeatherLocation {
  return {
    id: 'synthetic-location-1',
    displayName: 'Synthetic City',
    countryCode: 'KR',
    adminArea1: 'Synthetic Province',
    adminArea2: 'Synthetic District',
    adminArea3: null,
    latitude: 12.34,
    longitude: 56.78,
    timezone: 'UTC',
  };
}

/** A valid `{ location }` request body. */
export function validWeatherRequest(): WeatherRequestV1 {
  return { location: syntheticLocation() };
}

function syntheticMeta() {
  return {
    contractVersion: 1 as const,
    generatedAt: '2026-07-15T09:00:00Z',
    requestId: null,
  };
}

function syntheticHourlyEntry() {
  return {
    forecastAt: '2026-07-15T12:00:00Z',
    condition: 'CLEAR' as const,
    temperatureCelsius: 21,
    feelsLikeCelsius: 20,
    precipitationProbabilityPercent: 10,
    precipitationAmountMillimeters: 0,
    snowfallAmountCentimeters: 0,
    humidityPercent: 55,
    windSpeedMetersPerSecond: 2.4,
    windDirectionDegrees: 180,
  };
}

function syntheticHourlySource() {
  return {
    sourceId: 'kma-short-forecast-hourly',
    provider: 'KMA' as const,
    sections: ['HOURLY'],
    issuedAt: '2026-07-15T11:00:00Z',
    observedAt: null,
    fetchedAt: '2026-07-15T11:05:00Z',
    retrievalMode: 'LIVE' as const,
  };
}

/**
 * A valid success response carrying an hourly-only overview — the production `POST /weather`
 * shape today: hourly data present, every other section reported missing.
 */
export function successResponseBody(): WeatherSuccessResponseV1 {
  return {
    ok: true,
    meta: syntheticMeta(),
    data: {
      location: syntheticLocation(),
      current: null,
      hourly: [syntheticHourlyEntry()],
      daily: [],
      airQuality: { current: null, daily: [] },
      alerts: [],
      missingSections: [
        'CURRENT',
        'DAILY',
        'AIR_QUALITY_CURRENT',
        'AIR_QUALITY_FORECAST',
        'ALERTS',
      ],
      sources: [syntheticHourlySource()],
    },
  } as WeatherSuccessResponseV1;
}

/**
 * A valid success response for the no-selection case: `current: null`, `daily: []`, empty
 * hourly, and `missingSections` including `HOURLY` as well.
 */
export function noSelectionSuccessResponseBody(): WeatherSuccessResponseV1 {
  return {
    ok: true,
    meta: syntheticMeta(),
    data: {
      location: syntheticLocation(),
      current: null,
      hourly: [],
      daily: [],
      airQuality: { current: null, daily: [] },
      alerts: [],
      missingSections: [
        'CURRENT',
        'HOURLY',
        'DAILY',
        'AIR_QUALITY_CURRENT',
        'AIR_QUALITY_FORECAST',
        'ALERTS',
      ],
      sources: [],
    },
  } as WeatherSuccessResponseV1;
}

/** A valid V1 API error response (a successful round-trip whose body is a contract error). */
export function apiErrorResponseBody(): WeatherErrorResponseV1 {
  return {
    ok: false,
    meta: syntheticMeta(),
    error: {
      code: 'LOCATION_NOT_FOUND',
      message: 'The requested location could not be resolved.',
      retryable: false,
    },
  };
}
