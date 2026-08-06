import { describe, expect, it } from 'vitest';

import {
  selectLatestKmaCurrentObservationBaseTime,
  type KmaCurrentObservationBaseTime,
  type SelectLatestKmaCurrentObservationBaseTimeInput,
} from '../index';

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

describe('selectLatestKmaCurrentObservationBaseTime — hourly HH00 schedule', () => {
  const day = '2026-07-17';

  // Official 초단기실황 (getUltraSrtNcst) issue times, KST: one per hour at HH00 (24 a day).
  for (let hour = 0; hour < 24; hour += 1) {
    const hh = pad2(hour);
    const baseTime = `${hh}00`;

    it(`selects ${baseTime} exactly at the ${hh}:00 boundary (inclusive)`, () => {
      expect(
        selectLatestKmaCurrentObservationBaseTime({
          referenceEpochMilliseconds: kstEpochMs(`${day}T${hh}:00:00.000`),
        }),
      ).toEqual({ baseDate: '20260717', baseTime });
    });
  }

  // The exact boundaries called out as required.
  it.each([
    { at: '2026-07-17T00:00:00.000', baseDate: '20260717', baseTime: '0000' },
    { at: '2026-07-16T23:59:59.999', baseDate: '20260716', baseTime: '2300' },
    { at: '2026-07-17T05:59:59.999', baseDate: '20260717', baseTime: '0500' },
    { at: '2026-07-17T06:00:00.000', baseDate: '20260717', baseTime: '0600' },
    { at: '2026-07-17T23:00:00.000', baseDate: '20260717', baseTime: '2300' },
    { at: '2026-07-17T23:59:59.999', baseDate: '20260717', baseTime: '2300' },
  ])('$at -> $baseDate/$baseTime', ({ at, baseDate, baseTime }) => {
    expect(
      selectLatestKmaCurrentObservationBaseTime({
        referenceEpochMilliseconds: kstEpochMs(at),
      }),
    ).toEqual({ baseDate, baseTime });
  });

  it('selects the containing hour mid-interval (03:30 -> 0300)', () => {
    expect(
      selectLatestKmaCurrentObservationBaseTime({
        referenceEpochMilliseconds: kstEpochMs('2026-07-17T03:30:00.000'),
      }),
    ).toEqual({ baseDate: '20260717', baseTime: '0300' });
  });

  it('midnight selects the same KST day at 0000 (no previous-day rollover)', () => {
    expect(
      selectLatestKmaCurrentObservationBaseTime({
        referenceEpochMilliseconds: kstEpochMs('2026-07-17T00:00:00.000'),
      }),
    ).toEqual({ baseDate: '20260717', baseTime: '0000' });
  });

  it('one millisecond before midnight selects the previous day at 2300', () => {
    expect(
      selectLatestKmaCurrentObservationBaseTime({
        referenceEpochMilliseconds: kstEpochMs('2026-07-17T00:00:00.000') - 1,
      }),
    ).toEqual({ baseDate: '20260716', baseTime: '2300' });
  });

  it('produces fixed-width, digit-only output', () => {
    const result = selectLatestKmaCurrentObservationBaseTime({
      referenceEpochMilliseconds: kstEpochMs('2026-07-17T14:00:00.000'),
    });
    expect(result.baseDate).toMatch(/^\d{8}$/);
    expect(result.baseTime).toMatch(/^\d{4}$/);
    expect(result.baseDate).toHaveLength(8);
    expect(result.baseTime).toHaveLength(4);
  });

  it('always selects a base time exactly on the hour (mm === "00")', () => {
    const result = selectLatestKmaCurrentObservationBaseTime({
      referenceEpochMilliseconds: kstEpochMs('2026-07-17T14:37:12.345'),
    });
    expect(result.baseTime.slice(2)).toBe('00');
    expect(result.baseTime).toBe('1400');
  });
});

describe('selectLatestKmaCurrentObservationBaseTime — date rollover', () => {
  it('rolls to the previous year at year end', () => {
    expect(
      selectLatestKmaCurrentObservationBaseTime({
        referenceEpochMilliseconds: kstEpochMs('2026-01-01T00:00:00.000') - 1,
      }),
    ).toEqual({ baseDate: '20251231', baseTime: '2300' });
  });

  it('rolls to Feb 28 in a common year', () => {
    expect(
      selectLatestKmaCurrentObservationBaseTime({
        referenceEpochMilliseconds: kstEpochMs('2025-03-01T00:00:00.000') - 1,
      }),
    ).toEqual({ baseDate: '20250228', baseTime: '2300' });
  });

  it('rolls to Feb 29 in a leap year', () => {
    expect(
      selectLatestKmaCurrentObservationBaseTime({
        referenceEpochMilliseconds: kstEpochMs('2024-03-01T00:00:00.000') - 1,
      }),
    ).toEqual({ baseDate: '20240229', baseTime: '2300' });
  });

  it('rolls to the previous month end (May 1 -> Apr 30)', () => {
    expect(
      selectLatestKmaCurrentObservationBaseTime({
        referenceEpochMilliseconds: kstEpochMs('2026-05-01T00:00:00.000') - 1,
      }),
    ).toEqual({ baseDate: '20260430', baseTime: '2300' });
  });

  it('uses the KST calendar date and hour, not the UTC ones, for the same absolute instant', () => {
    // 2026-07-16T20:00:00Z === 2026-07-17T05:00:00 KST. UTC date is the 16th; KST is the 17th.
    expect(
      selectLatestKmaCurrentObservationBaseTime({
        referenceEpochMilliseconds: utcEpochMs('2026-07-16T20:00:00'),
      }),
    ).toEqual({ baseDate: '20260717', baseTime: '0500' });

    // 2026-07-16T15:00:00Z === 2026-07-17T00:00:00 KST — the first current-observation issuance
    // of the KST day.
    expect(
      selectLatestKmaCurrentObservationBaseTime({
        referenceEpochMilliseconds: utcEpochMs('2026-07-16T15:00:00'),
      }),
    ).toEqual({ baseDate: '20260717', baseTime: '0000' });
  });
});

describe('selectLatestKmaCurrentObservationBaseTime — lower-bound calendar boundary', () => {
  // Unlike the forecast selectors (./issue-time.ts), the current-observation schedule issues at
  // 0000 — the very first minute of the KST day — so there is no previous-day rollover and thus
  // no way for the selected base_date year to fall below the reference's own KST year. The
  // 1000-01-01 lower bound is therefore always the exact first issuance, never a RangeError.

  it('returns the exact first issuance at the 1000 lower bound (10000101/0000)', () => {
    expect(
      selectLatestKmaCurrentObservationBaseTime({
        referenceEpochMilliseconds: kstEpochMs('1000-01-01T00:00:00.000'),
      }),
    ).toEqual({ baseDate: '10000101', baseTime: '0000' });
  });

  it('throws RangeError one millisecond before the 1000 lower bound', () => {
    expect(() =>
      selectLatestKmaCurrentObservationBaseTime({
        referenceEpochMilliseconds: kstEpochMs('1000-01-01T00:00:00.000') - 1,
      }),
    ).toThrow(RangeError);
  });
});

describe('selectLatestKmaCurrentObservationBaseTime — invalid input', () => {
  // Shaped like a leaked secret. It must never appear in any thrown error message.
  const SECRET_SHAPED_VALUE_MUST_NOT_LEAK = 'SECRET_SHAPED_VALUE_MUST_NOT_LEAK_9D1A';

  it.each([
    { label: 'NaN', value: Number.NaN },
    { label: 'Infinity', value: Number.POSITIVE_INFINITY },
    { label: '-Infinity', value: Number.NEGATIVE_INFINITY },
    { label: 'fractional', value: 1_700_000_000_000.5 },
    { label: '> MAX_SAFE_INTEGER', value: Number.MAX_SAFE_INTEGER + 1 },
    { label: '< MIN_SAFE_INTEGER', value: Number.MIN_SAFE_INTEGER - 1 },
  ])('throws RangeError for referenceEpochMilliseconds = $label', ({ value }) => {
    expect(() =>
      selectLatestKmaCurrentObservationBaseTime({
        referenceEpochMilliseconds: value,
      }),
    ).toThrow(RangeError);
  });

  it.each([
    { label: 'beyond Date range (positive)', value: 8_700_000_000_000_000 },
    { label: 'beyond Date range (negative)', value: -8_700_000_000_000_000 },
  ])('throws RangeError for an instant $label', ({ value }) => {
    expect(() =>
      selectLatestKmaCurrentObservationBaseTime({
        referenceEpochMilliseconds: value,
      }),
    ).toThrow(RangeError);
  });

  it('throws RangeError when the KST year is below 1000', () => {
    expect(() =>
      selectLatestKmaCurrentObservationBaseTime({
        referenceEpochMilliseconds: Date.parse('0999-12-31T00:00:00Z'),
      }),
    ).toThrow(RangeError);
  });

  it('throws RangeError when the KST year exceeds 9999', () => {
    // 9999-12-31T20:00:00Z shifts to 10000-01-01T05:00 KST.
    expect(() =>
      selectLatestKmaCurrentObservationBaseTime({
        referenceEpochMilliseconds: Date.parse('9999-12-31T20:00:00Z'),
      }),
    ).toThrow(RangeError);
  });

  it('does not leak a non-number reference value, and throws RangeError (not TypeError)', () => {
    let caught: unknown;
    try {
      selectLatestKmaCurrentObservationBaseTime({
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
      selectLatestKmaCurrentObservationBaseTime({
        referenceEpochMilliseconds: Number.NaN,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    // Same input throws the same way; the message names the field, not a serialized object.
    expect(() =>
      selectLatestKmaCurrentObservationBaseTime({
        referenceEpochMilliseconds: Number.NaN,
      }),
    ).toThrow(RangeError);
    expect(message).not.toContain('{');
  });

  it('does not mutate the input object when rejecting it', () => {
    const input: SelectLatestKmaCurrentObservationBaseTimeInput = {
      referenceEpochMilliseconds: Number.NaN,
    };
    const snapshot = { ...input };
    expect(() => selectLatestKmaCurrentObservationBaseTime(input)).toThrow(RangeError);
    expect(input).toEqual(snapshot);
  });
});

describe('selectLatestKmaCurrentObservationBaseTime — immutability and reuse', () => {
  const reference = kstEpochMs('2026-07-17T14:30:00.000');
  const expected: KmaCurrentObservationBaseTime = {
    baseDate: '20260717',
    baseTime: '1400',
  };

  it('works with a frozen input and does not mutate it', () => {
    const input = Object.freeze({
      referenceEpochMilliseconds: reference,
    });
    const snapshot = { ...input };
    expect(selectLatestKmaCurrentObservationBaseTime(input)).toEqual(expected);
    expect(input).toEqual(snapshot);
  });

  it('returns deep-equal but distinct objects for the same input', () => {
    const first = selectLatestKmaCurrentObservationBaseTime({
      referenceEpochMilliseconds: reference,
    });
    const second = selectLatestKmaCurrentObservationBaseTime({
      referenceEpochMilliseconds: reference,
    });
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it('mutating a previous result does not affect the next call', () => {
    const first = selectLatestKmaCurrentObservationBaseTime({
      referenceEpochMilliseconds: reference,
    });
    (first as { baseDate: string; baseTime: string }).baseDate = 'MUTATED';
    (first as { baseDate: string; baseTime: string }).baseTime = 'XXXX';
    const second = selectLatestKmaCurrentObservationBaseTime({
      referenceEpochMilliseconds: reference,
    });
    expect(second).toEqual(expected);
  });

  it('does not accumulate state across calls with different references', () => {
    const otherReference = kstEpochMs('2026-07-17T20:00:00.000');
    const runFirst = () =>
      selectLatestKmaCurrentObservationBaseTime({ referenceEpochMilliseconds: reference });
    const runSecond = () =>
      selectLatestKmaCurrentObservationBaseTime({
        referenceEpochMilliseconds: otherReference,
      });
    expect(runFirst()).toEqual({ baseDate: '20260717', baseTime: '1400' });
    expect(runSecond()).toEqual({ baseDate: '20260717', baseTime: '2000' });
    expect(runFirst()).toEqual({ baseDate: '20260717', baseTime: '1400' });
    expect(runSecond()).toEqual({ baseDate: '20260717', baseTime: '2000' });
  });
});
