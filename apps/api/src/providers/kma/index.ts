/**
 * Public surface of the KMA (기상청) forecast boundary for `apps/api`.
 *
 * Two layers live here:
 *
 * 1. The PR #4 **raw-response boundary** — validate the raw `getVilageFcst` / `getUltraSrtFcst`
 *    JSON at runtime, classify it (success / upstream error / invalid response), and group a
 *    validated page into per-time slots with an explicit `ABSENT` / `NULL` / `VALUE` model. Pure;
 *    no I/O.
 * 2. The PR #5 **HTTP provider** — `createKmaForecastProvider` / `createKmaForecastProviderFromEnv`
 *    perform the real HTTPS `fetch` (server-only `KMA_SERVICE_KEY`, one-time URL encoding, timeout,
 *    caller abort, body-size cap, HTTP/gateway/JSON error classification), then run the layer-1
 *    parser and grouping and correlate the response against the request.
 *
 * A third layer is the PR #6 **hourly normalization adapter** — `normalizeKmaHourlyForecast`
 * turns a provider success's slots into the common `@life-weather/contracts` `HourlyForecast[]`
 * (per-product category selection, KST `forecastAt`, SKY/PTY/scalar/categorical parsing via
 * `weather-core`, and a contracts runtime validation). It is a pure adapter — the HTTP provider
 * never calls it automatically.
 *
 * The `WeatherOverview` assembly, `SourceMetadata`, current weather, daily forecast, and the API
 * route are **not** here — those are later PRs. See `docs/kma-response-boundary.md`,
 * `docs/kma-http-provider.md`, and `docs/kma-hourly-normalization.md` for the official-source
 * evidence and policy details. The URL builder and gateway-XML detector are internal and not
 * exported.
 */

export {
  createKmaForecastProvider,
  createKmaForecastProviderFromEnv,
  type CreateKmaForecastProviderResult,
  type KmaForecastProvider,
  type KmaForecastProviderError,
  type KmaForecastProviderResult,
  type KmaForecastProviderSuccess,
  type KmaResponseMismatchField,
} from './provider';

export {
  normalizeKmaHourlyForecast,
  type KmaHourlyNormalizationIssue,
  type NormalizeKmaHourlyForecastResult,
} from './normalize-hourly';

export {
  type KmaForecastProviderOptions,
  type KmaProviderConfigError,
} from './config';

export {
  type KmaForecastRequest,
  type KmaRequestIssue,
} from './request';

export {
  parseKmaForecastResponse,
  type KmaForecastPage,
  type KmaForecastResponseError,
  type KmaInvalidResponse,
  type KmaResponseIssue,
  type KmaUpstreamError,
  type ParseKmaForecastResponseResult,
} from './parse-response';

export {
  getKmaForecastField,
  groupKmaForecastItems,
  type GroupKmaForecastItemsResult,
  type KmaForecastField,
  type KmaForecastFieldLookup,
  type KmaForecastScalar,
  type KmaForecastSlot,
} from './group-forecast-items';

export {
  KMA_SUCCESS_RESULT_CODE,
  kmaForecastBodySchema,
  kmaForecastItemSchema,
  kmaForecastItemsSchema,
  kmaForecastSuccessResponseSchema,
  kmaResponseEnvelopeSchema,
  kmaResponseHeaderSchema,
  type KmaForecastBody,
  type KmaForecastItem,
  type KmaResponseHeader,
} from './raw-schema';
