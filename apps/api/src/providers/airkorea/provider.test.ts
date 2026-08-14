import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAirKoreaCurrentAirQualityProvider } from './provider.js';

/** An obviously fake, synthetic decoded service key — never a real/production-shaped string. */
const FAKE_KEY = 'FAKE-AIRKOREA-SERVICE-KEY-test+/==';

function successBody(items: readonly Record<string, unknown>[]): string {
  return JSON.stringify({
    response: {
      header: { resultCode: '00', resultMsg: 'NORMAL_CODE' },
      body: {
        numOfRows: 100,
        pageNo: 1,
        totalCount: items.length,
        items,
      },
    },
  });
}

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dataTime: '2020-11-25 13:00',
    stationName: '종로구',
    pm10Value: '73',
    pm25Value: '44',
    o3Value: '0.043',
    khaiValue: '75',
    khaiGrade: '2',
    pm10Grade: '2',
    pm25Grade: '2',
    o3Grade: '2',
    ...overrides,
  };
}

/** Return a shallow clone of `obj` with `key` deleted — works around TS's optional-only `delete`. */
function omitKey(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...obj };
  delete clone[key];
  return clone;
}

const REQUIRED_CONSUMED_FIELDS = [
  'pm10Value',
  'o3Value',
  'khaiValue',
  'khaiGrade',
  'pm10Grade',
  'o3Grade',
] as const;

afterEach(() => {
  vi.useRealTimers();
});

describe('AirKorea provider — successful in-memory JSON', () => {
  it('returns the parsed observation for a single-item page', async () => {
    const fetchImpl = vi.fn(async () => new Response(successBody([item()]), { status: 200 }));
    const result = createAirKoreaCurrentAirQualityProvider({ serviceKey: FAKE_KEY, fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const outcome = await result.provider.fetchCurrentAirQuality({ stationName: '종로구' });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.observation.stationName).toBe('종로구');
      expect(outcome.observation.pm10Value).toBe('73');
      expect(outcome.observation.pm25Value).toBe('44');
    }
  });

  it('sends exactly one GET request with the Accept header, https URL, and redirect:error', async () => {
    const fetchImpl = vi.fn(
      async (_input: URL | RequestInfo, _init?: RequestInit) =>
        new Response(successBody([item()]), { status: 200 }),
    );
    const result = createAirKoreaCurrentAirQualityProvider({
      serviceKey: FAKE_KEY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    if (!result.ok) throw new Error('unexpected config error');

    await result.provider.fetchCurrentAirQuality({ stationName: '종로구' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [urlArg, initArg] = fetchImpl.mock.calls[0]!;
    expect(String(urlArg)).toContain('https://apis.data.go.kr/B552584/ArpltnInforInqireSvc/getMsrstnAcctoRltmMesureDnsty');
    expect(initArg?.method).toBe('GET');
    expect(initArg?.headers).toEqual({ Accept: 'application/json' });
    expect(initArg?.redirect).toBe('error');
  });

  it('selects the item with the latest dataTime, not items[0]', async () => {
    const older = item({ dataTime: '2020-11-25 09:00', pm10Value: '10' });
    const newer = item({ dataTime: '2020-11-25 13:00', pm10Value: '99' });
    // Deliberately place the newer item AFTER the older one is not enough to prove non-vacuity —
    // also test the reverse order below.
    const fetchImpl = vi.fn(
      async () => new Response(successBody([newer, older]), { status: 200 }),
    );
    const result = createAirKoreaCurrentAirQualityProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchCurrentAirQuality({ stationName: '종로구' });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.observation.dataTime).toBe('2020-11-25 13:00');
      expect(outcome.observation.pm10Value).toBe('99');
    }
  });

  it('selects the latest item regardless of array order (reverse order)', async () => {
    const older = item({ dataTime: '2020-11-25 09:00', pm10Value: '10' });
    const newer = item({ dataTime: '2020-11-25 13:00', pm10Value: '99' });
    const fetchImpl = vi.fn(
      async () => new Response(successBody([older, newer]), { status: 200 }),
    );
    const result = createAirKoreaCurrentAirQualityProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchCurrentAirQuality({ stationName: '종로구' });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.observation.dataTime).toBe('2020-11-25 13:00');
    }
  });

  it('accepts a direct-array body.items live JSON shape (2026-08-13 Owner-observed evidence)', async () => {
    const fetchImpl = vi.fn(async () => new Response(successBody([item()]), { status: 200 }));
    const result = createAirKoreaCurrentAirQualityProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchCurrentAirQuality({ stationName: '종로구' });
    expect(outcome.ok).toBe(true);
  });

  it('rejects the old { item: [...] } wrapper shape as AIRKOREA_INVALID_RESPONSE', async () => {
    const body = JSON.stringify({
      response: {
        header: { resultCode: '00', resultMsg: 'NORMAL_CODE' },
        body: { numOfRows: 100, pageNo: 1, totalCount: 1, items: { item: [item()] } },
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
    const result = createAirKoreaCurrentAirQualityProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchCurrentAirQuality({ stationName: '종로구' });
    expect(outcome).toEqual({
      ok: false,
      error: { kind: 'AIRKOREA_INVALID_RESPONSE', issues: expect.any(Array) },
    });
  });

  describe('latest-row selection across the 24:00 midnight boundary', () => {
    it('selects a next-calendar-day 00:xx row over an earlier same-day 23:xx row', async () => {
      const earlier = item({ dataTime: '2026-08-12 23:00', pm10Value: '10' });
      const nextDay = item({ dataTime: '2026-08-13 00:00', pm10Value: '99' });
      const fetchImpl = vi.fn(
        async () => new Response(successBody([earlier, nextDay]), { status: 200 }),
      );
      const result = createAirKoreaCurrentAirQualityProvider({ serviceKey: FAKE_KEY, fetchImpl });
      if (!result.ok) throw new Error('unexpected config error');

      const outcome = await result.provider.fetchCurrentAirQuality({ stationName: '종로구' });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.observation.dataTime).toBe('2026-08-13 00:00');
        expect(outcome.observation.pm10Value).toBe('99');
      }
    });

    it('treats a 24:00 row and the next day 00:00 row as the exact same instant deterministically (first-encountered wins, reversed order)', async () => {
      const asEndOfDay = item({ dataTime: '2026-08-12 24:00', pm10Value: 'end-of-day' });
      const asNextDayMidnight = item({ dataTime: '2026-08-13 00:00', pm10Value: 'next-day' });

      const fetchImplForward = vi.fn(
        async () => new Response(successBody([asEndOfDay, asNextDayMidnight]), { status: 200 }),
      );
      const forwardResult = createAirKoreaCurrentAirQualityProvider({
        serviceKey: FAKE_KEY,
        fetchImpl: fetchImplForward,
      });
      if (!forwardResult.ok) throw new Error('unexpected config error');
      const forwardOutcome = await forwardResult.provider.fetchCurrentAirQuality({
        stationName: '종로구',
      });
      expect(forwardOutcome.ok).toBe(true);
      if (forwardOutcome.ok) {
        expect(forwardOutcome.observation.pm10Value).toBe('end-of-day');
      }

      const fetchImplReversed = vi.fn(
        async () => new Response(successBody([asNextDayMidnight, asEndOfDay]), { status: 200 }),
      );
      const reversedResult = createAirKoreaCurrentAirQualityProvider({
        serviceKey: FAKE_KEY,
        fetchImpl: fetchImplReversed,
      });
      if (!reversedResult.ok) throw new Error('unexpected config error');
      const reversedOutcome = await reversedResult.provider.fetchCurrentAirQuality({
        stationName: '종로구',
      });
      expect(reversedOutcome.ok).toBe(true);
      if (reversedOutcome.ok) {
        expect(reversedOutcome.observation.pm10Value).toBe('next-day');
      }
    });

    it('selects the true latest row among a 23:xx row, a 24:00 row, and a later next-day row, regardless of array order', async () => {
      const lateEvening = item({ dataTime: '2026-08-12 23:30', pm10Value: 'late-evening' });
      const endOfDay = item({ dataTime: '2026-08-12 24:00', pm10Value: 'end-of-day' });
      const laterNextDay = item({ dataTime: '2026-08-13 01:00', pm10Value: 'later-next-day' });

      const fetchImpl = vi.fn(
        async () =>
          new Response(successBody([endOfDay, laterNextDay, lateEvening]), { status: 200 }),
      );
      const result = createAirKoreaCurrentAirQualityProvider({ serviceKey: FAKE_KEY, fetchImpl });
      if (!result.ok) throw new Error('unexpected config error');

      const outcome = await result.provider.fetchCurrentAirQuality({ stationName: '종로구' });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.observation.pm10Value).toBe('later-next-day');
      }
    });
  });

  describe('max-representable-year rollover boundary (9999-12-31 24:00)', () => {
    it('fails closed with AIRKOREA_INVALID_RESPONSE when a page contains the unsupported overflow timestamp, rather than dropping it and selecting the older valid row', async () => {
      const valid = item({ dataTime: '9999-12-31 23:00', pm10Value: 'older-valid' });
      const overflow = item({ dataTime: '9999-12-31 24:00', pm10Value: 'overflow' });

      const fetchImpl = vi.fn(
        async () => new Response(successBody([valid, overflow]), { status: 200 }),
      );
      const result = createAirKoreaCurrentAirQualityProvider({ serviceKey: FAKE_KEY, fetchImpl });
      if (!result.ok) throw new Error('unexpected config error');

      const outcome = await result.provider.fetchCurrentAirQuality({ stationName: '종로구' });
      expect(outcome).toEqual({
        ok: false,
        error: { kind: 'AIRKOREA_INVALID_RESPONSE', issues: expect.any(Array) },
      });
    });
  });
});

describe('AirKorea provider — request validation', () => {
  it('rejects an invalid request without performing a fetch', async () => {
    const fetchImpl = vi.fn(async () => new Response(successBody([item()]), { status: 200 }));
    const result = createAirKoreaCurrentAirQualityProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchCurrentAirQuality({ stationName: '' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe('INVALID_REQUEST');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('AirKorea provider — response classification', () => {
  it('classifies a non-2xx status as HTTP_ERROR', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 500 }));
    const result = createAirKoreaCurrentAirQualityProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchCurrentAirQuality({ stationName: '종로구' });
    expect(outcome).toEqual({ ok: false, error: { kind: 'HTTP_ERROR', status: 500 } });
  });

  it('classifies a rejected fetch as NETWORK_ERROR', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('SECRET_NETWORK_EXCEPTION_MESSAGE');
    });
    const result = createAirKoreaCurrentAirQualityProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchCurrentAirQuality({ stationName: '종로구' });
    expect(outcome).toEqual({ ok: false, error: { kind: 'NETWORK_ERROR' } });
    expect(JSON.stringify(outcome)).not.toContain('SECRET_NETWORK_EXCEPTION_MESSAGE');
  });

  it('classifies a synchronous fetch throw as NETWORK_ERROR', async () => {
    const fetchImpl = vi.fn(() => {
      throw new Error('SECRET_SYNC_THROW_MESSAGE');
    }) as unknown as typeof fetch;
    const result = createAirKoreaCurrentAirQualityProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchCurrentAirQuality({ stationName: '종로구' });
    expect(outcome).toEqual({ ok: false, error: { kind: 'NETWORK_ERROR' } });
    expect(JSON.stringify(outcome)).not.toContain('SECRET_SYNC_THROW_MESSAGE');
  });

  it('classifies malformed JSON as INVALID_JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('{not json', { status: 200 }));
    const result = createAirKoreaCurrentAirQualityProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchCurrentAirQuality({ stationName: '종로구' });
    expect(outcome).toEqual({ ok: false, error: { kind: 'INVALID_JSON' } });
  });

  it('classifies an XML/HTML gateway body as NON_JSON_RESPONSE', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('<html><body>error</body></html>', { status: 200 }),
    );
    const result = createAirKoreaCurrentAirQualityProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchCurrentAirQuality({ stationName: '종로구' });
    expect(outcome).toEqual({ ok: false, error: { kind: 'NON_JSON_RESPONSE' } });
  });

  it('classifies an empty body as EMPTY_RESPONSE', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const result = createAirKoreaCurrentAirQualityProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchCurrentAirQuality({ stationName: '종로구' });
    expect(outcome).toEqual({ ok: false, error: { kind: 'EMPTY_RESPONSE' } });
  });

  it('classifies a non-success resultCode as AIRKOREA_UPSTREAM_ERROR (resultMsg never leaked)', async () => {
    const body = JSON.stringify({
      response: {
        header: { resultCode: '30', resultMsg: 'SECRET_UPSTREAM_MESSAGE' },
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
    const result = createAirKoreaCurrentAirQualityProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchCurrentAirQuality({ stationName: '종로구' });
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
    const result = createAirKoreaCurrentAirQualityProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchCurrentAirQuality({ stationName: '종로구' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe('AIRKOREA_INVALID_RESPONSE');
    }
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
      async () => new Response(successBody([item({ stationName: '다른동' })]), { status: 200 }),
    ];

    for (const makeResponse of scenarios) {
      const fetchImpl = vi.fn(makeResponse);
      const result = createAirKoreaCurrentAirQualityProvider({ serviceKey: FAKE_KEY, fetchImpl });
      if (!result.ok) throw new Error('unexpected config error');

      const outcome = await result.provider.fetchCurrentAirQuality({ stationName: '종로구' });
      expect(outcome.ok).toBe(false);
      expect(JSON.stringify(outcome)).not.toContain(FAKE_KEY);
    }
  });

  it('classifies an empty item list as NO_DATA (never fabricates a value)', async () => {
    const fetchImpl = vi.fn(async () => new Response(successBody([]), { status: 200 }));
    const result = createAirKoreaCurrentAirQualityProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchCurrentAirQuality({ stationName: '종로구' });
    expect(outcome).toEqual({ ok: false, error: { kind: 'NO_DATA' } });
  });

  it('classifies a stationName mismatch as RESPONSE_MISMATCH', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(successBody([item({ stationName: '다른동' })]), { status: 200 }),
    );
    const result = createAirKoreaCurrentAirQualityProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchCurrentAirQuality({ stationName: '종로구' });
    expect(outcome).toEqual({
      ok: false,
      error: { kind: 'RESPONSE_MISMATCH', field: 'stationName' },
    });
  });

  it('classifies totalCount exceeding the received item count as INCOMPLETE_PAGE', async () => {
    const body = JSON.stringify({
      response: {
        header: { resultCode: '00', resultMsg: 'NORMAL_CODE' },
        body: {
          numOfRows: 100,
          pageNo: 1,
          totalCount: 5,
          items: [item()],
        },
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
    const result = createAirKoreaCurrentAirQualityProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchCurrentAirQuality({ stationName: '종로구' });
    expect(outcome).toEqual({
      ok: false,
      error: { kind: 'INCOMPLETE_PAGE', totalCount: 5, receivedCount: 1 },
    });
  });

  it('classifies an oversized response as RESPONSE_TOO_LARGE', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(successBody([item()]), {
          status: 200,
          headers: { 'content-length': '999999999' },
        }),
    );
    const result = createAirKoreaCurrentAirQualityProvider({
      serviceKey: FAKE_KEY,
      fetchImpl,
      maxResponseBytes: 1024,
    });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchCurrentAirQuality({ stationName: '종로구' });
    expect(outcome).toEqual({ ok: false, error: { kind: 'RESPONSE_TOO_LARGE' } });
  });
});

describe('AirKorea provider — required response field enforcement', () => {
  it.each(REQUIRED_CONSUMED_FIELDS)(
    'classifies a response missing %s as AIRKOREA_INVALID_RESPONSE (never a successful observation)',
    async (field) => {
      const fetchImpl = vi.fn(
        async () => new Response(successBody([omitKey(item(), field)]), { status: 200 }),
      );
      const result = createAirKoreaCurrentAirQualityProvider({ serviceKey: FAKE_KEY, fetchImpl });
      if (!result.ok) throw new Error('unexpected config error');

      const outcome = await result.provider.fetchCurrentAirQuality({ stationName: '종로구' });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error.kind).toBe('AIRKOREA_INVALID_RESPONSE');
      }
    },
  );

  it('returns a successful observation when pm25Value and pm25Grade are both absent', async () => {
    const raw = omitKey(omitKey(item(), 'pm25Value'), 'pm25Grade');
    const fetchImpl = vi.fn(async () => new Response(successBody([raw]), { status: 200 }));
    const result = createAirKoreaCurrentAirQualityProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchCurrentAirQuality({ stationName: '종로구' });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.observation.pm25Value).toBeUndefined();
      expect(outcome.observation.pm25Grade).toBeUndefined();
    }
  });
});

describe('AirKorea provider — abort and timeout', () => {
  it('performs zero fetches for an already-aborted signal', async () => {
    const fetchImpl = vi.fn(async () => new Response(successBody([item()]), { status: 200 }));
    const result = createAirKoreaCurrentAirQualityProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const controller = new AbortController();
    controller.abort();
    const outcome = await result.provider.fetchCurrentAirQuality(
      { stationName: '종로구' },
      { signal: controller.signal },
    );
    expect(outcome).toEqual({ ok: false, error: { kind: 'ABORTED' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('classifies a mid-flight caller abort as ABORTED', async () => {
    const fetchImpl = vi.fn(
      (_url: URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    ) as unknown as typeof fetch;
    const result = createAirKoreaCurrentAirQualityProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    const controller = new AbortController();
    const outcomePromise = result.provider.fetchCurrentAirQuality(
      { stationName: '종로구' },
      { signal: controller.signal },
    );
    controller.abort();
    const outcome = await outcomePromise;
    expect(outcome).toEqual({ ok: false, error: { kind: 'ABORTED' } });
  });

  it('classifies a fetchImpl that ignores the signal and never settles as TIMEOUT', async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const result = createAirKoreaCurrentAirQualityProvider({
      serviceKey: FAKE_KEY,
      fetchImpl,
      timeoutMs: 20,
    });
    if (!result.ok) throw new Error('unexpected config error');

    const outcome = await result.provider.fetchCurrentAirQuality({ stationName: '종로구' });
    expect(outcome).toEqual({ ok: false, error: { kind: 'TIMEOUT' } });
  });
});

describe('AirKorea provider — no real network', () => {
  it('never calls the real global fetch (only the injected fetchImpl is used)', async () => {
    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, 'fetch');
    const fetchImpl = vi.fn(async () => new Response(successBody([item()]), { status: 200 }));
    const result = createAirKoreaCurrentAirQualityProvider({ serviceKey: FAKE_KEY, fetchImpl });
    if (!result.ok) throw new Error('unexpected config error');

    await result.provider.fetchCurrentAirQuality({ stationName: '종로구' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(globalThis.fetch).toBe(realFetch);
  });
});
