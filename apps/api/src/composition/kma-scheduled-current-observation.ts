/**
 * The **production composition root** for the KMA scheduled current-observation (초단기실황) pipeline.
 *
 * This is the current-observation counterpart of `kma-scheduled-hourly.ts` (the PR #11 grid scheduled
 * hourly composition) — a **separate**, parallel composition, not a generalization of it. It is the
 * explicit, server-side wiring point that assembles the components built by PR #63/#64/#66/#67/#68
 * into one live {@link KmaScheduledCurrentObservationFacade}:
 *
 * ```text
 * environment
 *   → createKmaCurrentObservationProviderFromEnv (PR #63)   → KmaCurrentObservationProvider
 *   → createKmaCurrentObservationService (PR #67)           → KmaCurrentObservationService
 *
 * system clock adapter / injected clock
 *   + selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay (PR #79)   // explicit
 *     availability-delay production choice, wired here by PR #80
 *   → createKmaCurrentObservationRequestFactory (PR #66)   → KmaCurrentObservationRequestFactory
 *
 * request factory + current-observation service
 *   → createKmaScheduledCurrentObservationFacade (PR #68) → live facade
 * ```
 *
 * It is a **callable** composition function — never an import-time singleton. Importing this module
 * reads no environment, builds no provider, reads no clock, and starts no I/O; every dependency is
 * created only when {@link createKmaScheduledCurrentObservationCompositionFromEnv} is *called*. This
 * keeps test and `/health` imports free of any KMA configuration dependency and defers all startup /
 * error policy to an explicit caller (a later route / startup PR).
 *
 * Production base-time choice: as of PR #80, this root injects the PR #79 **availability-delay**
 * selector, {@link selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay} — the request
 * factory's schedule-only default ({@link selectLatestKmaCurrentObservationBaseTime}, PR #64) is no
 * longer used here (a direct one-argument caller of the request factory still gets it). The
 * availability-delay selector picks the latest on-the-hour (`HH00`) issuance whose project-defined
 * 10-minute threshold has already elapsed at the reference instant; the 10-minute threshold itself
 * lives only in the PR #79 weather-core selector — this composition introduces no threshold number of
 * its own. This still does **not** guarantee the upstream API has actually published that issuance's
 * data, that a request at this instant succeeds, or that a previous-issuance fallback exists — see
 * `docs/kma-current-observation-api-availability-time.md`.
 *
 * Responsibility boundary: this layer only *selects* production dependencies — including the explicit
 * PR #79 availability-delay selector it injects into the request factory — and *sequences* the
 * existing public factories. It owns no KMA data rule, no transport, no normalization, no issue-time
 * math, no request-assembly rule, and no facade-wiring rule — those stay in the components it
 * composes. It reads and validates no service key of its own (the provider factory owns that), builds
 * no URL, calls no `fetch`, reads no clock, and adds no retry / fallback / logging. It consumes only
 * the `../providers/kma`, `../services`, and `@life-weather/weather-core` (the PR #79 selector) public
 * surfaces. See `docs/kma-current-observation-production-composition.md`.
 */

import { selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay } from '@life-weather/weather-core';

import {
  createKmaCurrentObservationProviderFromEnv,
  type KmaProviderConfigError,
} from '../providers/kma/index.js';
import {
  createKmaCurrentObservationRequestFactory,
  createKmaCurrentObservationService,
  createKmaScheduledCurrentObservationFacade,
  type KmaCurrentObservationRequestClock,
  type KmaScheduledCurrentObservationFacade,
} from '../services/index.js';
import { createKmaSystemClock } from './system-clock.js';

/**
 * The dependencies a caller may override for the composed pipeline. Both are optional and, when
 * omitted, resolve to the production default (native `fetch` inside the provider factory; the
 * {@link createKmaSystemClock} adapter for the clock — the same adapter the hourly composition uses,
 * since both request factories consume the same structural `nowEpochMilliseconds()` clock port).
 *
 * - `fetchImpl` — an injectable `fetch` forwarded to the provider factory (for tests / a custom
 *   transport). When omitted, the provider factory uses `globalThis.fetch`. Provider timeout and
 *   response-size policy are intentionally **not** exposed here — the provider's own defaults stand.
 * - `clock` — an injectable {@link KmaCurrentObservationRequestClock} handed straight to the request
 *   factory. When omitted, the production system clock is used. The clock is never called, cloned, or
 *   validated at composition time — only wired.
 */
export interface KmaScheduledCurrentObservationCompositionDependencies {
  readonly fetchImpl?: typeof fetch;
  readonly clock?: KmaCurrentObservationRequestClock;
}

/**
 * The outcome of composing the pipeline. On success it exposes **only** the live facade — never the
 * provider, request factory, current-observation service, clock, environment, `fetchImpl`, service
 * key, or a URL, so the internal graph (and the service key bound inside the provider) stays
 * encapsulated. On a provider-configuration failure it carries the provider factory's own
 * {@link KmaProviderConfigError} **by reference**, unchanged.
 */
export type CreateKmaScheduledCurrentObservationCompositionResult =
  | {
      readonly ok: true;
      readonly facade: KmaScheduledCurrentObservationFacade;
    }
  | {
      readonly ok: false;
      readonly error: KmaProviderConfigError;
    };

/**
 * Compose a live scheduled current-observation facade from the environment and optional
 * dependencies.
 *
 * Sequence:
 *
 * 1. Build the provider via {@link createKmaCurrentObservationProviderFromEnv}, forwarding `env` by
 *    reference (never read, cloned, or spread here) and the injected `fetchImpl` when supplied.
 * 2. On a provider config failure, return `{ ok: false, error }` immediately — the **same** error
 *    reference, with no clock read, no request factory / current-observation service / facade
 *    construction, and no `fetch`.
 * 3. Otherwise pick the clock: the injected `clock` reference when supplied, else a fresh
 *    {@link createKmaSystemClock} adapter.
 * 4. Build the request factory from that clock and the PR #79
 *    {@link selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay} availability-delay
 *    selector (the explicit production base-time choice), the current-observation service from the
 *    provider, and the scheduled facade from the two.
 * 5. Return `{ ok: true, facade }`.
 *
 * Construction is side-effect-free beyond reading provider configuration: it reads no clock, issues
 * no network request, registers no listener, starts no timer, and logs nothing. The first clock read,
 * the first selector run, and the first `fetch` happen only when the returned facade's
 * `fetchScheduledCurrentWeather()` runs. Every call builds a fresh dependency graph — there is no
 * module-level singleton or shared cache.
 *
 * When `env` is omitted, the provider factory reads `process.env` at call time; this function never
 * reads it at import time and never reads or validates the service key itself.
 */
export function createKmaScheduledCurrentObservationCompositionFromEnv(
  env?: NodeJS.ProcessEnv,
  dependencies?: KmaScheduledCurrentObservationCompositionDependencies,
): CreateKmaScheduledCurrentObservationCompositionResult {
  // Step 1: the provider factory owns service-key reading/validation and transport policy. Forward
  // an injected fetch only when one was supplied, so the provider keeps its native-fetch default
  // (never pass `{ fetchImpl: undefined }`).
  const providerResult = createKmaCurrentObservationProviderFromEnv(
    env,
    dependencies?.fetchImpl === undefined
      ? undefined
      : { fetchImpl: dependencies.fetchImpl },
  );

  // Step 2: a configuration failure is returned as a value, with the provider's own error reference
  // passed through unchanged — no clock read, no collaborator construction, no network.
  if (providerResult.ok === false) {
    return {
      ok: false,
      error: providerResult.error,
    };
  }

  // Step 3: select the clock — the injected reference wins; otherwise the production system clock.
  // Neither is called here; the first read is deferred to the facade's request-time factory call.
  const clock = dependencies?.clock ?? createKmaSystemClock();

  // Steps 4–6: assemble the request factory — injecting the PR #79 availability-delay selector as
  // the explicit production base-time choice (never relying on the factory's schedule-only implicit
  // default) — the current-observation service, and the scheduled facade. The selector is only
  // referenced now; it first runs when the facade's request-time factory call reads the clock.
  const requestFactory = createKmaCurrentObservationRequestFactory(
    clock,
    selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay,
  );
  const currentObservationService = createKmaCurrentObservationService(
    providerResult.provider,
  );
  const facade = createKmaScheduledCurrentObservationFacade(
    requestFactory,
    currentObservationService,
  );

  // Step 7: expose only the live facade — the internal graph stays encapsulated.
  return {
    ok: true,
    facade,
  };
}
