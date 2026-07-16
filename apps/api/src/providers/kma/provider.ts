/**
 * The KMA (기상청) HTTP forecast provider: the one place that performs network I/O. It ties the
 * pieces together — request validation and URL building (`request.ts`), the `fetch` call with a
 * timeout and caller-abort handling, HTTP-status classification, size-limited body reading
 * (`read-response.ts`), gateway-XML detection (`gateway-error.ts`), the PR #4 response parser
 * (`parse-response.ts`), request/response correlation, and slot grouping
 * (`group-forecast-items.ts`).
 *
 * Everything except the `fetch` itself is deterministic: the same request + same mocked response
 * always produce the same result. No system clock is read, no environment variable is touched at
 * import time, the request object and the parsed page are never mutated, and no global mutable
 * state exists. `receivedAt`-style timestamps are deliberately *not* added to the success result.
 *
 * Security is enforced by construction: no error variant carries the service key, the request URL
 * or query string, the raw response body, a raw upstream `resultMsg`/`returnAuthMsg`, or a `fetch`
 * exception's message/stack. `HTTP_ERROR` keeps only the numeric status; `NETWORK_ERROR`,
 * `TIMEOUT`, and `ABORTED` carry nothing beyond their `kind`.
 */

import type { KmaForecastProduct } from '@life-weather/weather-core';

import {
  validateKmaProviderOptions,
  type KmaForecastProviderOptions,
  type KmaProviderConfigError,
  type ResolvedKmaProviderConfig,
} from './config';
import {
  groupKmaForecastItems,
  type KmaForecastSlot,
} from './group-forecast-items';
import { detectKmaGatewayError } from './gateway-error';
import {
  parseKmaForecastResponse,
  type KmaForecastPage,
  type KmaResponseIssue,
} from './parse-response';
import { readResponseTextWithLimit } from './read-response';
import {
  buildKmaForecastRequestUrl,
  validateKmaForecastRequest,
  KMA_FIXED_NUM_OF_ROWS,
  KMA_FIXED_PAGE_NO,
  type KmaForecastRequest,
  type KmaRequestIssue,
} from './request';

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
  | { readonly kind: 'TIMEOUT' }
  | { readonly kind: 'ABORTED' }
  | { readonly kind: 'NETWORK_ERROR' }
  | { readonly kind: 'HTTP_ERROR'; readonly status: number }
  | { readonly kind: 'RESPONSE_TOO_LARGE' }
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

/** Cancel an error response's body so it is neither read nor left dangling. Errors are ignored. */
async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A body that cannot be cancelled is not a provider-level failure.
  }
}

/**
 * Perform one forecast fetch. See the module comment for the full contract. The timeout timer and
 * the caller-abort listener are always cleaned up (in `finally`), whether the fetch resolves,
 * rejects, or is aborted.
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

  const callerSignal = options?.signal;
  if (callerSignal?.aborted) {
    // Honour an already-aborted caller signal without issuing a network request.
    return fail({ kind: 'ABORTED' });
  }

  const built = buildKmaForecastRequestUrl(config.serviceKey, request);
  if (!built.ok) {
    // Unreachable in practice (the request already validated), handled for totality.
    return fail({ kind: 'INVALID_REQUEST', issues: built.issues });
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

  let response: Response;
  try {
    response = await config.fetchImpl(built.url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
  } catch {
    // Classify the rejection by which internal abort (if any) fired — never by the raw exception.
    if (abortReason === 'ABORTED') {
      return fail({ kind: 'ABORTED' });
    }
    if (abortReason === 'TIMEOUT') {
      return fail({ kind: 'TIMEOUT' });
    }
    return fail({ kind: 'NETWORK_ERROR' });
  } finally {
    clearTimeout(timeoutId);
    if (callerSignal !== undefined) {
      callerSignal.removeEventListener('abort', onCallerAbort);
    }
  }

  if (!response.ok) {
    await cancelBody(response);
    return fail({ kind: 'HTTP_ERROR', status: response.status });
  }

  const read = await readResponseTextWithLimit(response, config.maxResponseBytes);
  if (!read.ok) {
    return fail({ kind: 'RESPONSE_TOO_LARGE' });
  }

  return classifyBody(request, read.text);
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
