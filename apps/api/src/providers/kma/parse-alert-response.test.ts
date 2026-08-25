import { describe, expect, it } from 'vitest';

import { parseKmaAlertEventResponse } from './parse-alert-response.js';

function validItem() {
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
        items: { item: [validItem()] },
      },
    },
  };
}

/** Recursively freeze an object so any mutation attempt during parsing would throw. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

describe('parseKmaAlertEventResponse — success', () => {
  it('returns SUCCESS_PAGE with the validated page for a normal success response', () => {
    const result = parseKmaAlertEventResponse(validSuccessResponse());
    expect(result.kind).toBe('SUCCESS_PAGE');
    if (result.kind === 'SUCCESS_PAGE') {
      expect(result.page.dataType).toBe('JSON');
      expect(result.page.pageNo).toBe(1);
      expect(result.page.numOfRows).toBe(1000);
      expect(result.page.totalCount).toBe(1);
      expect(result.page.items).toHaveLength(1);
      expect(result.page.items[0].areaCode).toBe('L1010100');
    }
  });

  it('accepts a success response with an empty item array', () => {
    const response = validSuccessResponse();
    response.response.body.items.item = [];
    response.response.body.totalCount = 0;
    const result = parseKmaAlertEventResponse(response);
    expect(result.kind).toBe('SUCCESS_PAGE');
    if (result.kind === 'SUCCESS_PAGE') {
      expect(result.page.items).toHaveLength(0);
    }
  });

  it('does not mutate the input', () => {
    const response = deepFreeze(validSuccessResponse());
    expect(() => parseKmaAlertEventResponse(response)).not.toThrow();
  });
});

describe('parseKmaAlertEventResponse — confirmed 03 no-data outcome', () => {
  it('classifies resultCode 03 with no body as NO_DATA (not UPSTREAM_ERROR, not INVALID_RESPONSE)', () => {
    const response = {
      response: { header: { resultCode: '03', resultMsg: 'NODATA_ERROR' } },
    };
    const result = parseKmaAlertEventResponse(response);
    expect(result.kind).toBe('NO_DATA');
  });

  it('is a bare NO_DATA outcome with no other fields', () => {
    const response = {
      response: { header: { resultCode: '03', resultMsg: 'NODATA_ERROR' } },
    };
    const result = parseKmaAlertEventResponse(response);
    expect(Object.keys(result)).toEqual(['kind']);
  });

  it('treats a 03 response that unexpectedly carries a body as INVALID_RESPONSE, not silently as NO_DATA or a success page', () => {
    const contradicting = {
      response: {
        header: { resultCode: '03', resultMsg: 'NODATA_ERROR' },
        body: { dataType: 'JSON', pageNo: 1, numOfRows: 1000, totalCount: 0, items: { item: [] } },
      },
    };
    const result = parseKmaAlertEventResponse(contradicting);
    expect(result.kind).toBe('INVALID_RESPONSE');
  });
});

describe('parseKmaAlertEventResponse — upstream error', () => {
  it('classifies a non-00/non-03 code as UPSTREAM_ERROR, preserving only the code (no raw message)', () => {
    const response = {
      response: { header: { resultCode: '30', resultMsg: 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR' } },
    };
    const result = parseKmaAlertEventResponse(response);
    expect(result.kind).toBe('UPSTREAM_ERROR');
    if (result.kind === 'UPSTREAM_ERROR') {
      expect(result.resultCode).toBe('30');
      expect(Object.keys(result).sort()).toEqual(['kind', 'resultCode']);
    }
  });

  it('classifies a non-success header with no body as UPSTREAM_ERROR', () => {
    const response = {
      response: { header: { resultCode: '99', resultMsg: 'ERROR' } },
    };
    const result = parseKmaAlertEventResponse(response);
    expect(result.kind).toBe('UPSTREAM_ERROR');
  });
});

describe('parseKmaAlertEventResponse — invalid response', () => {
  it('classifies null as INVALID_RESPONSE, never throws', () => {
    expect(() => parseKmaAlertEventResponse(null)).not.toThrow();
    expect(parseKmaAlertEventResponse(null).kind).toBe('INVALID_RESPONSE');
  });

  it.each(['not-an-object', 42, true, [], undefined])(
    'classifies non-object input %p as INVALID_RESPONSE, never throws',
    (input) => {
      expect(() => parseKmaAlertEventResponse(input)).not.toThrow();
      expect(parseKmaAlertEventResponse(input).kind).toBe('INVALID_RESPONSE');
    },
  );

  it('classifies a malformed resultCode as INVALID_RESPONSE, never mistaken for an upstream error', () => {
    const response = { response: { header: { resultCode: '000', resultMsg: 'x' } } };
    const result = parseKmaAlertEventResponse(response);
    expect(result.kind).toBe('INVALID_RESPONSE');
  });

  it('classifies a success code with a missing body as INVALID_RESPONSE, never a silent empty page', () => {
    const response = { response: { header: { resultCode: '00', resultMsg: 'NORMAL_SERVICE' } } };
    const result = parseKmaAlertEventResponse(response);
    expect(result.kind).toBe('INVALID_RESPONSE');
  });

  it('classifies a success body with an item missing a required field as INVALID_RESPONSE', () => {
    const response = validSuccessResponse();
    delete (response.response.body.items.item[0] as Record<string, unknown>).warnVar;
    const result = parseKmaAlertEventResponse(response);
    expect(result.kind).toBe('INVALID_RESPONSE');
  });

  it('sanitized issues never include the raw offending value', () => {
    const response = validSuccessResponse();
    (response.response.body.items.item[0] as unknown as Record<string, unknown>).tmFc =
      'SECRET_RAW_VALUE_MARKER';
    const result = parseKmaAlertEventResponse(response);
    expect(result.kind).toBe('INVALID_RESPONSE');
    expect(JSON.stringify(result)).not.toContain('SECRET_RAW_VALUE_MARKER');
  });

  it('deterministically orders issues by (path, message)', () => {
    const response = validSuccessResponse();
    delete (response.response.body.items.item[0] as Record<string, unknown>).areaCode;
    delete (response.response.body.items.item[0] as Record<string, unknown>).cancel;
    const first = parseKmaAlertEventResponse(response);
    const second = parseKmaAlertEventResponse(response);
    expect(first).toEqual(second);
  });
});
