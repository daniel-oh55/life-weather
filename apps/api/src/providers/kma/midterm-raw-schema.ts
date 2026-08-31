/**
 * Runtime (Zod) schemas for the **raw** KMA (기상청) 중기예보 조회서비스 (`MidFcstInfoService`) JSON
 * responses — the untrusted boundary between the external service and this backend. Nothing here
 * fetches, reads an environment variable, or knows a service key; these schemas only *validate the
 * shape* of an already-parsed JSON value.
 *
 * Two operations are modelled, and their item shapes are kept **strictly separate** because they
 * genuinely have nothing in common beyond `regId`:
 *
 * - 중기기온조회 (`getMidTa`) → {@link kmaMidtermTemperatureItemSchema} — D+4~D+10 최저/최고기온.
 * - 중기육상예보조회 (`getMidLandFcst`) → {@link kmaMidtermLandItemSchema} — D+4~D+7 오전/오후
 *   날씨예보·강수확률 and D+8~D+10 종일 날씨예보·강수확률.
 *
 * The D+4 floor (rather than the D+3 the service originally published) and the AM/PM-then-all-day
 * split are the current official semantics — 단기예보 now covers through D+3, so the mid-term
 * product begins at D+4. See `docs/kma-midterm-provider.md` for the source record.
 *
 * The response **envelope** — `response.header.resultCode`/`resultMsg` and the
 * `dataType`/`pageNo`/`numOfRows`/`totalCount`/`items.item` body — is identical in shape to the
 * forecast/current-observation/alert boundaries, so this module reuses `kmaResponseHeaderSchema`
 * from `raw-schema.ts` rather than redefining it, and applies the same self-contradiction rules
 * (see {@link kmaMidtermTemperatureBodySchema}).
 *
 * Type discipline (identical policy to the other three KMA boundaries):
 *
 * - No `z.coerce`. A numeric string is never turned into a number and a number is never turned
 *   into a string.
 * - `dataType` is the literal `'JSON'` — this boundary only validates already-parsed JSON, so any
 *   other `dataType` is an invalid response, not a success body.
 * - `z.number()` in Zod 4 already rejects `NaN`/`Infinity`/`-Infinity`, so every numeric schema is
 *   finite by construction.
 * - Unknown *extra* keys are dropped by Zod's default object strip.
 * - A missing required field is a hard failure. **No field here is modeled as nullable** — unlike
 *   forecast's `fcstValue` / current observation's `obsrValue`, neither official item spec
 *   documents a nullable value, so no defensive `.nullable()` allowance is added without evidence.
 * - Provider strings (`wf4Am` and friends, e.g. `맑음`/`구름많음`/`흐리고 비`) are **not**
 *   normalized, enumerated, or mapped to a `WeatherCondition` here. This is a raw boundary; that
 *   mapping is a later normalization PR's responsibility.
 * - **D+4 is the one issuance-dependent exception to "every field is required".** The official
 *   06:00 KST issuance covers D+4~D+10, but the 18:00 KST issuance can begin at D+5, so a valid
 *   18:00 response legitimately omits the whole D+4 group. D+5~D+10 stay required unconditionally.
 *   The D+4 group — `taMin4`+`taMax4` for {@link kmaMidtermTemperatureItemSchema}, and
 *   `rnSt4Am`+`rnSt4Pm`+`wf4Am`+`wf4Pm` for {@link kmaMidtermLandItemSchema} — is therefore
 *   `.optional()` at the field level but enforced as **atomic** by a `superRefine`: every field in
 *   the group must be present together, or every field must be absent together. A partial D+4
 *   group (e.g. `taMin4` present without `taMax4`) is rejected here, at the raw boundary. This
 *   schema cannot see which `tmFc` produced a response, so it cannot enforce the *06:00-must-have-
 *   D+4* half of the rule — that request-aware check lives in `provider.ts` (see its module doc).
 *   Absent D+4 fields are never fabricated as `null`/`0`/empty-string/D+5 values by any layer.
 *
 * ## Open evidence item: `getMidTa`'s low/high range fields
 *
 * The 공공데이터포털 service page for `MidFcstInfoService` renders the full 요청/출력 tables only
 * for 중기전망조회 (`getMidFcst`); the `getMidTa` / `getMidLandFcst` 출력결과 tables live in the
 * downloadable 활용가이드 archive (`기상청28_중기예보 조회서비스_오픈API활용가이드_251212`), which
 * was not consulted in this PR, and **no live call is authorized here**. `getMidTa` is understood
 * to also carry per-day 예보 범위 fields (`taMin{N}Low`/`taMin{N}High`/`taMax{N}Low`/
 * `taMax{N}High`), but their exact names *and their JSON types* could not be confirmed against an
 * official table. They are therefore **deliberately not declared**: Zod's default object strip
 * already accepts and drops them harmlessly, whereas declaring them with a guessed type could
 * *reject a valid upstream response*. Adding them is a separate, evidenced correction once the
 * official 출력결과 table is read — the same discipline `alert-raw-schema.ts` applies to the
 * unobserved single-object `items.item` serialization. Nothing in this PR consumes those fields.
 */

import { z } from 'zod';

import { kmaResponseHeaderSchema } from './raw-schema.js';
import { isKmaMidtermRegId } from './validation.js';

// ---------------------------------------------------------------------------
// Field-level primitives
// ---------------------------------------------------------------------------

/**
 * `regId` — the official 중기예보 구역코드, validated with the exact same structural predicate the
 * request layer uses (`./validation`), so a code this response boundary accepts is validated by the
 * same code that validated the request. Structural only: never an allow-list, so no region is
 * hardcoded and a code KMA adds later still passes.
 */
const kmaMidtermRegId = z
  .string()
  .refine(isKmaMidtermRegId, { message: 'must be a valid KMA mid-term regId' });

/**
 * A 중기기온 temperature value (`taMin{N}` / `taMax{N}`), in °C. Finite (guaranteed by
 * `z.number()`) and otherwise unconstrained: no `.int()` is asserted, because the official field
 * type is documented as 숫자 without stating integrality, and no range bound is imposed, because no
 * official minimum/maximum is documented — an implausible value is left for a later layer rather
 * than guessed here. This matches `raw-schema.ts`'s stance on unbounded `nx`/`ny`.
 */
const kmaMidtermTemperature = z.number();

/**
 * A 중기육상예보 강수확률 (`rnSt{N}Am` / `rnSt{N}Pm` / `rnSt{N}`), documented in percent. Finite and
 * otherwise unconstrained for the same reason as {@link kmaMidtermTemperature}: no `[0, 100]` bound
 * is asserted here, since enforcing a range the raw boundary cannot cite is a policy guess. A
 * contract-level range check belongs to the later normalization layer.
 */
const kmaMidtermPrecipitationProbability = z.number();

/**
 * A 중기육상예보 날씨예보 (`wf{N}Am` / `wf{N}Pm` / `wf{N}`) — a required, non-empty Korean phrase
 * (`맑음`, `구름많음`, `흐리고 비`, …). Validated as a non-empty string only: it is deliberately
 * **not** an enum and **not** normalized, so an unknown/future phrase passes this raw boundary
 * untouched. Mapping these phrases to the shared `WeatherCondition` is a later PR's job.
 */
const kmaMidtermWeatherPhrase = z.string().min(1);

/** A 1-based page index (`pageNo`). */
const kmaMidtermPageNumber = z.number().int().min(1);

/** A page size (`numOfRows`) — at least one row per page. */
const kmaMidtermRowCount = z.number().int().min(1);

/** A total record count (`totalCount`) — non-negative; may be `0`. */
const kmaMidtermTotalCount = z.number().int().min(0);

// ---------------------------------------------------------------------------
// Item schemas — kept strictly separate per operation
// ---------------------------------------------------------------------------

/**
 * One 중기기온조회 (`getMidTa`) item: the region code plus the D+4 through D+10 최저/최고기온 pairs.
 * Every field D+5~D+10 is required and non-null. `taMin4`/`taMax4` are the one issuance-dependent
 * exception (see the module doc): both `.optional()`, and enforced as an **atomic pair** by the
 * trailing `superRefine` — a response supplying only one of the two is rejected here, at the raw
 * boundary, not silently treated as "D+4 absent". Unknown extra keys — including the unconfirmed
 * `taMin{N}Low`/`taMin{N}High`/`taMax{N}Low`/`taMax{N}High` range fields discussed in the module
 * doc — are stripped by Zod's default rather than rejected.
 */
export const kmaMidtermTemperatureItemSchema = z
  .object({
    regId: kmaMidtermRegId,
    taMin4: kmaMidtermTemperature.optional(),
    taMax4: kmaMidtermTemperature.optional(),
    taMin5: kmaMidtermTemperature,
    taMax5: kmaMidtermTemperature,
    taMin6: kmaMidtermTemperature,
    taMax6: kmaMidtermTemperature,
    taMin7: kmaMidtermTemperature,
    taMax7: kmaMidtermTemperature,
    taMin8: kmaMidtermTemperature,
    taMax8: kmaMidtermTemperature,
    taMin9: kmaMidtermTemperature,
    taMax9: kmaMidtermTemperature,
    taMin10: kmaMidtermTemperature,
    taMax10: kmaMidtermTemperature,
  })
  .superRefine((item, ctx) => {
    const hasTaMin4 = item.taMin4 !== undefined;
    const hasTaMax4 = item.taMax4 !== undefined;
    if (hasTaMin4 !== hasTaMax4) {
      ctx.addIssue({
        code: 'custom',
        path: [hasTaMin4 ? 'taMax4' : 'taMin4'],
        message: 'taMin4 and taMax4 must both be present or both be absent',
      });
    }
  });

export type KmaMidtermTemperatureItem = z.infer<typeof kmaMidtermTemperatureItemSchema>;

/**
 * The D+4 오전/오후 land fields, treated as one **atomic** optional group (see the module doc and
 * {@link kmaMidtermLandItemSchema}'s trailing `superRefine`): every field here must be present
 * together, or every field must be absent together.
 */
const KMA_MIDTERM_LAND_D4_FIELDS = ['rnSt4Am', 'rnSt4Pm', 'wf4Am', 'wf4Pm'] as const;

/**
 * One 중기육상예보조회 (`getMidLandFcst`) item: the region code, the D+4~D+7 오전/오후 pairs, and the
 * D+8~D+10 종일 values. The AM/PM-vs-all-day asymmetry is the official product semantics, not a
 * modelling shortcut — KMA publishes 중기육상예보 split by 오전/오후 only through D+7 and as a single
 * daily value from D+8 onward, which is exactly why the public `DailyForecast` contract already
 * carries `morning`/`afternoon` **and** `overall`. Every field D+5~D+10 is required and non-null.
 * `rnSt4Am`/`rnSt4Pm`/`wf4Am`/`wf4Pm` are the one issuance-dependent exception (see the module
 * doc): all four `.optional()`, and enforced as an **atomic group** by the trailing `superRefine`
 * — a response supplying any partial subset of the four is rejected here, at the raw boundary.
 */
export const kmaMidtermLandItemSchema = z
  .object({
    regId: kmaMidtermRegId,
    rnSt4Am: kmaMidtermPrecipitationProbability.optional(),
    rnSt4Pm: kmaMidtermPrecipitationProbability.optional(),
    rnSt5Am: kmaMidtermPrecipitationProbability,
    rnSt5Pm: kmaMidtermPrecipitationProbability,
    rnSt6Am: kmaMidtermPrecipitationProbability,
    rnSt6Pm: kmaMidtermPrecipitationProbability,
    rnSt7Am: kmaMidtermPrecipitationProbability,
    rnSt7Pm: kmaMidtermPrecipitationProbability,
    rnSt8: kmaMidtermPrecipitationProbability,
    rnSt9: kmaMidtermPrecipitationProbability,
    rnSt10: kmaMidtermPrecipitationProbability,
    wf4Am: kmaMidtermWeatherPhrase.optional(),
    wf4Pm: kmaMidtermWeatherPhrase.optional(),
    wf5Am: kmaMidtermWeatherPhrase,
    wf5Pm: kmaMidtermWeatherPhrase,
    wf6Am: kmaMidtermWeatherPhrase,
    wf6Pm: kmaMidtermWeatherPhrase,
    wf7Am: kmaMidtermWeatherPhrase,
    wf7Pm: kmaMidtermWeatherPhrase,
    wf8: kmaMidtermWeatherPhrase,
    wf9: kmaMidtermWeatherPhrase,
    wf10: kmaMidtermWeatherPhrase,
  })
  .superRefine((item, ctx) => {
    const presentCount = KMA_MIDTERM_LAND_D4_FIELDS.filter(
      (field) => item[field] !== undefined,
    ).length;
    if (presentCount === 0 || presentCount === KMA_MIDTERM_LAND_D4_FIELDS.length) {
      return;
    }
    for (const field of KMA_MIDTERM_LAND_D4_FIELDS) {
      if (item[field] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: 'rnSt4Am, rnSt4Pm, wf4Am, and wf4Pm must be present together or all absent',
        });
      }
    }
  });

export type KmaMidtermLandItem = z.infer<typeof kmaMidtermLandItemSchema>;

// ---------------------------------------------------------------------------
// Body / envelope schemas
// ---------------------------------------------------------------------------

/**
 * `response.body.items` for each operation. The official success payload nests the list under
 * `items.item`, and `item` must be an **array**; a single bare object is *not* accepted, matching
 * the evidence discipline `alert-raw-schema.ts` documents — that serialization was never observed
 * or documented for this service, and this PR performs no live call to discover it. An empty array
 * is allowed and yields an empty page.
 */
export const kmaMidtermTemperatureItemsSchema = z.object({
  item: z.array(kmaMidtermTemperatureItemSchema),
});

export const kmaMidtermLandItemsSchema = z.object({
  item: z.array(kmaMidtermLandItemSchema),
});

/**
 * The `superRefine` shared by both mid-term body schemas: the three *self-contradictions within one
 * page* the other KMA boundaries already reject (see `raw-schema.ts` for the full rationale).
 *
 * - `items.item.length > numOfRows` — a page cannot hold more rows than its own page size.
 * - `items.item.length > totalCount` — a page cannot hold more items than the grand total.
 * - `totalCount === 0` with a non-empty `items.item` — zero total records but items present.
 *
 * Left permissive, identically to the other boundaries: `totalCount > 0` with an empty
 * `items.item`, and any `item.length < totalCount` (which the provider then rejects as an
 * `INCOMPLETE_PAGE` rather than silently accepting a partial page).
 */
function refineMidtermPageConsistency(
  body: { readonly numOfRows: number; readonly totalCount: number; readonly items: { readonly item: readonly unknown[] } },
  ctx: z.RefinementCtx,
): void {
  const itemCount = body.items.item.length;

  if (itemCount > body.numOfRows) {
    ctx.addIssue({
      code: 'custom',
      path: ['items', 'item'],
      message: 'item count must not exceed numOfRows',
    });
  }

  // `> totalCount` already implies the `totalCount === 0 && itemCount > 0` contradiction, so the
  // two checks are mutually exclusive and never both fire for the same body.
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
}

/** `response.body` for a successful 중기기온조회 (`resultCode === '00'`). */
export const kmaMidtermTemperatureBodySchema = z
  .object({
    dataType: z.literal('JSON'),
    pageNo: kmaMidtermPageNumber,
    numOfRows: kmaMidtermRowCount,
    totalCount: kmaMidtermTotalCount,
    items: kmaMidtermTemperatureItemsSchema,
  })
  .superRefine(refineMidtermPageConsistency);

export type KmaMidtermTemperatureBody = z.infer<typeof kmaMidtermTemperatureBodySchema>;

/** `response.body` for a successful 중기육상예보조회 (`resultCode === '00'`). */
export const kmaMidtermLandBodySchema = z
  .object({
    dataType: z.literal('JSON'),
    pageNo: kmaMidtermPageNumber,
    numOfRows: kmaMidtermRowCount,
    totalCount: kmaMidtermTotalCount,
    items: kmaMidtermLandItemsSchema,
  })
  .superRefine(refineMidtermPageConsistency);

export type KmaMidtermLandBody = z.infer<typeof kmaMidtermLandBodySchema>;

/**
 * The full success envelopes: the shared `kmaResponseHeaderSchema` (imported from `raw-schema.ts`)
 * **and** a well-formed operation-specific body. Applied only after the header has been confirmed
 * valid and `resultCode` equals `KMA_SUCCESS_RESULT_CODE` (see `parse-midterm-response.ts`).
 */
export const kmaMidtermTemperatureSuccessResponseSchema = z.object({
  response: z.object({
    header: kmaResponseHeaderSchema,
    body: kmaMidtermTemperatureBodySchema,
  }),
});

export const kmaMidtermLandSuccessResponseSchema = z.object({
  response: z.object({
    header: kmaResponseHeaderSchema,
    body: kmaMidtermLandBodySchema,
  }),
});
