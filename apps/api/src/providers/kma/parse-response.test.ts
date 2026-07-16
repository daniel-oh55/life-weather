import { describe, expect, it } from 'vitest';

import { parseKmaForecastResponse } from './parse-response';

function validItem() {
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

function validSuccessResponse() {
  return {
    response: {
      header: { resultCode: '00', resultMsg: 'NORMAL_SERVICE' },
      body: {
        dataType: 'JSON',
        pageNo: 1,
        numOfRows: 12,
        totalCount: 809,
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

describe('parseKmaForecastResponse — success', () => {
  it('returns ok:true with the validated page for a normal success response', () => {
    const result = parseKmaForecastResponse(validSuccessResponse());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.page.dataType).toBe('JSON');
      expect(result.page.pageNo).toBe(1);
      expect(result.page.numOfRows).toBe(12);
      expect(result.page.totalCount).toBe(809);
      expect(result.page.items).toHaveLength(1);
      expect(result.page.items[0].category).toBe('TMP');
      expect(result.page.items[0].fcstValue).toBe('-2');
    }
  });

  it('accepts a success response with an empty item array', () => {
    const response = validSuccessResponse();
    response.response.body.items.item = [];
    response.response.body.totalCount = 0;
    const result = parseKmaForecastResponse(response);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.page.items).toHaveLength(0);
    }
  });
});

describe('parseKmaForecastResponse — upstream error', () => {
  it('classifies NODATA_ERROR (03) as UPSTREAM_ERROR, preserving code and message', () => {
    const response = {
      response: { header: { resultCode: '03', resultMsg: 'NO_DATA' } },
    };
    const result = parseKmaForecastResponse(response);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'UPSTREAM_ERROR') {
      expect(result.error.resultCode).toBe('03');
      expect(result.error.resultMessage).toBe('NO_DATA');
    } else {
      expect.fail('expected UPSTREAM_ERROR');
    }
  });

  it('classifies a non-success header with no body as UPSTREAM_ERROR', () => {
    const response = {
      response: {
        header: { resultCode: '30', resultMsg: 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR' },
      },
    };
    const result = parseKmaForecastResponse(response);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('UPSTREAM_ERROR');
    }
  });

  it('does not restrict the set of upstream error codes', () => {
    const response = {
      response: { header: { resultCode: '99', resultMsg: 'UNKNOWN_ERROR' } },
    };
    const result = parseKmaForecastResponse(response);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'UPSTREAM_ERROR') {
      expect(result.error.resultCode).toBe('99');
    } else {
      expect.fail('expected UPSTREAM_ERROR');
    }
  });
});

describe('parseKmaForecastResponse — invalid response', () => {
  it('classifies a success code with a missing body as INVALID_RESPONSE', () => {
    const response = {
      response: { header: { resultCode: '00', resultMsg: 'NORMAL_SERVICE' } },
    };
    const result = parseKmaForecastResponse(response);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('INVALID_RESPONSE');
    }
  });

  it.each([null, undefined, 42, 'a string', [], {}, { response: {} }, { response: { header: {} } }])(
    'classifies a malformed envelope (%o) as INVALID_RESPONSE',
    (input) => {
      const result = parseKmaForecastResponse(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('INVALID_RESPONSE');
      }
    },
  );

  it('produces sanitized issues with a path and message but no raw values', () => {
    const response = {
      response: {
        header: { resultCode: '00', resultMsg: 'NORMAL_SERVICE' },
        body: {
          dataType: 'JSON',
          pageNo: 1,
          numOfRows: 12,
          totalCount: 809,
          items: { item: [{ ...validItem(), nx: 'RAW_UNTRUSTED_VALUE_9f3c' }] },
        },
      },
    };
    const result = parseKmaForecastResponse(response);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'INVALID_RESPONSE') {
      expect(result.error.issues.length).toBeGreaterThan(0);
      for (const issue of result.error.issues) {
        expect(Array.isArray(issue.path)).toBe(true);
        expect(typeof issue.message).toBe('string');
      }
      // The offending raw value never leaks into the sanitized issues.
      expect(JSON.stringify(result.error.issues)).not.toContain('RAW_UNTRUSTED_VALUE_9f3c');
    } else {
      expect.fail('expected INVALID_RESPONSE');
    }
  });

  it('does not leak a service-key-shaped raw value into issues', () => {
    const serviceKeyLike = 'aBcD1234EfGh5678%2BFakeServiceKeyValue%3D%3D';
    const response = {
      response: {
        header: { resultCode: '00', resultMsg: 'NORMAL_SERVICE' },
        body: {
          dataType: 'JSON',
          pageNo: serviceKeyLike,
          numOfRows: 12,
          totalCount: 809,
          items: { item: [validItem()] },
        },
      },
    };
    const result = parseKmaForecastResponse(response);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'INVALID_RESPONSE') {
      expect(JSON.stringify(result.error.issues)).not.toContain(serviceKeyLike);
    } else {
      expect.fail('expected INVALID_RESPONSE');
    }
  });

  it('orders issues deterministically', () => {
    const bad = {
      response: {
        header: { resultCode: '00', resultMsg: 'NORMAL_SERVICE' },
        body: {
          dataType: 'JSON',
          pageNo: 'x',
          numOfRows: 'y',
          totalCount: -1,
          items: { item: [{ ...validItem(), nx: 'z', category: '' }] },
        },
      },
    };
    const first = parseKmaForecastResponse(bad);
    const second = parseKmaForecastResponse(bad);
    expect(first).toEqual(second);
    if (!first.ok && first.error.kind === 'INVALID_RESPONSE') {
      expect(first.error.issues.length).toBeGreaterThan(1);
      // The issues are already emitted in sorted (path, then message) order.
      const resorted = [...first.error.issues].sort((a, b) => {
        const pathA = a.path.join('');
        const pathB = b.path.join('');
        if (pathA !== pathB) {
          return pathA < pathB ? -1 : 1;
        }
        if (a.message !== b.message) {
          return a.message < b.message ? -1 : 1;
        }
        return 0;
      });
      expect(first.error.issues).toEqual(resorted);
    } else {
      expect.fail('expected INVALID_RESPONSE');
    }
  });
});

describe('parseKmaForecastResponse — purity', () => {
  it('never throws, whatever the input', () => {
    const inputs: unknown[] = [null, undefined, 0, '', [], {}, { response: 1 }, Symbol('x')];
    for (const input of inputs) {
      expect(() => parseKmaForecastResponse(input)).not.toThrow();
    }
  });

  it('does not mutate its input', () => {
    const response = validSuccessResponse();
    const snapshot = structuredClone(response);
    deepFreeze(response);
    expect(() => parseKmaForecastResponse(response)).not.toThrow();
    expect(response).toEqual(snapshot);
  });

  it('is deterministic for a success response', () => {
    const response = validSuccessResponse();
    expect(parseKmaForecastResponse(response)).toEqual(parseKmaForecastResponse(response));
  });
});
