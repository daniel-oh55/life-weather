/**
 * Deterministic freshness classification for a timestamped observation.
 *
 * This module has no dependency on Zod or `@life-weather/contracts`, and never reads the
 * system clock — the caller supplies `referenceAt`. Given the same input it always returns
 * the same result, and it never mutates its input.
 */

const MINUTE_IN_MS = 60_000;

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
 *   infinite, or if `referenceAt` cannot be parsed as a date.
 */
export function classifyFreshness(input: ClassifyFreshnessInput): FreshnessStatus {
  const { observedAt, referenceAt, staleAfterMinutes, futureToleranceMinutes } =
    input;

  assertNonNegativeFinite(staleAfterMinutes, 'staleAfterMinutes');
  assertNonNegativeFinite(futureToleranceMinutes, 'futureToleranceMinutes');

  const referenceMs = Date.parse(referenceAt);
  if (Number.isNaN(referenceMs)) {
    throw new RangeError(`referenceAt is not a valid date: ${referenceAt}`);
  }

  if (observedAt === null) {
    return FreshnessStatus.UNKNOWN;
  }

  const observedMs = Date.parse(observedAt);
  if (Number.isNaN(observedMs)) {
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
