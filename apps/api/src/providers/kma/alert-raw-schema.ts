/**
 * Runtime (Zod) schemas for the **raw** KMA (기상청) 기상특보 조회서비스 (`WthrWrnInfoService`)
 * 특보코드조회 (`getPwnCd`) JSON response — the untrusted boundary between the external service and
 * this backend. Nothing here fetches, reads an environment variable, or knows a service key; these
 * schemas only *validate the shape* of an already-parsed JSON value.
 *
 * Evidence: the official `기상청21_기상특보 조회서비스_오픈API활용가이드_260601` guide plus the
 * Owner-authorized live JSON diagnostic run 2026-08-25 (see `docs/kma-alert-event-provider.md`
 * for the full evidence record — no raw response, real alert content, or service key is recorded
 * there or here). The envelope `response.header` shape and success-code policy are **identical**
 * to the forecast/current-observation boundary, so this module reuses `kmaResponseHeaderSchema` /
 * `KMA_SUCCESS_RESULT_CODE` / `kmaResponseEnvelopeSchema` from `raw-schema.ts` rather than
 * redefining them.
 *
 * `getPwnCd` returns KMA alert **lifecycle/event** records (issue, release, extension, correction,
 * change) — not a "currently active alert" snapshot. This module validates only the confirmed raw
 * item shape; interpreting `command`/`cancel`/the time fields into an active-alert state is
 * explicitly deferred to a later PR (see the module doc in `provider.ts` and
 * `docs/kma-alert-event-provider.md`).
 *
 * Type discipline (identical policy to the forecast/current boundaries): no `z.coerce`; a numeric
 * field observed as `NUMBER` in the live diagnostic is never accepted as a string and vice versa;
 * unknown extra keys are dropped by Zod's default object strip; a missing required field is a hard
 * failure. Unlike `fcstValue`/`obsrValue`, **no field here is modeled as nullable** — the live
 * diagnostic's per-item field-type matrix showed a single consistent JSON type for every field on
 * every observed item, with no `NULL` variant, so no defensive `.nullable()` allowance is added
 * without evidence.
 */

import { z } from 'zod';

import { kmaResponseHeaderSchema } from './raw-schema.js';

/**
 * The confirmed `getPwnCd`-specific no-data `resultCode`. Per the live diagnostic, `03` for this
 * operation carries no `response.body` at all and represents a valid zero-match result — not a
 * provider failure (see `parse-alert-response.ts`). This is an *operation-specific* semantic: the
 * forecast/current-observation boundaries classify `03` as a generic `UPSTREAM_ERROR` (see
 * `raw-schema.ts`), and that policy is unchanged by this constant.
 */
export const KMA_ALERT_NO_DATA_RESULT_CODE = '03';

/**
 * `stnId` / `areaCode` / `areaName` / `command` / `cancel` — all confirmed `STRING` by the live
 * diagnostic. No official character-class spec was consulted for these (unlike `category`'s
 * documented `[A-Z0-9]+`), so only "required, non-empty string" is enforced — no speculative
 * regex/enum is imposed without evidence.
 */
const kmaAlertString = z.string().min(1);

/**
 * `tmFc` / `tmSeq` / `warnVar` / `warnStress` / `startTime` / `endTime` / `allEndTime` — all
 * confirmed `NUMBER` by the live diagnostic. Modeled as integers: every one of these is a
 * code/sequence/date-time-encoded value with no documented or observed fractional form. `z.number()`
 * already rejects `NaN`/`Infinity`/`-Infinity`; `.int()` further rejects non-integers. No upper/
 * lower bound is imposed — no official range is documented, so none is guessed here.
 */
const kmaAlertInteger = z.number().int();

/**
 * One `getPwnCd` alert-event item. Every field is required and non-null (see the module doc for
 * why no field is modeled nullable here, unlike `fcstValue`/`obsrValue`). Unknown extra keys are
 * stripped by Zod's default. Field set and JSON types come directly from the live diagnostic's
 * per-item type matrix — not from the XML-centric guide examples alone.
 */
export const kmaAlertEventItemSchema = z.object({
  stnId: kmaAlertString,
  tmFc: kmaAlertInteger,
  tmSeq: kmaAlertInteger,
  areaCode: kmaAlertString,
  areaName: kmaAlertString,
  warnVar: kmaAlertInteger,
  warnStress: kmaAlertInteger,
  command: kmaAlertString,
  startTime: kmaAlertInteger,
  endTime: kmaAlertInteger,
  allEndTime: kmaAlertInteger,
  cancel: kmaAlertString,
});

export type KmaAlertEventItem = z.infer<typeof kmaAlertEventItemSchema>;

/**
 * `response.body.items`. Matches the confirmed positive-sample shape: the list is nested under
 * `items.item`, which must be an **array** — a single object is *not* accepted here, because that
 * serialization was never independently observed (the confirmed positive sample held 2 records).
 * If a later live/official sample proves a single-object `item` serialization, that is a separate,
 * evidenced correction — not something this schema guesses at now. An empty array is allowed and
 * yields an empty page (distinct from the confirmed `03` no-data outcome — see
 * `parse-alert-response.ts`).
 */
export const kmaAlertEventItemsSchema = z.object({
  item: z.array(kmaAlertEventItemSchema),
});

/** A 1-based page index (`pageNo`). */
const kmaAlertPageNumber = z.number().int().min(1);

/** A page size (`numOfRows`) — at least one row per page. */
const kmaAlertRowCount = z.number().int().min(1);

/** A total record count (`totalCount`) — non-negative; may be `0`. */
const kmaAlertTotalCount = z.number().int().min(0);

/**
 * `response.body` for a success (`resultCode === '00'`). Pagination fields use the official JSON
 * numeric types confirmed by the live diagnostic. Same self-contradiction policy as the forecast/
 * current-observation body schemas (see `raw-schema.ts` for the full rationale):
 *
 * - `items.item.length > numOfRows` — rejected.
 * - `items.item.length > totalCount` — rejected.
 * - `totalCount === 0` with a non-empty `items.item` — rejected.
 *
 * `totalCount > 0` with an empty `items.item` is left permissive (normal pagination), matching the
 * forecast/current boundaries' documented allowance.
 */
export const kmaAlertEventBodySchema = z
  .object({
    dataType: z.literal('JSON'),
    pageNo: kmaAlertPageNumber,
    numOfRows: kmaAlertRowCount,
    totalCount: kmaAlertTotalCount,
    items: kmaAlertEventItemsSchema,
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

export type KmaAlertEventBody = z.infer<typeof kmaAlertEventBodySchema>;

/**
 * The full success envelope: the shared `kmaResponseHeaderSchema` (imported from `raw-schema.ts`)
 * **and** a well-formed alert-event body. Applied only after the header has been confirmed valid
 * and `resultCode` equals `KMA_SUCCESS_RESULT_CODE` (see `parse-alert-response.ts`).
 */
export const kmaAlertEventSuccessResponseSchema = z.object({
  response: z.object({
    header: kmaResponseHeaderSchema,
    body: kmaAlertEventBodySchema,
  }),
});

/**
 * The confirmed `resultCode === '03'` no-data shape: a valid header **and no `body` key at all**
 * (`.strict()` on `response` rejects an unexpected `body`, rather than silently ignoring it). This
 * is deliberately stricter than the generic envelope schema so a `03` response that *does* carry a
 * body — contradicting the confirmed shape — fails this schema and is handled conservatively by
 * the parser (as `INVALID_RESPONSE`), rather than being silently accepted as either a success page
 * or the confirmed no-data outcome. See `docs/kma-alert-event-provider.md` for the live evidence.
 */
export const kmaAlertNoDataResponseSchema = z.object({
  response: z
    .object({
      header: kmaResponseHeaderSchema,
    })
    .strict(),
});
