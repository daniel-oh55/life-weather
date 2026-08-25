import { describe, expect, it } from 'vitest';

import {
  buildKmaAlertEventRequestUrl,
  validateKmaAlertEventRequest,
  KMA_ALERT_WARNING_TYPES,
  type KmaAlertEventRequest,
  type KmaAlertRequestIssue,
  type KmaAlertWarningType,
  type ValidateKmaAlertEventRequestResult,
} from './alert-request.js';

/** An obviously fake decoded service key with the three characters that must be percent-encoded. */
const FAKE_KEY = 'test-key+with/slash==';

function validRequest(overrides: Partial<KmaAlertEventRequest> = {}): KmaAlertEventRequest {
  return {
    fromTmFc: '20260825',
    toTmFc: '20260825',
    ...overrides,
  };
}

function buildOrThrow(request: KmaAlertEventRequest, key = FAKE_KEY): URL {
  const result = buildKmaAlertEventRequestUrl(key, request);
  if (!result.ok) {
    throw new Error(`expected a URL, got issues: ${JSON.stringify(result.issues)}`);
  }
  return result.url;
}

describe('buildKmaAlertEventRequestUrl — fixed operation, host, and dedicated base path', () => {
  it('always targets getPwnCd, never a caller-chosen operation', () => {
    const url = buildOrThrow(validRequest());
    expect(url.pathname.endsWith('/getPwnCd')).toBe(true);
  });

  it('targets the HTTPS WthrWrnInfoService host — a dedicated base path, not VilageFcstInfoService_2.0', () => {
    const url = buildOrThrow(validRequest());
    expect(url.protocol).toBe('https:');
    expect(url.host).toBe('apis.data.go.kr');
    expect(url.pathname).toBe('/1360000/WthrWrnInfoService/getPwnCd');
    expect(url.pathname).not.toContain('VilageFcstInfoService_2.0');
  });
});

describe('buildKmaAlertEventRequestUrl — required query parameters', () => {
  it('uses the confirmed serviceKey casing and fixed pagination/format', () => {
    const url = buildOrThrow(validRequest());
    const params = url.searchParams;
    expect(params.get('serviceKey')).toBe(FAKE_KEY);
    expect(params.get('pageNo')).toBe('1');
    expect(params.get('numOfRows')).toBe('1000');
    expect(params.get('dataType')).toBe('JSON');
    expect(params.get('fromTmFc')).toBe('20260825');
    expect(params.get('toTmFc')).toBe('20260825');
  });

  it('uses serviceKey (lowercase), not ServiceKey or authKey', () => {
    const url = buildOrThrow(validRequest());
    expect(url.searchParams.has('serviceKey')).toBe(true);
    expect(url.searchParams.has('ServiceKey')).toBe(false);
    expect(url.searchParams.has('authKey')).toBe(false);
  });

  it('appends the required parameters in a deterministic order', () => {
    const keys = [...buildOrThrow(validRequest()).searchParams.keys()];
    expect(keys).toEqual([
      'serviceKey',
      'pageNo',
      'numOfRows',
      'dataType',
      'fromTmFc',
      'toTmFc',
    ]);
  });
});

describe('buildKmaAlertEventRequestUrl — optional filters', () => {
  it('omits areaCode/warningType/stnId entirely when absent (never sent as empty string)', () => {
    const params = buildOrThrow(validRequest()).searchParams;
    expect(params.has('areaCode')).toBe(false);
    expect(params.has('warningType')).toBe(false);
    expect(params.has('stnId')).toBe(false);
  });

  it('includes areaCode, warningType, and stnId (in that order) only when present', () => {
    const url = buildOrThrow(
      validRequest({ areaCode: 'L1010100', warningType: 3, stnId: '108' }),
    );
    const params = url.searchParams;
    expect(params.get('areaCode')).toBe('L1010100');
    expect(params.get('warningType')).toBe('3');
    expect(params.get('stnId')).toBe('108');
    expect([...params.keys()].slice(-3)).toEqual(['areaCode', 'warningType', 'stnId']);
  });

  it('never emits warninType — the guide example spelling is a documented typo', () => {
    const url = buildOrThrow(validRequest({ warningType: 5 }));
    expect(url.searchParams.has('warninType')).toBe(false);
    expect(url.href).not.toContain('warninType');
  });

  it.each(KMA_ALERT_WARNING_TYPES)('accepts official warningType %d', (warningType) => {
    const result = buildKmaAlertEventRequestUrl(FAKE_KEY, validRequest({ warningType }));
    expect(result.ok).toBe(true);
  });

  it.each([0, 10, 11, 14, -1] as const)(
    'rejects an undocumented warningType %d',
    (warningType) => {
      const result = buildKmaAlertEventRequestUrl(
        FAKE_KEY,
        validRequest({ warningType: warningType as never }),
      );
      expect(result.ok).toBe(false);
    },
  );
});

describe('buildKmaAlertEventRequestUrl — service key encoding', () => {
  it('encodes the decoded key exactly once (round-trips via searchParams)', () => {
    const url = buildOrThrow(validRequest());
    expect(url.searchParams.get('serviceKey')).toBe(FAKE_KEY);
  });

  it('percent-encodes +, / and = in the serialized URL', () => {
    const href = buildOrThrow(validRequest()).href;
    expect(href).toContain('%2B'); // +
    expect(href).toContain('%2F'); // /
    expect(href).toContain('%3D'); // =
  });

  it('does not double-encode (no stray %25 for a key without a literal %)', () => {
    const href = buildOrThrow(validRequest()).href;
    expect(href).not.toContain('%25');
  });

  it('never leaks the raw key into request issues', () => {
    const result = buildKmaAlertEventRequestUrl(FAKE_KEY, validRequest({ fromTmFc: 'bad' }));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
  });
});

describe('validateKmaAlertEventRequest — required date fields', () => {
  it('accepts a valid request with only the required fields', () => {
    expect(validateKmaAlertEventRequest(validRequest()).ok).toBe(true);
  });

  it('rejects a malformed fromTmFc', () => {
    expect(validateKmaAlertEventRequest(validRequest({ fromTmFc: '2026082' })).ok).toBe(false);
  });

  it('rejects an impossible calendar date for toTmFc', () => {
    const result = validateKmaAlertEventRequest(validRequest({ toTmFc: '20260230' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({ field: 'toTmFc', reason: 'INVALID' });
    }
  });

  it('rejects a numeric-date (no coercion)', () => {
    const result = validateKmaAlertEventRequest(
      validRequest({ fromTmFc: 20260825 as unknown as string }),
    );
    expect(result.ok).toBe(false);
  });

  it('does not require fromTmFc <= toTmFc (no official ordering evidence)', () => {
    const result = validateKmaAlertEventRequest(
      validRequest({ fromTmFc: '20260825', toTmFc: '20260101' }),
    );
    expect(result.ok).toBe(true);
  });
});

describe('validateKmaAlertEventRequest — optional filters', () => {
  it('accepts a request with all optional filters present', () => {
    const result = validateKmaAlertEventRequest(
      validRequest({ areaCode: 'L1010100', warningType: 1, stnId: '108' }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an empty-string areaCode (present but malformed, not treated as absent)', () => {
    const result = validateKmaAlertEventRequest(validRequest({ areaCode: '' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({ field: 'areaCode', reason: 'INVALID' });
    }
  });

  it('rejects an empty-string stnId', () => {
    const result = validateKmaAlertEventRequest(validRequest({ stnId: '' }));
    expect(result.ok).toBe(false);
  });

  it('rejects a warningType supplied as a numeric string (no coercion)', () => {
    const result = validateKmaAlertEventRequest(
      validRequest({ warningType: '3' as unknown as KmaAlertWarningType }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({ field: 'warningType', reason: 'INVALID' });
    }
  });

  it('rejects an explicit null for an optional field (not the same as undefined)', () => {
    const result = validateKmaAlertEventRequest({
      ...validRequest(),
      areaCode: null as unknown as string,
    });
    expect(result.ok).toBe(false);
  });

  it('collects every problem in fixed field order', () => {
    const result = validateKmaAlertEventRequest({
      fromTmFc: 'bad',
      toTmFc: 'bad',
      areaCode: '',
      warningType: 99,
      stnId: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.field)).toEqual([
        'fromTmFc',
        'toTmFc',
        'areaCode',
        'warningType',
        'stnId',
      ]);
    }
  });
});

describe('validateKmaAlertEventRequest — runtime totality on non-object input', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'not-a-request'],
    ['a number', 42],
    ['a boolean', true],
    ['an array', []],
    ['a function', () => undefined],
  ])('flags all five fields INVALID (never throws) for %s', (_label, input) => {
    let result: ValidateKmaAlertEventRequestResult;
    expect(() => {
      result = validateKmaAlertEventRequest(input);
    }).not.toThrow();
    expect(result!.ok).toBe(false);
    if (!result!.ok) {
      expect(result!.issues.map((issue) => issue.field)).toEqual([
        'fromTmFc',
        'toTmFc',
        'areaCode',
        'warningType',
        'stnId',
      ]);
      for (const issue of result!.issues) {
        expect(issue.reason).toBe('INVALID');
      }
    }
  });

  it('does not expose the raw non-object input', () => {
    const secret = 'SECRET_ALERT_REQUEST_INPUT_MARKER';
    const result = validateKmaAlertEventRequest(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe('validateKmaAlertEventRequest — issue state isolation', () => {
  it('returns a distinct array and distinct issue objects on each call', () => {
    const first = validateKmaAlertEventRequest(null);
    const second = validateKmaAlertEventRequest(undefined);
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    if (!first.ok && !second.ok) {
      expect(first.issues).not.toBe(second.issues);
      for (let i = 0; i < first.issues.length; i += 1) {
        expect(first.issues[i]).not.toBe(second.issues[i]);
      }
    }
  });

  it('does not let mutating a first result corrupt a later call', () => {
    const first = validateKmaAlertEventRequest(null);
    expect(first.ok).toBe(false);
    if (!first.ok) {
      (first.issues as KmaAlertRequestIssue[]).pop();
      const firstIssue = first.issues[0]!;
      (firstIssue as { field: string }).field = 'MUTATED';
    }

    const second = validateKmaAlertEventRequest(undefined);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.issues.map((issue) => issue.field)).toEqual([
        'fromTmFc',
        'toTmFc',
        'areaCode',
        'warningType',
        'stnId',
      ]);
    }
  });
});
