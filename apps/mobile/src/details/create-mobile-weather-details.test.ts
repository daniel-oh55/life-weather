import type {
  CurrentWeather,
  WeatherAlert,
  WeatherAlertSeverity,
  WeatherAlertType,
  WeatherCondition,
  WeatherDataSection,
  WeatherSuccessResponseV1,
} from '@life-weather/contracts';
import { describe, expect, it } from 'vitest';

import { createMobileWeatherDetails } from './create-mobile-weather-details';

// ---------------------------------------------------------------------------
// Fixtures — real contract shapes. This suite verifies the mobile presentation connection
// (availability policy, label mapping, timestamp formatting, purity) — not the shared contract's
// own invariants, which are already tested in `packages/contracts`.
// ---------------------------------------------------------------------------

const GENERATED_AT = '2026-08-05T05:00:00Z';

function sharedLocationFields(id = 'loc-a', timezone = 'Asia/Seoul') {
  return {
    id,
    displayName: 'Synthetic Location',
    countryCode: 'KR',
    adminArea1: 'Synthetic Province',
    adminArea2: 'Synthetic District',
    adminArea3: null,
    latitude: 37.5,
    longitude: 127.0,
    timezone,
  };
}

function currentFixture(overrides: Partial<CurrentWeather> = {}): CurrentWeather {
  return {
    observedAt: '2026-08-05T04:00:00Z',
    condition: 'CLEAR',
    temperatureCelsius: 23,
    feelsLikeCelsius: null,
    humidityPercent: null,
    windSpeedMetersPerSecond: null,
    windDirectionDegrees: null,
    precipitationLastHourMillimeters: null,
    visibilityMeters: null,
    ...overrides,
  };
}

function alertFixture(overrides: Partial<WeatherAlert> = {}): WeatherAlert {
  return {
    id: 'synthetic-alert-id',
    type: 'HEAVY_RAIN',
    severity: 'WARNING',
    title: 'Synthetic Alert Title',
    description: 'Synthetic alert description.',
    areas: ['Synthetic District'],
    issuedAt: '2026-08-05T03:00:00Z',
    effectiveAt: '2026-08-05T04:00:00Z',
    expiresAt: '2026-08-05T10:00:00Z',
    ...overrides,
  };
}

function successResponse(options: {
  current?: CurrentWeather | null;
  alerts?: readonly WeatherAlert[];
  timezone?: string;
  generatedAt?: string;
}): WeatherSuccessResponseV1 {
  const current = options.current ?? null;
  const alerts = options.alerts ?? [];
  const missingSections: WeatherDataSection[] = ['HOURLY', 'DAILY', 'AIR_QUALITY_CURRENT', 'AIR_QUALITY_FORECAST'];
  if (current === null) {
    missingSections.push('CURRENT');
  }
  if (alerts.length === 0) {
    missingSections.push('ALERTS');
  }

  return {
    ok: true,
    meta: {
      contractVersion: 1,
      generatedAt: options.generatedAt ?? GENERATED_AT,
      requestId: 'synthetic-request-id',
    },
    data: {
      location: sharedLocationFields('loc-a', options.timezone ?? 'Asia/Seoul'),
      current,
      hourly: [],
      daily: [],
      airQuality: { current: null, daily: [] },
      alerts: [...alerts],
      missingSections,
      sources: [],
    },
  };
}

// ---------------------------------------------------------------------------
// top-level shape and order.
// ---------------------------------------------------------------------------

describe('top-level structure', () => {
  it('returns alerts before current in key order', () => {
    const result = createMobileWeatherDetails(successResponse({}), 'Asia/Seoul');

    expect(Object.keys(result)).toEqual(['alerts', 'current']);
  });

  it('never includes hourly/daily/airQuality/sources/meta', () => {
    const result = createMobileWeatherDetails(
      successResponse({ current: currentFixture(), alerts: [alertFixture()] }),
      'Asia/Seoul',
    ) as unknown as Record<string, unknown>;

    expect(result.hourly).toBeUndefined();
    expect(result.daily).toBeUndefined();
    expect(result.airQuality).toBeUndefined();
    expect(result.sources).toBeUndefined();
    expect(result.meta).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// alert availability policy.
// ---------------------------------------------------------------------------

describe('alert availability', () => {
  it('is UNAVAILABLE with fixed message and no cards when ALERTS is missing', () => {
    const response = successResponse({ current: null, alerts: [] });
    const result = createMobileWeatherDetails(response, 'Asia/Seoul');

    expect(result.alerts.status).toBe('UNAVAILABLE');
    expect(result.alerts.message).toBe('기상특보 정보를 제공하지 못했습니다.');
    expect(result.alerts.cards).toEqual([]);
  });

  it('is NONE with fixed message when ALERTS is present but empty', () => {
    const response = successResponse({ alerts: [] });
    response.data.missingSections = response.data.missingSections.filter((s) => s !== 'ALERTS');
    const result = createMobileWeatherDetails(response, 'Asia/Seoul');

    expect(result.alerts.status).toBe('NONE');
    expect(result.alerts.message).toBe('현재 발표된 기상특보가 없습니다.');
    expect(result.alerts.cards).toEqual([]);
  });

  it('is AVAILABLE and preserves response order for multiple alerts', () => {
    const first = alertFixture({ title: 'First Alert', id: 'a1' });
    const second = alertFixture({ title: 'Second Alert', id: 'a2' });
    const response = successResponse({ alerts: [first, second] });
    const result = createMobileWeatherDetails(response, 'Asia/Seoul');

    expect(result.alerts.status).toBe('AVAILABLE');
    expect(result.alerts.message).toBeNull();
    expect(result.alerts.cards).toHaveLength(2);
    expect(result.alerts.cards[0]?.title).toBe('First Alert');
    expect(result.alerts.cards[1]?.title).toBe('Second Alert');
  });
});

// ---------------------------------------------------------------------------
// alert severity / type exhaustive mapping.
// ---------------------------------------------------------------------------

describe('alert severity mapping', () => {
  it.each([
    ['INFO', '안내'],
    ['ADVISORY', '주의보'],
    ['WARNING', '경보'],
    ['EMERGENCY', '긴급'],
    ['UNKNOWN', '등급 미확인'],
  ] satisfies [WeatherAlertSeverity, string][])('maps %s to "%s"', (severity, label) => {
    const response = successResponse({ alerts: [alertFixture({ severity })] });
    const result = createMobileWeatherDetails(response, 'Asia/Seoul');

    expect(result.alerts.cards[0]?.severityLabel).toBe(label);
  });
});

describe('alert type mapping', () => {
  it.each([
    ['HEAVY_RAIN', '호우'],
    ['HEAVY_SNOW', '대설'],
    ['HIGH_WIND', '강풍'],
    ['HIGH_SEAS', '풍랑'],
    ['TYPHOON', '태풍'],
    ['HEAT_WAVE', '폭염'],
    ['COLD_WAVE', '한파'],
    ['DRY', '건조'],
    ['STORM_SURGE', '폭풍해일'],
    ['YELLOW_DUST', '황사'],
    ['FOG', '안개'],
    ['THUNDERSTORM', '뇌우'],
    ['OTHER', '기타'],
  ] satisfies [WeatherAlertType, string][])('maps %s to "%s"', (type, label) => {
    const response = successResponse({ alerts: [alertFixture({ type })] });
    const result = createMobileWeatherDetails(response, 'Asia/Seoul');

    expect(result.alerts.cards[0]?.typeLabel).toBe(label);
  });
});

// ---------------------------------------------------------------------------
// alert title/description/effective/expires/areas passthrough.
// ---------------------------------------------------------------------------

describe('alert content passthrough', () => {
  it('preserves title and non-null description verbatim', () => {
    const response = successResponse({
      alerts: [alertFixture({ title: 'Exact Title', description: 'Exact description text.' })],
    });
    const result = createMobileWeatherDetails(response, 'Asia/Seoul');

    expect(result.alerts.cards[0]?.title).toBe('Exact Title');
    expect(result.alerts.cards[0]?.description).toBe('Exact description text.');
  });

  it('preserves a null description as null', () => {
    const response = successResponse({ alerts: [alertFixture({ description: null })] });
    const result = createMobileWeatherDetails(response, 'Asia/Seoul');

    expect(result.alerts.cards[0]?.description).toBeNull();
  });

  it('preserves null effectiveAt/expiresAt as null labels', () => {
    const response = successResponse({
      alerts: [alertFixture({ effectiveAt: null, expiresAt: null })],
    });
    const result = createMobileWeatherDetails(response, 'Asia/Seoul');

    expect(result.alerts.cards[0]?.effectiveAtLabel).toBeNull();
    expect(result.alerts.cards[0]?.expiresAtLabel).toBeNull();
  });

  it('joins areas in order with ", "', () => {
    const response = successResponse({
      alerts: [alertFixture({ areas: ['Area One', 'Area Two', 'Area Three'] })],
    });
    const result = createMobileWeatherDetails(response, 'Asia/Seoul');

    expect(result.alerts.cards[0]?.areasLabel).toBe('Area One, Area Two, Area Three');
  });

  it('never exposes alert id, requestId, source, or provider fields', () => {
    const response = successResponse({ alerts: [alertFixture()] });
    const result = createMobileWeatherDetails(response, 'Asia/Seoul') as unknown as {
      alerts: { cards: Record<string, unknown>[] };
    };

    const card = result.alerts.cards[0] ?? {};
    expect(card.id).toBeUndefined();
    expect(card.sourceId).toBeUndefined();
    expect(card.provider).toBeUndefined();
    expect(card.requestId).toBeUndefined();
    expect(JSON.stringify(card)).not.toContain('synthetic-alert-id');
  });
});

// ---------------------------------------------------------------------------
// current-condition availability.
// ---------------------------------------------------------------------------

describe('current availability', () => {
  it('is UNAVAILABLE with fixed message when current is null', () => {
    const response = successResponse({ current: null });
    const result = createMobileWeatherDetails(response, 'Asia/Seoul');

    expect(result.current.status).toBe('UNAVAILABLE');
    expect(result.current.message).toBe('현재 관측 정보를 제공하지 못했습니다.');
  });

  it('shows required observedAt/condition/temperature when current is available', () => {
    const response = successResponse({
      current: currentFixture({ observedAt: '2026-08-05T04:00:00Z', condition: 'RAIN', temperatureCelsius: 18 }),
    });
    const result = createMobileWeatherDetails(response, 'Asia/Seoul');

    expect(result.current.status).toBe('AVAILABLE');
    if (result.current.status !== 'AVAILABLE') throw new Error('unreachable');
    expect(result.current.message).toBeNull();
    expect(result.current.conditionLabel).toBe('비');
    expect(result.current.temperatureLabel).toBe('18°C');
    expect(result.current.observedAtLabel).toBe('8월 5일 (수) 13:00');
  });
});

describe('current optional detail presentation', () => {
  it('creates a detail entry only for each non-null optional field', () => {
    const response = successResponse({
      current: currentFixture({
        feelsLikeCelsius: 20,
        humidityPercent: null,
        windSpeedMetersPerSecond: null,
        windDirectionDegrees: null,
        precipitationLastHourMillimeters: null,
        visibilityMeters: null,
      }),
    });
    const result = createMobileWeatherDetails(response, 'Asia/Seoul');
    if (result.current.status !== 'AVAILABLE') throw new Error('unreachable');

    expect(result.current.details).toEqual([{ id: 'FEELS_LIKE', text: '체감온도 20°C' }]);
  });

  it('shows every optional field, including zero values, when all are present', () => {
    const response = successResponse({
      current: currentFixture({
        feelsLikeCelsius: 0,
        humidityPercent: 0,
        windSpeedMetersPerSecond: 0,
        windDirectionDegrees: 0,
        precipitationLastHourMillimeters: 0,
        visibilityMeters: 0,
      }),
    });
    const result = createMobileWeatherDetails(response, 'Asia/Seoul');
    if (result.current.status !== 'AVAILABLE') throw new Error('unreachable');

    expect(result.current.details).toEqual([
      { id: 'FEELS_LIKE', text: '체감온도 0°C' },
      { id: 'HUMIDITY', text: '습도 0%' },
      { id: 'WIND_SPEED', text: '풍속 0m/s' },
      { id: 'WIND_DIRECTION', text: '풍향 0°' },
      { id: 'PRECIPITATION_LAST_HOUR', text: '최근 1시간 강수량 0mm' },
      { id: 'VISIBILITY', text: '가시거리 0m' },
    ]);
  });

  it('produces no detail entries when every optional field is null', () => {
    const response = successResponse({ current: currentFixture() });
    const result = createMobileWeatherDetails(response, 'Asia/Seoul');
    if (result.current.status !== 'AVAILABLE') throw new Error('unreachable');

    expect(result.current.details).toEqual([]);
  });
});

describe('WeatherCondition mapping', () => {
  it.each([
    ['CLEAR', '맑음'],
    ['RAIN', '비'],
    ['SNOW', '눈'],
    ['UNKNOWN', '상태 미확인'],
  ] satisfies [WeatherCondition, string][])('maps %s to "%s"', (condition, label) => {
    const response = successResponse({ current: currentFixture({ condition }) });
    const result = createMobileWeatherDetails(response, 'Asia/Seoul');
    if (result.current.status !== 'AVAILABLE') throw new Error('unreachable');

    expect(result.current.conditionLabel).toBe(label);
  });
});

// ---------------------------------------------------------------------------
// timestamp formatting.
// ---------------------------------------------------------------------------

describe('timestamp formatting', () => {
  it('formats using the given (selected-location) timezone, not device default', () => {
    const response = successResponse({
      current: currentFixture({ observedAt: '2026-08-05T05:00:00Z' }),
      timezone: 'Asia/Seoul',
    });
    const result = createMobileWeatherDetails(response, 'Asia/Seoul');
    if (result.current.status !== 'AVAILABLE') throw new Error('unreachable');

    expect(result.current.observedAtLabel).toBe('8월 5일 (수) 14:00');
  });

  it('falls back to the raw ISO string without throwing for an invalid timezone', () => {
    const response = successResponse({ current: currentFixture({ observedAt: '2026-08-05T05:00:00Z' }) });

    expect(() => createMobileWeatherDetails(response, 'Not/AZone')).not.toThrow();
    const result = createMobileWeatherDetails(response, 'Not/AZone');
    if (result.current.status !== 'AVAILABLE') throw new Error('unreachable');
    expect(result.current.observedAtLabel).toBe('2026-08-05T05:00:00Z');
  });

  it('does not depend on Date.now/system clock for identical input', () => {
    const response = successResponse({
      current: currentFixture({ observedAt: '2026-08-05T05:00:00Z' }),
      alerts: [alertFixture()],
    });

    const first = createMobileWeatherDetails(response, 'Asia/Seoul');
    const originalNow = Date.now;
    Date.now = () => 0;
    try {
      const second = createMobileWeatherDetails(response, 'Asia/Seoul');
      expect(second).toEqual(first);
    } finally {
      Date.now = originalNow;
    }
  });
});

// ---------------------------------------------------------------------------
// purity: no mutation, deep-equal for identical input, independent fresh outputs.
// ---------------------------------------------------------------------------

describe('purity', () => {
  it('does not mutate the input response or its nested objects/arrays', () => {
    const response = successResponse({
      current: currentFixture(),
      alerts: [alertFixture({ areas: ['Area One', 'Area Two'] })],
    });
    const snapshot = JSON.parse(JSON.stringify(response));

    createMobileWeatherDetails(response, 'Asia/Seoul');

    expect(response).toEqual(snapshot);
  });

  it('returns deep-equal results for identical input', () => {
    const response = successResponse({ current: currentFixture(), alerts: [alertFixture()] });

    const first = createMobileWeatherDetails(response, 'Asia/Seoul');
    const second = createMobileWeatherDetails(response, 'Asia/Seoul');

    expect(first).toEqual(second);
  });

  it('returns an independent fresh value on every call (no shared cache/reference)', () => {
    const response = successResponse({ current: currentFixture(), alerts: [alertFixture()] });

    const first = createMobileWeatherDetails(response, 'Asia/Seoul');
    const second = createMobileWeatherDetails(response, 'Asia/Seoul');

    expect(first).not.toBe(second);
    expect(first.alerts).not.toBe(second.alerts);
    expect(first.current).not.toBe(second.current);
  });
});
