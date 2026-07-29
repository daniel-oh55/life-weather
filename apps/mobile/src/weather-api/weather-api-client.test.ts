import { describe, expect, it, vi } from 'vitest';

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

/** A `Response` whose body read rejects with `error`, used to exercise body-stream failures. */
function bodyFailingResponse(
  error: unknown,
  contentType = 'application/json',
): Response {
  return {
    headers: new Headers({ 'content-type': contentType }),
    text: () => Promise.reject(error),
  } as unknown as Response;
}

/** A `Response` that carries no `Content-Type` header at all (a null-body response has none). */
function noContentTypeResponse(): Response {
  return new Response(null, { status: 200 });
}

/**
 * Assert that a given `baseUrl` (typed loosely, so a runtime cast can be exercised) leaves the
 * client unconfigured: construction does not throw, `fetchWeather` resolves to a clean
 * `invalidClientConfiguration`, and no fetch is ever attempted.
 */
async function expectInvalidConfiguration(baseUrl: unknown): Promise<void> {
  const { fetchImpl, calls } = recordingFetch(() => jsonResponse(successResponseBody()));
  let client: ReturnType<typeof createWeatherApiClient> | undefined;
  expect(() => {
    client = createWeatherApiClient({ baseUrl: baseUrl as string, fetchImpl });
  }).not.toThrow();
  const result = await client!.fetchWeather(validWeatherRequest());
  expectCleanClientError(result, 'invalidClientConfiguration');
  expect(calls.length).toBe(0);
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('createWeatherApiClient — construction', () => {
  it('performs no network call and does not throw when constructed', () => {
    // The recorder injected as `fetchImpl` is the *same* one whose `calls` we assert, so this
    // proves the actually-injected fetch is untouched at construction time.
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(successResponseBody()));
    const client = createWeatherApiClient({ baseUrl: SYNTHETIC_BASE_URL, fetchImpl });
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
// Configuration validation
// ---------------------------------------------------------------------------

describe('createWeatherApiClient — configuration validation', () => {
  it('accepts a valid absolute https origin and posts to <origin>/weather', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(successResponseBody()));
    const client = createWeatherApiClient({ baseUrl: 'https://example.test', fetchImpl });
    const result = await client.fetchWeather(validWeatherRequest());
    expect(result.kind).toBe('success');
    expect(calls[0]!.input).toBe('https://example.test/weather');
  });

  it('accepts an origin with a trailing slash, appending /weather exactly once', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(successResponseBody()));
    const client = createWeatherApiClient({ baseUrl: 'https://example.test/', fetchImpl });
    await client.fetchWeather(validWeatherRequest());
    expect(calls[0]!.input).toBe('https://example.test/weather');
  });

  it('preserves an optional base path', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(successResponseBody()));
    const client = createWeatherApiClient({ baseUrl: 'https://example.test/api/v1', fetchImpl });
    await client.fetchWeather(validWeatherRequest());
    expect(calls[0]!.input).toBe('https://example.test/api/v1/weather');
  });

  it('preserves a base path that carries a trailing slash', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(successResponseBody()));
    const client = createWeatherApiClient({ baseUrl: 'https://example.test/api/v1/', fetchImpl });
    await client.fetchWeather(validWeatherRequest());
    expect(calls[0]!.input).toBe('https://example.test/api/v1/weather');
  });

  it('trims surrounding whitespace and never preserves it in the endpoint', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(successResponseBody()));
    const client = createWeatherApiClient({ baseUrl: '  https://example.test  ', fetchImpl });
    const result = await client.fetchWeather(validWeatherRequest());
    expect(result.kind).toBe('success');
    expect(calls[0]!.input).toBe('https://example.test/weather');
  });

  it.each([
    ['an empty string', ''],
    ['a whitespace-only string', '   '],
    ['a schemeless relative URL', 'example.test/weather'],
    ['an absolute-path relative URL', '/weather'],
    ['a malformed URL', 'http://%%%bad'],
    ['an unsupported scheme', 'ftp://example.test'],
    ['a URL with a query string', 'https://example.test?foo=bar'],
    ['a URL with a fragment', 'https://example.test#section'],
    ['a URL with embedded credentials', 'https://user:pass@example.test'],
  ])('rejects %s as invalidClientConfiguration, calling no fetch', async (_label, baseUrl) => {
    await expectInvalidConfiguration(baseUrl);
  });

  it.each([
    ['a number', 123],
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
  ])('rejects a runtime non-string baseUrl (%s)', async (_label, baseUrl) => {
    await expectInvalidConfiguration(baseUrl);
  });

  it.each([
    ['a number', 42],
    ['null', null],
    ['an object', {}],
    ['a string', 'not-a-function'],
  ])(
    'rejects a runtime non-function fetchImpl (%s) without falling back to global fetch',
    async (_label, badFetch) => {
      const client = createWeatherApiClient({
        baseUrl: SYNTHETIC_BASE_URL,
        fetchImpl: badFetch as unknown as WeatherApiFetch,
      });
      const result = await client.fetchWeather(validWeatherRequest());
      expectCleanClientError(result, 'invalidClientConfiguration');
    },
  );

  it('rejects when fetchImpl is omitted and no global fetch exists', async () => {
    vi.stubGlobal('fetch', undefined);
    try {
      const client = createWeatherApiClient({ baseUrl: SYNTHETIC_BASE_URL });
      const result = await client.fetchWeather(validWeatherRequest());
      expectCleanClientError(result, 'invalidClientConfiguration');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not throw at construction for a runtime-invalid config, and fetchWeather resolves', async () => {
    let client: ReturnType<typeof createWeatherApiClient> | undefined;
    expect(() => {
      client = createWeatherApiClient({
        baseUrl: undefined as unknown as string,
        fetchImpl: 123 as unknown as WeatherApiFetch,
      });
    }).not.toThrow();
    await expect(client!.fetchWeather(validWeatherRequest())).resolves.toBeDefined();
  });

  it('never leaks the raw base URL or a secret marker in a configuration error', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(successResponseBody()));
    // Embedded credentials make this an invalid config; the password carries the secret marker.
    const client = createWeatherApiClient({
      baseUrl: `https://user:${SECRET_MARKER}@example.test`,
      fetchImpl,
    });
    const result = await client.fetchWeather(validWeatherRequest());
    expectCleanClientError(result, 'invalidClientConfiguration');
    expect(calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// URL raw-syntax validation
//
// The URL parser must not be allowed to normalize an untrusted `baseUrl` into a *different*
// endpoint: a missing scheme slash, an empty `?`/`#`, a backslash, or a literal/`%2e` dot segment
// each get rewritten by `new URL()`. Every such input is rejected before any fetch, and legitimate
// origins (uppercase, ports, base paths, multiple trailing slashes, non-dot `%2e` bytes) still
// resolve. Assertions reuse `expectInvalidConfiguration`, which already proves fetch is never
// called and the error carries no URL or secret.
// ---------------------------------------------------------------------------

/** Assert a `baseUrl` resolves and POSTs to exactly `expectedUrl` (proving no unwanted rewrite). */
async function expectResolvedEndpoint(baseUrl: string, expectedUrl: string): Promise<void> {
  const { fetchImpl, calls } = recordingFetch(() => jsonResponse(successResponseBody()));
  const client = createWeatherApiClient({ baseUrl, fetchImpl });
  const result = await client.fetchWeather(validWeatherRequest());
  expect(result.kind).toBe('success');
  expect(calls[0]!.input).toBe(expectedUrl);
}

describe('createWeatherApiClient — URL scheme and slash syntax', () => {
  it.each([
    ['a single-slash https scheme', 'https:/example.test'],
    ['a single-slash http scheme', 'http:/example.test'],
    ['a slashless https scheme', 'https:example.test'],
    ['a triple-slash scheme', 'https:///example.test'],
    ['a quadruple-slash scheme', 'https:////example.test'],
  ])('rejects %s, calling no fetch', async (_label, baseUrl) => {
    await expectInvalidConfiguration(baseUrl);
  });
});

describe('createWeatherApiClient — empty query and fragment delimiters', () => {
  it.each([
    ['an empty query on a path', 'https://example.test/path?'],
    ['an empty fragment on a path', 'https://example.test/path#'],
    ['an empty query on the root', 'https://example.test/?'],
    ['an empty fragment on the root', 'https://example.test/#'],
    // A non-empty query/fragment must stay rejected too (the existing contract).
    ['a non-empty query', 'https://example.test/path?foo=bar'],
    ['a non-empty fragment', 'https://example.test/path#section'],
  ])('rejects %s, calling no fetch', async (_label, baseUrl) => {
    await expectInvalidConfiguration(baseUrl);
  });
});

describe('createWeatherApiClient — backslash paths', () => {
  it.each([
    // TypeScript string escapes: each `\\` is one literal backslash in the value.
    ['a backslash in the path', 'https://example.test/a\\b'],
    ['a backslash right after the host', 'https://example.test\\api'],
    ['a backslash dot-dot sequence', 'https://example.test/a\\..\\b'],
  ])('rejects %s, calling no fetch', async (_label, baseUrl) => {
    await expectInvalidConfiguration(baseUrl);
  });
});

describe('createWeatherApiClient — literal dot segments', () => {
  it.each([
    ['a single-dot segment mid-path', 'https://example.test/a/./b'],
    ['a double-dot segment mid-path', 'https://example.test/a/../b'],
    ['a leading single-dot segment', 'https://example.test/./api'],
    ['a leading double-dot segment', 'https://example.test/../api'],
    ['a trailing single-dot segment', 'https://example.test/a/.'],
    ['a trailing double-dot segment', 'https://example.test/a/..'],
  ])('rejects %s, calling no fetch', async (_label, baseUrl) => {
    await expectInvalidConfiguration(baseUrl);
  });
});

describe('createWeatherApiClient — percent-encoded dot segments', () => {
  it.each([
    ['a lower-case %2e segment', 'https://example.test/a/%2e/b'],
    ['an upper-case %2E segment', 'https://example.test/a/%2E/b'],
    ['a lower-case %2e%2e segment', 'https://example.test/a/%2e%2e/b'],
    ['an upper-case %2E%2E segment', 'https://example.test/a/%2E%2E/b'],
    ['a .%2e mixed dot-dot segment', 'https://example.test/a/.%2e/b'],
    ['a %2e. mixed dot-dot segment', 'https://example.test/a/%2e./b'],
  ])('rejects %s, calling no fetch', async (_label, baseUrl) => {
    await expectInvalidConfiguration(baseUrl);
  });
});

describe('createWeatherApiClient — legitimate origins still resolve', () => {
  it.each([
    ['an origin only', 'https://example.test', 'https://example.test/weather'],
    ['an explicit port', 'https://example.test:8443/api', 'https://example.test:8443/api/weather'],
    ['a base path', 'https://example.test/api/v1', 'https://example.test/api/v1/weather'],
    [
      'multiple trailing slashes',
      'https://example.test/api/v1///',
      'https://example.test/api/v1/weather',
    ],
    ['an uppercase scheme and host', 'HTTPS://EXAMPLE.TEST', 'https://example.test/weather'],
    ['surrounding whitespace', '  https://example.test  ', 'https://example.test/weather'],
    // A `%2e`/`%20` byte that is not a standalone dot segment must survive verbatim.
    ['a non-dot encoded space', 'https://example.test/api%20v1', 'https://example.test/api%20v1/weather'],
    ['a %2e inside a segment', 'https://example.test/api%2ev1', 'https://example.test/api%2ev1/weather'],
    ['a %2e-prefixed segment', 'https://example.test/%2econfig', 'https://example.test/%2econfig/weather'],
  ])('resolves %s to the expected /weather endpoint', async (_label, baseUrl, expectedUrl) => {
    await expectResolvedEndpoint(baseUrl, expectedUrl);
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
// Response Content-Type media type
// ---------------------------------------------------------------------------

describe('fetchWeather — Content-Type media type', () => {
  it.each([
    'application/json',
    'application/json; charset=utf-8',
    'APPLICATION/JSON',
    '  application/json  ',
    'application/json ; charset=utf-8',
  ])('accepts the JSON media type %j', async (contentType) => {
    const { fetchImpl } = recordingFetch(() =>
      rawResponse(JSON.stringify(successResponseBody()), contentType),
    );
    const client = createWeatherApiClient({ baseUrl: SYNTHETIC_BASE_URL, fetchImpl });
    const result = await client.fetchWeather(validWeatherRequest());
    expect(result.kind).toBe('success');
  });

  it.each([
    'text/plain',
    'application/jsonp',
    'application/json-extra',
    'text/application/json',
    'application/problem+json',
    'application/ld+json',
    '',
  ])('rejects the non-JSON media type %j as nonJsonResponse', async (contentType) => {
    const { fetchImpl } = recordingFetch(() =>
      rawResponse(JSON.stringify(successResponseBody()), contentType),
    );
    const client = createWeatherApiClient({ baseUrl: SYNTHETIC_BASE_URL, fetchImpl });
    expectCleanClientError(await client.fetchWeather(validWeatherRequest()), 'nonJsonResponse');
  });

  it('rejects a missing Content-Type header as nonJsonResponse', async () => {
    const { fetchImpl } = recordingFetch(() => noContentTypeResponse());
    const client = createWeatherApiClient({ baseUrl: SYNTHETIC_BASE_URL, fetchImpl });
    expectCleanClientError(await client.fetchWeather(validWeatherRequest()), 'nonJsonResponse');
  });
});

// ---------------------------------------------------------------------------
// Response body-read failure classification
// ---------------------------------------------------------------------------

describe('fetchWeather — body-read failure classification', () => {
  it('classifies a generic body-read rejection as aborted when the signal is already aborted', async () => {
    const controller = new AbortController();
    const fetchImpl: WeatherApiFetch = () => {
      // The signal is not aborted before fetch (so the pre-fetch short-circuit is skipped); it
      // fires while the response is in hand, then the body read fails with a generic error.
      controller.abort();
      return Promise.resolve(bodyFailingResponse(new Error(SECRET_MARKER)));
    };
    const client = createWeatherApiClient({ baseUrl: SYNTHETIC_BASE_URL, fetchImpl });
    const result = await client.fetchWeather(validWeatherRequest(), {
      signal: controller.signal,
    });
    expectCleanClientError(result, 'aborted');
  });

  it('classifies a generic body-read rejection as networkError when the signal is not aborted', async () => {
    const { fetchImpl } = recordingFetch(() => bodyFailingResponse(new Error(SECRET_MARKER)));
    const client = createWeatherApiClient({ baseUrl: SYNTHETIC_BASE_URL, fetchImpl });
    expectCleanClientError(await client.fetchWeather(validWeatherRequest()), 'networkError');
  });

  it('classifies a body-read AbortError as aborted even without an aborted signal', async () => {
    const abortError = new Error(SECRET_MARKER);
    abortError.name = 'AbortError';
    const { fetchImpl } = recordingFetch(() => bodyFailingResponse(abortError));
    const client = createWeatherApiClient({ baseUrl: SYNTHETIC_BASE_URL, fetchImpl });
    expectCleanClientError(await client.fetchWeather(validWeatherRequest()), 'aborted');
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
