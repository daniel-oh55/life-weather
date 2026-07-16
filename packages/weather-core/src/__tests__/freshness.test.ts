import { describe, expect, it } from 'vitest';

import {
  classifyFreshness,
  FreshnessStatus,
  type ClassifyFreshnessInput,
} from '../index';

const referenceAt = '2026-07-15T12:00:00Z';
const base = { referenceAt, staleAfterMinutes: 60, futureToleranceMinutes: 5 };

describe('classifyFreshness — classification', () => {
  it('returns FRESH for a recent observation within the stale threshold', () => {
    expect(
      classifyFreshness({ ...base, observedAt: '2026-07-15T11:30:00Z' }),
    ).toBe(FreshnessStatus.FRESH);
  });

  it('returns STALE for an observation older than the threshold', () => {
    expect(
      classifyFreshness({ ...base, observedAt: '2026-07-15T10:00:00Z' }),
    ).toBe(FreshnessStatus.STALE);
  });

  it('returns STALE when the age exactly equals the stale threshold', () => {
    // Exactly 60 minutes old, staleAfterMinutes = 60.
    expect(
      classifyFreshness({ ...base, observedAt: '2026-07-15T11:00:00Z' }),
    ).toBe(FreshnessStatus.STALE);
  });

  it('returns FRESH for a future observation within the tolerance', () => {
    // 3 minutes ahead, tolerance = 5.
    expect(
      classifyFreshness({ ...base, observedAt: '2026-07-15T12:03:00Z' }),
    ).toBe(FreshnessStatus.FRESH);
  });

  it('does not return FUTURE when exactly at the future tolerance', () => {
    // 5 minutes ahead, tolerance = 5 -> not FUTURE.
    expect(
      classifyFreshness({ ...base, observedAt: '2026-07-15T12:05:00Z' }),
    ).toBe(FreshnessStatus.FRESH);
  });

  it('returns FUTURE when beyond the future tolerance', () => {
    // 6 minutes ahead, tolerance = 5.
    expect(
      classifyFreshness({ ...base, observedAt: '2026-07-15T12:06:00Z' }),
    ).toBe(FreshnessStatus.FUTURE);
  });

  it('returns UNKNOWN when observedAt is null', () => {
    expect(classifyFreshness({ ...base, observedAt: null })).toBe(
      FreshnessStatus.UNKNOWN,
    );
  });

  it('returns UNKNOWN when observedAt is unparseable', () => {
    expect(classifyFreshness({ ...base, observedAt: 'not-a-date' })).toBe(
      FreshnessStatus.UNKNOWN,
    );
  });

  it('handles a timezone-offset datetime', () => {
    // 2026-07-15T20:30:00+09:00 === 2026-07-15T11:30:00Z -> 30 min old -> FRESH.
    expect(
      classifyFreshness({ ...base, observedAt: '2026-07-15T20:30:00+09:00' }),
    ).toBe(FreshnessStatus.FRESH);
  });
});

describe('classifyFreshness — invalid input', () => {
  it('throws RangeError for an unparseable referenceAt', () => {
    expect(() =>
      classifyFreshness({
        ...base,
        referenceAt: 'nonsense',
        observedAt: '2026-07-15T11:30:00Z',
      }),
    ).toThrow(RangeError);
  });

  it('throws RangeError for a negative stale threshold', () => {
    expect(() =>
      classifyFreshness({
        ...base,
        staleAfterMinutes: -1,
        observedAt: referenceAt,
      }),
    ).toThrow(RangeError);
  });

  it('throws RangeError for a negative future tolerance', () => {
    expect(() =>
      classifyFreshness({
        ...base,
        futureToleranceMinutes: -1,
        observedAt: referenceAt,
      }),
    ).toThrow(RangeError);
  });

  it('throws RangeError for a NaN threshold', () => {
    expect(() =>
      classifyFreshness({
        ...base,
        staleAfterMinutes: Number.NaN,
        observedAt: referenceAt,
      }),
    ).toThrow(RangeError);
  });

  it('throws RangeError for an Infinite threshold', () => {
    expect(() =>
      classifyFreshness({
        ...base,
        staleAfterMinutes: Number.POSITIVE_INFINITY,
        observedAt: referenceAt,
      }),
    ).toThrow(RangeError);
    expect(() =>
      classifyFreshness({
        ...base,
        futureToleranceMinutes: Number.POSITIVE_INFINITY,
        observedAt: referenceAt,
      }),
    ).toThrow(RangeError);
  });
});

describe('classifyFreshness — absolute ISO datetime validation', () => {
  it('throws RangeError for a referenceAt with no timezone', () => {
    expect(() =>
      classifyFreshness({
        ...base,
        referenceAt: '2026-07-15T12:00:00',
        observedAt: '2026-07-15T11:30:00Z',
      }),
    ).toThrow(RangeError);
  });

  it('returns UNKNOWN for an observedAt with no timezone', () => {
    expect(
      classifyFreshness({ ...base, observedAt: '2026-07-15T11:30:00' }),
    ).toBe(FreshnessStatus.UNKNOWN);
  });

  it('throws RangeError for a date-only referenceAt', () => {
    expect(() =>
      classifyFreshness({
        ...base,
        referenceAt: '2026-07-15',
        observedAt: '2026-07-15T11:30:00Z',
      }),
    ).toThrow(RangeError);
  });

  it('returns UNKNOWN for a date-only observedAt', () => {
    expect(classifyFreshness({ ...base, observedAt: '2026-07-15' })).toBe(
      FreshnessStatus.UNKNOWN,
    );
  });

  it('rejects a non-ISO string that Date.parse would otherwise accept', () => {
    // Date.parse('07/15/2026 10:00') succeeds in V8, but it has no timezone and is not ISO.
    expect(() =>
      classifyFreshness({
        ...base,
        referenceAt: '07/15/2026 10:00',
        observedAt: '2026-07-15T11:30:00Z',
      }),
    ).toThrow(RangeError);
    expect(
      classifyFreshness({ ...base, observedAt: '07/15/2026 10:00' }),
    ).toBe(FreshnessStatus.UNKNOWN);
  });

  it('accepts a UTC Z referenceAt and observedAt', () => {
    expect(
      classifyFreshness({
        referenceAt: '2026-07-15T12:00:00Z',
        observedAt: '2026-07-15T11:30:00Z',
        staleAfterMinutes: 60,
        futureToleranceMinutes: 5,
      }),
    ).toBe(FreshnessStatus.FRESH);
  });

  it('accepts a negative UTC offset', () => {
    // 2026-07-15T22:30:00-05:00 === 2026-07-16T03:30:00Z.
    expect(
      classifyFreshness({
        referenceAt: '2026-07-16T04:00:00Z',
        observedAt: '2026-07-15T22:30:00-05:00',
        staleAfterMinutes: 60,
        futureToleranceMinutes: 5,
      }),
    ).toBe(FreshnessStatus.FRESH);
  });
});

describe('classifyFreshness — timestamp precision', () => {
  // Policy: seconds are required, and fractional seconds are either absent or exactly
  // 3 digits (milliseconds). This matches isoDateTime in @life-weather/contracts.

  it.each([
    // observedAt, expected — each is 30 min before referenceAt (12:00:00Z) -> FRESH.
    ['2026-07-15T11:30:00Z', 'seconds precision, UTC'],
    ['2026-07-15T11:30:00.500Z', 'milliseconds precision, UTC'],
    ['2026-07-15T20:30:00+09:00', 'seconds precision, numeric offset'],
    ['2026-07-15T20:30:00.500+09:00', 'milliseconds precision, numeric offset'],
  ])('accepts %j (%s) as observedAt', (observedAt) => {
    expect(classifyFreshness({ ...base, observedAt })).toBe(
      FreshnessStatus.FRESH,
    );
  });

  it.each([
    '2026-07-15T12:00:00Z', // seconds precision, UTC
    '2026-07-15T12:00:00.000Z', // milliseconds precision, UTC
    '2026-07-15T21:00:00+09:00', // seconds precision, numeric offset
    '2026-07-15T21:00:00.000+09:00', // milliseconds precision, numeric offset
  ])('accepts %j as referenceAt (does not throw)', (value) => {
    expect(() =>
      classifyFreshness({ ...base, referenceAt: value, observedAt: value }),
    ).not.toThrow();
  });

  const wrongPrecision = [
    '2026-07-15T12:00Z', // no seconds (minute precision)
    '2026-07-15T12:00:00.1Z', // 1 fractional digit
    '2026-07-15T12:00:00.12Z', // 2 fractional digits
    '2026-07-15T12:00:00.0001Z', // 4 fractional digits (sub-millisecond)
    '2026-07-15T12:00:00.1234Z', // 4 fractional digits
  ];

  it.each(wrongPrecision)(
    'throws RangeError for the wrong-precision %j as referenceAt',
    (value) => {
      expect(() =>
        classifyFreshness({ ...base, referenceAt: value, observedAt: referenceAt }),
      ).toThrow(RangeError);
    },
  );

  it.each(wrongPrecision)(
    'returns UNKNOWN for the wrong-precision %j as observedAt',
    (value) => {
      expect(classifyFreshness({ ...base, observedAt: value })).toBe(
        FreshnessStatus.UNKNOWN,
      );
    },
  );

  it('resolves a 1 ms lead beyond a 0-minute future tolerance as FUTURE', () => {
    expect(
      classifyFreshness({
        referenceAt: '2026-07-15T12:00:00.000Z',
        observedAt: '2026-07-15T12:00:00.001Z',
        staleAfterMinutes: 60,
        futureToleranceMinutes: 0,
      }),
    ).toBe(FreshnessStatus.FUTURE);
  });

  it('treats an identical millisecond instant as FRESH, not FUTURE', () => {
    expect(
      classifyFreshness({
        referenceAt: '2026-07-15T12:00:00.000Z',
        observedAt: '2026-07-15T12:00:00.000Z',
        staleAfterMinutes: 60,
        futureToleranceMinutes: 0,
      }),
    ).toBe(FreshnessStatus.FRESH);
  });
});

describe('classifyFreshness — non-existent calendar dates', () => {
  const invalidDates = [
    '2026-02-30T10:00:00Z', // Feb 30 never exists
    '2026-04-31T10:00:00Z', // April has 30 days
    '2025-02-29T10:00:00Z', // 2025 is not a leap year
    '2026-01-01T24:00:00Z', // hour out of range
    '2026-01-01T10:60:00Z', // minute out of range
    '2026-01-01T10:00:60Z', // second out of range
  ];

  it.each(invalidDates)('throws RangeError for %s as referenceAt', (value) => {
    expect(() =>
      classifyFreshness({ ...base, referenceAt: value, observedAt: referenceAt }),
    ).toThrow(RangeError);
  });

  it.each(invalidDates)('returns UNKNOWN for %s as observedAt', (value) => {
    expect(classifyFreshness({ ...base, observedAt: value })).toBe(
      FreshnessStatus.UNKNOWN,
    );
  });

  it('accepts a valid leap day (2024-02-29)', () => {
    expect(
      classifyFreshness({
        referenceAt: '2024-02-29T10:30:00Z',
        observedAt: '2024-02-29T10:00:00Z',
        staleAfterMinutes: 60,
        futureToleranceMinutes: 5,
      }),
    ).toBe(FreshnessStatus.FRESH);
  });
});

describe('classifyFreshness — purity', () => {
  it('does not mutate its input object', () => {
    const input: ClassifyFreshnessInput = {
      observedAt: '2026-07-15T11:30:00Z',
      referenceAt,
      staleAfterMinutes: 60,
      futureToleranceMinutes: 5,
    };
    const snapshot = { ...input };
    Object.freeze(input);

    classifyFreshness(input);

    expect(input).toEqual(snapshot);
  });

  it('is deterministic — the same input always yields the same result', () => {
    const input: ClassifyFreshnessInput = {
      observedAt: '2026-07-15T11:30:00Z',
      referenceAt,
      staleAfterMinutes: 60,
      futureToleranceMinutes: 5,
    };
    const results = new Set([
      classifyFreshness(input),
      classifyFreshness(input),
      classifyFreshness(input),
    ]);
    expect(results.size).toBe(1);
  });

  it('depends only on referenceAt, never on the system clock', () => {
    // referenceAt is decades in the past; if the function read Date.now() (2026+),
    // a 30-minute-old observation would look extremely STALE. It must be FRESH.
    expect(
      classifyFreshness({
        observedAt: '2000-01-01T00:30:00Z',
        referenceAt: '2000-01-01T01:00:00Z',
        staleAfterMinutes: 60,
        futureToleranceMinutes: 5,
      }),
    ).toBe(FreshnessStatus.FRESH);
  });
});
