import { describe, expect, it } from 'vitest';

import {
  selectLatestKmaMidtermIssuance,
  type KmaMidtermIssuance,
  type SelectLatestKmaMidtermIssuanceInput,
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

describe('selectLatestKmaMidtermIssuance — 06:00/18:00 KST schedule', () => {
  const day = '2026-07-17';

  it('selects same-day 0600 exactly at the 06:00 boundary (inclusive)', () => {
    expect(
      selectLatestKmaMidtermIssuance({
        referenceEpochMilliseconds: kstEpochMs(`${day}T06:00:00.000`),
      }),
    ).toEqual({ tmFc: '202607170600' });
  });

  it('selects previous-day 1800 one ms before the 06:00 boundary', () => {
    expect(
      selectLatestKmaMidtermIssuance({
        referenceEpochMilliseconds: kstEpochMs(`${day}T06:00:00.000`) - 1,
      }),
    ).toEqual({ tmFc: '202607161800' });
  });

  it('selects same-day 1800 exactly at the 18:00 boundary (inclusive)', () => {
    expect(
      selectLatestKmaMidtermIssuance({
        referenceEpochMilliseconds: kstEpochMs(`${day}T18:00:00.000`),
      }),
    ).toEqual({ tmFc: '202607171800' });
  });

  it('selects same-day 0600 one ms before the 18:00 boundary', () => {
    expect(
      selectLatestKmaMidtermIssuance({
        referenceEpochMilliseconds: kstEpochMs(`${day}T18:00:00.000`) - 1,
      }),
    ).toEqual({ tmFc: '202607170600' });
  });

  it('selects previous-day 1800 shortly after midnight KST', () => {
    expect(
      selectLatestKmaMidtermIssuance({
        referenceEpochMilliseconds: kstEpochMs(`${day}T00:10:00.000`),
      }),
    ).toEqual({ tmFc: '202607161800' });
  });

  it('selects the containing slot mid-interval (12:00 -> 0600)', () => {
    expect(
      selectLatestKmaMidtermIssuance({
        referenceEpochMilliseconds: kstEpochMs(`${day}T12:00:00.000`),
      }),
    ).toEqual({ tmFc: '202607170600' });
  });

  it('selects the containing slot mid-interval (23:59:59.999 -> 1800)', () => {
    expect(
      selectLatestKmaMidtermIssuance({
        referenceEpochMilliseconds: kstEpochMs(`${day}T23:59:59.999`),
      }),
    ).toEqual({ tmFc: '202607171800' });
  });

  it('produces a fixed-width, digit-only 12-character tmFc', () => {
    const result = selectLatestKmaMidtermIssuance({
      referenceEpochMilliseconds: kstEpochMs(`${day}T14:00:00.000`),
    });
    expect(result.tmFc).toMatch(/^\d{12}$/);
    expect(result.tmFc).toHaveLength(12);
    expect(result.tmFc.endsWith('0600') || result.tmFc.endsWith('1800')).toBe(true);
  });
});

describe('selectLatestKmaMidtermIssuance — date rollover', () => {
  it('rolls to the previous year at year end', () => {
    expect(
      selectLatestKmaMidtermIssuance({
        referenceEpochMilliseconds: kstEpochMs('2026-01-01T01:00:00.000'),
      }),
    ).toEqual({ tmFc: '202512311800' });
  });

  it('rolls to Feb 28 in a common year', () => {
    expect(
      selectLatestKmaMidtermIssuance({
        referenceEpochMilliseconds: kstEpochMs('2025-03-01T01:00:00.000'),
      }),
    ).toEqual({ tmFc: '202502281800' });
  });

  it('rolls to Feb 29 in a leap year', () => {
    expect(
      selectLatestKmaMidtermIssuance({
        referenceEpochMilliseconds: kstEpochMs('2024-03-01T01:00:00.000'),
      }),
    ).toEqual({ tmFc: '202402291800' });
  });

  it('rolls to the previous month end (May 1 -> Apr 30)', () => {
    expect(
      selectLatestKmaMidtermIssuance({
        referenceEpochMilliseconds: kstEpochMs('2026-05-01T01:00:00.000'),
      }),
    ).toEqual({ tmFc: '202604301800' });
  });

  it('uses the KST calendar date, not the UTC date, for the same absolute instant', () => {
    // 2026-07-16T20:00:00Z === 2026-07-17T05:00:00 KST (before 06:00) -> previous-day 1800.
    expect(
      selectLatestKmaMidtermIssuance({
        referenceEpochMilliseconds: utcEpochMs('2026-07-16T20:00:00'),
      }),
    ).toEqual({ tmFc: '202607161800' });

    // 2026-07-16T21:00:00Z === 2026-07-17T06:00:00 KST -> same-day 0600.
    expect(
      selectLatestKmaMidtermIssuance({
        referenceEpochMilliseconds: utcEpochMs('2026-07-16T21:00:00'),
      }),
    ).toEqual({ tmFc: '202607170600' });
  });
});

describe('selectLatestKmaMidtermIssuance — lower-bound calendar boundary', () => {
  it('returns the exact first issuance at the 1000 lower bound (100001010600)', () => {
    expect(
      selectLatestKmaMidtermIssuance({
        referenceEpochMilliseconds: kstEpochMs('1000-01-01T06:00:00.000'),
      }),
    ).toEqual({ tmFc: '100001010600' });
  });

  it('throws RangeError when the previous-day rollover would select year 0999', () => {
    // 1000-01-01T05:59:59.999 KST is before the day's first issuance (06:00), so the selector
    // would have to roll back to 0999-12-31 / 1800 — outside the supported range.
    expect(() =>
      selectLatestKmaMidtermIssuance({
        referenceEpochMilliseconds: kstEpochMs('1000-01-01T05:59:59.999'),
      }),
    ).toThrow(RangeError);
  });
});

describe('selectLatestKmaMidtermIssuance — upper-bound calendar boundary', () => {
  const upperBoundEpochMs = kstEpochMs('9999-12-31T23:59:59.999');

  it('returns the exact last supported issuance at the 9999 upper bound (999912311800)', () => {
    expect(
      selectLatestKmaMidtermIssuance({
        referenceEpochMilliseconds: upperBoundEpochMs,
      }),
    ).toEqual({ tmFc: '999912311800' });
  });

  it('throws RangeError one millisecond after the 9999 upper bound', () => {
    expect(() =>
      selectLatestKmaMidtermIssuance({
        referenceEpochMilliseconds: upperBoundEpochMs + 1,
      }),
    ).toThrow(RangeError);
  });
});

describe('selectLatestKmaMidtermIssuance — invalid input', () => {
  // Shaped like a leaked secret. It must never appear in any thrown error message.
  const SECRET_SHAPED_VALUE_MUST_NOT_LEAK = 'SECRET_SHAPED_VALUE_MUST_NOT_LEAK_4F7E';

  it.each([
    { label: 'NaN', value: Number.NaN },
    { label: 'Infinity', value: Number.POSITIVE_INFINITY },
    { label: '-Infinity', value: Number.NEGATIVE_INFINITY },
    { label: 'fractional', value: 1_700_000_000_000.5 },
    { label: '> MAX_SAFE_INTEGER', value: Number.MAX_SAFE_INTEGER + 1 },
    { label: '< MIN_SAFE_INTEGER', value: Number.MIN_SAFE_INTEGER - 1 },
  ])('throws RangeError for referenceEpochMilliseconds = $label', ({ value }) => {
    expect(() =>
      selectLatestKmaMidtermIssuance({
        referenceEpochMilliseconds: value,
      }),
    ).toThrow(RangeError);
  });

  it.each([
    { label: 'beyond Date range (positive)', value: 8_700_000_000_000_000 },
    { label: 'beyond Date range (negative)', value: -8_700_000_000_000_000 },
  ])('throws RangeError for an instant $label', ({ value }) => {
    expect(() =>
      selectLatestKmaMidtermIssuance({
        referenceEpochMilliseconds: value,
      }),
    ).toThrow(RangeError);
  });

  it('throws RangeError when the KST year is below 1000', () => {
    expect(() =>
      selectLatestKmaMidtermIssuance({
        referenceEpochMilliseconds: Date.parse('0999-12-31T00:00:00Z'),
      }),
    ).toThrow(RangeError);
  });

  it('throws RangeError when the KST year exceeds 9999', () => {
    // 9999-12-31T20:00:00Z shifts to 10000-01-01T05:00 KST.
    expect(() =>
      selectLatestKmaMidtermIssuance({
        referenceEpochMilliseconds: Date.parse('9999-12-31T20:00:00Z'),
      }),
    ).toThrow(RangeError);
  });

  it('does not leak a non-number reference value, and throws RangeError (not TypeError)', () => {
    let caught: unknown;
    try {
      selectLatestKmaMidtermIssuance({
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
      selectLatestKmaMidtermIssuance({
        referenceEpochMilliseconds: Number.NaN,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    // Same input throws the same way; the message names the field, not a serialized object.
    expect(() =>
      selectLatestKmaMidtermIssuance({
        referenceEpochMilliseconds: Number.NaN,
      }),
    ).toThrow(RangeError);
    expect(message).not.toContain('{');
  });

  it('does not mutate the input object when rejecting it', () => {
    const input: SelectLatestKmaMidtermIssuanceInput = {
      referenceEpochMilliseconds: Number.NaN,
    };
    const snapshot = { ...input };
    expect(() => selectLatestKmaMidtermIssuance(input)).toThrow(RangeError);
    expect(input).toEqual(snapshot);
  });
});

describe('selectLatestKmaMidtermIssuance — immutability and reuse', () => {
  const reference = kstEpochMs('2026-07-17T14:30:00.000');
  const expected: KmaMidtermIssuance = { tmFc: '202607170600' };

  it('works with a frozen input and does not mutate it', () => {
    const input = Object.freeze({
      referenceEpochMilliseconds: reference,
    });
    const snapshot = { ...input };
    expect(selectLatestKmaMidtermIssuance(input)).toEqual(expected);
    expect(input).toEqual(snapshot);
  });

  it('returns deep-equal but distinct objects for the same input', () => {
    const first = selectLatestKmaMidtermIssuance({
      referenceEpochMilliseconds: reference,
    });
    const second = selectLatestKmaMidtermIssuance({
      referenceEpochMilliseconds: reference,
    });
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it('mutating a previous result does not affect the next call', () => {
    const first = selectLatestKmaMidtermIssuance({
      referenceEpochMilliseconds: reference,
    });
    (first as { tmFc: string }).tmFc = 'MUTATED';
    const second = selectLatestKmaMidtermIssuance({
      referenceEpochMilliseconds: reference,
    });
    expect(second).toEqual(expected);
  });

  it('does not accumulate state across calls with different references', () => {
    const otherReference = kstEpochMs('2026-07-17T20:00:00.000');
    const runFirst = () =>
      selectLatestKmaMidtermIssuance({ referenceEpochMilliseconds: reference });
    const runSecond = () =>
      selectLatestKmaMidtermIssuance({ referenceEpochMilliseconds: otherReference });
    expect(runFirst()).toEqual({ tmFc: '202607170600' });
    expect(runSecond()).toEqual({ tmFc: '202607171800' });
    expect(runFirst()).toEqual({ tmFc: '202607170600' });
    expect(runSecond()).toEqual({ tmFc: '202607171800' });
  });
});
