import { describe, expect, it } from 'vitest';

import {
  airKoreaTmCoordinateBodySchema,
  airKoreaTmCoordinateItemSchema,
  airKoreaTmCoordinateSuccessResponseSchema,
  parseAirKoreaTmCoordinateValue,
} from './tm-coordinate-raw-schema.js';

/** The technical document's own no-version response example (§ d) item. */
const VALID_ITEM = {
  sidoName: '서울특별시',
  sggName: '종로구',
  umdName: '혜화동',
  tmX: '200089.126044',
  tmY: '453946.42329',
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
        numOfRows: 10,
        pageNo: 1,
        totalCount: items.length,
        items: { item: items },
        ...overrides,
      },
    },
  };
}

describe('parseAirKoreaTmCoordinateValue', () => {
  it('parses a valid positive decimal coordinate', () => {
    expect(parseAirKoreaTmCoordinateValue('200089.126044')).toBe(200089.126044);
  });

  it('parses a valid integer coordinate', () => {
    expect(parseAirKoreaTmCoordinateValue('200089')).toBe(200089);
  });

  it('parses zero', () => {
    expect(parseAirKoreaTmCoordinateValue('0')).toBe(0);
  });

  it('parses a valid negative decimal coordinate', () => {
    expect(parseAirKoreaTmCoordinateValue('-1000.5')).toBe(-1000.5);
  });

  it('rejects an empty string', () => {
    expect(parseAirKoreaTmCoordinateValue('')).toBeNull();
  });

  it('rejects a leading-plus-signed coordinate', () => {
    expect(parseAirKoreaTmCoordinateValue('+200089.126044')).toBeNull();
  });

  it('rejects exponential notation', () => {
    expect(parseAirKoreaTmCoordinateValue('2.00089126044e5')).toBeNull();
  });

  it('rejects non-numeric text', () => {
    expect(parseAirKoreaTmCoordinateValue('not-a-number')).toBeNull();
  });

  it('rejects a value that would overflow to Infinity', () => {
    expect(parseAirKoreaTmCoordinateValue('1'.padEnd(400, '0'))).toBeNull();
  });

  it('rejects a value that would overflow to -Infinity', () => {
    expect(parseAirKoreaTmCoordinateValue(`-${'1'.padEnd(400, '0')}`)).toBeNull();
  });

  it('rejects a trailing decimal point with no digits', () => {
    expect(parseAirKoreaTmCoordinateValue('200089.')).toBeNull();
  });

  it('rejects a double-negative sign', () => {
    expect(parseAirKoreaTmCoordinateValue('--200089')).toBeNull();
  });
});

describe('airKoreaTmCoordinateItemSchema', () => {
  it('accepts a valid item', () => {
    const result = airKoreaTmCoordinateItemSchema.safeParse(VALID_ITEM);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(VALID_ITEM);
    }
  });

  it('strips unknown fields', () => {
    const result = airKoreaTmCoordinateItemSchema.safeParse({
      ...VALID_ITEM,
      stationCode: '131442',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('stationCode' in result.data).toBe(false);
    }
  });

  it.each(['sidoName', 'sggName', 'umdName', 'tmX', 'tmY'])(
    'rejects a missing %s (documented required field)',
    (field) => {
      const result = airKoreaTmCoordinateItemSchema.safeParse(omitKey(VALID_ITEM, field));
      expect(result.success).toBe(false);
    },
  );

  it('rejects a numeric (wrong-type) tmX', () => {
    const result = airKoreaTmCoordinateItemSchema.safeParse({ ...VALID_ITEM, tmX: 200089.126044 });
    expect(result.success).toBe(false);
  });

  it('rejects a numeric (wrong-type) tmY', () => {
    const result = airKoreaTmCoordinateItemSchema.safeParse({ ...VALID_ITEM, tmY: 453946.42329 });
    expect(result.success).toBe(false);
  });

  it('rejects a numeric (wrong-type) umdName', () => {
    const result = airKoreaTmCoordinateItemSchema.safeParse({ ...VALID_ITEM, umdName: 123 });
    expect(result.success).toBe(false);
  });

  it('rejects a sidoName over the documented 20-character response field size', () => {
    const result = airKoreaTmCoordinateItemSchema.safeParse({
      ...VALID_ITEM,
      sidoName: '가'.repeat(21),
    });
    expect(result.success).toBe(false);
  });

  it('accepts a sggName at exactly the documented 20-character response field size', () => {
    const result = airKoreaTmCoordinateItemSchema.safeParse({
      ...VALID_ITEM,
      sggName: '가'.repeat(20),
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty umdName', () => {
    const result = airKoreaTmCoordinateItemSchema.safeParse({ ...VALID_ITEM, umdName: '' });
    expect(result.success).toBe(false);
  });
});

describe('airKoreaTmCoordinateBodySchema', () => {
  it('accepts a well-formed body', () => {
    const result = airKoreaTmCoordinateBodySchema.safeParse({
      numOfRows: 10,
      pageNo: 1,
      totalCount: 1,
      items: { item: [VALID_ITEM] },
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty item list when totalCount is zero', () => {
    const result = airKoreaTmCoordinateBodySchema.safeParse({
      numOfRows: 10,
      pageNo: 1,
      totalCount: 0,
      items: { item: [] },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-empty item list when totalCount is zero', () => {
    const result = airKoreaTmCoordinateBodySchema.safeParse({
      numOfRows: 10,
      pageNo: 1,
      totalCount: 0,
      items: { item: [VALID_ITEM] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an item count exceeding totalCount', () => {
    const result = airKoreaTmCoordinateBodySchema.safeParse({
      numOfRows: 10,
      pageNo: 1,
      totalCount: 1,
      items: { item: [VALID_ITEM, VALID_ITEM] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an item count exceeding numOfRows', () => {
    const result = airKoreaTmCoordinateBodySchema.safeParse({
      numOfRows: 1,
      pageNo: 1,
      totalCount: 2,
      items: { item: [VALID_ITEM, VALID_ITEM] },
    });
    expect(result.success).toBe(false);
  });

  it('accepts totalCount exceeding a non-empty item count (partial page is structurally valid)', () => {
    const result = airKoreaTmCoordinateBodySchema.safeParse({
      numOfRows: 10,
      pageNo: 1,
      totalCount: 5,
      items: { item: [VALID_ITEM] },
    });
    expect(result.success).toBe(true);
  });
});

describe('airKoreaTmCoordinateSuccessResponseSchema', () => {
  it('accepts the technical document’s own no-version response example shape', () => {
    const result = airKoreaTmCoordinateSuccessResponseSchema.safeParse(
      successResponse([VALID_ITEM]),
    );
    expect(result.success).toBe(true);
  });
});
