import { describe, expect, it } from 'vitest';

import {
  AIRKOREA_BASE_URL,
  AIRKOREA_CURRENT_AIR_QUALITY_OPERATION,
  buildAirKoreaCurrentAirQualityRequestUrl,
  isAirKoreaStationName,
  validateAirKoreaCurrentAirQualityRequest,
} from './current-request.js';

/** An obviously fake, synthetic decoded service key — never a real/production-shaped string. */
const FAKE_KEY = 'FAKE-AIRKOREA-SERVICE-KEY-test+/==';

describe('isAirKoreaStationName', () => {
  it('accepts a Korean station name', () => {
    expect(isAirKoreaStationName('종로구')).toBe(true);
  });

  it('accepts a station name containing an internal space', () => {
    expect(isAirKoreaStationName('강남 대로')).toBe(true);
  });

  it('rejects a non-string', () => {
    expect(isAirKoreaStationName(123)).toBe(false);
    expect(isAirKoreaStationName(null)).toBe(false);
    expect(isAirKoreaStationName(undefined)).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isAirKoreaStationName('')).toBe(false);
  });

  it('rejects leading whitespace', () => {
    expect(isAirKoreaStationName(' 종로구')).toBe(false);
  });

  it('rejects trailing whitespace', () => {
    expect(isAirKoreaStationName('종로구 ')).toBe(false);
  });

  it('rejects a name over 30 characters', () => {
    expect(isAirKoreaStationName('가'.repeat(31))).toBe(false);
  });

  it('accepts a name exactly 30 characters', () => {
    expect(isAirKoreaStationName('가'.repeat(30))).toBe(true);
  });

  it('rejects a control character', () => {
    expect(isAirKoreaStationName('종로\t구')).toBe(false);
    expect(isAirKoreaStationName('종로\n구')).toBe(false);
    expect(isAirKoreaStationName('종로\u0007구')).toBe(false);
  });
});

describe('validateAirKoreaCurrentAirQualityRequest', () => {
  it('accepts a valid request', () => {
    expect(validateAirKoreaCurrentAirQualityRequest({ stationName: '종로구' })).toEqual({
      ok: true,
    });
  });

  it('rejects a missing stationName', () => {
    const result = validateAirKoreaCurrentAirQualityRequest({});
    expect(result).toEqual({
      ok: false,
      issues: [{ field: 'stationName', reason: 'INVALID' }],
    });
  });

  it('rejects a blank stationName', () => {
    const result = validateAirKoreaCurrentAirQualityRequest({ stationName: '   ' });
    expect(result.ok).toBe(false);
  });

  it('rejects a malformed (non-string) stationName', () => {
    const result = validateAirKoreaCurrentAirQualityRequest({ stationName: 42 });
    expect(result.ok).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'nope'],
    ['a number', 42],
    ['an array', []],
    ['a function', () => undefined],
  ])('returns INVALID without throwing for runtime %s', (_label, input) => {
    let result: ReturnType<typeof validateAirKoreaCurrentAirQualityRequest>;
    expect(() => {
      result = validateAirKoreaCurrentAirQualityRequest(input);
    }).not.toThrow();
    expect(result!).toEqual({
      ok: false,
      issues: [{ field: 'stationName', reason: 'INVALID' }],
    });
  });

  it('does not mutate a frozen request object', () => {
    const request = Object.freeze({ stationName: '종로구' });
    expect(() => validateAirKoreaCurrentAirQualityRequest(request)).not.toThrow();
    expect(request).toEqual({ stationName: '종로구' });
  });

  it('returns fresh issue arrays on every call', () => {
    const a = validateAirKoreaCurrentAirQualityRequest({});
    const b = validateAirKoreaCurrentAirQualityRequest({});
    expect(a).not.toBe(b);
    if (!a.ok && !b.ok) {
      expect(a.issues).not.toBe(b.issues);
    }
  });
});

describe('buildAirKoreaCurrentAirQualityRequestUrl', () => {
  it('builds the exact official HTTPS operation URL', () => {
    const result = buildAirKoreaCurrentAirQualityRequestUrl(FAKE_KEY, {
      stationName: '종로구',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.origin + result.url.pathname).toBe(
        `${AIRKOREA_BASE_URL}/${AIRKOREA_CURRENT_AIR_QUALITY_OPERATION}`,
      );
      expect(result.url.protocol).toBe('https:');
    }
  });

  it('encodes the service key exactly once via URLSearchParams', () => {
    const specialKey = 'abc+DEF/ghi==';
    const result = buildAirKoreaCurrentAirQualityRequestUrl(specialKey, {
      stationName: '종로구',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.searchParams.get('serviceKey')).toBe(specialKey);
    }
  });

  it('encodes a Unicode Korean stationName correctly via URLSearchParams', () => {
    const result = buildAirKoreaCurrentAirQualityRequestUrl(FAKE_KEY, {
      stationName: '강남대로',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.searchParams.get('stationName')).toBe('강남대로');
    }
  });

  it('sets the fixed official request parameters', () => {
    const result = buildAirKoreaCurrentAirQualityRequestUrl(FAKE_KEY, {
      stationName: '종로구',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.searchParams.get('returnType')).toBe('json');
      expect(result.url.searchParams.get('pageNo')).toBe('1');
      expect(result.url.searchParams.get('numOfRows')).toBe('100');
      expect(result.url.searchParams.get('dataTerm')).toBe('DAILY');
      expect(result.url.searchParams.get('ver')).toBe('1.5');
    }
  });

  it('does not mutate the input request', () => {
    const request = Object.freeze({ stationName: '종로구' });
    buildAirKoreaCurrentAirQualityRequestUrl(FAKE_KEY, request);
    expect(request).toEqual({ stationName: '종로구' });
  });

  it('rejects an invalid request without building a URL', () => {
    const result = buildAirKoreaCurrentAirQualityRequestUrl(FAKE_KEY, {
      stationName: '',
    });
    expect(result.ok).toBe(false);
  });

  it('never exposes the service key in a validation-failure result', () => {
    const result = buildAirKoreaCurrentAirQualityRequestUrl(FAKE_KEY, { stationName: '' });
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
  });
});
