/**
 * The KMA (기상청) current-observation (초단기실황, `getUltraSrtNcst`) **request factory**: the
 * application-level component that combines an **injected clock** with the PR #64 pure
 * weather-core selector (`selectLatestKmaCurrentObservationBaseTime`) and caller-supplied grid
 * coordinates into a complete {@link KmaCurrentObservationRequest}.
 *
 * This is the current-observation counterpart of `kma-forecast-request.ts` (the PR #9 forecast
 * request factory) — a **separate**, parallel factory, not a generalization of it. It differs in
 * the same two ways the current-observation request/selector already differ from their forecast
 * siblings: there is no `product` choice (초단기실황 is a single operation) and there is no
 * injectable base-time-selector seam, because no current-observation availability-delay selector
 * exists yet — [kma-current-observation-issue-time.md](../../../docs/kma-current-observation-issue-time.md)
 * documents that counterpart as explicitly out of scope. Should one be added later, an injectable
 * seam can be added to this factory then; adding an unused seam now would be speculative.
 *
 * Pipeline it assembles:
 *
 * ```text
 * injected clock
 *   → reference epoch milliseconds
 *   → selectLatestKmaCurrentObservationBaseTime (PR #64) → baseDate / baseTime
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
 * `createAvailableRequest` — because the selector picks the latest *scheduled* issuance and makes
 * **no** claim that the upstream API data is actually ready.
 *
 * Clock policy: the factory never reads any system/wall clock, high-resolution timer, or ambient
 * time source, and provides **no** default clock — the clock is always injected. Construction
 * calls the clock **zero** times; each `createScheduledRequest()` call reads the clock **exactly
 * once**, with no argument, and calls the selector **exactly once** with the clock's epoch value
 * forwarded verbatim (no rounding, truncation, or coercion).
 *
 * Error policy: this factory introduces **no** new result union and **no** new error type. A
 * selector `RangeError` (invalid epoch, out-of-range year) and any error the injected clock throws
 * propagate **verbatim** — the same error reference, never caught, wrapped, re-messaged, or
 * logged. See `docs/kma-current-observation-request-factory.md`.
 */

import { selectLatestKmaCurrentObservationBaseTime } from '@life-weather/weather-core';

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
   * issuance {@link selectLatestKmaCurrentObservationBaseTime} picks at the injected clock's
   * current instant. Reads the clock **exactly once** and returns a **fresh** request object
   * every call.
   */
  createScheduledRequest(
    input: KmaCurrentObservationRequestFactoryInput,
  ): KmaCurrentObservationRequest;
}

/**
 * Create a request factory bound to an injected {@link KmaCurrentObservationRequestClock}.
 *
 * Pure construction: it does **not** call the clock, read the environment, perform I/O, register
 * a listener, or start a timer — the returned object merely closes over `clock`. The same
 * instance is safe to call many times; it holds no mutable state and each call is independent of
 * any previous one.
 */
export function createKmaCurrentObservationRequestFactory(
  clock: KmaCurrentObservationRequestClock,
): KmaCurrentObservationRequestFactory {
  return {
    createScheduledRequest(input) {
      // Exactly one clock read per request; the epoch is forwarded to the selector unchanged.
      const referenceEpochMilliseconds = clock.nowEpochMilliseconds();

      // The PR #64 selector owns the base-time policy (schedule-only, no product). It throws a
      // RangeError verbatim for an invalid epoch — this factory neither catches, re-wraps,
      // re-validates, nor clones its result.
      const { baseDate, baseTime } = selectLatestKmaCurrentObservationBaseTime({
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
