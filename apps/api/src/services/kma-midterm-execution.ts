/**
 * The KMA (기상청) mid-term **execution service**: the application-level component that connects the
 * PR #100 {@link KmaMidtermRequestPlanFactory} to the PR #98 {@link KmaMidtermForecastProvider} and
 * runs both halves of one request plan through the provider.
 *
 * Pipeline it runs, per call:
 *
 * ```text
 * requestPlanFactory.createScheduledRequestPlan(input)        // exactly once
 *   → provider.fetchMidtermForecast(plan.temperature, options) // exactly once
 *   → provider.fetchMidtermForecast(plan.land, options)         // exactly once, after TEMPERATURE resolves
 *   → { temperature, land }                                     // fresh wrapper, both results preserved
 * ```
 *
 * Execution order is fixed and sequential: TEMPERATURE always runs before LAND, and this service
 * never introduces `Promise.all`, racing, concurrency limits, or batching — that policy is
 * deliberately out of scope for this PR.
 *
 * A **resolved** provider-domain failure (`{ ok: false, error }`) is not a thrown/rejected
 * collaborator error — it is an ordinary application value. TEMPERATURE resolving to `ok: false`
 * therefore does **not** suppress the LAND invocation: this service does not inspect the error kind,
 * does not pick a winner, and never flattens the two outcomes into one result. Both provider results
 * are preserved by exact reference in the returned wrapper.
 *
 * By contrast, a plan-factory throw or a provider synchronous throw/rejection is a collaborator
 * failure, not a resolved value: it propagates verbatim (the same error reference) and short-circuits
 * the remaining steps — no partial execution result is ever returned. There is no broad
 * `try`/`catch` anywhere in this file.
 *
 * Deliberately narrow — this service builds an **execution trace**, not a final daily forecast. It
 * does not normalize `DailyForecast[]`, merge TEMPERATURE and LAND, map Korean KMA weather phrases to
 * `WeatherCondition`, select a winning source, decide a partial-data policy, assemble a
 * `WeatherOverview`, build `SourceMetadata`, resolve a location to a `regId`, or wire into production
 * composition/routes. See `docs/kma-midterm-execution-service.md`.
 *
 * Abort policy: this service owns **no** abort policy. It creates no `AbortController`, registers no
 * listener, never inspects `options?.signal?.aborted`, and synthesizes no `ABORTED` result — the
 * caller's `options` (including its `AbortSignal`) is forwarded by the same reference to both
 * provider calls, and the provider alone decides whether an HTTP request is actually dispatched.
 */

import type {
  KmaMidtermForecastProvider,
  KmaMidtermForecastProviderResult,
} from '../providers/kma/index.js';
import type {
  KmaMidtermRequestPlanFactory,
  KmaMidtermRequestPlanFactoryInput,
} from './kma-midterm-request-plan.js';

/** The service input. A deliberate alias of the PR #100 plan-factory input — no field of its own. */
export type KmaMidtermExecutionServiceInput = KmaMidtermRequestPlanFactoryInput;

/**
 * Per-call options. The caller's `options` — including its `signal` — is forwarded to both provider
 * calls by the same reference (or `undefined` when omitted). This service defines no option of its
 * own.
 */
export interface KmaMidtermExecutionServiceOptions {
  readonly signal?: AbortSignal;
}

/**
 * The outcome of one `fetchScheduledMidtermForecast` call: both provider results, preserved by exact
 * reference. This is an **execution trace**, not a final selection — it carries no merged data, no
 * winning source, no `allSucceeded` flag, and no retry/fallback metadata. Either field may itself be
 * an `{ ok: false, error }` provider-domain result; that is a normal, resolved value and is preserved
 * exactly like a success.
 */
export interface KmaMidtermExecutionResult {
  readonly temperature: KmaMidtermForecastProviderResult;
  readonly land: KmaMidtermForecastProviderResult;
}

/** The service's single public method. */
export interface KmaMidtermExecutionService {
  /**
   * Build one request plan for `input`, run its `temperature` request through the provider, and —
   * regardless of whether that call resolves to a provider success or a provider-domain failure —
   * run the plan's `land` request through the same provider. Calls the plan factory exactly once and
   * the provider exactly twice (TEMPERATURE then LAND, in that fixed order). `options` (including its
   * `signal`) is forwarded to both provider calls by reference. A plan-factory or provider
   * throw/rejection propagates verbatim and yields no partial result.
   */
  fetchScheduledMidtermForecast(
    input: KmaMidtermExecutionServiceInput,
    options?: KmaMidtermExecutionServiceOptions,
  ): Promise<KmaMidtermExecutionResult>;
}

/**
 * Create a mid-term execution service bound to an injected {@link KmaMidtermRequestPlanFactory} and
 * {@link KmaMidtermForecastProvider}.
 *
 * Pure construction: it calls neither collaborator, reads no environment, performs no I/O, registers
 * no listener, and starts no timer — the returned object merely closes over `requestPlanFactory` and
 * `provider`. The same instance is safe to call many times; it holds no mutable state, and each call
 * is independent of any previous one and returns a fresh wrapper object.
 */
export function createKmaMidtermExecutionService(
  requestPlanFactory: KmaMidtermRequestPlanFactory,
  provider: KmaMidtermForecastProvider,
): KmaMidtermExecutionService {
  return {
    async fetchScheduledMidtermForecast(input, options) {
      // Exactly one plan per call; `input` passes through to the factory by reference (no clone).
      const plan = requestPlanFactory.createScheduledRequestPlan(input);

      // Exactly one TEMPERATURE attempt; the plan's `temperature` request and the caller's `options`
      // (signal included) pass through unchanged. A resolved provider-domain failure here is an
      // ordinary value, not a collaborator error, so it never prevents the LAND attempt below.
      const temperature = await provider.fetchMidtermForecast(plan.temperature, options);

      // Exactly one LAND attempt, run unconditionally after TEMPERATURE resolves — no inspection of
      // `temperature.ok` or its error kind, and no third request.
      const land = await provider.fetchMidtermForecast(plan.land, options);

      return {
        temperature,
        land,
      };
    },
  };
}
