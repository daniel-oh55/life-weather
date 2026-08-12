import { describe, expect, it } from 'vitest';

import { parseAirKoreaTmCoordinateResponse } from './parse-tm-coordinate-response.js';

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

const REQUIRED_CONSUMED_FIELDS = ['sidoName', 'sggName', 'umdName', 'tmX', 'tmY'] as const;

function successResponse(items: unknown[]) {
  return {
    response: {
      header: { resultCode: '00', resultMsg: 'NORMAL_CODE' },
      body: {
        numOfRows: 10,
        pageNo: 1,
        totalCount: items.length,
        items: { item: items },
      },
    },
  };
}

describe('parseAirKoreaTmCoordinateResponse — success', () => {
  it('parses a valid success page', () => {
    const result = parseAirKoreaTmCoordinateResponse(successResponse([VALID_ITEM]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.page.items).toHaveLength(1);
      expect(result.page.totalCount).toBe(1);
      expect(result.page.numOfRows).toBe(10);
      expect(result.page.pageNo).toBe(1);
    }
  });

  it('parses a valid empty-list success page', () => {
    const result = parseAirKoreaTmCoordinateResponse(successResponse([]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.page.items).toEqual([]);
    }
  });
});

describe('parseAirKoreaTmCoordinateResponse — upstream error', () => {
  it('classifies a structurally valid non-success header as UPSTREAM_ERROR', () => {
    const result = parseAirKoreaTmCoordinateResponse({
      response: {
        header: { resultCode: '30', resultMsg: 'SERVICE KEY IS NOT REGISTERED ERROR.' },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ kind: 'UPSTREAM_ERROR', resultCode: '30' });
    }
  });

  it('never carries the raw resultMsg into the error', () => {
    const result = parseAirKoreaTmCoordinateResponse({
      response: {
        header: { resultCode: '22', resultMsg: 'SECRET_UPSTREAM_MESSAGE_MARKER' },
      },
    });
    expect(JSON.stringify(result)).not.toContain('SECRET_UPSTREAM_MESSAGE_MARKER');
  });
});

describe('parseAirKoreaTmCoordinateResponse — invalid response', () => {
  it('classifies a non-envelope value as INVALID_RESPONSE', () => {
    expect(parseAirKoreaTmCoordinateResponse(null).ok).toBe(false);
    expect(parseAirKoreaTmCoordinateResponse('nope').ok).toBe(false);
    expect(parseAirKoreaTmCoordinateResponse({}).ok).toBe(false);
    expect(parseAirKoreaTmCoordinateResponse([]).ok).toBe(false);
  });

  it('classifies a malformed body under a success header as INVALID_RESPONSE', () => {
    const result = parseAirKoreaTmCoordinateResponse({
      response: {
        header: { resultCode: '00', resultMsg: 'NORMAL_CODE' },
        body: { numOfRows: 10, pageNo: 1 },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('INVALID_RESPONSE');
    }
  });

  it('reports sanitized, deterministically ordered issues (path + message only)', () => {
    const result = parseAirKoreaTmCoordinateResponse({
      response: {
        header: { resultCode: '00', resultMsg: 'NORMAL_CODE' },
        body: {
          numOfRows: 10,
          pageNo: 1,
          totalCount: 1,
          items: { item: [{ sidoName: '서울특별시' }] },
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'INVALID_RESPONSE') {
      for (const issue of result.error.issues) {
        expect(Object.keys(issue).sort()).toEqual(['message', 'path']);
      }
    }
  });

  it('never carries the raw input value into an INVALID_RESPONSE error', () => {
    const result = parseAirKoreaTmCoordinateResponse({
      response: { header: { resultCode: 'SECRET_MARKER' } },
    });
    expect(JSON.stringify(result)).not.toContain('SECRET_MARKER');
  });

  it('is pure and does not mutate the input', () => {
    const input = Object.freeze(successResponse([VALID_ITEM]));
    expect(() => parseAirKoreaTmCoordinateResponse(input)).not.toThrow();
  });

  it.each(REQUIRED_CONSUMED_FIELDS)(
    'classifies a success item missing %s as INVALID_RESPONSE (officially required field)',
    (field) => {
      const result = parseAirKoreaTmCoordinateResponse(successResponse([omitKey(VALID_ITEM, field)]));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('INVALID_RESPONSE');
      }
    },
  );
});
