/**
 * Public surface of the AirKorea (에어코리아) provider boundaries for `apps/api`: current
 * station air-quality (PR #82) and TM-coordinate nearby-station lookup (PR #83).
 *
 * Mirrors the same layering as the KMA current-observation boundary, as a **separate**,
 * independent provider namespace (no shared runtime code with `../kma/*`):
 *
 * 1. `current-raw-schema.ts` / `parse-current-response.ts` — the raw-response boundary for the
 *    측정소별 실시간 측정정보 조회 (`getMsrstnAcctoRltmMesureDnsty`) operation.
 *    `nearby-station-raw-schema.ts` / `parse-nearby-station-response.ts` — the raw-response
 *    boundary for the 근접측정소 목록 조회 (`getNearbyMsrstnList`) operation (reuses the shared
 *    envelope/header schema from `current-raw-schema.ts` — same `B552584` service family).
 * 2. `createAirKoreaCurrentAirQualityProvider` / `createAirKoreaCurrentAirQualityProviderFromEnv`
 *    and `createAirKoreaNearbyStationProvider` / `createAirKoreaNearbyStationProviderFromEnv`
 *    (`provider.ts`) — the HTTP providers: request validation/URL building
 *    (`current-request.ts`, `nearby-station-request.ts`), a shared timeout/abort/HTTP-status/
 *    body-size-capped transport (`read-response.ts`), response classification, and (for current
 *    air-quality only) request/response correlation and "latest measurement" selection.
 * 3. `normalizeAirKoreaCurrentAirQuality` (`normalize-current.ts`) — the pure adapter to the common
 *    `@life-weather/contracts` `CurrentAirQuality`. The nearby-station boundary has no normalizer —
 *    its provider success result (`AirKoreaNearbyStationCandidate[]`) *is* the boundary's public
 *    output; there is no shared contract type to adapt into.
 *
 * Neither boundary wires AirKorea into `POST /weather`, `services`, `composition`, or `routes`. The
 * nearby-station provider additionally does not resolve a single "closest" station, perform
 * WGS84→TM coordinate conversion, or convert an administrative area to TM coordinates — see
 * `docs/airkorea-current-air-quality-provider.md` and `docs/airkorea-nearby-station-provider.md` for
 * the full official-source evidence and scope boundaries. Neither provider performs caching or
 * retry.
 *
 * The URL builders are internal and not exported.
 */

export {
  createAirKoreaCurrentAirQualityProvider,
  createAirKoreaCurrentAirQualityProviderFromEnv,
  createAirKoreaNearbyStationProvider,
  createAirKoreaNearbyStationProviderFromEnv,
  type AirKoreaCurrentAirQualityProvider,
  type AirKoreaCurrentAirQualityProviderError,
  type AirKoreaCurrentAirQualityProviderResult,
  type AirKoreaCurrentAirQualityProviderSuccess,
  type AirKoreaNearbyStationCandidate,
  type AirKoreaNearbyStationProvider,
  type AirKoreaNearbyStationProviderError,
  type AirKoreaNearbyStationProviderResult,
  type AirKoreaResponseMismatchField,
  type CreateAirKoreaCurrentAirQualityProviderResult,
  type CreateAirKoreaNearbyStationProviderResult,
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
  isAirKoreaTmCoordinate,
  type AirKoreaNearbyStationRequest,
  type AirKoreaNearbyStationRequestIssue,
} from './nearby-station-request.js';

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
  parseAirKoreaNearbyStationResponse,
  type AirKoreaNearbyStationInvalidResponse,
  type AirKoreaNearbyStationPage,
  type AirKoreaNearbyStationResponseError,
  type AirKoreaNearbyStationResponseIssue,
  type AirKoreaNearbyStationUpstreamError,
  type ParseAirKoreaNearbyStationResponseResult,
} from './parse-nearby-station-response.js';

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

export {
  airKoreaNearbyStationBodySchema,
  airKoreaNearbyStationItemSchema,
  airKoreaNearbyStationItemsSchema,
  airKoreaNearbyStationSuccessResponseSchema,
  parseAirKoreaNearbyStationDistanceKm,
  type AirKoreaNearbyStationBody,
  type AirKoreaNearbyStationItem,
} from './nearby-station-raw-schema.js';
