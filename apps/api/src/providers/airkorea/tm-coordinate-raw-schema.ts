/**
 * Runtime (Zod) schemas for the **raw** AirKorea (에어코리아) TM 기준좌표 조회 (`getTMStdrCrdnt`) JSON
 * response — the untrusted boundary between the external 측정소정보 조회 서비스
 * (`MsrstnInfoInqireSvc`) and this backend. Nothing here fetches, reads an environment variable, or
 * knows a service key; these schemas only *validate the shape* of an already-parsed JSON value.
 *
 * Official-source evidence (see `docs/airkorea-tm-coordinate-provider.md` for the full record,
 * including the transcribed request/response field tables and the request/response XML example):
 * 한국환경공단_에어코리아_측정소정보 (Public Data Portal dataset `15073877`, portal metadata modified
 * 2026-06-30), reference document `한국환경공단_에어코리아_측정소정보_기술문서_v1.2.docx`.
 *
 * This module reuses `airKoreaResponseHeaderSchema`/`airKoreaResponseEnvelopeSchema`/
 * `AIRKOREA_SUCCESS_RESULT_CODE` from `./current-raw-schema.js` — all three `MsrstnInfoInqireSvc`/
 * `ArpltnInforInqireSvc` operations in this namespace are part of the same `B552584`
 * 공공데이터포털 service family and document an identical `resultCode`(2-digit)/`resultMsg` header
 * envelope, so this is intra-namespace reuse of a genuinely shared contract, not a cross-provider
 * (`../kma/*`) import.
 *
 * Type discipline: no `z.coerce`; unknown extra keys are dropped by Zod's default object strip. This
 * provider consumes `sidoName`, `sggName`, `umdName`, `tmX`, `tmY` from each item — the technical
 * document's field table marks all five *required* (항목구분: 1) for this operation, so an absent key
 * for any of them is rejected here as malformed.
 *
 * `sidoName`/`sggName`/`umdName` in the *response* document a field size of 20 — a different (smaller)
 * bound than the *request* `umdName`'s documented 60 (see `tm-coordinate-request.ts`). This is not a
 * project inconsistency: the technical document genuinely states two different 항목크기 values for
 * the same field name in its request table (§ b) versus its response table (§ c), so this module
 * defines its own response-side predicate rather than reusing the request-side one.
 */

import { z } from 'zod';

import { airKoreaResponseHeaderSchema } from './current-raw-schema.js';

/** The official field-size bound for each *response* administrative-name field (문서 항목크기: 20). */
const AIRKOREA_TM_COORDINATE_ADMIN_NAME_MAX_LENGTH = 20;

/** Matches a C0 control character or DEL — rejected in `sidoName`/`sggName`/`umdName`. */
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

/**
 * Whether `value` is a well-formed response administrative-name field (`sidoName`/`sggName`/
 * `umdName`): a non-empty string, no leading/trailing whitespace, at most
 * {@link AIRKOREA_TM_COORDINATE_ADMIN_NAME_MAX_LENGTH} UTF-16 code units, and free of C0 control
 * characters/DEL — the same discipline `isAirKoreaStationName`/`isAirKoreaAdministrativeDongName`
 * apply to their own fields, at this operation's own documented response size.
 */
function isAirKoreaTmCoordinateAdministrativeName(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  if (value.length === 0 || value.length > AIRKOREA_TM_COORDINATE_ADMIN_NAME_MAX_LENGTH) {
    return false;
  }
  if (value !== value.trim()) {
    return false;
  }
  return !CONTROL_CHARACTER_PATTERN.test(value);
}

const airKoreaTmCoordinateAdministrativeName = z
  .string()
  .refine(isAirKoreaTmCoordinateAdministrativeName, {
    message: 'must be a well-formed AirKorea administrative-name field (max 20 characters)',
  });

/**
 * `tmX`/`tmY` as documented: required string fields (항목구분: 1) — the technical document's
 * request/response example shows plain decimal text (`200089.126044`, `453946.42329`), with no
 * documented "missing coordinate" sentinel (every returned row officially has a coordinate). This
 * schema only checks that the key is present and holds a string; shape-vs-value parsing is
 * {@link parseAirKoreaTmCoordinateValue}'s job, matching the project's raw-boundary-vs-semantic-
 * parsing split (see `nearby-station-raw-schema.ts`'s `tm` for the same pattern).
 */
const airKoreaTmCoordinateValue = z.string();

/**
 * Matches an optionally negative, non-exponent plain-decimal coordinate string. A leading `-` is
 * permitted (unlike `nearby-station-raw-schema.ts`'s non-negative `tm` distance) because `tmX`/`tmY`
 * are Cartesian coordinates, not a distance, and the project's own request-side TM-coordinate
 * predicate (`isAirKoreaTmCoordinate`, `nearby-station-request.ts`) already treats a negative TM
 * coordinate as valid — this keeps the request-side and response-side definitions of "a TM
 * coordinate" consistent rather than inventing a narrower one here.
 */
const AIRKOREA_TM_COORDINATE_PATTERN = /^-?\d+(\.\d+)?$/;

/**
 * Parse a raw `tmX`/`tmY` string into a finite coordinate number, or `null` if it is not a
 * well-formed plain-decimal number (rejects a leading `+`, exponent notation, empty string, and any
 * text that is not exactly an optional `-` then digits with an optional decimal fraction) or if the
 * parsed value is not finite (an implausibly long digit string can overflow to `Infinity`). Never
 * promotes malformed text to a fabricated coordinate (in particular, never `0`). Pure — no `Date`, no
 * system clock, no I/O.
 */
export function parseAirKoreaTmCoordinateValue(value: string): number | null {
  if (!AIRKOREA_TM_COORDINATE_PATTERN.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * One TM 기준좌표 조회 `item`. All five consumed fields (`sidoName`, `sggName`, `umdName`, `tmX`,
 * `tmY`) are documented *required* (항목구분: 1) — an absent key for any of them is rejected here as
 * a malformed response, not silently accepted.
 */
export const airKoreaTmCoordinateItemSchema = z.object({
  sidoName: airKoreaTmCoordinateAdministrativeName,
  sggName: airKoreaTmCoordinateAdministrativeName,
  umdName: airKoreaTmCoordinateAdministrativeName,
  tmX: airKoreaTmCoordinateValue,
  tmY: airKoreaTmCoordinateValue,
});

export type AirKoreaTmCoordinateItem = z.infer<typeof airKoreaTmCoordinateItemSchema>;

/** `response.body.items`. The list is nested under `items.item`, which must be an **array**. */
export const airKoreaTmCoordinateItemsSchema = z.object({
  item: z.array(airKoreaTmCoordinateItemSchema),
});

/** A 1-based page index (`pageNo`). */
const airKoreaPageNumber = z.number().int().min(1);

/**
 * A page size (`numOfRows`) — at least one row per page. This provider always sends a fixed
 * `numOfRows` request value (`tm-coordinate-request.ts`); this schema only validates the echoed
 * response value's shape.
 */
const airKoreaRowCount = z.number().int().min(1);

/** A total record count (`totalCount`) — non-negative; may be `0`. */
const airKoreaTotalCount = z.number().int().min(0);

/**
 * `response.body` for a success (`resultCode === '00'`). Same defensive pagination
 * self-contradiction policy as `current-raw-schema.ts`/`nearby-station-raw-schema.ts`'s body
 * schemas (the technical document does not explicitly document these invariants for this operation
 * either): item count must not exceed `numOfRows`; `totalCount === 0` requires an empty item list; a
 * non-zero `totalCount` bounds the item count from above. Completeness across pages
 * (`totalCount > items.length`) is `provider.ts`'s semantic responsibility, not enforced here — a
 * `totalCount` larger than the returned item count is a structurally valid partial page.
 */
export const airKoreaTmCoordinateBodySchema = z
  .object({
    numOfRows: airKoreaRowCount,
    pageNo: airKoreaPageNumber,
    totalCount: airKoreaTotalCount,
    items: airKoreaTmCoordinateItemsSchema,
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

export type AirKoreaTmCoordinateBody = z.infer<typeof airKoreaTmCoordinateBodySchema>;

/**
 * The full success envelope: the shared header schema **and** a well-formed TM 기준좌표 조회 body.
 * Applied only after the header has been confirmed valid and `resultCode` equals
 * {@link AIRKOREA_SUCCESS_RESULT_CODE} (see `parse-tm-coordinate-response.ts`).
 */
export const airKoreaTmCoordinateSuccessResponseSchema = z.object({
  response: z.object({
    header: airKoreaResponseHeaderSchema,
    body: airKoreaTmCoordinateBodySchema,
  }),
});
