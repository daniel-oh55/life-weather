/**
 * The **production composition root** for the KMA *location* current `WeatherOverview` application
 * pipeline — an eighth callable composition root that lives alongside (and never replaces) the seven
 * existing roots. It is the entry point that assembles the PR #74 application service over a live
 * production graph.
 *
 * It assembles three already-built production pieces into one live
 * {@link KmaLocationCurrentOverviewService}:
 *
 * ```text
 * createKmaLocationScheduledCurrentObservationCompositionFromEnv (PR #71)  → live location current facade
 * createKmaLiveCurrentSourceMetadataResolver (PR #73)                     → live current source metadata resolver
 *
 * location current facade + current source metadata resolver
 *   → createKmaLocationCurrentOverviewService (PR #74)                    → live location current-overview service
 * ```
 *
 * This is the current-observation counterpart of `kma-location-hourly-overview.ts` (the PR #27
 * location hourly-overview composition) — a **separate**, parallel composition, not a generalization
 * of it. It does **not** re-implement the PR #71 graph: the provider-from-env, service-key
 * validation, clock selection, request factory, current-observation service, scheduled facade, the
 * production latitude/longitude → grid converter, and the PR #70 location facade are all built by the
 * existing {@link createKmaLocationScheduledCurrentObservationCompositionFromEnv}, which this
 * function consumes verbatim. This layer only *selects* the PR #73 live resolver's clock and wires
 * the two pieces through the PR #74 service. The PR #74 service's own default assembler
 * (`assembleKmaCurrentWeatherOverview`) is never overridden or re-selected here.
 *
 * It is a **callable** composition function — never an import-time singleton. Importing this module
 * reads no environment, builds no provider, reads no clock, runs no converter/resolver/assembler, and
 * starts no I/O; every dependency is created only when
 * {@link createKmaLocationCurrentOverviewCompositionFromEnv} is *called*, and the first clock read,
 * converter run, and `fetch` happen only when the returned service's method runs. `env` and
 * `dependencies` are forwarded to the existing composition by reference (never read, cloned, spread,
 * or mutated here), and a provider-configuration failure is returned as the **same**
 * {@link KmaProviderConfigError} reference, with no overview service, no metadata resolver, and no
 * resolver clock built.
 *
 * Clock ownership: the injected clock (when a caller supplies `dependencies.clock`) is the same
 * reference the PR #71 location composition already receives (and, through it, the PR #69 request
 * factory) — so the request clock and the metadata-resolver clock are one and the same injected
 * reference, read at most twice per supported *successful* call (once when the request is built, once
 * when the resolver materializes `fetchedAt`). When `dependencies.clock` is omitted, the PR #71/#69
 * graph keeps selecting its own system clock internally and this layer builds a **fresh**
 * {@link createKmaSystemClock} adapter for the resolver — two stateless adapters that each read the
 * live system time independently for their own role; the existing composition is never modified to
 * share a default clock. A `LOCATION`/`PROVIDER`/`NORMALIZATION` failure never runs the resolver, so
 * no second clock read happens there.
 *
 * Responsibility boundary: this layer owns no KMA data rule, no transport, no normalization, no
 * issue-time / grid-projection math, no schedule-only-vs-availability policy, no provenance policy
 * (`sourceId`/`fetchedAt`/`retrievalMode` stay the PR #73 resolver's), and no `WeatherOverview`
 * assembly rule beyond selecting the resolver clock and delegating to the existing composition and
 * service. The seven existing roots and their results are left unchanged, and no HTTP route is
 * registered. See `docs/kma-location-current-overview-composition.md`.
 */

import type { KmaProviderConfigError } from '../providers/kma/index.js';
import {
  createKmaLiveCurrentSourceMetadataResolver,
  createKmaLocationCurrentOverviewService,
  type KmaLocationCurrentOverviewService,
} from '../services/index.js';
import {
  createKmaLocationScheduledCurrentObservationCompositionFromEnv,
  type KmaLocationScheduledCurrentObservationCompositionDependencies,
} from './kma-location-scheduled-current-observation.js';
import { createKmaSystemClock } from './system-clock.js';

/**
 * The dependencies a caller may override for the composed location current-overview pipeline. A
 * deliberate **alias** of the PR #71
 * {@link KmaLocationScheduledCurrentObservationCompositionDependencies} (`{ fetchImpl?, clock? }`):
 * this root shares exactly the same two production seams as the location composition it consumes, so
 * aliasing keeps the two composition inputs from drifting apart and re-defines no field. Both
 * `fetchImpl` and `clock` are forwarded to the existing composition unchanged; when `clock` is
 * supplied it is *also* the resolver's clock (the same reference), and when omitted the resolver gets
 * a fresh production system clock. The PR #74 service's default assembler is a fixed production
 * choice and is not injectable here.
 */
export type KmaLocationCurrentOverviewCompositionDependencies =
  KmaLocationScheduledCurrentObservationCompositionDependencies;

/**
 * The outcome of composing the location current-overview pipeline. On success it exposes **only**
 * the live application service — never the internal location current facade, metadata resolver, its
 * clock, the assembler, the grid facade, converter, provider, request factory, current-observation
 * service, environment, `fetchImpl`, or service key, so the internal graph stays encapsulated. On a
 * provider-configuration failure it carries the existing composition's own
 * {@link KmaProviderConfigError} **by reference**, unchanged.
 */
export type CreateKmaLocationCurrentOverviewCompositionResult =
  | {
      readonly ok: true;
      readonly service: KmaLocationCurrentOverviewService;
    }
  | {
      readonly ok: false;
      readonly error: KmaProviderConfigError;
    };

/**
 * Compose a live location current-overview application service from the environment and optional
 * dependencies.
 *
 * Sequence:
 *
 * 1. Build the location current-observation pipeline via
 *    {@link createKmaLocationScheduledCurrentObservationCompositionFromEnv}, forwarding `env` and
 *    `dependencies` by reference (never read, cloned, spread, or mutated here).
 * 2. On a provider config failure, return `{ ok: false, error }` immediately — the **same** error
 *    reference, with no resolver clock read, no metadata resolver, no overview service, and no
 *    network.
 * 3. Otherwise select the metadata resolver's clock: the injected `clock` reference when supplied
 *    (the same reference the existing composition already received), else a fresh
 *    {@link createKmaSystemClock} adapter dedicated to the resolver — the existing composition's
 *    internal clock is never touched or shared.
 * 4. Build the PR #73 live current source metadata resolver from that clock and wire it, together
 *    with the location current-observation facade, through the PR #74
 *    {@link createKmaLocationCurrentOverviewService}. The service's default assembler is used —
 *    never passed in here.
 * 5. Return `{ ok: true, service }`.
 *
 * Construction is side-effect-free beyond reading provider configuration (inside the existing
 * composition): it reads no clock, runs no converter/resolver/assembler, issues no network request,
 * registers no listener, starts no timer, and logs nothing. The first clock read, the first converter
 * run, and the first `fetch` happen only when the returned service's
 * `fetchCurrentWeatherOverviewForLocation()` runs. Every call builds a fresh dependency graph — there
 * is no module-level singleton or shared cache.
 */
export function createKmaLocationCurrentOverviewCompositionFromEnv(
  env?: NodeJS.ProcessEnv,
  dependencies?: KmaLocationCurrentOverviewCompositionDependencies,
): CreateKmaLocationCurrentOverviewCompositionResult {
  // Step 1: reuse the existing PR #71 location composition — provider-from-env, clock selection,
  // request factory, current-observation service, scheduled facade, production converter, and PR #70
  // location facade — forwarding env/dependencies by reference.
  const locationComposition = createKmaLocationScheduledCurrentObservationCompositionFromEnv(
    env,
    dependencies,
  );

  // Step 2: a configuration failure is returned as a value, with the existing composition's own
  // error reference passed through unchanged — no resolver clock read, no resolver/service
  // construction, no network.
  if (!locationComposition.ok) {
    return {
      ok: false,
      error: locationComposition.error,
    };
  }

  // Step 3: select the metadata resolver's clock. When a caller injected `dependencies.clock`, the
  // same reference already reached the existing composition, so the request clock and the resolver
  // clock are the one injected reference (no wrapper/clone/adapter). When omitted, the existing
  // composition keeps its own internal system clock (its encapsulation is not broken) and the
  // resolver gets a fresh, independent stateless system clock adapter for its own role. Neither is
  // called here.
  const sourceMetadataClock = dependencies?.clock ?? createKmaSystemClock();

  // Step 4: build the PR #73 live current source metadata resolver (never called here) and wire it,
  // with the PR #71/#70 location current facade, through the PR #74 application service. The
  // service's default assembler stays its fixed production default — not passed in.
  const sourceMetadataResolver =
    createKmaLiveCurrentSourceMetadataResolver(sourceMetadataClock);
  const service = createKmaLocationCurrentOverviewService(
    locationComposition.facade,
    sourceMetadataResolver,
  );

  // Step 5: expose only the live application service — the internal graph stays encapsulated.
  return {
    ok: true,
    service,
  };
}
