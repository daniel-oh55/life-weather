/**
 * Provider configuration: validate the server-only `KMA_SERVICE_KEY` and the defensive
 * operational options, and *resolve* them into a fully-populated internal config. Nothing here
 * fetches; nothing here reads an environment variable at *module* scope. `createKmaForecastProvider*`
 * (in `provider.ts`) call {@link validateKmaProviderOptions} at *call* time, so importing this
 * module never touches `process.env`.
 *
 * A configuration problem is reported as a value (`{ ok: false, error }`), never thrown, and never
 * carries the service key. The service key is only ever validated for *presence/shape* here — its
 * actual characters never appear in {@link KmaProviderConfigError}.
 */

/**
 * Public options for {@link createKmaForecastProvider}.
 *
 * - `serviceKey` — the 공공데이터포털 **일반 인증키(Decoding)** (see `docs/kma-http-provider.md`). It
 *   is *not* trimmed, decoded, or re-encoded here; the URL builder encodes it exactly once.
 * - `fetchImpl` — injectable `fetch` for tests; defaults to `globalThis.fetch`.
 * - `timeoutMs` — per-request timeout; defaults to {@link DEFAULT_TIMEOUT_MS}.
 * - `maxResponseBytes` — hard cap on the response body size; defaults to
 *   {@link DEFAULT_MAX_RESPONSE_BYTES}.
 */
export interface KmaForecastProviderOptions {
  readonly serviceKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

/**
 * Default per-request timeout. **This is a project defensive default, not an official KMA value** —
 * the 활용가이드 documents no client timeout. Chosen to fail fast without tripping on a normal
 * upstream response.
 */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Default maximum response body size (4 MiB). **Project defensive default, not an official KMA
 * value.** A full `numOfRows=1000` forecast page is far smaller; the cap bounds memory against a
 * pathological or hostile body.
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * A configuration error, returned (never thrown) by the provider factories. Names only which
 * field was wrong and whether it was absent (`MISSING`) or present-but-malformed (`INVALID`).
 * The offending value — above all the service key — is never included.
 */
export interface KmaProviderConfigError {
  readonly kind: 'CONFIG_ERROR';
  readonly field: 'serviceKey' | 'timeoutMs' | 'maxResponseBytes';
  readonly reason: 'MISSING' | 'INVALID';
}

/**
 * A validated, fully-resolved configuration. Every optional option has been defaulted, so the
 * provider consumes concrete values. `serviceKey` is carried verbatim (never trimmed/decoded).
 */
export interface ResolvedKmaProviderConfig {
  readonly serviceKey: string;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export type ValidateKmaProviderOptionsResult =
  | { readonly ok: true; readonly config: ResolvedKmaProviderConfig }
  | { readonly ok: false; readonly error: KmaProviderConfigError };

/**
 * The runtime-checkable shape the validator inspects. It is intentionally looser than
 * {@link KmaForecastProviderOptions} (`serviceKey` may be absent) so the env factory can hand it a
 * possibly-unset `KMA_SERVICE_KEY` and still get a `CONFIG_ERROR` rather than a thrown `TypeError`.
 */
export interface ValidatableKmaProviderOptions {
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
 * This is deliberately *not* a strict plain-object check: a class instance or an object with a
 * custom prototype also passes. That is sufficient here because the factories are called from
 * internal server code; hostile-prototype/`Proxy` hardening is out of scope for this PR.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate and resolve provider options.
 *
 * The input is treated as `unknown`: a non-object (`null`, `undefined`, a string/number/boolean, an
 * array, a function) does not throw on a property read — it is reported as `CONFIG_ERROR(serviceKey,
 * MISSING)`, the same as an object with no usable key, so the factories stay *total* under a runtime
 * type bypass.
 *
 * `serviceKey` rules (never trimmed):
 * - not a string, `''`, or whitespace-only → `MISSING` (no usable key was supplied).
 * - present but with leading/trailing whitespace → `INVALID` (a key is there but malformed; we do
 *   not silently trim it, because a trimmed key would authenticate differently than what was set).
 *
 * `timeoutMs` / `maxResponseBytes`: `undefined` → the documented default; otherwise must be a
 * positive integer (rejects `0`, negatives, non-integers, `NaN`, `Infinity`, and non-numbers) →
 * else `INVALID`. Fields are checked in a fixed order (`serviceKey`, `timeoutMs`,
 * `maxResponseBytes`) so the first error is deterministic. The input object is never mutated.
 */
export function validateKmaProviderOptions(
  input: unknown,
): ValidateKmaProviderOptionsResult {
  if (!isRecord(input)) {
    return { ok: false, error: { kind: 'CONFIG_ERROR', field: 'serviceKey', reason: 'MISSING' } };
  }

  const { serviceKey, fetchImpl, timeoutMs, maxResponseBytes } =
    input as ValidatableKmaProviderOptions;

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
