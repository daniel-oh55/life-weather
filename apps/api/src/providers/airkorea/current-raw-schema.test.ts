import { describe, expect, it } from 'vitest';

import {
  airKoreaCurrentAirQualityBodySchema,
  airKoreaCurrentAirQualityItemSchema,
  airKoreaCurrentAirQualitySuccessResponseSchema,
  airKoreaResponseEnvelopeSchema,
  formatAirKoreaDataTimeCanonical,
  parseAirKoreaDataTime,
} from './current-raw-schema.js';

const VALID_ITEM = {
  dataTime: '2020-11-25 13:00',
  stationName: '종로구',
  pm10Value: '73',
  pm25Value: '44',
  o3Value: '0.043',
  khaiValue: '75',
  khaiGrade: '2',
  pm10Grade: '2',
  pm25Grade: '2',
  o3Grade: '2',
};

/** Return a shallow clone of `obj` with `key` deleted — works around TS's optional-only `delete`. */
function omitKey(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...obj };
  delete clone[key];
  return clone;
}

function successResponse(items: unknown[], overrides?: Record<string, unknown>) {
  return {
    response: {
      header: { resultCode: '00', resultMsg: 'NORMAL_CODE' },
      body: {
        numOfRows: 100,
        pageNo: 1,
        totalCount: items.length,
        items,
        ...overrides,
      },
    },
  };
}

describe('parseAirKoreaDataTime', () => {
  it('parses a valid dataTime', () => {
    expect(parseAirKoreaDataTime('2020-11-25 13:00')).toEqual({
      year: 2020,
      month: 11,
      day: 25,
      hour: 13,
      minute: 0,
    });
  });

  it('accepts a leap-day date', () => {
    expect(parseAirKoreaDataTime('2024-02-29 00:00')).not.toBeNull();
  });

  it('rejects a non-leap-year Feb 29', () => {
    expect(parseAirKoreaDataTime('2025-02-29 00:00')).toBeNull();
  });

  it('rejects an invalid month', () => {
    expect(parseAirKoreaDataTime('2025-13-01 00:00')).toBeNull();
  });

  it('rejects an invalid day', () => {
    expect(parseAirKoreaDataTime('2025-04-31 00:00')).toBeNull();
  });

  it('rejects minute 60', () => {
    expect(parseAirKoreaDataTime('2025-01-01 10:60')).toBeNull();
  });

  it('rejects a structurally malformed string', () => {
    expect(parseAirKoreaDataTime('2025/01/01 10:00')).toBeNull();
    expect(parseAirKoreaDataTime('not-a-date')).toBeNull();
    expect(parseAirKoreaDataTime('')).toBeNull();
  });

  describe('24:00 end-of-day rollover (2026-08-13 Owner-observed live JSON evidence)', () => {
    it('accepts 24:00 and rolls over to the next calendar day at 00:00', () => {
      expect(parseAirKoreaDataTime('2026-08-12 24:00')).toEqual({
        year: 2026,
        month: 8,
        day: 13,
        hour: 0,
        minute: 0,
      });
    });

    it('rolls December 31 24:00 over to January 1 of the next year', () => {
      expect(parseAirKoreaDataTime('2026-12-31 24:00')).toEqual({
        year: 2027,
        month: 1,
        day: 1,
        hour: 0,
        minute: 0,
      });
    });

    it('rolls an ordinary month-end 24:00 over to the first of the next month', () => {
      expect(parseAirKoreaDataTime('2026-09-30 24:00')).toEqual({
        year: 2026,
        month: 10,
        day: 1,
        hour: 0,
        minute: 0,
      });
    });

    it('rolls leap-year Feb 29 24:00 over to March 1', () => {
      expect(parseAirKoreaDataTime('2024-02-29 24:00')).toEqual({
        year: 2024,
        month: 3,
        day: 1,
        hour: 0,
        minute: 0,
      });
    });

    it('rolls leap-year Feb 28 24:00 within February (still a leap year, day 29 exists)', () => {
      expect(parseAirKoreaDataTime('2024-02-28 24:00')).toEqual({
        year: 2024,
        month: 2,
        day: 29,
        hour: 0,
        minute: 0,
      });
    });

    it('rolls a non-leap-year Feb 28 24:00 over to March 1', () => {
      expect(parseAirKoreaDataTime('2025-02-28 24:00')).toEqual({
        year: 2025,
        month: 3,
        day: 1,
        hour: 0,
        minute: 0,
      });
    });

    it('rejects 24:01 (only exact 24:00 is a legal end-of-day notation)', () => {
      expect(parseAirKoreaDataTime('2026-08-12 24:01')).toBeNull();
    });

    it('rejects 24:59', () => {
      expect(parseAirKoreaDataTime('2026-08-12 24:59')).toBeNull();
    });

    it('rejects 25:00 (not a legal end-of-day notation)', () => {
      expect(parseAirKoreaDataTime('2026-08-12 25:00')).toBeNull();
    });

    it('still rejects an invalid calendar date even at 24:00 (Feb 30 does not exist)', () => {
      expect(parseAirKoreaDataTime('2026-02-30 24:00')).toBeNull();
    });

    it('ordinary 00-23 hour parsing is unaffected', () => {
      expect(parseAirKoreaDataTime('2026-08-12 23:59')).toEqual({
        year: 2026,
        month: 8,
        day: 12,
        hour: 23,
        minute: 59,
      });
      expect(parseAirKoreaDataTime('2026-08-12 00:00')).toEqual({
        year: 2026,
        month: 8,
        day: 12,
        hour: 0,
        minute: 0,
      });
    });
  });
});

describe('formatAirKoreaDataTimeCanonical', () => {
  it('formats a 24:00 row and the rolled-over next-day 00:00 row to the same canonical key', () => {
    const rolledOver = parseAirKoreaDataTime('2026-08-12 24:00')!;
    const nextDayMidnight = parseAirKoreaDataTime('2026-08-13 00:00')!;
    expect(formatAirKoreaDataTimeCanonical(rolledOver)).toBe(
      formatAirKoreaDataTimeCanonical(nextDayMidnight),
    );
    expect(formatAirKoreaDataTimeCanonical(rolledOver)).toBe('2026-08-13 00:00');
  });
});

describe('airKoreaCurrentAirQualityItemSchema', () => {
  it('accepts a fully-populated valid item', () => {
    const result = airKoreaCurrentAirQualityItemSchema.safeParse(VALID_ITEM);
    expect(result.success).toBe(true);
  });

  it('accepts the "-" missing-measurement sentinel as a plain string (interpreted later)', () => {
    const result = airKoreaCurrentAirQualityItemSchema.safeParse({
      ...VALID_ITEM,
      khaiValue: '-',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.khaiValue).toBe('-');
    }
  });

  it('accepts an empty-string missing grade as a plain string (interpreted later)', () => {
    const result = airKoreaCurrentAirQualityItemSchema.safeParse({
      ...VALID_ITEM,
      pm25Grade: '',
    });
    expect(result.success).toBe(true);
  });

  it('accepts pm25Value/pm25Grade absent (documented optional response fields)', () => {
    const { pm25Value, pm25Grade, ...rest } = VALID_ITEM;
    const result = airKoreaCurrentAirQualityItemSchema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pm25Value).toBeUndefined();
      expect(result.data.pm25Grade).toBeUndefined();
    }
  });

  it('rejects a missing dataTime', () => {
    const { dataTime, ...rest } = VALID_ITEM;
    const result = airKoreaCurrentAirQualityItemSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects a missing stationName', () => {
    const { stationName, ...rest } = VALID_ITEM;
    const result = airKoreaCurrentAirQualityItemSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects a malformed dataTime', () => {
    const result = airKoreaCurrentAirQualityItemSchema.safeParse({
      ...VALID_ITEM,
      dataTime: 'not-a-date',
    });
    expect(result.success).toBe(false);
  });

  it('rejects wrong primitive types (number instead of string)', () => {
    const result = airKoreaCurrentAirQualityItemSchema.safeParse({
      ...VALID_ITEM,
      pm10Value: 73,
    });
    expect(result.success).toBe(false);
  });

  const REQUIRED_CONSUMED_FIELDS = [
    'pm10Value',
    'o3Value',
    'khaiValue',
    'khaiGrade',
    'pm10Grade',
    'o3Grade',
  ] as const;

  it.each(REQUIRED_CONSUMED_FIELDS)(
    'rejects a missing %s (officially required response field)',
    (field) => {
      const result = airKoreaCurrentAirQualityItemSchema.safeParse(omitKey(VALID_ITEM, field));
      expect(result.success).toBe(false);
    },
  );

  it.each(REQUIRED_CONSUMED_FIELDS)(
    'accepts a present %s holding its documented sentinel (presence, not value, is required)',
    (field) => {
      const sentinel = field.endsWith('Grade') ? '' : '-';
      const result = airKoreaCurrentAirQualityItemSchema.safeParse({
        ...VALID_ITEM,
        [field]: sentinel,
      });
      expect(result.success).toBe(true);
    },
  );

  it('strips unknown extra raw keys', () => {
    const result = airKoreaCurrentAirQualityItemSchema.safeParse({
      ...VALID_ITEM,
      mangName: '도시대기',
      stationCode: '111123',
      pm10Grade1h: '2',
      so2Flag: '점검및교정',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('mangName');
      expect(result.data).not.toHaveProperty('stationCode');
      expect(result.data).not.toHaveProperty('pm10Grade1h');
      expect(result.data).not.toHaveProperty('so2Flag');
    }
  });
});

describe('airKoreaCurrentAirQualityBodySchema — pagination self-contradiction', () => {
  it('accepts a consistent body', () => {
    const result = airKoreaCurrentAirQualityBodySchema.safeParse({
      numOfRows: 100,
      pageNo: 1,
      totalCount: 1,
      items: [VALID_ITEM],
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty page (totalCount 0, no items)', () => {
    const result = airKoreaCurrentAirQualityBodySchema.safeParse({
      numOfRows: 100,
      pageNo: 1,
      totalCount: 0,
      items: [],
    });
    expect(result.success).toBe(true);
  });

  it('rejects totalCount 0 with a non-empty item list', () => {
    const result = airKoreaCurrentAirQualityBodySchema.safeParse({
      numOfRows: 100,
      pageNo: 1,
      totalCount: 0,
      items: [VALID_ITEM],
    });
    expect(result.success).toBe(false);
  });

  it('rejects item count exceeding numOfRows', () => {
    const result = airKoreaCurrentAirQualityBodySchema.safeParse({
      numOfRows: 1,
      pageNo: 1,
      totalCount: 2,
      items: [VALID_ITEM, VALID_ITEM],
    });
    expect(result.success).toBe(false);
  });

  it('rejects item count exceeding a non-zero totalCount', () => {
    const result = airKoreaCurrentAirQualityBodySchema.safeParse({
      numOfRows: 100,
      pageNo: 1,
      totalCount: 1,
      items: [VALID_ITEM, VALID_ITEM],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a single object instead of a direct array under items (old { item: [...] } wrapper)', () => {
    const result = airKoreaCurrentAirQualityBodySchema.safeParse({
      numOfRows: 100,
      pageNo: 1,
      totalCount: 1,
      items: { item: [VALID_ITEM] },
    });
    expect(result.success).toBe(false);
  });
});

describe('airKoreaResponseEnvelopeSchema', () => {
  it('accepts a valid header envelope', () => {
    const result = airKoreaResponseEnvelopeSchema.safeParse({
      response: { header: { resultCode: '00', resultMsg: 'NORMAL_CODE' } },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a non-success 2-digit resultCode (classified later as upstream error)', () => {
    const result = airKoreaResponseEnvelopeSchema.safeParse({
      response: { header: { resultCode: '30', resultMsg: 'SERVICE KEY IS NOT REGISTERED' } },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a malformed (non-2-digit) resultCode', () => {
    const result = airKoreaResponseEnvelopeSchema.safeParse({
      response: { header: { resultCode: '0', resultMsg: 'x' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a completely unrelated JSON shape', () => {
    expect(airKoreaResponseEnvelopeSchema.safeParse({ foo: 'bar' }).success).toBe(false);
    expect(airKoreaResponseEnvelopeSchema.safeParse(null).success).toBe(false);
    expect(airKoreaResponseEnvelopeSchema.safeParse('nope').success).toBe(false);
  });
});

describe('airKoreaCurrentAirQualitySuccessResponseSchema', () => {
  it('accepts a full valid success response', () => {
    const result = airKoreaCurrentAirQualitySuccessResponseSchema.safeParse(
      successResponse([VALID_ITEM]),
    );
    expect(result.success).toBe(true);
  });

  it('accepts an empty-list success response', () => {
    const result = airKoreaCurrentAirQualitySuccessResponseSchema.safeParse(
      successResponse([]),
    );
    expect(result.success).toBe(true);
  });

  it('rejects a malformed body under a success header', () => {
    const result = airKoreaCurrentAirQualitySuccessResponseSchema.safeParse({
      response: {
        header: { resultCode: '00', resultMsg: 'NORMAL_CODE' },
        body: { numOfRows: 100, pageNo: 1 },
      },
    });
    expect(result.success).toBe(false);
  });
});
