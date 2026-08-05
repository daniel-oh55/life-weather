import { describe, expect, it } from 'vitest';

import {
  kmaCurrentObservationBodySchema,
  kmaCurrentObservationItemSchema,
  kmaCurrentObservationSuccessResponseSchema,
} from './current-raw-schema.js';

/**
 * A valid 초단기실황 (getUltraSrtNcst) item. Returns a fresh object per call so a test can mutate
 * its copy without affecting others.
 */
function validCurrentItem() {
  return {
    baseDate: '20260716',
    baseTime: '0600',
    category: 'T1H',
    obsrValue: '23.5',
    nx: 61,
    ny: 126,
  };
}

/** A valid success envelope wrapping a single item. */
function validSuccessResponse() {
  return {
    response: {
      header: { resultCode: '00', resultMsg: 'NORMAL_SERVICE' },
      body: {
        dataType: 'JSON',
        pageNo: 1,
        numOfRows: 1000,
        totalCount: 8,
        items: { item: [validCurrentItem()] },
      },
    },
  };
}

describe('kmaCurrentObservationItemSchema — valid items', () => {
  it('accepts a valid current-observation item', () => {
    expect(kmaCurrentObservationItemSchema.safeParse(validCurrentItem()).success).toBe(true);
  });

  it('accepts an explicit null obsrValue', () => {
    const item = { ...validCurrentItem(), obsrValue: null };
    expect(kmaCurrentObservationItemSchema.safeParse(item).success).toBe(true);
  });

  it('accepts an unknown/future category code (not an enum)', () => {
    const item = { ...validCurrentItem(), category: 'ZZZ' };
    expect(kmaCurrentObservationItemSchema.safeParse(item).success).toBe(true);
  });

  it('strips unknown extra fields rather than failing', () => {
    const item = { ...validCurrentItem(), somethingNew: 'ignore-me' };
    const result = kmaCurrentObservationItemSchema.safeParse(item);
    expect(result.success).toBe(true);
    if (result.success) {
      expect('somethingNew' in result.data).toBe(false);
    }
  });

  it('has no fcstDate/fcstTime/fcstValue fields (current observation, not forecast)', () => {
    const item = validCurrentItem();
    const result = kmaCurrentObservationItemSchema.safeParse(item);
    expect(result.success).toBe(true);
    if (result.success) {
      expect('fcstDate' in result.data).toBe(false);
      expect('fcstTime' in result.data).toBe(false);
      expect('fcstValue' in result.data).toBe(false);
    }
  });
});

describe('kmaCurrentObservationItemSchema — required fields', () => {
  const requiredFields = ['baseDate', 'baseTime', 'category', 'obsrValue', 'nx', 'ny'] as const;

  it.each(requiredFields)('rejects an item missing %s', (field) => {
    const item: Record<string, unknown> = validCurrentItem();
    delete item[field];
    expect(kmaCurrentObservationItemSchema.safeParse(item).success).toBe(false);
  });

  it('rejects a numeric obsrValue (no coercion, string only or null)', () => {
    const item = { ...validCurrentItem(), obsrValue: 23.5 };
    expect(kmaCurrentObservationItemSchema.safeParse(item).success).toBe(false);
  });

  it('rejects an object obsrValue', () => {
    const item = { ...validCurrentItem(), obsrValue: { value: 23.5 } };
    expect(kmaCurrentObservationItemSchema.safeParse(item).success).toBe(false);
  });

  it('rejects an array obsrValue', () => {
    const item = { ...validCurrentItem(), obsrValue: ['23.5'] };
    expect(kmaCurrentObservationItemSchema.safeParse(item).success).toBe(false);
  });
});

describe('kmaCurrentObservationItemSchema — date validation (YYYYMMDD calendar dates)', () => {
  const invalidDates = ['20260230', '20251301', '20250010', '20250229', '2026071', '2026-07-16', ''];

  it.each(invalidDates)('rejects invalid baseDate %s', (baseDate) => {
    expect(
      kmaCurrentObservationItemSchema.safeParse({ ...validCurrentItem(), baseDate }).success,
    ).toBe(false);
  });

  it('rejects Feb 29 in a common year (20250229)', () => {
    const item = { ...validCurrentItem(), baseDate: '20250229' };
    expect(kmaCurrentObservationItemSchema.safeParse(item).success).toBe(false);
  });

  it('accepts Feb 29 in a leap year (20240229)', () => {
    const item = { ...validCurrentItem(), baseDate: '20240229' };
    expect(kmaCurrentObservationItemSchema.safeParse(item).success).toBe(true);
  });
});

describe('kmaCurrentObservationItemSchema — time validation (HHmm)', () => {
  const invalidTimes = ['2400', '1260', '060', '06000', '24:00', 'ab00', ''];

  it.each(invalidTimes)('rejects invalid baseTime %s', (baseTime) => {
    expect(
      kmaCurrentObservationItemSchema.safeParse({ ...validCurrentItem(), baseTime }).success,
    ).toBe(false);
  });

  it('accepts a valid on-the-hour baseTime', () => {
    expect(
      kmaCurrentObservationItemSchema.safeParse({ ...validCurrentItem(), baseTime: '0600' })
        .success,
    ).toBe(true);
  });
});

describe('kmaCurrentObservationItemSchema — category validation', () => {
  it.each(['t1h', 'T 1H', 'T1H\n', ' T1H', 'T1H ', 'T1H-2', ''])(
    'rejects malformed category %s',
    (category) => {
      expect(
        kmaCurrentObservationItemSchema.safeParse({ ...validCurrentItem(), category }).success,
      ).toBe(false);
    },
  );
});

describe('kmaCurrentObservationItemSchema — grid coordinates', () => {
  it('rejects a negative nx', () => {
    expect(
      kmaCurrentObservationItemSchema.safeParse({ ...validCurrentItem(), nx: -1 }).success,
    ).toBe(false);
  });

  it('rejects a non-integer ny', () => {
    expect(
      kmaCurrentObservationItemSchema.safeParse({ ...validCurrentItem(), ny: 12.5 }).success,
    ).toBe(false);
  });

  it('rejects a string coordinate (no coercion)', () => {
    expect(
      kmaCurrentObservationItemSchema.safeParse({ ...validCurrentItem(), nx: '61' }).success,
    ).toBe(false);
  });
});

describe('kmaCurrentObservationBodySchema — pagination self-contradictions', () => {
  it('accepts a full page', () => {
    const body = {
      dataType: 'JSON',
      pageNo: 1,
      numOfRows: 1,
      totalCount: 1,
      items: { item: [validCurrentItem()] },
    };
    expect(kmaCurrentObservationBodySchema.safeParse(body).success).toBe(true);
  });

  it('accepts totalCount = 0 with an empty item array', () => {
    const body = {
      dataType: 'JSON',
      pageNo: 1,
      numOfRows: 1000,
      totalCount: 0,
      items: { item: [] },
    };
    expect(kmaCurrentObservationBodySchema.safeParse(body).success).toBe(true);
  });

  it('rejects totalCount = 0 with a non-empty item array', () => {
    const body = {
      dataType: 'JSON',
      pageNo: 1,
      numOfRows: 1000,
      totalCount: 0,
      items: { item: [validCurrentItem()] },
    };
    expect(kmaCurrentObservationBodySchema.safeParse(body).success).toBe(false);
  });

  it('rejects item count exceeding numOfRows', () => {
    const body = {
      dataType: 'JSON',
      pageNo: 1,
      numOfRows: 1,
      totalCount: 5,
      items: { item: [validCurrentItem(), validCurrentItem()] },
    };
    expect(kmaCurrentObservationBodySchema.safeParse(body).success).toBe(false);
  });

  it('rejects item count exceeding totalCount', () => {
    const body = {
      dataType: 'JSON',
      pageNo: 1,
      numOfRows: 1000,
      totalCount: 1,
      items: { item: [validCurrentItem(), validCurrentItem()] },
    };
    expect(kmaCurrentObservationBodySchema.safeParse(body).success).toBe(false);
  });

  it('allows totalCount > item.length (defensive empty/partial success page allowance)', () => {
    const body = {
      dataType: 'JSON',
      pageNo: 1,
      numOfRows: 1000,
      totalCount: 8,
      items: { item: [] },
    };
    expect(kmaCurrentObservationBodySchema.safeParse(body).success).toBe(true);
  });

  it('rejects a non-JSON dataType', () => {
    const body = {
      dataType: 'XML',
      pageNo: 1,
      numOfRows: 1000,
      totalCount: 1,
      items: { item: [validCurrentItem()] },
    };
    expect(kmaCurrentObservationBodySchema.safeParse(body).success).toBe(false);
  });
});

describe('kmaCurrentObservationSuccessResponseSchema — shared header reuse', () => {
  it('accepts a valid success envelope', () => {
    expect(
      kmaCurrentObservationSuccessResponseSchema.safeParse(validSuccessResponse()).success,
    ).toBe(true);
  });

  it('rejects a malformed resultCode (same policy as the forecast header)', () => {
    const response = validSuccessResponse();
    response.response.header.resultCode = '0';
    expect(kmaCurrentObservationSuccessResponseSchema.safeParse(response).success).toBe(false);
  });

  it('rejects a missing header', () => {
    const response: Record<string, unknown> = validSuccessResponse();
    const inner = response.response as Record<string, unknown>;
    delete inner.header;
    expect(kmaCurrentObservationSuccessResponseSchema.safeParse(response).success).toBe(false);
  });
});
