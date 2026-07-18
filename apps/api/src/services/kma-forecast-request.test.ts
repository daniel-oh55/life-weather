import { describe, expect, it, vi } from 'vitest';

import { KmaForecastProduct } from '@life-weather/weather-core';

import type { KmaForecastRequest } from '../providers/kma';
import {
  createKmaForecastRequestFactory,
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
