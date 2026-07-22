/**
 * The **production composition root** for the KMA *location* hourly-forecast **fallback** pipeline —
 * a fourth callable composition root that lives alongside (and never replaces) the three existing
 * roots: the two single-request roots ({@link createKmaScheduledHourlyCompositionFromEnv} and its
 * location sibling) and the PR #20 grid {@link createKmaHourlyFallbackCompositionFromEnv}. It is the
 * latitude/longitude entry point that sits in front of the PR #20 grid fallback service.
 *
 * It assembles the PR #21 location fallback facade over two production dependencies:
 *
 * ```text
 * createKmaHourlyFallbackCompositionFromEnv (PR #20)  → live grid fallback service
 * convertKmaLatitudeLongitudeToGrid         (PR #12)  → production forward converter
 *
 * converter + grid fallback service
 *   → createKmaLocationHourlyFallbackFacade (PR #21)  → live location fallback facade
 * ```
 *
 * It does **not** re-implement the fallback graph: the provider-from-env, service-key validation,
 * clock selection, request-plan factory (with the PR #16 candidate selector), hourly service,
 * PR #17 classifier, and PR #19 fallback orchestration are all built by the existing
 * {@link createKmaHourlyFallbackCompositionFromEnv}, which this function consumes verbatim. This
 * layer only *selects* the production PR #12 converter (imported from the `@life-weather/weather-core`
 * public package surface, never by a private deep import) and wires it to the existing grid fallback
 * service through the location facade.
 *
 * It is a **callable** composition function — never an import-time singleton. Importing this module
 * reads no environment, builds no provider, reads no clock, runs no converter, and starts no I/O;
 * every dependency is created only when {@link createKmaLocationHourlyFallbackCompositionFromEnv} is
 * *called*, and the first converter run, clock read, and `fetch` happen only when the returned
 * facade's method runs. `env` and `dependencies` are forwarded to the existing composition by
 * reference (never read, cloned, spread, or mutated here), and a provider-configuration failure is
 * returned as the **same** {@link KmaProviderConfigError} reference, with no converter run, no clock
 * read, no network, and no location-facade construction.
 *
 * Responsibility boundary: this layer owns no KMA data rule, no transport, no normalization, no
 * issue-time / candidate math, no eligibility rule, no request-assembly rule, no projection math, and
 * no facade-wiring rule beyond selecting the converter and delegating to the existing composition.
 * The grid fallback composition (`createKmaHourlyFallbackCompositionFromEnv`) and its result, plus
 * both single-request roots, are left unchanged; supported locations still make **at most two**
 * provider calls per invocation and unsupported locations make none, and no HTTP route is registered.
 * See `docs/kma-location-hourly-fallback.md`.
 */

import { convertKmaLatitudeLongitudeToGrid } from '@life-weather/weather-core';

import type { KmaProviderConfigError } from '../providers/kma';
import {
  createKmaLocationHourlyFallbackFacade,
  type KmaLocationHourlyFallbackFacade,
} from '../services';
import {
  createKmaHourlyFallbackCompositionFromEnv,
  type KmaHourlyFallbackCompositionDependencies,
} from './kma-hourly-fallback';

/**
 * The dependencies a caller may override for the composed location fallback pipeline. A deliberate
 * **alias** of the PR #20 {@link KmaHourlyFallbackCompositionDependencies} (`{ fetchImpl?, clock? }`):
 * the location fallback root shares exactly the same two production seams as the grid fallback root,
 * so aliasing keeps the two composition inputs from drifting apart and re-defines no field. Both
 * `fetchImpl` and `clock` are forwarded to the existing composition unchanged; the PR #12 converter
 * is a fixed production choice and is not injectable here.
 */
export type KmaLocationHourlyFallbackCompositionDependencies =
  KmaHourlyFallbackCompositionDependencies;

/**
 * The outcome of composing the location fallback pipeline. On success it exposes **only** the live
 * location fallback facade — never the internal grid fallback service, grid converter, provider,
 * request-plan factory, hourly service, classifier, selector, clock, environment, `fetchImpl`, or
 * service key, so the internal graph stays encapsulated. On a provider-configuration failure it
 * carries the existing composition's own {@link KmaProviderConfigError} **by reference**, unchanged.
 */
export type CreateKmaLocationHourlyFallbackCompositionResult =
  | {
      readonly ok: true;
      readonly facade: KmaLocationHourlyFallbackFacade;
    }
  | {
      readonly ok: false;
      readonly error: KmaProviderConfigError;
    };

/**
 * Compose a live location hourly-forecast fallback facade from the environment and optional
 * dependencies.
 *
 * Sequence:
 *
 * 1. Build the grid fallback pipeline via {@link createKmaHourlyFallbackCompositionFromEnv},
 *    forwarding `env` and `dependencies` by reference (never read, cloned, spread, or mutated here).
 * 2. On a provider config failure, return `{ ok: false, error }` immediately — the **same** error
 *    reference, with no converter run, no clock read, no network, and no location-facade
 *    construction.
 * 3. Otherwise select the production PR #12 converter ({@link convertKmaLatitudeLongitudeToGrid}).
 * 4. Wire the converter and the existing grid fallback service through
 *    {@link createKmaLocationHourlyFallbackFacade}.
 * 5. Return `{ ok: true, facade }`.
 *
 * Construction is side-effect-free beyond reading provider configuration (inside the existing
 * composition): it runs no converter, reads no clock, issues no network request, registers no
 * listener, starts no timer, and logs nothing. The first converter run, the first clock read, and
 * the first `fetch` happen only when the returned facade's
 * `fetchHourlyForecastWithFallbackForLocation()` runs. Every call builds a fresh dependency graph —
 * there is no module-level singleton or shared cache.
 */
export function createKmaLocationHourlyFallbackCompositionFromEnv(
  env?: NodeJS.ProcessEnv,
  dependencies?: KmaLocationHourlyFallbackCompositionDependencies,
): CreateKmaLocationHourlyFallbackCompositionResult {
  // Step 1: reuse the existing PR #20 grid fallback graph — provider-from-env, clock selection,
  // request-plan factory (with the PR #16 candidate selector), hourly service, PR #17 classifier, and
  // PR #19 fallback orchestration — forwarding env/dependencies by reference.
  const fallbackComposition = createKmaHourlyFallbackCompositionFromEnv(
    env,
    dependencies,
  );

  // Step 2: a configuration failure is returned as a value, with the existing composition's own
  // error reference passed through unchanged — no converter run, no clock read, no network.
  if (!fallbackComposition.ok) {
    return {
      ok: false,
      error: fallbackComposition.error,
    };
  }

  // Steps 3–4: select the production PR #12 converter (never called here) and wire it to the
  // existing grid fallback service through the location facade.
  const facade = createKmaLocationHourlyFallbackFacade(
    convertKmaLatitudeLongitudeToGrid,
    fallbackComposition.service,
  );

  // Step 5: expose only the live location fallback facade — the internal graph stays encapsulated.
  return {
    ok: true,
    facade,
  };
}
