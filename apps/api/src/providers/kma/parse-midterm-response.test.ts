import { describe, expect, it } from 'vitest';

import {
  parseKmaMidtermLandResponse,
  parseKmaMidtermTemperatureResponse,
  type ParseKmaMidtermLandResponseResult,
  type ParseKmaMidtermTemperatureResponseResult,
} from './parse-midterm-response.js';

const REG_ID = '11B10101';
const LAND_REG_ID = '11B00000';

function temperatureItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    regId: REG_ID,
    taMin4: 21,
    taMax4: 29,
    taMin5: 22,
    taMax5: 30,
    taMin6: 20,
    taMax6: 28,
    taMin7: 19,
    taMax7: 27,
    taMin8: 18,
    taMax8: 26,
    taMin9: 17,
    taMax9: 25,
    taMin10: 16,
    taMax10: 24,
    ...overrides,
  };
}

function landItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    regId: LAND_REG_ID,
    rnSt4Am: 30,
    rnSt4Pm: 60,
    rnSt5Am: 20,
    rnSt5Pm: 20,
    rnSt6Am: 10,
    rnSt6Pm: 30,
    rnSt7Am: 40,
    rnSt7Pm: 50,
    rnSt8: 30,
    rnSt9: 20,
    rnSt10: 10,
    wf4Am: '구름많음',
    wf4Pm: '흐리고 비',
    wf5Am: '맑음',
    wf5Pm: '구름많음',
    wf6Am: '흐림',
    wf6Pm: '흐리고 비',
    wf7Am: '맑음',
    wf7Pm: '맑음',
    wf8: '구름많음',
    wf9: '맑음',
    wf10: '흐림',
    ...overrides,
  };
}

interface ResponseOptions {
  resultCode?: string;
  resultMsg?: string;
  totalCount?: number;
  pageNo?: number;
  numOfRows?: number;
  items?: readonly Record<string, unknown>[];
  omitBody?: boolean;
}

function response(item: Record<string, unknown>, options: ResponseOptions = {}): unknown {
  const items = options.items ?? [item];
  const header = {
    resultCode: options.resultCode ?? '00',
    resultMsg: options.resultMsg ?? 'NORMAL_SERVICE',
  };
  if (options.omitBody === true) {
    return { response: { header } };
  }
  return {
    response: {
      header,
      body: {
        dataType: 'JSON',
        pageNo: options.pageNo ?? 1,
        numOfRows: options.numOfRows ?? 10,
        totalCount: options.totalCount ?? items.length,
        items: { item: items },
      },
    },
  };
}

function expectOk<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) {
    throw new Error(`expected success, got ${JSON.stringify(result)}`);
  }
  return result as Extract<T, { ok: true }>;
}

function errorOf(
  result: ParseKmaMidtermTemperatureResponseResult | ParseKmaMidtermLandResponseResult,
) {
  if (result.ok) {
    throw new Error('expected a failure');
  }
  return result.error;
}

// ---------------------------------------------------------------------------
// Success
// ---------------------------------------------------------------------------

describe('parseKmaMidtermTemperatureResponse — success', () => {
  it('returns a validated page retaining D+4 through D+10', () => {
    const page = expectOk(parseKmaMidtermTemperatureResponse(response(temperatureItem()))).page;
    expect(page.dataType).toBe('JSON');
    expect(page.pageNo).toBe(1);
    expect(page.numOfRows).toBe(10);
    expect(page.totalCount).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toEqual(temperatureItem());
  });

  it('accepts a valid empty page without fabricating an item', () => {
    const page = expectOk(
      parseKmaMidtermTemperatureResponse(response(temperatureItem(), { totalCount: 0, items: [] })),
    ).page;
    expect(page.items).toEqual([]);
    expect(page.totalCount).toBe(0);
  });
});

describe('parseKmaMidtermLandResponse — success', () => {
  it('returns a validated page retaining AM/PM D+4~D+7 and all-day D+8~D+10', () => {
    const page = expectOk(parseKmaMidtermLandResponse(response(landItem()))).page;
    expect(page.items).toHaveLength(1);
    const item = page.items[0];
    expect(item.wf4Am).toBe('구름많음');
    expect(item.wf4Pm).toBe('흐리고 비');
    expect(item.rnSt7Am).toBe(40);
    expect(item.rnSt7Pm).toBe(50);
    expect(item.wf8).toBe('구름많음');
    expect(item.wf9).toBe('맑음');
    expect(item.wf10).toBe('흐림');
    expect(item.rnSt10).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Operation separation
// ---------------------------------------------------------------------------

describe('mid-term parsers — the two operations are strictly separate', () => {
  it('rejects a land payload through the temperature parser', () => {
    const error = errorOf(parseKmaMidtermTemperatureResponse(response(landItem())));
    expect(error.kind).toBe('INVALID_RESPONSE');
  });

  it('rejects a temperature payload through the land parser', () => {
    const error = errorOf(parseKmaMidtermLandResponse(response(temperatureItem())));
    expect(error.kind).toBe('INVALID_RESPONSE');
  });
});

// ---------------------------------------------------------------------------
// Upstream error
// ---------------------------------------------------------------------------

describe('mid-term parsers — upstream error', () => {
  it.each(['03', '10', '20', '30', '99'])(
    'classifies non-success resultCode %s as UPSTREAM_ERROR, including 03',
    (resultCode) => {
      // No official documentation establishes a dedicated no-data code for these operations, so
      // `03` is NOT guessed to be a valid empty result (unlike the confirmed getPwnCd behavior).
      const error = errorOf(
        parseKmaMidtermTemperatureResponse(response(temperatureItem(), { resultCode })),
      );
      expect(error).toEqual({ kind: 'UPSTREAM_ERROR', resultCode });
    },
  );

  it('classifies a non-success code for the land operation too', () => {
    const error = errorOf(parseKmaMidtermLandResponse(response(landItem(), { resultCode: '99' })));
    expect(error).toEqual({ kind: 'UPSTREAM_ERROR', resultCode: '99' });
  });

  it('reports an upstream error even when the response carries no body at all', () => {
    const error = errorOf(
      parseKmaMidtermLandResponse(response(landItem(), { resultCode: '03', omitBody: true })),
    );
    expect(error).toEqual({ kind: 'UPSTREAM_ERROR', resultCode: '03' });
  });

  it('never leaks the raw resultMsg', () => {
    const result = parseKmaMidtermTemperatureResponse(
      response(temperatureItem(), { resultCode: '30', resultMsg: 'SECRET_UPSTREAM_MSG' }),
    );
    expect(JSON.stringify(result)).not.toContain('SECRET_UPSTREAM_MSG');
    expect(errorOf(result)).toEqual({ kind: 'UPSTREAM_ERROR', resultCode: '30' });
  });
});

// ---------------------------------------------------------------------------
// Invalid response
// ---------------------------------------------------------------------------

describe('mid-term parsers — invalid response', () => {
  const notEnvelopes: [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['a string', 'nope'],
    ['a number', 1],
    ['an array', []],
    ['an empty object', {}],
    ['a missing header', { response: {} }],
    ['a missing resultMsg', { response: { header: { resultCode: '00' } } }],
  ];

  it.each(notEnvelopes)('reports %s as INVALID_RESPONSE without throwing', (_label, input) => {
    expect(errorOf(parseKmaMidtermTemperatureResponse(input)).kind).toBe('INVALID_RESPONSE');
    expect(errorOf(parseKmaMidtermLandResponse(input)).kind).toBe('INVALID_RESPONSE');
  });

  it.each(['', '0', '000', 'AB', ' 03 ', '+3'])(
    'treats the structurally malformed resultCode %j as INVALID_RESPONSE, never an upstream error',
    (resultCode) => {
      const error = errorOf(
        parseKmaMidtermTemperatureResponse(response(temperatureItem(), { resultCode })),
      );
      expect(error.kind).toBe('INVALID_RESPONSE');
    },
  );

  it('reports a success code with a malformed body as INVALID_RESPONSE, not an empty page', () => {
    const error = errorOf(
      parseKmaMidtermTemperatureResponse(response(temperatureItem(), { omitBody: true })),
    );
    expect(error.kind).toBe('INVALID_RESPONSE');
  });

  it('reports issue paths and value-free messages only', () => {
    const error = errorOf(
      parseKmaMidtermTemperatureResponse(
        response(temperatureItem({ taMin4: 'SECRET_VALUE_21' })),
      ),
    );
    if (error.kind !== 'INVALID_RESPONSE') {
      throw new Error('expected INVALID_RESPONSE');
    }
    expect(error.issues.length).toBeGreaterThan(0);
    for (const issue of error.issues) {
      expect(Array.isArray(issue.path)).toBe(true);
      expect(typeof issue.message).toBe('string');
      expect(Object.keys(issue).sort()).toEqual(['message', 'path']);
    }
    expect(JSON.stringify(error)).not.toContain('SECRET_VALUE_21');
  });

  it('orders issues deterministically regardless of traversal order', () => {
    const malformed = response(temperatureItem({ taMax10: null, taMin4: 'x', regId: 'bad' }));
    const first = errorOf(parseKmaMidtermTemperatureResponse(malformed));
    const second = errorOf(parseKmaMidtermTemperatureResponse(malformed));
    expect(first).toEqual(second);
  });

  it('never mutates the input', () => {
    const input = response(temperatureItem());
    const snapshot = JSON.stringify(input);
    parseKmaMidtermTemperatureResponse(input);
    parseKmaMidtermLandResponse(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
