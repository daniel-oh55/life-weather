import { describe, expect, it, vi } from 'vitest';

import type { WeatherLocation, WeatherRequestV1, WeatherSuccessResponseV1 } from '@life-weather/contracts';

import {
  weatherApiClientError,
  type WeatherApiClient,
  type WeatherApiClientErrorKind,
  type WeatherApiResult,
} from '../weather-api';
import {
  apiErrorResponseBody,
  successResponseBody,
  validWeatherRequest,
} from '../weather-api/fixtures';

import { createMobileWeatherQueryStore } from './mobile-weather-query-store';

// ---------------------------------------------------------------------------
// `validWeatherRequest()`/`successResponseBody()` (from `../weather-api/fixtures`) always carry the
// same fixed synthetic location. These local helpers build a request for an arbitrary `id` (keeping
// every other shared field from that same fixture location) and a response body whose `data.location`
// is pinned to exactly match a given request — so tests can freely use readable ids like `'a'`/`'b'`
// while staying correlated under the store's response-location check.
// ---------------------------------------------------------------------------

function requestForLocation(id: string): WeatherRequestV1 {
  const base = validWeatherRequest();
  return { location: { ...base.location, id } };
}

function successResponseBodyFor(request: WeatherRequestV1): WeatherSuccessResponseV1 {
  const body = successResponseBody();
  return { ...body, data: { ...body.data, location: request.location } };
}

function successResultFor(request: WeatherRequestV1): WeatherApiResult {
  return { kind: 'success', data: successResponseBodyFor(request) };
}

// ---------------------------------------------------------------------------
// A `Deferred` lets a test resolve/reject the client's `fetchWeather` promise on its own schedule,
// so LOADING can be observed before a terminal result lands, and two overlapping requests (A/B) can
// be driven independently to prove the generation guard actually works.
// ---------------------------------------------------------------------------

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Build a store over a fresh `vi.fn()` client, so each test asserts its own call count from 0. */
function setup() {
  const fetchWeather = vi.fn();
  const client: WeatherApiClient = {
    fetchWeather: fetchWeather as WeatherApiClient['fetchWeather'],
  };
  const store = createMobileWeatherQueryStore({ client });
  return { store, fetchWeather };
}

function successResult(): WeatherApiResult {
  return { kind: 'success', data: successResponseBody() };
}

function apiErrorResult(): WeatherApiResult {
  return { kind: 'apiError', error: apiErrorResponseBody() };
}

function clientErrorResult(kind: WeatherApiClientErrorKind): WeatherApiResult {
  return { kind: 'clientError', error: weatherApiClientError(kind) };
}

/** The `AbortSignal` passed to a given `fetchWeather` call. */
function signalFromCall(fetchWeather: ReturnType<typeof vi.fn>, callIndex: number): AbortSignal {
  const call = fetchWeather.mock.calls[callIndex] as
    | [unknown, { signal?: AbortSignal }]
    | undefined;
  if (call === undefined) {
    throw new Error(`expected fetchWeather call #${callIndex} to have been made`);
  }
  const signal = call[1].signal;
  if (signal === undefined) {
    throw new Error('expected an AbortSignal to have been passed');
  }
  return signal;
}

// ---------------------------------------------------------------------------
// IDLE -> request -> LOADING -> SUCCESS.
// ---------------------------------------------------------------------------

describe('IDLE -> request -> LOADING -> SUCCESS', () => {
  it('starts IDLE and transitions through LOADING to SUCCESS', async () => {
    const { store, fetchWeather } = setup();
    expect(store.getSnapshot()).toEqual({ status: 'IDLE' });

    const deferred = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValue(deferred.promise);

    const request = requestForLocation('loc-a');
    store.request(request);
    expect(store.getSnapshot()).toEqual({ status: 'LOADING', locationId: 'loc-a' });

    const expectedBody = successResponseBodyFor(request);
    deferred.resolve({ kind: 'success', data: expectedBody });
    await deferred.promise;

    const snapshot = store.getSnapshot();
    expect(snapshot.status).toBe('SUCCESS');
    if (snapshot.status === 'SUCCESS') {
      expect(snapshot.locationId).toBe('loc-a');
      expect(snapshot.data).toEqual(expectedBody);
    }
  });
});

// ---------------------------------------------------------------------------
// Result-mapping matrix.
// ---------------------------------------------------------------------------

describe('result mapping', () => {
  it('maps an apiError result to ERROR/API', async () => {
    const { store, fetchWeather } = setup();
    const deferred = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValue(deferred.promise);

    store.request(requestForLocation('a'));
    deferred.resolve(apiErrorResult());
    await deferred.promise;

    expect(store.getSnapshot()).toEqual({ status: 'ERROR', locationId: 'a', presentation: 'API' });
  });

  it('maps invalidClientConfiguration to ERROR/CONFIGURATION', async () => {
    const { store, fetchWeather } = setup();
    const deferred = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValue(deferred.promise);

    store.request(requestForLocation('a'));
    deferred.resolve(clientErrorResult('invalidClientConfiguration'));
    await deferred.promise;

    expect(store.getSnapshot()).toEqual({
      status: 'ERROR',
      locationId: 'a',
      presentation: 'CONFIGURATION',
    });
  });

  it('maps networkError to ERROR/NETWORK', async () => {
    const { store, fetchWeather } = setup();
    const deferred = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValue(deferred.promise);

    store.request(requestForLocation('a'));
    deferred.resolve(clientErrorResult('networkError'));
    await deferred.promise;

    expect(store.getSnapshot()).toEqual({
      status: 'ERROR',
      locationId: 'a',
      presentation: 'NETWORK',
    });
  });

  it('classifies an out-of-contract promise rejection as ERROR/NETWORK without reading it', async () => {
    const { store, fetchWeather } = setup();
    const deferred = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValue(deferred.promise);

    store.request(requestForLocation('a'));
    deferred.reject(new Error('synthetic contract violation'));
    await deferred.promise.catch(() => {});

    expect(store.getSnapshot()).toEqual({
      status: 'ERROR',
      locationId: 'a',
      presentation: 'NETWORK',
    });
  });

  it.each([
    'invalidRequest',
    'nonJsonResponse',
    'malformedJson',
    'invalidEnvelope',
    'unsupportedContractVersion',
    'invalidResponse',
  ] as const)('maps clientError kind %s to ERROR/INVALID_RESPONSE', async (kind) => {
    const { store, fetchWeather } = setup();
    const deferred = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValue(deferred.promise);

    store.request(requestForLocation('a'));
    deferred.resolve(clientErrorResult(kind));
    await deferred.promise;

    expect(store.getSnapshot()).toEqual({
      status: 'ERROR',
      locationId: 'a',
      presentation: 'INVALID_RESPONSE',
    });
  });

  it('an aborted clientError for the current generation publishes IDLE, never ERROR', async () => {
    const { store, fetchWeather } = setup();
    const deferred = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValue(deferred.promise);

    store.request(requestForLocation('a'));
    deferred.resolve(clientErrorResult('aborted'));
    await deferred.promise;

    expect(store.getSnapshot()).toEqual({ status: 'IDLE' });
  });
});

// ---------------------------------------------------------------------------
// Request identity: `request.location.id` is the sole source of the query's locationId. There is no
// separate `locationId` parameter a caller could pass out of sync with the request.
// ---------------------------------------------------------------------------

describe('request identity', () => {
  it('derives the LOADING/terminal locationId from request.location.id alone', () => {
    const { store, fetchWeather } = setup();
    fetchWeather.mockReturnValue(createDeferred<WeatherApiResult>().promise);

    const request = requestForLocation('derived-id');
    store.request(request);

    expect(store.getSnapshot()).toEqual({ status: 'LOADING', locationId: 'derived-id' });
  });

  it('retry restarts with the exact retained request, including its location.id', async () => {
    const { store, fetchWeather } = setup();
    const deferred1 = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValueOnce(deferred1.promise);

    const request = requestForLocation('retry-id');
    store.request(request);
    deferred1.resolve(clientErrorResult('networkError'));
    await deferred1.promise;

    const deferred2 = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValueOnce(deferred2.promise);
    store.retry();

    expect(fetchWeather).toHaveBeenNthCalledWith(2, request, expect.anything());
    expect(store.getSnapshot()).toEqual({ status: 'LOADING', locationId: 'retry-id' });
  });
});

// ---------------------------------------------------------------------------
// Response location correlation: a SUCCESS is published only when the response's `data.location`
// exactly matches the requested location on every shared field. Any mismatch is ERROR/INVALID_RESPONSE
// with no retry and no raw value exposed.
// ---------------------------------------------------------------------------

describe('response location correlation', () => {
  it.each<[string, Partial<WeatherLocation>]>([
    ['id', { id: 'different-location-id' }],
    ['displayName', { displayName: 'Different City' }],
    ['countryCode', { countryCode: 'US' }],
    ['adminArea1', { adminArea1: 'Different Province' }],
    ['adminArea2', { adminArea2: 'Different District' }],
    ['adminArea3', { adminArea3: 'Different Area' }],
    ['latitude', { latitude: 0 }],
    ['longitude', { longitude: 0 }],
    ['timezone', { timezone: 'Asia/Tokyo' }],
  ])(
    'rejects a SUCCESS response whose %s does not match the requested location',
    async (_field, override) => {
      const { store, fetchWeather } = setup();
      const deferred = createDeferred<WeatherApiResult>();
      fetchWeather.mockReturnValue(deferred.promise);

      const request = requestForLocation('correlated-id');
      store.request(request);

      const body = successResponseBodyFor(request);
      const mismatchedBody: WeatherSuccessResponseV1 = {
        ...body,
        data: { ...body.data, location: { ...body.data.location, ...override } },
      };
      deferred.resolve({ kind: 'success', data: mismatchedBody });
      await deferred.promise;

      expect(store.getSnapshot()).toEqual({
        status: 'ERROR',
        locationId: 'correlated-id',
        presentation: 'INVALID_RESPONSE',
      });
    },
  );

  it('does not expose the mismatched raw location values anywhere in the snapshot', async () => {
    const { store, fetchWeather } = setup();
    const deferred = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValue(deferred.promise);

    const request = requestForLocation('correlated-id');
    store.request(request);

    const body = successResponseBodyFor(request);
    const mismatchedBody: WeatherSuccessResponseV1 = {
      ...body,
      data: {
        ...body.data,
        location: {
          ...body.data.location,
          id: 'attacker-controlled-id',
          displayName: 'Secret Leak Display Name',
        },
      },
    };
    deferred.resolve({ kind: 'success', data: mismatchedBody });
    await deferred.promise;

    const serialized = JSON.stringify(store.getSnapshot());
    expect(serialized).not.toContain('attacker-controlled-id');
    expect(serialized).not.toContain('Secret Leak Display Name');
  });

  it('publishes SUCCESS when every shared field matches exactly', async () => {
    const { store, fetchWeather } = setup();
    const deferred = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValue(deferred.promise);

    const request = requestForLocation('correlated-id');
    store.request(request);
    deferred.resolve(successResultFor(request));
    await deferred.promise;

    expect(store.getSnapshot()).toEqual({
      status: 'SUCCESS',
      locationId: 'correlated-id',
      data: successResponseBodyFor(request),
    });
  });
});

// ---------------------------------------------------------------------------
// Reentrant notification guard: a listener may reentrantly reset()/request() during the synchronous
// LOADING publish. The generation is rechecked after that publish, before `fetchWeather` is called, so
// a superseded/reset generation never reaches the client.
// ---------------------------------------------------------------------------

describe('reentrant notification guard', () => {
  it('a listener that resets on the first LOADING notification prevents any client call and settles IDLE', () => {
    const { store, fetchWeather } = setup();
    fetchWeather.mockReturnValue(createDeferred<WeatherApiResult>().promise);

    let notifications = 0;
    const listener = vi.fn(() => {
      notifications += 1;
      if (notifications === 1) {
        store.reset();
      }
    });
    store.subscribe(listener);

    expect(() => store.request(requestForLocation('a'))).not.toThrow();

    expect(fetchWeather).toHaveBeenCalledTimes(0);
    expect(store.getSnapshot()).toEqual({ status: 'IDLE' });
  });

  it('a listener that requests a different location on the first LOADING notification supersedes cleanly', () => {
    const { store, fetchWeather } = setup();
    fetchWeather.mockReturnValue(createDeferred<WeatherApiResult>().promise);

    let notifications = 0;
    const listener = vi.fn(() => {
      notifications += 1;
      if (notifications === 1) {
        store.request(requestForLocation('b'));
      }
    });
    store.subscribe(listener);

    expect(() => store.request(requestForLocation('a'))).not.toThrow();

    expect(fetchWeather).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toEqual({ status: 'LOADING', locationId: 'b' });
  });
});

// ---------------------------------------------------------------------------
// Same-id dedupe: no additional call while LOADING / SUCCESS / ERROR for the same locationId.
// ---------------------------------------------------------------------------

describe('same-id dedupe', () => {
  it('does not start a second request for the same id while LOADING', () => {
    const { store, fetchWeather } = setup();
    fetchWeather.mockReturnValue(createDeferred<WeatherApiResult>().promise);

    store.request(requestForLocation('a'));
    store.request(requestForLocation('a'));

    expect(fetchWeather).toHaveBeenCalledTimes(1);
  });

  it('does not start a second request for the same id while SUCCESS', async () => {
    const { store, fetchWeather } = setup();
    const deferred = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValue(deferred.promise);

    const request = requestForLocation('a');
    store.request(request);
    deferred.resolve(successResultFor(request));
    await deferred.promise;

    store.request(requestForLocation('a'));
    expect(fetchWeather).toHaveBeenCalledTimes(1);
  });

  it('does not start a second request for the same id while ERROR (no automatic retry)', async () => {
    const { store, fetchWeather } = setup();
    const deferred = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValue(deferred.promise);

    store.request(requestForLocation('a'));
    deferred.resolve(clientErrorResult('networkError'));
    await deferred.promise;

    store.request(requestForLocation('a'));
    expect(fetchWeather).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// A LOADING -> B request: supersede ordering, abort, and stale-completion drop. This is the test
// that would fail against a naive implementation with no generation guard (A's late completion
// would overwrite B's state).
// ---------------------------------------------------------------------------

describe('A LOADING -> B request supersede', () => {
  it("aborts A's signal, publishes B's LOADING, and drops A's late success", async () => {
    const { store, fetchWeather } = setup();
    const deferredA = createDeferred<WeatherApiResult>();
    const deferredB = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValueOnce(deferredA.promise).mockReturnValueOnce(deferredB.promise);

    store.request(requestForLocation('a'));
    const signalA = signalFromCall(fetchWeather, 0);

    store.request(requestForLocation('b'));
    expect(signalA.aborted).toBe(true);
    expect(store.getSnapshot()).toEqual({ status: 'LOADING', locationId: 'b' });

    deferredA.resolve(successResult());
    await deferredA.promise;
    expect(store.getSnapshot()).toEqual({ status: 'LOADING', locationId: 'b' });

    deferredB.resolve(apiErrorResult());
    await deferredB.promise;
    expect(store.getSnapshot()).toEqual({ status: 'ERROR', locationId: 'b', presentation: 'API' });
  });

  it("drops A's late error the same way, leaving only B's terminal state", async () => {
    const { store, fetchWeather } = setup();
    const deferredA = createDeferred<WeatherApiResult>();
    const deferredB = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValueOnce(deferredA.promise).mockReturnValueOnce(deferredB.promise);

    store.request(requestForLocation('a'));
    const requestB = requestForLocation('b');
    store.request(requestB);

    deferredA.resolve(clientErrorResult('networkError'));
    await deferredA.promise;
    expect(store.getSnapshot()).toEqual({ status: 'LOADING', locationId: 'b' });

    deferredB.resolve(successResultFor(requestB));
    await deferredB.promise;
    const snapshot = store.getSnapshot();
    expect(snapshot.status).toBe('SUCCESS');
    if (snapshot.status === 'SUCCESS') {
      expect(snapshot.locationId).toBe('b');
    }
  });
});

// ---------------------------------------------------------------------------
// reset().
// ---------------------------------------------------------------------------

describe('reset', () => {
  it('invalidates the generation, aborts the active request, publishes IDLE, and drops the late completion', async () => {
    const { store, fetchWeather } = setup();
    const deferred = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValue(deferred.promise);

    store.request(requestForLocation('a'));
    const signal = signalFromCall(fetchWeather, 0);

    store.reset();
    expect(signal.aborted).toBe(true);
    expect(store.getSnapshot()).toEqual({ status: 'IDLE' });

    deferred.resolve(successResult());
    await deferred.promise;
    expect(store.getSnapshot()).toEqual({ status: 'IDLE' });
  });

  it('allows a fresh request for the same location after reset', async () => {
    const { store, fetchWeather } = setup();
    const deferred1 = createDeferred<WeatherApiResult>();
    const deferred2 = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValueOnce(deferred1.promise).mockReturnValueOnce(deferred2.promise);

    store.request(requestForLocation('a'));
    store.reset();
    const request = requestForLocation('a');
    store.request(request);

    expect(fetchWeather).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toEqual({ status: 'LOADING', locationId: 'a' });

    deferred2.resolve(successResultFor(request));
    await deferred2.promise;
    expect(store.getSnapshot().status).toBe('SUCCESS');
  });

  it('is a semantic no-op when already IDLE with no active request', () => {
    const { store } = setup();
    const listener = vi.fn();
    store.subscribe(listener);

    store.reset();

    expect(listener).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// retry().
// ---------------------------------------------------------------------------

describe('retry', () => {
  it('retries from ERROR using the retained request', async () => {
    const { store, fetchWeather } = setup();
    const deferred1 = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValueOnce(deferred1.promise);

    const request = requestForLocation('a');
    store.request(request);
    deferred1.resolve(clientErrorResult('networkError'));
    await deferred1.promise;
    expect(store.getSnapshot()).toEqual({
      status: 'ERROR',
      locationId: 'a',
      presentation: 'NETWORK',
    });

    const deferred2 = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValueOnce(deferred2.promise);
    store.retry();

    expect(fetchWeather).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toEqual({ status: 'LOADING', locationId: 'a' });

    deferred2.resolve(successResultFor(request));
    await deferred2.promise;
    expect(store.getSnapshot().status).toBe('SUCCESS');
  });

  it('starts only one request across repeated retry presses while the retry is LOADING', async () => {
    const { store, fetchWeather } = setup();
    const deferred1 = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValueOnce(deferred1.promise);
    store.request(requestForLocation('a'));
    deferred1.resolve(clientErrorResult('networkError'));
    await deferred1.promise;

    fetchWeather.mockReturnValueOnce(createDeferred<WeatherApiResult>().promise);
    store.retry();
    store.retry();
    store.retry();

    expect(fetchWeather).toHaveBeenCalledTimes(2);
  });

  it('is a no-op outside ERROR (IDLE, LOADING, SUCCESS)', async () => {
    const { store, fetchWeather } = setup();

    store.retry(); // IDLE
    expect(fetchWeather).toHaveBeenCalledTimes(0);

    const deferred = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValue(deferred.promise);
    const request = requestForLocation('a');
    store.request(request);
    store.retry(); // LOADING
    expect(fetchWeather).toHaveBeenCalledTimes(1);

    deferred.resolve(successResultFor(request));
    await deferred.promise;
    store.retry(); // SUCCESS
    expect(fetchWeather).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// refresh().
// ---------------------------------------------------------------------------

describe('refresh', () => {
  it('restarts from SUCCESS using the exact retained request reference', async () => {
    const { store, fetchWeather } = setup();
    const deferred1 = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValueOnce(deferred1.promise);

    const request = requestForLocation('a');
    store.request(request);
    deferred1.resolve(successResultFor(request));
    await deferred1.promise;
    expect(store.getSnapshot().status).toBe('SUCCESS');

    const deferred2 = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValueOnce(deferred2.promise);
    store.refresh();

    expect(fetchWeather).toHaveBeenCalledTimes(2);
    expect(fetchWeather).toHaveBeenNthCalledWith(2, request, expect.anything());
    expect(store.getSnapshot()).toEqual({ status: 'LOADING', locationId: 'a' });

    deferred2.resolve(successResultFor(request));
    await deferred2.promise;
    expect(store.getSnapshot().status).toBe('SUCCESS');
  });

  it('is a no-op outside SUCCESS (IDLE, LOADING, ERROR)', async () => {
    const { store, fetchWeather } = setup();

    store.refresh(); // IDLE
    expect(fetchWeather).toHaveBeenCalledTimes(0);

    const deferred = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValue(deferred.promise);
    store.request(requestForLocation('a'));
    store.refresh(); // LOADING
    expect(fetchWeather).toHaveBeenCalledTimes(1);

    deferred.resolve(clientErrorResult('networkError'));
    await deferred.promise;
    store.refresh(); // ERROR
    expect(fetchWeather).toHaveBeenCalledTimes(1);
  });

  it('starts only one request across repeated refresh presses while the refresh is LOADING', async () => {
    const { store, fetchWeather } = setup();
    const deferred1 = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValueOnce(deferred1.promise);

    const request = requestForLocation('a');
    store.request(request);
    deferred1.resolve(successResultFor(request));
    await deferred1.promise;

    fetchWeather.mockReturnValueOnce(createDeferred<WeatherApiResult>().promise);
    store.refresh();
    store.refresh();
    store.refresh();

    expect(fetchWeather).toHaveBeenCalledTimes(2);
  });

  it('a refresh failure uses the existing ERROR classification, not a refresh-specific one', async () => {
    const { store, fetchWeather } = setup();
    const deferred1 = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValueOnce(deferred1.promise);

    const request = requestForLocation('a');
    store.request(request);
    deferred1.resolve(successResultFor(request));
    await deferred1.promise;

    const deferred2 = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValueOnce(deferred2.promise);
    store.refresh();
    deferred2.resolve(apiErrorResult());
    await deferred2.promise;

    expect(store.getSnapshot()).toEqual({ status: 'ERROR', locationId: 'a', presentation: 'API' });
  });
});

// ---------------------------------------------------------------------------
// Snapshot reference identity, notification semantics, and freezing.
// ---------------------------------------------------------------------------

describe('snapshot contract', () => {
  it('returns the exact same reference from repeated getSnapshot calls', () => {
    const { store } = setup();
    const first = store.getSnapshot();
    const second = store.getSnapshot();
    expect(first).toBe(second);
  });

  it('notifies a listener only on a semantic transition, never on registration', () => {
    const { store } = setup();
    const listener = vi.fn();
    store.subscribe(listener);

    expect(listener).toHaveBeenCalledTimes(0);
  });

  it('unsubscribe is idempotent and stops further notifications', async () => {
    const { store, fetchWeather } = setup();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();

    const deferred = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValue(deferred.promise);
    const request = requestForLocation('a');
    store.request(request);
    deferred.resolve(successResultFor(request));
    await deferred.promise;

    expect(listener).toHaveBeenCalledTimes(0);
  });

  it('isolates a throwing listener from the others and from the query lifecycle', async () => {
    const { store, fetchWeather } = setup();
    const throwingListener = vi.fn(() => {
      throw new Error('synthetic listener failure');
    });
    const goodListener = vi.fn();
    store.subscribe(throwingListener);
    store.subscribe(goodListener);

    const deferred = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValue(deferred.promise);
    const request = requestForLocation('a');
    expect(() => store.request(request)).not.toThrow();
    expect(throwingListener).toHaveBeenCalledTimes(1);
    expect(goodListener).toHaveBeenCalledTimes(1);

    deferred.resolve(successResultFor(request));
    await deferred.promise;
    expect(store.getSnapshot().status).toBe('SUCCESS');
  });

  it('freezes the top-level snapshot object in every state', async () => {
    const { store, fetchWeather } = setup();
    expect(Object.isFrozen(store.getSnapshot())).toBe(true);

    const deferred = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValue(deferred.promise);
    const request = requestForLocation('a');
    store.request(request);
    expect(Object.isFrozen(store.getSnapshot())).toBe(true);

    deferred.resolve(successResultFor(request));
    await deferred.promise;
    expect(Object.isFrozen(store.getSnapshot())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pure barrel non-exposure.
// ---------------------------------------------------------------------------

describe('pure barrel', () => {
  it('exports only the provider-neutral factory/types, never the hook or production singleton', async () => {
    const barrel = await import('./index');

    expect(typeof barrel.createMobileWeatherQueryStore).toBe('function');
    expect('useMobileWeatherQuery' in barrel).toBe(false);
    expect('mobileWeatherQueryStore' in barrel).toBe(false);
  });
});
