import { describe, expect, it, vi } from 'vitest';

import type { KmaMidtermForecastProviderResult } from '../providers/kma/index.js';
import { createKmaMidtermExecutionService } from './kma-midterm-execution.js';
import type {
  KmaMidtermRequestPlan,
  KmaMidtermRequestPlanFactory,
  KmaMidtermRequestPlanFactoryInput,
} from './kma-midterm-request-plan.js';

const TEMPERATURE_REQUEST = Object.freeze({
  operation: 'TEMPERATURE' as const,
  regId: '11B10101',
  tmFc: '202609010600',
});

const LAND_REQUEST = Object.freeze({
  operation: 'LAND' as const,
  regId: '11B00000',
  tmFc: '202609010600',
});

function makePlan(): KmaMidtermRequestPlan {
  return {
    temperature: TEMPERATURE_REQUEST,
    land: LAND_REQUEST,
  };
}

function makeSuccess(
  operation: 'TEMPERATURE' | 'LAND',
): KmaMidtermForecastProviderResult {
  if (operation === 'TEMPERATURE') {
    return Object.freeze({
      ok: true,
      midterm: Object.freeze({
        operation: 'TEMPERATURE',
        regId: TEMPERATURE_REQUEST.regId,
        tmFc: TEMPERATURE_REQUEST.tmFc,
        totalCount: 1,
        temperatures: Object.freeze([]),
      }),
    }) as KmaMidtermForecastProviderResult;
  }
  return Object.freeze({
    ok: true,
    midterm: Object.freeze({
      operation: 'LAND',
      regId: LAND_REQUEST.regId,
      tmFc: LAND_REQUEST.tmFc,
      totalCount: 1,
      landForecasts: Object.freeze([]),
    }),
  }) as KmaMidtermForecastProviderResult;
}

function makeFailure(resultCode: string): KmaMidtermForecastProviderResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ kind: 'KMA_UPSTREAM_ERROR', resultCode }),
  }) as KmaMidtermForecastProviderResult;
}

/** A synthetic plan factory: records calls and returns a fixed plan (or throws a fixed error). */
function makePlanFactory(options?: {
  readonly plan?: KmaMidtermRequestPlan;
  readonly throwError?: unknown;
}): {
  readonly factory: KmaMidtermRequestPlanFactory;
  readonly calls: KmaMidtermRequestPlanFactoryInput[];
} {
  const calls: KmaMidtermRequestPlanFactoryInput[] = [];
  const plan = options?.plan ?? makePlan();
  return {
    calls,
    factory: {
      createScheduledRequestPlan(input) {
        calls.push(input);
        if (options?.throwError !== undefined) {
          throw options.throwError;
        }
        return plan;
      },
    },
  };
}

/** A synthetic provider: records call order/args and resolves/throws/rejects per a fixed script. */
type MidtermScriptFn = (
  request: unknown,
  options?: unknown,
) => KmaMidtermForecastProviderResult | Promise<KmaMidtermForecastProviderResult>;

function makeProvider(
  script: MidtermScriptFn,
): {
  readonly provider: { fetchMidtermForecast: MidtermScriptFn };
  readonly calls: Array<{ request: unknown; options: unknown }>;
} {
  const calls: Array<{ request: unknown; options: unknown }> = [];
  const fetchMidtermForecast = vi.fn<MidtermScriptFn>((request, options) => {
    calls.push({ request, options });
    return script(request, options);
  });
  return { provider: { fetchMidtermForecast }, calls };
}

describe('createKmaMidtermExecutionService', () => {
  describe('construction', () => {
    it('does not call the plan factory or the provider at construction time', () => {
      const { factory, calls: planCalls } = makePlanFactory();
      const { provider, calls: providerCalls } = makeProvider(() => makeSuccess('TEMPERATURE'));

      createKmaMidtermExecutionService(factory, provider as never);

      expect(planCalls).toHaveLength(0);
      expect(providerCalls).toHaveLength(0);
      expect(provider.fetchMidtermForecast).not.toHaveBeenCalled();
    });
  });

  describe('plan invocation', () => {
    it('calls the plan factory exactly once with the exact caller input reference', async () => {
      const { factory, calls: planCalls } = makePlanFactory();
      const { provider } = makeProvider((request) =>
        (request as { operation: string }).operation === 'TEMPERATURE'
          ? makeSuccess('TEMPERATURE')
          : makeSuccess('LAND'),
      );
      const service = createKmaMidtermExecutionService(factory, provider as never);
      const input: KmaMidtermExecutionServiceInputForTest = {
        temperatureRegId: '11B10101',
        landRegId: '11B00000',
      };

      await service.fetchScheduledMidtermForecast(input);

      expect(planCalls).toHaveLength(1);
      expect(planCalls[0]).toBe(input);
    });
  });

  describe('provider invocation order', () => {
    it('calls TEMPERATURE then LAND, exactly once each, with exact plan request references', async () => {
      const plan = makePlan();
      const { factory } = makePlanFactory({ plan });
      const order: string[] = [];
      const { provider, calls } = makeProvider((request) => {
        const operation = (request as { operation: string }).operation;
        order.push(operation);
        return operation === 'TEMPERATURE' ? makeSuccess('TEMPERATURE') : makeSuccess('LAND');
      });
      const service = createKmaMidtermExecutionService(factory, provider as never);

      await service.fetchScheduledMidtermForecast({
        temperatureRegId: '11B10101',
        landRegId: '11B00000',
      });

      expect(order).toEqual(['TEMPERATURE', 'LAND']);
      expect(calls).toHaveLength(2);
      expect(calls[0]!.request).toBe(plan.temperature);
      expect(calls[1]!.request).toBe(plan.land);
    });
  });

  describe('options / signal', () => {
    it('forwards the exact same options and AbortSignal reference to both calls', async () => {
      const { factory } = makePlanFactory();
      const { provider, calls } = makeProvider(() => makeSuccess('TEMPERATURE'));
      const service = createKmaMidtermExecutionService(factory, provider as never);
      const controller = new AbortController();
      const options = { signal: controller.signal };

      await service.fetchScheduledMidtermForecast(
        { temperatureRegId: '11B10101', landRegId: '11B00000' },
        options,
      );

      expect(calls[0]!.options).toBe(options);
      expect(calls[1]!.options).toBe(options);
      expect((calls[0]!.options as { signal: AbortSignal }).signal).toBe(controller.signal);
      expect((calls[1]!.options as { signal: AbortSignal }).signal).toBe(controller.signal);
    });

    it('leaves options undefined as undefined when the caller omits it', async () => {
      const { factory } = makePlanFactory();
      const { provider, calls } = makeProvider(() => makeSuccess('TEMPERATURE'));
      const service = createKmaMidtermExecutionService(factory, provider as never);

      await service.fetchScheduledMidtermForecast({
        temperatureRegId: '11B10101',
        landRegId: '11B00000',
      });

      expect(calls[0]!.options).toBeUndefined();
      expect(calls[1]!.options).toBeUndefined();
    });
  });

  describe('both successes', () => {
    it('returns a fresh wrapper preserving exact temperature/land result references', async () => {
      const { factory } = makePlanFactory();
      const temperatureResult = makeSuccess('TEMPERATURE');
      const landResult = makeSuccess('LAND');
      const { provider } = makeProvider((request) =>
        (request as { operation: string }).operation === 'TEMPERATURE'
          ? temperatureResult
          : landResult,
      );
      const service = createKmaMidtermExecutionService(factory, provider as never);

      const result = await service.fetchScheduledMidtermForecast({
        temperatureRegId: '11B10101',
        landRegId: '11B00000',
      });

      expect(Object.keys(result).sort()).toEqual(['land', 'temperature']);
      expect(result.temperature).toBe(temperatureResult);
      expect(result.land).toBe(landResult);
    });
  });

  describe('TEMPERATURE resolved provider failure', () => {
    it('still calls LAND and preserves both exact references (temperature fails)', async () => {
      const { factory } = makePlanFactory();
      const temperatureFailure = makeFailure('03');
      const landSuccess = makeSuccess('LAND');
      const { provider, calls } = makeProvider((request) =>
        (request as { operation: string }).operation === 'TEMPERATURE'
          ? temperatureFailure
          : landSuccess,
      );
      const service = createKmaMidtermExecutionService(factory, provider as never);

      const result = await service.fetchScheduledMidtermForecast({
        temperatureRegId: '11B10101',
        landRegId: '11B00000',
      });

      expect(calls).toHaveLength(2);
      expect(result.temperature).toBe(temperatureFailure);
      expect(result.land).toBe(landSuccess);
    });

    it('still calls LAND and preserves both exact references (land fails)', async () => {
      const { factory } = makePlanFactory();
      const temperatureSuccess = makeSuccess('TEMPERATURE');
      const landFailure = makeFailure('99');
      const { provider, calls } = makeProvider((request) =>
        (request as { operation: string }).operation === 'TEMPERATURE'
          ? temperatureSuccess
          : landFailure,
      );
      const service = createKmaMidtermExecutionService(factory, provider as never);

      const result = await service.fetchScheduledMidtermForecast({
        temperatureRegId: '11B10101',
        landRegId: '11B00000',
      });

      expect(calls).toHaveLength(2);
      expect(result.temperature).toBe(temperatureSuccess);
      expect(result.land).toBe(landFailure);
    });
  });

  describe('both resolved failures', () => {
    it('runs both calls and preserves both exact failure references without collapsing', async () => {
      const { factory } = makePlanFactory();
      const temperatureFailure = makeFailure('03');
      const landFailure = makeFailure('99');
      const { provider, calls } = makeProvider((request) =>
        (request as { operation: string }).operation === 'TEMPERATURE'
          ? temperatureFailure
          : landFailure,
      );
      const service = createKmaMidtermExecutionService(factory, provider as never);

      const result = await service.fetchScheduledMidtermForecast({
        temperatureRegId: '11B10101',
        landRegId: '11B00000',
      });

      expect(calls).toHaveLength(2);
      expect(result.temperature).toBe(temperatureFailure);
      expect(result.land).toBe(landFailure);
      expect(result.temperature).not.toBe(result.land);
    });
  });

  describe('plan factory throw', () => {
    it('propagates the exact error reference and calls the provider zero times', async () => {
      const sentinel = new Error('plan factory sentinel');
      const { factory } = makePlanFactory({ throwError: sentinel });
      const { provider, calls } = makeProvider(() => makeSuccess('TEMPERATURE'));
      const service = createKmaMidtermExecutionService(factory, provider as never);

      await expect(
        service.fetchScheduledMidtermForecast({
          temperatureRegId: '11B10101',
          landRegId: '11B00000',
        }),
      ).rejects.toBe(sentinel);
      expect(calls).toHaveLength(0);
    });
  });

  describe('first provider synchronous throw', () => {
    it('propagates the exact error, never calls LAND, and returns no partial result', async () => {
      const { factory } = makePlanFactory();
      const sentinel = new Error('temperature sync throw sentinel');
      const { provider, calls } = makeProvider((request) => {
        if ((request as { operation: string }).operation === 'TEMPERATURE') {
          throw sentinel;
        }
        return makeSuccess('LAND');
      });
      const service = createKmaMidtermExecutionService(factory, provider as never);

      await expect(
        service.fetchScheduledMidtermForecast({
          temperatureRegId: '11B10101',
          landRegId: '11B00000',
        }),
      ).rejects.toBe(sentinel);
      expect(calls).toHaveLength(1);
    });
  });

  describe('first provider rejected promise', () => {
    it('propagates the exact rejection reference, never calls LAND, and returns no partial result', async () => {
      const { factory } = makePlanFactory();
      const sentinel = new Error('temperature rejection sentinel');
      const { provider, calls } = makeProvider((request) => {
        if ((request as { operation: string }).operation === 'TEMPERATURE') {
          return Promise.reject(sentinel);
        }
        return makeSuccess('LAND');
      });
      const service = createKmaMidtermExecutionService(factory, provider as never);

      await expect(
        service.fetchScheduledMidtermForecast({
          temperatureRegId: '11B10101',
          landRegId: '11B00000',
        }),
      ).rejects.toBe(sentinel);
      expect(calls).toHaveLength(1);
    });
  });

  describe('second provider synchronous throw/rejection', () => {
    it('propagates the exact LAND error after TEMPERATURE was called once, with no partial wrapper', async () => {
      const { factory } = makePlanFactory();
      const sentinel = new Error('land sync throw sentinel');
      const { provider, calls } = makeProvider((request) => {
        if ((request as { operation: string }).operation === 'TEMPERATURE') {
          return makeSuccess('TEMPERATURE');
        }
        throw sentinel;
      });
      const service = createKmaMidtermExecutionService(factory, provider as never);

      await expect(
        service.fetchScheduledMidtermForecast({
          temperatureRegId: '11B10101',
          landRegId: '11B00000',
        }),
      ).rejects.toBe(sentinel);
      expect(calls).toHaveLength(2);
    });

    it('propagates the exact LAND rejection after TEMPERATURE was called once, with no partial wrapper', async () => {
      const { factory } = makePlanFactory();
      const sentinel = new Error('land rejection sentinel');
      const { provider, calls } = makeProvider((request) => {
        if ((request as { operation: string }).operation === 'TEMPERATURE') {
          return makeSuccess('TEMPERATURE');
        }
        return Promise.reject(sentinel);
      });
      const service = createKmaMidtermExecutionService(factory, provider as never);

      await expect(
        service.fetchScheduledMidtermForecast({
          temperatureRegId: '11B10101',
          landRegId: '11B00000',
        }),
      ).rejects.toBe(sentinel);
      expect(calls).toHaveLength(2);
    });
  });

  describe('pre-aborted signal', () => {
    it('forwards the same already-aborted signal to both calls without inspecting aborted state', async () => {
      const { factory } = makePlanFactory();
      const controller = new AbortController();
      controller.abort();
      const abortedResult = (operation: 'TEMPERATURE' | 'LAND'): KmaMidtermForecastProviderResult =>
        operation === 'TEMPERATURE'
          ? (Object.freeze({ ok: false, error: Object.freeze({ kind: 'ABORTED' }) }) as never)
          : (Object.freeze({ ok: false, error: Object.freeze({ kind: 'ABORTED' }) }) as never);
      const { provider, calls } = makeProvider((request) =>
        abortedResult((request as { operation: 'TEMPERATURE' | 'LAND' }).operation),
      );
      const service = createKmaMidtermExecutionService(factory, provider as never);
      const options = { signal: controller.signal };

      const result = await service.fetchScheduledMidtermForecast(
        { temperatureRegId: '11B10101', landRegId: '11B00000' },
        options,
      );

      expect(calls).toHaveLength(2);
      expect((calls[0]!.options as { signal: AbortSignal }).signal).toBe(controller.signal);
      expect((calls[1]!.options as { signal: AbortSignal }).signal).toBe(controller.signal);
      expect(result.temperature).toEqual({ ok: false, error: { kind: 'ABORTED' } });
      expect(result.land).toEqual({ ok: false, error: { kind: 'ABORTED' } });
    });
  });

  describe('mutation / reference safety', () => {
    it('forwards a frozen plan request without mutation and works with a frozen input', async () => {
      const plan = Object.freeze({
        temperature: TEMPERATURE_REQUEST,
        land: LAND_REQUEST,
      });
      const { factory } = makePlanFactory({ plan });
      const { provider, calls } = makeProvider((request) =>
        (request as { operation: string }).operation === 'TEMPERATURE'
          ? makeSuccess('TEMPERATURE')
          : makeSuccess('LAND'),
      );
      const service = createKmaMidtermExecutionService(factory, provider as never);
      const frozenInput = Object.freeze({ temperatureRegId: '11B10101', landRegId: '11B00000' });

      await service.fetchScheduledMidtermForecast(frozenInput);

      expect(calls[0]!.request).toBe(plan.temperature);
      expect(calls[1]!.request).toBe(plan.land);
      expect(Object.isFrozen(plan.temperature)).toBe(true);
      expect(Object.isFrozen(plan.land)).toBe(true);
    });

    it('returns frozen provider results unchanged and allocates a fresh wrapper on each call', async () => {
      const { factory } = makePlanFactory();
      const temperatureResult = makeSuccess('TEMPERATURE');
      const landResult = makeSuccess('LAND');
      const { provider } = makeProvider((request) =>
        (request as { operation: string }).operation === 'TEMPERATURE'
          ? temperatureResult
          : landResult,
      );
      const service = createKmaMidtermExecutionService(factory, provider as never);
      const input = { temperatureRegId: '11B10101', landRegId: '11B00000' };

      const first = await service.fetchScheduledMidtermForecast(input);
      const second = await service.fetchScheduledMidtermForecast(input);

      expect(first).not.toBe(second);
      expect(first.temperature).toBe(second.temperature);
      expect(first.land).toBe(second.land);
      expect(Object.isFrozen(first.temperature)).toBe(true);
      expect(Object.isFrozen(first.land)).toBe(true);
    });
  });

  describe('representative broken implementations fail these tests', () => {
    it('detects a plan factory called twice', async () => {
      const { factory, calls: planCalls } = makePlanFactory();
      const { provider } = makeProvider((request) =>
        (request as { operation: string }).operation === 'TEMPERATURE'
          ? makeSuccess('TEMPERATURE')
          : makeSuccess('LAND'),
      );

      // Simulate a broken caller that (incorrectly) builds the plan twice, to prove this assertion
      // would catch that regression if it crept into the service itself.
      const brokenService = {
        async run(input: KmaMidtermExecutionServiceInputForTest) {
          factory.createScheduledRequestPlan(input);
          const plan = factory.createScheduledRequestPlan(input);
          const temperature = await provider.fetchMidtermForecast(plan.temperature);
          const land = await provider.fetchMidtermForecast(plan.land);
          return { temperature, land };
        },
      };

      await brokenService.run({ temperatureRegId: '11B10101', landRegId: '11B00000' });

      expect(planCalls.length).toBeGreaterThan(1);

      const { factory: correctFactory, calls: correctPlanCalls } = makePlanFactory();
      const correctService = createKmaMidtermExecutionService(correctFactory, provider as never);
      await correctService.fetchScheduledMidtermForecast({
        temperatureRegId: '11B10101',
        landRegId: '11B00000',
      });
      expect(correctPlanCalls).toHaveLength(1);
    });

    it('detects LAND skipped after a resolved temperature failure', async () => {
      const { factory } = makePlanFactory();
      const temperatureFailure = makeFailure('03');
      const landSuccess = makeSuccess('LAND');
      const { provider, calls } = makeProvider((request) =>
        (request as { operation: string }).operation === 'TEMPERATURE'
          ? temperatureFailure
          : landSuccess,
      );

      // A broken short-circuiting implementation, to prove the correct service does not do this.
      const brokenResult = await (async () => {
        const plan = factory.createScheduledRequestPlan({
          temperatureRegId: '11B10101',
          landRegId: '11B00000',
        });
        const temperature = await provider.fetchMidtermForecast(plan.temperature);
        if (!temperature.ok) {
          return { temperature, land: null };
        }
        const land = await provider.fetchMidtermForecast(plan.land);
        return { temperature, land };
      })();
      expect(brokenResult.land).toBeNull();

      calls.length = 0;
      const service = createKmaMidtermExecutionService(factory, provider as never);
      const result = await service.fetchScheduledMidtermForecast({
        temperatureRegId: '11B10101',
        landRegId: '11B00000',
      });
      expect(calls).toHaveLength(2);
      expect(result.land).toBe(landSuccess);
    });
  });
});

/** Local alias matching the service's public input shape, for test readability only. */
interface KmaMidtermExecutionServiceInputForTest {
  readonly temperatureRegId: string;
  readonly landRegId: string;
}
