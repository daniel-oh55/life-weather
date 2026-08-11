/**
 * The **production composition root** for the KMA *location* current + hourly `WeatherOverview`
 * application pipeline — a ninth callable composition root that lives alongside (and never replaces)
 * the eight existing roots. It is the entry point that assembles the PR #77 combined application
 * service over two already-live production graphs.
 *
 * It assembles two already-built production composition roots into one live
 * {@link KmaLocationCurrentHourlyOverviewService}:
 *
 * ```text
 * createKmaLocationHourlyOverviewCompositionFromEnv (PR #27)   → live hourly overview service
 * createKmaLocationCurrentOverviewCompositionFromEnv (PR #75)  → live current overview service
 *
 * hourly service + current service
 *   → createKmaLocationCurrentHourlyOverviewService (PR #77)   → live combined application service
 * ```
 *
 * This is a **combining** root, not a third parallel graph: it does **not** re-implement the PR #27
 * hourly graph (provider-from-env, clock selection, request-plan factory, hourly fallback service, PR
 * #26 selected-source metadata resolver) or the PR #75 current graph (provider-from-env, clock
 * selection, request factory, current-observation service, PR #73 current source metadata resolver).
 * Both are built by their own existing composition functions, which this function consumes verbatim,
 * in that order. The PR #77 service factory owns all runtime hourly/current orchestration and the
 * current-failure degradation policy — this layer only *constructs and wires* the two upstream
 * services through it, never inspecting or reimplementing that policy.
 *
 * It is a **callable** composition function — never an import-time singleton. Importing this module
 * reads no environment, builds no provider, reads no clock, runs no converter/selector/resolver/
 * assembler/application-service execution, and starts no I/O; every dependency is created only when
 * {@link createKmaLocationCurrentHourlyOverviewCompositionFromEnv} is *called*, and the first clock
 * read, converter run, and `fetch` happen only when the returned service's method runs.
 *
 * ## Hourly is built first, deterministically
 *
 * The PR #27 hourly composition is built first, forwarding `env` and `dependencies` by the **exact
 * same references** (never read, cloned, spread, mutated, or reconstructed here). On a hourly
 * provider-configuration failure this composition returns a **fresh** `{ ok: false, error }` carrying
 * the hourly composition's own {@link KmaProviderConfigError} **by reference** — the PR #75 current
 * composition is never called, and no clock/network/service-factory work happens.
 *
 * Only after the hourly composition succeeds is the PR #75 current composition built, forwarding the
 * **same** `env`/`dependencies` references (never a second, cloned, or partial dependencies object).
 * A current provider-configuration failure at this point is **also** a composition failure — it is
 * returned as a fresh `{ ok: false, error }` carrying the current composition's own
 * {@link KmaProviderConfigError} by reference, and the PR #77 service factory is never called. This is
 * distinct from PR #77's own runtime degradation policy: PR #77 degrades a *resolved* current
 * `ok: false` **application result** (`LOCATION`/`PROVIDER`/`NORMALIZATION`) to `current: null` once
 * both live services already exist, but a current *composition* failure means the production current
 * service could never be constructed at all — there is no live service to degrade with, so this stays
 * a composition-level failure rather than a runtime section-level one.
 *
 * When both compositions succeed, the two exact live service references — never wrapped, cloned, or
 * reordered — are passed to the PR #77
 * {@link createKmaLocationCurrentHourlyOverviewService}(hourlyService, currentService) factory, using
 * only its two required parameters. The PR #77 factory's own default assembler
 * (`assembleKmaCurrentHourlyWeatherOverview`, the real PR #76 assembler) is never overridden by
 * supplying a third argument here.
 *
 * ## Clock and fetch identity
 *
 * `dependencies` (when supplied) is forwarded to **both** the PR #27 and PR #75 compositions by the
 * same exact reference. Consequently:
 *
 * - An injected `dependencies.fetchImpl` reaches both the hourly and the current provider
 *   construction with the same function reference — this layer builds no shared provider itself; the
 *   two existing roots still construct their own separate provider instances, each configured from
 *   the same injected `fetchImpl`.
 * - An injected `dependencies.clock` reaches the hourly graph's request-plan clock, the hourly
 *   PR #26 metadata-resolver clock, the current graph's request clock, and the current PR #73
 *   metadata-resolver clock — all four roles share the one injected reference (never wrapped, cloned,
 *   adapted, multiplexed, or snapshotted, and never read here at composition time).
 * - When `dependencies.clock` is omitted, this layer builds **no** clock of its own and imports no
 *   system-clock factory — each existing root keeps selecting its own independent default system
 *   clock internally, exactly as it already does standalone. Their encapsulation is preserved.
 *
 * ## No policy reimplementation
 *
 * This composition inspects none of the hourly result, hourly selection, current result, current
 * failure stage, `missingSections`, `sources`, or `WeatherOverview` — it only constructs the two
 * upstream services and wires them through the PR #77 factory. Runtime hourly/current orchestration
 * and degradation remain entirely PR #77's responsibility.
 *
 * ## Current availability — inherited from PR #69, no claim added
 *
 * As of PR #80, the current branch inherited through the PR #75 composition (→ PR #71 → PR #69) uses
 * the PR #79 **availability-delay** current-observation base-time selector — the PR #69 composition
 * now injects it explicitly instead of the request factory's PR #64 schedule-only default. This root
 * itself does not import or select that policy; it only inherits whatever PR #69 already wires. It
 * still adds no readiness retry and does not fall back to a previous current issuance. The inherited
 * selector makes **no claim** that the selected current issuance has already been published upstream
 * by KMA, that a request at this instant succeeds, or that upstream replication has completed — it
 * only expresses a deterministic project threshold, not an official SLA.
 *
 * ## Maximum runtime provider work
 *
 * This layer adds no new limit or retry policy; the following falls out of the two composed graphs
 * unmodified. A representative supported request makes: the hourly PR #19 fallback graph's **at most
 * two** provider attempts (a PRIMARY attempt and, only when the classifier reports a no-data signal, a
 * single PREVIOUS attempt) **plus** the current graph's **at most one** provider attempt — **at most
 * three** total provider calls per invocation. An unsupported location through the hourly location
 * boundary never reaches the current graph at all (PR #77's baseline-first ordering), so provider
 * fetches stay at zero.
 *
 * ## What this composition is not
 *
 * It does not register any HTTP route, does not wire `apps/api/src/index.ts` or
 * `apps/api/src/api-app.ts`, does not change the existing hourly/current composition roots or the
 * PR #77 service, and does not add a current availability-delay selector, cache, or stale-data policy.
 * `POST /weather` still returns hourly-only production data with `current` missing after this PR. See
 * `docs/kma-location-current-hourly-overview-composition.md`.
 */

import type { KmaProviderConfigError } from '../providers/kma/index.js';
import { createKmaLocationCurrentHourlyOverviewService } from '../services/index.js';
import type { KmaLocationCurrentHourlyOverviewService } from '../services/index.js';
import {
  createKmaLocationCurrentOverviewCompositionFromEnv,
  type KmaLocationCurrentOverviewCompositionDependencies,
} from './kma-location-current-overview.js';
import {
  createKmaLocationHourlyOverviewCompositionFromEnv,
  type KmaLocationHourlyOverviewCompositionDependencies,
} from './kma-location-hourly-overview.js';

/**
 * The dependencies a caller may override for the composed combined pipeline. A deliberate
 * **composition** of the PR #27 {@link KmaLocationHourlyOverviewCompositionDependencies} and the
 * PR #75 {@link KmaLocationCurrentOverviewCompositionDependencies} — both are already the same
 * `{ fetchImpl?, clock? }` shape, so this type re-defines no field of its own. The exact same
 * `dependencies` object reference reaches both underlying compositions; see the module doc's "Clock
 * and fetch identity" section.
 */
export type KmaLocationCurrentHourlyOverviewCompositionDependencies =
  KmaLocationHourlyOverviewCompositionDependencies &
    KmaLocationCurrentOverviewCompositionDependencies;

/**
 * The outcome of composing the combined current+hourly pipeline. On success it exposes **only** the
 * live combined application service — never the hourly service, the current service, either
 * underlying composition result, the provider, facade, resolver, clock, environment, `fetchImpl`,
 * service key, converter, request factory, or assembler, so the internal graph stays encapsulated. On
 * a provider-configuration failure (from either the hourly or the current composition) it carries that
 * composition's own {@link KmaProviderConfigError} **by reference**, unchanged.
 */
export type CreateKmaLocationCurrentHourlyOverviewCompositionResult =
  | {
      readonly ok: true;
      readonly service: KmaLocationCurrentHourlyOverviewService;
    }
  | {
      readonly ok: false;
      readonly error: KmaProviderConfigError;
    };

/**
 * Compose a live location current+hourly overview application service from the environment and
 * optional dependencies.
 *
 * Sequence:
 *
 * 1. Build the PR #27 hourly composition via
 *    {@link createKmaLocationHourlyOverviewCompositionFromEnv}, forwarding `env` and `dependencies` by
 *    reference (never read, cloned, spread, or mutated here).
 * 2. On a hourly provider config failure, return `{ ok: false, error }` immediately — the **same**
 *    error reference, with the PR #75 current composition never called and no service construction.
 * 3. Otherwise build the PR #75 current composition via
 *    {@link createKmaLocationCurrentOverviewCompositionFromEnv}, forwarding the **same** exact
 *    `env`/`dependencies` references.
 * 4. On a current provider config failure, return `{ ok: false, error }` immediately — the **same**
 *    error reference. This is a composition failure, not a degradable runtime result: the PR #77
 *    service factory is never called.
 * 5. Otherwise wire the two exact live service references through the PR #77
 *    {@link createKmaLocationCurrentHourlyOverviewService}, using only its two required parameters —
 *    its own default assembler is never overridden here.
 * 6. Return `{ ok: true, service }`.
 *
 * Construction is side-effect-free beyond reading provider configuration (inside the two existing
 * compositions): it reads no clock, runs no converter/selector/resolver/assembler, issues no network
 * request, registers no listener, starts no timer, and logs nothing. The first clock read, the first
 * converter run, and the first `fetch` happen only when the returned service's
 * `fetchCurrentHourlyWeatherOverviewForLocation()` runs. Every call builds a fresh dependency graph —
 * there is no module-level singleton or shared cache.
 */
export function createKmaLocationCurrentHourlyOverviewCompositionFromEnv(
  env?: NodeJS.ProcessEnv,
  dependencies?: KmaLocationCurrentHourlyOverviewCompositionDependencies,
): CreateKmaLocationCurrentHourlyOverviewCompositionResult {
  // Step 1: build the PR #27 hourly composition first, forwarding env/dependencies by reference.
  // Hourly is the required application baseline, so it is composed deterministically before current.
  const hourlyComposition = createKmaLocationHourlyOverviewCompositionFromEnv(env, dependencies);

  // Step 2: a hourly config failure short-circuits — the PR #75 current composition is never invoked,
  // so no current clock/provider/network work happens either.
  if (!hourlyComposition.ok) {
    return {
      ok: false,
      error: hourlyComposition.error,
    };
  }

  // Step 3: build the PR #75 current composition using the exact same env/dependencies references —
  // never a second, cloned, or partial dependencies object.
  const currentComposition = createKmaLocationCurrentOverviewCompositionFromEnv(
    env,
    dependencies,
  );

  // Step 4: a current config failure means the production current service could never be built at
  // all — this stays a composition failure (not a degradable runtime current:null), so the PR #77
  // service factory is never called.
  if (!currentComposition.ok) {
    return {
      ok: false,
      error: currentComposition.error,
    };
  }

  // Step 5: wire the two exact live service references through the PR #77 factory. Its own default
  // assembler (the real PR #76 assembler) stays untouched — no third argument is supplied.
  const service = createKmaLocationCurrentHourlyOverviewService(
    hourlyComposition.service,
    currentComposition.service,
  );

  // Step 6: expose only the live combined application service — the internal graph stays
  // encapsulated.
  return {
    ok: true,
    service,
  };
}
