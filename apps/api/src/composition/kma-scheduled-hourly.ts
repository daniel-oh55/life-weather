/**
 * The **production composition root** for the KMA scheduled hourly-forecast pipeline.
 *
 * This is the explicit, server-side wiring point that assembles the components built by the earlier
 * PRs into one live {@link KmaScheduledHourlyForecastFacade}:
 *
 * ```text
 * environment
 *   → createKmaForecastProviderFromEnv (PR #5)      → KmaForecastProvider
 *   → createKmaHourlyForecastService  (PR #7)       → KmaHourlyForecastService
 *
 * system clock adapter / injected clock
 *   → createKmaForecastRequestFactory (PR #9)       → KmaForecastRequestFactory
 *
 * request factory + hourly service
 *   → createKmaScheduledHourlyForecastFacade (PR #10) → live facade
 * ```
 *
 * It is a **callable** composition function — never an import-time singleton. Importing this module
 * reads no environment, builds no provider, reads no clock, and starts no I/O; every dependency is
 * created only when {@link createKmaScheduledHourlyCompositionFromEnv} is *called*. This keeps test
 * and `/health` imports free of any KMA configuration dependency and defers all startup / error
 * policy to an explicit caller (a later route / startup PR).
 *
 * Responsibility boundary: this layer only *selects* production dependencies and *sequences* the
 * existing public factories. It owns no KMA data rule, no transport, no normalization, no issue-time
 * math, no request-assembly rule, and no facade-wiring rule — those stay in the components it
 * composes. It reads and validates no service key of its own (the provider factory owns that), builds
 * no URL, calls no `fetch`, reads no clock, and adds no retry / fallback / logging. It consumes only
 * the `../providers/kma` and `../services` public surfaces. See `docs/kma-production-composition.md`.
 */

import {
  createKmaForecastProviderFromEnv,
  type KmaProviderConfigError,
} from '../providers/kma';
import {
  createKmaForecastRequestFactory,
  createKmaHourlyForecastService,
  createKmaScheduledHourlyForecastFacade,
  type KmaForecastRequestClock,
  type KmaScheduledHourlyForecastFacade,
} from '../services';
import { createKmaSystemClock } from './system-clock';

/**
 * The dependencies a caller may override for the composed pipeline. Both are optional and, when
 * omitted, resolve to the production default (native `fetch` inside the provider factory; the
 * {@link createKmaSystemClock} adapter for the clock).
 *
 * - `fetchImpl` — an injectable `fetch` forwarded to the provider factory (for tests / a custom
 *   transport). When omitted, the provider factory uses `globalThis.fetch`. Provider timeout and
 *   response-size policy are intentionally **not** exposed here — the provider's own defaults stand.
 * - `clock` — an injectable {@link KmaForecastRequestClock} handed straight to the request factory.
 *   When omitted, the production system clock is used. The clock is never called, cloned, or
 *   validated at composition time — only wired.
 */
export interface KmaScheduledHourlyCompositionDependencies {
  readonly fetchImpl?: typeof fetch;
  readonly clock?: KmaForecastRequestClock;
}

/**
 * The outcome of composing the pipeline. On success it exposes **only** the live facade — never the
 * provider, request factory, hourly service, clock, environment, `fetchImpl`, service key, or a URL,
 * so the internal graph (and the service key bound inside the provider) stays encapsulated. On a
 * provider-configuration failure it carries the provider factory's own {@link KmaProviderConfigError}
 * **by reference**, unchanged.
 */
export type CreateKmaScheduledHourlyCompositionResult =
  | {
      readonly ok: true;
      readonly facade: KmaScheduledHourlyForecastFacade;
    }
  | {
      readonly ok: false;
      readonly error: KmaProviderConfigError;
    };

/**
 * Compose a live scheduled hourly-forecast facade from the environment and optional dependencies.
 *
 * Sequence:
 *
 * 1. Build the provider via {@link createKmaForecastProviderFromEnv}, forwarding `env` by reference
 *    (never read, cloned, or spread here) and the injected `fetchImpl` when supplied.
 * 2. On a provider config failure, return `{ ok: false, error }` immediately — the **same** error
 *    reference, with no clock read, no request factory / hourly service / facade construction, and
 *    no `fetch`.
 * 3. Otherwise pick the clock: the injected `clock` reference when supplied, else a fresh
 *    {@link createKmaSystemClock} adapter.
 * 4. Build the request factory from that clock, the hourly service from the provider, and the
 *    scheduled facade from the two.
 * 5. Return `{ ok: true, facade }`.
 *
 * Construction is side-effect-free beyond reading provider configuration: it reads no clock, issues
 * no network request, registers no listener, starts no timer, and logs nothing. The first clock read
 * and the first `fetch` happen only when the returned facade's `fetchScheduledHourlyForecast()` runs.
 * Every call builds a fresh dependency graph — there is no module-level singleton or shared cache.
 *
 * When `env` is omitted, the provider factory reads `process.env` at call time; this function never
 * reads it at import time and never reads or validates the service key itself.
 */
export function createKmaScheduledHourlyCompositionFromEnv(
  env?: NodeJS.ProcessEnv,
  dependencies?: KmaScheduledHourlyCompositionDependencies,
): CreateKmaScheduledHourlyCompositionResult {
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
  // Neither is called here; the first read is deferred to the facade's request-time factory call.
  const clock = dependencies?.clock ?? createKmaSystemClock();

  // Steps 4–6: assemble the request factory, the hourly service, and the scheduled facade.
  const requestFactory = createKmaForecastRequestFactory(clock);
  const hourlyService = createKmaHourlyForecastService(providerResult.provider);
  const facade = createKmaScheduledHourlyForecastFacade(
    requestFactory,
    hourlyService,
  );

  // Step 7: expose only the live facade — the internal graph stays encapsulated.
  return {
    ok: true,
    facade,
  };
}
