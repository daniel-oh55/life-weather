/**
 * The KMA (기상청) current-observation (초단기실황, `getUltraSrtNcst`) **request factory**: the
 * application-level component that combines an **injected clock**, an **injectable base-time
 * selector** (defaulting to the PR #64 pure weather-core selector,
 * `selectLatestKmaCurrentObservationBaseTime`), and caller-supplied grid coordinates into a
 * complete {@link KmaCurrentObservationRequest}.
 *
 * This is the current-observation counterpart of `kma-forecast-request.ts` (the PR #9 forecast
 * request factory) — a **separate**, parallel factory, not a generalization of it. It differs
 * from its forecast sibling in the one way the current-observation request already differs: there
 * is no `product` choice (초단기실황 is a single operation). It shares the same injectable
 * base-time-selector seam the forecast factory has. A current-observation availability-delay
 * selector, {@link selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay}, now exists
 * (PR #79) — see
 * [kma-current-observation-api-availability-time.md](../../../docs/kma-current-observation-api-availability-time.md).
 * Choosing an availability policy remains a **composition** responsibility, not this factory's: this
 * factory itself neither imports nor hard-codes one, so a direct one-argument caller still gets this
 * factory's schedule-only default. As of **PR #80** the PR #69 production composition
 * (`apps/api/src/composition/kma-scheduled-current-observation.ts`) injects the PR #79 selector here
 * as its explicit non-default choice.
 *
 * Pipeline it assembles:
 *
 * ```text
 * injected clock
 *   → reference epoch milliseconds
 *   → base-time selector   // default: selectLatestKmaCurrentObservationBaseTime (PR #64) → baseDate / baseTime
 *   → combine with caller-supplied nx / ny
 *   → complete KmaCurrentObservationRequest
 * ```
 *
 * Why it lives in `apps/api/src/services` and not in `providers/kma`: reading "now" is an
 * application/server-layer concern and the result type is the provider boundary's
 * {@link KmaCurrentObservationRequest}, so the factory bridges two layers — the same reasoning as
 * the forecast request factory. The publication *schedule* rule stays owned by the `weather-core`
 * selector; the provider must never read a clock or call the selector on its own; and
 * `weather-core` must never import an `apps/api` type.
 *
 * Deliberately narrow: this factory assembles a *request* and nothing more. It does **not** call
 * the provider, convert lat/long → grid, re-validate the request (the provider still owns runtime
 * request validation), or add retry/fallback. The method is named `createScheduledRequest` — not
 * `createAvailableRequest` — because the default selector picks the latest *scheduled* issuance
 * and even an injected selector makes **no** claim that the upstream API data is actually ready.
 *
 * Clock policy: the factory never reads any system/wall clock, high-resolution timer, or ambient
 * time source, and provides **no** default clock — the clock is always injected. Construction
 * calls the clock and the selector **zero** times; each `createScheduledRequest()` call reads the
 * clock **exactly once**, with no argument, and calls the selector **exactly once** with the
 * clock's epoch value forwarded verbatim (no rounding, truncation, or coercion).
 *
 * Error policy: this factory introduces **no** new result union and **no** new error type. A
 * selector `RangeError` (invalid epoch, out-of-range year) and any error the injected clock or the
 * injected selector throws propagate **verbatim** — the same error reference, never caught,
 * wrapped, re-messaged, or logged. See `docs/kma-current-observation-request-factory.md`.
 */

import {
  selectLatestKmaCurrentObservationBaseTime,
  type KmaCurrentObservationBaseTime,
  type SelectLatestKmaCurrentObservationBaseTimeInput,
} from '@life-weather/weather-core';

import type { KmaCurrentObservationRequest } from '../providers/kma/index.js';

/**
 * The injected clock. Its single method returns the current instant as absolute epoch
 * milliseconds (UTC). The factory calls it with **no argument** and treats the returned value
 * as-is — it never reads a clock of its own, so this is the only source of "now".
 */
export interface KmaCurrentObservationRequestClock {
  readonly nowEpochMilliseconds: () => number;
}

/**
 * The pluggable base-time selection policy: given a `{ referenceEpochMilliseconds }` input, it
 * returns the request's `baseDate` / `baseTime`. Structurally this is exactly the call signature
 * of `weather-core`'s pure selectors — {@link selectLatestKmaCurrentObservationBaseTime} (the
 * schedule-only default) and the PR #79
 * `selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay` availability-delay selector
 * (the one the PR #69 production composition injects as of PR #80) — so either can be injected
 * without an adapter. The factory treats the selector as an opaque function: it neither
 * re-validates, clones, spreads, nor transforms the result, and never catches, wraps, or logs an
 * error the selector throws.
 */
export type KmaCurrentObservationBaseTimeSelector = (
  input: SelectLatestKmaCurrentObservationBaseTimeInput,
) => KmaCurrentObservationBaseTime;

/**
 * The caller-supplied part of a request: the **already-computed** KMA grid point. The factory
 * assumes a valid, typed grid coordinate is supplied here — it does not transform, round, clamp,
 * swap, stringify, or default `nx`/`ny`. The runtime trust-boundary validation of these values
 * stays with the provider.
 */
export interface KmaCurrentObservationRequestFactoryInput {
  readonly nx: number;
  readonly ny: number;
}

/** The factory's single public method. */
export interface KmaCurrentObservationRequestFactory {
  /**
   * Build a complete {@link KmaCurrentObservationRequest} for the given `input`, dating it to the
   * issuance the factory's base-time selector picks at the injected clock's current instant.
   * Reads the clock **exactly once**, calls the selector **exactly once**, and returns a
   * **fresh** request object every call.
   */
  createScheduledRequest(
    input: KmaCurrentObservationRequestFactoryInput,
  ): KmaCurrentObservationRequest;
}

/**
 * Create a request factory bound to an injected {@link KmaCurrentObservationRequestClock} and an
 * optional {@link KmaCurrentObservationBaseTimeSelector}. When `baseTimeSelector` is omitted it
 * defaults to the PR #64 {@link selectLatestKmaCurrentObservationBaseTime} schedule-only
 * selector, so the historical one-argument call keeps its exact behaviour. As of **PR #80**, the
 * PR #69 production composition (`apps/api/src/composition/kma-scheduled-current-observation.ts`)
 * injects the PR #79 availability-delay selector here as its explicit non-default choice; a direct
 * one-argument caller of this factory is unaffected and still gets the schedule-only default.
 *
 * Pure construction: it does **not** call the clock, call the selector, read the environment,
 * perform I/O, register a listener, or start a timer — the returned object merely closes over
 * `clock` and `baseTimeSelector`. The same instance is safe to call many times; it holds no
 * mutable state and each call is independent of any previous one.
 */
export function createKmaCurrentObservationRequestFactory(
  clock: KmaCurrentObservationRequestClock,
  baseTimeSelector: KmaCurrentObservationBaseTimeSelector = selectLatestKmaCurrentObservationBaseTime,
): KmaCurrentObservationRequestFactory {
  return {
    createScheduledRequest(input) {
      // Exactly one clock read per request; the epoch is forwarded to the selector unchanged.
      const referenceEpochMilliseconds = clock.nowEpochMilliseconds();

      // The selector owns the base-time policy (schedule-only by default). It is called exactly
      // once with a fresh one-key input and throws a RangeError verbatim for an invalid epoch —
      // this factory neither catches, re-wraps, re-validates, nor clones its result.
      const { baseDate, baseTime } = baseTimeSelector({
        referenceEpochMilliseconds,
      });

      // Explicit fields only — never spread `input`, so a runtime-injected extra property cannot
      // leak into the fixed request shape.
      return {
        baseDate,
        baseTime,
        nx: input.nx,
        ny: input.ny,
      };
    },
  };
}
