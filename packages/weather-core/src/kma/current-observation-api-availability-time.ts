/**
 * Select the latest KMA (Korea Meteorological Administration) 초단기실황 (`getUltraSrtNcst`,
 * current observation) issue time (`base_date` / `base_time`) whose **project-defined
 * availability threshold** — modelled from the guide's documented approximate API provision time
 * — has already elapsed at a caller-supplied absolute instant.
 *
 * The sibling {@link selectLatestKmaCurrentObservationBaseTime} selects the latest issuance the
 * official *publication schedule* places at or before the reference — it makes no claim about
 * when the data reaches the 공공데이터포털 API. This function layers the project's deterministic
 * threshold, derived from the guide's separate approximate `API 제공 시간 (~ 이후)` guidance, on
 * top of that schedule:
 *
 * ```text
 * caller-supplied absolute instant
 *   → shift the reference into the past by the deterministic threshold modelled by this project
 *     from the guide's documented API provision time
 *   → reuse selectLatestKmaCurrentObservationBaseTime on the adjusted instant
 *   → { baseDate, baseTime }
 * ```
 *
 * Concretely, it selects the latest issuance for which
 * `official HH00 issuance + 10-minute threshold ≤ reference instant`. This threshold is derived
 * by this project from the KMA guide's approximate provision-time guidance — see
 * `docs/kma-current-observation-api-availability-time.md` (`기상청_단기예보 조회서비스`,
 * 공공데이터 ID `15084084`; 기상청41_단기예보 조회서비스_오픈API활용가이드_2607.zip), whose
 * `# 예보 발표시각` section (초단기실황 발표시각) documents the 매시간 정시 (`HH00`) publication
 * schedule *and* the accompanying approximate `API 제공 시간 (~이후)` guidance (`0000` →
 * `~00:10`, `0100` → `~01:10`, … , `2300` → `~23:10`). This project models that guidance as an
 * exact **10-minute** inclusive threshold after each issuance for deterministic selection.
 *
 * The threshold is **inclusive**: at exactly `issuance + 10 minutes` the issuance becomes
 * selectable (e.g. `05:10:00.000` KST selects `0500`; `05:09:59.999` selects `0400`). This exact
 * millisecond boundary is a deterministic project policy, not an official SLA.
 *
 * This function does **not** re-implement any publication schedule, KST calendar, day/month/year
 * rollover, or year validation — all of that stays owned by
 * {@link selectLatestKmaCurrentObservationBaseTime}, which this function composes twice (once on
 * the original instant to reuse its validation contract, once on the availability-adjusted
 * instant to reuse its schedule selection). It only subtracts a fixed number of milliseconds
 * before delegating.
 *
 * Like the schedule selector, this module is pure and deterministic: it never reads the system
 * clock, the environment, or the host locale/timezone; it performs no I/O; it holds no mutable
 * global state; it never mutates its input; and given the same input it always returns a fresh,
 * deep-equal result. KST is treated as a fixed `UTC+09:00` with no daylight saving time.
 *
 * It selects a **schedule-based availability candidate** only. It does **not** guarantee that the
 * upstream replication actually completed, that a call at this instant succeeds, that the
 * issuance exists, or that the page is non-empty — see
 * `docs/kma-current-observation-api-availability-time.md`. The name says `AfterAvailabilityDelay`,
 * not "available" or "ready", for exactly this reason.
 */

import {
  selectLatestKmaCurrentObservationBaseTime,
  type KmaCurrentObservationBaseTime,
  type SelectLatestKmaCurrentObservationBaseTimeInput,
} from './current-observation-issue-time.js';

const MINUTE_IN_MILLISECONDS = 60_000;

/**
 * Project threshold for 초단기실황 (`getUltraSrtNcst`), derived from the guide's approximate API
 * provision-time guidance (`HH00` → `~HH:10 이후`). The exact 10-minute millisecond threshold is
 * a deterministic project policy, not an official SLA.
 */
const CURRENT_OBSERVATION_API_AVAILABILITY_DELAY_MILLISECONDS = 10 * MINUTE_IN_MILLISECONDS;

/**
 * The reference instant to select an availability-delay-aware current-observation issue time
 * for. This is a deliberate **alias** of
 * {@link SelectLatestKmaCurrentObservationBaseTimeInput}: the two selectors share exactly the
 * same input shape (`referenceEpochMilliseconds`), so aliasing prevents the shapes from drifting
 * apart and adds no new optional/safety-margin field.
 */
export type SelectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelayInput =
  SelectLatestKmaCurrentObservationBaseTimeInput;

/**
 * Select the latest KMA 초단기실황 (`getUltraSrtNcst`) `base_date` / `base_time` whose
 * project-defined 10-minute availability threshold has already elapsed at
 * `referenceEpochMilliseconds`.
 *
 * The reference instant is shifted into the past by the deterministic 10-minute threshold
 * modelled by this project from the guide's approximate provision-time guidance, and the latest
 * scheduled issuance at or before that adjusted instant is selected via
 * {@link selectLatestKmaCurrentObservationBaseTime}. The threshold is inclusive: exactly at
 * `issuance + 10 minutes` selects that issuance, one millisecond earlier selects the previous
 * one. This exact millisecond inclusiveness is a project policy and does not guarantee that a
 * call at that instant actually succeeds or that the data is ready upstream. All KST calendar,
 * day/month/year/leap-day rollover, and supported-year validation is owned by the schedule
 * selector and is not re-implemented here.
 *
 * Pure and deterministic; never reads the system clock; does not mutate `input`; returns a fresh
 * result object on every call.
 *
 * @throws RangeError with the schedule selector's existing contract — if
 *   `referenceEpochMilliseconds` is not a finite safe integer, denotes an instant outside the
 *   representable `Date` range, or has a KST calendar year outside `[1000, 9999]`; or if the
 *   availability-adjusted selection rolls to a `base_date` year below that range (e.g. the
 *   `1000-01-01` lower bound rolling into `0999`). Every message names only the offending field
 *   or policy — it never echoes the raw input value, the adjusted epoch, the derived year, nor
 *   serializes the input.
 */
export function selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay(
  input: SelectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelayInput,
): KmaCurrentObservationBaseTime {
  // First selection on the ORIGINAL instant: reuse the schedule selector's existing validation
  // contract for the caller's absolute reference (epoch shape, Date range, KST year).
  selectLatestKmaCurrentObservationBaseTime(input);

  // Second selection on the availability-adjusted instant: reuse the schedule selection and
  // rollover/year validation for `reference - threshold`. Subtracting a fixed number of
  // milliseconds keeps the input an absolute instant, so the selector still owns every calendar
  // computation.
  return selectLatestKmaCurrentObservationBaseTime({
    referenceEpochMilliseconds:
      input.referenceEpochMilliseconds - CURRENT_OBSERVATION_API_AVAILABILITY_DELAY_MILLISECONDS,
  });
}
