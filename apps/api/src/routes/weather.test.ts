import { Hono } from 'hono';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  CONTRACT_VERSION,
  weatherErrorResponseV1,
  weatherResponseV1,
  weatherSuccessResponseV1,
  type HourlyForecast,
  type WeatherLocation,
  type WeatherRequestV1,
  type WeatherResponseV1,
} from '@life-weather/contracts';
import { KmaForecastProduct } from '@life-weather/weather-core';

import {
  presentKmaLocationHourlyOverviewResponseV1,
  type WeatherResponsePresenterMetaV1,
} from '../presenters';
import {
  assembleKmaHourlyWeatherOverview,
  selectKmaHourlyFallbackResult,
  type KmaForecastIssuanceIdentity,
  type KmaHourlyFallbackServiceResult,
  type KmaLocationHourlyOverviewInput,
  type KmaLocationHourlyOverviewResult,
} from '../services';

import {
  createWeatherRoute,
  WEATHER_REQUEST_MAX_BYTES,
  type WeatherRouteDependencies,
  type WeatherRouteExecuteOverview,
} from './weather';

/**
 * These tests exercise the PR #30 `POST /weather` route factory mounted exactly as production will mount
 * it (`app.route('/weather', createWeatherRoute(deps))`) and drive it with `app.request`. Success /
 * no-selection / unsupported-location cases inject the REAL PR #29 presenter over a real PR #24-shaped
 * service result (built with the real PR #22 selector + PR #23 assembler), so the emitted body is exactly
 * what production would produce. Service, presenter, server product, and `meta` provider are always
 * injected — never a global or startup dependency. Every fixture is fresh per call.
 */

const SHORT = KmaForecastProduct.SHORT_FORECAST;
const ULTRA = KmaForecastProduct.ULTRA_SHORT_FORECAST;

const UNSUPPORTED_LOCATION_MESSAGE = 'The requested location is not supported.';
const INVALID_REQUEST_MESSAGE = 'The request body is invalid.';
const UNSUPPORTED_MEDIA_TYPE_MESSAGE = 'Content-Type must be application/json.';
const PAYLOAD_TOO_LARGE_MESSAGE = 'The request body is too large.';
const INTERNAL_ERROR_MESSAGE = 'The weather request could not be completed.';

// Own-key sets (sorted).
const SUCCESS_TOP_KEYS = ['data', 'meta', 'ok'] as const;
const ERROR_TOP_KEYS = ['error', 'meta', 'ok'] as const;
const META_KEYS = ['contractVersion', 'generatedAt', 'requestId'] as const;
const API_ERROR_KEYS = ['code', 'message', 'retryable'] as const;

/** Internal keys that must never appear at any depth of a serialized response. */
const FORBIDDEN_KEYS = [
  'selection',
  'execution',
  'primary',
  'previous',
  'trace',
  'product',
  'fallbackUsed',
  'selected',
  'primaryIssuance',
  'previousIssuance',
  'baseDate',
  'baseTime',
  'nx',
  'ny',
  'grid',
  'serviceKey',
  'stage',
  'kind',
] as const;

const encoder = new TextEncoder();
const byteLen = (value: string): number => encoder.encode(value).length;

// ---------------------------------------------------------------------------
// Fixture builders (fresh per call).
// ---------------------------------------------------------------------------

function makeLocation(overrides: Partial<WeatherLocation> = {}): WeatherLocation {
  return {
    id: 'loc_seoul_jung',
    displayName: '서울특별시 중구',
    countryCode: 'KR',
    adminArea1: '서울특별시',
    adminArea2: '중구',
    adminArea3: null,
    latitude: 37.5636,
    longitude: 126.997,
    timezone: 'Asia/Seoul',
    ...overrides,
  };
}

/** A fresh, valid request body object (`{ location }`) — the shape a mobile client sends. */
function makeValidRequestBody(): WeatherRequestV1 {
  return { location: makeLocation() };
}

function makeMeta(
  overrides: Partial<WeatherResponsePresenterMetaV1> = {},
): WeatherResponsePresenterMetaV1 {
  return {
    generatedAt: '2026-07-24T05:05:00+09:00',
    requestId: 'req_pr30_abc123',
    ...overrides,
  };
}

function makeHourly(forecastAt = '2026-07-24T14:00:00+09:00'): HourlyForecast {
  return {
    forecastAt,
    condition: 'CLEAR',
    temperatureCelsius: 25.5,
    feelsLikeCelsius: null,
    precipitationProbabilityPercent: 20,
    precipitationAmountMillimeters: 1,
    snowfallAmountCentimeters: 0,
    humidityPercent: 55,
    windSpeedMetersPerSecond: 3.4,
    windDirectionDegrees: 270,
  };
}

function makePrimaryIssuance(): KmaForecastIssuanceIdentity {
  return { product: SHORT, baseDate: '20260724', baseTime: '0500' };
}

function makePreviousIssuance(): KmaForecastIssuanceIdentity {
  return { product: SHORT, baseDate: '20260724', baseTime: '0200' };
}

/** A no-fallback trace whose primary is a usable (non-empty) success → selector picks PRIMARY. */
function makePrimaryExecution(
  hourly: readonly HourlyForecast[] = [makeHourly()],
): KmaHourlyFallbackServiceResult {
  return {
    fallbackAttempted: false,
    primaryIssuance: makePrimaryIssuance(),
    primary: { ok: true, hourly },
  };
}

/** A fallback trace: empty primary, usable previous → selector picks PREVIOUS. */
function makePreviousExecution(
  previousHourly: readonly HourlyForecast[] = [makeHourly('2026-07-24T13:00:00+09:00')],
): KmaHourlyFallbackServiceResult {
  return {
    fallbackAttempted: true,
    fallbackReason: 'EMPTY_HOURLY',
    primaryIssuance: makePrimaryIssuance(),
    primary: { ok: true, hourly: [] },
    previousIssuance: makePreviousIssuance(),
    previous: { ok: true, hourly: previousHourly },
  };
}

/** A no-fallback trace whose primary is an empty success → no selection. */
function makeNoSelectionExecution(): KmaHourlyFallbackServiceResult {
  return {
    fallbackAttempted: false,
    primaryIssuance: makePrimaryIssuance(),
    primary: { ok: true, hourly: [] },
  };
}

/** Build a real internal success result (`{ ok, selection, overview }`) from an execution trace. */
function makeSuccessResult(
  execution: KmaHourlyFallbackServiceResult,
  location: WeatherLocation = makeLocation(),
): Extract<KmaLocationHourlyOverviewResult, { readonly ok: true }> {
  const selection = selectKmaHourlyFallbackResult(execution);
  const overview = selection.selected
    ? assembleKmaHourlyWeatherOverview({
        location,
        selection,
        source: {
          sourceId: 'kma-short-forecast-hourly',
          issuedAt: '2026-07-24T05:00:00+09:00',
          fetchedAt: '2026-07-24T05:05:00+09:00',
          retrievalMode: 'LIVE',
        },
      })
    : assembleKmaHourlyWeatherOverview({ location, selection, source: null });
  return { ok: true, selection, overview };
}

/** The value-free LOCATION passthrough failure. */
function makeLocationFailure(): KmaLocationHourlyOverviewResult {
  return { ok: false, stage: 'LOCATION', error: { kind: 'UNSUPPORTED_LOCATION' } };
}

// ---------------------------------------------------------------------------
// Typed test doubles (no `as any`).
// ---------------------------------------------------------------------------

type ExecuteCall = {
  readonly input: KmaLocationHourlyOverviewInput;
  readonly signal: AbortSignal;
};

function spyExecute(
  impl: WeatherRouteExecuteOverview,
): { fn: WeatherRouteExecuteOverview; calls: ExecuteCall[] } {
  const calls: ExecuteCall[] = [];
  const fn: WeatherRouteExecuteOverview = (input, signal) => {
    calls.push({ input, signal });
    return impl(input, signal);
  };
  return { fn, calls };
}

const resolveResult =
  (result: KmaLocationHourlyOverviewResult): WeatherRouteExecuteOverview =>
  () =>
    Promise.resolve(result);

type PresentCall = {
  readonly result: KmaLocationHourlyOverviewResult;
  readonly meta: WeatherResponsePresenterMetaV1;
};

function spyPresent(
  impl: typeof presentKmaLocationHourlyOverviewResponseV1,
): {
  fn: typeof presentKmaLocationHourlyOverviewResponseV1;
  calls: PresentCall[];
} {
  const calls: PresentCall[] = [];
  const fn: typeof presentKmaLocationHourlyOverviewResponseV1 = (result, meta) => {
    calls.push({ result, meta });
    return impl(result, meta);
  };
  return { fn, calls };
}

function spyMeta(
  meta: WeatherResponsePresenterMetaV1 = makeMeta(),
): { fn: (request: Request) => WeatherResponsePresenterMetaV1; calls: Request[] } {
  const calls: Request[] = [];
  const fn = (request: Request): WeatherResponsePresenterMetaV1 => {
    calls.push(request);
    return meta;
  };
  return { fn, calls };
}

function makeDeps(
  overrides: Partial<WeatherRouteDependencies> = {},
): WeatherRouteDependencies {
  return {
    executeOverview: resolveResult(makeSuccessResult(makePrimaryExecution())),
    presentResponse: presentKmaLocationHourlyOverviewResponseV1,
    product: SHORT,
    createMeta: () => makeMeta(),
    ...overrides,
  };
}

/** Mount the route exactly as production will: a fresh parent app with the sub-app at `/weather`. */
function mount(deps: WeatherRouteDependencies): Hono {
  const app = new Hono();
  app.route('/weather', createWeatherRoute(deps));
  return app;
}

function postWeather(
  app: Hono,
  init: { body?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const requestInit: RequestInit = {
    method: 'POST',
    headers: init.headers ?? { 'content-type': 'application/json' },
  };
  if (init.body !== undefined) {
    requestInit.body = init.body;
  }
  return Promise.resolve(app.request('/weather', requestInit));
}

// ---------------------------------------------------------------------------
// Assertion helpers.
// ---------------------------------------------------------------------------

function collectKeys(value: unknown, keys: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const element of value) {
      collectKeys(element, keys);
    }
  } else if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      keys.add(key);
      collectKeys((value as Record<string, unknown>)[key], keys);
    }
  }
  return keys;
}

function expectNoForbiddenKeys(response: unknown): void {
  const present = collectKeys(response);
  for (const forbidden of FORBIDDEN_KEYS) {
    expect(present.has(forbidden)).toBe(false);
  }
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

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// A — valid PRIMARY success.
// ---------------------------------------------------------------------------

describe('POST /weather — PRIMARY success', () => {
  it('maps a PRIMARY-selected service result to a 200 WeatherSuccessResponseV1', async () => {
    const hourly = [
      makeHourly('2026-07-24T14:00:00+09:00'),
      makeHourly('2026-07-24T15:00:00+09:00'),
    ];
    const result = makeSuccessResult(makePrimaryExecution(hourly));
    const execute = spyExecute(resolveResult(result));
    const meta = spyMeta(makeMeta());
    const present = spyPresent(presentKmaLocationHourlyOverviewResponseV1);

    const app = mount(
      makeDeps({
        executeOverview: execute.fn,
        presentResponse: present.fn,
        createMeta: meta.fn,
        product: SHORT,
      }),
    );

    const res = await postWeather(app, { body: JSON.stringify(makeValidRequestBody()) });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = await res.json();
    expect(weatherSuccessResponseV1.safeParse(body).success).toBe(true);

    // Exactly one service / presenter / meta call.
    expect(execute.calls).toHaveLength(1);
    expect(present.calls).toHaveLength(1);
    expect(meta.calls).toHaveLength(1);

    // Server product + parsed location reached the service.
    expect(execute.calls[0].input.product).toBe(SHORT);
    expect(execute.calls[0].input.location).toEqual(makeLocation());

    // No selection/trace leak.
    expectNoForbiddenKeys(body);
    expect(Object.keys(body as object).sort()).toEqual([...SUCCESS_TOP_KEYS]);
  });
});

// ---------------------------------------------------------------------------
// B — valid PREVIOUS success.
// ---------------------------------------------------------------------------

describe('POST /weather — PREVIOUS (fallback) success', () => {
  it('returns 200 with only the overview and no fallback trace', async () => {
    const previousHourly = [makeHourly('2026-07-24T11:00:00+09:00')];
    const result = makeSuccessResult(makePreviousExecution(previousHourly));
    const app = mount(makeDeps({ executeOverview: resolveResult(result) }));

    const res = await postWeather(app, { body: JSON.stringify(makeValidRequestBody()) });

    expect(res.status).toBe(200);
    const body = (await res.json()) as WeatherResponseV1;
    expect(weatherResponseV1.safeParse(body).success).toBe(true);
    if (!body.ok) {
      throw new Error('expected a success response');
    }
    expect(body.data.hourly).toEqual(previousHourly);
    expect(body.data.sources).toHaveLength(1);
    expectNoForbiddenKeys(body);
  });
});

// ---------------------------------------------------------------------------
// C — no-selection success (never promoted to an error).
// ---------------------------------------------------------------------------

describe('POST /weather — no-selection success', () => {
  it('returns 200 with empty hourly/sources and HOURLY missing (not an error)', async () => {
    const result = makeSuccessResult(makeNoSelectionExecution());
    const app = mount(makeDeps({ executeOverview: resolveResult(result) }));

    const res = await postWeather(app, { body: JSON.stringify(makeValidRequestBody()) });

    expect(res.status).toBe(200);
    const body = (await res.json()) as WeatherResponseV1;
    expect(body.ok).toBe(true);
    if (!body.ok) {
      throw new Error('expected a success response');
    }
    expect(body.data.hourly).toEqual([]);
    expect(body.data.sources).toEqual([]);
    expect(body.data.missingSections).toContain('HOURLY');
    expectNoForbiddenKeys(body);
  });
});

// ---------------------------------------------------------------------------
// D — unsupported location → 422.
// ---------------------------------------------------------------------------

describe('POST /weather — unsupported location', () => {
  it('maps a LOCATION failure to a 422 UNSUPPORTED_LOCATION error with no internal leak', async () => {
    const app = mount(makeDeps({ executeOverview: resolveResult(makeLocationFailure()) }));

    const res = await postWeather(app, { body: JSON.stringify(makeValidRequestBody()) });

    expect(res.status).toBe(422);
    const body = (await res.json()) as WeatherResponseV1;
    expect(weatherErrorResponseV1.safeParse(body).success).toBe(true);
    if (body.ok) {
      throw new Error('expected an error response');
    }
    expect(body.error.code).toBe('UNSUPPORTED_LOCATION');
    expect(body.error.message).toBe(UNSUPPORTED_LOCATION_MESSAGE);
    expect(body.error.retryable).toBe(false);

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('stage');
    expect(serialized).not.toContain('kind');
    expectNoForbiddenKeys(body);
  });
});

// ---------------------------------------------------------------------------
// E — Content-Type policy.
// ---------------------------------------------------------------------------

describe('POST /weather — Content-Type policy', () => {
  it.each([
    { name: 'application/json', value: 'application/json' },
    { name: 'application/json; charset=utf-8', value: 'application/json; charset=utf-8' },
    { name: 'application/json ; charset=utf-8 (space before ;)', value: 'application/json ; charset=utf-8' },
    { name: 'APPLICATION/JSON (case-insensitive)', value: 'APPLICATION/JSON' },
  ])('accepts %s and reaches the service', async ({ value }) => {
    const execute = spyExecute(resolveResult(makeSuccessResult(makePrimaryExecution())));
    const app = mount(makeDeps({ executeOverview: execute.fn }));

    const res = await postWeather(app, {
      headers: { 'content-type': value },
      body: JSON.stringify(makeValidRequestBody()),
    });

    expect(res.status).toBe(200);
    expect(execute.calls).toHaveLength(1);
  });

  it('rejects a missing Content-Type with 415 and no service call', async () => {
    const execute = spyExecute(resolveResult(makeSuccessResult(makePrimaryExecution())));
    const app = mount(makeDeps({ executeOverview: execute.fn }));

    // No body and no Content-Type header → the header is absent.
    const res = await app.request('/weather', { method: 'POST' });

    expect(res.status).toBe(415);
    expect(execute.calls).toHaveLength(0);
    const body = await res.json();
    expect(weatherErrorResponseV1.safeParse(body).success).toBe(true);
  });

  it.each([
    { name: 'empty', value: '' },
    { name: 'text/plain', value: 'text/plain' },
    { name: 'application/problem+json', value: 'application/problem+json' },
    { name: 'multipart/form-data', value: 'multipart/form-data' },
    { name: 'application/x-www-form-urlencoded', value: 'application/x-www-form-urlencoded' },
  ])('rejects %s with 415 UNSUPPORTED_MEDIA_TYPE and no service call', async ({ value }) => {
    const execute = spyExecute(resolveResult(makeSuccessResult(makePrimaryExecution())));
    const present = spyPresent(presentKmaLocationHourlyOverviewResponseV1);
    const app = mount(
      makeDeps({ executeOverview: execute.fn, presentResponse: present.fn }),
    );

    const res = await postWeather(app, {
      headers: { 'content-type': value },
      body: JSON.stringify(makeValidRequestBody()),
    });

    expect(res.status).toBe(415);
    expect(execute.calls).toHaveLength(0);
    expect(present.calls).toHaveLength(0);
    const body = (await res.json()) as WeatherResponseV1;
    expect(weatherErrorResponseV1.safeParse(body).success).toBe(true);
    if (body.ok) {
      throw new Error('expected an error response');
    }
    expect(body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(body.error.message).toBe(UNSUPPORTED_MEDIA_TYPE_MESSAGE);
    expect(body.error.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F — malformed JSON → 400, no parser detail leak.
// ---------------------------------------------------------------------------

describe('POST /weather — malformed JSON', () => {
  it.each([
    { name: 'open brace', body: '{' },
    { name: 'empty body', body: '' },
    { name: 'truncated object', body: '{"location":' },
    { name: 'trailing garbage', body: '{"location":{}}x' },
  ])('returns 400 INVALID_REQUEST for %s with no service/presenter call', async ({ body }) => {
    const execute = spyExecute(resolveResult(makeSuccessResult(makePrimaryExecution())));
    const present = spyPresent(presentKmaLocationHourlyOverviewResponseV1);
    const app = mount(
      makeDeps({ executeOverview: execute.fn, presentResponse: present.fn }),
    );

    const res = await postWeather(app, { body });

    expect(res.status).toBe(400);
    expect(execute.calls).toHaveLength(0);
    expect(present.calls).toHaveLength(0);

    const parsedBody = (await res.json()) as WeatherResponseV1;
    expect(weatherErrorResponseV1.safeParse(parsedBody).success).toBe(true);
    if (parsedBody.ok) {
      throw new Error('expected an error response');
    }
    expect(parsedBody.error.code).toBe('INVALID_REQUEST');
    expect(parsedBody.error.message).toBe(INVALID_REQUEST_MESSAGE);

    // No raw parser detail leaks.
    const serialized = JSON.stringify(parsedBody);
    for (const marker of ['SyntaxError', 'JSON', 'position', 'Unexpected', 'token']) {
      expect(serialized).not.toContain(marker);
    }
  });
});

// ---------------------------------------------------------------------------
// G — schema validation → 400, no service call, no Zod issues leaked.
// ---------------------------------------------------------------------------

describe('POST /weather — schema validation', () => {
  const validLocation = makeLocation();

  const invalidBodies: { name: string; json: string }[] = [
    { name: 'null', json: 'null' },
    { name: 'array', json: '[]' },
    { name: 'empty object', json: '{}' },
    { name: 'string', json: '"hello"' },
    { name: 'number', json: '42' },
    { name: 'boolean', json: 'true' },
    { name: 'missing location', json: JSON.stringify({ notLocation: 1 }) },
    { name: 'invalid latitude', json: JSON.stringify({ location: { ...validLocation, latitude: 999 } }) },
    { name: 'invalid longitude', json: JSON.stringify({ location: { ...validLocation, longitude: -999 } }) },
    { name: 'invalid timezone', json: JSON.stringify({ location: { ...validLocation, timezone: 'Seoul' } }) },
    { name: 'invalid countryCode', json: JSON.stringify({ location: { ...validLocation, countryCode: 'kr' } }) },
    { name: 'top-level extra key', json: JSON.stringify({ location: validLocation, extra: 1 }) },
    { name: 'nested location extra key', json: JSON.stringify({ location: { ...validLocation, isCurrent: true } }) },
    { name: 'nested nx/ny', json: JSON.stringify({ location: { ...validLocation, nx: 60, ny: 127 } }) },
    { name: 'nested serviceKey', json: JSON.stringify({ location: { ...validLocation, serviceKey: 'secret' } }) },
    { name: 'nested baseDate/baseTime', json: JSON.stringify({ location: { ...validLocation, baseDate: '20260724', baseTime: '0500' } }) },
  ];

  it.each(invalidBodies)('rejects $name with 400 INVALID_REQUEST and no service call', async ({ json }) => {
    const execute = spyExecute(resolveResult(makeSuccessResult(makePrimaryExecution())));
    const present = spyPresent(presentKmaLocationHourlyOverviewResponseV1);
    const app = mount(
      makeDeps({ executeOverview: execute.fn, presentResponse: present.fn }),
    );

    const res = await postWeather(app, { body: json });

    expect(res.status).toBe(400);
    expect(execute.calls).toHaveLength(0);
    expect(present.calls).toHaveLength(0);

    const body = (await res.json()) as WeatherResponseV1;
    expect(weatherErrorResponseV1.safeParse(body).success).toBe(true);
    if (body.ok) {
      throw new Error('expected an error response');
    }
    expect(body.error.code).toBe('INVALID_REQUEST');
    expect(body.error.message).toBe(INVALID_REQUEST_MESSAGE);

    // No Zod issue detail leaks (no `path`, `expected`, `invalid_`, `issues`).
    const serialized = JSON.stringify(body);
    for (const marker of ['issues', 'invalid_', 'expected', 'unrecognized', 'Unrecognized']) {
      expect(serialized).not.toContain(marker);
    }
  });
});

// ---------------------------------------------------------------------------
// H — body-size limit (byte-based, 16 KiB).
// ---------------------------------------------------------------------------

describe('POST /weather — body-size limit', () => {
  it('accepts a body of exactly WEATHER_REQUEST_MAX_BYTES (trailing JSON whitespace)', async () => {
    const execute = spyExecute(resolveResult(makeSuccessResult(makePrimaryExecution())));
    const app = mount(makeDeps({ executeOverview: execute.fn }));

    const base = JSON.stringify(makeValidRequestBody());
    const body = base + ' '.repeat(WEATHER_REQUEST_MAX_BYTES - byteLen(base));
    expect(byteLen(body)).toBe(WEATHER_REQUEST_MAX_BYTES);

    const res = await postWeather(app, { body });

    expect(res.status).toBe(200);
    expect(execute.calls).toHaveLength(1);
  });

  it('rejects a body of WEATHER_REQUEST_MAX_BYTES + 1 with 413 and no service call', async () => {
    const execute = spyExecute(resolveResult(makeSuccessResult(makePrimaryExecution())));
    const present = spyPresent(presentKmaLocationHourlyOverviewResponseV1);
    const app = mount(
      makeDeps({ executeOverview: execute.fn, presentResponse: present.fn }),
    );

    const base = JSON.stringify(makeValidRequestBody());
    const body = base + ' '.repeat(WEATHER_REQUEST_MAX_BYTES + 1 - byteLen(base));
    expect(byteLen(body)).toBe(WEATHER_REQUEST_MAX_BYTES + 1);

    const res = await postWeather(app, { body });

    expect(res.status).toBe(413);
    expect(execute.calls).toHaveLength(0);
    expect(present.calls).toHaveLength(0);
    const parsed = (await res.json()) as WeatherResponseV1;
    expect(weatherErrorResponseV1.safeParse(parsed).success).toBe(true);
    if (parsed.ok) {
      throw new Error('expected an error response');
    }
    expect(parsed.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(parsed.error.message).toBe(PAYLOAD_TOO_LARGE_MESSAGE);
    expect(parsed.error.retryable).toBe(false);
  });

  it('limits by BYTE length, not character count (multi-byte Unicode body)', async () => {
    const execute = spyExecute(resolveResult(makeSuccessResult(makePrimaryExecution())));
    const app = mount(makeDeps({ executeOverview: execute.fn }));

    // Each '가' is 3 UTF-8 bytes but 1 UTF-16 char. Build a body whose BYTE length exceeds the limit
    // while its CHARACTER length stays well under it — a naive `text.length` check would wrongly pass.
    const baseBytes = byteLen(JSON.stringify({ location: makeLocation({ displayName: '' }) }));
    const fillerChars = Math.ceil((WEATHER_REQUEST_MAX_BYTES + 1 - baseBytes) / 3);
    const body = JSON.stringify({
      location: makeLocation({ displayName: '가'.repeat(fillerChars) }),
    });

    expect(byteLen(body)).toBeGreaterThan(WEATHER_REQUEST_MAX_BYTES);
    expect(body.length).toBeLessThan(WEATHER_REQUEST_MAX_BYTES);

    const res = await postWeather(app, { body });

    expect(res.status).toBe(413);
    expect(execute.calls).toHaveLength(0);
  });

  it('enforces the byte limit on a streamed body with no Content-Length', async () => {
    const execute = spyExecute(resolveResult(makeSuccessResult(makePrimaryExecution())));
    const app = mount(makeDeps({ executeOverview: execute.fn }));

    const base = JSON.stringify(makeValidRequestBody());
    const oversize = base + ' '.repeat(WEATHER_REQUEST_MAX_BYTES + 1 - byteLen(base));
    const bytes = encoder.encode(oversize);
    expect(bytes.length).toBe(WEATHER_REQUEST_MAX_BYTES + 1);

    // A ReadableStream body carries no Content-Length; the limit must hold on the actual stream size.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });

    const res = await app.request('/weather', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    expect(res.status).toBe(413);
    expect(execute.calls).toHaveLength(0);
  });

  // NOTE: this runtime's Request implementation does not let a client forge a Content-Length that
  // disagrees with the actual body bytes (it is a managed/forbidden header), so a "lying Content-Length"
  // cannot be constructed here. The streamed-body test above demonstrates that the limit is enforced on
  // the real byte stream, not on a trusted header.
});

// ---------------------------------------------------------------------------
// I — client cannot inject the server-owned product.
// ---------------------------------------------------------------------------

describe('POST /weather — client product injection is rejected', () => {
  it('rejects a client-supplied top-level product with 400 and never overrides the dependency product', async () => {
    const execute = spyExecute(resolveResult(makeSuccessResult(makePrimaryExecution())));
    const app = mount(makeDeps({ executeOverview: execute.fn, product: SHORT }));

    const res = await postWeather(app, {
      body: JSON.stringify({ location: makeLocation(), product: ULTRA }),
    });

    expect(res.status).toBe(400);
    expect(execute.calls).toHaveLength(0);
    const body = (await res.json()) as WeatherResponseV1;
    if (body.ok) {
      throw new Error('expected an error response');
    }
    expect(body.error.code).toBe('INVALID_REQUEST');
  });
});

// ---------------------------------------------------------------------------
// J — AbortSignal is forwarded by exact reference.
// ---------------------------------------------------------------------------

describe('POST /weather — AbortSignal pass-through', () => {
  it('forwards the exact raw-request AbortSignal (no new controller)', async () => {
    const execute = spyExecute(resolveResult(makeSuccessResult(makePrimaryExecution())));
    const meta = spyMeta(makeMeta());
    const app = mount(makeDeps({ executeOverview: execute.fn, createMeta: meta.fn }));

    const res = await postWeather(app, { body: JSON.stringify(makeValidRequestBody()) });

    expect(res.status).toBe(200);
    expect(execute.calls).toHaveLength(1);
    expect(meta.calls).toHaveLength(1);

    const signal = execute.calls[0].signal;
    expectTypeOf(signal).toEqualTypeOf<AbortSignal>();
    // createMeta received the raw Request; the signal handed to the service is that request's own signal.
    expect(signal).toBe(meta.calls[0].signal);
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});

// ---------------------------------------------------------------------------
// K — meta handling.
// ---------------------------------------------------------------------------

describe('POST /weather — response meta', () => {
  it('preserves generatedAt and a string requestId, and calls createMeta exactly once', async () => {
    const meta = spyMeta(makeMeta({ requestId: 'req_pr30_meta' }));
    const app = mount(makeDeps({ createMeta: meta.fn }));

    const res = await postWeather(app, { body: JSON.stringify(makeValidRequestBody()) });

    const body = (await res.json()) as WeatherResponseV1;
    expect(body.meta.contractVersion).toBe(CONTRACT_VERSION);
    expect(body.meta.generatedAt).toBe('2026-07-24T05:05:00+09:00');
    expect(body.meta.requestId).toBe('req_pr30_meta');
    expect(meta.calls).toHaveLength(1);
    expect(Object.keys(body.meta).sort()).toEqual([...META_KEYS]);
  });

  it('preserves a null requestId', async () => {
    const app = mount(makeDeps({ createMeta: () => makeMeta({ requestId: null }) }));

    const res = await postWeather(app, { body: JSON.stringify(makeValidRequestBody()) });
    const body = (await res.json()) as WeatherResponseV1;

    expect(body.meta.requestId).toBeNull();
    expect(weatherResponseV1.safeParse(body).success).toBe(true);
  });

  it('ignores extra runtime meta keys and always writes CONTRACT_VERSION', async () => {
    // A careless meta provider adds extra keys, including an attempt to override contractVersion. Cast
    // through unknown because these keys are intentionally absent from WeatherResponsePresenterMetaV1.
    const pollutedMeta = {
      generatedAt: '2026-07-24T05:05:00+09:00',
      requestId: 'req_extra',
      contractVersion: 999,
      serviceKey: 'META_SECRET_MUST_NOT_LEAK',
    } as unknown as WeatherResponsePresenterMetaV1;
    const app = mount(makeDeps({ createMeta: () => pollutedMeta }));

    const res = await postWeather(app, { body: JSON.stringify(makeValidRequestBody()) });
    const body = (await res.json()) as WeatherResponseV1;

    expect(body.meta.contractVersion).toBe(CONTRACT_VERSION);
    expect(Object.keys(body.meta).sort()).toEqual([...META_KEYS]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('META_SECRET_MUST_NOT_LEAK');
    expect(serialized).not.toContain('999');
  });
});

// ---------------------------------------------------------------------------
// L — invalid meta from createMeta (route infrastructure contract).
// ---------------------------------------------------------------------------

describe('POST /weather — invalid meta from createMeta', () => {
  // createMeta is trusted route infrastructure that MUST return a valid meta. A meta that fails the
  // producer schema (invalid generatedAt, empty requestId) cannot yield a contract-shaped body, so the
  // producer validation throws and the request fails as a generic 500 (Hono's default). This is NOT a
  // route logging decision; the route adds no console/logger of its own.
  it.each([
    { name: 'invalid generatedAt', meta: makeMeta({ generatedAt: 'not-a-timestamp' }) },
    { name: 'empty requestId', meta: makeMeta({ requestId: '' }) },
  ])('surfaces a %s meta as a 500 (cannot build a contract body)', async ({ meta }) => {
    // Hono's default error handler logs to console.error on an uncaught throw; mute it for clean output.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = mount(makeDeps({ createMeta: () => meta }));

    const res = await postWeather(app, { body: JSON.stringify(makeValidRequestBody()) });

    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// M — service throw → 500 INTERNAL_ERROR, no secret leak, presenter not called.
// ---------------------------------------------------------------------------

describe('POST /weather — service throw', () => {
  it('collapses a service rejection to a fixed 500 INTERNAL_ERROR without leaking the error', async () => {
    const SECRET = 'SERVICE_THROW_SECRET_MUST_NOT_LEAK';
    const execute = spyExecute(() => Promise.reject(new Error(SECRET)));
    const present = spyPresent(presentKmaLocationHourlyOverviewResponseV1);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = mount(
      makeDeps({ executeOverview: execute.fn, presentResponse: present.fn }),
    );

    const res = await postWeather(app, { body: JSON.stringify(makeValidRequestBody()) });

    expect(res.status).toBe(500);
    expect(present.calls).toHaveLength(0);
    const body = (await res.json()) as WeatherResponseV1;
    expect(weatherErrorResponseV1.safeParse(body).success).toBe(true);
    if (body.ok) {
      throw new Error('expected an error response');
    }
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe(INTERNAL_ERROR_MESSAGE);
    expect(body.error.retryable).toBe(false);
    expect(JSON.stringify(body)).not.toContain(SECRET);
    // The route caught the error itself — Hono's default logger did not run.
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// N — presenter throw → 500 INTERNAL_ERROR, no leak.
// ---------------------------------------------------------------------------

describe('POST /weather — presenter throw', () => {
  it('collapses a presenter throw to a fixed 500 INTERNAL_ERROR without leaking the error', async () => {
    const SECRET = 'PRESENTER_THROW_SECRET_MUST_NOT_LEAK';
    const present = spyPresent(() => {
      throw new Error(SECRET);
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = mount(
      makeDeps({
        executeOverview: resolveResult(makeSuccessResult(makePrimaryExecution())),
        presentResponse: present.fn,
      }),
    );

    const res = await postWeather(app, { body: JSON.stringify(makeValidRequestBody()) });

    expect(res.status).toBe(500);
    const body = (await res.json()) as WeatherResponseV1;
    if (body.ok) {
      throw new Error('expected an error response');
    }
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// O — unexpected presenter error code → 500 (never surfaced verbatim).
// ---------------------------------------------------------------------------

describe('POST /weather — unexpected presenter error code', () => {
  it('maps an unexpected presenter error code to 500 INTERNAL_ERROR without leaking the original', async () => {
    const ORIGINAL = 'UNEXPECTED_ORIGINAL_MESSAGE_MUST_NOT_LEAK';
    // A typed presenter double returns a valid WeatherErrorResponseV1 with a DIFFERENT known code.
    const present = spyPresent(() =>
      weatherErrorResponseV1.parse({
        ok: false,
        meta: {
          contractVersion: CONTRACT_VERSION,
          generatedAt: '2026-07-24T05:05:00+09:00',
          requestId: 'req_unexpected',
        },
        error: { code: 'RATE_LIMITED', message: ORIGINAL, retryable: true },
      }),
    );
    const app = mount(
      makeDeps({
        executeOverview: resolveResult(makeSuccessResult(makePrimaryExecution())),
        presentResponse: present.fn,
      }),
    );

    const res = await postWeather(app, { body: JSON.stringify(makeValidRequestBody()) });

    expect(res.status).toBe(500);
    const body = (await res.json()) as WeatherResponseV1;
    if (body.ok) {
      throw new Error('expected an error response');
    }
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe(INTERNAL_ERROR_MESSAGE);
    expect(body.error.retryable).toBe(false);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(ORIGINAL);
    expect(serialized).not.toContain('RATE_LIMITED');
  });
});

// ---------------------------------------------------------------------------
// P — exact response keys.
// ---------------------------------------------------------------------------

describe('POST /weather — exact response keys', () => {
  it('a success body has exactly ok/meta/data and meta has contractVersion/generatedAt/requestId', async () => {
    const app = mount(makeDeps());
    const res = await postWeather(app, { body: JSON.stringify(makeValidRequestBody()) });
    const body = (await res.json()) as Record<string, unknown> & { meta: object };

    expect(Object.keys(body).sort()).toEqual([...SUCCESS_TOP_KEYS]);
    expect(Object.keys(body.meta).sort()).toEqual([...META_KEYS]);
  });

  it('an error body has exactly ok/meta/error and error has code/message/retryable', async () => {
    const app = mount(makeDeps({ executeOverview: resolveResult(makeLocationFailure()) }));
    const res = await postWeather(app, { body: JSON.stringify(makeValidRequestBody()) });
    const body = (await res.json()) as Record<string, unknown> & { error: object };

    expect(Object.keys(body).sort()).toEqual([...ERROR_TOP_KEYS]);
    expect(Object.keys(body.error).sort()).toEqual([...API_ERROR_KEYS]);
  });
});

// ---------------------------------------------------------------------------
// Q — non-mutation of deeply-frozen inputs.
// ---------------------------------------------------------------------------

describe('POST /weather — non-mutation', () => {
  it('does not mutate deeply-frozen dependencies, service result, or meta', async () => {
    const result = deepFreeze(makeSuccessResult(makePreviousExecution()));
    const meta = deepFreeze(makeMeta());
    const presented = deepFreeze(presentKmaLocationHourlyOverviewResponseV1(result, meta));

    const deps = deepFreeze(
      makeDeps({
        executeOverview: resolveResult(result),
        presentResponse: () => presented,
        createMeta: () => meta,
      }),
    );
    const resultSnapshot = JSON.stringify(result);
    const metaSnapshot = JSON.stringify(meta);

    const app = mount(deps);
    const res = await postWeather(app, { body: JSON.stringify(makeValidRequestBody()) });

    expect(res.status).toBe(200);
    expect(JSON.stringify(result)).toBe(resultSnapshot);
    expect(JSON.stringify(meta)).toBe(metaSnapshot);
  });
});

// ---------------------------------------------------------------------------
// R — no clock / randomness / logging / network side effects.
// ---------------------------------------------------------------------------

describe('POST /weather — side effects', () => {
  it('reads no clock/randomness, logs nothing, and calls no fetch on the success path', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const nowSpy = vi.spyOn(Date, 'now');
    const randomSpy = vi.spyOn(Math, 'random');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((() => {
      throw new Error('fetch must not be called');
    }) as typeof fetch);

    const app = mount(makeDeps());
    const res = await postWeather(app, { body: JSON.stringify(makeValidRequestBody()) });

    expect(res.status).toBe(200);
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(nowSpy).not.toHaveBeenCalled();
    expect(randomSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// S — factory isolation.
// ---------------------------------------------------------------------------

describe('POST /weather — factory isolation', () => {
  it('keeps two factories independent (own product/service/meta, no shared state)', async () => {
    const executeA = spyExecute(resolveResult(makeSuccessResult(makePrimaryExecution())));
    const executeB = spyExecute(resolveResult(makeSuccessResult(makePreviousExecution())));

    const appA = mount(
      makeDeps({ executeOverview: executeA.fn, product: SHORT, createMeta: () => makeMeta({ requestId: 'A' }) }),
    );
    const appB = mount(
      makeDeps({ executeOverview: executeB.fn, product: ULTRA, createMeta: () => makeMeta({ requestId: 'B' }) }),
    );

    const [resA, resB] = await Promise.all([
      postWeather(appA, { body: JSON.stringify(makeValidRequestBody()) }),
      postWeather(appB, { body: JSON.stringify(makeValidRequestBody()) }),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(executeA.calls).toHaveLength(1);
    expect(executeB.calls).toHaveLength(1);
    expect(executeA.calls[0].input.product).toBe(SHORT);
    expect(executeB.calls[0].input.product).toBe(ULTRA);

    const bodyA = (await resA.json()) as WeatherResponseV1;
    const bodyB = (await resB.json()) as WeatherResponseV1;
    expect(bodyA.meta.requestId).toBe('A');
    expect(bodyB.meta.requestId).toBe('B');
  });
});

// ---------------------------------------------------------------------------
// T — method/path: only POST / is registered on the sub-app.
// ---------------------------------------------------------------------------

describe('POST /weather — method/path scope', () => {
  it('does not run the POST handler for GET /weather', async () => {
    const execute = spyExecute(resolveResult(makeSuccessResult(makePrimaryExecution())));
    const app = mount(makeDeps({ executeOverview: execute.fn }));

    const res = await app.request('/weather', { method: 'GET' });

    expect(res.status).toBe(404);
    expect(execute.calls).toHaveLength(0);
  });

  it('does not match POST /unknown on the parent', async () => {
    const execute = spyExecute(resolveResult(makeSuccessResult(makePrimaryExecution())));
    const app = mount(makeDeps({ executeOverview: execute.fn }));

    const res = await postWeatherPath(app, '/unknown');

    expect(res.status).toBe(404);
    expect(execute.calls).toHaveLength(0);
  });

  it('does not register POST / on the parent (the sub-app only owns /)', async () => {
    const execute = spyExecute(resolveResult(makeSuccessResult(makePrimaryExecution())));
    const app = mount(makeDeps({ executeOverview: execute.fn }));

    const res = await postWeatherPath(app, '/');

    expect(res.status).toBe(404);
    expect(execute.calls).toHaveLength(0);
  });

  it('registers no health route on the sub-app', async () => {
    const app = mount(makeDeps());
    const res = await app.request('/weather/health', { method: 'GET' });
    expect(res.status).toBe(404);
  });
});

function postWeatherPath(app: Hono, path: string): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeValidRequestBody()),
    }),
  );
}

// ---------------------------------------------------------------------------
// Type-level contracts.
// ---------------------------------------------------------------------------

describe('createWeatherRoute — type contracts', () => {
  it('returns a Hono sub-app synchronously (never a Promise)', () => {
    type Returned = ReturnType<typeof createWeatherRoute>;
    expectTypeOf<Returned>().toExtend<Hono>();
    expectTypeOf<Returned>().not.toExtend<Promise<unknown>>();
  });

  it('binds the dependency port, product, presenter, and meta to the real types', () => {
    expectTypeOf<WeatherRouteDependencies['product']>().toEqualTypeOf<
      KmaLocationHourlyOverviewInput['product']
    >();
    expectTypeOf<Parameters<WeatherRouteExecuteOverview>[0]>().toEqualTypeOf<KmaLocationHourlyOverviewInput>();
    expectTypeOf<Parameters<WeatherRouteExecuteOverview>[1]>().toEqualTypeOf<AbortSignal>();
    expectTypeOf<ReturnType<WeatherRouteExecuteOverview>>().toEqualTypeOf<
      Promise<KmaLocationHourlyOverviewResult>
    >();
    expectTypeOf<WeatherRouteDependencies['presentResponse']>().toEqualTypeOf<
      typeof presentKmaLocationHourlyOverviewResponseV1
    >();
    expectTypeOf<ReturnType<WeatherRouteDependencies['createMeta']>>().toEqualTypeOf<WeatherResponsePresenterMetaV1>();
  });

  it('has readonly dependencies (compile-time)', () => {
    function _readonlyCheck(deps: WeatherRouteDependencies): void {
      // @ts-expect-error product is readonly and cannot be reassigned.
      deps.product = deps.product;
      // @ts-expect-error executeOverview is readonly and cannot be reassigned.
      deps.executeOverview = deps.executeOverview;
    }
    expect(typeof _readonlyCheck).toBe('function');
  });

  it('the public request contract carries no product', () => {
    expectTypeOf<WeatherRequestV1>().not.toHaveProperty('product');
  });
});
