import { afterEach, describe, expect, it, vi } from 'vitest';

import { currentWeather } from '@life-weather/contracts';

import type { KmaCurrentObservationRequestClock } from '../services/index.js';
import {
  createKmaScheduledCurrentObservationCompositionFromEnv,
  type KmaScheduledCurrentObservationCompositionDependencies,
} from './kma-scheduled-current-observation.js';

/**
 * Layer A (below) isolates the composition's **wiring** — which collaborator it calls, in what
 * order, with which exact references — by mocking the four modules it imports
 * (`@life-weather/weather-core`, `../providers/kma/index.js`, `../services/index.js`,
 * `./system-clock.js`) via `vi.doMock` + `vi.resetModules()` + a dynamic `import()`, the same
 * pattern `kma-current-observation.test.ts`'s isolated-boundary tests already use. Layer B (further
 * below) assembles the **real** components through the statically-imported composition function
 * above and mocks nothing except the network and, where needed, the clock — so together the two
 * layers prove both the wiring contract and the actual pipeline behaviour.
 */

/** An obviously fake, decoded-shaped service key. Never a real/production key. */
const FAKE_KMA_SERVICE_KEY = 'test-only-decoded-current-key+slash==';

/** A secret-shaped key marker used only to prove the key never leaks into a result, error, or log. */
const SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR69 =
  'SECRET_SHAPED_KMA_CURRENT_KEY_MUST_NOT_LEAK_PR69+slash==';

/** A fresh environment object per call, so no test shares a mutable env reference. */
function makeEnv(serviceKey?: string): NodeJS.ProcessEnv {
  return serviceKey === undefined
    ? ({} as NodeJS.ProcessEnv)
    : ({ KMA_SERVICE_KEY: serviceKey } as NodeJS.ProcessEnv);
}

/** Assert an object's own enumerable keys are exactly `keys` (order-independent). */
function expectExactKeys(value: object, keys: readonly string[]): void {
  expect(Object.keys(value).sort()).toEqual([...keys].sort());
}

/** Spy on all five console methods and provide silence assertion + restore. */
function spyOnConsole() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

  return {
    expectSilent(): void {
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
      expect(debug).not.toHaveBeenCalled();
    },
    restore(): void {
      log.mockRestore();
      error.mockRestore();
      warn.mockRestore();
      info.mockRestore();
      debug.mockRestore();
    },
  };
}

// ---------------------------------------------------------------------------
// Layer A: isolated composition wiring
// ---------------------------------------------------------------------------

interface IsolatedMocks {
  readonly weatherCore?: Record<string, unknown>;
  readonly providers?: Record<string, unknown>;
  readonly services?: Record<string, unknown>;
  readonly systemClock?: Record<string, unknown>;
}

/**
 * Reset the module registry, install the requested partial mocks (spread over the real module so
 * unmocked exports stay real), and dynamically re-import the composition module. Every isolated test
 * gets a fresh module instance — no cross-test mock leakage.
 */
async function loadIsolatedComposition(
  mocks: IsolatedMocks,
): Promise<typeof import('./kma-scheduled-current-observation.js')> {
  vi.resetModules();
  if (mocks.weatherCore) {
    vi.doMock('@life-weather/weather-core', async () => {
      const actual = await vi.importActual<typeof import('@life-weather/weather-core')>(
        '@life-weather/weather-core',
      );
      return { ...actual, ...mocks.weatherCore };
    });
  }
  if (mocks.providers) {
    vi.doMock('../providers/kma/index.js', async () => {
      const actual = await vi.importActual<typeof import('../providers/kma/index.js')>(
        '../providers/kma/index.js',
      );
      return { ...actual, ...mocks.providers };
    });
  }
  if (mocks.services) {
    vi.doMock('../services/index.js', async () => {
      const actual = await vi.importActual<typeof import('../services/index.js')>(
        '../services/index.js',
      );
      return { ...actual, ...mocks.services };
    });
  }
  if (mocks.systemClock) {
    vi.doMock('./system-clock.js', async () => {
      const actual = await vi.importActual<typeof import('./system-clock.js')>(
        './system-clock.js',
      );
      return { ...actual, ...mocks.systemClock };
    });
  }
  return import('./kma-scheduled-current-observation.js');
}

/** A `vi.fn()` that throws a labeled error the instant it is called — proves a stage never runs. */
function neverCalled(label: string) {
  return vi.fn(() => {
    throw new Error(`isolated wiring test: ${label} must not be called`);
  });
}

/**
 * Run `action` and return whatever it threw, by exact reference — `undefined` if it didn't throw.
 * `toThrow(sentinel)` only compares `name`/`message`, not object identity; this captures the actual
 * thrown value so callers can assert exact-reference propagation with `toBe`.
 */
function captureThrown(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }

  return undefined;
}

describe('createKmaScheduledCurrentObservationCompositionFromEnv — isolated wiring', () => {
  afterEach(() => {
    vi.doUnmock('@life-weather/weather-core');
    vi.doUnmock('../providers/kma/index.js');
    vi.doUnmock('../services/index.js');
    vi.doUnmock('./system-clock.js');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('performs no provider/clock/factory/service/facade/selector call and no direct env/time/logging/timer/listener side effect merely by importing the module', async () => {
    const providerFactory = vi.fn();
    const systemClockFactory = vi.fn();
    const requestFactoryFactory = vi.fn();
    const serviceFactory = vi.fn();
    const facadeFactory = vi.fn();
    const selector = vi.fn();
    // The pre-PR #80 schedule-only selector this composition must never import/run directly anymore.
    const scheduleOnlySelector = vi.fn();

    // Track a direct read of the one env var this pipeline's config depends on
    // (`KMA_SERVICE_KEY`), via a reversible Proxy swapped in for `process.env` — never observing or
    // mutating any real value. Node rejects an accessor descriptor on an individual `process.env`
    // property ("'process.env' does not accept an accessor(getter/setter) descriptor"), so the trap
    // must live on a replacement object for the whole `env` reference instead. A trap that recorded
    // *every* property read was tried first, but Vitest's own dynamic-`import()` machinery reads
    // unrelated env keys internally (e.g. its watch-mode dependency reporting), making a whole-object
    // read count indistinguishable from a real regression. Filtering the trap to this one property
    // name is the minimal equivalent that still catches the composition module reading the service
    // key directly at import time, while every other property passes through untouched.
    const KMA_SERVICE_KEY_PROPERTY = 'KMA_SERVICE_KEY';
    const originalEnvDescriptor = Object.getOwnPropertyDescriptor(process, 'env');
    const originalEnv = process.env;
    const kmaServiceKeyGet = vi.fn();
    const proxiedEnv = new Proxy(originalEnv, {
      get(target, property, receiver) {
        if (property === KMA_SERVICE_KEY_PROPERTY) {
          kmaServiceKeyGet();
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const dateNowSpy = vi.spyOn(Date, 'now');
    const consoleSpy = spyOnConsole();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const setImmediateSpy = vi.spyOn(globalThis, 'setImmediate');
    const addEventListenerSpy = vi.spyOn(EventTarget.prototype, 'addEventListener');
    const processOnSpy = vi.spyOn(process, 'on');
    const processAddListenerSpy = vi.spyOn(process, 'addListener');

    try {
      if (originalEnvDescriptor) {
        Object.defineProperty(process, 'env', {
          ...originalEnvDescriptor,
          value: proxiedEnv,
        });
      }

      await loadIsolatedComposition({
        weatherCore: {
          selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay: selector,
          selectLatestKmaCurrentObservationBaseTime: scheduleOnlySelector,
        },
        providers: { createKmaCurrentObservationProviderFromEnv: providerFactory },
        services: {
          createKmaCurrentObservationRequestFactory: requestFactoryFactory,
          createKmaCurrentObservationService: serviceFactory,
          createKmaScheduledCurrentObservationFacade: facadeFactory,
        },
        systemClock: { createKmaSystemClock: systemClockFactory },
      });

      expect(providerFactory).not.toHaveBeenCalled();
      expect(systemClockFactory).not.toHaveBeenCalled();
      expect(requestFactoryFactory).not.toHaveBeenCalled();
      expect(serviceFactory).not.toHaveBeenCalled();
      expect(facadeFactory).not.toHaveBeenCalled();
      expect(selector).not.toHaveBeenCalled();
      expect(scheduleOnlySelector).not.toHaveBeenCalled();

      expect(kmaServiceKeyGet).not.toHaveBeenCalled();
      expect(dateNowSpy).not.toHaveBeenCalled();
      consoleSpy.expectSilent();
      expect(setTimeoutSpy).not.toHaveBeenCalled();
      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(setImmediateSpy).not.toHaveBeenCalled();
      expect(addEventListenerSpy).not.toHaveBeenCalled();
      expect(processOnSpy).not.toHaveBeenCalled();
      expect(processAddListenerSpy).not.toHaveBeenCalled();
    } finally {
      if (originalEnvDescriptor) {
        Object.defineProperty(process, 'env', originalEnvDescriptor);
      }
      dateNowSpy.mockRestore();
      consoleSpy.restore();
      setTimeoutSpy.mockRestore();
      setIntervalSpy.mockRestore();
      setImmediateSpy.mockRestore();
      addEventListenerSpy.mockRestore();
      processOnSpy.mockRestore();
      processAddListenerSpy.mockRestore();
    }
  });

  describe('config failure', () => {
    it('returns the provider config error by exact reference and builds nothing downstream', async () => {
      const sentinelError = Object.freeze({
        kind: 'CONFIG_ERROR',
        field: 'serviceKey',
        reason: 'MISSING',
      } as const);
      const providerFactory = vi.fn((..._args: unknown[]) => ({
        ok: false as const,
        error: sentinelError,
      }));
      const systemClockFactory = neverCalled('system clock factory');
      const requestFactoryFactory = neverCalled('request factory factory');
      const serviceFactory = neverCalled('service factory');
      const facadeFactory = neverCalled('facade factory');
      const consoleSpy = spyOnConsole();

      const { createKmaScheduledCurrentObservationCompositionFromEnv: composeIsolated } =
        await loadIsolatedComposition({
          providers: { createKmaCurrentObservationProviderFromEnv: providerFactory },
          services: {
            createKmaCurrentObservationRequestFactory: requestFactoryFactory,
            createKmaCurrentObservationService: serviceFactory,
            createKmaScheduledCurrentObservationFacade: facadeFactory,
          },
          systemClock: { createKmaSystemClock: systemClockFactory },
        });

      const env = Object.freeze({}) as NodeJS.ProcessEnv;
      const result = composeIsolated(env);

      expect(providerFactory).toHaveBeenCalledTimes(1);
      expect(providerFactory.mock.calls[0]?.[0]).toBe(env);
      expect(providerFactory.mock.calls[0]?.[1]).toBeUndefined();

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error('expected a config failure');
      }
      expect(result.error).toBe(sentinelError);
      expectExactKeys(result, ['ok', 'error']);

      expect(systemClockFactory).not.toHaveBeenCalled();
      expect(requestFactoryFactory).not.toHaveBeenCalled();
      expect(serviceFactory).not.toHaveBeenCalled();
      expect(facadeFactory).not.toHaveBeenCalled();

      consoleSpy.expectSilent();
      consoleSpy.restore();
    });

    it('forwards a supplied fetchImpl as the exact-shape { fetchImpl } options object', async () => {
      const sentinelError = Object.freeze({
        kind: 'CONFIG_ERROR',
        field: 'serviceKey',
        reason: 'INVALID',
      } as const);
      const providerFactory = vi.fn((..._args: unknown[]) => ({
        ok: false as const,
        error: sentinelError,
      }));
      const fetchImpl = vi.fn() as unknown as typeof fetch;

      const { createKmaScheduledCurrentObservationCompositionFromEnv: composeIsolated } =
        await loadIsolatedComposition({
          providers: { createKmaCurrentObservationProviderFromEnv: providerFactory },
        });

      composeIsolated(makeEnv(' bad '), { fetchImpl });

      const forwardedOptions = providerFactory.mock.calls[0]?.[1] as
        | { readonly fetchImpl?: typeof fetch }
        | undefined;
      expect(forwardedOptions).toBeDefined();
      expect(forwardedOptions?.fetchImpl).toBe(fetchImpl);
      expectExactKeys(forwardedOptions!, ['fetchImpl']);
    });
  });

  describe('success wiring — injected dependencies', () => {
    it('wires the injected clock, the explicit selector, and every collaborator by exact reference in order', async () => {
      const providerSentinel = Object.freeze({ marker: 'PROVIDER_SENTINEL_INJECTED' });
      const providerFactory = vi.fn((..._args: unknown[]) => ({
        ok: true as const,
        provider: providerSentinel,
      }));
      const systemClockFactory = neverCalled('system clock factory (clock was injected)');
      const requestFactorySentinel = Object.freeze({ marker: 'REQUEST_FACTORY_SENTINEL_INJECTED' });
      const requestFactoryFactory = vi.fn((..._args: unknown[]) => requestFactorySentinel);
      const serviceSentinel = Object.freeze({ marker: 'SERVICE_SENTINEL_INJECTED' });
      const serviceFactory = vi.fn((..._args: unknown[]) => serviceSentinel);
      const facadeSentinel = Object.freeze({ marker: 'FACADE_SENTINEL_INJECTED' });
      const facadeFactory = vi.fn((..._args: unknown[]) => facadeSentinel);
      const selectorSentinel = vi.fn();
      // The pre-PR #80 schedule-only selector — must never be the one wired into the request factory.
      const scheduleOnlySelectorSentinel = neverCalled(
        'schedule-only selector (production must inject the PR #79 availability-delay selector)',
      );
      const injectedClock: KmaCurrentObservationRequestClock = {
        nowEpochMilliseconds: vi.fn(() => {
          throw new Error('isolated wiring test: clock must not be read at construction');
        }),
      };
      const fetchImpl = vi.fn() as unknown as typeof fetch;

      const { createKmaScheduledCurrentObservationCompositionFromEnv: composeIsolated } =
        await loadIsolatedComposition({
          weatherCore: {
            selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay: selectorSentinel,
            selectLatestKmaCurrentObservationBaseTime: scheduleOnlySelectorSentinel,
          },
          providers: { createKmaCurrentObservationProviderFromEnv: providerFactory },
          services: {
            createKmaCurrentObservationRequestFactory: requestFactoryFactory,
            createKmaCurrentObservationService: serviceFactory,
            createKmaScheduledCurrentObservationFacade: facadeFactory,
          },
          systemClock: { createKmaSystemClock: systemClockFactory },
        });

      const env = Object.freeze(makeEnv(FAKE_KMA_SERVICE_KEY));
      const dependencies = Object.freeze<KmaScheduledCurrentObservationCompositionDependencies>({
        fetchImpl,
        clock: injectedClock,
      });

      const result = composeIsolated(env, dependencies);

      // Step 1: provider factory — exact env reference, fetchImpl-only options shape.
      expect(providerFactory).toHaveBeenCalledTimes(1);
      expect(providerFactory.mock.calls[0]?.[0]).toBe(env);
      const forwardedOptions = providerFactory.mock.calls[0]?.[1] as
        | { readonly fetchImpl?: typeof fetch }
        | undefined;
      expect(forwardedOptions?.fetchImpl).toBe(fetchImpl);
      expectExactKeys(forwardedOptions!, ['fetchImpl']);

      // Step 3: default system clock never built — the injected clock wins.
      expect(systemClockFactory).not.toHaveBeenCalled();

      // Step 4: request factory — exact injected clock + exact selector reference, in that order.
      expect(requestFactoryFactory).toHaveBeenCalledTimes(1);
      expect(requestFactoryFactory.mock.calls[0]?.[0]).toBe(injectedClock);
      expect(requestFactoryFactory.mock.calls[0]?.[1]).toBe(selectorSentinel);

      // Step 5: current-observation service — exact provider reference.
      expect(serviceFactory).toHaveBeenCalledTimes(1);
      expect(serviceFactory.mock.calls[0]?.[0]).toBe(providerSentinel);

      // Step 6: facade — exact request factory + service references.
      expect(facadeFactory).toHaveBeenCalledTimes(1);
      expect(facadeFactory.mock.calls[0]?.[0]).toBe(requestFactorySentinel);
      expect(facadeFactory.mock.calls[0]?.[1]).toBe(serviceSentinel);

      // Step 7: success result — exactly { ok, facade }, exact facade reference.
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error('expected success');
      }
      expect(result.facade).toBe(facadeSentinel);
      expectExactKeys(result, ['ok', 'facade']);

      for (const forbidden of [
        'provider',
        'requestFactory',
        'service',
        'clock',
        'env',
        'fetchImpl',
        'serviceKey',
        'config',
        'url',
        'dependencies',
        'selector',
      ]) {
        expect(forbidden in result).toBe(false);
      }

      // The injected clock was never read at construction.
      expect(injectedClock.nowEpochMilliseconds).not.toHaveBeenCalled();
      // The pre-PR #80 schedule-only selector was never called (it would have thrown via `neverCalled`
      // if the composition had wired it into the request factory instead of the PR #79 selector).
      expect(scheduleOnlySelectorSentinel).not.toHaveBeenCalled();

      // Neither env nor dependencies was mutated (both frozen — a mutation attempt would throw).
      expect(dependencies.fetchImpl).toBe(fetchImpl);
      expect(dependencies.clock).toBe(injectedClock);
    });
  });

  describe('success wiring — defaults', () => {
    it('builds and injects the default system clock and the explicit PR #79 availability-delay selector when dependencies are omitted', async () => {
      const providerSentinel = Object.freeze({ marker: 'PROVIDER_SENTINEL_DEFAULTS' });
      const providerFactory = vi.fn((..._args: unknown[]) => ({
        ok: true as const,
        provider: providerSentinel,
      }));
      const clockSentinel: KmaCurrentObservationRequestClock = {
        nowEpochMilliseconds: vi.fn(() => {
          throw new Error('isolated wiring test: clock must not be read at construction');
        }),
      };
      const systemClockFactory = vi.fn(() => clockSentinel);
      const requestFactorySentinel = Object.freeze({ marker: 'REQUEST_FACTORY_SENTINEL_DEFAULTS' });
      const requestFactoryFactory = vi.fn((..._args: unknown[]) => requestFactorySentinel);
      const serviceSentinel = Object.freeze({ marker: 'SERVICE_SENTINEL_DEFAULTS' });
      const serviceFactory = vi.fn((..._args: unknown[]) => serviceSentinel);
      const facadeSentinel = Object.freeze({ marker: 'FACADE_SENTINEL_DEFAULTS' });
      const facadeFactory = vi.fn((..._args: unknown[]) => facadeSentinel);
      const selectorSentinel = vi.fn();
      // The pre-PR #80 schedule-only selector — must never be the one wired into the request factory.
      const scheduleOnlySelectorSentinel = neverCalled(
        'schedule-only selector (production must inject the PR #79 availability-delay selector)',
      );

      const { createKmaScheduledCurrentObservationCompositionFromEnv: composeIsolated } =
        await loadIsolatedComposition({
          weatherCore: {
            selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay: selectorSentinel,
            selectLatestKmaCurrentObservationBaseTime: scheduleOnlySelectorSentinel,
          },
          providers: { createKmaCurrentObservationProviderFromEnv: providerFactory },
          services: {
            createKmaCurrentObservationRequestFactory: requestFactoryFactory,
            createKmaCurrentObservationService: serviceFactory,
            createKmaScheduledCurrentObservationFacade: facadeFactory,
          },
          systemClock: { createKmaSystemClock: systemClockFactory },
        });

      const env = makeEnv(FAKE_KMA_SERVICE_KEY);
      const result = composeIsolated(env);

      expect(providerFactory).toHaveBeenCalledTimes(1);
      // No dependencies supplied → the second positional argument is exactly undefined.
      expect(providerFactory.mock.calls[0]?.[1]).toBeUndefined();

      expect(systemClockFactory).toHaveBeenCalledTimes(1);
      expect(requestFactoryFactory).toHaveBeenCalledTimes(1);
      expect(requestFactoryFactory.mock.calls[0]?.[0]).toBe(clockSentinel);
      expect(requestFactoryFactory.mock.calls[0]?.[1]).toBe(selectorSentinel);
      expect(clockSentinel.nowEpochMilliseconds).not.toHaveBeenCalled();
      expect(scheduleOnlySelectorSentinel).not.toHaveBeenCalled();

      expect(serviceFactory).toHaveBeenCalledTimes(1);
      expect(serviceFactory.mock.calls[0]?.[0]).toBe(providerSentinel);
      expect(facadeFactory).toHaveBeenCalledTimes(1);
      expect(facadeFactory.mock.calls[0]?.[0]).toBe(requestFactorySentinel);
      expect(facadeFactory.mock.calls[0]?.[1]).toBe(serviceSentinel);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.facade).toBe(facadeSentinel);
      }
    });
  });

  describe('short-circuit order on a collaborator-factory throw', () => {
    it('propagates a provider-factory throw and builds nothing downstream', async () => {
      const sentinel = new Error('KMA_CURRENT_COMPOSITION_PROVIDER_FACTORY_SENTINEL');
      const providerFactory = vi.fn(() => {
        throw sentinel;
      });
      const systemClockFactory = neverCalled('system clock factory');
      const requestFactoryFactory = neverCalled('request factory factory');
      const serviceFactory = neverCalled('service factory');
      const facadeFactory = neverCalled('facade factory');
      const consoleSpy = spyOnConsole();

      const { createKmaScheduledCurrentObservationCompositionFromEnv: composeIsolated } =
        await loadIsolatedComposition({
          providers: { createKmaCurrentObservationProviderFromEnv: providerFactory },
          services: {
            createKmaCurrentObservationRequestFactory: requestFactoryFactory,
            createKmaCurrentObservationService: serviceFactory,
            createKmaScheduledCurrentObservationFacade: facadeFactory,
          },
          systemClock: { createKmaSystemClock: systemClockFactory },
        });

      const thrown = captureThrown(() => composeIsolated(makeEnv(FAKE_KMA_SERVICE_KEY)));
      expect(thrown).toBe(sentinel);
      expect(systemClockFactory).not.toHaveBeenCalled();
      expect(requestFactoryFactory).not.toHaveBeenCalled();
      expect(serviceFactory).not.toHaveBeenCalled();
      expect(facadeFactory).not.toHaveBeenCalled();
      consoleSpy.expectSilent();
      consoleSpy.restore();
    });

    it('propagates a default system-clock-factory throw after a successful provider build, before request-factory/service/facade construction', async () => {
      const providerSentinel = Object.freeze({ marker: 'X' });
      const providerFactory = vi.fn((..._args: unknown[]) => ({
        ok: true as const,
        provider: providerSentinel,
      }));
      const sentinel = new Error('KMA_CURRENT_COMPOSITION_SYSTEM_CLOCK_FACTORY_SENTINEL');
      const systemClockFactory = vi.fn(() => {
        throw sentinel;
      });
      const requestFactoryFactory = neverCalled('request factory factory');
      const serviceFactory = neverCalled('service factory');
      const facadeFactory = neverCalled('facade factory');
      const consoleSpy = spyOnConsole();

      const { createKmaScheduledCurrentObservationCompositionFromEnv: composeIsolated } =
        await loadIsolatedComposition({
          providers: { createKmaCurrentObservationProviderFromEnv: providerFactory },
          services: {
            createKmaCurrentObservationRequestFactory: requestFactoryFactory,
            createKmaCurrentObservationService: serviceFactory,
            createKmaScheduledCurrentObservationFacade: facadeFactory,
          },
          systemClock: { createKmaSystemClock: systemClockFactory },
        });

      const thrown = captureThrown(() => composeIsolated(makeEnv(FAKE_KMA_SERVICE_KEY)));
      expect(thrown).toBe(sentinel);
      expect(providerFactory).toHaveBeenCalledTimes(1);
      expect(requestFactoryFactory).not.toHaveBeenCalled();
      expect(serviceFactory).not.toHaveBeenCalled();
      expect(facadeFactory).not.toHaveBeenCalled();
      consoleSpy.expectSilent();
      consoleSpy.restore();
    });

    it('propagates a request-factory construction throw before service/facade construction', async () => {
      const providerSentinel = Object.freeze({ marker: 'X' });
      const providerFactory = vi.fn((..._args: unknown[]) => ({
        ok: true as const,
        provider: providerSentinel,
      }));
      const sentinel = new Error('KMA_CURRENT_COMPOSITION_REQUEST_FACTORY_SENTINEL');
      const requestFactoryFactory = vi.fn(() => {
        throw sentinel;
      });
      const serviceFactory = neverCalled('service factory');
      const facadeFactory = neverCalled('facade factory');
      const injectedClock: KmaCurrentObservationRequestClock = {
        nowEpochMilliseconds: vi.fn(),
      };
      const consoleSpy = spyOnConsole();

      const { createKmaScheduledCurrentObservationCompositionFromEnv: composeIsolated } =
        await loadIsolatedComposition({
          providers: { createKmaCurrentObservationProviderFromEnv: providerFactory },
          services: {
            createKmaCurrentObservationRequestFactory: requestFactoryFactory,
            createKmaCurrentObservationService: serviceFactory,
            createKmaScheduledCurrentObservationFacade: facadeFactory,
          },
        });

      const thrown = captureThrown(() =>
        composeIsolated(makeEnv(FAKE_KMA_SERVICE_KEY), { clock: injectedClock }),
      );
      expect(thrown).toBe(sentinel);
      expect(providerFactory).toHaveBeenCalledTimes(1);
      expect(requestFactoryFactory).toHaveBeenCalledTimes(1);
      expect(serviceFactory).not.toHaveBeenCalled();
      expect(facadeFactory).not.toHaveBeenCalled();
      consoleSpy.expectSilent();
      consoleSpy.restore();
    });

    it('propagates a current-observation-service construction throw before facade construction', async () => {
      const providerSentinel = Object.freeze({ marker: 'X' });
      const providerFactory = vi.fn((..._args: unknown[]) => ({
        ok: true as const,
        provider: providerSentinel,
      }));
      const requestFactorySentinel = Object.freeze({ marker: 'RF' });
      const requestFactoryFactory = vi.fn((..._args: unknown[]) => requestFactorySentinel);
      const sentinel = new Error('KMA_CURRENT_COMPOSITION_SERVICE_FACTORY_SENTINEL');
      const serviceFactory = vi.fn(() => {
        throw sentinel;
      });
      const facadeFactory = neverCalled('facade factory');
      const injectedClock: KmaCurrentObservationRequestClock = {
        nowEpochMilliseconds: vi.fn(),
      };
      const consoleSpy = spyOnConsole();

      const { createKmaScheduledCurrentObservationCompositionFromEnv: composeIsolated } =
        await loadIsolatedComposition({
          providers: { createKmaCurrentObservationProviderFromEnv: providerFactory },
          services: {
            createKmaCurrentObservationRequestFactory: requestFactoryFactory,
            createKmaCurrentObservationService: serviceFactory,
            createKmaScheduledCurrentObservationFacade: facadeFactory,
          },
        });

      const thrown = captureThrown(() =>
        composeIsolated(makeEnv(FAKE_KMA_SERVICE_KEY), { clock: injectedClock }),
      );
      expect(thrown).toBe(sentinel);
      expect(providerFactory).toHaveBeenCalledTimes(1);
      expect(requestFactoryFactory).toHaveBeenCalledTimes(1);
      expect(serviceFactory).toHaveBeenCalledTimes(1);
      expect(facadeFactory).not.toHaveBeenCalled();
      consoleSpy.expectSilent();
      consoleSpy.restore();
    });

    it('propagates a facade construction throw', async () => {
      const providerSentinel = Object.freeze({ marker: 'X' });
      const providerFactory = vi.fn((..._args: unknown[]) => ({
        ok: true as const,
        provider: providerSentinel,
      }));
      const requestFactorySentinel = Object.freeze({ marker: 'RF' });
      const requestFactoryFactory = vi.fn((..._args: unknown[]) => requestFactorySentinel);
      const serviceSentinel = Object.freeze({ marker: 'SVC' });
      const serviceFactory = vi.fn((..._args: unknown[]) => serviceSentinel);
      const sentinel = new Error('KMA_CURRENT_COMPOSITION_FACADE_FACTORY_SENTINEL');
      const facadeFactory = vi.fn(() => {
        throw sentinel;
      });
      const injectedClock: KmaCurrentObservationRequestClock = {
        nowEpochMilliseconds: vi.fn(),
      };
      const consoleSpy = spyOnConsole();

      const { createKmaScheduledCurrentObservationCompositionFromEnv: composeIsolated } =
        await loadIsolatedComposition({
          providers: { createKmaCurrentObservationProviderFromEnv: providerFactory },
          services: {
            createKmaCurrentObservationRequestFactory: requestFactoryFactory,
            createKmaCurrentObservationService: serviceFactory,
            createKmaScheduledCurrentObservationFacade: facadeFactory,
          },
        });

      const thrown = captureThrown(() =>
        composeIsolated(makeEnv(FAKE_KMA_SERVICE_KEY), { clock: injectedClock }),
      );
      expect(thrown).toBe(sentinel);
      expect(providerFactory).toHaveBeenCalledTimes(1);
      expect(requestFactoryFactory).toHaveBeenCalledTimes(1);
      expect(serviceFactory).toHaveBeenCalledTimes(1);
      expect(facadeFactory).toHaveBeenCalledTimes(1);
      consoleSpy.expectSilent();
      consoleSpy.restore();
    });
  });
});

// ---------------------------------------------------------------------------
// Layer B: real full-pipeline tests
// ---------------------------------------------------------------------------

/**
 * These tests assemble the **real** components — the PR #63 provider-from-env, the PR #67
 * current-observation service, the PR #66 request factory (with the PR #79 availability-delay
 * selector, injected here by PR #80), the PR #63 current normalizer, and the PR #68 scheduled
 * facade — through the statically-imported
 * composition function above. Nothing is mocked except the network (an injected in-memory
 * `fetchImpl`) and, where a deterministic instant is needed, the clock (an injected fake clock, or a
 * `Date.now()` spy for the default-clock-laziness test). No real service key, no external network,
 * and no fake timers are used.
 */

/** A fresh fake clock fixed at one instant, with a `vi.fn` so read count is directly assertable. */
function fixedClock(epochMilliseconds: number) {
  const nowEpochMilliseconds = vi.fn(() => epochMilliseconds);
  const clock: KmaCurrentObservationRequestClock = { nowEpochMilliseconds };
  return { clock, nowEpochMilliseconds };
}

interface FetchRecord {
  readonly url: unknown;
  readonly init: RequestInit | undefined;
}

/**
 * A fresh in-memory `fetch` that records each call (url + init by reference) and returns a **fresh**
 * `Response` per call from `makeResponse(callIndex)`.
 */
function recordingFetch(makeResponse: (callIndex: number) => Response) {
  const calls: FetchRecord[] = [];
  const fetchImpl = ((url: unknown, init?: RequestInit) => {
    const index = calls.length;
    calls.push({ url, init });
    return Promise.resolve(makeResponse(index));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** A `fetch` that must never run — fails the test loudly if the provider ever calls it. */
function neverCalledFetch() {
  const calls: FetchRecord[] = [];
  const fetchImpl = ((url: unknown, init?: RequestInit) => {
    calls.push({ url, init });
    throw new Error('test setup: fetch was called but should not have been');
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

interface RawItem {
  baseDate: string;
  baseTime: string;
  category: string;
  obsrValue: string | null;
  nx: number;
  ny: number;
}

/**
 * A raw current-observation item matching the 20260718/0600 issuance (the PR #79 availability-delay
 * selector's pick at 06:10:00.000 KST — the shared `CLOCK_AT_0610_KST_20260718` test clock) unless
 * overridden.
 */
function item(overrides: Partial<RawItem> = {}): RawItem {
  return {
    baseDate: '20260718',
    baseTime: '0600',
    category: 'T1H',
    obsrValue: '23.5',
    nx: 60,
    ny: 127,
    ...overrides,
  };
}

/** Serialize a KMA success envelope (matching the provider's expected success shape). */
function successBody(
  items: readonly RawItem[],
  options: { totalCount?: number } = {},
): string {
  return JSON.stringify({
    response: {
      header: { resultCode: '00', resultMsg: 'NORMAL_SERVICE' },
      body: {
        dataType: 'JSON',
        pageNo: 1,
        numOfRows: 1000,
        totalCount: options.totalCount ?? items.length,
        items: { item: items },
      },
    },
  });
}

/** The full set of categories 초단기실황 provides for the full-pipeline test. */
function fullCurrentSlotItems(): RawItem[] {
  return [
    item({ category: 'T1H', obsrValue: '23.5' }),
    item({ category: 'PTY', obsrValue: '0' }),
    item({ category: 'REH', obsrValue: '55' }),
    item({ category: 'WSD', obsrValue: '3.4' }),
    item({ category: 'VEC', obsrValue: '270' }),
    item({ category: 'RN1', obsrValue: '0' }),
  ];
}

function jsonOk(bodyString: string): Response {
  return new Response(bodyString, { status: 200 });
}

/** Compose successfully or fail the test — collapses the result-union narrowing in setup. */
function composeOrThrow(
  env: NodeJS.ProcessEnv,
  dependencies: KmaScheduledCurrentObservationCompositionDependencies,
) {
  const result = createKmaScheduledCurrentObservationCompositionFromEnv(env, dependencies);
  if (!result.ok) {
    throw new Error(
      `test setup: expected composition to succeed, got ${JSON.stringify(result)}`,
    );
  }
  return result.facade;
}

/**
 * `06:10:00.000 KST == 2026-07-17T21:10:00.000Z` — a post-availability-threshold instant. Under the
 * PR #79 availability-delay selector this adjusts to `06:00:00.000` and still selects base_date
 * 20260718 / base_time 0600 (the same issuance the pre-PR #80 schedule-only selector picked at
 * exactly `06:00:00.000`), so it is reused as the shared "generic success/failure" clock for tests
 * that do not target the availability boundary itself.
 */
const CLOCK_AT_0610_KST_20260718 = Date.UTC(2026, 6, 17, 21, 10, 0, 0);

describe('createKmaScheduledCurrentObservationCompositionFromEnv — missing/invalid config', () => {
  it('returns the provider MISSING config error for an empty environment (no throw, no I/O)', () => {
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0610_KST_20260718);
    const env = makeEnv();

    const result = createKmaScheduledCurrentObservationCompositionFromEnv(env, {
      fetchImpl,
      clock,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected a config failure');
    }
    expect(result.error).toEqual({
      kind: 'CONFIG_ERROR',
      field: 'serviceKey',
      reason: 'MISSING',
    });
    expectExactKeys(result, ['ok', 'error']);
    expect('facade' in result).toBe(false);
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('KMA_SERVICE_KEY');
  });

  it('returns MISSING for a whitespace-only key (no clock read, no fetch)', () => {
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0610_KST_20260718);

    const result = createKmaScheduledCurrentObservationCompositionFromEnv(makeEnv('   '), {
      fetchImpl,
      clock,
    });

    expect(result).toEqual({
      ok: false,
      error: { kind: 'CONFIG_ERROR', field: 'serviceKey', reason: 'MISSING' },
    });
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
  });

  it('returns INVALID for a key with leading/trailing whitespace, without leaking the raw key', () => {
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0610_KST_20260718);
    const rawKey = ` ${SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR69} `;

    const result = createKmaScheduledCurrentObservationCompositionFromEnv(makeEnv(rawKey), {
      fetchImpl,
      clock,
    });

    expect(result).toEqual({
      ok: false,
      error: { kind: 'CONFIG_ERROR', field: 'serviceKey', reason: 'INVALID' },
    });
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR69);
  });
});

describe('createKmaScheduledCurrentObservationCompositionFromEnv — construction laziness', () => {
  it('builds a facade exposing only { ok, facade } and reads no clock / network at construction', () => {
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0610_KST_20260718);
    const env = makeEnv(FAKE_KMA_SERVICE_KEY);
    const dependencies: KmaScheduledCurrentObservationCompositionDependencies = {
      fetchImpl,
      clock,
    };
    const envSnapshot = JSON.stringify(env);
    const dependenciesSnapshot = { ...dependencies };

    const result = createKmaScheduledCurrentObservationCompositionFromEnv(env, dependencies);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected success');
    }
    expectExactKeys(result, ['ok', 'facade']);
    expect(typeof result.facade.fetchScheduledCurrentWeather).toBe('function');

    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);

    for (const forbidden of [
      'provider',
      'requestFactory',
      'currentObservationService',
      'service',
      'clock',
      'env',
      'fetchImpl',
      'serviceKey',
      'config',
      'url',
      'dependencies',
    ]) {
      expect(forbidden in result).toBe(false);
    }

    expect(JSON.stringify(env)).toBe(envSnapshot);
    expect(dependencies.fetchImpl).toBe(dependenciesSnapshot.fetchImpl);
    expect(dependencies.clock).toBe(dependenciesSnapshot.clock);
  });

  it('works with a frozen environment and frozen dependencies', () => {
    const { fetchImpl } = neverCalledFetch();
    const { clock } = fixedClock(CLOCK_AT_0610_KST_20260718);
    const env = Object.freeze(makeEnv(FAKE_KMA_SERVICE_KEY));
    const dependencies = Object.freeze<KmaScheduledCurrentObservationCompositionDependencies>({
      fetchImpl,
      clock,
    });

    const result = createKmaScheduledCurrentObservationCompositionFromEnv(env, dependencies);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.facade.fetchScheduledCurrentWeather).toBe('function');
    }
  });
});

describe('createKmaScheduledCurrentObservationCompositionFromEnv — default system clock is lazy', () => {
  it('uses the system clock by default but reads no time at construction, and never caches across calls', async () => {
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(CLOCK_AT_0610_KST_20260718);
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      jsonOk(successBody(fullCurrentSlotItems())),
    );

    const result = createKmaScheduledCurrentObservationCompositionFromEnv(
      makeEnv(FAKE_KMA_SERVICE_KEY),
      { fetchImpl },
    );

    expect(result.ok).toBe(true);
    expect(dateNowSpy).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    if (!result.ok) {
      dateNowSpy.mockRestore();
      throw new Error('expected success');
    }

    await result.facade.fetchScheduledCurrentWeather({ nx: 60, ny: 127 });
    expect(dateNowSpy).toHaveBeenCalledTimes(1);

    await result.facade.fetchScheduledCurrentWeather({ nx: 60, ny: 127 });
    expect(dateNowSpy).toHaveBeenCalledTimes(2);

    dateNowSpy.mockRestore();
  });
});

describe('createKmaScheduledCurrentObservationCompositionFromEnv — PR #79 availability-delay selector integration', () => {
  it('06:09:59.999 KST selects base_time 0500 (one millisecond before the 10-minute threshold elapses)', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(
      () => new Response('x', { status: 503 }),
    );
    // 06:09:59.999 KST == 2026-07-17T21:09:59.999Z. Adjusted reference: 05:59:59.999 → base_time 0500.
    const { clock, nowEpochMilliseconds } = fixedClock(Date.UTC(2026, 6, 17, 21, 9, 59, 999));
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const result = await facade.fetchScheduledCurrentWeather({ nx: 60, ny: 127 });

    expect(result).toEqual({
      ok: false,
      stage: 'PROVIDER',
      error: { kind: 'HTTP_ERROR', status: 503 },
    });
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);
    const url = fetchCalls[0].url as URL;
    expect(url.pathname.endsWith('/getUltraSrtNcst')).toBe(true);
    expect(url.searchParams.get('base_date')).toBe('20260718');
    expect(url.searchParams.get('base_time')).toBe('0500');
  });

  it('06:10:00.000 KST selects base_time 0600 (the 10-minute threshold is inclusive)', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(
      () => new Response('x', { status: 503 }),
    );
    // 06:10:00.000 KST == 2026-07-17T21:10:00.000Z. Adjusted reference: 06:00:00.000 → base_time 0600.
    const { clock, nowEpochMilliseconds } = fixedClock(Date.UTC(2026, 6, 17, 21, 10, 0, 0));
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const result = await facade.fetchScheduledCurrentWeather({ nx: 60, ny: 127 });

    expect(result).toEqual({
      ok: false,
      stage: 'PROVIDER',
      error: { kind: 'HTTP_ERROR', status: 503 },
    });
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);
    const url = fetchCalls[0].url as URL;
    expect(url.pathname.endsWith('/getUltraSrtNcst')).toBe(true);
    expect(url.searchParams.get('base_date')).toBe('20260718');
    expect(url.searchParams.get('base_time')).toBe('0600');
  });
});

describe('createKmaScheduledCurrentObservationCompositionFromEnv — full success pipeline', () => {
  it('assembles the real components and produces one normalized CurrentWeather', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      jsonOk(successBody(fullCurrentSlotItems())),
    );
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0610_KST_20260718);
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);

    const result = await facade.fetchScheduledCurrentWeather({ nx: 60, ny: 127 });

    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);

    const requestedUrl = fetchCalls[0].url;
    expect(requestedUrl).toBeInstanceOf(URL);
    const url = requestedUrl as URL;
    expect(url.pathname.endsWith('/getUltraSrtNcst')).toBe(true);
    expect(url.searchParams.get('base_date')).toBe('20260718');
    expect(url.searchParams.get('base_time')).toBe('0600');
    expect(url.searchParams.get('nx')).toBe('60');
    expect(url.searchParams.get('ny')).toBe('127');
    expect(url.searchParams.get('pageNo')).toBe('1');
    expect(url.searchParams.get('numOfRows')).toBe('1000');
    expect(url.searchParams.get('dataType')).toBe('JSON');
    expect(url.searchParams.get('ServiceKey')).toBe(FAKE_KMA_SERVICE_KEY);

    expect(fetchCalls[0].init?.method).toBe('GET');
    expect(fetchCalls[0].init?.headers).toEqual({ Accept: 'application/json' });
    expect(fetchCalls[0].init?.redirect).toBe('error');
    expect(fetchCalls[0].init?.signal).toBeInstanceOf(AbortSignal);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`expected success, got ${JSON.stringify(result)}`);
    }
    expect(result.current).toEqual({
      observedAt: '2026-07-18T06:00:00+09:00',
      condition: 'UNKNOWN',
      temperatureCelsius: 23.5,
      feelsLikeCelsius: null,
      humidityPercent: 55,
      windSpeedMetersPerSecond: 3.4,
      windDirectionDegrees: 270,
      precipitationLastHourMillimeters: 0,
      visibilityMeters: null,
    });
    expect(currentWeather.safeParse(result.current).success).toBe(true);

    const serialized = JSON.stringify(result);
    for (const forbidden of [
      FAKE_KMA_SERVICE_KEY,
      'apis.data.go.kr',
      'ServiceKey',
      'obsrValue',
      'NORMAL_SERVICE',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('createKmaScheduledCurrentObservationCompositionFromEnv — provider-stage failure', () => {
  it('surfaces an HTTP 503 as a PROVIDER-stage HTTP_ERROR (not re-classified)', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(
      () => new Response('secret upstream error page', { status: 503 }),
    );
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0610_KST_20260718);
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const result = await facade.fetchScheduledCurrentWeather({ nx: 60, ny: 127 });

    expect(result).toEqual({
      ok: false,
      stage: 'PROVIDER',
      error: { kind: 'HTTP_ERROR', status: 503 },
    });
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);

    const serialized = JSON.stringify(result);
    for (const forbidden of [FAKE_KMA_SERVICE_KEY, 'apis.data.go.kr', 'ServiceKey']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('createKmaScheduledCurrentObservationCompositionFromEnv — normalization-stage failure', () => {
  it('surfaces a missing required T1H category as a NORMALIZATION-stage issue', async () => {
    const items = [item({ category: 'PTY', obsrValue: '0' })];
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() => jsonOk(successBody(items)));
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0610_KST_20260718);
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const result = await facade.fetchScheduledCurrentWeather({ nx: 60, ny: 127 });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected a normalization failure');
    }
    expect(result.stage).toBe('NORMALIZATION');
    if (result.stage !== 'NORMALIZATION') {
      throw new Error(`expected NORMALIZATION stage, got ${result.stage}`);
    }
    expect(result.issues).toContainEqual({ field: 'temperatureCelsius', reason: 'ABSENT' });
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);

    expect('current' in result).toBe(false);
    const serialized = JSON.stringify(result);
    for (const forbidden of [FAKE_KMA_SERVICE_KEY, 'apis.data.go.kr', 'ServiceKey', 'obsrValue']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('createKmaScheduledCurrentObservationCompositionFromEnv — pre-aborted signal', () => {
  it('honours a pre-aborted signal as a PROVIDER-stage ABORTED with no fetch', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      jsonOk(successBody(fullCurrentSlotItems())),
    );
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0610_KST_20260718);
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const controller = new AbortController();
    controller.abort();

    const result = await facade.fetchScheduledCurrentWeather(
      { nx: 60, ny: 127 },
      { signal: controller.signal },
    );

    expect(result).toEqual({
      ok: false,
      stage: 'PROVIDER',
      error: { kind: 'ABORTED' },
    });
    // The request was still built (one clock read), but the provider short-circuited before fetch.
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('createKmaScheduledCurrentObservationCompositionFromEnv — no secret leakage, no logging', () => {
  it('never surfaces the service key across success and both failure results, and logs nothing', async () => {
    const consoleSpy = spyOnConsole();

    const success = recordingFetch(() => jsonOk(successBody(fullCurrentSlotItems())));
    const successFacade = composeOrThrow(makeEnv(SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR69), {
      fetchImpl: success.fetchImpl,
      clock: fixedClock(CLOCK_AT_0610_KST_20260718).clock,
    });
    const successResult = await successFacade.fetchScheduledCurrentWeather({ nx: 60, ny: 127 });
    expect(successResult.ok).toBe(true);
    expect(JSON.stringify(successResult)).not.toContain(SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR69);

    const providerFail = recordingFetch(() => new Response('x', { status: 503 }));
    const providerFailFacade = composeOrThrow(makeEnv(SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR69), {
      fetchImpl: providerFail.fetchImpl,
      clock: fixedClock(CLOCK_AT_0610_KST_20260718).clock,
    });
    const providerFailResult = await providerFailFacade.fetchScheduledCurrentWeather({
      nx: 60,
      ny: 127,
    });
    expect(providerFailResult.ok).toBe(false);
    expect(JSON.stringify(providerFailResult)).not.toContain(
      SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR69,
    );

    const normFail = recordingFetch(() =>
      jsonOk(successBody([item({ category: 'PTY', obsrValue: '0' })])),
    );
    const normFailFacade = composeOrThrow(makeEnv(SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR69), {
      fetchImpl: normFail.fetchImpl,
      clock: fixedClock(CLOCK_AT_0610_KST_20260718).clock,
    });
    const normFailResult = await normFailFacade.fetchScheduledCurrentWeather({ nx: 60, ny: 127 });
    expect(normFailResult.ok).toBe(false);
    expect(JSON.stringify(normFailResult)).not.toContain(SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR69);

    consoleSpy.expectSilent();
    consoleSpy.restore();
  });
});

describe('createKmaScheduledCurrentObservationCompositionFromEnv — repeated independent calls', () => {
  it('threads two facade calls independently (clock ×2, fetch ×2, distinct result references)', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      jsonOk(successBody(fullCurrentSlotItems())),
    );
    const nowValues = [CLOCK_AT_0610_KST_20260718, CLOCK_AT_0610_KST_20260718 + 60_000];
    let callIndex = 0;
    const nowEpochMilliseconds = vi.fn(() => {
      const value = nowValues[callIndex];
      callIndex += 1;
      return value;
    });
    const clock: KmaCurrentObservationRequestClock = { nowEpochMilliseconds };
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const first = await facade.fetchScheduledCurrentWeather({ nx: 60, ny: 127 });
    const second = await facade.fetchScheduledCurrentWeather({ nx: 60, ny: 127 });

    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(2);
    expect(fetchCalls).toHaveLength(2);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      throw new Error('expected both calls to succeed');
    }
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });

  it('produces independent facades and results across two separate composition calls', async () => {
    const runA = recordingFetch(() => jsonOk(successBody(fullCurrentSlotItems())));
    const runB = recordingFetch(() => jsonOk(successBody(fullCurrentSlotItems())));
    const env = makeEnv(FAKE_KMA_SERVICE_KEY);

    const facadeA = composeOrThrow(env, {
      fetchImpl: runA.fetchImpl,
      clock: fixedClock(CLOCK_AT_0610_KST_20260718).clock,
    });
    const facadeB = composeOrThrow(env, {
      fetchImpl: runB.fetchImpl,
      clock: fixedClock(CLOCK_AT_0610_KST_20260718).clock,
    });

    expect(facadeA).not.toBe(facadeB);

    const resultA = await facadeA.fetchScheduledCurrentWeather({ nx: 60, ny: 127 });
    const resultB = await facadeB.fetchScheduledCurrentWeather({ nx: 60, ny: 127 });

    expect(resultA).not.toBe(resultB);
    expect(resultA).toEqual(resultB);
    expect(runA.calls).toHaveLength(1);
    expect(runB.calls).toHaveLength(1);
  });
});
