import { describe, expect, it } from 'vitest';

import {
  createWeatherApiClient,
  type WeatherApiFetch,
  type WeatherApiResult,
} from './index';
import {
  SECRET_MARKER,
  SYNTHETIC_BASE_URL,
  SYNTHETIC_WEATHER_URL,
  apiErrorResponseBody,
  noSelectionSuccessResponseBody,
  successResponseBody,
  syntheticLocation,
  validWeatherRequest,
} from './fixtures';
import type { WeatherRequestV1 } from '@life-weather/contracts';

// ---------------------------------------------------------------------------
// Test helpers — every call uses an injected fetch or an in-memory Response, so no test
// touches the network.
// ---------------------------------------------------------------------------

/** Build an in-memory JSON `Response`. The client ignores the HTTP status by design. */
function jsonResponse(
  body: unknown,
  init: { status?: number; contentType?: string } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': init.contentType ?? 'application/json' },
  });
}

/** Build a `Response` from a raw (possibly non-JSON) body string. */
function rawResponse(body: string, contentType: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

interface RecordedCall {
  readonly input: string;
  readonly init: RequestInit;
}

/** A fetch stub that records each call and returns a *fresh* response per call. */
function recordingFetch(makeResponse: () => Response) {
  const calls: RecordedCall[] = [];
  const fetchImpl: WeatherApiFetch = (input, init) => {
    calls.push({ input, init });
    return Promise.resolve(makeResponse());
  };
  return { fetchImpl, calls };
}

/** A fetch stub that always rejects, recording each call. */
function rejectingFetch(error: unknown) {
  const calls: RecordedCall[] = [];
  const fetchImpl: WeatherApiFetch = (input, init) => {
    calls.push({ input, init });
    return Promise.reject(error);
  };
  return { fetchImpl, calls };
}

/** Recursively freeze a value so any mutation attempt throws in strict mode. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** Assert a result is a `clientError` of the given kind, carrying nothing but a safe message. */
function expectCleanClientError(
  result: WeatherApiResult,
  kind: string,
): void {
  expect(result.kind).toBe('clientError');
  if (result.kind !== 'clientError') {
    throw new Error('expected a clientError result');
  }
  expect(result.error.kind).toBe(kind);
  // The whole error object is exactly { kind, message } — no body, URL, cause, or stack.
  expect(Object.keys(result.error).sort()).toEqual(['kind', 'message']);
  expect(typeof result.error.message).toBe('string');
  const serialized = `${JSON.stringify(result.error)} ${String(result.error.message)}`;
  expect(serialized).not.toContain(SECRET_MARKER);
  expect(serialized).not.toContain('example.test');
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('createWeatherApiClient — construction', () => {
  it('performs no network call and does not throw when constructed', () => {
    const { calls } = recordingFetch(() => jsonResponse(successResponseBody()));
    const client = createWeatherApiClient({
      baseUrl: SYNTHETIC_BASE_URL,
      fetchImpl: recordingFetch(() => jsonResponse(successResponseBody())).fetchImpl,
    });
    expect(client).toBeDefined();
    expect(calls.length).toBe(0);
  });

  it('rejects an empty baseUrl as an invalid-configuration client error, calling no fetch', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(successResponseBody()));
    const client = createWeatherApiClient({ baseUrl: '   ', fetchImpl });
    const result = await client.fetchWeather(validWeatherRequest());
    expectCleanClientError(result, 'invalidClientConfiguration');
    expect(calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Outbound request
// ---------------------------------------------------------------------------

describe('fetchWeather — outbound request', () => {
  it('POSTs to exactly <baseUrl>/weather with JSON headers', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(successResponseBody()));
    const client = createWeatherApiClient({ baseUrl: SYNTHETIC_BASE_URL, fetchImpl });
    await client.fetchWeather(validWeatherRequest());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toBe(SYNTHETIC_WEATHER_URL);
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Accept).toBe('application/json');
  });

  it('tolerates a single trailing slash on baseUrl', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(successResponseBody()));
    const client = createWeatherApiClient({ baseUrl: `${SYNTHETIC_BASE_URL}/`, fetchImpl });
    await client.fetchWeather(validWeatherRequest());
    expect(calls[0]!.input).toBe(SYNTHETIC_WEATHER_URL);
  });

  it('serializes exactly the parsed { location } body', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(successResponseBody()));
    const client = createWeatherApiClient({ baseUrl: SYNTHETIC_BASE_URL, fetchImpl });
    await client.fetchWeather(validWeatherRequest());
    const sent = JSON.parse(calls[0]!.init.body as string) as unknown;
    expect(sent).toEqual({ location: syntheticLocation() });
  });

  it('rejects structurally invalid input before sending anything', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(successResponseBody()));
    const client = createWeatherApiClient({ baseUrl: SYNTHETIC_BASE_URL, fetchImpl });
    const result = await client.fetchWeather({} as unknown as WeatherRequestV1);
    expectCleanClientError(result, 'invalidRequest');
    expect(calls.length).toBe(0);
  });

  it('rejects — and never transmits — a provider-native extra location field', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(successResponseBody()));
    const client = createWeatherApiClient({ baseUrl: SYNTHETIC_BASE_URL, fetchImpl });
    const request = validWeatherRequest();
    (request.location as Record<string, unknown>).kmaGrid = { nx: 60, ny: 127 };
    const result = await client.fetchWeather(request);
    expectCleanClientError(result, 'invalidRequest');
    expect(calls.length).toBe(0);
  });

  it('rejects — and never transmits — an app-only top-level extra field', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(successResponseBody()));
    const client = createWeatherApiClient({ baseUrl: SYNTHETIC_BASE_URL, fetchImpl });
    const request = { ...validWeatherRequest(), contractVersion: 1 } as WeatherRequestV1;
    const result = await client.fetchWeather(request);
    expectCleanClientError(result, 'invalidRequest');
    expect(calls.length).toBe(0);
  });

  it('does not mutate a deep-frozen input request', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(successResponseBody()));
    const client = createWeatherApiClient({ baseUrl: SYNTHETIC_BASE_URL, fetchImpl });
    const input = deepFreeze(validWeatherRequest());
    const result = await client.fetchWeather(input);
    expect(result.kind).toBe('success');
    expect(input).toEqual(validWeatherRequest());
  });
});

// ---------------------------------------------------------------------------
// Successful responses
// ---------------------------------------------------------------------------

describe('fetchWeather — contract responses', () => {
  it('parses a success response', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(successResponseBody()));
    const client = createWeatherApiClient({ baseUrl: SYNTHETIC_BASE_URL, fetchImpl });
    const result = await client.fetchWeather(validWeatherRequest());
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error('expected success');
    expect(result.data.ok).toBe(true);
    expect(result.data.data.hourly).toHaveLength(1);
    expect(result.data.data.current).toBeNull();
    expect(result.data.data.daily).toEqual([]);
  });

  it('parses a no-selection success response (empty hourly, current null, daily [])', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(noSelectionSuccessResponseBody()));
    const client = createWeatherApiClient({ baseUrl: SYNTHETIC_BASE_URL, fetchImpl });
    const result = await client.fetchWeather(validWeatherRequest());
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error('expected success');
    expect(result.data.data.hourly).toEqual([]);
    expect(result.data.data.missingSections).toContain('HOURLY');
  });

  it('parses an API error response via the ok discriminator, regardless of HTTP status', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(apiErrorResponseBody(), { status: 422 }));
    const client = createWeatherApiClient({ baseUrl: SYNTHETIC_BASE_URL, fetchImpl });
    const result = await client.fetchWeather(validWeatherRequest());
    expect(result.kind).toBe('apiError');
    if (result.kind !== 'apiError') throw new Error('expected apiError');
    expect(result.error.ok).toBe(false);
    expect(result.error.error.code).toBe('LOCATION_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// Response validation failures
// ---------------------------------------------------------------------------

describe('fetchWeather — response validation', () => {
  it('flags a non-JSON Content-Type', async () => {
    const { fetchImpl } = recordingFetch(() =>
      rawResponse(JSON.stringify(successResponseBody()), 'text/plain'),
    );
    const client = createWeatherApiClient({ baseUrl: SYNTHETIC_BASE_URL, fetchImpl });
    expectCleanClientError(await client.fetchWeather(validWeatherRequest()), 'nonJsonResponse');
  });

  it('flags a malformed JSON body', async () => {
    const { fetchImpl } = recordingFetch(() =>
      rawResponse(`{"secret":"${SECRET_MARKER}" not-json`, 'application/json'),
    );
    const client = createWeatherApiClient({ baseUrl: SYNTHETIC_BASE_URL, fetchImpl });
    expectCleanClientError(await client.fetchWeather(validWeatherRequest()), 'malformedJson');
  });

  it('flags a structurally invalid envelope', async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({ ok: 'yes' }));
    const client = createWeatherApiClient({ baseUrl: SYNTHETIC_BASE_URL, fetchImpl });
    expectCleanClientError(await client.fetchWeather(validWeatherRequest()), 'invalidEnvelope');
  });

  it('detects an unsupported contract version before the full V1 parse', async () => {
    // The body is a valid envelope with contractVersion 2 but an otherwise-invalid v1 payload.
    // A version mismatch must win over the invalid-response classification.
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse({ ok: true, meta: { contractVersion: 2 }, data: { not: 'valid' } }),
    );
    const client = createWeatherApiClient({ baseUrl: SYNTHETIC_BASE_URL, fetchImpl });
    expectCleanClientError(
      await client.fetchWeather(validWeatherRequest()),
      'unsupportedContractVersion',
    );
  });

  it('flags a structurally invalid V1 response that matches the envelope', async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse({
        ok: true,
        meta: { contractVersion: 1, generatedAt: '2026-07-15T09:00:00Z', requestId: null },
        data: { location: 'not-an-object' },
      }),
    );
    const client = createWeatherApiClient({ baseUrl: SYNTHETIC_BASE_URL, fetchImpl });
    expectCleanClientError(await client.fetchWeather(validWeatherRequest()), 'invalidResponse');
  });
});

// ---------------------------------------------------------------------------
// Transport failures
// ---------------------------------------------------------------------------

describe('fetchWeather — transport failures', () => {
  it('maps a fetch rejection to networkError without leaking the original message', async () => {
    const { fetchImpl } = rejectingFetch(new Error(SECRET_MARKER));
    const client = createWeatherApiClient({ baseUrl: SYNTHETIC_BASE_URL, fetchImpl });
    expectCleanClientError(await client.fetchWeather(validWeatherRequest()), 'networkError');
  });

  it('maps an AbortError rejection to aborted', async () => {
    const abortError = new Error('the operation was aborted');
    abortError.name = 'AbortError';
    const { fetchImpl } = rejectingFetch(abortError);
    const client = createWeatherApiClient({ baseUrl: SYNTHETIC_BASE_URL, fetchImpl });
    expectCleanClientError(await client.fetchWeather(validWeatherRequest()), 'aborted');
  });

  it('short-circuits a pre-aborted signal to aborted without calling fetch', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(successResponseBody()));
    const client = createWeatherApiClient({ baseUrl: SYNTHETIC_BASE_URL, fetchImpl });
    const controller = new AbortController();
    controller.abort();
    const result = await client.fetchWeather(validWeatherRequest(), {
      signal: controller.signal,
    });
    expectCleanClientError(result, 'aborted');
    expect(calls.length).toBe(0);
  });

  it('forwards the caller AbortSignal to fetch by the same reference', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(successResponseBody()));
    const client = createWeatherApiClient({ baseUrl: SYNTHETIC_BASE_URL, fetchImpl });
    const controller = new AbortController();
    await client.fetchWeather(validWeatherRequest(), { signal: controller.signal });
    expect(calls[0]!.init.signal).toBe(controller.signal);
  });
});

// ---------------------------------------------------------------------------
// Isolation between calls
// ---------------------------------------------------------------------------

describe('fetchWeather — no shared mutable state across calls', () => {
  it('keeps repeated calls independent (an aborted call does not affect the next)', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(successResponseBody()));
    const client = createWeatherApiClient({ baseUrl: SYNTHETIC_BASE_URL, fetchImpl });

    const aborted = new AbortController();
    aborted.abort();
    const first = await client.fetchWeather(validWeatherRequest(), { signal: aborted.signal });
    expect(first.kind).toBe('clientError');

    const second = await client.fetchWeather(validWeatherRequest());
    expect(second.kind).toBe('success');
    // Only the second call reached fetch.
    expect(calls.length).toBe(1);
  });

  it('produces an independent result object for each successful call', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(successResponseBody()));
    const client = createWeatherApiClient({ baseUrl: SYNTHETIC_BASE_URL, fetchImpl });
    const a = await client.fetchWeather(validWeatherRequest());
    const b = await client.fetchWeather(validWeatherRequest());
    expect(a.kind).toBe('success');
    expect(b.kind).toBe('success');
    expect(a).not.toBe(b);
    expect(calls.length).toBe(2);
  });
});
