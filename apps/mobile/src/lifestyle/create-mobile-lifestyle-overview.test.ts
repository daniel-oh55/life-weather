import type { HourlyForecast, WeatherSuccessResponseV1 } from '@life-weather/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMobileLifestyleOverview } from './create-mobile-lifestyle-overview';

// ---------------------------------------------------------------------------
// Fixtures — real contract shapes, not lifestyle-engine internals. This suite verifies the
// mobile connection contract (input wiring, copy passthrough, purity) — not the underlying
// policy thresholds, which are already exhaustively pinned in `packages/lifestyle-engine`.
// ---------------------------------------------------------------------------

const GENERATED_AT = '2026-07-15T12:00:00Z';
const HOUR_IN_MS = 3_600_000;

function isoPlusHours(hours: number): string {
  return new Date(Date.parse(GENERATED_AT) + hours * HOUR_IN_MS).toISOString();
}

function sharedLocationFields(id = 'loc-a') {
  return {
    id,
    displayName: 'Synthetic Location',
    countryCode: 'KR',
    adminArea1: 'Synthetic Province',
    adminArea2: 'Synthetic District',
    adminArea3: null,
    latitude: 37.5,
    longitude: 127.0,
    timezone: 'Asia/Seoul',
  };
}

function hourlyEntry(overrides: Partial<HourlyForecast> & { forecastAt: string }): HourlyForecast {
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

/** `count` dry, usable (CLEAR) forecasts at +1h, +2h, ... — enough for a confident NOT_NEEDED /
 * GOOD-band read across every hourly-based engine. */
function dryHourlyForecasts(count: number): HourlyForecast[] {
  return Array.from({ length: count }, (_, index) =>
    hourlyEntry({
      forecastAt: isoPlusHours(index + 1),
      temperatureCelsius: 16,
      humidityPercent: 50,
    }),
  );
}

function currentAirQualityFixture(
  overrides: Partial<WeatherSuccessResponseV1['data']['airQuality']['current']> = {},
) {
  return {
    measuredAt: GENERATED_AT,
    pm10MicrogramsPerCubicMeter: 10,
    pm25MicrogramsPerCubicMeter: 5,
    ozonePartsPerMillion: 0.02,
    comprehensiveAirQualityIndex: 30,
    overallGrade: 'GOOD' as const,
    pm10Grade: 'GOOD' as const,
    pm25Grade: 'GOOD' as const,
    ozoneGrade: 'GOOD' as const,
    ...overrides,
  };
}

function successResponse(options: {
  hourly?: readonly HourlyForecast[];
  airQualityCurrent?: WeatherSuccessResponseV1['data']['airQuality']['current'];
  generatedAt?: string;
}): WeatherSuccessResponseV1 {
  const hourly = options.hourly ?? [];
  const airQualityCurrent = options.airQualityCurrent ?? null;
  const missingSections: WeatherSuccessResponseV1['data']['missingSections'] = ['CURRENT'];
  if (hourly.length === 0) {
    missingSections.push('HOURLY');
  }
  if (airQualityCurrent === null) {
    missingSections.push('AIR_QUALITY_CURRENT');
  }
  missingSections.push('AIR_QUALITY_FORECAST', 'ALERTS');

  return {
    ok: true,
    meta: {
      contractVersion: 1,
      generatedAt: options.generatedAt ?? GENERATED_AT,
      requestId: 'synthetic-request-id',
    },
    data: {
      location: sharedLocationFields(),
      current: null,
      hourly: [...hourly],
      daily: [],
      airQuality: { current: airQualityCurrent, daily: [] },
      alerts: [],
      missingSections,
      sources: [
        {
          sourceId: 'synthetic-source',
          provider: 'KMA',
          sections: ['HOURLY'],
          issuedAt: GENERATED_AT,
          observedAt: null,
          fetchedAt: GENERATED_AT,
          retrievalMode: 'LIVE',
        },
      ],
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 1–3: shape, order, titles.
// ---------------------------------------------------------------------------

describe('card shape and fixed order', () => {
  it('1. returns exactly four cards', () => {
    const cards = createMobileLifestyleOverview(successResponse({}));
    expect(cards).toHaveLength(4);
  });

  it('2. returns cards in fixed order UMBRELLA, OUTFIT, MASK, LAUNDRY', () => {
    const cards = createMobileLifestyleOverview(successResponse({}));
    expect(cards.map((card) => card.id)).toEqual(['UMBRELLA', 'OUTFIT', 'MASK', 'LAUNDRY']);
  });

  it('3. titles are 우산, 옷차림, 마스크, 빨래 in that order', () => {
    const cards = createMobileLifestyleOverview(successResponse({}));
    expect(cards.map((card) => card.title)).toEqual(['우산', '옷차림', '마스크', '빨래']);
  });
});

// ---------------------------------------------------------------------------
// 4–8: input wiring.
// ---------------------------------------------------------------------------

describe('input wiring', () => {
  it('4. uses response.meta.generatedAt as the evaluation instant, not the current instant', () => {
    // A generatedAt far in the past would be "STALE" for mask evidence if a fixed evaluatedAt
    // is used, but would be misclassified if the function silently substituted Date.now().
    const pastGeneratedAt = '2020-01-01T00:00:00Z';
    const cards = createMobileLifestyleOverview(
      successResponse({
        generatedAt: pastGeneratedAt,
        airQualityCurrent: currentAirQualityFixture({ measuredAt: pastGeneratedAt }),
      }),
    );
    const mask = cards.find((card) => card.id === 'MASK');
    expect(mask?.statusLabel).toBe('필요 낮음');
  });

  it('5. threads hourly forecasts into umbrella, outfit, and laundry', () => {
    const rainNow = [
      hourlyEntry({ forecastAt: isoPlusHours(0.5), condition: 'RAIN', temperatureCelsius: 10 }),
    ];
    const cards = createMobileLifestyleOverview(successResponse({ hourly: rainNow }));
    const umbrella = cards.find((card) => card.id === 'UMBRELLA');
    const laundry = cards.find((card) => card.id === 'LAUNDRY');
    expect(umbrella?.statusLabel).toBe('지금 필요');
    expect(laundry?.statusLabel).toBe('실외 건조 비추천');
  });

  it('6. threads airQuality.current into mask', () => {
    const cards = createMobileLifestyleOverview(
      successResponse({ airQualityCurrent: currentAirQualityFixture({ pm10Grade: 'VERY_BAD' }) }),
    );
    const mask = cards.find((card) => card.id === 'MASK');
    expect(mask?.statusLabel).toBe('착용 필요');
  });

  it('7. mask is 판단 보류 when airQuality.current is null — no fabricated fallback', () => {
    const cards = createMobileLifestyleOverview(successResponse({ airQualityCurrent: null }));
    const mask = cards.find((card) => card.id === 'MASK');
    expect(mask?.statusLabel).toBe('판단 보류');
  });

  it('8. umbrella, outfit, and laundry are 판단 보류 when hourly is empty', () => {
    const cards = createMobileLifestyleOverview(successResponse({ hourly: [] }));
    const byId = new Map(cards.map((card) => [card.id, card]));
    expect(byId.get('UMBRELLA')?.statusLabel).toBe('판단 보류');
    expect(byId.get('OUTFIT')?.statusLabel).toBe('판단 보류');
    expect(byId.get('LAUNDRY')?.statusLabel).toBe('판단 보류');
  });
});

// ---------------------------------------------------------------------------
// 9: representative status-label mapping across all four engines.
// ---------------------------------------------------------------------------

describe('status label mapping', () => {
  it('9. maps a representative non-INSUFFICIENT status per engine to its Korean label', () => {
    const cards = createMobileLifestyleOverview(
      successResponse({
        hourly: dryHourlyForecasts(8),
        airQualityCurrent: currentAirQualityFixture(),
      }),
    );
    const byId = new Map(cards.map((card) => [card.id, card]));
    expect(byId.get('UMBRELLA')?.statusLabel).toBe('필요 낮음');
    expect(byId.get('OUTFIT')?.statusLabel).toBe('온화함');
    expect(byId.get('MASK')?.statusLabel).toBe('필요 낮음');
    expect(byId.get('LAUNDRY')?.statusLabel).toBe('좋음');
  });
});

// ---------------------------------------------------------------------------
// 10–12: engine copy passthrough.
// ---------------------------------------------------------------------------

describe('engine copy passthrough', () => {
  it('10. reason and recommendation are the engine output, byte for byte', async () => {
    const { assessUmbrellaNeed } = await import('@life-weather/lifestyle-engine');
    const hourly = [
      hourlyEntry({ forecastAt: isoPlusHours(0.5), condition: 'RAIN', temperatureCelsius: 10 }),
    ];
    const expected = assessUmbrellaNeed({ evaluatedAt: GENERATED_AT, hourlyForecasts: hourly });

    const cards = createMobileLifestyleOverview(successResponse({ hourly }));
    const umbrella = cards.find((card) => card.id === 'UMBRELLA');

    expect(umbrella?.reason).toBe(expected.reason);
    expect(umbrella?.recommendation).toBe(expected.recommendation);
  });

  it('11. preserves outfit additionalRecommendation when layering is recommended', () => {
    // A >=8C spread across the 6h outfit window triggers layeringRecommended.
    const hourly = [
      hourlyEntry({ forecastAt: isoPlusHours(1), temperatureCelsius: 8 }),
      hourlyEntry({ forecastAt: isoPlusHours(5), temperatureCelsius: 18 }),
    ];
    const cards = createMobileLifestyleOverview(successResponse({ hourly }));
    const outfit = cards.find((card) => card.id === 'OUTFIT');
    expect(outfit?.additionalRecommendation).toBe(
      '시간대별 온도 차가 커서 벗고 입기 쉬운 겉옷을 준비하세요.',
    );
  });

  it('12. every non-outfit card has a null additionalRecommendation', () => {
    const hourly = [
      hourlyEntry({ forecastAt: isoPlusHours(1), temperatureCelsius: 8 }),
      hourlyEntry({ forecastAt: isoPlusHours(5), temperatureCelsius: 18 }),
    ];
    const cards = createMobileLifestyleOverview(
      successResponse({ hourly, airQualityCurrent: currentAirQualityFixture() }),
    );
    const byId = new Map(cards.map((card) => [card.id, card]));
    expect(byId.get('UMBRELLA')?.additionalRecommendation).toBeNull();
    expect(byId.get('MASK')?.additionalRecommendation).toBeNull();
    expect(byId.get('LAUNDRY')?.additionalRecommendation).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 13–14: purity.
// ---------------------------------------------------------------------------

describe('purity', () => {
  it('13. does not mutate the input response or its nested arrays/objects', () => {
    const response = successResponse({
      hourly: dryHourlyForecasts(8),
      airQualityCurrent: currentAirQualityFixture(),
    });
    const snapshot = JSON.parse(JSON.stringify(response)) as unknown;

    createMobileLifestyleOverview(response);

    expect(JSON.parse(JSON.stringify(response))).toEqual(snapshot);
  });

  it('14. does not depend on Date.now or the system clock', () => {
    const response = successResponse({
      hourly: dryHourlyForecasts(8),
      airQualityCurrent: currentAirQualityFixture(),
    });
    const before = createMobileLifestyleOverview(response);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2099-01-01T00:00:00Z'));
    const during = createMobileLifestyleOverview(response);
    vi.useRealTimers();

    expect(during).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// 15: no internal leakage.
// ---------------------------------------------------------------------------

describe('no internal detail leakage', () => {
  it('15. cards never carry requestId/source/provider/evidence/reasonCode/policyVersion keys', () => {
    const cards = createMobileLifestyleOverview(
      successResponse({
        hourly: dryHourlyForecasts(8),
        airQualityCurrent: currentAirQualityFixture(),
      }),
    );

    for (const card of cards) {
      const keys = Object.keys(card);
      expect(keys.sort()).toEqual(
        ['additionalRecommendation', 'id', 'reason', 'recommendation', 'statusLabel', 'title'].sort(),
      );
    }
    const serialized = JSON.stringify(cards);
    expect(serialized).not.toContain('requestId');
    expect(serialized).not.toContain('policyVersion');
    expect(serialized).not.toContain('reasonCode');
    expect(serialized).not.toContain('evidence');
    expect(serialized).not.toContain('synthetic-request-id');
    expect(serialized).not.toContain('synthetic-source');
  });
});

// ---------------------------------------------------------------------------
// 16–17: determinism and per-call independence.
// ---------------------------------------------------------------------------

describe('determinism and independence', () => {
  it('16. the same input produces a deep-equal result on repeated calls', () => {
    const response = successResponse({
      hourly: dryHourlyForecasts(8),
      airQualityCurrent: currentAirQualityFixture(),
    });

    const first = createMobileLifestyleOverview(response);
    const second = createMobileLifestyleOverview(response);

    expect(second).toEqual(first);
  });

  it('17. each call returns a fresh array (no shared mutable identity across calls)', () => {
    const response = successResponse({
      hourly: dryHourlyForecasts(8),
      airQualityCurrent: currentAirQualityFixture(),
    });

    const first = createMobileLifestyleOverview(response);
    const second = createMobileLifestyleOverview(response);

    expect(second).not.toBe(first);
  });
});
