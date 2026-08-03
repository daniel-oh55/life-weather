import { describe, expect, it, vi } from 'vitest';

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

    store.request('loc-a', validWeatherRequest());
    expect(store.getSnapshot()).toEqual({ status: 'LOADING', locationId: 'loc-a' });

    deferred.resolve(successResult());
    await deferred.promise;

    const snapshot = store.getSnapshot();
    expect(snapshot.status).toBe('SUCCESS');
    if (snapshot.status === 'SUCCESS') {
      expect(snapshot.locationId).toBe('loc-a');
      expect(snapshot.data).toEqual(successResponseBody());
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

    store.request('a', validWeatherRequest());
    deferred.resolve(apiErrorResult());
    await deferred.promise;

    expect(store.getSnapshot()).toEqual({ status: 'ERROR', locationId: 'a', presentation: 'API' });
  });

  it('maps invalidClientConfiguration to ERROR/CONFIGURATION', async () => {
    const { store, fetchWeather } = setup();
    const deferred = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValue(deferred.promise);

    store.request('a', validWeatherRequest());
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

    store.request('a', validWeatherRequest());
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

    store.request('a', validWeatherRequest());
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

    store.request('a', validWeatherRequest());
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

    store.request('a', validWeatherRequest());
    deferred.resolve(clientErrorResult('aborted'));
    await deferred.promise;

    expect(store.getSnapshot()).toEqual({ status: 'IDLE' });
  });
});

// ---------------------------------------------------------------------------
// Same-id dedupe: no additional call while LOADING / SUCCESS / ERROR for the same locationId.
// ---------------------------------------------------------------------------

describe('same-id dedupe', () => {
  it('does not start a second request for the same id while LOADING', () => {
    const { store, fetchWeather } = setup();
    fetchWeather.mockReturnValue(createDeferred<WeatherApiResult>().promise);

    store.request('a', validWeatherRequest());
    store.request('a', validWeatherRequest());

    expect(fetchWeather).toHaveBeenCalledTimes(1);
  });

  it('does not start a second request for the same id while SUCCESS', async () => {
    const { store, fetchWeather } = setup();
    const deferred = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValue(deferred.promise);

    store.request('a', validWeatherRequest());
    deferred.resolve(successResult());
    await deferred.promise;

    store.request('a', validWeatherRequest());
    expect(fetchWeather).toHaveBeenCalledTimes(1);
  });

  it('does not start a second request for the same id while ERROR (no automatic retry)', async () => {
    const { store, fetchWeather } = setup();
    const deferred = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValue(deferred.promise);

    store.request('a', validWeatherRequest());
    deferred.resolve(clientErrorResult('networkError'));
    await deferred.promise;

    store.request('a', validWeatherRequest());
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

    store.request('a', validWeatherRequest());
    const signalA = signalFromCall(fetchWeather, 0);

    store.request('b', validWeatherRequest());
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

    store.request('a', validWeatherRequest());
    store.request('b', validWeatherRequest());

    deferredA.resolve(clientErrorResult('networkError'));
    await deferredA.promise;
    expect(store.getSnapshot()).toEqual({ status: 'LOADING', locationId: 'b' });

    deferredB.resolve(successResult());
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

    store.request('a', validWeatherRequest());
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

    store.request('a', validWeatherRequest());
    store.reset();
    store.request('a', validWeatherRequest());

    expect(fetchWeather).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toEqual({ status: 'LOADING', locationId: 'a' });

    deferred2.resolve(successResult());
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
  it('retries from ERROR using the retained locationId/request', async () => {
    const { store, fetchWeather } = setup();
    const deferred1 = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValueOnce(deferred1.promise);

    store.request('a', validWeatherRequest());
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

    deferred2.resolve(successResult());
    await deferred2.promise;
    expect(store.getSnapshot().status).toBe('SUCCESS');
  });

  it('starts only one request across repeated retry presses while the retry is LOADING', async () => {
    const { store, fetchWeather } = setup();
    const deferred1 = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValueOnce(deferred1.promise);
    store.request('a', validWeatherRequest());
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
    store.request('a', validWeatherRequest());
    store.retry(); // LOADING
    expect(fetchWeather).toHaveBeenCalledTimes(1);

    deferred.resolve(successResult());
    await deferred.promise;
    store.retry(); // SUCCESS
    expect(fetchWeather).toHaveBeenCalledTimes(1);
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
    store.request('a', validWeatherRequest());
    deferred.resolve(successResult());
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
    expect(() => store.request('a', validWeatherRequest())).not.toThrow();
    expect(throwingListener).toHaveBeenCalledTimes(1);
    expect(goodListener).toHaveBeenCalledTimes(1);

    deferred.resolve(successResult());
    await deferred.promise;
    expect(store.getSnapshot().status).toBe('SUCCESS');
  });

  it('freezes the top-level snapshot object in every state', async () => {
    const { store, fetchWeather } = setup();
    expect(Object.isFrozen(store.getSnapshot())).toBe(true);

    const deferred = createDeferred<WeatherApiResult>();
    fetchWeather.mockReturnValue(deferred.promise);
    store.request('a', validWeatherRequest());
    expect(Object.isFrozen(store.getSnapshot())).toBe(true);

    deferred.resolve(successResult());
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
