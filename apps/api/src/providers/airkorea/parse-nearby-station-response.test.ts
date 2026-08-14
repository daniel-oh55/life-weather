import { describe, expect, it } from 'vitest';

import { parseAirKoreaNearbyStationResponse } from './parse-nearby-station-response.js';

/** 2026-08-13 Owner-observed live JSON evidence: `tm` is a JSON number. */
const VALID_ITEM = {
  tm: 8.2,
  stationName: '부발읍',
  addr: '경기도 이천시 부발읍 무촌로 117부발보건지소 옥상',
};

/** Return a shallow clone of `obj` with `key` deleted — works around TS's optional-only `delete`. */
function omitKey(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...obj };
  delete clone[key];
  return clone;
}

const REQUIRED_CONSUMED_FIELDS = ['tm', 'stationName'] as const;

function successResponse(items: unknown[]) {
  return {
    response: {
      header: { resultCode: '00', resultMsg: 'NORMAL_CODE' },
      body: {
        numOfRows: 10,
        pageNo: 1,
        totalCount: items.length,
        items,
      },
    },
  };
}

describe('parseAirKoreaNearbyStationResponse — success', () => {
  it('parses a valid success page', () => {
    const result = parseAirKoreaNearbyStationResponse(successResponse([VALID_ITEM]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.page.items).toHaveLength(1);
      expect(result.page.totalCount).toBe(1);
      expect(result.page.numOfRows).toBe(10);
      expect(result.page.pageNo).toBe(1);
    }
  });

  it('parses a valid empty-list success page', () => {
    const result = parseAirKoreaNearbyStationResponse(successResponse([]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.page.items).toEqual([]);
    }
  });

  it('rejects the old { item: [...] } wrapper shape as INVALID_RESPONSE (2026-08-13 live evidence: body.items is a direct array)', () => {
    const result = parseAirKoreaNearbyStationResponse({
      response: {
        header: { resultCode: '00', resultMsg: 'NORMAL_CODE' },
        body: { numOfRows: 10, pageNo: 1, totalCount: 1, items: { item: [VALID_ITEM] } },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('INVALID_RESPONSE');
    }
  });
});

describe('parseAirKoreaNearbyStationResponse — upstream error', () => {
  it('classifies a structurally valid non-success header as UPSTREAM_ERROR', () => {
    const result = parseAirKoreaNearbyStationResponse({
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
    const result = parseAirKoreaNearbyStationResponse({
      response: {
        header: { resultCode: '22', resultMsg: 'SECRET_UPSTREAM_MESSAGE_MARKER' },
      },
    });
    expect(JSON.stringify(result)).not.toContain('SECRET_UPSTREAM_MESSAGE_MARKER');
  });
});

describe('parseAirKoreaNearbyStationResponse — invalid response', () => {
  it('classifies a non-envelope value as INVALID_RESPONSE', () => {
    expect(parseAirKoreaNearbyStationResponse(null).ok).toBe(false);
    expect(parseAirKoreaNearbyStationResponse('nope').ok).toBe(false);
    expect(parseAirKoreaNearbyStationResponse({}).ok).toBe(false);
    expect(parseAirKoreaNearbyStationResponse([]).ok).toBe(false);
  });

  it('classifies a malformed body under a success header as INVALID_RESPONSE', () => {
    const result = parseAirKoreaNearbyStationResponse({
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
    const result = parseAirKoreaNearbyStationResponse({
      response: {
        header: { resultCode: '00', resultMsg: 'NORMAL_CODE' },
        body: {
          numOfRows: 10,
          pageNo: 1,
          totalCount: 1,
          items: [{ tm: 8.2 }],
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
    const result = parseAirKoreaNearbyStationResponse({
      response: { header: { resultCode: 'SECRET_MARKER' } },
    });
    expect(JSON.stringify(result)).not.toContain('SECRET_MARKER');
  });

  it('is pure and does not mutate the input', () => {
    const input = Object.freeze(successResponse([VALID_ITEM]));
    expect(() => parseAirKoreaNearbyStationResponse(input)).not.toThrow();
  });

  it.each(REQUIRED_CONSUMED_FIELDS)(
    'classifies a success item missing %s as INVALID_RESPONSE (officially required field)',
    (field) => {
      const result = parseAirKoreaNearbyStationResponse(
        successResponse([omitKey(VALID_ITEM, field)]),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('INVALID_RESPONSE');
      }
    },
  );

  it('accepts a success item missing addr (undeclared, unconsumed field)', () => {
    const item = omitKey(VALID_ITEM, 'addr');
    const result = parseAirKoreaNearbyStationResponse(successResponse([item]));
    expect(result.ok).toBe(true);
  });
});
