/**
 * Runtime (Zod) schemas for the **raw** KMA (기상청) short-term / ultra-short-term forecast
 * JSON response — the untrusted boundary between the external 기상청_단기예보 조회서비스 and this
 * backend. Nothing here fetches, reads an environment variable, or knows a service key; these
 * schemas only *validate the shape* of an already-parsed JSON value.
 *
 * The structure and the scalar types come from the official guide, not from memory or blogs —
 * see `docs/kma-response-boundary.md` (`기상청_단기예보 조회서비스`, 공공데이터 ID `15084084`,
 * 활용가이드 `2607`; cross-checked against the 기상청 API 허브 `VilageFcstInfoService_2.0` 활용가이드).
 * The two in-scope operations — `getVilageFcst` (단기예보) and `getUltraSrtFcst` (초단기예보) —
 * share the *same* item shape (only their category codes differ), so one item schema serves both.
 *
 * Type discipline (see the guide doc for the evidence behind each choice):
 *
 * - No `z.coerce`. A numeric string is never turned into a number and a number is never turned
 *   into a string. The official JSON keeps `fcstValue`/dates/times as strings and
 *   `nx`/`ny`/pagination as numbers; we mirror that exactly.
 * - `z.number()` in Zod 4 already rejects `NaN`/`Infinity`/`-Infinity`, so every numeric schema
 *   is finite by construction; `.int()` further rejects non-integers.
 * - Unknown *extra* keys are dropped by Zod's default object strip. A brand-new `category` code
 *   is still accepted, because `category` is validated as a non-empty code string, never an enum.
 * - A missing required field is a hard failure (not "normal" data). `fcstValue` is the one field
 *   that may be explicitly `null` (see below); every other item field is required and non-null.
 */

import { z } from 'zod';

/**
 * The official success `resultCode` (NORMAL_SERVICE). Every other code — including `03`
 * (NODATA_ERROR, "데이터없음") — is a non-success code per the guide's error-code table, and is
 * classified as an upstream error rather than a successful empty page. Kept as a string; the
 * official field is a 2-character code and is never coerced to a number.
 */
export const KMA_SUCCESS_RESULT_CODE = '00';

// ---------------------------------------------------------------------------
// Field-level primitives
// ---------------------------------------------------------------------------

/** `YYYYMMDD` calendar-date matcher (structure only; calendar validity is checked separately). */
const YYYYMMDD_PATTERN = /^(\d{4})(\d{2})(\d{2})$/;

/** `HHmm` (`HH24MI`) time matcher — exactly four digits. */
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
function isCalendarDate(value: string): boolean {
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
function isClockTime(value: string): boolean {
  const match = HHMM_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

/** `baseDate` / `fcstDate` — an official `YYYYMMDD` string that is also a real calendar date. */
const kmaDate = z
  .string()
  .refine(isCalendarDate, { message: 'must be a valid YYYYMMDD calendar date' });

/** `baseTime` / `fcstTime` — an official `HHmm` (`HH24MI`) clock time. */
const kmaTime = z
  .string()
  .refine(isClockTime, { message: 'must be a valid HHmm (HH24MI) time' });

/**
 * `category` (자료구분문자) — a non-empty code string with no surrounding whitespace. Not an
 * enum: an unknown/future code (e.g. a category KMA adds later) must pass through the raw
 * boundary untouched, because normalizing codes into common states is `weather-core`'s job.
 * The empty string and a whitespace-only string are rejected, and a value carrying leading or
 * trailing whitespace is treated as contaminated (rejected) rather than silently trimmed into
 * an official code.
 */
const kmaCategory = z.string().refine((value) => value.length > 0 && value === value.trim(), {
  message: 'must be a non-empty category code with no surrounding whitespace',
});

/**
 * `fcstValue` (예보 값). The official JSON always carries this as a **string** — even the
 * "실수로 제공" categories (TMP, TMN, TMX, UUU, VVV, WAV, WSD) appear string-encoded
 * (e.g. `"-2"`, `"6.2"`) — so a number is *not* accepted (no numeric coercion), and objects and
 * arrays are rejected. The field key itself is required; its value may be an explicit `null`.
 * Accepting explicit `null` while still failing on a *missing* key is deliberate: it is the only
 * way the field-presence model can distinguish "item present but value null" from "item absent"
 * (see `groupKmaForecastItems`). A missing key is a schema failure, never treated as `null`.
 */
const kmaForecastValue = z.string().nullable();

/**
 * A forecast grid coordinate (`nx` / `ny`). Finite (guaranteed by `z.number()`), an integer,
 * and non-negative. No upper bound is imposed: the guide's item-size column ("2") is
 * contradicted by its own sample (`127`), so no reliable maximum is documented — an out-of-grid
 * coordinate is left for a later layer rather than guessed here.
 */
const kmaGridCoordinate = z.number().int().min(0);

/** A 1-based page index (`pageNo`). */
const kmaPageNumber = z.number().int().min(1);

/** A page size (`numOfRows`) — at least one row per page. */
const kmaRowCount = z.number().int().min(1);

/** A total record count (`totalCount`) — non-negative; may be `0`. */
const kmaTotalCount = z.number().int().min(0);

// ---------------------------------------------------------------------------
// Object schemas
// ---------------------------------------------------------------------------

/**
 * `response.header`. Both fields are plain strings; `resultCode` is never coerced to a number,
 * so an official success code (`'00'`) keeps its leading zero. This is the only part of the
 * envelope needed to classify a response as success vs. upstream error.
 */
export const kmaResponseHeaderSchema = z.object({
  resultCode: z.string(),
  resultMsg: z.string(),
});

export type KmaResponseHeader = z.infer<typeof kmaResponseHeaderSchema>;

/**
 * One forecast `item`. Identical for 단기예보 and 초단기예보. Every field is required; only
 * `fcstValue` may be explicitly `null`. Unknown extra keys are stripped by Zod's default.
 */
export const kmaForecastItemSchema = z.object({
  baseDate: kmaDate,
  baseTime: kmaTime,
  category: kmaCategory,
  fcstDate: kmaDate,
  fcstTime: kmaTime,
  fcstValue: kmaForecastValue,
  nx: kmaGridCoordinate,
  ny: kmaGridCoordinate,
});

export type KmaForecastItem = z.infer<typeof kmaForecastItemSchema>;

/**
 * `response.body.items`. The official success payload nests the list under `items.item`, and
 * `item` must be an **array**; a single object or an empty string is rejected (a genuine
 * no-data response arrives as the `03` error code, not as a success body with an odd `items`
 * shape). An empty array is allowed and yields an empty page.
 */
export const kmaForecastItemsSchema = z.object({
  item: z.array(kmaForecastItemSchema),
});

/**
 * `response.body` for a success (`resultCode === '00'`). Pagination fields use the official
 * JSON numeric types; `totalCount` is intentionally *not* asserted to equal the current page's
 * item count, since pagination means a page may hold fewer items than `totalCount`.
 */
export const kmaForecastBodySchema = z.object({
  dataType: z.string(),
  pageNo: kmaPageNumber,
  numOfRows: kmaRowCount,
  totalCount: kmaTotalCount,
  items: kmaForecastItemsSchema,
});

export type KmaForecastBody = z.infer<typeof kmaForecastBodySchema>;

/**
 * The outer envelope needed only to *classify* a response: a valid `response.header`. The body
 * is left unvalidated here (and stripped) so a non-success code can be reported as an upstream
 * error without first proving the body is well-formed — the official error responses may carry
 * no usable body at all.
 */
export const kmaResponseEnvelopeSchema = z.object({
  response: z.object({
    header: kmaResponseHeaderSchema,
  }),
});

/**
 * The full success envelope: valid header **and** a well-formed body. Applied only after the
 * header has been confirmed and `resultCode` equals {@link KMA_SUCCESS_RESULT_CODE}.
 */
export const kmaForecastSuccessResponseSchema = z.object({
  response: z.object({
    header: kmaResponseHeaderSchema,
    body: kmaForecastBodySchema,
  }),
});
