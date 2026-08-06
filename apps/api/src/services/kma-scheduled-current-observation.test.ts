import { afterEach, describe, expect, it, vi } from 'vitest';

import { currentWeather, type CurrentWeather } from '@life-weather/contracts';

import type {
  KmaCurrentNormalizationIssue,
  KmaCurrentObservationProviderError,
  KmaCurrentObservationRequest,
} from '../providers/kma/index.js';
import type { KmaCurrentObservationRequestFactory } from './kma-current-observation-request.js';
import type {
  KmaCurrentObservationService,
  KmaCurrentObservationServiceOptions,
  KmaCurrentObservationServiceResult,
} from './kma-current-observation.js';
import {
  createKmaScheduledCurrentObservationFacade,
  type KmaScheduledCurrentObservationInput,
} from './kma-scheduled-current-observation.js';

/** A fresh, valid caller input. Each test builds its own so no reference is ever shared across tests. */
function makeInput(): KmaScheduledCurrentObservationInput {
  return { nx: 60, ny: 127 };
}

/** A fresh, complete request the fake factory returns. The facade must pass it through by reference. */
function makeRequest(): KmaCurrentObservationRequest {
  return {
    baseDate: '20260718',
    baseTime: '0600',
    nx: 60,
    ny: 127,
  };
}

/** A minimal, contracts-valid current-observation entry for the success fixture. */
function makeCurrent(): CurrentWeather {
  return {
    observedAt: '2026-07-18T06:00:00+09:00',
    condition: 'CLEAR',
    temperatureCelsius: 23.5,
    feelsLikeCelsius: null,
    humidityPercent: null,
    windSpeedMetersPerSecond: null,
    windDirectionDegrees: null,
    precipitationLastHourMillimeters: null,
    visibilityMeters: null,
  };
}

interface FactoryCall {
  readonly input: KmaScheduledCurrentObservationInput;
}

interface ServiceCall {
  readonly request: KmaCurrentObservationRequest;
  readonly options: KmaCurrentObservationServiceOptions | undefined;
}

/**
 * A fresh fake request factory that records each `input` (by reference) and returns `request`.
 * Uses `vi.fn` so call count and argument identity are directly assertable.
 */
function fakeFactory(request: KmaCurrentObservationRequest) {
  const calls: FactoryCall[] = [];
  const createScheduledRequest = vi.fn(
    (input: KmaScheduledCurrentObservationInput) => {
      calls.push({ input });
      return request;
    },
  );
  const factory: KmaCurrentObservationRequestFactory = {
    createScheduledRequest,
  };
  return { factory, createScheduledRequest, calls };
}

/**
 * A fresh fake current-observation service that records each call's `request`/`options` (by
 * reference) and returns the exact `result` Promise it is handed — never a new Promise of its own.
 */
function fakeService(result: Promise<KmaCurrentObservationServiceResult>) {
  const calls: ServiceCall[] = [];
  const fetchCurrentWeather = vi.fn(
    (
      request: KmaCurrentObservationRequest,
      options?: KmaCurrentObservationServiceOptions,
    ): Promise<KmaCurrentObservationServiceResult> => {
      calls.push({ request, options });
      return result;
    },
  );
  const service: KmaCurrentObservationService = { fetchCurrentWeather };
  return { service, fetchCurrentWeather, calls };
}

/** Silences and records every console channel the facade must never write to. */
function spyOnConsoleOutput() {
  return [
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'info').mockImplementation(() => undefined),
    vi.spyOn(console, 'debug').mockImplementation(() => undefined),
  ];
}

function expectNoConsoleOutput(
  spies: readonly ReturnType<typeof vi.spyOn>[],
): void {
  for (const spy of spies) {
    expect(spy).not.toHaveBeenCalled();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createKmaScheduledCurrentObservationFacade — construction is side-effect-free', () => {
  it('does not call the request factory on construction alone', () => {
    const { factory, createScheduledRequest } = fakeFactory(makeRequest());
    const { service } = fakeService(
      Promise.resolve({ ok: true, current: makeCurrent() }),
    );
    createKmaScheduledCurrentObservationFacade(factory, service);
    expect(createScheduledRequest).not.toHaveBeenCalled();
  });

  it('does not call the current-observation service on construction alone', () => {
    const { factory } = fakeFactory(makeRequest());
    const { service, fetchCurrentWeather } = fakeService(
      Promise.resolve({ ok: true, current: makeCurrent() }),
    );
    createKmaScheduledCurrentObservationFacade(factory, service);
    expect(fetchCurrentWeather).not.toHaveBeenCalled();
  });

  it('does not throw on construction alone', () => {
    const { factory } = fakeFactory(makeRequest());
    const { service } = fakeService(
      Promise.resolve({ ok: true, current: makeCurrent() }),
    );
    expect(() =>
      createKmaScheduledCurrentObservationFacade(factory, service),
    ).not.toThrow();
  });

  it('works when both collaborator objects are frozen', () => {
    const request = makeRequest();
    const createScheduledRequest = vi.fn(() => request);
    const factory = Object.freeze<KmaCurrentObservationRequestFactory>({
      createScheduledRequest,
    });
    const resultPromise = Promise.resolve<KmaCurrentObservationServiceResult>(
      { ok: true, current: makeCurrent() },
    );
    const fetchCurrentWeather = vi.fn(() => resultPromise);
    const service = Object.freeze<KmaCurrentObservationService>({
      fetchCurrentWeather,
    });

    const facade = createKmaScheduledCurrentObservationFacade(
      factory,
      service,
    );
    expect(createScheduledRequest).not.toHaveBeenCalled();
    expect(fetchCurrentWeather).not.toHaveBeenCalled();
    expect(facade).toBeDefined();
  });

  it('keeps two facade instances independent (no global mutable state)', async () => {
    const requestA = makeRequest();
    const requestB = makeRequest();
    const resultA = Promise.resolve<KmaCurrentObservationServiceResult>({
      ok: true,
      current: makeCurrent(),
    });
    const resultB = Promise.resolve<KmaCurrentObservationServiceResult>({
      ok: true,
      current: makeCurrent(),
    });
    const a = fakeFactory(requestA);
    const b = fakeFactory(requestB);
    const sa = fakeService(resultA);
    const sb = fakeService(resultB);

    const facadeA = createKmaScheduledCurrentObservationFacade(
      a.factory,
      sa.service,
    );
    const facadeB = createKmaScheduledCurrentObservationFacade(
      b.factory,
      sb.service,
    );

    await facadeA.fetchScheduledCurrentWeather(makeInput());

    // Calling facadeA never touches facadeB's collaborators.
    expect(a.createScheduledRequest).toHaveBeenCalledTimes(1);
    expect(sa.fetchCurrentWeather).toHaveBeenCalledTimes(1);
    expect(b.createScheduledRequest).not.toHaveBeenCalled();
    expect(sb.fetchCurrentWeather).not.toHaveBeenCalled();
  });
});

describe('createKmaScheduledCurrentObservationFacade — success wiring', () => {
  it('sequences factory → service and passes every reference through unchanged', async () => {
    const input = makeInput();
    const request = makeRequest();
    const current = Object.freeze(makeCurrent());
    const result = Object.freeze<KmaCurrentObservationServiceResult>({
      ok: true,
      current,
    });
    const resultPromise =
      Promise.resolve<KmaCurrentObservationServiceResult>(result);

    const {
      factory,
      createScheduledRequest,
      calls: factoryCalls,
    } = fakeFactory(request);
    const {
      service,
      fetchCurrentWeather,
      calls: serviceCalls,
    } = fakeService(resultPromise);
    const facade = createKmaScheduledCurrentObservationFacade(
      factory,
      service,
    );

    const options: KmaCurrentObservationServiceOptions = {
      signal: new AbortController().signal,
    };
    const temperatureBefore = current.temperatureCelsius;
    const returned = facade.fetchScheduledCurrentWeather(input, options);

    // The factory ran exactly once with the caller's exact input reference.
    expect(createScheduledRequest).toHaveBeenCalledTimes(1);
    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls[0].input).toBe(input);

    // The service ran exactly once with the factory's exact request and the caller's exact options.
    expect(fetchCurrentWeather).toHaveBeenCalledTimes(1);
    expect(serviceCalls).toHaveLength(1);
    expect(serviceCalls[0].request).toBe(request);
    expect(serviceCalls[0].options).toBe(options);

    // The facade returns the exact Promise the service returned, resolving to the exact result.
    expect(returned).toBe(resultPromise);
    const resolved = await returned;
    // Give a same-Promise `.then()` side effect (a mutation regression) a turn to run before asserting.
    await Promise.resolve();

    expect(resolved).toBe(result);
    expect(resolved.ok).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(current)).toBe(true);
    if (resolved.ok) {
      expect(resolved.current).toBe(current);
      expect(currentWeather.safeParse(resolved.current).success).toBe(true);
      expect(resolved.current.temperatureCelsius).toBe(temperatureBefore);
    }
  });
});

describe('createKmaScheduledCurrentObservationFacade — options omitted', () => {
  it('forwards exactly undefined (never a synthesized {}) when options are omitted', async () => {
    const request = makeRequest();
    const { factory, createScheduledRequest } = fakeFactory(request);
    const { service, fetchCurrentWeather, calls } = fakeService(
      Promise.resolve({ ok: true, current: makeCurrent() }),
    );
    const facade = createKmaScheduledCurrentObservationFacade(
      factory,
      service,
    );

    await facade.fetchScheduledCurrentWeather(makeInput());

    expect(createScheduledRequest).toHaveBeenCalledTimes(1);
    expect(fetchCurrentWeather).toHaveBeenCalledTimes(1);
    // Exactly two positional arguments; the second is literally undefined.
    expect(fetchCurrentWeather.mock.calls[0]).toHaveLength(2);
    expect(fetchCurrentWeather.mock.calls[0][1]).toBeUndefined();
    expect(calls[0].options).toBeUndefined();
  });
});

describe('createKmaScheduledCurrentObservationFacade — AbortSignal reference', () => {
  it('forwards the exact options object and its signal, wrapping neither', async () => {
    const request = makeRequest();
    const { factory } = fakeFactory(request);
    const { service, calls } = fakeService(
      Promise.resolve({ ok: true, current: makeCurrent() }),
    );
    const facade = createKmaScheduledCurrentObservationFacade(
      factory,
      service,
    );

    const controller = new AbortController();
    const signal = controller.signal;
    const options: KmaCurrentObservationServiceOptions = { signal };

    await facade.fetchScheduledCurrentWeather(makeInput(), options);

    expect(calls[0].options).toBe(options);
    expect(calls[0].options?.signal).toBe(signal);
  });
});

describe('createKmaScheduledCurrentObservationFacade — provider-stage failure pass-through', () => {
  it('returns the same PROVIDER-stage result and error reference, unchanged', async () => {
    const sentinelProviderError =
      Object.freeze<KmaCurrentObservationProviderError>({
        kind: 'TIMEOUT',
      });
    const result = Object.freeze<KmaCurrentObservationServiceResult>({
      ok: false,
      stage: 'PROVIDER',
      error: sentinelProviderError,
    });
    const resultPromise =
      Promise.resolve<KmaCurrentObservationServiceResult>(result);

    const { factory } = fakeFactory(makeRequest());
    const { service } = fakeService(resultPromise);
    const facade = createKmaScheduledCurrentObservationFacade(
      factory,
      service,
    );

    const errorSnapshot = JSON.stringify(sentinelProviderError);
    const returned = facade.fetchScheduledCurrentWeather(makeInput());
    expect(returned).toBe(resultPromise);

    const resolved = await returned;
    // Give a same-Promise `.then()` side effect (a mutation regression) a turn to run before asserting.
    await Promise.resolve();

    expect(resolved).toBe(result);
    expect(resolved.ok).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(sentinelProviderError)).toBe(true);
    expect(Object.keys(resolved).sort()).toEqual(
      ['error', 'ok', 'stage'].sort(),
    );
    if (!resolved.ok) {
      expect(resolved.stage).toBe('PROVIDER');
      if (resolved.stage === 'PROVIDER') {
        expect(resolved.error).toBe(sentinelProviderError);
        expect(JSON.stringify(resolved.error)).toBe(errorSnapshot);
      }
    }
  });
});

describe('createKmaScheduledCurrentObservationFacade — normalization-stage failure pass-through', () => {
  it('returns the same NORMALIZATION-stage result, issues array, and issue references', async () => {
    const firstIssue = Object.freeze<KmaCurrentNormalizationIssue>({
      field: 'observedAt',
      reason: 'INVALID',
    });
    const secondIssue = Object.freeze<KmaCurrentNormalizationIssue>({
      field: 'temperatureCelsius',
      reason: 'ABSENT',
    });
    const sentinelIssues =
      Object.freeze<readonly KmaCurrentNormalizationIssue[]>([
        firstIssue,
        secondIssue,
      ]);
    const result = Object.freeze<KmaCurrentObservationServiceResult>({
      ok: false,
      stage: 'NORMALIZATION',
      issues: sentinelIssues,
    });
    const resultPromise =
      Promise.resolve<KmaCurrentObservationServiceResult>(result);

    const { factory } = fakeFactory(makeRequest());
    const { service } = fakeService(resultPromise);
    const facade = createKmaScheduledCurrentObservationFacade(
      factory,
      service,
    );

    const orderSnapshot = sentinelIssues.map(
      (issue) => `${issue.field}:${issue.reason}`,
    );
    const returned = facade.fetchScheduledCurrentWeather(makeInput());
    expect(returned).toBe(resultPromise);

    const resolved = await returned;
    // Give a same-Promise `.then()` side effect (a mutation regression) a turn to run before asserting.
    await Promise.resolve();

    expect(resolved).toBe(result);
    expect(resolved.ok).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(firstIssue)).toBe(true);
    expect(Object.isFrozen(secondIssue)).toBe(true);
    if (!resolved.ok) {
      expect(resolved.stage).toBe('NORMALIZATION');
      if (resolved.stage === 'NORMALIZATION') {
        expect(Object.isFrozen(resolved.issues)).toBe(true);
        expect(resolved.issues).toBe(sentinelIssues);
        expect(resolved.issues).toHaveLength(2);
        expect(resolved.issues[0]).toBe(firstIssue);
        expect(resolved.issues[1]).toBe(secondIssue);
        expect(
          resolved.issues.map((issue) => `${issue.field}:${issue.reason}`),
        ).toEqual(orderSnapshot);
      }
    }
  });
});

describe('createKmaScheduledCurrentObservationFacade — factory throw', () => {
  it('propagates the exact RangeError reference and never calls the current-observation service', () => {
    const consoleSpies = spyOnConsoleOutput();
    const sentinel = new RangeError(
      'REQUEST_FACTORY_RANGE_SENTINEL_FOR_IDENTITY',
    );
    const createScheduledRequest = vi.fn((): KmaCurrentObservationRequest => {
      throw sentinel;
    });
    const factory: KmaCurrentObservationRequestFactory = {
      createScheduledRequest,
    };
    const { service, fetchCurrentWeather } = fakeService(
      Promise.resolve({ ok: true, current: makeCurrent() }),
    );
    const facade = createKmaScheduledCurrentObservationFacade(
      factory,
      service,
    );

    let caught: unknown;
    let returned: unknown;
    try {
      returned = facade.fetchScheduledCurrentWeather(makeInput());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(sentinel);
    expect(returned).toBeUndefined();
    expect(createScheduledRequest).toHaveBeenCalledTimes(1);
    expect(fetchCurrentWeather).not.toHaveBeenCalled();
    expectNoConsoleOutput(consoleSpies);
  });

  it('propagates the exact generic Error sentinel reference and never calls the current-observation service', () => {
    const consoleSpies = spyOnConsoleOutput();
    const sentinel = new Error('REQUEST_FACTORY_GENERIC_SENTINEL_FOR_IDENTITY');
    const createScheduledRequest = vi.fn((): KmaCurrentObservationRequest => {
      throw sentinel;
    });
    const factory: KmaCurrentObservationRequestFactory = {
      createScheduledRequest,
    };
    const { service, fetchCurrentWeather } = fakeService(
      Promise.resolve({ ok: true, current: makeCurrent() }),
    );
    const facade = createKmaScheduledCurrentObservationFacade(
      factory,
      service,
    );

    let caught: unknown;
    let returned: unknown;
    try {
      returned = facade.fetchScheduledCurrentWeather(makeInput());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(sentinel);
    expect(returned).toBeUndefined();
    expect(createScheduledRequest).toHaveBeenCalledTimes(1);
    expect(fetchCurrentWeather).not.toHaveBeenCalled();
    expectNoConsoleOutput(consoleSpies);
  });
});

describe('createKmaScheduledCurrentObservationFacade — current-observation service synchronous throw', () => {
  it('propagates the exact error the service throws synchronously (no broad catch)', () => {
    const consoleSpies = spyOnConsoleOutput();
    const sentinel = new Error(
      'CURRENT_OBSERVATION_SERVICE_SYNC_SENTINEL_FOR_IDENTITY',
    );
    const request = makeRequest();
    const { factory, createScheduledRequest } = fakeFactory(request);
    // The interface expects a Promise return; cast to exercise a runtime collaborator violation.
    const fetchCurrentWeather = vi.fn(
      (): Promise<KmaCurrentObservationServiceResult> => {
        throw sentinel;
      },
    );
    const service = {
      fetchCurrentWeather,
    } as unknown as KmaCurrentObservationService;
    const facade = createKmaScheduledCurrentObservationFacade(
      factory,
      service,
    );

    let caught: unknown;
    try {
      facade.fetchScheduledCurrentWeather(makeInput());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(sentinel);
    expect(createScheduledRequest).toHaveBeenCalledTimes(1);
    expect(fetchCurrentWeather).toHaveBeenCalledTimes(1);
    expectNoConsoleOutput(consoleSpies);
  });
});

describe('createKmaScheduledCurrentObservationFacade — rejected Promise', () => {
  it('returns the same rejected Promise reference without intercepting the rejection', async () => {
    const consoleSpies = spyOnConsoleOutput();
    const sentinel = new Error(
      'CURRENT_OBSERVATION_SERVICE_REJECTION_SENTINEL_FOR_IDENTITY',
    );
    const rejected =
      Promise.reject<KmaCurrentObservationServiceResult>(sentinel);
    // Attach an assertion immediately so the rejection is always handled (no unhandled rejection).
    const assertion = expect(rejected).rejects.toBe(sentinel);

    const { factory, createScheduledRequest } = fakeFactory(makeRequest());
    const { service, fetchCurrentWeather } = fakeService(rejected);
    const facade = createKmaScheduledCurrentObservationFacade(
      factory,
      service,
    );

    const returned = facade.fetchScheduledCurrentWeather(makeInput());
    expect(returned).toBe(rejected);
    await expect(returned).rejects.toBe(sentinel);
    await assertion;

    expect(createScheduledRequest).toHaveBeenCalledTimes(1);
    expect(fetchCurrentWeather).toHaveBeenCalledTimes(1);
    expectNoConsoleOutput(consoleSpies);
  });
});

describe('createKmaScheduledCurrentObservationFacade — repeated calls and independence', () => {
  it('threads each call independently — right request/options/result, no cross-over or retained state', async () => {
    const requestOne = makeRequest();
    const requestTwo = { ...makeRequest(), baseTime: '1400' };
    const requestQueue = [requestOne, requestTwo];
    const createScheduledRequest = vi.fn(
      (_input: KmaScheduledCurrentObservationInput) => {
        const next = requestQueue.shift();
        if (next === undefined) {
          throw new Error('test setup: factory called more than twice');
        }
        return next;
      },
    );
    const factory: KmaCurrentObservationRequestFactory = {
      createScheduledRequest,
    };

    const resultOne: KmaCurrentObservationServiceResult = {
      ok: true,
      current: makeCurrent(),
    };
    const resultTwo: KmaCurrentObservationServiceResult = {
      ok: false,
      stage: 'PROVIDER',
      error: { kind: 'ABORTED' },
    };
    const promiseOne = Promise.resolve(resultOne);
    const promiseTwo = Promise.resolve(resultTwo);
    const promiseQueue = [promiseOne, promiseTwo];
    const serviceCalls: ServiceCall[] = [];
    const fetchCurrentWeather = vi.fn(
      (
        request: KmaCurrentObservationRequest,
        options?: KmaCurrentObservationServiceOptions,
      ) => {
        serviceCalls.push({ request, options });
        const next = promiseQueue.shift();
        if (next === undefined) {
          throw new Error('test setup: service called more than twice');
        }
        return next;
      },
    );
    const service: KmaCurrentObservationService = { fetchCurrentWeather };
    const facade = createKmaScheduledCurrentObservationFacade(
      factory,
      service,
    );

    const inputOne = makeInput();
    const inputTwo = makeInput();
    const optionsOne: KmaCurrentObservationServiceOptions = {
      signal: new AbortController().signal,
    };
    const optionsTwo: KmaCurrentObservationServiceOptions = {
      signal: new AbortController().signal,
    };

    const returnedOne = facade.fetchScheduledCurrentWeather(
      inputOne,
      optionsOne,
    );
    const returnedTwo = facade.fetchScheduledCurrentWeather(
      inputTwo,
      optionsTwo,
    );

    expect(createScheduledRequest).toHaveBeenCalledTimes(2);
    expect(fetchCurrentWeather).toHaveBeenCalledTimes(2);

    // Each service call got its own call's request and options — no cross-over.
    expect(serviceCalls[0].request).toBe(requestOne);
    expect(serviceCalls[0].options).toBe(optionsOne);
    expect(serviceCalls[1].request).toBe(requestTwo);
    expect(serviceCalls[1].options).toBe(optionsTwo);

    // Each returned Promise is the one from its own call, resolving to its own result.
    expect(returnedOne).toBe(promiseOne);
    expect(returnedTwo).toBe(promiseTwo);
    expect(await returnedOne).toBe(resultOne);
    expect(await returnedTwo).toBe(resultTwo);
  });
});

describe('createKmaScheduledCurrentObservationFacade — frozen input/options', () => {
  it('accepts frozen input and options, mutates neither, and forwards the same references', async () => {
    const request = makeRequest();
    const { factory, calls: factoryCalls } = fakeFactory(request);
    const { service, calls: serviceCalls } = fakeService(
      Promise.resolve({ ok: true, current: makeCurrent() }),
    );
    const facade = createKmaScheduledCurrentObservationFacade(
      factory,
      service,
    );

    const signal = new AbortController().signal;
    const input = Object.freeze<KmaScheduledCurrentObservationInput>({
      nx: 60,
      ny: 127,
    });
    const options = Object.freeze<KmaCurrentObservationServiceOptions>({
      signal,
    });
    const inputSnapshot = JSON.stringify(input);

    await facade.fetchScheduledCurrentWeather(input, options);

    // Same references reach the collaborators.
    expect(factoryCalls[0].input).toBe(input);
    expect(serviceCalls[0].options).toBe(options);
    // Field/reference assertions (not a JSON compare of the signal): the signal is the same object.
    expect(serviceCalls[0].options?.signal).toBe(signal);
    // Neither the input fields nor its identity changed.
    expect(JSON.stringify(input)).toBe(inputSnapshot);
    expect(input.nx).toBe(60);
    expect(input.ny).toBe(127);
  });
});

describe('createKmaScheduledCurrentObservationFacade — non-vacuity (frozen request clone regression)', () => {
  it('would fail if the facade spread the factory request instead of forwarding it by reference', async () => {
    const request = Object.freeze(makeRequest());
    const { factory } = fakeFactory(request);
    const { service, calls } = fakeService(
      Promise.resolve({ ok: true, current: makeCurrent() }),
    );
    const facade = createKmaScheduledCurrentObservationFacade(
      factory,
      service,
    );

    await facade.fetchScheduledCurrentWeather(makeInput());

    // A buggy implementation that does `{ ...requestFactory.createScheduledRequest(input) }` would
    // produce a new object here and fail this identity check.
    expect(calls[0].request).toBe(request);
  });
});
