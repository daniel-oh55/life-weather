/**
 * AirKorea (에어코리아) current station air-quality request input: its public type, runtime
 * validation, and deterministic URL construction for the 공공데이터포털 `getMsrstnAcctoRltmMesureDnsty`
 * (측정소별 실시간 측정정보 조회) operation.
 *
 * Official-source evidence (see `docs/airkorea-current-air-quality-provider.md` for the full
 * record): 한국환경공단_에어코리아_대기오염정보 (Public Data Portal dataset `15073861`, portal metadata
 * modified 2026-06-30), reference document
 * `한국환경공단 에어코리아 OpenAPI 기술문서_20260630.zip` →
 * `한국환경공단_에어코리아_대기오염정보_기술문서_v1.4.docx`, operation 1 (측정소별 실시간 측정정보 조회,
 * `getMsrstnAcctoRltmMesureDnsty`).
 *
 * The caller supplies only the *varying* request field — the measurement station name
 * (`stationName`). The fixed query parameters this provider always sends — `returnType=json`,
 * `pageNo=1`, `numOfRows=100`, `dataTerm=DAILY`, `ver=1.5` — are internal constants a caller cannot
 * override (see the module-private rationale on each constant below).
 *
 * Security: the service key is placed into the query with `URLSearchParams`, which percent-encodes
 * it exactly once. Neither the key, the built `URL`, nor the query string is ever logged or copied
 * into an error — a request error carries only value-free field issues.
 */

/** A current station air-quality request. Only `stationName` varies per call. */
export interface AirKoreaCurrentAirQualityRequest {
  /** The official AirKorea measurement station name (e.g. `종로구`). */
  readonly stationName: string;
}

/**
 * A single, value-free request-validation problem. Names the offending field only; the raw value
 * is deliberately never included so nothing (including a mistakenly-secret-shaped value) leaks.
 */
export interface AirKoreaCurrentRequestIssue {
  readonly field: 'stationName';
  readonly reason: 'INVALID';
}

/**
 * The 공공데이터포털 HTTPS host for `ArpltnInforInqireSvc` (대기오염정보 조회 서비스). The technical
 * document's request/response examples show `http://apis.data.go.kr/...`, but this project always
 * calls the public data portal over HTTPS (matching the existing KMA provider's documented
 * deviation) — a service key must never be sent over a plaintext connection.
 */
export const AIRKOREA_BASE_URL = 'https://apis.data.go.kr/B552584/ArpltnInforInqireSvc';

/** The fixed 측정소별 실시간 측정정보 조회 operation. Never built from caller input. */
export const AIRKOREA_CURRENT_AIR_QUALITY_OPERATION = 'getMsrstnAcctoRltmMesureDnsty';

/** `returnType=json` — documented JSON-response opt-in (「JSON 방식 호출 방법」). */
const AIRKOREA_FIXED_RETURN_TYPE = 'json';

/** `pageNo=1` — this provider never auto-paginates; see `provider.ts` for the completeness check. */
const AIRKOREA_FIXED_PAGE_NO = 1;

/**
 * `numOfRows=100` — a fixed page size comfortably larger than the ~24 hourly rows one station
 * produces for `dataTerm=DAILY`, matching the technical document's own request/response sample
 * value. Project-owned fixed request policy, not a caller-controlled value.
 */
const AIRKOREA_FIXED_NUM_OF_ROWS = 100;

/**
 * `dataTerm=DAILY` — the smallest official request period (문서: "요청 데이터기간(1일: DAILY, 1개월:
 * MONTH, 3개월: 3MONTH)"), chosen to minimize the row set the "latest measurement" selection
 * (`provider.ts`) has to consider. Project-owned fixed request policy.
 */
const AIRKOREA_FIXED_DATA_TERM = 'DAILY';

/**
 * `ver=1.5` — the highest version documented for this operation. The technical document's 버전(ver)
 * notes describe each version as strictly additive over the previous one, and **PM2.5 data is not
 * included at all without a `ver` parameter** ("버전을 포함하지 않고 호출할 경우 : PM2.5 데이터가
 * 포함되지 않은 원래 오퍼레이션 결과 표출"). Fast-track 1.0 requires both PM10 and PM2.5
 * (`docs/product-scope.md`), so a version must be sent. `1.5` is used — not an earlier version —
 * because it is the only documented value guaranteed (per the same notes) to include every field
 * this provider normalizes: PM2.5 (`ver 1.0`), the 1-hour PM grades this provider does *not* use,
 * 측정망 정보 (`ver 1.2`, unused here), and expanded decimal precision for CO/O3/SO2/NO2 (`ver 1.5`,
 * relevant to `ozonePartsPerMillion`). Module-private and non-configurable per the project's
 * evidence-gate policy — see `docs/airkorea-current-air-quality-provider.md` for the full version
 * table transcribed from the technical document.
 */
const AIRKOREA_FIXED_VERSION = '1.5';

/** The official field-size bound for `stationName` (문서 항목크기: 30). */
const AIRKOREA_STATION_NAME_MAX_LENGTH = 30;

/** Matches a C0 control character or DEL — rejected in `stationName`. */
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export type ValidateAirKoreaCurrentAirQualityRequestResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly AirKoreaCurrentRequestIssue[] };

export type BuildAirKoreaCurrentAirQualityRequestUrlResult =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly issues: readonly AirKoreaCurrentRequestIssue[] };

/**
 * Whether `value` is a well-formed AirKorea `stationName`: a non-empty string, no leading/trailing
 * whitespace, at most {@link AIRKOREA_STATION_NAME_MAX_LENGTH} UTF-16 code units, and free of
 * control characters. Exported so `current-raw-schema.ts` can apply the identical predicate to the
 * *response* `stationName` (this operation always requests `ver=1.5`, which the technical document
 * documents as including `stationName` in the response body), keeping the two layers from silently
 * drifting apart.
 */
export function isAirKoreaStationName(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  if (value.length === 0 || value.length > AIRKOREA_STATION_NAME_MAX_LENGTH) {
    return false;
  }
  if (value !== value.trim()) {
    return false;
  }
  return !CONTROL_CHARACTER_PATTERN.test(value);
}

/**
 * Whether `value` is a record-like object we can read fields off — a non-null, non-array object.
 * Not a strict plain-object check (a `Date`/class instance/custom-prototype object also passes);
 * sufficient here because this provider is called from internal server code with a JSON-shaped
 * request.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate a current-air-quality request at runtime. The input is treated as `unknown`: a
 * non-object (`null`, `undefined`, a string/number/boolean, an array, a function) does not throw —
 * it fails with `stationName` flagged `INVALID`, the same as an object with a malformed
 * `stationName`, so the validator is *total*. The request object is only read, never mutated.
 */
export function validateAirKoreaCurrentAirQualityRequest(
  input: unknown,
): ValidateAirKoreaCurrentAirQualityRequestResult {
  if (!isRecord(input)) {
    return { ok: false, issues: [{ field: 'stationName', reason: 'INVALID' }] };
  }

  if (!isAirKoreaStationName(input.stationName)) {
    return { ok: false, issues: [{ field: 'stationName', reason: 'INVALID' }] };
  }

  return { ok: true };
}

/**
 * Build the 공공데이터포털 current-air-quality request URL for a *validated* request. Re-validates
 * defensively (so it is safe to call in isolation) and returns the same value-free issues on
 * failure.
 *
 * Construction rules:
 * - The operation path is always {@link AIRKOREA_CURRENT_AIR_QUALITY_OPERATION} — never built from
 *   caller input.
 * - `URL` + `URLSearchParams` build the query — never string concatenation.
 * - Parameters are appended in a fixed, deterministic order: `serviceKey`, `returnType`, `pageNo`,
 *   `numOfRows`, `stationName`, `dataTerm`, `ver`.
 * - `URLSearchParams` percent-encodes the decoded service key (and the Korean `stationName`)
 *   exactly once.
 */
export function buildAirKoreaCurrentAirQualityRequestUrl(
  serviceKey: string,
  request: AirKoreaCurrentAirQualityRequest,
): BuildAirKoreaCurrentAirQualityRequestUrlResult {
  const validation = validateAirKoreaCurrentAirQualityRequest(request);
  if (!validation.ok) {
    return { ok: false, issues: validation.issues };
  }

  const url = new URL(`${AIRKOREA_BASE_URL}/${AIRKOREA_CURRENT_AIR_QUALITY_OPERATION}`);
  url.searchParams.set('serviceKey', serviceKey);
  url.searchParams.set('returnType', AIRKOREA_FIXED_RETURN_TYPE);
  url.searchParams.set('pageNo', String(AIRKOREA_FIXED_PAGE_NO));
  url.searchParams.set('numOfRows', String(AIRKOREA_FIXED_NUM_OF_ROWS));
  url.searchParams.set('stationName', request.stationName);
  url.searchParams.set('dataTerm', AIRKOREA_FIXED_DATA_TERM);
  url.searchParams.set('ver', AIRKOREA_FIXED_VERSION);

  return { ok: true, url };
}

/** Exported for `provider.ts`'s request/response correlation check. */
export { AIRKOREA_FIXED_NUM_OF_ROWS, AIRKOREA_FIXED_PAGE_NO };
