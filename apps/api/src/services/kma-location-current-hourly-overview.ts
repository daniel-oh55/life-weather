/**
 * The KMA (기상청) **location current + hourly `WeatherOverview` application
 * service**: the orchestration layer that actually invokes the PR #24 location hourly overview
 * service and the PR #74 location current overview service, in that order, and combines their
 * results through the PR #76 pure aggregate assembler.
 *
 * Pipeline it connects:
 *
 * ```text
 * { product, location }
 *   → hourlyOverviewService.fetchHourlyWeatherOverviewForLocation(input, options)  // PR #24
 *   → LOCATION failure → returned verbatim (current is never attempted)
 *   → hourly success   → currentOverviewService.fetchCurrentWeatherOverviewForLocation(       // PR #74
 *          { location: hourlyResult.overview.location }, options)
 *        → ok:true  → assembler({ hourly: hourlyResult, current: currentResult })  // PR #76
 *        → ok:false → assembler({ hourly: hourlyResult, current: null })           // degraded
 *   → { ok: true, selection: hourlyResult.selection, overview }
 * ```
 *
 * ### Hourly is the required baseline
 *
 * Execution always begins with the hourly service, called with the caller's exact `input` and
 * `options` references (never cloned or reconstructed). Hourly defines whether the overall
 * application request has a usable location baseline at all.
 *
 * A hourly-service top-level `LOCATION` failure is returned **verbatim** — the exact result
 * reference, with no field added or removed — and neither the current service nor the assembler
 * runs. Current is an additive section and must not run when the required location baseline
 * already failed.
 *
 * Every hourly `{ ok: true }` result proceeds to current, **including** a no-selection success
 * (`selection.selected === false`, `overview.hourly: []`, `HOURLY` in `missingSections`). Hourly
 * "no usable data" does not prevent current from being attempted.
 *
 * ### Current input — the hourly baseline location, not the caller's raw input
 *
 * After a hourly success, this service calls the current service with a **fresh** input object
 * containing exactly `{ location: hourlyResult.overview.location }` — the parsed location the
 * hourly application service already produced, by exact reference. It does not use the caller's
 * raw `input.location`, grid values, or any other trace. The caller's exact `options` reference
 * (or `undefined` when omitted) is forwarded to the current service unchanged — no clone, no new
 * `AbortController`, no combined signal.
 *
 * ### Current explicit failure degradation policy
 *
 * If the current service **resolves** with `ok: false` for any of its existing stages —
 * `LOCATION`, `PROVIDER`, or `NORMALIZATION` — that failure is **not** returned and its stage is
 * never inspected to choose different behavior. Instead the PR #76 assembler is called with
 * `current: null`, so the resulting overview expresses current unavailability through
 * `current: null` and `CURRENT` in `missingSections` — section-level degradation, not a
 * service/HTTP error. Once hourly has already produced a valid location baseline, an explicit
 * current-section failure must not discard already-usable hourly data, and this service treats
 * all three stages uniformly (no stage/error field leaks into the combined result).
 *
 * A current `{ ok: true }` result is passed to the assembler by exact reference, unmodified,
 * alongside the exact hourly success reference.
 *
 * ### Unexpected throws/rejections are not degraded
 *
 * Only a **resolved** current result with `ok: false` is degraded to `current: null`. A hourly
 * synchronous throw, a hourly Promise rejection, a current synchronous throw, a current Promise
 * rejection, or an assembler throw are never caught or degraded — each propagates as the exact
 * same error/rejection reference. There is no broad `try`/`catch`.
 *
 * ### Execution order — sequential, not concurrent
 *
 * The method is intentionally **not** `async`. It calls the hourly service synchronously and
 * `.then()`s its result; only inside that fulfillment handler, and only on a hourly success, does
 * it call the current service and `.then()` its result to build the aggregate. `Promise.all` /
 * `Promise.allSettled` / eager parallel current execution are deliberately not used: the hourly
 * `LOCATION` failure must stay authoritative, unsupported locations must not trigger unnecessary
 * current work, and error precedence and `AbortSignal`/rejection behavior stay simple. This PR
 * does not optimize latency.
 *
 * ### Result contract — exactly `KmaLocationHourlyOverviewResult`-compatible
 *
 * The combined result's public shape is **intentionally** identical to
 * {@link KmaLocationHourlyOverviewResult} — either the hourly `LOCATION` failure verbatim, or
 * `{ ok: true, selection: hourlyResult.selection, overview }` (the exact hourly `selection`
 * reference and a fresh wrapper around the assembler's exact return reference). No
 * `currentResult`, `currentFailure`, `degraded`, `partial`, `warnings`, failure stage, provider
 * error, source trace, request trace, or coordinates are added. This exact compatibility is
 * deliberate so a later production-wiring PR can reuse the existing hourly presenter boundary
 * without redesigning the public HTTP contract; this PR does not modify the presenter.
 *
 * ### Purity and no policy reimplementation
 *
 * Construction is side-effect-free: it calls no collaborator, reads no clock/environment/network,
 * registers no listener, and owns no mutable state, cache, counter, or singleton — it merely
 * closes over the three injected references. It mutates neither `input`, `options`, the hourly
 * result, the hourly `selection`/`overview`, nor the current result/overview, and every call
 * builds a fresh success wrapper. This service does not implement `WeatherOverview` merging
 * itself (that is the PR #76 assembler's job), does not re-run hourly fallback/selection policy,
 * and does not inspect current provider/normalization details — it only reads `currentResult.ok`
 * to decide between the current success object and `null`.
 *
 * ### What it is not
 *
 * It does not build a production composition root, wire `apps/api/src/index.ts`, register the
 * `/weather` route, map HTTP status/envelopes, implement a current availability-delay selector,
 * or add cache/stale-data/retry/timeout/concurrency-optimization policy. Those remain later PRs.
 * See `docs/kma-location-current-hourly-overview.md`.
 */

import {
  assembleKmaCurrentHourlyWeatherOverview,
  type KmaCurrentHourlyWeatherOverviewInput,
} from './kma-current-hourly-weather-overview.js';
import type { KmaLocationCurrentOverviewService } from './kma-location-current-overview.js';
import type {
  KmaLocationHourlyOverviewInput,
  KmaLocationHourlyOverviewOptions,
  KmaLocationHourlyOverviewResult,
  KmaLocationHourlyOverviewService,
} from './kma-location-hourly-overview.js';

/** A deliberate alias of the PR #24 {@link KmaLocationHourlyOverviewInput} — no new input shape. */
export type KmaLocationCurrentHourlyOverviewInput = KmaLocationHourlyOverviewInput;

/** A deliberate alias of the PR #24 {@link KmaLocationHourlyOverviewOptions} (`{ signal? }`). */
export type KmaLocationCurrentHourlyOverviewOptions = KmaLocationHourlyOverviewOptions;

/**
 * A deliberate alias of the PR #24 {@link KmaLocationHourlyOverviewResult} — either the hourly
 * `LOCATION`-stage failure verbatim, or `{ ok: true, selection, overview }`. The combined
 * service's result stays exactly compatible with the existing hourly result shape; see the module
 * doc's "Result contract" section.
 */
export type KmaLocationCurrentHourlyOverviewResult = KmaLocationHourlyOverviewResult;

/** The service's single public method. */
export interface KmaLocationCurrentHourlyOverviewService {
  /**
   * Run the PR #24 hourly overview service; return its `LOCATION` failure verbatim, or otherwise
   * run the PR #74 current overview service against the hourly baseline's location and combine
   * both through the PR #76 assembler (degrading any resolved current `ok: false` to
   * `current: null`). Not `async`: a hourly synchronous throw propagates synchronously; a hourly
   * rejection, a current synchronous throw/rejection, or an assembler throw reject the returned
   * Promise with the same reference. `options` is forwarded to both services by reference (or
   * `undefined` when omitted).
   */
  readonly fetchCurrentHourlyWeatherOverviewForLocation: (
    input: KmaLocationCurrentHourlyOverviewInput,
    options?: KmaLocationCurrentHourlyOverviewOptions,
  ) => Promise<KmaLocationCurrentHourlyOverviewResult>;
}

/**
 * Create a location current+hourly overview application service bound to an injected PR #24
 * hourly overview service and PR #74 current overview service, plus an optional PR #76 assembler
 * collaborator that defaults to the real `assembleKmaCurrentHourlyWeatherOverview`.
 *
 * Pure construction: it calls no collaborator, reads no clock/environment/network, registers no
 * listener, and starts no timer — the returned object merely closes over the three references.
 * The same instance is safe to call many times; it holds no mutable state, cache, or counter, and
 * each call is independent of any previous one and returns a fresh wrapper object.
 */
export function createKmaLocationCurrentHourlyOverviewService(
  hourlyOverviewService: KmaLocationHourlyOverviewService,
  currentOverviewService: KmaLocationCurrentOverviewService,
  overviewAssembler: typeof assembleKmaCurrentHourlyWeatherOverview = assembleKmaCurrentHourlyWeatherOverview,
): KmaLocationCurrentHourlyOverviewService {
  return {
    fetchCurrentHourlyWeatherOverviewForLocation(input, options) {
      // Step 1: hourly is the required baseline, called synchronously with the caller's exact
      // input/options references. A synchronous throw here propagates verbatim, before any
      // `.then` runs.
      const hourlyPromise = hourlyOverviewService.fetchHourlyWeatherOverviewForLocation(
        input,
        options,
      );

      return hourlyPromise.then((hourlyResult) => {
        // Step 2: a top-level LOCATION failure is returned exactly as the hourly service
        // produced it. Current is never attempted for an unsupported location.
        if (!hourlyResult.ok) {
          return hourlyResult;
        }

        // Step 3: every hourly success — including a no-selection success — proceeds to current,
        // using the hourly baseline's own parsed location (never the caller's raw input) and the
        // caller's exact options reference.
        return currentOverviewService
          .fetchCurrentWeatherOverviewForLocation(
            { location: hourlyResult.overview.location },
            options,
          )
          .then((currentResult) => {
            // Step 4: a resolved current failure (LOCATION/PROVIDER/NORMALIZATION) degrades to
            // `current: null` uniformly, without inspecting or exposing its stage. A current
            // success reaches the assembler by exact reference.
            const overview = overviewAssembler({
              hourly: hourlyResult,
              current: currentResult.ok ? currentResult : null,
            } satisfies KmaCurrentHourlyWeatherOverviewInput);

            return {
              ok: true,
              selection: hourlyResult.selection,
              overview,
            };
          });
      });
    },
  };
}
