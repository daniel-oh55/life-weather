/**
 * The **production composition root** for the KMA hourly-forecast **fallback** pipeline — a third
 * callable composition root that lives alongside (and never replaces) the two existing single-request
 * roots ({@link createKmaScheduledHourlyCompositionFromEnv} and its location sibling).
 *
 * This is the explicit, server-side wiring point that assembles the components built by PR #16–#19
 * into one live {@link KmaHourlyFallbackService}:
 *
 * ```text
 * environment
 *   → createKmaForecastProviderFromEnv (PR #5)        → KmaForecastProvider
 *   → createKmaHourlyForecastService  (PR #7)         → KmaHourlyForecastService
 *
 * system clock adapter / injected clock
 *   + selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay (PR #16)   // production selector choice
 *   → createKmaFallbackRequestPlanFactory (PR #18)    → KmaFallbackRequestPlanFactory
 *
 * request-plan factory + hourly service + classifyKmaHourlyFallbackEligibility (PR #17)
 *   → createKmaHourlyFallbackService (PR #19)         → live KmaHourlyFallbackService
 * ```
 *
 * It is a **callable** composition function — never an import-time singleton. Importing this module
 * reads no environment, builds no provider, reads no clock, and starts no I/O; every dependency is
 * created only when {@link createKmaHourlyFallbackCompositionFromEnv} is *called*. This keeps test and
 * `/health` imports free of any KMA configuration dependency and defers all startup / error policy to
 * an explicit caller (a later route / startup PR).
 *
 * Responsibility boundary: this layer only *selects* the two production policy collaborators — the
 * PR #16 {@link selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay} candidate selector
 * (availability-aware primary + one-step-back previous) and the PR #17
 * {@link classifyKmaHourlyFallbackEligibility} classifier (exact upstream `'03'` / empty-hourly →
 * eligible) — and *sequences* the existing public factories. It re-implements **no** eligibility
 * rule, **no** base-time / availability math, and **no** provider logic; it reads and validates no
 * service key of its own (the provider factory owns that), builds no URL, calls no `fetch`, reads no
 * clock, and adds no retry / third attempt / logging. It consumes only the `../providers/kma`,
 * `../services`, and `@life-weather/weather-core` (the PR #16 selector) public surfaces, plus the
 * concrete {@link createKmaSystemClock} adapter and (type-only) the existing scheduled composition's
 * dependency shape.
 *
 * Why a parallel root rather than a change to the existing composition: the existing scheduled/location
 * roots expose a `KmaScheduledHourlyForecastFacade` with a `{ ok, facade }` result and at most one
 * provider call per invocation. The PR #19 fallback service has a different public method and result
 * union (a primary + optional previous execution trace, up to two provider calls). Adding a separate
 * root preserves both existing public contracts and their at-most-one-call production behaviour
 * untouched. A location → grid fallback facade in front of this service is a later PR (PR #21). See
 * `docs/kma-hourly-fallback-composition.md`.
 */

import { selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay } from '@life-weather/weather-core';

import {
  createKmaForecastProviderFromEnv,
  type KmaProviderConfigError,
} from '../providers/kma';
import {
  classifyKmaHourlyFallbackEligibility,
  createKmaFallbackRequestPlanFactory,
  createKmaHourlyForecastService,
  createKmaHourlyFallbackService,
  type KmaHourlyFallbackService,
} from '../services';
import type { KmaScheduledHourlyCompositionDependencies } from './kma-scheduled-hourly';
import { createKmaSystemClock } from './system-clock';

/**
 * The dependencies a caller may override for the composed fallback pipeline. A deliberate **alias**
 * of the existing {@link KmaScheduledHourlyCompositionDependencies} (`{ fetchImpl?, clock? }`): the
 * fallback root shares exactly the same two production seams as the scheduled root, so aliasing keeps
 * the two composition inputs from drifting apart and re-defines no field.
 *
 * - `fetchImpl` — an injectable `fetch` forwarded to the provider factory (for tests / a custom
 *   transport). When omitted, the provider factory uses `globalThis.fetch`. Provider timeout and
 *   response-size policy are intentionally **not** exposed here — the provider's own defaults stand.
 * - `clock` — an injectable `KmaForecastRequestClock` handed straight to the request-plan factory.
 *   When omitted, the production system clock is used. The clock is never called, cloned, or
 *   validated at composition time — only wired.
 *
 * No selector / classifier / timeout / retry / fallback / feature-flag / safety-margin override is
 * added: the PR #16 candidate selector and the PR #17 classifier are fixed production choices,
 * injected in the composition body rather than exposed as options.
 */
export type KmaHourlyFallbackCompositionDependencies =
  KmaScheduledHourlyCompositionDependencies;

/**
 * The outcome of composing the fallback pipeline. On success it exposes **only** the live service —
 * never the provider, request-plan factory, hourly service, classifier, selector, clock, environment,
 * `fetchImpl`, service key, or a URL, so the internal graph (and the service key bound inside the
 * provider) stays encapsulated. On a provider-configuration failure it carries the provider factory's
 * own {@link KmaProviderConfigError} **by reference**, unchanged.
 */
export type CreateKmaHourlyFallbackCompositionResult =
  | {
      readonly ok: true;
      readonly service: KmaHourlyFallbackService;
    }
  | {
      readonly ok: false;
      readonly error: KmaProviderConfigError;
    };

/**
 * Compose a live KMA hourly-forecast fallback service from the environment and optional dependencies.
 *
 * Sequence:
 *
 * 1. Build the provider via {@link createKmaForecastProviderFromEnv}, forwarding `env` by reference
 *    (never read, cloned, or spread here) and the injected `fetchImpl` when supplied.
 * 2. On a provider config failure, return `{ ok: false, error }` immediately — the **same** error
 *    reference, with no clock read, no collaborator construction, and no `fetch`.
 * 3. Otherwise pick the clock: the injected `clock` reference when supplied, else a fresh
 *    {@link createKmaSystemClock} adapter.
 * 4. Build the PR #18 request-plan factory from that clock and the PR #16
 *    {@link selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay} candidate selector (the fixed
 *    production base-time choice), the PR #7 hourly service from the provider, and the PR #19 fallback
 *    service from the plan factory, the hourly service, and the PR #17
 *    {@link classifyKmaHourlyFallbackEligibility} classifier (the fixed production eligibility policy).
 * 5. Return `{ ok: true, service }`.
 *
 * Construction is side-effect-free beyond reading provider configuration: it reads no clock, builds no
 * request plan, runs neither the primary nor the previous service, calls the classifier zero times,
 * issues no network request, registers no listener, starts no timer, and logs nothing. The first
 * clock read and the first `fetch` happen only when the returned service's
 * `fetchHourlyForecastWithFallback()` runs. Every call builds a fresh dependency graph — there is no
 * module-level singleton or shared cache.
 *
 * When `env` is omitted, the provider factory reads `process.env` at call time; this function never
 * reads it at import time and never reads or validates the service key itself.
 */
export function createKmaHourlyFallbackCompositionFromEnv(
  env?: NodeJS.ProcessEnv,
  dependencies?: KmaHourlyFallbackCompositionDependencies,
): CreateKmaHourlyFallbackCompositionResult {
  // Step 1: the provider factory owns service-key reading/validation and transport policy. Forward
  // an injected fetch only when one was supplied, so the provider keeps its native-fetch default
  // (never pass `{ fetchImpl: undefined }`).
  const providerResult = createKmaForecastProviderFromEnv(
    env,
    dependencies?.fetchImpl === undefined
      ? undefined
      : { fetchImpl: dependencies.fetchImpl },
  );

  // Step 2: a configuration failure is returned as a value, with the provider's own error reference
  // passed through unchanged — no clock read, no collaborator construction, no network.
  if (!providerResult.ok) {
    return {
      ok: false,
      error: providerResult.error,
    };
  }

  // Step 3: select the clock — the injected reference wins; otherwise the production system clock.
  // Neither is called here; the first read is deferred to the service's request-time plan-factory call.
  const clock = dependencies?.clock ?? createKmaSystemClock();

  // Step 4: assemble the graph — injecting the PR #16 candidate selector into the request-plan factory
  // as the fixed production base-time policy, and the PR #17 classifier into the fallback service as
  // the fixed production eligibility policy. Both are only referenced now; the selector first runs
  // when the plan factory reads the clock at request time, and the classifier first runs when the
  // fallback service classifies its primary result.
  const requestPlanFactory = createKmaFallbackRequestPlanFactory(
    clock,
    selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay,
  );
  const hourlyService = createKmaHourlyForecastService(providerResult.provider);
  const service = createKmaHourlyFallbackService(
    requestPlanFactory,
    hourlyService,
    classifyKmaHourlyFallbackEligibility,
  );

  // Step 5: expose only the live service — the internal graph stays encapsulated.
  return {
    ok: true,
    service,
  };
}
