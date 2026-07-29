/**
 * Contract-safe mobile weather API client boundary.
 *
 * A narrow client for the production `POST /weather` endpoint. It consumes the shared
 * `@life-weather/contracts` schemas directly — it never redefines or copies them — to validate
 * the outbound request and the inbound response at the network boundary, and returns a
 * discriminated result so the app can tell an API success, an API error, and a local
 * transport/validation failure apart.
 *
 * Deliberately minimal: no class hierarchy, no generic HTTP framework, and no retry, timeout,
 * cache, auth, or logging. The `baseUrl` and `fetchImpl` are injected by the caller, so
 * constructing the client reads no environment, hard-codes no URL, and performs no network I/O.
 */

import {
  CONTRACT_VERSION,
  apiEnvelopeHeader,
  weatherRequestV1,
  weatherResponseV1,
  type WeatherErrorResponseV1,
  type WeatherRequestV1,
  type WeatherSuccessResponseV1,
} from '@life-weather/contracts';

import {
  weatherApiClientError,
  type WeatherApiClientError,
} from './errors';

/**
 * The subset of the Fetch API this client needs, so a caller (and every test) can inject an
 * implementation. Compatible with the global `fetch`, which is why the request path is passed
 * as a `string` and the init is always provided.
 */
export type WeatherApiFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

/** Construction options. Both collaborators are injected; nothing is read from the environment. */
export interface WeatherApiClientConfig {
  /**
   * The API origin (optionally with a base path), e.g. `https://example.test`. Must be an
   * absolute `http:`/`https:` URL with no query, fragment, or embedded credentials; surrounding
   * whitespace is trimmed. The client appends exactly one `/weather` segment, tolerating a
   * trailing slash. An unusable value yields an `invalidClientConfiguration` result — it never
   * throws — and no URL is hard-coded here.
   */
  readonly baseUrl: string;
  /**
   * The fetch implementation to use. Optional: when omitted the runtime global `fetch` is used
   * if present. Injecting it keeps the client fully testable with no network access.
   */
  readonly fetchImpl?: WeatherApiFetch;
}

/** Per-call options. */
export interface FetchWeatherOptions {
  /**
   * An abort signal forwarded to `fetch` by the *same reference* — the client neither wraps it
   * nor creates its own controller.
   */
  readonly signal?: AbortSignal;
}

/**
 * The outcome of a {@link WeatherApiClient.fetchWeather} call.
 *
 * - `success` — a valid `WeatherResponseV1` was received with `ok: true`.
 * - `apiError` — a valid `WeatherResponseV1` was received with `ok: false`. This is the API's
 *   own contract error (its HTTP status mapping is consumed via the response `ok` discriminator,
 *   never re-derived here).
 * - `clientError` — the client could not obtain or trust a contract response (transport,
 *   validation, or configuration failure). See {@link WeatherApiClientError}.
 */
export type WeatherApiResult =
  | { readonly kind: 'success'; readonly data: WeatherSuccessResponseV1 }
  | { readonly kind: 'apiError'; readonly error: WeatherErrorResponseV1 }
  | { readonly kind: 'clientError'; readonly error: WeatherApiClientError };

/** The narrow client surface: a single weather fetch method. */
export interface WeatherApiClient {
  fetchWeather(
    request: WeatherRequestV1,
    options?: FetchWeatherOptions,
  ): Promise<WeatherApiResult>;
}

const JSON_CONTENT_TYPE = 'application/json';

/** A `clientError` result wrapping the error for `kind`. */
function clientError(
  kind: WeatherApiClientError['kind'],
): WeatherApiResult {
  return { kind: 'clientError', error: weatherApiClientError(kind) };
}

/**
 * Whether a rejected `fetch` (or a body read) failed because the request was aborted. Only the
 * error `name` is inspected — the original message is never read or retained.
 */
function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/**
 * Whether a `Content-Type` header value declares exactly an `application/json` body.
 *
 * Only the media type is examined: the portion before the first `;` (dropping any parameters
 * such as `charset`), trimmed and lower-cased, must equal `application/json` exactly. A
 * lookalike type — `application/jsonp`, `application/json-extra`, `text/application/json`, or any
 * `application/*+json` such as `application/problem+json` — is not accepted, matching the exact
 * `application/json` the server produces today.
 */
function isJsonContentType(contentType: string | null): boolean {
  if (contentType === null) {
    return false;
  }
  const mediaType = contentType.split(';', 1)[0]!.trim().toLowerCase();
  return mediaType === JSON_CONTENT_TYPE;
}

/**
 * Validate, classify, and parse the `Response` into a {@link WeatherApiResult}.
 *
 * Order matters and is part of the contract:
 * 1. defensively require a JSON `Content-Type`, then read and `JSON.parse` the body;
 * 2. match the minimal `apiEnvelopeHeader` first;
 * 3. compare `meta.contractVersion` to {@link CONTRACT_VERSION} — a mismatch short-circuits to
 *    `unsupportedContractVersion` *before* any full V1 parse;
 * 4. only on a version match, run the full `weatherResponseV1` parse;
 * 5. return the `success` / `apiError` variant off the response `ok` discriminator.
 */
async function readResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<WeatherApiResult> {
  if (!isJsonContentType(response.headers.get('content-type'))) {
    return clientError('nonJsonResponse');
  }

  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch (error) {
    // A body-stream failure is a transport problem, not a malformed payload. It is classified as
    // an abort when the runtime error says so *or* the caller's signal has already fired — some
    // runtimes surface a body-read cancellation as a generic error rather than an `AbortError`.
    if (isAbortError(error) || signal?.aborted === true) {
      return clientError('aborted');
    }
    return clientError('networkError');
  }

  let json: unknown;
  try {
    json = JSON.parse(bodyText) as unknown;
  } catch {
    return clientError('malformedJson');
  }

  const envelope = apiEnvelopeHeader.safeParse(json);
  if (!envelope.success) {
    return clientError('invalidEnvelope');
  }

  // Read the contract version from the header before the full parse, so a v2+ payload is
  // rejected as an unsupported version rather than as an invalid v1 response.
  if (envelope.data.meta.contractVersion !== CONTRACT_VERSION) {
    return clientError('unsupportedContractVersion');
  }

  const parsed = weatherResponseV1.safeParse(json);
  if (!parsed.success) {
    return clientError('invalidResponse');
  }

  return parsed.data.ok
    ? { kind: 'success', data: parsed.data }
    : { kind: 'apiError', error: parsed.data };
}

/**
 * Normalize and validate a caller-supplied `baseUrl` into the exact absolute `/weather` endpoint,
 * or `null` when the configuration is unusable. This never throws and never reads the environment.
 *
 * The input is treated as untrusted (a runtime cast or a JavaScript caller can defeat the static
 * `string` type), so the value is checked at runtime. Surrounding whitespace is trimmed rather
 * than preserved, and the URL must be an absolute `http:`/`https:` origin (optionally with a base
 * path) that carries no query, fragment, or embedded credentials. Exactly one `/weather` segment
 * is appended regardless of a trailing slash. On any failure `null` is returned so the caller can
 * surface `invalidClientConfiguration` — the offending value is never echoed back.
 */
function resolveWeatherEndpoint(rawBaseUrl: unknown): string | null {
  if (typeof rawBaseUrl !== 'string') {
    return null;
  }
  const trimmed = rawBaseUrl.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // Malformed or non-absolute (schemeless / relative) URLs land here.
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }
  if (url.search !== '' || url.hash !== '') {
    return null;
  }
  if (url.username !== '' || url.password !== '') {
    return null;
  }

  // `origin` carries scheme + host + port (never credentials); the base path is preserved with
  // any trailing slashes stripped so exactly one `/weather` segment is appended.
  const basePath = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${basePath}/weather`;
}

/**
 * Resolve the fetch implementation, or `undefined` when none is usable. A caller-provided
 * `fetchImpl` must be a function at runtime (a runtime cast can supply a non-function); when it is
 * omitted, the global `fetch` is used only if it is itself a function. A provided-but-invalid
 * `fetchImpl` never silently falls back to the global.
 */
function resolveFetch(config: WeatherApiClientConfig): WeatherApiFetch | undefined {
  const providedFetch: unknown = config.fetchImpl;
  if (providedFetch !== undefined) {
    return typeof providedFetch === 'function'
      ? (providedFetch as WeatherApiFetch)
      : undefined;
  }
  return typeof globalThis.fetch === 'function'
    ? (globalThis.fetch as WeatherApiFetch)
    : undefined;
}

/**
 * Create a {@link WeatherApiClient}.
 *
 * Construction has no side effects: it resolves the fetch implementation and validates the
 * configuration but performs no network I/O and reads no environment. An invalid configuration
 * is not thrown — it is surfaced as an `invalidClientConfiguration` `clientError` on the first
 * `fetchWeather` call, keeping every failure inside the same typed result.
 */
export function createWeatherApiClient(
  config: WeatherApiClientConfig,
): WeatherApiClient {
  // Resolve and validate both collaborators once, without throwing. Either being unusable leaves
  // the client unconfigured; the failure is surfaced as a typed result on the first call.
  const endpoint = resolveWeatherEndpoint(config.baseUrl);
  const resolvedFetch = resolveFetch(config);

  return {
    async fetchWeather(request, options) {
      if (endpoint === null || resolvedFetch === undefined) {
        return clientError('invalidClientConfiguration');
      }

      // Validate the outbound request against the shared strict schema. Anything but exactly
      // `{ location: WeatherLocation }` — an app-only field, a provider-native lookup key — is
      // rejected here, so it is never serialized or transmitted.
      const validRequest = weatherRequestV1.safeParse(request);
      if (!validRequest.success) {
        return clientError('invalidRequest');
      }

      // Don't do work for an already-cancelled request.
      if (options?.signal?.aborted) {
        return clientError('aborted');
      }

      let response: Response;
      try {
        response = await resolvedFetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': JSON_CONTENT_TYPE,
            Accept: JSON_CONTENT_TYPE,
          },
          // Serialize only the parsed request, never the caller's raw input.
          body: JSON.stringify(validRequest.data),
          // Forward the caller's signal by the same reference; no wrapping controller.
          signal: options?.signal,
        });
      } catch (error) {
        if (isAbortError(error) || options?.signal?.aborted === true) {
          return clientError('aborted');
        }
        return clientError('networkError');
      }

      return readResponse(response, options?.signal);
    },
  };
}
