import { describe, expect, it } from 'vitest';

import {
  KmaForecastProduct,
  selectLatestKmaForecastBaseTime,
  type KmaForecastBaseTime,
  type SelectLatestKmaForecastBaseTimeInput,
} from '../index';

const SHORT = KmaForecastProduct.SHORT_FORECAST;
const ULTRA = KmaForecastProduct.ULTRA_SHORT_FORECAST;

/**
 * Build an absolute epoch-millisecond reference from a KST wall clock. The offset is always
 * explicit (`+09:00`), so the input string is never a timezone-less local datetime and the
 * parsed instant is independent of the host timezone.
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

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

describe('selectLatestKmaForecastBaseTime — short forecast schedule', () => {
  // Official 단기예보 (getVilageFcst) issue times, KST. Table drives every one of the 8.
  const shortCases = [
    { baseTime: '0200', prevBaseTime: '2300', prevIsSameDay: false },
    { baseTime: '0500', prevBaseTime: '0200', prevIsSameDay: true },
    { baseTime: '0800', prevBaseTime: '0500', prevIsSameDay: true },
    { baseTime: '1100', prevBaseTime: '0800', prevIsSameDay: true },
    { baseTime: '1400', prevBaseTime: '1100', prevIsSameDay: true },
    { baseTime: '1700', prevBaseTime: '1400', prevIsSameDay: true },
    { baseTime: '2000', prevBaseTime: '1700', prevIsSameDay: true },
    { baseTime: '2300', prevBaseTime: '2000', prevIsSameDay: true },
  ] as const;

  const day = '2026-07-17';

  for (const { baseTime, prevBaseTime, prevIsSameDay } of shortCases) {
    const hh = baseTime.slice(0, 2);
    const mm = baseTime.slice(2);

    it(`selects ${baseTime} exactly at the ${baseTime} boundary (inclusive)`, () => {
      expect(
        selectLatestKmaForecastBaseTime({
          product: SHORT,
          referenceEpochMilliseconds: kstEpochMs(`${day}T${hh}:${mm}:00.000`),
        }),
      ).toEqual({ baseDate: '20260717', baseTime });
    });

    it(`selects the previous issue time one ms before ${baseTime}`, () => {
      const oneMsBefore = kstEpochMs(`${day}T${hh}:${mm}:00.000`) - 1;
      expect(
        selectLatestKmaForecastBaseTime({
          product: SHORT,
          referenceEpochMilliseconds: oneMsBefore,
        }),
      ).toEqual({
        baseDate: prevIsSameDay ? '20260717' : '20260716',
        baseTime: prevBaseTime,
      });
    });
  }

  // The exact boundaries called out as required.
  it.each([
    { at: '2026-07-17T01:59:59.999', baseDate: '20260716', baseTime: '2300' },
    { at: '2026-07-17T02:00:00.000', baseDate: '20260717', baseTime: '0200' },
    { at: '2026-07-17T04:59:59.999', baseDate: '20260717', baseTime: '0200' },
    { at: '2026-07-17T05:00:00.000', baseDate: '20260717', baseTime: '0500' },
    { at: '2026-07-17T22:59:59.999', baseDate: '20260717', baseTime: '2000' },
    { at: '2026-07-17T23:00:00.000', baseDate: '20260717', baseTime: '2300' },
    { at: '2026-07-17T23:59:59.999', baseDate: '20260717', baseTime: '2300' },
  ])('short: $at -> $baseDate/$baseTime', ({ at, baseDate, baseTime }) => {
    expect(
      selectLatestKmaForecastBaseTime({
        product: SHORT,
        referenceEpochMilliseconds: kstEpochMs(at),
      }),
    ).toEqual({ baseDate, baseTime });
  });

  it('selects the containing slot mid-interval (03:30 -> 0200)', () => {
    expect(
      selectLatestKmaForecastBaseTime({
        product: SHORT,
        referenceEpochMilliseconds: kstEpochMs('2026-07-17T03:30:00.000'),
      }),
    ).toEqual({ baseDate: '20260717', baseTime: '0200' });
  });

  it('produces fixed-width, digit-only output', () => {
    const result = selectLatestKmaForecastBaseTime({
      product: SHORT,
      referenceEpochMilliseconds: kstEpochMs('2026-07-17T14:00:00.000'),
    });
    expect(result.baseDate).toMatch(/^\d{8}$/);
    expect(result.baseTime).toMatch(/^\d{4}$/);
    expect(result.baseDate).toHaveLength(8);
    expect(result.baseTime).toHaveLength(4);
  });
});

describe('selectLatestKmaForecastBaseTime — ultra-short forecast schedule', () => {
  const day = '2026-07-17';

  // Official 초단기예보 (getUltraSrtFcst) issue times, KST: one per hour at HH30 (24 a day).
  for (let hour = 0; hour < 24; hour += 1) {
    const hh = pad2(hour);
    const baseTime = `${hh}30`;

    it(`selects ${baseTime} exactly at the ${hh}:30 boundary (inclusive)`, () => {
      expect(
        selectLatestKmaForecastBaseTime({
          product: ULTRA,
          referenceEpochMilliseconds: kstEpochMs(`${day}T${hh}:30:00.000`),
        }),
      ).toEqual({ baseDate: '20260717', baseTime });
    });
  }

  // The exact boundaries called out as required.
  it.each([
    { at: '2026-07-17T00:29:59.999', baseDate: '20260716', baseTime: '2330' },
    { at: '2026-07-17T00:30:00.000', baseDate: '20260717', baseTime: '0030' },
    { at: '2026-07-17T01:29:59.999', baseDate: '20260717', baseTime: '0030' },
    { at: '2026-07-17T01:30:00.000', baseDate: '20260717', baseTime: '0130' },
    { at: '2026-07-17T12:29:59.999', baseDate: '20260717', baseTime: '1130' },
    { at: '2026-07-17T12:30:00.000', baseDate: '20260717', baseTime: '1230' },
    { at: '2026-07-17T23:29:59.999', baseDate: '20260717', baseTime: '2230' },
    { at: '2026-07-17T23:30:00.000', baseDate: '20260717', baseTime: '2330' },
    { at: '2026-07-17T23:59:59.999', baseDate: '20260717', baseTime: '2330' },
  ])('ultra: $at -> $baseDate/$baseTime', ({ at, baseDate, baseTime }) => {
    expect(
      selectLatestKmaForecastBaseTime({
        product: ULTRA,
        referenceEpochMilliseconds: kstEpochMs(at),
      }),
    ).toEqual({ baseDate, baseTime });
  });

  it('selects the containing slot mid-interval (12:00 -> 1130)', () => {
    expect(
      selectLatestKmaForecastBaseTime({
        product: ULTRA,
        referenceEpochMilliseconds: kstEpochMs('2026-07-17T12:00:00.000'),
      }),
    ).toEqual({ baseDate: '20260717', baseTime: '1130' });
  });

  it('is a single hourly HH30 issuance, not two per hour (11:31 stays 1130)', () => {
    expect(
      selectLatestKmaForecastBaseTime({
        product: ULTRA,
        referenceEpochMilliseconds: kstEpochMs('2026-07-17T11:31:00.000'),
      }),
    ).toEqual({ baseDate: '20260717', baseTime: '1130' });
  });
});

describe('selectLatestKmaForecastBaseTime — date rollover', () => {
  it('rolls to the previous year at year end (short)', () => {
    expect(
      selectLatestKmaForecastBaseTime({
        product: SHORT,
        referenceEpochMilliseconds: kstEpochMs('2026-01-01T01:00:00.000'),
      }),
    ).toEqual({ baseDate: '20251231', baseTime: '2300' });
  });

  it('rolls to Feb 28 in a common year (short)', () => {
    expect(
      selectLatestKmaForecastBaseTime({
        product: SHORT,
        referenceEpochMilliseconds: kstEpochMs('2025-03-01T01:00:00.000'),
      }),
    ).toEqual({ baseDate: '20250228', baseTime: '2300' });
  });

  it('rolls to Feb 29 in a leap year (short)', () => {
    expect(
      selectLatestKmaForecastBaseTime({
        product: SHORT,
        referenceEpochMilliseconds: kstEpochMs('2024-03-01T01:00:00.000'),
      }),
    ).toEqual({ baseDate: '20240229', baseTime: '2300' });
  });

  it('rolls to the previous day before the first ultra issuance', () => {
    expect(
      selectLatestKmaForecastBaseTime({
        product: ULTRA,
        referenceEpochMilliseconds: kstEpochMs('2026-07-01T00:10:00.000'),
      }),
    ).toEqual({ baseDate: '20260630', baseTime: '2330' });
  });

  it('rolls to the previous month end (short, May 1 -> Apr 30)', () => {
    expect(
      selectLatestKmaForecastBaseTime({
        product: SHORT,
        referenceEpochMilliseconds: kstEpochMs('2026-05-01T01:00:00.000'),
      }),
    ).toEqual({ baseDate: '20260430', baseTime: '2300' });
  });

  it('uses the KST calendar date, not the UTC date, for the same absolute instant', () => {
    // 2026-07-16T20:00:00Z === 2026-07-17T05:00:00 KST. UTC date is the 16th; KST is the 17th.
    expect(
      selectLatestKmaForecastBaseTime({
        product: SHORT,
        referenceEpochMilliseconds: utcEpochMs('2026-07-16T20:00:00'),
      }),
    ).toEqual({ baseDate: '20260717', baseTime: '0500' });

    // 2026-07-16T15:30:00Z === 2026-07-17T00:30:00 KST — the first ultra issuance of the KST day.
    expect(
      selectLatestKmaForecastBaseTime({
        product: ULTRA,
        referenceEpochMilliseconds: utcEpochMs('2026-07-16T15:30:00'),
      }),
    ).toEqual({ baseDate: '20260717', baseTime: '0030' });
  });
});

describe('selectLatestKmaForecastBaseTime — lower-bound calendar boundary', () => {
  // The supported year policy is [1000, 9999] for BOTH the reference KST year and the final
  // selected base_date year. A previous-day rollover below the day's first issue time moves the
  // selected base_date one calendar year below the reference (1000-01-01 -> 0999-12-31), which
  // has no valid four-digit YYYY and must be rejected — never clamped or emitted as year 0999.

  it('throws RangeError when the SHORT previous-day rollover would select year 0999', () => {
    // 1000-01-01T01:59:59.999 KST is before the day's first SHORT issue (02:00), so the
    // selector would have to roll back to 0999-12-31 / 2300 — outside the supported range.
    expect(() =>
      selectLatestKmaForecastBaseTime({
        product: SHORT,
        referenceEpochMilliseconds: kstEpochMs('1000-01-01T01:59:59.999'),
      }),
    ).toThrow(RangeError);
  });

  it('returns the exact first SHORT issuance at the 1000 lower bound (10000101/0200)', () => {
    expect(
      selectLatestKmaForecastBaseTime({
        product: SHORT,
        referenceEpochMilliseconds: kstEpochMs('1000-01-01T02:00:00.000'),
      }),
    ).toEqual({ baseDate: '10000101', baseTime: '0200' });
  });

  it('throws RangeError when the ULTRA previous-day rollover would select year 0999', () => {
    // 1000-01-01T00:29:59.999 KST is before the day's first ULTRA issue (00:30), so the
    // selector would have to roll back to 0999-12-31 / 2330 — outside the supported range.
    expect(() =>
      selectLatestKmaForecastBaseTime({
        product: ULTRA,
        referenceEpochMilliseconds: kstEpochMs('1000-01-01T00:29:59.999'),
      }),
    ).toThrow(RangeError);
  });

  it('returns the exact first ULTRA issuance at the 1000 lower bound (10000101/0030)', () => {
    expect(
      selectLatestKmaForecastBaseTime({
        product: ULTRA,
        referenceEpochMilliseconds: kstEpochMs('1000-01-01T00:30:00.000'),
      }),
    ).toEqual({ baseDate: '10000101', baseTime: '0030' });
  });
});

describe('selectLatestKmaForecastBaseTime — invalid input', () => {
  const validReference = kstEpochMs('2026-07-17T12:00:00.000');

  // Shaped like a leaked secret. It must never appear in any thrown error message.
  const SECRET_SHAPED_VALUE_MUST_NOT_LEAK = 'SECRET_SHAPED_VALUE_MUST_NOT_LEAK_8C2F';

  it.each([
    { label: 'NaN', value: Number.NaN },
    { label: 'Infinity', value: Number.POSITIVE_INFINITY },
    { label: '-Infinity', value: Number.NEGATIVE_INFINITY },
    { label: 'fractional', value: 1_700_000_000_000.5 },
    { label: '> MAX_SAFE_INTEGER', value: Number.MAX_SAFE_INTEGER + 1 },
    { label: '< MIN_SAFE_INTEGER', value: Number.MIN_SAFE_INTEGER - 1 },
  ])('throws RangeError for referenceEpochMilliseconds = $label', ({ value }) => {
    expect(() =>
      selectLatestKmaForecastBaseTime({
        product: SHORT,
        referenceEpochMilliseconds: value,
      }),
    ).toThrow(RangeError);
  });

  it.each([
    { label: 'beyond Date range (positive)', value: 8_700_000_000_000_000 },
    { label: 'beyond Date range (negative)', value: -8_700_000_000_000_000 },
  ])('throws RangeError for an instant $label', ({ value }) => {
    expect(() =>
      selectLatestKmaForecastBaseTime({
        product: SHORT,
        referenceEpochMilliseconds: value,
      }),
    ).toThrow(RangeError);
  });

  it('throws RangeError when the KST year is below 1000', () => {
    expect(() =>
      selectLatestKmaForecastBaseTime({
        product: SHORT,
        referenceEpochMilliseconds: Date.parse('0999-12-31T00:00:00Z'),
      }),
    ).toThrow(RangeError);
  });

  it('throws RangeError when the KST year exceeds 9999', () => {
    // 9999-12-31T20:00:00Z shifts to 10000-01-01T05:00 KST.
    expect(() =>
      selectLatestKmaForecastBaseTime({
        product: SHORT,
        referenceEpochMilliseconds: Date.parse('9999-12-31T20:00:00Z'),
      }),
    ).toThrow(RangeError);
  });

  it('throws RangeError for an unsupported product (runtime cast)', () => {
    expect(() =>
      selectLatestKmaForecastBaseTime({
        product: 'ULTRA_SHORT_NOWCAST' as KmaForecastProduct,
        referenceEpochMilliseconds: validReference,
      }),
    ).toThrow(RangeError);
  });

  it('does not leak the raw product value in the unsupported-product RangeError', () => {
    let message = '';
    try {
      selectLatestKmaForecastBaseTime({
        product: SECRET_SHAPED_VALUE_MUST_NOT_LEAK as unknown as KmaForecastProduct,
        referenceEpochMilliseconds: validReference,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(() =>
      selectLatestKmaForecastBaseTime({
        product: SECRET_SHAPED_VALUE_MUST_NOT_LEAK as unknown as KmaForecastProduct,
        referenceEpochMilliseconds: validReference,
      }),
    ).toThrow(RangeError);
    // Value-free message: no secret marker, no serialized input object.
    expect(message).not.toContain(SECRET_SHAPED_VALUE_MUST_NOT_LEAK);
    expect(message).not.toContain('{');
  });

  it('does not leak a non-number reference value, and throws RangeError (not TypeError)', () => {
    let caught: unknown;
    try {
      selectLatestKmaForecastBaseTime({
        product: SHORT,
        referenceEpochMilliseconds:
          SECRET_SHAPED_VALUE_MUST_NOT_LEAK as unknown as number,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RangeError);
    expect(caught).not.toBeInstanceOf(TypeError);
    // Value-free message: no secret marker, no serialized input object.
    expect((caught as Error).message).not.toContain(SECRET_SHAPED_VALUE_MUST_NOT_LEAK);
    expect((caught as Error).message).not.toContain('{');
  });

  it('rejection is deterministic and does not leak the whole input object', () => {
    let message = '';
    try {
      selectLatestKmaForecastBaseTime({
        product: SHORT,
        referenceEpochMilliseconds: Number.NaN,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    // Same input throws the same way; the message names the field, not a serialized object.
    expect(() =>
      selectLatestKmaForecastBaseTime({
        product: SHORT,
        referenceEpochMilliseconds: Number.NaN,
      }),
    ).toThrow(RangeError);
    expect(message).not.toContain('{');
    expect(message).not.toContain('product');
  });

  it('does not mutate the input object when rejecting it', () => {
    const input: SelectLatestKmaForecastBaseTimeInput = {
      product: SHORT,
      referenceEpochMilliseconds: Number.NaN,
    };
    const snapshot = { ...input };
    expect(() => selectLatestKmaForecastBaseTime(input)).toThrow(RangeError);
    expect(input).toEqual(snapshot);
  });
});

describe('selectLatestKmaForecastBaseTime — immutability and reuse', () => {
  const reference = kstEpochMs('2026-07-17T14:30:00.000');
  const expectedShort: KmaForecastBaseTime = {
    baseDate: '20260717',
    baseTime: '1400',
  };

  it('works with a frozen input and does not mutate it', () => {
    const input = Object.freeze({
      product: SHORT,
      referenceEpochMilliseconds: reference,
    });
    const snapshot = { ...input };
    expect(selectLatestKmaForecastBaseTime(input)).toEqual(expectedShort);
    expect(input).toEqual(snapshot);
  });

  it('returns deep-equal but distinct objects for the same input', () => {
    const first = selectLatestKmaForecastBaseTime({
      product: SHORT,
      referenceEpochMilliseconds: reference,
    });
    const second = selectLatestKmaForecastBaseTime({
      product: SHORT,
      referenceEpochMilliseconds: reference,
    });
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it('mutating a previous result does not affect the next call', () => {
    const first = selectLatestKmaForecastBaseTime({
      product: SHORT,
      referenceEpochMilliseconds: reference,
    });
    (first as { baseDate: string; baseTime: string }).baseDate = 'MUTATED';
    (first as { baseDate: string; baseTime: string }).baseTime = 'XXXX';
    const second = selectLatestKmaForecastBaseTime({
      product: SHORT,
      referenceEpochMilliseconds: reference,
    });
    expect(second).toEqual(expectedShort);
  });

  it('does not accumulate state across alternating products', () => {
    const ultraReference = kstEpochMs('2026-07-17T14:30:00.000');
    const runShort = () =>
      selectLatestKmaForecastBaseTime({
        product: SHORT,
        referenceEpochMilliseconds: reference,
      });
    const runUltra = () =>
      selectLatestKmaForecastBaseTime({
        product: ULTRA,
        referenceEpochMilliseconds: ultraReference,
      });
    expect(runShort()).toEqual({ baseDate: '20260717', baseTime: '1400' });
    expect(runUltra()).toEqual({ baseDate: '20260717', baseTime: '1430' });
    expect(runShort()).toEqual({ baseDate: '20260717', baseTime: '1400' });
    expect(runUltra()).toEqual({ baseDate: '20260717', baseTime: '1430' });
  });
});
