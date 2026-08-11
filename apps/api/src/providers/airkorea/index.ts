/**
 * Public surface of the AirKorea (에어코리아) current station air-quality provider boundary for
 * `apps/api`.
 *
 * Mirrors the same three layers as the KMA current-observation boundary, as a **separate**,
 * independent provider namespace (no shared runtime code, no shared error/config types):
 *
 * 1. `current-raw-schema.ts` / `parse-current-response.ts` — the raw-response boundary for the
 *    측정소별 실시간 측정정보 조회 (`getMsrstnAcctoRltmMesureDnsty`) operation.
 * 2. `createAirKoreaCurrentAirQualityProvider` / `createAirKoreaCurrentAirQualityProviderFromEnv`
 *    (`provider.ts`) — the HTTP provider: request validation/URL building
 *    (`current-request.ts`), a timeout/abort/HTTP-status/body-size-capped transport
 *    (`read-response.ts`), response classification, request/response correlation, and the "latest
 *    measurement" selection.
 * 3. `normalizeAirKoreaCurrentAirQuality` (`normalize-current.ts`) — the pure adapter to the common
 *    `@life-weather/contracts` `CurrentAirQuality`.
 *
 * This boundary does **not** wire AirKorea into `POST /weather`, `services`, `composition`, or
 * `routes` — it does not resolve a measurement station from latitude/longitude, and it performs no
 * caching or retry. See `docs/airkorea-current-air-quality-provider.md` for the full official-source
 * evidence and scope boundary.
 *
 * The URL builder is internal and not exported.
 */

export {
  createAirKoreaCurrentAirQualityProvider,
  createAirKoreaCurrentAirQualityProviderFromEnv,
  type AirKoreaCurrentAirQualityProvider,
  type AirKoreaCurrentAirQualityProviderError,
  type AirKoreaCurrentAirQualityProviderResult,
  type AirKoreaCurrentAirQualityProviderSuccess,
  type AirKoreaResponseMismatchField,
  type CreateAirKoreaCurrentAirQualityProviderResult,
} from './provider.js';

export {
  normalizeAirKoreaCurrentAirQuality,
  type AirKoreaCurrentNormalizationIssue,
  type NormalizeAirKoreaCurrentAirQualityResult,
} from './normalize-current.js';

export {
  type AirKoreaProviderConfigError,
  type AirKoreaProviderOptions,
} from './config.js';

export {
  isAirKoreaStationName,
  type AirKoreaCurrentAirQualityRequest,
  type AirKoreaCurrentRequestIssue,
} from './current-request.js';

export {
  parseAirKoreaCurrentAirQualityResponse,
  type AirKoreaCurrentAirQualityPage,
  type AirKoreaCurrentInvalidResponse,
  type AirKoreaCurrentResponseError,
  type AirKoreaCurrentResponseIssue,
  type AirKoreaCurrentUpstreamError,
  type ParseAirKoreaCurrentAirQualityResponseResult,
} from './parse-current-response.js';

export {
  AIRKOREA_SUCCESS_RESULT_CODE,
  airKoreaCurrentAirQualityBodySchema,
  airKoreaCurrentAirQualityItemSchema,
  airKoreaCurrentAirQualityItemsSchema,
  airKoreaCurrentAirQualitySuccessResponseSchema,
  airKoreaResponseEnvelopeSchema,
  airKoreaResponseHeaderSchema,
  parseAirKoreaDataTime,
  type AirKoreaCurrentAirQualityBody,
  type AirKoreaCurrentAirQualityItem,
  type AirKoreaDataTimeParts,
} from './current-raw-schema.js';
