/**
 * The AirKorea (에어코리아) **location current air-quality application service**: the orchestration
 * layer that connects an already-validated `WeatherLocation` to a `CurrentAirQuality` by chaining the
 * three independent AirKorea provider boundaries:
 *
 * ```text
 * { location }
 *   → weatherLocation.parse(location)                          // contracts runtime validation (upfront)
 *   → supported-location check (KR, adminArea1/adminArea3 non-null)
 *   → tmCoordinateProvider.fetchTmCoordinates({ umdName: adminArea3 })   // PR #84
 *   → exact-match candidate resolution against adminArea1/adminArea2/adminArea3
 *   → nearbyStationProvider.fetchNearbyStations({ tmX, tmY })            // PR #83
 *   → closest-station selection (distance, then stationName tie-break)
 *   → currentAirQualityProvider.fetchCurrentAirQuality({ stationName })  // PR #82
 *   → normalizeAirKoreaCurrentAirQuality                                  // existing PR #82 normalizer
 *   → { ok: true, current }
 * ```
 *
 * This service owns exactly two application-level decisions neither provider makes: **which** TM
 * candidate a `WeatherLocation`'s administrative context identifies (PR #84 returns every structurally
 * valid candidate — a `umdName` may legitimately recur across different 시군구), and **which** nearby
 * station is closest (PR #83 returns candidates in undocumented upstream order). It re-implements no
 * provider or normalizer logic — every request field, error kind, and field-parsing rule stays owned by
 * its provider/normalizer.
 *
 * ### Supported-location policy
 *
 * Only a Korean location with enough administrative context to call PR #84 is supported:
 * `countryCode === 'KR'`, `adminArea1 !== null`, `adminArea3 !== null`. `adminArea2` may stay `null` —
 * the shared contract allows a two-level hierarchy. A province/district-level location (e.g. `서울특별시
 * 중구` with `adminArea3: null`) fails closed as `UNSUPPORTED_ADMINISTRATIVE_LEVEL` rather than guessing
 * a child dong from `adminArea2`/`displayName`, or treating latitude/longitude as TM coordinates.
 *
 * ### TM-candidate resolution
 *
 * A candidate matches only when `candidate.sidoName === location.adminArea1`, `candidate.umdName ===
 * location.adminArea3`, and — only when `location.adminArea2 !== null` — `candidate.sggName ===
 * location.adminArea2`. No trim/fuzzy/prefix/alias normalization. Zero matches is
 * `TM_COORDINATE_NOT_FOUND`; more than one is `AMBIGUOUS_TM_COORDINATE` — `candidates[0]` is never
 * assumed correct.
 *
 * ### Closest-station selection
 *
 * `distanceKm` is the primary key (smallest wins); `stationName` ascending (`<`/`>`, not
 * `localeCompare`) is a deterministic tie-break for equal distances only — never upstream array order.
 * PR #83 guarantees a provider success carries a non-empty station collection; if that invariant is
 * ever violated at runtime this service fails closed with a static `NEARBY_STATION_NOT_FOUND` LOCATION
 * error rather than fabricating a station.
 *
 * ### Execution and failure semantics
 *
 * Strictly sequential — at most three network calls (TM lookup, nearby-station lookup, current-AQ
 * lookup), never `Promise.all`, no retry/fallback/cache. Every provider-stage failure carries the
 * losing provider's own error **by exact reference**, never re-classified. `options` (and any
 * `AbortSignal` inside it) is forwarded to all three providers by the same reference; no
 * `AbortController` is constructed here. The method is intentionally **not** `async`:
 * `weatherLocation.parse` and a first-provider synchronous throw propagate synchronously; every
 * subsequent Promise rejection or collaborator throw rejects the returned Promise with the same
 * reference — there is no broad `try`/`catch`.
 *
 * Construction is side-effect-free: it only closes over the three injected provider references.
 *
 * See `docs/airkorea-location-current-air-quality-service.md` for the full policy record.
 */

import {
  weatherLocation,
  type CurrentAirQuality,
  type WeatherLocation,
} from '@life-weather/contracts';

import {
  normalizeAirKoreaCurrentAirQuality,
  type AirKoreaCurrentAirQualityProvider,
  type AirKoreaCurrentAirQualityProviderError,
  type AirKoreaCurrentNormalizationIssue,
  type AirKoreaNearbyStationCandidate,
  type AirKoreaNearbyStationProvider,
  type AirKoreaNearbyStationProviderError,
  type AirKoreaTmCoordinateCandidate,
  type AirKoreaTmCoordinateProvider,
  type AirKoreaTmCoordinateProviderError,
} from '../providers/airkorea/index.js';

/** The caller-supplied input: a full contracts {@link WeatherLocation}. */
export interface AirKoreaLocationCurrentAirQualityInput {
  readonly location: WeatherLocation;
}

/**
 * Per-call options. Forwarded unchanged (by exact reference, or exactly `undefined` when omitted) to
 * all three providers — no new `AbortController` is ever constructed here.
 */
export interface AirKoreaLocationCurrentAirQualityOptions {
  readonly signal?: AbortSignal;
}

/**
 * Application-owned, value-free `LOCATION`-stage failure kinds. None carries latitude, longitude,
 * administrative names, `displayName`, a provider URL, or any other raw value.
 */
export type AirKoreaLocationCurrentAirQualityLocationError =
  | { readonly kind: 'UNSUPPORTED_COUNTRY' }
  | { readonly kind: 'UNSUPPORTED_ADMINISTRATIVE_LEVEL' }
  | { readonly kind: 'TM_COORDINATE_NOT_FOUND' }
  | { readonly kind: 'AMBIGUOUS_TM_COORDINATE' }
  | { readonly kind: 'NEARBY_STATION_NOT_FOUND' };

/**
 * The outcome of one `fetchCurrentAirQualityForLocation` call. Success carries only the normalized
 * `CurrentAirQuality` — never `stationName`, TM coordinates, candidate lists, distance, the raw
 * provider observation, or any URL/body/key. Each failure names the `stage` it happened in; a
 * provider-stage failure carries that provider's own error **verbatim** (never re-classified), and
 * `NORMALIZATION` carries the existing normalizer's issues verbatim.
 */
export type AirKoreaLocationCurrentAirQualityResult =
  | { readonly ok: true; readonly current: CurrentAirQuality }
  | {
      readonly ok: false;
      readonly stage: 'LOCATION';
      readonly error: AirKoreaLocationCurrentAirQualityLocationError;
    }
  | {
      readonly ok: false;
      readonly stage: 'TM_COORDINATE_PROVIDER';
      readonly error: AirKoreaTmCoordinateProviderError;
    }
  | {
      readonly ok: false;
      readonly stage: 'NEARBY_STATION_PROVIDER';
      readonly error: AirKoreaNearbyStationProviderError;
    }
  | {
      readonly ok: false;
      readonly stage: 'CURRENT_PROVIDER';
      readonly error: AirKoreaCurrentAirQualityProviderError;
    }
  | {
      readonly ok: false;
      readonly stage: 'NORMALIZATION';
      readonly issues: readonly AirKoreaCurrentNormalizationIssue[];
    };

/** The service's single public method. */
export interface AirKoreaLocationCurrentAirQualityService {
  /**
   * Validate `input.location`, resolve it through the TM-coordinate → nearby-station →
   * current-air-quality pipeline, and return `{ ok: true, current }` or the first stage's failure.
   * Not `async`: an invalid location and a first-provider synchronous throw propagate synchronously;
   * every later rejection/throw rejects the returned Promise with the same reference. `options` is
   * forwarded to every provider call by reference (or `undefined` when omitted).
   */
  readonly fetchCurrentAirQualityForLocation: (
    input: AirKoreaLocationCurrentAirQualityInput,
    options?: AirKoreaLocationCurrentAirQualityOptions,
  ) => Promise<AirKoreaLocationCurrentAirQualityResult>;
}

/**
 * Every structurally valid TM candidate whose `sidoName`/`umdName` match the location exactly, and
 * whose `sggName` also matches when `adminArea2` is not `null`. No trim/fuzzy/prefix/alias
 * normalization; `candidates[0]` is never assumed correct.
 */
function resolveExactTmCandidates(
  adminArea1: string,
  adminArea2: string | null,
  adminArea3: string,
  candidates: readonly AirKoreaTmCoordinateCandidate[],
): AirKoreaTmCoordinateCandidate[] {
  return candidates.filter((candidate) => {
    if (candidate.sidoName !== adminArea1) {
      return false;
    }
    if (candidate.umdName !== adminArea3) {
      return false;
    }
    if (adminArea2 !== null && candidate.sggName !== adminArea2) {
      return false;
    }
    return true;
  });
}

/**
 * The candidate with the smallest `distanceKm`; ties broken by `stationName` ascending (`<`/`>`,
 * locale-independent — never `localeCompare`), never by upstream array order. Returns `null` only if
 * `stations` is empty (a PR #83 invariant violation this service never fabricates around).
 */
function selectClosestStation(
  stations: readonly AirKoreaNearbyStationCandidate[],
): AirKoreaNearbyStationCandidate | null {
  if (stations.length === 0) {
    return null;
  }
  let closest = stations[0]!;
  for (const candidate of stations.slice(1)) {
    if (
      candidate.distanceKm < closest.distanceKm ||
      (candidate.distanceKm === closest.distanceKm && candidate.stationName < closest.stationName)
    ) {
      closest = candidate;
    }
  }
  return closest;
}

/**
 * Create a location current-air-quality service bound to the three injected AirKorea providers. Pure
 * construction: it calls no provider, reads no clock/environment/network, and registers no listener —
 * the returned object merely closes over the three references. The same instance is safe to call many
 * times; it holds no mutable state, cache, or counter.
 */
export function createAirKoreaLocationCurrentAirQualityService(
  tmCoordinateProvider: AirKoreaTmCoordinateProvider,
  nearbyStationProvider: AirKoreaNearbyStationProvider,
  currentAirQualityProvider: AirKoreaCurrentAirQualityProvider,
): AirKoreaLocationCurrentAirQualityService {
  return {
    fetchCurrentAirQualityForLocation(input, options) {
      // Step 1: validate the location upfront. An invalid location throws a synchronous Zod error and
      // no provider is called.
      const location = weatherLocation.parse(input.location);

      const adminArea1 = location.adminArea1;
      const adminArea2 = location.adminArea2;
      const adminArea3 = location.adminArea3;

      // Step 2: supported-location policy. Fails closed for anything short of a full KR leaf
      // administrative location — never guesses a child dong from adminArea2/displayName.
      if (location.countryCode !== 'KR') {
        return Promise.resolve({
          ok: false,
          stage: 'LOCATION',
          error: { kind: 'UNSUPPORTED_COUNTRY' },
        });
      }
      if (adminArea1 === null || adminArea3 === null) {
        return Promise.resolve({
          ok: false,
          stage: 'LOCATION',
          error: { kind: 'UNSUPPORTED_ADMINISTRATIVE_LEVEL' },
        });
      }

      // Step 3: PR #84 TM-coordinate lookup, exactly once, with a fresh request object.
      return tmCoordinateProvider
        .fetchTmCoordinates({ umdName: adminArea3 }, options)
        .then((tmResult): AirKoreaLocationCurrentAirQualityResult | Promise<AirKoreaLocationCurrentAirQualityResult> => {
          if (!tmResult.ok) {
            return { ok: false, stage: 'TM_COORDINATE_PROVIDER', error: tmResult.error };
          }

          // Step 4: application-owned exact-match disambiguation.
          const matches = resolveExactTmCandidates(
            adminArea1,
            adminArea2,
            adminArea3,
            tmResult.candidates,
          );
          if (matches.length === 0) {
            return { ok: false, stage: 'LOCATION', error: { kind: 'TM_COORDINATE_NOT_FOUND' } };
          }
          if (matches.length > 1) {
            return { ok: false, stage: 'LOCATION', error: { kind: 'AMBIGUOUS_TM_COORDINATE' } };
          }
          const selectedTm = matches[0]!;

          // Step 5: PR #83 nearby-station lookup, exactly once, with a fresh request object.
          return nearbyStationProvider
            .fetchNearbyStations({ tmX: selectedTm.tmX, tmY: selectedTm.tmY }, options)
            .then((nearbyResult): AirKoreaLocationCurrentAirQualityResult | Promise<AirKoreaLocationCurrentAirQualityResult> => {
              if (!nearbyResult.ok) {
                return { ok: false, stage: 'NEARBY_STATION_PROVIDER', error: nearbyResult.error };
              }

              // Step 6: application-owned closest-station selection.
              const closest = selectClosestStation(nearbyResult.stations);
              if (closest === null) {
                return {
                  ok: false,
                  stage: 'LOCATION',
                  error: { kind: 'NEARBY_STATION_NOT_FOUND' },
                };
              }

              // Step 7: PR #82 current-air-quality lookup, exactly once, with a fresh request object.
              return currentAirQualityProvider
                .fetchCurrentAirQuality({ stationName: closest.stationName }, options)
                .then((currentResult): AirKoreaLocationCurrentAirQualityResult => {
                  if (!currentResult.ok) {
                    return { ok: false, stage: 'CURRENT_PROVIDER', error: currentResult.error };
                  }

                  // Step 8: the existing PR #82 normalizer — no reimplementation of its rules.
                  const normalized = normalizeAirKoreaCurrentAirQuality(currentResult.observation);
                  if (!normalized.ok) {
                    return { ok: false, stage: 'NORMALIZATION', issues: normalized.issues };
                  }

                  return { ok: true, current: normalized.current };
                });
            });
        });
    },
  };
}
