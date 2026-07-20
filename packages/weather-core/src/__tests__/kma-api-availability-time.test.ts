import { describe, expect, it } from 'vitest';

import {
  KmaForecastProduct,
  selectLatestKmaForecastBaseTime,
  selectLatestKmaForecastBaseTimeAfterAvailabilityDelay,
  type KmaForecastBaseTime,
  type SelectLatestKmaForecastBaseTimeAfterAvailabilityDelayInput,
} from '../index';

const SHORT = KmaForecastProduct.SHORT_FORECAST;
const ULTRA = KmaForecastProduct.ULTRA_SHORT_FORECAST;

/**
 * Build an absolute epoch-millisecond reference from a KST wall clock. The offset is always
 * explicit (`+09:00`), so the input string is never a timezone-less local datetime and the
 * parsed instant is independent of the host timezone. `process.env.TZ` is never touched.
 */
function kstEpochMs(kstWallClock: string): number {
  const ms = Date.parse(`${kstWallClock}+09:00`);
  if (Number.isNaN(ms)) {
    throw new Error(`test setup: unparseable KST wall clock "${kstWallClock}"`);
  }
  return ms;
}

/** Build an absolute epoch-millisecond reference from an explicit UTC (`Z`) wall clock. */
function utcEpochMs(utcWallClock: string): number {
  const ms = Date.parse(`${utcWallClock}Z`);
  if (Number.isNaN(ms)) {
    throw new Error(`test setup: unparseable UTC wall clock "${utcWallClock}"`);
  }
  return ms;
}

/**
 * Fresh, test-local input builder. Nothing mutable is shared at describe scope, so tests are
 * independent of execution order and pass under any shuffle seed.
 */
function inputAtKst(
  product: KmaForecastProduct,
  kstWallClock: string,
): SelectLatestKmaForecastBaseTimeAfterAvailabilityDelayInput {
  return { product, referenceEpochMilliseconds: kstEpochMs(kstWallClock) };
}

describe('selectLatestKmaForecastBaseTimeAfterAvailabilityDelay — SHORT availability threshold (+10m)', () => {
  it.each([
    // First issuance boundary (0200 available at 02:10).
    { at: '2026-07-18T02:09:59.999', baseDate: '20260717', baseTime: '2300' },
    { at: '2026-07-18T02:10:00.000', baseDate: '20260718', baseTime: '0200' },
    // Middle issuance boundary (0500 available at 05:10).
    { at: '2026-07-18T05:00:00.000', baseDate: '20260718', baseTime: '0200' },
    { at: '2026-07-18T05:09:59.999', baseDate: '20260718', baseTime: '0200' },
    { at: '2026-07-18T05:10:00.000', baseDate: '20260718', baseTime: '0500' },
    { at: '2026-07-18T05:10:00.001', baseDate: '20260718', baseTime: '0500' },
    // Last issuance boundary (2300 available at 23:10).
    { at: '2026-07-18T23:09:59.999', baseDate: '20260718', baseTime: '2000' },
    { at: '2026-07-18T23:10:00.000', baseDate: '20260718', baseTime: '2300' },
  ])('short: $at -> $baseDate/$baseTime', ({ at, baseDate, baseTime }) => {
    expect(
      selectLatestKmaForecastBaseTimeAfterAvailabilityDelay(inputAtKst(SHORT, at)),
    ).toEqual({ baseDate, baseTime });
  });

  it('uses an inclusive threshold exactly at issuance + 10 minutes for every SHORT issue time', () => {
    const shortIssueTimes = [
      '0200',
      '0500',
      '0800',
      '1100',
      '1400',
      '1700',
      '2000',
      '2300',
    ] as const;
    const prevBaseTime: Record<string, string> = {
      '0200': '2300',
      '0500': '0200',
      '0800': '0500',
      '1100': '0800',
      '1400': '1100',
      '1700': '1400',
      '2000': '1700',
      '2300': '2000',
    };
    const day = '2026-07-18';
    for (const baseTime of shortIssueTimes) {
      const hh = baseTime.slice(0, 2);
      // Available at HH:10:00.000 KST (issuance HH:00 + 10 minutes).
      const availableAt = `${day}T${hh}:10:00.000`;
      const oneMsBefore = kstEpochMs(availableAt) - 1;

      expect(
        selectLatestKmaForecastBaseTimeAfterAvailabilityDelay({
          product: SHORT,
          referenceEpochMilliseconds: kstEpochMs(availableAt),
        }),
      ).toEqual({ baseDate: '20260718', baseTime });

      expect(
        selectLatestKmaForecastBaseTimeAfterAvailabilityDelay({
          product: SHORT,
          referenceEpochMilliseconds: oneMsBefore,
        }),
      ).toEqual({
        baseDate: baseTime === '0200' ? '20260717' : '20260718',
        baseTime: prevBaseTime[baseTime] as string,
      });
    }
  });
});

describe('selectLatestKmaForecastBaseTimeAfterAvailabilityDelay — ULTRA availability threshold (+15m)', () => {
  it.each([
    // First issuance boundary (0030 available at 00:45).
    { at: '2026-07-18T00:44:59.999', baseDate: '20260717', baseTime: '2330' },
    { at: '2026-07-18T00:45:00.000', baseDate: '20260718', baseTime: '0030' },
    // Middle issuance boundary (0630 available at 06:45).
    { at: '2026-07-18T06:30:00.000', baseDate: '20260718', baseTime: '0530' },
    { at: '2026-07-18T06:44:59.999', baseDate: '20260718', baseTime: '0530' },
    { at: '2026-07-18T06:45:00.000', baseDate: '20260718', baseTime: '0630' },
    { at: '2026-07-18T06:45:00.001', baseDate: '20260718', baseTime: '0630' },
    // Last issuance boundary (2330 available at 23:45).
    { at: '2026-07-18T23:44:59.999', baseDate: '20260718', baseTime: '2230' },
    { at: '2026-07-18T23:45:00.000', baseDate: '20260718', baseTime: '2330' },
  ])('ultra: $at -> $baseDate/$baseTime', ({ at, baseDate, baseTime }) => {
    expect(
      selectLatestKmaForecastBaseTimeAfterAvailabilityDelay(inputAtKst(ULTRA, at)),
    ).toEqual({ baseDate, baseTime });
  });

  it('uses an inclusive threshold exactly at issuance + 15 minutes for every ULTRA hour', () => {
    const day = '2026-07-18';
    for (let hour = 0; hour < 24; hour += 1) {
      const hh = String(hour).padStart(2, '0');
      const baseTime = `${hh}30`;
      // Available at HH:45:00.000 KST (issuance HH:30 + 15 minutes).
      const availableAt = `${day}T${hh}:45:00.000`;
      const oneMsBefore = kstEpochMs(availableAt) - 1;

      expect(
        selectLatestKmaForecastBaseTimeAfterAvailabilityDelay({
          product: ULTRA,
          referenceEpochMilliseconds: kstEpochMs(availableAt),
        }),
      ).toEqual({ baseDate: '20260718', baseTime });

      const prevHour = String((hour + 23) % 24).padStart(2, '0');
      expect(
        selectLatestKmaForecastBaseTimeAfterAvailabilityDelay({
          product: ULTRA,
          referenceEpochMilliseconds: oneMsBefore,
        }),
      ).toEqual({
        baseDate: hour === 0 ? '20260717' : '20260718',
        baseTime: `${prevHour}30`,
      });
    }
  });
});

describe('selectLatestKmaForecastBaseTimeAfterAvailabilityDelay — date rollover', () => {
  it.each([
    // Year rollover.
    { product: SHORT, at: '2026-01-01T02:09:59.999', baseDate: '20251231', baseTime: '2300' },
    { product: SHORT, at: '2026-01-01T02:10:00.000', baseDate: '20260101', baseTime: '0200' },
    { product: ULTRA, at: '2026-01-01T00:44:59.999', baseDate: '20251231', baseTime: '2330' },
    { product: ULTRA, at: '2026-01-01T00:45:00.000', baseDate: '20260101', baseTime: '0030' },
    // Month-end rollover.
    { product: SHORT, at: '2026-08-01T02:09:59.999', baseDate: '20260731', baseTime: '2300' },
    { product: ULTRA, at: '2026-08-01T00:44:59.999', baseDate: '20260731', baseTime: '2330' },
    // Leap-day rollover (2024-02-29 exists).
    { product: SHORT, at: '2024-03-01T02:09:59.999', baseDate: '20240229', baseTime: '2300' },
    { product: ULTRA, at: '2024-03-01T00:44:59.999', baseDate: '20240229', baseTime: '2330' },
  ])(
    '$product: $at -> $baseDate/$baseTime',
    ({ product, at, baseDate, baseTime }) => {
      expect(
        selectLatestKmaForecastBaseTimeAfterAvailabilityDelay(inputAtKst(product, at)),
      ).toEqual({ baseDate, baseTime });
    },
  );
});

describe('selectLatestKmaForecastBaseTimeAfterAvailabilityDelay — supported-year lower bound', () => {
  // The [1000, 9999] policy is owned by the schedule selector and applies to the
  // availability-adjusted selection too: an adjusted instant that rolls the base_date into 0999
  // is rejected — never clamped or emitted as year 0999.

  it('throws RangeError when the SHORT availability-adjusted selection rolls into year 0999', () => {
    // 1000-01-01T02:09:59.999 KST - 10m = 01:59:59.999, before the day's first SHORT issue, so
    // the selection rolls back to 0999-12-31 / 2300 — outside the supported range.
    expect(() =>
      selectLatestKmaForecastBaseTimeAfterAvailabilityDelay(
        inputAtKst(SHORT, '1000-01-01T02:09:59.999'),
      ),
    ).toThrow(RangeError);
  });

  it('returns the exact first SHORT issuance at the 1000 lower bound (10000101/0200)', () => {
    expect(
      selectLatestKmaForecastBaseTimeAfterAvailabilityDelay(
        inputAtKst(SHORT, '1000-01-01T02:10:00.000'),
      ),
    ).toEqual({ baseDate: '10000101', baseTime: '0200' });
  });

  it('throws RangeError when the ULTRA availability-adjusted selection rolls into year 0999', () => {
    // 1000-01-01T00:44:59.999 KST - 15m = 00:29:59.999, before the day's first ULTRA issue, so
    // the selection rolls back to 0999-12-31 / 2330 — outside the supported range.
    expect(() =>
      selectLatestKmaForecastBaseTimeAfterAvailabilityDelay(
        inputAtKst(ULTRA, '1000-01-01T00:44:59.999'),
      ),
    ).toThrow(RangeError);
  });

  it('returns the exact first ULTRA issuance at the 1000 lower bound (10000101/0030)', () => {
    expect(
      selectLatestKmaForecastBaseTimeAfterAvailabilityDelay(
        inputAtKst(ULTRA, '1000-01-01T00:45:00.000'),
      ),
    ).toEqual({ baseDate: '10000101', baseTime: '0030' });
  });
});

describe('selectLatestKmaForecastBaseTimeAfterAvailabilityDelay — contrast with the schedule selector', () => {
  // Same absolute reference, both selectors. The schedule selector never gains the availability
  // delay; the new selector shifts the reference by the delay before selecting.

  it('SHORT 05:00 KST: scheduled -> 0500, availability-delay -> 0200', () => {
    const reference = kstEpochMs('2026-07-18T05:00:00.000');
    expect(
      selectLatestKmaForecastBaseTime({ product: SHORT, referenceEpochMilliseconds: reference }),
    ).toEqual({ baseDate: '20260718', baseTime: '0500' });
    expect(
      selectLatestKmaForecastBaseTimeAfterAvailabilityDelay({
        product: SHORT,
        referenceEpochMilliseconds: reference,
      }),
    ).toEqual({ baseDate: '20260718', baseTime: '0200' });
  });

  it('SHORT 05:10 KST: both selectors -> 0500', () => {
    const reference = kstEpochMs('2026-07-18T05:10:00.000');
    expect(
      selectLatestKmaForecastBaseTime({ product: SHORT, referenceEpochMilliseconds: reference }),
    ).toEqual({ baseDate: '20260718', baseTime: '0500' });
    expect(
      selectLatestKmaForecastBaseTimeAfterAvailabilityDelay({
        product: SHORT,
        referenceEpochMilliseconds: reference,
      }),
    ).toEqual({ baseDate: '20260718', baseTime: '0500' });
  });

  it('ULTRA 06:30 KST: scheduled -> 0630, availability-delay -> 0530', () => {
    const reference = kstEpochMs('2026-07-18T06:30:00.000');
    expect(
      selectLatestKmaForecastBaseTime({ product: ULTRA, referenceEpochMilliseconds: reference }),
    ).toEqual({ baseDate: '20260718', baseTime: '0630' });
    expect(
      selectLatestKmaForecastBaseTimeAfterAvailabilityDelay({
        product: ULTRA,
        referenceEpochMilliseconds: reference,
      }),
    ).toEqual({ baseDate: '20260718', baseTime: '0530' });
  });

  it('ULTRA 06:45 KST: both selectors -> 0630', () => {
    const reference = kstEpochMs('2026-07-18T06:45:00.000');
    expect(
      selectLatestKmaForecastBaseTime({ product: ULTRA, referenceEpochMilliseconds: reference }),
    ).toEqual({ baseDate: '20260718', baseTime: '0630' });
    expect(
      selectLatestKmaForecastBaseTimeAfterAvailabilityDelay({
        product: ULTRA,
        referenceEpochMilliseconds: reference,
      }),
    ).toEqual({ baseDate: '20260718', baseTime: '0630' });
  });
});

describe('selectLatestKmaForecastBaseTimeAfterAvailabilityDelay — timezone-independent absolute instant', () => {
  it('gives the same result for the same instant written as +09:00 KST and as UTC Z', () => {
    // 2026-07-18T05:10:00.000+09:00 === 2026-07-17T20:10:00.000Z (the same absolute instant).
    const fromKst = selectLatestKmaForecastBaseTimeAfterAvailabilityDelay({
      product: SHORT,
      referenceEpochMilliseconds: kstEpochMs('2026-07-18T05:10:00.000'),
    });
    const fromUtc = selectLatestKmaForecastBaseTimeAfterAvailabilityDelay({
      product: SHORT,
      referenceEpochMilliseconds: utcEpochMs('2026-07-17T20:10:00.000'),
    });
    expect(fromKst).toEqual({ baseDate: '20260718', baseTime: '0500' });
    expect(fromUtc).toEqual(fromKst);
  });

  it('agrees across representations for an ULTRA instant too', () => {
    // 2026-07-18T06:45:00.000+09:00 === 2026-07-17T21:45:00.000Z.
    const fromKst = selectLatestKmaForecastBaseTimeAfterAvailabilityDelay({
      product: ULTRA,
      referenceEpochMilliseconds: kstEpochMs('2026-07-18T06:45:00.000'),
    });
    const fromUtc = selectLatestKmaForecastBaseTimeAfterAvailabilityDelay({
      product: ULTRA,
      referenceEpochMilliseconds: utcEpochMs('2026-07-17T21:45:00.000'),
    });
    expect(fromKst).toEqual({ baseDate: '20260718', baseTime: '0630' });
    expect(fromUtc).toEqual(fromKst);
  });
});

describe('selectLatestKmaForecastBaseTimeAfterAvailabilityDelay — invalid input', () => {
  // Shaped like a leaked secret. It must never appear in any thrown error message.
  const SECRET_SHAPED_VALUE_MUST_NOT_LEAK = 'SECRET_SHAPED_AVAILABILITY_TIME_MUST_NOT_LEAK_PR14';

  it.each([
    { label: 'NaN', value: Number.NaN },
    { label: 'Infinity', value: Number.POSITIVE_INFINITY },
    { label: '-Infinity', value: Number.NEGATIVE_INFINITY },
    { label: 'fractional', value: 1_700_000_000_000.5 },
    { label: '> MAX_SAFE_INTEGER', value: Number.MAX_SAFE_INTEGER + 1 },
    { label: '< MIN_SAFE_INTEGER', value: Number.MIN_SAFE_INTEGER - 1 },
  ])(
    'throws RangeError for referenceEpochMilliseconds = $label',
    ({ value }) => {
      expect(() =>
        selectLatestKmaForecastBaseTimeAfterAvailabilityDelay({
          product: SHORT,
          referenceEpochMilliseconds: value,
        }),
      ).toThrow(RangeError);
    },
  );

  it('throws RangeError (not TypeError) and does not leak a runtime string reference value', () => {
    let caught: unknown;
    try {
      selectLatestKmaForecastBaseTimeAfterAvailabilityDelay({
        product: SHORT,
        referenceEpochMilliseconds:
          SECRET_SHAPED_VALUE_MUST_NOT_LEAK as unknown as number,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RangeError);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect((caught as Error).message).not.toContain(SECRET_SHAPED_VALUE_MUST_NOT_LEAK);
    expect((caught as Error).message).not.toContain('{');
  });

  it.each([
    { label: 'null', value: null },
    { label: 'undefined', value: undefined },
  ])(
    'throws RangeError for a runtime $label reference cast',
    ({ value }) => {
      expect(() =>
        selectLatestKmaForecastBaseTimeAfterAvailabilityDelay({
          product: SHORT,
          referenceEpochMilliseconds: value as unknown as number,
        }),
      ).toThrow(RangeError);
    },
  );

  it('throws RangeError for an unsupported product (runtime cast)', () => {
    expect(() =>
      selectLatestKmaForecastBaseTimeAfterAvailabilityDelay({
        product: 'ULTRA_SHORT_NOWCAST' as KmaForecastProduct,
        referenceEpochMilliseconds: kstEpochMs('2026-07-18T12:00:00.000'),
      }),
    ).toThrow(RangeError);
  });

  it.each([
    { label: 'null', value: null },
    { label: 'undefined', value: undefined },
  ])('throws RangeError for a runtime $label product cast', ({ value }) => {
    expect(() =>
      selectLatestKmaForecastBaseTimeAfterAvailabilityDelay({
        product: value as unknown as KmaForecastProduct,
        referenceEpochMilliseconds: kstEpochMs('2026-07-18T12:00:00.000'),
      }),
    ).toThrow(RangeError);
  });

  it('does not leak the raw product value in the unsupported-product RangeError', () => {
    let message = '';
    try {
      selectLatestKmaForecastBaseTimeAfterAvailabilityDelay({
        product: SECRET_SHAPED_VALUE_MUST_NOT_LEAK as unknown as KmaForecastProduct,
        referenceEpochMilliseconds: kstEpochMs('2026-07-18T12:00:00.000'),
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(() =>
      selectLatestKmaForecastBaseTimeAfterAvailabilityDelay({
        product: SECRET_SHAPED_VALUE_MUST_NOT_LEAK as unknown as KmaForecastProduct,
        referenceEpochMilliseconds: kstEpochMs('2026-07-18T12:00:00.000'),
      }),
    ).toThrow(RangeError);
    expect(message).not.toContain(SECRET_SHAPED_VALUE_MUST_NOT_LEAK);
    expect(message).not.toContain('{');
  });

  it('does not mutate the input object when rejecting it', () => {
    const input: SelectLatestKmaForecastBaseTimeAfterAvailabilityDelayInput = {
      product: SHORT,
      referenceEpochMilliseconds: Number.NaN,
    };
    const snapshot = { ...input };
    expect(() =>
      selectLatestKmaForecastBaseTimeAfterAvailabilityDelay(input),
    ).toThrow(RangeError);
    expect(input).toEqual(snapshot);
  });
});

describe('selectLatestKmaForecastBaseTimeAfterAvailabilityDelay — immutability and freshness', () => {
  it('works with a frozen input and does not mutate it', () => {
    const input = Object.freeze({
      product: SHORT,
      referenceEpochMilliseconds: kstEpochMs('2026-07-18T05:10:00.000'),
    });
    const snapshot = { ...input };
    expect(selectLatestKmaForecastBaseTimeAfterAvailabilityDelay(input)).toEqual({
      baseDate: '20260718',
      baseTime: '0500',
    });
    expect(input).toEqual(snapshot);
  });

  it('does not observe an extra runtime input property in the output', () => {
    const input = {
      product: SHORT,
      referenceEpochMilliseconds: kstEpochMs('2026-07-18T05:10:00.000'),
      extra: 'SECRET_SHAPED_AVAILABILITY_TIME_MUST_NOT_LEAK_PR14',
    } as unknown as SelectLatestKmaForecastBaseTimeAfterAvailabilityDelayInput;
    const result = selectLatestKmaForecastBaseTimeAfterAvailabilityDelay(input);
    expect(Object.keys(result).sort()).toEqual(['baseDate', 'baseTime']);
    expect(JSON.stringify(result)).not.toContain('extra');
    expect(JSON.stringify(result)).not.toContain('SECRET_SHAPED');
  });

  it('output own keys are exactly baseDate and baseTime, both fixed-width digit strings', () => {
    const result: KmaForecastBaseTime = selectLatestKmaForecastBaseTimeAfterAvailabilityDelay({
      product: ULTRA,
      referenceEpochMilliseconds: kstEpochMs('2026-07-18T14:00:00.000'),
    });
    expect(Object.keys(result).sort()).toEqual(['baseDate', 'baseTime']);
    expect(result.baseDate).toMatch(/^\d{8}$/);
    expect(result.baseTime).toMatch(/^\d{4}$/);
  });

  it('returns deep-equal but distinct objects for the same input', () => {
    const build = () =>
      selectLatestKmaForecastBaseTimeAfterAvailabilityDelay({
        product: SHORT,
        referenceEpochMilliseconds: kstEpochMs('2026-07-18T14:30:00.000'),
      });
    const first = build();
    const second = build();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it('mutating a previous result does not affect the next call', () => {
    const reference = kstEpochMs('2026-07-18T14:30:00.000');
    const first = selectLatestKmaForecastBaseTimeAfterAvailabilityDelay({
      product: SHORT,
      referenceEpochMilliseconds: reference,
    });
    (first as { baseDate: string; baseTime: string }).baseDate = 'MUTATED';
    (first as { baseDate: string; baseTime: string }).baseTime = 'XXXX';
    const second = selectLatestKmaForecastBaseTimeAfterAvailabilityDelay({
      product: SHORT,
      referenceEpochMilliseconds: reference,
    });
    expect(second).toEqual({ baseDate: '20260718', baseTime: '1400' });
  });

  it('does not accumulate or mix state across alternating SHORT and ULTRA calls', () => {
    // SHORT 14:30 KST - 10m = 14:20 -> 1400; ULTRA 14:30 KST - 15m = 14:15 -> 1330.
    const runShort = () =>
      selectLatestKmaForecastBaseTimeAfterAvailabilityDelay({
        product: SHORT,
        referenceEpochMilliseconds: kstEpochMs('2026-07-18T14:30:00.000'),
      });
    const runUltra = () =>
      selectLatestKmaForecastBaseTimeAfterAvailabilityDelay({
        product: ULTRA,
        referenceEpochMilliseconds: kstEpochMs('2026-07-18T14:30:00.000'),
      });
    // Order-independent: interleaving the two products never changes either result.
    expect(runShort()).toEqual({ baseDate: '20260718', baseTime: '1400' });
    expect(runUltra()).toEqual({ baseDate: '20260718', baseTime: '1330' });
    expect(runUltra()).toEqual({ baseDate: '20260718', baseTime: '1330' });
    expect(runShort()).toEqual({ baseDate: '20260718', baseTime: '1400' });
  });
});
