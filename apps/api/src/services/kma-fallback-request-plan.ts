/**
 * The KMA (기상청) fallback **request-plan factory**: the application-level component that combines
 * an **injected clock** and an **injectable candidate selector** (defaulting to the PR #16
 * availability-aware {@link selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay}) with
 * caller-supplied grid coordinates into a **pair** of complete {@link KmaForecastRequest}s.
 *
 * Pipeline it assembles:
 *
 * ```text
 * injected clock
 *   → reference epoch milliseconds                                    // read exactly once
 *   → candidate selector   // default: PR #16 selector → { primary, previous } base-time candidates
 *   → combine each candidate with caller-supplied product / nx / ny
 *   → { primary: KmaForecastRequest, previous: KmaForecastRequest }
 * ```
 *
 * The two requests share the **same absolute reference**: the clock is read once and the selector is
 * called once, so both `primary` and `previous` come from a single candidate pair. This factory does
 * **not** call the PR #9 single request factory (calling it twice could read the clock twice and pin
 * `primary`/`previous` to two different instants across an availability threshold boundary, losing
 * the PR #16 pair invariant).
 *
 * Why this factory lives in `apps/api/src/services`: reading "now" is an application/server-layer
 * concern and the result requests are the provider boundary's {@link KmaForecastRequest}, so the
 * factory bridges the injected clock and the `weather-core` candidate selector into requests. The
 * candidate schedule and availability rules stay owned by the `weather-core` selector; the provider
 * must never read a clock or call the selector on its own; and `weather-core` must never import an
 * `apps/api` type. The allowed direction is `apps/api services → @life-weather/weather-core` and
 * `apps/api services → providers/kma` (type-only).
 *
 * Deliberately narrow — this factory builds a *request plan* and nothing more. It does **not** call
 * the provider, run the hourly service, invoke the PR #17 fallback-eligibility classifier, inspect a
 * primary result, execute the `previous` request, retry, orchestrate a fallback, wire an
 * `AbortSignal`, or re-validate the request (the provider still owns runtime request validation). A
 * `previous` request being present in the plan does **not** mean it will be sent: the request plan is
 * built *before* execution, whereas eligibility is decided *after* the primary service result exists.
 * Whether the `previous` request is ever executed is a later orchestration PR's decision (PR #19).
 *
 * Clock policy: the factory never reads any system/wall clock, high-resolution timer, or ambient
 * time source, and provides **no** default clock — the clock is always injected. Construction calls
 * the clock and the selector **zero** times; each `createFallbackRequestPlan()` call reads the clock
 * **exactly once**, with no argument, and calls the selector **exactly once** with the clock's epoch
 * value forwarded verbatim (no rounding, truncation, or coercion).
 *
 * Error policy: this factory introduces **no** new result union and **no** new error type. A clock
 * error and a selector `RangeError` (invalid epoch, unsupported product, out-of-range year) propagate
 * **verbatim** — the same error reference, never caught, wrapped, re-messaged, or logged, and never a
 * partial plan. See `docs/kma-fallback-request-plan.md`.
 */

import {
  selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay,
  type KmaForecastBaseTimeCandidates,
  type SelectKmaForecastBaseTimeCandidatesAfterAvailabilityDelayInput,
} from '@life-weather/weather-core';

import type { KmaForecastRequest } from '../providers/kma';
import type {
  KmaForecastRequestClock,
  KmaForecastRequestFactoryInput,
} from './kma-forecast-request';

/**
 * The pluggable candidate-selection policy: given a `{ product, referenceEpochMilliseconds }` input,
 * it returns the `{ primary, previous }` base-time candidate pair. Structurally this is exactly the
 * call signature of `weather-core`'s pure PR #16 candidate selector
 * ({@link selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay}), so it can be injected without
 * an adapter. The factory treats the selector as an opaque function: it neither re-validates, clones,
 * spreads, nor transforms the result, and never catches, wraps, or logs an error the selector throws.
 */
export type KmaForecastBaseTimeCandidatesSelector = (
  input: SelectKmaForecastBaseTimeCandidatesAfterAvailabilityDelayInput,
) => KmaForecastBaseTimeCandidates;

/**
 * The caller-supplied part of a request plan: the forecast product and the **already-computed** KMA
 * grid point. This is a deliberate **alias** of {@link KmaForecastRequestFactoryInput} (the PR #9
 * single request factory's input): the fallback plan shares exactly the same caller-supplied shape
 * (`product` + `nx` + `ny`), so aliasing keeps the two factories' input shapes from drifting apart
 * and re-defines no field. Latitude/longitude conversion occurs upstream in the PR #12/#13 location
 * pipeline; this factory accepts the already-computed `nx`/`ny` and does not transform, round, clamp,
 * swap, stringify, or default them. Runtime trust-boundary validation stays with the provider.
 */
export type KmaFallbackRequestPlanFactoryInput = KmaForecastRequestFactoryInput;

/**
 * The availability-aware request plan: a `primary` request built from the selector's primary
 * candidate and a `previous` request built from its previous candidate. The plan carries exactly
 * these two keys and no eligibility flag, reason, `fallbackUsed`/`selected`/`attempt` metadata,
 * candidate object, reference epoch, or error/result union — it is a pure pre-execution assembly.
 */
export interface KmaFallbackRequestPlan {
  /** The request dated to the PR #16 primary (availability-aware) candidate. */
  readonly primary: KmaForecastRequest;
  /** The request dated to the PR #16 previous (one-step-back) candidate. */
  readonly previous: KmaForecastRequest;
}

/** The factory's single public method. */
export interface KmaFallbackRequestPlanFactory {
  /**
   * Build a complete {@link KmaFallbackRequestPlan} for the given `input`, dating `primary` and
   * `previous` to the candidate pair the factory's selector picks at the injected clock's current
   * instant. Reads the clock **exactly once**, calls the selector **exactly once**, and returns a
   * **fresh** plan (with fresh, distinct `primary` and `previous` request objects) every call.
   */
  createFallbackRequestPlan(
    input: KmaFallbackRequestPlanFactoryInput,
  ): KmaFallbackRequestPlan;
}

/**
 * Create a fallback request-plan factory bound to an injected {@link KmaForecastRequestClock} and an
 * optional {@link KmaForecastBaseTimeCandidatesSelector}. When `candidatesSelector` is omitted it
 * defaults to the PR #16 availability-aware
 * {@link selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay} — because this factory's whole
 * purpose is an availability-aware primary plus a one-step-back previous, that selector is the
 * natural default (unlike the PR #9 single request factory, whose default stays the schedule-only
 * PR #8 selector — this factory does not change that). The default is **not** wired into the
 * production composition yet, so current production behaviour is unchanged; a caller may still inject
 * a custom candidates selector for a test or a different policy.
 *
 * Pure construction: it does **not** call the clock, call the selector, read the environment,
 * perform I/O, register a listener, or start a timer — the returned object merely closes over
 * `clock` and `candidatesSelector`. The same instance is safe to call many times; it holds no mutable
 * state and each call is independent of any previous one.
 */
export function createKmaFallbackRequestPlanFactory(
  clock: KmaForecastRequestClock,
  candidatesSelector: KmaForecastBaseTimeCandidatesSelector = selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay,
): KmaFallbackRequestPlanFactory {
  return {
    createFallbackRequestPlan(input) {
      // Exactly one clock read per plan; the epoch is forwarded to the selector unchanged. Both
      // requests are dated from this single reference, so primary and previous can never straddle an
      // availability threshold boundary the way two independent clock reads could.
      const referenceEpochMilliseconds = clock.nowEpochMilliseconds();

      // The selector owns the candidate policy (availability-aware primary + one-step-back previous
      // by default). It is called exactly once with a fresh two-key input and throws a RangeError
      // verbatim for an invalid epoch or an unsupported product — this factory neither catches,
      // re-wraps, re-validates, nor clones its result.
      const candidates = candidatesSelector({
        product: input.product,
        referenceEpochMilliseconds,
      });

      // Explicit fields only — never spread `input` or a candidate, so a runtime-injected extra
      // property cannot leak into the fixed request shape, and only the base-time primitives (not the
      // candidate object references) reach the plan. `primary` and `previous` are always distinct
      // freshly-allocated objects.
      return {
        primary: {
          product: input.product,
          baseDate: candidates.primary.baseDate,
          baseTime: candidates.primary.baseTime,
          nx: input.nx,
          ny: input.ny,
        },
        previous: {
          product: input.product,
          baseDate: candidates.previous.baseDate,
          baseTime: candidates.previous.baseTime,
          nx: input.nx,
          ny: input.ny,
        },
      };
    },
  };
}
