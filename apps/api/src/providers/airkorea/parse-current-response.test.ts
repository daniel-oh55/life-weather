import { describe, expect, it } from 'vitest';

import { parseAirKoreaCurrentAirQualityResponse } from './parse-current-response.js';

const VALID_ITEM = {
  dataTime: '2020-11-25 13:00',
  stationName: '종로구',
  pm10Value: '73',
  pm25Value: '44',
  o3Value: '0.043',
  khaiValue: '75',
  khaiGrade: '2',
  pm10Grade: '2',
  pm25Grade: '2',
  o3Grade: '2',
};

/** Return a shallow clone of `obj` with `key` deleted — works around TS's optional-only `delete`. */
function omitKey(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...obj };
  delete clone[key];
  return clone;
}

const REQUIRED_CONSUMED_FIELDS = [
  'pm10Value',
  'o3Value',
  'khaiValue',
  'khaiGrade',
  'pm10Grade',
  'o3Grade',
] as const;

function successResponse(items: unknown[]) {
  return {
    response: {
      header: { resultCode: '00', resultMsg: 'NORMAL_CODE' },
      body: {
        numOfRows: 100,
        pageNo: 1,
        totalCount: items.length,
        items: { item: items },
      },
    },
  };
}

describe('parseAirKoreaCurrentAirQualityResponse — success', () => {
  it('parses a valid success page', () => {
    const result = parseAirKoreaCurrentAirQualityResponse(successResponse([VALID_ITEM]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.page.items).toHaveLength(1);
      expect(result.page.totalCount).toBe(1);
      expect(result.page.numOfRows).toBe(100);
      expect(result.page.pageNo).toBe(1);
    }
  });

  it('parses a valid empty-list success page', () => {
    const result = parseAirKoreaCurrentAirQualityResponse(successResponse([]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.page.items).toEqual([]);
    }
  });
});

describe('parseAirKoreaCurrentAirQualityResponse — upstream error', () => {
  it('classifies a structurally valid non-success header as UPSTREAM_ERROR', () => {
    const result = parseAirKoreaCurrentAirQualityResponse({
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
    const result = parseAirKoreaCurrentAirQualityResponse({
      response: {
        header: { resultCode: '22', resultMsg: 'SECRET_UPSTREAM_MESSAGE_MARKER' },
      },
    });
    expect(JSON.stringify(result)).not.toContain('SECRET_UPSTREAM_MESSAGE_MARKER');
  });
});

describe('parseAirKoreaCurrentAirQualityResponse — invalid response', () => {
  it('classifies a non-envelope value as INVALID_RESPONSE', () => {
    expect(parseAirKoreaCurrentAirQualityResponse(null).ok).toBe(false);
    expect(parseAirKoreaCurrentAirQualityResponse('nope').ok).toBe(false);
    expect(parseAirKoreaCurrentAirQualityResponse({}).ok).toBe(false);
    expect(parseAirKoreaCurrentAirQualityResponse([]).ok).toBe(false);
  });

  it('classifies a malformed body under a success header as INVALID_RESPONSE', () => {
    const result = parseAirKoreaCurrentAirQualityResponse({
      response: {
        header: { resultCode: '00', resultMsg: 'NORMAL_CODE' },
        body: { numOfRows: 100, pageNo: 1 },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('INVALID_RESPONSE');
    }
  });

  it('reports sanitized, deterministically ordered issues (path + message only)', () => {
    const result = parseAirKoreaCurrentAirQualityResponse({
      response: {
        header: { resultCode: '00', resultMsg: 'NORMAL_CODE' },
        body: {
          numOfRows: 100,
          pageNo: 1,
          totalCount: 1,
          items: { item: [{ dataTime: 'bad', stationName: '종로구' }] },
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
    const result = parseAirKoreaCurrentAirQualityResponse({
      response: { header: { resultCode: 'SECRET_MARKER' } },
    });
    expect(JSON.stringify(result)).not.toContain('SECRET_MARKER');
  });

  it('is pure and does not mutate the input', () => {
    const input = Object.freeze(successResponse([VALID_ITEM]));
    expect(() => parseAirKoreaCurrentAirQualityResponse(input)).not.toThrow();
  });

  it.each(REQUIRED_CONSUMED_FIELDS)(
    'classifies a success item missing %s as INVALID_RESPONSE (officially required field)',
    (field) => {
      const result = parseAirKoreaCurrentAirQualityResponse(
        successResponse([omitKey(VALID_ITEM, field)]),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('INVALID_RESPONSE');
      }
    },
  );

  it('accepts a success item missing pm25Value and pm25Grade (documented optional fields)', () => {
    const item = omitKey(omitKey(VALID_ITEM, 'pm25Value'), 'pm25Grade');
    const result = parseAirKoreaCurrentAirQualityResponse(successResponse([item]));
    expect(result.ok).toBe(true);
  });
});
