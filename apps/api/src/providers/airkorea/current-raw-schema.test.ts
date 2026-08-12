import { describe, expect, it } from 'vitest';

import {
  airKoreaCurrentAirQualityBodySchema,
  airKoreaCurrentAirQualityItemSchema,
  airKoreaCurrentAirQualitySuccessResponseSchema,
  airKoreaResponseEnvelopeSchema,
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
        items: { item: items },
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

  it('rejects hour 24 (no confirmed 24:00 convention for this operation)', () => {
    expect(parseAirKoreaDataTime('2025-01-01 24:00')).toBeNull();
  });

  it('rejects minute 60', () => {
    expect(parseAirKoreaDataTime('2025-01-01 10:60')).toBeNull();
  });

  it('rejects a structurally malformed string', () => {
    expect(parseAirKoreaDataTime('2025/01/01 10:00')).toBeNull();
    expect(parseAirKoreaDataTime('not-a-date')).toBeNull();
    expect(parseAirKoreaDataTime('')).toBeNull();
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
      items: { item: [VALID_ITEM] },
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty page (totalCount 0, no items)', () => {
    const result = airKoreaCurrentAirQualityBodySchema.safeParse({
      numOfRows: 100,
      pageNo: 1,
      totalCount: 0,
      items: { item: [] },
    });
    expect(result.success).toBe(true);
  });

  it('rejects totalCount 0 with a non-empty item list', () => {
    const result = airKoreaCurrentAirQualityBodySchema.safeParse({
      numOfRows: 100,
      pageNo: 1,
      totalCount: 0,
      items: { item: [VALID_ITEM] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects item count exceeding numOfRows', () => {
    const result = airKoreaCurrentAirQualityBodySchema.safeParse({
      numOfRows: 1,
      pageNo: 1,
      totalCount: 2,
      items: { item: [VALID_ITEM, VALID_ITEM] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects item count exceeding a non-zero totalCount', () => {
    const result = airKoreaCurrentAirQualityBodySchema.safeParse({
      numOfRows: 100,
      pageNo: 1,
      totalCount: 1,
      items: { item: [VALID_ITEM, VALID_ITEM] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a single object instead of an array under items.item', () => {
    const result = airKoreaCurrentAirQualityBodySchema.safeParse({
      numOfRows: 100,
      pageNo: 1,
      totalCount: 1,
      items: { item: VALID_ITEM },
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
