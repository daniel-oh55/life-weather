/**
 * Shared, dependency-free validation predicates for KMA (기상청) date, time, and grid values.
 *
 * These are the *single source* of the calendar-date and clock-time rules used by several layers:
 *
 * - `raw-schema.ts` / `current-raw-schema.ts` — validating the shape of an already-parsed
 *   *response* item (`baseDate`, `baseTime`, `fcstDate`, `fcstTime`).
 * - `request.ts` / `current-request.ts` — validating a caller's *request* before a URL is built.
 * - `normalize-current.ts` — the current-observation normalizer's defensive re-check before
 *   composing `observedAt`.
 *
 * Extracting them here (rather than re-deriving the leap-year / HHmm logic per layer) keeps every
 * layer provably consistent: a date the response boundary accepts is validated by the exact same
 * code that validates a request date. Pure arithmetic only — no `Date`, no system clock, no
 * environment access — so validation is deterministic across machines and time.
 *
 * `isCalendarDate` / `isClockTime` are unchanged in behavior from their PR #4 home in
 * `raw-schema.ts`; only their location moved. `isNonNegativeSafeInteger` is used by the forecast
 * request layer (see the note on its stricter `safe`-integer rule below).
 *
 * `isKmaCurrentObservationBaseTime` and the `isKmaCurrentObservationGrid{Nx,Ny}` pair are
 * **current-observation-only** — 초단기실황 (`getUltraSrtNcst`) is issued strictly on the hour and
 * only within the official 149×253 forecast grid, which is stricter than the general `HHmm`/
 * unbounded-integer rules forecast still relies on. They are the single provider-local source of
 * truth for that stricter policy, shared by `current-request.ts`, `current-raw-schema.ts`, and
 * `normalize-current.ts` so the three layers cannot silently drift apart. Forecast's `isClockTime`
 * / `isNonNegativeSafeInteger` behavior is unchanged by their addition.
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
 * TypeScript type says `number`. Declared as a type predicate purely so callers that need the
 * narrowed `number` type (the current-observation grid predicates below) can build on it without
 * re-deriving the same runtime check; the check itself is unchanged.
 */
export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** `HHmm` (`HH24MI`) matcher requiring the minute component to be exactly `00`. */
const ON_THE_HOUR_MINUTE = '00';

/**
 * Whether `value` is a valid current-observation (초단기실황, `getUltraSrtNcst`) `baseTime`: a
 * structurally valid `isClockTime` value that additionally falls exactly on the hour (`mm ===
 * '00'`) — `'0000'`..`'2300'` in steps of 100, never e.g. `'0030'`/`'0530'`/`'2359'`. 초단기실황 is
 * issued only on the hour, unlike forecast's `HHmm` base/forecast times, which keep using the
 * general `isClockTime` unchanged.
 */
export function isKmaCurrentObservationBaseTime(value: string): boolean {
  return isClockTime(value) && value.slice(2) === ON_THE_HOUR_MINUTE;
}

/**
 * The official KMA 동네예보 forecast grid extent (inclusive) — the same `[1, 149] × [1, 253]` range
 * as `packages/weather-core`'s `grid.ts`. Duplicated here as the provider-local single source of
 * truth for current-observation request/raw-schema range enforcement: this `apps/api` module does
 * not import `packages/weather-core`, and forecast's own request/raw-schema validation stays
 * unbounded (`isNonNegativeSafeInteger` / `z.number().int().min(0)`) — only current observation
 * enforces this stricter range.
 */
export const KMA_CURRENT_OBSERVATION_GRID_NX_MIN = 1;
export const KMA_CURRENT_OBSERVATION_GRID_NX_MAX = 149;
export const KMA_CURRENT_OBSERVATION_GRID_NY_MIN = 1;
export const KMA_CURRENT_OBSERVATION_GRID_NY_MAX = 253;

/**
 * Whether `value` is a valid current-observation `nx`: a non-negative safe integer within
 * `[1, 149]`. No coercion — a numeric string is rejected, matching `isNonNegativeSafeInteger`.
 */
export function isKmaCurrentObservationGridNx(value: unknown): value is number {
  return (
    isNonNegativeSafeInteger(value) &&
    value >= KMA_CURRENT_OBSERVATION_GRID_NX_MIN &&
    value <= KMA_CURRENT_OBSERVATION_GRID_NX_MAX
  );
}

/**
 * Whether `value` is a valid current-observation `ny`: a non-negative safe integer within
 * `[1, 253]`. No coercion — a numeric string is rejected, matching `isNonNegativeSafeInteger`.
 */
export function isKmaCurrentObservationGridNy(value: unknown): value is number {
  return (
    isNonNegativeSafeInteger(value) &&
    value >= KMA_CURRENT_OBSERVATION_GRID_NY_MIN &&
    value <= KMA_CURRENT_OBSERVATION_GRID_NY_MAX
  );
}

// ---------------------------------------------------------------------------
// Mid-term forecast (중기예보, `MidFcstInfoService`) — PR #98
// ---------------------------------------------------------------------------
//
// These two predicates are **mid-term-only**, in the same spirit as the current-observation
// predicates above: 중기예보 addresses a region by an official 구역코드 (`regId`) rather than a
// forecast grid point, and identifies an issuance by a single 12-digit `tmFc` stamp rather than a
// separate `base_date` / `base_time` pair. They live here so the request layer
// (`midterm-request.ts`) and the response boundary (`midterm-raw-schema.ts`) validate `regId` with
// the exact same rule and cannot drift apart. Forecast's and current observation's own predicates
// are unchanged by their addition.

/**
 * The structural form of an official 중기예보 구역코드 (`regId`): two digits, one ASCII uppercase
 * letter, then five digits (`11B00000`, `11D10000`, `11H20000` for 육상예보구역; `11B10101`,
 * `11H20201` for 중기기온 도시). This is a **structural** check only — deliberately *not* an
 * allow-list of region codes, so no single region (Seoul or otherwise) is hardcoded here and a
 * code KMA adds later still passes. Resolving a location/administrative area/coordinate to the
 * correct 육상 or 기온 `regId` is explicitly out of scope for this boundary and remains future
 * work (see `docs/kma-midterm-provider.md`); this predicate only rejects a value that is not a
 * 구역코드 at all (`''`, `'11B0000'`, `'11B000000'`, `'11b00000'`, `'1AB00000'`, `' 11B00000 '`).
 */
const KMA_MIDTERM_REG_ID_PATTERN = /^\d{2}[A-Z]\d{5}$/;

/**
 * Whether `value` is a structurally valid 중기예보 `regId` (see {@link KMA_MIDTERM_REG_ID_PATTERN}).
 * Takes `unknown` and guards with `typeof` because a request `regId` crosses a trust boundary; no
 * coercion and no trimming — a surrounding-whitespace value is rejected, never silently cleaned.
 */
export function isKmaMidtermRegId(value: unknown): value is string {
  return typeof value === 'string' && KMA_MIDTERM_REG_ID_PATTERN.test(value);
}

/** `YYYYMMDDHHmm` structural matcher — exactly twelve digits. */
const YYYYMMDDHHMM_PATTERN = /^\d{12}$/;

/**
 * Whether `value` is a structurally valid 중기예보 issuance stamp (`tmFc`): exactly twelve digits
 * whose first eight form a real `YYYYMMDD` calendar date and whose last four form a valid `HHmm`
 * clock time. Composed from {@link isCalendarDate} / {@link isClockTime} so the mid-term boundary
 * inherits the exact same leap-year and `HH24MI` rules the forecast/current boundaries use.
 *
 * The official 발표시각 **schedule** (`YYYYMMDD0600` / `YYYYMMDD1800`, most recent 24 hours only)
 * is deliberately **not** enforced: a structurally valid but non-canonical stamp such as
 * `202608310615` is accepted, exactly as `request.ts` accepts a non-canonical forecast `baseTime`.
 * Choosing the latest scheduled 06/18 KST issuance — and any publication-delay policy around it —
 * belongs to a later issuance-selector/application layer, not to this structural validator, which
 * never reads the system clock and is therefore deterministic across machines and time.
 */
export function isKmaMidtermIssuanceStamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    YYYYMMDDHHMM_PATTERN.test(value) &&
    isCalendarDate(value.slice(0, 8)) &&
    isClockTime(value.slice(8))
  );
}
