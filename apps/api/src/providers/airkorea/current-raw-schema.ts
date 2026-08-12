/**
 * Runtime (Zod) schemas for the **raw** AirKorea (에어코리아) 측정소별 실시간 측정정보 조회
 * (`getMsrstnAcctoRltmMesureDnsty`) JSON response — the untrusted boundary between the external
 * 대기오염정보 조회 서비스 (`ArpltnInforInqireSvc`) and this backend. Nothing here fetches, reads an
 * environment variable, or knows a service key; these schemas only *validate the shape* of an
 * already-parsed JSON value.
 *
 * Official-source evidence (see `docs/airkorea-current-air-quality-provider.md` for the full
 * record, including the transcribed request/response field tables): 한국환경공단_에어코리아_대기오염정보
 * (Public Data Portal dataset `15073861`, portal metadata modified 2026-06-30), reference document
 * `한국환경공단_에어코리아_대기오염정보_기술문서_v1.4.docx`.
 *
 * This is an **independent** schema module from `../kma/*-raw-schema.ts` — it defines its own
 * envelope shape (`resultCode`/`resultMsg` header, `body.items.item[]`) rather than importing the
 * KMA provider's types, per the project's provider-namespace isolation policy. The envelope shape
 * happens to resemble KMA's (both are 공공데이터포털 services), but AirKorea's body has **no**
 * `dataType` field — unlike KMA, this operation's technical document response table does not list
 * one.
 *
 * Type discipline: no `z.coerce`; unknown extra keys are dropped by Zod's default object strip. The
 * technical document's own field table marks `pm10Value`, `o3Value`, `khaiValue`, `khaiGrade`,
 * `pm10Grade`, and `o3Grade` as *required* response fields (항목구분: 1) — a response missing any of
 * these keys is malformed and rejected here, at the raw boundary, rather than being silently
 * normalized to `null` downstream. Only `pm25Value`/`pm25Grade` are documented *optional* (항목구분:
 * 0) and modeled as optional keys. Presence and value are distinct concepts: a documented sentinel
 * ("-" for a measurement, "" for a grade — see the technical document's XML sample, which shows a
 * missing grade as a self-closing element) is a valid *string* for a **present** required key: the
 * key is not absent, its value merely encodes "no data". Interpreting a sentinel (or an absent
 * optional key) as "no data" is `normalize-current.ts`'s job, not this raw boundary's — this
 * boundary's job is only to reject an **absent required key** as malformed.
 */

import { z } from 'zod';

import { isAirKoreaStationName } from './current-request.js';

/** `resultCode` — the official 2-digit result code (오류 코드 정리: `01`..`34`; success is `00`). */
const airKoreaResultCode = z.string().regex(/^\d{2}$/, {
  message: 'must be a 2-digit result code',
});

/** The official AirKorea success result code (모든 오류 코드는 `00`이 아니므로, `00`은 성공을 의미). */
export const AIRKOREA_SUCCESS_RESULT_CODE = '00';

/** `response.header` — identical shape/policy to the forecast envelope's header field discipline. */
export const airKoreaResponseHeaderSchema = z.object({
  resultCode: airKoreaResultCode,
  resultMsg: z.string(),
});

/** The envelope shape needed only to classify success vs. upstream error (no body validated yet). */
export const airKoreaResponseEnvelopeSchema = z.object({
  response: z.object({
    header: airKoreaResponseHeaderSchema,
  }),
});

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** `dataTime` structural pattern: `YYYY-MM-DD HH:mm` (official sample: `2020-11-25 13:00`). */
const AIRKOREA_DATA_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;

/** The parsed numeric components of a validated `dataTime` string. */
export interface AirKoreaDataTimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

/**
 * Parse and validate an AirKorea `dataTime` string (`YYYY-MM-DD HH:mm`), or return `null` if it is
 * not a real calendar date/clock time. Hour is `00`-`23` and minute is `00`-`59` — the technical
 * document's own sample (`2020-11-25 13:00`) uses this range; no official confirmation of a
 * `24:00`-style end-of-day convention exists for *this* operation's `dataTime`, so such a value is
 * rejected rather than silently reinterpreted (documented as a known gap in
 * `docs/airkorea-current-air-quality-provider.md`). Pure arithmetic — no `Date`, no system clock.
 * Exported so `normalize-current.ts` (building `measuredAt`) and `provider.ts` (comparing
 * candidate rows by recency — the fixed-width zero-padded format sorts lexicographically in
 * chronological order once every candidate is confirmed well-formed) share one source of truth.
 */
export function parseAirKoreaDataTime(value: string): AirKoreaDataTimeParts | null {
  const match = AIRKOREA_DATA_TIME_PATTERN.exec(value);
  if (match === null) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);

  if (month < 1 || month > 12 || day < 1) {
    return null;
  }
  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  if (day > maxDay) {
    return null;
  }
  if (hour > 23 || minute > 59) {
    return null;
  }

  return { year, month, day, hour, minute };
}

/** Whether `value` is a well-formed `dataTime` string — see {@link parseAirKoreaDataTime}. */
function isAirKoreaDataTime(value: string): boolean {
  return parseAirKoreaDataTime(value) !== null;
}

const airKoreaDataTime = z.string().refine(isAirKoreaDataTime, {
  message: 'must be a valid YYYY-MM-DD HH:mm measurement time',
});

const airKoreaStationName = z.string().refine(isAirKoreaStationName, {
  message: 'must be a well-formed AirKorea station name',
});

/**
 * A measurement/index field (`pm10Value`, `pm25Value`, `o3Value`, `khaiValue`). Official field spec
 * types these as strings — the documented missing sentinel is the literal `"-"` (confirmed by the
 * technical document's `<khaiValue>-</khaiValue>` sample); a valid measurement is a bare
 * non-negative decimal string (e.g. `"73"`, `"0.043"`). No numeric coercion here — semantic
 * interpretation (sentinel vs. malformed vs. valid) is `normalize-current.ts`'s job. Per-field
 * required-vs-optional key presence is enforced where this schema is used, not here (the sentinel
 * value itself is the same shape either way).
 */
const airKoreaMeasurementValue = z.string();

/**
 * A grade field (`khaiGrade`, `pm10Grade`, `pm25Grade`, `o3Grade`). Official documented values are
 * the literal digit strings `"1"`-`"4"` (좋음/보통/나쁨/매우나쁨); the technical document's XML
 * sample shows a missing grade as a self-closing element (`<so2Grade/>`), i.e. an empty string.
 * Semantic mapping happens in `normalize-current.ts`. Per-field required-vs-optional key presence is
 * enforced where this schema is used, not here.
 */
const airKoreaGradeValue = z.string();

/**
 * One 측정소별 실시간 측정정보 조회 `item`. `dataTime` and `stationName` are always present once
 * `ver=1.5` is requested. Of the eight consumed value/grade fields, the technical document's field
 * table marks six as *required* (항목구분: 1) — `pm10Value`, `o3Value`, `khaiValue`, `khaiGrade`,
 * `pm10Grade`, `o3Grade` — so an absent key for any of these is rejected here as a malformed
 * response, not silently accepted and normalized to `null` downstream. Only `pm25Value` and
 * `pm25Grade` are documented *optional* (항목구분: 0) and remain `.optional()` keys (see the module
 * docblock and `docs/airkorea-current-air-quality-provider.md` for the full field table). A
 * required key that is *present* but holds its documented sentinel string (`"-"` / `""`) still
 * parses here — presence and value are different concepts; sentinel-vs-malformed-vs-valid
 * interpretation is `normalize-current.ts`'s job. Unknown extra keys (e.g. `mangName`,
 * `stationCode`, `pm10Value24`, the `*Flag` fields, the 1-hour PM grades) are stripped by Zod's
 * default — this provider does not consume them.
 */
export const airKoreaCurrentAirQualityItemSchema = z.object({
  dataTime: airKoreaDataTime,
  stationName: airKoreaStationName,
  pm10Value: airKoreaMeasurementValue,
  pm25Value: airKoreaMeasurementValue.optional(),
  o3Value: airKoreaMeasurementValue,
  khaiValue: airKoreaMeasurementValue,
  khaiGrade: airKoreaGradeValue,
  pm10Grade: airKoreaGradeValue,
  pm25Grade: airKoreaGradeValue.optional(),
  o3Grade: airKoreaGradeValue,
});

export type AirKoreaCurrentAirQualityItem = z.infer<typeof airKoreaCurrentAirQualityItemSchema>;

/** `response.body.items`. The list is nested under `items.item`, which must be an **array**. */
export const airKoreaCurrentAirQualityItemsSchema = z.object({
  item: z.array(airKoreaCurrentAirQualityItemSchema),
});

/** A 1-based page index (`pageNo`). */
const airKoreaPageNumber = z.number().int().min(1);

/** A page size (`numOfRows`) — at least one row per page. */
const airKoreaRowCount = z.number().int().min(1);

/** A total record count (`totalCount`) — non-negative; may be `0`. */
const airKoreaTotalCount = z.number().int().min(0);

/**
 * `response.body` for a success (`resultCode === '00'`). Same pagination self-contradiction policy
 * as the KMA response boundary (defensive, since the official examples do not explicitly document
 * these invariants for this operation): item count must not exceed `numOfRows`; `totalCount === 0`
 * requires an empty item list; a non-zero `totalCount` bounds the item count from above.
 */
export const airKoreaCurrentAirQualityBodySchema = z
  .object({
    numOfRows: airKoreaRowCount,
    pageNo: airKoreaPageNumber,
    totalCount: airKoreaTotalCount,
    items: airKoreaCurrentAirQualityItemsSchema,
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

export type AirKoreaCurrentAirQualityBody = z.infer<typeof airKoreaCurrentAirQualityBodySchema>;

/**
 * The full success envelope: the shared header schema **and** a well-formed
 * 측정소별 실시간 측정정보 조회 body. Applied only after the header has been confirmed valid and
 * `resultCode` equals `AIRKOREA_SUCCESS_RESULT_CODE` (see `parse-current-response.ts`).
 */
export const airKoreaCurrentAirQualitySuccessResponseSchema = z.object({
  response: z.object({
    header: airKoreaResponseHeaderSchema,
    body: airKoreaCurrentAirQualityBodySchema,
  }),
});
