/**
 * Select the latest KMA (Korea Meteorological Administration) forecast issue time
 * (`base_date` / `base_time`) whose **documented API availability delay** has already elapsed at
 * a caller-supplied absolute instant.
 *
 * The sibling {@link selectLatestKmaForecastBaseTime} selects the latest issuance the official
 * *publication schedule* places at or before the reference — it makes no claim about when the
 * data reaches the 공공데이터포털 API. This function layers the guide's separate
 * `API 제공 시간` (availability delay) on top of that schedule:
 *
 * ```text
 * caller-supplied absolute instant
 *   → shift the reference into the past by the product's official API availability delay
 *   → reuse selectLatestKmaForecastBaseTime on the adjusted instant
 *   → { baseDate, baseTime }
 * ```
 *
 * Concretely, it selects the latest issuance for which
 * `official issuance time + product API availability delay ≤ reference instant`. The delays come
 * from the KMA guide — see `docs/kma-api-availability-time.md`
 * (`기상청_단기예보 조회서비스`, 공공데이터 ID `15084084`; API 허브 활용가이드
 * `단기예보조회서비스_API활용가이드_260623.docx`), whose `# 예보 발표시각` section documents the
 * publication schedule *and* the accompanying `API 제공 시간 (~ 이후)`:
 *
 * - 단기예보 (`getVilageFcst`): issued `0200/0500/…/2300`, provided `~02:10, ~05:10, …` — a fixed
 *   **10-minute** availability delay after each issuance.
 * - 초단기예보 (`getUltraSrtFcst`): issued each hour at `HH30`, provided `~HH45 이후` — a fixed
 *   **15-minute** availability delay after each issuance.
 *
 * The delay threshold is **inclusive**: at exactly `issuance + delay` the issuance becomes
 * selectable (e.g. SHORT `05:10:00.000` KST selects `0500`; `05:09:59.999` selects `0200`).
 *
 * This function does **not** re-implement any publication schedule, KST calendar, day/month/year
 * rollover, or year validation — all of that stays owned by {@link selectLatestKmaForecastBaseTime},
 * which this function composes twice (once on the original instant to reuse its validation
 * contract, once on the availability-adjusted instant to reuse its schedule selection). It only
 * subtracts a fixed, product-specific number of milliseconds before delegating.
 *
 * Like the schedule selector, this module is pure and deterministic: it never reads the system
 * clock, the environment, or the host locale/timezone; it performs no I/O; it holds no mutable
 * global state; it never mutates its input; and given the same input it always returns a fresh,
 * deep-equal result. KST is treated as a fixed `UTC+09:00` with no daylight saving time.
 *
 * It selects a **schedule-based availability candidate** only. It does **not** guarantee that the
 * upstream replication actually completed, that a call at this instant succeeds, that the issuance
 * exists, or that the page is non-empty — see `docs/kma-api-availability-time.md`. The name says
 * `AfterAvailabilityDelay`, not "available" or "ready", for exactly this reason.
 */

import { KmaForecastProduct } from './condition';
import {
  selectLatestKmaForecastBaseTime,
  type KmaForecastBaseTime,
  type SelectLatestKmaForecastBaseTimeInput,
} from './issue-time';

const MINUTE_IN_MILLISECONDS = 60_000;

/**
 * Official API availability delay for 단기예보 (`getVilageFcst`): the guide's `API 제공 시간`
 * lands `~10분` after each `0200/0500/…/2300` issuance (e.g. `0200` → `~02:10 이후`).
 */
const SHORT_FORECAST_API_AVAILABILITY_DELAY_MILLISECONDS =
  10 * MINUTE_IN_MILLISECONDS;

/**
 * Official API availability delay for 초단기예보 (`getUltraSrtFcst`): the guide's `API 제공 시간`
 * lands `~15분` after each `HH30` issuance (e.g. `0030` → `~00:45 이후`).
 */
const ULTRA_SHORT_FORECAST_API_AVAILABILITY_DELAY_MILLISECONDS =
  15 * MINUTE_IN_MILLISECONDS;

/**
 * The reference instant and forecast product to select an availability-delay-aware issue time
 * for. This is a deliberate **alias** of {@link SelectLatestKmaForecastBaseTimeInput}: the two
 * selectors share exactly the same input shape (`product` + `referenceEpochMilliseconds`), so
 * aliasing prevents the shapes from drifting apart and adds no new optional/safety-margin field.
 */
export type SelectLatestKmaForecastBaseTimeAfterAvailabilityDelayInput =
  SelectLatestKmaForecastBaseTimeInput;

/**
 * Resolve the official API availability delay (in milliseconds) for a product, rejecting any
 * value that is not one of the two supported `KmaForecastProduct` members. No arbitrary default
 * delay is applied to an unsupported product, and the message never echoes the caller's raw
 * (possibly secret-shaped) product value.
 */
function availabilityDelayMillisecondsFor(product: KmaForecastProduct): number {
  switch (product) {
    case KmaForecastProduct.SHORT_FORECAST:
      return SHORT_FORECAST_API_AVAILABILITY_DELAY_MILLISECONDS;
    case KmaForecastProduct.ULTRA_SHORT_FORECAST:
      return ULTRA_SHORT_FORECAST_API_AVAILABILITY_DELAY_MILLISECONDS;
    default:
      // Value-free: never echo the caller's raw (possibly secret-shaped) product value.
      throw new RangeError('product must be a supported KmaForecastProduct');
  }
}

/**
 * Select the latest KMA forecast `base_date` / `base_time` whose documented API availability
 * delay has already elapsed at `referenceEpochMilliseconds`, for the given `product`.
 *
 * The reference instant is shifted into the past by the product's fixed official availability
 * delay (단기예보 10분, 초단기예보 15분) and the latest scheduled issuance at or before that
 * adjusted instant is selected via {@link selectLatestKmaForecastBaseTime}. The threshold is
 * inclusive: exactly at `issuance + delay` selects that issuance, one millisecond earlier selects
 * the previous one. All KST calendar, day/month/year/leap-day rollover, and supported-year
 * validation is owned by the schedule selector and is not re-implemented here.
 *
 * Pure and deterministic; never reads the system clock; does not mutate `input`; returns a fresh
 * result object on every call.
 *
 * @throws RangeError with the schedule selector's existing contract — if
 *   `referenceEpochMilliseconds` is not a finite safe integer, denotes an instant outside the
 *   representable `Date` range, or has a KST calendar year outside `[1000, 9999]`; if the
 *   availability-adjusted selection rolls to a `base_date` year below that range (e.g. the
 *   `1000-01-01` lower bound rolling into `0999`); or if `product` is not a supported
 *   `KmaForecastProduct`. Every message names only the offending field or policy — it never
 *   echoes the raw input value, the adjusted epoch, the derived year, nor serializes the input.
 */
export function selectLatestKmaForecastBaseTimeAfterAvailabilityDelay(
  input: SelectLatestKmaForecastBaseTimeAfterAvailabilityDelayInput,
): KmaForecastBaseTime {
  // First selection on the ORIGINAL instant: reuse the schedule selector's existing validation
  // contract for the caller's absolute reference (epoch shape, Date range, KST year, product).
  selectLatestKmaForecastBaseTime(input);

  const delayMilliseconds = availabilityDelayMillisecondsFor(input.product);

  // Second selection on the availability-adjusted instant: reuse the schedule selection and
  // rollover/year validation for `reference - delay`. Subtracting a fixed number of milliseconds
  // keeps the input an absolute instant, so the selector still owns every calendar computation.
  return selectLatestKmaForecastBaseTime({
    product: input.product,
    referenceEpochMilliseconds: input.referenceEpochMilliseconds - delayMilliseconds,
  });
}
