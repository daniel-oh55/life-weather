import { describe, expect, it } from 'vitest';

import {
  selectLatestKmaCurrentObservationBaseTime,
  selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay,
  type KmaCurrentObservationBaseTime,
  type SelectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelayInput,
} from '../index';

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

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

describe('selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay — inclusive +10m threshold, all 24 hours', () => {
  const day = '2026-07-18';

  for (let hour = 0; hour < 24; hour += 1) {
    const hh = pad2(hour);
    const baseTime = `${hh}00`;
    const availableAt = `${day}T${hh}:10:00.000`;

    it(`selects ${baseTime} exactly at ${hh}:10:00.000 (issuance + 10m, inclusive)`, () => {
      expect(
        selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay({
          referenceEpochMilliseconds: kstEpochMs(availableAt),
        }),
      ).toEqual({ baseDate: '20260718', baseTime });
    });

    it(`selects the previous hour one millisecond before ${hh}:10:00.000`, () => {
      const oneMsBefore = kstEpochMs(availableAt) - 1;
      const prevHour = (hour + 23) % 24;
      const expectedBaseTime = `${pad2(prevHour)}00`;
      const expectedBaseDate = hour === 0 ? '20260717' : '20260718';

      expect(
        selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay({
          referenceEpochMilliseconds: oneMsBefore,
        }),
      ).toEqual({ baseDate: expectedBaseDate, baseTime: expectedBaseTime });
    });
  }
});

describe('selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay — exact millisecond boundary', () => {
  it.each([
    { at: '2026-07-18T05:09:59.999', baseDate: '20260718', baseTime: '0400' },
    { at: '2026-07-18T05:10:00.000', baseDate: '20260718', baseTime: '0500' },
    { at: '2026-07-18T05:10:00.001', baseDate: '20260718', baseTime: '0500' },
    { at: '2026-07-18T00:09:59.999', baseDate: '20260717', baseTime: '2300' },
    { at: '2026-07-18T00:10:00.000', baseDate: '20260718', baseTime: '0000' },
    { at: '2026-07-18T00:10:00.001', baseDate: '20260718', baseTime: '0000' },
  ])('$at -> $baseDate/$baseTime', ({ at, baseDate, baseTime }) => {
    expect(
      selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay({
        referenceEpochMilliseconds: kstEpochMs(at),
      }),
    ).toEqual({ baseDate, baseTime });
  });
});

describe('selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay — date rollover', () => {
  it.each([
    // Year rollover.
    { at: '2026-01-01T00:09:59.999', baseDate: '20251231', baseTime: '2300' },
    { at: '2026-01-01T00:10:00.000', baseDate: '20260101', baseTime: '0000' },
    // Month-end rollover.
    { at: '2026-08-01T00:09:59.999', baseDate: '20260731', baseTime: '2300' },
    { at: '2026-08-01T00:10:00.000', baseDate: '20260801', baseTime: '0000' },
    // Common-year February.
    { at: '2025-03-01T00:09:59.999', baseDate: '20250228', baseTime: '2300' },
    { at: '2025-03-01T00:10:00.000', baseDate: '20250301', baseTime: '0000' },
    // Leap-year February.
    { at: '2024-03-01T00:09:59.999', baseDate: '20240229', baseTime: '2300' },
    { at: '2024-03-01T00:10:00.000', baseDate: '20240301', baseTime: '0000' },
    // Non-midnight month rollover (May 1 -> Apr 30).
    { at: '2026-05-01T00:09:59.999', baseDate: '20260430', baseTime: '2300' },
  ])('$at -> $baseDate/$baseTime', ({ at, baseDate, baseTime }) => {
    expect(
      selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay({
        referenceEpochMilliseconds: kstEpochMs(at),
      }),
    ).toEqual({ baseDate, baseTime });
  });
});

describe('selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay — timezone-independent absolute instant', () => {
  it('gives the same result for the same instant written as +09:00 KST and as UTC Z', () => {
    // 2026-07-18T05:10:00.000+09:00 === 2026-07-17T20:10:00.000Z (the same absolute instant).
    const fromKst = selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay({
      referenceEpochMilliseconds: kstEpochMs('2026-07-18T05:10:00.000'),
    });
    const fromUtc = selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay({
      referenceEpochMilliseconds: utcEpochMs('2026-07-17T20:10:00.000'),
    });
    expect(fromKst).toEqual({ baseDate: '20260718', baseTime: '0500' });
    expect(fromUtc).toEqual(fromKst);
  });
});

describe('selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay — supported-year lower bound', () => {
  // The [1000, 9999] policy is owned by the schedule selector and applies to the
  // availability-adjusted selection too: an adjusted instant that rolls the base_date into 0999
  // is rejected — never clamped or emitted as year 0999.

  it('throws RangeError when the availability-adjusted selection rolls into year 0999', () => {
    // 1000-01-01T00:09:59.999 KST - 10m = 0999-12-31T23:59:59.999.
    expect(() =>
      selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay({
        referenceEpochMilliseconds: kstEpochMs('1000-01-01T00:09:59.999'),
      }),
    ).toThrow(RangeError);
  });

  it('returns the exact first issuance at the 1000 lower bound (10000101/0000)', () => {
    expect(
      selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay({
        referenceEpochMilliseconds: kstEpochMs('1000-01-01T00:10:00.000'),
      }),
    ).toEqual({ baseDate: '10000101', baseTime: '0000' });
  });

  it('does not throw for the original reference itself at the 1000 lower bound (original-input validation passes)', () => {
    // 1000-01-01T00:00:00.000 KST is itself a supported original reference; the adjusted instant
    // (0999-12-31T23:50:00.000) is what triggers the RangeError, exercised above.
    expect(() =>
      selectLatestKmaCurrentObservationBaseTime({
        referenceEpochMilliseconds: kstEpochMs('1000-01-01T00:00:00.000'),
      }),
    ).not.toThrow();
  });
});

describe('selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay — supported-year upper bound', () => {
  const upperBoundEpochMs = kstEpochMs('9999-12-31T23:59:59.999');

  it('returns the exact last supported issuance at the 9999 upper bound (99991231/2300)', () => {
    // 9999-12-31T23:59:59.999 - 10m = 9999-12-31T23:49:59.999, still within 2300.
    expect(
      selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay({
        referenceEpochMilliseconds: upperBoundEpochMs,
      }),
    ).toEqual({ baseDate: '99991231', baseTime: '2300' });
  });

  it('throws RangeError one millisecond after the 9999 upper bound (original-input validation)', () => {
    expect(() =>
      selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay({
        referenceEpochMilliseconds: upperBoundEpochMs + 1,
      }),
    ).toThrow(RangeError);
  });
});

describe('selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay — contrast with the schedule selector', () => {
  it('05:00 KST: scheduled -> 0500, availability-delay -> 0400', () => {
    const reference = kstEpochMs('2026-07-18T05:00:00.000');
    expect(
      selectLatestKmaCurrentObservationBaseTime({ referenceEpochMilliseconds: reference }),
    ).toEqual({ baseDate: '20260718', baseTime: '0500' });
    expect(
      selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay({
        referenceEpochMilliseconds: reference,
      }),
    ).toEqual({ baseDate: '20260718', baseTime: '0400' });
  });

  it('05:10 KST: both selectors -> 0500', () => {
    const reference = kstEpochMs('2026-07-18T05:10:00.000');
    expect(
      selectLatestKmaCurrentObservationBaseTime({ referenceEpochMilliseconds: reference }),
    ).toEqual({ baseDate: '20260718', baseTime: '0500' });
    expect(
      selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay({
        referenceEpochMilliseconds: reference,
      }),
    ).toEqual({ baseDate: '20260718', baseTime: '0500' });
  });
});

describe('selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay — invalid input', () => {
  // Shaped like a leaked secret. It must never appear in any thrown error message.
  const SECRET_SHAPED_VALUE_MUST_NOT_LEAK =
    'SECRET_SHAPED_CURRENT_AVAILABILITY_TIME_MUST_NOT_LEAK_PR79';

  it.each([
    { label: 'NaN', value: Number.NaN },
    { label: 'Infinity', value: Number.POSITIVE_INFINITY },
    { label: '-Infinity', value: Number.NEGATIVE_INFINITY },
    { label: 'fractional', value: 1_700_000_000_000.5 },
    { label: '> MAX_SAFE_INTEGER', value: Number.MAX_SAFE_INTEGER + 1 },
    { label: '< MIN_SAFE_INTEGER', value: Number.MIN_SAFE_INTEGER - 1 },
  ])('throws RangeError for referenceEpochMilliseconds = $label', ({ value }) => {
    expect(() =>
      selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay({
        referenceEpochMilliseconds: value,
      }),
    ).toThrow(RangeError);
  });

  it.each([
    { label: 'beyond Date range (positive)', value: 8_700_000_000_000_000 },
    { label: 'beyond Date range (negative)', value: -8_700_000_000_000_000 },
  ])('throws RangeError for an instant $label', ({ value }) => {
    expect(() =>
      selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay({
        referenceEpochMilliseconds: value,
      }),
    ).toThrow(RangeError);
  });

  it('throws RangeError when the original KST year is below 1000', () => {
    expect(() =>
      selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay({
        referenceEpochMilliseconds: Date.parse('0999-12-31T00:00:00Z'),
      }),
    ).toThrow(RangeError);
  });

  it('throws RangeError when the original KST year exceeds 9999', () => {
    // 9999-12-31T20:00:00Z shifts to 10000-01-01T05:00 KST.
    expect(() =>
      selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay({
        referenceEpochMilliseconds: Date.parse('9999-12-31T20:00:00Z'),
      }),
    ).toThrow(RangeError);
  });

  it('throws RangeError (not TypeError) and does not leak a runtime string reference value', () => {
    let caught: unknown;
    try {
      selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay({
        referenceEpochMilliseconds: SECRET_SHAPED_VALUE_MUST_NOT_LEAK as unknown as number,
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
  ])('throws RangeError for a runtime $label reference cast', ({ value }) => {
    expect(() =>
      selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay({
        referenceEpochMilliseconds: value as unknown as number,
      }),
    ).toThrow(RangeError);
  });

  it('rejection is deterministic and does not leak the whole input object', () => {
    let message = '';
    try {
      selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay({
        referenceEpochMilliseconds: Number.NaN,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(() =>
      selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay({
        referenceEpochMilliseconds: Number.NaN,
      }),
    ).toThrow(RangeError);
    expect(message).not.toContain('{');
  });

  it('does not mutate the input object when rejecting it', () => {
    const input: SelectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelayInput = {
      referenceEpochMilliseconds: Number.NaN,
    };
    const snapshot = { ...input };
    expect(() =>
      selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay(input),
    ).toThrow(RangeError);
    expect(input).toEqual(snapshot);
  });
});

describe('selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay — immutability and freshness', () => {
  it('works with a frozen input and does not mutate it', () => {
    const input = Object.freeze({
      referenceEpochMilliseconds: kstEpochMs('2026-07-18T05:10:00.000'),
    });
    const snapshot = { ...input };
    expect(
      selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay(input),
    ).toEqual({ baseDate: '20260718', baseTime: '0500' });
    expect(input).toEqual(snapshot);
  });

  it('does not observe an extra runtime input property in the output', () => {
    const input = {
      referenceEpochMilliseconds: kstEpochMs('2026-07-18T05:10:00.000'),
      extra: 'SECRET_SHAPED_CURRENT_AVAILABILITY_TIME_MUST_NOT_LEAK_PR79',
    } as unknown as SelectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelayInput;
    const result = selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay(input);
    expect(Object.keys(result).sort()).toEqual(['baseDate', 'baseTime']);
    expect(JSON.stringify(result)).not.toContain('extra');
    expect(JSON.stringify(result)).not.toContain('SECRET_SHAPED');
  });

  it('output own keys are exactly baseDate and baseTime, both fixed-width digit strings', () => {
    const result: KmaCurrentObservationBaseTime =
      selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay({
        referenceEpochMilliseconds: kstEpochMs('2026-07-18T14:10:00.000'),
      });
    expect(Object.keys(result).sort()).toEqual(['baseDate', 'baseTime']);
    expect(result.baseDate).toMatch(/^\d{8}$/);
    expect(result.baseTime).toMatch(/^\d{4}$/);
  });

  it('returns deep-equal but distinct objects for the same input', () => {
    const build = () =>
      selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay({
        referenceEpochMilliseconds: kstEpochMs('2026-07-18T14:30:00.000'),
      });
    const first = build();
    const second = build();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it('mutating a previous result does not affect the next call', () => {
    const reference = kstEpochMs('2026-07-18T14:30:00.000');
    const first = selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay({
      referenceEpochMilliseconds: reference,
    });
    (first as { baseDate: string; baseTime: string }).baseDate = 'MUTATED';
    (first as { baseDate: string; baseTime: string }).baseTime = 'XXXX';
    const second = selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay({
      referenceEpochMilliseconds: reference,
    });
    expect(second).toEqual({ baseDate: '20260718', baseTime: '1400' });
  });

  it('does not accumulate state across calls with different references', () => {
    const first = kstEpochMs('2026-07-18T14:30:00.000');
    const second = kstEpochMs('2026-07-18T20:30:00.000');
    const runFirst = () =>
      selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay({
        referenceEpochMilliseconds: first,
      });
    const runSecond = () =>
      selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay({
        referenceEpochMilliseconds: second,
      });
    expect(runFirst()).toEqual({ baseDate: '20260718', baseTime: '1400' });
    expect(runSecond()).toEqual({ baseDate: '20260718', baseTime: '2000' });
    expect(runFirst()).toEqual({ baseDate: '20260718', baseTime: '1400' });
    expect(runSecond()).toEqual({ baseDate: '20260718', baseTime: '2000' });
  });
});
