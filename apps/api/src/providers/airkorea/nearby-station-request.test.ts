import { describe, expect, it } from 'vitest';

import {
  AIRKOREA_NEARBY_STATION_BASE_URL,
  AIRKOREA_NEARBY_STATION_OPERATION,
  buildAirKoreaNearbyStationRequestUrl,
  isAirKoreaTmCoordinate,
  validateAirKoreaNearbyStationRequest,
} from './nearby-station-request.js';

/** An obviously fake, synthetic decoded service key — never a real/production-shaped string. */
const FAKE_KEY = 'FAKE-AIRKOREA-SERVICE-KEY-test+/==';

/** The technical document's own request example TM coordinates (§ d, 요청/응답 메시지 예제). */
const SAMPLE_TM_X = 244148.546388;
const SAMPLE_TM_Y = 412423.75772;

describe('isAirKoreaTmCoordinate', () => {
  it('accepts a typical TM coordinate', () => {
    expect(isAirKoreaTmCoordinate(SAMPLE_TM_X)).toBe(true);
    expect(isAirKoreaTmCoordinate(SAMPLE_TM_Y)).toBe(true);
  });

  it('accepts zero and negative coordinates', () => {
    expect(isAirKoreaTmCoordinate(0)).toBe(true);
    expect(isAirKoreaTmCoordinate(-1000.5)).toBe(true);
  });

  it('rejects a non-number', () => {
    expect(isAirKoreaTmCoordinate('244148.546388')).toBe(false);
    expect(isAirKoreaTmCoordinate(null)).toBe(false);
    expect(isAirKoreaTmCoordinate(undefined)).toBe(false);
  });

  it('rejects NaN', () => {
    expect(isAirKoreaTmCoordinate(Number.NaN)).toBe(false);
  });

  it('rejects Infinity and -Infinity', () => {
    expect(isAirKoreaTmCoordinate(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isAirKoreaTmCoordinate(Number.NEGATIVE_INFINITY)).toBe(false);
  });

  it('rejects a magnitude that would serialize as exponential notation', () => {
    expect(isAirKoreaTmCoordinate(1e21)).toBe(false);
    expect(isAirKoreaTmCoordinate(1e-8)).toBe(false);
  });
});

describe('validateAirKoreaNearbyStationRequest', () => {
  it('accepts a valid request', () => {
    expect(
      validateAirKoreaNearbyStationRequest({ tmX: SAMPLE_TM_X, tmY: SAMPLE_TM_Y }),
    ).toEqual({ ok: true });
  });

  it('rejects a missing tmX and tmY', () => {
    const result = validateAirKoreaNearbyStationRequest({});
    expect(result).toEqual({
      ok: false,
      issues: [
        { field: 'tmX', reason: 'INVALID' },
        { field: 'tmY', reason: 'INVALID' },
      ],
    });
  });

  it('rejects a malformed (non-number) tmX', () => {
    const result = validateAirKoreaNearbyStationRequest({ tmX: '244148', tmY: SAMPLE_TM_Y });
    expect(result).toEqual({ ok: false, issues: [{ field: 'tmX', reason: 'INVALID' }] });
  });

  it('rejects a malformed (non-number) tmY', () => {
    const result = validateAirKoreaNearbyStationRequest({ tmX: SAMPLE_TM_X, tmY: '412423' });
    expect(result).toEqual({ ok: false, issues: [{ field: 'tmY', reason: 'INVALID' }] });
  });

  it('rejects a non-finite tmX', () => {
    const result = validateAirKoreaNearbyStationRequest({
      tmX: Number.NaN,
      tmY: SAMPLE_TM_Y,
    });
    expect(result).toEqual({ ok: false, issues: [{ field: 'tmX', reason: 'INVALID' }] });
  });

  it('rejects a non-finite tmY', () => {
    const result = validateAirKoreaNearbyStationRequest({
      tmX: SAMPLE_TM_X,
      tmY: Number.POSITIVE_INFINITY,
    });
    expect(result).toEqual({ ok: false, issues: [{ field: 'tmY', reason: 'INVALID' }] });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'nope'],
    ['a number', 42],
    ['an array', []],
    ['a function', () => undefined],
  ])('returns INVALID for both fields without throwing for runtime %s', (_label, input) => {
    let result: ReturnType<typeof validateAirKoreaNearbyStationRequest>;
    expect(() => {
      result = validateAirKoreaNearbyStationRequest(input);
    }).not.toThrow();
    expect(result!).toEqual({
      ok: false,
      issues: [
        { field: 'tmX', reason: 'INVALID' },
        { field: 'tmY', reason: 'INVALID' },
      ],
    });
  });

  it('does not mutate a frozen request object', () => {
    const request = Object.freeze({ tmX: SAMPLE_TM_X, tmY: SAMPLE_TM_Y });
    expect(() => validateAirKoreaNearbyStationRequest(request)).not.toThrow();
    expect(request).toEqual({ tmX: SAMPLE_TM_X, tmY: SAMPLE_TM_Y });
  });

  it('returns fresh issue arrays on every call', () => {
    const a = validateAirKoreaNearbyStationRequest({});
    const b = validateAirKoreaNearbyStationRequest({});
    expect(a).not.toBe(b);
    if (!a.ok && !b.ok) {
      expect(a.issues).not.toBe(b.issues);
    }
  });
});

describe('buildAirKoreaNearbyStationRequestUrl', () => {
  it('builds the exact official HTTPS operation URL', () => {
    const result = buildAirKoreaNearbyStationRequestUrl(FAKE_KEY, {
      tmX: SAMPLE_TM_X,
      tmY: SAMPLE_TM_Y,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.origin + result.url.pathname).toBe(
        `${AIRKOREA_NEARBY_STATION_BASE_URL}/${AIRKOREA_NEARBY_STATION_OPERATION}`,
      );
      expect(result.url.protocol).toBe('https:');
    }
  });

  it('encodes the service key exactly once via URLSearchParams', () => {
    const specialKey = 'abc+DEF/ghi==';
    const result = buildAirKoreaNearbyStationRequestUrl(specialKey, {
      tmX: SAMPLE_TM_X,
      tmY: SAMPLE_TM_Y,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.searchParams.get('serviceKey')).toBe(specialKey);
      expect(result.url.toString().indexOf('abc%2BDEF')).toBe(
        result.url.toString().lastIndexOf('abc%2BDEF'),
      );
    }
  });

  it('sets tmX and tmY to the exact decimal representation of the request coordinates', () => {
    const result = buildAirKoreaNearbyStationRequestUrl(FAKE_KEY, {
      tmX: SAMPLE_TM_X,
      tmY: SAMPLE_TM_Y,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.searchParams.get('tmX')).toBe(String(SAMPLE_TM_X));
      expect(result.url.searchParams.get('tmY')).toBe(String(SAMPLE_TM_Y));
    }
  });

  it('sets the fixed official request parameters and no others', () => {
    const result = buildAirKoreaNearbyStationRequestUrl(FAKE_KEY, {
      tmX: SAMPLE_TM_X,
      tmY: SAMPLE_TM_Y,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.searchParams.get('returnType')).toBe('json');
      expect([...result.url.searchParams.keys()].sort()).toEqual(
        ['returnType', 'serviceKey', 'tmX', 'tmY'].sort(),
      );
      expect(result.url.searchParams.has('ver')).toBe(false);
      expect(result.url.searchParams.has('pageNo')).toBe(false);
      expect(result.url.searchParams.has('numOfRows')).toBe(false);
      expect(result.url.searchParams.has('dataTerm')).toBe(false);
      expect(result.url.searchParams.has('stationName')).toBe(false);
    }
  });

  it('does not mutate the input request', () => {
    const request = Object.freeze({ tmX: SAMPLE_TM_X, tmY: SAMPLE_TM_Y });
    buildAirKoreaNearbyStationRequestUrl(FAKE_KEY, request);
    expect(request).toEqual({ tmX: SAMPLE_TM_X, tmY: SAMPLE_TM_Y });
  });

  it('rejects an invalid request without building a URL', () => {
    const result = buildAirKoreaNearbyStationRequestUrl(FAKE_KEY, {
      tmX: Number.NaN,
      tmY: SAMPLE_TM_Y,
    });
    expect(result.ok).toBe(false);
  });

  it('never exposes the service key in a validation-failure result', () => {
    const result = buildAirKoreaNearbyStationRequestUrl(FAKE_KEY, {
      tmX: Number.NaN,
      tmY: SAMPLE_TM_Y,
    });
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
  });
});
