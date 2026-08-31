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
 * Alert events (기상특보 조회서비스 `getPwnCd`, PR #89) is a **third, independent** boundary against
 * a different `WthrWrnInfoService` service family (its own base URL and service-key query casing —
 * see `docs/kma-alert-event-provider.md`):
 *
 * 1. `alert-request.ts` / `alert-raw-schema.ts` / `parse-alert-response.ts` — request validation,
 *    the raw-response boundary, and a **four**-outcome parser (success / confirmed no-data /
 *    upstream error / invalid response — `getPwnCd`'s `03` is a confirmed valid zero-match result
 *    for this operation, unlike the generic `UPSTREAM_ERROR` the forecast/current boundaries give
 *    every non-success code).
 * 2. `createKmaAlertEventProvider` / `createKmaAlertEventProviderFromEnv` (`provider.ts`) — the
 *    HTTP provider, sharing the same transport policy via `performKmaGetRequest`.
 *
 * This PR stops at validated alert **lifecycle event** records — it does not normalize them to the
 * public `WeatherAlert[]` contract, fold lifecycle state into an active-alert set, or wire this
 * provider into `POST /weather`/`services`/`composition`/`routes`. See
 * `docs/kma-alert-event-provider.md` for the full scope boundary.
 *
 * Mid-term forecast (중기예보 조회서비스 `getMidTa` / `getMidLandFcst`, PR #98) is a **fourth,
 * independent** boundary against the `MidFcstInfoService` service family (its own base URL; the
 * 공공데이터포털 `ServiceKey` query casing, like the forecast/current boundaries — see
 * `docs/kma-midterm-provider.md`):
 *
 * 1. `midterm-request.ts` / `midterm-raw-schema.ts` / `parse-midterm-response.ts` — request
 *    validation and the fixed `TEMPERATURE`→`getMidTa` / `LAND`→`getMidLandFcst` path mapping, two
 *    **separate** raw-item schemas (D+4~D+10 최저/최고기온 vs. D+4~D+7 오전/오후 plus D+8~D+10 종일
 *    육상예보), and a three-outcome parser per operation (success / upstream error / invalid
 *    response — no dedicated no-data code is documented for these operations, so a non-success
 *    `resultCode` is never *guessed* to mean no-data).
 * 2. `createKmaMidtermForecastProvider` / `createKmaMidtermForecastProviderFromEnv` (`provider.ts`)
 *    — the HTTP provider, sharing the same transport policy via `performKmaGetRequest` and the same
 *    `KMA_SERVICE_KEY` configuration, with `regId` and pagination request/response correlation.
 *
 * This PR stops at validated raw mid-term records. It does **not** resolve a location to a `regId`,
 * select the latest 06/18 KST issuance, normalize records into `DailyForecast[]`, map Korean KMA
 * weather phrases to `WeatherCondition`, or wire this provider into `POST /weather`/`services`/
 * `composition`/`routes`. See `docs/kma-midterm-provider.md` for the full scope boundary. The
 * mid-term raw schemas and parsers are internal and not exported.
 *
 * The `WeatherOverview` assembly, `SourceMetadata`, daily forecast, and the API route are **not**
 * here — those are later PRs. See `docs/kma-response-boundary.md`, `docs/kma-http-provider.md`,
 * `docs/kma-hourly-normalization.md`, and `docs/kma-current-observation-provider.md` for the
 * official-source evidence and policy details. The URL builders and the gateway-XML detector are
 * internal and not exported.
 */

export {
  createKmaAlertEventProvider,
  createKmaAlertEventProviderFromEnv,
  createKmaCurrentObservationProvider,
  createKmaCurrentObservationProviderFromEnv,
  createKmaForecastProvider,
  createKmaForecastProviderFromEnv,
  createKmaMidtermForecastProvider,
  createKmaMidtermForecastProviderFromEnv,
  type CreateKmaAlertEventProviderResult,
  type CreateKmaCurrentObservationProviderResult,
  type CreateKmaForecastProviderResult,
  type CreateKmaMidtermForecastProviderResult,
  type KmaAlertEventProvider,
  type KmaAlertEventProviderError,
  type KmaAlertEventProviderResult,
  type KmaAlertEventProviderSuccess,
  type KmaAlertEventRecord,
  type KmaAlertResponseMismatchField,
  type KmaCurrentObservationProvider,
  type KmaCurrentObservationProviderError,
  type KmaCurrentObservationProviderResult,
  type KmaCurrentObservationProviderSuccess,
  type KmaCurrentResponseMismatchField,
  type KmaForecastProvider,
  type KmaForecastProviderError,
  type KmaForecastProviderResult,
  type KmaForecastProviderSuccess,
  type KmaMidtermForecastProvider,
  type KmaMidtermForecastProviderError,
  type KmaMidtermForecastProviderResult,
  type KmaMidtermForecastProviderSuccess,
  type KmaMidtermLandRecord,
  type KmaMidtermResponseMismatchField,
  type KmaMidtermTemperatureRecord,
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
  KMA_ALERT_WARNING_TYPES,
  type KmaAlertEventRequest,
  type KmaAlertRequestIssue,
  type KmaAlertWarningType,
} from './alert-request.js';

export {
  KMA_MIDTERM_OPERATIONS,
  type KmaMidtermForecastRequest,
  type KmaMidtermOperation,
  type KmaMidtermRequestIssue,
} from './midterm-request.js';

export { type KmaMidtermResponseIssue } from './parse-midterm-response.js';

export {
  parseKmaAlertEventResponse,
  type KmaAlertEventPage,
  type KmaAlertResponseIssue,
  type ParseKmaAlertEventResponseResult,
} from './parse-alert-response.js';

export {
  kmaAlertEventBodySchema,
  kmaAlertEventItemSchema,
  kmaAlertEventItemsSchema,
  kmaAlertEventSuccessResponseSchema,
  kmaAlertNoDataResponseSchema,
  KMA_ALERT_NO_DATA_RESULT_CODE,
  type KmaAlertEventBody,
  type KmaAlertEventItem,
} from './alert-raw-schema.js';

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
