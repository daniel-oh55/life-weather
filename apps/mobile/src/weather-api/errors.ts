/**
 * Mobile-local error boundary for the weather API client.
 *
 * These errors are the transport/consumer failures the client can surface *before* it ever
 * has a valid V1 contract response — a network drop, a cancelled request, a body that is not
 * JSON, an envelope that does not match, or an unsupported contract version. They are kept
 * deliberately distinct from the API's own {@link WeatherErrorResponseV1}: an API error is a
 * *successful* HTTP round-trip whose body is a valid contract error, whereas everything here
 * means the client could not obtain (or trust) a contract response at all.
 *
 * An error carries only a stable, machine-readable {@link WeatherApiClientErrorKind} and a
 * fixed, safe {@link WeatherApiClientError.message}. It never carries the raw response body,
 * the request/response URL, a stack, a `cause`, the original fetch error message, response
 * headers, the request location/coordinates, or any provider-internal detail. User-facing
 * copy is intentionally out of scope for this boundary — the UI maps `kind` to its own strings.
 */

/** A stable, machine-readable classification of a client-boundary failure. */
export type WeatherApiClientErrorKind =
  /** The client was constructed with an unusable `baseUrl` or `fetchImpl`. */
  | 'invalidClientConfiguration'
  /** The outbound request failed `weatherRequestV1` validation, so nothing was sent. */
  | 'invalidRequest'
  /** `fetch` rejected for a reason other than an abort (e.g. the network was unreachable). */
  | 'networkError'
  /** The request was cancelled via the caller's `AbortSignal`. */
  | 'aborted'
  /** The response `Content-Type` was not `application/json`. */
  | 'nonJsonResponse'
  /** The response body was declared JSON but could not be parsed. */
  | 'malformedJson'
  /** The parsed body did not match the minimal `apiEnvelopeHeader` shape. */
  | 'invalidEnvelope'
  /** The response envelope's `contractVersion` is not the version this client supports. */
  | 'unsupportedContractVersion'
  /** The envelope matched but the full `weatherResponseV1` parse failed. */
  | 'invalidResponse';

/**
 * A client-boundary error. The whole object is intentionally just `{ kind, message }` — no
 * dynamic, caller-derived, or upstream content is ever attached, so it can be logged or
 * serialized without leaking a request location, a URL, or a secret.
 */
export interface WeatherApiClientError {
  readonly kind: WeatherApiClientErrorKind;
  readonly message: string;
}

/**
 * Fixed, safe message per error kind. Every string is a static literal — it contains no
 * request data, response data, URL, or secret — so the same object is safe to surface or log.
 */
const CLIENT_ERROR_MESSAGE: Readonly<Record<WeatherApiClientErrorKind, string>> = {
  invalidClientConfiguration: 'The weather API client is not configured correctly.',
  invalidRequest: 'The weather request is not valid.',
  networkError: 'The weather request could not reach the server.',
  aborted: 'The weather request was cancelled.',
  nonJsonResponse: 'The server response was not JSON.',
  malformedJson: 'The server response could not be read.',
  invalidEnvelope: 'The server response did not match the expected format.',
  unsupportedContractVersion: 'The server response uses an unsupported contract version.',
  invalidResponse: 'The server response did not match the expected weather format.',
};

/**
 * Build a {@link WeatherApiClientError} for `kind`. Deliberately takes only the kind: the
 * message is the fixed, safe string for that kind and nothing else is ever attached.
 */
export function weatherApiClientError(
  kind: WeatherApiClientErrorKind,
): WeatherApiClientError {
  return { kind, message: CLIENT_ERROR_MESSAGE[kind] };
}
