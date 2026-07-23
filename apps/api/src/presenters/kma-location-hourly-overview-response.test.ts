import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  CONTRACT_VERSION,
  weatherOverview,
  weatherResponseV1,
  type ApiErrorV1,
  type HourlyForecast,
  type WeatherDataSection,
  type WeatherErrorResponseV1,
  type WeatherLocation,
  type WeatherOverview,
  type WeatherResponseV1,
} from '@life-weather/contracts';
import { KmaForecastProduct } from '@life-weather/weather-core';

import {
  assembleKmaHourlyWeatherOverview,
  selectKmaHourlyFallbackResult,
  type KmaForecastIssuanceIdentity,
  type KmaHourlyFallbackSelection,
  type KmaHourlyFallbackServiceResult,
  type KmaHourlySourceMetadataInput,
  type KmaLocationHourlyOverviewResult,
} from '../services';

import {
  presentKmaLocationHourlyOverviewResponseV1,
  type WeatherResponsePresenterMetaV1,
} from './kma-location-hourly-overview-response';

/**
 * These tests exercise the PR #29 response presenter in isolation. Success/no-selection fixtures are
 * built by running the REAL PR #22 selector and PR #23 assembler over a hand-built execution trace, so
 * the `selection`/`overview` are structurally exactly what the PR #24 service would produce. The LOCATION
 * failure is the value-free facade discriminator. Every mutable fixture is fresh per call so no test
 * shares a mutable result/selection/overview/meta object.
 */

const SHORT = KmaForecastProduct.SHORT_FORECAST;

// Unique markers so a leak is detectable by a substring scan of the serialized response. These are NOT
// real keys or real credentials — just sentinel strings that must never appear in a mobile response.
const SELECTION_SECRET = 'PR29_INTERNAL_SELECTION_SECRET_MUST_NOT_LEAK';
const SERVICE_KEY_SECRET = 'PR29_SERVICE_KEY_SECRET_MUST_NOT_LEAK';
const RAW_UPSTREAM_SECRET = 'PR29_RAW_UPSTREAM_SECRET_MUST_NOT_LEAK';

/** Internal keys that must never appear at any depth of a serialized response (from the design). */
const FORBIDDEN_KEYS = [
  'selection',
  'execution',
  'primary',
  'previous',
  'attempts',
  'attempt',
  'trace',
  'requestPlan',
  'plan',
  'product',
  'fallbackUsed',
  'selected',
  'sourceSelection',
  'primaryIssuance',
  'previousIssuance',
  'baseDate',
  'baseTime',
  'nx',
  'ny',
  'grid',
  'kmaGrid',
  'serviceKey',
  'KMA_SERVICE_KEY',
  'url',
  'query',
  'raw',
  'rawBody',
  'resultMsg',
  'environment',
  'dependencies',
  'providerConfig',
] as const;

// Exact own-key sets (sorted).
const SUCCESS_TOP_KEYS = ['data', 'meta', 'ok'] as const;
const ERROR_TOP_KEYS = ['error', 'meta', 'ok'] as const;
const META_KEYS = ['contractVersion', 'generatedAt', 'requestId'] as const;
const API_ERROR_KEYS = ['code', 'message', 'retryable'] as const;

const UNSUPPORTED_LOCATION_MESSAGE = 'The requested location is not supported.';

// ---------------------------------------------------------------------------
// Fixture builders.
// ---------------------------------------------------------------------------

/** A fresh, complete, schema-valid `HourlyForecast`; `forecastAt` overridable for distinct entries. */
function makeHourly(forecastAt = '2026-07-22T14:00:00+09:00'): HourlyForecast {
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

/** A fresh, complete, schema-valid `WeatherLocation`. */
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

/** A fresh caller-supplied response meta (`generatedAt` + `requestId` only). */
function makeMeta(
  overrides: Partial<WeatherResponsePresenterMetaV1> = {},
): WeatherResponsePresenterMetaV1 {
  return {
    generatedAt: '2026-07-22T05:05:00+09:00',
    requestId: 'req_pr29_abc123',
    ...overrides,
  };
}

/** A fresh selected-source provenance context. */
function makeSourceMetadata(
  overrides: Partial<KmaHourlySourceMetadataInput> = {},
): KmaHourlySourceMetadataInput {
  return {
    sourceId: 'kma-short-forecast-hourly',
    issuedAt: '2026-07-22T05:00:00+09:00',
    fetchedAt: '2026-07-22T05:05:00+09:00',
    retrievalMode: 'LIVE',
    ...overrides,
  };
}

function makePrimaryIssuance(): KmaForecastIssuanceIdentity {
  return { product: SHORT, baseDate: '20260722', baseTime: '0500' };
}

function makePreviousIssuance(): KmaForecastIssuanceIdentity {
  return { product: SHORT, baseDate: '20260722', baseTime: '0200' };
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

/** A fallback trace: empty primary, usable previous → selector picks PREVIOUS (fallbackUsed: true). */
function makePreviousExecution(
  previousHourly: readonly HourlyForecast[] = [makeHourly('2026-07-22T13:00:00+09:00')],
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

/** A no-fallback trace whose primary is an empty success → selector picks nothing (no selection). */
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
  let overview: WeatherOverview;
  if (selection.selected) {
    overview = assembleKmaHourlyWeatherOverview({
      location,
      selection,
      source: makeSourceMetadata(),
    });
  } else {
    overview = assembleKmaHourlyWeatherOverview({ location, selection, source: null });
  }
  return { ok: true, selection, overview };
}

/** The value-free LOCATION passthrough failure. */
function makeLocationFailure(): KmaLocationHourlyOverviewResult {
  return {
    ok: false,
    stage: 'LOCATION',
    error: { kind: 'UNSUPPORTED_LOCATION' },
  };
}

// ---------------------------------------------------------------------------
// Assertion helpers.
// ---------------------------------------------------------------------------

/** Recursively collect every object own-key found anywhere in a value. */
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

/** Assert no forbidden internal key appears at any depth of the response. */
function expectNoForbiddenKeys(response: WeatherResponseV1): void {
  const present = collectKeys(response);
  for (const forbidden of FORBIDDEN_KEYS) {
    expect(present.has(forbidden)).toBe(false);
  }
}

/** Capture whatever a thunk throws synchronously, or `undefined` when it does not throw. */
function captureSynchronousError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Recursively freeze so any attempted mutation would throw in strict mode. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Attach forbidden internal keys + unique secret markers to a success result's `selection` (and a
 * nested object) so a leak is detectable. Cast through `unknown` (never `as any`) because these keys
 * deliberately do not exist on the typed internal contract — the whole point is to prove the presenter
 * copies none of them. A fresh object is built; the caller fixture is not mutated.
 */
function withInternalSecrets(
  result: Extract<KmaLocationHourlyOverviewResult, { readonly ok: true }>,
): KmaLocationHourlyOverviewResult {
  const pollutedSelection = {
    ...result.selection,
    serviceKey: SERVICE_KEY_SECRET,
    KMA_SERVICE_KEY: SERVICE_KEY_SECRET,
    url: `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst?serviceKey=${SERVICE_KEY_SECRET}`,
    query: { serviceKey: SERVICE_KEY_SECRET, nx: 60, ny: 127 },
    rawBody: RAW_UPSTREAM_SECRET,
    resultMsg: RAW_UPSTREAM_SECRET,
    nx: 60,
    ny: 127,
    baseDate: '20260722',
    baseTime: '0500',
    internalMarker: SELECTION_SECRET,
  };
  return {
    ok: true,
    selection: pollutedSelection,
    overview: result.overview,
  } as unknown as KmaLocationHourlyOverviewResult;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixture sanity.
// ---------------------------------------------------------------------------

describe('fixture sanity', () => {
  it('builds a contracts-valid success overview and a real selection', () => {
    const result = makeSuccessResult(makePrimaryExecution());
    expect(result.selection.selected).toBe(true);
    expect(weatherOverview.safeParse(result.overview).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A — PRIMARY selected success.
// ---------------------------------------------------------------------------

describe('presentKmaLocationHourlyOverviewResponseV1 — PRIMARY success', () => {
  it('maps a PRIMARY-selected result to a mobile-safe success response', () => {
    const hourly = [
      makeHourly('2026-07-22T14:00:00+09:00'),
      makeHourly('2026-07-22T15:00:00+09:00'),
    ];
    const result = makeSuccessResult(makePrimaryExecution(hourly));
    expect(result.selection.source).toBe('PRIMARY');

    const meta = makeMeta();
    const response = presentKmaLocationHourlyOverviewResponseV1(result, meta);

    expect(response.ok).toBe(true);
    expect(weatherResponseV1.safeParse(response).success).toBe(true);

    if (!response.ok) {
      throw new Error('expected a success response');
    }
    expect(response.meta.contractVersion).toBe(1);
    expect(response.meta.contractVersion).toBe(CONTRACT_VERSION);
    expect(response.meta.generatedAt).toBe(meta.generatedAt);
    expect(response.meta.requestId).toBe(meta.requestId);

    // `data` is the overview only, structurally equal to the internal overview and schema-valid.
    expect(weatherOverview.safeParse(response.data).success).toBe(true);
    expect(response.data).toEqual(result.overview);
    expect(response.data.hourly.map((entry) => entry.forecastAt)).toEqual([
      '2026-07-22T14:00:00+09:00',
      '2026-07-22T15:00:00+09:00',
    ]);

    // Exact key contracts; no selection.
    expect(Object.keys(response).sort()).toEqual([...SUCCESS_TOP_KEYS]);
    expect(Object.keys(response.meta).sort()).toEqual([...META_KEYS]);
    expect(response).not.toHaveProperty('selection');
    expectNoForbiddenKeys(response);
  });
});

// ---------------------------------------------------------------------------
// B — PREVIOUS selected success.
// ---------------------------------------------------------------------------

describe('presentKmaLocationHourlyOverviewResponseV1 — PREVIOUS success', () => {
  it('maps a PREVIOUS-selected (fallback) result to the same success shape without trace', () => {
    const previousHourly = [makeHourly('2026-07-22T11:00:00+09:00')];
    const result = makeSuccessResult(makePreviousExecution(previousHourly));
    expect(result.selection.source).toBe('PREVIOUS');
    if (result.selection.selected) {
      expect(result.selection.fallbackUsed).toBe(true);
    }

    const response = presentKmaLocationHourlyOverviewResponseV1(result, makeMeta());

    expect(response.ok).toBe(true);
    if (!response.ok) {
      throw new Error('expected a success response');
    }
    // Only the public overview reaches `data`; no fallback/selection trace leaks.
    expect(response.data.hourly).toEqual(previousHourly);
    expect(response.data.sources).toHaveLength(1);
    expect(Object.keys(response).sort()).toEqual([...SUCCESS_TOP_KEYS]);
    expect(response).not.toHaveProperty('selection');
    expectNoForbiddenKeys(response);
    expect(weatherResponseV1.safeParse(response).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C — no-selection success (never promoted to an error).
// ---------------------------------------------------------------------------

describe('presentKmaLocationHourlyOverviewResponseV1 — no-selection success', () => {
  it('maps a no-selection result to a success (not an error) response', () => {
    const result = makeSuccessResult(makeNoSelectionExecution());
    expect(result.selection.selected).toBe(false);
    expect(result.overview.hourly).toEqual([]);
    expect(result.overview.sources).toEqual([]);
    expect(result.overview.missingSections).toContain('HOURLY');

    const response = presentKmaLocationHourlyOverviewResponseV1(result, makeMeta());

    // A no-selection overview is a valid public success, not an API error.
    expect(response.ok).toBe(true);
    if (!response.ok) {
      throw new Error('expected a success response');
    }
    expect(weatherOverview.safeParse(response.data).success).toBe(true);
    expect(response.data.hourly).toEqual([]);
    expect(response.data.missingSections).toContain('HOURLY');
    expect(Object.keys(response).sort()).toEqual([...SUCCESS_TOP_KEYS]);
    expect(response).not.toHaveProperty('selection');
    expect(response).not.toHaveProperty('error');
    expectNoForbiddenKeys(response);
    expect(weatherResponseV1.safeParse(response).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D — LOCATION failure.
// ---------------------------------------------------------------------------

describe('presentKmaLocationHourlyOverviewResponseV1 — LOCATION failure', () => {
  it('maps a LOCATION failure to a stable UNSUPPORTED_LOCATION error response', () => {
    const meta = makeMeta();
    const response = presentKmaLocationHourlyOverviewResponseV1(
      makeLocationFailure(),
      meta,
    );

    expect(response.ok).toBe(false);
    if (response.ok) {
      throw new Error('expected an error response');
    }
    expect(response.error.code).toBe('UNSUPPORTED_LOCATION');
    expect(response.error.message).toBe(UNSUPPORTED_LOCATION_MESSAGE);
    expect(response.error.retryable).toBe(false);

    // Meta is normal.
    expect(response.meta.contractVersion).toBe(CONTRACT_VERSION);
    expect(response.meta.generatedAt).toBe(meta.generatedAt);
    expect(response.meta.requestId).toBe(meta.requestId);

    // No data key; exact error keys; no internal stage/kind/coordinate leaks.
    expect(response).not.toHaveProperty('data');
    expect(Object.keys(response).sort()).toEqual([...ERROR_TOP_KEYS]);
    expect(Object.keys(response.error).sort()).toEqual([...API_ERROR_KEYS]);
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain('stage');
    expect(serialized).not.toContain('kind');
    expect(serialized).not.toContain('UNSUPPORTED_LOCATION_ERROR');
    expectNoForbiddenKeys(response);
    expect(weatherResponseV1.safeParse(response).success).toBe(true);
  });

  it('carries the requestId (incl. null) into the error meta', () => {
    const response = presentKmaLocationHourlyOverviewResponseV1(
      makeLocationFailure(),
      makeMeta({ requestId: null }),
    );
    if (response.ok) {
      throw new Error('expected an error response');
    }
    expect(response.meta.requestId).toBeNull();
    expect(weatherResponseV1.safeParse(response).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// E — exact keys (success and error), stably sorted.
// ---------------------------------------------------------------------------

describe('presentKmaLocationHourlyOverviewResponseV1 — exact keys', () => {
  it('success has exactly data/meta/ok and meta has contractVersion/generatedAt/requestId', () => {
    const response = presentKmaLocationHourlyOverviewResponseV1(
      makeSuccessResult(makePrimaryExecution()),
      makeMeta(),
    );
    expect(Object.keys(response).sort()).toEqual([...SUCCESS_TOP_KEYS]);
    expect(Object.keys(response.meta).sort()).toEqual([...META_KEYS]);
    expect(response).not.toHaveProperty('selection');
    expect(response).not.toHaveProperty('error');
  });

  it('error has exactly error/meta/ok and the real ApiErrorV1 own keys', () => {
    const response = presentKmaLocationHourlyOverviewResponseV1(
      makeLocationFailure(),
      makeMeta(),
    );
    expect(Object.keys(response).sort()).toEqual([...ERROR_TOP_KEYS]);
    if (response.ok) {
      throw new Error('expected an error response');
    }
    expect(Object.keys(response.error).sort()).toEqual([...API_ERROR_KEYS]);
    expect(response).not.toHaveProperty('data');
  });
});

// ---------------------------------------------------------------------------
// F — internal extra keys (selection secrets) never leak.
// ---------------------------------------------------------------------------

describe('presentKmaLocationHourlyOverviewResponseV1 — internal secret non-leakage', () => {
  it('never copies selection, its trace, or injected secret keys into a success response', () => {
    const polluted = withInternalSecrets(makeSuccessResult(makePrimaryExecution()));

    const response = presentKmaLocationHourlyOverviewResponseV1(polluted, makeMeta());

    if (!response.ok) {
      throw new Error('expected a success response');
    }
    // The real selection already carries `execution`/`selected`/`fallbackUsed`/`result` and a nested
    // `primaryIssuance`; none — nor the injected forbidden keys — may appear anywhere.
    expectNoForbiddenKeys(response);

    const serialized = JSON.stringify(response);
    for (const secret of [SELECTION_SECRET, SERVICE_KEY_SECRET, RAW_UPSTREAM_SECRET]) {
      expect(serialized).not.toContain(secret);
    }
    // The provider-native grid values injected on the selection must not survive either.
    expect(serialized).not.toContain('"nx"');
    expect(serialized).not.toContain('"20260722"');
    // The response is still exactly the mobile-safe success shape.
    expect(Object.keys(response).sort()).toEqual([...SUCCESS_TOP_KEYS]);
  });
});

// ---------------------------------------------------------------------------
// G — caller `meta` extra keys never leak; contractVersion is always CONTRACT_VERSION.
// ---------------------------------------------------------------------------

describe('presentKmaLocationHourlyOverviewResponseV1 — meta extra-key non-leakage', () => {
  it('ignores extra runtime meta keys and always writes CONTRACT_VERSION', () => {
    // A hostile/careless caller adds extra keys, including an attempt to override contractVersion. Cast
    // through `unknown` because these keys are intentionally absent from WeatherResponsePresenterMetaV1.
    const pollutedMeta = {
      generatedAt: '2026-07-22T05:05:00+09:00',
      requestId: 'req_pr29_meta',
      contractVersion: 999,
      serviceKey: SERVICE_KEY_SECRET,
      generatedBy: 'internal-service',
      internalTrace: SELECTION_SECRET,
    } as unknown as WeatherResponsePresenterMetaV1;

    const response = presentKmaLocationHourlyOverviewResponseV1(
      makeSuccessResult(makePrimaryExecution()),
      pollutedMeta,
    );

    expect(response.meta.contractVersion).toBe(CONTRACT_VERSION);
    expect(response.meta.contractVersion).not.toBe(999);
    expect(Object.keys(response.meta).sort()).toEqual([...META_KEYS]);

    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain(SERVICE_KEY_SECRET);
    expect(serialized).not.toContain(SELECTION_SECRET);
    expect(serialized).not.toContain('generatedBy');
    expect(serialized).not.toContain('999');
  });
});

// ---------------------------------------------------------------------------
// H — invalid generatedAt → synchronous ZodError (never caught/converted).
// ---------------------------------------------------------------------------

describe('presentKmaLocationHourlyOverviewResponseV1 — invalid generatedAt', () => {
  const invalidGeneratedAt = [
    { name: 'no timezone', value: '2026-07-22T05:05:00' },
    { name: 'no seconds', value: '2026-07-22T05:05+09:00' },
    { name: 'arbitrary fractional seconds', value: '2026-07-22T05:05:00.1+09:00' },
    { name: 'empty string', value: '' },
  ] as const;

  for (const { name, value } of invalidGeneratedAt) {
    it(`throws a synchronous ZodError for a ${name} generatedAt`, () => {
      const result = makeSuccessResult(makePrimaryExecution());
      const error = captureSynchronousError(() =>
        presentKmaLocationHourlyOverviewResponseV1(result, makeMeta({ generatedAt: value })),
      );
      expect((error as { name?: string }).name).toBe('ZodError');
    });
  }
});

// ---------------------------------------------------------------------------
// I — requestId policy: empty string rejected; null accepted (nullable).
// ---------------------------------------------------------------------------

describe('presentKmaLocationHourlyOverviewResponseV1 — requestId validation', () => {
  it('throws a synchronous ZodError for an empty-string requestId', () => {
    const result = makeSuccessResult(makePrimaryExecution());
    const error = captureSynchronousError(() =>
      presentKmaLocationHourlyOverviewResponseV1(result, makeMeta({ requestId: '' })),
    );
    expect((error as { name?: string }).name).toBe('ZodError');
  });

  it('accepts a null requestId (the contract makes it nullable)', () => {
    const response = presentKmaLocationHourlyOverviewResponseV1(
      makeSuccessResult(makePrimaryExecution()),
      makeMeta({ requestId: null }),
    );
    if (!response.ok) {
      throw new Error('expected a success response');
    }
    expect(response.meta.requestId).toBeNull();
    expect(weatherResponseV1.safeParse(response).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// J — invalid overview → producer-side ZodError (never a bad success response).
// ---------------------------------------------------------------------------

describe('presentKmaLocationHourlyOverviewResponseV1 — invalid overview producer validation', () => {
  it('throws a ZodError when hourly has entries but HOURLY is marked missing', () => {
    const base = makeSuccessResult(makePrimaryExecution());
    // `missingSections` is typed `WeatherDataSection[]` and `HOURLY` is a valid member, so this needs no
    // cast — the type allows it; only the runtime `superRefine` rejects the contradiction.
    const brokenMissing: WeatherDataSection[] = [
      ...base.overview.missingSections,
      'HOURLY',
    ];
    const result: Extract<KmaLocationHourlyOverviewResult, { readonly ok: true }> = {
      ok: true,
      selection: base.selection,
      overview: { ...base.overview, missingSections: brokenMissing },
    };

    const error = captureSynchronousError(() =>
      presentKmaLocationHourlyOverviewResponseV1(result, makeMeta()),
    );
    expect((error as { name?: string }).name).toBe('ZodError');
  });

  it('throws a ZodError when current is null but CURRENT is not marked missing', () => {
    const base = makeSuccessResult(makePrimaryExecution());
    const brokenMissing: WeatherDataSection[] = base.overview.missingSections.filter(
      (section) => section !== 'CURRENT',
    );
    const result: Extract<KmaLocationHourlyOverviewResult, { readonly ok: true }> = {
      ok: true,
      selection: base.selection,
      overview: { ...base.overview, missingSections: brokenMissing },
    };

    const error = captureSynchronousError(() =>
      presentKmaLocationHourlyOverviewResponseV1(result, makeMeta()),
    );
    expect((error as { name?: string }).name).toBe('ZodError');
  });
});

// ---------------------------------------------------------------------------
// K — non-mutation of deeply-frozen inputs.
// ---------------------------------------------------------------------------

describe('presentKmaLocationHourlyOverviewResponseV1 — non-mutation', () => {
  it('does not mutate a deeply-frozen success result or meta', () => {
    const result = deepFreeze(makeSuccessResult(makePreviousExecution()));
    const meta = deepFreeze(makeMeta());
    const resultSnapshot = JSON.stringify(result);
    const metaSnapshot = JSON.stringify(meta);

    const response = presentKmaLocationHourlyOverviewResponseV1(result, meta);

    expect(response.ok).toBe(true);
    expect(JSON.stringify(result)).toBe(resultSnapshot);
    expect(JSON.stringify(meta)).toBe(metaSnapshot);
  });

  it('does not mutate a deeply-frozen LOCATION failure or meta', () => {
    const failure = deepFreeze(makeLocationFailure());
    const meta = deepFreeze(makeMeta());
    const failureSnapshot = JSON.stringify(failure);
    const metaSnapshot = JSON.stringify(meta);

    const response = presentKmaLocationHourlyOverviewResponseV1(failure, meta);

    expect(response.ok).toBe(false);
    expect(JSON.stringify(failure)).toBe(failureSnapshot);
    expect(JSON.stringify(meta)).toBe(metaSnapshot);
  });
});

// ---------------------------------------------------------------------------
// L — fresh wrapper on repeated calls.
// ---------------------------------------------------------------------------

describe('presentKmaLocationHourlyOverviewResponseV1 — fresh wrapper', () => {
  it('returns deep-equal but reference-distinct wrappers for the same input', () => {
    const result = makeSuccessResult(makePrimaryExecution());
    const meta = makeMeta();

    const first = presentKmaLocationHourlyOverviewResponseV1(result, meta);
    const second = presentKmaLocationHourlyOverviewResponseV1(result, meta);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.meta).not.toBe(second.meta);
  });

  it('returns distinct wrappers for repeated LOCATION failures', () => {
    const meta = makeMeta();
    const first = presentKmaLocationHourlyOverviewResponseV1(makeLocationFailure(), meta);
    const second = presentKmaLocationHourlyOverviewResponseV1(makeLocationFailure(), meta);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.meta).not.toBe(second.meta);
  });
});

// ---------------------------------------------------------------------------
// M — purity: no console, clock, randomness, or network.
// ---------------------------------------------------------------------------

describe('presentKmaLocationHourlyOverviewResponseV1 — side effects', () => {
  it('never logs, reads the clock, uses randomness, or calls fetch on any path', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const nowSpy = vi.spyOn(Date, 'now');
    const randomSpy = vi.spyOn(Math, 'random');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((() => {
        throw new Error('fetch must not be called');
      }) as typeof fetch);

    presentKmaLocationHourlyOverviewResponseV1(
      makeSuccessResult(makePrimaryExecution()),
      makeMeta(),
    );
    presentKmaLocationHourlyOverviewResponseV1(
      makeSuccessResult(makeNoSelectionExecution()),
      makeMeta(),
    );
    presentKmaLocationHourlyOverviewResponseV1(makeLocationFailure(), makeMeta());

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(nowSpy).not.toHaveBeenCalled();
    expect(randomSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §14 — type-level contracts.
// ---------------------------------------------------------------------------

describe('presentKmaLocationHourlyOverviewResponseV1 — type contracts', () => {
  it('has the expected public signature and meta shape', () => {
    // Return type is exactly WeatherResponseV1 (a synchronous value, never a Promise).
    expectTypeOf(
      presentKmaLocationHourlyOverviewResponseV1,
    ).returns.toEqualTypeOf<WeatherResponseV1>();

    // First parameter is the internal application result.
    expectTypeOf(presentKmaLocationHourlyOverviewResponseV1)
      .parameter(0)
      .toEqualTypeOf<KmaLocationHourlyOverviewResult>();

    // The caller meta has exactly generatedAt/requestId — never contractVersion.
    expectTypeOf<keyof WeatherResponsePresenterMetaV1>().toEqualTypeOf<
      'generatedAt' | 'requestId'
    >();
    expectTypeOf<WeatherResponsePresenterMetaV1>().not.toHaveProperty(
      'contractVersion',
    );

    // WeatherResponseV1 never exposes an internal selection; its error arm is WeatherErrorResponseV1.
    expectTypeOf<WeatherResponseV1>().not.toHaveProperty('selection');
    expectTypeOf<
      Extract<WeatherResponseV1, { readonly ok: false }>
    >().toEqualTypeOf<WeatherErrorResponseV1>();

    // The error body type used by the presenter is the real ApiErrorV1 (has retryable, not details).
    expectTypeOf<ApiErrorV1>().toHaveProperty('retryable');
    expectTypeOf<ApiErrorV1>().not.toHaveProperty('details');
  });
});

// ---------------------------------------------------------------------------
// §14b — exhaustive-guard regression (compile-time). The presenter's `satisfies` guard is fixed on
// BOTH `stage` and `error.kind`, so a future same-stage arm with a different kind cannot be silently
// published as UNSUPPORTED_LOCATION. These are type-level assertions; `expectTypeOf(...)` erases at
// runtime, so this block adds no runtime behavior beyond the single `it` wrapper.
// ---------------------------------------------------------------------------

describe('presentKmaLocationHourlyOverviewResponseV1 — exhaustive guard', () => {
  it('pins every current LOCATION failure to exactly the supported UNSUPPORTED_LOCATION arm', () => {
    // Every LOCATION-stage failure the result union carries today (extracted on `stage` alone)...
    type CurrentLocationFailure = Extract<
      KmaLocationHourlyOverviewResult,
      { readonly stage: 'LOCATION' }
    >;
    // ...and the single arm the presenter actually supports (stage LOCATION + kind UNSUPPORTED_LOCATION),
    // which is exactly what the production `UnsupportedLocationFailure` guard type resolves to.
    type SupportedUnsupportedLocationFailure = Extract<
      KmaLocationHourlyOverviewResult,
      {
        readonly stage: 'LOCATION';
        readonly error: { readonly kind: 'UNSUPPORTED_LOCATION' };
      }
    >;

    // (A) Exact equality: today every LOCATION failure IS the supported arm. If a future LOCATION arm
    // with a different `error.kind` is added, the stage-only extraction gains that arm, the two types
    // diverge, and typecheck fails here — the same signal that breaks the presenter's `satisfies` guard.
    expectTypeOf<CurrentLocationFailure>().toEqualTypeOf<SupportedUnsupportedLocationFailure>();

    // (B) A hypothetical future same-stage / different-kind arm...
    type SimulatedAmbiguousLocationFailure = {
      readonly ok: false;
      readonly stage: 'LOCATION';
      readonly error: { readonly kind: 'AMBIGUOUS_LOCATION' };
    };
    // ...added alongside the supported arm is NOT assignable to the supported arm. This is the precise
    // property the presenter's `result satisfies UnsupportedLocationFailure` guard relies on: were the
    // union to become the non-success arm, that `satisfies` line would stop compiling — proving a new
    // error kind can never be silently accepted as, and downgraded to, UNSUPPORTED_LOCATION.
    type SimulatedFutureLocationFailures =
      | SupportedUnsupportedLocationFailure
      | SimulatedAmbiguousLocationFailure;
    expectTypeOf<
      SimulatedFutureLocationFailures
    >().not.toExtend<SupportedUnsupportedLocationFailure>();
  });
});
