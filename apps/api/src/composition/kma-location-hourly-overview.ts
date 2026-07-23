/**
 * The **production composition root** for the KMA *location* hourly `WeatherOverview` application
 * pipeline — a fifth callable composition root that lives alongside (and never replaces) the four
 * existing roots: the two single-request roots ({@link createKmaScheduledHourlyCompositionFromEnv}
 * and its location sibling), the PR #20 grid {@link createKmaHourlyFallbackCompositionFromEnv}, and
 * the PR #21 location {@link createKmaLocationHourlyFallbackCompositionFromEnv}. It is the entry
 * point that assembles the PR #24 application service over a live production graph.
 *
 * It assembles three already-built production pieces into one live
 * {@link KmaLocationHourlyOverviewService}:
 *
 * ```text
 * createKmaLocationHourlyFallbackCompositionFromEnv (PR #21)  → live location fallback facade
 * createKmaLiveSelectedHourlySourceMetadataResolver (PR #26)  → live selected-source metadata resolver
 *
 * location fallback facade + selected-source metadata resolver
 *   → createKmaLocationHourlyOverviewService (PR #24)         → live location hourly-overview service
 * ```
 *
 * It does **not** re-implement the fallback graph, the selection policy, or the assembler: the
 * provider-from-env, service-key validation, clock selection, request-plan factory (with the PR #16
 * candidate selector), hourly service, PR #17 classifier, PR #19 fallback orchestration, PR #12
 * converter, and PR #21 location facade are all built by the existing
 * {@link createKmaLocationHourlyFallbackCompositionFromEnv}, which this function consumes verbatim;
 * the PR #22 {@link selectKmaHourlyFallbackResult} selector and the PR #23
 * {@link assembleKmaHourlyWeatherOverview} assembler stay the PR #24 service's own defaults (never
 * passed in here). This layer only *selects* the PR #26 live metadata resolver's clock and wires the
 * three pieces through the PR #24 service.
 *
 * It is a **callable** composition function — never an import-time singleton. Importing this module
 * reads no environment, builds no provider, reads no clock, runs no converter/selector/resolver/
 * assembler, and starts no I/O; every dependency is created only when
 * {@link createKmaLocationHourlyOverviewCompositionFromEnv} is *called*, and the first clock read,
 * converter run, and `fetch` happen only when the returned service's method runs. `env` and
 * `dependencies` are forwarded to the existing composition by reference (never read, cloned, spread,
 * or mutated here), and a provider-configuration failure is returned as the **same**
 * {@link KmaProviderConfigError} reference, with no overview service, no metadata resolver, and no
 * resolver clock built.
 *
 * Clock ownership: the injected clock (when a caller supplies `dependencies.clock`) is the same
 * reference the PR #21 fallback composition already receives — so the request-plan clock and the
 * metadata-resolver clock are one and the same injected reference, read at most twice per supported
 * *selected* call (once when the request plan is built, once when the resolver materializes
 * `fetchedAt`). When `dependencies.clock` is omitted, the fallback root keeps selecting its own
 * system clock internally and this layer builds a **fresh** {@link createKmaSystemClock} adapter for
 * the resolver — two stateless adapters that each read the live system time independently for their
 * own role; the existing fallback composition is never modified to share a default clock. A
 * no-selection or `LOCATION` result never runs the resolver, so no second clock read happens there.
 *
 * Responsibility boundary: this layer owns no KMA data rule, no transport, no normalization, no
 * issue-time / candidate / selection math, no eligibility rule, no request-assembly rule, no
 * projection math, no provenance policy (`issuedAt`/`sourceId`/`fetchedAt`/`retrievalMode` stay the
 * PR #26 resolver's), and no `WeatherOverview` assembly rule beyond selecting the resolver clock and
 * delegating to the existing composition and service. The four existing roots and their results are
 * left unchanged; supported *selected* locations still make **at most two** provider calls per
 * invocation and unsupported locations make none, and no HTTP route is registered. The PR #24
 * internal application result (`{ ok, selection, overview }`) is exposed as-is — a future
 * mobile-facing `/weather` route must map only the `overview`, never serialize the `selection`/
 * execution trace directly. See `docs/kma-location-hourly-overview-composition.md`.
 */

import type { KmaProviderConfigError } from '../providers/kma';
import {
  createKmaLiveSelectedHourlySourceMetadataResolver,
  createKmaLocationHourlyOverviewService,
  type KmaLocationHourlyOverviewService,
} from '../services';
import {
  createKmaLocationHourlyFallbackCompositionFromEnv,
  type KmaLocationHourlyFallbackCompositionDependencies,
} from './kma-location-hourly-fallback';
import { createKmaSystemClock } from './system-clock';

/**
 * The dependencies a caller may override for the composed location hourly-overview pipeline. A
 * deliberate **alias** of the PR #21 {@link KmaLocationHourlyFallbackCompositionDependencies}
 * (`{ fetchImpl?, clock? }`): this root shares exactly the same two production seams as the location
 * fallback root it consumes, so aliasing keeps the two composition inputs from drifting apart and
 * re-defines no field. Both `fetchImpl` and `clock` are forwarded to the existing composition
 * unchanged; when `clock` is supplied it is *also* the resolver's clock (the same reference), and
 * when omitted the resolver gets a fresh production system clock. The PR #22 selector and PR #23
 * assembler are fixed production choices inside the PR #24 service and are not injectable here.
 */
export type KmaLocationHourlyOverviewCompositionDependencies =
  KmaLocationHourlyFallbackCompositionDependencies;

/**
 * The outcome of composing the location hourly-overview pipeline. On success it exposes **only** the
 * live application service — never the internal location fallback facade, metadata resolver, its
 * clock, the selector, the assembler, the grid fallback service, converter, provider, request-plan
 * factory, hourly service, classifier, environment, `fetchImpl`, or service key, so the internal
 * graph stays encapsulated. On a provider-configuration failure it carries the existing composition's
 * own {@link KmaProviderConfigError} **by reference**, unchanged.
 */
export type CreateKmaLocationHourlyOverviewCompositionResult =
  | {
      readonly ok: true;
      readonly service: KmaLocationHourlyOverviewService;
    }
  | {
      readonly ok: false;
      readonly error: KmaProviderConfigError;
    };

/**
 * Compose a live location hourly-overview application service from the environment and optional
 * dependencies.
 *
 * Sequence:
 *
 * 1. Build the location fallback pipeline via
 *    {@link createKmaLocationHourlyFallbackCompositionFromEnv}, forwarding `env` and `dependencies`
 *    by reference (never read, cloned, spread, or mutated here).
 * 2. On a provider config failure, return `{ ok: false, error }` immediately — the **same** error
 *    reference, with no resolver clock read, no metadata resolver, no overview service, and no
 *    network.
 * 3. Otherwise select the metadata resolver's clock: the injected `clock` reference when supplied
 *    (the same reference the fallback root already received), else a fresh
 *    {@link createKmaSystemClock} adapter dedicated to the resolver — the existing fallback root's
 *    internal clock is never touched or shared.
 * 4. Build the PR #26 live selected-source metadata resolver from that clock and wire it, together
 *    with the location fallback facade, through the PR #24
 *    {@link createKmaLocationHourlyOverviewService}. The PR #22 selector and PR #23 assembler are the
 *    service's own defaults — never passed in here.
 * 5. Return `{ ok: true, service }`.
 *
 * Construction is side-effect-free beyond reading provider configuration (inside the existing
 * composition): it reads no clock, runs no converter/selector/resolver/assembler, issues no network
 * request, registers no listener, starts no timer, and logs nothing. The first clock read, the first
 * converter run, and the first `fetch` happen only when the returned service's
 * `fetchHourlyWeatherOverviewForLocation()` runs. Every call builds a fresh dependency graph — there
 * is no module-level singleton or shared cache.
 */
export function createKmaLocationHourlyOverviewCompositionFromEnv(
  env?: NodeJS.ProcessEnv,
  dependencies?: KmaLocationHourlyOverviewCompositionDependencies,
): CreateKmaLocationHourlyOverviewCompositionResult {
  // Step 1: reuse the existing PR #21 location fallback graph — provider-from-env, clock selection,
  // request-plan factory (with the PR #16 candidate selector), hourly service, PR #17 classifier,
  // PR #19 fallback orchestration, the PR #12 converter, and the PR #21 location facade — forwarding
  // env/dependencies by reference.
  const fallbackComposition = createKmaLocationHourlyFallbackCompositionFromEnv(
    env,
    dependencies,
  );

  // Step 2: a configuration failure is returned as a value, with the existing composition's own
  // error reference passed through unchanged — no resolver clock read, no resolver/service
  // construction, no network.
  if (!fallbackComposition.ok) {
    return {
      ok: false,
      error: fallbackComposition.error,
    };
  }

  // Step 3: select the metadata resolver's clock. When a caller injected `dependencies.clock`, the
  // same reference already reached the fallback root, so the request-plan clock and the resolver
  // clock are the one injected reference (no wrapper/clone/adapter). When omitted, the fallback root
  // keeps its own internal system clock (its encapsulation is not broken) and the resolver gets a
  // fresh, independent stateless system clock adapter for its own role. Neither is called here.
  const sourceMetadataClock = dependencies?.clock ?? createKmaSystemClock();

  // Step 4: build the PR #26 live selected-source metadata resolver (never called here) and wire it,
  // with the PR #21 location fallback facade, through the PR #24 application service. The PR #22
  // selector and PR #23 assembler stay the service's fixed production defaults — not passed in.
  const sourceMetadataResolver =
    createKmaLiveSelectedHourlySourceMetadataResolver(sourceMetadataClock);
  const service = createKmaLocationHourlyOverviewService(
    fallbackComposition.facade,
    sourceMetadataResolver,
  );

  // Step 5: expose only the live application service — the internal graph stays encapsulated.
  return {
    ok: true,
    service,
  };
}
