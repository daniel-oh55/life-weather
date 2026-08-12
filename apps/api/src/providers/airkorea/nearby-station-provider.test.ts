import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAirKoreaNearbyStationProvider } from './provider.js';

/** An obviously fake, synthetic decoded service key — never a real/production-shaped string. */
const FAKE_KEY = 'FAKE-AIRKOREA-SERVICE-KEY-test+/==';

const SAMPLE_TM_X = 244148.546388;
const SAMPLE_TM_Y = 412423.75772;
const VALID_REQUEST = { tmX: SAMPLE_TM_X, tmY: SAMPLE_TM_Y };

function successBody(
  items: readonly Record<string, unknown>[],
  overrides: { readonly totalCount?: number } = {},
): string {
  return JSON.stringify({
    response: {
      header: { resultCode: '00', resultMsg: 'NORMAL_CODE' },
      body: {
        numOfRows: 10,
        pageNo: 1,
        totalCount: overrides.totalCount ?? items.length,
        items: { item: items },
      },
    },
  });
}

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tm: '8.2',
    stationName: '부발읍',
    addr: '경기도 이천시 부발읍 무촌로 117부발보건지소 옥상',
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AirKorea nearby-station provider — successful in-memory JSON', () => {
  it('returns the validated candidate list for a single-item page', async () => {
    const fetchImpl = vi.fn(async () => new Response(successBody([item()]), { status: 200 }));
    const result = createAirKoreaNearbyStationProvider({ serviceKey: FAKE_KEY, fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const outcome = await result.provider.fetchNearbyStations(VALID_REQUEST);
    expect(outcome).toEqual({
      ok: true,
      stations: [{ stationName: '부발읍', distanceKm: 8.2 }],
    });
  });

  it('returns candidates in upstream item order without sorting or picking a single closest station', async () => {
    const first = item({ tm: '9.7', stationName: '창전동' });
    const second = item({ tm: '8.2', stationName: '부발읍' });
    const fetchImpl = vi.fn(async () => new Response(successBody([first, second]), { status: 200 }));
    const result = createAirKoreaNearbyStationProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchNearbyStations(VALID_REQUEST);
    expect(outcome).toEqual({
      ok: true,
      stations: [
        { stationName: '창전동', distanceKm: 9.7 },
        { stationName: '부발읍', distanceKm: 8.2 },
      ],
    });
  });

  it('sends exactly one GET request with the Accept header, https URL, and redirect:error', async () => {
    const fetchImpl = vi.fn(
      async (_input: URL | RequestInfo, _init?: RequestInit) =>
        new Response(successBody([item()]), { status: 200 }),
    );
    const result = createAirKoreaNearbyStationProvider({
      serviceKey: FAKE_KEY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    if (!result.ok) throw new Error('unexpected config error');

    await result.provider.fetchNearbyStations(VALID_REQUEST);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [urlArg, initArg] = fetchImpl.mock.calls[0]!;
    expect(String(urlArg)).toContain('https://apis.data.go.kr/B552584/MsrstnInfoInqireSvc/getNearbyMsrstnList');
    expect(String(urlArg)).toContain(`tmX=${SAMPLE_TM_X}`);
    expect(String(urlArg)).toContain(`tmY=${SAMPLE_TM_Y}`);
    expect(String(urlArg)).not.toContain('ver=');
    expect(initArg?.method).toBe('GET');
    expect(initArg?.headers).toEqual({ Accept: 'application/json' });
    expect(initArg?.redirect).toBe('error');
  });
});

describe('AirKorea nearby-station provider — request validation', () => {
  it('rejects an invalid request without performing a fetch', async () => {
    const fetchImpl = vi.fn(async () => new Response(successBody([item()]), { status: 200 }));
    const result = createAirKoreaNearbyStationProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchNearbyStations({ tmX: Number.NaN, tmY: SAMPLE_TM_Y });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe('INVALID_REQUEST');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('AirKorea nearby-station provider — response classification', () => {
  it('classifies a non-2xx status as HTTP_ERROR', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 500 }));
    const result = createAirKoreaNearbyStationProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchNearbyStations(VALID_REQUEST);
    expect(outcome).toEqual({ ok: false, error: { kind: 'HTTP_ERROR', status: 500 } });
  });

  it('classifies a rejected fetch as NETWORK_ERROR', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('SECRET_NETWORK_EXCEPTION_MESSAGE');
    });
    const result = createAirKoreaNearbyStationProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchNearbyStations(VALID_REQUEST);
    expect(outcome).toEqual({ ok: false, error: { kind: 'NETWORK_ERROR' } });
    expect(JSON.stringify(outcome)).not.toContain('SECRET_NETWORK_EXCEPTION_MESSAGE');
  });

  it('classifies malformed JSON as INVALID_JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('{not json', { status: 200 }));
    const result = createAirKoreaNearbyStationProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchNearbyStations(VALID_REQUEST);
    expect(outcome).toEqual({ ok: false, error: { kind: 'INVALID_JSON' } });
  });

  it('classifies an XML/HTML gateway body as NON_JSON_RESPONSE', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('<html><body>error</body></html>', { status: 200 }),
    );
    const result = createAirKoreaNearbyStationProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchNearbyStations(VALID_REQUEST);
    expect(outcome).toEqual({ ok: false, error: { kind: 'NON_JSON_RESPONSE' } });
  });

  it('classifies an empty body as EMPTY_RESPONSE', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const result = createAirKoreaNearbyStationProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchNearbyStations(VALID_REQUEST);
    expect(outcome).toEqual({ ok: false, error: { kind: 'EMPTY_RESPONSE' } });
  });

  it('classifies a non-success resultCode as AIRKOREA_UPSTREAM_ERROR (resultMsg never leaked)', async () => {
    const body = JSON.stringify({
      response: {
        header: { resultCode: '30', resultMsg: 'SECRET_UPSTREAM_MESSAGE' },
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
    const result = createAirKoreaNearbyStationProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchNearbyStations(VALID_REQUEST);
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
        body: { numOfRows: 10, pageNo: 1 },
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
    const result = createAirKoreaNearbyStationProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchNearbyStations(VALID_REQUEST);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe('AIRKOREA_INVALID_RESPONSE');
    }
  });

  it('classifies an empty item list as NO_DATA (never fabricates a value)', async () => {
    const fetchImpl = vi.fn(async () => new Response(successBody([]), { status: 200 }));
    const result = createAirKoreaNearbyStationProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchNearbyStations(VALID_REQUEST);
    expect(outcome).toEqual({ ok: false, error: { kind: 'NO_DATA' } });
  });

  it('classifies totalCount exceeding a non-empty received item count as INCOMPLETE_RESULT', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(successBody([item()], { totalCount: 2 }), { status: 200 }),
    );
    const result = createAirKoreaNearbyStationProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchNearbyStations(VALID_REQUEST);
    expect(outcome).toEqual({
      ok: false,
      error: { kind: 'INCOMPLETE_RESULT', totalCount: 2, receivedCount: 1 },
    });
  });

  it('classifies a positive totalCount with zero returned items as INCOMPLETE_RESULT, not NO_DATA', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(successBody([], { totalCount: 1 }), { status: 200 }),
    );
    const result = createAirKoreaNearbyStationProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchNearbyStations(VALID_REQUEST);
    expect(outcome).toEqual({
      ok: false,
      error: { kind: 'INCOMPLETE_RESULT', totalCount: 1, receivedCount: 0 },
    });
  });

  it('classifies a complete multi-item result (totalCount === items.length) as success', async () => {
    const first = item({ stationName: '창전동', tm: '9.7' });
    const second = item({ stationName: '부발읍', tm: '8.2' });
    const fetchImpl = vi.fn(async () => new Response(successBody([first, second]), { status: 200 }));
    const result = createAirKoreaNearbyStationProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchNearbyStations(VALID_REQUEST);
    expect(outcome).toEqual({
      ok: true,
      stations: [
        { stationName: '창전동', distanceKm: 9.7 },
        { stationName: '부발읍', distanceKm: 8.2 },
      ],
    });
  });

  it('classifies a malformed distance as MALFORMED_DISTANCE (never promoted to a fabricated value)', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(successBody([item({ tm: 'not-a-number' })]), { status: 200 }),
    );
    const result = createAirKoreaNearbyStationProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchNearbyStations(VALID_REQUEST);
    expect(outcome).toEqual({ ok: false, error: { kind: 'MALFORMED_DISTANCE' } });
  });

  it('classifies a single malformed distance among otherwise-valid items as MALFORMED_DISTANCE for the whole page', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          successBody([item({ stationName: '창전동', tm: '9.7' }), item({ stationName: '설성면', tm: '-1' })]),
          { status: 200 },
        ),
    );
    const result = createAirKoreaNearbyStationProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchNearbyStations(VALID_REQUEST);
    expect(outcome).toEqual({ ok: false, error: { kind: 'MALFORMED_DISTANCE' } });
  });

  it('classifies an oversized response as RESPONSE_TOO_LARGE', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(successBody([item()]), {
          status: 200,
          headers: { 'content-length': '999999999' },
        }),
    );
    const result = createAirKoreaNearbyStationProvider({
      serviceKey: FAKE_KEY,
      fetchImpl,
      maxResponseBytes: 1024,
    });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchNearbyStations(VALID_REQUEST);
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
      const result = createAirKoreaNearbyStationProvider({ serviceKey: FAKE_KEY, fetchImpl });
      if (!result.ok) throw new Error('unexpected config error');

      const outcome = await result.provider.fetchNearbyStations(VALID_REQUEST);
      expect(outcome.ok).toBe(false);
      expect(JSON.stringify(outcome)).not.toContain(FAKE_KEY);
    }
  });
});

describe('AirKorea nearby-station provider — abort and timeout', () => {
  it('performs zero fetches for an already-aborted signal', async () => {
    const fetchImpl = vi.fn(async () => new Response(successBody([item()]), { status: 200 }));
    const result = createAirKoreaNearbyStationProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const controller = new AbortController();
    controller.abort();
    const outcome = await result.provider.fetchNearbyStations(VALID_REQUEST, {
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
    const result = createAirKoreaNearbyStationProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const controller = new AbortController();
    const outcomePromise = result.provider.fetchNearbyStations(VALID_REQUEST, {
      signal: controller.signal,
    });
    controller.abort();
    const outcome = await outcomePromise;
    expect(outcome).toEqual({ ok: false, error: { kind: 'ABORTED' } });
  });

  it('classifies a fetchImpl that ignores the signal and never settles as TIMEOUT', async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const result = createAirKoreaNearbyStationProvider({
      serviceKey: FAKE_KEY,
      fetchImpl,
      timeoutMs: 20,
    });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchNearbyStations(VALID_REQUEST);
    expect(outcome).toEqual({ ok: false, error: { kind: 'TIMEOUT' } });
  });
});

describe('AirKorea nearby-station provider — no retry, no real network', () => {
  it('performs exactly one fetch even on an upstream error (no retry)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 500 }));
    const result = createAirKoreaNearbyStationProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    await result.provider.fetchNearbyStations(VALID_REQUEST);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never calls the real global fetch (only the injected fetchImpl is used)', async () => {
    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, 'fetch');
    const fetchImpl = vi.fn(async () => new Response(successBody([item()]), { status: 200 }));
    const result = createAirKoreaNearbyStationProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    await result.provider.fetchNearbyStations(VALID_REQUEST);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(globalThis.fetch).toBe(realFetch);
  });
});
