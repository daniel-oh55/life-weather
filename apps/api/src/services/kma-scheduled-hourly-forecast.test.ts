import { describe, expect, it, vi } from 'vitest';

import { hourlyForecast, type HourlyForecast } from '@life-weather/contracts';
import { KmaForecastProduct } from '@life-weather/weather-core';

import type {
  KmaForecastProviderError,
  KmaForecastRequest,
  KmaHourlyNormalizationIssue,
} from '../providers/kma';
import type { KmaForecastRequestFactory } from './kma-forecast-request';
import type {
  KmaHourlyForecastService,
  KmaHourlyForecastServiceOptions,
  KmaHourlyForecastServiceResult,
} from './kma-hourly-forecast';
import {
  createKmaScheduledHourlyForecastFacade,
  type KmaScheduledHourlyForecastInput,
} from './kma-scheduled-hourly-forecast';

const SHORT = KmaForecastProduct.SHORT_FORECAST;

/** A fresh, valid caller input. Each test builds its own so no reference is ever shared across tests. */
function makeInput(): KmaScheduledHourlyForecastInput {
  return { product: SHORT, nx: 60, ny: 127 };
}

/** A fresh, complete request the fake factory returns. The facade must pass it through by reference. */
function makeRequest(): KmaForecastRequest {
  return {
    product: SHORT,
    baseDate: '20260718',
    baseTime: '0500',
    nx: 60,
    ny: 127,
  };
}

/** A minimal, contracts-valid hourly entry for the success fixture. */
function makeHourly(): HourlyForecast {
  return {
    forecastAt: '2026-07-18T05:00:00+09:00',
    condition: 'CLEAR',
    temperatureCelsius: 21.5,
    feelsLikeCelsius: null,
    precipitationProbabilityPercent: null,
    precipitationAmountMillimeters: null,
    snowfallAmountCentimeters: null,
    humidityPercent: null,
    windSpeedMetersPerSecond: null,
    windDirectionDegrees: null,
  };
}

interface FactoryCall {
  readonly input: KmaScheduledHourlyForecastInput;
}

interface ServiceCall {
  readonly request: KmaForecastRequest;
  readonly options: KmaHourlyForecastServiceOptions | undefined;
}

/**
 * A fresh fake request factory that records each `input` (by reference) and returns `request`.
 * Uses `vi.fn` so call count and argument identity are directly assertable.
 */
function fakeFactory(request: KmaForecastRequest) {
  const calls: FactoryCall[] = [];
  const createScheduledRequest = vi.fn((input: KmaScheduledHourlyForecastInput) => {
    calls.push({ input });
    return request;
  });
  const factory: KmaForecastRequestFactory = { createScheduledRequest };
  return { factory, createScheduledRequest, calls };
}

/**
 * A fresh fake hourly service that records each call's `request`/`options` (by reference) and
 * returns the exact `result` Promise it is handed — never a new Promise of its own.
 */
function fakeService(result: Promise<KmaHourlyForecastServiceResult>) {
  const calls: ServiceCall[] = [];
  const fetchHourlyForecast = vi.fn(
    (
      request: KmaForecastRequest,
      options?: KmaHourlyForecastServiceOptions,
    ): Promise<KmaHourlyForecastServiceResult> => {
      calls.push({ request, options });
      return result;
    },
  );
  const service: KmaHourlyForecastService = { fetchHourlyForecast };
  return { service, fetchHourlyForecast, calls };
}

describe('createKmaScheduledHourlyForecastFacade — construction is side-effect-free', () => {
  it('does not call the request factory on construction alone', () => {
    const { factory, createScheduledRequest } = fakeFactory(makeRequest());
    const { service } = fakeService(Promise.resolve({ ok: true, hourly: [makeHourly()] }));
    createKmaScheduledHourlyForecastFacade(factory, service);
    expect(createScheduledRequest).not.toHaveBeenCalled();
  });

  it('does not call the hourly service on construction alone', () => {
    const { factory } = fakeFactory(makeRequest());
    const { service, fetchHourlyForecast } = fakeService(
      Promise.resolve({ ok: true, hourly: [makeHourly()] }),
    );
    createKmaScheduledHourlyForecastFacade(factory, service);
    expect(fetchHourlyForecast).not.toHaveBeenCalled();
  });

  it('does not throw on construction alone', () => {
    const { factory } = fakeFactory(makeRequest());
    const { service } = fakeService(Promise.resolve({ ok: true, hourly: [makeHourly()] }));
    expect(() => createKmaScheduledHourlyForecastFacade(factory, service)).not.toThrow();
  });

  it('works when both collaborator objects are frozen', () => {
    const request = makeRequest();
    const createScheduledRequest = vi.fn(() => request);
    const factory = Object.freeze<KmaForecastRequestFactory>({ createScheduledRequest });
    const resultPromise = Promise.resolve<KmaHourlyForecastServiceResult>({
      ok: true,
      hourly: [makeHourly()],
    });
    const fetchHourlyForecast = vi.fn(() => resultPromise);
    const service = Object.freeze<KmaHourlyForecastService>({ fetchHourlyForecast });

    const facade = createKmaScheduledHourlyForecastFacade(factory, service);
    expect(createScheduledRequest).not.toHaveBeenCalled();
    expect(fetchHourlyForecast).not.toHaveBeenCalled();
    expect(facade).toBeDefined();
  });

  it('keeps two facade instances independent (no global mutable state)', async () => {
    const requestA = makeRequest();
    const requestB = makeRequest();
    const resultA = Promise.resolve<KmaHourlyForecastServiceResult>({ ok: true, hourly: [] });
    const resultB = Promise.resolve<KmaHourlyForecastServiceResult>({ ok: true, hourly: [] });
    const a = fakeFactory(requestA);
    const b = fakeFactory(requestB);
    const sa = fakeService(resultA);
    const sb = fakeService(resultB);

    const facadeA = createKmaScheduledHourlyForecastFacade(a.factory, sa.service);
    const facadeB = createKmaScheduledHourlyForecastFacade(b.factory, sb.service);

    await facadeA.fetchScheduledHourlyForecast(makeInput());

    // Calling facadeA never touches facadeB's collaborators.
    expect(a.createScheduledRequest).toHaveBeenCalledTimes(1);
    expect(sa.fetchHourlyForecast).toHaveBeenCalledTimes(1);
    expect(b.createScheduledRequest).not.toHaveBeenCalled();
    expect(sb.fetchHourlyForecast).not.toHaveBeenCalled();
  });
});

describe('createKmaScheduledHourlyForecastFacade — success wiring', () => {
  it('sequences factory → service and passes every reference through unchanged', async () => {
    const input = makeInput();
    const request = makeRequest();
    const hourly = [makeHourly()];
    const result: KmaHourlyForecastServiceResult = { ok: true, hourly };
    const resultPromise = Promise.resolve(result);

    const { factory, createScheduledRequest, calls: factoryCalls } = fakeFactory(request);
    const { service, fetchHourlyForecast, calls: serviceCalls } = fakeService(resultPromise);
    const facade = createKmaScheduledHourlyForecastFacade(factory, service);

    const options: KmaHourlyForecastServiceOptions = { signal: new AbortController().signal };
    const returned = facade.fetchScheduledHourlyForecast(input, options);

    // The factory ran exactly once with the caller's exact input reference.
    expect(createScheduledRequest).toHaveBeenCalledTimes(1);
    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls[0].input).toBe(input);

    // The service ran exactly once with the factory's exact request and the caller's exact options.
    expect(fetchHourlyForecast).toHaveBeenCalledTimes(1);
    expect(serviceCalls).toHaveLength(1);
    expect(serviceCalls[0].request).toBe(request);
    expect(serviceCalls[0].options).toBe(options);

    // The facade returns the exact Promise the service returned, resolving to the exact result.
    expect(returned).toBe(resultPromise);
    const resolved = await returned;
    expect(resolved).toBe(result);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.hourly).toBe(hourly);
      expect(hourlyForecast.safeParse(resolved.hourly[0]).success).toBe(true);
    }
  });
});

describe('createKmaScheduledHourlyForecastFacade — options omitted', () => {
  it('forwards exactly undefined (never a synthesized {}) when options are omitted', async () => {
    const request = makeRequest();
    const { factory, createScheduledRequest } = fakeFactory(request);
    const { service, fetchHourlyForecast, calls } = fakeService(
      Promise.resolve({ ok: true, hourly: [] }),
    );
    const facade = createKmaScheduledHourlyForecastFacade(factory, service);

    await facade.fetchScheduledHourlyForecast(makeInput());

    expect(createScheduledRequest).toHaveBeenCalledTimes(1);
    expect(fetchHourlyForecast).toHaveBeenCalledTimes(1);
    // Exactly two positional arguments; the second is literally undefined.
    expect(fetchHourlyForecast.mock.calls[0]).toHaveLength(2);
    expect(fetchHourlyForecast.mock.calls[0][1]).toBeUndefined();
    expect(calls[0].options).toBeUndefined();
  });
});

describe('createKmaScheduledHourlyForecastFacade — AbortSignal reference', () => {
  it('forwards the exact options object and its signal, wrapping neither', async () => {
    const request = makeRequest();
    const { factory } = fakeFactory(request);
    const { service, calls } = fakeService(Promise.resolve({ ok: true, hourly: [] }));
    const facade = createKmaScheduledHourlyForecastFacade(factory, service);

    const controller = new AbortController();
    const signal = controller.signal;
    const options: KmaHourlyForecastServiceOptions = { signal };

    await facade.fetchScheduledHourlyForecast(makeInput(), options);

    expect(calls[0].options).toBe(options);
    expect(calls[0].options?.signal).toBe(signal);
  });
});

describe('createKmaScheduledHourlyForecastFacade — provider-stage failure pass-through', () => {
  it('returns the same PROVIDER-stage result and error reference, unchanged', async () => {
    const sentinelProviderError: KmaForecastProviderError = { kind: 'TIMEOUT' };
    const result: KmaHourlyForecastServiceResult = {
      ok: false,
      stage: 'PROVIDER',
      error: sentinelProviderError,
    };
    const resultPromise = Promise.resolve(result);

    const { factory } = fakeFactory(makeRequest());
    const { service } = fakeService(resultPromise);
    const facade = createKmaScheduledHourlyForecastFacade(factory, service);

    const returned = facade.fetchScheduledHourlyForecast(makeInput());
    expect(returned).toBe(resultPromise);

    const resolved = await returned;
    expect(resolved).toBe(result);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.stage).toBe('PROVIDER');
      if (resolved.stage === 'PROVIDER') {
        expect(resolved.error).toBe(sentinelProviderError);
      }
    }
  });
});

describe('createKmaScheduledHourlyForecastFacade — normalization-stage failure pass-through', () => {
  it('returns the same NORMALIZATION-stage result, issues array, and issue references', async () => {
    const issue: KmaHourlyNormalizationIssue = {
      slotKey: 'SHORT_FORECAST|20260718|0500|20260718|1400|60|127',
      field: 'temperatureCelsius',
      reason: 'ABSENT',
    };
    const sentinelIssues: readonly KmaHourlyNormalizationIssue[] = [issue];
    const result: KmaHourlyForecastServiceResult = {
      ok: false,
      stage: 'NORMALIZATION',
      issues: sentinelIssues,
    };
    const resultPromise = Promise.resolve(result);

    const { factory } = fakeFactory(makeRequest());
    const { service } = fakeService(resultPromise);
    const facade = createKmaScheduledHourlyForecastFacade(factory, service);

    const returned = facade.fetchScheduledHourlyForecast(makeInput());
    expect(returned).toBe(resultPromise);

    const resolved = await returned;
    expect(resolved).toBe(result);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.stage).toBe('NORMALIZATION');
      if (resolved.stage === 'NORMALIZATION') {
        expect(resolved.issues).toBe(sentinelIssues);
        expect(resolved.issues[0]).toBe(issue);
      }
    }
  });
});

describe('createKmaScheduledHourlyForecastFacade — factory throw', () => {
  it('propagates the exact factory error and never calls the hourly service', () => {
    const sentinel = new Error('REQUEST_FACTORY_SENTINEL_FOR_IDENTITY');
    const createScheduledRequest = vi.fn((): KmaForecastRequest => {
      throw sentinel;
    });
    const factory: KmaForecastRequestFactory = { createScheduledRequest };
    const { service, fetchHourlyForecast } = fakeService(
      Promise.resolve({ ok: true, hourly: [] }),
    );
    const facade = createKmaScheduledHourlyForecastFacade(factory, service);

    let caught: unknown;
    let returned: unknown;
    try {
      returned = facade.fetchScheduledHourlyForecast(makeInput());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(sentinel);
    expect(returned).toBeUndefined();
    expect(createScheduledRequest).toHaveBeenCalledTimes(1);
    expect(fetchHourlyForecast).not.toHaveBeenCalled();
  });
});

describe('createKmaScheduledHourlyForecastFacade — hourly service synchronous throw', () => {
  it('propagates the exact error the service throws synchronously (no broad catch)', () => {
    const sentinel = new Error('HOURLY_SERVICE_SYNC_SENTINEL_FOR_IDENTITY');
    const request = makeRequest();
    const { factory, createScheduledRequest } = fakeFactory(request);
    // The interface expects a Promise return; cast to exercise a runtime collaborator violation.
    const fetchHourlyForecast = vi.fn((): Promise<KmaHourlyForecastServiceResult> => {
      throw sentinel;
    });
    const service = { fetchHourlyForecast } as unknown as KmaHourlyForecastService;
    const facade = createKmaScheduledHourlyForecastFacade(factory, service);

    let caught: unknown;
    try {
      facade.fetchScheduledHourlyForecast(makeInput());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(sentinel);
    expect(createScheduledRequest).toHaveBeenCalledTimes(1);
    expect(fetchHourlyForecast).toHaveBeenCalledTimes(1);
  });
});

describe('createKmaScheduledHourlyForecastFacade — rejected Promise', () => {
  it('returns the same rejected Promise reference without intercepting the rejection', async () => {
    const sentinel = new Error('HOURLY_SERVICE_REJECTION_SENTINEL_FOR_IDENTITY');
    const rejected = Promise.reject<KmaHourlyForecastServiceResult>(sentinel);
    // Attach an assertion immediately so the rejection is always handled (no unhandled rejection).
    const assertion = expect(rejected).rejects.toBe(sentinel);

    const { factory } = fakeFactory(makeRequest());
    const { service } = fakeService(rejected);
    const facade = createKmaScheduledHourlyForecastFacade(factory, service);

    const returned = facade.fetchScheduledHourlyForecast(makeInput());
    expect(returned).toBe(rejected);
    await expect(returned).rejects.toBe(sentinel);
    await assertion;
  });
});

describe('createKmaScheduledHourlyForecastFacade — repeated calls and independence', () => {
  it('threads each call independently — right request/options/result, no cross-over or retained state', async () => {
    const requestOne = makeRequest();
    const requestTwo = { ...makeRequest(), baseTime: '1400' };
    const requestQueue = [requestOne, requestTwo];
    const createScheduledRequest = vi.fn((_input: KmaScheduledHourlyForecastInput) => {
      const next = requestQueue.shift();
      if (next === undefined) {
        throw new Error('test setup: factory called more than twice');
      }
      return next;
    });
    const factory: KmaForecastRequestFactory = { createScheduledRequest };

    const resultOne: KmaHourlyForecastServiceResult = { ok: true, hourly: [makeHourly()] };
    const resultTwo: KmaHourlyForecastServiceResult = { ok: false, stage: 'PROVIDER', error: { kind: 'ABORTED' } };
    const promiseOne = Promise.resolve(resultOne);
    const promiseTwo = Promise.resolve(resultTwo);
    const promiseQueue = [promiseOne, promiseTwo];
    const serviceCalls: ServiceCall[] = [];
    const fetchHourlyForecast = vi.fn(
      (request: KmaForecastRequest, options?: KmaHourlyForecastServiceOptions) => {
        serviceCalls.push({ request, options });
        const next = promiseQueue.shift();
        if (next === undefined) {
          throw new Error('test setup: service called more than twice');
        }
        return next;
      },
    );
    const service: KmaHourlyForecastService = { fetchHourlyForecast };
    const facade = createKmaScheduledHourlyForecastFacade(factory, service);

    const inputOne = makeInput();
    const inputTwo = makeInput();
    const optionsOne: KmaHourlyForecastServiceOptions = { signal: new AbortController().signal };
    const optionsTwo: KmaHourlyForecastServiceOptions = { signal: new AbortController().signal };

    const returnedOne = facade.fetchScheduledHourlyForecast(inputOne, optionsOne);
    const returnedTwo = facade.fetchScheduledHourlyForecast(inputTwo, optionsTwo);

    expect(createScheduledRequest).toHaveBeenCalledTimes(2);
    expect(fetchHourlyForecast).toHaveBeenCalledTimes(2);

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

describe('createKmaScheduledHourlyForecastFacade — frozen input/options', () => {
  it('accepts frozen input and options, mutates neither, and forwards the same references', async () => {
    const request = makeRequest();
    const { factory, calls: factoryCalls } = fakeFactory(request);
    const { service, calls: serviceCalls } = fakeService(
      Promise.resolve({ ok: true, hourly: [] }),
    );
    const facade = createKmaScheduledHourlyForecastFacade(factory, service);

    const signal = new AbortController().signal;
    const input = Object.freeze<KmaScheduledHourlyForecastInput>({ product: SHORT, nx: 60, ny: 127 });
    const options = Object.freeze<KmaHourlyForecastServiceOptions>({ signal });
    const inputSnapshot = JSON.stringify(input);

    await facade.fetchScheduledHourlyForecast(input, options);

    // Same references reach the collaborators.
    expect(factoryCalls[0].input).toBe(input);
    expect(serviceCalls[0].options).toBe(options);
    // Field/reference assertions (not a JSON compare of the signal): the signal is the same object.
    expect(serviceCalls[0].options?.signal).toBe(signal);
    // Neither the input fields nor its identity changed.
    expect(JSON.stringify(input)).toBe(inputSnapshot);
    expect(input.product).toBe(SHORT);
    expect(input.nx).toBe(60);
    expect(input.ny).toBe(127);
  });
});
