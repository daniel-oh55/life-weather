import { afterEach, describe, expect, it, vi } from 'vitest';

import { currentWeather } from '@life-weather/contracts';
import { convertKmaLatitudeLongitudeToGrid } from '@life-weather/weather-core';

import type { KmaCurrentObservationRequestClock } from '../services/index.js';
import {
  createKmaLocationScheduledCurrentObservationCompositionFromEnv,
  type KmaLocationScheduledCurrentObservationCompositionDependencies,
} from './kma-location-scheduled-current-observation.js';

/**
 * Layer A (below) isolates this composition's **wiring** — which collaborator it calls, in what
 * order, with which exact references — by mocking the two modules it imports directly
 * (`@life-weather/weather-core`, `../services/index.js`) plus the PR #69 composition module it
 * reuses (`./kma-scheduled-current-observation.js`), via `vi.doMock` + `vi.resetModules()` + a
 * dynamic `import()` — the same pattern `kma-scheduled-current-observation.test.ts`'s isolated
 * wiring tests already use. Layer B (further below) assembles the **real** components through the
 * statically-imported composition function above and mocks nothing except the network and, where
 * needed, the clock — so together the two layers prove both the wiring contract and the actual
 * pipeline behaviour.
 */

/** An obviously fake, decoded-shaped service key. Never a real/production key. */
const FAKE_KMA_SERVICE_KEY = 'test-only-decoded-location-current-key+slash==';

/** A secret-shaped key marker used only to prove the key never leaks into a result, error, or log. */
const SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR71 =
  'SECRET_SHAPED_KMA_LOCATION_CURRENT_KEY_MUST_NOT_LEAK_PR71+slash==';

/** Seoul: latitude/longitude the production converter maps onto the KMA grid { nx: 60, ny: 127 }. */
const SEOUL_LATITUDE = 37.5665;
const SEOUL_LONGITUDE = 126.978;

/** Tokyo: a physically valid coordinate outside the KMA forecast grid → converter returns null. */
const TOKYO_LATITUDE = 35.6762;
const TOKYO_LONGITUDE = 139.6503;

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

// ---------------------------------------------------------------------------
// Layer A: isolated composition wiring
// ---------------------------------------------------------------------------

interface IsolatedMocks {
  readonly weatherCore?: Record<string, unknown>;
  readonly services?: Record<string, unknown>;
  readonly scheduledComposition?: Record<string, unknown>;
  readonly weatherRouteComposition?: Record<string, unknown>;
  readonly routes?: Record<string, unknown>;
}

/**
 * Reset the module registry, install the requested partial mocks (spread over the real module so
 * unmocked exports stay real), and dynamically re-import the composition module. Every isolated test
 * gets a fresh module instance — no cross-test mock leakage.
 *
 * `weatherRouteComposition`/`routes` mock the route/startup boundaries this composition explicitly
 * does **not** import (`./weather-route.js`'s `createProductionWeatherRouteDependencies`,
 * `../routes/index.js`'s `createWeatherRoute`) with bare sentinel-only replacements — never
 * `importActual` — so a future mutant that imports/calls either at module scope trips an observable
 * sentinel instead of silently running real route/startup code.
 */
async function loadIsolatedComposition(
  mocks: IsolatedMocks,
): Promise<typeof import('./kma-location-scheduled-current-observation.js')> {
  vi.resetModules();
  if (mocks.weatherCore) {
    vi.doMock('@life-weather/weather-core', async () => {
      const actual = await vi.importActual<typeof import('@life-weather/weather-core')>(
        '@life-weather/weather-core',
      );
      return { ...actual, ...mocks.weatherCore };
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
  if (mocks.scheduledComposition) {
    vi.doMock('./kma-scheduled-current-observation.js', async () => {
      const actual = await vi.importActual<typeof import('./kma-scheduled-current-observation.js')>(
        './kma-scheduled-current-observation.js',
      );
      return { ...actual, ...mocks.scheduledComposition };
    });
  }
  if (mocks.weatherRouteComposition) {
    const weatherRouteComposition = mocks.weatherRouteComposition;
    vi.doMock('./weather-route.js', () => weatherRouteComposition);
  }
  if (mocks.routes) {
    const routes = mocks.routes;
    vi.doMock('../routes/index.js', () => routes);
  }
  return import('./kma-location-scheduled-current-observation.js');
}

describe('createKmaLocationScheduledCurrentObservationCompositionFromEnv — isolated wiring', () => {
  afterEach(() => {
    vi.doUnmock('@life-weather/weather-core');
    vi.doUnmock('../services/index.js');
    vi.doUnmock('./kma-scheduled-current-observation.js');
    vi.doUnmock('./weather-route.js');
    vi.doUnmock('../routes/index.js');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('performs no scheduled-composition/converter/location-facade/selector/route call and no direct env/time/logging/timer/listener/network side effect merely by importing the module', async () => {
    const scheduledCompositionFactory = vi.fn();
    const locationFacadeFactory = vi.fn();
    const converter = vi.fn();
    // The PR #79 availability-delay selector the parent PR #69 composition injects (as of PR #80) —
    // this composition must never import/run it directly, proving a future regression can't quietly
    // take ownership of PR #69's selector policy at this layer. The pre-PR #80 schedule-only selector
    // is guarded the same way.
    const selector = vi.fn();
    const scheduleOnlySelector = vi.fn();
    // Route/startup boundaries this composition explicitly does not wire — see the
    // `loadIsolatedComposition` doc comment above.
    const createProductionWeatherRouteDependenciesSentinel = vi.fn();
    const createWeatherRouteSentinel = vi.fn();

    // Track a direct read of the one env var this pipeline's config depends on
    // (`KMA_SERVICE_KEY`), via a reversible Proxy swapped in for `process.env` — never observing or
    // mutating any real value. Node rejects an accessor descriptor on an individual `process.env`
    // property ("'process.env' does not accept an accessor(getter/setter) descriptor"), so the trap
    // must live on a replacement object for the whole `env` reference instead. A trap that recorded
    // *every* property read was tried first, but Vitest's own dynamic-`import()` machinery reads
    // unrelated env keys internally (e.g. its watch-mode dependency reporting), making a whole-object
    // read count indistinguishable from a real regression. Filtering the trap to this one property
    // name is the minimal equivalent that still catches the composition module reading the service
    // key directly at import time, while every other property passes through untouched. Same pattern
    // as `kma-scheduled-current-observation.test.ts`'s isolated wiring test.
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
    // A guard, not a functional mock: it throws the instant it is called, so any call fails the test
    // loudly instead of silently reaching the network.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('isolated wiring test: global fetch must not be called merely by importing the module');
    });

    try {
      if (originalEnvDescriptor) {
        Object.defineProperty(process, 'env', {
          ...originalEnvDescriptor,
          value: proxiedEnv,
        });
      }

      await loadIsolatedComposition({
        weatherCore: {
          convertKmaLatitudeLongitudeToGrid: converter,
          selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay: selector,
          selectLatestKmaCurrentObservationBaseTime: scheduleOnlySelector,
        },
        services: { createKmaLocationScheduledCurrentObservationFacade: locationFacadeFactory },
        scheduledComposition: {
          createKmaScheduledCurrentObservationCompositionFromEnv: scheduledCompositionFactory,
        },
        weatherRouteComposition: {
          createProductionWeatherRouteDependencies: createProductionWeatherRouteDependenciesSentinel,
        },
        routes: {
          createWeatherRoute: createWeatherRouteSentinel,
        },
      });

      expect(scheduledCompositionFactory).not.toHaveBeenCalled();
      expect(locationFacadeFactory).not.toHaveBeenCalled();
      expect(converter).not.toHaveBeenCalled();
      expect(selector).not.toHaveBeenCalled();
      expect(scheduleOnlySelector).not.toHaveBeenCalled();
      expect(createProductionWeatherRouteDependenciesSentinel).not.toHaveBeenCalled();
      expect(createWeatherRouteSentinel).not.toHaveBeenCalled();
      expect(kmaServiceKeyGet).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
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
      fetchSpy.mockRestore();
    }
  });

  describe('config failure', () => {
    it('returns the scheduled composition config error by exact reference and builds nothing downstream', async () => {
      const sentinelError = Object.freeze({
        kind: 'CONFIG_ERROR',
        field: 'serviceKey',
        reason: 'MISSING',
      } as const);
      const scheduledCompositionFactory = vi.fn((..._args: unknown[]) => ({
        ok: false as const,
        error: sentinelError,
      }));
      const locationFacadeFactory = neverCalled('location facade factory');
      const converter = neverCalled('converter');
      const consoleSpy = spyOnConsole();

      const { createKmaLocationScheduledCurrentObservationCompositionFromEnv: composeIsolated } =
        await loadIsolatedComposition({
          weatherCore: { convertKmaLatitudeLongitudeToGrid: converter },
          services: { createKmaLocationScheduledCurrentObservationFacade: locationFacadeFactory },
          scheduledComposition: {
            createKmaScheduledCurrentObservationCompositionFromEnv: scheduledCompositionFactory,
          },
        });

      const env = Object.freeze({}) as NodeJS.ProcessEnv;
      const dependencies =
        Object.freeze<KmaLocationScheduledCurrentObservationCompositionDependencies>({});
      const result = composeIsolated(env, dependencies);

      expect(scheduledCompositionFactory).toHaveBeenCalledTimes(1);
      expect(scheduledCompositionFactory.mock.calls[0]?.[0]).toBe(env);
      expect(scheduledCompositionFactory.mock.calls[0]?.[1]).toBe(dependencies);

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error('expected a config failure');
      }
      expect(result.error).toBe(sentinelError);
      expectExactKeys(result, ['ok', 'error']);

      expect(locationFacadeFactory).not.toHaveBeenCalled();
      expect(converter).not.toHaveBeenCalled();

      consoleSpy.expectSilent();
      consoleSpy.restore();
    });
  });

  describe('success wiring', () => {
    it('wires the exact env/dependencies, the exact production converter, and the exact scheduled facade in order', async () => {
      const scheduledFacadeSentinel = Object.freeze({ marker: 'SCHEDULED_FACADE_SENTINEL' });
      const scheduledCompositionFactory = vi.fn((..._args: unknown[]) => ({
        ok: true as const,
        facade: scheduledFacadeSentinel,
      }));
      const locationFacadeSentinel = Object.freeze({ marker: 'LOCATION_FACADE_SENTINEL' });
      const locationFacadeFactory = vi.fn((..._args: unknown[]) => locationFacadeSentinel);
      const converterSentinel = vi.fn();

      const { createKmaLocationScheduledCurrentObservationCompositionFromEnv: composeIsolated } =
        await loadIsolatedComposition({
          weatherCore: { convertKmaLatitudeLongitudeToGrid: converterSentinel },
          services: { createKmaLocationScheduledCurrentObservationFacade: locationFacadeFactory },
          scheduledComposition: {
            createKmaScheduledCurrentObservationCompositionFromEnv: scheduledCompositionFactory,
          },
        });

      const env = Object.freeze(makeEnv(FAKE_KMA_SERVICE_KEY));
      const dependencies =
        Object.freeze<KmaLocationScheduledCurrentObservationCompositionDependencies>({});

      const result = composeIsolated(env, dependencies);

      // Step 1: the scheduled composition — exact env/dependencies references.
      expect(scheduledCompositionFactory).toHaveBeenCalledTimes(1);
      expect(scheduledCompositionFactory.mock.calls[0]?.[0]).toBe(env);
      expect(scheduledCompositionFactory.mock.calls[0]?.[1]).toBe(dependencies);

      // Step 3-4: the location facade factory — exact production converter reference (arg1), exact
      // scheduled facade reference (arg2).
      expect(locationFacadeFactory).toHaveBeenCalledTimes(1);
      expect(locationFacadeFactory.mock.calls[0]?.[0]).toBe(converterSentinel);
      expect(locationFacadeFactory.mock.calls[0]?.[1]).toBe(scheduledFacadeSentinel);

      // The production converter itself is never executed by the composition.
      expect(converterSentinel).not.toHaveBeenCalled();

      // Step 5: success result — exactly { ok, facade }, exact facade reference.
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error('expected success');
      }
      expect(result.facade).toBe(locationFacadeSentinel);
      expectExactKeys(result, ['ok', 'facade']);

      for (const forbidden of [
        'scheduledFacade',
        'converter',
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
      ]) {
        expect(forbidden in result).toBe(false);
      }
    });

    it('forwards exactly undefined for env/dependencies when the caller omits them', async () => {
      const scheduledFacadeSentinel = Object.freeze({
        marker: 'SCHEDULED_FACADE_SENTINEL_DEFAULTS',
      });
      const scheduledCompositionFactory = vi.fn((..._args: unknown[]) => ({
        ok: true as const,
        facade: scheduledFacadeSentinel,
      }));
      const locationFacadeSentinel = Object.freeze({ marker: 'LOCATION_FACADE_SENTINEL_DEFAULTS' });
      const locationFacadeFactory = vi.fn((..._args: unknown[]) => locationFacadeSentinel);
      const converterSentinel = vi.fn();

      const { createKmaLocationScheduledCurrentObservationCompositionFromEnv: composeIsolated } =
        await loadIsolatedComposition({
          weatherCore: { convertKmaLatitudeLongitudeToGrid: converterSentinel },
          services: { createKmaLocationScheduledCurrentObservationFacade: locationFacadeFactory },
          scheduledComposition: {
            createKmaScheduledCurrentObservationCompositionFromEnv: scheduledCompositionFactory,
          },
        });

      const result = composeIsolated();

      expect(scheduledCompositionFactory).toHaveBeenCalledTimes(1);
      expect(scheduledCompositionFactory.mock.calls[0]?.[0]).toBeUndefined();
      expect(scheduledCompositionFactory.mock.calls[0]?.[1]).toBeUndefined();
      expect(result.ok).toBe(true);
    });
  });

  describe('call order', () => {
    it('calls the scheduled composition before constructing the location facade, and never runs the converter', async () => {
      const order: string[] = [];
      const scheduledFacadeSentinel = Object.freeze({ marker: 'ORDER_SCHEDULED_FACADE' });
      const scheduledCompositionFactory = vi.fn((..._args: unknown[]) => {
        order.push('scheduledComposition');
        return { ok: true as const, facade: scheduledFacadeSentinel };
      });
      const locationFacadeFactory = vi.fn((..._args: unknown[]) => {
        order.push('locationFacade');
        return { marker: 'ORDER_LOCATION_FACADE' };
      });
      const converterSentinel = vi.fn(() => {
        order.push('converter');
        return null;
      });

      const { createKmaLocationScheduledCurrentObservationCompositionFromEnv: composeIsolated } =
        await loadIsolatedComposition({
          weatherCore: { convertKmaLatitudeLongitudeToGrid: converterSentinel },
          services: { createKmaLocationScheduledCurrentObservationFacade: locationFacadeFactory },
          scheduledComposition: {
            createKmaScheduledCurrentObservationCompositionFromEnv: scheduledCompositionFactory,
          },
        });

      composeIsolated(makeEnv(FAKE_KMA_SERVICE_KEY));

      expect(order).toEqual(['scheduledComposition', 'locationFacade']);
    });
  });

  describe('location facade construction throw', () => {
    it('propagates the exact thrown reference, calls nothing downstream, and logs nothing', async () => {
      const scheduledFacadeSentinel = Object.freeze({ marker: 'THROW_SCHEDULED_FACADE' });
      const scheduledCompositionFactory = vi.fn((..._args: unknown[]) => ({
        ok: true as const,
        facade: scheduledFacadeSentinel,
      }));
      const sentinel = new Error('KMA_LOCATION_CURRENT_COMPOSITION_FACADE_FACTORY_SENTINEL');
      const locationFacadeFactory = vi.fn(() => {
        throw sentinel;
      });
      const converterSentinel = vi.fn();
      const consoleSpy = spyOnConsole();

      const { createKmaLocationScheduledCurrentObservationCompositionFromEnv: composeIsolated } =
        await loadIsolatedComposition({
          weatherCore: { convertKmaLatitudeLongitudeToGrid: converterSentinel },
          services: { createKmaLocationScheduledCurrentObservationFacade: locationFacadeFactory },
          scheduledComposition: {
            createKmaScheduledCurrentObservationCompositionFromEnv: scheduledCompositionFactory,
          },
        });

      const thrown = captureThrown(() => composeIsolated(makeEnv(FAKE_KMA_SERVICE_KEY)));
      expect(thrown).toBe(sentinel);
      expect(scheduledCompositionFactory).toHaveBeenCalledTimes(1);
      expect(locationFacadeFactory).toHaveBeenCalledTimes(1);
      expect(converterSentinel).not.toHaveBeenCalled();
      consoleSpy.expectSilent();
      consoleSpy.restore();
    });
  });

  describe('repeated composition', () => {
    it('builds independent scheduled/location facade graphs on each call', async () => {
      let compositionCallIndex = 0;
      const scheduledCompositionFactory = vi.fn((..._args: unknown[]) => {
        compositionCallIndex += 1;
        return { ok: true as const, facade: { marker: `SCHEDULED_${compositionCallIndex}` } };
      });
      let facadeCallIndex = 0;
      const locationFacadeFactory = vi.fn((..._args: unknown[]) => {
        facadeCallIndex += 1;
        return { marker: `LOCATION_${facadeCallIndex}` };
      });
      const converterSentinel = vi.fn();

      const { createKmaLocationScheduledCurrentObservationCompositionFromEnv: composeIsolated } =
        await loadIsolatedComposition({
          weatherCore: { convertKmaLatitudeLongitudeToGrid: converterSentinel },
          services: { createKmaLocationScheduledCurrentObservationFacade: locationFacadeFactory },
          scheduledComposition: {
            createKmaScheduledCurrentObservationCompositionFromEnv: scheduledCompositionFactory,
          },
        });

      const first = composeIsolated(makeEnv(FAKE_KMA_SERVICE_KEY));
      const second = composeIsolated(makeEnv(FAKE_KMA_SERVICE_KEY));

      expect(first).not.toBe(second);
      if (!first.ok || !second.ok) {
        throw new Error('expected both compositions to succeed');
      }
      expect(first.facade).not.toBe(second.facade);
      expect(scheduledCompositionFactory).toHaveBeenCalledTimes(2);
      expect(locationFacadeFactory).toHaveBeenCalledTimes(2);
    });
  });
});

// ---------------------------------------------------------------------------
// Layer B: real full-pipeline tests
// ---------------------------------------------------------------------------

/**
 * These tests assemble the **real** components — the PR #63 provider-from-env, the PR #67
 * current-observation service, the PR #66 request factory (with the PR #79 availability-delay
 * selector, injected by the parent PR #69 composition as of PR #80),
 * the PR #63 current normalizer, the PR #68 scheduled facade, the production
 * `convertKmaLatitudeLongitudeToGrid` converter, and the PR #70 location facade — through the
 * statically-imported composition function above. Nothing is mocked except the network (an injected
 * in-memory `fetchImpl`) and, where a deterministic instant is needed, the clock (an injected fake
 * clock). No real service key, no external network, and no fake timers are used. Coordinate fixtures
 * (Seoul, Tokyo, the out-of-range latitude) reuse the same canonical values already established by
 * `kma-location-scheduled-hourly.test.ts` and `kma-location-scheduled-current-observation.test.ts`.
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
 * selector's pick at 06:10:00.000 KST — the shared `CLOCK_AT_0610_KST_20260718` test clock) at the
 * Seoul grid `{ nx: 60, ny: 127 }`, unless overridden.
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
  dependencies: KmaLocationScheduledCurrentObservationCompositionDependencies,
) {
  const result = createKmaLocationScheduledCurrentObservationCompositionFromEnv(env, dependencies);
  if (!result.ok) {
    throw new Error(
      `test setup: expected composition to succeed, got ${JSON.stringify(result)}`,
    );
  }
  return result.facade;
}

/**
 * `06:10:00.000 KST == 2026-07-17T21:10:00.000Z` — a post-availability-threshold instant. Under the
 * PR #79 availability-delay selector (inherited transitively from the PR #69 composition via PR #80)
 * this adjusts to `06:00:00.000` and still selects base_date 20260718 / base_time 0600.
 */
const CLOCK_AT_0610_KST_20260718 = Date.UTC(2026, 6, 17, 21, 10, 0, 0);

describe('createKmaLocationScheduledCurrentObservationCompositionFromEnv — missing/invalid config', () => {
  it('returns the provider MISSING config error for an empty environment (no throw, no I/O)', () => {
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0610_KST_20260718);

    const result = createKmaLocationScheduledCurrentObservationCompositionFromEnv(makeEnv(), {
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
    expect(JSON.stringify(result)).not.toContain('KMA_SERVICE_KEY');
  });

  it('returns INVALID for a whitespace-padded key, without leaking the raw key or reading the clock', () => {
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0610_KST_20260718);
    const rawKey = ` ${SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR71} `;

    const result = createKmaLocationScheduledCurrentObservationCompositionFromEnv(makeEnv(rawKey), {
      fetchImpl,
      clock,
    });

    expect(result).toEqual({
      ok: false,
      error: { kind: 'CONFIG_ERROR', field: 'serviceKey', reason: 'INVALID' },
    });
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR71);
  });
});

describe('createKmaLocationScheduledCurrentObservationCompositionFromEnv — success construction is lazy', () => {
  it('builds a facade exposing only { ok, facade } and runs no converter/clock/network', () => {
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0610_KST_20260718);
    const env = makeEnv(FAKE_KMA_SERVICE_KEY);
    const dependencies: KmaLocationScheduledCurrentObservationCompositionDependencies = {
      fetchImpl,
      clock,
    };
    const envSnapshot = JSON.stringify(env);
    const dependenciesSnapshot = { ...dependencies };

    const result = createKmaLocationScheduledCurrentObservationCompositionFromEnv(
      env,
      dependencies,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected success');
    }
    expectExactKeys(result, ['ok', 'facade']);
    expect(typeof result.facade.fetchScheduledCurrentWeatherForLocation).toBe('function');

    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);

    for (const forbidden of [
      'scheduledFacade',
      'converter',
      'provider',
      'requestFactory',
      'currentObservationService',
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
    const dependencies =
      Object.freeze<KmaLocationScheduledCurrentObservationCompositionDependencies>({
        fetchImpl,
        clock,
      });

    const result = createKmaLocationScheduledCurrentObservationCompositionFromEnv(
      env,
      dependencies,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.facade.fetchScheduledCurrentWeatherForLocation).toBe('function');
    }
  });

  it('uses the default system clock lazily when none is injected', () => {
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(CLOCK_AT_0610_KST_20260718);
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();

    const result = createKmaLocationScheduledCurrentObservationCompositionFromEnv(
      makeEnv(FAKE_KMA_SERVICE_KEY),
      { fetchImpl },
    );

    expect(result.ok).toBe(true);
    expect(dateNowSpy).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    dateNowSpy.mockRestore();
  });
});

describe('createKmaLocationScheduledCurrentObservationCompositionFromEnv — full Seoul pipeline', () => {
  it('assembles the real components (production converter → grid → scheduled facade) and normalizes one CurrentWeather', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      jsonOk(successBody(fullCurrentSlotItems())),
    );
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0610_KST_20260718);
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    // Construction touched neither the clock nor the network.
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);

    const result = await facade.fetchScheduledCurrentWeatherForLocation({
      latitude: SEOUL_LATITUDE,
      longitude: SEOUL_LONGITUDE,
    });

    // Exactly one clock read (to build the request) and one fetch.
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);

    // The URL the provider built from the selector's issue time and the production converter's grid.
    const requestedUrl = fetchCalls[0].url;
    expect(requestedUrl).toBeInstanceOf(URL);
    const url = requestedUrl as URL;
    expect(url.pathname.endsWith('/getUltraSrtNcst')).toBe(true);
    expect(url.searchParams.get('base_date')).toBe('20260718');
    expect(url.searchParams.get('base_time')).toBe('0600');
    // The Seoul lat/lon projected to nx=60, ny=127.
    expect(url.searchParams.get('nx')).toBe('60');
    expect(url.searchParams.get('ny')).toBe('127');
    expect(url.searchParams.get('pageNo')).toBe('1');
    expect(url.searchParams.get('numOfRows')).toBe('1000');
    expect(url.searchParams.get('dataType')).toBe('JSON');
    expect(url.searchParams.get('ServiceKey')).toBe(FAKE_KMA_SERVICE_KEY);

    expect(fetchCalls[0].init?.method).toBe('GET');
    expect(fetchCalls[0].init?.headers).toEqual({ Accept: 'application/json' });

    // The normalized result.
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

    // No raw coordinate / grid / KMA body / URL / key leaks into the facade result.
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      FAKE_KMA_SERVICE_KEY,
      'apis.data.go.kr',
      'ServiceKey',
      'obsrValue',
      'NORMAL_SERVICE',
      'latitude',
      'longitude',
      String(SEOUL_LATITUDE),
      String(SEOUL_LONGITUDE),
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('createKmaLocationScheduledCurrentObservationCompositionFromEnv — unsupported location', () => {
  it('returns a LOCATION/UNSUPPORTED_LOCATION result for Tokyo, with no clock read and no fetch', async () => {
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0610_KST_20260718);
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const result = await facade.fetchScheduledCurrentWeatherForLocation({
      latitude: TOKYO_LATITUDE,
      longitude: TOKYO_LONGITUDE,
    });

    expect(result).toEqual({
      ok: false,
      stage: 'LOCATION',
      error: { kind: 'UNSUPPORTED_LOCATION' },
    });
    // The provider was never reached: no clock read, no fetch.
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    // No raw coordinate leaks into the result, and the stage is not misreported.
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      'latitude',
      'longitude',
      String(TOKYO_LATITUDE),
      String(TOKYO_LONGITUDE),
      'PROVIDER',
      'NORMALIZATION',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('createKmaLocationScheduledCurrentObservationCompositionFromEnv — invalid coordinate', () => {
  it('lets the production converter RangeError propagate synchronously, without a clock read, fetch, or LOCATION result', () => {
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0610_KST_20260718);
    const consoleSpy = spyOnConsole();
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    let caught: unknown;
    let returned: unknown;
    try {
      returned = facade.fetchScheduledCurrentWeatherForLocation({
        latitude: 999,
        longitude: SEOUL_LONGITUDE,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RangeError);
    expect((caught as RangeError).message).toBe('latitude must be within [-90, 90]');
    // The throw happened synchronously — no Promise was returned.
    expect(returned).toBeUndefined();
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    // The out-of-range raw coordinate never appears in the error message.
    expect((caught as RangeError).message).not.toContain('999');
    consoleSpy.expectSilent();
    consoleSpy.restore();
  });
});

describe('createKmaLocationScheduledCurrentObservationCompositionFromEnv — downstream pass-through', () => {
  it('surfaces an HTTP 503 as a PROVIDER-stage HTTP_ERROR (not re-classified as LOCATION)', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(
      () => new Response('secret upstream error page', { status: 503 }),
    );
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0610_KST_20260718);
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const result = await facade.fetchScheduledCurrentWeatherForLocation({
      latitude: SEOUL_LATITUDE,
      longitude: SEOUL_LONGITUDE,
    });

    expect(result).toEqual({
      ok: false,
      stage: 'PROVIDER',
      error: { kind: 'HTTP_ERROR', status: 503 },
    });
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);

    const serialized = JSON.stringify(result);
    for (const forbidden of [
      FAKE_KMA_SERVICE_KEY,
      'apis.data.go.kr',
      'ServiceKey',
      'latitude',
      'longitude',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('surfaces a missing required T1H category as a NORMALIZATION-stage issue (not re-classified as LOCATION), runs silently under a 5-channel console guard, exposes exactly { ok, stage, issues }, and leaks no grid coordinate', async () => {
    const items = [item({ category: 'PTY', obsrValue: '0' })];
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() => jsonOk(successBody(items)));
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0610_KST_20260718);
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });
    // Installed before the call and asserted/restored only after every normalization assertion below,
    // so a regression such as `console.error(rawKmaPayload)` on the normalization-failure path is caught.
    const consoleSpy = spyOnConsole();

    try {
      const result = await facade.fetchScheduledCurrentWeatherForLocation({
        latitude: SEOUL_LATITUDE,
        longitude: SEOUL_LONGITUDE,
      });

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error('expected a normalization failure');
      }
      expect(result.stage).toBe('NORMALIZATION');
      if (result.stage !== 'NORMALIZATION') {
        throw new Error(`expected NORMALIZATION stage, got ${result.stage}`);
      }
      expect(result.issues).toContainEqual({ field: 'temperatureCelsius', reason: 'ABSENT' });
      expectExactKeys(result, ['ok', 'stage', 'issues']);
      expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
      expect(fetchCalls).toHaveLength(1);

      expect('current' in result).toBe(false);
      const serialized = JSON.stringify(result);
      for (const forbidden of [
        FAKE_KMA_SERVICE_KEY,
        'apis.data.go.kr',
        'ServiceKey',
        'obsrValue',
        'latitude',
        'longitude',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
      // The grid coordinate the location facade computed internally must never leak into the
      // outward-facing normalization failure, even though it is present in the raw KMA response.
      expect(serialized).not.toContain('"nx"');
      expect(serialized).not.toContain('"ny"');

      consoleSpy.expectSilent();
    } finally {
      consoleSpy.restore();
    }
  });
});

describe('createKmaLocationScheduledCurrentObservationCompositionFromEnv — repeated independent calls', () => {
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

    const first = await facade.fetchScheduledCurrentWeatherForLocation({
      latitude: SEOUL_LATITUDE,
      longitude: SEOUL_LONGITUDE,
    });
    const second = await facade.fetchScheduledCurrentWeatherForLocation({
      latitude: SEOUL_LATITUDE,
      longitude: SEOUL_LONGITUDE,
    });

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

    const resultA = await facadeA.fetchScheduledCurrentWeatherForLocation({
      latitude: SEOUL_LATITUDE,
      longitude: SEOUL_LONGITUDE,
    });
    const resultB = await facadeB.fetchScheduledCurrentWeatherForLocation({
      latitude: SEOUL_LATITUDE,
      longitude: SEOUL_LONGITUDE,
    });

    expect(resultA).not.toBe(resultB);
    expect(resultA).toEqual(resultB);
    expect(runA.calls).toHaveLength(1);
    expect(runB.calls).toHaveLength(1);
  });

  it('does not mix state between a supported call and a following unsupported call', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      jsonOk(successBody(fullCurrentSlotItems())),
    );
    const { clock, nowEpochMilliseconds } = fixedClock(CLOCK_AT_0610_KST_20260718);
    const facade = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const supported = await facade.fetchScheduledCurrentWeatherForLocation({
      latitude: SEOUL_LATITUDE,
      longitude: SEOUL_LONGITUDE,
    });
    const unsupported = await facade.fetchScheduledCurrentWeatherForLocation({
      latitude: TOKYO_LATITUDE,
      longitude: TOKYO_LONGITUDE,
    });

    expect(supported.ok).toBe(true);
    expect(unsupported).toEqual({
      ok: false,
      stage: 'LOCATION',
      error: { kind: 'UNSUPPORTED_LOCATION' },
    });
    // Only the supported call read the clock and hit the network.
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);
  });
});

describe('createKmaLocationScheduledCurrentObservationCompositionFromEnv — no secret leakage, no logging', () => {
  it('never surfaces the service key or raw coordinate across success/unsupported/failure results, and logs nothing', async () => {
    const consoleSpy = spyOnConsole();

    // 1) Success pipeline with a secret-shaped key.
    const success = recordingFetch(() => jsonOk(successBody(fullCurrentSlotItems())));
    const successFacade = composeOrThrow(makeEnv(SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR71), {
      fetchImpl: success.fetchImpl,
      clock: fixedClock(CLOCK_AT_0610_KST_20260718).clock,
    });
    const successResult = await successFacade.fetchScheduledCurrentWeatherForLocation({
      latitude: SEOUL_LATITUDE,
      longitude: SEOUL_LONGITUDE,
    });
    expect(successResult.ok).toBe(true);
    expect(JSON.stringify(successResult)).not.toContain(SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR71);

    // 2) Unsupported location — the raw coordinate must not leak.
    const unsupportedFacade = composeOrThrow(makeEnv(SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR71), {
      fetchImpl: neverCalledFetch().fetchImpl,
      clock: fixedClock(CLOCK_AT_0610_KST_20260718).clock,
    });
    const unsupportedResult = await unsupportedFacade.fetchScheduledCurrentWeatherForLocation({
      latitude: TOKYO_LATITUDE,
      longitude: TOKYO_LONGITUDE,
    });
    expect(unsupportedResult.ok).toBe(false);
    expect(JSON.stringify(unsupportedResult)).not.toContain(String(TOKYO_LATITUDE));
    expect(JSON.stringify(unsupportedResult)).not.toContain(String(TOKYO_LONGITUDE));

    // 3) Provider failure with the same secret-shaped key.
    const providerFail = recordingFetch(() => new Response('x', { status: 503 }));
    const providerFailFacade = composeOrThrow(makeEnv(SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR71), {
      fetchImpl: providerFail.fetchImpl,
      clock: fixedClock(CLOCK_AT_0610_KST_20260718).clock,
    });
    const providerFailResult = await providerFailFacade.fetchScheduledCurrentWeatherForLocation({
      latitude: SEOUL_LATITUDE,
      longitude: SEOUL_LONGITUDE,
    });
    expect(providerFailResult.ok).toBe(false);
    expect(JSON.stringify(providerFailResult)).not.toContain(
      SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR71,
    );

    // 4) Config failure — no facade even built.
    const configResult = createKmaLocationScheduledCurrentObservationCompositionFromEnv(
      makeEnv(` ${SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR71} `),
      { fetchImpl: neverCalledFetch().fetchImpl },
    );
    expect(configResult.ok).toBe(false);
    expect(JSON.stringify(configResult)).not.toContain(SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR71);

    // The composition and its collaborators never log.
    consoleSpy.expectSilent();
    consoleSpy.restore();
  });
});
