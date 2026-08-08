/**
 * The **production composition root** for the KMA *location* scheduled current-observation
 * (초단기실황) pipeline — the latitude/longitude entry point that sits in front of the PR #69
 * grid-based current-observation composition.
 *
 * It assembles the PR #70 location facade over two production dependencies:
 *
 * ```text
 * createKmaScheduledCurrentObservationCompositionFromEnv (PR #69)  → live grid-based scheduled facade
 * convertKmaLatitudeLongitudeToGrid                      (existing) → production forward converter
 *
 * converter + scheduled facade
 *   → createKmaLocationScheduledCurrentObservationFacade (PR #70) → live location facade
 * ```
 *
 * This is the current-observation counterpart of `kma-location-scheduled-hourly.ts` (the PR #13
 * location scheduled hourly composition) — a **separate**, parallel composition, not a
 * generalization of it. It does **not** re-implement the PR #69 production graph: the
 * provider-from-env, service-key validation, clock selection, request factory, current-observation
 * service, and scheduled facade are all built by the existing
 * {@link createKmaScheduledCurrentObservationCompositionFromEnv}, which this function consumes
 * verbatim. This layer only *selects* the existing production `convertKmaLatitudeLongitudeToGrid`
 * converter (imported from the `@life-weather/weather-core` public package surface, never by a
 * private deep import) and wires it to the existing scheduled facade through the PR #70 location
 * facade.
 *
 * It is a **callable** composition function — never an import-time singleton. Importing this
 * module reads no environment, builds no provider, reads no clock, runs no converter, and starts no
 * I/O; every dependency is created only when
 * {@link createKmaLocationScheduledCurrentObservationCompositionFromEnv} is *called*, and the first
 * converter run, clock read, and `fetch` happen only when the returned facade's method runs. `env`
 * and `dependencies` are forwarded to the existing composition by reference (never read, cloned,
 * spread, or mutated here), and a provider-configuration failure is returned as the **same**
 * {@link KmaProviderConfigError} reference, with no converter run, no clock read, no network, and no
 * location-facade construction.
 *
 * Responsibility boundary: this layer owns no KMA data rule, no transport, no normalization, no
 * issue-time math, no request-assembly rule, no projection math, no schedule-only-vs-availability
 * policy, and no facade-wiring rule beyond selecting the converter and delegating to the existing
 * composition. The PR #69 grid-based composition (and its result) and the PR #70 location facade
 * are left unchanged, and no HTTP route is registered. See
 * `docs/kma-location-scheduled-current-observation.md`.
 */

import { convertKmaLatitudeLongitudeToGrid } from '@life-weather/weather-core';

import type { KmaProviderConfigError } from '../providers/kma/index.js';
import {
  createKmaLocationScheduledCurrentObservationFacade,
  type KmaLocationScheduledCurrentObservationFacade,
} from '../services/index.js';
import {
  createKmaScheduledCurrentObservationCompositionFromEnv,
  type KmaScheduledCurrentObservationCompositionDependencies,
} from './kma-scheduled-current-observation.js';

/**
 * The dependencies a caller may override for the composed location pipeline. Reused verbatim from
 * the PR #69 grid-based composition ({@link KmaScheduledCurrentObservationCompositionDependencies})
 * — this PR adds no new dependency option. Both `fetchImpl` and `clock` are forwarded to the
 * existing composition unchanged; the production converter is a fixed production choice and is not
 * injectable here.
 */
export type KmaLocationScheduledCurrentObservationCompositionDependencies =
  KmaScheduledCurrentObservationCompositionDependencies;

/**
 * The outcome of composing the location pipeline. On success it exposes **only** the live location
 * facade — never the internal scheduled facade, grid converter, provider, request factory,
 * current-observation service, clock, environment, `fetchImpl`, or service key, so the internal
 * graph stays encapsulated. On a provider-configuration failure it carries the existing PR #69
 * composition's own {@link KmaProviderConfigError} **by reference**, unchanged.
 */
export type CreateKmaLocationScheduledCurrentObservationCompositionResult =
  | {
      readonly ok: true;
      readonly facade: KmaLocationScheduledCurrentObservationFacade;
    }
  | {
      readonly ok: false;
      readonly error: KmaProviderConfigError;
    };

/**
 * Compose a live location scheduled current-observation facade from the environment and optional
 * dependencies.
 *
 * Sequence:
 *
 * 1. Build the grid-based pipeline via
 *    {@link createKmaScheduledCurrentObservationCompositionFromEnv}, forwarding `env` and
 *    `dependencies` by reference (never read, cloned, spread, or mutated here).
 * 2. On a provider config failure, return `{ ok: false, error }` immediately — the **same** error
 *    reference, with no converter run, no clock read, no network, and no location-facade
 *    construction.
 * 3. Otherwise select the production converter ({@link convertKmaLatitudeLongitudeToGrid}).
 * 4. Wire the converter and the existing scheduled facade through
 *    {@link createKmaLocationScheduledCurrentObservationFacade}.
 * 5. Return `{ ok: true, facade }`.
 *
 * Construction is side-effect-free beyond reading provider configuration (inside the existing PR
 * #69 composition): it runs no converter, reads no clock, issues no network request, registers no
 * listener, starts no timer, and logs nothing. The first converter run, the first clock read, and
 * the first `fetch` happen only when the returned facade's
 * `fetchScheduledCurrentWeatherForLocation()` runs. Every call builds a fresh dependency graph —
 * there is no module-level singleton or shared cache.
 */
export function createKmaLocationScheduledCurrentObservationCompositionFromEnv(
  env?: NodeJS.ProcessEnv,
  dependencies?: KmaLocationScheduledCurrentObservationCompositionDependencies,
): CreateKmaLocationScheduledCurrentObservationCompositionResult {
  // Step 1: reuse the existing PR #69 production graph — provider-from-env, clock selection,
  // request factory, current-observation service, and scheduled facade — forwarding
  // env/dependencies by reference.
  const scheduledComposition = createKmaScheduledCurrentObservationCompositionFromEnv(
    env,
    dependencies,
  );

  // Step 2: a configuration failure is returned as a value, with the existing composition's own
  // error reference passed through unchanged — no converter run, no clock read, no network.
  if (!scheduledComposition.ok) {
    return {
      ok: false,
      error: scheduledComposition.error,
    };
  }

  // Steps 3–4: select the production converter (never called here) and wire it to the existing
  // scheduled facade through the PR #70 location facade.
  const facade = createKmaLocationScheduledCurrentObservationFacade(
    convertKmaLatitudeLongitudeToGrid,
    scheduledComposition.facade,
  );

  // Step 5: expose only the live location facade — the internal graph stays encapsulated.
  return {
    ok: true,
    facade,
  };
}
