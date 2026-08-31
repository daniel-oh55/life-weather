import { describe, expect, it } from 'vitest';

import {
  buildKmaMidtermForecastRequestUrl,
  validateKmaMidtermForecastRequest,
  KMA_MIDTERM_OPERATIONS,
  type KmaMidtermForecastRequest,
  type KmaMidtermRequestIssue,
  type ValidateKmaMidtermForecastRequestResult,
} from './midterm-request.js';

/** An obviously fake decoded service key with the three characters that must be percent-encoded. */
const FAKE_KEY = 'test-key+with/slash==';

/**
 * Synthetic, official-*format* region codes. These exercise the structural rule only — no
 * production region selection exists in this PR, and none is implied by their use here.
 */
const LAND_REG_ID = '11B00000';
const TEMPERATURE_REG_ID = '11B10101';

const TM_FC = '202608310600';

function validRequest(
  overrides: Partial<KmaMidtermForecastRequest> = {},
): KmaMidtermForecastRequest {
  return {
    operation: 'TEMPERATURE',
    regId: TEMPERATURE_REG_ID,
    tmFc: TM_FC,
    ...overrides,
  };
}

function buildOrThrow(request: KmaMidtermForecastRequest, key = FAKE_KEY): URL {
  const result = buildKmaMidtermForecastRequestUrl(key, request);
  if (!result.ok) {
    throw new Error(`expected a URL, got issues: ${JSON.stringify(result.issues)}`);
  }
  return result.url;
}

function issuesOf(result: ValidateKmaMidtermForecastRequestResult): readonly KmaMidtermRequestIssue[] {
  if (result.ok) {
    throw new Error('expected the request to be rejected');
  }
  return result.issues;
}

// ---------------------------------------------------------------------------
// Structurally valid requests
// ---------------------------------------------------------------------------

describe('validateKmaMidtermForecastRequest — structurally valid requests', () => {
  it.each(KMA_MIDTERM_OPERATIONS)('accepts a well-formed %s request', (operation) => {
    expect(validateKmaMidtermForecastRequest(validRequest({ operation }))).toEqual({ ok: true });
  });

  it('accepts both the land and the temperature regId code sets (one structural rule)', () => {
    expect(
      validateKmaMidtermForecastRequest(validRequest({ operation: 'LAND', regId: LAND_REG_ID })),
    ).toEqual({ ok: true });
    expect(
      validateKmaMidtermForecastRequest(validRequest({ regId: TEMPERATURE_REG_ID })),
    ).toEqual({ ok: true });
  });

  it('accepts every structurally valid regId letter/digit combination, hardcoding no region', () => {
    for (const regId of ['11B00000', '11D10000', '11H20000', '21F20801', '00A00000', '99Z99999']) {
      expect(validateKmaMidtermForecastRequest(validRequest({ regId }))).toEqual({ ok: true });
    }
  });

  it('accepts both official issuance hours and a leap-year date', () => {
    for (const tmFc of ['202608310600', '202608311800', '202402290600']) {
      expect(validateKmaMidtermForecastRequest(validRequest({ tmFc }))).toEqual({ ok: true });
    }
  });

  it('accepts a structurally valid but non-canonical issuance hour (schedule is not enforced here)', () => {
    // Choosing the latest scheduled 06/18 KST issuance belongs to a later selector layer, so this
    // structural validator must not reject an off-schedule stamp.
    expect(validateKmaMidtermForecastRequest(validRequest({ tmFc: '202608310615' }))).toEqual({
      ok: true,
    });
    expect(validateKmaMidtermForecastRequest(validRequest({ tmFc: '202608312359' }))).toEqual({
      ok: true,
    });
  });

  it('never mutates the request object', () => {
    const request = validRequest();
    const snapshot = { ...request };
    validateKmaMidtermForecastRequest(request);
    buildKmaMidtermForecastRequestUrl(FAKE_KEY, request);
    expect(request).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// Invalid operation / regId / tmFc
// ---------------------------------------------------------------------------

describe('validateKmaMidtermForecastRequest — invalid operation', () => {
  it.each([
    ['an unsupported service operation name', 'getMidTa'],
    ['the other mid-term operations that are out of scope', 'SEA'],
    ['a lower-case variant', 'temperature'],
    ['an empty string', ''],
    ['a number', 3],
    ['null', null],
    ['undefined (the field is required)', undefined],
  ])('rejects %s', (_label, operation) => {
    const issues = issuesOf(
      validateKmaMidtermForecastRequest({ ...validRequest(), operation } as unknown),
    );
    expect(issues).toEqual([{ field: 'operation', reason: 'INVALID' }]);
  });
});

describe('validateKmaMidtermForecastRequest — invalid regId', () => {
  it.each([
    ['an empty string', ''],
    ['too few characters', '11B0000'],
    ['too many characters', '11B000000'],
    ['a lower-case letter', '11b00000'],
    ['a letter in a digit position', '1AB00000'],
    ['a digit in the letter position', '11100000'],
    ['surrounding whitespace (never silently trimmed)', ' 11B00000 '],
    ['an internal space', '11B 0000'],
    ['a non-ASCII letter', '11Ｂ00000'],
    ['a number rather than a string (no coercion)', 11_800_000],
    ['null', null],
    ['undefined (the field is required)', undefined],
  ])('rejects %s', (_label, regId) => {
    const issues = issuesOf(
      validateKmaMidtermForecastRequest({ ...validRequest(), regId } as unknown),
    );
    expect(issues).toEqual([{ field: 'regId', reason: 'INVALID' }]);
  });
});

describe('validateKmaMidtermForecastRequest — invalid tmFc', () => {
  it.each([
    ['an empty string', ''],
    ['only a date', '20260831'],
    ['too few digits', '20260831060'],
    ['too many digits', '2026083106000'],
    ['a non-existent calendar day', '202602300600'],
    ['a non-leap-year 29 February', '202502290600'],
    ['month 13', '202613010600'],
    ['day 0', '202608000600'],
    ['hour 24', '202608312400'],
    ['minute 60', '202608310660'],
    ['a non-digit character', '2026083106O0'],
    ['surrounding whitespace (never silently trimmed)', ' 202608310600 '],
    ['a number rather than a string (no coercion)', 202_608_310_600],
    ['null', null],
    ['undefined (the field is required)', undefined],
  ])('rejects %s', (_label, tmFc) => {
    const issues = issuesOf(
      validateKmaMidtermForecastRequest({ ...validRequest(), tmFc } as unknown),
    );
    expect(issues).toEqual([{ field: 'tmFc', reason: 'INVALID' }]);
  });
});

describe('validateKmaMidtermForecastRequest — multiple problems', () => {
  it('reports every problem in the fixed operation → regId → tmFc order', () => {
    const issues = issuesOf(
      validateKmaMidtermForecastRequest({ operation: 'SEA', regId: 'nope', tmFc: '1' } as unknown),
    );
    expect(issues).toEqual([
      { field: 'operation', reason: 'INVALID' },
      { field: 'regId', reason: 'INVALID' },
      { field: 'tmFc', reason: 'INVALID' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Runtime type bypass (validator totality)
// ---------------------------------------------------------------------------

describe('validateKmaMidtermForecastRequest — non-object runtime bypass', () => {
  const nonObjects: [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['a string', 'TEMPERATURE'],
    ['a number', 1],
    ['a boolean', true],
    ['an array', []],
    ['a function', () => undefined],
  ];

  it.each(nonObjects)('is total for %s — flags every field without throwing', (_label, input) => {
    const issues = issuesOf(validateKmaMidtermForecastRequest(input));
    expect(issues).toEqual([
      { field: 'operation', reason: 'INVALID' },
      { field: 'regId', reason: 'INVALID' },
      { field: 'tmFc', reason: 'INVALID' },
    ]);
  });

  it('returns freshly allocated issues on every call (no shared mutable state)', () => {
    const first = issuesOf(validateKmaMidtermForecastRequest(null));
    const second = issuesOf(validateKmaMidtermForecastRequest(null));
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);

    (first as KmaMidtermRequestIssue[]).push({ field: 'regId', reason: 'INVALID' });
    expect(issuesOf(validateKmaMidtermForecastRequest(null))).toHaveLength(3);
  });

  it('builds no URL for a non-object request', () => {
    const result = buildKmaMidtermForecastRequestUrl(FAKE_KEY, null as unknown as KmaMidtermForecastRequest);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Deterministic URL construction
// ---------------------------------------------------------------------------

describe('buildKmaMidtermForecastRequestUrl — fixed operation path mapping', () => {
  it('maps TEMPERATURE to getMidTa — never getMidLandFcst', () => {
    const url = buildOrThrow(validRequest({ operation: 'TEMPERATURE' }));
    expect(url.pathname).toBe('/1360000/MidFcstInfoService/getMidTa');
    expect(url.pathname).not.toContain('getMidLandFcst');
  });

  it('maps LAND to getMidLandFcst — never getMidTa', () => {
    const url = buildOrThrow(validRequest({ operation: 'LAND', regId: LAND_REG_ID }));
    expect(url.pathname).toBe('/1360000/MidFcstInfoService/getMidLandFcst');
    expect(url.pathname.endsWith('/getMidTa')).toBe(false);
  });

  it('targets the HTTPS MidFcstInfoService host — its own family, not the other KMA services', () => {
    const url = buildOrThrow(validRequest());
    expect(url.protocol).toBe('https:');
    expect(url.host).toBe('apis.data.go.kr');
    expect(url.pathname.startsWith('/1360000/MidFcstInfoService/')).toBe(true);
    expect(url.pathname).not.toContain('VilageFcstInfoService_2.0');
    expect(url.pathname).not.toContain('WthrWrnInfoService');
  });

  it('never lets caller input reach the URL path', () => {
    // A runtime type bypass with a path-traversal-shaped regId/tmFc must not produce a URL at all;
    // the path is selected only from the internal operation table.
    const result = buildKmaMidtermForecastRequestUrl(FAKE_KEY, {
      operation: '../getMidSeaFcst',
      regId: '../../getMidFcst',
      tmFc: '../..',
    } as unknown as KmaMidtermForecastRequest);
    expect(result.ok).toBe(false);
  });

  it('keeps a valid regId out of the path even though it is caller-supplied', () => {
    const url = buildOrThrow(validRequest({ regId: '11B10101' }));
    expect(url.pathname).toBe('/1360000/MidFcstInfoService/getMidTa');
    expect(url.searchParams.get('regId')).toBe('11B10101');
  });
});

describe('buildKmaMidtermForecastRequestUrl — query parameters', () => {
  it('uses the 공공데이터포털 ServiceKey casing and the fixed pagination/format', () => {
    const params = buildOrThrow(validRequest()).searchParams;
    expect(params.get('ServiceKey')).toBe(FAKE_KEY);
    expect(params.get('pageNo')).toBe('1');
    expect(params.get('numOfRows')).toBe('10');
    expect(params.get('dataType')).toBe('JSON');
    expect(params.get('regId')).toBe(TEMPERATURE_REG_ID);
    expect(params.get('tmFc')).toBe(TM_FC);
  });

  it('uses ServiceKey, not the alert boundary serviceKey casing nor authKey', () => {
    const params = buildOrThrow(validRequest()).searchParams;
    expect(params.has('ServiceKey')).toBe(true);
    expect(params.has('serviceKey')).toBe(false);
    expect(params.has('authKey')).toBe(false);
  });

  it('appends the parameters in a deterministic order', () => {
    expect([...buildOrThrow(validRequest()).searchParams.keys()]).toEqual([
      'ServiceKey',
      'pageNo',
      'numOfRows',
      'dataType',
      'regId',
      'tmFc',
    ]);
  });

  it('sends JSON, never XML', () => {
    for (const operation of KMA_MIDTERM_OPERATIONS) {
      expect(buildOrThrow(validRequest({ operation })).searchParams.get('dataType')).toBe('JSON');
    }
  });

  it('sends the same fixed pagination for both operations (a caller cannot override it)', () => {
    for (const operation of KMA_MIDTERM_OPERATIONS) {
      const params = buildOrThrow(
        // Extra caller keys are ignored: pagination comes only from the internal constants.
        { ...validRequest({ operation }), pageNo: 7, numOfRows: 999 } as KmaMidtermForecastRequest,
      ).searchParams;
      expect(params.get('pageNo')).toBe('1');
      expect(params.get('numOfRows')).toBe('10');
    }
  });
});

describe('buildKmaMidtermForecastRequestUrl — service-key encoding', () => {
  it('percent-encodes the decoded key exactly once and round-trips it', () => {
    const url = buildOrThrow(validRequest());
    expect(url.searchParams.get('ServiceKey')).toBe(FAKE_KEY);
    expect(url.toString()).toContain('ServiceKey=test-key%2Bwith%2Fslash%3D%3D');
    expect(url.toString()).not.toContain('test-key+with/slash==');
  });

  it('never double-encodes a percent sign', () => {
    const url = buildOrThrow(validRequest(), 'abc%2Bdef');
    expect(url.searchParams.get('ServiceKey')).toBe('abc%2Bdef');
    expect(url.toString()).toContain('ServiceKey=abc%252Bdef');
  });

  it('builds no URL — and therefore never embeds the key — for an invalid request', () => {
    const result = buildKmaMidtermForecastRequestUrl(FAKE_KEY, validRequest({ regId: 'nope' }));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
  });
});
