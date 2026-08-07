/**
 * The KMA (기상청) **location scheduled current-observation facade**: a deliberately thin
 * application-level adapter that puts the existing latitude/longitude → grid converter
 * (`convertKmaLatitudeLongitudeToGrid`) in front of the PR #68 scheduled current-observation
 * facade, so a caller can go straight from `latitude`/`longitude` to a
 * {@link KmaScheduledCurrentObservationResult} without converting coordinates and wiring the two by
 * hand every time.
 *
 * Pipeline it connects:
 *
 * ```text
 * caller input (latitude / longitude)
 *   → gridConverter({ latitude, longitude })                 // injected
 *   → { nx, ny } | null
 *   → scheduledFacade.fetchScheduledCurrentWeather(           // PR #68
 *        { nx, ny }, options)
 *   → KmaScheduledCurrentObservationResult (returned verbatim)
 * ```
 *
 * This is the current-observation counterpart of `kma-location-scheduled-hourly-forecast.ts` (the
 * PR #13 location scheduled hourly facade) — a **separate**, parallel facade, not a generalization
 * of it. Both collaborators are **injected**. This facade introduces exactly one new outcome — a
 * `LOCATION`-stage {@link KmaCurrentObservationUnsupportedLocationError} for a physically valid
 * coordinate the KMA grid does not cover — and no other new rule. It owns no projection math, no
 * clock read, no provider call, no environment read, and no network I/O: the injected converter
 * still owns the projection and its `RangeError` policy, and the scheduled facade still owns
 * request assembly, the provider call, and the `PROVIDER`/`NORMALIZATION` result union.
 *
 * Reference and mutation: the caller's `input` is never spread, cloned, mutated, or forwarded
 * as-is (its shape differs from both collaborators'). The converter receives a **fresh** object
 * with exactly `latitude`/`longitude`; the scheduled facade receives a **fresh** object with
 * exactly `nx`/`ny` (the converter's `nx`/`ny` passed through unchanged — never defaulted, swapped,
 * clamped, rounded, or stringified); and the caller's `options` reaches the scheduled facade as the
 * **same** reference (omitted `options` forwarded as exactly `undefined`).
 *
 * Promise identity and error boundary: on a supported location,
 * `fetchScheduledCurrentWeatherForLocation` returns the **exact** Promise the scheduled facade
 * returns — the method is intentionally written without an `async` marker and adds no extra
 * Promise layer, so a success, a `PROVIDER`-stage failure, a `NORMALIZATION`-stage failure, a
 * synchronous throw, and a rejection all propagate exactly as the scheduled facade produced them.
 * If the converter throws (a non-finite/out-of-physical-range `RangeError`, or an injected
 * converter's own error), the **same** error reference propagates synchronously and the scheduled
 * facade is **not** called — a throw is never converted to a Promise or a `LOCATION` result. Only a
 * converter `null` becomes the `LOCATION` result; `RangeError` and unsupported-location are never
 * merged.
 *
 * The `LOCATION` result is a value-free discriminator: it carries no latitude/longitude, no grid,
 * no country/provider, no URL, no raw input, and no message — a physically valid coordinate simply
 * fell outside the current KMA forecast grid. HTTP status and user messaging are decided elsewhere.
 * Each unsupported call builds a **fresh** Promise, result, and error object (no module-level
 * shared failure singleton).
 *
 * Construction is side-effect-free: {@link createKmaLocationScheduledCurrentObservationFacade}
 * calls neither collaborator, reads no clock, reads no environment, touches no network, registers
 * no listener, and starts no timer — the returned object merely closes over the two references and
 * holds no other state, so the same instance is safe to call repeatedly with each call independent
 * of any previous one.
 *
 * What it is **not**: it does not select the concrete converter (that is the composition layer's
 * job), build a provider, read a clock, read a service key, apply an availability delay, retry,
 * fall back, or assemble a `WeatherOverview`; and it registers no HTTP route. See
 * `docs/kma-location-scheduled-current-observation.md`.
 */

import type {
  ConvertKmaLatitudeLongitudeToGridInput,
  KmaForecastGridCoordinate,
} from '@life-weather/weather-core';

import type {
  KmaScheduledCurrentObservationFacade,
  KmaScheduledCurrentObservationOptions,
  KmaScheduledCurrentObservationResult,
} from './kma-scheduled-current-observation.js';

/**
 * The injected forward converter. Structurally the existing
 * {@link convertKmaLatitudeLongitudeToGrid}: it returns a fresh grid coordinate for a supported
 * location, `null` for a physically valid coordinate the grid does not cover, and throws
 * `RangeError` for a non-finite or out-of-physical-range coordinate. The concrete production
 * converter is chosen by the composition layer, never by this facade.
 */
export type KmaLocationCurrentObservationGridConverter = (
  input: ConvertKmaLatitudeLongitudeToGridInput,
) => KmaForecastGridCoordinate | null;

/**
 * The caller-supplied input: a decimal-degree `latitude`/`longitude`. This is the one shape the
 * location facade defines; it is converted to the converter's and the scheduled facade's shapes
 * internally and never forwarded to either collaborator as-is.
 */
export interface KmaLocationScheduledCurrentObservationInput {
  readonly latitude: number;
  readonly longitude: number;
}

/**
 * Per-call options. Reused verbatim from the PR #68 scheduled current-observation facade (its
 * `signal` included) — the location facade forwards this reference to the scheduled facade
 * untouched.
 */
export type KmaLocationScheduledCurrentObservationOptions =
  KmaScheduledCurrentObservationOptions;

/**
 * The location-stage error: a physically valid coordinate the converter accepts but the current
 * KMA forecast grid does not cover. Value-free by contract — it carries only its `kind`, never the
 * coordinate, grid, or any other input-derived detail.
 */
export interface KmaCurrentObservationUnsupportedLocationError {
  readonly kind: 'UNSUPPORTED_LOCATION';
}

/**
 * The outcome of one call. Either the scheduled facade's own success / `PROVIDER` /
 * `NORMALIZATION` result (returned unchanged) or the location facade's `LOCATION`-stage
 * unsupported-location failure. This is the only result the location facade adds.
 */
export type KmaLocationScheduledCurrentObservationResult =
  | KmaScheduledCurrentObservationResult
  | {
      readonly ok: false;
      readonly stage: 'LOCATION';
      readonly error: KmaCurrentObservationUnsupportedLocationError;
    };

/** The facade's single public method. */
export interface KmaLocationScheduledCurrentObservationFacade {
  /**
   * Convert `input`'s `latitude`/`longitude` to a grid via the injected converter, then (on a
   * supported location) fetch the scheduled current observation for `nx`/`ny`. Calls the converter
   * **exactly once**; on a supported location calls the scheduled facade **exactly once** and
   * returns its Promise as-is; on an unsupported location returns a fresh `LOCATION` failure and
   * never calls the scheduled facade; and lets a converter throw propagate synchronously.
   */
  readonly fetchScheduledCurrentWeatherForLocation: (
    input: KmaLocationScheduledCurrentObservationInput,
    options?: KmaLocationScheduledCurrentObservationOptions,
  ) => Promise<KmaLocationScheduledCurrentObservationResult>;
}

/**
 * Create a location scheduled current-observation facade bound to an injected grid converter and
 * scheduled facade. Pure construction: it calls neither collaborator and performs no I/O — the
 * returned object just closes over the two references. The same instance is safe to call many
 * times; it holds no mutable state and each call is independent of any previous one.
 */
export function createKmaLocationScheduledCurrentObservationFacade(
  gridConverter: KmaLocationCurrentObservationGridConverter,
  scheduledFacade: KmaScheduledCurrentObservationFacade,
): KmaLocationScheduledCurrentObservationFacade {
  return {
    fetchScheduledCurrentWeatherForLocation(input, options) {
      // Step 1: convert exactly once, from a fresh { latitude, longitude } object (never the
      // caller input spread). A converter throw propagates verbatim and step 3 never runs.
      const grid = gridConverter({
        latitude: input.latitude,
        longitude: input.longitude,
      });

      // Step 2: a `null` (physically valid but off-grid) becomes a fresh LOCATION failure — a
      // value-free discriminator, resolved as a fresh Promise, with no scheduled-facade call.
      if (grid === null) {
        return Promise.resolve({
          ok: false,
          stage: 'LOCATION',
          error: {
            kind: 'UNSUPPORTED_LOCATION',
          },
        });
      }

      // Step 3: hand a fresh { nx, ny } object and the caller's options straight to the scheduled
      // facade and return its Promise unchanged — no extra Promise layer, so the result/rejection
      // contract is intact. The grid's nx/ny pass through untouched.
      return scheduledFacade.fetchScheduledCurrentWeather(
        {
          nx: grid.nx,
          ny: grid.ny,
        },
        options,
      );
    },
  };
}
