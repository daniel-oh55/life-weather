import { describe, expect, it } from 'vitest';

import {
  KMA_ALERT_NO_DATA_RESULT_CODE,
  kmaAlertEventBodySchema,
  kmaAlertEventItemSchema,
  kmaAlertEventSuccessResponseSchema,
  kmaAlertNoDataResponseSchema,
} from './alert-raw-schema.js';

/** A valid `getPwnCd` alert-event item matching the confirmed live-diagnostic type matrix. */
function validAlertItem() {
  return {
    stnId: '108',
    tmFc: 202608251400,
    tmSeq: 1,
    areaCode: 'L1010100',
    areaName: '서울',
    warnVar: 3,
    warnStress: 2,
    command: '발표',
    startTime: 202608251400,
    endTime: 202608261400,
    allEndTime: 202608261400,
    cancel: '0',
  };
}

function validSuccessResponse() {
  return {
    response: {
      header: { resultCode: '00', resultMsg: 'NORMAL_SERVICE' },
      body: {
        dataType: 'JSON',
        pageNo: 1,
        numOfRows: 1000,
        totalCount: 1,
        items: { item: [validAlertItem()] },
      },
    },
  };
}

describe('KMA_ALERT_NO_DATA_RESULT_CODE', () => {
  it('is the confirmed operation-specific no-data code', () => {
    expect(KMA_ALERT_NO_DATA_RESULT_CODE).toBe('03');
  });
});

describe('kmaAlertEventItemSchema — valid items', () => {
  it('accepts a valid item', () => {
    expect(kmaAlertEventItemSchema.safeParse(validAlertItem()).success).toBe(true);
  });

  it('strips unknown extra fields rather than failing', () => {
    const item = { ...validAlertItem(), somethingNew: 'ignore-me' };
    const result = kmaAlertEventItemSchema.safeParse(item);
    expect(result.success).toBe(true);
    if (result.success) {
      expect('somethingNew' in result.data).toBe(false);
    }
  });
});

describe('kmaAlertEventItemSchema — required fields', () => {
  const requiredFields = ['stnId', 'tmFc', 'areaCode', 'areaName', 'allEndTime'] as const;

  it.each(requiredFields)('rejects an item missing %s', (field) => {
    const item: Record<string, unknown> = validAlertItem();
    delete item[field];
    expect(kmaAlertEventItemSchema.safeParse(item).success).toBe(false);
  });

  it.each(requiredFields)('rejects an explicit null for %s (no field here is nullable)', (field) => {
    const item: Record<string, unknown> = { ...validAlertItem(), [field]: null };
    expect(kmaAlertEventItemSchema.safeParse(item).success).toBe(false);
  });
});

describe('kmaAlertEventItemSchema — guide-optional/conditional response fields', () => {
  const optionalFields = [
    'tmSeq',
    'warnVar',
    'warnStress',
    'command',
    'startTime',
    'endTime',
    'cancel',
  ] as const;

  it.each(optionalFields)('accepts an item with %s absent', (field) => {
    const item: Record<string, unknown> = validAlertItem();
    delete item[field];
    expect(kmaAlertEventItemSchema.safeParse(item).success).toBe(true);
  });

  it.each(optionalFields)('rejects an explicit null for %s (absence, not null)', (field) => {
    const item: Record<string, unknown> = { ...validAlertItem(), [field]: null };
    expect(kmaAlertEventItemSchema.safeParse(item).success).toBe(false);
  });

  it('rejects a numeric-string tmSeq when present', () => {
    const item = { ...validAlertItem(), tmSeq: '1' };
    expect(kmaAlertEventItemSchema.safeParse(item).success).toBe(false);
  });

  it('rejects a string warnVar when present', () => {
    const item = { ...validAlertItem(), warnVar: 'not-a-number' };
    expect(kmaAlertEventItemSchema.safeParse(item).success).toBe(false);
  });

  it('rejects a numeric-string warnStress when present', () => {
    const item = { ...validAlertItem(), warnStress: '2' };
    expect(kmaAlertEventItemSchema.safeParse(item).success).toBe(false);
  });

  it('rejects a numeric command when present', () => {
    const item = { ...validAlertItem(), command: 2 };
    expect(kmaAlertEventItemSchema.safeParse(item).success).toBe(false);
  });

  it('rejects an empty-string cancel when present', () => {
    const item = { ...validAlertItem(), cancel: '' };
    expect(kmaAlertEventItemSchema.safeParse(item).success).toBe(false);
  });

  it('accepts a release-like item with startTime absent (announcement-only field per guide semantics)', () => {
    const item: Record<string, unknown> = validAlertItem();
    delete item.startTime;
    expect(kmaAlertEventItemSchema.safeParse(item).success).toBe(true);
  });

  it('rejects a null startTime even though startTime may be absent', () => {
    const item = { ...validAlertItem(), startTime: null };
    expect(kmaAlertEventItemSchema.safeParse(item).success).toBe(false);
  });

  it('accepts an issue-like item with endTime absent (release-only field per guide semantics)', () => {
    const item: Record<string, unknown> = validAlertItem();
    delete item.endTime;
    expect(kmaAlertEventItemSchema.safeParse(item).success).toBe(true);
  });

  it('rejects an empty-string endTime even though endTime may be absent', () => {
    const item = { ...validAlertItem(), endTime: '' };
    expect(kmaAlertEventItemSchema.safeParse(item).success).toBe(false);
  });

  it('accepts an item with every guide-optional field absent at once', () => {
    const item: Record<string, unknown> = validAlertItem();
    for (const field of optionalFields) {
      delete item[field];
    }
    expect(kmaAlertEventItemSchema.safeParse(item).success).toBe(true);
  });
});

describe('kmaAlertEventItemSchema — type discipline (no coercion)', () => {
  it('rejects a numeric-string tmFc (numbers are not strings)', () => {
    const item = { ...validAlertItem(), tmFc: '202608251400' };
    expect(kmaAlertEventItemSchema.safeParse(item).success).toBe(false);
  });

  it('rejects a numeric stnId (strings are not numbers)', () => {
    const item = { ...validAlertItem(), stnId: 108 };
    expect(kmaAlertEventItemSchema.safeParse(item).success).toBe(false);
  });

  it('rejects a non-integer warnVar', () => {
    const item = { ...validAlertItem(), warnVar: 3.5 };
    expect(kmaAlertEventItemSchema.safeParse(item).success).toBe(false);
  });

  it('rejects an empty-string areaName (required, non-empty)', () => {
    const item = { ...validAlertItem(), areaName: '' };
    expect(kmaAlertEventItemSchema.safeParse(item).success).toBe(false);
  });
});

describe('kmaAlertEventBodySchema — pagination self-contradictions', () => {
  it('accepts a well-formed body', () => {
    expect(kmaAlertEventBodySchema.safeParse(validSuccessResponse().response.body).success).toBe(
      true,
    );
  });

  it('rejects item count exceeding numOfRows', () => {
    const body = {
      ...validSuccessResponse().response.body,
      numOfRows: 0,
      items: { item: [validAlertItem()] },
    };
    expect(kmaAlertEventBodySchema.safeParse(body).success).toBe(false);
  });

  it('rejects item count exceeding totalCount', () => {
    const body = {
      ...validSuccessResponse().response.body,
      totalCount: 0,
      items: { item: [validAlertItem()] },
    };
    expect(kmaAlertEventBodySchema.safeParse(body).success).toBe(false);
  });

  it('accepts totalCount > 0 with an empty item array (normal pagination, no official empty-page evidence against it)', () => {
    const body = {
      ...validSuccessResponse().response.body,
      totalCount: 5,
      items: { item: [] },
    };
    expect(kmaAlertEventBodySchema.safeParse(body).success).toBe(true);
  });

  it('rejects a single-object item (not an array) — never independently observed', () => {
    const body = {
      ...validSuccessResponse().response.body,
      items: { item: validAlertItem() },
    };
    expect(kmaAlertEventBodySchema.safeParse(body).success).toBe(false);
  });
});

describe('kmaAlertEventSuccessResponseSchema', () => {
  it('accepts a full valid success envelope', () => {
    expect(kmaAlertEventSuccessResponseSchema.safeParse(validSuccessResponse()).success).toBe(
      true,
    );
  });

  it('rejects a dataType other than JSON', () => {
    const response = validSuccessResponse();
    (response.response.body as { dataType: string }).dataType = 'XML';
    expect(kmaAlertEventSuccessResponseSchema.safeParse(response).success).toBe(false);
  });
});

describe('kmaAlertNoDataResponseSchema — confirmed 03 no-body shape', () => {
  it('accepts a header-only response with no body key at all', () => {
    const noData = {
      response: { header: { resultCode: '03', resultMsg: 'NODATA_ERROR' } },
    };
    expect(kmaAlertNoDataResponseSchema.safeParse(noData).success).toBe(true);
  });

  it('rejects a 03 response that unexpectedly carries a body (contradicts confirmed shape)', () => {
    const contradicting = {
      response: {
        header: { resultCode: '03', resultMsg: 'NODATA_ERROR' },
        body: { dataType: 'JSON', pageNo: 1, numOfRows: 1000, totalCount: 0, items: { item: [] } },
      },
    };
    expect(kmaAlertNoDataResponseSchema.safeParse(contradicting).success).toBe(false);
  });

  it('rejects a malformed header even when body is absent', () => {
    const malformed = { response: { header: { resultCode: 'X', resultMsg: 'bad' } } };
    expect(kmaAlertNoDataResponseSchema.safeParse(malformed).success).toBe(false);
  });
});
