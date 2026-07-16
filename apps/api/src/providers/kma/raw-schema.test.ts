import { describe, expect, it } from 'vitest';

import {
  KMA_SUCCESS_RESULT_CODE,
  kmaForecastBodySchema,
  kmaForecastItemSchema,
  kmaForecastSuccessResponseSchema,
  kmaResponseHeaderSchema,
} from './raw-schema';

/**
 * A valid 단기예보 (getVilageFcst) item. Category TMP is provided "실수로" (real number) but is
 * still string-encoded in the official JSON. Returns a fresh object per call so a test can
 * mutate its copy without affecting others.
 */
function validShortForecastItem() {
  return {
    baseDate: '20240127',
    baseTime: '0500',
    category: 'TMP',
    fcstDate: '20240127',
    fcstTime: '0600',
    fcstValue: '-2',
    nx: 61,
    ny: 126,
  };
}

/** A valid 초단기예보 (getUltraSrtFcst) item. Category LGT is 초단기예보-flavored. */
function validUltraShortForecastItem() {
  return {
    baseDate: '20210628',
    baseTime: '0630',
    category: 'LGT',
    fcstDate: '20210628',
    fcstTime: '1200',
    fcstValue: '0',
    nx: 55,
    ny: 127,
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
        numOfRows: 12,
        totalCount: 809,
        items: { item: [validShortForecastItem()] },
      },
    },
  };
}

describe('KMA_SUCCESS_RESULT_CODE', () => {
  it('is the official NORMAL_SERVICE code, as a two-character string', () => {
    expect(KMA_SUCCESS_RESULT_CODE).toBe('00');
  });
});

describe('kmaForecastItemSchema — valid items', () => {
  it('accepts a valid 단기예보 item', () => {
    expect(kmaForecastItemSchema.safeParse(validShortForecastItem()).success).toBe(true);
  });

  it('accepts a valid 초단기예보 item', () => {
    expect(kmaForecastItemSchema.safeParse(validUltraShortForecastItem()).success).toBe(true);
  });

  it('accepts an unknown/future category code (not an enum)', () => {
    const item = { ...validShortForecastItem(), category: 'ZZZ' };
    expect(kmaForecastItemSchema.safeParse(item).success).toBe(true);
  });

  it('strips unknown extra fields rather than failing', () => {
    const item = { ...validShortForecastItem(), somethingNew: 'ignore-me' };
    const result = kmaForecastItemSchema.safeParse(item);
    expect(result.success).toBe(true);
    if (result.success) {
      expect('somethingNew' in result.data).toBe(false);
    }
  });
});

describe('kmaForecastItemSchema — required fields', () => {
  const requiredFields = [
    'baseDate',
    'baseTime',
    'category',
    'fcstDate',
    'fcstTime',
    'fcstValue',
    'nx',
    'ny',
  ] as const;

  it.each(requiredFields)('rejects an item missing %s', (field) => {
    const item: Record<string, unknown> = validShortForecastItem();
    delete item[field];
    expect(kmaForecastItemSchema.safeParse(item).success).toBe(false);
  });
});

describe('kmaForecastItemSchema — date validation (YYYYMMDD calendar dates)', () => {
  const invalidDates = ['20260230', '20251301', '20250010', '20250229', '2026071', '2026-07-16', ''];

  it.each(invalidDates)('rejects invalid baseDate %s', (baseDate) => {
    expect(kmaForecastItemSchema.safeParse({ ...validShortForecastItem(), baseDate }).success).toBe(
      false,
    );
  });

  it.each(invalidDates)('rejects invalid fcstDate %s', (fcstDate) => {
    expect(kmaForecastItemSchema.safeParse({ ...validShortForecastItem(), fcstDate }).success).toBe(
      false,
    );
  });

  it('rejects Feb 29 in a common year (20250229)', () => {
    const item = { ...validShortForecastItem(), baseDate: '20250229', fcstDate: '20250229' };
    expect(kmaForecastItemSchema.safeParse(item).success).toBe(false);
  });

  it('accepts Feb 29 in a leap year (20240229)', () => {
    const item = { ...validShortForecastItem(), baseDate: '20240229', fcstDate: '20240229' };
    expect(kmaForecastItemSchema.safeParse(item).success).toBe(true);
  });
});

describe('kmaForecastItemSchema — time validation (HHmm)', () => {
  const invalidTimes = ['2400', '1260', '060', '06000', '24:00', 'ab00', ''];

  it.each(invalidTimes)('rejects invalid baseTime %s', (baseTime) => {
    expect(kmaForecastItemSchema.safeParse({ ...validShortForecastItem(), baseTime }).success).toBe(
      false,
    );
  });

  it.each(invalidTimes)('rejects invalid fcstTime %s', (fcstTime) => {
    expect(kmaForecastItemSchema.safeParse({ ...validShortForecastItem(), fcstTime }).success).toBe(
      false,
    );
  });

  it('accepts boundary times 0000 and 2359', () => {
    const item = { ...validShortForecastItem(), baseTime: '0000', fcstTime: '2359' };
    expect(kmaForecastItemSchema.safeParse(item).success).toBe(true);
  });
});

describe('kmaForecastItemSchema — category validation (ASCII uppercase/digit only)', () => {
  const acceptedCategories = ['TMP', 'RN1', 'ZZZ', 'A', 'A1B2', 'PTY', 'SKY'];

  it.each(acceptedCategories)('accepts the official/future code shape %s', (category) => {
    expect(kmaForecastItemSchema.safeParse({ ...validShortForecastItem(), category }).success).toBe(true);
  });

  const rejectedCategories: readonly [string, string][] = [
    ['empty string', ''],
    ['single space', ' '],
    ['leading space', ' TMP'],
    ['trailing space', 'TMP '],
    ['whitespace only', '   '],
    ['internal space', 'T MP'],
    ['internal tab', 'T\tMP'],
    ['internal newline', 'T\nMP'],
    ['leading control char', '\x1fTMP'],
    ['lowercase', 'tmp'],
    ['mixed case', 'Tmp'],
    ['hyphen', 'TMP-1'],
    ['underscore', 'TMP_1'],
    ['hangul', '기온'],
  ];

  it.each(rejectedCategories)('rejects a category with %s', (_label, category) => {
    expect(kmaForecastItemSchema.safeParse({ ...validShortForecastItem(), category }).success).toBe(false);
  });

  it('still accepts an unknown/future code as long as it is [A-Z0-9]+ (not an enum)', () => {
    expect(kmaForecastItemSchema.safeParse({ ...validShortForecastItem(), category: 'QWERTY9' }).success).toBe(
      true,
    );
  });
});

describe('kmaForecastItemSchema — fcstValue (string | null, key required)', () => {
  it('accepts a string fcstValue', () => {
    expect(kmaForecastItemSchema.safeParse({ ...validShortForecastItem(), fcstValue: '6.2' }).success).toBe(
      true,
    );
  });

  it('accepts an explicit null fcstValue', () => {
    const result = kmaForecastItemSchema.safeParse({ ...validShortForecastItem(), fcstValue: null });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fcstValue).toBeNull();
    }
  });

  it('distinguishes a missing fcstValue key (fail) from an explicit null (pass)', () => {
    const missing: Record<string, unknown> = validShortForecastItem();
    delete missing.fcstValue;
    expect(kmaForecastItemSchema.safeParse(missing).success).toBe(false);

    expect(kmaForecastItemSchema.safeParse({ ...validShortForecastItem(), fcstValue: null }).success).toBe(
      true,
    );
  });

  it('rejects a number fcstValue (no numeric coercion, incl. non-finite)', () => {
    expect(kmaForecastItemSchema.safeParse({ ...validShortForecastItem(), fcstValue: 21 }).success).toBe(
      false,
    );
    expect(kmaForecastItemSchema.safeParse({ ...validShortForecastItem(), fcstValue: 6.2 }).success).toBe(
      false,
    );
    expect(kmaForecastItemSchema.safeParse({ ...validShortForecastItem(), fcstValue: Number.NaN }).success).toBe(
      false,
    );
    expect(
      kmaForecastItemSchema.safeParse({ ...validShortForecastItem(), fcstValue: Number.POSITIVE_INFINITY })
        .success,
    ).toBe(false);
  });

  it('rejects an object or array fcstValue', () => {
    expect(kmaForecastItemSchema.safeParse({ ...validShortForecastItem(), fcstValue: {} }).success).toBe(
      false,
    );
    expect(kmaForecastItemSchema.safeParse({ ...validShortForecastItem(), fcstValue: ['6.2'] }).success).toBe(
      false,
    );
  });
});

describe('kmaForecastItemSchema — grid coordinates (nx, ny)', () => {
  it('rejects a negative coordinate', () => {
    expect(kmaForecastItemSchema.safeParse({ ...validShortForecastItem(), nx: -1 }).success).toBe(false);
  });

  it('rejects a non-integer coordinate', () => {
    expect(kmaForecastItemSchema.safeParse({ ...validShortForecastItem(), ny: 126.5 }).success).toBe(false);
  });

  it('rejects a string coordinate (no coercion)', () => {
    expect(kmaForecastItemSchema.safeParse({ ...validShortForecastItem(), nx: '61' }).success).toBe(false);
  });
});

describe('kmaResponseHeaderSchema — resultCode (exactly two digits)', () => {
  it('accepts string resultCode / resultMsg', () => {
    expect(
      kmaResponseHeaderSchema.safeParse({ resultCode: '00', resultMsg: 'NORMAL_SERVICE' }).success,
    ).toBe(true);
  });

  const acceptedCodes = ['00', '03', '30', '99', '01', '22'];

  it.each(acceptedCodes)('accepts the two-digit code %s (structural, not an enum)', (resultCode) => {
    expect(kmaResponseHeaderSchema.safeParse({ resultCode, resultMsg: 'X' }).success).toBe(true);
  });

  const rejectedCodes: readonly [string, string][] = [
    ['empty string', ''],
    ['one digit', '0'],
    ['three digits', '000'],
    ['letters', 'AB'],
    ['surrounding spaces', ' 03 '],
    ['trailing space', '03 '],
    ['leading space', ' 03'],
    ['signed', '+3'],
    ['non-digit', '0x'],
  ];

  it.each(rejectedCodes)('rejects a malformed resultCode with %s', (_label, resultCode) => {
    expect(kmaResponseHeaderSchema.safeParse({ resultCode, resultMsg: 'X' }).success).toBe(false);
  });

  it('rejects a non-string resultCode (no numeric coercion of the success code)', () => {
    expect(kmaResponseHeaderSchema.safeParse({ resultCode: 0, resultMsg: 'NORMAL_SERVICE' }).success).toBe(
      false,
    );
  });
});

describe('kmaForecastBodySchema — pagination', () => {
  function validBody() {
    return {
      dataType: 'JSON',
      pageNo: 1,
      numOfRows: 12,
      totalCount: 809,
      items: { item: [validShortForecastItem()] },
    };
  }

  it('accepts a valid body', () => {
    expect(kmaForecastBodySchema.safeParse(validBody()).success).toBe(true);
  });

  it('rejects a string pageNo (no numeric coercion)', () => {
    expect(kmaForecastBodySchema.safeParse({ ...validBody(), pageNo: '1' }).success).toBe(false);
  });

  it('rejects a negative totalCount', () => {
    expect(kmaForecastBodySchema.safeParse({ ...validBody(), totalCount: -1 }).success).toBe(false);
  });

  it('accepts totalCount 0 (non-negative)', () => {
    expect(kmaForecastBodySchema.safeParse({ ...validBody(), totalCount: 0, items: { item: [] } }).success).toBe(
      true,
    );
  });

  it('rejects a non-array items.item', () => {
    expect(
      kmaForecastBodySchema.safeParse({ ...validBody(), items: { item: validShortForecastItem() } }).success,
    ).toBe(false);
  });

  it('does not assume totalCount equals the current page item count', () => {
    // One item on the page, but totalCount 809 — valid, no cross-field equality assertion.
    expect(kmaForecastBodySchema.safeParse(validBody()).success).toBe(true);
  });

  it('accepts a normal full page (numOfRows 100, totalCount 809, 3 items)', () => {
    const body = {
      ...validBody(),
      numOfRows: 100,
      totalCount: 809,
      items: {
        item: [validShortForecastItem(), validUltraShortForecastItem(), validShortForecastItem()],
      },
    };
    expect(kmaForecastBodySchema.safeParse(body).success).toBe(true);
  });

  it('accepts a last page holding fewer items than numOfRows (2 items, numOfRows 100)', () => {
    const body = {
      ...validBody(),
      numOfRows: 100,
      totalCount: 809,
      items: { item: [validShortForecastItem(), validUltraShortForecastItem()] },
    };
    expect(kmaForecastBodySchema.safeParse(body).success).toBe(true);
  });

  it('rejects an obvious contradiction: totalCount 0 but items present', () => {
    const body = { ...validBody(), totalCount: 0, items: { item: [validShortForecastItem()] } };
    expect(kmaForecastBodySchema.safeParse(body).success).toBe(false);
  });

  it('rejects item count greater than numOfRows', () => {
    const body = {
      ...validBody(),
      numOfRows: 1,
      totalCount: 809,
      items: { item: [validShortForecastItem(), validUltraShortForecastItem()] },
    };
    expect(kmaForecastBodySchema.safeParse(body).success).toBe(false);
  });

  it('rejects item count greater than totalCount', () => {
    const body = {
      ...validBody(),
      numOfRows: 100,
      totalCount: 1,
      items: { item: [validShortForecastItem(), validUltraShortForecastItem()] },
    };
    expect(kmaForecastBodySchema.safeParse(body).success).toBe(false);
  });

  it('accepts totalCount greater than the page item count (normal pagination)', () => {
    const body = { ...validBody(), numOfRows: 100, totalCount: 809, items: { item: [validShortForecastItem()] } };
    expect(kmaForecastBodySchema.safeParse(body).success).toBe(true);
  });

  it('accepts totalCount > 0 with an empty item array (no official sample; allowed defensively)', () => {
    // Policy: there is no confirmed official empty-success-page sample, so this is allowed
    // defensively (not a merge-blocking rule) and re-evaluated against a real response in PR #5.
    const body = { ...validBody(), numOfRows: 100, totalCount: 809, items: { item: [] } };
    expect(kmaForecastBodySchema.safeParse(body).success).toBe(true);
  });
});

describe('kmaForecastBodySchema — dataType (literal "JSON")', () => {
  function validBody() {
    return {
      dataType: 'JSON',
      pageNo: 1,
      numOfRows: 12,
      totalCount: 809,
      items: { item: [validShortForecastItem()] },
    };
  }

  it('accepts dataType "JSON"', () => {
    expect(kmaForecastBodySchema.safeParse(validBody()).success).toBe(true);
  });

  const rejectedDataTypes = ['XML', '', 'json', 'UNKNOWN', 'Json', 'JSON '];

  it.each(rejectedDataTypes)('rejects dataType %o', (dataType) => {
    expect(kmaForecastBodySchema.safeParse({ ...validBody(), dataType }).success).toBe(false);
  });
});

describe('kmaForecastSuccessResponseSchema — full success envelope', () => {
  it('accepts a valid success response', () => {
    expect(kmaForecastSuccessResponseSchema.safeParse(validSuccessResponse()).success).toBe(true);
  });

  it('rejects a success envelope whose body is missing', () => {
    const response = { response: { header: { resultCode: '00', resultMsg: 'NORMAL_SERVICE' } } };
    expect(kmaForecastSuccessResponseSchema.safeParse(response).success).toBe(false);
  });
});
