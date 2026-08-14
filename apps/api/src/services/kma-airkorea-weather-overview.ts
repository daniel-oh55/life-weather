/**
 * The **cross-provider location `WeatherOverview` application service**: the orchestration layer that
 * actually invokes the existing KMA `KmaLocationCurrentHourlyOverviewService` (PR #77/#81) and the PR
 * #85 `AirKoreaLocationCurrentAirQualityService`, in that order, and combines their results through
 * the `weather-overview-air-quality-overlay.ts` overlay.
 *
 * Pipeline it connects:
 *
 * ```text
 * { product, location }
 *   → kmaService.fetchCurrentHourlyWeatherOverviewForLocation(input, options)
 *   → LOCATION failure → returned verbatim (AirKorea is never attempted)
 *   → KMA success      → airKoreaService.fetchCurrentAirQualityForLocation(
 *          { location: kmaResult.overview.location }, options)
 *        → ok:true  → resolve live AirKorea source metadata → overlay({ current, source })
 *        → ok:false → overlay(null)                                   // uniform degradation
 *   → { ok: true, selection: kmaResult.selection, overview }
 * ```
 *
 * ### KMA is the required baseline
 *
 * Execution always begins with the KMA combined current+hourly service, called with the caller's
 * exact `input`/`options` references (never cloned or reconstructed). A KMA top-level `LOCATION`
 * failure is returned **verbatim** — the exact result reference — and AirKorea is never attempted:
 * an unsupported location must not trigger unnecessary AirKorea work. Every KMA `{ ok: true }` result
 * (including one where hourly itself degraded internally) proceeds to AirKorea.
 *
 * ### AirKorea input — the KMA baseline location, not the caller's raw input
 *
 * After a KMA success, this service calls AirKorea with a **fresh** input object containing exactly
 * `{ location: kmaResult.overview.location }` — the parsed location the KMA pipeline already
 * produced, by exact reference. It does not use the caller's raw `input.location` or any other
 * trace. The caller's exact `options` reference (or `undefined` when omitted) is forwarded to
 * AirKorea unchanged — no clone, no new `AbortController`, no combined signal.
 *
 * ### AirKorea failure degradation policy
 *
 * If AirKorea **resolves** with `ok: false` for any of its existing stages (`LOCATION`,
 * `TM_COORDINATE_PROVIDER`, `NEARBY_STATION_PROVIDER`, `CURRENT_PROVIDER`, `NORMALIZATION`), that
 * failure is **not** returned and its stage is never inspected to choose different behavior — the
 * overlay is called with `airQuality: null`, so the combined overview expresses AirKorea
 * unavailability through `airQuality.current: null` and `AIR_QUALITY_CURRENT` in `missingSections`,
 * exactly like the existing KMA current-failure degradation. Every resolved AirKorea failure stage
 * degrades identically — none is special-cased.
 *
 * A resolved AirKorea `{ ok: true }` result resolves the live AirKorea source metadata **exactly
 * once** and is then overlaid by exact reference.
 *
 * ### Unexpected throws/rejections are not degraded
 *
 * Only a **resolved** AirKorea result with `ok: false` is degraded to `airQuality: null`. A KMA
 * synchronous throw, a KMA Promise rejection, an AirKorea synchronous throw, an AirKorea Promise
 * rejection, a source-metadata-resolver throw, or an overlay throw are never caught or degraded —
 * each propagates as the exact same error/rejection reference. There is no broad `try`/`catch`.
 *
 * ### Execution order — sequential, not concurrent
 *
 * The method is intentionally **not** `async`. It calls the KMA service synchronously and
 * `.then()`s its result; only inside that fulfillment handler, and only on a KMA success, does it
 * call AirKorea and `.then()` its result to build the aggregate. `Promise.all` /
 * `Promise.allSettled` / eager parallel AirKorea execution are deliberately not used.
 *
 * ### Result contract — exactly `KmaLocationCurrentHourlyOverviewResult`-compatible
 *
 * The combined result's public shape is **intentionally** identical to
 * {@link KmaLocationCurrentHourlyOverviewResult} — either the KMA `LOCATION` failure verbatim, or
 * `{ ok: true, selection: kmaResult.selection, overview }` (the exact KMA `selection` reference and a
 * fresh wrapper around the overlay's exact return reference). No `airQualityResult`,
 * `airQualityFailure`, `degraded`, failure stage, provider error, station, TM coordinate, or
 * candidate is added. This exact compatibility is deliberate so the existing production route
 * composition and presenter can consume this service without any new contract.
 *
 * ### Purity and no policy reimplementation
 *
 * Construction is side-effect-free: it closes over the three injected references only. It mutates
 * neither `input`, `options`, the KMA result, nor the AirKorea result, and every call builds a fresh
 * success wrapper. This service does not implement `WeatherOverview` overlay itself (that is the
 * overlay's job), does not re-run KMA orchestration, and does not inspect AirKorea provider/
 * normalization details — it only reads `airKoreaResult.ok` to decide between the AirKorea success
 * object and `null`.
 */

import type { AirKoreaLocationCurrentAirQualityService } from './airkorea-location-current-air-quality.js';
import type { AirKoreaCurrentSourceMetadataResolver } from './airkorea-current-source-metadata.js';
import type {
  KmaLocationCurrentHourlyOverviewInput,
  KmaLocationCurrentHourlyOverviewOptions,
  KmaLocationCurrentHourlyOverviewResult,
  KmaLocationCurrentHourlyOverviewService,
} from './kma-location-current-hourly-overview.js';
import {
  overlayAirKoreaCurrentAirQualityOnWeatherOverview,
  type AirQualityCurrentOverlayInput,
} from './weather-overview-air-quality-overlay.js';

/** A deliberate alias of {@link KmaLocationCurrentHourlyOverviewInput} — no new input shape. */
export type KmaAirKoreaWeatherOverviewInput = KmaLocationCurrentHourlyOverviewInput;

/** A deliberate alias of {@link KmaLocationCurrentHourlyOverviewOptions} (`{ signal? }`). */
export type KmaAirKoreaWeatherOverviewOptions = KmaLocationCurrentHourlyOverviewOptions;

/**
 * A deliberate alias of {@link KmaLocationCurrentHourlyOverviewResult} — either the KMA
 * `LOCATION`-stage failure verbatim, or `{ ok: true, selection, overview }`. See the module doc's
 * "Result contract" section.
 */
export type KmaAirKoreaWeatherOverviewResult = KmaLocationCurrentHourlyOverviewResult;

/** The service's single public method. */
export interface KmaAirKoreaWeatherOverviewService {
  /**
   * Run the KMA combined current+hourly overview service; return its `LOCATION` failure verbatim, or
   * otherwise run the PR #85 AirKorea current air-quality service against the KMA baseline's location
   * and overlay both through `overlayAirKoreaCurrentAirQualityOnWeatherOverview` (degrading any
   * resolved AirKorea `ok: false` to `airQuality: null`). Not `async`: a KMA synchronous throw
   * propagates synchronously; a KMA rejection, an AirKorea synchronous throw/rejection, a
   * source-metadata-resolver throw, or an overlay throw reject the returned Promise with the same
   * reference. `options` is forwarded to both collaborators by reference (or `undefined` when
   * omitted).
   */
  readonly fetchCurrentHourlyWeatherOverviewForLocation: (
    input: KmaAirKoreaWeatherOverviewInput,
    options?: KmaAirKoreaWeatherOverviewOptions,
  ) => Promise<KmaAirKoreaWeatherOverviewResult>;
}

/**
 * Create a cross-provider location current+hourly+air-quality overview application service bound to
 * an injected KMA combined service, PR #85 AirKorea service, and AirKorea live source metadata
 * resolver, plus an optional overlay collaborator that defaults to the real
 * `overlayAirKoreaCurrentAirQualityOnWeatherOverview`.
 *
 * Pure construction: it calls no collaborator, reads no clock/environment/network, registers no
 * listener, and starts no timer — the returned object merely closes over the four references. The
 * same instance is safe to call many times; it holds no mutable state, cache, or counter, and each
 * call is independent of any previous one and returns a fresh wrapper object.
 */
export function createKmaAirKoreaWeatherOverviewService(
  kmaService: KmaLocationCurrentHourlyOverviewService,
  airKoreaService: AirKoreaLocationCurrentAirQualityService,
  airKoreaSourceMetadataResolver: AirKoreaCurrentSourceMetadataResolver,
  overlayAssembler: typeof overlayAirKoreaCurrentAirQualityOnWeatherOverview = overlayAirKoreaCurrentAirQualityOnWeatherOverview,
): KmaAirKoreaWeatherOverviewService {
  return {
    fetchCurrentHourlyWeatherOverviewForLocation(input, options) {
      // Step 1: KMA is the required baseline, called synchronously with the caller's exact
      // input/options references. A synchronous throw here propagates verbatim, before any `.then`
      // runs.
      const kmaPromise = kmaService.fetchCurrentHourlyWeatherOverviewForLocation(input, options);

      return kmaPromise.then((kmaResult) => {
        // Step 2: a top-level LOCATION failure is returned exactly as the KMA service produced it.
        // AirKorea is never attempted for an unsupported location.
        if (!kmaResult.ok) {
          return kmaResult;
        }

        // Step 3: every KMA success proceeds to AirKorea, using the KMA baseline's own parsed
        // location (never the caller's raw input) and the caller's exact options reference.
        return airKoreaService
          .fetchCurrentAirQualityForLocation(
            { location: kmaResult.overview.location },
            options,
          )
          .then((airKoreaResult) => {
            // Step 4: a resolved AirKorea failure (any stage) degrades to `airQuality: null`
            // uniformly, without inspecting or exposing its stage. A resolved AirKorea success
            // resolves live source metadata exactly once and reaches the overlay by exact
            // reference.
            const overlayInput: AirQualityCurrentOverlayInput = airKoreaResult.ok
              ? {
                  baseline: kmaResult.overview,
                  airQuality: {
                    current: airKoreaResult.current,
                    source: airKoreaSourceMetadataResolver(),
                  },
                }
              : {
                  baseline: kmaResult.overview,
                  airQuality: null,
                };

            const overview = overlayAssembler(overlayInput);

            return {
              ok: true,
              selection: kmaResult.selection,
              overview,
            };
          });
      });
    },
  };
}
