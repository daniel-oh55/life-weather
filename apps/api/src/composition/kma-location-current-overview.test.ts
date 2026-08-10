import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  weatherLocation,
  weatherOverview,
  type WeatherLocation,
} from '@life-weather/contracts';

import type { KmaCurrentObservationRequestClock } from '../services/index.js';
import {
  createKmaLocationCurrentOverviewCompositionFromEnv,
  type KmaLocationCurrentOverviewCompositionDependencies,
} from './kma-location-current-overview.js';

/**
 * Layer A (below) isolates this composition's **wiring** — which collaborator it calls, in what
 * order, with which exact references — by mocking the three modules it imports directly
 * (`../services/index.js`, `./kma-location-scheduled-current-observation.js`, `./system-clock.js`),
 * via `vi.doMock` + `vi.resetModules()` + a dynamic `import()` — the same pattern
 * `kma-location-scheduled-current-observation.test.ts`'s isolated wiring tests already use. Layer B
 * (further below) assembles the **real** components through the statically-imported composition
 * function above and mocks nothing except the network (an injected in-memory `fetchImpl`) and, where
 * needed, the clock (an injected fake clock) — so together the two layers prove both the wiring
 * contract and the actual pipeline behaviour.
 */

/** An obviously fake, decoded-shaped service key. Never a real/production key. */
const FAKE_KMA_SERVICE_KEY = 'test-only-decoded-location-current-overview-key+slash==';

/** A secret-shaped key marker used only to prove the key never leaks into a result, error, or log. */
const SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR75 =
  'SECRET_SHAPED_KMA_LOCATION_CURRENT_OVERVIEW_KEY_MUST_NOT_LEAK_PR75+slash==';

/** Seoul: latitude/longitude the production converter maps onto the KMA grid { nx: 60, ny: 127 }. */
const SEOUL_LATITUDE = 37.5665;
const SEOUL_LONGITUDE = 126.978;

/** Tokyo: a physically valid coordinate outside the KMA forecast grid → converter returns null. */
const TOKYO_LATITUDE = 35.6762;
const TOKYO_LONGITUDE = 139.6503;

/** The fixed, canonical app-internal `sourceId` for the KMA 초단기실황 (`getUltraSrtNcst`) endpoint. */
const CURRENT_SOURCE_ID = 'kma-ultra-short-current-observation';

/** A fresh environment object per call, so no test shares a mutable env reference. */
function makeEnv(serviceKey?: string): NodeJS.ProcessEnv {
  return serviceKey === undefined
    ? ({} as NodeJS.ProcessEnv)
    : ({ KMA_SERVICE_KEY: serviceKey } as NodeJS.ProcessEnv);
}

/** A fresh, complete, schema-valid `WeatherLocation` at Seoul; overridable per field for edge cases. */
function makeLocation(overrides: Partial<WeatherLocation> = {}): WeatherLocation {
  return {
    id: 'loc_seoul_jung',
    displayName: '서울특별시 중구',
    countryCode: 'KR',
    adminArea1: '서울특별시',
    adminArea2: '중구',
    adminArea3: null,
    latitude: SEOUL_LATITUDE,
    longitude: SEOUL_LONGITUDE,
    timezone: 'Asia/Seoul',
    ...overrides,
  };
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
  readonly services?: Record<string, unknown>;
  readonly locationComposition?: Record<string, unknown>;
  readonly systemClock?: Record<string, unknown>;
}

/**
 * Reset the module registry, install the requested partial mocks (spread over the real module so
 * unmocked exports stay real), and dynamically re-import the composition module. Every isolated test
 * gets a fresh module instance — no cross-test mock leakage.
 */
async function loadIsolatedComposition(
  mocks: IsolatedMocks,
): Promise<typeof import('./kma-location-current-overview.js')> {
  vi.resetModules();
  if (mocks.services) {
    vi.doMock('../services/index.js', async () => {
      const actual = await vi.importActual<typeof import('../services/index.js')>(
        '../services/index.js',
      );
      return { ...actual, ...mocks.services };
    });
  }
  if (mocks.locationComposition) {
    vi.doMock('./kma-location-scheduled-current-observation.js', async () => {
      const actual = await vi.importActual<
        typeof import('./kma-location-scheduled-current-observation.js')
      >('./kma-location-scheduled-current-observation.js');
      return { ...actual, ...mocks.locationComposition };
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
  return import('./kma-location-current-overview.js');
}

describe('createKmaLocationCurrentOverviewCompositionFromEnv — isolated wiring', () => {
  afterEach(() => {
    vi.doUnmock('../services/index.js');
    vi.doUnmock('./kma-location-scheduled-current-observation.js');
    vi.doUnmock('./system-clock.js');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('performs no location-composition/resolver/service/clock call and no direct env/time/logging/timer/listener/network side effect merely by importing the module', async () => {
    const locationCompositionFactory = vi.fn();
    const resolverFactory = vi.fn();
    const serviceFactory = vi.fn();
    const systemClockFactory = vi.fn();

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
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error(
        'isolated wiring test: global fetch must not be called merely by importing the module',
      );
    });

    try {
      if (originalEnvDescriptor) {
        Object.defineProperty(process, 'env', {
          ...originalEnvDescriptor,
          value: proxiedEnv,
        });
      }

      await loadIsolatedComposition({
        services: {
          createKmaLiveCurrentSourceMetadataResolver: resolverFactory,
          createKmaLocationCurrentOverviewService: serviceFactory,
        },
        locationComposition: {
          createKmaLocationScheduledCurrentObservationCompositionFromEnv:
            locationCompositionFactory,
        },
        systemClock: {
          createKmaSystemClock: systemClockFactory,
        },
      });

      expect(locationCompositionFactory).not.toHaveBeenCalled();
      expect(resolverFactory).not.toHaveBeenCalled();
      expect(serviceFactory).not.toHaveBeenCalled();
      expect(systemClockFactory).not.toHaveBeenCalled();
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
    it('returns the location composition config error by exact reference and builds nothing downstream', async () => {
      const sentinelError = Object.freeze({
        kind: 'CONFIG_ERROR',
        field: 'serviceKey',
        reason: 'MISSING',
      } as const);
      const locationCompositionFactory = vi.fn((..._args: unknown[]) => ({
        ok: false as const,
        error: sentinelError,
      }));
      const resolverFactory = neverCalled('resolver factory');
      const serviceFactory = neverCalled('service factory');
      const systemClockFactory = neverCalled('system clock factory');
      const consoleSpy = spyOnConsole();

      const { createKmaLocationCurrentOverviewCompositionFromEnv: composeIsolated } =
        await loadIsolatedComposition({
          services: {
            createKmaLiveCurrentSourceMetadataResolver: resolverFactory,
            createKmaLocationCurrentOverviewService: serviceFactory,
          },
          locationComposition: {
            createKmaLocationScheduledCurrentObservationCompositionFromEnv:
              locationCompositionFactory,
          },
          systemClock: { createKmaSystemClock: systemClockFactory },
        });

      const env = Object.freeze({}) as NodeJS.ProcessEnv;
      const dependencies =
        Object.freeze<KmaLocationCurrentOverviewCompositionDependencies>({});
      const result = composeIsolated(env, dependencies);

      expect(locationCompositionFactory).toHaveBeenCalledTimes(1);
      expect(locationCompositionFactory.mock.calls[0]?.[0]).toBe(env);
      expect(locationCompositionFactory.mock.calls[0]?.[1]).toBe(dependencies);

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error('expected a config failure');
      }
      expect(result.error).toBe(sentinelError);
      expectExactKeys(result, ['ok', 'error']);

      expect(resolverFactory).not.toHaveBeenCalled();
      expect(serviceFactory).not.toHaveBeenCalled();
      expect(systemClockFactory).not.toHaveBeenCalled();

      consoleSpy.expectSilent();
      consoleSpy.restore();
    });
  });

  describe('success wiring — injected clock', () => {
    it('shares the injected clock reference with the resolver, never builds a system clock, and wires exact facade/resolver references into the service', async () => {
      const facadeSentinel = Object.freeze({ marker: 'LOCATION_FACADE_SENTINEL' });
      const locationCompositionFactory = vi.fn((..._args: unknown[]) => ({
        ok: true as const,
        facade: facadeSentinel,
      }));
      const resolverSentinel = Object.freeze({ marker: 'RESOLVER_SENTINEL' });
      const resolverFactory = vi.fn((..._args: unknown[]) => resolverSentinel);
      const serviceSentinel = Object.freeze({ marker: 'SERVICE_SENTINEL' });
      const serviceFactory = vi.fn((..._args: unknown[]) => serviceSentinel);
      const systemClockFactory = neverCalled('system clock factory');

      const { createKmaLocationCurrentOverviewCompositionFromEnv: composeIsolated } =
        await loadIsolatedComposition({
          services: {
            createKmaLiveCurrentSourceMetadataResolver: resolverFactory,
            createKmaLocationCurrentOverviewService: serviceFactory,
          },
          locationComposition: {
            createKmaLocationScheduledCurrentObservationCompositionFromEnv:
              locationCompositionFactory,
          },
          systemClock: { createKmaSystemClock: systemClockFactory },
        });

      const injectedClock: KmaCurrentObservationRequestClock = {
        nowEpochMilliseconds: vi.fn(),
      };
      const env = Object.freeze(makeEnv(FAKE_KMA_SERVICE_KEY));
      const dependencies =
        Object.freeze<KmaLocationCurrentOverviewCompositionDependencies>({
          clock: injectedClock,
        });

      const result = composeIsolated(env, dependencies);

      // The existing composition gets the exact env/dependencies references.
      expect(locationCompositionFactory).toHaveBeenCalledTimes(1);
      expect(locationCompositionFactory.mock.calls[0]?.[0]).toBe(env);
      expect(locationCompositionFactory.mock.calls[0]?.[1]).toBe(dependencies);

      // No system clock is built when a clock is injected.
      expect(systemClockFactory).not.toHaveBeenCalled();

      // The resolver factory receives the exact injected clock reference.
      expect(resolverFactory).toHaveBeenCalledTimes(1);
      expect(resolverFactory.mock.calls[0]?.[0]).toBe(injectedClock);

      // The service factory receives the exact facade + resolver references.
      expect(serviceFactory).toHaveBeenCalledTimes(1);
      expect(serviceFactory.mock.calls[0]?.[0]).toBe(facadeSentinel);
      expect(serviceFactory.mock.calls[0]?.[1]).toBe(resolverSentinel);

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error('expected success');
      }
      expect(result.service).toBe(serviceSentinel);
      expectExactKeys(result, ['ok', 'service']);

      for (const forbidden of [
        'facade',
        'resolver',
        'clock',
        'provider',
        'requestFactory',
        'currentObservationService',
        'converter',
        'assembler',
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
  });

  describe('success wiring — default clock', () => {
    it('forwards the original dependencies reference unchanged, builds exactly one system clock for the resolver role, and wires it through', async () => {
      const facadeSentinel = Object.freeze({ marker: 'LOCATION_FACADE_SENTINEL_DEFAULT' });
      const locationCompositionFactory = vi.fn((..._args: unknown[]) => ({
        ok: true as const,
        facade: facadeSentinel,
      }));
      const resolverSentinel = Object.freeze({ marker: 'RESOLVER_SENTINEL_DEFAULT' });
      const resolverFactory = vi.fn((..._args: unknown[]) => resolverSentinel);
      const serviceSentinel = Object.freeze({ marker: 'SERVICE_SENTINEL_DEFAULT' });
      const serviceFactory = vi.fn((..._args: unknown[]) => serviceSentinel);
      const systemClockSentinel = Object.freeze({
        marker: 'SYSTEM_CLOCK_SENTINEL',
        nowEpochMilliseconds: vi.fn(),
      });
      const systemClockFactory = vi.fn(() => systemClockSentinel);

      const { createKmaLocationCurrentOverviewCompositionFromEnv: composeIsolated } =
        await loadIsolatedComposition({
          services: {
            createKmaLiveCurrentSourceMetadataResolver: resolverFactory,
            createKmaLocationCurrentOverviewService: serviceFactory,
          },
          locationComposition: {
            createKmaLocationScheduledCurrentObservationCompositionFromEnv:
              locationCompositionFactory,
          },
          systemClock: { createKmaSystemClock: systemClockFactory },
        });

      const env = makeEnv(FAKE_KMA_SERVICE_KEY);
      const dependencies: KmaLocationCurrentOverviewCompositionDependencies = {};

      const result = composeIsolated(env, dependencies);

      expect(locationCompositionFactory).toHaveBeenCalledTimes(1);
      expect(locationCompositionFactory.mock.calls[0]?.[1]).toBe(dependencies);

      // Exactly one fresh system clock is built for the resolver's own role.
      expect(systemClockFactory).toHaveBeenCalledTimes(1);
      expect(resolverFactory).toHaveBeenCalledTimes(1);
      expect(resolverFactory.mock.calls[0]?.[0]).toBe(systemClockSentinel);

      expect(serviceFactory).toHaveBeenCalledTimes(1);
      expect(serviceFactory.mock.calls[0]?.[0]).toBe(facadeSentinel);
      expect(serviceFactory.mock.calls[0]?.[1]).toBe(resolverSentinel);

      // The system clock adapter itself was never read at construction.
      expect(systemClockSentinel.nowEpochMilliseconds).not.toHaveBeenCalled();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.service).toBe(serviceSentinel);
      }
    });
  });

  describe('fresh composition', () => {
    it('builds independent resolver/service graphs on each call with no shared cache', async () => {
      let compositionCallIndex = 0;
      const locationCompositionFactory = vi.fn((..._args: unknown[]) => {
        compositionCallIndex += 1;
        return { ok: true as const, facade: { marker: `FACADE_${compositionCallIndex}` } };
      });
      let resolverCallIndex = 0;
      const resolverFactory = vi.fn((..._args: unknown[]) => {
        resolverCallIndex += 1;
        return { marker: `RESOLVER_${resolverCallIndex}` };
      });
      let serviceCallIndex = 0;
      const serviceFactory = vi.fn((..._args: unknown[]) => {
        serviceCallIndex += 1;
        return { marker: `SERVICE_${serviceCallIndex}` };
      });
      const systemClockFactory = vi.fn(() => ({ nowEpochMilliseconds: vi.fn() }));

      const { createKmaLocationCurrentOverviewCompositionFromEnv: composeIsolated } =
        await loadIsolatedComposition({
          services: {
            createKmaLiveCurrentSourceMetadataResolver: resolverFactory,
            createKmaLocationCurrentOverviewService: serviceFactory,
          },
          locationComposition: {
            createKmaLocationScheduledCurrentObservationCompositionFromEnv:
              locationCompositionFactory,
          },
          systemClock: { createKmaSystemClock: systemClockFactory },
        });

      const env = makeEnv(FAKE_KMA_SERVICE_KEY);
      const first = composeIsolated(env, {});
      const second = composeIsolated(env, {});

      expect(first).not.toBe(second);
      if (!first.ok || !second.ok) {
        throw new Error('expected both compositions to succeed');
      }
      expect(first.service).not.toBe(second.service);
      expect(locationCompositionFactory).toHaveBeenCalledTimes(2);
      expect(resolverFactory).toHaveBeenCalledTimes(2);
      expect(serviceFactory).toHaveBeenCalledTimes(2);
      expect(systemClockFactory).toHaveBeenCalledTimes(2);
    });
  });

  describe('unexpected collaborator factory throws', () => {
    it('propagates the exact thrown reference from the resolver factory, calls nothing downstream, and logs nothing', async () => {
      const facadeSentinel = Object.freeze({ marker: 'THROW_FACADE' });
      const locationCompositionFactory = vi.fn((..._args: unknown[]) => ({
        ok: true as const,
        facade: facadeSentinel,
      }));
      const sentinel = new Error('KMA_LOCATION_CURRENT_OVERVIEW_RESOLVER_FACTORY_SENTINEL');
      const resolverFactory = vi.fn(() => {
        throw sentinel;
      });
      const serviceFactory = neverCalled('service factory');
      const systemClockFactory = neverCalled('system clock factory');
      const consoleSpy = spyOnConsole();

      const { createKmaLocationCurrentOverviewCompositionFromEnv: composeIsolated } =
        await loadIsolatedComposition({
          services: {
            createKmaLiveCurrentSourceMetadataResolver: resolverFactory,
            createKmaLocationCurrentOverviewService: serviceFactory,
          },
          locationComposition: {
            createKmaLocationScheduledCurrentObservationCompositionFromEnv:
              locationCompositionFactory,
          },
          systemClock: { createKmaSystemClock: systemClockFactory },
        });

      const injectedClock: KmaCurrentObservationRequestClock = {
        nowEpochMilliseconds: vi.fn(),
      };
      const thrown = captureThrown(() =>
        composeIsolated(makeEnv(FAKE_KMA_SERVICE_KEY), { clock: injectedClock }),
      );

      expect(thrown).toBe(sentinel);
      expect(locationCompositionFactory).toHaveBeenCalledTimes(1);
      expect(resolverFactory).toHaveBeenCalledTimes(1);
      expect(serviceFactory).not.toHaveBeenCalled();
      consoleSpy.expectSilent();
      consoleSpy.restore();
    });

    it('propagates the exact thrown reference from the service factory, after the resolver already ran', async () => {
      const facadeSentinel = Object.freeze({ marker: 'THROW_FACADE_SERVICE' });
      const locationCompositionFactory = vi.fn((..._args: unknown[]) => ({
        ok: true as const,
        facade: facadeSentinel,
      }));
      const resolverSentinel = Object.freeze({ marker: 'RESOLVER_BEFORE_SERVICE_THROW' });
      const resolverFactory = vi.fn((..._args: unknown[]) => resolverSentinel);
      const sentinel = new Error('KMA_LOCATION_CURRENT_OVERVIEW_SERVICE_FACTORY_SENTINEL');
      const serviceFactory = vi.fn(() => {
        throw sentinel;
      });
      const consoleSpy = spyOnConsole();

      const { createKmaLocationCurrentOverviewCompositionFromEnv: composeIsolated } =
        await loadIsolatedComposition({
          services: {
            createKmaLiveCurrentSourceMetadataResolver: resolverFactory,
            createKmaLocationCurrentOverviewService: serviceFactory,
          },
          locationComposition: {
            createKmaLocationScheduledCurrentObservationCompositionFromEnv:
              locationCompositionFactory,
          },
        });

      const injectedClock: KmaCurrentObservationRequestClock = {
        nowEpochMilliseconds: vi.fn(),
      };
      const thrown = captureThrown(() =>
        composeIsolated(makeEnv(FAKE_KMA_SERVICE_KEY), { clock: injectedClock }),
      );

      expect(thrown).toBe(sentinel);
      expect(resolverFactory).toHaveBeenCalledTimes(1);
      expect(serviceFactory).toHaveBeenCalledTimes(1);
      consoleSpy.expectSilent();
      consoleSpy.restore();
    });
  });
});

// ---------------------------------------------------------------------------
// Layer B: real full-pipeline tests
// ---------------------------------------------------------------------------

/**
 * These tests assemble the **real** components — the PR #71 location scheduled current-observation
 * composition (provider-from-env, PR #67 current-observation service, PR #66 request factory with the
 * PR #64 schedule-only selector, PR #63 normalizer, PR #68 scheduled facade, production
 * `convertKmaLatitudeLongitudeToGrid` converter, PR #70 location facade), the PR #73 live current
 * source metadata resolver, and the PR #74 location current-overview application service — through
 * the statically-imported composition function above. Nothing is mocked except the network (an
 * injected in-memory `fetchImpl`) and, where a deterministic instant is needed, the clock (an
 * injected fake clock). No real service key, no external network, and no fake timers are used.
 * Coordinate fixtures reuse the same canonical values already established by
 * `kma-location-scheduled-current-observation.test.ts`.
 */

/**
 * A fresh fake clock that returns `values[i]` on its i-th call (the last value repeats for any extra
 * call). Used to give the request read and the metadata-resolver read distinct instants.
 */
function scriptedClock(values: readonly number[]) {
  const nowEpochMilliseconds = vi.fn((): number => {
    const callIndex = nowEpochMilliseconds.mock.calls.length - 1;
    return values[Math.min(callIndex, values.length - 1)];
  });
  const clock: KmaCurrentObservationRequestClock = { nowEpochMilliseconds };
  return { clock, nowEpochMilliseconds };
}

/**
 * A fresh fake clock that returns `firstValue` on its first call and throws `error` on every later
 * call — models a clock that works for the request but fails at metadata materialization.
 */
function throwingSecondClock(firstValue: number, error: unknown) {
  const nowEpochMilliseconds = vi.fn((): number => {
    const callIndex = nowEpochMilliseconds.mock.calls.length - 1;
    if (callIndex === 0) {
      return firstValue;
    }
    throw error;
  });
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
 * A raw current-observation item matching the 20260718/0600 issuance (the schedule-only selector's
 * pick at 06:00:00.000 KST) at the Seoul grid `{ nx: 60, ny: 127 }`, unless overridden.
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

/** A success envelope missing the required `T1H` category → NORMALIZATION failure. */
function missingRequiredCategoryItems(): RawItem[] {
  return [item({ category: 'PTY', obsrValue: '0' })];
}

function jsonOk(bodyString: string): Response {
  return new Response(bodyString, { status: 200 });
}

/** Compose successfully or fail the test — collapses the result-union narrowing in setup. */
function composeOrThrow(
  env: NodeJS.ProcessEnv,
  dependencies: KmaLocationCurrentOverviewCompositionDependencies,
) {
  const result = createKmaLocationCurrentOverviewCompositionFromEnv(env, dependencies);
  if (!result.ok) {
    throw new Error(
      `test setup: expected composition to succeed, got ${JSON.stringify(result)}`,
    );
  }
  return result.service;
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

/** Recursively freeze so any attempted mutation would throw in strict mode. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Secret / raw-transport values that must never appear in a serialized composition/service result or
 * on the console. The overview legitimately echoes the caller's `location` (with its coordinates), so
 * raw latitude/longitude are **not** listed here — only the transport secrets and raw KMA body.
 */
const FORBIDDEN_LEAKAGE_STRINGS = [
  FAKE_KMA_SERVICE_KEY,
  SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR75,
  'apis.data.go.kr',
  'ServiceKey',
  'obsrValue',
  'NORMAL_SERVICE',
];

function expectNoLeakage(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const forbidden of FORBIDDEN_LEAKAGE_STRINGS) {
    expect(serialized).not.toContain(forbidden);
  }
}

/** `06:00:00.000 KST == 2026-07-17T21:00:00.000Z`; selects base_date 20260718 / base_time 0600. */
const CLOCK_AT_0600_KST_20260718 = Date.UTC(2026, 6, 17, 21, 0, 0, 0);

/**
 * `06:05:22.333 KST == 2026-07-17T21:05:22.333Z` — a **distinct, later** instant used as the
 * **second** clock read (the metadata resolver's `fetchedAt` materialization). Keeping it distinct
 * from the request instant proves `fetchedAt` comes from this second reading, not the first.
 */
const FETCHED_AT_EPOCH_MS = Date.UTC(2026, 6, 17, 21, 5, 22, 333);

/** The UTC `Z` millisecond ISO string the resolver derives from {@link FETCHED_AT_EPOCH_MS}. */
const FETCHED_AT_ISO = '2026-07-17T21:05:22.333Z';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fixture sanity', () => {
  it('builds a contracts-valid WeatherLocation fixture', () => {
    expect(weatherLocation.safeParse(makeLocation()).success).toBe(true);
  });

  it('ties the fetchedAt epoch to its ISO string', () => {
    expect(new Date(FETCHED_AT_EPOCH_MS).toISOString()).toBe(FETCHED_AT_ISO);
  });
});

describe('createKmaLocationCurrentOverviewCompositionFromEnv — missing/invalid config', () => {
  it('returns the provider MISSING config error for an empty environment (no clock read, no fetch)', () => {
    const consoleSpy = spyOnConsole();
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = scriptedClock([
      CLOCK_AT_0600_KST_20260718,
      FETCHED_AT_EPOCH_MS,
    ]);

    const result = createKmaLocationCurrentOverviewCompositionFromEnv(makeEnv(), {
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
    expect('service' in result).toBe(false);
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('KMA_SERVICE_KEY');
    consoleSpy.expectSilent();
    consoleSpy.restore();
  });

  it('returns INVALID for a whitespace-padded key, without leaking the raw key, and logs nothing', () => {
    const consoleSpy = spyOnConsole();
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = scriptedClock([
      CLOCK_AT_0600_KST_20260718,
      FETCHED_AT_EPOCH_MS,
    ]);
    const rawKey = ` ${SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR75} `;

    const result = createKmaLocationCurrentOverviewCompositionFromEnv(makeEnv(rawKey), {
      fetchImpl,
      clock,
    });

    expect(result).toEqual({
      ok: false,
      error: { kind: 'CONFIG_ERROR', field: 'serviceKey', reason: 'INVALID' },
    });
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR75);
    consoleSpy.expectSilent();
    consoleSpy.restore();
  });

  it('works with a frozen environment and frozen dependencies on config failure', () => {
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = scriptedClock([
      CLOCK_AT_0600_KST_20260718,
      FETCHED_AT_EPOCH_MS,
    ]);
    const env = Object.freeze(makeEnv());
    const dependencies =
      Object.freeze<KmaLocationCurrentOverviewCompositionDependencies>({
        fetchImpl,
        clock,
      });

    const result = createKmaLocationCurrentOverviewCompositionFromEnv(env, dependencies);

    expect(result).toEqual({
      ok: false,
      error: { kind: 'CONFIG_ERROR', field: 'serviceKey', reason: 'MISSING' },
    });
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('createKmaLocationCurrentOverviewCompositionFromEnv — success construction is lazy', () => {
  it('builds a service exposing only { ok, service } and reads no clock / network at construction', () => {
    const consoleSpy = spyOnConsole();
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = scriptedClock([
      CLOCK_AT_0600_KST_20260718,
      FETCHED_AT_EPOCH_MS,
    ]);
    const env = makeEnv(FAKE_KMA_SERVICE_KEY);
    const dependencies: KmaLocationCurrentOverviewCompositionDependencies = {
      fetchImpl,
      clock,
    };
    const envSnapshot = JSON.stringify(env);
    const dependenciesSnapshot = { ...dependencies };

    const result = createKmaLocationCurrentOverviewCompositionFromEnv(env, dependencies);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected success');
    }
    expectExactKeys(result, ['ok', 'service']);
    expectExactKeys(result.service, ['fetchCurrentWeatherOverviewForLocation']);
    expect(typeof result.service.fetchCurrentWeatherOverviewForLocation).toBe('function');

    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);

    for (const forbidden of [
      'facade',
      'resolver',
      'assembler',
      'provider',
      'clock',
      'fetchImpl',
      'environment',
      'env',
      'config',
      'converter',
      'request',
      'dependencies',
      'serviceKey',
    ]) {
      expect(forbidden in result).toBe(false);
    }

    expect(JSON.stringify(env)).toBe(envSnapshot);
    expect(dependencies.fetchImpl).toBe(dependenciesSnapshot.fetchImpl);
    expect(dependencies.clock).toBe(dependenciesSnapshot.clock);
    consoleSpy.expectSilent();
    consoleSpy.restore();
  });

  it('uses the default system clock lazily when none is injected (no time read at construction)', () => {
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(CLOCK_AT_0600_KST_20260718);
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();

    const result = createKmaLocationCurrentOverviewCompositionFromEnv(
      makeEnv(FAKE_KMA_SERVICE_KEY),
      { fetchImpl },
    );

    expect(result.ok).toBe(true);
    expect(dateNowSpy).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    dateNowSpy.mockRestore();
  });
});

describe('createKmaLocationCurrentOverviewCompositionFromEnv — full Seoul success pipeline', () => {
  it('assembles a current-only overview, fetchedAt from the second clock read, baseTime from the first', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      jsonOk(successBody(fullCurrentSlotItems())),
    );
    const { clock, nowEpochMilliseconds } = scriptedClock([
      CLOCK_AT_0600_KST_20260718,
      FETCHED_AT_EPOCH_MS,
    ]);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    // Construction touched neither the clock nor the network.
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);

    const result = await service.fetchCurrentWeatherOverviewForLocation({
      location: makeLocation(),
    });

    // Exactly two clock reads (request + metadata) and one fetch.
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(2);
    expect(fetchCalls).toHaveLength(1);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('expected an application success');
    }
    expectExactKeys(result, ['ok', 'overview']);

    expect(weatherOverview.safeParse(result.overview).success).toBe(true);

    // Current is present, and CURRENT is absent from missingSections.
    expect(result.overview.current).not.toBeNull();
    expect(result.overview.missingSections).not.toContain('CURRENT');
    expect(result.overview.missingSections).toEqual([
      'HOURLY',
      'DAILY',
      'AIR_QUALITY_CURRENT',
      'AIR_QUALITY_FORECAST',
      'ALERTS',
    ]);
    // Current-only placeholders for the still-unimplemented sections.
    expect(result.overview.hourly).toEqual([]);
    expect(result.overview.daily).toEqual([]);
    expect(result.overview.airQuality.current).toBeNull();
    expect(result.overview.airQuality.daily).toEqual([]);
    expect(result.overview.alerts).toEqual([]);

    // Exactly one CURRENT source with the resolver's provenance.
    expect(result.overview.sources).toHaveLength(1);
    const source = result.overview.sources[0];
    expect(source.provider).toBe('KMA');
    expect(source.sections).toEqual(['CURRENT']);
    expect(source.issuedAt).toBeNull();
    expect(source.observedAt).toBe(result.overview.current?.observedAt);
    expect(source.retrievalMode).toBe('LIVE');
    expect(source.sourceId).toBe(CURRENT_SOURCE_ID);
    // fetchedAt is derived from the second clock read (a distinct, later instant).
    expect(source.fetchedAt).toBe(FETCHED_AT_ISO);

    // The request URL is dated to the first clock read's issuance (06:00 KST) and the real Seoul grid
    // — never the second (metadata) clock read.
    const url = fetchCalls[0].url as URL;
    expect(url.pathname.endsWith('/getUltraSrtNcst')).toBe(true);
    expect(url.searchParams.get('base_date')).toBe('20260718');
    expect(url.searchParams.get('base_time')).toBe('0600');
    expect(url.searchParams.get('nx')).toBe('60');
    expect(url.searchParams.get('ny')).toBe('127');

    expectNoLeakage(result);
  });

  it('assembles correctly from a deeply frozen input and does not mutate it', async () => {
    const { fetchImpl } = recordingFetch(() => jsonOk(successBody(fullCurrentSlotItems())));
    const { clock } = scriptedClock([CLOCK_AT_0600_KST_20260718, FETCHED_AT_EPOCH_MS]);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const input = deepFreeze({ location: makeLocation() });
    const snapshot = JSON.stringify(input);

    const result = await service.fetchCurrentWeatherOverviewForLocation(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.overview.current).not.toBeNull();
    }
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('createKmaLocationCurrentOverviewCompositionFromEnv — unsupported location', () => {
  it('returns the exact LOCATION failure for Tokyo, with no clock read, no fetch, and no resolver run', async () => {
    const consoleSpy = spyOnConsole();
    const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
    const { clock, nowEpochMilliseconds } = scriptedClock([
      CLOCK_AT_0600_KST_20260718,
      FETCHED_AT_EPOCH_MS,
    ]);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const result = await service.fetchCurrentWeatherOverviewForLocation({
      location: makeLocation({ latitude: TOKYO_LATITUDE, longitude: TOKYO_LONGITUDE }),
    });

    expect(result).toEqual({
      ok: false,
      stage: 'LOCATION',
      error: { kind: 'UNSUPPORTED_LOCATION' },
    });
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    expect('overview' in result).toBe(false);
    consoleSpy.expectSilent();
    consoleSpy.restore();
  });
});

describe('createKmaLocationCurrentOverviewCompositionFromEnv — invalid WeatherLocation', () => {
  const invalidLocations: ReadonlyArray<{
    readonly name: string;
    readonly overrides: Partial<WeatherLocation>;
  }> = [
    { name: 'invalid timezone', overrides: { timezone: 'Seoul' } },
    { name: 'out-of-range latitude', overrides: { latitude: 999 } },
    { name: 'out-of-range longitude', overrides: { longitude: 999 } },
    { name: 'empty id', overrides: { id: '' } },
    { name: 'invalid countryCode', overrides: { countryCode: 'kr' } },
  ];

  for (const { name, overrides } of invalidLocations) {
    it(`throws a synchronous ZodError for a ${name}, with no clock read and no fetch`, () => {
      const consoleSpy = spyOnConsole();
      const { fetchImpl, calls: fetchCalls } = neverCalledFetch();
      const { clock, nowEpochMilliseconds } = scriptedClock([
        CLOCK_AT_0600_KST_20260718,
        FETCHED_AT_EPOCH_MS,
      ]);
      const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

      const input = { location: makeLocation(overrides) };
      const snapshot = JSON.stringify(input);

      let returned: unknown;
      const caught = captureSynchronousError(() => {
        returned = service.fetchCurrentWeatherOverviewForLocation(input);
      });

      expect(caught).toBeInstanceOf(Error);
      expect((caught as { name?: string }).name).toBe('ZodError');
      expect(returned).toBeUndefined();
      expect(nowEpochMilliseconds).not.toHaveBeenCalled();
      expect(fetchCalls).toHaveLength(0);
      expect(JSON.stringify(input)).toBe(snapshot);
      consoleSpy.expectSilent();
      consoleSpy.restore();
    });
  }
});

describe('createKmaLocationCurrentOverviewCompositionFromEnv — pre-aborted supported location', () => {
  it('honours a pre-aborted signal (PROVIDER/ABORTED), reads the request clock once, never reads the metadata clock, and never calls fetchImpl', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      jsonOk(successBody(fullCurrentSlotItems())),
    );
    const { clock, nowEpochMilliseconds } = scriptedClock([
      CLOCK_AT_0600_KST_20260718,
      FETCHED_AT_EPOCH_MS,
    ]);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const controller = new AbortController();
    controller.abort();

    const result = await service.fetchCurrentWeatherOverviewForLocation(
      { location: makeLocation() },
      { signal: controller.signal },
    );

    expect(result).toEqual({
      ok: false,
      stage: 'PROVIDER',
      error: { kind: 'ABORTED' },
    });
    // The request was built (one clock read); the provider short-circuited before any fetch, so the
    // resolver never ran and never took its second clock read.
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('createKmaLocationCurrentOverviewCompositionFromEnv — downstream failure pass-through', () => {
  it('returns a PROVIDER-stage HTTP_ERROR verbatim, with the request clock read once and the metadata resolver never run', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(
      () => new Response('secret upstream error page', { status: 503 }),
    );
    const { clock, nowEpochMilliseconds } = scriptedClock([
      CLOCK_AT_0600_KST_20260718,
      FETCHED_AT_EPOCH_MS,
    ]);
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const result = await service.fetchCurrentWeatherOverviewForLocation({
      location: makeLocation(),
    });

    expect(result).toEqual({
      ok: false,
      stage: 'PROVIDER',
      error: { kind: 'HTTP_ERROR', status: 503 },
    });
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);
    expectNoLeakage(result);
  });

  it('returns a NORMALIZATION-stage failure verbatim, with the request clock read once and the metadata resolver never run', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      jsonOk(successBody(missingRequiredCategoryItems())),
    );
    const { clock, nowEpochMilliseconds } = scriptedClock([
      CLOCK_AT_0600_KST_20260718,
      FETCHED_AT_EPOCH_MS,
    ]);
    const consoleSpy = spyOnConsole();
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    const result = await service.fetchCurrentWeatherOverviewForLocation({
      location: makeLocation(),
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
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);
    expect('overview' in result).toBe(false);
    expectNoLeakage(result);
    consoleSpy.expectSilent();
    consoleSpy.restore();
  });
});

describe('createKmaLocationCurrentOverviewCompositionFromEnv — metadata clock throw', () => {
  it('rejects the returned Promise with the exact sentinel when the second (metadata) clock read throws, after a successful fetch', async () => {
    const consoleSpy = spyOnConsole();
    const sentinel = new Error('METADATA_CLOCK_SENTINEL_PR75');
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      jsonOk(successBody(fullCurrentSlotItems())),
    );
    const { clock, nowEpochMilliseconds } = throwingSecondClock(
      CLOCK_AT_0600_KST_20260718,
      sentinel,
    );
    const service = composeOrThrow(makeEnv(FAKE_KMA_SERVICE_KEY), { fetchImpl, clock });

    let returned: unknown;
    const caught = captureSynchronousError(() => {
      returned = service.fetchCurrentWeatherOverviewForLocation({ location: makeLocation() });
    });

    // The method call itself does not become a synchronous throw — it returns a Promise…
    expect(caught).toBeUndefined();
    expect(returned).toBeInstanceOf(Promise);
    // …that rejects with the exact sentinel reference (no wrapping, no partial overview).
    await expect(returned).rejects.toBe(sentinel);

    // The clock was read twice (request + failed metadata) and one fetch occurred; the current
    // observation itself was already fetched/normalized successfully before the resolver threw.
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(2);
    expect(fetchCalls).toHaveLength(1);
    consoleSpy.expectSilent();
    consoleSpy.restore();
  });
});

describe('createKmaLocationCurrentOverviewCompositionFromEnv — fresh independent graphs', () => {
  it('builds distinct result, service, and method references across calls with no shared cache', async () => {
    const { fetchImpl, calls: fetchCalls } = recordingFetch(() =>
      jsonOk(successBody(fullCurrentSlotItems())),
    );
    const env = makeEnv(FAKE_KMA_SERVICE_KEY);
    const dependencies: KmaLocationCurrentOverviewCompositionDependencies = {
      fetchImpl,
      clock: scriptedClock([CLOCK_AT_0600_KST_20260718, FETCHED_AT_EPOCH_MS]).clock,
    };

    const first = createKmaLocationCurrentOverviewCompositionFromEnv(env, dependencies);
    const second = createKmaLocationCurrentOverviewCompositionFromEnv(env, dependencies);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      throw new Error('expected both compositions to succeed');
    }

    expect(first).not.toBe(second);
    expect(first.service).not.toBe(second.service);
    expect(first.service.fetchCurrentWeatherOverviewForLocation).not.toBe(
      second.service.fetchCurrentWeatherOverviewForLocation,
    );

    const firstResult = await first.service.fetchCurrentWeatherOverviewForLocation({
      location: makeLocation(),
    });
    const secondResult = await second.service.fetchCurrentWeatherOverviewForLocation({
      location: makeLocation(),
    });

    expect(firstResult).not.toBe(secondResult);
    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    if (firstResult.ok && secondResult.ok) {
      expect(firstResult.overview).not.toBe(secondResult.overview);
    }
    expect(fetchCalls).toHaveLength(2);
  });
});

describe('createKmaLocationCurrentOverviewCompositionFromEnv — no secret leakage, no logging', () => {
  it('never surfaces the service key across success/unsupported/provider-failure results, and logs nothing', async () => {
    const consoleSpy = spyOnConsole();

    const success = recordingFetch(() => jsonOk(successBody(fullCurrentSlotItems())));
    const successService = composeOrThrow(makeEnv(SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR75), {
      fetchImpl: success.fetchImpl,
      clock: scriptedClock([CLOCK_AT_0600_KST_20260718, FETCHED_AT_EPOCH_MS]).clock,
    });
    const successResult = await successService.fetchCurrentWeatherOverviewForLocation({
      location: makeLocation(),
    });
    expect(successResult.ok).toBe(true);
    expect(JSON.stringify(successResult)).not.toContain(
      SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR75,
    );

    const unsupportedService = composeOrThrow(
      makeEnv(SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR75),
      {
        fetchImpl: neverCalledFetch().fetchImpl,
        clock: scriptedClock([CLOCK_AT_0600_KST_20260718, FETCHED_AT_EPOCH_MS]).clock,
      },
    );
    const unsupportedResult = await unsupportedService.fetchCurrentWeatherOverviewForLocation({
      location: makeLocation({ latitude: TOKYO_LATITUDE, longitude: TOKYO_LONGITUDE }),
    });
    expect(unsupportedResult.ok).toBe(false);
    expect(JSON.stringify(unsupportedResult)).not.toContain(
      SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR75,
    );

    const providerFail = recordingFetch(() => new Response('x', { status: 503 }));
    const providerFailService = composeOrThrow(
      makeEnv(SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR75),
      {
        fetchImpl: providerFail.fetchImpl,
        clock: scriptedClock([CLOCK_AT_0600_KST_20260718, FETCHED_AT_EPOCH_MS]).clock,
      },
    );
    const providerFailResult =
      await providerFailService.fetchCurrentWeatherOverviewForLocation({
        location: makeLocation(),
      });
    expect(providerFailResult.ok).toBe(false);
    expect(JSON.stringify(providerFailResult)).not.toContain(
      SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR75,
    );

    const configResult = createKmaLocationCurrentOverviewCompositionFromEnv(
      makeEnv(` ${SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR75} `),
      { fetchImpl: neverCalledFetch().fetchImpl },
    );
    expect(configResult.ok).toBe(false);
    expect(JSON.stringify(configResult)).not.toContain(
      SECRET_SHAPED_KMA_KEY_MUST_NOT_LEAK_PR75,
    );

    consoleSpy.expectSilent();
    consoleSpy.restore();
  });
});
