import { afterEach, describe, expect, it, vi } from 'vitest';

import { currentAirQuality, weatherLocation, type WeatherLocation } from '@life-weather/contracts';

import type {
  AirKoreaCurrentAirQualityProvider,
  AirKoreaCurrentAirQualityProviderError,
  AirKoreaCurrentAirQualityProviderResult,
  AirKoreaCurrentAirQualityProviderSuccess,
  AirKoreaCurrentAirQualityRequest,
  AirKoreaNearbyStationCandidate,
  AirKoreaNearbyStationProvider,
  AirKoreaNearbyStationProviderError,
  AirKoreaNearbyStationProviderResult,
  AirKoreaNearbyStationRequest,
  AirKoreaTmCoordinateCandidate,
  AirKoreaTmCoordinateProvider,
  AirKoreaTmCoordinateProviderError,
  AirKoreaTmCoordinateProviderResult,
  AirKoreaTmCoordinateRequest,
} from '../providers/airkorea/index.js';
import {
  createAirKoreaLocationCurrentAirQualityService,
  type AirKoreaLocationCurrentAirQualityInput,
  type AirKoreaLocationCurrentAirQualityOptions,
  type AirKoreaLocationCurrentAirQualityResult,
} from './airkorea-location-current-air-quality.js';

// ---------------------------------------------------------------------------
// Fixture builders — every mutable fixture is built fresh per call.
// ---------------------------------------------------------------------------

/** A fresh, complete, schema-valid Korean leaf `WeatherLocation` (has a non-null adminArea3). */
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

function makeInput(
  overrides: { readonly location?: WeatherLocation } = {},
): AirKoreaLocationCurrentAirQualityInput {
  return { location: overrides.location ?? makeLocation() };
}

function makeTmCandidate(
  overrides: Partial<AirKoreaTmCoordinateCandidate> = {},
): AirKoreaTmCoordinateCandidate {
  return {
    sidoName: '서울특별시',
    sggName: '종로구',
    umdName: '혜화동',
    tmX: 200089.126044,
    tmY: 453946.42329,
    ...overrides,
  };
}

function makeStationCandidate(
  overrides: Partial<AirKoreaNearbyStationCandidate> = {},
): AirKoreaNearbyStationCandidate {
  return {
    stationName: '종로구',
    distanceKm: 1.2,
    ...overrides,
  };
}

const CURRENT_OBSERVATION: AirKoreaCurrentAirQualityProviderSuccess = {
  stationName: '종로구',
  dataTime: '2020-11-25 13:00',
  pm10Value: '73',
  pm25Value: '44',
  o3Value: '0.043',
  khaiValue: '75',
  khaiGrade: '2',
  pm10Grade: '2',
  pm25Grade: '3',
  o3Grade: '1',
};

function makeCurrentObservation(
  overrides: Partial<AirKoreaCurrentAirQualityProviderSuccess> = {},
): AirKoreaCurrentAirQualityProviderSuccess {
  return { ...CURRENT_OBSERVATION, ...overrides };
}

// ---------------------------------------------------------------------------
// Collaborator stubs — vi.fn-backed fakes recording every call by reference.
// ---------------------------------------------------------------------------

interface RecordedCall<TRequest> {
  readonly request: TRequest;
  readonly options: AirKoreaLocationCurrentAirQualityOptions | undefined;
}

function createTmProviderStub(
  respond: (
    request: AirKoreaTmCoordinateRequest,
  ) => Promise<AirKoreaTmCoordinateProviderResult> | AirKoreaTmCoordinateProviderResult,
) {
  const calls: RecordedCall<AirKoreaTmCoordinateRequest>[] = [];
  const fetchTmCoordinates = vi.fn(
    (request: AirKoreaTmCoordinateRequest, options?: AirKoreaLocationCurrentAirQualityOptions) => {
      calls.push({ request, options });
      return Promise.resolve(respond(request));
    },
  );
  const provider: AirKoreaTmCoordinateProvider = { fetchTmCoordinates };
  return { provider, fetchTmCoordinates, calls };
}

function resolvingTmProvider(result: AirKoreaTmCoordinateProviderResult) {
  return createTmProviderStub(() => result);
}

function tmProviderThatSyncThrows(error: unknown) {
  const fetchTmCoordinates = vi.fn(() => {
    throw error;
  });
  const provider: AirKoreaTmCoordinateProvider = { fetchTmCoordinates };
  return { provider, fetchTmCoordinates };
}

function tmProviderThatRejects(error: unknown) {
  const fetchTmCoordinates = vi.fn(() => Promise.reject(error));
  const provider: AirKoreaTmCoordinateProvider = { fetchTmCoordinates };
  return { provider, fetchTmCoordinates };
}

function neverTmProvider() {
  const fetchTmCoordinates = vi.fn((): Promise<AirKoreaTmCoordinateProviderResult> => {
    throw new Error('test setup: TM coordinate provider must not be called');
  });
  const provider: AirKoreaTmCoordinateProvider = { fetchTmCoordinates };
  return { provider, fetchTmCoordinates };
}

function createNearbyProviderStub(
  respond: (
    request: AirKoreaNearbyStationRequest,
  ) => Promise<AirKoreaNearbyStationProviderResult> | AirKoreaNearbyStationProviderResult,
) {
  const calls: RecordedCall<AirKoreaNearbyStationRequest>[] = [];
  const fetchNearbyStations = vi.fn(
    (request: AirKoreaNearbyStationRequest, options?: AirKoreaLocationCurrentAirQualityOptions) => {
      calls.push({ request, options });
      return Promise.resolve(respond(request));
    },
  );
  const provider: AirKoreaNearbyStationProvider = { fetchNearbyStations };
  return { provider, fetchNearbyStations, calls };
}

function resolvingNearbyProvider(result: AirKoreaNearbyStationProviderResult) {
  return createNearbyProviderStub(() => result);
}

function nearbyProviderThatRejects(error: unknown) {
  const fetchNearbyStations = vi.fn(() => Promise.reject(error));
  const provider: AirKoreaNearbyStationProvider = { fetchNearbyStations };
  return { provider, fetchNearbyStations };
}

function neverNearbyProvider() {
  const fetchNearbyStations = vi.fn((): Promise<AirKoreaNearbyStationProviderResult> => {
    throw new Error('test setup: nearby-station provider must not be called');
  });
  const provider: AirKoreaNearbyStationProvider = { fetchNearbyStations };
  return { provider, fetchNearbyStations };
}

function createCurrentProviderStub(
  respond: (
    request: AirKoreaCurrentAirQualityRequest,
  ) => Promise<AirKoreaCurrentAirQualityProviderResult> | AirKoreaCurrentAirQualityProviderResult,
) {
  const calls: RecordedCall<AirKoreaCurrentAirQualityRequest>[] = [];
  const fetchCurrentAirQuality = vi.fn(
    (
      request: AirKoreaCurrentAirQualityRequest,
      options?: AirKoreaLocationCurrentAirQualityOptions,
    ) => {
      calls.push({ request, options });
      return Promise.resolve(respond(request));
    },
  );
  const provider: AirKoreaCurrentAirQualityProvider = { fetchCurrentAirQuality };
  return { provider, fetchCurrentAirQuality, calls };
}

function resolvingCurrentProvider(result: AirKoreaCurrentAirQualityProviderResult) {
  return createCurrentProviderStub(() => result);
}

function neverCurrentProvider() {
  const fetchCurrentAirQuality = vi.fn((): Promise<AirKoreaCurrentAirQualityProviderResult> => {
    throw new Error('test setup: current-air-quality provider must not be called');
  });
  const provider: AirKoreaCurrentAirQualityProvider = { fetchCurrentAirQuality };
  return { provider, fetchCurrentAirQuality };
}

/** A default fully-wired happy-path graph: exactly one exact TM match and one nearby station. */
function makeHappyPathProviders() {
  const tm = resolvingTmProvider({ ok: true, candidates: [makeTmCandidate()] });
  const nearby = resolvingNearbyProvider({ ok: true, stations: [makeStationCandidate()] });
  const current = resolvingCurrentProvider({ ok: true, observation: makeCurrentObservation() });
  return { tm, nearby, current };
}

/** Capture whatever a thunk throws synchronously, or `undefined` when it does not throw. */
function captureSynchronousError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixture sanity.
// ---------------------------------------------------------------------------

describe('fixture sanity', () => {
  it('builds a contracts-valid WeatherLocation fixture', () => {
    expect(weatherLocation.safeParse(makeLocation()).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A. Construction is side-effect-free.
// ---------------------------------------------------------------------------

describe('createAirKoreaLocationCurrentAirQualityService — construction', () => {
  it('calls no collaborator on construction alone', () => {
    const { tm, nearby, current } = makeHappyPathProviders();

    createAirKoreaLocationCurrentAirQualityService(tm.provider, nearby.provider, current.provider);

    expect(tm.fetchTmCoordinates).not.toHaveBeenCalled();
    expect(nearby.fetchNearbyStations).not.toHaveBeenCalled();
    expect(current.fetchCurrentAirQuality).not.toHaveBeenCalled();
  });

  it('exposes exactly one public method key that is callable', () => {
    const { tm, nearby, current } = makeHappyPathProviders();
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    expect(Object.keys(service)).toEqual(['fetchCurrentAirQualityForLocation']);
    expect(typeof service.fetchCurrentAirQualityForLocation).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// B. WeatherLocation validation and supported-location policy.
// ---------------------------------------------------------------------------

describe('fetchCurrentAirQualityForLocation — WeatherLocation validation', () => {
  it('a valid leaf KR location proceeds to call the TM provider', async () => {
    const { tm, nearby, current } = makeHappyPathProviders();
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    const result = await service.fetchCurrentAirQualityForLocation(makeInput());

    expect(result.ok).toBe(true);
    expect(tm.fetchTmCoordinates).toHaveBeenCalledTimes(1);
  });

  it('throws a synchronous ZodError for an invalid contract location and calls zero providers', () => {
    const tm = neverTmProvider();
    const nearby = neverNearbyProvider();
    const current = neverCurrentProvider();
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    const input = makeInput({ location: makeLocation({ countryCode: 'kr' }) });

    const error = captureSynchronousError(() =>
      service.fetchCurrentAirQualityForLocation(input),
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as { name?: string }).name).toBe('ZodError');
    expect(tm.fetchTmCoordinates).not.toHaveBeenCalled();
    expect(nearby.fetchNearbyStations).not.toHaveBeenCalled();
    expect(current.fetchCurrentAirQuality).not.toHaveBeenCalled();
  });

  it('non-KR countryCode fails as LOCATION/UNSUPPORTED_COUNTRY and calls zero providers', async () => {
    const tm = neverTmProvider();
    const nearby = neverNearbyProvider();
    const current = neverCurrentProvider();
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    const input = makeInput({ location: makeLocation({ countryCode: 'US' }) });
    const result = await service.fetchCurrentAirQualityForLocation(input);

    expect(result).toEqual({
      ok: false,
      stage: 'LOCATION',
      error: { kind: 'UNSUPPORTED_COUNTRY' },
    });
    expect(tm.fetchTmCoordinates).not.toHaveBeenCalled();
    expect(nearby.fetchNearbyStations).not.toHaveBeenCalled();
    expect(current.fetchCurrentAirQuality).not.toHaveBeenCalled();
  });

  it('adminArea3 === null fails as LOCATION/UNSUPPORTED_ADMINISTRATIVE_LEVEL and calls zero providers', async () => {
    const tm = neverTmProvider();
    const nearby = neverNearbyProvider();
    const current = neverCurrentProvider();
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    const input = makeInput({
      location: makeLocation({ adminArea3: null, displayName: '서울특별시 종로구' }),
    });
    const result = await service.fetchCurrentAirQualityForLocation(input);

    expect(result).toEqual({
      ok: false,
      stage: 'LOCATION',
      error: { kind: 'UNSUPPORTED_ADMINISTRATIVE_LEVEL' },
    });
    expect(tm.fetchTmCoordinates).not.toHaveBeenCalled();
    expect(nearby.fetchNearbyStations).not.toHaveBeenCalled();
    expect(current.fetchCurrentAirQuality).not.toHaveBeenCalled();
  });

  it('does not leak latitude/longitude/displayName/raw values in a LOCATION error', async () => {
    const tm = neverTmProvider();
    const nearby = neverNearbyProvider();
    const current = neverCurrentProvider();
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    const input = makeInput({ location: makeLocation({ adminArea3: null }) });
    const result = await service.fetchCurrentAirQualityForLocation(input);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('37.');
    expect(serialized).not.toContain('127.');
    expect(serialized).not.toContain('서울');
  });
});

// ---------------------------------------------------------------------------
// C. TM request shape and forwarding.
// ---------------------------------------------------------------------------

describe('fetchCurrentAirQualityForLocation — TM request', () => {
  it('sends exactly adminArea3 as umdName, in a fresh request object, exactly once', async () => {
    const { tm, nearby, current } = makeHappyPathProviders();
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    const input = makeInput();
    await service.fetchCurrentAirQualityForLocation(input);

    expect(tm.fetchTmCoordinates).toHaveBeenCalledTimes(1);
    expect(tm.calls[0].request).toEqual({ umdName: input.location.adminArea3 });
    expect(tm.calls[0].request).not.toBe(input.location);
    expect(Object.keys(tm.calls[0].request)).toEqual(['umdName']);
  });

  it('forwards the caller options by exact reference to the TM provider', async () => {
    const { tm, nearby, current } = makeHappyPathProviders();
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    const options: AirKoreaLocationCurrentAirQualityOptions = {
      signal: new AbortController().signal,
    };
    await service.fetchCurrentAirQualityForLocation(makeInput(), options);

    expect(tm.calls[0].options).toBe(options);
    expect(tm.calls[0].options?.signal).toBe(options.signal);
  });

  it('forwards exactly undefined when options are omitted', async () => {
    const { tm, nearby, current } = makeHappyPathProviders();
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    await service.fetchCurrentAirQualityForLocation(makeInput());

    expect(tm.fetchTmCoordinates.mock.calls[0][1]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// D. TM candidate resolution.
// ---------------------------------------------------------------------------

describe('fetchCurrentAirQualityForLocation — TM candidate resolution', () => {
  it('selects the exact match even when candidate[0] is a different region (no first-candidate shortcut)', async () => {
    const wrongRegion = makeTmCandidate({ sidoName: '부산광역시', sggName: '해운대구', tmX: 1, tmY: 1 });
    const correct = makeTmCandidate();
    const tm = resolvingTmProvider({ ok: true, candidates: [wrongRegion, correct] });
    const nearby = resolvingNearbyProvider({ ok: true, stations: [makeStationCandidate()] });
    const current = resolvingCurrentProvider({ ok: true, observation: makeCurrentObservation() });
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    await service.fetchCurrentAirQualityForLocation(makeInput());

    expect(nearby.calls[0].request).toEqual({ tmX: correct.tmX, tmY: correct.tmY });
  });

  it('requires exact adminArea1/adminArea2/adminArea3 matching', async () => {
    const partialMismatchSgg = makeTmCandidate({ sggName: '다른구' });
    const tm = resolvingTmProvider({ ok: true, candidates: [partialMismatchSgg] });
    const nearby = neverNearbyProvider();
    const current = neverCurrentProvider();
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    const result = await service.fetchCurrentAirQualityForLocation(makeInput());

    expect(result).toEqual({
      ok: false,
      stage: 'LOCATION',
      error: { kind: 'TM_COORDINATE_NOT_FOUND' },
    });
    expect(nearby.fetchNearbyStations).not.toHaveBeenCalled();
  });

  it('supports an adminArea2-null location by skipping the sggName comparison', async () => {
    const location = makeLocation({ adminArea2: null, displayName: '서울특별시 혜화동' });
    const candidateA = makeTmCandidate({ sggName: '종로구' });
    const candidateB = makeTmCandidate({ sggName: '성북구', tmX: 999, tmY: 999 });
    // Two candidates differing only by sggName both match when adminArea2 is null, so this is
    // ambiguous — pinning that adminArea2-null does not silently pick the first sggName variant.
    const tm = resolvingTmProvider({ ok: true, candidates: [candidateA, candidateB] });
    const nearby = neverNearbyProvider();
    const current = neverCurrentProvider();
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    const result = await service.fetchCurrentAirQualityForLocation(makeInput({ location }));

    expect(result).toEqual({
      ok: false,
      stage: 'LOCATION',
      error: { kind: 'AMBIGUOUS_TM_COORDINATE' },
    });
  });

  it('an adminArea2-null location resolves cleanly when only one candidate matches sido/umd', async () => {
    const location = makeLocation({ adminArea2: null, displayName: '서울특별시 혜화동' });
    const onlyMatch = makeTmCandidate({ sggName: '종로구' });
    const tm = resolvingTmProvider({ ok: true, candidates: [onlyMatch] });
    const nearby = resolvingNearbyProvider({ ok: true, stations: [makeStationCandidate()] });
    const current = resolvingCurrentProvider({ ok: true, observation: makeCurrentObservation() });
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    const result = await service.fetchCurrentAirQualityForLocation(makeInput({ location }));

    expect(result.ok).toBe(true);
    expect(nearby.calls[0].request).toEqual({ tmX: onlyMatch.tmX, tmY: onlyMatch.tmY });
  });

  it('zero exact matches → LOCATION/TM_COORDINATE_NOT_FOUND', async () => {
    const tm = resolvingTmProvider({ ok: true, candidates: [] });
    const nearby = neverNearbyProvider();
    const current = neverCurrentProvider();
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    const result = await service.fetchCurrentAirQualityForLocation(makeInput());

    expect(result).toEqual({
      ok: false,
      stage: 'LOCATION',
      error: { kind: 'TM_COORDINATE_NOT_FOUND' },
    });
  });

  it('multiple exact matches → LOCATION/AMBIGUOUS_TM_COORDINATE, never candidates[0]', async () => {
    const first = makeTmCandidate({ tmX: 1, tmY: 1 });
    const second = makeTmCandidate({ tmX: 2, tmY: 2 });
    const tm = resolvingTmProvider({ ok: true, candidates: [first, second] });
    const nearby = neverNearbyProvider();
    const current = neverCurrentProvider();
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    const result = await service.fetchCurrentAirQualityForLocation(makeInput());

    expect(result).toEqual({
      ok: false,
      stage: 'LOCATION',
      error: { kind: 'AMBIGUOUS_TM_COORDINATE' },
    });
    expect(nearby.fetchNearbyStations).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// E. Short-circuit behavior.
// ---------------------------------------------------------------------------

describe('fetchCurrentAirQualityForLocation — short circuit', () => {
  it('TM provider failure prevents nearby-station and current provider calls', async () => {
    const tmError: AirKoreaTmCoordinateProviderError = { kind: 'TIMEOUT' };
    const tm = resolvingTmProvider({ ok: false, error: tmError });
    const nearby = neverNearbyProvider();
    const current = neverCurrentProvider();
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    const result = await service.fetchCurrentAirQualityForLocation(makeInput());

    expect(result).toEqual({ ok: false, stage: 'TM_COORDINATE_PROVIDER', error: tmError });
    expect(nearby.fetchNearbyStations).not.toHaveBeenCalled();
    expect(current.fetchCurrentAirQuality).not.toHaveBeenCalled();
  });

  it('TM location-resolution failure (ambiguous/not-found) prevents later provider calls', async () => {
    const tm = resolvingTmProvider({ ok: true, candidates: [] });
    const nearby = neverNearbyProvider();
    const current = neverCurrentProvider();
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    await service.fetchCurrentAirQualityForLocation(makeInput());

    expect(nearby.fetchNearbyStations).not.toHaveBeenCalled();
    expect(current.fetchCurrentAirQuality).not.toHaveBeenCalled();
  });

  it('nearby-station provider failure prevents the current-provider and normalizer from running', async () => {
    const tm = resolvingTmProvider({ ok: true, candidates: [makeTmCandidate()] });
    const nearbyError: AirKoreaNearbyStationProviderError = { kind: 'NO_DATA' };
    const nearby = resolvingNearbyProvider({ ok: false, error: nearbyError });
    const current = neverCurrentProvider();
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    const result = await service.fetchCurrentAirQualityForLocation(makeInput());

    expect(result).toEqual({ ok: false, stage: 'NEARBY_STATION_PROVIDER', error: nearbyError });
    expect(current.fetchCurrentAirQuality).not.toHaveBeenCalled();
  });

  it('current provider failure prevents the normalizer from running (NORMALIZATION not reached)', async () => {
    const tm = resolvingTmProvider({ ok: true, candidates: [makeTmCandidate()] });
    const nearby = resolvingNearbyProvider({ ok: true, stations: [makeStationCandidate()] });
    const currentError: AirKoreaCurrentAirQualityProviderError = { kind: 'NO_DATA' };
    const current = resolvingCurrentProvider({ ok: false, error: currentError });
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    const result = await service.fetchCurrentAirQualityForLocation(makeInput());

    expect(result).toEqual({ ok: false, stage: 'CURRENT_PROVIDER', error: currentError });
  });

  it('makes at most 3 network calls total on a fully supported successful invocation', async () => {
    const { tm, nearby, current } = makeHappyPathProviders();
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    await service.fetchCurrentAirQualityForLocation(makeInput());

    expect(tm.fetchTmCoordinates).toHaveBeenCalledTimes(1);
    expect(nearby.fetchNearbyStations).toHaveBeenCalledTimes(1);
    expect(current.fetchCurrentAirQuality).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// F. Closest-station selection.
// ---------------------------------------------------------------------------

describe('fetchCurrentAirQualityForLocation — closest station', () => {
  it('selects the nearest candidate even when it is not upstream index 0', async () => {
    const far = makeStationCandidate({ stationName: 'Far', distanceKm: 9.9 });
    const near = makeStationCandidate({ stationName: 'Near', distanceKm: 0.5 });
    const tm = resolvingTmProvider({ ok: true, candidates: [makeTmCandidate()] });
    const nearby = resolvingNearbyProvider({ ok: true, stations: [far, near] });
    const current = resolvingCurrentProvider({ ok: true, observation: makeCurrentObservation() });
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    await service.fetchCurrentAirQualityForLocation(makeInput());

    expect(current.calls[0].request).toEqual({ stationName: 'Near' });
  });

  it('breaks an equal-distance tie by stationName ascending, independent of upstream order (A before B)', async () => {
    const stationA = makeStationCandidate({ stationName: 'A', distanceKm: 3 });
    const stationB = makeStationCandidate({ stationName: 'B', distanceKm: 3 });
    const tm = resolvingTmProvider({ ok: true, candidates: [makeTmCandidate()] });
    const nearby = resolvingNearbyProvider({ ok: true, stations: [stationB, stationA] });
    const current = resolvingCurrentProvider({ ok: true, observation: makeCurrentObservation() });
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    await service.fetchCurrentAirQualityForLocation(makeInput());

    expect(current.calls[0].request).toEqual({ stationName: 'A' });
  });

  it('breaks an equal-distance tie by stationName ascending in the reverse upstream order too (still A)', async () => {
    const stationA = makeStationCandidate({ stationName: 'A', distanceKm: 3 });
    const stationB = makeStationCandidate({ stationName: 'B', distanceKm: 3 });
    const tm = resolvingTmProvider({ ok: true, candidates: [makeTmCandidate()] });
    const nearby = resolvingNearbyProvider({ ok: true, stations: [stationA, stationB] });
    const current = resolvingCurrentProvider({ ok: true, observation: makeCurrentObservation() });
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    await service.fetchCurrentAirQualityForLocation(makeInput());

    expect(current.calls[0].request).toEqual({ stationName: 'A' });
  });

  it('fails closed with LOCATION/NEARBY_STATION_NOT_FOUND if the provider defensively returns zero stations', async () => {
    const tm = resolvingTmProvider({ ok: true, candidates: [makeTmCandidate()] });
    const nearby = resolvingNearbyProvider({ ok: true, stations: [] });
    const current = neverCurrentProvider();
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    const result = await service.fetchCurrentAirQualityForLocation(makeInput());

    expect(result).toEqual({
      ok: false,
      stage: 'LOCATION',
      error: { kind: 'NEARBY_STATION_NOT_FOUND' },
    });
    expect(current.fetchCurrentAirQuality).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// G. Normalization.
// ---------------------------------------------------------------------------

describe('fetchCurrentAirQualityForLocation — normalization', () => {
  it('exercises the real normalizer: valid provider success → CurrentAirQuality success', async () => {
    const { tm, nearby, current } = makeHappyPathProviders();
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    const result = await service.fetchCurrentAirQualityForLocation(makeInput());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(currentAirQuality.safeParse(result.current).success).toBe(true);
      expect(result.current.measuredAt).toBe('2020-11-25T13:00:00+09:00');
      expect(result.current.pm10MicrogramsPerCubicMeter).toBe(73);
    }
  });

  it('malformed normalization input → NORMALIZATION failure with the real normalizer issues', async () => {
    const tm = resolvingTmProvider({ ok: true, candidates: [makeTmCandidate()] });
    const nearby = resolvingNearbyProvider({ ok: true, stations: [makeStationCandidate()] });
    const malformed = makeCurrentObservation({ dataTime: 'not-a-date' });
    const current = resolvingCurrentProvider({ ok: true, observation: malformed });
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    const result = await service.fetchCurrentAirQualityForLocation(makeInput());

    expect(result).toEqual({
      ok: false,
      stage: 'NORMALIZATION',
      issues: [{ field: 'measuredAt', reason: 'INVALID' }],
    });
  });

  it('success result exposes only ok/current — no stationName/TM/distance/raw observation', async () => {
    const { tm, nearby, current } = makeHappyPathProviders();
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    const result = await service.fetchCurrentAirQualityForLocation(makeInput());

    expect(Object.keys(result).sort()).toEqual(['current', 'ok']);
  });
});

// ---------------------------------------------------------------------------
// H. Signal/options forwarding across all three providers.
// ---------------------------------------------------------------------------

describe('fetchCurrentAirQualityForLocation — signal/options', () => {
  it('forwards the exact same options reference (and AbortSignal) to all three providers', async () => {
    const { tm, nearby, current } = makeHappyPathProviders();
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    const options: AirKoreaLocationCurrentAirQualityOptions = {
      signal: new AbortController().signal,
    };
    await service.fetchCurrentAirQualityForLocation(makeInput(), options);

    expect(tm.calls[0].options).toBe(options);
    expect(nearby.calls[0].options).toBe(options);
    expect(current.calls[0].options).toBe(options);
    expect(tm.calls[0].options?.signal).toBe(options.signal);
    expect(nearby.calls[0].options?.signal).toBe(options.signal);
    expect(current.calls[0].options?.signal).toBe(options.signal);
  });

  it('omitted options stays exactly undefined at every provider call', async () => {
    const { tm, nearby, current } = makeHappyPathProviders();
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    await service.fetchCurrentAirQualityForLocation(makeInput());

    expect(tm.fetchTmCoordinates.mock.calls[0][1]).toBeUndefined();
    expect(nearby.fetchNearbyStations.mock.calls[0][1]).toBeUndefined();
    expect(current.fetchCurrentAirQuality.mock.calls[0][1]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// I. Error propagation.
// ---------------------------------------------------------------------------

describe('fetchCurrentAirQualityForLocation — error propagation', () => {
  it('propagates a TM provider synchronous throw synchronously, running no downstream', () => {
    const sentinel = new Error('TM_SYNC_THROW_SENTINEL');
    const tm = tmProviderThatSyncThrows(sentinel);
    const nearby = neverNearbyProvider();
    const current = neverCurrentProvider();
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    let returned: unknown;
    const caught = captureSynchronousError(() => {
      returned = service.fetchCurrentAirQualityForLocation(makeInput());
    });

    expect(caught).toBe(sentinel);
    expect(returned).toBeUndefined();
    expect(nearby.fetchNearbyStations).not.toHaveBeenCalled();
    expect(current.fetchCurrentAirQuality).not.toHaveBeenCalled();
  });

  it('propagates a TM provider Promise rejection as the same rejection reason', async () => {
    const sentinel = new Error('TM_REJECTION_SENTINEL');
    const tm = tmProviderThatRejects(sentinel);
    const nearby = neverNearbyProvider();
    const current = neverCurrentProvider();
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    await expect(
      service.fetchCurrentAirQualityForLocation(makeInput()),
    ).rejects.toBe(sentinel);
    expect(nearby.fetchNearbyStations).not.toHaveBeenCalled();
    expect(current.fetchCurrentAirQuality).not.toHaveBeenCalled();
  });

  it('propagates a nearby-station provider rejection as a rejection, running no current provider', async () => {
    const sentinel = new Error('NEARBY_REJECTION_SENTINEL');
    const tm = resolvingTmProvider({ ok: true, candidates: [makeTmCandidate()] });
    const nearby = nearbyProviderThatRejects(sentinel);
    const current = neverCurrentProvider();
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    await expect(
      service.fetchCurrentAirQualityForLocation(makeInput()),
    ).rejects.toBe(sentinel);
    expect(current.fetchCurrentAirQuality).not.toHaveBeenCalled();
  });

  it('propagates a current-provider rejection as the same rejection reason (not swallowed)', async () => {
    const sentinel = new Error('CURRENT_REJECTION_SENTINEL');
    const tm = resolvingTmProvider({ ok: true, candidates: [makeTmCandidate()] });
    const nearby = resolvingNearbyProvider({ ok: true, stations: [makeStationCandidate()] });
    const fetchCurrentAirQuality = vi.fn(() => Promise.reject(sentinel));
    const currentProvider: AirKoreaCurrentAirQualityProvider = { fetchCurrentAirQuality };
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      currentProvider,
    );

    await expect(
      service.fetchCurrentAirQualityForLocation(makeInput()),
    ).rejects.toBe(sentinel);
  });
});

// ---------------------------------------------------------------------------
// J. Purity — no mutation of input, provider results, or candidate arrays.
// ---------------------------------------------------------------------------

describe('fetchCurrentAirQualityForLocation — purity', () => {
  it('does not mutate the caller input location', async () => {
    const { tm, nearby, current } = makeHappyPathProviders();
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    const input = makeInput();
    const snapshot = JSON.stringify(input);

    await service.fetchCurrentAirQualityForLocation(input);

    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('does not mutate the TM candidate array or its elements', async () => {
    // Two fully-matching candidates make this an AMBIGUOUS_TM_COORDINATE case, so the nearby-station
    // provider is never called — appropriate for asserting the TM candidate array is left untouched.
    const candidates = [makeTmCandidate({ tmX: 1 }), makeTmCandidate({ tmX: 2 })];
    const snapshot = JSON.stringify(candidates);
    const tm = resolvingTmProvider({ ok: true, candidates });
    const nearby = neverNearbyProvider();
    const current = neverCurrentProvider();
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    await service.fetchCurrentAirQualityForLocation(makeInput());

    expect(JSON.stringify(candidates)).toBe(snapshot);
  });

  it('does not mutate the nearby-station candidate array or its elements', async () => {
    const stations = [makeStationCandidate({ stationName: 'B', distanceKm: 2 }), makeStationCandidate({ stationName: 'A', distanceKm: 1 })];
    const snapshot = JSON.stringify(stations);
    const tm = resolvingTmProvider({ ok: true, candidates: [makeTmCandidate()] });
    const nearby = resolvingNearbyProvider({ ok: true, stations });
    const current = resolvingCurrentProvider({ ok: true, observation: makeCurrentObservation() });
    const service = createAirKoreaLocationCurrentAirQualityService(
      tm.provider,
      nearby.provider,
      current.provider,
    );

    await service.fetchCurrentAirQualityForLocation(makeInput());

    expect(JSON.stringify(stations)).toBe(snapshot);
  });
});
