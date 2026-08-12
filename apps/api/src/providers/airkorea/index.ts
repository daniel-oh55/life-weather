/**
 * Public surface of the AirKorea (에어코리아) provider boundaries for `apps/api`: current
 * station air-quality (PR #82), TM-coordinate nearby-station lookup (PR #83), and
 * administrative-name → TM-coordinate lookup (PR #84).
 *
 * Mirrors the same layering as the KMA current-observation boundary, as a **separate**,
 * independent provider namespace (no shared runtime code with `../kma/*`):
 *
 * 1. `current-raw-schema.ts` / `parse-current-response.ts` — the raw-response boundary for the
 *    측정소별 실시간 측정정보 조회 (`getMsrstnAcctoRltmMesureDnsty`) operation.
 *    `nearby-station-raw-schema.ts` / `parse-nearby-station-response.ts` — the raw-response
 *    boundary for the 근접측정소 목록 조회 (`getNearbyMsrstnList`) operation.
 *    `tm-coordinate-raw-schema.ts` / `parse-tm-coordinate-response.ts` — the raw-response boundary
 *    for the TM 기준좌표 조회 (`getTMStdrCrdnt`) operation. All three reuse the shared
 *    envelope/header schema from `current-raw-schema.ts` — same `B552584` service family.
 * 2. `createAirKoreaCurrentAirQualityProvider` / `createAirKoreaCurrentAirQualityProviderFromEnv`,
 *    `createAirKoreaNearbyStationProvider` / `createAirKoreaNearbyStationProviderFromEnv`, and
 *    `createAirKoreaTmCoordinateProvider` / `createAirKoreaTmCoordinateProviderFromEnv`
 *    (`provider.ts`) — the HTTP providers: request validation/URL building
 *    (`current-request.ts`, `nearby-station-request.ts`, `tm-coordinate-request.ts`), a shared
 *    timeout/abort/HTTP-status/body-size-capped transport (`read-response.ts`), response
 *    classification, and (for current air-quality only) request/response correlation and "latest
 *    measurement" selection.
 * 3. `normalizeAirKoreaCurrentAirQuality` (`normalize-current.ts`) — the pure adapter to the common
 *    `@life-weather/contracts` `CurrentAirQuality`. The nearby-station and TM-coordinate boundaries
 *    have no normalizer — their provider success results (`AirKoreaNearbyStationCandidate[]` /
 *    `AirKoreaTmCoordinateCandidate[]`) *are* the boundaries' public output; there is no shared
 *    contract type to adapt into.
 *
 * None of the three boundaries wires AirKorea into `POST /weather`, `services`, `composition`, or
 * `routes`. The nearby-station and TM-coordinate providers additionally do not resolve a single
 * "closest station" / "the" TM point, perform WGS84→TM coordinate conversion, or (TM-coordinate
 * only) correlate a `umdName` against app administrative-area context — see
 * `docs/airkorea-current-air-quality-provider.md`, `docs/airkorea-nearby-station-provider.md`, and
 * `docs/airkorea-tm-coordinate-provider.md` for the full official-source evidence and scope
 * boundaries. None of the three providers performs caching or retry.
 *
 * The URL builders are internal and not exported.
 */

export {
  createAirKoreaCurrentAirQualityProvider,
  createAirKoreaCurrentAirQualityProviderFromEnv,
  createAirKoreaNearbyStationProvider,
  createAirKoreaNearbyStationProviderFromEnv,
  createAirKoreaTmCoordinateProvider,
  createAirKoreaTmCoordinateProviderFromEnv,
  type AirKoreaCurrentAirQualityProvider,
  type AirKoreaCurrentAirQualityProviderError,
  type AirKoreaCurrentAirQualityProviderResult,
  type AirKoreaCurrentAirQualityProviderSuccess,
  type AirKoreaNearbyStationCandidate,
  type AirKoreaNearbyStationProvider,
  type AirKoreaNearbyStationProviderError,
  type AirKoreaNearbyStationProviderResult,
  type AirKoreaResponseMismatchField,
  type AirKoreaTmCoordinateCandidate,
  type AirKoreaTmCoordinateProvider,
  type AirKoreaTmCoordinateProviderError,
  type AirKoreaTmCoordinateProviderResult,
  type CreateAirKoreaCurrentAirQualityProviderResult,
  type CreateAirKoreaNearbyStationProviderResult,
  type CreateAirKoreaTmCoordinateProviderResult,
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
  isAirKoreaAdministrativeDongName,
  type AirKoreaTmCoordinateRequest,
  type AirKoreaTmCoordinateRequestIssue,
} from './tm-coordinate-request.js';

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
  parseAirKoreaTmCoordinateResponse,
  type AirKoreaTmCoordinateInvalidResponse,
  type AirKoreaTmCoordinatePage,
  type AirKoreaTmCoordinateResponseError,
  type AirKoreaTmCoordinateResponseIssue,
  type AirKoreaTmCoordinateUpstreamError,
  type ParseAirKoreaTmCoordinateResponseResult,
} from './parse-tm-coordinate-response.js';

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

export {
  airKoreaTmCoordinateBodySchema,
  airKoreaTmCoordinateItemSchema,
  airKoreaTmCoordinateItemsSchema,
  airKoreaTmCoordinateSuccessResponseSchema,
  parseAirKoreaTmCoordinateValue,
  type AirKoreaTmCoordinateBody,
  type AirKoreaTmCoordinateItem,
} from './tm-coordinate-raw-schema.js';
