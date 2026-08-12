import { describe, expect, it, vi } from 'vitest';

import {
  weatherOverview,
  type CurrentAirQuality,
  type SourceMetadata,
  type WeatherLocation,
  type WeatherOverview,
} from '@life-weather/contracts';
import { KmaForecastProduct } from '@life-weather/weather-core';

import type {
  AirKoreaLocationCurrentAirQualityInput,
  AirKoreaLocationCurrentAirQualityOptions,
  AirKoreaLocationCurrentAirQualityResult,
  AirKoreaLocationCurrentAirQualityService,
} from './airkorea-location-current-air-quality.js';
import type { AirKoreaCurrentSourceMetadataResolver } from './airkorea-current-source-metadata.js';
import {
  createKmaAirKoreaWeatherOverviewService,
  type KmaAirKoreaWeatherOverviewInput,
  type KmaAirKoreaWeatherOverviewOptions,
} from './kma-airkorea-weather-overview.js';
import type {
  KmaLocationCurrentHourlyOverviewInput,
  KmaLocationCurrentHourlyOverviewOptions,
  KmaLocationCurrentHourlyOverviewResult,
  KmaLocationCurrentHourlyOverviewService,
} from './kma-location-current-hourly-overview.js';
import { overlayAirKoreaCurrentAirQualityOnWeatherOverview } from './weather-overview-air-quality-overlay.js';

type KmaSuccess = Extract<KmaLocationCurrentHourlyOverviewResult, { readonly ok: true }>;
type KmaLocationFailure = Extract<
  KmaLocationCurrentHourlyOverviewResult,
  { readonly stage: 'LOCATION' }
>;

// ---------------------------------------------------------------------------
// Fixture builders.
// ---------------------------------------------------------------------------

function makeLocation(overrides: Partial<WeatherLocation> = {}): WeatherLocation {
  return {
    id: 'loc_seoul_hyehwa',
    displayName: '서울특별시 종로구 혜화동',
    countryCode: 'KR',
    adminArea1: '서울특별시',
    adminArea2: '종로구',
    adminArea3: '혜화동',
    latitude: 37.5861,
    longitude: 127.0022,
    timezone: 'Asia/Seoul',
    ...overrides,
  };
}

const HOURLY_SOURCE: SourceMetadata = {
  sourceId: 'kma-short-forecast-hourly',
  provider: 'KMA',
  sections: ['HOURLY'],
  issuedAt: '2026-08-11T05:00:00+09:00',
  observedAt: null,
  fetchedAt: '2026-08-11T05:05:00+09:00',
  retrievalMode: 'LIVE',
};

/** A KMA baseline overview shaped exactly like the real combined-pipeline output. */
function makeKmaOverview(location: WeatherLocation = makeLocation()): WeatherOverview {
  const overview = {
    location,
    current: null,
    hourly: [],
    daily: [],
    airQuality: { current: null, daily: [] },
    alerts: [],
    missingSections: ['CURRENT', 'HOURLY', 'DAILY', 'AIR_QUALITY_CURRENT', 'AIR_QUALITY_FORECAST', 'ALERTS'],
    sources: [],
  } satisfies WeatherOverview;
  return weatherOverview.parse(overview);
}

function makeKmaSuccess(location: WeatherLocation = makeLocation()): KmaSuccess {
  return {
    ok: true,
    selection: { selected: false, source: null, fallbackUsed: false, result: null } as never,
    overview: makeKmaOverview(location),
  };
}

function makeKmaLocationFailure(): KmaLocationFailure {
  return { ok: false, stage: 'LOCATION', error: { kind: 'UNSUPPORTED_LOCATION' } as never };
}

function makeCurrentAirQuality(overrides: Partial<CurrentAirQuality> = {}): CurrentAirQuality {
  return {
    measuredAt: '2026-08-11T14:00:00+09:00',
    pm10MicrogramsPerCubicMeter: 30,
    pm25MicrogramsPerCubicMeter: 15,
    ozonePartsPerMillion: 0.03,
    comprehensiveAirQualityIndex: 60,
    overallGrade: 'MODERATE',
    pm10Grade: 'GOOD',
    pm25Grade: 'MODERATE',
    ozoneGrade: 'GOOD',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Collaborator stubs.
// ---------------------------------------------------------------------------

function createKmaServiceStub(
  respond: (
    input: KmaLocationCurrentHourlyOverviewInput,
    options: KmaLocationCurrentHourlyOverviewOptions | undefined,
  ) => Promise<KmaLocationCurrentHourlyOverviewResult> | KmaLocationCurrentHourlyOverviewResult,
) {
  const calls: Array<{
    readonly input: KmaLocationCurrentHourlyOverviewInput;
    readonly options: KmaLocationCurrentHourlyOverviewOptions | undefined;
  }> = [];
  const fetchCurrentHourlyWeatherOverviewForLocation = vi.fn(
    (input: KmaLocationCurrentHourlyOverviewInput, options?: KmaLocationCurrentHourlyOverviewOptions) => {
      calls.push({ input, options });
      return Promise.resolve(respond(input, options));
    },
  );
  const service: KmaLocationCurrentHourlyOverviewService = {
    fetchCurrentHourlyWeatherOverviewForLocation,
  };
  return { service, fetchCurrentHourlyWeatherOverviewForLocation, calls };
}

function kmaServiceThatSyncThrows(error: unknown) {
  const fetchCurrentHourlyWeatherOverviewForLocation = vi.fn(() => {
    throw error;
  });
  const service: KmaLocationCurrentHourlyOverviewService = {
    fetchCurrentHourlyWeatherOverviewForLocation,
  };
  return { service, fetchCurrentHourlyWeatherOverviewForLocation };
}

function createAirKoreaServiceStub(
  respond: (
    input: AirKoreaLocationCurrentAirQualityInput,
    options: AirKoreaLocationCurrentAirQualityOptions | undefined,
  ) => Promise<AirKoreaLocationCurrentAirQualityResult> | AirKoreaLocationCurrentAirQualityResult,
) {
  const calls: Array<{
    readonly input: AirKoreaLocationCurrentAirQualityInput;
    readonly options: AirKoreaLocationCurrentAirQualityOptions | undefined;
  }> = [];
  const fetchCurrentAirQualityForLocation = vi.fn(
    (input: AirKoreaLocationCurrentAirQualityInput, options?: AirKoreaLocationCurrentAirQualityOptions) => {
      calls.push({ input, options });
      return Promise.resolve(respond(input, options));
    },
  );
  const service: AirKoreaLocationCurrentAirQualityService = { fetchCurrentAirQualityForLocation };
  return { service, fetchCurrentAirQualityForLocation, calls };
}

function airKoreaServiceThatSyncThrows(error: unknown) {
  const fetchCurrentAirQualityForLocation = vi.fn(() => {
    throw error;
  });
  const service: AirKoreaLocationCurrentAirQualityService = { fetchCurrentAirQualityForLocation };
  return { service, fetchCurrentAirQualityForLocation };
}

function airKoreaServiceThatRejects(error: unknown) {
  const fetchCurrentAirQualityForLocation = vi.fn(() => Promise.reject(error));
  const service: AirKoreaLocationCurrentAirQualityService = { fetchCurrentAirQualityForLocation };
  return { service, fetchCurrentAirQualityForLocation };
}

function neverAirKoreaService() {
  const fetchCurrentAirQualityForLocation = vi.fn((): Promise<AirKoreaLocationCurrentAirQualityResult> => {
    throw new Error('test setup: AirKorea service must not be called');
  });
  const service: AirKoreaLocationCurrentAirQualityService = { fetchCurrentAirQualityForLocation };
  return { service, fetchCurrentAirQualityForLocation };
}

function makeSourceMetadataResolver(fetchedAt = '2026-08-11T05:10:00.000Z') {
  const resolver = vi.fn((): ReturnType<AirKoreaCurrentSourceMetadataResolver> => ({
    sourceId: 'airkorea-current-air-quality',
    fetchedAt,
    retrievalMode: 'LIVE',
  }));
  return resolver;
}

function neverSourceMetadataResolver() {
  return vi.fn((): ReturnType<AirKoreaCurrentSourceMetadataResolver> => {
    throw new Error('test setup: source metadata resolver must not be called');
  });
}

// ---------------------------------------------------------------------------
// KMA LOCATION failure — AirKorea never attempted.
// ---------------------------------------------------------------------------

describe('createKmaAirKoreaWeatherOverviewService — KMA LOCATION failure', () => {
  it('returns the exact KMA LOCATION failure reference and calls AirKorea zero times', async () => {
    const kmaFailure = makeKmaLocationFailure();
    const kma = createKmaServiceStub(() => kmaFailure);
    const airKorea = neverAirKoreaService();
    const resolver = neverSourceMetadataResolver();
    const service = createKmaAirKoreaWeatherOverviewService(kma.service, airKorea.service, resolver);

    const result = await service.fetchCurrentHourlyWeatherOverviewForLocation({
      product: KmaForecastProduct.SHORT_FORECAST,
      location: makeLocation(),
    });

    expect(result).toBe(kmaFailure);
    expect(airKorea.fetchCurrentAirQualityForLocation).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// KMA success — AirKorea called with the exact KMA baseline location.
// ---------------------------------------------------------------------------

describe('createKmaAirKoreaWeatherOverviewService — KMA success routes to AirKorea', () => {
  it('calls AirKorea with { location } set to the exact kmaResult.overview.location reference', async () => {
    const location = makeLocation();
    const kmaResult = makeKmaSuccess(location);
    const kma = createKmaServiceStub(() => kmaResult);
    const airKorea = createAirKoreaServiceStub(() => ({
      ok: false,
      stage: 'LOCATION',
      error: { kind: 'UNSUPPORTED_ADMINISTRATIVE_LEVEL' },
    }));
    const resolver = neverSourceMetadataResolver();
    const service = createKmaAirKoreaWeatherOverviewService(kma.service, airKorea.service, resolver);

    await service.fetchCurrentHourlyWeatherOverviewForLocation({
      product: KmaForecastProduct.SHORT_FORECAST,
      location: makeLocation({ id: 'caller-raw-input-must-be-ignored' }),
    });

    expect(airKorea.calls).toHaveLength(1);
    expect(airKorea.calls[0]!.input.location).toBe(kmaResult.overview.location);
  });

  it('forwards the exact caller options/AbortSignal reference to both collaborators', async () => {
    const controller = new AbortController();
    const options: KmaAirKoreaWeatherOverviewOptions = { signal: controller.signal };
    const kmaResult = makeKmaSuccess();
    const kma = createKmaServiceStub(() => kmaResult);
    const airKorea = createAirKoreaServiceStub(() => ({
      ok: false,
      stage: 'LOCATION',
      error: { kind: 'UNSUPPORTED_ADMINISTRATIVE_LEVEL' },
    }));
    const resolver = neverSourceMetadataResolver();
    const service = createKmaAirKoreaWeatherOverviewService(kma.service, airKorea.service, resolver);

    await service.fetchCurrentHourlyWeatherOverviewForLocation(
      { product: KmaForecastProduct.SHORT_FORECAST, location: makeLocation() },
      options,
    );

    expect(kma.calls[0]!.options).toBe(options);
    expect(airKorea.calls[0]!.options).toBe(options);
  });

  it('preserves the exact KMA selection reference in the combined result', async () => {
    const kmaResult = makeKmaSuccess();
    const kma = createKmaServiceStub(() => kmaResult);
    const airKorea = createAirKoreaServiceStub(() => ({
      ok: false,
      stage: 'LOCATION',
      error: { kind: 'UNSUPPORTED_ADMINISTRATIVE_LEVEL' },
    }));
    const resolver = neverSourceMetadataResolver();
    const service = createKmaAirKoreaWeatherOverviewService(kma.service, airKorea.service, resolver);

    const result = await service.fetchCurrentHourlyWeatherOverviewForLocation({
      product: KmaForecastProduct.SHORT_FORECAST,
      location: makeLocation(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.selection).toBe(kmaResult.selection);
    }
  });

  it('returns exactly the ok/selection/overview keys on success', async () => {
    const kma = createKmaServiceStub(() => makeKmaSuccess());
    const airKorea = createAirKoreaServiceStub(() => ({
      ok: false,
      stage: 'LOCATION',
      error: { kind: 'UNSUPPORTED_ADMINISTRATIVE_LEVEL' },
    }));
    const service = createKmaAirKoreaWeatherOverviewService(
      kma.service,
      airKorea.service,
      neverSourceMetadataResolver(),
    );

    const result = await service.fetchCurrentHourlyWeatherOverviewForLocation({
      product: KmaForecastProduct.SHORT_FORECAST,
      location: makeLocation(),
    });

    expect(Object.keys(result).sort()).toEqual(['ok', 'overview', 'selection']);
  });
});

// ---------------------------------------------------------------------------
// AirKorea resolved failure — uniform degradation.
// ---------------------------------------------------------------------------

describe('createKmaAirKoreaWeatherOverviewService — AirKorea resolved failure degrades uniformly', () => {
  const failureCases: Array<{ readonly name: string; readonly result: AirKoreaLocationCurrentAirQualityResult }> = [
    {
      name: 'LOCATION',
      result: { ok: false, stage: 'LOCATION', error: { kind: 'UNSUPPORTED_ADMINISTRATIVE_LEVEL' } },
    },
    {
      name: 'TM_COORDINATE_PROVIDER',
      result: {
        ok: false,
        stage: 'TM_COORDINATE_PROVIDER',
        error: { kind: 'NO_DATA' } as never,
      },
    },
    {
      name: 'NEARBY_STATION_PROVIDER',
      result: {
        ok: false,
        stage: 'NEARBY_STATION_PROVIDER',
        error: { kind: 'NO_DATA' } as never,
      },
    },
    {
      name: 'CURRENT_PROVIDER',
      result: {
        ok: false,
        stage: 'CURRENT_PROVIDER',
        error: { kind: 'NO_DATA' } as never,
      },
    },
    {
      name: 'NORMALIZATION',
      result: { ok: false, stage: 'NORMALIZATION', issues: [] },
    },
  ];

  it.each(failureCases)(
    'degrades a resolved $name AirKorea failure to airQuality.current: null, never resolving source metadata',
    async ({ result: airKoreaResult }) => {
      const kmaResult = makeKmaSuccess();
      const kma = createKmaServiceStub(() => kmaResult);
      const airKorea = createAirKoreaServiceStub(() => airKoreaResult);
      const resolver = neverSourceMetadataResolver();
      const service = createKmaAirKoreaWeatherOverviewService(kma.service, airKorea.service, resolver);

      const result = await service.fetchCurrentHourlyWeatherOverviewForLocation({
        product: KmaForecastProduct.SHORT_FORECAST,
        location: makeLocation(),
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.overview.airQuality.current).toBeNull();
        expect(result.overview.missingSections).toContain('AIR_QUALITY_CURRENT');
        expect(result.overview.sources.some((s) => s.provider === 'AIR_KOREA')).toBe(false);
      }
      expect(resolver).not.toHaveBeenCalled();
    },
  );
});

// ---------------------------------------------------------------------------
// AirKorea resolved success — overlay.
// ---------------------------------------------------------------------------

describe('createKmaAirKoreaWeatherOverviewService — AirKorea success overlay', () => {
  it('resolves live source metadata exactly once and overlays airQuality.current', async () => {
    const current = makeCurrentAirQuality();
    const kmaResult = makeKmaSuccess();
    const kma = createKmaServiceStub(() => kmaResult);
    const airKorea = createAirKoreaServiceStub(() => ({ ok: true, current }));
    const resolver = makeSourceMetadataResolver();
    const service = createKmaAirKoreaWeatherOverviewService(kma.service, airKorea.service, resolver);

    const result = await service.fetchCurrentHourlyWeatherOverviewForLocation({
      product: KmaForecastProduct.SHORT_FORECAST,
      location: makeLocation(),
    });

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.overview.airQuality.current).toEqual(current);
      expect(result.overview.missingSections).not.toContain('AIR_QUALITY_CURRENT');
      const airKoreaSource = result.overview.sources.find((s) => s.provider === 'AIR_KOREA');
      expect(airKoreaSource).toBeDefined();
      expect(airKoreaSource!.sourceId).toBe('airkorea-current-air-quality');
      expect(airKoreaSource!.observedAt).toBe(current.measuredAt);
    }
  });

  it('uses the injected overlay assembler default (the real overlayAirKoreaCurrentAirQualityOnWeatherOverview) unless overridden', async () => {
    const kma = createKmaServiceStub(() => makeKmaSuccess());
    const airKorea = createAirKoreaServiceStub(() => ({ ok: true, current: makeCurrentAirQuality() }));
    const resolver = makeSourceMetadataResolver();
    const spy = vi.fn(overlayAirKoreaCurrentAirQualityOnWeatherOverview);
    const service = createKmaAirKoreaWeatherOverviewService(kma.service, airKorea.service, resolver, spy);

    await service.fetchCurrentHourlyWeatherOverviewForLocation({
      product: KmaForecastProduct.SHORT_FORECAST,
      location: makeLocation(),
    });

    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Unexpected throws/rejections propagate unchanged.
// ---------------------------------------------------------------------------

describe('createKmaAirKoreaWeatherOverviewService — unexpected throws/rejections are not degraded', () => {
  it('propagates a KMA synchronous throw synchronously (same reference)', () => {
    const marker = new Error('kma boom');
    const kma = kmaServiceThatSyncThrows(marker);
    const airKorea = neverAirKoreaService();
    const service = createKmaAirKoreaWeatherOverviewService(
      kma.service,
      airKorea.service,
      neverSourceMetadataResolver(),
    );

    expect(() =>
      service.fetchCurrentHourlyWeatherOverviewForLocation({
        product: KmaForecastProduct.SHORT_FORECAST,
        location: makeLocation(),
      }),
    ).toThrow(marker);
  });

  it('rejects with the exact same reference on a KMA Promise rejection', async () => {
    const marker = new Error('kma rejected');
    const kma = createKmaServiceStub(() => Promise.reject(marker));
    const airKorea = neverAirKoreaService();
    const service = createKmaAirKoreaWeatherOverviewService(
      kma.service,
      airKorea.service,
      neverSourceMetadataResolver(),
    );

    await expect(
      service.fetchCurrentHourlyWeatherOverviewForLocation({
        product: KmaForecastProduct.SHORT_FORECAST,
        location: makeLocation(),
      }),
    ).rejects.toBe(marker);
  });

  it('rejects with the exact same reference on an AirKorea synchronous throw', async () => {
    const marker = new Error('airkorea sync boom');
    const kma = createKmaServiceStub(() => makeKmaSuccess());
    const airKorea = airKoreaServiceThatSyncThrows(marker);
    const service = createKmaAirKoreaWeatherOverviewService(
      kma.service,
      airKorea.service,
      neverSourceMetadataResolver(),
    );

    await expect(
      service.fetchCurrentHourlyWeatherOverviewForLocation({
        product: KmaForecastProduct.SHORT_FORECAST,
        location: makeLocation(),
      }),
    ).rejects.toBe(marker);
  });

  it('rejects with the exact same reference on an AirKorea Promise rejection', async () => {
    const marker = new Error('airkorea rejected');
    const kma = createKmaServiceStub(() => makeKmaSuccess());
    const airKorea = airKoreaServiceThatRejects(marker);
    const service = createKmaAirKoreaWeatherOverviewService(
      kma.service,
      airKorea.service,
      neverSourceMetadataResolver(),
    );

    await expect(
      service.fetchCurrentHourlyWeatherOverviewForLocation({
        product: KmaForecastProduct.SHORT_FORECAST,
        location: makeLocation(),
      }),
    ).rejects.toBe(marker);
  });

  it('rejects with the exact same reference on a source-metadata-resolver throw', async () => {
    const marker = new Error('resolver boom');
    const kma = createKmaServiceStub(() => makeKmaSuccess());
    const airKorea = createAirKoreaServiceStub(() => ({ ok: true, current: makeCurrentAirQuality() }));
    const resolver = vi.fn((): ReturnType<AirKoreaCurrentSourceMetadataResolver> => {
      throw marker;
    });
    const service = createKmaAirKoreaWeatherOverviewService(kma.service, airKorea.service, resolver);

    await expect(
      service.fetchCurrentHourlyWeatherOverviewForLocation({
        product: KmaForecastProduct.SHORT_FORECAST,
        location: makeLocation(),
      }),
    ).rejects.toBe(marker);
  });

  it('rejects with the exact same reference on an overlay-assembler throw', async () => {
    const marker = new Error('overlay boom');
    const kma = createKmaServiceStub(() => makeKmaSuccess());
    const airKorea = createAirKoreaServiceStub(() => ({ ok: true, current: makeCurrentAirQuality() }));
    const resolver = makeSourceMetadataResolver();
    const throwingOverlay = vi.fn((): WeatherOverview => {
      throw marker;
    });
    const service = createKmaAirKoreaWeatherOverviewService(
      kma.service,
      airKorea.service,
      resolver,
      throwingOverlay,
    );

    await expect(
      service.fetchCurrentHourlyWeatherOverviewForLocation({
        product: KmaForecastProduct.SHORT_FORECAST,
        location: makeLocation(),
      }),
    ).rejects.toBe(marker);
  });
});

// ---------------------------------------------------------------------------
// District/province (adminArea3-null) location — documented degradation.
// ---------------------------------------------------------------------------

describe('createKmaAirKoreaWeatherOverviewService — adminArea3-null location', () => {
  it('KMA still succeeds and AirKorea degrades to UNSUPPORTED_ADMINISTRATIVE_LEVEL → airQuality missing, not a request failure', async () => {
    const districtLocation = makeLocation({ adminArea3: null });
    const kmaResult = makeKmaSuccess(districtLocation);
    const kma = createKmaServiceStub(() => kmaResult);
    const airKorea = createAirKoreaServiceStub(() => ({
      ok: false,
      stage: 'LOCATION',
      error: { kind: 'UNSUPPORTED_ADMINISTRATIVE_LEVEL' },
    }));
    const service = createKmaAirKoreaWeatherOverviewService(
      kma.service,
      airKorea.service,
      neverSourceMetadataResolver(),
    );

    const result = await service.fetchCurrentHourlyWeatherOverviewForLocation({
      product: KmaForecastProduct.SHORT_FORECAST,
      location: districtLocation,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.overview.airQuality.current).toBeNull();
      expect(result.overview.missingSections).toContain('AIR_QUALITY_CURRENT');
    }
  });
});

// ---------------------------------------------------------------------------
// Construction purity.
// ---------------------------------------------------------------------------

describe('createKmaAirKoreaWeatherOverviewService — construction', () => {
  it('calls no collaborator at construction time', () => {
    const kma = createKmaServiceStub(() => makeKmaSuccess());
    const airKorea = neverAirKoreaService();
    const resolver = neverSourceMetadataResolver();

    createKmaAirKoreaWeatherOverviewService(kma.service, airKorea.service, resolver);

    expect(kma.fetchCurrentHourlyWeatherOverviewForLocation).not.toHaveBeenCalled();
    expect(airKorea.fetchCurrentAirQualityForLocation).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
  });
});
