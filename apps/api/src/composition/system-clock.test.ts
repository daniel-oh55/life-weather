import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KmaForecastRequestClock } from '../services';
import { createKmaSystemClock } from './system-clock';

/**
 * Install a fresh `Date.now` spy for a single test. Each test owns its spy and restores it (both
 * explicitly below and via the `afterEach` safety net), so no state leaks across tests and the suite
 * is order-independent. No fake timers are used — `Date.now` is spied directly.
 */
function spyOnDateNow() {
  return vi.spyOn(Date, 'now');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createKmaSystemClock — construction reads no time', () => {
  it('does not call Date.now on construction alone', () => {
    const spy = spyOnDateNow().mockReturnValue(1_752_800_000_000);
    createKmaSystemClock();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('returns an object exposing nowEpochMilliseconds', () => {
    const spy = spyOnDateNow().mockReturnValue(1_752_800_000_000);
    const clock: KmaForecastRequestClock = createKmaSystemClock();
    expect(typeof clock.nowEpochMilliseconds).toBe('function');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('createKmaSystemClock — reading the clock', () => {
  it('calls Date.now exactly once per read', () => {
    const spy = spyOnDateNow().mockReturnValue(1_752_800_000_000);
    const clock = createKmaSystemClock();
    clock.nowEpochMilliseconds();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('passes no argument to Date.now', () => {
    const spy = spyOnDateNow().mockReturnValue(1_752_800_000_000);
    const clock = createKmaSystemClock();
    clock.nowEpochMilliseconds();
    expect(spy.mock.calls[0]).toHaveLength(0);
    spy.mockRestore();
  });

  it('returns the exact Date.now value verbatim (no rounding, truncation, or coercion)', () => {
    // A non-integer sentinel proves the value is passed through untouched, not truncated/rounded.
    const sentinel = 1_752_800_000_123.456;
    const spy = spyOnDateNow().mockReturnValue(sentinel);
    const clock = createKmaSystemClock();
    const value = clock.nowEpochMilliseconds();
    expect(value).toBe(sentinel);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('createKmaSystemClock — re-reads live time and does not cache', () => {
  it('reads Date.now again on each successive call', () => {
    const spy = spyOnDateNow()
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(3_000);
    const clock = createKmaSystemClock();

    expect(clock.nowEpochMilliseconds()).toBe(1_000);
    expect(clock.nowEpochMilliseconds()).toBe(2_000);
    expect(clock.nowEpochMilliseconds()).toBe(3_000);
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });

  it('does not cache the first value (a later call reflects the new time)', () => {
    const spy = spyOnDateNow().mockReturnValueOnce(41).mockReturnValueOnce(42);
    const clock = createKmaSystemClock();

    const first = clock.nowEpochMilliseconds();
    const second = clock.nowEpochMilliseconds();
    expect(first).toBe(41);
    expect(second).toBe(42);
    expect(first).not.toBe(second);
    spy.mockRestore();
  });
});

describe('createKmaSystemClock — error propagation', () => {
  it('propagates the exact error reference Date.now throws (no wrapping)', () => {
    const sentinel = new Error('SYSTEM_CLOCK_DATE_NOW_SENTINEL_FOR_IDENTITY');
    const spy = spyOnDateNow().mockImplementation(() => {
      throw sentinel;
    });
    const clock = createKmaSystemClock();

    let caught: unknown;
    try {
      clock.nowEpochMilliseconds();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(sentinel);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('createKmaSystemClock — instances share no mutable state', () => {
  it('keeps two instances independent — each reads live time, neither retains the other’s value', () => {
    const spy = spyOnDateNow()
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(20)
      .mockReturnValueOnce(30)
      .mockReturnValueOnce(40);
    const clockA = createKmaSystemClock();
    const clockB = createKmaSystemClock();

    // Interleave the two instances: each call reads the next live value regardless of instance.
    expect(clockA.nowEpochMilliseconds()).toBe(10);
    expect(clockB.nowEpochMilliseconds()).toBe(20);
    expect(clockA.nowEpochMilliseconds()).toBe(30);
    expect(clockB.nowEpochMilliseconds()).toBe(40);
    expect(spy).toHaveBeenCalledTimes(4);
    spy.mockRestore();
  });
});
