/**
 * Select the latest **scheduled** KMA (Korea Meteorological Administration) 초단기실황
 * (`getUltraSrtNcst`, current observation) issue time (`base_date` / `base_time`) for a
 * caller-supplied absolute instant.
 *
 * The official publication schedule comes from the KMA guide — see
 * `docs/kma-current-observation-issue-time.md` (`기상청_단기예보 조회서비스`, 공공데이터 ID
 * `15084084`). Unlike 단기예보 (`getVilageFcst`, `0200/…/2300`) or 초단기예보 (`getUltraSrtFcst`,
 * `HH30`), 초단기실황 is generated **매시간 정시** — once an hour, on the hour (`HH00`), 24 times a
 * day (`0000, 0100, … , 2300`). There is no `product` choice: `getUltraSrtNcst` is the only
 * current-observation operation, so this module's input has no `product` field (unlike the
 * sibling forecast selectors in `./issue-time.ts`).
 *
 * This selects the latest issuance that the publication *schedule* places at or before the
 * reference instant. It makes **no** claim about API availability — that is a distinct,
 * out-of-scope concern (see the forecast `./api-availability-time.ts` for the analogous
 * separation on the forecast side; this module deliberately does not add an availability-delay
 * counterpart).
 *
 * This module is pure and deterministic: it never reads the system clock (`Date.now()`), the
 * environment, or the host locale/timezone; it performs no I/O; it holds no mutable global
 * state; it never mutates its input; and given the same input it always returns a fresh,
 * deep-equal result. KST is treated as a fixed `UTC+09:00` with no daylight saving time, so the
 * KST calendar is read via `Date`'s **UTC** getters on an offset-shifted instant — never via
 * host-local getters (`getHours`, `getDate`, …) or `Intl`.
 */

const HOUR_IN_MS = 3_600_000;

/** KST is a fixed offset of `UTC+09:00` with no daylight saving time. */
const KST_OFFSET_IN_MS = 9 * HOUR_IN_MS;

/**
 * The smallest `YYYYMMDD` year that formats to exactly four digits, and the largest. Because
 * the 초단기실황 schedule issues at `0000` — the very first minute of the KST day — the selected
 * `base_date` is always the reference instant's own KST calendar day; there is no previous-day
 * rollover the way there is for `./issue-time.ts`'s `0200`/`0030` first-issuance schedules. So a
 * single check against the reference's own KST year is sufficient (unlike the forecast selector,
 * which must separately re-validate the *selected* base_date year after a rollover).
 */
const MIN_API_YEAR = 1000;
const MAX_API_YEAR = 9999;

/**
 * The reference instant, as absolute epoch milliseconds, to select a 초단기실황 issue time for.
 */
export interface SelectLatestKmaCurrentObservationBaseTimeInput {
  /**
   * The reference instant as absolute epoch milliseconds (UTC). Host-timezone independent — the
   * same instant yields the same result regardless of where the caller runs. Must be a finite,
   * safe integer that denotes an instant representable by `Date` whose KST calendar year is in
   * `[1000, 9999]`.
   */
  readonly referenceEpochMilliseconds: number;
}

/**
 * A KMA 초단기실황 request's `base_date` / `base_time`, ready to place into a
 * `KmaCurrentObservationRequest`. Both are fixed-width, digit-only strings; `baseTime` is
 * always exactly on the hour (`HH00`).
 */
export interface KmaCurrentObservationBaseTime {
  /** KST calendar date of the selected issuance, exactly `YYYYMMDD`. */
  readonly baseDate: string;
  /** KST clock time of the selected issuance, exactly `HH00`. */
  readonly baseTime: string;
}

/** Left-pad a non-negative integer to a fixed width with leading zeros. */
function padZeros(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * Select the latest **scheduled** KMA 초단기실황 (`getUltraSrtNcst`) `base_date` / `base_time` at
 * or before `referenceEpochMilliseconds`.
 *
 * The reference instant is converted to KST (fixed `UTC+09:00`), and the most recent official
 * issue time that is **at or before** it (inclusive) is chosen: exactly at an hour boundary
 * (`HH:00:00.000`) selects that hour's issuance, one millisecond before it selects the previous
 * hour's. Because every KST hour has an issuance (including `00`), this is a direct hour-boundary
 * read — the KST calendar day, month, year, and leap-day rollovers are all handled by `Date`'s own
 * UTC-getter arithmetic on the shifted instant, with no manual previous-day-rollover branch: at
 * `H:00:00.000` minus one millisecond, `Date` already reports the correct previous hour/day/
 * month/year on its own. The input's seconds and milliseconds participate in the boundary
 * comparison (they never advance the selected hour).
 *
 * Pure and deterministic; never reads the system clock; does not mutate `input`; returns a fresh
 * result object on every call.
 *
 * @throws RangeError if `referenceEpochMilliseconds` is not a finite safe integer, denotes an
 *   instant outside the representable `Date` range, or has a KST calendar year outside
 *   `[1000, 9999]`. Every message names only the offending field or policy — it never echoes the
 *   raw input value nor serializes the input object.
 */
export function selectLatestKmaCurrentObservationBaseTime(
  input: SelectLatestKmaCurrentObservationBaseTimeInput,
): KmaCurrentObservationBaseTime {
  const { referenceEpochMilliseconds } = input;

  // Reject NaN, ±Infinity, fractional, and unsafe-integer millisecond values in one check —
  // Number.isSafeInteger is false for all of them (and for any non-number at runtime).
  if (!Number.isSafeInteger(referenceEpochMilliseconds)) {
    // Value-free: covers NaN / ±Infinity / fractional / unsafe and any non-number runtime
    // value, and never echoes the caller's raw (possibly secret-shaped) reference value.
    throw new RangeError('referenceEpochMilliseconds must be a finite safe integer');
  }

  // Shift by the fixed KST offset, then read the KST calendar with UTC getters. A shifted
  // instant outside Date's representable range yields a NaN time and is rejected.
  const kstShiftedMs = referenceEpochMilliseconds + KST_OFFSET_IN_MS;
  const kstInstant = new Date(kstShiftedMs);
  if (Number.isNaN(kstInstant.getTime())) {
    throw new RangeError(
      'referenceEpochMilliseconds denotes an instant outside the representable date range',
    );
  }

  const year = kstInstant.getUTCFullYear();
  if (year < MIN_API_YEAR || year > MAX_API_YEAR) {
    throw new RangeError('referenceEpochMilliseconds denotes an unsupported KST calendar year');
  }

  // The schedule issues every KST hour on the hour (HH00), including 00 — so the reference's own
  // KST hour (minutes/seconds/milliseconds truncated toward the top of the hour) is always the
  // latest issuance at or before it. No previous-day rollover is possible.
  const baseDate =
    padZeros(year, 4) +
    padZeros(kstInstant.getUTCMonth() + 1, 2) +
    padZeros(kstInstant.getUTCDate(), 2);

  const baseTime = padZeros(kstInstant.getUTCHours(), 2) + '00';

  return { baseDate, baseTime };
}
