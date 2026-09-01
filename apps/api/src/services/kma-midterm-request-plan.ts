/**
 * The KMA (기상청) mid-term **request-plan factory**: the application-level component that combines
 * an **injected clock** and an **injectable issuance selector** (defaulting to the PR #99 pure
 * weather-core selector, {@link selectLatestKmaMidtermIssuance}) with caller-supplied `regId`s into a
 * **pair** of complete {@link KmaMidtermForecastRequest}s — one `TEMPERATURE` (`getMidTa`) request and
 * one `LAND` (`getMidLandFcst`) request.
 *
 * Pipeline it assembles:
 *
 * ```text
 * injected clock
 *   → reference epoch milliseconds                          // read exactly once
 *   → issuance selector   // default: selectLatestKmaMidtermIssuance (PR #99) → { tmFc }
 *   → combine that one tmFc with caller-supplied temperatureRegId / landRegId
 *   → { temperature: KmaMidtermForecastRequest, land: KmaMidtermForecastRequest }
 * ```
 *
 * The two requests share the **same** absolute reference and the **same** selected `tmFc`: the clock
 * is read once and the selector is called once, so `temperature.tmFc === land.tmFc` for every
 * successfully-created plan. This factory does **not** call a single-request factory twice — doing so
 * could read the clock twice and let `temperature`/`land` straddle the official 06:00/18:00 KST
 * issuance boundary, producing two requests for two different issuances. That single-reference
 * invariant is the entire reason this component is a request **plan** factory rather than two calls to
 * a per-operation factory.
 *
 * Why this factory lives in `apps/api/src/services`: reading "now" is an application/server-layer
 * concern, and the result requests are the provider boundary's {@link KmaMidtermForecastRequest}, so
 * the factory bridges the injected clock and the `weather-core` issuance selector into requests. The
 * issuance schedule rule stays owned by the `weather-core` selector; the provider must never read a
 * clock or call the selector on its own; and `weather-core` must never import an `apps/api` type.
 *
 * Deliberately narrow — this factory builds a *request plan* and nothing more. It does **not** call
 * the provider, resolve a `regId` from a location/administrative area/coordinate, re-validate the
 * request (the provider still owns runtime request validation), or add retry/fallback/availability-delay
 * policy. It is schedule-only: {@link selectLatestKmaMidtermIssuance} makes no claim that upstream
 * `MidFcstInfoService` data is actually ready at the selected `tmFc`.
 *
 * Clock policy: the factory never reads any system/wall clock, high-resolution timer, or ambient time
 * source, and provides **no** default clock — the clock is always injected. Construction calls the
 * clock and the selector **zero** times; each `createScheduledRequestPlan()` call reads the clock
 * **exactly once**, with no argument, and calls the issuance selector **exactly once** with the clock's
 * epoch value forwarded verbatim (no rounding, truncation, or coercion) in a fresh
 * `{ referenceEpochMilliseconds }` object.
 *
 * Error policy: this factory introduces **no** new result union and **no** new error type. A clock
 * error and a selector `RangeError` (invalid epoch, out-of-range year) propagate **verbatim** — the
 * same error reference, never caught, wrapped, re-messaged, or logged, and never a partial plan. See
 * `docs/kma-midterm-request-plan.md`.
 */

import {
  selectLatestKmaMidtermIssuance,
  type KmaMidtermIssuance,
  type SelectLatestKmaMidtermIssuanceInput,
} from '@life-weather/weather-core';

import type { KmaMidtermForecastRequest } from '../providers/kma/index.js';

/**
 * The injected clock. Its single method returns the current instant as absolute epoch milliseconds
 * (UTC). The factory calls it with **no argument** and treats the returned value as-is — it never
 * reads a clock of its own, so this is the only source of "now".
 */
export interface KmaMidtermRequestClock {
  readonly nowEpochMilliseconds: () => number;
}

/**
 * The pluggable issuance-selection policy: given a `{ referenceEpochMilliseconds }` input, it returns
 * the selected `{ tmFc }`. Structurally this is exactly the call signature of `weather-core`'s pure
 * PR #99 selector ({@link selectLatestKmaMidtermIssuance}), so it can be injected without an adapter.
 * The factory treats the selector as an opaque function: it neither re-validates, clones, spreads, nor
 * transforms the result, and never catches, wraps, or logs an error the selector throws.
 */
export type KmaMidtermIssuanceSelector = (
  input: SelectLatestKmaMidtermIssuanceInput,
) => KmaMidtermIssuance;

/**
 * The caller-supplied part of a request plan: the two separately-named `regId`s. `TEMPERATURE`
 * (`getMidTa`) and `LAND` (`getMidLandFcst`) use different official 중기예보 구역코드 code sets, so
 * this factory neither infers one from the other nor picks either from a location/administrative
 * area/coordinate — both remain caller-supplied, typed primitives passed through unchanged.
 */
export interface KmaMidtermRequestPlanFactoryInput {
  readonly temperatureRegId: string;
  readonly landRegId: string;
}

/**
 * The plan: one `TEMPERATURE` request and one `LAND` request sharing exactly one selected `tmFc`. The
 * plan carries exactly these two keys — no eligibility flag, reference epoch, issuance object, or
 * error/result union — it is a pure pre-execution assembly.
 */
export interface KmaMidtermRequestPlan {
  readonly temperature: KmaMidtermForecastRequest;
  readonly land: KmaMidtermForecastRequest;
}

/** The factory's single public method. */
export interface KmaMidtermRequestPlanFactory {
  /**
   * Build a complete {@link KmaMidtermRequestPlan} for the given `input`, dating both requests to the
   * single `tmFc` the factory's issuance selector picks at the injected clock's current instant. Reads
   * the clock **exactly once**, calls the issuance selector **exactly once**, and returns a **fresh**
   * plan (with fresh, distinct `temperature` and `land` request objects) every call.
   */
  createScheduledRequestPlan(
    input: KmaMidtermRequestPlanFactoryInput,
  ): KmaMidtermRequestPlan;
}

/**
 * Create a mid-term request-plan factory bound to an injected {@link KmaMidtermRequestClock} and an
 * optional {@link KmaMidtermIssuanceSelector}. When `issuanceSelector` is omitted it defaults to the
 * PR #99 {@link selectLatestKmaMidtermIssuance} schedule-only selector, so the historical
 * one-argument call keeps its exact behaviour. No availability-delay policy exists for this service
 * yet, so this factory neither invents one nor imports one.
 *
 * Pure construction: it does **not** call the clock, call the selector, read the environment, perform
 * I/O, register a listener, or start a timer — the returned object merely closes over `clock` and
 * `issuanceSelector`. The same instance is safe to call many times; it holds no mutable state and each
 * call is independent of any previous one.
 */
export function createKmaMidtermRequestPlanFactory(
  clock: KmaMidtermRequestClock,
  issuanceSelector: KmaMidtermIssuanceSelector = selectLatestKmaMidtermIssuance,
): KmaMidtermRequestPlanFactory {
  return {
    createScheduledRequestPlan(input) {
      // Exactly one clock read per plan; the epoch is forwarded to the selector unchanged. Both
      // requests are dated from this single reference and this single selected tmFc, so TEMPERATURE
      // and LAND can never straddle the 06:00/18:00 KST issuance boundary the way two independent
      // clock reads (or two independent single-request factory calls) could.
      const referenceEpochMilliseconds = clock.nowEpochMilliseconds();

      // The selector owns the issuance policy (schedule-only). It is called exactly once with a
      // fresh one-key input and throws a RangeError verbatim for an invalid epoch — this factory
      // neither catches, re-wraps, re-validates, nor clones its result.
      const { tmFc } = issuanceSelector({ referenceEpochMilliseconds });

      // Explicit fields only — never spread `input`, so a runtime-injected extra property cannot
      // leak into either fixed request shape. `temperature` and `land` are always distinct
      // freshly-allocated objects sharing exactly one tmFc.
      return {
        temperature: {
          operation: 'TEMPERATURE',
          regId: input.temperatureRegId,
          tmFc,
        },
        land: {
          operation: 'LAND',
          regId: input.landRegId,
          tmFc,
        },
      };
    },
  };
}
