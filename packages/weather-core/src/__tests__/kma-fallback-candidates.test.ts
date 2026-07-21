import { describe, expect, it } from 'vitest';

import {
  KmaForecastProduct,
  selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay,
  type KmaForecastBaseTime,
  type KmaForecastBaseTimeCandidates,
  type SelectKmaForecastBaseTimeCandidatesAfterAvailabilityDelayInput,
} from '../index';

const SHORT = KmaForecastProduct.SHORT_FORECAST;
const ULTRA = KmaForecastProduct.ULTRA_SHORT_FORECAST;

/**
 * Build an absolute epoch-millisecond reference from a KST wall clock. The offset is always
 * explicit (`+09:00`), so the input string is never a timezone-less local datetime and the parsed
 * instant is independent of the host timezone. `process.env.TZ` is never touched.
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
): SelectKmaForecastBaseTimeCandidatesAfterAvailabilityDelayInput {
  return { product, referenceEpochMilliseconds: kstEpochMs(kstWallClock) };
}

/**
 * The official SHORT schedule as `HHmm` strings, ascending, returned **fresh** each call so no
 * mutable array is shared across tests. Expected values are derived from this local array (never
 * from the production selector).
 */
function shortSchedule(): readonly string[] {
  return ['0200', '0500', '0800', '1100', '1400', '1700', '2000', '2300'];
}

/** The official ULTRA schedule as `HHmm` strings for hours `0..23`, returned fresh each call. */
function ultraSchedule(): readonly string[] {
  return Array.from({ length: 24 }, (_value, hour) => `${String(hour).padStart(2, '0')}30`);
}

describe('selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay — representative SHORT cases', () => {
  it.each([
    // Exact threshold.
    {
      at: '2026-07-18T02:10:00.000',
      primary: { baseDate: '20260718', baseTime: '0200' },
      previous: { baseDate: '20260717', baseTime: '2300' },
    },
    {
      at: '2026-07-18T05:10:00.000',
      primary: { baseDate: '20260718', baseTime: '0500' },
      previous: { baseDate: '20260718', baseTime: '0200' },
    },
    {
      at: '2026-07-18T23:10:00.000',
      primary: { baseDate: '20260718', baseTime: '2300' },
      previous: { baseDate: '20260718', baseTime: '2000' },
    },
    // One millisecond before the threshold.
    {
      at: '2026-07-18T02:09:59.999',
      primary: { baseDate: '20260717', baseTime: '2300' },
      previous: { baseDate: '20260717', baseTime: '2000' },
    },
    {
      at: '2026-07-18T05:09:59.999',
      primary: { baseDate: '20260718', baseTime: '0200' },
      previous: { baseDate: '20260717', baseTime: '2300' },
    },
    // Between thresholds.
    {
      at: '2026-07-18T07:59:00.000',
      primary: { baseDate: '20260718', baseTime: '0500' },
      previous: { baseDate: '20260718', baseTime: '0200' },
    },
  ])('short: $at -> primary $primary.baseTime / previous $previous.baseTime', ({ at, primary, previous }) => {
    expect(
      selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay(inputAtKst(SHORT, at)),
    ).toEqual({ primary, previous });
  });
});

describe('selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay — SHORT full schedule', () => {
  it('at each exact HH:10 threshold, primary is that issuance and previous is the one before', () => {
    const schedule = shortSchedule();
    const day8 = '20260718';
    const prevDay8 = '20260717';
    for (let i = 0; i < schedule.length; i += 1) {
      const hh = (schedule[i] as string).slice(0, 2);
      const at = `2026-07-18T${hh}:10:00.000`;
      const primary: KmaForecastBaseTime = { baseDate: day8, baseTime: schedule[i] as string };
      const previous: KmaForecastBaseTime =
        i === 0
          ? { baseDate: prevDay8, baseTime: '2300' }
          : { baseDate: day8, baseTime: schedule[i - 1] as string };
      expect(
        selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay(inputAtKst(SHORT, at)),
      ).toEqual({ primary, previous });
    }
  });

  it('one millisecond before each HH:10 threshold, both candidates shift back one issuance', () => {
    const schedule = shortSchedule();
    const day8 = '20260718';
    const prevDay8 = '20260717';
    // Linear issuance index i on 2026-07-18; index -1 is prev-day 2300, index -2 is prev-day 2000.
    const issuanceAt = (index: number): KmaForecastBaseTime => {
      if (index >= 0) {
        return { baseDate: day8, baseTime: schedule[index] as string };
      }
      // Only -1 and -2 are reachable here (one ms before the day's first two thresholds).
      return { baseDate: prevDay8, baseTime: schedule[schedule.length + index] as string };
    };
    for (let i = 0; i < schedule.length; i += 1) {
      const hh = (schedule[i] as string).slice(0, 2);
      const oneMsBefore = kstEpochMs(`2026-07-18T${hh}:10:00.000`) - 1;
      expect(
        selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay({
          product: SHORT,
          referenceEpochMilliseconds: oneMsBefore,
        }),
      ).toEqual({ primary: issuanceAt(i - 1), previous: issuanceAt(i - 2) });
    }
  });
});

describe('selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay — representative ULTRA cases', () => {
  it.each([
    // Exact threshold.
    {
      at: '2026-07-18T00:45:00.000',
      primary: { baseDate: '20260718', baseTime: '0030' },
      previous: { baseDate: '20260717', baseTime: '2330' },
    },
    {
      at: '2026-07-18T06:45:00.000',
      primary: { baseDate: '20260718', baseTime: '0630' },
      previous: { baseDate: '20260718', baseTime: '0530' },
    },
    {
      at: '2026-07-18T23:45:00.000',
      primary: { baseDate: '20260718', baseTime: '2330' },
      previous: { baseDate: '20260718', baseTime: '2230' },
    },
    // One millisecond before the threshold.
    {
      at: '2026-07-18T00:44:59.999',
      primary: { baseDate: '20260717', baseTime: '2330' },
      previous: { baseDate: '20260717', baseTime: '2230' },
    },
    {
      at: '2026-07-18T06:44:59.999',
      primary: { baseDate: '20260718', baseTime: '0530' },
      previous: { baseDate: '20260718', baseTime: '0430' },
    },
    // Between thresholds.
    {
      at: '2026-07-18T06:59:00.000',
      primary: { baseDate: '20260718', baseTime: '0630' },
      previous: { baseDate: '20260718', baseTime: '0530' },
    },
  ])('ultra: $at -> primary $primary.baseTime / previous $previous.baseTime', ({ at, primary, previous }) => {
    expect(
      selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay(inputAtKst(ULTRA, at)),
    ).toEqual({ primary, previous });
  });
});

describe('selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay — ULTRA full schedule', () => {
  it('at each exact HH:45 threshold, primary is HH30 and previous is the previous hour HH30', () => {
    const schedule = ultraSchedule();
    const day8 = '20260718';
    const prevDay8 = '20260717';
    for (let hour = 0; hour < 24; hour += 1) {
      const hh = String(hour).padStart(2, '0');
      const at = `2026-07-18T${hh}:45:00.000`;
      const primary: KmaForecastBaseTime = { baseDate: day8, baseTime: schedule[hour] as string };
      const previous: KmaForecastBaseTime =
        hour === 0
          ? { baseDate: prevDay8, baseTime: '2330' }
          : { baseDate: day8, baseTime: schedule[hour - 1] as string };
      expect(
        selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay(inputAtKst(ULTRA, at)),
      ).toEqual({ primary, previous });
    }
  });

  it('one millisecond before each HH:45 threshold, both candidates shift back one hour', () => {
    const schedule = ultraSchedule();
    const day8 = '20260718';
    const prevDay8 = '20260717';
    const issuanceAt = (index: number): KmaForecastBaseTime => {
      if (index >= 0) {
        return { baseDate: day8, baseTime: schedule[index] as string };
      }
      return { baseDate: prevDay8, baseTime: schedule[schedule.length + index] as string };
    };
    for (let hour = 0; hour < 24; hour += 1) {
      const hh = String(hour).padStart(2, '0');
      const oneMsBefore = kstEpochMs(`2026-07-18T${hh}:45:00.000`) - 1;
      expect(
        selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay({
          product: ULTRA,
          referenceEpochMilliseconds: oneMsBefore,
        }),
      ).toEqual({ primary: issuanceAt(hour - 1), previous: issuanceAt(hour - 2) });
    }
  });
});

describe('selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay — date rollover', () => {
  it.each([
    // Year boundary.
    {
      product: SHORT,
      at: '2026-01-01T02:10:00.000',
      primary: { baseDate: '20260101', baseTime: '0200' },
      previous: { baseDate: '20251231', baseTime: '2300' },
    },
    {
      product: ULTRA,
      at: '2026-01-01T00:45:00.000',
      primary: { baseDate: '20260101', baseTime: '0030' },
      previous: { baseDate: '20251231', baseTime: '2330' },
    },
    // Month boundary.
    {
      product: SHORT,
      at: '2026-08-01T02:10:00.000',
      primary: { baseDate: '20260801', baseTime: '0200' },
      previous: { baseDate: '20260731', baseTime: '2300' },
    },
    {
      product: ULTRA,
      at: '2026-08-01T00:45:00.000',
      primary: { baseDate: '20260801', baseTime: '0030' },
      previous: { baseDate: '20260731', baseTime: '2330' },
    },
    // Leap day (2024-02-29 exists).
    {
      product: SHORT,
      at: '2024-03-01T02:10:00.000',
      primary: { baseDate: '20240301', baseTime: '0200' },
      previous: { baseDate: '20240229', baseTime: '2300' },
    },
    {
      product: ULTRA,
      at: '2024-03-01T00:45:00.000',
      primary: { baseDate: '20240301', baseTime: '0030' },
      previous: { baseDate: '20240229', baseTime: '2330' },
    },
  ])('$product: $at rolls previous across the boundary', ({ product, at, primary, previous }) => {
    expect(
      selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay(inputAtKst(product, at)),
    ).toEqual({ primary, previous });
  });
});

describe('selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay — supported-year boundary', () => {
  it('returns a valid SHORT pair at the 1000 lower bound when previous stays in 1000', () => {
    expect(
      selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay(
        inputAtKst(SHORT, '1000-01-01T05:10:00.000'),
      ),
    ).toEqual({
      primary: { baseDate: '10000101', baseTime: '0500' },
      previous: { baseDate: '10000101', baseTime: '0200' },
    });
  });

  it('throws RangeError when the SHORT previous candidate rolls into year 0999', () => {
    // primary 10000101/0200 is representable, but previous shifts the reference back 3 hours to
    // 1000-01-01 02:10 - 3h = 0999-12-31 23:10, whose availability selection is 0999-12-31 / 2300.
    expect(() =>
      selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay(
        inputAtKst(SHORT, '1000-01-01T02:10:00.000'),
      ),
    ).toThrow(RangeError);
  });

  it('returns a valid ULTRA pair at the 1000 lower bound when previous stays in 1000', () => {
    expect(
      selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay(
        inputAtKst(ULTRA, '1000-01-01T01:45:00.000'),
      ),
    ).toEqual({
      primary: { baseDate: '10000101', baseTime: '0130' },
      previous: { baseDate: '10000101', baseTime: '0030' },
    });
  });

  it('throws RangeError when the ULTRA previous candidate rolls into year 0999', () => {
    // primary 10000101/0030, but previous shifts back 1 hour to 0999-12-31 23:45 -> 0999/2330.
    expect(() =>
      selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay(
        inputAtKst(ULTRA, '1000-01-01T00:45:00.000'),
      ),
    ).toThrow(RangeError);
  });

  it('produces a valid candidate pair for a late-day reference in year 9999', () => {
    expect(
      selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay(
        inputAtKst(SHORT, '9999-12-31T23:10:00.000'),
      ),
    ).toEqual({
      primary: { baseDate: '99991231', baseTime: '2300' },
      previous: { baseDate: '99991231', baseTime: '2000' },
    });
    expect(
      selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay(
        inputAtKst(ULTRA, '9999-12-31T23:45:00.000'),
      ),
    ).toEqual({
      primary: { baseDate: '99991231', baseTime: '2330' },
      previous: { baseDate: '99991231', baseTime: '2230' },
    });
  });
});

describe('selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay — timezone-independent absolute instant', () => {
  it('gives the same SHORT pair for the same instant written as +09:00 KST and as UTC Z', () => {
    // 2026-07-18T05:10:00.000+09:00 === 2026-07-17T20:10:00.000Z (the same absolute instant).
    const fromKst = selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay({
      product: SHORT,
      referenceEpochMilliseconds: kstEpochMs('2026-07-18T05:10:00.000'),
    });
    const fromUtc = selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay({
      product: SHORT,
      referenceEpochMilliseconds: utcEpochMs('2026-07-17T20:10:00.000'),
    });
    expect(fromKst).toEqual({
      primary: { baseDate: '20260718', baseTime: '0500' },
      previous: { baseDate: '20260718', baseTime: '0200' },
    });
    expect(fromUtc).toEqual(fromKst);
  });

  it('agrees across representations for an ULTRA instant too', () => {
    // 2026-07-18T06:45:00.000+09:00 === 2026-07-17T21:45:00.000Z.
    const fromKst = selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay({
      product: ULTRA,
      referenceEpochMilliseconds: kstEpochMs('2026-07-18T06:45:00.000'),
    });
    const fromUtc = selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay({
      product: ULTRA,
      referenceEpochMilliseconds: utcEpochMs('2026-07-17T21:45:00.000'),
    });
    expect(fromKst).toEqual({
      primary: { baseDate: '20260718', baseTime: '0630' },
      previous: { baseDate: '20260718', baseTime: '0530' },
    });
    expect(fromUtc).toEqual(fromKst);
  });
});

describe('selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay — invalid input', () => {
  // Shaped like a leaked secret. It must never appear in any thrown error message or output.
  const SECRET_SHAPED_VALUE_MUST_NOT_LEAK =
    'SECRET_SHAPED_FALLBACK_CANDIDATE_MUST_NOT_LEAK_PR16';

  it.each([
    { label: 'NaN', value: Number.NaN },
    { label: 'Infinity', value: Number.POSITIVE_INFINITY },
    { label: '-Infinity', value: Number.NEGATIVE_INFINITY },
    { label: 'fractional', value: 1_700_000_000_000.5 },
    { label: '> MAX_SAFE_INTEGER', value: Number.MAX_SAFE_INTEGER + 1 },
    { label: '< MIN_SAFE_INTEGER', value: Number.MIN_SAFE_INTEGER - 1 },
  ])('throws RangeError for referenceEpochMilliseconds = $label', ({ value }) => {
    expect(() =>
      selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay({
        product: SHORT,
        referenceEpochMilliseconds: value,
      }),
    ).toThrow(RangeError);
  });

  it.each([
    { label: 'null', value: null },
    { label: 'undefined', value: undefined },
  ])('throws RangeError for a runtime $label reference cast', ({ value }) => {
    expect(() =>
      selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay({
        product: SHORT,
        referenceEpochMilliseconds: value as unknown as number,
      }),
    ).toThrow(RangeError);
  });

  it('throws RangeError (not TypeError) and does not leak a runtime string reference value', () => {
    let caught: unknown;
    try {
      selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay({
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

  it('throws RangeError for an unsupported product (runtime cast) with a valid epoch', () => {
    expect(() =>
      selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay({
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
      selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay({
        product: value as unknown as KmaForecastProduct,
        referenceEpochMilliseconds: kstEpochMs('2026-07-18T12:00:00.000'),
      }),
    ).toThrow(RangeError);
  });

  it('rejects an invalid epoch before an unsupported product (validation order preserved)', () => {
    // The PR #14 selector validates the epoch first, so an invalid epoch throws even when the
    // product is also unsupported — no product-specific message leaks the raw product first.
    let message = '';
    try {
      selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay({
        product: SECRET_SHAPED_VALUE_MUST_NOT_LEAK as unknown as KmaForecastProduct,
        referenceEpochMilliseconds: Number.NaN,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(() =>
      selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay({
        product: SECRET_SHAPED_VALUE_MUST_NOT_LEAK as unknown as KmaForecastProduct,
        referenceEpochMilliseconds: Number.NaN,
      }),
    ).toThrow(RangeError);
    expect(message).toContain('referenceEpochMilliseconds');
    expect(message).not.toContain(SECRET_SHAPED_VALUE_MUST_NOT_LEAK);
  });

  it('does not leak the raw product value in the unsupported-product RangeError', () => {
    let message = '';
    try {
      selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay({
        product: SECRET_SHAPED_VALUE_MUST_NOT_LEAK as unknown as KmaForecastProduct,
        referenceEpochMilliseconds: kstEpochMs('2026-07-18T12:00:00.000'),
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(() =>
      selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay({
        product: SECRET_SHAPED_VALUE_MUST_NOT_LEAK as unknown as KmaForecastProduct,
        referenceEpochMilliseconds: kstEpochMs('2026-07-18T12:00:00.000'),
      }),
    ).toThrow(RangeError);
    expect(message).not.toContain(SECRET_SHAPED_VALUE_MUST_NOT_LEAK);
    expect(message).not.toContain('{');
  });

  it('does not mutate the input object when rejecting it', () => {
    const input: SelectKmaForecastBaseTimeCandidatesAfterAvailabilityDelayInput = {
      product: SHORT,
      referenceEpochMilliseconds: Number.NaN,
    };
    const snapshot = { ...input };
    expect(() =>
      selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay(input),
    ).toThrow(RangeError);
    expect(input).toEqual(snapshot);
  });
});

describe('selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay — freshness and immutability', () => {
  it('works with a frozen input and does not mutate it', () => {
    const input = Object.freeze({
      product: SHORT,
      referenceEpochMilliseconds: kstEpochMs('2026-07-18T05:10:00.000'),
    });
    const snapshot = { ...input };
    expect(selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay(input)).toEqual({
      primary: { baseDate: '20260718', baseTime: '0500' },
      previous: { baseDate: '20260718', baseTime: '0200' },
    });
    expect(input).toEqual(snapshot);
  });

  it('result own keys are exactly primary and previous', () => {
    const result: KmaForecastBaseTimeCandidates =
      selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay({
        product: ULTRA,
        referenceEpochMilliseconds: kstEpochMs('2026-07-18T14:45:00.000'),
      });
    expect(Object.keys(result).sort()).toEqual(['previous', 'primary']);
  });

  it('each candidate own keys are exactly baseDate and baseTime, both fixed-width digit strings', () => {
    const result = selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay({
      product: SHORT,
      referenceEpochMilliseconds: kstEpochMs('2026-07-18T14:10:00.000'),
    });
    expect(Object.keys(result.primary).sort()).toEqual(['baseDate', 'baseTime']);
    expect(Object.keys(result.previous).sort()).toEqual(['baseDate', 'baseTime']);
    expect(result.primary.baseDate).toMatch(/^\d{8}$/);
    expect(result.primary.baseTime).toMatch(/^\d{4}$/);
    expect(result.previous.baseDate).toMatch(/^\d{8}$/);
    expect(result.previous.baseTime).toMatch(/^\d{4}$/);
  });

  it('primary and previous are distinct object references and distinct issuances', () => {
    const result = selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay({
      product: SHORT,
      referenceEpochMilliseconds: kstEpochMs('2026-07-18T14:10:00.000'),
    });
    expect(result.primary).not.toBe(result.previous);
    expect(result.primary).not.toEqual(result.previous);
  });

  it('returns deep-equal but distinct wrapper / primary / previous objects on repeated calls', () => {
    const build = () =>
      selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay({
        product: SHORT,
        referenceEpochMilliseconds: kstEpochMs('2026-07-18T14:30:00.000'),
      });
    const first = build();
    const second = build();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.primary).not.toBe(second.primary);
    expect(first.previous).not.toBe(second.previous);
  });

  it('mutating a previous result does not affect the next call', () => {
    const reference = kstEpochMs('2026-07-18T14:30:00.000');
    const first = selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay({
      product: SHORT,
      referenceEpochMilliseconds: reference,
    });
    (first as { primary: { baseDate: string; baseTime: string } }).primary.baseDate = 'MUTATED';
    (first as { primary: { baseDate: string; baseTime: string } }).primary.baseTime = 'XXXX';
    (first as { previous: { baseDate: string; baseTime: string } }).previous.baseDate = 'MUTATED';
    const second = selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay({
      product: SHORT,
      referenceEpochMilliseconds: reference,
    });
    expect(second).toEqual({
      primary: { baseDate: '20260718', baseTime: '1400' },
      previous: { baseDate: '20260718', baseTime: '1100' },
    });
  });

  it('does not observe an extra runtime input property in the output', () => {
    const input = {
      product: SHORT,
      referenceEpochMilliseconds: kstEpochMs('2026-07-18T05:10:00.000'),
      extra: 'SECRET_SHAPED_FALLBACK_CANDIDATE_MUST_NOT_LEAK_PR16',
    } as unknown as SelectKmaForecastBaseTimeCandidatesAfterAvailabilityDelayInput;
    const result = selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay(input);
    expect(Object.keys(result).sort()).toEqual(['previous', 'primary']);
    expect(JSON.stringify(result)).not.toContain('extra');
    expect(JSON.stringify(result)).not.toContain('SECRET_SHAPED');
  });

  it('does not accumulate or mix state across alternating SHORT and ULTRA calls', () => {
    // SHORT 14:30 KST: primary 1400, previous 1100. ULTRA 14:30 KST: primary 1330, previous 1230.
    const runShort = () =>
      selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay({
        product: SHORT,
        referenceEpochMilliseconds: kstEpochMs('2026-07-18T14:30:00.000'),
      });
    const runUltra = () =>
      selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay({
        product: ULTRA,
        referenceEpochMilliseconds: kstEpochMs('2026-07-18T14:30:00.000'),
      });
    const shortExpected = {
      primary: { baseDate: '20260718', baseTime: '1400' },
      previous: { baseDate: '20260718', baseTime: '1100' },
    };
    const ultraExpected = {
      primary: { baseDate: '20260718', baseTime: '1330' },
      previous: { baseDate: '20260718', baseTime: '1230' },
    };
    // Order-independent: interleaving the two products never changes either result.
    expect(runShort()).toEqual(shortExpected);
    expect(runUltra()).toEqual(ultraExpected);
    expect(runUltra()).toEqual(ultraExpected);
    expect(runShort()).toEqual(shortExpected);
  });
});
