/**
 * Runtime (Zod) schemas for the **raw** KMA (기상청) short-term / ultra-short-term forecast
 * JSON response — the untrusted boundary between the external 기상청_단기예보 조회서비스 and this
 * backend. Nothing here fetches, reads an environment variable, or knows a service key; these
 * schemas only *validate the shape* of an already-parsed JSON value.
 *
 * The envelope structure and each field's type come from the official field spec (the
 * 공공데이터포털 상세기능 표 and the 활용가이드 응답 명세), not from memory or blogs — see
 * `docs/kma-response-boundary.md` (`기상청_단기예보 조회서비스`, 공공데이터 ID `15084084`, 활용가이드
 * `2607`; cross-checked against the 기상청 API 허브 `VilageFcstInfoService_2.0` 활용가이드). The
 * official response examples are XML-centric, so the exact JSON serialization is modelled from the
 * field-type spec and re-confirmation against an authenticated JSON response is deferred to PR #5;
 * that doc records where each choice is spec-backed vs. a documented defensive allowance.
 * The two in-scope operations — `getVilageFcst` (단기예보) and `getUltraSrtFcst` (초단기예보) —
 * share the *same* item shape (only their category codes differ), so one item schema serves both.
 *
 * Type discipline (see the guide doc for the evidence behind each choice):
 *
 * - No `z.coerce`. A numeric string is never turned into a number and a number is never turned
 *   into a string. The spec keeps `fcstValue`/dates/times as strings and `nx`/`ny`/pagination as
 *   numbers; we mirror that exactly.
 * - `dataType` is the literal `'JSON'` — this boundary only validates already-parsed JSON, so any
 *   other `dataType` is an invalid response, not a success body.
 * - `z.number()` in Zod 4 already rejects `NaN`/`Infinity`/`-Infinity`, so every numeric schema
 *   is finite by construction; `.int()` further rejects non-integers.
 * - Unknown *extra* keys are dropped by Zod's default object strip. A brand-new `category` code
 *   is still accepted, because `category` is validated by its character class (`[A-Z0-9]+`), not
 *   as an enum; `resultCode` is likewise validated structurally (two digits), not as an enum.
 * - A missing required field is a hard failure (not "normal" data). `fcstValue` is the one field
 *   that may be explicitly `null` (see below); every other item field is required and non-null.
 */

import { z } from 'zod';

import { isCalendarDate, isClockTime } from './validation';

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
//
// The `YYYYMMDD` calendar-date and `HHmm` clock-time predicates live in `./validation` so the
// request layer (`request.ts`) validates dates/times with the exact same rules this response
// boundary uses. Their behavior is unchanged from PR #4; only their location moved.

/** `baseDate` / `fcstDate` — an official `YYYYMMDD` string that is also a real calendar date. */
const kmaDate = z
  .string()
  .refine(isCalendarDate, { message: 'must be a valid YYYYMMDD calendar date' });

/** `baseTime` / `fcstTime` — an official `HHmm` (`HH24MI`) clock time. */
const kmaTime = z
  .string()
  .refine(isClockTime, { message: 'must be a valid HHmm (HH24MI) time' });

/**
 * `category` (자료구분문자) — a non-empty code of ASCII uppercase letters and digits only, the
 * shape every official 단기예보/초단기예보 code takes (`TMP`, `RN1`, `SKY`, `PTY`, …). Not an
 * enum: an unknown/future code (e.g. a category KMA adds later) must pass through the raw
 * boundary untouched — as long as it is the same character class — because normalizing codes
 * into common states is `weather-core`'s job. The pattern rejects the empty string, a
 * whitespace-only string, surrounding whitespace, *internal* space/tab/newline, control
 * characters, lower-case, and non-ASCII, so a contaminated value is never silently accepted as
 * a code (there is no official basis for a code outside `[A-Z0-9]`).
 */
const kmaCategory = z.string().regex(/^[A-Z0-9]+$/, {
  message: 'must contain only ASCII uppercase letters and digits',
});

/**
 * `fcstValue` (예보 값). The official field spec types this as a **string** — even the
 * "실수로 제공" categories (TMP, TMN, TMX, UUU, VVV, WAV, WSD) are documented string-encoded
 * (e.g. `"-2"`, `"6.2"`) — so a number is *not* accepted (no numeric coercion), and objects and
 * arrays are rejected. The field key itself is required; its value may be an explicit `null`.
 * Accepting explicit `null` while still failing on a *missing* key is deliberate: it is the only
 * way the field-presence model can distinguish "item present but value null" from "item absent"
 * (see `groupKmaForecastItems`). A missing key is a schema failure, never treated as `null`.
 *
 * Evidence caveat: no official JSON sample showing a literal `null` `fcstValue` has been
 * confirmed; the `null` branch is a *defensive* allowance for the field-presence model and is to
 * be re-confirmed against an authenticated JSON response in PR #5 (see the guide doc).
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

/**
 * `resultCode` — the official code is **exactly two digits** (`00`, `03`, `30`, `99`, …). This is
 * a structural check, not an allow-list: unknown *future* two-digit codes stay valid so a new
 * error code is classified as an upstream error rather than rejected. But a structurally
 * malformed code (`""`, `"0"`, `"000"`, `"AB"`, `" 03 "`, `"03 "`, `"+3"`) is not a KMA code at
 * all, so it fails the envelope here and is reported as an invalid response — never mistaken for
 * a genuine upstream error. Kept as a string and never coerced, so `"00"` keeps its leading zero.
 */
const kmaResultCode = z.string().regex(/^\d{2}$/, {
  message: 'must be a two-digit KMA result code',
});

// ---------------------------------------------------------------------------
// Object schemas
// ---------------------------------------------------------------------------

/**
 * `response.header`. `resultCode` is a two-digit code string (never coerced to a number, so a
 * success code (`'00'`) keeps its leading zero); `resultMsg` is a plain string that is validated
 * for shape but is **never** surfaced on a public error (see `parse-response.ts`). This is the
 * only part of the envelope needed to classify a response as success vs. upstream error.
 */
export const kmaResponseHeaderSchema = z.object({
  resultCode: kmaResultCode,
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
 * `response.body` for a success (`resultCode === '00'`). `dataType` is the literal `'JSON'`: this
 * boundary only ever validates an already-`JSON.parse`d JSON response, so an `'XML'` (or `''`,
 * `'json'`, or any other) `dataType` is not a success body — it is an invalid response.
 *
 * Pagination fields use the official JSON numeric types. `totalCount` is intentionally *not*
 * asserted to equal the current page's item count (pagination means a page may hold fewer items
 * than `totalCount`), but three *impossible* combinations are rejected via `superRefine`:
 *
 * - `items.item.length > numOfRows` — a page cannot hold more rows than its own page size.
 * - `items.item.length > totalCount` — a page cannot hold more items than the grand total.
 * - `totalCount === 0` with a non-empty `items.item` — zero total records but items present.
 *
 * These are *self-contradictions within one page*, not policy guesses. What is deliberately left
 * permissive: `totalCount > 0` with an empty `items.item` (no official empty-success-page sample
 * has been confirmed, so it is allowed defensively rather than made a merge-blocking rule — see
 * `docs/kma-response-boundary.md`) and any `item.length < totalCount` (normal pagination).
 */
export const kmaForecastBodySchema = z
  .object({
    dataType: z.literal('JSON'),
    pageNo: kmaPageNumber,
    numOfRows: kmaRowCount,
    totalCount: kmaTotalCount,
    items: kmaForecastItemsSchema,
  })
  .superRefine((body, ctx) => {
    const itemCount = body.items.item.length;

    if (itemCount > body.numOfRows) {
      ctx.addIssue({
        code: 'custom',
        path: ['items', 'item'],
        message: 'item count must not exceed numOfRows',
      });
    }

    // `> totalCount` already implies the `totalCount === 0 && itemCount > 0` contradiction, so
    // the two checks are mutually exclusive and never both fire for the same body.
    if (body.totalCount === 0) {
      if (itemCount > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['items', 'item'],
          message: 'items must be empty when totalCount is zero',
        });
      }
    } else if (itemCount > body.totalCount) {
      ctx.addIssue({
        code: 'custom',
        path: ['items', 'item'],
        message: 'item count must not exceed totalCount',
      });
    }
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
