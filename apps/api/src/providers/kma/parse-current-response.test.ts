import { describe, expect, it } from 'vitest';

import { parseKmaCurrentObservationResponse } from './parse-current-response.js';

function validItem(): {
  baseDate: string;
  baseTime: string;
  category: string;
  obsrValue: string | null;
  nx: number;
  ny: number;
} {
  return {
    baseDate: '20260716',
    baseTime: '0600',
    category: 'T1H',
    obsrValue: '23.5',
    nx: 61,
    ny: 126,
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
        totalCount: 8,
        items: { item: [validItem()] },
      },
    },
  };
}

describe('parseKmaCurrentObservationResponse — success', () => {
  it('returns ok:true with the validated page for a normal success response', () => {
    const result = parseKmaCurrentObservationResponse(validSuccessResponse());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.page.dataType).toBe('JSON');
      expect(result.page.pageNo).toBe(1);
      expect(result.page.numOfRows).toBe(1000);
      expect(result.page.totalCount).toBe(8);
      expect(result.page.items).toHaveLength(1);
      expect(result.page.items[0]!.category).toBe('T1H');
      expect(result.page.items[0]!.obsrValue).toBe('23.5');
    }
  });

  it('accepts a success response with an empty item array', () => {
    const response = validSuccessResponse();
    response.response.body.items.item = [];
    response.response.body.totalCount = 0;
    const result = parseKmaCurrentObservationResponse(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.page.items).toHaveLength(0);
    }
  });

  it('preserves an explicit null obsrValue (field-presence model)', () => {
    const response = validSuccessResponse();
    response.response.body.items.item = [{ ...validItem(), obsrValue: null }];
    const result = parseKmaCurrentObservationResponse(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.page.items[0]!.obsrValue).toBeNull();
    }
  });
});

describe('parseKmaCurrentObservationResponse — upstream error', () => {
  it('classifies NODATA_ERROR (03) as UPSTREAM_ERROR, preserving only the code (no raw message)', () => {
    const response = {
      response: { header: { resultCode: '03', resultMsg: 'NO_DATA' } },
    };
    const result = parseKmaCurrentObservationResponse(response);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'UPSTREAM_ERROR') {
      expect(result.error.resultCode).toBe('03');
      expect('resultMessage' in result.error).toBe(false);
      expect(Object.keys(result.error).sort()).toEqual(['kind', 'resultCode']);
    } else {
      expect.fail('expected UPSTREAM_ERROR');
    }
  });

  it.each(['03', '30', '99', '01', '22'])(
    'classifies the valid two-digit non-success code %s as UPSTREAM_ERROR',
    (resultCode) => {
      const response = { response: { header: { resultCode, resultMsg: 'X' } } };
      const result = parseKmaCurrentObservationResponse(response);
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === 'UPSTREAM_ERROR') {
        expect(result.error.resultCode).toBe(resultCode);
      } else {
        expect.fail('expected UPSTREAM_ERROR');
      }
    },
  );

  it('never copies an untrusted raw resultMsg (secret marker / CR-LF) onto the public error', () => {
    const response = {
      response: {
        header: {
          resultCode: '03',
          resultMsg: 'aBcD1234%2BFakeSecret%3D\r\nInjected-Line',
        },
      },
    };
    const result = parseKmaCurrentObservationResponse(response);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'UPSTREAM_ERROR') {
      const serialized = JSON.stringify(result.error);
      expect(serialized).not.toContain('FakeSecret');
      expect(serialized).not.toContain('%2B');
      expect(serialized).not.toContain('Injected-Line');
      expect(serialized).not.toContain('\r');
      expect(serialized).not.toContain('\n');
      expect('resultMessage' in result.error).toBe(false);
    } else {
      expect.fail('expected UPSTREAM_ERROR');
    }
  });
});

describe('parseKmaCurrentObservationResponse — malformed resultCode is invalid, not upstream', () => {
  it.each(['', '0', '000', 'AB', ' 03 ', '03 ', '+3'])(
    'classifies malformed resultCode %o as INVALID_RESPONSE (never UPSTREAM_ERROR)',
    (resultCode) => {
      const response = { response: { header: { resultCode, resultMsg: 'X' } } };
      const result = parseKmaCurrentObservationResponse(response);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('INVALID_RESPONSE');
      }
    },
  );
});

describe('parseKmaCurrentObservationResponse — dataType must be literal "JSON"', () => {
  it.each(['XML', '', 'json', 'UNKNOWN'])(
    'classifies a success body with dataType %o as INVALID_RESPONSE',
    (dataType) => {
      const response = validSuccessResponse();
      response.response.body.dataType = dataType;
      const result = parseKmaCurrentObservationResponse(response);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('INVALID_RESPONSE');
      }
    },
  );

  it('accepts dataType "JSON"', () => {
    const result = parseKmaCurrentObservationResponse(validSuccessResponse());
    expect(result.ok).toBe(true);
  });
});

describe('parseKmaCurrentObservationResponse — pagination contradictions are invalid', () => {
  it('classifies totalCount 0 with items present as INVALID_RESPONSE', () => {
    const response = validSuccessResponse();
    response.response.body.totalCount = 0;
    const result = parseKmaCurrentObservationResponse(response);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('INVALID_RESPONSE');
    }
  });

  it('classifies item count > numOfRows as INVALID_RESPONSE', () => {
    const response = validSuccessResponse();
    response.response.body.numOfRows = 1;
    response.response.body.totalCount = 8;
    response.response.body.items.item = [validItem(), validItem()];
    const result = parseKmaCurrentObservationResponse(response);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('INVALID_RESPONSE');
    }
  });

  it('classifies item count > totalCount as INVALID_RESPONSE', () => {
    const response = validSuccessResponse();
    response.response.body.numOfRows = 100;
    response.response.body.totalCount = 1;
    response.response.body.items.item = [validItem(), validItem()];
    const result = parseKmaCurrentObservationResponse(response);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('INVALID_RESPONSE');
    }
  });

  it('accepts totalCount exceeding the page item count (defensive empty-page allowance)', () => {
    const response = validSuccessResponse();
    response.response.body.numOfRows = 1000;
    response.response.body.totalCount = 8;
    response.response.body.items.item = [];
    const result = parseKmaCurrentObservationResponse(response);
    expect(result.ok).toBe(true);
  });
});

describe('parseKmaCurrentObservationResponse — invalid response', () => {
  it('classifies a success code with a missing body as INVALID_RESPONSE', () => {
    const response = {
      response: { header: { resultCode: '00', resultMsg: 'NORMAL_SERVICE' } },
    };
    const result = parseKmaCurrentObservationResponse(response);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('INVALID_RESPONSE');
    }
  });

  it.each([null, undefined, 42, 'a string', [], {}, { response: {} }, { response: { header: {} } }])(
    'classifies a malformed envelope (%o) as INVALID_RESPONSE',
    (input) => {
      const result = parseKmaCurrentObservationResponse(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('INVALID_RESPONSE');
      }
    },
  );

  it('sanitized issues carry only path and message, never the raw offending value', () => {
    const response = validSuccessResponse();
    response.response.body.items.item = [{ ...validItem(), nx: -5 }];
    const result = parseKmaCurrentObservationResponse(response);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'INVALID_RESPONSE') {
      for (const issue of result.error.issues) {
        expect(Object.keys(issue).sort()).toEqual(['message', 'path']);
      }
      expect(JSON.stringify(result.error)).not.toContain('-5');
    } else {
      expect.fail('expected INVALID_RESPONSE');
    }
  });

  it('produces a deterministic issue order independent of Zod traversal order', () => {
    const response = validSuccessResponse();
    response.response.body.items.item = [{ ...validItem(), nx: -1, ny: -1 }];
    const first = parseKmaCurrentObservationResponse(response);
    const second = parseKmaCurrentObservationResponse(response);
    expect(first).toEqual(second);
  });
});

describe('parseKmaCurrentObservationResponse — purity', () => {
  it('does not mutate the input', () => {
    const response = validSuccessResponse();
    const before = JSON.stringify(response);
    parseKmaCurrentObservationResponse(response);
    expect(JSON.stringify(response)).toBe(before);
  });
});
