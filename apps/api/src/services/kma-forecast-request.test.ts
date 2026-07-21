import { describe, expect, it, vi } from 'vitest';

import {
  KmaForecastProduct,
  selectLatestKmaForecastBaseTimeAfterAvailabilityDelay,
  type SelectLatestKmaForecastBaseTimeInput,
} from '@life-weather/weather-core';

import type { KmaForecastRequest } from '../providers/kma';
import {
  createKmaForecastRequestFactory,
  type KmaForecastBaseTimeSelector,
  type KmaForecastRequestClock,
  type KmaForecastRequestFactoryInput,
} from './kma-forecast-request';

const SHORT = KmaForecastProduct.SHORT_FORECAST;
const ULTRA = KmaForecastProduct.ULTRA_SHORT_FORECAST;

/** The exact five keys a request must expose, sorted for stable comparison. */
const REQUEST_KEYS = ['baseDate', 'baseTime', 'nx', 'ny', 'product'] as const;

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
    return value;
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
 * A fresh, test-local injected {@link KmaForecastBaseTimeSelector} that records every input it
 * receives (by reference) and returns `result`. The `calls` array is created per invocation of this
 * helper — never a module-scope mutable array or a shared `vi.fn` — so no call history is shared
 * across tests (order-independent under shuffle). The default `result` is deliberately distinct from
 * anything the real PR #8 selector would return, so a test can prove the factory used *this* result.
 */
function recordingSelector(
  result: { baseDate: string; baseTime: string } = {
    baseDate: '20200101',
    baseTime: '1234',
  },
) {
  const calls: SelectLatestKmaForecastBaseTimeInput[] = [];
  const selector: KmaForecastBaseTimeSelector = (input) => {
    calls.push(input);
    return result;
  };
  return { selector, calls, result };
}

/** A fresh, test-local selector that throws `error` (the exact reference, for identity checks). */
function throwingSelector(error: unknown) {
  const calls: SelectLatestKmaForecastBaseTimeInput[] = [];
  const selector: KmaForecastBaseTimeSelector = (input) => {
    calls.push(input);
    throw error;
  };
  return { selector, calls };
}

describe('createKmaForecastRequestFactory — construction is side-effect-free', () => {
  it('does not call the clock on construction alone', () => {
    const { clock, nowEpochMilliseconds } = fixedClock(
      kstEpochMs('2026-07-17T05:00:00.000'),
    );
    createKmaForecastRequestFactory(clock);
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
  });

  it('does not throw on construction alone', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-17T05:00:00.000'));
    expect(() => createKmaForecastRequestFactory(clock)).not.toThrow();
  });

  it('works with a frozen clock object', () => {
    const nowEpochMilliseconds = vi.fn(() => kstEpochMs('2026-07-17T05:00:00.000'));
    const clock = Object.freeze({ nowEpochMilliseconds });
    const factory = createKmaForecastRequestFactory(clock);
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    const result = factory.createScheduledRequest({ product: SHORT, nx: 60, ny: 127 });
    expect(result).toEqual({
      product: SHORT,
      baseDate: '20260717',
      baseTime: '0500',
      nx: 60,
      ny: 127,
    });
  });

  it('reuses one instance across many calls with no shared mutable state', () => {
    const { clock, nowEpochMilliseconds } = fixedClock(
      kstEpochMs('2026-07-17T14:30:00.000'),
    );
    const factory = createKmaForecastRequestFactory(clock);
    const first = factory.createScheduledRequest({ product: SHORT, nx: 60, ny: 127 });
    const second = factory.createScheduledRequest({ product: SHORT, nx: 60, ny: 127 });
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(2);
  });

  it('keeps two factories independent (no global mutable state)', () => {
    const shortFactory = createKmaForecastRequestFactory(
      fixedClock(kstEpochMs('2026-07-17T05:00:00.000')).clock,
    );
    const ultraFactory = createKmaForecastRequestFactory(
      fixedClock(kstEpochMs('2026-07-17T12:30:00.000')).clock,
    );
    expect(shortFactory.createScheduledRequest({ product: SHORT, nx: 60, ny: 127 })).toEqual({
      product: SHORT,
      baseDate: '20260717',
      baseTime: '0500',
      nx: 60,
      ny: 127,
    });
    expect(ultraFactory.createScheduledRequest({ product: ULTRA, nx: 55, ny: 124 })).toEqual({
      product: ULTRA,
      baseDate: '20260717',
      baseTime: '1230',
      nx: 55,
      ny: 124,
    });
  });
});

describe('createKmaForecastRequestFactory — clock is read exactly once per request', () => {
  it('reads the clock exactly once, with no argument, per createScheduledRequest call', () => {
    const { clock, nowEpochMilliseconds } = fixedClock(
      kstEpochMs('2026-07-17T05:00:00.000'),
    );
    const factory = createKmaForecastRequestFactory(clock);
    factory.createScheduledRequest({ product: SHORT, nx: 60, ny: 127 });
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    expect(nowEpochMilliseconds.mock.calls[0]).toEqual([]);
  });

  it('forwards the exact clock value to the selector (sequence clock across two calls)', () => {
    const { clock, nowEpochMilliseconds } = sequenceClock([
      kstEpochMs('2026-07-17T04:59:59.999'),
      kstEpochMs('2026-07-17T05:00:00.000'),
    ]);
    const factory = createKmaForecastRequestFactory(clock);

    const first = factory.createScheduledRequest({ product: SHORT, nx: 60, ny: 127 });
    const second = factory.createScheduledRequest({ product: SHORT, nx: 60, ny: 127 });

    // One millisecond before 05:00 selects the previous scheduled issuance; exactly 05:00 selects it.
    expect(first).toMatchObject({ baseDate: '20260717', baseTime: '0200' });
    expect(second).toMatchObject({ baseDate: '20260717', baseTime: '0500' });
    // Two requests → exactly two clock reads (one per request, never twice within a call).
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(2);
  });
});

describe('createKmaForecastRequestFactory — SHORT_FORECAST request', () => {
  it('assembles a complete SHORT request from the real PR #8 selector', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-17T05:00:00.000'));
    const factory = createKmaForecastRequestFactory(clock);
    const input: KmaForecastRequestFactoryInput = { product: SHORT, nx: 60, ny: 127 };

    const result = factory.createScheduledRequest(input);

    expect(result).toEqual({
      product: SHORT,
      baseDate: '20260717',
      baseTime: '0500',
      nx: 60,
      ny: 127,
    });
    // Exactly the five request fields, nothing more.
    expect(Object.keys(result).sort()).toEqual([...REQUEST_KEYS].sort());
    // Assignable to the provider-boundary request type, and a distinct object from the input.
    const request: KmaForecastRequest = result;
    expect(request.product).toBe(SHORT);
    expect(result).not.toBe(input as unknown as KmaForecastRequest);
  });
});

describe('createKmaForecastRequestFactory — ULTRA_SHORT_FORECAST request', () => {
  it('assembles a complete ULTRA request from the real PR #8 selector', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-17T12:30:00.000'));
    const factory = createKmaForecastRequestFactory(clock);

    const result = factory.createScheduledRequest({ product: ULTRA, nx: 55, ny: 124 });

    expect(result).toEqual({
      product: ULTRA,
      baseDate: '20260717',
      baseTime: '1230',
      nx: 55,
      ny: 124,
    });
    expect(Object.keys(result).sort()).toEqual([...REQUEST_KEYS].sort());
  });

  it('applies the previous-day rollover before the first ULTRA issuance', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-01T00:10:00.000'));
    const factory = createKmaForecastRequestFactory(clock);

    const result = factory.createScheduledRequest({ product: ULTRA, nx: 55, ny: 124 });

    expect(result).toEqual({
      product: ULTRA,
      baseDate: '20260630',
      baseTime: '2330',
      nx: 55,
      ny: 124,
    });
  });
});

describe('createKmaForecastRequestFactory — input and output safety', () => {
  it('works with a frozen input and never mutates it', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-17T05:00:00.000'));
    const factory = createKmaForecastRequestFactory(clock);
    const input = Object.freeze<KmaForecastRequestFactoryInput>({
      product: SHORT,
      nx: 60,
      ny: 127,
    });
    const snapshot = JSON.stringify(input);

    const result = factory.createScheduledRequest(input);

    expect(JSON.stringify(input)).toBe(snapshot);
    // The caller-supplied fields are preserved verbatim.
    expect(result.product).toBe(input.product);
    expect(result.nx).toBe(input.nx);
    expect(result.ny).toBe(input.ny);
  });

  it('returns a fresh object per call; same input + same clock value → deep-equal but distinct', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-17T14:30:00.000'));
    const factory = createKmaForecastRequestFactory(clock);
    const input: KmaForecastRequestFactoryInput = { product: SHORT, nx: 60, ny: 127 };

    const first = factory.createScheduledRequest(input);
    const second = factory.createScheduledRequest(input);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it('mutating a previous result (runtime cast) does not affect the next call', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-17T14:30:00.000'));
    const factory = createKmaForecastRequestFactory(clock);
    const input: KmaForecastRequestFactoryInput = { product: SHORT, nx: 60, ny: 127 };

    const first = factory.createScheduledRequest(input);
    (first as { baseDate: string; nx: number }).baseDate = 'MUTATED';
    (first as { baseDate: string; nx: number }).nx = -999;

    const second = factory.createScheduledRequest(input);
    expect(second).toEqual({
      product: SHORT,
      baseDate: '20260717',
      baseTime: '1400',
      nx: 60,
      ny: 127,
    });
  });

  it('does not accumulate state across alternating SHORT and ULTRA calls', () => {
    const factory = createKmaForecastRequestFactory(
      fixedClock(kstEpochMs('2026-07-17T14:30:00.000')).clock,
    );
    const runShort = () =>
      factory.createScheduledRequest({ product: SHORT, nx: 60, ny: 127 });
    const runUltra = () =>
      factory.createScheduledRequest({ product: ULTRA, nx: 55, ny: 124 });

    const expectedShort = {
      product: SHORT,
      baseDate: '20260717',
      baseTime: '1400',
      nx: 60,
      ny: 127,
    };
    const expectedUltra = {
      product: ULTRA,
      baseDate: '20260717',
      baseTime: '1430',
      nx: 55,
      ny: 124,
    };
    expect(runShort()).toEqual(expectedShort);
    expect(runUltra()).toEqual(expectedUltra);
    expect(runShort()).toEqual(expectedShort);
    expect(runUltra()).toEqual(expectedUltra);
  });

  it('does not leak a runtime extra property from the input (no object spread)', () => {
    const EXTRA_MARKER = 'SECRET_SHAPED_EXTRA_MUST_NOT_LEAK_PR9';
    const { clock } = fixedClock(kstEpochMs('2026-07-17T05:00:00.000'));
    const factory = createKmaForecastRequestFactory(clock);
    const input = {
      product: SHORT,
      nx: 60,
      ny: 127,
      [EXTRA_MARKER]: 'leak-me-if-you-spread-input',
    } as unknown as KmaForecastRequestFactoryInput;

    const result = factory.createScheduledRequest(input);

    // Exactly the five request fields — the marker key and value never survive.
    expect(Object.keys(result).sort()).toEqual([...REQUEST_KEYS].sort());
    expect(result).not.toHaveProperty(EXTRA_MARKER);
    expect(JSON.stringify(result)).not.toContain(EXTRA_MARKER);
    expect(JSON.stringify(result)).not.toContain('leak-me-if-you-spread-input');
  });
});

describe('createKmaForecastRequestFactory — error propagation', () => {
  it('propagates the selector RangeError for a NaN clock value (no new result union)', () => {
    const { clock } = fixedClock(Number.NaN);
    const factory = createKmaForecastRequestFactory(clock);
    expect(() =>
      factory.createScheduledRequest({ product: SHORT, nx: 60, ny: 127 }),
    ).toThrow(RangeError);
  });

  it('throws a value-free RangeError (not TypeError) for a non-number clock value', () => {
    const CLOCK_MARKER = 'SECRET_SHAPED_CLOCK_VALUE_MUST_NOT_LEAK_PR9';
    const nowEpochMilliseconds = vi.fn(() => CLOCK_MARKER as unknown as number);
    const factory = createKmaForecastRequestFactory({ nowEpochMilliseconds });

    let caught: unknown;
    try {
      factory.createScheduledRequest({ product: SHORT, nx: 60, ny: 127 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RangeError);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect((caught as Error).message).not.toContain(CLOCK_MARKER);
  });

  it('propagates a value-free RangeError for an unsupported product, reading the clock once', () => {
    const PRODUCT_MARKER = 'SECRET_SHAPED_PRODUCT_MUST_NOT_LEAK_PR9';
    const { clock, nowEpochMilliseconds } = fixedClock(
      kstEpochMs('2026-07-17T12:00:00.000'),
    );
    const factory = createKmaForecastRequestFactory(clock);

    let caught: unknown;
    try {
      factory.createScheduledRequest({
        product: PRODUCT_MARKER as unknown as KmaForecastProduct,
        nx: 60,
        ny: 127,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RangeError);
    expect((caught as Error).message).not.toContain(PRODUCT_MARKER);
    // The clock is still read exactly once for this request before the selector rejects the product.
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
  });

  it('propagates the exact error the clock throws (same reference, no wrapping, no request)', () => {
    const sentinel = new Error('CLOCK_SENTINEL_FOR_IDENTITY');
    const { clock } = throwingClock(sentinel);
    const factory = createKmaForecastRequestFactory(clock);

    let caught: unknown;
    let returned: KmaForecastRequest | undefined;
    try {
      returned = factory.createScheduledRequest({ product: SHORT, nx: 60, ny: 127 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(sentinel);
    expect(returned).toBeUndefined();
  });
});

describe('createKmaForecastRequestFactory — injected selector: construction is side-effect-free', () => {
  it('does not call the injected selector on construction alone', () => {
    const { clock, nowEpochMilliseconds } = fixedClock(
      kstEpochMs('2026-07-18T05:00:00.000'),
    );
    const { selector, calls } = recordingSelector();
    createKmaForecastRequestFactory(clock, selector);
    expect(calls).toHaveLength(0);
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
  });

  it('constructs from a frozen clock and a frozen selector reference without calling either', () => {
    const nowEpochMilliseconds = vi.fn(() => kstEpochMs('2026-07-18T05:00:00.000'));
    const clock = Object.freeze({ nowEpochMilliseconds });
    const { selector, calls } = recordingSelector();
    const frozenSelector = Object.freeze(selector);

    const factory = createKmaForecastRequestFactory(clock, frozenSelector);

    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    // The factory is usable and routes through the injected selector reference.
    const result = factory.createScheduledRequest({ product: SHORT, nx: 60, ny: 127 });
    expect(result).toMatchObject({ baseDate: '20200101', baseTime: '1234' });
    expect(calls).toHaveLength(1);
  });

  it('does not mutate the injected selector reference', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-18T05:00:00.000'));
    const { selector } = recordingSelector();
    const before = { ...(selector as unknown as Record<string, unknown>) };
    const factory = createKmaForecastRequestFactory(clock, selector);
    factory.createScheduledRequest({ product: SHORT, nx: 60, ny: 127 });
    expect({ ...(selector as unknown as Record<string, unknown>) }).toEqual(before);
  });
});

describe('createKmaForecastRequestFactory — injected selector: input contract', () => {
  it('calls the selector exactly once per request', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-18T05:00:00.000'));
    const { selector, calls } = recordingSelector();
    const factory = createKmaForecastRequestFactory(clock, selector);
    factory.createScheduledRequest({ product: SHORT, nx: 60, ny: 127 });
    expect(calls).toHaveLength(1);
  });

  it("passes a selector input whose own keys are exactly product + referenceEpochMilliseconds", () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-18T05:00:00.000'));
    const { selector, calls } = recordingSelector();
    const factory = createKmaForecastRequestFactory(clock, selector);

    factory.createScheduledRequest({ product: SHORT, nx: 60, ny: 127 });

    expect(Object.keys(calls[0]).sort()).toEqual([
      'product',
      'referenceEpochMilliseconds',
    ]);
    // No grid coordinate is forwarded into the selector input.
    expect('nx' in calls[0]).toBe(false);
    expect('ny' in calls[0]).toBe(false);
  });

  it('does not forward a runtime extra property from the factory input into the selector input', () => {
    const EXTRA_MARKER = 'SECRET_SHAPED_EXTRA_MUST_NOT_LEAK_PR15';
    const { clock } = fixedClock(kstEpochMs('2026-07-18T05:00:00.000'));
    const { selector, calls } = recordingSelector();
    const factory = createKmaForecastRequestFactory(clock, selector);
    const input = {
      product: SHORT,
      nx: 60,
      ny: 127,
      [EXTRA_MARKER]: 'leak-me-if-you-spread-input',
    } as unknown as KmaForecastRequestFactoryInput;

    factory.createScheduledRequest(input);

    expect(Object.keys(calls[0]).sort()).toEqual([
      'product',
      'referenceEpochMilliseconds',
    ]);
    expect(calls[0]).not.toHaveProperty(EXTRA_MARKER);
  });

  it('builds a selector input that is a distinct object reference from the factory input', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-18T05:00:00.000'));
    const { selector, calls } = recordingSelector();
    const factory = createKmaForecastRequestFactory(clock, selector);
    const input: KmaForecastRequestFactoryInput = { product: SHORT, nx: 60, ny: 127 };

    factory.createScheduledRequest(input);

    expect(calls[0]).not.toBe(input as unknown as SelectLatestKmaForecastBaseTimeInput);
  });

  it('forwards the exact clock value and product to the selector input', () => {
    const epoch = kstEpochMs('2026-07-18T05:00:00.000');
    const { clock } = fixedClock(epoch);
    const { selector, calls } = recordingSelector();
    const factory = createKmaForecastRequestFactory(clock, selector);

    factory.createScheduledRequest({ product: ULTRA, nx: 55, ny: 124 });

    expect(calls[0].referenceEpochMilliseconds).toBe(epoch);
    expect(calls[0].product).toBe(ULTRA);
  });

  it('builds a fresh selector input object on every call', () => {
    const { clock } = sequenceClock([
      kstEpochMs('2026-07-18T05:00:00.000'),
      kstEpochMs('2026-07-18T06:00:00.000'),
    ]);
    const { selector, calls } = recordingSelector();
    const factory = createKmaForecastRequestFactory(clock, selector);

    factory.createScheduledRequest({ product: SHORT, nx: 60, ny: 127 });
    factory.createScheduledRequest({ product: SHORT, nx: 60, ny: 127 });

    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toBe(calls[1]);
  });
});

describe('createKmaForecastRequestFactory — injected selector: output contract', () => {
  it("uses the selector's baseDate/baseTime verbatim in the request", () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-18T05:00:00.000'));
    const { selector } = recordingSelector({ baseDate: '20191231', baseTime: '2359' });
    const factory = createKmaForecastRequestFactory(clock, selector);

    const result = factory.createScheduledRequest({ product: SHORT, nx: 60, ny: 127 });

    expect(result).toEqual({
      product: SHORT,
      baseDate: '20191231',
      baseTime: '2359',
      nx: 60,
      ny: 127,
    });
    expect(Object.keys(result).sort()).toEqual([...REQUEST_KEYS].sort());
  });

  it('does not expose an extra runtime property from the selector result', () => {
    const EXTRA_MARKER = 'SECRET_SHAPED_SELECTOR_RESULT_MUST_NOT_LEAK_PR15';
    const { clock } = fixedClock(kstEpochMs('2026-07-18T05:00:00.000'));
    // A selector whose result carries an extra runtime key beyond baseDate/baseTime.
    const selector: KmaForecastBaseTimeSelector = () =>
      ({
        baseDate: '20260718',
        baseTime: '0200',
        [EXTRA_MARKER]: 'leak-me-if-you-spread-result',
      }) as unknown as ReturnType<KmaForecastBaseTimeSelector>;
    const factory = createKmaForecastRequestFactory(clock, selector);

    const result = factory.createScheduledRequest({ product: SHORT, nx: 60, ny: 127 });

    expect(Object.keys(result).sort()).toEqual([...REQUEST_KEYS].sort());
    expect(result).not.toHaveProperty(EXTRA_MARKER);
    expect(JSON.stringify(result)).not.toContain(EXTRA_MARKER);
  });

  it('works with a frozen selector result and never mutates it', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-18T05:00:00.000'));
    const frozenResult = Object.freeze({ baseDate: '20260718', baseTime: '0200' });
    const selector: KmaForecastBaseTimeSelector = () => frozenResult;
    const factory = createKmaForecastRequestFactory(clock, selector);

    const result = factory.createScheduledRequest({ product: SHORT, nx: 60, ny: 127 });

    expect(result).toMatchObject({ baseDate: '20260718', baseTime: '0200' });
    // The selector's result object is left exactly as it was returned.
    expect(frozenResult).toEqual({ baseDate: '20260718', baseTime: '0200' });
  });
});

describe('createKmaForecastRequestFactory — injected selector: error propagation', () => {
  it('does not call the selector when the clock throws', () => {
    const sentinel = new Error('CLOCK_SENTINEL_BEFORE_SELECTOR');
    const { clock } = throwingClock(sentinel);
    const { selector, calls } = recordingSelector();
    const factory = createKmaForecastRequestFactory(clock, selector);

    let caught: unknown;
    try {
      factory.createScheduledRequest({ product: SHORT, nx: 60, ny: 127 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(sentinel);
    expect(calls).toHaveLength(0);
  });

  it('propagates the exact error the selector throws after reading the clock once', () => {
    const sentinel = new Error('SELECTOR_SENTINEL_FOR_IDENTITY');
    const { clock, nowEpochMilliseconds } = fixedClock(
      kstEpochMs('2026-07-18T05:00:00.000'),
    );
    const { selector } = throwingSelector(sentinel);
    const factory = createKmaForecastRequestFactory(clock, selector);

    let caught: unknown;
    let returned: KmaForecastRequest | undefined;
    try {
      returned = factory.createScheduledRequest({ product: SHORT, nx: 60, ny: 127 });
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
    const factory = createKmaForecastRequestFactory(clock, selector);

    let caught: unknown;
    try {
      factory.createScheduledRequest({ product: SHORT, nx: 60, ny: 127 });
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
    const factory = createKmaForecastRequestFactory(clock, selector);

    expect(() =>
      factory.createScheduledRequest({ product: SHORT, nx: 60, ny: 127 }),
    ).toThrow();

    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    log.mockRestore();
    error.mockRestore();
    warn.mockRestore();
  });
});

describe('createKmaForecastRequestFactory — default selector compatibility (schedule-only)', () => {
  it('omitting the selector keeps the PR #8 schedule result for SHORT 05:00 KST → 0500', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-18T05:00:00.000'));
    // One-argument call: the historical API, unchanged.
    const factory = createKmaForecastRequestFactory(clock);

    const result = factory.createScheduledRequest({ product: SHORT, nx: 60, ny: 127 });

    expect(result).toEqual({
      product: SHORT,
      baseDate: '20260718',
      baseTime: '0500',
      nx: 60,
      ny: 127,
    });
  });

  it('omitting the selector keeps the PR #8 schedule result for ULTRA 06:30 KST → 0630', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-18T06:30:00.000'));
    const factory = createKmaForecastRequestFactory(clock);

    const result = factory.createScheduledRequest({ product: ULTRA, nx: 55, ny: 124 });

    expect(result).toEqual({
      product: ULTRA,
      baseDate: '20260718',
      baseTime: '0630',
      nx: 55,
      ny: 124,
    });
  });
});

describe('createKmaForecastRequestFactory — real PR #14 availability-delay selector', () => {
  it('SHORT 05:00 KST selects the 0200 issuance (10-minute threshold not yet met for 0500)', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-18T05:00:00.000'));
    const factory = createKmaForecastRequestFactory(
      clock,
      selectLatestKmaForecastBaseTimeAfterAvailabilityDelay,
    );

    const result = factory.createScheduledRequest({ product: SHORT, nx: 60, ny: 127 });

    expect(result).toEqual({
      product: SHORT,
      baseDate: '20260718',
      baseTime: '0200',
      nx: 60,
      ny: 127,
    });
  });

  it('SHORT 05:10 KST selects the 0500 issuance (10-minute threshold exactly met)', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-18T05:10:00.000'));
    const factory = createKmaForecastRequestFactory(
      clock,
      selectLatestKmaForecastBaseTimeAfterAvailabilityDelay,
    );

    const result = factory.createScheduledRequest({ product: SHORT, nx: 60, ny: 127 });

    expect(result).toMatchObject({ baseDate: '20260718', baseTime: '0500' });
  });

  it('ULTRA 06:30 KST selects the 0530 issuance (15-minute threshold not yet met for 0630)', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-18T06:30:00.000'));
    const factory = createKmaForecastRequestFactory(
      clock,
      selectLatestKmaForecastBaseTimeAfterAvailabilityDelay,
    );

    const result = factory.createScheduledRequest({ product: ULTRA, nx: 55, ny: 124 });

    expect(result).toMatchObject({ baseDate: '20260718', baseTime: '0530' });
  });

  it('ULTRA 06:45 KST selects the 0630 issuance (15-minute threshold exactly met)', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-18T06:45:00.000'));
    const factory = createKmaForecastRequestFactory(
      clock,
      selectLatestKmaForecastBaseTimeAfterAvailabilityDelay,
    );

    const result = factory.createScheduledRequest({ product: ULTRA, nx: 55, ny: 124 });

    expect(result).toMatchObject({ baseDate: '20260718', baseTime: '0630' });
  });
});

describe('createKmaForecastRequestFactory — injected selector: repeated calls', () => {
  it('reads the clock once and calls the selector once per request across many calls', () => {
    const { clock, nowEpochMilliseconds } = fixedClock(
      kstEpochMs('2026-07-18T05:00:00.000'),
    );
    const { selector, calls } = recordingSelector();
    const factory = createKmaForecastRequestFactory(clock, selector);

    factory.createScheduledRequest({ product: SHORT, nx: 60, ny: 127 });
    factory.createScheduledRequest({ product: SHORT, nx: 60, ny: 127 });
    factory.createScheduledRequest({ product: SHORT, nx: 60, ny: 127 });

    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(3);
    expect(calls).toHaveLength(3);
  });

  it('returns a fresh, uncached request object per call with the injected selector', () => {
    const { clock } = fixedClock(kstEpochMs('2026-07-18T05:00:00.000'));
    const { selector } = recordingSelector({ baseDate: '20260718', baseTime: '0200' });
    const factory = createKmaForecastRequestFactory(clock, selector);
    const input: KmaForecastRequestFactoryInput = { product: SHORT, nx: 60, ny: 127 };

    const first = factory.createScheduledRequest(input);
    const second = factory.createScheduledRequest(input);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it('does not mix SHORT/ULTRA state across alternating calls with the real PR #14 selector', () => {
    const factory = createKmaForecastRequestFactory(
      fixedClock(kstEpochMs('2026-07-18T06:45:00.000')).clock,
      selectLatestKmaForecastBaseTimeAfterAvailabilityDelay,
    );
    const runShort = () =>
      factory.createScheduledRequest({ product: SHORT, nx: 60, ny: 127 });
    const runUltra = () =>
      factory.createScheduledRequest({ product: ULTRA, nx: 55, ny: 124 });

    // At 06:45 KST: SHORT (−10m → 06:35) selects 0500; ULTRA (−15m → 06:30) selects 0630.
    const expectedShort = {
      product: SHORT,
      baseDate: '20260718',
      baseTime: '0500',
      nx: 60,
      ny: 127,
    };
    const expectedUltra = {
      product: ULTRA,
      baseDate: '20260718',
      baseTime: '0630',
      nx: 55,
      ny: 124,
    };
    expect(runShort()).toEqual(expectedShort);
    expect(runUltra()).toEqual(expectedUltra);
    expect(runShort()).toEqual(expectedShort);
    expect(runUltra()).toEqual(expectedUltra);
  });
});
