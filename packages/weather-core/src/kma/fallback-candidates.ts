/**
 * Derive the two KMA (Korea Meteorological Administration) forecast issuance candidates a caller
 * needs to plan an availability-aware request plus a single one-step-back fallback, from one
 * caller-supplied absolute instant:
 *
 * - `primary` — exactly what the PR #14 availability-delay selector
 *   ({@link selectLatestKmaForecastBaseTimeAfterAvailabilityDelay}) picks at the reference instant:
 *   the latest issuance whose project-defined availability threshold has already elapsed.
 * - `previous` — the one official scheduled issuance immediately before `primary`, i.e. the single
 *   candidate a later PR may fall back to once when a no-data or publication-in-progress condition
 *   is detected for `primary`.
 *
 * ```text
 * caller-supplied absolute instant
 *   → PR #14 availability-delay selector on the original reference        → primary
 *   → subtract exactly one product-specific issuance interval, then reuse
 *     the same PR #14 selector on the shifted reference                   → previous
 *   → { primary, previous }
 * ```
 *
 * This module owns **only** one product policy: the uniform issuance interval of each product's
 * current official schedule — SHORT 3 hours, ULTRA 1 hour. Every schedule array, the KST calendar,
 * day/month/year/leap-day rollover, supported-year validation, and the availability thresholds
 * (SHORT 10 minutes, ULTRA 15 minutes) stay owned by the PR #8 schedule selector and the PR #14
 * availability-delay selector, which this module composes twice.
 *
 * Why subtracting one interval is enough: the current official schedules are uniform per product
 * (SHORT always 3 h, ULTRA always 1 h) and the PR #14 threshold is the same for every issuance of a
 * product, so moving the absolute reference back by exactly one issuance interval moves the
 * availability bucket back by exactly one issuance. There is no need to re-parse `primary`'s
 * formatted `base_date` / `base_time` back into an epoch, to duplicate a schedule array, or to
 * compute a KST calendar rollover here.
 *
 * Like the two selectors it composes, this module is pure and deterministic: it never reads the
 * system clock, the environment, or the host locale/timezone; it performs no I/O; it holds no
 * mutable global state; it never mutates its input; and given the same input it always returns a
 * fresh, deep-equal result. It performs **no** provider call, second HTTP request, retry, fallback
 * orchestration, upstream result-code / total-count / empty-forecast-list / normalization-failure
 * classification, or live availability probe — it only produces the two candidates a later
 * orchestration PR may act on. KST is treated as a fixed `UTC+09:00` with no daylight saving time.
 */

import { KmaForecastProduct } from './condition';
import { type KmaForecastBaseTime } from './issue-time';
import {
  selectLatestKmaForecastBaseTimeAfterAvailabilityDelay,
  type SelectLatestKmaForecastBaseTimeAfterAvailabilityDelayInput,
} from './api-availability-time';

const HOUR_IN_MILLISECONDS = 3_600_000;

/**
 * Uniform issuance interval of the current official `SHORT_FORECAST` (`getVilageFcst`) schedule:
 * `0200/0500/…/2300` KST, i.e. every 3 hours (the `2300 → 0200` day boundary is 3 hours too). This
 * is the current publication cadence, not an availability threshold.
 */
const SHORT_FORECAST_ISSUANCE_INTERVAL_MILLISECONDS = 3 * HOUR_IN_MILLISECONDS;

/**
 * Uniform issuance interval of the current official `ULTRA_SHORT_FORECAST` (`getUltraSrtFcst`)
 * schedule: once per hour at `HH30` KST, i.e. every 1 hour (the `2330 → 0030` day boundary is 1 hour too).
 * This is the current publication cadence, not an availability threshold.
 */
const ULTRA_SHORT_FORECAST_ISSUANCE_INTERVAL_MILLISECONDS = 1 * HOUR_IN_MILLISECONDS;

/**
 * The reference instant and forecast product to derive availability-aware candidates for. This is a
 * deliberate **alias** of {@link SelectLatestKmaForecastBaseTimeAfterAvailabilityDelayInput} (itself
 * an alias of the schedule selector's input): the candidate function shares exactly the same input
 * shape (`product` + `referenceEpochMilliseconds`), so aliasing prevents the shapes from drifting
 * apart and adds no new optional field.
 */
export type SelectKmaForecastBaseTimeCandidatesAfterAvailabilityDelayInput =
  SelectLatestKmaForecastBaseTimeAfterAvailabilityDelayInput;

/**
 * The availability-aware primary issuance and its immediately-preceding scheduled issuance. Each
 * candidate reuses the existing {@link KmaForecastBaseTime} shape; the result carries exactly these
 * two keys and no error union, retry result, attempt metadata, array, or `fallbackUsed`-style flag.
 */
export interface KmaForecastBaseTimeCandidates {
  /** The PR #14 availability-delay selection at the reference instant. */
  readonly primary: KmaForecastBaseTime;
  /** The single official scheduled issuance immediately before {@link primary}. */
  readonly previous: KmaForecastBaseTime;
}

/**
 * Resolve the uniform issuance interval (in milliseconds) of a product's current official schedule,
 * rejecting any value that is not one of the two supported `KmaForecastProduct` members. No
 * arbitrary default interval is applied, and the message never echoes the caller's raw (possibly
 * secret-shaped) product value.
 *
 * In the normal path the public function first calls the PR #14 selector on the original input,
 * which already validates the product, so this helper only re-resolves the interval for an
 * already-validated product; its `RangeError` default branch is a defensive guard, and product /
 * epoch validation ordering on the happy path follows the existing selector contract.
 */
function issuanceIntervalMillisecondsFor(product: KmaForecastProduct): number {
  switch (product) {
    case KmaForecastProduct.SHORT_FORECAST:
      return SHORT_FORECAST_ISSUANCE_INTERVAL_MILLISECONDS;
    case KmaForecastProduct.ULTRA_SHORT_FORECAST:
      return ULTRA_SHORT_FORECAST_ISSUANCE_INTERVAL_MILLISECONDS;
    default:
      // Value-free: never echo the caller's raw (possibly secret-shaped) product value.
      throw new RangeError('product must be a supported KmaForecastProduct');
  }
}

/**
 * Derive the availability-aware `primary` issuance and its immediately-preceding `previous`
 * scheduled issuance from a caller-supplied absolute instant, for the given `product`.
 *
 * `primary` is the PR #14 availability-delay selection at `referenceEpochMilliseconds`. `previous`
 * reuses the same PR #14 selector on `referenceEpochMilliseconds` shifted back by exactly one
 * product-specific issuance interval (SHORT 3 h, ULTRA 1 h). Because the current official schedule
 * and the availability threshold are uniform per product, this lands `previous` on exactly the
 * issuance before `primary`. No schedule array, KST calendar, rollover, or year validation is
 * re-implemented here — all of it stays owned by the composed selectors.
 *
 * Pure and deterministic; never reads the system clock; does not mutate `input`; returns a fresh
 * wrapper whose `primary` and `previous` are distinct object references (and always distinct
 * issuances) on every call.
 *
 * @throws RangeError with the PR #14 selector's existing contract, propagated verbatim — if
 *   `referenceEpochMilliseconds` is not a finite safe integer, denotes an instant outside the
 *   representable `Date` range, or has a KST calendar year outside `[1000, 9999]`; if the `primary`
 *   or the `previous` availability-adjusted selection rolls to a `base_date` year below that range
 *   (e.g. the `1000-01-01` lower bound whose `previous` lands in `0999`); or if `product` is not a
 *   supported `KmaForecastProduct`. The whole call throws — it never returns a partial result with
 *   only `primary`. Every message names only the offending field or policy; it never echoes the raw
 *   input value, the derived epoch/year, nor serializes the input.
 */
export function selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay(
  input: SelectKmaForecastBaseTimeCandidatesAfterAvailabilityDelayInput,
): KmaForecastBaseTimeCandidates {
  // First selection on the ORIGINAL instant: reuse the PR #14 selector (and, through it, the
  // schedule selector's validation contract) for the caller's absolute reference. This is `primary`.
  const primary = selectLatestKmaForecastBaseTimeAfterAvailabilityDelay(input);

  const issuanceIntervalMilliseconds = issuanceIntervalMillisecondsFor(input.product);

  // Second selection on the original reference shifted back by exactly one issuance interval, with a
  // fresh two-key input. The PR #14 selector applies the same availability threshold, so `previous`
  // is the single scheduled issuance immediately before `primary`. Subtracting a fixed number of
  // milliseconds keeps the input an absolute instant, so the selectors still own every calendar
  // computation and reject a lower-bound rollover into an unsupported year.
  const previous = selectLatestKmaForecastBaseTimeAfterAvailabilityDelay({
    product: input.product,
    referenceEpochMilliseconds:
      input.referenceEpochMilliseconds - issuanceIntervalMilliseconds,
  });

  return { primary, previous };
}
