/**
 * Runtime (Zod) schemas for the **raw** KMA (기상청) 초단기실황 (`getUltraSrtNcst`, ultra-short-term
 * *current observation*) JSON response — the untrusted boundary between the external
 * 기상청_단기예보 조회서비스 and this backend. Nothing here fetches, reads an environment variable, or
 * knows a service key; these schemas only *validate the shape* of an already-parsed JSON value.
 *
 * This is a **separate** schema module from `raw-schema.ts` (the forecast response boundary):
 * current observation is a distinct operation with a distinct item shape — `obsrValue` (관측값),
 * not `fcstValue`, and no `fcstDate`/`fcstTime` (current observation has no forecast target time,
 * only the observation's own `baseDate`/`baseTime`). See
 * `docs/kma-current-observation-provider.md` for the official-source evidence. The envelope
 * `response.header` shape and success-code policy are **identical** to the forecast boundary, so
 * this module reuses `kmaResponseHeaderSchema` / `KMA_SUCCESS_RESULT_CODE` /
 * `kmaResponseEnvelopeSchema` from `raw-schema.ts` rather than redefining them.
 *
 * Type discipline (identical policy to the forecast boundary — see its docblock for the evidence):
 * no `z.coerce`; `dataType` is the literal `'JSON'`; unknown extra keys are dropped by Zod's
 * default object strip; a missing required field is a hard failure, but `obsrValue` may be an
 * explicit `null` (see below) so the field-presence model can distinguish "absent" from "present
 * but null" from "present with a value".
 */

import { z } from 'zod';

import { kmaResponseHeaderSchema } from './raw-schema.js';
import { isCalendarDate, isClockTime } from './validation.js';

/** `baseDate` — an official `YYYYMMDD` string that is also a real calendar date. */
const kmaCurrentDate = z
  .string()
  .refine(isCalendarDate, { message: 'must be a valid YYYYMMDD calendar date' });

/** `baseTime` — an official `HHmm` (`HH24MI`) clock time. */
const kmaCurrentTime = z
  .string()
  .refine(isClockTime, { message: 'must be a valid HHmm (HH24MI) time' });

/**
 * `category` (자료구분문자) — the same ASCII-uppercase/digit character class as the forecast
 * boundary (`T1H`, `PTY`, `REH`, `WSD`, `VEC`, `RN1`, …). Not an enum, for the same reason: an
 * unknown/future current-observation category must pass through this raw boundary untouched, as
 * long as it is the same character class, because interpreting codes is `weather-core`'s job.
 */
const kmaCurrentCategory = z.string().regex(/^[A-Z0-9]+$/, {
  message: 'must contain only ASCII uppercase letters and digits',
});

/**
 * `obsrValue` (관측값). Modeled the same way as the forecast boundary's `fcstValue`: the official
 * field spec types this as a **string** (even numeric categories are string-encoded), so a number
 * is not accepted (no numeric coercion) and objects/arrays are rejected. The field key itself is
 * required; its value may be an explicit `null` — required so the field-presence model
 * (`group-current-observation-items.ts`) can distinguish "category present with a null value" from
 * "category absent". As with `fcstValue`, no official JSON sample showing a literal `null`
 * `obsrValue` has been confirmed; this is the same documented defensive allowance, carried over
 * for the same field-presence reason, and is to be re-confirmed against an authenticated JSON
 * response in a future live-verification PR.
 */
const kmaCurrentObservationValue = z.string().nullable();

/**
 * A current-observation grid coordinate (`nx` / `ny`). Same policy as the forecast boundary:
 * finite, integer, non-negative, no upper bound imposed (no reliable official maximum documented).
 */
const kmaCurrentGridCoordinate = z.number().int().min(0);

/** A 1-based page index (`pageNo`). */
const kmaCurrentPageNumber = z.number().int().min(1);

/** A page size (`numOfRows`) — at least one row per page. */
const kmaCurrentRowCount = z.number().int().min(1);

/** A total record count (`totalCount`) — non-negative; may be `0`. */
const kmaCurrentTotalCount = z.number().int().min(0);

/**
 * One current-observation `item`. Every field is required; only `obsrValue` may be explicitly
 * `null`. Unknown extra keys are stripped by Zod's default. Unlike a forecast item, there is no
 * `fcstDate`/`fcstTime`/`fcstValue` — 초단기실황 carries only the observation's own
 * `baseDate`/`baseTime`.
 */
export const kmaCurrentObservationItemSchema = z.object({
  baseDate: kmaCurrentDate,
  baseTime: kmaCurrentTime,
  category: kmaCurrentCategory,
  obsrValue: kmaCurrentObservationValue,
  nx: kmaCurrentGridCoordinate,
  ny: kmaCurrentGridCoordinate,
});

export type KmaCurrentObservationItem = z.infer<typeof kmaCurrentObservationItemSchema>;

/**
 * `response.body.items`. Same shape as the forecast boundary: the list is nested under
 * `items.item`, which must be an **array** (a single object or empty string is rejected). An empty
 * array is allowed and yields an empty page.
 */
export const kmaCurrentObservationItemsSchema = z.object({
  item: z.array(kmaCurrentObservationItemSchema),
});

/**
 * `response.body` for a success (`resultCode === '00'`). Same pagination self-contradiction policy
 * as the forecast boundary (see `raw-schema.ts` for the full rationale):
 *
 * - `items.item.length > numOfRows` — rejected.
 * - `items.item.length > totalCount` — rejected.
 * - `totalCount === 0` with a non-empty `items.item` — rejected.
 *
 * `totalCount > 0` with an empty `items.item` (no official empty-success-page sample confirmed) is
 * left permissive, matching the forecast boundary's documented defensive allowance — a downstream
 * consumer must not fabricate current-observation values for such a page.
 */
export const kmaCurrentObservationBodySchema = z
  .object({
    dataType: z.literal('JSON'),
    pageNo: kmaCurrentPageNumber,
    numOfRows: kmaCurrentRowCount,
    totalCount: kmaCurrentTotalCount,
    items: kmaCurrentObservationItemsSchema,
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

export type KmaCurrentObservationBody = z.infer<typeof kmaCurrentObservationBodySchema>;

/**
 * The full success envelope: the shared `kmaResponseHeaderSchema` (imported from `raw-schema.ts` —
 * the header shape and success-code policy are identical to the forecast boundary) **and** a
 * well-formed current-observation body. Applied only after the header has been confirmed valid and
 * `resultCode` equals `KMA_SUCCESS_RESULT_CODE` (see `parse-current-response.ts`).
 */
export const kmaCurrentObservationSuccessResponseSchema = z.object({
  response: z.object({
    header: kmaResponseHeaderSchema,
    body: kmaCurrentObservationBodySchema,
  }),
});
