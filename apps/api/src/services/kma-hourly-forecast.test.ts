import { describe, expect, it } from 'vitest';

import { hourlyForecast } from '@life-weather/contracts';
import { KmaForecastProduct } from '@life-weather/weather-core';

import type {
  KmaForecastField,
  KmaForecastProvider,
  KmaForecastProviderError,
  KmaForecastProviderResult,
  KmaForecastProviderSuccess,
  KmaForecastRequest,
  KmaForecastSlot,
} from '../providers/kma';
import { createKmaHourlyForecastService } from './kma-hourly-forecast';

const SHORT = KmaForecastProduct.SHORT_FORECAST;
const ULTRA = KmaForecastProduct.ULTRA_SHORT_FORECAST;

/** A unique, non-secret marker used to prove no raw provider value reaches the service result. */
const RAW_MARKER = 'RAW_KMA_VALUE_MUST_NOT_LEAK_7F3A';

/** A complete, already-built request. The service never re-validates or re-derives any of it. */
const REQUEST: KmaForecastRequest = {
  product: SHORT,
  baseDate: '20260717',
  baseTime: '0500',
  nx: 60,
  ny: 127,
};

/**
 * A category's raw presence in a test slot:
 * - a `string`  → a present `VALUE`,
 * - `null`      → a present but explicitly-`NULL` field,
 * - omitted key → `ABSENT` (no field at all).
 */
type FieldSpec = Record<string, string | null>;

/** Build a slot's `fields` array from a {@link FieldSpec}, sorted by category like the real grouper. */
function toFields(spec: FieldSpec): KmaForecastField[] {
  return Object.keys(spec)
    .sort()
    .map((category) => {
      const value = spec[category];
      return value === null
        ? { category, state: 'NULL' as const }
        : { category, state: 'VALUE' as const, value };
    });
}

/** Build one forecast slot. `fields` defaults to a full, valid 단기예보 field set. */
function makeSlot(
  overrides: {
    product?: KmaForecastProduct;
    baseDate?: string;
    baseTime?: string;
    forecastDate?: string;
    forecastTime?: string;
    nx?: number;
    ny?: number;
    fields?: FieldSpec;
  } = {},
): KmaForecastSlot {
  const {
    product = SHORT,
    baseDate = '20260717',
    baseTime = '0500',
    forecastDate = '20260717',
    forecastTime = '1400',
    nx = 60,
    ny = 127,
    fields = {
      TMP: '25.5',
      SKY: '1',
      PTY: '0',
      POP: '20',
      PCP: '1.0mm',
      SNO: '적설없음',
      REH: '55',
      WSD: '3.4',
      VEC: '270',
    },
  } = overrides;
  return {
    product,
    baseDate,
    baseTime,
    forecastDate,
    forecastTime,
    nx,
    ny,
    fields: toFields(fields),
  };
}

/** Wrap slots into a provider success object. */
function makeSuccess(
  slots: readonly KmaForecastSlot[],
  overrides: Partial<Omit<KmaForecastProviderSuccess, 'slots'>> = {},
): KmaForecastProviderSuccess {
  const first = slots[0];
  return {
    product: overrides.product ?? first?.product ?? SHORT,
    baseDate: overrides.baseDate ?? first?.baseDate ?? '20260717',
    baseTime: overrides.baseTime ?? first?.baseTime ?? '0500',
    nx: overrides.nx ?? first?.nx ?? 60,
    ny: overrides.ny ?? first?.ny ?? 127,
    totalCount: overrides.totalCount ?? slots.length,
    slots,
  };
}

interface RecordedCall {
  readonly request: KmaForecastRequest;
  readonly options: { readonly signal?: AbortSignal } | undefined;
}

interface FakeProvider extends KmaForecastProvider {
  readonly calls: readonly RecordedCall[];
}

/**
 * A fake provider that honours the {@link KmaForecastProvider} contract: it records each call's
 * `request` and `options` (by reference) and resolves to a fixed result union — it never throws.
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

/**
 * Fresh, isolated fixtures for one SHORT_FORECAST success run. Each test builds its own context so
 * the fake provider's `calls` log is never shared across tests — order-independent under shuffle.
 */
function createShortSuccessContext() {
  const success = makeSuccess([makeSlot()]);
  const provider = fakeProvider({ ok: true, forecast: success });
  const service = createKmaHourlyForecastService(provider);
  const options = { signal: new AbortController().signal };
  return { provider, service, options };
}

describe('createKmaHourlyForecastService — SHORT_FORECAST success', () => {
  it('calls the provider exactly once with the same request and options references', async () => {
    const { provider, service, options } = createShortSuccessContext();
    const result = await service.fetchHourlyForecast(REQUEST, options);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].request).toBe(REQUEST);
    expect(provider.calls[0].options).toBe(options);
    expect(result.ok).toBe(true);
  });

  it('returns the normalized HourlyForecast built by the real PR #6 normalizer', async () => {
    const { service } = createShortSuccessContext();
    const result = await service.fetchHourlyForecast(REQUEST);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.hourly).toHaveLength(1);
    const [entry] = result.hourly;
    expect(entry.forecastAt).toBe('2026-07-17T14:00:00+09:00');
    expect(entry.condition).toBe('CLEAR'); // SKY 1 + PTY 0
    expect(entry.temperatureCelsius).toBe(25.5);
    expect(entry.precipitationProbabilityPercent).toBe(20);
    expect(entry.precipitationAmountMillimeters).toBe(1);
    expect(entry.snowfallAmountCentimeters).toBe(0); // 적설없음
    expect(entry.humidityPercent).toBe(55);
    expect(entry.windSpeedMetersPerSecond).toBe(3.4);
    expect(entry.windDirectionDegrees).toBe(270);
    expect(entry.feelsLikeCelsius).toBeNull();
  });

  it('produces output that passes the contracts hourlyForecast schema', async () => {
    const { service } = createShortSuccessContext();
    const result = await service.fetchHourlyForecast(REQUEST);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    for (const entry of result.hourly) {
      expect(hourlyForecast.safeParse(entry).success).toBe(true);
    }
  });

  it('exposes only { ok, hourly } — no raw provider success, slots, or raw fields', async () => {
    const { service } = createShortSuccessContext();
    const result = await service.fetchHourlyForecast(REQUEST);
    expect(result.ok).toBe(true);
    expect(Object.keys(result).sort()).toEqual(['hourly', 'ok']);
    expect(result).not.toHaveProperty('forecast');
    expect(result).not.toHaveProperty('slots');
    expect(result).not.toHaveProperty('totalCount');
    expect(result).not.toHaveProperty('stage');
    if (result.ok) {
      // Each hourly entry carries exactly the contract keys — no raw KMA category passthrough.
      expect(Object.keys(result.hourly[0]).sort()).toEqual(
        [
          'condition',
          'feelsLikeCelsius',
          'forecastAt',
          'humidityPercent',
          'precipitationAmountMillimeters',
          'precipitationProbabilityPercent',
          'snowfallAmountCentimeters',
          'temperatureCelsius',
          'windDirectionDegrees',
          'windSpeedMetersPerSecond',
        ].sort(),
      );
    }
  });
});

describe('createKmaHourlyForecastService — ULTRA_SHORT_FORECAST success', () => {
  it('routes T1H/RN1 through the real normalizer, parses ultra POP, and has null snowfall', async () => {
    const success = makeSuccess(
      [
        makeSlot({
          product: ULTRA,
          fields: {
            T1H: '18.2',
            SKY: '4',
            PTY: '1',
            POP: '60',
            RN1: '30.0~50.0mm',
            REH: '80',
            WSD: '2.1',
            VEC: '90',
          },
        }),
      ],
      { product: ULTRA },
    );
    const provider = fakeProvider({ ok: true, forecast: success });
    const service = createKmaHourlyForecastService(provider);

    const ultraRequest: KmaForecastRequest = { ...REQUEST, product: ULTRA };
    const result = await service.fetchHourlyForecast(ultraRequest);

    expect(provider.calls).toHaveLength(1);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const [entry] = result.hourly;
    expect(entry.temperatureCelsius).toBe(18.2); // T1H, not TMP
    expect(entry.condition).toBe('RAIN'); // PTY 1 wins over SKY 4
    expect(entry.precipitationProbabilityPercent).toBe(60); // 초단기 POP VALUE parsed
    expect(entry.precipitationAmountMillimeters).toBe(30); // RN1 lower bound
    expect(entry.snowfallAmountCentimeters).toBeNull(); // no 신적설 in 초단기예보
    expect(entry.humidityPercent).toBe(80);
    expect(entry.windSpeedMetersPerSecond).toBe(2.1);
    expect(entry.windDirectionDegrees).toBe(90);
    expect(entry.feelsLikeCelsius).toBeNull();
    expect(hourlyForecast.safeParse(entry).success).toBe(true);
  });
});

describe('createKmaHourlyForecastService — empty success page', () => {
  it('returns { ok: true, hourly: [] } for an empty slots array (totalCount 0)', async () => {
    const provider = fakeProvider({
      ok: true,
      forecast: makeSuccess([], { totalCount: 0 }),
    });
    const service = createKmaHourlyForecastService(provider);
    const result = await service.fetchHourlyForecast(REQUEST);
    expect(result).toEqual({ ok: true, hourly: [] });
    expect(provider.calls).toHaveLength(1);
  });
});

describe('createKmaHourlyForecastService — provider errors surface as PROVIDER stage', () => {
  // Every variant of the current provider error union, each with a representative payload.
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
    { kind: 'DUPLICATE_CATEGORY', category: 'TMP', slotKey: 'SHORT_FORECAST|20260717|0500|20260717|1400|60|127' },
    { kind: 'RESPONSE_MISMATCH', field: 'baseDate' },
    { kind: 'INCOMPLETE_PAGE', totalCount: 100, receivedCount: 50 },
  ];

  it.each(providerErrors)('returns %o verbatim under stage PROVIDER', async (error) => {
    const snapshot = JSON.stringify(error);
    const provider = fakeProvider({ ok: false, error });
    const service = createKmaHourlyForecastService(provider);

    const result = await service.fetchHourlyForecast(REQUEST);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe('PROVIDER');
    if (result.stage !== 'PROVIDER') {
      return;
    }
    // The provider error is passed through by reference (not re-classified or re-interpreted)...
    expect(result.error).toBe(error);
    // ...and is deep-equal to what the provider returned, untouched.
    expect(result.error).toEqual(error);
    // No normalization field, no success field.
    expect(result).not.toHaveProperty('hourly');
    expect(result).not.toHaveProperty('issues');
    // Exactly one provider call.
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].request).toBe(REQUEST);
    // The provider error object itself is never mutated.
    expect(JSON.stringify(error)).toBe(snapshot);
  });

  it('covers every provider error kind (table stays in sync with the union)', () => {
    const kinds = new Set(providerErrors.map((error) => error.kind));
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

  it('does not run the normalizer on a provider failure (no normalization issues appear)', async () => {
    const provider = fakeProvider({ ok: false, error: { kind: 'TIMEOUT' } });
    const service = createKmaHourlyForecastService(provider);
    const result = await service.fetchHourlyForecast(REQUEST);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe('PROVIDER');
    // A provider failure never carries a NORMALIZATION issue list.
    expect(result).not.toHaveProperty('issues');
  });
});

describe('createKmaHourlyForecastService — normalization failure surfaces as NORMALIZATION stage', () => {
  it('reports an ABSENT required-temperature issue and no provider error / hourly', async () => {
    const provider = fakeProvider({
      ok: true,
      forecast: makeSuccess([makeSlot({ fields: { SKY: '1', PTY: '0' } })]), // TMP absent
    });
    const service = createKmaHourlyForecastService(provider);
    const options = { signal: new AbortController().signal };

    const result = await service.fetchHourlyForecast(REQUEST, options);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe('NORMALIZATION');
    if (result.stage !== 'NORMALIZATION') {
      return;
    }
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      field: 'temperatureCelsius',
      reason: 'ABSENT',
    });
    expect(result).not.toHaveProperty('error');
    expect(result).not.toHaveProperty('hourly');
    // The provider is still called exactly once with the same request/options.
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].request).toBe(REQUEST);
    expect(provider.calls[0].options).toBe(options);
  });

  it('reports an INVALID issue for a malformed temperature without leaking the raw string', async () => {
    const provider = fakeProvider({
      ok: true,
      forecast: makeSuccess([
        makeSlot({ fields: { TMP: `${RAW_MARKER}`, SKY: '1', PTY: '0' } }),
      ]),
    });
    const service = createKmaHourlyForecastService(provider);
    const result = await service.fetchHourlyForecast(REQUEST);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe('NORMALIZATION');
    if (result.stage !== 'NORMALIZATION') {
      return;
    }
    expect(result.issues[0]).toMatchObject({
      field: 'temperatureCelsius',
      reason: 'INVALID',
    });
    expect(JSON.stringify(result)).not.toContain(RAW_MARKER);
  });

  it('preserves the normalizer issue order and count verbatim (all-or-nothing)', async () => {
    const provider = fakeProvider({
      ok: true,
      forecast: makeSuccess([
        makeSlot({ forecastTime: '1500', fields: { SKY: '1', PTY: '0' } }), // TMP absent
        makeSlot({ forecastTime: '1300', fields: { TMP: null, SKY: '1', PTY: '0' } }), // TMP null
      ]),
    });
    const service = createKmaHourlyForecastService(provider);
    const result = await service.fetchHourlyForecast(REQUEST);
    expect(result.ok).toBe(false);
    if (result.ok || result.stage !== 'NORMALIZATION') {
      return;
    }
    expect(result.issues).toHaveLength(2);
    // No partial hourly data is ever returned alongside issues.
    expect(result).not.toHaveProperty('hourly');
  });
});

describe('createKmaHourlyForecastService — raw value non-leakage', () => {
  it('does not leak a raw ignored-category value on the success path', async () => {
    const provider = fakeProvider({
      ok: true,
      forecast: makeSuccess([
        makeSlot({
          fields: {
            TMP: '25.5',
            SKY: '1',
            PTY: '0',
            // An unknown category the normalizer ignores; its raw value must not survive.
            ZZZ: RAW_MARKER,
          },
        }),
      ]),
    });
    const service = createKmaHourlyForecastService(provider);
    const result = await service.fetchHourlyForecast(REQUEST);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(RAW_MARKER);
    expect(JSON.stringify(result)).not.toContain('ZZZ');
  });
});

describe('createKmaHourlyForecastService — forwarding and immutability', () => {
  it('forwards undefined options to the provider when options are omitted', async () => {
    const provider = fakeProvider({ ok: true, forecast: makeSuccess([makeSlot()]) });
    const service = createKmaHourlyForecastService(provider);
    await service.fetchHourlyForecast(REQUEST);
    expect(provider.calls[0].options).toBeUndefined();
  });

  it('forwards the exact caller signal reference to the provider', async () => {
    const provider = fakeProvider({ ok: true, forecast: makeSuccess([makeSlot()]) });
    const service = createKmaHourlyForecastService(provider);
    const signal = new AbortController().signal;
    const options = { signal };
    await service.fetchHourlyForecast(REQUEST, options);
    expect(provider.calls[0].options).toBe(options);
    expect(provider.calls[0].options?.signal).toBe(signal);
  });

  it('works with a deeply-frozen request and options (never mutates them)', async () => {
    const provider = fakeProvider({ ok: true, forecast: makeSuccess([makeSlot()]) });
    const service = createKmaHourlyForecastService(provider);
    const request = deepFreeze<KmaForecastRequest>({ ...REQUEST });
    const options = deepFreeze({ signal: new AbortController().signal });
    const requestSnapshot = JSON.stringify(request);

    const result = await service.fetchHourlyForecast(request, options);

    expect(result.ok).toBe(true);
    expect(JSON.stringify(request)).toBe(requestSnapshot);
    expect(provider.calls[0].request).toBe(request);
    expect(provider.calls[0].options).toBe(options);
  });

  it('works with a deeply-frozen provider success (slots and fields frozen)', async () => {
    const success = deepFreeze(makeSuccess([makeSlot()]));
    const provider = fakeProvider({ ok: true, forecast: success });
    const service = createKmaHourlyForecastService(provider);
    const result = await service.fetchHourlyForecast(REQUEST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hourly).toHaveLength(1);
    }
  });

  it('does not call the provider on factory construction alone', () => {
    const provider = fakeProvider({ ok: true, forecast: makeSuccess([makeSlot()]) });
    createKmaHourlyForecastService(provider);
    expect(provider.calls).toHaveLength(0);
  });

  it('is reusable — one instance handles many calls with no shared mutable state', async () => {
    const provider = fakeProvider({ ok: true, forecast: makeSuccess([makeSlot()]) });
    const service = createKmaHourlyForecastService(provider);
    const first = await service.fetchHourlyForecast(REQUEST);
    const second = await service.fetchHourlyForecast(REQUEST);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(provider.calls).toHaveLength(2);
    // Deterministic: equal input → equal output, no drift between calls.
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
