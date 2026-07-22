import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  KmaForecastProduct,
  type KmaForecastBaseTimeCandidates,
  type SelectKmaForecastBaseTimeCandidatesAfterAvailabilityDelayInput,
} from '@life-weather/weather-core';

import type { KmaForecastRequest } from '../providers/kma';
import type {
  KmaForecastRequestClock,
  KmaForecastRequestFactoryInput,
} from './kma-forecast-request';
import {
  createKmaFallbackRequestPlanFactory,
  type KmaFallbackRequestPlanFactoryInput,
  type KmaForecastBaseTimeCandidatesSelector,
} from './kma-fallback-request-plan';

const SHORT = KmaForecastProduct.SHORT_FORECAST;
const ULTRA = KmaForecastProduct.ULTRA_SHORT_FORECAST;

/** The exact five keys each request must expose, sorted for stable comparison. */
const REQUEST_KEYS = ['baseDate', 'baseTime', 'nx', 'ny', 'product'] as const;
/** The exact two keys the plan wrapper must expose, sorted for stable comparison. */
const PLAN_KEYS = ['previous', 'primary'] as const;
/** The exact two keys the selector input must expose, sorted for stable comparison. */
const SELECTOR_INPUT_KEYS = ['product', 'referenceEpochMilliseconds'] as const;

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
  const clock: KmaForecastRequestClock = { nowEpochMilliseconds };
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
  const clock: KmaForecastRequestClock = { nowEpochMilliseconds };
  return { clock, nowEpochMilliseconds };
}

/** A fresh fake clock whose read throws `error` (the exact reference, for identity checks). */
function throwingClock(error: unknown) {
  const nowEpochMilliseconds = vi.fn((): number => {
    throw error;
  });
  const clock: KmaForecastRequestClock = { nowEpochMilliseconds };
  return { clock, nowEpochMilliseconds };
}

/**
 * A fresh candidate pair distinct from anything the real PR #16 selector would return at a common
 * reference, so a test can prove the factory used *this* selector's result. Freshly built each call.
 */
function customCandidates(): KmaForecastBaseTimeCandidates {
  return {
    primary: { baseDate: '20260722', baseTime: '0500' },
    previous: { baseDate: '20260722', baseTime: '0200' },
  };
}

/**
 * A fresh, test-local injected {@link KmaForecastBaseTimeCandidatesSelector} that records every input
 * it receives (by reference) and returns `result`. The `calls` array is created per invocation of
 * this helper — never a module-scope mutable array or a shared `vi.fn` — so no call history is shared
 * across tests (order-independent under shuffle).
 */
function recordingSelector(result: KmaForecastBaseTimeCandidates = customCandidates()) {
  const calls: SelectKmaForecastBaseTimeCandidatesAfterAvailabilityDelayInput[] = [];
  const selector: KmaForecastBaseTimeCandidatesSelector = (input) => {
    calls.push(input);
    return result;
  };
  return { selector, calls, result };
}

/** A fresh, test-local selector that throws `error` (the exact reference, for identity checks). */
function throwingSelector(error: unknown) {
  const calls: SelectKmaForecastBaseTimeCandidatesAfterAvailabilityDelayInput[] = [];
  const selector: KmaForecastBaseTimeCandidatesSelector = (input) => {
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

describe('createKmaFallbackRequestPlanFactory — construction is side-effect-free', () => {
  it('does not call the clock on construction alone', () => {
    const { clock, nowEpochMilliseconds } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const { selector } = recordingSelector();
    createKmaFallbackRequestPlanFactory(clock, selector);
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
  });

  it('does not call the injected selector on construction alone', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const { selector, calls } = recordingSelector();
    createKmaFallbackRequestPlanFactory(clock, selector);
    expect(calls).toHaveLength(0);
  });

  it('does not call the clock or the default selector on construction alone', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { clock, nowEpochMilliseconds } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    // Default (PR #16) selector path — construction must still touch nothing.
    expect(() => createKmaFallbackRequestPlanFactory(clock)).not.toThrow();
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    // No environment/network/logging on construction.
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('exposes exactly one public method named createFallbackRequestPlan', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const { selector } = recordingSelector();
    const factory = createKmaFallbackRequestPlanFactory(clock, selector);
    expect(Object.keys(factory)).toEqual(['createFallbackRequestPlan']);
    expect(typeof factory.createFallbackRequestPlan).toBe('function');
  });

  it('creates independent instances on repeated construction (no shared state)', () => {
    const { clock: clockA } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const { clock: clockB } = fixedClock(kstEpochMs('2026-07-22T06:45:00.000'));
    const factoryA = createKmaFallbackRequestPlanFactory(clockA, recordingSelector().selector);
    const factoryB = createKmaFallbackRequestPlanFactory(clockB, recordingSelector().selector);
    expect(factoryA).not.toBe(factoryB);
    expect(factoryA.createFallbackRequestPlan).not.toBe(factoryB.createFallbackRequestPlan);
  });

  it('constructs from a frozen clock and a frozen selector reference without calling either', () => {
    const nowEpochMilliseconds = vi.fn(() => kstEpochMs('2026-07-22T05:10:00.000'));
    const clock = Object.freeze({ nowEpochMilliseconds });
    const { selector, calls } = recordingSelector();
    const frozenSelector = Object.freeze(selector);

    const factory = createKmaFallbackRequestPlanFactory(clock, frozenSelector);

    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    // The factory is usable and routes through the injected selector reference.
    const plan = factory.createFallbackRequestPlan({ product: SHORT, nx: 60, ny: 127 });
    expect(plan.primary).toMatchObject({ baseDate: '20260722', baseTime: '0500' });
    expect(calls).toHaveLength(1);
  });
});

describe('createKmaFallbackRequestPlanFactory — custom selector default plan', () => {
  it('assembles primary/previous requests from the selector candidate pair and caller coordinates', () => {
    const epoch = kstEpochMs('2026-07-22T05:10:00.000');
    const { clock, nowEpochMilliseconds } = fixedClock(epoch);
    const { selector, calls } = recordingSelector();
    const factory = createKmaFallbackRequestPlanFactory(clock, selector);
    const input: KmaFallbackRequestPlanFactoryInput = { product: SHORT, nx: 60, ny: 127 };

    const plan = factory.createFallbackRequestPlan(input);

    expect(plan).toEqual({
      primary: {
        product: SHORT,
        baseDate: '20260722',
        baseTime: '0500',
        nx: 60,
        ny: 127,
      },
      previous: {
        product: SHORT,
        baseDate: '20260722',
        baseTime: '0200',
        nx: 60,
        ny: 127,
      },
    });
    // Exactly one clock read and one selector call, with the exact product + epoch forwarded.
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].product).toBe(SHORT);
    expect(calls[0].referenceEpochMilliseconds).toBe(epoch);
  });

  it('does not mutate the caller input or the selector candidate result', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const candidates = deepFreeze(customCandidates());
    const { selector } = recordingSelector(candidates);
    const factory = createKmaFallbackRequestPlanFactory(clock, selector);
    const input = Object.freeze<KmaFallbackRequestPlanFactoryInput>({
      product: SHORT,
      nx: 60,
      ny: 127,
    });
    const inputSnapshot = JSON.stringify(input);
    const candidatesSnapshot = JSON.stringify(candidates);

    factory.createFallbackRequestPlan(input);

    expect(JSON.stringify(input)).toBe(inputSnapshot);
    expect(JSON.stringify(candidates)).toBe(candidatesSnapshot);
  });
});

describe('createKmaFallbackRequestPlanFactory — default PR #16 selector integration', () => {
  // The real (default) PR #16 selector is exercised by OMITTING the second argument. Expected
  // base times are hard-coded literals — never generated by calling the production selector.
  function planAt(kstWallClock: string, input: KmaFallbackRequestPlanFactoryInput) {
    const { clock } = fixedClock(kstEpochMs(kstWallClock));
    const factory = createKmaFallbackRequestPlanFactory(clock);
    return factory.createFallbackRequestPlan(input);
  }

  it('SHORT at 05:10 KST (exact 10-minute threshold): primary 0500 / previous 0200', () => {
    const plan = planAt('2026-07-22T05:10:00.000', { product: SHORT, nx: 60, ny: 127 });
    expect(plan).toEqual({
      primary: { product: SHORT, baseDate: '20260722', baseTime: '0500', nx: 60, ny: 127 },
      previous: { product: SHORT, baseDate: '20260722', baseTime: '0200', nx: 60, ny: 127 },
    });
  });

  it('SHORT one millisecond before threshold: primary 0200 / previous 20260721 2300', () => {
    const plan = planAt('2026-07-22T05:09:59.999', { product: SHORT, nx: 60, ny: 127 });
    expect(plan).toEqual({
      primary: { product: SHORT, baseDate: '20260722', baseTime: '0200', nx: 60, ny: 127 },
      previous: { product: SHORT, baseDate: '20260721', baseTime: '2300', nx: 60, ny: 127 },
    });
  });

  it('SHORT at 02:10 KST (day boundary): primary 0200 / previous 20260721 2300', () => {
    const plan = planAt('2026-07-22T02:10:00.000', { product: SHORT, nx: 60, ny: 127 });
    expect(plan).toEqual({
      primary: { product: SHORT, baseDate: '20260722', baseTime: '0200', nx: 60, ny: 127 },
      previous: { product: SHORT, baseDate: '20260721', baseTime: '2300', nx: 60, ny: 127 },
    });
  });

  it('ULTRA at 06:45 KST (exact 15-minute threshold): primary 0630 / previous 0530', () => {
    const plan = planAt('2026-07-22T06:45:00.000', { product: ULTRA, nx: 55, ny: 124 });
    expect(plan).toEqual({
      primary: { product: ULTRA, baseDate: '20260722', baseTime: '0630', nx: 55, ny: 124 },
      previous: { product: ULTRA, baseDate: '20260722', baseTime: '0530', nx: 55, ny: 124 },
    });
  });

  it('ULTRA one millisecond before threshold: primary 0530 / previous 0430', () => {
    const plan = planAt('2026-07-22T06:44:59.999', { product: ULTRA, nx: 55, ny: 124 });
    expect(plan).toEqual({
      primary: { product: ULTRA, baseDate: '20260722', baseTime: '0530', nx: 55, ny: 124 },
      previous: { product: ULTRA, baseDate: '20260722', baseTime: '0430', nx: 55, ny: 124 },
    });
  });
});

describe('createKmaFallbackRequestPlanFactory — clock is read exactly once per plan', () => {
  it('reads only the first epoch of a sequence clock and calls the selector once per plan', () => {
    const first = kstEpochMs('2026-07-22T05:10:00.000');
    const second = kstEpochMs('2026-07-22T08:10:00.000');
    const { clock, nowEpochMilliseconds } = sequenceClock([first, second]);
    const { selector, calls } = recordingSelector();
    const factory = createKmaFallbackRequestPlanFactory(clock, selector);

    const plan = factory.createFallbackRequestPlan({ product: SHORT, nx: 60, ny: 127 });

    // One plan → clock read exactly once (the second sequence value is never consumed).
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(nowEpochMilliseconds.mock.calls[0]).toEqual([]);
    // Selector called exactly once with that first epoch → primary and previous share one pair.
    expect(calls).toHaveLength(1);
    expect(calls[0].referenceEpochMilliseconds).toBe(first);
    expect(plan.primary.baseTime).toBe('0500');
    expect(plan.previous.baseTime).toBe('0200');
  });

  it('reads a distinct epoch per call across two plans with no state mixing', () => {
    const first = kstEpochMs('2026-07-22T05:10:00.000');
    const second = kstEpochMs('2026-07-22T08:10:00.000');
    const { clock, nowEpochMilliseconds } = sequenceClock([first, second]);
    const { selector, calls } = recordingSelector();
    const factory = createKmaFallbackRequestPlanFactory(clock, selector);

    factory.createFallbackRequestPlan({ product: SHORT, nx: 60, ny: 127 });
    factory.createFallbackRequestPlan({ product: SHORT, nx: 60, ny: 127 });

    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(2);
    expect(calls[0].referenceEpochMilliseconds).toBe(first);
    expect(calls[1].referenceEpochMilliseconds).toBe(second);
  });
});

describe('createKmaFallbackRequestPlanFactory — selector input contract', () => {
  it('passes a selector input whose own keys are exactly product + referenceEpochMilliseconds', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const { selector, calls } = recordingSelector();
    const factory = createKmaFallbackRequestPlanFactory(clock, selector);

    factory.createFallbackRequestPlan({ product: SHORT, nx: 60, ny: 127 });

    expect(Object.keys(calls[0]).sort()).toEqual([...SELECTOR_INPUT_KEYS].sort());
    // No grid coordinate is forwarded into the selector input.
    expect('nx' in calls[0]).toBe(false);
    expect('ny' in calls[0]).toBe(false);
  });

  it('builds a selector input that is a distinct object reference from the caller input', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const { selector, calls } = recordingSelector();
    const factory = createKmaFallbackRequestPlanFactory(clock, selector);
    const input: KmaFallbackRequestPlanFactoryInput = { product: SHORT, nx: 60, ny: 127 };

    factory.createFallbackRequestPlan(input);

    expect(calls[0]).not.toBe(
      input as unknown as SelectKmaForecastBaseTimeCandidatesAfterAvailabilityDelayInput,
    );
  });

  it('does not forward a runtime extra property from the caller input into the selector input', () => {
    const EXTRA_MARKER = 'SECRET_SHAPED_EXTRA_MUST_NOT_LEAK_PR18';
    const { clock } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const { selector, calls } = recordingSelector();
    const factory = createKmaFallbackRequestPlanFactory(clock, selector);
    const input = {
      product: SHORT,
      nx: 60,
      ny: 127,
      [EXTRA_MARKER]: 'leak-me-if-you-spread-input',
    } as unknown as KmaFallbackRequestPlanFactoryInput;

    factory.createFallbackRequestPlan(input);

    expect(Object.keys(calls[0]).sort()).toEqual([...SELECTOR_INPUT_KEYS].sort());
    expect(calls[0]).not.toHaveProperty(EXTRA_MARKER);
  });

  it('forwards the exact clock epoch and product to the selector input', () => {
    const epoch = kstEpochMs('2026-07-22T06:45:00.000');
    const { clock } = fixedClock(epoch);
    const { selector, calls } = recordingSelector();
    const factory = createKmaFallbackRequestPlanFactory(clock, selector);

    factory.createFallbackRequestPlan({ product: ULTRA, nx: 55, ny: 124 });

    expect(calls[0].referenceEpochMilliseconds).toBe(epoch);
    expect(calls[0].product).toBe(ULTRA);
  });

  it('builds a fresh selector input object on every call', () => {
    const { clock } = sequenceClock([
      kstEpochMs('2026-07-22T05:10:00.000'),
      kstEpochMs('2026-07-22T08:10:00.000'),
    ]);
    const { selector, calls } = recordingSelector();
    const factory = createKmaFallbackRequestPlanFactory(clock, selector);

    factory.createFallbackRequestPlan({ product: SHORT, nx: 60, ny: 127 });
    factory.createFallbackRequestPlan({ product: SHORT, nx: 60, ny: 127 });

    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toBe(calls[1]);
  });
});

describe('createKmaFallbackRequestPlanFactory — output exact keys', () => {
  it('exposes exactly primary/previous on the plan and five keys on each request', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const { selector } = recordingSelector();
    const factory = createKmaFallbackRequestPlanFactory(clock, selector);

    const plan = factory.createFallbackRequestPlan({ product: SHORT, nx: 60, ny: 127 });

    expect(Object.keys(plan).sort()).toEqual([...PLAN_KEYS].sort());
    expect(Object.keys(plan.primary).sort()).toEqual([...REQUEST_KEYS].sort());
    expect(Object.keys(plan.previous).sort()).toEqual([...REQUEST_KEYS].sort());
    // No execution/orchestration metadata leaks onto the plan.
    for (const forbidden of [
      'referenceEpochMilliseconds',
      'candidates',
      'candidate',
      'eligible',
      'reason',
      'retryable',
      'fallbackUsed',
      'selected',
      'attempt',
    ] as const) {
      expect(plan).not.toHaveProperty(forbidden);
    }
  });

  it('does not expose an extra runtime property from the caller input (no input spread)', () => {
    const EXTRA_MARKER = 'SECRET_SHAPED_INPUT_MUST_NOT_LEAK_PR18';
    const { clock } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const { selector } = recordingSelector();
    const factory = createKmaFallbackRequestPlanFactory(clock, selector);
    const input = {
      product: SHORT,
      nx: 60,
      ny: 127,
      [EXTRA_MARKER]: 'leak-me-if-you-spread-input',
    } as unknown as KmaFallbackRequestPlanFactoryInput;

    const plan = factory.createFallbackRequestPlan(input);

    expect(Object.keys(plan.primary).sort()).toEqual([...REQUEST_KEYS].sort());
    expect(Object.keys(plan.previous).sort()).toEqual([...REQUEST_KEYS].sort());
    expect(JSON.stringify(plan)).not.toContain(EXTRA_MARKER);
  });

  it('does not expose an extra runtime property from a candidate (no candidate spread)', () => {
    const EXTRA_MARKER = 'SECRET_SHAPED_CANDIDATE_MUST_NOT_LEAK_PR18';
    const { clock } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const candidates = {
      primary: { baseDate: '20260722', baseTime: '0500', [EXTRA_MARKER]: 'leak' },
      previous: { baseDate: '20260722', baseTime: '0200', [EXTRA_MARKER]: 'leak' },
    } as unknown as KmaForecastBaseTimeCandidates;
    const { selector } = recordingSelector(candidates);
    const factory = createKmaFallbackRequestPlanFactory(clock, selector);

    const plan = factory.createFallbackRequestPlan({ product: SHORT, nx: 60, ny: 127 });

    expect(Object.keys(plan.primary).sort()).toEqual([...REQUEST_KEYS].sort());
    expect(Object.keys(plan.previous).sort()).toEqual([...REQUEST_KEYS].sort());
    expect(JSON.stringify(plan)).not.toContain(EXTRA_MARKER);
  });

  it('does not expose the candidate object references on the plan', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const { selector, result } = recordingSelector();
    const factory = createKmaFallbackRequestPlanFactory(clock, selector);

    const plan = factory.createFallbackRequestPlan({ product: SHORT, nx: 60, ny: 127 });

    expect(plan.primary).not.toBe(result.primary as unknown as KmaForecastRequest);
    expect(plan.previous).not.toBe(result.previous as unknown as KmaForecastRequest);
  });
});

describe('createKmaFallbackRequestPlanFactory — freshness', () => {
  it('returns a fresh, deep-equal plan with distinct references on repeated calls', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const { selector } = recordingSelector();
    const factory = createKmaFallbackRequestPlanFactory(clock, selector);
    const input: KmaFallbackRequestPlanFactoryInput = { product: SHORT, nx: 60, ny: 127 };

    const first = factory.createFallbackRequestPlan(input);
    const second = factory.createFallbackRequestPlan(input);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.primary).not.toBe(second.primary);
    expect(first.previous).not.toBe(second.previous);
    // Within one plan, primary and previous are distinct object references.
    expect(first.primary).not.toBe(first.previous as unknown as KmaForecastRequest);
  });

  it('is unaffected by mutation of a previously returned plan (no shared singleton/cache)', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const { selector } = recordingSelector();
    const factory = createKmaFallbackRequestPlanFactory(clock, selector);
    const input: KmaFallbackRequestPlanFactoryInput = { product: SHORT, nx: 60, ny: 127 };

    const first = factory.createFallbackRequestPlan(input);
    (first.primary as { baseDate: string; nx: number }).baseDate = 'MUTATED';
    (first.primary as { baseDate: string; nx: number }).nx = -999;
    (first as { previous: unknown }).previous = null;

    const second = factory.createFallbackRequestPlan(input);
    expect(second).toEqual({
      primary: { product: SHORT, baseDate: '20260722', baseTime: '0500', nx: 60, ny: 127 },
      previous: { product: SHORT, baseDate: '20260722', baseTime: '0200', nx: 60, ny: 127 },
    });
  });
});

describe('createKmaFallbackRequestPlanFactory — frozen input and candidate', () => {
  it('works with a frozen caller input and a deep-frozen candidate result, mutating neither', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const candidates = deepFreeze(customCandidates());
    const { selector } = recordingSelector(candidates);
    const factory = createKmaFallbackRequestPlanFactory(clock, selector);
    const input = Object.freeze<KmaFallbackRequestPlanFactoryInput>({
      product: SHORT,
      nx: 60,
      ny: 127,
    });

    const plan = factory.createFallbackRequestPlan(input);

    expect(plan.primary).toEqual({
      product: SHORT,
      baseDate: '20260722',
      baseTime: '0500',
      nx: 60,
      ny: 127,
    });
    // Snapshots of the frozen collaborators are unchanged, and no property was added to them.
    expect(input).toEqual({ product: SHORT, nx: 60, ny: 127 });
    expect(candidates).toEqual(customCandidates());
    expect(candidates.primary).toEqual({ baseDate: '20260722', baseTime: '0500' });
    expect(candidates.previous).toEqual({ baseDate: '20260722', baseTime: '0200' });
  });
});

describe('createKmaFallbackRequestPlanFactory — coordinate pass-through', () => {
  // The factory is not the provider validation boundary: it passes nx/ny through verbatim and never
  // rounds/clamps/defaults/coerces, and never throws for an out-of-domain coordinate. The real
  // provider still owns validation when a request is actually sent.
  const CASES: ReadonlyArray<{ label: string; nx: number; ny: number }> = [
    { label: 'ordinary grid values', nx: 60, ny: 127 },
    { label: 'boundary typed integers', nx: 0, ny: Number.MAX_SAFE_INTEGER },
    { label: 'runtime fractional values', nx: 60.5, ny: 127.25 },
    { label: 'runtime negative values', nx: -60, ny: -127 },
  ];

  for (const { label, nx, ny } of CASES) {
    it(`preserves ${label} verbatim without transformation`, () => {
      const { clock } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
      const { selector } = recordingSelector();
      const factory = createKmaFallbackRequestPlanFactory(clock, selector);

      const plan = factory.createFallbackRequestPlan({ product: SHORT, nx, ny });

      expect(plan.primary.nx).toBe(nx);
      expect(plan.primary.ny).toBe(ny);
      expect(plan.previous.nx).toBe(nx);
      expect(plan.previous.ny).toBe(ny);
    });
  }

  it('passes NaN and Infinity through verbatim without throwing', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const { selector } = recordingSelector();
    const factory = createKmaFallbackRequestPlanFactory(clock, selector);

    const plan = factory.createFallbackRequestPlan({
      product: SHORT,
      nx: Number.NaN,
      ny: Number.POSITIVE_INFINITY,
    });

    expect(Number.isNaN(plan.primary.nx)).toBe(true);
    expect(plan.primary.ny).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isNaN(plan.previous.nx)).toBe(true);
    expect(plan.previous.ny).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('createKmaFallbackRequestPlanFactory — clock error propagation', () => {
  it('propagates the exact clock error, calls the selector zero times, and returns no partial plan', () => {
    const sentinel = new Error('CLOCK_SENTINEL_FOR_IDENTITY');
    const { clock } = throwingClock(sentinel);
    const { selector, calls } = recordingSelector();
    const factory = createKmaFallbackRequestPlanFactory(clock, selector);

    let caught: unknown;
    let returned: unknown;
    try {
      returned = factory.createFallbackRequestPlan({ product: SHORT, nx: 60, ny: 127 });
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
    // First call throws; a fresh healthy factory then succeeds (no cross-call state).
    const throwing = throwingClock(sentinel);
    const throwingFactory = createKmaFallbackRequestPlanFactory(
      throwing.clock,
      recordingSelector().selector,
    );
    expect(() =>
      throwingFactory.createFallbackRequestPlan({ product: SHORT, nx: 60, ny: 127 }),
    ).toThrow(sentinel);

    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    const healthy = createKmaFallbackRequestPlanFactory(
      fixedClock(kstEpochMs('2026-07-22T05:10:00.000')).clock,
      recordingSelector().selector,
    );
    expect(
      healthy.createFallbackRequestPlan({ product: SHORT, nx: 60, ny: 127 }).primary.baseTime,
    ).toBe('0500');
  });
});

describe('createKmaFallbackRequestPlanFactory — selector error propagation', () => {
  it('reads the clock once, calls the selector once, and propagates the exact error with no partial plan', () => {
    const sentinel = new Error('SELECTOR_SENTINEL_FOR_IDENTITY');
    const { clock, nowEpochMilliseconds } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const { selector, calls } = throwingSelector(sentinel);
    const factory = createKmaFallbackRequestPlanFactory(clock, selector);

    let caught: unknown;
    let returned: unknown;
    try {
      returned = factory.createFallbackRequestPlan({ product: SHORT, nx: 60, ny: 127 });
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
    const factory = createKmaFallbackRequestPlanFactory(clock, selector);

    expect(() =>
      factory.createFallbackRequestPlan({ product: SHORT, nx: 60, ny: 127 }),
    ).toThrow();

    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    const healthy = createKmaFallbackRequestPlanFactory(
      fixedClock(kstEpochMs('2026-07-22T05:10:00.000')).clock,
      recordingSelector().selector,
    );
    expect(
      healthy.createFallbackRequestPlan({ product: SHORT, nx: 60, ny: 127 }).primary.baseTime,
    ).toBe('0500');
  });

  it('propagates the default PR #16 selector RangeError for an unsupported product (runtime cast)', () => {
    const PRODUCT_MARKER = 'SECRET_SHAPED_PRODUCT_MUST_NOT_LEAK_PR18';
    const { clock, nowEpochMilliseconds } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    // Default (PR #16) selector path — no injected selector.
    const factory = createKmaFallbackRequestPlanFactory(clock);

    let caught: unknown;
    try {
      factory.createFallbackRequestPlan({
        product: PRODUCT_MARKER as unknown as KmaForecastProduct,
        nx: 60,
        ny: 127,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RangeError);
    expect((caught as Error).message).not.toContain(PRODUCT_MARKER);
    // The clock is still read exactly once before the selector rejects the product.
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
  });

  it('propagates the default PR #16 selector RangeError for an invalid (NaN) clock epoch', () => {
    const { clock } = fixedClock(Number.NaN);
    const factory = createKmaFallbackRequestPlanFactory(clock);
    expect(() =>
      factory.createFallbackRequestPlan({ product: SHORT, nx: 60, ny: 127 }),
    ).toThrow(RangeError);
  });
});

describe('createKmaFallbackRequestPlanFactory — no classifier / service / network', () => {
  it('returns a synchronous plain object (not a Promise) and logs nothing', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { clock } = fixedClock(kstEpochMs('2026-07-22T05:10:00.000'));
    const { selector } = recordingSelector();
    const factory = createKmaFallbackRequestPlanFactory(clock, selector);

    const plan = factory.createFallbackRequestPlan({ product: SHORT, nx: 60, ny: 127 });

    expect(plan).not.toBeInstanceOf(Promise);
    expect(typeof (plan as { then?: unknown }).then).not.toBe('function');
    expect(plan.primary).toBeDefined();
    expect(plan.previous).toBeDefined();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
