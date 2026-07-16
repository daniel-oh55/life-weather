import { KmaForecastProduct } from '@life-weather/weather-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getKmaForecastField } from './group-forecast-items';
import {
  createKmaForecastProvider,
  type KmaForecastProvider,
} from './provider';
import type { KmaForecastRequest } from './request';

/** An obviously fake decoded service key. Never a real/production-shaped string. */
const FAKE_KEY = 'test-key+with/slash==';

const REQUEST: KmaForecastRequest = {
  product: KmaForecastProduct.SHORT_FORECAST,
  baseDate: '20260716',
  baseTime: '0500',
  nx: 60,
  ny: 127,
};

interface RawItem {
  baseDate: string;
  baseTime: string;
  category: string;
  fcstDate: string;
  fcstTime: string;
  fcstValue: string | null;
  nx: number;
  ny: number;
}

/** A raw forecast item that matches {@link REQUEST}'s identity unless overridden. */
function item(overrides: Partial<RawItem> = {}): RawItem {
  return {
    baseDate: '20260716',
    baseTime: '0500',
    category: 'TMP',
    fcstDate: '20260716',
    fcstTime: '0600',
    fcstValue: '25',
    nx: 60,
    ny: 127,
    ...overrides,
  };
}

interface BodyOptions {
  pageNo?: number;
  numOfRows?: number;
  totalCount?: number;
  items?: readonly RawItem[];
  resultCode?: string;
  resultMsg?: string;
}

/** Serialize a KMA success/error envelope to a JSON string. */
function body(options: BodyOptions = {}): string {
  const items = options.items ?? [item()];
  return JSON.stringify({
    response: {
      header: {
        resultCode: options.resultCode ?? '00',
        resultMsg: options.resultMsg ?? 'NORMAL_SERVICE',
      },
      body: {
        dataType: 'JSON',
        pageNo: options.pageNo ?? 1,
        numOfRows: options.numOfRows ?? 1000,
        totalCount: options.totalCount ?? items.length,
        items: { item: items },
      },
    },
  });
}

function jsonOk(bodyString: string): Response {
  return new Response(bodyString, { status: 200 });
}

function fetchReturning(response: Response): typeof fetch {
  return (async () => response) as unknown as typeof fetch;
}

function fetchRejecting(error: unknown): typeof fetch {
  return (async () => {
    throw error;
  }) as unknown as typeof fetch;
}

/** A fetch that never settles until its signal aborts, then rejects like the platform does. */
function fetchHangingUntilAbort(): typeof fetch {
  return ((_input: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    })) as unknown as typeof fetch;
}

function providerWith(
  fetchImpl: typeof fetch,
  options: { timeoutMs?: number; maxResponseBytes?: number } = {},
): KmaForecastProvider {
  const created = createKmaForecastProvider({ serviceKey: FAKE_KEY, fetchImpl, ...options });
  if (!created.ok) {
    throw new Error('unexpected config error in test setup');
  }
  return created.provider;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

describe('fetchForecast — request validation', () => {
  it('returns INVALID_REQUEST without calling fetch for a bad request', async () => {
    const spy = vi.fn(fetchReturning(jsonOk(body())));
    const result = await providerWith(spy as unknown as typeof fetch).fetchForecast({
      ...REQUEST,
      baseTime: '2400',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('INVALID_REQUEST');
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('fetchForecast — fetch options', () => {
  it('issues a GET with Accept: application/json, redirect: error, and an AbortSignal', async () => {
    const calls: { input: unknown; init: RequestInit | undefined }[] = [];
    const fetchImpl = ((input: unknown, init?: RequestInit) => {
      calls.push({ input, init });
      return Promise.resolve(jsonOk(body()));
    }) as unknown as typeof fetch;

    await providerWith(fetchImpl).fetchForecast(REQUEST);

    expect(calls).toHaveLength(1);
    const { input, init } = calls[0];
    expect(input).toBeInstanceOf(URL);
    expect(init?.method).toBe('GET');
    expect(init?.headers).toEqual({ Accept: 'application/json' });
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('does not use the global fetch when an implementation is injected', async () => {
    const globalSpy = vi.spyOn(globalThis, 'fetch');
    await providerWith(fetchReturning(jsonOk(body()))).fetchForecast(REQUEST);
    expect(globalSpy).not.toHaveBeenCalled();
    globalSpy.mockRestore();
  });

  it('does not log the URL or service key', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await providerWith(fetchReturning(jsonOk(body()))).fetchForecast(REQUEST);

    for (const spy of [logSpy, errorSpy, warnSpy]) {
      expect(spy).not.toHaveBeenCalled();
    }
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe('fetchForecast — timeout & caller abort', () => {
  it('maps a provider timeout to TIMEOUT', async () => {
    const result = await providerWith(fetchHangingUntilAbort(), { timeoutMs: 10 }).fetchForecast(
      REQUEST,
    );
    expect(result).toEqual({ ok: false, error: { kind: 'TIMEOUT' } });
  });

  it('returns ABORTED without calling fetch when the caller signal is already aborted', async () => {
    const spy = vi.fn(fetchReturning(jsonOk(body())));
    const controller = new AbortController();
    controller.abort();
    const result = await providerWith(spy as unknown as typeof fetch).fetchForecast(REQUEST, {
      signal: controller.signal,
    });
    expect(result).toEqual({ ok: false, error: { kind: 'ABORTED' } });
    expect(spy).not.toHaveBeenCalled();
  });

  it('maps a mid-flight caller abort to ABORTED', async () => {
    const controller = new AbortController();
    const promise = providerWith(fetchHangingUntilAbort(), { timeoutMs: 10_000 }).fetchForecast(
      REQUEST,
      { signal: controller.signal },
    );
    controller.abort();
    expect(await promise).toEqual({ ok: false, error: { kind: 'ABORTED' } });
  });

  it('maps a generic fetch rejection to NETWORK_ERROR', async () => {
    const result = await providerWith(fetchRejecting(new Error('boom'))).fetchForecast(REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'NETWORK_ERROR' } });
  });

  it('never exposes a fetch exception message', async () => {
    const secret = 'SECRET_FETCH_EXCEPTION_MARKER';
    const result = await providerWith(fetchRejecting(new Error(secret))).fetchForecast(REQUEST);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('clears the timeout timer and removes the caller-abort listener on success', async () => {
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    await providerWith(fetchReturning(jsonOk(body())), { timeoutMs: 54_321 }).fetchForecast(
      REQUEST,
      { signal: controller.signal },
    );

    const callIndex = setSpy.mock.calls.findIndex((call) => call[1] === 54_321);
    expect(callIndex).toBeGreaterThanOrEqual(0);
    expect(clearSpy).toHaveBeenCalledWith(setSpy.mock.results[callIndex]?.value);
    expect(removeSpy).toHaveBeenCalled();

    setSpy.mockRestore();
    clearSpy.mockRestore();
  });

  it('resolves the timeout-vs-abort race deterministically (mid-flight abort → ABORTED)', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const controller = new AbortController();
      const promise = providerWith(fetchHangingUntilAbort(), { timeoutMs: 10_000 }).fetchForecast(
        REQUEST,
        { signal: controller.signal },
      );
      controller.abort();
      expect(await promise).toEqual({ ok: false, error: { kind: 'ABORTED' } });
    }
  });
});

describe('fetchForecast — HTTP status', () => {
  it.each([400, 401, 403, 404, 408, 429, 500, 503])(
    'maps HTTP %i to HTTP_ERROR with only the status',
    async (status) => {
      const result = await providerWith(
        fetchReturning(new Response('secret error page body', { status })),
      ).fetchForecast(REQUEST);
      expect(result).toEqual({ ok: false, error: { kind: 'HTTP_ERROR', status } });
    },
  );

  it('does not expose an HTTP error body', async () => {
    const result = await providerWith(
      fetchReturning(new Response('SECRET_ERROR_PAGE', { status: 500 })),
    ).fetchForecast(REQUEST);
    expect(JSON.stringify(result)).not.toContain('SECRET_ERROR_PAGE');
  });
});

describe('fetchForecast — response size', () => {
  it('rejects an over-large body with RESPONSE_TOO_LARGE', async () => {
    const huge = 'x'.repeat(10_000);
    const result = await providerWith(fetchReturning(jsonOk(huge)), {
      maxResponseBytes: 128,
    }).fetchForecast(REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'RESPONSE_TOO_LARGE' } });
  });
});

describe('fetchForecast — body format', () => {
  it('classifies an empty body as EMPTY_RESPONSE', async () => {
    const result = await providerWith(fetchReturning(new Response('', { status: 200 }))).fetchForecast(
      REQUEST,
    );
    expect(result).toEqual({ ok: false, error: { kind: 'EMPTY_RESPONSE' } });
  });

  it('classifies a whitespace-only body as EMPTY_RESPONSE', async () => {
    const result = await providerWith(fetchReturning(jsonOk('   \n\t '))).fetchForecast(REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'EMPTY_RESPONSE' } });
  });

  it('classifies malformed JSON as INVALID_JSON', async () => {
    const result = await providerWith(fetchReturning(jsonOk('{ not json'))).fetchForecast(REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'INVALID_JSON' } });
  });

  it('classifies arbitrary XML as NON_JSON_RESPONSE', async () => {
    const result = await providerWith(fetchReturning(jsonOk('<foo><bar>x</bar></foo>'))).fetchForecast(
      REQUEST,
    );
    expect(result).toEqual({ ok: false, error: { kind: 'NON_JSON_RESPONSE' } });
  });

  it('classifies HTML as NON_JSON_RESPONSE', async () => {
    const html = '<!DOCTYPE html><html><body>502</body></html>';
    const result = await providerWith(fetchReturning(jsonOk(html))).fetchForecast(REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'NON_JSON_RESPONSE' } });
  });

  it('maps a gateway XML body (with reason code) to GATEWAY_ERROR', async () => {
    const xml =
      '<OpenAPI_ServiceResponse><cmmMsgHeader><returnReasonCode>30</returnReasonCode>' +
      '<returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg></cmmMsgHeader></OpenAPI_ServiceResponse>';
    const result = await providerWith(fetchReturning(jsonOk(xml))).fetchForecast(REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'GATEWAY_ERROR', reasonCode: '30' } });
  });

  it('maps a gateway XML body (without reason code) to GATEWAY_ERROR with reasonCode null', async () => {
    const xml = '<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>x</errMsg></cmmMsgHeader></OpenAPI_ServiceResponse>';
    const result = await providerWith(fetchReturning(jsonOk(xml))).fetchForecast(REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'GATEWAY_ERROR', reasonCode: null } });
  });

  it('never exposes a secret-shaped returnAuthMsg from a gateway body', async () => {
    const secret = 'SECRET_AUTH_MSG_zZ99==';
    const xml = `<OpenAPI_ServiceResponse><returnReasonCode>30</returnReasonCode><returnAuthMsg>${secret}</returnAuthMsg></OpenAPI_ServiceResponse>`;
    const result = await providerWith(fetchReturning(jsonOk(xml))).fetchForecast(REQUEST);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe('fetchForecast — PR #4 parser connection', () => {
  it('returns a success for a normal KMA success body', async () => {
    const result = await providerWith(fetchReturning(jsonOk(body()))).fetchForecast(REQUEST);
    expect(result.ok).toBe(true);
  });

  it.each(['03', '30'])('maps upstream resultCode %s to KMA_UPSTREAM_ERROR', async (resultCode) => {
    const result = await providerWith(
      fetchReturning(jsonOk(body({ resultCode, resultMsg: 'anything' }))),
    ).fetchForecast(REQUEST);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'KMA_UPSTREAM_ERROR', resultCode },
    });
  });

  it('never exposes a raw upstream resultMsg', async () => {
    const secret = 'SECRET_RESULT_MSG_marker';
    const result = await providerWith(
      fetchReturning(jsonOk(body({ resultCode: '03', resultMsg: secret }))),
    ).fetchForecast(REQUEST);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('maps a malformed success body to KMA_INVALID_RESPONSE with sanitized issues', async () => {
    const malformed = JSON.stringify({
      response: {
        header: { resultCode: '00', resultMsg: 'NORMAL_SERVICE' },
        body: {
          dataType: 'JSON',
          pageNo: 1,
          numOfRows: 1000,
          totalCount: 1,
          items: { item: [{ baseDate: '20260716' }] }, // missing required fields
        },
      },
    });
    const result = await providerWith(fetchReturning(jsonOk(malformed))).fetchForecast(REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'KMA_INVALID_RESPONSE') {
      expect(result.error.issues.length).toBeGreaterThan(0);
      for (const issue of result.error.issues) {
        expect(Array.isArray(issue.path)).toBe(true);
        expect(typeof issue.message).toBe('string');
      }
    } else {
      throw new Error(`expected KMA_INVALID_RESPONSE, got ${JSON.stringify(result)}`);
    }
  });

  it('maps a malformed resultCode to KMA_INVALID_RESPONSE (not upstream error)', async () => {
    const result = await providerWith(
      fetchReturning(jsonOk(body({ resultCode: '0' }))),
    ).fetchForecast(REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('KMA_INVALID_RESPONSE');
    }
  });
});

describe('fetchForecast — request/response correlation', () => {
  it('flags a pageNo mismatch', async () => {
    const result = await providerWith(
      fetchReturning(jsonOk(body({ pageNo: 2 }))),
    ).fetchForecast(REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'RESPONSE_MISMATCH', field: 'pageNo' } });
  });

  it('flags a numOfRows mismatch', async () => {
    const result = await providerWith(
      fetchReturning(jsonOk(body({ numOfRows: 500, totalCount: 1 }))),
    ).fetchForecast(REQUEST);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'RESPONSE_MISMATCH', field: 'numOfRows' },
    });
  });

  it.each([
    ['baseDate', { baseDate: '20260717' }],
    ['baseTime', { baseTime: '0600' }],
    ['nx', { nx: 61 }],
    ['ny', { ny: 128 }],
  ])('flags a %s mismatch on an item', async (field, overrides) => {
    const result = await providerWith(
      fetchReturning(jsonOk(body({ items: [item(overrides)] }))),
    ).fetchForecast(REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'RESPONSE_MISMATCH', field } });
  });

  it('reports the highest-priority field when several mismatch', async () => {
    // baseDate is earlier in the fixed order than nx, so baseDate wins.
    const result = await providerWith(
      fetchReturning(jsonOk(body({ items: [item({ baseDate: '20260717', nx: 61 })] }))),
    ).fetchForecast(REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'RESPONSE_MISMATCH', field: 'baseDate' } });
  });

  it('is independent of item order', async () => {
    const good = item();
    const bad = item({ baseTime: '0600' });
    const forward = await providerWith(
      fetchReturning(jsonOk(body({ items: [good, bad], totalCount: 2 }))),
    ).fetchForecast(REQUEST);
    const reverse = await providerWith(
      fetchReturning(jsonOk(body({ items: [bad, good], totalCount: 2 }))),
    ).fetchForecast(REQUEST);
    expect(forward).toEqual(reverse);
    expect(forward).toEqual({ ok: false, error: { kind: 'RESPONSE_MISMATCH', field: 'baseTime' } });
  });

  it('flags an incomplete page when totalCount exceeds the received count', async () => {
    const items = [item({ category: 'TMP' }), item({ category: 'SKY', fcstValue: '1' })];
    const result = await providerWith(
      fetchReturning(jsonOk(body({ items, totalCount: 5 }))),
    ).fetchForecast(REQUEST);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'INCOMPLETE_PAGE', totalCount: 5, receivedCount: 2 },
    });
  });

  it('accepts an empty page with totalCount 0', async () => {
    const result = await providerWith(
      fetchReturning(jsonOk(body({ items: [], totalCount: 0 }))),
    ).fetchForecast(REQUEST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.forecast.totalCount).toBe(0);
      expect(result.forecast.slots).toEqual([]);
    }
  });

  it('accepts a complete page', async () => {
    const items = [item({ category: 'TMP' }), item({ category: 'SKY', fcstValue: '1' })];
    const result = await providerWith(
      fetchReturning(jsonOk(body({ items, totalCount: 2 }))),
    ).fetchForecast(REQUEST);
    expect(result.ok).toBe(true);
  });
});

describe('fetchForecast — slot grouping connection', () => {
  it('groups items into slots and preserves the SHORT_FORECAST product', async () => {
    const result = await providerWith(fetchReturning(jsonOk(body()))).fetchForecast(REQUEST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.forecast.product).toBe(KmaForecastProduct.SHORT_FORECAST);
      expect(result.forecast.slots.length).toBeGreaterThan(0);
      expect(result.forecast.slots[0].product).toBe(KmaForecastProduct.SHORT_FORECAST);
    }
  });

  it('preserves the ULTRA_SHORT_FORECAST product', async () => {
    const result = await providerWith(fetchReturning(jsonOk(body()))).fetchForecast({
      ...REQUEST,
      product: KmaForecastProduct.ULTRA_SHORT_FORECAST,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.forecast.product).toBe(KmaForecastProduct.ULTRA_SHORT_FORECAST);
      expect(result.forecast.slots[0].product).toBe(KmaForecastProduct.ULTRA_SHORT_FORECAST);
    }
  });

  it('preserves the ABSENT / NULL / VALUE field-presence distinction', async () => {
    const items = [
      item({ category: 'TMP', fcstValue: '25' }),
      item({ category: 'REH', fcstValue: null }),
    ];
    const result = await providerWith(
      fetchReturning(jsonOk(body({ items, totalCount: 2 }))),
    ).fetchForecast(REQUEST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const slot = result.forecast.slots[0];
      expect(getKmaForecastField(slot, 'TMP')).toEqual({ state: 'VALUE', value: '25' });
      expect(getKmaForecastField(slot, 'REH')).toEqual({ state: 'NULL' });
      expect(getKmaForecastField(slot, 'PTY')).toEqual({ state: 'ABSENT' });
    }
  });

  it('preserves an unknown but structurally valid category', async () => {
    const result = await providerWith(
      fetchReturning(jsonOk(body({ items: [item({ category: 'ABCD' })] }))),
    ).fetchForecast(REQUEST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(getKmaForecastField(result.forecast.slots[0], 'ABCD')).toEqual({
        state: 'VALUE',
        value: '25',
      });
    }
  });

  it('maps a duplicate category to DUPLICATE_CATEGORY', async () => {
    const items = [item({ category: 'TMP' }), item({ category: 'TMP' })];
    const result = await providerWith(
      fetchReturning(jsonOk(body({ items, totalCount: 2 }))),
    ).fetchForecast(REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'DUPLICATE_CATEGORY') {
      expect(result.error.category).toBe('TMP');
      expect(typeof result.error.slotKey).toBe('string');
    } else {
      throw new Error(`expected DUPLICATE_CATEGORY, got ${JSON.stringify(result)}`);
    }
  });

  it('sorts slots deterministically by forecast time', async () => {
    const items = [
      item({ fcstTime: '0700', category: 'TMP' }),
      item({ fcstTime: '0600', category: 'TMP' }),
    ];
    const result = await providerWith(
      fetchReturning(jsonOk(body({ items, totalCount: 2 }))),
    ).fetchForecast(REQUEST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.forecast.slots.map((slot) => slot.forecastTime)).toEqual(['0600', '0700']);
    }
  });

  it('does not mutate the request object', async () => {
    const request = deepFreeze({ ...REQUEST });
    const result = await providerWith(fetchReturning(jsonOk(body()))).fetchForecast(request);
    expect(result.ok).toBe(true);
    expect(request).toEqual(REQUEST);
  });

  it('is deterministic for the same mocked response', async () => {
    const first = await providerWith(fetchReturning(jsonOk(body()))).fetchForecast(REQUEST);
    const second = await providerWith(fetchReturning(jsonOk(body()))).fetchForecast(REQUEST);
    expect(first).toEqual(second);
  });
});

describe('fetchForecast — success result shape', () => {
  it('returns request identity, totalCount, and slots without any raw upstream data', async () => {
    const result = await providerWith(fetchReturning(jsonOk(body()))).fetchForecast(REQUEST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.forecast).toMatchObject({
        product: KmaForecastProduct.SHORT_FORECAST,
        baseDate: '20260716',
        baseTime: '0500',
        nx: 60,
        ny: 127,
        totalCount: 1,
      });
      const serialized = JSON.stringify(result.forecast);
      expect(serialized).not.toContain(FAKE_KEY);
      expect(serialized).not.toContain('apis.data.go.kr');
      expect(serialized).not.toContain('ServiceKey');
      expect(serialized).not.toContain('resultMsg');
      expect(serialized).not.toContain('NORMAL_SERVICE');
    }
  });
});

describe('fetchForecast — secret non-exposure across error variants', () => {
  const gatewaySecret = 'GATEWAY_SECRET_AUTH==';
  const gatewayXml = `<OpenAPI_ServiceResponse><returnReasonCode>30</returnReasonCode><returnAuthMsg>${gatewaySecret}</returnAuthMsg></OpenAPI_ServiceResponse>`;

  const scenarios: { name: string; fetchImpl: typeof fetch; forbidden: string[] }[] = [
    {
      name: 'HTTP_ERROR',
      fetchImpl: fetchReturning(new Response('SECRET_HTTP_BODY', { status: 500 })),
      forbidden: ['SECRET_HTTP_BODY'],
    },
    {
      name: 'NETWORK_ERROR',
      fetchImpl: fetchRejecting(new Error('SECRET_NETWORK_EXCEPTION')),
      forbidden: ['SECRET_NETWORK_EXCEPTION'],
    },
    {
      name: 'GATEWAY_ERROR',
      fetchImpl: fetchReturning(jsonOk(gatewayXml)),
      forbidden: [gatewaySecret],
    },
    {
      name: 'KMA_UPSTREAM_ERROR',
      fetchImpl: fetchReturning(jsonOk(body({ resultCode: '03', resultMsg: 'SECRET_UPSTREAM_MSG' }))),
      forbidden: ['SECRET_UPSTREAM_MSG'],
    },
    {
      name: 'INVALID_JSON',
      fetchImpl: fetchReturning(jsonOk('{ "SECRET_JSON_FRAGMENT": ')),
      forbidden: ['SECRET_JSON_FRAGMENT'],
    },
  ];

  it.each(scenarios)('$name never leaks secrets or the URL/key', async ({ fetchImpl, forbidden }) => {
    const result = await providerWith(fetchImpl).fetchForecast(REQUEST);
    const serialized = JSON.stringify(result);
    for (const secret of [...forbidden, FAKE_KEY, 'apis.data.go.kr', 'ServiceKey']) {
      expect(serialized).not.toContain(secret);
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
