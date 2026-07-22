/**
 * The KMA (기상청) hourly-forecast **fallback orchestration service**: the application component that
 * combines three existing building blocks into a single, at-most-two-attempt execution.
 *
 * It composes:
 *
 * 1. the PR #18 {@link KmaFallbackRequestPlanFactory} — one `{ primary, previous }` request plan built
 *    from a single availability-aware reference,
 * 2. the PR #7 {@link KmaHourlyForecastService} — runs **one** complete request through the provider
 *    and normalizer, and
 * 3. the PR #17 {@link classifyKmaHourlyFallbackEligibility} classifier — decides whether one primary
 *    result is a no-data signal that warrants a single previous-issuance retry.
 *
 * Exact execution order per call:
 *
 * ```text
 * plan factory.createFallbackRequestPlan(input)            // exactly once
 *   → hourly service.fetchHourlyForecast(plan.primary)     // exactly once  (PRIMARY_SERVICE)
 *   → classifier(primary)                                  // exactly once  (CLASSIFY_PRIMARY)
 *   → ineligible → stop, return { fallbackAttempted: false, primary }
 *   → eligible   → hourly service.fetchHourlyForecast(plan.previous)   // at most once (PREVIOUS_SERVICE)
 *                → return { fallbackAttempted: true, fallbackReason, primary, previous }
 * ```
 *
 * This is the first PR that actually **executes** the `previous` request. The "fallback" here is not a
 * generic transport retry: it means the newest availability-aware issuance reported a no-data signal
 * (`EMPTY_HOURLY` or upstream `'03'`), so the immediately-previous scheduled issuance is queried
 * **once**. It never walks further back, never retries the same request, and never re-classifies the
 * `previous` result — a single step of fallback and no more.
 *
 * `fallbackAttempted: true` means the previous hourly-service invocation **happened**; it does not
 * mean an HTTP request was sent, that the network succeeded, or that the previous result carries data.
 * The result is an **execution trace** (which attempts ran, and why), not a final API selection: it
 * merges nothing, picks no winner, and adds no `source`/`stale`/`fallbackUsed`/`selected` field.
 *
 * Deliberately narrow — everything below stays with other layers or later PRs: production composition
 * wiring, the scheduled/location facades, an HTTP route, `WeatherOverview`/`SourceMetadata` assembly,
 * final source/stale reporting, caching, a third attempt, transport/timeout/HTTP retry, backoff,
 * delay, exploring other base times, and merging or selecting the primary/previous results.
 *
 * Reference discipline: the caller `input` reaches the plan factory by the **same reference**;
 * `plan.primary`/`plan.previous` reach the service by the same references; the caller `options`
 * (including its `AbortSignal`) reaches both service calls by the same reference (or `undefined` when
 * omitted); the primary result reaches both the classifier and the output by the same reference; and
 * the previous result reaches the output by the same reference. Nothing is cloned, spread, sanitized,
 * or re-assembled — the nested service results are already the application boundary's sanitized
 * results.
 *
 * Abort policy: this orchestration owns **no** abort policy. It creates no `AbortController`, wraps no
 * signal, registers no listener, never inspects `options.signal.aborted`, and synthesizes no `ABORTED`
 * result — the caller's signal is forwarded verbatim and the provider keeps its existing abort
 * ownership. If the signal is already aborted before the previous attempt, the previous service still
 * receives that same aborted signal and the provider returns `ABORTED` with no network request.
 *
 * Error policy: it introduces **no** new result union and **no** new error type. A collaborator error
 * — a plan-factory throw, a primary or previous service synchronous throw or rejected `Promise`, or a
 * classifier throw — propagates **verbatim** as the returned `Promise`'s rejection (the same error
 * reference), never caught in a broad `try/catch`, wrapped, re-messaged, logged, hidden behind a
 * `{ ok: false }` result, or turned into a partial execution result. See
 * `docs/kma-hourly-fallback.md`.
 */

import type {
  KmaFallbackRequestPlanFactory,
  KmaFallbackRequestPlanFactoryInput,
} from './kma-fallback-request-plan';
import {
  classifyKmaHourlyFallbackEligibility,
  type KmaHourlyFallbackEligibility,
  type KmaHourlyFallbackReason,
} from './kma-hourly-fallback-eligibility';
import type {
  KmaHourlyForecastService,
  KmaHourlyForecastServiceOptions,
  KmaHourlyForecastServiceResult,
} from './kma-hourly-forecast';

/**
 * The pluggable fallback-eligibility policy: given **one** {@link KmaHourlyForecastServiceResult}, it
 * returns a {@link KmaHourlyFallbackEligibility}. Structurally this is exactly the call signature of
 * the pure PR #17 {@link classifyKmaHourlyFallbackEligibility}, so it can be injected without an
 * adapter. The orchestrator treats it as an opaque function: it never re-implements the eligibility
 * rules (no `result.ok`, `resultCode`, `hourly.length`, provider-error-kind, or normalization-issue
 * inspection of its own) and never catches, wraps, or logs an error it throws.
 */
export type KmaHourlyFallbackEligibilityClassifier = (
  result: KmaHourlyForecastServiceResult,
) => KmaHourlyFallbackEligibility;

/**
 * The service input. A deliberate **alias** of the PR #18
 * {@link KmaFallbackRequestPlanFactoryInput} (`product` + `nx` + `ny`): the orchestrator forwards it
 * to the plan factory by reference and defines no field of its own, so the two shapes cannot drift.
 */
export type KmaHourlyFallbackServiceInput = KmaFallbackRequestPlanFactoryInput;

/**
 * Per-call options. A deliberate **alias** of the PR #7
 * {@link KmaHourlyForecastServiceOptions} (`{ signal? }`): the caller's options — including its
 * `signal` — is forwarded unchanged to both service calls, so no new option shape is introduced.
 */
export type KmaHourlyFallbackServiceOptions = KmaHourlyForecastServiceOptions;

/**
 * The outcome of one `fetchHourlyForecastWithFallback` call — an **execution trace**, not a final API
 * selection. Exactly one of two branches:
 *
 * - **No fallback** (`fallbackAttempted: false`): the plan was built, the primary service ran, and the
 *   classifier returned ineligible, so the previous service was never invoked. Carries only the
 *   primary service result.
 * - **Fallback attempted** (`fallbackAttempted: true`): the primary result was eligible, so the
 *   previous service was invoked **exactly once**. Carries the primary eligibility `reason`
 *   (unchanged by the previous result), the primary result, and the previous result.
 *
 * Each nested result is the collaborator's own result by reference. The union carries **no** final
 * selection or transport metadata — no `fallbackUsed`, `fallbackSucceeded`, `selected`, `final`,
 * `result`, `source`, `stale`, `attemptCount`, `maxAttempts`, `retryable`, `delayMilliseconds`,
 * `primaryRequest`, `previousRequest`, `plan`, `eligibility`, or `classifierResult`.
 */
export type KmaHourlyFallbackServiceResult =
  | {
      readonly fallbackAttempted: false;
      readonly primary: KmaHourlyForecastServiceResult;
    }
  | {
      readonly fallbackAttempted: true;
      readonly fallbackReason: KmaHourlyFallbackReason;
      readonly primary: KmaHourlyForecastServiceResult;
      readonly previous: KmaHourlyForecastServiceResult;
    };

/** The service's single public method. */
export interface KmaHourlyFallbackService {
  /**
   * Build a request plan for `input`, run its `primary` request through the hourly service, classify
   * that primary result, and — only when the classifier reports eligible — run the plan's `previous`
   * request through the hourly service **once**. Calls the plan factory exactly once, the classifier
   * exactly once (on the primary result only), and the hourly service at most twice. `options`
   * (including its `signal`) is forwarded to both service calls by reference (or `undefined` when
   * omitted). Returns a fresh execution-trace result; a collaborator error rejects the returned
   * `Promise` verbatim.
   */
  fetchHourlyForecastWithFallback(
    input: KmaHourlyFallbackServiceInput,
    options?: KmaHourlyFallbackServiceOptions,
  ): Promise<KmaHourlyFallbackServiceResult>;
}

/**
 * Create a fallback orchestration service bound to an injected {@link KmaFallbackRequestPlanFactory}
 * and {@link KmaHourlyForecastService}, plus an optional
 * {@link KmaHourlyFallbackEligibilityClassifier} that defaults to the pure PR #17
 * {@link classifyKmaHourlyFallbackEligibility}. Injecting the classifier keeps all fallback policy in
 * one place — the orchestrator never re-derives eligibility itself.
 *
 * Pure construction: it calls neither collaborator, reads no environment, performs no I/O, registers
 * no listener, and starts no timer — the returned object merely closes over the three collaborators.
 * The same instance is safe to call many times; it holds no mutable state, cache, or counter, and
 * each call is independent of any previous one and returns a fresh wrapper object.
 */
export function createKmaHourlyFallbackService(
  requestPlanFactory: KmaFallbackRequestPlanFactory,
  hourlyService: KmaHourlyForecastService,
  eligibilityClassifier: KmaHourlyFallbackEligibilityClassifier = classifyKmaHourlyFallbackEligibility,
): KmaHourlyFallbackService {
  return {
    async fetchHourlyForecastWithFallback(input, options) {
      // Exactly one plan per call; `input` passes through to the factory by reference (no clone).
      const plan = requestPlanFactory.createFallbackRequestPlan(input);

      // Exactly one primary attempt; the plan's `primary` request and the caller's `options` (signal
      // included) pass through unchanged.
      const primary = await hourlyService.fetchHourlyForecast(plan.primary, options);

      // The injected classifier owns all fallback policy — it inspects the primary result once and
      // this orchestrator never re-implements the eligibility rules.
      const eligibility = eligibilityClassifier(primary);

      if (!eligibility.eligible) {
        // Ineligible: stop after the primary attempt. The previous request is never sent.
        return {
          fallbackAttempted: false,
          primary,
        };
      }

      // Eligible: run the plan's `previous` request through the same service exactly once, forwarding
      // the same `options`/signal reference. The previous result is never re-classified and no third
      // request is ever made.
      const previous = await hourlyService.fetchHourlyForecast(plan.previous, options);

      return {
        fallbackAttempted: true,
        fallbackReason: eligibility.reason,
        primary,
        previous,
      };
    },
  };
}
