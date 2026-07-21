import { afterEach, describe, expect, it, vi } from 'vitest';

import { hourlyForecast, type HourlyForecast } from '@life-weather/contracts';
import { KmaForecastProduct } from '@life-weather/weather-core';

import type {
  KmaForecastProvider,
  KmaForecastProviderError,
  KmaForecastProviderResult,
  KmaForecastProviderSuccess,
  KmaForecastRequest,
  KmaHourlyNormalizationIssue,
} from '../providers/kma';
import {
  classifyKmaHourlyFallbackEligibility,
  type KmaHourlyFallbackEligibility,
} from './kma-hourly-fallback-eligibility';
import {
  createKmaHourlyForecastService,
  type KmaHourlyForecastServiceResult,
} from './kma-hourly-forecast';

const SHORT = KmaForecastProduct.SHORT_FORECAST;

/** A unique, non-secret marker used to prove no raw input value reaches the classifier result. */
const RAW_MARKER = 'RAW_KMA_ELIGIBILITY_MUST_NOT_LEAK_9C2E';

/** The 기상청 NODATA_ERROR upstream code — the sole eligible upstream code. */
const NO_DATA_CODE = '03';

/**
 * Two complete, schema-valid `HourlyForecast` fixtures. Each is written as a full literal (never a
 * spread of `Partial`, so `satisfies` keeps every field's exact type) and is module-scope immutable.
 */
const HOURLY_A = {
  forecastAt: '2026-07-17T14:00:00+09:00',
  condition: 'CLEAR',
  temperatureCelsius: 25.5,
  feelsLikeCelsius: null,
  precipitationProbabilityPercent: 20,
  precipitationAmountMillimeters: 1,
  snowfallAmountCentimeters: 0,
  humidityPercent: 55,
  windSpeedMetersPerSecond: 3.4,
  windDirectionDegrees: 270,
} satisfies HourlyForecast;

const HOURLY_B = {
  forecastAt: '2026-07-17T15:00:00+09:00',
  condition: 'RAIN',
  temperatureCelsius: 22,
  feelsLikeCelsius: null,
  precipitationProbabilityPercent: 80,
  precipitationAmountMillimeters: 3,
  snowfallAmountCentimeters: null,
  humidityPercent: 90,
  windSpeedMetersPerSecond: 5,
  windDirectionDegrees: 180,
} satisfies HourlyForecast;

/** A complete, already-built request for the service integration cases. */
const REQUEST: KmaForecastRequest = {
  product: SHORT,
  baseDate: '20260717',
  baseTime: '0500',
  nx: 60,
  ny: 127,
};

/** Recursively freeze so any mutation of the input would throw in strict mode. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** A fresh empty-success result. Built per call so no test shares a mutable result object. */
function emptySuccess(): KmaHourlyForecastServiceResult {
  return { ok: true, hourly: [] };
}

/** A fresh non-empty-success result with the given hourly entries. */
function nonEmptySuccess(
  hourly: readonly HourlyForecast[],
): KmaHourlyForecastServiceResult {
  return { ok: true, hourly };
}

/** A fresh `PROVIDER`-stage result wrapping the given provider error. */
function providerFailure(
  error: KmaForecastProviderError,
): KmaHourlyForecastServiceResult {
  return { ok: false, stage: 'PROVIDER', error };
}

/** A fresh `NORMALIZATION`-stage result carrying the given issues. */
function normalizationFailure(
  issues: readonly KmaHourlyNormalizationIssue[],
): KmaHourlyForecastServiceResult {
  return { ok: false, stage: 'NORMALIZATION', issues };
}

/** A fresh `PROVIDER`-stage upstream-error result for the given `resultCode`. */
function upstream(resultCode: string): KmaHourlyForecastServiceResult {
  return providerFailure({ kind: 'KMA_UPSTREAM_ERROR', resultCode });
}

interface RecordedCall {
  readonly request: KmaForecastRequest;
  readonly options: { readonly signal?: AbortSignal } | undefined;
}

interface FakeProvider extends KmaForecastProvider {
  readonly calls: readonly RecordedCall[];
}

/**
 * A typed fake provider honouring the {@link KmaForecastProvider} contract: it records each call and
 * resolves to a fixed result union (never throws, never hits the network). Fresh per test.
 */
function fakeProvider(result: KmaForecastProviderResult): FakeProvider {
  const calls: RecordedCall[] = [];
  return {
    calls,
    fetchForecast(request, options) {
      calls.push({ request, options });
      return Promise.resolve(result);
    },
  };
}

/** A `totalCount === 0` provider success page (empty slots → empty hourly downstream). */
function emptyProviderSuccess(): KmaForecastProviderSuccess {
  return {
    product: SHORT,
    baseDate: '20260717',
    baseTime: '0500',
    nx: 60,
    ny: 127,
    totalCount: 0,
    slots: [],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('classifyKmaHourlyFallbackEligibility — eligible: empty-hourly success', () => {
  it('classifies { ok: true, hourly: [] } as EMPTY_HOURLY', () => {
    expect(classifyKmaHourlyFallbackEligibility(emptySuccess())).toEqual({
      eligible: true,
      reason: 'EMPTY_HOURLY',
    });
  });

  it('handles a frozen empty hourly array without mutating it', () => {
    const hourly = deepFreeze<readonly HourlyForecast[]>([]);
    const result = nonEmptySuccess(hourly);
    expect(classifyKmaHourlyFallbackEligibility(result)).toEqual({
      eligible: true,
      reason: 'EMPTY_HOURLY',
    });
    expect(result.ok && result.hourly).toBe(hourly);
    expect(result.ok && result.hourly).toHaveLength(0);
  });

  it('handles a fully-frozen empty-success result and leaves it deep-equal', () => {
    const result = deepFreeze<KmaHourlyForecastServiceResult>(emptySuccess());
    const snapshot = JSON.stringify(result);
    expect(classifyKmaHourlyFallbackEligibility(result)).toEqual({
      eligible: true,
      reason: 'EMPTY_HOURLY',
    });
    expect(JSON.stringify(result)).toBe(snapshot);
  });

  it('does not expose a runtime extra property from an empty-success input', () => {
    const result: KmaHourlyForecastServiceResult & { readonly leaked?: string } = {
      ...emptySuccess(),
      leaked: RAW_MARKER,
    };
    const classified = classifyKmaHourlyFallbackEligibility(result);
    expect(classified).toEqual({ eligible: true, reason: 'EMPTY_HOURLY' });
    expect(JSON.stringify(classified)).not.toContain(RAW_MARKER);
    expect(classified).not.toHaveProperty('leaked');
  });

  it('exposes exactly the keys { eligible, reason } for an eligible result', () => {
    const classified = classifyKmaHourlyFallbackEligibility(emptySuccess());
    expect(Object.keys(classified).sort()).toEqual(['eligible', 'reason']);
  });

  it('sets reason to the exact value EMPTY_HOURLY', () => {
    const classified = classifyKmaHourlyFallbackEligibility(emptySuccess());
    expect(classified.eligible).toBe(true);
    if (classified.eligible) {
      expect(classified.reason).toBe('EMPTY_HOURLY');
    }
  });
});

describe('classifyKmaHourlyFallbackEligibility — eligible: upstream resultCode 03', () => {
  it('classifies PROVIDER / KMA_UPSTREAM_ERROR / resultCode 03 as KMA_NO_DATA', () => {
    expect(classifyKmaHourlyFallbackEligibility(upstream(NO_DATA_CODE))).toEqual({
      eligible: true,
      reason: 'KMA_NO_DATA',
    });
  });

  it('classifies a frozen provider-error result and leaves it untouched', () => {
    const result = deepFreeze<KmaHourlyForecastServiceResult>(upstream(NO_DATA_CODE));
    const snapshot = JSON.stringify(result);
    expect(classifyKmaHourlyFallbackEligibility(result)).toEqual({
      eligible: true,
      reason: 'KMA_NO_DATA',
    });
    expect(JSON.stringify(result)).toBe(snapshot);
  });

  it('does not expose a runtime extra property on the provider error', () => {
    const error: KmaForecastProviderError & { readonly leaked?: string } = {
      kind: 'KMA_UPSTREAM_ERROR',
      resultCode: NO_DATA_CODE,
      leaked: RAW_MARKER,
    };
    const classified = classifyKmaHourlyFallbackEligibility(providerFailure(error));
    expect(classified).toEqual({ eligible: true, reason: 'KMA_NO_DATA' });
    expect(JSON.stringify(classified)).not.toContain(RAW_MARKER);
    expect(classified).not.toHaveProperty('resultCode');
  });

  it('does not change the input resultCode reference or value', () => {
    const error: KmaForecastProviderError = {
      kind: 'KMA_UPSTREAM_ERROR',
      resultCode: NO_DATA_CODE,
    };
    const result = providerFailure(error);
    classifyKmaHourlyFallbackEligibility(result);
    expect(result.ok).toBe(false);
    if (!result.ok && result.stage === 'PROVIDER') {
      expect(result.error).toBe(error);
      expect(result.error.kind === 'KMA_UPSTREAM_ERROR' && result.error.resultCode).toBe(
        NO_DATA_CODE,
      );
    }
  });

  it('exposes exactly the keys { eligible, reason } for the eligible upstream result', () => {
    const classified = classifyKmaHourlyFallbackEligibility(upstream(NO_DATA_CODE));
    expect(Object.keys(classified).sort()).toEqual(['eligible', 'reason']);
  });

  it('sets reason to the exact value KMA_NO_DATA', () => {
    const classified = classifyKmaHourlyFallbackEligibility(upstream(NO_DATA_CODE));
    expect(classified.eligible).toBe(true);
    if (classified.eligible) {
      expect(classified.reason).toBe('KMA_NO_DATA');
    }
  });
});

describe('classifyKmaHourlyFallbackEligibility — ineligible: non-empty success', () => {
  it('classifies a one-element hourly success as ineligible', () => {
    expect(classifyKmaHourlyFallbackEligibility(nonEmptySuccess([HOURLY_A]))).toEqual({
      eligible: false,
    });
  });

  it('classifies a multi-element hourly success as ineligible', () => {
    expect(
      classifyKmaHourlyFallbackEligibility(nonEmptySuccess([HOURLY_A, HOURLY_B])),
    ).toEqual({ eligible: false });
  });

  it('exposes exactly the key { eligible } for an ineligible result', () => {
    const classified = classifyKmaHourlyFallbackEligibility(nonEmptySuccess([HOURLY_A]));
    expect(Object.keys(classified)).toEqual(['eligible']);
  });

  it('does not carry a reason own-property on an ineligible result', () => {
    const classified = classifyKmaHourlyFallbackEligibility(nonEmptySuccess([HOURLY_A]));
    expect(classified).not.toHaveProperty('reason');
    expect(Object.prototype.hasOwnProperty.call(classified, 'reason')).toBe(false);
  });

  it('observes only length — element contents are never inspected or mutated', () => {
    // A frozen element with an out-of-contract sentinel temperature still classifies purely by
    // length, and the classifier neither reads its fields to reclassify nor mutates it.
    const weird = deepFreeze<HourlyForecast>({ ...HOURLY_A, temperatureCelsius: -999 });
    const hourly = deepFreeze<readonly HourlyForecast[]>([weird]);
    const snapshot = JSON.stringify(hourly);
    expect(classifyKmaHourlyFallbackEligibility(nonEmptySuccess(hourly))).toEqual({
      eligible: false,
    });
    expect(JSON.stringify(hourly)).toBe(snapshot);
    expect(hourly[0]).toBe(weird);
  });

  it('uses fixtures that satisfy the real HourlyForecast schema', () => {
    // Guards the fixtures themselves (no `as any`): both pass the contracts runtime check.
    expect(hourlyForecast.safeParse(HOURLY_A).success).toBe(true);
    expect(hourlyForecast.safeParse(HOURLY_B).success).toBe(true);
  });
});

describe('classifyKmaHourlyFallbackEligibility — ineligible: other upstream result codes', () => {
  // Every code here is NOT the exact string '03': other valid two-digit codes, malformed near-'03'
  // variants (whitespace/short/long/numeric), and an unknown future code.
  const ineligibleCodes: readonly string[] = [
    '00',
    '01',
    '02',
    '04',
    '05',
    '10',
    '11',
    '12',
    '20',
    '21',
    '22',
    '30',
    '31',
    '32',
    '33',
    '99',
    '3',
    '003',
    ' 03',
    '03 ',
    ' 03 ',
    '98',
  ];

  it.each(ineligibleCodes)('classifies upstream resultCode %j as ineligible', (code) => {
    expect(classifyKmaHourlyFallbackEligibility(upstream(code))).toEqual({
      eligible: false,
    });
  });

  it('classifies only the exact string 03 as eligible (exact-match, no coercion)', () => {
    expect(classifyKmaHourlyFallbackEligibility(upstream('03'))).toEqual({
      eligible: true,
      reason: 'KMA_NO_DATA',
    });
    for (const code of ineligibleCodes) {
      expect(classifyKmaHourlyFallbackEligibility(upstream(code)).eligible).toBe(false);
    }
  });
});

describe('classifyKmaHourlyFallbackEligibility — ineligible: every other provider error', () => {
  // The full current provider error union with '03' deliberately excluded (it is tested as eligible
  // above). A non-'03' KMA_UPSTREAM_ERROR is included here.
  const providerErrors: readonly KmaForecastProviderError[] = [
    { kind: 'INVALID_REQUEST', issues: [{ field: 'product', reason: 'INVALID' }] },
    { kind: 'TIMEOUT' },
    { kind: 'ABORTED' },
    { kind: 'NETWORK_ERROR' },
    { kind: 'HTTP_ERROR', status: 503 },
    { kind: 'RESPONSE_TOO_LARGE' },
    { kind: 'EMPTY_RESPONSE' },
    { kind: 'NON_JSON_RESPONSE' },
    { kind: 'INVALID_JSON' },
    { kind: 'GATEWAY_ERROR', reasonCode: '30' },
    { kind: 'GATEWAY_ERROR', reasonCode: null },
    { kind: 'KMA_UPSTREAM_ERROR', resultCode: '10' },
    {
      kind: 'KMA_INVALID_RESPONSE',
      issues: [{ path: ['response', 'body', 'items', 'item', 0, 'nx'], message: 'expected number' }],
    },
    {
      kind: 'DUPLICATE_CATEGORY',
      category: 'TMP',
      slotKey: 'SHORT_FORECAST|20260717|0500|20260717|1400|60|127',
    },
    { kind: 'RESPONSE_MISMATCH', field: 'baseDate' },
    { kind: 'INCOMPLETE_PAGE', totalCount: 100, receivedCount: 50 },
  ];

  it.each(providerErrors)('classifies provider error %o as ineligible', (error) => {
    expect(classifyKmaHourlyFallbackEligibility(providerFailure(error))).toEqual({
      eligible: false,
    });
  });

  it('covers every provider error kind (table stays in sync with the union)', () => {
    const kinds = new Set(providerErrors.map((error) => error.kind));
    // Every kind except that KMA_UPSTREAM_ERROR/03 is the eligible one.
    expect([...kinds].sort()).toEqual(
      [
        'ABORTED',
        'DUPLICATE_CATEGORY',
        'EMPTY_RESPONSE',
        'GATEWAY_ERROR',
        'HTTP_ERROR',
        'INCOMPLETE_PAGE',
        'INVALID_JSON',
        'INVALID_REQUEST',
        'KMA_INVALID_RESPONSE',
        'KMA_UPSTREAM_ERROR',
        'NETWORK_ERROR',
        'NON_JSON_RESPONSE',
        'RESPONSE_MISMATCH',
        'RESPONSE_TOO_LARGE',
        'TIMEOUT',
      ].sort(),
    );
  });

  it('classifies ABORTED as ineligible (never auto-retries a cancelled call)', () => {
    expect(classifyKmaHourlyFallbackEligibility(providerFailure({ kind: 'ABORTED' }))).toEqual(
      { eligible: false },
    );
  });

  it('classifies TIMEOUT as ineligible', () => {
    expect(classifyKmaHourlyFallbackEligibility(providerFailure({ kind: 'TIMEOUT' }))).toEqual(
      { eligible: false },
    );
  });

  it('classifies HTTP 503 as ineligible', () => {
    expect(
      classifyKmaHourlyFallbackEligibility(
        providerFailure({ kind: 'HTTP_ERROR', status: 503 }),
      ),
    ).toEqual({ eligible: false });
  });

  it('classifies NETWORK_ERROR as ineligible', () => {
    expect(
      classifyKmaHourlyFallbackEligibility(providerFailure({ kind: 'NETWORK_ERROR' })),
    ).toEqual({ eligible: false });
  });

  it('classifies INCOMPLETE_PAGE as ineligible', () => {
    expect(
      classifyKmaHourlyFallbackEligibility(
        providerFailure({ kind: 'INCOMPLETE_PAGE', totalCount: 100, receivedCount: 50 }),
      ),
    ).toEqual({ eligible: false });
  });

  it('classifies EMPTY_RESPONSE as ineligible', () => {
    expect(
      classifyKmaHourlyFallbackEligibility(providerFailure({ kind: 'EMPTY_RESPONSE' })),
    ).toEqual({ eligible: false });
  });
});

describe('classifyKmaHourlyFallbackEligibility — ineligible: every normalization failure', () => {
  const SLOT_KEY = 'SHORT_FORECAST|20260717|0500|20260717|1400|60|127';

  const issueCases: readonly {
    readonly label: string;
    readonly issues: readonly KmaHourlyNormalizationIssue[];
  }[] = [
    {
      label: 'temperatureCelsius / ABSENT',
      issues: [{ slotKey: SLOT_KEY, field: 'temperatureCelsius', reason: 'ABSENT' }],
    },
    {
      label: 'temperatureCelsius / NULL',
      issues: [{ slotKey: SLOT_KEY, field: 'temperatureCelsius', reason: 'NULL' }],
    },
    {
      label: 'temperatureCelsius / INVALID',
      issues: [{ slotKey: SLOT_KEY, field: 'temperatureCelsius', reason: 'INVALID' }],
    },
    {
      label: 'forecastAt / INVALID',
      issues: [{ slotKey: SLOT_KEY, field: 'forecastAt', reason: 'INVALID' }],
    },
    {
      label: 'contract / INVALID',
      issues: [
        {
          slotKey: SLOT_KEY,
          field: 'contract',
          reason: 'INVALID',
          path: 'temperatureCelsius',
          message: 'expected number',
        },
      ],
    },
    {
      label: 'multiple issues',
      issues: [
        { slotKey: SLOT_KEY, field: 'temperatureCelsius', reason: 'ABSENT' },
        { slotKey: SLOT_KEY, field: 'forecastAt', reason: 'INVALID' },
      ],
    },
  ];

  it.each(issueCases)('classifies normalization $label as ineligible', ({ issues }) => {
    expect(classifyKmaHourlyFallbackEligibility(normalizationFailure(issues))).toEqual({
      eligible: false,
    });
  });

  it('does not re-inspect issue contents nor mutate the issue list/objects', () => {
    const issues = deepFreeze<readonly KmaHourlyNormalizationIssue[]>([
      { slotKey: SLOT_KEY, field: 'temperatureCelsius', reason: 'ABSENT' },
    ]);
    const result = normalizationFailure(issues);
    const snapshot = JSON.stringify(issues);
    const classified = classifyKmaHourlyFallbackEligibility(result);
    expect(classified).toEqual({ eligible: false });
    // ABSENT (or NULL/INVALID) is never treated as a no-data signal, and no path/message leaks.
    expect(classified).not.toHaveProperty('reason');
    expect(JSON.stringify(classified)).not.toContain('ABSENT');
    expect(JSON.stringify(classified)).not.toContain('temperatureCelsius');
    // The input issues array/objects are unchanged (same reference, same content).
    expect(result.ok).toBe(false);
    if (!result.ok && result.stage === 'NORMALIZATION') {
      expect(result.issues).toBe(issues);
    }
    expect(JSON.stringify(issues)).toBe(snapshot);
  });
});

describe('classifyKmaHourlyFallbackEligibility — service integration (typed fake provider)', () => {
  it('A. totalCount 0 success → EMPTY_HOURLY, provider called once, no network', async () => {
    const provider = fakeProvider({ ok: true, forecast: emptyProviderSuccess() });
    const service = createKmaHourlyForecastService(provider);

    const result = await service.fetchHourlyForecast(REQUEST);

    expect(result).toEqual({ ok: true, hourly: [] });
    expect(classifyKmaHourlyFallbackEligibility(result)).toEqual({
      eligible: true,
      reason: 'EMPTY_HOURLY',
    });
    expect(provider.calls).toHaveLength(1);
  });

  it('B. upstream 03 → PROVIDER stage preserved, classifier KMA_NO_DATA', async () => {
    const error: KmaForecastProviderError = {
      kind: 'KMA_UPSTREAM_ERROR',
      resultCode: '03',
    };
    const provider = fakeProvider({ ok: false, error });
    const service = createKmaHourlyForecastService(provider);

    const result = await service.fetchHourlyForecast(REQUEST);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe('PROVIDER');
      // The existing service contract preserves the provider error by reference — unbroken here.
      if (result.stage === 'PROVIDER') {
        expect(result.error).toBe(error);
      }
    }
    expect(classifyKmaHourlyFallbackEligibility(result)).toEqual({
      eligible: true,
      reason: 'KMA_NO_DATA',
    });
    expect(provider.calls).toHaveLength(1);
  });

  it('C. HTTP 503 → PROVIDER/HTTP_ERROR, classifier ineligible (no auto previous-issuance)', async () => {
    const error: KmaForecastProviderError = { kind: 'HTTP_ERROR', status: 503 };
    const provider = fakeProvider({ ok: false, error });
    const service = createKmaHourlyForecastService(provider);

    const result = await service.fetchHourlyForecast(REQUEST);

    expect(result.ok).toBe(false);
    if (!result.ok && result.stage === 'PROVIDER') {
      expect(result.error).toEqual({ kind: 'HTTP_ERROR', status: 503 });
    }
    expect(classifyKmaHourlyFallbackEligibility(result)).toEqual({ eligible: false });
    expect(provider.calls).toHaveLength(1);
  });
});

describe('classifyKmaHourlyFallbackEligibility — freshness and immutability', () => {
  it('returns deep-equal but reference-distinct results for a repeated eligible input', () => {
    const input = emptySuccess();
    const first = classifyKmaHourlyFallbackEligibility(input);
    const second = classifyKmaHourlyFallbackEligibility(input);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it('returns deep-equal but reference-distinct results for a repeated ineligible input', () => {
    const input = nonEmptySuccess([HOURLY_A]);
    const first = classifyKmaHourlyFallbackEligibility(input);
    const second = classifyKmaHourlyFallbackEligibility(input);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it('returns distinct references for KMA_NO_DATA and EMPTY_HOURLY results', () => {
    const noData = classifyKmaHourlyFallbackEligibility(upstream(NO_DATA_CODE));
    const empty = classifyKmaHourlyFallbackEligibility(emptySuccess());
    expect(noData).not.toBe(empty);
    expect(noData).toEqual({ eligible: true, reason: 'KMA_NO_DATA' });
    expect(empty).toEqual({ eligible: true, reason: 'EMPTY_HOURLY' });
  });

  it('is unaffected by a runtime mutation of a previously returned object', () => {
    const input = emptySuccess();
    const first = classifyKmaHourlyFallbackEligibility(input);
    // Mutate the earlier return via a runtime cast (readonly is compile-time only).
    (first as { eligible: boolean; reason?: string }).reason = 'MUTATED';
    (first as { eligible: boolean }).eligible = false;
    const second = classifyKmaHourlyFallbackEligibility(input);
    expect(second).toEqual({ eligible: true, reason: 'EMPTY_HOURLY' });
  });

  it('never mutates the input result (deep-equal snapshot preserved)', () => {
    const inputs: readonly KmaHourlyForecastServiceResult[] = [
      emptySuccess(),
      nonEmptySuccess([HOURLY_A, HOURLY_B]),
      upstream(NO_DATA_CODE),
      providerFailure({ kind: 'HTTP_ERROR', status: 503 }),
      normalizationFailure([
        { slotKey: 'k', field: 'temperatureCelsius', reason: 'ABSENT' },
      ]),
    ];
    for (const input of inputs) {
      const snapshot = JSON.stringify(input);
      classifyKmaHourlyFallbackEligibility(input);
      expect(JSON.stringify(input)).toBe(snapshot);
    }
  });

  it('keeps nested array/error/issues references and contents unchanged', () => {
    const hourly: readonly HourlyForecast[] = [HOURLY_A];
    const success = nonEmptySuccess(hourly);
    classifyKmaHourlyFallbackEligibility(success);
    expect(success.ok && success.hourly).toBe(hourly);

    const error: KmaForecastProviderError = { kind: 'KMA_UPSTREAM_ERROR', resultCode: '03' };
    const failure = providerFailure(error);
    classifyKmaHourlyFallbackEligibility(failure);
    expect(!failure.ok && failure.stage === 'PROVIDER' && failure.error).toBe(error);

    const issues: readonly KmaHourlyNormalizationIssue[] = [
      { slotKey: 'k', field: 'forecastAt', reason: 'INVALID' },
    ];
    const norm = normalizationFailure(issues);
    classifyKmaHourlyFallbackEligibility(norm);
    expect(!norm.ok && norm.stage === 'NORMALIZATION' && norm.issues).toBe(issues);
  });

  it('is independent of call order across mixed inputs', () => {
    // Interleave eligible and ineligible inputs; each result depends only on its own input.
    expect(classifyKmaHourlyFallbackEligibility(nonEmptySuccess([HOURLY_A]))).toEqual({
      eligible: false,
    });
    expect(classifyKmaHourlyFallbackEligibility(emptySuccess())).toEqual({
      eligible: true,
      reason: 'EMPTY_HOURLY',
    });
    expect(classifyKmaHourlyFallbackEligibility(upstream('10'))).toEqual({ eligible: false });
    expect(classifyKmaHourlyFallbackEligibility(upstream(NO_DATA_CODE))).toEqual({
      eligible: true,
      reason: 'KMA_NO_DATA',
    });
  });

  it('produces the exact output shape for eligible and ineligible results', () => {
    const eligible: KmaHourlyFallbackEligibility = classifyKmaHourlyFallbackEligibility(
      emptySuccess(),
    );
    const ineligible: KmaHourlyFallbackEligibility = classifyKmaHourlyFallbackEligibility(
      nonEmptySuccess([HOURLY_A]),
    );
    expect(Object.keys(eligible).sort()).toEqual(['eligible', 'reason']);
    expect(Object.keys(ineligible)).toEqual(['eligible']);
  });
});

describe('classifyKmaHourlyFallbackEligibility — no logging', () => {
  it('never calls console.log / console.warn / console.error', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    classifyKmaHourlyFallbackEligibility(emptySuccess());
    classifyKmaHourlyFallbackEligibility(nonEmptySuccess([HOURLY_A]));
    classifyKmaHourlyFallbackEligibility(upstream(NO_DATA_CODE));
    classifyKmaHourlyFallbackEligibility(upstream('99'));
    classifyKmaHourlyFallbackEligibility(providerFailure({ kind: 'ABORTED' }));
    classifyKmaHourlyFallbackEligibility(
      normalizationFailure([{ slotKey: 'k', field: 'contract', reason: 'INVALID' }]),
    );

    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
