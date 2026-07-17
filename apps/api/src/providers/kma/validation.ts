/**
 * Shared, dependency-free validation predicates for KMA (기상청) date, time, and grid values.
 *
 * These are the *single source* of the calendar-date and clock-time rules used by two layers:
 *
 * - `raw-schema.ts` — validating the shape of an already-parsed *response* item (`baseDate`,
 *   `baseTime`, `fcstDate`, `fcstTime`).
 * - `request.ts` — validating a caller's forecast *request* before a URL is built.
 *
 * Extracting them here (rather than re-deriving the leap-year / HHmm logic in `request.ts`) keeps
 * the two layers provably consistent: a date the response boundary accepts is validated by the
 * exact same code that validates a request date. Pure arithmetic only — no `Date`, no system
 * clock, no environment access — so validation is deterministic across machines and time.
 *
 * `isCalendarDate` / `isClockTime` are unchanged in behavior from their PR #4 home in
 * `raw-schema.ts`; only their location moved. `isNonNegativeSafeInteger` is *new* and is used only
 * by the request layer (see the note on its stricter `safe`-integer rule below).
 */

/** `YYYYMMDD` structural matcher (calendar validity is checked separately in {@link isCalendarDate}). */
const YYYYMMDD_PATTERN = /^(\d{4})(\d{2})(\d{2})$/;

/** `HHmm` (`HH24MI`) matcher — exactly four digits. */
const HHMM_PATTERN = /^(\d{2})(\d{2})$/;

/** Days per month for a non-leap year; February is corrected for leap years at call time. */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** Proleptic Gregorian leap-year rule. Pure arithmetic — no `Date`, no system clock. */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Whether `value` is a real `YYYYMMDD` calendar date. Rejects a structurally-shaped but
 * impossible date (`20260230` → Feb 30, `20251301` → month 13, `20250010` → day 0,
 * `20250229` → 2025 is not a leap year) and accepts real ones (`20240229`, `20260716`).
 * The current date is never consulted, so validation is deterministic across machines and time.
 */
export function isCalendarDate(value: string): boolean {
  const match = YYYYMMDD_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  const maxDay =
    month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  return day <= maxDay;
}

/**
 * Whether `value` is a valid `HHmm` clock time: exactly four digits, hour `00`–`23`, minute
 * `00`–`59`. Rejects `2400` (hour 24) and `1260` (minute 60). No numeric coercion — the value
 * must already be the official string form.
 */
export function isClockTime(value: string): boolean {
  const match = HHMM_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

/**
 * Whether `value` is a non-negative *safe* integer — used to validate a request `nx` / `ny`.
 *
 * This is deliberately stricter than the response-side `kmaGridCoordinate` schema (`z.number()
 * .int().min(0)`): a request coordinate the caller supplies must be a plain `number` (never a
 * numeric string — no coercion), finite, an integer, non-negative, and within the safe-integer
 * range so it round-trips through `String(...)` into the URL without precision loss. `typeof`
 * guards the runtime input because a request object crosses a trust boundary even though its
 * TypeScript type says `number`.
 */
export function isNonNegativeSafeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
