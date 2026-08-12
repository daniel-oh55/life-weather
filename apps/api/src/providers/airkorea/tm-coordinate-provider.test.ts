import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAirKoreaTmCoordinateProvider } from './provider.js';

/** An obviously fake, synthetic decoded service key — never a real/production-shaped string. */
const FAKE_KEY = 'FAKE-AIRKOREA-SERVICE-KEY-test+/==';

const SAMPLE_UMD_NAME = '혜화동';
const VALID_REQUEST = { umdName: SAMPLE_UMD_NAME };

function successBody(
  items: readonly Record<string, unknown>[],
  overrides: { readonly totalCount?: number } = {},
): string {
  return JSON.stringify({
    response: {
      header: { resultCode: '00', resultMsg: 'NORMAL_CODE' },
      body: {
        numOfRows: 100,
        pageNo: 1,
        totalCount: overrides.totalCount ?? items.length,
        items: { item: items },
      },
    },
  });
}

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sidoName: '서울특별시',
    sggName: '종로구',
    umdName: '혜화동',
    tmX: '200089.126044',
    tmY: '453946.42329',
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AirKorea TM-coordinate provider — successful in-memory JSON', () => {
  it('returns the validated candidate list for a single-item page', async () => {
    const fetchImpl = vi.fn(async () => new Response(successBody([item()]), { status: 200 }));
    const result = createAirKoreaTmCoordinateProvider({ serviceKey: FAKE_KEY, fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const outcome = await result.provider.fetchTmCoordinates(VALID_REQUEST);
    expect(outcome).toEqual({
      ok: true,
      candidates: [
        {
          sidoName: '서울특별시',
          sggName: '종로구',
          umdName: '혜화동',
          tmX: 200089.126044,
          tmY: 453946.42329,
        },
      ],
    });
  });

  it('returns candidates in upstream item order without sorting or picking a single row (동명이동)', async () => {
    const first = item({ sidoName: '경기도', sggName: '동두천시', umdName: '중앙동', tmX: '100', tmY: '200' });
    const second = item({ sidoName: '부산광역시', sggName: '중구', umdName: '중앙동', tmX: '300', tmY: '400' });
    const fetchImpl = vi.fn(async () => new Response(successBody([first, second]), { status: 200 }));
    const result = createAirKoreaTmCoordinateProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchTmCoordinates({ umdName: '중앙동' });
    expect(outcome).toEqual({
      ok: true,
      candidates: [
        { sidoName: '경기도', sggName: '동두천시', umdName: '중앙동', tmX: 100, tmY: 200 },
        { sidoName: '부산광역시', sggName: '중구', umdName: '중앙동', tmX: 300, tmY: 400 },
      ],
    });
  });

  it('sends exactly one GET request with the Accept header, https URL, and redirect:error', async () => {
    const fetchImpl = vi.fn(
      async (_input: URL | RequestInfo, _init?: RequestInit) =>
        new Response(successBody([item()]), { status: 200 }),
    );
    const result = createAirKoreaTmCoordinateProvider({
      serviceKey: FAKE_KEY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    if (!result.ok) throw new Error('unexpected config error');

    await result.provider.fetchTmCoordinates(VALID_REQUEST);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [urlArg, initArg] = fetchImpl.mock.calls[0]!;
    expect(String(urlArg)).toContain('https://apis.data.go.kr/B552584/MsrstnInfoInqireSvc/getTMStdrCrdnt');
    expect(String(urlArg)).toContain(`umdName=${encodeURIComponent(SAMPLE_UMD_NAME)}`);
    expect(String(urlArg)).toContain('pageNo=1');
    expect(String(urlArg)).toContain('numOfRows=100');
    expect(String(urlArg)).not.toContain('ver=');
    expect(initArg?.method).toBe('GET');
    expect(initArg?.headers).toEqual({ Accept: 'application/json' });
    expect(initArg?.redirect).toBe('error');
  });
});

describe('AirKorea TM-coordinate provider — request validation', () => {
  it('rejects an invalid request without performing a fetch', async () => {
    const fetchImpl = vi.fn(async () => new Response(successBody([item()]), { status: 200 }));
    const result = createAirKoreaTmCoordinateProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchTmCoordinates({ umdName: '' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe('INVALID_REQUEST');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('AirKorea TM-coordinate provider — response classification', () => {
  it('classifies a non-2xx status as HTTP_ERROR', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 500 }));
    const result = createAirKoreaTmCoordinateProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchTmCoordinates(VALID_REQUEST);
    expect(outcome).toEqual({ ok: false, error: { kind: 'HTTP_ERROR', status: 500 } });
  });

  it('classifies a rejected fetch as NETWORK_ERROR', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('SECRET_NETWORK_EXCEPTION_MESSAGE');
    });
    const result = createAirKoreaTmCoordinateProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchTmCoordinates(VALID_REQUEST);
    expect(outcome).toEqual({ ok: false, error: { kind: 'NETWORK_ERROR' } });
    expect(JSON.stringify(outcome)).not.toContain('SECRET_NETWORK_EXCEPTION_MESSAGE');
  });

  it('classifies malformed JSON as INVALID_JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('{not json', { status: 200 }));
    const result = createAirKoreaTmCoordinateProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchTmCoordinates(VALID_REQUEST);
    expect(outcome).toEqual({ ok: false, error: { kind: 'INVALID_JSON' } });
  });

  it('classifies an XML/HTML gateway body as NON_JSON_RESPONSE', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('<html><body>error</body></html>', { status: 200 }),
    );
    const result = createAirKoreaTmCoordinateProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchTmCoordinates(VALID_REQUEST);
    expect(outcome).toEqual({ ok: false, error: { kind: 'NON_JSON_RESPONSE' } });
  });

  it('classifies an empty body as EMPTY_RESPONSE', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const result = createAirKoreaTmCoordinateProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchTmCoordinates(VALID_REQUEST);
    expect(outcome).toEqual({ ok: false, error: { kind: 'EMPTY_RESPONSE' } });
  });

  it('classifies a non-success resultCode as AIRKOREA_UPSTREAM_ERROR (resultMsg never leaked)', async () => {
    const body = JSON.stringify({
      response: {
        header: { resultCode: '30', resultMsg: 'SECRET_UPSTREAM_MESSAGE' },
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
    const result = createAirKoreaTmCoordinateProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchTmCoordinates(VALID_REQUEST);
    expect(outcome).toEqual({
      ok: false,
      error: { kind: 'AIRKOREA_UPSTREAM_ERROR', resultCode: '30' },
    });
    expect(JSON.stringify(outcome)).not.toContain('SECRET_UPSTREAM_MESSAGE');
  });

  it('classifies a malformed success body as AIRKOREA_INVALID_RESPONSE', async () => {
    const body = JSON.stringify({
      response: {
        header: { resultCode: '00', resultMsg: 'NORMAL_CODE' },
        body: { numOfRows: 100, pageNo: 1 },
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
    const result = createAirKoreaTmCoordinateProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchTmCoordinates(VALID_REQUEST);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe('AIRKOREA_INVALID_RESPONSE');
    }
  });

  it('classifies an empty item list as NO_DATA (never fabricates a value)', async () => {
    const fetchImpl = vi.fn(async () => new Response(successBody([]), { status: 200 }));
    const result = createAirKoreaTmCoordinateProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchTmCoordinates(VALID_REQUEST);
    expect(outcome).toEqual({ ok: false, error: { kind: 'NO_DATA' } });
  });

  it('classifies totalCount exceeding a non-empty received item count as INCOMPLETE_RESULT', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(successBody([item()], { totalCount: 2 }), { status: 200 }),
    );
    const result = createAirKoreaTmCoordinateProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchTmCoordinates(VALID_REQUEST);
    expect(outcome).toEqual({
      ok: false,
      error: { kind: 'INCOMPLETE_RESULT', totalCount: 2, receivedCount: 1 },
    });
  });

  it('classifies a positive totalCount with zero returned items as INCOMPLETE_RESULT, not NO_DATA', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(successBody([], { totalCount: 1 }), { status: 200 }),
    );
    const result = createAirKoreaTmCoordinateProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchTmCoordinates(VALID_REQUEST);
    expect(outcome).toEqual({
      ok: false,
      error: { kind: 'INCOMPLETE_RESULT', totalCount: 1, receivedCount: 0 },
    });
  });

  it('classifies a complete multi-item result (totalCount === items.length) as success', async () => {
    const first = item({ umdName: '중앙동', sggName: '동두천시' });
    const second = item({ umdName: '중앙동', sggName: '중구' });
    const fetchImpl = vi.fn(async () => new Response(successBody([first, second]), { status: 200 }));
    const result = createAirKoreaTmCoordinateProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchTmCoordinates({ umdName: '중앙동' });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.candidates).toHaveLength(2);
    }
  });

  it('classifies a malformed tmX as MALFORMED_COORDINATE (never promoted to a fabricated value)', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(successBody([item({ tmX: 'not-a-number' })]), { status: 200 }),
    );
    const result = createAirKoreaTmCoordinateProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchTmCoordinates(VALID_REQUEST);
    expect(outcome).toEqual({ ok: false, error: { kind: 'MALFORMED_COORDINATE' } });
  });

  it('classifies a malformed tmY as MALFORMED_COORDINATE (never fabricated as 0)', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(successBody([item({ tmY: '' })]), { status: 200 }),
    );
    const result = createAirKoreaTmCoordinateProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchTmCoordinates(VALID_REQUEST);
    expect(outcome).toEqual({ ok: false, error: { kind: 'MALFORMED_COORDINATE' } });
  });

  it('classifies a single malformed coordinate among otherwise-valid items as MALFORMED_COORDINATE for the whole page', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          successBody([item({ umdName: '중앙동' }), item({ umdName: '중앙동', tmX: '1e5' })]),
          { status: 200 },
        ),
    );
    const result = createAirKoreaTmCoordinateProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchTmCoordinates({ umdName: '중앙동' });
    expect(outcome).toEqual({ ok: false, error: { kind: 'MALFORMED_COORDINATE' } });
  });

  it('classifies an oversized response as RESPONSE_TOO_LARGE', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(successBody([item()]), {
          status: 200,
          headers: { 'content-length': '999999999' },
        }),
    );
    const result = createAirKoreaTmCoordinateProvider({
      serviceKey: FAKE_KEY,
      fetchImpl,
      maxResponseBytes: 1024,
    });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchTmCoordinates(VALID_REQUEST);
    expect(outcome).toEqual({ ok: false, error: { kind: 'RESPONSE_TOO_LARGE' } });
  });

  it('never leaks the service key through any provider error variant', async () => {
    const scenarios: Array<() => Promise<Response>> = [
      async () => new Response('', { status: 500 }),
      async () => new Response('not json', { status: 200 }),
      async () => new Response('<html>err</html>', { status: 200 }),
      async () =>
        new Response(
          JSON.stringify({ response: { header: { resultCode: '30', resultMsg: 'x' } } }),
          { status: 200 },
        ),
      async () => new Response(successBody([]), { status: 200 }),
    ];

    for (const makeResponse of scenarios) {
      const fetchImpl = vi.fn(makeResponse);
      const result = createAirKoreaTmCoordinateProvider({ serviceKey: FAKE_KEY, fetchImpl });
      if (!result.ok) throw new Error('unexpected config error');

      const outcome = await result.provider.fetchTmCoordinates(VALID_REQUEST);
      expect(outcome.ok).toBe(false);
      expect(JSON.stringify(outcome)).not.toContain(FAKE_KEY);
    }
  });
});

describe('AirKorea TM-coordinate provider — abort and timeout', () => {
  it('performs zero fetches for an already-aborted signal', async () => {
    const fetchImpl = vi.fn(async () => new Response(successBody([item()]), { status: 200 }));
    const result = createAirKoreaTmCoordinateProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const controller = new AbortController();
    controller.abort();
    const outcome = await result.provider.fetchTmCoordinates(VALID_REQUEST, {
      signal: controller.signal,
    });
    expect(outcome).toEqual({ ok: false, error: { kind: 'ABORTED' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('classifies a mid-flight caller abort as ABORTED (caller signal forwarded through transport)', async () => {
    const fetchImpl = vi.fn(
      (_url: URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    ) as unknown as typeof fetch;
    const result = createAirKoreaTmCoordinateProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const controller = new AbortController();
    const outcomePromise = result.provider.fetchTmCoordinates(VALID_REQUEST, {
      signal: controller.signal,
    });
    controller.abort();
    const outcome = await outcomePromise;
    expect(outcome).toEqual({ ok: false, error: { kind: 'ABORTED' } });
  });

  it('classifies a fetchImpl that ignores the signal and never settles as TIMEOUT', async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const result = createAirKoreaTmCoordinateProvider({
      serviceKey: FAKE_KEY,
      fetchImpl,
      timeoutMs: 20,
    });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchTmCoordinates(VALID_REQUEST);
    expect(outcome).toEqual({ ok: false, error: { kind: 'TIMEOUT' } });
  });
});

describe('AirKorea TM-coordinate provider — no retry, no real network', () => {
  it('performs exactly one fetch even on an upstream error (no retry)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 500 }));
    const result = createAirKoreaTmCoordinateProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    await result.provider.fetchTmCoordinates(VALID_REQUEST);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never calls the real global fetch (only the injected fetchImpl is used)', async () => {
    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, 'fetch');
    const fetchImpl = vi.fn(async () => new Response(successBody([item()]), { status: 200 }));
    const result = createAirKoreaTmCoordinateProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    await result.provider.fetchTmCoordinates(VALID_REQUEST);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(globalThis.fetch).toBe(realFetch);
  });
});
