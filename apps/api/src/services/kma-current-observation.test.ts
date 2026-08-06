import { describe, expect, it } from 'vitest';

import { currentWeather } from '@life-weather/contracts';

import type {
  KmaCurrentObservationField,
  KmaCurrentObservationProvider,
  KmaCurrentObservationProviderError,
  KmaCurrentObservationProviderResult,
  KmaCurrentObservationProviderSuccess,
  KmaCurrentObservationRequest,
  KmaCurrentObservationSlot,
} from '../providers/kma/index.js';
import { createKmaCurrentObservationService } from './kma-current-observation.js';

/** A unique, non-secret marker used to prove no raw provider value reaches the service result. */
const RAW_MARKER = 'RAW_KMA_CURRENT_VALUE_MUST_NOT_LEAK_9C2B';

/** A complete, already-built request. The service never re-validates or re-derives any of it. */
const REQUEST: KmaCurrentObservationRequest = {
  baseDate: '20260717',
  baseTime: '0600',
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
function toFields(spec: FieldSpec): KmaCurrentObservationField[] {
  return Object.keys(spec)
    .sort()
    .map((category) => {
      const value = spec[category];
      return value === null
        ? { category, state: 'NULL' as const }
        : { category, state: 'VALUE' as const, value };
    });
}

/** Build one current-observation slot. `fields` defaults to a full, valid field set. */
function makeSlot(
  overrides: {
    baseDate?: string;
    baseTime?: string;
    nx?: number;
    ny?: number;
    fields?: FieldSpec;
  } = {},
): KmaCurrentObservationSlot {
  const {
    baseDate = '20260717',
    baseTime = '0600',
    nx = 60,
    ny = 127,
    fields = {
      T1H: '23.5',
      PTY: '0',
      REH: '55',
      WSD: '3.4',
      VEC: '270',
      RN1: '0',
    },
  } = overrides;
  return { baseDate, baseTime, nx, ny, fields: toFields(fields) };
}

/** Wrap a slot (or `null`, the documented defensive empty-page allowance) into a provider success. */
function makeSuccess(
  slot: KmaCurrentObservationSlot | null,
  overrides: Partial<Omit<KmaCurrentObservationProviderSuccess, 'slot'>> = {},
): KmaCurrentObservationProviderSuccess {
  return {
    baseDate: overrides.baseDate ?? slot?.baseDate ?? '20260717',
    baseTime: overrides.baseTime ?? slot?.baseTime ?? '0600',
    nx: overrides.nx ?? slot?.nx ?? 60,
    ny: overrides.ny ?? slot?.ny ?? 127,
    totalCount: overrides.totalCount ?? (slot === null ? 0 : 1),
    slot,
  };
}

interface RecordedCall {
  readonly request: KmaCurrentObservationRequest;
  readonly options: { readonly signal?: AbortSignal } | undefined;
}

interface FakeProvider extends KmaCurrentObservationProvider {
  readonly calls: readonly RecordedCall[];
}

/**
 * A fake provider that honours the {@link KmaCurrentObservationProvider} contract: it records each
 * call's `request` and `options` (by reference) and resolves to a fixed result union — it never
 * throws.
 */
function fakeProvider(result: KmaCurrentObservationProviderResult): FakeProvider {
  const calls: RecordedCall[] = [];
  return {
    calls,
    fetchCurrentObservation(request, options) {
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
 * Fresh, isolated fixtures for one success run. Each test builds its own context so the fake
 * provider's `calls` log is never shared across tests — order-independent under shuffle.
 */
function createSuccessContext() {
  const success = makeSuccess(makeSlot());
  const provider = fakeProvider({ ok: true, observation: success });
  const service = createKmaCurrentObservationService(provider);
  const options = { signal: new AbortController().signal };
  return { provider, service, options };
}

describe('createKmaCurrentObservationService — success', () => {
  it('calls the provider exactly once with the same request and options references', async () => {
    const { provider, service, options } = createSuccessContext();
    const result = await service.fetchCurrentWeather(REQUEST, options);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].request).toBe(REQUEST);
    expect(provider.calls[0].options).toBe(options);
    expect(result.ok).toBe(true);
  });

  it('returns the normalized CurrentWeather built by the real normalizer', async () => {
    const { service } = createSuccessContext();
    const result = await service.fetchCurrentWeather(REQUEST);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.current.observedAt).toBe('2026-07-17T06:00:00+09:00');
    expect(result.current.temperatureCelsius).toBe(23.5);
    expect(result.current.condition).toBe('UNKNOWN'); // PTY 0, no SKY fallback for current
    expect(result.current.humidityPercent).toBe(55);
    expect(result.current.windSpeedMetersPerSecond).toBe(3.4);
    expect(result.current.windDirectionDegrees).toBe(270);
    expect(result.current.precipitationLastHourMillimeters).toBe(0);
    expect(result.current.feelsLikeCelsius).toBeNull();
    expect(result.current.visibilityMeters).toBeNull();
  });

  it('produces output that passes the contracts currentWeather schema', async () => {
    const { service } = createSuccessContext();
    const result = await service.fetchCurrentWeather(REQUEST);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(currentWeather.safeParse(result.current).success).toBe(true);
  });

  it('exposes only { ok, current } — no raw provider success, slot, totalCount, or obsrValue', async () => {
    const { service } = createSuccessContext();
    const result = await service.fetchCurrentWeather(REQUEST);
    expect(result.ok).toBe(true);
    expect(Object.keys(result).sort()).toEqual(['current', 'ok']);
    expect(result).not.toHaveProperty('observation');
    expect(result).not.toHaveProperty('slot');
    expect(result).not.toHaveProperty('totalCount');
    expect(result).not.toHaveProperty('obsrValue');
    expect(result).not.toHaveProperty('fields');
    expect(result).not.toHaveProperty('stage');
    if (result.ok) {
      expect(Object.keys(result.current).sort()).toEqual(
        [
          'observedAt',
          'condition',
          'temperatureCelsius',
          'feelsLikeCelsius',
          'humidityPercent',
          'windSpeedMetersPerSecond',
          'windDirectionDegrees',
          'precipitationLastHourMillimeters',
          'visibilityMeters',
        ].sort(),
      );
    }
  });

  it('does not leak a raw ignored-category value on the success path', async () => {
    const success = makeSuccess(
      makeSlot({ fields: { T1H: '23.5', PTY: '0', ZZZ: RAW_MARKER } }),
    );
    const provider = fakeProvider({ ok: true, observation: success });
    const service = createKmaCurrentObservationService(provider);
    const result = await service.fetchCurrentWeather(REQUEST);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(RAW_MARKER);
    expect(JSON.stringify(result)).not.toContain('ZZZ');
  });
});

describe('createKmaCurrentObservationService — empty observation (slot: null)', () => {
  it('passes a defensive null slot straight to the normalizer (no PROVIDER reclassification, no invented NO_DATA)', async () => {
    const provider = fakeProvider({
      ok: true,
      observation: makeSuccess(null),
    });
    const service = createKmaCurrentObservationService(provider);
    const result = await service.fetchCurrentWeather(REQUEST);

    // Every category is ABSENT when slot is null, so the required T1H is ABSENT → NORMALIZATION.
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe('NORMALIZATION');
    if (result.stage !== 'NORMALIZATION') {
      return;
    }
    expect(result.issues).toEqual([{ field: 'temperatureCelsius', reason: 'ABSENT' }]);
    expect(provider.calls).toHaveLength(1);
  });
});

describe('createKmaCurrentObservationService — provider errors surface as PROVIDER stage', () => {
  // Every variant of the current-observation provider error union, each with a representative payload.
  const providerErrors: readonly KmaCurrentObservationProviderError[] = [
    { kind: 'INVALID_REQUEST', issues: [{ field: 'baseDate', reason: 'INVALID' }] },
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
    { kind: 'DUPLICATE_CATEGORY', category: 'T1H', slotKey: '20260717|0600|60|127' },
    { kind: 'RESPONSE_MISMATCH', field: 'baseDate' },
    { kind: 'INCOMPLETE_PAGE', totalCount: 8, receivedCount: 4 },
  ];

  it.each(providerErrors)('returns %o verbatim under stage PROVIDER', async (error) => {
    const snapshot = JSON.stringify(error);
    const provider = fakeProvider({ ok: false, error });
    const service = createKmaCurrentObservationService(provider);

    const result = await service.fetchCurrentWeather(REQUEST);

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
    expect(result).not.toHaveProperty('current');
    expect(result).not.toHaveProperty('issues');
    // Exactly the three own keys.
    expect(Object.keys(result).sort()).toEqual(['error', 'ok', 'stage']);
    // Exactly one provider call.
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].request).toBe(REQUEST);
    // The provider error object itself is never mutated.
    expect(JSON.stringify(error)).toBe(snapshot);
    // No raw marker or secret-shaped value leaks into the serialized result.
    expect(JSON.stringify(result)).not.toContain('ServiceKey');
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
    const service = createKmaCurrentObservationService(provider);
    const result = await service.fetchCurrentWeather(REQUEST);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe('PROVIDER');
    // A provider failure never carries a NORMALIZATION issue list.
    expect(result).not.toHaveProperty('issues');
  });
});

describe('createKmaCurrentObservationService — normalization failure surfaces as NORMALIZATION stage', () => {
  it('reports an ABSENT required-temperature issue and no provider error / current', async () => {
    const provider = fakeProvider({
      ok: true,
      observation: makeSuccess(makeSlot({ fields: { PTY: '0' } })), // T1H absent
    });
    const service = createKmaCurrentObservationService(provider);
    const options = { signal: new AbortController().signal };

    const result = await service.fetchCurrentWeather(REQUEST, options);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe('NORMALIZATION');
    if (result.stage !== 'NORMALIZATION') {
      return;
    }
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ field: 'temperatureCelsius', reason: 'ABSENT' });
    expect(result).not.toHaveProperty('error');
    expect(result).not.toHaveProperty('current');
    expect(Object.keys(result).sort()).toEqual(['issues', 'ok', 'stage']);
    // The provider is still called exactly once with the same request/options.
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].request).toBe(REQUEST);
    expect(provider.calls[0].options).toBe(options);
  });

  it('reports a NULL required-temperature issue', async () => {
    const provider = fakeProvider({
      ok: true,
      observation: makeSuccess(makeSlot({ fields: { T1H: null, PTY: '0' } })),
    });
    const service = createKmaCurrentObservationService(provider);
    const result = await service.fetchCurrentWeather(REQUEST);
    expect(result.ok).toBe(false);
    if (result.ok || result.stage !== 'NORMALIZATION') {
      return;
    }
    expect(result.issues[0]).toMatchObject({ field: 'temperatureCelsius', reason: 'NULL' });
  });

  it('reports an INVALID issue for a malformed temperature without leaking the raw string', async () => {
    const provider = fakeProvider({
      ok: true,
      observation: makeSuccess(
        makeSlot({ fields: { T1H: RAW_MARKER, PTY: '0' } }),
      ),
    });
    const service = createKmaCurrentObservationService(provider);
    const result = await service.fetchCurrentWeather(REQUEST);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe('NORMALIZATION');
    if (result.stage !== 'NORMALIZATION') {
      return;
    }
    expect(result.issues[0]).toMatchObject({ field: 'temperatureCelsius', reason: 'INVALID' });
    expect(JSON.stringify(result)).not.toContain(RAW_MARKER);
  });

  it('reports an observedAt issue for a malformed (non-hour) baseTime reaching the normalizer directly', async () => {
    // Defensive fixture: a provider-success shape with a structurally-`HHmm` but non-hour baseTime,
    // exercising the normalizer's own defensive re-check (the raw schema/provider would normally
    // reject this earlier, but the service must still surface whatever the real normalizer reports).
    const provider = fakeProvider({
      ok: true,
      observation: makeSuccess(makeSlot({ baseTime: '0630' }), { baseTime: '0630' }),
    });
    const service = createKmaCurrentObservationService(provider);
    const result = await service.fetchCurrentWeather(REQUEST);

    expect(result.ok).toBe(false);
    if (result.ok || result.stage !== 'NORMALIZATION') {
      return;
    }
    expect(result.issues.some((issue) => issue.field === 'observedAt' && issue.reason === 'INVALID')).toBe(
      true,
    );
  });

  it('preserves the normalizer issue order and count verbatim (all-or-nothing, exact reference)', async () => {
    // Both observedAt and temperatureCelsius fail together: malformed baseDate + absent T1H.
    const observation = makeSuccess(makeSlot({ baseDate: 'BADDATE', fields: { PTY: '0' } }), {
      baseDate: 'BADDATE',
    });
    const provider = fakeProvider({ ok: true, observation });
    const service = createKmaCurrentObservationService(provider);
    const result = await service.fetchCurrentWeather(REQUEST);

    expect(result.ok).toBe(false);
    if (result.ok || result.stage !== 'NORMALIZATION') {
      return;
    }
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
    // No partial current data is ever returned alongside issues.
    expect(result).not.toHaveProperty('current');
  });

  it('never reclassifies a normalization failure as a PROVIDER-stage error', async () => {
    const provider = fakeProvider({
      ok: true,
      observation: makeSuccess(makeSlot({ fields: { PTY: '0' } })), // T1H absent
    });
    const service = createKmaCurrentObservationService(provider);
    const result = await service.fetchCurrentWeather(REQUEST);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).not.toBe('PROVIDER');
    expect(result).not.toHaveProperty('error');
  });
});

describe('createKmaCurrentObservationService — throw / rejection policy', () => {
  it('propagates a provider synchronous throw as a same-reference Promise rejection', async () => {
    const sentinel = new Error('CURRENT_PROVIDER_SYNC_THROW_SENTINEL_FOR_IDENTITY');
    const calls: RecordedCall[] = [];
    const provider: KmaCurrentObservationProvider = {
      fetchCurrentObservation(request, options) {
        calls.push({ request, options });
        throw sentinel;
      },
    };
    const service = createKmaCurrentObservationService(provider);

    const returned = service.fetchCurrentWeather(REQUEST);
    await expect(returned).rejects.toBe(sentinel);
    expect(calls).toHaveLength(1);
  });

  it('propagates a provider rejected Promise with the same reference', async () => {
    const sentinel = new Error('CURRENT_PROVIDER_REJECTION_SENTINEL_FOR_IDENTITY');
    const rejected = Promise.reject<KmaCurrentObservationProviderResult>(sentinel);
    // Attach an assertion immediately so the rejection is always handled (no unhandled rejection).
    const assertion = expect(rejected).rejects.toBe(sentinel);

    const provider: KmaCurrentObservationProvider = {
      fetchCurrentObservation: () => rejected,
    };
    const service = createKmaCurrentObservationService(provider);

    const returned = service.fetchCurrentWeather(REQUEST);
    await expect(returned).rejects.toBe(sentinel);
    await assertion;
  });

  it('does not throw on construction alone and does not call the provider', () => {
    const provider = fakeProvider({ ok: true, observation: makeSuccess(makeSlot()) });
    expect(() => createKmaCurrentObservationService(provider)).not.toThrow();
    expect(provider.calls).toHaveLength(0);
  });
});

describe('createKmaCurrentObservationService — forwarding and immutability', () => {
  it('forwards undefined options to the provider when options are omitted', async () => {
    const provider = fakeProvider({ ok: true, observation: makeSuccess(makeSlot()) });
    const service = createKmaCurrentObservationService(provider);
    await service.fetchCurrentWeather(REQUEST);
    expect(provider.calls[0].options).toBeUndefined();
  });

  it('forwards the exact caller signal reference to the provider', async () => {
    const provider = fakeProvider({ ok: true, observation: makeSuccess(makeSlot()) });
    const service = createKmaCurrentObservationService(provider);
    const signal = new AbortController().signal;
    const options = { signal };
    await service.fetchCurrentWeather(REQUEST, options);
    expect(provider.calls[0].options).toBe(options);
    expect(provider.calls[0].options?.signal).toBe(signal);
  });

  it('works with a deeply-frozen request and options (never mutates them)', async () => {
    const provider = fakeProvider({ ok: true, observation: makeSuccess(makeSlot()) });
    const service = createKmaCurrentObservationService(provider);
    const request = deepFreeze<KmaCurrentObservationRequest>({ ...REQUEST });
    const options = deepFreeze({ signal: new AbortController().signal });
    const requestSnapshot = JSON.stringify(request);

    const result = await service.fetchCurrentWeather(request, options);

    expect(result.ok).toBe(true);
    expect(JSON.stringify(request)).toBe(requestSnapshot);
    expect(provider.calls[0].request).toBe(request);
    expect(provider.calls[0].options).toBe(options);
  });

  it('works with a deeply-frozen provider success (slot and fields frozen)', async () => {
    const success = deepFreeze(makeSuccess(makeSlot()));
    const provider = fakeProvider({ ok: true, observation: success });
    const service = createKmaCurrentObservationService(provider);
    const result = await service.fetchCurrentWeather(REQUEST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.current.temperatureCelsius).toBe(23.5);
    }
  });

  it('is reusable — one instance handles many calls with no shared mutable state', async () => {
    const provider = fakeProvider({ ok: true, observation: makeSuccess(makeSlot()) });
    const service = createKmaCurrentObservationService(provider);
    const first = await service.fetchCurrentWeather(REQUEST);
    const second = await service.fetchCurrentWeather(REQUEST);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(provider.calls).toHaveLength(2);
    // Deterministic: equal input → equal output, no drift between calls.
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    // Fresh outer result object each call — not the same reference.
    expect(first).not.toBe(second);
  });
});
