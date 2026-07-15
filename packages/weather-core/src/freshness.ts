/**
 * Deterministic freshness classification for a timestamped observation.
 *
 * This module has no dependency on Zod or `@life-weather/contracts`, and never reads the
 * system clock — the caller supplies `referenceAt`. Given the same input it always returns
 * the same result, and it never mutates its input.
 */

const MINUTE_IN_MS = 60_000;

/**
 * ISO 8601 datetime with a **required** timezone designator, capturing each component for
 * range validation: `(year)-(month)-(day)T(hour):(minute):(second)` (optional fractional
 * seconds) then `Z` or a numeric `(sign)(offsetHour):(offsetMinute)` offset. The shape alone
 * rejects timezone-less local datetimes (`2026-07-15T10:00:00`), date-only strings
 * (`2026-07-15`), and non-ISO formats (`07/15/2026 10:00`).
 */
const ABSOLUTE_ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  const daysPerMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }
  return daysPerMonth[month - 1] ?? 0;
}

/**
 * Parse an absolute ISO datetime to epoch milliseconds, or return `null` if it is not a
 * timezone-qualified ISO datetime or does not denote a real calendar instant.
 *
 * The format and required timezone are checked first, then each captured component is
 * validated directly — month `1..12`, day `1..` the real last day of that year/month (with
 * the 4/100/400 leap-year rule), hour `0..23`, minute/second `0..59`, and offset hour/minute
 * in range. This rejects impossible dates that `Date.parse` would silently roll over (e.g.
 * `2026-02-30` → `2026-03-02`). Only after component validation is `Date.parse` used to
 * compute the absolute instant — independent of the host timezone/locale because the offset
 * is explicit.
 */
function parseAbsoluteInstantMs(value: string): number | null {
  const match = ABSOLUTE_ISO_DATETIME.exec(value);
  if (match === null) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);

  if (month < 1 || month > 12) {
    return null;
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return null;
  }

  // Offset components are absent for the `Z` form (match[7] is the sign, or undefined).
  if (match[7] !== undefined) {
    const offsetHour = Number(match[8]);
    const offsetMinute = Number(match[9]);
    if (offsetHour > 23 || offsetMinute > 59) {
      return null;
    }
  }

  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The freshness of an observation relative to a reference instant.
 *
 * - `FRESH`   — recent enough to use.
 * - `STALE`   — older than the allowed staleness threshold.
 * - `FUTURE`  — dated further into the future than the allowed tolerance (clock skew / bad data).
 * - `UNKNOWN` — no timestamp, or an unparseable one.
 */
export const FreshnessStatus = {
  FRESH: 'FRESH',
  STALE: 'STALE',
  FUTURE: 'FUTURE',
  UNKNOWN: 'UNKNOWN',
} as const;

export type FreshnessStatus =
  (typeof FreshnessStatus)[keyof typeof FreshnessStatus];

export interface ClassifyFreshnessInput {
  /** When the observation was made (ISO 8601), or `null` if unknown. */
  observedAt: string | null;
  /** The instant to measure against (ISO 8601), supplied by the caller. */
  referenceAt: string;
  /** An observation at or beyond this age (in minutes) is `STALE`. Must be finite and `>= 0`. */
  staleAfterMinutes: number;
  /** How many minutes ahead of `referenceAt` is tolerated before `FUTURE`. Must be finite and `>= 0`. */
  futureToleranceMinutes: number;
}

function assertNonNegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite number >= 0, received ${value}`);
  }
}

/**
 * Classify how fresh `observedAt` is relative to `referenceAt`.
 *
 * @throws RangeError if `staleAfterMinutes` or `futureToleranceMinutes` is negative, NaN or
 *   infinite, or if `referenceAt` is not a timezone-qualified ISO 8601 datetime. An
 *   `observedAt` that is `null` or not such a datetime yields `UNKNOWN`.
 */
export function classifyFreshness(input: ClassifyFreshnessInput): FreshnessStatus {
  const { observedAt, referenceAt, staleAfterMinutes, futureToleranceMinutes } =
    input;

  assertNonNegativeFinite(staleAfterMinutes, 'staleAfterMinutes');
  assertNonNegativeFinite(futureToleranceMinutes, 'futureToleranceMinutes');

  const referenceMs = parseAbsoluteInstantMs(referenceAt);
  if (referenceMs === null) {
    throw new RangeError(
      `referenceAt must be an ISO 8601 datetime with a timezone: ${referenceAt}`,
    );
  }

  if (observedAt === null) {
    return FreshnessStatus.UNKNOWN;
  }

  const observedMs = parseAbsoluteInstantMs(observedAt);
  if (observedMs === null) {
    return FreshnessStatus.UNKNOWN;
  }

  const aheadOfReferenceMs = observedMs - referenceMs;
  // Strictly beyond the tolerance is FUTURE; exactly at the tolerance is not.
  if (aheadOfReferenceMs > futureToleranceMinutes * MINUTE_IN_MS) {
    return FreshnessStatus.FUTURE;
  }

  const ageMs = referenceMs - observedMs;
  // At or beyond the threshold is STALE; anything younger is FRESH.
  if (ageMs >= staleAfterMinutes * MINUTE_IN_MS) {
    return FreshnessStatus.STALE;
  }

  return FreshnessStatus.FRESH;
}
