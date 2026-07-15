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
