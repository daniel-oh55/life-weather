import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SelectLatestKmaCurrentObservationBaseTimeInput } from '@life-weather/weather-core';

import type { KmaCurrentObservationRequest } from '../providers/kma/index.js';
import { validateKmaCurrentObservationRequest } from '../providers/kma/current-request.js';
import {
  createKmaCurrentObservationRequestFactory,
  type KmaCurrentObservationBaseTimeSelector,
  type KmaCurrentObservationRequestClock,
  type KmaCurrentObservationRequestFactoryInput,
} from './kma-current-observation-request.js';

/** The exact four keys a request must expose, sorted for stable comparison. */
const REQUEST_KEYS = ['baseDate', 'baseTime', 'nx', 'ny'] as const;

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
  const clock: KmaCurrentObservationRequestClock = { nowEpochMilliseconds };
  return { clock, nowEpochMilliseconds };
}

/** A fresh fake clock that returns the next value in `values` on each successive call. */
function sequenceClock(values: readonly number[]) {
  let index = 0;
  const nowEpochMilliseconds = vi.fn(() => {
    const value = values[index];
    index += 1;
    return value;
  });
  const clock: KmaCurrentObservationRequestClock = { nowEpochMilliseconds };
  return { clock, nowEpochMilliseconds };
}

/** A fresh fake clock whose read throws `error` (the exact reference, for identity checks). */
function throwingClock(error: unknown) {
  const nowEpochMilliseconds = vi.fn((): number => {
    throw error;
  });
  const clock: KmaCurrentObservationRequestClock = { nowEpochMilliseconds };
  return { clock, nowEpochMilliseconds };
}

/**
 * A fresh, test-local injected {@link KmaCurrentObservationBaseTimeSelector} that records every
 * input it receives (by reference) and returns `result`. The `calls` array is created per
 * invocation of this helper — never a module-scope mutable array or a shared `vi.fn` — so no call
 * history is shared across tests (order-independent under shuffle). The default `result` is
 * deliberately distinct from anything the real PR #64 selector would return, so a test can prove
 * the factory used *this* result.
 */
function recordingSelector(
  result: { baseDate: string; baseTime: string } = {
    baseDate: '20200101',
    baseTime: '1234',
  },
) {
  const calls: SelectLatestKmaCurrentObservationBaseTimeInput[] = [];
  const selector: KmaCurrentObservationBaseTimeSelector = (input) => {
    calls.push(input);
    return result;
  };
  return { selector, calls, result };
}

/** A fresh, test-local selector that throws `error` (the exact reference, for identity checks). */
function throwingSelector(error: unknown) {
  const calls: SelectLatestKmaCurrentObservationBaseTimeInput[] = [];
  const selector: KmaCurrentObservationBaseTimeSelector = (input) => {
    calls.push(input);
    throw error;
  };
  return { selector, calls };
}

// Safety net: restore any console (or other) spy even if an assertion in the test that installed it
// throws before its explicit `mockRestore()` runs. Applies to every describe block below.
afterEach(() => {
  vi.restoreAllMocks();
});

describe('createKmaCurrentObservationRequestFactory — construction is side-effect-free', () => {
  it('does not call the clock on construction alone', () => {
    const { clock, nowEpochMilliseconds } = fixedClock(kstEpochMs('2026-07-17T05:00:00.000'));
    createKmaCurrentObservationRequestFactory(clock);
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
  });

  it('does not throw on construction alone', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-17T05:00:00.000'));
    expect(() => createKmaCurrentObservationRequestFactory(clock)).not.toThrow();
  });

  it('works with a frozen clock object', () => {
    const nowEpochMilliseconds = vi.fn(() => kstEpochMs('2026-07-17T05:00:00.000'));
    const clock = Object.freeze({ nowEpochMilliseconds });
    const factory = createKmaCurrentObservationRequestFactory(clock);
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    const result = factory.createScheduledRequest({ nx: 60, ny: 127 });
    expect(result).toEqual({
      baseDate: '20260717',
      baseTime: '0500',
      nx: 60,
      ny: 127,
    });
  });

  it('reuses one instance across many calls with no shared mutable state', () => {
    const { clock, nowEpochMilliseconds } = fixedClock(kstEpochMs('2026-07-17T14:30:00.000'));
    const factory = createKmaCurrentObservationRequestFactory(clock);
    const first = factory.createScheduledRequest({ nx: 60, ny: 127 });
    const second = factory.createScheduledRequest({ nx: 60, ny: 127 });
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(2);
  });

  it('keeps two factories independent (no global mutable state)', () => {
    const firstFactory = createKmaCurrentObservationRequestFactory(
      fixedClock(kstEpochMs('2026-07-17T05:00:00.000')).clock,
    );
    const secondFactory = createKmaCurrentObservationRequestFactory(
      fixedClock(kstEpochMs('2026-07-17T12:00:00.000')).clock,
    );
    expect(firstFactory.createScheduledRequest({ nx: 60, ny: 127 })).toEqual({
      baseDate: '20260717',
      baseTime: '0500',
      nx: 60,
      ny: 127,
    });
    expect(secondFactory.createScheduledRequest({ nx: 55, ny: 124 })).toEqual({
      baseDate: '20260717',
      baseTime: '1200',
      nx: 55,
      ny: 124,
    });
  });
});

describe('createKmaCurrentObservationRequestFactory — clock is read exactly once per request', () => {
  it('reads the clock exactly once, with no argument, per createScheduledRequest call', () => {
    const { clock, nowEpochMilliseconds } = fixedClock(kstEpochMs('2026-07-17T05:00:00.000'));
    const factory = createKmaCurrentObservationRequestFactory(clock);
    factory.createScheduledRequest({ nx: 60, ny: 127 });
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(nowEpochMilliseconds.mock.calls[0]).toEqual([]);
  });

  it('forwards the exact clock value to the selector (sequence clock across two calls)', () => {
    const { clock, nowEpochMilliseconds } = sequenceClock([
      kstEpochMs('2026-07-17T04:59:59.999'),
      kstEpochMs('2026-07-17T05:00:00.000'),
    ]);
    const factory = createKmaCurrentObservationRequestFactory(clock);

    const first = factory.createScheduledRequest({ nx: 60, ny: 127 });
    const second = factory.createScheduledRequest({ nx: 60, ny: 127 });

    // One millisecond before 05:00 selects the previous on-the-hour issuance; exactly 05:00
    // selects it.
    expect(first).toMatchObject({ baseDate: '20260717', baseTime: '0400' });
    expect(second).toMatchObject({ baseDate: '20260717', baseTime: '0500' });
    // Two requests → exactly two clock reads (one per request, never twice within a call).
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(2);
  });
});

describe('createKmaCurrentObservationRequestFactory — request assembly', () => {
  it('assembles a complete request from the real PR #64 selector', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-17T05:00:00.000'));
    const factory = createKmaCurrentObservationRequestFactory(clock);
    const input: KmaCurrentObservationRequestFactoryInput = { nx: 60, ny: 127 };

    const result = factory.createScheduledRequest(input);

    expect(result).toEqual({
      baseDate: '20260717',
      baseTime: '0500',
      nx: 60,
      ny: 127,
    });
    // Exactly the four request fields, nothing more.
    expect(Object.keys(result).sort()).toEqual([...REQUEST_KEYS].sort());
    // Assignable to the provider-boundary request type, and a distinct object from the input.
    const request: KmaCurrentObservationRequest = result;
    expect(request.nx).toBe(60);
    expect(result).not.toBe(input as unknown as KmaCurrentObservationRequest);
  });

  it('rolls over to the previous KST day just before midnight', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-01T00:00:00.000') - 1);
    const factory = createKmaCurrentObservationRequestFactory(clock);

    const result = factory.createScheduledRequest({ nx: 55, ny: 124 });

    expect(result).toEqual({
      baseDate: '20260630',
      baseTime: '2300',
      nx: 55,
      ny: 124,
    });
  });

  it('selects the on-the-hour issuance exactly at midnight (no rollover needed)', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-01T00:00:00.000'));
    const factory = createKmaCurrentObservationRequestFactory(clock);

    const result = factory.createScheduledRequest({ nx: 55, ny: 124 });

    expect(result).toEqual({
      baseDate: '20260701',
      baseTime: '0000',
      nx: 55,
      ny: 124,
    });
  });
});

describe('createKmaCurrentObservationRequestFactory — input and output safety', () => {
  it('works with a frozen input and never mutates it', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-17T05:00:00.000'));
    const factory = createKmaCurrentObservationRequestFactory(clock);
    const input = Object.freeze<KmaCurrentObservationRequestFactoryInput>({ nx: 60, ny: 127 });
    const snapshot = JSON.stringify(input);

    const result = factory.createScheduledRequest(input);

    expect(JSON.stringify(input)).toBe(snapshot);
    // The caller-supplied fields are preserved verbatim.
    expect(result.nx).toBe(input.nx);
    expect(result.ny).toBe(input.ny);
  });

  it('returns a fresh object per call; same input + same clock value → deep-equal but distinct', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-17T14:30:00.000'));
    const factory = createKmaCurrentObservationRequestFactory(clock);
    const input: KmaCurrentObservationRequestFactoryInput = { nx: 60, ny: 127 };

    const first = factory.createScheduledRequest(input);
    const second = factory.createScheduledRequest(input);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it('mutating a previous result (runtime cast) does not affect the next call', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-17T14:30:00.000'));
    const factory = createKmaCurrentObservationRequestFactory(clock);
    const input: KmaCurrentObservationRequestFactoryInput = { nx: 60, ny: 127 };

    const first = factory.createScheduledRequest(input);
    (first as { baseDate: string; nx: number }).baseDate = 'MUTATED';
    (first as { baseDate: string; nx: number }).nx = -999;

    const second = factory.createScheduledRequest(input);
    expect(second).toEqual({
      baseDate: '20260717',
      baseTime: '1400',
      nx: 60,
      ny: 127,
    });
  });

  it('does not leak a runtime extra property from the input (no object spread)', () => {
    const EXTRA_MARKER = 'SECRET_SHAPED_EXTRA_MUST_NOT_LEAK_PR66';
    const { clock } = fixedClock(kstEpochMs('2026-07-17T05:00:00.000'));
    const factory = createKmaCurrentObservationRequestFactory(clock);
    const input = {
      nx: 60,
      ny: 127,
      [EXTRA_MARKER]: 'leak-me-if-you-spread-input',
    } as unknown as KmaCurrentObservationRequestFactoryInput;

    const result = factory.createScheduledRequest(input);

    // Exactly the four request fields — the marker key and value never survive.
    expect(Object.keys(result).sort()).toEqual([...REQUEST_KEYS].sort());
    expect(result).not.toHaveProperty(EXTRA_MARKER);
    expect(JSON.stringify(result)).not.toContain(EXTRA_MARKER);
    expect(JSON.stringify(result)).not.toContain('leak-me-if-you-spread-input');
  });

  it('does not accumulate state across alternating calls with different grid points', () => {
    const factory = createKmaCurrentObservationRequestFactory(
      fixedClock(kstEpochMs('2026-07-17T14:30:00.000')).clock,
    );
    const runFirstGrid = () => factory.createScheduledRequest({ nx: 60, ny: 127 });
    const runSecondGrid = () => factory.createScheduledRequest({ nx: 55, ny: 124 });

    const expectedFirst = { baseDate: '20260717', baseTime: '1400', nx: 60, ny: 127 };
    const expectedSecond = { baseDate: '20260717', baseTime: '1400', nx: 55, ny: 124 };
    expect(runFirstGrid()).toEqual(expectedFirst);
    expect(runSecondGrid()).toEqual(expectedSecond);
    expect(runFirstGrid()).toEqual(expectedFirst);
    expect(runSecondGrid()).toEqual(expectedSecond);
  });
});

describe('createKmaCurrentObservationRequestFactory — error propagation', () => {
  it('propagates the selector RangeError for a NaN clock value (no new result union)', () => {
    const { clock } = fixedClock(Number.NaN);
    const factory = createKmaCurrentObservationRequestFactory(clock);
    expect(() => factory.createScheduledRequest({ nx: 60, ny: 127 })).toThrow(RangeError);
  });

  it('throws a value-free RangeError (not TypeError) for a non-number clock value', () => {
    const CLOCK_MARKER = 'SECRET_SHAPED_CLOCK_VALUE_MUST_NOT_LEAK_PR66';
    const nowEpochMilliseconds = vi.fn(() => CLOCK_MARKER as unknown as number);
    const factory = createKmaCurrentObservationRequestFactory({ nowEpochMilliseconds });

    let caught: unknown;
    try {
      factory.createScheduledRequest({ nx: 60, ny: 127 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RangeError);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect((caught as Error).message).not.toContain(CLOCK_MARKER);
  });

  it('propagates a value-free RangeError for an out-of-range KST year, reading the clock once', () => {
    const { clock, nowEpochMilliseconds } = fixedClock(kstEpochMs('1000-01-01T00:00:00.000') - 1);
    const factory = createKmaCurrentObservationRequestFactory(clock);

    let caught: unknown;
    try {
      factory.createScheduledRequest({ nx: 60, ny: 127 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RangeError);
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
  });

  it('propagates the exact error the clock throws (same reference, no wrapping, no request)', () => {
    const sentinel = new Error('CLOCK_SENTINEL_FOR_IDENTITY');
    const { clock } = throwingClock(sentinel);
    const factory = createKmaCurrentObservationRequestFactory(clock);

    let caught: unknown;
    let returned: KmaCurrentObservationRequest | undefined;
    try {
      returned = factory.createScheduledRequest({ nx: 60, ny: 127 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(sentinel);
    expect(returned).toBeUndefined();
  });

  it('logs nothing when the clock throws', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { clock } = throwingClock(new Error('CLOCK_SILENT'));
    const factory = createKmaCurrentObservationRequestFactory(clock);

    expect(() => factory.createScheduledRequest({ nx: 60, ny: 127 })).toThrow();

    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    log.mockRestore();
    error.mockRestore();
    warn.mockRestore();
  });
});

describe('createKmaCurrentObservationRequestFactory — injected selector: construction is side-effect-free', () => {
  it('does not call the injected selector on construction alone', () => {
    const { clock, nowEpochMilliseconds } = fixedClock(kstEpochMs('2026-07-18T05:00:00.000'));
    const { selector, calls } = recordingSelector();
    createKmaCurrentObservationRequestFactory(clock, selector);
    expect(calls).toHaveLength(0);
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
  });

  it('constructs from a frozen clock and a frozen selector reference without calling either', () => {
    const nowEpochMilliseconds = vi.fn(() => kstEpochMs('2026-07-18T05:00:00.000'));
    const clock = Object.freeze({ nowEpochMilliseconds });
    const { selector, calls } = recordingSelector();
    const frozenSelector = Object.freeze(selector);

    const factory = createKmaCurrentObservationRequestFactory(clock, frozenSelector);

    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    // The factory is usable and routes through the injected selector reference.
    const result = factory.createScheduledRequest({ nx: 60, ny: 127 });
    expect(result).toMatchObject({ baseDate: '20200101', baseTime: '1234' });
    expect(calls).toHaveLength(1);
  });

  it('does not mutate the injected selector reference', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-18T05:00:00.000'));
    const { selector } = recordingSelector();
    const before = { ...(selector as unknown as Record<string, unknown>) };
    const factory = createKmaCurrentObservationRequestFactory(clock, selector);
    factory.createScheduledRequest({ nx: 60, ny: 127 });
    expect({ ...(selector as unknown as Record<string, unknown>) }).toEqual(before);
  });
});

describe('createKmaCurrentObservationRequestFactory — injected selector: input contract', () => {
  it('calls the selector exactly once per request', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-18T05:00:00.000'));
    const { selector, calls } = recordingSelector();
    const factory = createKmaCurrentObservationRequestFactory(clock, selector);
    factory.createScheduledRequest({ nx: 60, ny: 127 });
    expect(calls).toHaveLength(1);
  });

  it('passes a selector input whose own keys are exactly referenceEpochMilliseconds', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-18T05:00:00.000'));
    const { selector, calls } = recordingSelector();
    const factory = createKmaCurrentObservationRequestFactory(clock, selector);

    factory.createScheduledRequest({ nx: 60, ny: 127 });

    expect(Object.keys(calls[0]).sort()).toEqual(['referenceEpochMilliseconds']);
    // No grid coordinate and no product is forwarded into the selector input.
    expect('nx' in calls[0]).toBe(false);
    expect('ny' in calls[0]).toBe(false);
    expect('product' in calls[0]).toBe(false);
  });

  it('does not forward a runtime extra property from the factory input into the selector input', () => {
    const EXTRA_MARKER = 'SECRET_SHAPED_EXTRA_MUST_NOT_LEAK_PR66_FIX';
    const { clock } = fixedClock(kstEpochMs('2026-07-18T05:00:00.000'));
    const { selector, calls } = recordingSelector();
    const factory = createKmaCurrentObservationRequestFactory(clock, selector);
    const input = {
      nx: 60,
      ny: 127,
      [EXTRA_MARKER]: 'leak-me-if-you-spread-input',
    } as unknown as KmaCurrentObservationRequestFactoryInput;

    factory.createScheduledRequest(input);

    expect(Object.keys(calls[0]).sort()).toEqual(['referenceEpochMilliseconds']);
    expect(calls[0]).not.toHaveProperty(EXTRA_MARKER);
  });

  it('builds a selector input that is a distinct object reference from the factory input', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-18T05:00:00.000'));
    const { selector, calls } = recordingSelector();
    const factory = createKmaCurrentObservationRequestFactory(clock, selector);
    const input: KmaCurrentObservationRequestFactoryInput = { nx: 60, ny: 127 };

    factory.createScheduledRequest(input);

    expect(calls[0]).not.toBe(input as unknown as SelectLatestKmaCurrentObservationBaseTimeInput);
  });

  it('forwards the exact clock value to the selector input', () => {
    const epoch = kstEpochMs('2026-07-18T05:00:00.000');
    const { clock } = fixedClock(epoch);
    const { selector, calls } = recordingSelector();
    const factory = createKmaCurrentObservationRequestFactory(clock, selector);

    factory.createScheduledRequest({ nx: 55, ny: 124 });

    expect(calls[0].referenceEpochMilliseconds).toBe(epoch);
  });

  it('builds a fresh selector input object on every call', () => {
    const { clock } = sequenceClock([
      kstEpochMs('2026-07-18T05:00:00.000'),
      kstEpochMs('2026-07-18T06:00:00.000'),
    ]);
    const { selector, calls } = recordingSelector();
    const factory = createKmaCurrentObservationRequestFactory(clock, selector);

    factory.createScheduledRequest({ nx: 60, ny: 127 });
    factory.createScheduledRequest({ nx: 60, ny: 127 });

    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toBe(calls[1]);
  });
});

describe('createKmaCurrentObservationRequestFactory — injected selector: output contract', () => {
  it("uses the selector's baseDate/baseTime verbatim in the request", () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-18T05:00:00.000'));
    const { selector } = recordingSelector({ baseDate: '20191231', baseTime: '2359' });
    const factory = createKmaCurrentObservationRequestFactory(clock, selector);

    const result = factory.createScheduledRequest({ nx: 60, ny: 127 });

    expect(result).toEqual({
      baseDate: '20191231',
      baseTime: '2359',
      nx: 60,
      ny: 127,
    });
    expect(Object.keys(result).sort()).toEqual([...REQUEST_KEYS].sort());
  });

  it('does not expose an extra runtime property from the selector result', () => {
    const EXTRA_MARKER = 'SECRET_SHAPED_SELECTOR_RESULT_MUST_NOT_LEAK_PR66_FIX';
    const { clock } = fixedClock(kstEpochMs('2026-07-18T05:00:00.000'));
    // A selector whose result carries an extra runtime key beyond baseDate/baseTime.
    const selector: KmaCurrentObservationBaseTimeSelector = () =>
      ({
        baseDate: '20260718',
        baseTime: '0200',
        [EXTRA_MARKER]: 'leak-me-if-you-spread-result',
      }) as unknown as ReturnType<KmaCurrentObservationBaseTimeSelector>;
    const factory = createKmaCurrentObservationRequestFactory(clock, selector);

    const result = factory.createScheduledRequest({ nx: 60, ny: 127 });

    expect(Object.keys(result).sort()).toEqual([...REQUEST_KEYS].sort());
    expect(result).not.toHaveProperty(EXTRA_MARKER);
    expect(JSON.stringify(result)).not.toContain(EXTRA_MARKER);
  });

  it('works with a frozen selector result and never mutates it', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-18T05:00:00.000'));
    const frozenResult = Object.freeze({ baseDate: '20260718', baseTime: '0200' });
    const selector: KmaCurrentObservationBaseTimeSelector = () => frozenResult;
    const factory = createKmaCurrentObservationRequestFactory(clock, selector);

    const result = factory.createScheduledRequest({ nx: 60, ny: 127 });

    expect(result).toMatchObject({ baseDate: '20260718', baseTime: '0200' });
    // The selector's result object is left exactly as it was returned.
    expect(frozenResult).toEqual({ baseDate: '20260718', baseTime: '0200' });
  });
});

describe('createKmaCurrentObservationRequestFactory — injected selector: error propagation', () => {
  it('does not call the selector when the clock throws', () => {
    const sentinel = new Error('CLOCK_SENTINEL_BEFORE_SELECTOR');
    const { clock } = throwingClock(sentinel);
    const { selector, calls } = recordingSelector();
    const factory = createKmaCurrentObservationRequestFactory(clock, selector);

    let caught: unknown;
    try {
      factory.createScheduledRequest({ nx: 60, ny: 127 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(sentinel);
    expect(calls).toHaveLength(0);
  });

  it('propagates the exact error the selector throws after reading the clock once', () => {
    const sentinel = new Error('SELECTOR_SENTINEL_FOR_IDENTITY');
    const { clock, nowEpochMilliseconds } = fixedClock(kstEpochMs('2026-07-18T05:00:00.000'));
    const { selector } = throwingSelector(sentinel);
    const factory = createKmaCurrentObservationRequestFactory(clock, selector);

    let caught: unknown;
    let returned: KmaCurrentObservationRequest | undefined;
    try {
      returned = factory.createScheduledRequest({ nx: 60, ny: 127 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(sentinel);
    expect(returned).toBeUndefined();
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
  });

  it('propagates a selector RangeError by the same reference (no new result union)', () => {
    const sentinel = new RangeError('SELECTOR_RANGE_ERROR_FOR_IDENTITY');
    const { clock } = fixedClock(kstEpochMs('2026-07-18T05:00:00.000'));
    const { selector } = throwingSelector(sentinel);
    const factory = createKmaCurrentObservationRequestFactory(clock, selector);

    let caught: unknown;
    try {
      factory.createScheduledRequest({ nx: 60, ny: 127 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(sentinel);
  });

  it('logs nothing when the selector throws', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { clock } = fixedClock(kstEpochMs('2026-07-18T05:00:00.000'));
    const { selector } = throwingSelector(new Error('SELECTOR_SILENT'));
    const factory = createKmaCurrentObservationRequestFactory(clock, selector);

    expect(() => factory.createScheduledRequest({ nx: 60, ny: 127 })).toThrow();

    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    log.mockRestore();
    error.mockRestore();
    warn.mockRestore();
  });
});

describe('createKmaCurrentObservationRequestFactory — default selector behaviour is unchanged', () => {
  it('uses the PR #64 schedule-only selector when baseTimeSelector is omitted', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-17T05:00:00.000'));
    const factory = createKmaCurrentObservationRequestFactory(clock);

    const result = factory.createScheduledRequest({ nx: 60, ny: 127 });

    expect(result).toEqual({
      baseDate: '20260717',
      baseTime: '0500',
      nx: 60,
      ny: 127,
    });
  });
});

describe('createKmaCurrentObservationRequestFactory — invalid coordinates pass through unchanged', () => {
  it('preserves out-of-range nx/ny verbatim — no clamp, coercion, swap, default, or throw', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-18T05:00:00.000'));
    const { selector } = recordingSelector({ baseDate: '20260718', baseTime: '0500' });
    const factory = createKmaCurrentObservationRequestFactory(clock, selector);
    // 0 and 254 both fall outside the provider's valid [1, 149] x [1, 253] grid range.
    const input: KmaCurrentObservationRequestFactoryInput = { nx: 0, ny: 254 };

    expect(() => factory.createScheduledRequest(input)).not.toThrow();
    const result = factory.createScheduledRequest(input);

    expect(result).toEqual({
      baseDate: '20260718',
      baseTime: '0500',
      nx: 0,
      ny: 254,
    });
    expect(Object.keys(result).sort()).toEqual([...REQUEST_KEYS].sort());
    expect(JSON.stringify(input)).toBe(JSON.stringify({ nx: 0, ny: 254 }));
  });
});

describe('createKmaCurrentObservationRequestFactory — provider validator compatibility', () => {
  it('produces a default-factory request that the provider validator accepts directly', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-17T05:00:00.000'));
    const factory = createKmaCurrentObservationRequestFactory(clock);

    const request = factory.createScheduledRequest({ nx: 60, ny: 127 });

    expect(validateKmaCurrentObservationRequest(request)).toEqual({ ok: true });
  });
});
