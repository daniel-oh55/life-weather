/**
 * The **production composition root** for the KMA *location* scheduled hourly-forecast pipeline —
 * the latitude/longitude entry point that sits in front of the grid-based composition from PR #11.
 *
 * It assembles the PR #13 location facade over two production dependencies:
 *
 * ```text
 * createKmaScheduledHourlyCompositionFromEnv (PR #11)  → live grid-based scheduled facade
 * convertKmaLatitudeLongitudeToGrid          (PR #12)  → production forward converter
 *
 * converter + scheduled facade
 *   → createKmaLocationScheduledHourlyForecastFacade (PR #13) → live location facade
 * ```
 *
 * It does **not** re-implement the production graph: the provider-from-env, service-key validation,
 * clock selection, request factory, hourly service, and scheduled facade are all built by the
 * existing {@link createKmaScheduledHourlyCompositionFromEnv}, which this function consumes
 * verbatim. This layer only *selects* the production PR #12 converter (imported from the
 * `@life-weather/weather-core` public package surface, never by a private deep import) and wires it
 * to the existing scheduled facade through the location facade.
 *
 * It is a **callable** composition function — never an import-time singleton. Importing this module
 * reads no environment, builds no provider, reads no clock, runs no converter, and starts no I/O;
 * every dependency is created only when {@link createKmaLocationScheduledHourlyCompositionFromEnv}
 * is *called*, and the first converter run, clock read, and `fetch` happen only when the returned
 * facade's method runs. `env` and `dependencies` are forwarded to the existing composition by
 * reference (never read, cloned, spread, or mutated here), and a provider-configuration failure is
 * returned as the **same** {@link KmaProviderConfigError} reference, with no converter run, no clock
 * read, no network, and no location-facade construction.
 *
 * Responsibility boundary: this layer owns no KMA data rule, no transport, no normalization, no
 * issue-time math, no request-assembly rule, no projection math, and no facade-wiring rule beyond
 * selecting the converter and delegating to the existing composition. The grid-based composition
 * (`createKmaScheduledHourlyCompositionFromEnv`) and its result are left unchanged, and no HTTP
 * route is registered. See `docs/kma-location-scheduled-hourly.md`.
 */

import { convertKmaLatitudeLongitudeToGrid } from '@life-weather/weather-core';

import type { KmaProviderConfigError } from '../providers/kma';
import {
  createKmaLocationScheduledHourlyForecastFacade,
  type KmaLocationScheduledHourlyForecastFacade,
} from '../services';
import {
  createKmaScheduledHourlyCompositionFromEnv,
  type KmaScheduledHourlyCompositionDependencies,
} from './kma-scheduled-hourly';

/**
 * The dependencies a caller may override for the composed location pipeline. Reused verbatim from
 * the grid-based composition ({@link KmaScheduledHourlyCompositionDependencies}) — this PR adds no
 * new dependency option. Both `fetchImpl` and `clock` are forwarded to the existing composition
 * unchanged; the PR #12 converter is a fixed production choice and is not injectable here.
 */
export type KmaLocationScheduledHourlyCompositionDependencies =
  KmaScheduledHourlyCompositionDependencies;

/**
 * The outcome of composing the location pipeline. On success it exposes **only** the live location
 * facade — never the internal scheduled facade, grid converter, provider, request factory, hourly
 * service, clock, environment, `fetchImpl`, or service key, so the internal graph stays
 * encapsulated. On a provider-configuration failure it carries the existing composition's own
 * {@link KmaProviderConfigError} **by reference**, unchanged.
 */
export type CreateKmaLocationScheduledHourlyCompositionResult =
  | {
      readonly ok: true;
      readonly facade: KmaLocationScheduledHourlyForecastFacade;
    }
  | {
      readonly ok: false;
      readonly error: KmaProviderConfigError;
    };

/**
 * Compose a live location scheduled hourly-forecast facade from the environment and optional
 * dependencies.
 *
 * Sequence:
 *
 * 1. Build the grid-based pipeline via {@link createKmaScheduledHourlyCompositionFromEnv},
 *    forwarding `env` and `dependencies` by reference (never read, cloned, spread, or mutated here).
 * 2. On a provider config failure, return `{ ok: false, error }` immediately — the **same** error
 *    reference, with no converter run, no clock read, no network, and no location-facade
 *    construction.
 * 3. Otherwise select the production PR #12 converter ({@link convertKmaLatitudeLongitudeToGrid}).
 * 4. Wire the converter and the existing scheduled facade through
 *    {@link createKmaLocationScheduledHourlyForecastFacade}.
 * 5. Return `{ ok: true, facade }`.
 *
 * Construction is side-effect-free beyond reading provider configuration (inside the existing
 * composition): it runs no converter, reads no clock, issues no network request, registers no
 * listener, starts no timer, and logs nothing. The first converter run, the first clock read, and
 * the first `fetch` happen only when the returned facade's
 * `fetchScheduledHourlyForecastForLocation()` runs. Every call builds a fresh dependency graph —
 * there is no module-level singleton or shared cache.
 */
export function createKmaLocationScheduledHourlyCompositionFromEnv(
  env?: NodeJS.ProcessEnv,
  dependencies?: KmaLocationScheduledHourlyCompositionDependencies,
): CreateKmaLocationScheduledHourlyCompositionResult {
  // Step 1: reuse the existing production graph — provider-from-env, clock selection, request
  // factory, hourly service, and scheduled facade — forwarding env/dependencies by reference.
  const scheduledComposition = createKmaScheduledHourlyCompositionFromEnv(
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

  // Steps 3–4: select the production PR #12 converter (never called here) and wire it to the
  // existing scheduled facade through the location facade.
  const facade = createKmaLocationScheduledHourlyForecastFacade(
    convertKmaLatitudeLongitudeToGrid,
    scheduledComposition.facade,
  );

  // Step 5: expose only the live location facade — the internal graph stays encapsulated.
  return {
    ok: true,
    facade,
  };
}
