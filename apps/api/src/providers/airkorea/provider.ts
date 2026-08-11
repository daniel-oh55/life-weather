/**
 * The AirKorea (에어코리아) HTTP provider: the one place in this namespace that performs network
 * I/O. It ties the pieces together — request validation and URL building (`current-request.ts`),
 * the `fetch` call under a timeout and caller-abort that spans the full transport (response header
 * *and* body read), HTTP-status classification, size-limited body reading (`read-response.ts`),
 * the response parser (`parse-current-response.ts`), request/response correlation, and the "latest
 * measurement" selection (`docs/airkorea-current-air-quality-provider.md`, §14).
 *
 * This is an **independent** provider — it does not import any private helper from
 * `../kma/provider.ts`, per the project's provider-namespace isolation policy. It provides the same
 * class of transport safety guarantees (injected `fetchImpl`, GET only, `Accept: application/json`,
 * `redirect: 'error'`, caller `AbortSignal` support, a pre-aborted signal performing zero fetches, a
 * project-owned finite timeout, a response-size hard cap, and no key/raw-body/exception-message
 * leakage in any error variant) as an independent, smaller implementation.
 *
 * Everything except the `fetch` itself is deterministic: the same request + same mocked response
 * always produce the same result. No system clock is read, no environment variable is touched at
 * import time, request objects and parsed pages are never mutated, and no global mutable state
 * exists. This provider never retries, never caches, and never resolves a station — those are
 * explicitly out of scope for this PR (see the module docblock referenced above).
 */

import {
  validateAirKoreaProviderOptions,
  type AirKoreaProviderOptions,
  type AirKoreaProviderConfigError,
  type ResolvedAirKoreaProviderConfig,
} from './config.js';
import {
  buildAirKoreaCurrentAirQualityRequestUrl,
  validateAirKoreaCurrentAirQualityRequest,
  AIRKOREA_FIXED_NUM_OF_ROWS,
  AIRKOREA_FIXED_PAGE_NO,
  type AirKoreaCurrentAirQualityRequest,
  type AirKoreaCurrentRequestIssue,
} from './current-request.js';
import {
  parseAirKoreaCurrentAirQualityResponse,
  type AirKoreaCurrentAirQualityPage,
  type AirKoreaCurrentResponseIssue,
} from './parse-current-response.js';
import { readAirKoreaResponseTextWithLimit } from './read-response.js';

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

type AirKoreaTransportError =
  | { readonly kind: 'TIMEOUT' }
  | { readonly kind: 'ABORTED' }
  | { readonly kind: 'NETWORK_ERROR' }
  | { readonly kind: 'HTTP_ERROR'; readonly status: number }
  | { readonly kind: 'RESPONSE_TOO_LARGE' };

type AirKoreaTransportResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: AirKoreaTransportError };

/**
 * Start a best-effort, non-blocking cancellation of a response body that will not be read. A
 * *cleanup starter*, not a cleanup guarantee: nothing awaits this function's outcome.
 */
async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Not a provider-level failure.
  }
}

type AbortRaceOutcome<T> = { readonly aborted: true } | { readonly aborted: false; readonly value: T };

/**
 * Race `work` against `abortWait` (resolves the instant the shared timeout/caller-abort fires) and
 * return as soon as either settles. This is what makes {@link performAirKoreaGetRequest} immune to
 * a `fetchImpl` that ignores the abort signal and never settles — awaiting `work` directly would
 * otherwise block forever. `work` is documented to never reject (its call site folds its own
 * failure into a value); the `.catch` here is a defensive backstop only.
 */
function raceAgainstAbort<T>(
  work: Promise<T>,
  abortWait: Promise<void>,
  onLateSettle: (value: T) => void,
): Promise<AbortRaceOutcome<T>> {
  const settled: Promise<AbortRaceOutcome<T>> = work.then((value) => ({ aborted: false, value }));
  const aborted: Promise<AbortRaceOutcome<T>> = abortWait.then(() => ({ aborted: true }));

  return Promise.race([settled, aborted]).then((outcome) => {
    if (outcome.aborted) {
      work.then(onLateSettle).catch(() => {
        // `work` never rejects; defensive backstop only.
      });
    }
    return outcome;
  });
}

type AirKoreaFetchOutcome = { readonly ok: true; readonly response: Response } | { readonly ok: false };

/**
 * Call `config.fetchImpl` and never reject: a network failure or synchronous throw is folded into
 * `{ ok: false }`, which is what makes this promise safe to hand to {@link raceAgainstAbort}.
 */
async function invokeFetch(
  config: ResolvedAirKoreaProviderConfig,
  url: URL,
  signal: AbortSignal,
): Promise<AirKoreaFetchOutcome> {
  try {
    const response = await config.fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal,
    });
    return { ok: true, response };
  } catch {
    return { ok: false };
  }
}

/**
 * Perform one GET request under the shared AirKorea transport policy and return its raw response
 * text (or a transport error) — never parses or classifies the AirKorea JSON payload. Owns:
 *
 * - honouring an already-aborted caller signal without issuing a network request;
 * - the internal timeout timer and caller-abort listener, spanning the fetch, the HTTP-status
 *   decision, and the full body read, cleaned up exactly once in `finally`;
 * - `redirect: 'error'` so a service key is never forwarded to a redirect target host;
 * - HTTP-status classification (`response.ok === false` → `HTTP_ERROR` with only the status code);
 * - size-limited body reading (`read-response.ts`).
 *
 * Never throws for an expected transport failure; the raw exception, its message, and its `cause`
 * are never surfaced.
 */
async function performAirKoreaGetRequest(
  config: ResolvedAirKoreaProviderConfig,
  url: URL,
  options?: { readonly signal?: AbortSignal },
): Promise<AirKoreaTransportResult> {
  const callerSignal = options?.signal;
  if (callerSignal?.aborted) {
    return { ok: false, error: { kind: 'ABORTED' } };
  }

  const controller = new AbortController();
  let abortReason: 'TIMEOUT' | 'ABORTED' | null = null;
  let signalAbortWait!: () => void;
  const abortWait = new Promise<void>((resolve) => {
    signalAbortWait = resolve;
  });
  const fireAbort = (reason: 'TIMEOUT' | 'ABORTED'): void => {
    if (abortReason === null) {
      abortReason = reason;
    }
    controller.abort();
    signalAbortWait();
  };
  const onCallerAbort = (): void => fireAbort('ABORTED');
  const timeoutId = setTimeout(() => fireAbort('TIMEOUT'), config.timeoutMs);
  if (callerSignal !== undefined) {
    callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }

  const toAbortResult = (): AirKoreaTransportResult => {
    if (abortReason === 'ABORTED') {
      return { ok: false, error: { kind: 'ABORTED' } };
    }
    if (abortReason === 'TIMEOUT') {
      return { ok: false, error: { kind: 'TIMEOUT' } };
    }
    return { ok: false, error: { kind: 'NETWORK_ERROR' } };
  };

  try {
    const fetchRace = await raceAgainstAbort(
      invokeFetch(config, url, controller.signal),
      abortWait,
      (outcome) => {
        if (outcome.ok) {
          void cancelBody(outcome.response);
        }
      },
    );
    if (fetchRace.aborted) {
      return toAbortResult();
    }
    if (!fetchRace.value.ok) {
      return toAbortResult();
    }
    const response = fetchRace.value.response;

    if (abortReason !== null) {
      void cancelBody(response);
      return toAbortResult();
    }

    if (!response.ok) {
      void cancelBody(response);
      return { ok: false, error: { kind: 'HTTP_ERROR', status: response.status } };
    }

    const read = await readAirKoreaResponseTextWithLimit(response, config.maxResponseBytes, {
      signal: controller.signal,
    });
    if (!read.ok) {
      if (read.error.kind === 'RESPONSE_TOO_LARGE') {
        return { ok: false, error: { kind: 'RESPONSE_TOO_LARGE' } };
      }
      return toAbortResult();
    }

    if (abortReason !== null) {
      return toAbortResult();
    }

    return { ok: true, text: read.text };
  } catch {
    return toAbortResult();
  } finally {
    clearTimeout(timeoutId);
    if (callerSignal !== undefined) {
      callerSignal.removeEventListener('abort', onCallerAbort);
    }
  }
}

// ---------------------------------------------------------------------------
// Current air-quality provider
// ---------------------------------------------------------------------------

/**
 * A successful current-air-quality fetch: the selected (latest) validated raw item's fields. Only
 * what `normalize-current.ts` needs, plus `stationName` for internal traceability — never a raw
 * body, URL, or service key.
 */
export interface AirKoreaCurrentAirQualityProviderSuccess {
  readonly stationName: string;
  readonly dataTime: string;
  readonly pm10Value?: string;
  readonly pm25Value?: string;
  readonly o3Value?: string;
  readonly khaiValue?: string;
  readonly khaiGrade?: string;
  readonly pm10Grade?: string;
  readonly pm25Grade?: string;
  readonly o3Grade?: string;
}

/** The field a request/response correlation check found inconsistent. */
export type AirKoreaResponseMismatchField = 'pageNo' | 'numOfRows' | 'stationName';

/**
 * Every way a current-air-quality fetch can fail, as a discriminated union. Each variant carries
 * only the minimum needed to act on it — never a raw upstream string, URL, body, or exception.
 */
export type AirKoreaCurrentAirQualityProviderError =
  | { readonly kind: 'INVALID_REQUEST'; readonly issues: readonly AirKoreaCurrentRequestIssue[] }
  | AirKoreaTransportError
  | { readonly kind: 'EMPTY_RESPONSE' }
  | { readonly kind: 'NON_JSON_RESPONSE' }
  | { readonly kind: 'INVALID_JSON' }
  | { readonly kind: 'AIRKOREA_UPSTREAM_ERROR'; readonly resultCode: string }
  | {
      readonly kind: 'AIRKOREA_INVALID_RESPONSE';
      readonly issues: readonly AirKoreaCurrentResponseIssue[];
    }
  | { readonly kind: 'RESPONSE_MISMATCH'; readonly field: AirKoreaResponseMismatchField }
  | { readonly kind: 'INCOMPLETE_PAGE'; readonly totalCount: number; readonly receivedCount: number }
  | { readonly kind: 'NO_DATA' };

export type AirKoreaCurrentAirQualityProviderResult =
  | { readonly ok: true; readonly observation: AirKoreaCurrentAirQualityProviderSuccess }
  | { readonly ok: false; readonly error: AirKoreaCurrentAirQualityProviderError };

/** The provider's single public method. */
export interface AirKoreaCurrentAirQualityProvider {
  fetchCurrentAirQuality(
    request: AirKoreaCurrentAirQualityRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<AirKoreaCurrentAirQualityProviderResult>;
}

export type CreateAirKoreaCurrentAirQualityProviderResult =
  | { readonly ok: true; readonly provider: AirKoreaCurrentAirQualityProvider }
  | { readonly ok: false; readonly error: AirKoreaProviderConfigError };

function fail(error: AirKoreaCurrentAirQualityProviderError): AirKoreaCurrentAirQualityProviderResult {
  return { ok: false, error };
}

/**
 * The first request/response correlation problem, in a fixed field order (`pageNo`, `numOfRows`,
 * then `stationName` checked field-by-field across every item so the result is independent of item
 * order), or `null` if consistent. An empty item array trivially passes `stationName` correlation.
 */
function findResponseMismatch(
  request: AirKoreaCurrentAirQualityRequest,
  page: AirKoreaCurrentAirQualityPage,
): AirKoreaResponseMismatchField | null {
  if (page.pageNo !== AIRKOREA_FIXED_PAGE_NO) {
    return 'pageNo';
  }
  if (page.numOfRows !== AIRKOREA_FIXED_NUM_OF_ROWS) {
    return 'numOfRows';
  }
  if (page.items.some((item) => item.stationName !== request.stationName)) {
    return 'stationName';
  }
  return null;
}

/**
 * Select the *latest* item among a validated page's items by comparing each item's `dataTime`
 * string directly (fixed-width, zero-padded `YYYY-MM-DD HH:mm` — every candidate has already
 * passed `parseAirKoreaDataTime`, so lexicographic order over this format is chronological order).
 * This does **not** rely on the array's position/order — only on the officially documented
 * `dataTime` field's value — per the project's "do not silently use `items[0]`" policy. On an exact
 * tie (a data anomaly that should not occur for one station's real hourly series), the
 * first-encountered item wins, which is a deterministic fallback, not an assumption about API
 * ordering.
 */
function selectLatestItem<T extends { readonly dataTime: string }>(items: readonly T[]): T {
  let latest = items[0]!;
  for (const item of items.slice(1)) {
    if (item.dataTime > latest.dataTime) {
      latest = item;
    }
  }
  return latest;
}

/**
 * Turn a validated success page into a provider result: correlate it against the request, reject
 * an incomplete page, report an explicit no-data outcome for an empty page, then select the latest
 * item. Pure and deterministic.
 */
function interpretPage(
  request: AirKoreaCurrentAirQualityRequest,
  page: AirKoreaCurrentAirQualityPage,
): AirKoreaCurrentAirQualityProviderResult {
  const mismatch = findResponseMismatch(request, page);
  if (mismatch !== null) {
    return fail({ kind: 'RESPONSE_MISMATCH', field: mismatch });
  }

  if (page.totalCount > page.items.length) {
    return fail({
      kind: 'INCOMPLETE_PAGE',
      totalCount: page.totalCount,
      receivedCount: page.items.length,
    });
  }

  if (page.items.length === 0) {
    return fail({ kind: 'NO_DATA' });
  }

  const selected = selectLatestItem(page.items);
  return {
    ok: true,
    observation: {
      stationName: selected.stationName,
      dataTime: selected.dataTime,
      pm10Value: selected.pm10Value,
      pm25Value: selected.pm25Value,
      o3Value: selected.o3Value,
      khaiValue: selected.khaiValue,
      khaiGrade: selected.khaiGrade,
      pm10Grade: selected.pm10Grade,
      pm25Grade: selected.pm25Grade,
      o3Grade: selected.o3Grade,
    },
  };
}

/**
 * Classify a 2xx response body (already read to text). Decision order: empty → non-JSON (starts
 * with `<`, e.g. an XML/HTML gateway page) → JSON parse → response parser → page interpretation.
 * Pure and deterministic; the raw body never leaves this function.
 */
function classifyBody(
  request: AirKoreaCurrentAirQualityRequest,
  text: string,
): AirKoreaCurrentAirQualityProviderResult {
  const trimmed = text.trim();
  if (trimmed === '') {
    return fail({ kind: 'EMPTY_RESPONSE' });
  }

  if (trimmed.startsWith('<')) {
    return fail({ kind: 'NON_JSON_RESPONSE' });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The raw SyntaxError message can echo body fragments, so it is never surfaced.
    return fail({ kind: 'INVALID_JSON' });
  }

  const parseResult = parseAirKoreaCurrentAirQualityResponse(parsed);
  if (!parseResult.ok) {
    return parseResult.error.kind === 'UPSTREAM_ERROR'
      ? fail({ kind: 'AIRKOREA_UPSTREAM_ERROR', resultCode: parseResult.error.resultCode })
      : fail({ kind: 'AIRKOREA_INVALID_RESPONSE', issues: parseResult.error.issues });
  }

  return interpretPage(request, parseResult.page);
}

/**
 * Perform one current-air-quality fetch. Request validation and URL building are
 * AirKorea-specific; the transport is the shared {@link performAirKoreaGetRequest}.
 */
async function fetchCurrentAirQuality(
  config: ResolvedAirKoreaProviderConfig,
  request: AirKoreaCurrentAirQualityRequest,
  options?: { readonly signal?: AbortSignal },
): Promise<AirKoreaCurrentAirQualityProviderResult> {
  const validation = validateAirKoreaCurrentAirQualityRequest(request);
  if (!validation.ok) {
    return fail({ kind: 'INVALID_REQUEST', issues: validation.issues });
  }

  const built = buildAirKoreaCurrentAirQualityRequestUrl(config.serviceKey, request);
  if (!built.ok) {
    // Unreachable in practice (the request already validated), handled for totality.
    return fail({ kind: 'INVALID_REQUEST', issues: built.issues });
  }

  const transport = await performAirKoreaGetRequest(config, built.url, options);
  if (!transport.ok) {
    return fail(transport.error);
  }

  return classifyBody(request, transport.text);
}

/** Build a provider bound to a resolved config. */
function makeProvider(config: ResolvedAirKoreaProviderConfig): AirKoreaCurrentAirQualityProvider {
  return {
    fetchCurrentAirQuality(request, options) {
      return fetchCurrentAirQuality(config, request, options);
    },
  };
}

/**
 * Create a current-air-quality provider from explicit options. Returns a `CONFIG_ERROR` result
 * (never throws) when the options are invalid — see {@link validateAirKoreaProviderOptions}.
 */
export function createAirKoreaCurrentAirQualityProvider(
  options: AirKoreaProviderOptions,
): CreateAirKoreaCurrentAirQualityProviderResult {
  const validated = validateAirKoreaProviderOptions(options);
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }
  return { ok: true, provider: makeProvider(validated.config) };
}

/**
 * Create a current-air-quality provider from the environment, reading **only**
 * `AIRKOREA_SERVICE_KEY`. The environment is read when this function is *called* (default
 * `process.env`), never at module import. A missing, empty, or whitespace-only key yields a
 * `CONFIG_ERROR`; the key value never appears in the error.
 */
export function createAirKoreaCurrentAirQualityProviderFromEnv(
  env?: NodeJS.ProcessEnv,
  dependencies?: { readonly fetchImpl?: typeof fetch },
): CreateAirKoreaCurrentAirQualityProviderResult {
  const source = env ?? process.env;
  return createAirKoreaCurrentAirQualityProvider({
    serviceKey: source.AIRKOREA_SERVICE_KEY as string,
    fetchImpl: dependencies?.fetchImpl,
  });
}
