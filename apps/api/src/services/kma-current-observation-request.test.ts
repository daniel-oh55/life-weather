import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KmaCurrentObservationRequest } from '../providers/kma/index.js';
import {
  createKmaCurrentObservationRequestFactory,
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
