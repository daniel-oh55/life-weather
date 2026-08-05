/**
 * Public surface of the KMA (기상청) forecast and current-observation boundaries for `apps/api`.
 *
 * Forecast (단기예보/초단기예보, PR #4–#7):
 *
 * 1. The PR #4 **raw-response boundary** — validate the raw `getVilageFcst` / `getUltraSrtFcst`
 *    JSON at runtime, classify it (success / upstream error / invalid response), and group a
 *    validated page into per-time slots with an explicit `ABSENT` / `NULL` / `VALUE` model. Pure;
 *    no I/O.
 * 2. The PR #5 **HTTP provider** — `createKmaForecastProvider` / `createKmaForecastProviderFromEnv`
 *    perform the real HTTPS `fetch` (server-only `KMA_SERVICE_KEY`, one-time URL encoding, timeout,
 *    caller abort, body-size cap, HTTP/gateway/JSON error classification), then run the layer-1
 *    parser and grouping and correlate the response against the request.
 * 3. The PR #6 **hourly normalization adapter** — `normalizeKmaHourlyForecast` turns a provider
 *    success's slots into the common `@life-weather/contracts` `HourlyForecast[]` (per-product
 *    category selection, KST `forecastAt`, SKY/PTY/scalar/categorical parsing via `weather-core`,
 *    and a contracts runtime validation). It is a pure adapter — the HTTP provider never calls it
 *    automatically.
 *
 * Current observation (초단기실황, PR #63) mirrors the same three layers as a **separate**
 * boundary — a distinct request/response shape (`obsrValue`, no forecast target time), reusing
 * only the shared HTTP transport policy and the shared response header/success-code schema:
 *
 * 1. `current-raw-schema.ts` / `parse-current-response.ts` / `group-current-observation-items.ts`
 *    — the raw-response boundary for `getUltraSrtNcst`.
 * 2. `createKmaCurrentObservationProvider` / `createKmaCurrentObservationProviderFromEnv`
 *    (`provider.ts`) — the HTTP provider, sharing the exact timeout/abort/HTTP-status/body-size
 *    transport policy with the forecast provider.
 * 3. `normalizeKmaCurrentObservation` (`normalize-current.ts`) — the pure adapter to the common
 *    `CurrentWeather` contract.
 *
 * This PR does **not** wire current observation into `POST /weather`, `services`, `composition`,
 * or `routes` — see `docs/kma-current-observation-provider.md` for the full scope boundary.
 *
 * The `WeatherOverview` assembly, `SourceMetadata`, daily forecast, and the API route are **not**
 * here — those are later PRs. See `docs/kma-response-boundary.md`, `docs/kma-http-provider.md`,
 * `docs/kma-hourly-normalization.md`, and `docs/kma-current-observation-provider.md` for the
 * official-source evidence and policy details. The URL builders and the gateway-XML detector are
 * internal and not exported.
 */

export {
  createKmaCurrentObservationProvider,
  createKmaCurrentObservationProviderFromEnv,
  createKmaForecastProvider,
  createKmaForecastProviderFromEnv,
  type CreateKmaCurrentObservationProviderResult,
  type CreateKmaForecastProviderResult,
  type KmaCurrentObservationProvider,
  type KmaCurrentObservationProviderError,
  type KmaCurrentObservationProviderResult,
  type KmaCurrentObservationProviderSuccess,
  type KmaCurrentResponseMismatchField,
  type KmaForecastProvider,
  type KmaForecastProviderError,
  type KmaForecastProviderResult,
  type KmaForecastProviderSuccess,
  type KmaResponseMismatchField,
} from './provider.js';

export {
  normalizeKmaHourlyForecast,
  type KmaHourlyNormalizationIssue,
  type NormalizeKmaHourlyForecastResult,
} from './normalize-hourly.js';

export {
  normalizeKmaCurrentObservation,
  type KmaCurrentNormalizationIssue,
  type NormalizeKmaCurrentObservationResult,
} from './normalize-current.js';

export {
  type KmaForecastProviderOptions,
  type KmaProviderConfigError,
} from './config.js';

export {
  type KmaForecastRequest,
  type KmaRequestIssue,
} from './request.js';

export {
  type KmaCurrentObservationRequest,
  type KmaCurrentRequestIssue,
} from './current-request.js';

export {
  parseKmaForecastResponse,
  type KmaForecastPage,
  type KmaForecastResponseError,
  type KmaInvalidResponse,
  type KmaResponseIssue,
  type KmaUpstreamError,
  type ParseKmaForecastResponseResult,
} from './parse-response.js';

export {
  parseKmaCurrentObservationResponse,
  type KmaCurrentInvalidResponse,
  type KmaCurrentObservationPage,
  type KmaCurrentObservationResponseError,
  type KmaCurrentResponseIssue,
  type KmaCurrentUpstreamError,
  type ParseKmaCurrentObservationResponseResult,
} from './parse-current-response.js';

export {
  getKmaForecastField,
  groupKmaForecastItems,
  type GroupKmaForecastItemsResult,
  type KmaForecastField,
  type KmaForecastFieldLookup,
  type KmaForecastScalar,
  type KmaForecastSlot,
} from './group-forecast-items.js';

export {
  getKmaCurrentObservationField,
  groupKmaCurrentObservationItems,
  type GroupKmaCurrentObservationItemsResult,
  type KmaCurrentObservationField,
  type KmaCurrentObservationFieldLookup,
  type KmaCurrentObservationScalar,
  type KmaCurrentObservationSlot,
} from './group-current-observation-items.js';

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
} from './raw-schema.js';

export {
  kmaCurrentObservationBodySchema,
  kmaCurrentObservationItemSchema,
  kmaCurrentObservationItemsSchema,
  kmaCurrentObservationSuccessResponseSchema,
  type KmaCurrentObservationBody,
  type KmaCurrentObservationItem,
} from './current-raw-schema.js';
