import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KmaMidtermIssuance, SelectLatestKmaMidtermIssuanceInput } from '@life-weather/weather-core';

import type { KmaMidtermForecastRequest } from '../providers/kma/index.js';
import {
  createKmaMidtermRequestPlanFactory,
  type KmaMidtermIssuanceSelector,
  type KmaMidtermRequestClock,
  type KmaMidtermRequestPlanFactoryInput,
} from './kma-midterm-request-plan.js';

/** The exact three keys each request must expose, sorted for stable comparison. */
const REQUEST_KEYS = ['operation', 'regId', 'tmFc'] as const;
/** The exact two keys the plan wrapper must expose, sorted for stable comparison. */
const PLAN_KEYS = ['land', 'temperature'] as const;
/** The exact one key the selector input must expose. */
const SELECTOR_INPUT_KEYS = ['referenceEpochMilliseconds'] as const;

const TEMPERATURE_REG_ID = '11B10101';
const LAND_REG_ID = '11B00000';

/**
 * Build an absolute epoch-millisecond value from a KST wall clock. The offset is always explicit
 * (`+09:00`), so the reference is host-timezone independent — the same instant everywhere.
 */
function kstEpochMs(kstWallClock: string): number {
  const ms = Date.parse(`${kstWallClock}+09:00`);
  if (Number.isNaN(ms)) {
    throw new Error(`test setup: unparseable KST wall clock "${kstWallClock}"`);
  }
  return ms;
}

/**
 * A fresh, isolated fake clock that always returns `epochMilliseconds`. Each call builds its own
 * `vi.fn`, so no call history is ever shared across tests (order-independent under shuffle).
 */
function fixedClock(epochMilliseconds: number) {
  const nowEpochMilliseconds = vi.fn(() => epochMilliseconds);
  const clock: KmaMidtermRequestClock = { nowEpochMilliseconds };
  return { clock, nowEpochMilliseconds };
}

/** A fresh fake clock that returns the next value in `values` on each successive call. */
function sequenceClock(values: readonly number[]) {
  let index = 0;
  const nowEpochMilliseconds = vi.fn(() => {
    const value = values[index];
    index += 1;
    return value as number;
  });
  const clock: KmaMidtermRequestClock = { nowEpochMilliseconds };
  return { clock, nowEpochMilliseconds };
}

/** A fresh fake clock whose read throws `error` (the exact reference, for identity checks). */
function throwingClock(error: unknown) {
  const nowEpochMilliseconds = vi.fn((): number => {
    throw error;
  });
  const clock: KmaMidtermRequestClock = { nowEpochMilliseconds };
  return { clock, nowEpochMilliseconds };
}

/** A fresh issuance result distinct from anything the real PR #99 selector would return. */
function customIssuance(): KmaMidtermIssuance {
  return { tmFc: '202607220600' };
}

/**
 * A fresh, test-local injected {@link KmaMidtermIssuanceSelector} that records every input it
 * receives (by reference) and returns `result`. The `calls` array is created per invocation of
 * this helper — never a module-scope mutable array or a shared `vi.fn` — so no call history is
 * shared across tests (order-independent under shuffle).
 */
function recordingSelector(result: KmaMidtermIssuance = customIssuance()) {
  const calls: SelectLatestKmaMidtermIssuanceInput[] = [];
  const selector: KmaMidtermIssuanceSelector = (input) => {
    calls.push(input);
    return result;
  };
  return { selector, calls, result };
}

/** A fresh, test-local selector that throws `error` (the exact reference, for identity checks). */
function throwingSelector(error: unknown) {
  const calls: SelectLatestKmaMidtermIssuanceInput[] = [];
  const selector: KmaMidtermIssuanceSelector = (input) => {
    calls.push(input);
    throw error;
  };
  return { selector, calls };
}

/** Recursively freeze an object graph so any write to it (or a nested object) throws in strict mode. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

// Safety net: restore any console (or other) spy even if an assertion in the test that installed it
// throws before its explicit `mockRestore()` runs. Applies to every describe block below.
afterEach(() => {
  vi.restoreAllMocks();
});

describe('createKmaMidtermRequestPlanFactory — construction is side-effect-free', () => {
  it('does not call the clock on construction alone', () => {
    const { clock, nowEpochMilliseconds } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const { selector } = recordingSelector();
    createKmaMidtermRequestPlanFactory(clock, selector);
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
  });

  it('does not call the injected selector on construction alone', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const { selector, calls } = recordingSelector();
    createKmaMidtermRequestPlanFactory(clock, selector);
    expect(calls).toHaveLength(0);
  });

  it('does not call the clock or the default selector on construction alone', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { clock, nowEpochMilliseconds } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    // Default (PR #99) selector path — construction must still touch nothing.
    expect(() => createKmaMidtermRequestPlanFactory(clock)).not.toThrow();
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    // No environment/network/logging on construction.
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('exposes exactly one public method named createScheduledRequestPlan', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const { selector } = recordingSelector();
    const factory = createKmaMidtermRequestPlanFactory(clock, selector);
    expect(Object.keys(factory)).toEqual(['createScheduledRequestPlan']);
    expect(typeof factory.createScheduledRequestPlan).toBe('function');
  });

  it('creates independent instances on repeated construction (no shared state)', () => {
    const { clock: clockA } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const { clock: clockB } = fixedClock(kstEpochMs('2026-07-22T18:45:00.000'));
    const factoryA = createKmaMidtermRequestPlanFactory(clockA, recordingSelector().selector);
    const factoryB = createKmaMidtermRequestPlanFactory(clockB, recordingSelector().selector);
    expect(factoryA).not.toBe(factoryB);
    expect(factoryA.createScheduledRequestPlan).not.toBe(factoryB.createScheduledRequestPlan);
  });

  it('constructs from a frozen clock and a frozen selector reference without calling either', () => {
    const nowEpochMilliseconds = vi.fn(() => kstEpochMs('2026-07-22T05:10:00.000'));
    const clock = Object.freeze({ nowEpochMilliseconds });
    const { selector, calls } = recordingSelector();
    const frozenSelector = Object.freeze(selector);

    const factory = createKmaMidtermRequestPlanFactory(clock, frozenSelector);

    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    // The factory is usable and routes through the injected selector reference.
    const plan = factory.createScheduledRequestPlan({
      temperatureRegId: TEMPERATURE_REG_ID,
      landRegId: LAND_REG_ID,
    });
    expect(plan.temperature.tmFc).toBe('202607220600');
    expect(calls).toHaveLength(1);
  });
});

describe('createKmaMidtermRequestPlanFactory — request assembly', () => {
  it('assembles temperature/land requests from the selector tmFc and caller regIds', () => {
    const epoch = kstEpochMs('2026-07-22T05:10:00.000');
    const { clock, nowEpochMilliseconds } = fixedClock(epoch);
    const { selector, calls } = recordingSelector();
    const factory = createKmaMidtermRequestPlanFactory(clock, selector);
    const input: KmaMidtermRequestPlanFactoryInput = {
      temperatureRegId: TEMPERATURE_REG_ID,
      landRegId: LAND_REG_ID,
    };

    const plan = factory.createScheduledRequestPlan(input);

    expect(plan).toEqual({
      temperature: {
        operation: 'TEMPERATURE',
        regId: TEMPERATURE_REG_ID,
        tmFc: '202607220600',
      },
      land: {
        operation: 'LAND',
        regId: LAND_REG_ID,
        tmFc: '202607220600',
      },
    });
    // Both requests share exactly the same tmFc.
    expect(plan.temperature.tmFc).toBe(plan.land.tmFc);
    // No accidental regId swap.
    expect(plan.temperature.regId).toBe(TEMPERATURE_REG_ID);
    expect(plan.land.regId).toBe(LAND_REG_ID);
    // Exactly one clock read and one selector call, with the exact epoch forwarded.
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].referenceEpochMilliseconds).toBe(epoch);
  });

  it('does not mutate the caller input or the selector issuance result', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const issuance = deepFreeze(customIssuance());
    const { selector } = recordingSelector(issuance);
    const factory = createKmaMidtermRequestPlanFactory(clock, selector);
    const input = Object.freeze<KmaMidtermRequestPlanFactoryInput>({
      temperatureRegId: TEMPERATURE_REG_ID,
      landRegId: LAND_REG_ID,
    });
    const inputSnapshot = JSON.stringify(input);
    const issuanceSnapshot = JSON.stringify(issuance);

    factory.createScheduledRequestPlan(input);

    expect(JSON.stringify(input)).toBe(inputSnapshot);
    expect(JSON.stringify(issuance)).toBe(issuanceSnapshot);
  });
});

describe('createKmaMidtermRequestPlanFactory — default PR #99 selector integration', () => {
  // The real (default) PR #99 selector is exercised by OMITTING the second argument. Expected
  // tmFc values are hard-coded literals — never generated by calling the production selector.
  function planAt(kstWallClock: string, input: KmaMidtermRequestPlanFactoryInput) {
    const { clock } = fixedClock(kstEpochMs(kstWallClock));
    const factory = createKmaMidtermRequestPlanFactory(clock);
    return factory.createScheduledRequestPlan(input);
  }

  it('at 06:00:00.000 KST (exact boundary): both requests share tmFc 0600', () => {
    const plan = planAt('2026-07-22T06:00:00.000', {
      temperatureRegId: TEMPERATURE_REG_ID,
      landRegId: LAND_REG_ID,
    });
    expect(plan).toEqual({
      temperature: { operation: 'TEMPERATURE', regId: TEMPERATURE_REG_ID, tmFc: '202607220600' },
      land: { operation: 'LAND', regId: LAND_REG_ID, tmFc: '202607220600' },
    });
  });

  it('one millisecond before the 06:00 boundary: both requests share the previous-day 1800', () => {
    const plan = planAt('2026-07-22T05:59:59.999', {
      temperatureRegId: TEMPERATURE_REG_ID,
      landRegId: LAND_REG_ID,
    });
    expect(plan).toEqual({
      temperature: { operation: 'TEMPERATURE', regId: TEMPERATURE_REG_ID, tmFc: '202607211800' },
      land: { operation: 'LAND', regId: LAND_REG_ID, tmFc: '202607211800' },
    });
  });

  it('at 18:00:00.000 KST (exact boundary): both requests share tmFc 1800', () => {
    const plan = planAt('2026-07-22T18:00:00.000', {
      temperatureRegId: TEMPERATURE_REG_ID,
      landRegId: LAND_REG_ID,
    });
    expect(plan).toEqual({
      temperature: { operation: 'TEMPERATURE', regId: TEMPERATURE_REG_ID, tmFc: '202607221800' },
      land: { operation: 'LAND', regId: LAND_REG_ID, tmFc: '202607221800' },
    });
  });
});

describe('createKmaMidtermRequestPlanFactory — single-reference (boundary) invariant', () => {
  it('reads only the first epoch of a sequence clock and calls the selector once per plan', () => {
    const first = kstEpochMs('2026-07-22T05:59:59.999');
    const second = kstEpochMs('2026-07-22T06:00:00.000');
    const { clock, nowEpochMilliseconds } = sequenceClock([first, second]);
    const { selector, calls } = recordingSelector();
    const factory = createKmaMidtermRequestPlanFactory(clock, selector);

    factory.createScheduledRequestPlan({
      temperatureRegId: TEMPERATURE_REG_ID,
      landRegId: LAND_REG_ID,
    });

    // One plan → clock read exactly once (the second sequence value is never consumed), so
    // temperature/land cannot be built from two different clock reads straddling the 06:00
    // boundary.
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(nowEpochMilliseconds.mock.calls[0]).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].referenceEpochMilliseconds).toBe(first);
  });

  it('proves the invariant against a double-read implementation using the real 06:00 boundary schedule', () => {
    // A hypothetical double-read implementation would call the clock once per operation and could
    // observe different epochs on either side of the 06:00 boundary, producing temperature.tmFc !==
    // land.tmFc. A clock that fails on a second call makes any second read fatal, proving this
    // factory performs exactly one read per plan and therefore cannot straddle the boundary.
    const boundary = kstEpochMs('2026-07-22T06:00:00.000');
    const nowEpochMilliseconds = vi.fn(() => boundary);
    let callCount = 0;
    const clock: KmaMidtermRequestClock = {
      nowEpochMilliseconds: () => {
        callCount += 1;
        if (callCount > 1) {
          throw new Error('SECOND_CLOCK_READ_MUST_NOT_HAPPEN');
        }
        return nowEpochMilliseconds();
      },
    };
    const factory = createKmaMidtermRequestPlanFactory(clock);

    const plan = factory.createScheduledRequestPlan({
      temperatureRegId: TEMPERATURE_REG_ID,
      landRegId: LAND_REG_ID,
    });

    expect(plan.temperature.tmFc).toBe(plan.land.tmFc);
    expect(plan.temperature.tmFc).toBe('202607220600');
    expect(callCount).toBe(1);
  });

  it('reads a distinct epoch per call across two plans with no state mixing', () => {
    const first = kstEpochMs('2026-07-22T05:10:00.000');
    const second = kstEpochMs('2026-07-22T18:10:00.000');
    const { clock, nowEpochMilliseconds } = sequenceClock([first, second]);
    const { selector, calls } = recordingSelector();
    const factory = createKmaMidtermRequestPlanFactory(clock, selector);

    factory.createScheduledRequestPlan({
      temperatureRegId: TEMPERATURE_REG_ID,
      landRegId: LAND_REG_ID,
    });
    factory.createScheduledRequestPlan({
      temperatureRegId: TEMPERATURE_REG_ID,
      landRegId: LAND_REG_ID,
    });

    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(2);
    expect(calls[0].referenceEpochMilliseconds).toBe(first);
    expect(calls[1].referenceEpochMilliseconds).toBe(second);
  });
});

describe('createKmaMidtermRequestPlanFactory — selector input contract', () => {
  it('passes a selector input whose only own key is referenceEpochMilliseconds', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const { selector, calls } = recordingSelector();
    const factory = createKmaMidtermRequestPlanFactory(clock, selector);

    factory.createScheduledRequestPlan({
      temperatureRegId: TEMPERATURE_REG_ID,
      landRegId: LAND_REG_ID,
    });

    expect(Object.keys(calls[0]).sort()).toEqual([...SELECTOR_INPUT_KEYS].sort());
  });

  it('builds a selector input that is a distinct object reference from the caller input', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const { selector, calls } = recordingSelector();
    const factory = createKmaMidtermRequestPlanFactory(clock, selector);
    const input: KmaMidtermRequestPlanFactoryInput = {
      temperatureRegId: TEMPERATURE_REG_ID,
      landRegId: LAND_REG_ID,
    };

    factory.createScheduledRequestPlan(input);

    expect(calls[0]).not.toBe(input as unknown as SelectLatestKmaMidtermIssuanceInput);
  });

  it('does not forward a runtime extra property from the caller input into the selector input', () => {
    const EXTRA_MARKER = 'SECRET_SHAPED_EXTRA_MUST_NOT_LEAK_PR100';
    const { clock } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const { selector, calls } = recordingSelector();
    const factory = createKmaMidtermRequestPlanFactory(clock, selector);
    const input = {
      temperatureRegId: TEMPERATURE_REG_ID,
      landRegId: LAND_REG_ID,
      [EXTRA_MARKER]: 'leak-me-if-you-spread-input',
    } as unknown as KmaMidtermRequestPlanFactoryInput;

    factory.createScheduledRequestPlan(input);

    expect(Object.keys(calls[0]).sort()).toEqual([...SELECTOR_INPUT_KEYS].sort());
    expect(calls[0]).not.toHaveProperty(EXTRA_MARKER);
  });

  it('forwards the exact clock epoch to the selector input unchanged', () => {
    const epoch = kstEpochMs('2026-07-22T18:45:00.000');
    const { clock } = fixedClock(epoch);
    const { selector, calls } = recordingSelector();
    const factory = createKmaMidtermRequestPlanFactory(clock, selector);

    factory.createScheduledRequestPlan({
      temperatureRegId: TEMPERATURE_REG_ID,
      landRegId: LAND_REG_ID,
    });

    expect(calls[0].referenceEpochMilliseconds).toBe(epoch);
  });

  it('builds a fresh selector input object on every call', () => {
    const { clock } = sequenceClock([
      kstEpochMs('2026-07-22T05:10:00.000'),
      kstEpochMs('2026-07-22T18:10:00.000'),
    ]);
    const { selector, calls } = recordingSelector();
    const factory = createKmaMidtermRequestPlanFactory(clock, selector);

    factory.createScheduledRequestPlan({
      temperatureRegId: TEMPERATURE_REG_ID,
      landRegId: LAND_REG_ID,
    });
    factory.createScheduledRequestPlan({
      temperatureRegId: TEMPERATURE_REG_ID,
      landRegId: LAND_REG_ID,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toBe(calls[1]);
  });
});

describe('createKmaMidtermRequestPlanFactory — output exact keys', () => {
  it('exposes exactly temperature/land on the plan and three keys on each request', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const { selector } = recordingSelector();
    const factory = createKmaMidtermRequestPlanFactory(clock, selector);

    const plan = factory.createScheduledRequestPlan({
      temperatureRegId: TEMPERATURE_REG_ID,
      landRegId: LAND_REG_ID,
    });

    expect(Object.keys(plan).sort()).toEqual([...PLAN_KEYS].sort());
    expect(Object.keys(plan.temperature).sort()).toEqual([...REQUEST_KEYS].sort());
    expect(Object.keys(plan.land).sort()).toEqual([...REQUEST_KEYS].sort());
    // No execution/orchestration metadata leaks onto the plan.
    for (const forbidden of [
      'referenceEpochMilliseconds',
      'issuance',
      'tmFc',
      'eligible',
      'reason',
      'retryable',
    ] as const) {
      expect(plan).not.toHaveProperty(forbidden);
    }
  });

  it('does not expose an extra runtime property from the caller input (no input spread)', () => {
    const EXTRA_MARKER = 'SECRET_SHAPED_INPUT_MUST_NOT_LEAK_PR100';
    const { clock } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const { selector } = recordingSelector();
    const factory = createKmaMidtermRequestPlanFactory(clock, selector);
    const input = {
      temperatureRegId: TEMPERATURE_REG_ID,
      landRegId: LAND_REG_ID,
      [EXTRA_MARKER]: 'leak-me-if-you-spread-input',
    } as unknown as KmaMidtermRequestPlanFactoryInput;

    const plan = factory.createScheduledRequestPlan(input);

    expect(Object.keys(plan.temperature).sort()).toEqual([...REQUEST_KEYS].sort());
    expect(Object.keys(plan.land).sort()).toEqual([...REQUEST_KEYS].sort());
    expect(JSON.stringify(plan)).not.toContain(EXTRA_MARKER);
  });

  it('does not expose an extra runtime property from the issuance result (no issuance spread)', () => {
    const EXTRA_MARKER = 'SECRET_SHAPED_ISSUANCE_MUST_NOT_LEAK_PR100';
    const { clock } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const issuance = { tmFc: '202607220600', [EXTRA_MARKER]: 'leak' } as unknown as KmaMidtermIssuance;
    const { selector } = recordingSelector(issuance);
    const factory = createKmaMidtermRequestPlanFactory(clock, selector);

    const plan = factory.createScheduledRequestPlan({
      temperatureRegId: TEMPERATURE_REG_ID,
      landRegId: LAND_REG_ID,
    });

    expect(Object.keys(plan.temperature).sort()).toEqual([...REQUEST_KEYS].sort());
    expect(Object.keys(plan.land).sort()).toEqual([...REQUEST_KEYS].sort());
    expect(JSON.stringify(plan)).not.toContain(EXTRA_MARKER);
  });
});

describe('createKmaMidtermRequestPlanFactory — freshness', () => {
  it('returns a fresh, deep-equal plan with distinct references on repeated calls', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const { selector } = recordingSelector();
    const factory = createKmaMidtermRequestPlanFactory(clock, selector);
    const input: KmaMidtermRequestPlanFactoryInput = {
      temperatureRegId: TEMPERATURE_REG_ID,
      landRegId: LAND_REG_ID,
    };

    const first = factory.createScheduledRequestPlan(input);
    const second = factory.createScheduledRequestPlan(input);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.temperature).not.toBe(second.temperature);
    expect(first.land).not.toBe(second.land);
    // Within one plan, temperature and land are distinct object references.
    expect(first.temperature as unknown as KmaMidtermForecastRequest).not.toBe(
      first.land as unknown as KmaMidtermForecastRequest,
    );
  });

  it('is unaffected by mutation of a previously returned plan (no shared singleton/cache)', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const { selector } = recordingSelector();
    const factory = createKmaMidtermRequestPlanFactory(clock, selector);
    const input: KmaMidtermRequestPlanFactoryInput = {
      temperatureRegId: TEMPERATURE_REG_ID,
      landRegId: LAND_REG_ID,
    };

    const first = factory.createScheduledRequestPlan(input);
    (first.temperature as { regId: string }).regId = 'MUTATED';
    (first as { land: unknown }).land = null;

    const second = factory.createScheduledRequestPlan(input);
    expect(second).toEqual({
      temperature: { operation: 'TEMPERATURE', regId: TEMPERATURE_REG_ID, tmFc: '202607220600' },
      land: { operation: 'LAND', regId: LAND_REG_ID, tmFc: '202607220600' },
    });
  });
});

describe('createKmaMidtermRequestPlanFactory — frozen input and issuance', () => {
  it('works with a frozen caller input and a deep-frozen issuance result, mutating neither', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const issuance = deepFreeze(customIssuance());
    const { selector } = recordingSelector(issuance);
    const factory = createKmaMidtermRequestPlanFactory(clock, selector);
    const input = Object.freeze<KmaMidtermRequestPlanFactoryInput>({
      temperatureRegId: TEMPERATURE_REG_ID,
      landRegId: LAND_REG_ID,
    });

    const plan = factory.createScheduledRequestPlan(input);

    expect(plan.temperature).toEqual({
      operation: 'TEMPERATURE',
      regId: TEMPERATURE_REG_ID,
      tmFc: '202607220600',
    });
    // Snapshots of the frozen collaborators are unchanged, and no property was added to them.
    expect(input).toEqual({ temperatureRegId: TEMPERATURE_REG_ID, landRegId: LAND_REG_ID });
    expect(issuance).toEqual(customIssuance());
  });
});

describe('createKmaMidtermRequestPlanFactory — clock error propagation', () => {
  it('propagates the exact clock error, calls the selector zero times, and returns no partial plan', () => {
    const sentinel = new Error('CLOCK_SENTINEL_FOR_IDENTITY');
    const { clock } = throwingClock(sentinel);
    const { selector, calls } = recordingSelector();
    const factory = createKmaMidtermRequestPlanFactory(clock, selector);

    let caught: unknown;
    let returned: unknown;
    try {
      returned = factory.createScheduledRequestPlan({
        temperatureRegId: TEMPERATURE_REG_ID,
        landRegId: LAND_REG_ID,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(sentinel);
    expect(returned).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('logs nothing when the clock throws and leaves a later normal call unaffected', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sentinel = new Error('CLOCK_SILENT');
    const throwing = throwingClock(sentinel);
    const throwingFactory = createKmaMidtermRequestPlanFactory(
      throwing.clock,
      recordingSelector().selector,
    );
    expect(() =>
      throwingFactory.createScheduledRequestPlan({
        temperatureRegId: TEMPERATURE_REG_ID,
        landRegId: LAND_REG_ID,
      }),
    ).toThrow(sentinel);

    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    const healthy = createKmaMidtermRequestPlanFactory(
      fixedClock(kstEpochMs('2026-07-22T05:10:00.000')).clock,
      recordingSelector().selector,
    );
    expect(
      healthy.createScheduledRequestPlan({
        temperatureRegId: TEMPERATURE_REG_ID,
        landRegId: LAND_REG_ID,
      }).temperature.tmFc,
    ).toBe('202607220600');
  });
});

describe('createKmaMidtermRequestPlanFactory — selector error propagation', () => {
  it('reads the clock once, calls the selector once, and propagates the exact error with no partial plan', () => {
    const sentinel = new Error('SELECTOR_SENTINEL_FOR_IDENTITY');
    const { clock, nowEpochMilliseconds } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const { selector, calls } = throwingSelector(sentinel);
    const factory = createKmaMidtermRequestPlanFactory(clock, selector);

    let caught: unknown;
    let returned: unknown;
    try {
      returned = factory.createScheduledRequestPlan({
        temperatureRegId: TEMPERATURE_REG_ID,
        landRegId: LAND_REG_ID,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(sentinel);
    expect(returned).toBeUndefined();
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it('logs nothing when the selector throws and leaves a later normal call unaffected', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { clock } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const { selector } = throwingSelector(new Error('SELECTOR_SILENT'));
    const factory = createKmaMidtermRequestPlanFactory(clock, selector);

    expect(() =>
      factory.createScheduledRequestPlan({
        temperatureRegId: TEMPERATURE_REG_ID,
        landRegId: LAND_REG_ID,
      }),
    ).toThrow();

    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    const healthy = createKmaMidtermRequestPlanFactory(
      fixedClock(kstEpochMs('2026-07-22T05:10:00.000')).clock,
      recordingSelector().selector,
    );
    expect(
      healthy.createScheduledRequestPlan({
        temperatureRegId: TEMPERATURE_REG_ID,
        landRegId: LAND_REG_ID,
      }).temperature.tmFc,
    ).toBe('202607220600');
  });

  it('propagates the default PR #99 selector RangeError for an invalid (NaN) clock epoch', () => {
    const { clock } = fixedClock(Number.NaN);
    const factory = createKmaMidtermRequestPlanFactory(clock);
    expect(() =>
      factory.createScheduledRequestPlan({
        temperatureRegId: TEMPERATURE_REG_ID,
        landRegId: LAND_REG_ID,
      }),
    ).toThrow(RangeError);
  });
});

describe('createKmaMidtermRequestPlanFactory — no provider / network', () => {
  it('returns a synchronous plain object (not a Promise) and logs nothing', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { clock } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const { selector } = recordingSelector();
    const factory = createKmaMidtermRequestPlanFactory(clock, selector);

    const plan = factory.createScheduledRequestPlan({
      temperatureRegId: TEMPERATURE_REG_ID,
      landRegId: LAND_REG_ID,
    });

    expect(plan).not.toBeInstanceOf(Promise);
    expect(typeof (plan as { then?: unknown }).then).not.toBe('function');
    expect(plan.temperature).toBeDefined();
    expect(plan.land).toBeDefined();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
