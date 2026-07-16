import type { WeatherOverview } from '../index';

/**
 * A fully-populated, valid {@link WeatherOverview} (every section present, no
 * `missingSections`). Returned as a fresh object each call so tests can mutate it freely.
 */
export function fullOverview(): WeatherOverview {
  return {
    location: {
      id: 'loc_seoul_jung',
      displayName: '서울특별시 중구',
      countryCode: 'KR',
      adminArea1: '서울특별시',
      adminArea2: '중구',
      adminArea3: null,
      latitude: 37.5636,
      longitude: 126.997,
      timezone: 'Asia/Seoul',
    },
    current: {
      observedAt: '2026-07-15T01:00:00Z',
      condition: 'CLEAR',
      temperatureCelsius: 28.4,
      feelsLikeCelsius: 30.1,
      humidityPercent: 62,
      windSpeedMetersPerSecond: 2.3,
      windDirectionDegrees: 270,
      precipitationLastHourMillimeters: 0,
      visibilityMeters: 12000,
    },
    hourly: [
      {
        forecastAt: '2026-07-15T02:00:00Z',
        condition: 'PARTLY_CLOUDY',
        temperatureCelsius: 27.9,
        feelsLikeCelsius: null,
        precipitationProbabilityPercent: 20,
        precipitationAmountMillimeters: 0,
        snowfallAmountCentimeters: 0,
        humidityPercent: 64,
        windSpeedMetersPerSecond: 2.1,
        windDirectionDegrees: 250,
      },
    ],
    daily: [
      {
        date: '2026-07-15',
        minimumTemperatureCelsius: 24.5,
        maximumTemperatureCelsius: 31.2,
        overall: null,
        morning: { condition: 'CLEAR', precipitationProbabilityPercent: 10 },
        afternoon: { condition: 'RAIN', precipitationProbabilityPercent: 60 },
        sunriseAt: '2026-07-14T20:19:00Z',
        sunsetAt: '2026-07-15T10:49:00Z',
      },
      {
        // A mid-range day (D+8~D+10): single all-day state in `overall`.
        date: '2026-07-23',
        minimumTemperatureCelsius: 25,
        maximumTemperatureCelsius: 33,
        overall: { condition: 'CLOUDY', precipitationProbabilityPercent: 40 },
        morning: null,
        afternoon: null,
        sunriseAt: null,
        sunsetAt: null,
      },
    ],
    airQuality: {
      current: {
        measuredAt: '2026-07-15T01:00:00Z',
        pm10MicrogramsPerCubicMeter: 34,
        pm25MicrogramsPerCubicMeter: 18,
        ozonePartsPerMillion: 0.032,
        comprehensiveAirQualityIndex: 58,
        overallGrade: 'MODERATE',
        pm10Grade: 'GOOD',
        pm25Grade: 'MODERATE',
        ozoneGrade: 'MODERATE',
      },
      daily: [
        {
          date: '2026-07-16',
          pm10Grade: 'MODERATE',
          pm25Grade: 'MODERATE',
          ozoneGrade: null,
        },
      ],
    },
    alerts: [
      {
        id: 'alert_heatwave_2026_0715',
        type: 'HEAT_WAVE',
        severity: 'WARNING',
        title: '폭염경보',
        description: '낮 최고기온 35도 이상이 지속되겠습니다.',
        areas: ['서울특별시'],
        issuedAt: '2026-07-15T00:00:00Z',
        effectiveAt: '2026-07-15T00:00:00Z',
        expiresAt: null,
      },
    ],
    missingSections: [],
    sources: [
      {
        sourceId: 'src_kma_short_term',
        provider: 'KMA',
        sections: ['CURRENT', 'HOURLY', 'DAILY'],
        issuedAt: '2026-07-15T00:00:00Z',
        observedAt: '2026-07-15T01:00:00Z',
        fetchedAt: '2026-07-15T01:05:00Z',
        retrievalMode: 'LIVE',
      },
      {
        sourceId: 'src_air_korea',
        provider: 'AIR_KOREA',
        sections: ['AIR_QUALITY_CURRENT', 'AIR_QUALITY_FORECAST'],
        issuedAt: null,
        observedAt: '2026-07-15T01:00:00Z',
        fetchedAt: '2026-07-15T01:05:00Z',
        retrievalMode: 'LIVE',
      },
    ],
  };
}
