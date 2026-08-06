import { afterEach, describe, expect, it, vi } from 'vitest';

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
 * Load a fresh, isolated instance of the service module with `normalizeKmaCurrentObservation`
 * replaced by `normalizeMock`, while every other export of the provider barrel stays the real one.
 *
 * The service imports the normalizer statically from `'../providers/kma/index.js'`, so mocking that
 * same specifier — via a non-hoisted `vi.doMock` plus a fresh `vi.resetModules()` and dynamic
 * `import()` — intercepts exactly what the service sees, without adding any test-only seam to
 * production code. Callers must clean up (see the `afterEach` in the isolated-boundary `describe`
 * below) so the mock never leaks into the real-normalizer tests elsewhere in this file, including
 * under shuffle.
 */
async function withIsolatedNormalizerMock(
  normalizeMock: (
    ...args: Parameters<typeof import('../providers/kma/index.js').normalizeKmaCurrentObservation>
  ) => ReturnType<typeof import('../providers/kma/index.js').normalizeKmaCurrentObservation>,
): Promise<typeof import('./kma-current-observation.js')> {
  vi.resetModules();
  vi.doMock('../providers/kma/index.js', async () => {
    const actual = await vi.importActual<typeof import('../providers/kma/index.js')>(
      '../providers/kma/index.js',
    );
    return { ...actual, normalizeKmaCurrentObservation: normalizeMock };
  });
  return import('./kma-current-observation.js');
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
  /**
   * A mapped type keyed by every `kind` in the real union. `providerErrorByKind` below must supply
   * exactly one representative per key or the `satisfies` check fails to compile — so adding a new
   * `kind` to {@link KmaCurrentObservationProviderError} without adding a fixture here is a
   * type-check failure, not a silently-skipped test case.
   */
  type KmaCurrentObservationProviderErrorByKind = {
    readonly [Kind in KmaCurrentObservationProviderError['kind']]: Extract<
      KmaCurrentObservationProviderError,
      { readonly kind: Kind }
    >;
  };

  // The exhaustive-by-kind source of truth: one representative payload per union variant.
  const providerErrorByKind = {
    INVALID_REQUEST: { kind: 'INVALID_REQUEST', issues: [{ field: 'baseDate', reason: 'INVALID' }] },
    TIMEOUT: { kind: 'TIMEOUT' },
    ABORTED: { kind: 'ABORTED' },
    NETWORK_ERROR: { kind: 'NETWORK_ERROR' },
    HTTP_ERROR: { kind: 'HTTP_ERROR', status: 503 },
    RESPONSE_TOO_LARGE: { kind: 'RESPONSE_TOO_LARGE' },
    EMPTY_RESPONSE: { kind: 'EMPTY_RESPONSE' },
    NON_JSON_RESPONSE: { kind: 'NON_JSON_RESPONSE' },
    INVALID_JSON: { kind: 'INVALID_JSON' },
    GATEWAY_ERROR: { kind: 'GATEWAY_ERROR', reasonCode: '30' },
    KMA_UPSTREAM_ERROR: { kind: 'KMA_UPSTREAM_ERROR', resultCode: '10' },
    KMA_INVALID_RESPONSE: {
      kind: 'KMA_INVALID_RESPONSE',
      issues: [{ path: ['response', 'body', 'items', 'item', 0, 'nx'], message: 'expected number' }],
    },
    DUPLICATE_CATEGORY: { kind: 'DUPLICATE_CATEGORY', category: 'T1H', slotKey: '20260717|0600|60|127' },
    RESPONSE_MISMATCH: { kind: 'RESPONSE_MISMATCH', field: 'baseDate' },
    INCOMPLETE_PAGE: { kind: 'INCOMPLETE_PAGE', totalCount: 8, receivedCount: 4 },
  } satisfies KmaCurrentObservationProviderErrorByKind;

  // `GATEWAY_ERROR` has two meaningfully different shapes (a real reason code vs. `null`); the
  // exhaustive-by-kind record above holds one representative per *kind*, so the `null` variant is a
  // separate, additional fixture rather than a second `GATEWAY_ERROR` entry in that record.
  const gatewayErrorNullReasonCode: KmaCurrentObservationProviderError = {
    kind: 'GATEWAY_ERROR',
    reasonCode: null,
  };

  // Every variant of the current-observation provider error union, each with a representative payload.
  const providerErrors: readonly KmaCurrentObservationProviderError[] = [
    ...Object.values(providerErrorByKind),
    gatewayErrorNullReasonCode,
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

  it('covers every provider error kind (runtime keys match the compile-time exhaustive record)', () => {
    // Derived from `providerErrorByKind` (the compile-time source of truth) rather than a second,
    // independently-typed list of kind literals — so there is only one place a kind can go missing.
    const kinds = new Set(providerErrors.map((error) => error.kind));
    expect(kinds).toEqual(new Set(Object.keys(providerErrorByKind)));
  });

  // A direct, isolated observation of zero normalizer invocations on a provider failure — not just
  // the absence of an `issues` property — lives in the "isolated normalizer boundary" describe below
  // (`normalizeMock` called exactly zero times, verified against a mock that would throw if invoked).
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

  it('collects every normalizer issue together for a combined baseDate + T1H failure (all-or-nothing)', async () => {
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

/**
 * These three tests replace the injected `normalizeKmaCurrentObservation` with a `vi.fn()` mock via
 * {@link withIsolatedNormalizerMock}, so they can observe the service's direct interaction with the
 * normalizer — exact call count, exact argument reference, and exact throw propagation — instead of
 * only inferring it from the real normalizer's output. The service under test in every case here is
 * the isolated, dynamically-imported one returned by the helper, never the statically-imported
 * `createKmaCurrentObservationService` used by the rest of this file, so the real-normalizer tests
 * above and below are never affected by the mock, in any shuffle order.
 */
describe('createKmaCurrentObservationService — isolated normalizer boundary', () => {
  afterEach(() => {
    vi.doUnmock('../providers/kma/index.js');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('passes the normalizer issues array and its objects through by exact reference and order', async () => {
    const firstIssue = Object.freeze({
      field: 'temperatureCelsius',
      reason: 'ABSENT',
    } as const);
    const secondIssue = Object.freeze({
      field: 'observedAt',
      reason: 'INVALID',
    } as const);
    // Deliberately out of the normalizer's usual emission order, so a service that re-sorts issues
    // (e.g. `.toSorted(...)`) or rebuilds the array (e.g. `[...normalized.issues]`) would fail the
    // `toBe` reference check below even though a deep-equality check would still pass.
    const issues = Object.freeze([secondIssue, firstIssue]);

    const normalizeMock = vi.fn((_observation: KmaCurrentObservationProviderSuccess) => ({
      ok: false as const,
      issues,
    }));
    const { createKmaCurrentObservationService: createIsolatedService } =
      await withIsolatedNormalizerMock(normalizeMock);

    const success = makeSuccess(makeSlot());
    const provider = fakeProvider({ ok: true, observation: success });
    const service = createIsolatedService(provider);

    const result = await service.fetchCurrentWeather(REQUEST);

    expect(normalizeMock).toHaveBeenCalledTimes(1);
    expect(normalizeMock.mock.calls[0]?.[0]).toBe(success);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe('NORMALIZATION');
    if (result.stage !== 'NORMALIZATION') {
      return;
    }
    expect(result.issues).toBe(issues);
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0]).toBe(secondIssue);
    expect(result.issues[1]).toBe(firstIssue);
    expect(Object.keys(result).sort()).toEqual(['issues', 'ok', 'stage']);
    expect(result).not.toHaveProperty('current');
    expect(result).not.toHaveProperty('error');
    expect(result).not.toHaveProperty('observation');
    // The frozen fixtures were never mutated by the service.
    expect(Object.isFrozen(issues)).toBe(true);
    expect(Object.isFrozen(firstIssue)).toBe(true);
    expect(Object.isFrozen(secondIssue)).toBe(true);
    expect(firstIssue).toEqual({ field: 'temperatureCelsius', reason: 'ABSENT' });
    expect(secondIssue).toEqual({ field: 'observedAt', reason: 'INVALID' });
  });

  it('never invokes the normalizer when the provider itself fails', async () => {
    const vacuousPassGuardSentinel = new Error(
      'CURRENT_NORMALIZER_MUST_NOT_RUN_ON_PROVIDER_FAILURE',
    );
    // If the service ever called the normalizer here, this throw would surface as a rejected
    // `fetchCurrentWeather` promise, failing the test loudly rather than passing vacuously.
    const normalizeMock = vi.fn((_observation: KmaCurrentObservationProviderSuccess) => {
      throw vacuousPassGuardSentinel;
    });
    const { createKmaCurrentObservationService: createIsolatedService } =
      await withIsolatedNormalizerMock(normalizeMock);

    const error: KmaCurrentObservationProviderError = { kind: 'TIMEOUT' };
    const provider = fakeProvider({ ok: false, error });
    const service = createIsolatedService(provider);
    const options = { signal: new AbortController().signal };

    const result = await service.fetchCurrentWeather(REQUEST, options);

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].request).toBe(REQUEST);
    expect(provider.calls[0].options).toBe(options);
    expect(normalizeMock).toHaveBeenCalledTimes(0);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe('PROVIDER');
    if (result.stage !== 'PROVIDER') {
      return;
    }
    expect(result.error).toBe(error);
    expect(Object.keys(result).sort()).toEqual(['error', 'ok', 'stage']);
  });

  it('propagates a normalizer synchronous throw as a same-reference Promise rejection', async () => {
    const sentinel = new Error('CURRENT_NORMALIZER_THROW_SENTINEL_FOR_IDENTITY');
    const normalizeMock = vi.fn((_observation: KmaCurrentObservationProviderSuccess) => {
      throw sentinel;
    });
    const { createKmaCurrentObservationService: createIsolatedService } =
      await withIsolatedNormalizerMock(normalizeMock);

    const success = makeSuccess(makeSlot());
    const provider = fakeProvider({ ok: true, observation: success });
    const service = createIsolatedService(provider);

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const returned = service.fetchCurrentWeather(REQUEST);
    expect(returned).toBeInstanceOf(Promise);
    await expect(returned).rejects.toBe(sentinel);

    expect(provider.calls).toHaveLength(1);
    expect(normalizeMock).toHaveBeenCalledTimes(1);
    expect(normalizeMock.mock.calls[0]?.[0]).toBe(success);
    // The service does not catch, wrap, re-message, or log the normalizer's throw.
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
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
