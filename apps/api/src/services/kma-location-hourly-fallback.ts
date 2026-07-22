/**
 * The KMA (기상청) **location hourly-forecast fallback facade**: a deliberately thin
 * application-level adapter that puts the PR #12 latitude/longitude → grid converter in front of the
 * PR #19 {@link KmaHourlyFallbackService}, so a caller can go straight from `product`/`latitude`/
 * `longitude` to a primary + optional previous execution trace without converting coordinates and
 * wiring the two by hand every time.
 *
 * Pipeline it connects:
 *
 * ```text
 * caller input (product / latitude / longitude)
 *   → gridConverter({ latitude, longitude })                       // PR #12 (injected)
 *   → { nx, ny } | null
 *   → fallbackService.fetchHourlyForecastWithFallback(             // PR #19
 *        { product, nx, ny }, options)
 *   → KmaHourlyFallbackServiceResult (returned verbatim)
 * ```
 *
 * Both collaborators are **injected**. This facade introduces exactly one new outcome — a
 * `LOCATION`-stage {@link KmaUnsupportedLocationError} for a physically valid coordinate the KMA grid
 * does not cover — and no other new rule. It is the exact structural twin of the PR #13 location
 * *scheduled* facade, differing only in the collaborator it fronts (the fallback service instead of
 * the scheduled facade) and thus its result union. It owns no projection math, no base-time /
 * eligibility policy, no provider call, no clock read, no environment read, and no network I/O: the
 * injected converter still owns the projection and its `RangeError` policy, and the fallback service
 * still owns the primary/previous execution policy (a **maximum of two** provider calls per service
 * call — one when the primary is ineligible, two when it is eligible), abort handling, and the
 * `KmaHourlyFallbackServiceResult` union.
 *
 * Reference and mutation: the caller's `input` is never spread, cloned, mutated, or forwarded as-is
 * (its shape differs from both collaborators'). The converter receives a **fresh** object with
 * exactly `latitude`/`longitude`; the fallback service receives a **fresh** object with exactly
 * `product`/`nx`/`ny` (the converter's `nx`/`ny` passed through unchanged — never defaulted, swapped,
 * clamped, rounded, or stringified); and the caller's `options` reaches the fallback service as the
 * **same** reference (omitted `options` forwarded as exactly `undefined`).
 *
 * Promise identity and error boundary: on a supported location,
 * `fetchHourlyForecastWithFallbackForLocation` returns the **exact** Promise the fallback service
 * returns — the method is intentionally written without an `async` marker and adds no extra Promise
 * layer, so a no-fallback trace, a fallback trace, a synchronous throw, and a rejection all propagate
 * exactly as the fallback service produced them. If the converter throws (a non-finite /
 * out-of-physical-range `RangeError`, or an injected converter's own error), the **same** error
 * reference propagates synchronously and the fallback service is **not** called — a throw is never
 * converted to a Promise or a `LOCATION` result. Only a converter `null` becomes the `LOCATION`
 * result; `RangeError` and unsupported-location are never merged.
 *
 * The `LOCATION` result is a value-free discriminator: it carries no latitude/longitude, no grid, no
 * country/provider, no URL, no raw input, and no message — a physically valid coordinate simply fell
 * outside the current KMA forecast grid. It adds no `locationResolved`, `grid`, `selected`, `final`,
 * `fallbackUsed`, `source`, or `stale` field to either branch. HTTP status and user messaging are
 * decided elsewhere. Each unsupported call builds a **fresh** Promise, result, and error object (no
 * module-level shared failure singleton).
 *
 * Construction is side-effect-free: {@link createKmaLocationHourlyFallbackFacade} calls neither
 * collaborator, reads no clock, reads no environment, touches no network, registers no listener, and
 * starts no timer — the returned object merely closes over the two references and holds no other
 * state, so the same instance is safe to call repeatedly with each call independent of any previous
 * one.
 *
 * What it is **not**: it does not select the concrete PR #12 converter (that is the composition
 * layer's job), build a provider, read a clock, read a service key, apply an availability delay,
 * choose base times, classify eligibility, select a final primary/previous source, or assemble a
 * `WeatherOverview` / `SourceMetadata`; and it registers no HTTP route. See
 * `docs/kma-location-hourly-fallback.md`.
 */

import type {
  KmaHourlyFallbackService,
  KmaHourlyFallbackServiceOptions,
  KmaHourlyFallbackServiceResult,
} from './kma-hourly-fallback';
import type {
  KmaLocationForecastGridConverter,
  KmaLocationScheduledHourlyForecastInput,
  KmaLocationScheduledHourlyForecastResult,
} from './kma-location-scheduled-hourly-forecast';

/**
 * The caller-supplied input: a `product` plus a decimal-degree `latitude`/`longitude`. A deliberate
 * **alias** of the PR #13 {@link KmaLocationScheduledHourlyForecastInput}: the two location entry
 * points share exactly one caller shape, so aliasing re-defines no field and keeps them from
 * drifting apart.
 */
export type KmaLocationHourlyFallbackInput =
  KmaLocationScheduledHourlyForecastInput;

/**
 * Per-call options. A deliberate **alias** of the PR #19
 * {@link KmaHourlyFallbackServiceOptions} (`{ signal? }`) — the caller's options (its `signal`
 * included) is forwarded to the fallback service untouched, so no new option shape is introduced.
 */
export type KmaLocationHourlyFallbackOptions = KmaHourlyFallbackServiceOptions;

/**
 * The outcome of one call. Either the PR #19 fallback service's own execution trace
 * ({@link KmaHourlyFallbackServiceResult}, returned unchanged) or the location facade's
 * `LOCATION`-stage unsupported-location failure. The `LOCATION` branch is **reused** from the PR #13
 * location scheduled result via `Extract` rather than redefined, so the two facades cannot disagree
 * on the unsupported-location shape. This is the only result the location facade adds.
 */
export type KmaLocationHourlyFallbackResult =
  | KmaHourlyFallbackServiceResult
  | Extract<
      KmaLocationScheduledHourlyForecastResult,
      {
        readonly stage: 'LOCATION';
      }
    >;

/** The facade's single public method. */
export interface KmaLocationHourlyFallbackFacade {
  /**
   * Convert `input`'s `latitude`/`longitude` to a grid via the injected converter, then (on a
   * supported location) run the hourly-forecast fallback pipeline for `product`/`nx`/`ny`. Calls the
   * converter **exactly once**; on a supported location calls the fallback service **exactly once**
   * and returns its Promise as-is; on an unsupported location returns a fresh `LOCATION` failure and
   * never calls the fallback service; and lets a converter throw propagate synchronously.
   */
  readonly fetchHourlyForecastWithFallbackForLocation: (
    input: KmaLocationHourlyFallbackInput,
    options?: KmaLocationHourlyFallbackOptions,
  ) => Promise<KmaLocationHourlyFallbackResult>;
}

/**
 * Create a location hourly-forecast fallback facade bound to an injected grid converter and fallback
 * service. Pure construction: it calls neither collaborator and performs no I/O — the returned object
 * just closes over the two references. The same instance is safe to call many times; it holds no
 * mutable state and each call is independent of any previous one.
 */
export function createKmaLocationHourlyFallbackFacade(
  gridConverter: KmaLocationForecastGridConverter,
  fallbackService: KmaHourlyFallbackService,
): KmaLocationHourlyFallbackFacade {
  return {
    fetchHourlyForecastWithFallbackForLocation(input, options) {
      // Step 1: convert exactly once, from a fresh { latitude, longitude } object (never the caller
      // input spread, and never carrying `product`). A converter throw propagates verbatim and
      // step 3 never runs.
      const grid = gridConverter({
        latitude: input.latitude,
        longitude: input.longitude,
      });

      // Step 2: a `null` (physically valid but off-grid) becomes a fresh LOCATION failure — a
      // value-free discriminator, resolved as a fresh Promise, with no fallback-service call.
      if (grid === null) {
        return Promise.resolve({
          ok: false,
          stage: 'LOCATION',
          error: {
            kind: 'UNSUPPORTED_LOCATION',
          },
        });
      }

      // Step 3: hand a fresh { product, nx, ny } object and the caller's options straight to the
      // fallback service and return its Promise unchanged — no extra Promise layer, so the
      // execution-trace / rejection contract is intact. The grid's nx/ny pass through untouched.
      return fallbackService.fetchHourlyForecastWithFallback(
        {
          product: input.product,
          nx: grid.nx,
          ny: grid.ny,
        },
        options,
      );
    },
  };
}
