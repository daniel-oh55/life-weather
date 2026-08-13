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
 *
 * `body.items` is a **direct array** (not a `{ item: [...] }` wrapper) and `tm` is a JSON
 * **number** (not a string) — both confirmed by an Owner-executed authenticated Public Data Portal
 * preview call on 2026-08-13 that observed numeric `tm` values including `1.5`/`1.7`/`1.9` (see
 * `docs/airkorea-nearby-station-provider.md`, "Owner-observed live JSON evidence"). The technical
 * document's own request/response example only showed XML text, so the project previously treated
 * `tm` as a string by analogy with the current-air-quality operation; that assumption is now
 * corrected by live evidence, not by speculative coercion.
 */

import { z } from 'zod';

import { airKoreaResponseHeaderSchema } from './current-raw-schema.js';
import { isAirKoreaStationName } from './current-request.js';

const airKoreaNearbyStationName = z.string().refine(isAirKoreaStationName, {
  message: 'must be a well-formed AirKorea station name',
});

/**
 * `tm` (거리, km) as live-observed: a required JSON **number** field (항목구분: 1) — the technical
 * document's own request/response example only showed XML text with no documented "missing
 * distance" sentinel (a computed distance to a returned station is always calculable), but an
 * Owner-executed authenticated Public Data Portal preview call on 2026-08-13 confirmed the JSON
 * serialization is a bare number (observed values included `1.5`/`1.7`/`1.9`), not a string. No
 * `z.coerce` — a string `tm` (even a numeric-looking one) is rejected, not silently accepted for
 * backward compatibility with the project's earlier (pre-live-evidence) string assumption. This
 * schema only checks that the key is present and holds a JSON number; finite/non-negative
 * range-checking is {@link parseAirKoreaNearbyStationDistanceKm}'s job, matching the project's
 * raw-boundary-vs-semantic-parsing split (see `current-raw-schema.ts`'s `pm10Value` etc.).
 */
const airKoreaNearbyStationDistance = z.number();

/**
 * Validate a raw `tm` number into a finite, non-negative kilometre distance, or `null` if it is not
 * finite (`NaN`/`Infinity`/`-Infinity`) or negative. Never promotes a malformed value to a
 * fabricated distance. Pure — no `Date`, no system clock, no I/O.
 */
export function parseAirKoreaNearbyStationDistanceKm(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
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

/**
 * `response.body.items` — a **direct array** of items (Owner-observed live JSON evidence,
 * 2026-08-13; see the module docblock). Not a `{ item: [...] }` wrapper.
 */
export const airKoreaNearbyStationItemsSchema = z.array(airKoreaNearbyStationItemSchema);

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
    const itemCount = body.items.length;

    if (itemCount > body.numOfRows) {
      ctx.addIssue({
        code: 'custom',
        path: ['items'],
        message: 'item count must not exceed numOfRows',
      });
    }

    if (body.totalCount === 0) {
      if (itemCount > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['items'],
          message: 'items must be empty when totalCount is zero',
        });
      }
    } else if (itemCount > body.totalCount) {
      ctx.addIssue({
        code: 'custom',
        path: ['items'],
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
