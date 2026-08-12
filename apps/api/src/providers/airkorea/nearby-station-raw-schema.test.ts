import { describe, expect, it } from 'vitest';

import {
  airKoreaNearbyStationBodySchema,
  airKoreaNearbyStationItemSchema,
  airKoreaNearbyStationSuccessResponseSchema,
  parseAirKoreaNearbyStationDistanceKm,
} from './nearby-station-raw-schema.js';

/** The technical document's own no-version response example (§ d) items. */
const VALID_ITEM = {
  tm: '8.2',
  stationName: '부발읍',
  addr: '경기도 이천시 부발읍 무촌로 117부발보건지소 옥상',
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

describe('parseAirKoreaNearbyStationDistanceKm', () => {
  it('parses a valid integer distance', () => {
    expect(parseAirKoreaNearbyStationDistanceKm('8')).toBe(8);
  });

  it('parses a valid decimal distance', () => {
    expect(parseAirKoreaNearbyStationDistanceKm('9.3')).toBe(9.3);
  });

  it('parses zero', () => {
    expect(parseAirKoreaNearbyStationDistanceKm('0')).toBe(0);
  });

  it('rejects an empty string', () => {
    expect(parseAirKoreaNearbyStationDistanceKm('')).toBeNull();
  });

  it('rejects a negative distance', () => {
    expect(parseAirKoreaNearbyStationDistanceKm('-9.3')).toBeNull();
  });

  it('rejects the AirKorea missing-value sentinel', () => {
    expect(parseAirKoreaNearbyStationDistanceKm('-')).toBeNull();
  });

  it('rejects a leading-plus-signed distance', () => {
    expect(parseAirKoreaNearbyStationDistanceKm('+9.3')).toBeNull();
  });

  it('rejects exponential notation', () => {
    expect(parseAirKoreaNearbyStationDistanceKm('9.3e1')).toBeNull();
  });

  it('rejects non-numeric text', () => {
    expect(parseAirKoreaNearbyStationDistanceKm('nine')).toBeNull();
  });

  it('rejects a value that would overflow to Infinity', () => {
    expect(parseAirKoreaNearbyStationDistanceKm('1'.padEnd(400, '0'))).toBeNull();
  });

  it('rejects a trailing decimal point with no digits', () => {
    expect(parseAirKoreaNearbyStationDistanceKm('9.')).toBeNull();
  });
});

describe('airKoreaNearbyStationItemSchema', () => {
  it('accepts a valid item and strips unknown fields (addr)', () => {
    const result = airKoreaNearbyStationItemSchema.safeParse(VALID_ITEM);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ tm: '8.2', stationName: '부발읍' });
    }
  });

  it('strips an unrequested stationCode field (ver-gated, never sent)', () => {
    const result = airKoreaNearbyStationItemSchema.safeParse({
      ...VALID_ITEM,
      stationCode: '131442',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('stationCode' in result.data).toBe(false);
    }
  });

  it('rejects a missing stationName (documented required field)', () => {
    const result = airKoreaNearbyStationItemSchema.safeParse(omitKey(VALID_ITEM, 'stationName'));
    expect(result.success).toBe(false);
  });

  it('rejects a missing tm (documented required field)', () => {
    const result = airKoreaNearbyStationItemSchema.safeParse(omitKey(VALID_ITEM, 'tm'));
    expect(result.success).toBe(false);
  });

  it('rejects a numeric (wrong-type) tm', () => {
    const result = airKoreaNearbyStationItemSchema.safeParse({ ...VALID_ITEM, tm: 8.2 });
    expect(result.success).toBe(false);
  });

  it('rejects a numeric (wrong-type) stationName', () => {
    const result = airKoreaNearbyStationItemSchema.safeParse({ ...VALID_ITEM, stationName: 123 });
    expect(result.success).toBe(false);
  });

  it('rejects a station name over 30 characters (official 항목크기)', () => {
    const result = airKoreaNearbyStationItemSchema.safeParse({
      ...VALID_ITEM,
      stationName: '가'.repeat(31),
    });
    expect(result.success).toBe(false);
  });
});

describe('airKoreaNearbyStationBodySchema', () => {
  it('accepts a well-formed body', () => {
    const result = airKoreaNearbyStationBodySchema.safeParse({
      numOfRows: 10,
      pageNo: 1,
      totalCount: 1,
      items: { item: [VALID_ITEM] },
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty item list when totalCount is zero', () => {
    const result = airKoreaNearbyStationBodySchema.safeParse({
      numOfRows: 10,
      pageNo: 1,
      totalCount: 0,
      items: { item: [] },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-empty item list when totalCount is zero', () => {
    const result = airKoreaNearbyStationBodySchema.safeParse({
      numOfRows: 10,
      pageNo: 1,
      totalCount: 0,
      items: { item: [VALID_ITEM] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an item count exceeding totalCount', () => {
    const result = airKoreaNearbyStationBodySchema.safeParse({
      numOfRows: 10,
      pageNo: 1,
      totalCount: 1,
      items: { item: [VALID_ITEM, VALID_ITEM] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an item count exceeding numOfRows', () => {
    const result = airKoreaNearbyStationBodySchema.safeParse({
      numOfRows: 1,
      pageNo: 1,
      totalCount: 2,
      items: { item: [VALID_ITEM, VALID_ITEM] },
    });
    expect(result.success).toBe(false);
  });
});

describe('airKoreaNearbyStationSuccessResponseSchema', () => {
  it('accepts the technical document’s own no-version response example shape', () => {
    const result = airKoreaNearbyStationSuccessResponseSchema.safeParse(
      successResponse([
        { tm: '8.2', stationName: '부발읍', addr: '경기도 이천시 부발읍' },
        { tm: '9.3', stationName: '설성면', addr: '경기 이천시 설성면' },
        { tm: '9.7', stationName: '창전동', addr: '경기 이천시 영창로' },
      ]),
    );
    expect(result.success).toBe(true);
  });
});
