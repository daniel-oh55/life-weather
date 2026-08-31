/**
 * Select the latest **scheduled** KMA (Korea Meteorological Administration) 중기예보
 * (`MidFcstInfoService`) issuance stamp (`tmFc`) for a caller-supplied absolute instant.
 *
 * The official publication schedule comes from the KMA guide — see
 * `docs/kma-midterm-issue-time.md` (`기상청_중기예보 조회서비스`, 공공데이터 ID `15059468`). Unlike
 * 단기예보 (`getVilageFcst`, `0200/…/2300`) or 초단기예보 (`getUltraSrtFcst`, `HH30`), 중기예보 is
 * published **twice a day** — `06:00 KST`와 `18:00 KST` — and both `getMidTa`(중기기온조회)와
 * `getMidLandFcst`(중기육상예보조회) operation은 같은 `tmFc` schedule을 공유하므로, 이 selector에는
 * (forecast selector `./issue-time.ts`와 달리) `product` 선택이 없습니다.
 *
 * This selects the latest issuance that the publication *schedule* places at or before the
 * reference instant. It makes **no** claim about API availability — the guide establishes the
 * 06/18 schedule and a "recent 24 hours only" retention window, but this project has not
 * established a grounded publication/replication delay for this service comparable to the
 * forecast `./api-availability-time.ts` threshold, so no availability-delay counterpart is
 * added here (see `docs/kma-midterm-issue-time.md`).
 *
 * This module is pure and deterministic: it never reads the system clock (`Date.now()`), the
 * environment, or the host locale/timezone; it performs no I/O; it holds no mutable global
 * state; it never mutates its input; and given the same input it always returns a fresh,
 * deep-equal result. KST is treated as a fixed `UTC+09:00` with no daylight saving time, so the
 * KST calendar is read via `Date`'s **UTC** getters on an offset-shifted instant — never via
 * host-local getters (`getHours`, `getDate`, …) or `Intl`.
 *
 * This module does not resolve a location to a 중기예보 구역코드 (`regId`) and does not claim the
 * selected issuance is already available from the API — both remain the responsibility of later
 * layers (see the module doc's scope note and `docs/kma-midterm-issue-time.md`).
 */

const MINUTE_IN_MS = 60_000;
const HOUR_IN_MS = 3_600_000;
const DAY_IN_MS = 86_400_000;

/** KST is a fixed offset of `UTC+09:00` with no daylight saving time. */
const KST_OFFSET_IN_MS = 9 * HOUR_IN_MS;

/**
 * The smallest `YYYYMMDD` year that formats to exactly four digits, and the largest. Both the
 * reference instant's KST calendar year AND the final selected issuance date's year must fall
 * within `[MIN_API_YEAR, MAX_API_YEAR]`: a previous-day rollover below the day's first issuance
 * (`06:00`) can move the selected issuance date one calendar year earlier than the reference (at
 * the `1000-01-01` lower bound it would land in `0999`), and such an out-of-range result is
 * rejected rather than emitted, clamped, or truncated.
 */
const MIN_API_YEAR = 1000;
const MAX_API_YEAR = 9999;

/**
 * Official 중기예보 issue times as minutes past KST midnight, ascending: `0600, 1800`. Both
 * `getMidTa` and `getMidLandFcst` share this same publication schedule.
 */
const KMA_MIDTERM_ISSUANCE_MINUTES_OF_DAY: readonly number[] = [
  6 * 60, // 0600
  18 * 60, // 1800
];

/** The reference instant, as absolute epoch milliseconds, to select a 중기예보 issuance for. */
export interface SelectLatestKmaMidtermIssuanceInput {
  /**
   * The reference instant as absolute epoch milliseconds (UTC). Host-timezone independent — the
   * same instant yields the same result regardless of where the caller runs. Must be a finite,
   * safe integer that denotes an instant representable by `Date` whose KST calendar year is in
   * `[1000, 9999]`.
   */
  readonly referenceEpochMilliseconds: number;
}

/**
 * The selected KMA 중기예보 issuance identity — the official request stamp (`tmFc`) a later layer
 * places into a `KmaMidtermForecastRequest`
 * (`apps/api/src/providers/kma/midterm-request.ts`). This selector does not model `regId`.
 */
export interface KmaMidtermIssuance {
  /** Official issuance stamp, exactly `YYYYMMDDHHmm`, always ending in `0600` or `1800`. */
  readonly tmFc: string;
}

/** Left-pad a non-negative integer to a fixed width with leading zeros. */
function padZeros(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * Reject any calendar year outside the supported `[MIN_API_YEAR, MAX_API_YEAR]` range. Applied
 * both to the reference instant's KST year and to the final selected issuance date's year — the
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
 * Select the latest **scheduled** KMA 중기예보 issuance stamp (`tmFc`) at or before
 * `referenceEpochMilliseconds`.
 *
 * The reference instant is converted to KST (fixed `UTC+09:00`), and the most recent official
 * issue time that is **at or before** it (inclusive) is chosen: exactly at `06:00` or `18:00`
 * selects that issuance, one millisecond before it selects the previous one. When the reference
 * is earlier than the first issuance of its KST day (`06:00`), the previous KST day's `18:00`
 * issuance is selected — with month-end, year-end, and leap-day boundaries computed exactly. The
 * input's seconds and milliseconds participate in the boundary comparison.
 *
 * Pure and deterministic; never reads the system clock; does not mutate `input`; returns a fresh
 * result object on every call.
 *
 * @throws RangeError if `input` is not an object (including `null` or `undefined`, reachable
 *   only past a type-bypassing/unsafe-cast call); if `referenceEpochMilliseconds` is not a
 *   finite safe integer, denotes an instant outside the representable `Date` range, or has a
 *   KST calendar year outside `[1000, 9999]`; or if the previous-day rollover selects an
 *   issuance date whose year falls below that range (e.g. the `1000-01-01` lower bound rolling
 *   into `0999`). Every message names only the offending field or policy — it never echoes the
 *   raw input value nor serializes the input object.
 */
export function selectLatestKmaMidtermIssuance(
  input: SelectLatestKmaMidtermIssuanceInput,
): KmaMidtermIssuance {
  // Validate the top-level input itself before destructuring, so that a `null` or `undefined`
  // input (reachable only past a type-bypassing/unsafe-cast call, since the TS type requires an
  // object) raises this module's own value-free RangeError instead of an engine-generated
  // TypeError from destructuring a non-object.
  if (typeof input !== 'object' || input === null) {
    throw new RangeError('selectLatestKmaMidtermIssuance input must be an object');
  }

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
  for (let i = KMA_MIDTERM_ISSUANCE_MINUTES_OF_DAY.length - 1; i >= 0; i -= 1) {
    if (
      (KMA_MIDTERM_ISSUANCE_MINUTES_OF_DAY[i] as number) * MINUTE_IN_MS <=
      referenceMsIntoDay
    ) {
      selectedMinuteOfDay = KMA_MIDTERM_ISSUANCE_MINUTES_OF_DAY[i] as number;
      break;
    }
  }

  // Earlier than the day's first issuance (06:00) -> previous KST day's 18:00 issuance.
  // Subtracting a whole day from the shifted instant (no DST) moves the KST calendar back
  // exactly one day, so Date's UTC calendar handles month-end / year-end / leap-day rollovers
  // exactly.
  let issuanceDateInstant = kstInstant;
  if (selectedMinuteOfDay === null) {
    selectedMinuteOfDay = KMA_MIDTERM_ISSUANCE_MINUTES_OF_DAY[
      KMA_MIDTERM_ISSUANCE_MINUTES_OF_DAY.length - 1
    ] as number;
    issuanceDateInstant = new Date(kstShiftedMs - DAY_IN_MS);
  }

  // The previous-day rollover can move the selected issuance date one calendar year below the
  // reference year — at the `1000-01-01` lower bound it lands in `0999`, which has no valid
  // four-digit YYYY. Re-validate the *selected* year and reject rather than emit / clamp it.
  assertSupportedCalendarYear(
    issuanceDateInstant.getUTCFullYear(),
    'selected KMA mid-term issuance date is outside the supported calendar range',
  );

  const issuanceDate =
    padZeros(issuanceDateInstant.getUTCFullYear(), 4) +
    padZeros(issuanceDateInstant.getUTCMonth() + 1, 2) +
    padZeros(issuanceDateInstant.getUTCDate(), 2);

  const issuanceTime =
    padZeros(Math.floor(selectedMinuteOfDay / 60), 2) +
    padZeros(selectedMinuteOfDay % 60, 2);

  return { tmFc: `${issuanceDate}${issuanceTime}` };
}
