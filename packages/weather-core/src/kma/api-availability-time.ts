/**
 * Select the latest KMA (Korea Meteorological Administration) forecast issue time
 * (`base_date` / `base_time`) whose **project-defined availability threshold** — modelled from the
 * guide's documented approximate API provision time — has already elapsed at a caller-supplied
 * absolute instant.
 *
 * The sibling {@link selectLatestKmaForecastBaseTime} selects the latest issuance the official
 * *publication schedule* places at or before the reference — it makes no claim about when the
 * data reaches the 공공데이터포털 API. This function layers the project's deterministic threshold,
 * derived from the guide's separate approximate `API 제공 시간 (~ 이후)` guidance, on top of that
 * schedule:
 *
 * ```text
 * caller-supplied absolute instant
 *   → shift the reference into the past by the product-specific deterministic threshold modelled
 *     by this project from the guide's documented API provision time
 *   → reuse selectLatestKmaForecastBaseTime on the adjusted instant
 *   → { baseDate, baseTime }
 * ```
 *
 * Concretely, it selects the latest issuance for which
 * `official issuance time + product-specific threshold ≤ reference instant`. These thresholds are
 * derived by this project from the KMA guide's approximate provision-time guidance — see
 * `docs/kma-api-availability-time.md` (`기상청_단기예보 조회서비스`, 공공데이터 ID `15084084`; API
 * 허브 활용가이드 `단기예보조회서비스_API활용가이드_260623.docx`), whose `# 예보 발표시각` section
 * documents the publication schedule *and* the accompanying approximate `API 제공 시간 (~ 이후)`:
 *
 * - 단기예보 (`getVilageFcst`): issued `0200/0500/…/2300`, and the guide lists provision times such
 *   as `~02:10 이후` for a `0200` issuance. This project models that guidance as an exact
 *   **10-minute** inclusive threshold after each issuance for deterministic selection.
 * - 초단기예보 (`getUltraSrtFcst`): issued each hour at `HH30`, and the guide lists `~HH45 이후`.
 *   This project models that guidance as an exact **15-minute** inclusive threshold after each
 *   issuance.
 *
 * The threshold is **inclusive**: at exactly `issuance + threshold` the issuance becomes
 * selectable (e.g. SHORT `05:10:00.000` KST selects `0500`; `05:09:59.999` selects `0200`). This
 * exact millisecond boundary is a deterministic project policy, not an official SLA.
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
 * Project threshold for `SHORT_FORECAST` (`getVilageFcst`), derived from the guide's approximate
 * API provision-time guidance (`0200` → `~02:10 이후`). The exact 10-minute millisecond threshold
 * is a deterministic project policy, not an official SLA.
 */
const SHORT_FORECAST_API_AVAILABILITY_DELAY_MILLISECONDS =
  10 * MINUTE_IN_MILLISECONDS;

/**
 * Project threshold for `ULTRA_SHORT_FORECAST` (`getUltraSrtFcst`), derived from the guide's
 * approximate API provision-time guidance (`HH30` → `~HH45 이후`). The exact 15-minute millisecond
 * threshold is a deterministic project policy, not an official SLA.
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
 * Resolve the project-defined availability threshold (in milliseconds) for a product, derived from
 * the official guide's documented approximate API provision times, rejecting any value that is not
 * one of the two supported `KmaForecastProduct` members. No arbitrary default threshold is applied
 * to an unsupported product, and the message never echoes the caller's raw (possibly secret-shaped)
 * product value.
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
 * Select the latest KMA forecast `base_date` / `base_time` whose project-defined availability
 * threshold has already elapsed at `referenceEpochMilliseconds`, for the given `product`.
 *
 * The reference instant is shifted into the past by the product-specific deterministic threshold
 * modelled by this project from the guide's approximate provision-time guidance (단기예보 10분,
 * 초단기예보 15분) and the latest scheduled issuance at or before that adjusted instant is selected
 * via {@link selectLatestKmaForecastBaseTime}. The threshold is inclusive: exactly at
 * `issuance + threshold` selects that issuance, one millisecond earlier selects the previous one.
 * This exact millisecond inclusiveness is a project policy and does not guarantee that a call at
 * that instant actually succeeds or that the data is ready upstream. All KST calendar,
 * day/month/year/leap-day rollover, and supported-year validation is owned by the schedule selector
 * and is not re-implemented here.
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
