/**
 * The KMA (기상청) forecast-request **factory**: the application-level component that combines an
 * **injected clock**, an **injectable base-time selector** (defaulting to the PR #8 scheduled
 * issue-time selector), and caller-supplied grid coordinates into a complete
 * {@link KmaForecastRequest}.
 *
 * Pipeline it assembles:
 *
 * ```text
 * injected clock
 *   → reference epoch milliseconds
 *   → base-time selector   // default: selectLatestKmaForecastBaseTime (PR #8) → baseDate / baseTime
 *   → combine with caller-supplied product / nx / ny
 *   → complete KmaForecastRequest
 * ```
 *
 * Selector policy: the factory is **selector-agnostic**. When the second argument is omitted it uses
 * the PR #8 {@link selectLatestKmaForecastBaseTime} schedule-only selector — the historical
 * one-argument default, which is unchanged and makes **no** claim about API availability. A caller
 * may instead inject any {@link KmaForecastBaseTimeSelector}; the production composition injects the
 * PR #14 availability-delay selector as its explicit production choice. Choosing an availability
 * policy is a **composition** responsibility — this factory neither imports the PR #14 selector nor
 * hard-codes any availability threshold.
 *
 * Why it lives in `apps/api/src/services` and not in `providers/kma`: reading "now" is an
 * application/server-layer concern and the result type is the provider boundary's
 * {@link KmaForecastRequest}, so the factory bridges two layers. The publication *schedule* rule is
 * owned by the `weather-core` selector; the provider must never read a clock or call the selector on
 * its own; and `weather-core` must never import an `apps/api` type. The allowed direction is
 * `apps/api services → @life-weather/weather-core` and `apps/api services → providers/kma`
 * (type-only).
 *
 * Deliberately narrow: this factory assembles a *request* and nothing more. It does **not** call the
 * provider, wire the hourly service, convert lat/long → grid, re-validate the request (the provider
 * still owns runtime request validation), or add retry/fallback. The method is named
 * `createScheduledRequest` — not `createAvailableRequest` — precisely because the default selector
 * picks the latest *scheduled* issuance and even an injected availability-delay selector makes **no**
 * claim that the upstream API data is actually ready.
 *
 * Clock policy: the factory never reads any system/wall clock, high-resolution timer, or ambient
 * time source, and provides **no** default clock — the clock is always injected. Construction calls
 * the clock and the selector **zero** times; each `createScheduledRequest()` call reads the clock
 * **exactly once**, with no argument, and calls the selector **exactly once** with the clock's epoch
 * value forwarded verbatim (no rounding, truncation, or coercion).
 *
 * Error policy: this factory introduces **no** new result union and **no** new error type. A
 * selector `RangeError` (invalid epoch, unsupported product, out-of-range year) and any error the
 * injected clock throws propagate **verbatim** — the same error reference, never caught, wrapped,
 * re-messaged, or logged. Surfacing a collaborator's programmer/configuration error as an invented
 * domain result is explicitly out of scope. See `docs/kma-forecast-request-factory.md`.
 */

import {
  selectLatestKmaForecastBaseTime,
  type KmaForecastBaseTime,
  type KmaForecastProduct,
  type SelectLatestKmaForecastBaseTimeInput,
} from '@life-weather/weather-core';

import type { KmaForecastRequest } from '../providers/kma';

/**
 * The injected clock. Its single method returns the current instant as absolute epoch milliseconds
 * (UTC). The factory calls it with **no argument** and treats the returned value as-is — it never
 * reads a clock of its own, so this is the only source of "now".
 */
export interface KmaForecastRequestClock {
  readonly nowEpochMilliseconds: () => number;
}

/**
 * The pluggable base-time selection policy: given a `{ product, referenceEpochMilliseconds }` input,
 * it returns the request's `baseDate` / `baseTime`. Structurally this is exactly the call signature
 * of `weather-core`'s pure selectors — {@link selectLatestKmaForecastBaseTime} (the schedule-only
 * default) and `selectLatestKmaForecastBaseTimeAfterAvailabilityDelay` (the production choice, wired
 * by the composition root) — so either can be injected without an adapter. The factory treats the
 * selector as an opaque function: it neither re-validates, clones, spreads, nor transforms the
 * result, and never catches, wraps, or logs an error the selector throws.
 */
export type KmaForecastBaseTimeSelector = (
  input: SelectLatestKmaForecastBaseTimeInput,
) => KmaForecastBaseTime;

/**
 * The caller-supplied part of a request: the forecast product and the **already-computed** KMA grid
 * point. The factory assumes a valid, typed grid coordinate is supplied here. Latitude/longitude
 * conversion occurs upstream in the PR #12/#13 location pipeline; this factory accepts the
 * already-computed `nx`/`ny` and does not transform, round, clamp, swap, stringify, or default them.
 * The runtime trust-boundary validation of these values stays with the provider.
 */
export interface KmaForecastRequestFactoryInput {
  readonly product: KmaForecastProduct;
  readonly nx: number;
  readonly ny: number;
}

/** The factory's single public method. */
export interface KmaForecastRequestFactory {
  /**
   * Build a complete {@link KmaForecastRequest} for the given `input`, dating it to the issuance the
   * factory's base-time selector picks at the injected clock's current instant. Reads the clock
   * **exactly once**, calls the selector **exactly once**, and returns a **fresh** request object
   * every call.
   */
  createScheduledRequest(
    input: KmaForecastRequestFactoryInput,
  ): KmaForecastRequest;
}

/**
 * Create a request factory bound to an injected {@link KmaForecastRequestClock} and an optional
 * {@link KmaForecastBaseTimeSelector}. When `baseTimeSelector` is omitted it defaults to the PR #8
 * {@link selectLatestKmaForecastBaseTime} schedule-only selector, so the historical one-argument
 * call keeps its exact behaviour. The production composition injects the PR #14 availability-delay
 * selector here as its explicit production choice.
 *
 * Pure construction: it does **not** call the clock, call the selector, read the environment,
 * perform I/O, register a listener, or start a timer — the returned object merely closes over
 * `clock` and `baseTimeSelector`. The same instance is safe to call many times; it holds no mutable
 * state and each call is independent of any previous one.
 */
export function createKmaForecastRequestFactory(
  clock: KmaForecastRequestClock,
  baseTimeSelector: KmaForecastBaseTimeSelector = selectLatestKmaForecastBaseTime,
): KmaForecastRequestFactory {
  return {
    createScheduledRequest(input) {
      // Exactly one clock read per request; the epoch is forwarded to the selector unchanged.
      const referenceEpochMilliseconds = clock.nowEpochMilliseconds();

      // The selector owns the base-time policy (schedule-only by default; availability-delay-aware
      // when the composition injects the PR #14 selector). It is called exactly once with a fresh
      // two-key input and throws a RangeError verbatim for an invalid epoch or an unsupported
      // product — this factory neither catches, re-wraps, re-validates, nor clones its result.
      const { baseDate, baseTime } = baseTimeSelector({
        product: input.product,
        referenceEpochMilliseconds,
      });

      // Explicit fields only — never spread `input`, so a runtime-injected extra property cannot
      // leak into the fixed request shape.
      return {
        product: input.product,
        baseDate,
        baseTime,
        nx: input.nx,
        ny: input.ny,
      };
    },
  };
}
