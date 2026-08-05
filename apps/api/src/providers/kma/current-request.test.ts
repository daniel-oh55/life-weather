import { describe, expect, it } from 'vitest';

import {
  buildKmaCurrentObservationRequestUrl,
  validateKmaCurrentObservationRequest,
  type KmaCurrentObservationRequest,
  type KmaCurrentRequestIssue,
  type ValidateKmaCurrentObservationRequestResult,
} from './current-request.js';

/** An obviously fake decoded service key with the three characters that must be percent-encoded. */
const FAKE_KEY = 'test-key+with/slash==';

function validRequest(
  overrides: Partial<KmaCurrentObservationRequest> = {},
): KmaCurrentObservationRequest {
  return {
    baseDate: '20260716',
    baseTime: '0500',
    nx: 60,
    ny: 127,
    ...overrides,
  };
}

function buildOrThrow(request: KmaCurrentObservationRequest, key = FAKE_KEY): URL {
  const result = buildKmaCurrentObservationRequestUrl(key, request);
  if (!result.ok) {
    throw new Error(`expected a URL, got issues: ${JSON.stringify(result.issues)}`);
  }
  return result.url;
}

describe('buildKmaCurrentObservationRequestUrl — fixed operation and host', () => {
  it('always targets getUltraSrtNcst, never a caller-chosen operation', () => {
    const url = buildOrThrow(validRequest());
    expect(url.pathname.endsWith('/getUltraSrtNcst')).toBe(true);
  });

  it('targets the HTTPS VilageFcstInfoService_2.0 host', () => {
    const url = buildOrThrow(validRequest());
    expect(url.protocol).toBe('https:');
    expect(url.host).toBe('apis.data.go.kr');
    expect(url.pathname.startsWith('/1360000/VilageFcstInfoService_2.0/')).toBe(true);
  });
});

describe('buildKmaCurrentObservationRequestUrl — query parameters', () => {
  it('uses the exact official parameter names, casing, and fixed values', () => {
    const url = buildOrThrow(validRequest());
    const params = url.searchParams;
    expect(params.get('ServiceKey')).toBe(FAKE_KEY);
    expect(params.get('pageNo')).toBe('1');
    expect(params.get('numOfRows')).toBe('1000');
    expect(params.get('dataType')).toBe('JSON');
    expect(params.get('base_date')).toBe('20260716');
    expect(params.get('base_time')).toBe('0500');
    expect(params.get('nx')).toBe('60');
    expect(params.get('ny')).toBe('127');
  });

  it('uses ServiceKey (capital S), not serviceKey or authKey', () => {
    const url = buildOrThrow(validRequest());
    expect(url.searchParams.has('ServiceKey')).toBe(true);
    expect(url.searchParams.has('serviceKey')).toBe(false);
    expect(url.searchParams.has('authKey')).toBe(false);
  });

  it('appends parameters in a deterministic order', () => {
    const keys = [...buildOrThrow(validRequest()).searchParams.keys()];
    expect(keys).toEqual([
      'ServiceKey',
      'pageNo',
      'numOfRows',
      'dataType',
      'base_date',
      'base_time',
      'nx',
      'ny',
    ]);
  });
});

describe('buildKmaCurrentObservationRequestUrl — service key encoding', () => {
  it('encodes the decoded key exactly once (round-trips via searchParams)', () => {
    const url = buildOrThrow(validRequest());
    expect(url.searchParams.get('ServiceKey')).toBe(FAKE_KEY);
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
    const result = buildKmaCurrentObservationRequestUrl(
      FAKE_KEY,
      validRequest({ baseTime: '2400' }),
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
  });
});

describe('validateKmaCurrentObservationRequest — invalid inputs', () => {
  it('rejects a malformed date', () => {
    expect(
      validateKmaCurrentObservationRequest(validRequest({ baseDate: '2026071' })).ok,
    ).toBe(false);
  });

  it('rejects an impossible calendar date', () => {
    const result = validateKmaCurrentObservationRequest(validRequest({ baseDate: '20260230' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({ field: 'baseDate', reason: 'INVALID' });
    }
  });

  it.each(['2400', '1260', '060', '06000'])('rejects an invalid time %s', (baseTime) => {
    expect(validateKmaCurrentObservationRequest(validRequest({ baseTime })).ok).toBe(false);
  });

  it('accepts a structurally valid on-the-hour base time', () => {
    expect(validateKmaCurrentObservationRequest(validRequest({ baseTime: '0600' })).ok).toBe(
      true,
    );
  });

  it.each([
    ['negative nx', { nx: -1 }],
    ['non-integer ny', { ny: 12.5 }],
    ['unsafe integer nx', { nx: 2 ** 53 }],
  ])('rejects %s', (_label, overrides) => {
    expect(validateKmaCurrentObservationRequest(validRequest(overrides)).ok).toBe(false);
  });

  it('rejects a string coordinate (no coercion)', () => {
    const result = validateKmaCurrentObservationRequest(
      validRequest({ nx: '60' as unknown as number }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual({ field: 'nx', reason: 'INVALID' });
    }
  });

  it('rejects a numeric-string date (no coercion)', () => {
    const result = validateKmaCurrentObservationRequest(
      validRequest({ baseDate: 20260716 as unknown as string }),
    );
    expect(result.ok).toBe(false);
  });

  it('collects every problem in fixed field order', () => {
    const result = validateKmaCurrentObservationRequest({
      baseDate: 'bad',
      baseTime: 'bad',
      nx: -1,
      ny: -1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.field)).toEqual([
        'baseDate',
        'baseTime',
        'nx',
        'ny',
      ]);
    }
  });
});

describe('validateKmaCurrentObservationRequest — runtime totality on non-object input', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'not-a-request'],
    ['a number', 42],
    ['a boolean', true],
    ['an array', []],
    ['a function', () => undefined],
  ])('flags all four fields INVALID (never throws) for %s', (_label, input) => {
    let result: ValidateKmaCurrentObservationRequestResult;
    expect(() => {
      result = validateKmaCurrentObservationRequest(input);
    }).not.toThrow();
    expect(result!.ok).toBe(false);
    if (!result!.ok) {
      expect(result!.issues.map((issue) => issue.field)).toEqual([
        'baseDate',
        'baseTime',
        'nx',
        'ny',
      ]);
      for (const issue of result!.issues) {
        expect(issue.reason).toBe('INVALID');
      }
    }
  });

  it('does not expose the raw non-object input', () => {
    const secret = 'SECRET_CURRENT_REQUEST_INPUT_MARKER';
    const result = validateKmaCurrentObservationRequest(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe('validateKmaCurrentObservationRequest — non-object issue state isolation', () => {
  const EXPECTED_FIELDS = ['baseDate', 'baseTime', 'nx', 'ny'] as const;

  function expectPristineIssues(result: ValidateKmaCurrentObservationRequestResult): void {
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.field)).toEqual([...EXPECTED_FIELDS]);
      for (const issue of result.issues) {
        expect(issue.reason).toBe('INVALID');
      }
    }
  }

  it('returns a distinct array and distinct issue objects on each call', () => {
    const first = validateKmaCurrentObservationRequest(null);
    const second = validateKmaCurrentObservationRequest(undefined);
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    if (!first.ok && !second.ok) {
      expect(first.issues).not.toBe(second.issues);
      for (let i = 0; i < first.issues.length; i += 1) {
        expect(first.issues[i]).not.toBe(second.issues[i]);
      }
    }
  });

  it('does not let a pop()/splice() on the first result corrupt a later call', () => {
    const first = validateKmaCurrentObservationRequest(null);
    expect(first.ok).toBe(false);
    if (!first.ok) {
      // Mutate the first result through a runtime cast (readonly is compile-time only).
      (first.issues as KmaCurrentRequestIssue[]).pop();
      (first.issues as KmaCurrentRequestIssue[]).splice(0, 1);
    }

    expectPristineIssues(validateKmaCurrentObservationRequest(undefined));
    expectPristineIssues(validateKmaCurrentObservationRequest('not-a-request'));
  });

  it('does not let mutating a first issue object corrupt a later call', () => {
    const first = validateKmaCurrentObservationRequest(null);
    expect(first.ok).toBe(false);
    if (!first.ok) {
      const firstIssue = first.issues[0]!;
      (firstIssue as { field: string }).field = 'MUTATED';
      (firstIssue as { reason: string }).reason = 'TAMPERED';
    }

    expectPristineIssues(validateKmaCurrentObservationRequest(undefined));
  });
});
