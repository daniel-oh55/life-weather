/**
 * The **combined production composition root** for the cross-provider KMA + AirKorea location
 * `WeatherOverview` pipeline. It assembles two already-built production composition roots into one
 * live {@link KmaAirKoreaWeatherOverviewService}:
 *
 * ```text
 * createKmaLocationCurrentHourlyOverviewCompositionFromEnv (PR #78)         → live KMA combined service
 * createAirKoreaLocationCurrentAirQualityCompositionFromEnv (this PR, §8)   → live AirKorea service + resolver
 *
 * KMA service + AirKorea service + AirKorea source metadata resolver
 *   → createKmaAirKoreaWeatherOverviewService                              → live cross-provider service
 * ```
 *
 * This is a **combining** root, following the existing PR #78 pattern
 * (`kma-location-current-hourly-overview.ts`): it does **not** re-implement the PR #78 KMA graph or the
 * AirKorea graph above — both are built by their own existing composition functions, which this
 * function consumes verbatim, in that order. The `createKmaAirKoreaWeatherOverviewService` factory
 * owns all runtime KMA/AirKorea orchestration and the AirKorea-failure degradation policy — this layer
 * only *constructs and wires* the two upstream graphs through it.
 *
 * It is a **callable** composition function — never an import-time singleton. Importing this module
 * reads no environment, builds no provider, reads no clock, and starts no I/O; every dependency is
 * created only when {@link createKmaAirKoreaWeatherOverviewCompositionFromEnv} is *called*, and the
 * first clock read, converter run, and `fetch` happen only when the returned service's method runs.
 *
 * ## KMA is built first, deterministically
 *
 * The PR #78 KMA composition is built first, forwarding `env` and `dependencies` by the **exact same**
 * references (never read, cloned, spread, mutated, or reconstructed here). On a KMA
 * provider-configuration failure this composition returns a **fresh** `{ ok: false, stage: 'KMA',
 * error }` carrying the KMA composition's own error **by reference** — the AirKorea composition is
 * never called, and no AirKorea clock/network/service-factory work happens.
 *
 * Only after the KMA composition succeeds is the AirKorea composition built, forwarding the **same**
 * `env`/`dependencies` references. An AirKorea provider-configuration failure at this point is
 * **also** a composition failure — returned as `{ ok: false, stage: 'AIRKOREA', error }` carrying the
 * AirKorea composition's own error by reference — and the cross-provider service factory is never
 * called. A partial production graph (KMA built, AirKorea not) is never returned as a success.
 *
 * When both compositions succeed, the two exact live service references and the exact live source
 * metadata resolver reference — never wrapped, cloned, or reordered — are passed to
 * {@link createKmaAirKoreaWeatherOverviewService}, using only its three required parameters. The
 * factory's own default overlay assembler is never overridden by supplying a fourth argument here.
 *
 * ## Clock and fetch identity
 *
 * `dependencies` (when supplied) is forwarded to **both** the KMA and the AirKorea compositions by the
 * same exact reference — an injected `dependencies.fetchImpl` reaches all provider construction with
 * the same function reference, and an injected `dependencies.clock` reaches every KMA clock role *and*
 * the AirKorea source metadata resolver's clock (all structurally the same
 * `nowEpochMilliseconds(): number` port). When `dependencies.clock` is omitted, this layer builds no
 * clock of its own — each existing root keeps selecting its own independent default system clock
 * internally.
 *
 * ## Maximum runtime provider work
 *
 * This layer adds no new limit or retry policy; the following falls out of the two composed graphs
 * unmodified. A representative supported request makes: the KMA graph's **at most three** provider
 * attempts (hourly's at-most-two fallback, plus current's at-most-one) **plus** the AirKorea graph's
 * **at most three** provider attempts (TM lookup, nearby-station lookup, current-AQ lookup) — **at
 * most six** total provider calls per invocation. A KMA top-level `LOCATION` failure never reaches
 * AirKorea at all, so provider fetches stay at the KMA-only ceiling in that case.
 *
 * ## What this composition is not
 *
 * It does not register any HTTP route itself, does not wire `apps/api/src/index.ts`, does not change
 * the existing KMA or AirKorea composition roots or their consumed services, and does not add cache or
 * stale-data policy.
 */

import type { AirKoreaProviderConfigError } from '../providers/airkorea/index.js';
import type { KmaProviderConfigError } from '../providers/kma/index.js';
import {
  createKmaAirKoreaWeatherOverviewService,
  type KmaAirKoreaWeatherOverviewService,
} from '../services/index.js';
import {
  createAirKoreaLocationCurrentAirQualityCompositionFromEnv,
  type AirKoreaLocationCurrentAirQualityCompositionDependencies,
} from './airkorea-location-current-air-quality.js';
import {
  createKmaLocationCurrentHourlyOverviewCompositionFromEnv,
  type KmaLocationCurrentHourlyOverviewCompositionDependencies,
} from './kma-location-current-hourly-overview.js';

/**
 * The dependencies a caller may override for the composed cross-provider pipeline. A deliberate
 * **composition** of the KMA {@link KmaLocationCurrentHourlyOverviewCompositionDependencies} and the
 * AirKorea {@link AirKoreaLocationCurrentAirQualityCompositionDependencies} — both are already the same
 * `{ fetchImpl?, clock? }` shape, so this type re-defines no field of its own. The exact same
 * `dependencies` object reference reaches both underlying compositions.
 */
export type KmaAirKoreaWeatherOverviewCompositionDependencies =
  KmaLocationCurrentHourlyOverviewCompositionDependencies &
    AirKoreaLocationCurrentAirQualityCompositionDependencies;

/**
 * The outcome of composing the cross-provider pipeline. On success it exposes **only** the live
 * combined application service — never either underlying service, resolver, provider, clock,
 * environment, `fetchImpl`, or service key, so the internal graph stays encapsulated. On a
 * provider-configuration failure, `stage` names which composition failed (`'KMA'` or `'AIRKOREA'`) so a
 * caller can produce a distinct fail-fast message per key, and `error` carries that composition's own
 * config-error reference, unchanged.
 */
export type CreateKmaAirKoreaWeatherOverviewCompositionResult =
  | {
      readonly ok: true;
      readonly service: KmaAirKoreaWeatherOverviewService;
    }
  | {
      readonly ok: false;
      readonly stage: 'KMA';
      readonly error: KmaProviderConfigError;
    }
  | {
      readonly ok: false;
      readonly stage: 'AIRKOREA';
      readonly error: AirKoreaProviderConfigError;
    };

/**
 * Compose a live cross-provider KMA + AirKorea location overview application service from the
 * environment and optional dependencies.
 *
 * Sequence:
 *
 * 1. Build the PR #78 KMA composition via
 *    {@link createKmaLocationCurrentHourlyOverviewCompositionFromEnv}, forwarding `env` and
 *    `dependencies` by reference.
 * 2. On a KMA provider config failure, return `{ ok: false, stage: 'KMA', error }` immediately — the
 *    AirKorea composition is never called and no AirKorea clock/network/service construction happens.
 * 3. Otherwise build the AirKorea composition via
 *    {@link createAirKoreaLocationCurrentAirQualityCompositionFromEnv}, forwarding the **same** exact
 *    `env`/`dependencies` references.
 * 4. On an AirKorea provider config failure, return `{ ok: false, stage: 'AIRKOREA', error }`
 *    immediately — a partial graph (KMA built, AirKorea not) is never returned as a success.
 * 5. Otherwise wire the two exact live service references and the exact live AirKorea source metadata
 *    resolver reference through {@link createKmaAirKoreaWeatherOverviewService}, using only its three
 *    required parameters — its own default overlay assembler is never overridden here.
 * 6. Return `{ ok: true, service }`.
 *
 * Construction is side-effect-free beyond reading provider configuration (inside the two existing
 * compositions): it reads no clock, runs no converter/resolver/overlay, issues no network request,
 * registers no listener, starts no timer, and logs nothing. Every call builds a fresh dependency graph
 * — there is no module-level singleton or shared cache.
 */
export function createKmaAirKoreaWeatherOverviewCompositionFromEnv(
  env?: NodeJS.ProcessEnv,
  dependencies?: KmaAirKoreaWeatherOverviewCompositionDependencies,
): CreateKmaAirKoreaWeatherOverviewCompositionResult {
  // Step 1: build the KMA composition first, forwarding env/dependencies by reference. KMA is the
  // required application baseline, so it is composed deterministically before AirKorea.
  const kmaComposition = createKmaLocationCurrentHourlyOverviewCompositionFromEnv(
    env,
    dependencies,
  );

  // Step 2: a KMA config failure short-circuits — the AirKorea composition is never invoked, so no
  // AirKorea clock/provider/network work happens either.
  if (!kmaComposition.ok) {
    return {
      ok: false,
      stage: 'KMA',
      error: kmaComposition.error,
    };
  }

  // Step 3: build the AirKorea composition using the exact same env/dependencies references.
  const airKoreaComposition = createAirKoreaLocationCurrentAirQualityCompositionFromEnv(
    env,
    dependencies,
  );

  // Step 4: an AirKorea config failure means the production AirKorea service could never be built at
  // all — a partial graph is never returned as a success.
  if (!airKoreaComposition.ok) {
    return {
      ok: false,
      stage: 'AIRKOREA',
      error: airKoreaComposition.error,
    };
  }

  // Step 5: wire the two exact live service references and the exact live resolver reference through
  // the cross-provider service factory. Its own default overlay assembler stays untouched — no fourth
  // argument is supplied.
  const service = createKmaAirKoreaWeatherOverviewService(
    kmaComposition.service,
    airKoreaComposition.service,
    airKoreaComposition.sourceMetadataResolver,
  );

  // Step 6: expose only the live combined application service — the internal graph stays
  // encapsulated.
  return {
    ok: true,
    service,
  };
}
