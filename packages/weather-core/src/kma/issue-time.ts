/**
 * Select the latest **scheduled** KMA (Korea Meteorological Administration) forecast issue
 * time (`base_date` / `base_time`) for a caller-supplied absolute instant.
 *
 * The official publication schedule comes from the KMA guide — see `docs/kma-issue-time.md`
 * (`기상청_단기예보 조회서비스`, 공공데이터 ID `15084084`; API 허브 활용가이드
 * `단기예보조회서비스_API활용가이드_260623.docx`). The guide lists, under `# 예보 발표시각`:
 *
 * - 단기예보 (`getVilageFcst`): `Base_time: 0200, 0500, 0800, 1100, 1400, 1700, 2000, 2300`
 *   (`1일 8회`), labeled `발표시각(KST)`.
 * - 초단기예보 (`getUltraSrtFcst`): `매시간 30분에 생성` — one issuance per hour at `HH30`
 *   (`0030, 0130, … , 2330`), 24 times a day.
 *
 * This selects the latest issuance that the publication *schedule* places at or before the
 * reference instant. It makes **no** claim about API availability: the guide's separate
 * `API 제공 시간` (e.g. 단기예보 `~02:10 이후`, 초단기예보 `~HH45 이후`) — the publication /
 * replication lag — is deliberately out of scope here. See `docs/kma-issue-time.md` for the
 * availability boundary. The function name says `LatestKmaForecastBaseTime`, not "available"
 * or "ready", for exactly this reason.
 *
 * This module is pure and deterministic: it never reads the system clock (`Date.now()`), the
 * environment, or the host locale/timezone; it performs no I/O; it holds no mutable global
 * state; it never mutates its input; and given the same input it always returns a fresh,
 * deep-equal result. KST is treated as a fixed `UTC+09:00` with no daylight saving time, so
 * the KST calendar is read via `Date`'s **UTC** getters on an offset-shifted instant — never
 * via host-local getters (`getHours`, `getDate`, …) or `Intl`.
 */

import { KmaForecastProduct } from './condition';

const MINUTE_IN_MS = 60_000;
const HOUR_IN_MS = 3_600_000;
const DAY_IN_MS = 86_400_000;

/** KST is a fixed offset of `UTC+09:00` with no daylight saving time. */
const KST_OFFSET_IN_MS = 9 * HOUR_IN_MS;

/**
 * The smallest `YYYYMMDD` year that formats to exactly four digits, and the largest. Both the
 * reference instant's KST calendar year AND the final selected `base_date` year must fall
 * within `[MIN_API_YEAR, MAX_API_YEAR]`: a previous-day rollover below the day's first issue
 * time can move the selected `base_date` one calendar year earlier than the reference (at the
 * `1000-01-01` lower bound it would land in `0999`), and such an out-of-range result is
 * rejected rather than emitted, clamped, or truncated. Anything outside the range cannot
 * produce a valid four-digit `base_date` year and is a programmer/configuration error.
 */
const MIN_API_YEAR = 1000;
const MAX_API_YEAR = 9999;

/**
 * Official 단기예보 (`getVilageFcst`) issue times as minutes past KST midnight, ascending:
 * `0200, 0500, 0800, 1100, 1400, 1700, 2000, 2300`.
 */
const SHORT_FORECAST_MINUTES_OF_DAY: readonly number[] = [
  2 * 60, // 0200
  5 * 60, // 0500
  8 * 60, // 0800
  11 * 60, // 1100
  14 * 60, // 1400
  17 * 60, // 1700
  20 * 60, // 2000
  23 * 60, // 2300
];

/**
 * Official 초단기예보 (`getUltraSrtFcst`) issue times as minutes past KST midnight, ascending:
 * one per hour at `HH30` — `0030, 0130, … , 2330` (24 a day). This is a single hourly
 * issuance at minute 30, **not** two issuances per hour, and is distinct from 초단기실황
 * (`getUltraSrtNcst`, `매시간 정시`/`HH00`), which is out of scope for this selector.
 */
const ULTRA_SHORT_FORECAST_MINUTES_OF_DAY: readonly number[] = Array.from(
  { length: 24 },
  (_value, hour) => hour * 60 + 30,
);

/**
 * Which forecast product to select an issue time for, and the absolute instant to measure
 * against.
 */
export interface SelectLatestKmaForecastBaseTimeInput {
  /** The KMA forecast product whose official publication schedule to apply. */
  readonly product: KmaForecastProduct;
  /**
   * The reference instant as absolute epoch milliseconds (UTC). Host-timezone independent —
   * the same instant yields the same result regardless of where the caller runs. Must be a
   * finite, safe integer that denotes an instant representable by `Date` whose KST calendar
   * year is in `[1000, 9999]`.
   */
  readonly referenceEpochMilliseconds: number;
}

/**
 * A KMA request's `base_date` / `base_time`, ready to place into a `KmaForecastRequest`.
 * Both are fixed-width, digit-only strings.
 */
export interface KmaForecastBaseTime {
  /** KST calendar date of the selected issuance, exactly `YYYYMMDD`. */
  readonly baseDate: string;
  /** KST clock time of the selected issuance, exactly `HHmm`. */
  readonly baseTime: string;
}

/**
 * Resolve the official issue-time schedule for a product, rejecting any value that is not one
 * of the two supported `KmaForecastProduct` members. The array is a module-private constant
 * shared across calls and is never exposed to or mutated by callers.
 */
function minutesOfDayScheduleFor(
  product: KmaForecastProduct,
): readonly number[] {
  switch (product) {
    case KmaForecastProduct.SHORT_FORECAST:
      return SHORT_FORECAST_MINUTES_OF_DAY;
    case KmaForecastProduct.ULTRA_SHORT_FORECAST:
      return ULTRA_SHORT_FORECAST_MINUTES_OF_DAY;
    default:
      // Value-free: never echo the caller's raw (possibly secret-shaped) product value.
      throw new RangeError('product must be a supported KmaForecastProduct');
  }
}

/** Left-pad a non-negative integer to a fixed width with leading zeros. */
function padZeros(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * Reject any calendar year outside the supported `[MIN_API_YEAR, MAX_API_YEAR]` range. Applied
 * both to the reference instant's KST year and to the final selected `base_date` year — the
 * previous-day rollover can push the latter one calendar year below the former. The message
 * names only the offending field/policy and never echoes the year value, so an out-of-policy
 * runtime value cannot leak through the error text.
 */
function assertSupportedCalendarYear(year: number, message: string): void {
  if (year < MIN_API_YEAR || year > MAX_API_YEAR) {
    throw new RangeError(message);
  }
}

/**
 * Select the latest **scheduled** KMA forecast `base_date` / `base_time` at or before
 * `referenceEpochMilliseconds`, for the given `product`.
 *
 * The reference instant is converted to KST (fixed `UTC+09:00`), and the most recent official
 * issue time that is **at or before** it (inclusive) is chosen: exactly at an issue time
 * selects that issue time, one millisecond before it selects the previous one. When the
 * reference is earlier than the first issue time of its KST day, the previous KST day's last
 * issue time is selected — with month-end, year-end, and leap-day boundaries computed exactly.
 * The input's seconds and milliseconds participate in the boundary comparison.
 *
 * Pure and deterministic; never reads the system clock; does not mutate `input`; returns a
 * fresh result object on every call.
 *
 * @throws RangeError if `referenceEpochMilliseconds` is not a finite safe integer, denotes an
 *   instant outside the representable `Date` range, or has a KST calendar year outside
 *   `[MIN_API_YEAR, MAX_API_YEAR]`; if the previous-day rollover selects a `base_date` whose
 *   year falls below that range (e.g. the `1000-01-01` lower bound rolling into `0999`); or if
 *   `product` is not a supported `KmaForecastProduct`. Every message names only the offending
 *   field or policy — it never echoes the raw input value nor serializes the input object.
 */
export function selectLatestKmaForecastBaseTime(
  input: SelectLatestKmaForecastBaseTimeInput,
): KmaForecastBaseTime {
  const { referenceEpochMilliseconds } = input;

  // Reject NaN, ±Infinity, fractional, and unsafe-integer millisecond values in one check —
  // Number.isSafeInteger is false for all of them (and for any non-number at runtime).
  if (!Number.isSafeInteger(referenceEpochMilliseconds)) {
    // Value-free: covers NaN / ±Infinity / fractional / unsafe and any non-number runtime
    // value, and never echoes the caller's raw (possibly secret-shaped) reference value.
    throw new RangeError('referenceEpochMilliseconds must be a finite safe integer');
  }

  // Resolve (and validate) the product's schedule before computing anything from the instant.
  const schedule = minutesOfDayScheduleFor(input.product);

  // Shift by the fixed KST offset, then read the KST calendar with UTC getters. A shifted
  // instant outside Date's representable range yields a NaN time and is rejected.
  const kstShiftedMs = referenceEpochMilliseconds + KST_OFFSET_IN_MS;
  const kstInstant = new Date(kstShiftedMs);
  if (Number.isNaN(kstInstant.getTime())) {
    throw new RangeError(
      'referenceEpochMilliseconds denotes an instant outside the representable date range',
    );
  }

  assertSupportedCalendarYear(
    kstInstant.getUTCFullYear(),
    'referenceEpochMilliseconds denotes an unsupported KST calendar year',
  );

  // Milliseconds elapsed since KST midnight — includes seconds and milliseconds so that the
  // boundary comparison is exact and does not collapse to whole hours.
  const referenceMsIntoDay =
    kstInstant.getUTCHours() * HOUR_IN_MS +
    kstInstant.getUTCMinutes() * MINUTE_IN_MS +
    kstInstant.getUTCSeconds() * 1000 +
    kstInstant.getUTCMilliseconds();

  // Latest issue time at or before the reference (inclusive), scanning newest-first.
  let selectedMinuteOfDay: number | null = null;
  for (let i = schedule.length - 1; i >= 0; i -= 1) {
    if ((schedule[i] as number) * MINUTE_IN_MS <= referenceMsIntoDay) {
      selectedMinuteOfDay = schedule[i] as number;
      break;
    }
  }

  // Earlier than the day's first issue time -> previous KST day's last issue time. Subtracting
  // a whole day from the shifted instant (no DST) moves the KST calendar back exactly one day,
  // so Date's UTC calendar handles month-end / year-end / leap-day rollovers exactly.
  let baseDateInstant = kstInstant;
  if (selectedMinuteOfDay === null) {
    selectedMinuteOfDay = schedule[schedule.length - 1] as number;
    baseDateInstant = new Date(kstShiftedMs - DAY_IN_MS);
  }

  // The previous-day rollover can move the selected base_date one calendar year below the
  // reference year — at the `1000-01-01` lower bound it lands in `0999`, which has no valid
  // four-digit YYYY. Re-validate the *selected* year and reject rather than emit / clamp it.
  assertSupportedCalendarYear(
    baseDateInstant.getUTCFullYear(),
    'selected KMA base date is outside the supported calendar range',
  );

  const baseDate =
    padZeros(baseDateInstant.getUTCFullYear(), 4) +
    padZeros(baseDateInstant.getUTCMonth() + 1, 2) +
    padZeros(baseDateInstant.getUTCDate(), 2);

  const baseTime =
    padZeros(Math.floor(selectedMinuteOfDay / 60), 2) +
    padZeros(selectedMinuteOfDay % 60, 2);

  return { baseDate, baseTime };
}
