import { describe, expect, it } from 'vitest';

import {
  AIRKOREA_FIXED_NUM_OF_ROWS,
  AIRKOREA_FIXED_PAGE_NO,
  AIRKOREA_TM_COORDINATE_BASE_URL,
  AIRKOREA_TM_COORDINATE_OPERATION,
  buildAirKoreaTmCoordinateRequestUrl,
  isAirKoreaAdministrativeDongName,
  validateAirKoreaTmCoordinateRequest,
} from './tm-coordinate-request.js';

/** An obviously fake, synthetic decoded service key — never a real/production-shaped string. */
const FAKE_KEY = 'FAKE-AIRKOREA-SERVICE-KEY-test+/==';

/** The technical document's own request example umd name (§ d, 요청/응답 메시지 예제). */
const SAMPLE_UMD_NAME = '혜화동';

describe('isAirKoreaAdministrativeDongName', () => {
  it('accepts a typical Korean 읍면동 name', () => {
    expect(isAirKoreaAdministrativeDongName(SAMPLE_UMD_NAME)).toBe(true);
  });

  it('accepts a name at exactly the documented 60-character boundary', () => {
    expect(isAirKoreaAdministrativeDongName('가'.repeat(60))).toBe(true);
  });

  it('rejects a name over the documented 60-character boundary', () => {
    expect(isAirKoreaAdministrativeDongName('가'.repeat(61))).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isAirKoreaAdministrativeDongName('')).toBe(false);
  });

  it('rejects a non-string', () => {
    expect(isAirKoreaAdministrativeDongName(42)).toBe(false);
    expect(isAirKoreaAdministrativeDongName(null)).toBe(false);
    expect(isAirKoreaAdministrativeDongName(undefined)).toBe(false);
    expect(isAirKoreaAdministrativeDongName({})).toBe(false);
  });

  it('rejects leading whitespace (never silently trimmed)', () => {
    expect(isAirKoreaAdministrativeDongName(` ${SAMPLE_UMD_NAME}`)).toBe(false);
  });

  it('rejects trailing whitespace (never silently trimmed)', () => {
    expect(isAirKoreaAdministrativeDongName(`${SAMPLE_UMD_NAME} `)).toBe(false);
  });

  it('rejects C0 control characters', () => {
    expect(isAirKoreaAdministrativeDongName(SAMPLE_UMD_NAME + String.fromCharCode(0x00))).toBe(false);
    expect(isAirKoreaAdministrativeDongName(String.fromCharCode(0x01) + SAMPLE_UMD_NAME)).toBe(false);
  });

  it('rejects DEL', () => {
    expect(isAirKoreaAdministrativeDongName(SAMPLE_UMD_NAME + String.fromCharCode(0x7f))).toBe(false);
  });
});

describe('validateAirKoreaTmCoordinateRequest', () => {
  it('accepts a valid request', () => {
    expect(validateAirKoreaTmCoordinateRequest({ umdName: SAMPLE_UMD_NAME })).toEqual({ ok: true });
  });

  it('rejects a missing umdName', () => {
    const result = validateAirKoreaTmCoordinateRequest({});
    expect(result).toEqual({ ok: false, issues: [{ field: 'umdName', reason: 'INVALID' }] });
  });

  it('rejects an empty umdName', () => {
    const result = validateAirKoreaTmCoordinateRequest({ umdName: '' });
    expect(result).toEqual({ ok: false, issues: [{ field: 'umdName', reason: 'INVALID' }] });
  });

  it('rejects a non-string umdName', () => {
    const result = validateAirKoreaTmCoordinateRequest({ umdName: 12345 });
    expect(result).toEqual({ ok: false, issues: [{ field: 'umdName', reason: 'INVALID' }] });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'nope'],
    ['a number', 42],
    ['an array', []],
    ['a function', () => undefined],
  ])('returns INVALID for umdName without throwing for runtime %s', (_label, input) => {
    let result: ReturnType<typeof validateAirKoreaTmCoordinateRequest>;
    expect(() => {
      result = validateAirKoreaTmCoordinateRequest(input);
    }).not.toThrow();
    expect(result!).toEqual({ ok: false, issues: [{ field: 'umdName', reason: 'INVALID' }] });
  });

  it('does not mutate a frozen request object', () => {
    const request = Object.freeze({ umdName: SAMPLE_UMD_NAME });
    expect(() => validateAirKoreaTmCoordinateRequest(request)).not.toThrow();
    expect(request).toEqual({ umdName: SAMPLE_UMD_NAME });
  });

  it('returns fresh issue arrays on every call', () => {
    const a = validateAirKoreaTmCoordinateRequest({});
    const b = validateAirKoreaTmCoordinateRequest({});
    expect(a).not.toBe(b);
    if (!a.ok && !b.ok) {
      expect(a.issues).not.toBe(b.issues);
    }
  });
});

describe('buildAirKoreaTmCoordinateRequestUrl', () => {
  it('builds the exact official HTTPS operation URL', () => {
    const result = buildAirKoreaTmCoordinateRequestUrl(FAKE_KEY, { umdName: SAMPLE_UMD_NAME });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.origin + result.url.pathname).toBe(
        `${AIRKOREA_TM_COORDINATE_BASE_URL}/${AIRKOREA_TM_COORDINATE_OPERATION}`,
      );
      expect(result.url.protocol).toBe('https:');
    }
  });

  it('encodes the service key exactly once via URLSearchParams', () => {
    const specialKey = 'abc+DEF/ghi==';
    const result = buildAirKoreaTmCoordinateRequestUrl(specialKey, { umdName: SAMPLE_UMD_NAME });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.searchParams.get('serviceKey')).toBe(specialKey);
      expect(result.url.toString().indexOf('abc%2BDEF')).toBe(
        result.url.toString().lastIndexOf('abc%2BDEF'),
      );
    }
  });

  it('encodes a Korean umdName exactly once via URLSearchParams', () => {
    const result = buildAirKoreaTmCoordinateRequestUrl(FAKE_KEY, { umdName: SAMPLE_UMD_NAME });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.searchParams.get('umdName')).toBe(SAMPLE_UMD_NAME);
    }
  });

  it('sets the fixed official request parameters and no others', () => {
    const result = buildAirKoreaTmCoordinateRequestUrl(FAKE_KEY, { umdName: SAMPLE_UMD_NAME });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.searchParams.get('returnType')).toBe('json');
      expect(result.url.searchParams.get('pageNo')).toBe(String(AIRKOREA_FIXED_PAGE_NO));
      expect(result.url.searchParams.get('numOfRows')).toBe(String(AIRKOREA_FIXED_NUM_OF_ROWS));
      expect([...result.url.searchParams.keys()].sort()).toEqual(
        ['numOfRows', 'pageNo', 'returnType', 'serviceKey', 'umdName'].sort(),
      );
      expect(result.url.searchParams.has('ver')).toBe(false);
      expect(result.url.searchParams.has('dataTerm')).toBe(false);
      expect(result.url.searchParams.has('stationName')).toBe(false);
      expect(result.url.searchParams.has('tmX')).toBe(false);
      expect(result.url.searchParams.has('tmY')).toBe(false);
    }
  });

  it('does not mutate the input request', () => {
    const request = Object.freeze({ umdName: SAMPLE_UMD_NAME });
    buildAirKoreaTmCoordinateRequestUrl(FAKE_KEY, request);
    expect(request).toEqual({ umdName: SAMPLE_UMD_NAME });
  });

  it('rejects an invalid request without building a URL', () => {
    const result = buildAirKoreaTmCoordinateRequestUrl(FAKE_KEY, { umdName: '' });
    expect(result.ok).toBe(false);
  });

  it('never exposes the service key in a validation-failure result', () => {
    const result = buildAirKoreaTmCoordinateRequestUrl(FAKE_KEY, { umdName: '' });
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
  });
});
