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
   * The API origin (optionally with a base path), e.g. `https://example.test`. The client
   * appends `/weather`; a single trailing slash is tolerated. No URL is hard-coded here.
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

/** Whether a `Content-Type` header value declares a JSON body. */
function isJsonContentType(contentType: string | null): boolean {
  return contentType !== null && contentType.toLowerCase().includes(JSON_CONTENT_TYPE);
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
async function readResponse(response: Response): Promise<WeatherApiResult> {
  if (!isJsonContentType(response.headers.get('content-type'))) {
    return clientError('nonJsonResponse');
  }

  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch (error) {
    // A body-stream failure is a transport problem, not a malformed payload.
    return clientError(isAbortError(error) ? 'aborted' : 'networkError');
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

/** Drop a single trailing slash so `${baseUrl}/weather` never produces a double slash. */
function weatherEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/weather`;
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
  const resolvedFetch: WeatherApiFetch | undefined =
    config.fetchImpl ??
    (typeof globalThis.fetch === 'function'
      ? (globalThis.fetch as WeatherApiFetch)
      : undefined);

  const hasValidBaseUrl =
    typeof config.baseUrl === 'string' && config.baseUrl.trim().length > 0;

  const isConfigured = hasValidBaseUrl && resolvedFetch !== undefined;
  const endpoint = hasValidBaseUrl ? weatherEndpoint(config.baseUrl) : '';

  return {
    async fetchWeather(request, options) {
      if (!isConfigured || resolvedFetch === undefined) {
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

      return readResponse(response);
    },
  };
}
