/**
 * Runtime (Zod) schemas for the **raw** AirKorea (에어코리아) 근접측정소 목록 조회
 * (`getNearbyMsrstnList`) JSON response — the untrusted boundary between the external 측정소정보
 * 조회 서비스 (`MsrstnInfoInqireSvc`) and this backend. Nothing here fetches, reads an environment
 * variable, or knows a service key; these schemas only *validate the shape* of an already-parsed
 * JSON value.
 *
 * Official-source evidence (see `docs/airkorea-nearby-station-provider.md` for the full record,
 * including the transcribed request/response field tables and the request/response XML example):
 * 한국환경공단_에어코리아_측정소정보 (Public Data Portal dataset `15073877`, portal metadata modified
 * 2026-06-30), reference document `한국환경공단_에어코리아_측정소정보_기술문서_v1.2.docx`.
 *
 * This module reuses `airKoreaResponseHeaderSchema`/`airKoreaResponseEnvelopeSchema`/
 * `AIRKOREA_SUCCESS_RESULT_CODE` from `./current-raw-schema.js` — both operations are part of the
 * same `B552584` 공공데이터포털 service family and document an identical `resultCode`(2-digit)/
 * `resultMsg` header envelope, so this is intra-namespace reuse of a genuinely shared contract, not
 * a cross-provider (`../kma/*`) import. `stationName`'s field-size predicate
 * (`isAirKoreaStationName`, from `./current-request.js`) is reused for the same reason — the
 * technical document documents an identical 측정소명 항목크기 (30) for both operations.
 *
 * Type discipline: no `z.coerce`; unknown extra keys are dropped by Zod's default object strip.
 * This provider consumes only `stationName` and `tm` (거리, km) from each item — the technical
 * document's field table marks both *required* (항목구분: 1) for this operation, so an absent key
 * for either is rejected here as malformed. `stationCode`/`addr` are documented fields this provider
 * does not consume; they are stripped by Zod's default rather than declared. `stationCode` is,
 * per the technical document's own 버전(ver) notes, only present when `ver=1.1`/`1.2` is requested —
 * this provider never sends `ver` (see `nearby-station-request.ts`), and the document's own
 * no-version request/response example does not include it, so it is never expected here regardless.
 */

import { z } from 'zod';

import { airKoreaResponseHeaderSchema } from './current-raw-schema.js';
import { isAirKoreaStationName } from './current-request.js';

const airKoreaNearbyStationName = z.string().refine(isAirKoreaStationName, {
  message: 'must be a well-formed AirKorea station name',
});

/**
 * `tm` (거리, km) as documented: a required string field (항목구분: 1) — the technical document's
 * request/response example shows plain non-negative decimal text (`8.2`, `9.3`, `9.7`), with no
 * documented "missing distance" sentinel (unlike `khaiValue`'s `"-"` in the current-air-quality
 * operation — a computed distance to a returned station is always calculable). This schema only
 * checks that the key is present and holds a string; shape-vs-value parsing is
 * {@link parseAirKoreaNearbyStationDistanceKm}'s job, matching the project's raw-boundary-vs-
 * semantic-parsing split (see `current-raw-schema.ts`'s `pm10Value` etc.).
 */
const airKoreaNearbyStationDistance = z.string();

/** Matches a non-negative plain-decimal distance string (no sign, no exponent). */
const AIRKOREA_DISTANCE_PATTERN = /^\d+(\.\d+)?$/;

/**
 * Parse a raw `tm` string into a finite, non-negative kilometre distance, or `null` if it is not a
 * well-formed non-negative decimal (rejects a sign, exponent notation, empty string, and any text
 * that is not exactly digits with an optional decimal fraction) or if the parsed value is not
 * finite (an implausibly long digit string can overflow to `Infinity`). Never promotes malformed
 * text to a fabricated distance. Pure — no `Date`, no system clock, no I/O.
 */
export function parseAirKoreaNearbyStationDistanceKm(value: string): number | null {
  if (!AIRKOREA_DISTANCE_PATTERN.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * One 근접측정소 목록 조회 `item`. Both consumed fields (`stationName`, `tm`) are documented
 * *required* (항목구분: 1) — an absent key for either is rejected here as a malformed response, not
 * silently accepted. Unknown extra keys (`stationCode`, `addr`) are stripped by Zod's default — this
 * provider does not consume them.
 */
export const airKoreaNearbyStationItemSchema = z.object({
  stationName: airKoreaNearbyStationName,
  tm: airKoreaNearbyStationDistance,
});

export type AirKoreaNearbyStationItem = z.infer<typeof airKoreaNearbyStationItemSchema>;

/** `response.body.items`. The list is nested under `items.item`, which must be an **array**. */
export const airKoreaNearbyStationItemsSchema = z.object({
  item: z.array(airKoreaNearbyStationItemSchema),
});

/** A 1-based page index (`pageNo`). */
const airKoreaPageNumber = z.number().int().min(1);

/** A page size (`numOfRows`) — at least one row per page. This operation echoes a server-chosen
 * default (the document's own example shows `numOfRows: 10` for a request that never sent
 * `numOfRows`); this provider never sends it as a request parameter. */
const airKoreaRowCount = z.number().int().min(1);

/** A total record count (`totalCount`) — non-negative; may be `0`. */
const airKoreaTotalCount = z.number().int().min(0);

/**
 * `response.body` for a success (`resultCode === '00'`). Same defensive pagination
 * self-contradiction policy as `current-raw-schema.ts`'s body schema (the technical document does
 * not explicitly document these invariants for this operation either): item count must not exceed
 * `numOfRows`; `totalCount === 0` requires an empty item list; a non-zero `totalCount` bounds the
 * item count from above.
 */
export const airKoreaNearbyStationBodySchema = z
  .object({
    numOfRows: airKoreaRowCount,
    pageNo: airKoreaPageNumber,
    totalCount: airKoreaTotalCount,
    items: airKoreaNearbyStationItemsSchema,
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

export type AirKoreaNearbyStationBody = z.infer<typeof airKoreaNearbyStationBodySchema>;

/**
 * The full success envelope: the shared header schema **and** a well-formed 근접측정소 목록 조회
 * body. Applied only after the header has been confirmed valid and `resultCode` equals
 * {@link AIRKOREA_SUCCESS_RESULT_CODE} (see `parse-nearby-station-response.ts`).
 */
export const airKoreaNearbyStationSuccessResponseSchema = z.object({
  response: z.object({
    header: airKoreaResponseHeaderSchema,
    body: airKoreaNearbyStationBodySchema,
  }),
});
