/**
 * KMA (기상청) 중기예보 조회서비스 (`MidFcstInfoService`) request input for the two D+4~D+10
 * operations — 중기기온조회 (`getMidTa`) and 중기육상예보조회 (`getMidLandFcst`) — covering the
 * public request type, runtime validation, the fixed operation→path mapping, and deterministic URL
 * construction.
 *
 * `MidFcstInfoService` is a **third service family** alongside `VilageFcstInfoService_2.0`
 * (forecast / current observation) and `WthrWrnInfoService` (alert events), so it gets its own base
 * URL rather than reusing either of theirs. It follows the 공공데이터포털 request convention
 * documented for the forecast boundary — the `ServiceKey` (capitalised) query parameter — because
 * the 공공데이터포털 상세기능 표 for this service documents its request exactly that way. The
 * alert boundary's lower-case `serviceKey` is **not** copied here: that casing was established by
 * an Owner-authorized live diagnostic against a different service family, and no live call is
 * authorized for this PR (see `docs/kma-midterm-provider.md`).
 *
 * The caller supplies only the *varying* request fields (operation, region code, issuance stamp).
 * The fixed query parameters this module always sends — `pageNo=1`, `numOfRows=10`,
 * `dataType=JSON` — are internal constants a caller cannot override, so every fetch retrieves the
 * complete single mid-term item for one `regId`/`tmFc` as JSON.
 *
 * Scope boundary: this module does **not** resolve a location, administrative area, or coordinate
 * pair to a `regId`, and it does **not** select the latest scheduled 06/18 KST issuance. Both
 * remain future work; here `regId` and `tmFc` are structurally validated caller input only.
 *
 * Security: the service key is placed into the query with `URLSearchParams`, which percent-encodes
 * it exactly once. Neither the key, the built `URL`, nor the query string is ever logged or copied
 * into an error — a request error carries only value-free field issues.
 */

import { isKmaMidtermIssuanceStamp, isKmaMidtermRegId } from './validation.js';

/**
 * The two in-scope mid-term operations, named by *what they return* rather than by their upstream
 * path, so the operation is explicit in the request and the path stays an internal detail:
 *
 * - `TEMPERATURE` — 중기기온조회, the D+4~D+10 최저/최고기온 item.
 * - `LAND` — 중기육상예보조회, the D+4~D+7 오전/오후 and D+8~D+10 종일 육상 item.
 *
 * 중기전망조회 (`getMidFcst`) and 중기해상예보조회 (`getMidSeaFcst`) are the service's other two
 * operations and are deliberately **not** modelled — this boundary exists to feed the public
 * `DailyForecast` D+4~D+10 shape, which neither of those serves.
 */
export const KMA_MIDTERM_OPERATIONS = ['TEMPERATURE', 'LAND'] as const;

export type KmaMidtermOperation = (typeof KMA_MIDTERM_OPERATIONS)[number];

/**
 * A mid-term forecast request. Only these three vary per call; pagination and format are fixed
 * internally (see {@link KMA_MIDTERM_FIXED_PAGE_NO} / {@link KMA_MIDTERM_FIXED_NUM_OF_ROWS} /
 * {@link KMA_MIDTERM_FIXED_DATA_TYPE}).
 */
export interface KmaMidtermForecastRequest {
  readonly operation: KmaMidtermOperation;
  /**
   * Official 중기예보 구역코드. The 육상예보구역 code set (`getMidLandFcst`) and the 중기기온 도시
   * code set (`getMidTa`) are different code sets that share one structural form; picking the
   * right code for a location is out of scope here (see the module doc).
   */
  readonly regId: string;
  /** Issuance stamp, official `YYYYMMDDHHmm` (`tmFc`). */
  readonly tmFc: string;
}

/**
 * A single, value-free request-validation problem. Names the offending field only; the raw value
 * is deliberately never included so nothing (including a mistakenly-secret-shaped value) leaks.
 */
export interface KmaMidtermRequestIssue {
  readonly field: 'operation' | 'regId' | 'tmFc';
  readonly reason: 'INVALID';
}

/**
 * The dedicated `MidFcstInfoService` base URL — never shared with `VilageFcstInfoService_2.0`
 * (forecast / current observation) or `WthrWrnInfoService` (alert events). HTTPS in production.
 */
export const KMA_MIDTERM_BASE_URL = 'https://apis.data.go.kr/1360000/MidFcstInfoService';

/** Fixed pagination/format this request always sends (a caller cannot change these). */
export const KMA_MIDTERM_FIXED_PAGE_NO = 1;
/**
 * One `regId`/`tmFc` pair yields exactly one mid-term item, so a small fixed page is sufficient to
 * retrieve the complete response; `10` is the 공공데이터포털 상세기능 표's own documented sample
 * value for this service. It is still a *fixed internal* value — the provider never auto-paginates,
 * and a `totalCount` larger than the received item count is reported as an incomplete page rather
 * than silently truncated (see `provider.ts`).
 */
export const KMA_MIDTERM_FIXED_NUM_OF_ROWS = 10;
export const KMA_MIDTERM_FIXED_DATA_TYPE = 'JSON';

/**
 * The only operation→path mapping. Operation paths are selected *exclusively* from this table,
 * never built from caller input, so a malicious `operation` can never reach the URL path.
 *
 * - `TEMPERATURE` → `getMidTa` (중기기온조회)
 * - `LAND` → `getMidLandFcst` (중기육상예보조회)
 */
const KMA_MIDTERM_PATH_BY_OPERATION = {
  TEMPERATURE: 'getMidTa',
  LAND: 'getMidLandFcst',
} as const satisfies Record<KmaMidtermOperation, string>;

export type KmaMidtermOperationPath =
  (typeof KMA_MIDTERM_PATH_BY_OPERATION)[KmaMidtermOperation];

export type ValidateKmaMidtermForecastRequestResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly KmaMidtermRequestIssue[] };

export type BuildKmaMidtermForecastRequestUrlResult =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly issues: readonly KmaMidtermRequestIssue[] };

/** Whether `operation` is one of the two supported mid-term operations. */
function isSupportedOperation(operation: unknown): operation is KmaMidtermOperation {
  return (
    typeof operation === 'string' &&
    (KMA_MIDTERM_OPERATIONS as readonly string[]).includes(operation)
  );
}

/**
 * Whether `value` is a record-like object we can read fields off — a non-null, non-array object.
 * Deliberately not a strict plain-object check, matching the same allowance documented in
 * `request.ts` / `current-request.ts` / `alert-request.ts` / `config.ts`.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build the value-free issue list for a non-object request: every field flagged `INVALID`, in the
 * same fixed order as an object request, so the validator is *total* rather than throwing on a
 * property read. A **fresh** array of **fresh** issue objects is returned on every call (see
 * `request.ts` for why: the public type is `readonly`, but that is not runtime immutability).
 */
function createNonObjectMidtermRequestIssues(): KmaMidtermRequestIssue[] {
  return [
    { field: 'operation', reason: 'INVALID' },
    { field: 'regId', reason: 'INVALID' },
    { field: 'tmFc', reason: 'INVALID' },
  ];
}

/**
 * Validate a mid-term forecast request at runtime. The input is treated as `unknown` because a
 * request crosses a trust boundary even though its TypeScript type says
 * {@link KmaMidtermForecastRequest}: a non-object (`null`, `undefined`, a string/number/boolean, an
 * array, a function) does not throw — it fails with every field flagged `INVALID` in the fixed
 * order below.
 *
 * For an object input, collects every problem in a fixed field order (`operation`, `regId`,
 * `tmFc`) so the issue list is deterministic regardless of how many fields are wrong. Every field
 * is required — unlike `alert-request.ts`, this operation has no optional filters, and an
 * `undefined` field is simply invalid. No coercion: a numeric `tmFc` is rejected, not stringified.
 *
 * `regId` is validated *structurally* only (`isKmaMidtermRegId`) — no region allow-list, so no
 * single region is hardcoded. `tmFc` is validated *structurally* only
 * (`isKmaMidtermIssuanceStamp`) — the official 06/18 KST 발표시각 schedule is **not** enforced, and
 * selecting the latest issuance is a later layer's job (see the module doc and the predicate's own
 * docblock). This validator never reads the system clock. The request object is only read, never
 * mutated. Every call returns freshly-allocated issues, so mutating one result never leaks into a
 * later call.
 */
export function validateKmaMidtermForecastRequest(
  input: unknown,
): ValidateKmaMidtermForecastRequestResult {
  if (!isRecord(input)) {
    return { ok: false, issues: createNonObjectMidtermRequestIssues() };
  }

  const issues: KmaMidtermRequestIssue[] = [];

  if (!isSupportedOperation(input.operation)) {
    issues.push({ field: 'operation', reason: 'INVALID' });
  }
  if (!isKmaMidtermRegId(input.regId)) {
    issues.push({ field: 'regId', reason: 'INVALID' });
  }
  if (!isKmaMidtermIssuanceStamp(input.tmFc)) {
    issues.push({ field: 'tmFc', reason: 'INVALID' });
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/**
 * Build the mid-term request URL for a *validated* request. Re-validates defensively (so it is safe
 * to call in isolation) and returns the same value-free issues on failure.
 *
 * Construction rules:
 * - The operation path comes only from {@link KMA_MIDTERM_PATH_BY_OPERATION} — never from caller
 *   input, so `regId`/`tmFc` can never influence the path even under a runtime type bypass.
 * - `URL` + `URLSearchParams` build the query — never string concatenation.
 * - Parameters are appended in a fixed, deterministic order: `ServiceKey`, `pageNo`, `numOfRows`,
 *   `dataType`, `regId`, `tmFc`. Names and casing match the 공공데이터포털 상세기능 표 exactly
 *   (`ServiceKey`, not `authKey`; see the module doc for why the alert boundary's lower-case
 *   `serviceKey` is not copied here).
 * - `URLSearchParams` percent-encodes the decoded service key exactly once, so
 *   `url.searchParams.get('ServiceKey')` round-trips back to the original key while the serialized
 *   query shows `+`, `/`, `=` as `%2B`, `%2F`, `%3D` (and never double-encodes a `%`).
 */
export function buildKmaMidtermForecastRequestUrl(
  serviceKey: string,
  request: KmaMidtermForecastRequest,
): BuildKmaMidtermForecastRequestUrlResult {
  const validation = validateKmaMidtermForecastRequest(request);
  if (!validation.ok) {
    return { ok: false, issues: validation.issues };
  }

  const operationPath = KMA_MIDTERM_PATH_BY_OPERATION[request.operation];
  const url = new URL(`${KMA_MIDTERM_BASE_URL}/${operationPath}`);
  url.searchParams.set('ServiceKey', serviceKey);
  url.searchParams.set('pageNo', String(KMA_MIDTERM_FIXED_PAGE_NO));
  url.searchParams.set('numOfRows', String(KMA_MIDTERM_FIXED_NUM_OF_ROWS));
  url.searchParams.set('dataType', KMA_MIDTERM_FIXED_DATA_TYPE);
  url.searchParams.set('regId', request.regId);
  url.searchParams.set('tmFc', request.tmFc);

  return { ok: true, url };
}
