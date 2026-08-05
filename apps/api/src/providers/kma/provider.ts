/**
 * The KMA (기상청) HTTP providers: the one place that performs network I/O. It ties the pieces
 * together — request validation and URL building (`request.ts` / `current-request.ts`), the
 * `fetch` call under a timeout and caller-abort that span the full transport (response header
 * *and* body read), HTTP-status classification, size-limited body reading (`read-response.ts`),
 * gateway-XML detection (`gateway-error.ts`), the response parsers (`parse-response.ts` /
 * `parse-current-response.ts`), request/response correlation, and slot grouping
 * (`group-forecast-items.ts` / `group-current-observation-items.ts`).
 *
 * Two independent operations share this file: the PR #5 **forecast** provider
 * (`createKmaForecastProvider`, 단기예보/초단기예보) and the PR #63 **current-observation** provider
 * (`createKmaCurrentObservationProvider`, 초단기실황). They share the transport lifecycle — timeout,
 * caller abort, HTTP-status classification, and size-limited body reading — via the private
 * {@link performKmaGetRequest} helper, so the security/timeout/abort/response-size policy is
 * defined exactly once. Everything after the raw body text (JSON parsing, KMA-specific response
 * classification, request/response correlation, slot grouping) stays separate per operation, since
 * the two response shapes are genuinely different (`fcstDate`/`fcstTime`/`fcstValue` vs. no
 * forecast target time and `obsrValue`). `fetchForecast`'s public contract, result/error kinds, and
 * behavior are unchanged from PR #5/#6/#7.
 *
 * Everything except the `fetch` itself is deterministic: the same request + same mocked response
 * always produce the same result. No system clock is read, no environment variable is touched at
 * import time, request objects and parsed pages are never mutated, and no global mutable state
 * exists. `receivedAt`-style timestamps are deliberately *not* added to either success result.
 *
 * Security is enforced by construction: no error variant carries the service key, the request URL
 * or query string, the raw response body, a raw upstream `resultMsg`/`returnAuthMsg`, a raw
 * `obsrValue`, or a `fetch` exception's message/stack. `HTTP_ERROR` keeps only the numeric status;
 * `NETWORK_ERROR`, `TIMEOUT`, and `ABORTED` carry nothing beyond their `kind`.
 */

import type { KmaForecastProduct } from '@life-weather/weather-core';

import {
  validateKmaProviderOptions,
  type KmaForecastProviderOptions,
  type KmaProviderConfigError,
  type ResolvedKmaProviderConfig,
} from './config.js';
import {
  buildKmaCurrentObservationRequestUrl,
  validateKmaCurrentObservationRequest,
  type KmaCurrentObservationRequest,
  type KmaCurrentRequestIssue,
} from './current-request.js';
import {
  groupKmaCurrentObservationItems,
  type KmaCurrentObservationSlot,
} from './group-current-observation-items.js';
import {
  groupKmaForecastItems,
  type KmaForecastSlot,
} from './group-forecast-items.js';
import { detectKmaGatewayError } from './gateway-error.js';
import {
  parseKmaCurrentObservationResponse,
  type KmaCurrentObservationPage,
  type KmaCurrentResponseIssue,
} from './parse-current-response.js';
import {
  parseKmaForecastResponse,
  type KmaForecastPage,
  type KmaResponseIssue,
} from './parse-response.js';
import { readResponseTextWithLimit } from './read-response.js';
import {
  buildKmaForecastRequestUrl,
  validateKmaForecastRequest,
  KMA_FIXED_NUM_OF_ROWS,
  KMA_FIXED_PAGE_NO,
  type KmaForecastRequest,
  type KmaRequestIssue,
} from './request.js';

// ---------------------------------------------------------------------------
// Shared transport (used by both the forecast and current-observation providers)
// ---------------------------------------------------------------------------

/**
 * The low-level transport errors every KMA HTTP operation can produce, before any
 * operation-specific JSON classification happens. Shared verbatim by
 * {@link KmaForecastProviderError} and {@link KmaCurrentObservationProviderError}.
 */
type KmaTransportError =
  | { readonly kind: 'TIMEOUT' }
  | { readonly kind: 'ABORTED' }
  | { readonly kind: 'NETWORK_ERROR' }
  | { readonly kind: 'HTTP_ERROR'; readonly status: number }
  | { readonly kind: 'RESPONSE_TOO_LARGE' };

type KmaTransportResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: KmaTransportError };

/** Cancel an error response's body so it is neither read nor left dangling. Errors are ignored. */
async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A body that cannot be cancelled is not a provider-level failure.
  }
}

/**
 * Perform one GET request under the shared KMA transport policy and return its raw response text
 * (or a transport error) — it never parses or classifies the KMA JSON payload, which stays each
 * operation's own responsibility. This is the single place that owns:
 *
 * - honouring an already-aborted caller signal without issuing a network request;
 * - the internal timeout timer and caller-abort listener, whose lifecycle spans the **whole**
 *   transport (the `fetch`, the HTTP-status decision, *and* the full body read), cleaned up
 *   exactly once in `finally` on every return/throw path;
 * - `redirect: 'error'` so a service key is never forwarded to a redirect target host;
 * - HTTP-status classification (`response.ok === false` → `HTTP_ERROR` with only the status code,
 *   body left unread);
 * - size-limited body reading (`read-response.ts`), with `RESPONSE_TOO_LARGE` outranking a
 *   concurrent abort and a `BODY_READ_ERROR` mapped by whichever abort (if any) fired during the
 *   read.
 *
 * A fetch implementation that ignores the abort signal and resolves a `Response` (or a body chunk)
 * anyway is still checked against the already-fixed abort reason before being treated as success.
 * Never throws for an expected transport failure; the raw exception, its message, and its `cause`
 * are never surfaced.
 */
async function performKmaGetRequest(
  config: ResolvedKmaProviderConfig,
  url: URL,
  options?: { readonly signal?: AbortSignal },
): Promise<KmaTransportResult> {
  const callerSignal = options?.signal;
  if (callerSignal?.aborted) {
    return { ok: false, error: { kind: 'ABORTED' } };
  }

  const controller = new AbortController();
  // The first firing (timeout vs. caller abort) wins and fixes the reason deterministically; the
  // second sees a non-null reason and does not overwrite it. JS runs these callbacks one at a time.
  let abortReason: 'TIMEOUT' | 'ABORTED' | null = null;
  const onCallerAbort = (): void => {
    if (abortReason === null) {
      abortReason = 'ABORTED';
    }
    controller.abort();
  };
  const timeoutId = setTimeout(() => {
    if (abortReason === null) {
      abortReason = 'TIMEOUT';
    }
    controller.abort();
  }, config.timeoutMs);
  if (callerSignal !== undefined) {
    callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }

  const toAbortResult = (): KmaTransportResult => {
    if (abortReason === 'ABORTED') {
      return { ok: false, error: { kind: 'ABORTED' } };
    }
    if (abortReason === 'TIMEOUT') {
      return { ok: false, error: { kind: 'TIMEOUT' } };
    }
    return { ok: false, error: { kind: 'NETWORK_ERROR' } };
  };

  try {
    const response = await config.fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });

    // A fetch impl that ignores the abort signal and resolves a Response anyway must not slip past
    // a timeout/abort that has already fired: honour the fixed reason before touching the body.
    if (abortReason !== null) {
      await cancelBody(response);
      return toAbortResult();
    }

    if (!response.ok) {
      await cancelBody(response);
      return { ok: false, error: { kind: 'HTTP_ERROR', status: response.status } };
    }

    const read = await readResponseTextWithLimit(response, config.maxResponseBytes);
    if (!read.ok) {
      // RESPONSE_TOO_LARGE is a hard cap and outranks a concurrent abort. A BODY_READ_ERROR is an
      // internal transport failure mapped by whichever abort (if any) fired during the read.
      if (read.error.kind === 'RESPONSE_TOO_LARGE') {
        return { ok: false, error: { kind: 'RESPONSE_TOO_LARGE' } };
      }
      return toAbortResult();
    }

    // The body read completed; if a timeout/abort fired during it, do not treat it as success.
    if (abortReason !== null) {
      return toAbortResult();
    }

    return { ok: true, text: read.text };
  } catch {
    // fetch (or a synchronous throw) failed: classify by which internal abort (if any) fired —
    // never by the raw exception.
    return toAbortResult();
  } finally {
    clearTimeout(timeoutId);
    if (callerSignal !== undefined) {
      callerSignal.removeEventListener('abort', onCallerAbort);
    }
  }
}

// ---------------------------------------------------------------------------
// Forecast provider (PR #5 / #6 / #7 — public contract and behavior unchanged)
// ---------------------------------------------------------------------------

/** A successful forecast fetch: the request identity, the page total, and the grouped slots. */
export interface KmaForecastProviderSuccess {
  readonly product: KmaForecastProduct;
  readonly baseDate: string;
  readonly baseTime: string;
  readonly nx: number;
  readonly ny: number;
  readonly totalCount: number;
  readonly slots: readonly KmaForecastSlot[];
}

/** The field a request/response correlation check found inconsistent. */
export type KmaResponseMismatchField =
  | 'pageNo'
  | 'numOfRows'
  | 'baseDate'
  | 'baseTime'
  | 'nx'
  | 'ny';

/**
 * Every way a forecast fetch can fail, as a discriminated union. Each variant carries only the
 * minimum needed to act on it — never a raw upstream string, URL, body, or exception.
 */
export type KmaForecastProviderError =
  | { readonly kind: 'INVALID_REQUEST'; readonly issues: readonly KmaRequestIssue[] }
  | KmaTransportError
  | { readonly kind: 'EMPTY_RESPONSE' }
  | { readonly kind: 'NON_JSON_RESPONSE' }
  | { readonly kind: 'INVALID_JSON' }
  | { readonly kind: 'GATEWAY_ERROR'; readonly reasonCode: string | null }
  | { readonly kind: 'KMA_UPSTREAM_ERROR'; readonly resultCode: string }
  | { readonly kind: 'KMA_INVALID_RESPONSE'; readonly issues: readonly KmaResponseIssue[] }
  | { readonly kind: 'DUPLICATE_CATEGORY'; readonly category: string; readonly slotKey: string }
  | { readonly kind: 'RESPONSE_MISMATCH'; readonly field: KmaResponseMismatchField }
  | {
      readonly kind: 'INCOMPLETE_PAGE';
      readonly totalCount: number;
      readonly receivedCount: number;
    };

export type KmaForecastProviderResult =
  | { readonly ok: true; readonly forecast: KmaForecastProviderSuccess }
  | { readonly ok: false; readonly error: KmaForecastProviderError };

/** The provider's single public method. */
export interface KmaForecastProvider {
  fetchForecast(
    request: KmaForecastRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<KmaForecastProviderResult>;
}

export type CreateKmaForecastProviderResult =
  | { readonly ok: true; readonly provider: KmaForecastProvider }
  | { readonly ok: false; readonly error: KmaProviderConfigError };

/** Wrap an error variant into a failed result. */
function fail(error: KmaForecastProviderError): KmaForecastProviderResult {
  return { ok: false, error };
}

/**
 * The first request/response correlation problem, in a fixed field order, or `null` if consistent.
 * Page metadata (`pageNo`, `numOfRows`) is checked before item identity so a paging anomaly is
 * reported ahead of a data mismatch. Item identity is checked *field-by-field across all items*
 * (all items' `baseDate`, then all items' `baseTime`, …) rather than item-by-item, so the returned
 * field is independent of item order: whichever field (in order) any item violates is reported.
 * An empty item array trivially passes (a `totalCount === 0` empty page is a valid success).
 */
function findResponseMismatch(
  request: KmaForecastRequest,
  page: KmaForecastPage,
): KmaResponseMismatchField | null {
  if (page.pageNo !== KMA_FIXED_PAGE_NO) {
    return 'pageNo';
  }
  if (page.numOfRows !== KMA_FIXED_NUM_OF_ROWS) {
    return 'numOfRows';
  }
  if (page.items.some((item) => item.baseDate !== request.baseDate)) {
    return 'baseDate';
  }
  if (page.items.some((item) => item.baseTime !== request.baseTime)) {
    return 'baseTime';
  }
  if (page.items.some((item) => item.nx !== request.nx)) {
    return 'nx';
  }
  if (page.items.some((item) => item.ny !== request.ny)) {
    return 'ny';
  }
  return null;
}

/**
 * Turn a validated success page into a provider result: correlate it against the request, reject
 * an incomplete page, then group its items into slots. Pure and deterministic.
 */
function interpretPage(
  request: KmaForecastRequest,
  page: KmaForecastPage,
): KmaForecastProviderResult {
  const mismatch = findResponseMismatch(request, page);
  if (mismatch !== null) {
    return fail({ kind: 'RESPONSE_MISMATCH', field: mismatch });
  }

  // The provider always requests numOfRows=1000 to get one complete issuance. If the grand total
  // still exceeds what arrived, the page is incomplete (this provider does not auto-paginate).
  // `items.length > totalCount` is already rejected by the PR #4 schema, so this is the only gap.
  if (page.totalCount > page.items.length) {
    return fail({
      kind: 'INCOMPLETE_PAGE',
      totalCount: page.totalCount,
      receivedCount: page.items.length,
    });
  }

  const grouped = groupKmaForecastItems(request.product, page.items);
  if (!grouped.ok) {
    return fail({
      kind: 'DUPLICATE_CATEGORY',
      category: grouped.error.category,
      slotKey: grouped.error.slotKey,
    });
  }

  return {
    ok: true,
    forecast: {
      product: request.product,
      baseDate: request.baseDate,
      baseTime: request.baseTime,
      nx: request.nx,
      ny: request.ny,
      totalCount: page.totalCount,
      slots: grouped.slots,
    },
  };
}

/**
 * Classify a 2xx response body (already read to text) into a provider result. Decision order:
 * empty → gateway XML → other XML/HTML (non-JSON) → JSON parse → PR #4 parser → page interpretation.
 * Pure and deterministic; the raw body never leaves this function.
 */
function classifyBody(
  request: KmaForecastRequest,
  text: string,
): KmaForecastProviderResult {
  const trimmed = text.trim();
  if (trimmed === '') {
    return fail({ kind: 'EMPTY_RESPONSE' });
  }

  // Anything starting with '<' is XML/HTML, never JSON: distinguish a portal gateway wrapper from
  // arbitrary XML/HTML. Only the gateway wrapper becomes GATEWAY_ERROR; the rest is NON_JSON.
  if (trimmed.startsWith('<')) {
    const gateway = detectKmaGatewayError(text);
    return gateway.isGatewayError
      ? fail({ kind: 'GATEWAY_ERROR', reasonCode: gateway.reasonCode })
      : fail({ kind: 'NON_JSON_RESPONSE' });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The raw SyntaxError message can echo body fragments, so it is never surfaced.
    return fail({ kind: 'INVALID_JSON' });
  }

  const parseResult = parseKmaForecastResponse(parsed);
  if (!parseResult.ok) {
    return parseResult.error.kind === 'UPSTREAM_ERROR'
      ? fail({ kind: 'KMA_UPSTREAM_ERROR', resultCode: parseResult.error.resultCode })
      : fail({ kind: 'KMA_INVALID_RESPONSE', issues: parseResult.error.issues });
  }

  return interpretPage(request, parseResult.page);
}

/**
 * Perform one forecast fetch. See the module comment for the full contract. Request validation and
 * URL building stay forecast-specific; the transport (timeout/abort/HTTP-status/body-size) is
 * delegated to the shared {@link performKmaGetRequest}, and the raw response text is then
 * classified by {@link classifyBody}.
 */
async function fetchForecast(
  config: ResolvedKmaProviderConfig,
  request: KmaForecastRequest,
  options?: { readonly signal?: AbortSignal },
): Promise<KmaForecastProviderResult> {
  const validation = validateKmaForecastRequest(request);
  if (!validation.ok) {
    return fail({ kind: 'INVALID_REQUEST', issues: validation.issues });
  }

  const built = buildKmaForecastRequestUrl(config.serviceKey, request);
  if (!built.ok) {
    // Unreachable in practice (the request already validated), handled for totality.
    return fail({ kind: 'INVALID_REQUEST', issues: built.issues });
  }

  const transport = await performKmaGetRequest(config, built.url, options);
  if (!transport.ok) {
    return fail(transport.error);
  }

  return classifyBody(request, transport.text);
}

/** Build a provider bound to a resolved config. */
function makeProvider(config: ResolvedKmaProviderConfig): KmaForecastProvider {
  return {
    fetchForecast(request, options) {
      return fetchForecast(config, request, options);
    },
  };
}

/**
 * Create a provider from explicit options. Returns a `CONFIG_ERROR` result (never throws) when the
 * options are invalid — see {@link validateKmaProviderOptions} for the rules.
 */
export function createKmaForecastProvider(
  options: KmaForecastProviderOptions,
): CreateKmaForecastProviderResult {
  const validated = validateKmaProviderOptions(options);
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }
  return { ok: true, provider: makeProvider(validated.config) };
}

/**
 * Create a provider from the environment, reading **only** `KMA_SERVICE_KEY`. The environment is
 * read when this function is *called* (default `process.env`), never at module import. A missing,
 * empty, or whitespace-only key yields a `CONFIG_ERROR`; the key value never appears in the error.
 */
export function createKmaForecastProviderFromEnv(
  env?: NodeJS.ProcessEnv,
  dependencies?: { readonly fetchImpl?: typeof fetch },
): CreateKmaForecastProviderResult {
  const source = env ?? process.env;
  return createKmaForecastProvider({
    // May be undefined; validateKmaProviderOptions maps a non-string key to CONFIG_ERROR/MISSING.
    serviceKey: source.KMA_SERVICE_KEY as string,
    fetchImpl: dependencies?.fetchImpl,
  });
}

// ---------------------------------------------------------------------------
// Current-observation provider (PR #63 — 초단기실황, getUltraSrtNcst)
// ---------------------------------------------------------------------------

/**
 * A successful current-observation fetch: the request identity, the page total, and at most one
 * grouped slot. After request/response correlation (below) every returned item is guaranteed to
 * share the request's exact `(baseDate, baseTime, nx, ny)`, so grouping can never yield more than
 * one slot. `slot` is `null` only for the documented defensive empty-success-page allowance
 * (`totalCount > 0` with zero items, or `totalCount === 0`) — see
 * `docs/kma-current-observation-provider.md`.
 */
export interface KmaCurrentObservationProviderSuccess {
  readonly baseDate: string;
  readonly baseTime: string;
  readonly nx: number;
  readonly ny: number;
  readonly totalCount: number;
  readonly slot: KmaCurrentObservationSlot | null;
}

/** The field a request/response correlation check found inconsistent. */
export type KmaCurrentResponseMismatchField =
  | 'pageNo'
  | 'numOfRows'
  | 'baseDate'
  | 'baseTime'
  | 'nx'
  | 'ny';

/**
 * Every way a current-observation fetch can fail. Same shape discipline as
 * {@link KmaForecastProviderError} — each variant carries only the minimum needed to act on it.
 */
export type KmaCurrentObservationProviderError =
  | { readonly kind: 'INVALID_REQUEST'; readonly issues: readonly KmaCurrentRequestIssue[] }
  | KmaTransportError
  | { readonly kind: 'EMPTY_RESPONSE' }
  | { readonly kind: 'NON_JSON_RESPONSE' }
  | { readonly kind: 'INVALID_JSON' }
  | { readonly kind: 'GATEWAY_ERROR'; readonly reasonCode: string | null }
  | { readonly kind: 'KMA_UPSTREAM_ERROR'; readonly resultCode: string }
  | { readonly kind: 'KMA_INVALID_RESPONSE'; readonly issues: readonly KmaCurrentResponseIssue[] }
  | { readonly kind: 'DUPLICATE_CATEGORY'; readonly category: string; readonly slotKey: string }
  | { readonly kind: 'RESPONSE_MISMATCH'; readonly field: KmaCurrentResponseMismatchField }
  | {
      readonly kind: 'INCOMPLETE_PAGE';
      readonly totalCount: number;
      readonly receivedCount: number;
    };

export type KmaCurrentObservationProviderResult =
  | { readonly ok: true; readonly observation: KmaCurrentObservationProviderSuccess }
  | { readonly ok: false; readonly error: KmaCurrentObservationProviderError };

/** The current-observation provider's single public method. */
export interface KmaCurrentObservationProvider {
  fetchCurrentObservation(
    request: KmaCurrentObservationRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<KmaCurrentObservationProviderResult>;
}

export type CreateKmaCurrentObservationProviderResult =
  | { readonly ok: true; readonly provider: KmaCurrentObservationProvider }
  | { readonly ok: false; readonly error: KmaProviderConfigError };

/** Wrap an error variant into a failed current-observation result. */
function failCurrent(
  error: KmaCurrentObservationProviderError,
): KmaCurrentObservationProviderResult {
  return { ok: false, error };
}

/**
 * The first request/response correlation problem for a current-observation page, in the same fixed
 * field order as the forecast provider's {@link findResponseMismatch}. Item identity is checked
 * field-by-field across all items so the result is independent of item order.
 */
function findCurrentResponseMismatch(
  request: KmaCurrentObservationRequest,
  page: KmaCurrentObservationPage,
): KmaCurrentResponseMismatchField | null {
  // The current-observation request shares the exact same fixed pagination as the forecast
  // request (pageNo=1, numOfRows=1000 — see request.ts / current-request.ts), so this reuses the
  // same imported constants rather than redefining identical values.
  if (page.pageNo !== KMA_FIXED_PAGE_NO) {
    return 'pageNo';
  }
  if (page.numOfRows !== KMA_FIXED_NUM_OF_ROWS) {
    return 'numOfRows';
  }
  if (page.items.some((item) => item.baseDate !== request.baseDate)) {
    return 'baseDate';
  }
  if (page.items.some((item) => item.baseTime !== request.baseTime)) {
    return 'baseTime';
  }
  if (page.items.some((item) => item.nx !== request.nx)) {
    return 'nx';
  }
  if (page.items.some((item) => item.ny !== request.ny)) {
    return 'ny';
  }
  return null;
}

/**
 * Turn a validated success page into a current-observation provider result: correlate it against
 * the request, reject an incomplete page, then group its items. Because correlation already
 * guarantees every item shares the request's exact identity, grouping yields at most one slot.
 */
function interpretCurrentPage(
  request: KmaCurrentObservationRequest,
  page: KmaCurrentObservationPage,
): KmaCurrentObservationProviderResult {
  const mismatch = findCurrentResponseMismatch(request, page);
  if (mismatch !== null) {
    return failCurrent({ kind: 'RESPONSE_MISMATCH', field: mismatch });
  }

  if (page.totalCount > page.items.length) {
    return failCurrent({
      kind: 'INCOMPLETE_PAGE',
      totalCount: page.totalCount,
      receivedCount: page.items.length,
    });
  }

  const grouped = groupKmaCurrentObservationItems(page.items);
  if (!grouped.ok) {
    return failCurrent({
      kind: 'DUPLICATE_CATEGORY',
      category: grouped.error.category,
      slotKey: grouped.error.slotKey,
    });
  }

  return {
    ok: true,
    observation: {
      baseDate: request.baseDate,
      baseTime: request.baseTime,
      nx: request.nx,
      ny: request.ny,
      totalCount: page.totalCount,
      slot: grouped.slots[0] ?? null,
    },
  };
}

/**
 * Classify a 2xx current-observation response body (already read to text). Same decision order as
 * the forecast provider's `classifyBody`: empty → gateway XML → other XML/HTML → JSON parse →
 * response parser → page interpretation. Pure and deterministic; the raw body never leaves this
 * function.
 */
function classifyCurrentBody(
  request: KmaCurrentObservationRequest,
  text: string,
): KmaCurrentObservationProviderResult {
  const trimmed = text.trim();
  if (trimmed === '') {
    return failCurrent({ kind: 'EMPTY_RESPONSE' });
  }

  if (trimmed.startsWith('<')) {
    const gateway = detectKmaGatewayError(text);
    return gateway.isGatewayError
      ? failCurrent({ kind: 'GATEWAY_ERROR', reasonCode: gateway.reasonCode })
      : failCurrent({ kind: 'NON_JSON_RESPONSE' });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failCurrent({ kind: 'INVALID_JSON' });
  }

  const parseResult = parseKmaCurrentObservationResponse(parsed);
  if (!parseResult.ok) {
    return parseResult.error.kind === 'UPSTREAM_ERROR'
      ? failCurrent({ kind: 'KMA_UPSTREAM_ERROR', resultCode: parseResult.error.resultCode })
      : failCurrent({ kind: 'KMA_INVALID_RESPONSE', issues: parseResult.error.issues });
  }

  return interpretCurrentPage(request, parseResult.page);
}

/**
 * Perform one current-observation fetch. Request validation and URL building are
 * current-observation-specific; the transport is the same shared {@link performKmaGetRequest} the
 * forecast provider uses, so both operations are bound by the identical timeout/abort/HTTP-status/
 * body-size policy.
 */
async function fetchCurrentObservation(
  config: ResolvedKmaProviderConfig,
  request: KmaCurrentObservationRequest,
  options?: { readonly signal?: AbortSignal },
): Promise<KmaCurrentObservationProviderResult> {
  const validation = validateKmaCurrentObservationRequest(request);
  if (!validation.ok) {
    return failCurrent({ kind: 'INVALID_REQUEST', issues: validation.issues });
  }

  const built = buildKmaCurrentObservationRequestUrl(config.serviceKey, request);
  if (!built.ok) {
    // Unreachable in practice (the request already validated), handled for totality.
    return failCurrent({ kind: 'INVALID_REQUEST', issues: built.issues });
  }

  const transport = await performKmaGetRequest(config, built.url, options);
  if (!transport.ok) {
    return failCurrent(transport.error);
  }

  return classifyCurrentBody(request, transport.text);
}

/** Build a current-observation provider bound to a resolved config. */
function makeCurrentObservationProvider(
  config: ResolvedKmaProviderConfig,
): KmaCurrentObservationProvider {
  return {
    fetchCurrentObservation(request, options) {
      return fetchCurrentObservation(config, request, options);
    },
  };
}

/**
 * Create a current-observation provider from explicit options. Reuses the exact same option shape
 * and validation as the forecast provider ({@link KmaForecastProviderOptions} /
 * {@link validateKmaProviderOptions}) — both target the same 공공데이터포털 service with the same
 * `KMA_SERVICE_KEY`, timeout, and response-size policy. Returns a `CONFIG_ERROR` result (never
 * throws) when the options are invalid.
 */
export function createKmaCurrentObservationProvider(
  options: KmaForecastProviderOptions,
): CreateKmaCurrentObservationProviderResult {
  const validated = validateKmaProviderOptions(options);
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }
  return { ok: true, provider: makeCurrentObservationProvider(validated.config) };
}

/**
 * Create a current-observation provider from the environment, reading **only**
 * `KMA_SERVICE_KEY` — identical env-reading policy to {@link createKmaForecastProviderFromEnv}
 * (read at call time, never at module import; the key value never appears in the error).
 */
export function createKmaCurrentObservationProviderFromEnv(
  env?: NodeJS.ProcessEnv,
  dependencies?: { readonly fetchImpl?: typeof fetch },
): CreateKmaCurrentObservationProviderResult {
  const source = env ?? process.env;
  return createKmaCurrentObservationProvider({
    serviceKey: source.KMA_SERVICE_KEY as string,
    fetchImpl: dependencies?.fetchImpl,
  });
}
