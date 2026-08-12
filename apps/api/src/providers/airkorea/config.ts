/**
 * AirKorea (에어코리아) provider configuration: validate the server-only `AIRKOREA_SERVICE_KEY` and
 * the defensive operational options, and *resolve* them into a fully-populated internal config.
 * Nothing here fetches; nothing here reads an environment variable at *module* scope —
 * `createAirKoreaCurrentAirQualityProvider*` (in `provider.ts`) call
 * {@link validateAirKoreaProviderOptions} at *call* time, so importing this module never touches
 * `process.env`.
 *
 * This is an **independent** config module for the AirKorea provider namespace — it intentionally
 * does not import or reuse `../kma/config.ts`'s types, even though the shape is similar, per the
 * project's provider-namespace isolation policy (see `docs/airkorea-current-air-quality-provider.md`).
 *
 * A configuration problem is reported as a value (`{ ok: false, error }`), never thrown, and never
 * carries the service key. The service key is only ever validated for *presence/shape* here — its
 * actual characters never appear in {@link AirKoreaProviderConfigError}.
 */

/**
 * Public options for {@link createAirKoreaCurrentAirQualityProvider}.
 *
 * - `serviceKey` — the 공공데이터포털 **일반 인증키(Decoding)**. It is *not* trimmed, decoded, or
 *   re-encoded here; the URL builder encodes it exactly once.
 * - `fetchImpl` — injectable `fetch` for tests; defaults to `globalThis.fetch`.
 * - `timeoutMs` — per-request timeout; defaults to {@link DEFAULT_TIMEOUT_MS}.
 * - `maxResponseBytes` — hard cap on the response body size; defaults to
 *   {@link DEFAULT_MAX_RESPONSE_BYTES}.
 */
export interface AirKoreaProviderOptions {
  readonly serviceKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

/**
 * Default per-request timeout. **This is a project defensive default, not an official AirKorea
 * value** — the 활용가이드 documents no client timeout. Chosen to fail fast without tripping on a
 * normal upstream response (평균 응답 시간 500ms per the technical document).
 */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Default maximum response body size (4 MiB). **Project defensive default, not an official
 * AirKorea value.** A single station's one-day (`dataTerm=DAILY`) page of hourly rows is far
 * smaller; the cap bounds memory against a pathological or hostile body.
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * A configuration error, returned (never thrown) by the provider factories. Names only which
 * field was wrong and whether it was absent (`MISSING`) or present-but-malformed (`INVALID`). The
 * offending value — above all the service key — is never included.
 */
export interface AirKoreaProviderConfigError {
  readonly kind: 'CONFIG_ERROR';
  readonly field: 'serviceKey' | 'timeoutMs' | 'maxResponseBytes';
  readonly reason: 'MISSING' | 'INVALID';
}

/**
 * A validated, fully-resolved configuration. Every optional option has been defaulted, so the
 * provider consumes concrete values. `serviceKey` is carried verbatim (never trimmed/decoded).
 */
export interface ResolvedAirKoreaProviderConfig {
  readonly serviceKey: string;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export type ValidateAirKoreaProviderOptionsResult =
  | { readonly ok: true; readonly config: ResolvedAirKoreaProviderConfig }
  | { readonly ok: false; readonly error: AirKoreaProviderConfigError };

/**
 * The runtime-checkable shape the validator inspects. Intentionally looser than
 * {@link AirKoreaProviderOptions} (`serviceKey` may be absent) so the env factory can hand it a
 * possibly-unset `AIRKOREA_SERVICE_KEY` and still get a `CONFIG_ERROR` rather than a thrown
 * `TypeError`.
 */
export interface ValidatableAirKoreaProviderOptions {
  readonly serviceKey?: unknown;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

/** A positive integer bound (used for both `timeoutMs` and `maxResponseBytes`). */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Whether `value` is a record-like object we can read options off — a non-null, non-array object.
 * Deliberately not a strict plain-object check (a class instance or custom-prototype object also
 * passes); sufficient here because the factories are called from internal server code.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate and resolve provider options.
 *
 * The input is treated as `unknown`: a non-object (`null`, `undefined`, a string/number/boolean,
 * an array, a function) does not throw on a property read — it is reported as
 * `CONFIG_ERROR(serviceKey, MISSING)`, the same as an object with no usable key, so the factories
 * stay *total* under a runtime type bypass.
 *
 * `serviceKey` rules (never trimmed):
 * - not a string, `''`, or whitespace-only → `MISSING` (no usable key was supplied).
 * - present but with leading/trailing whitespace → `INVALID` (a key is there but malformed; it is
 *   not silently trimmed, because a trimmed key would authenticate differently than what was set).
 *
 * `timeoutMs` / `maxResponseBytes`: `undefined` → the documented default; otherwise must be a
 * positive integer (rejects `0`, negatives, non-integers, `NaN`, `Infinity`, and non-numbers) →
 * else `INVALID`. Fields are checked in a fixed order (`serviceKey`, `timeoutMs`,
 * `maxResponseBytes`) so the first error is deterministic. The input object is never mutated.
 */
export function validateAirKoreaProviderOptions(
  input: unknown,
): ValidateAirKoreaProviderOptionsResult {
  if (!isRecord(input)) {
    return { ok: false, error: { kind: 'CONFIG_ERROR', field: 'serviceKey', reason: 'MISSING' } };
  }

  const { serviceKey, fetchImpl, timeoutMs, maxResponseBytes } =
    input as ValidatableAirKoreaProviderOptions;

  if (typeof serviceKey !== 'string' || serviceKey.trim() === '') {
    return { ok: false, error: { kind: 'CONFIG_ERROR', field: 'serviceKey', reason: 'MISSING' } };
  }
  if (serviceKey !== serviceKey.trim()) {
    return { ok: false, error: { kind: 'CONFIG_ERROR', field: 'serviceKey', reason: 'INVALID' } };
  }

  if (timeoutMs !== undefined && !isPositiveInteger(timeoutMs)) {
    return { ok: false, error: { kind: 'CONFIG_ERROR', field: 'timeoutMs', reason: 'INVALID' } };
  }

  if (maxResponseBytes !== undefined && !isPositiveInteger(maxResponseBytes)) {
    return {
      ok: false,
      error: { kind: 'CONFIG_ERROR', field: 'maxResponseBytes', reason: 'INVALID' },
    };
  }

  return {
    ok: true,
    config: {
      serviceKey,
      fetchImpl: fetchImpl ?? globalThis.fetch,
      timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxResponseBytes: maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    },
  };
}
