/**
 * AirKorea (에어코리아) TM-coordinate lookup request input: its public type, runtime validation,
 * and deterministic URL construction for the 공공데이터포털 `getTMStdrCrdnt` (TM 기준좌표 조회)
 * operation.
 *
 * Official-source evidence (see `docs/airkorea-tm-coordinate-provider.md` for the full record):
 * 한국환경공단_에어코리아_측정소정보 (Public Data Portal dataset `15073877`, portal metadata modified
 * 2026-06-30), reference document `한국환경공단 에어코리아 OpenAPI 기술문서_20260630.zip` →
 * `한국환경공단_에어코리아_측정소정보_기술문서_v1.2.docx`, operation 3 (TM 기준좌표 조회,
 * `getTMStdrCrdnt`), API명(영문) `MsrstnInfoInqireSvc`.
 *
 * The caller supplies only the single varying request field — an administrative 읍면동(umd) name
 * (`umdName`). Unlike `getNearbyMsrstnList` (PR #83), this operation's request table has **no**
 * `ver` parameter at all (not "documented but unused" — it is simply absent from the table), so this
 * provider never sends one. `pageNo`/`numOfRows` **are** documented optional (항목구분: 0) request
 * parameters for this operation (unlike `getNearbyMsrstnList`) — this provider fixes both to a
 * project-owned deterministic value (`pageNo=1`, `numOfRows=100`, matching the technical document's
 * own request-table sample value) rather than exposing them to the caller, so a single call is
 * reproducible and the completeness guard (`provider.ts`'s `INCOMPLETE_RESULT`) has a fixed page
 * size to reason about. This is *not* a pagination loop — see `docs/airkorea-tm-coordinate-provider.md`
 * §"Pagination / completeness" for the full reasoning.
 *
 * Security: the service key is placed into the query with `URLSearchParams`, which percent-encodes
 * it exactly once. Neither the key, the built `URL`, nor the query string is ever logged or copied
 * into an error — a request error carries only value-free field issues.
 */

/** A TM-coordinate lookup request. Only `umdName` varies per call. */
export interface AirKoreaTmCoordinateRequest {
  /** The official AirKorea 읍면동(umd) administrative name (e.g. `혜화동`). */
  readonly umdName: string;
}

/**
 * A single, value-free request-validation problem. Names the offending field only; the raw value
 * is deliberately never included so nothing (including a mistakenly-secret-shaped value) leaks.
 */
export interface AirKoreaTmCoordinateRequestIssue {
  readonly field: 'umdName';
  readonly reason: 'INVALID';
}

/**
 * The 공공데이터포털 HTTPS host for `MsrstnInfoInqireSvc` (측정소정보 조회 서비스) — the same service
 * family as `getNearbyMsrstnList` (PR #83). The technical document's Call Back URL is
 * `http://apis.data.go.kr/...`, but this project always calls the public data portal over HTTPS
 * (matching the existing KMA and AirKorea providers' documented deviation) — a service key must
 * never be sent over a plaintext connection.
 */
export const AIRKOREA_TM_COORDINATE_BASE_URL = 'https://apis.data.go.kr/B552584/MsrstnInfoInqireSvc';

/** The fixed TM 기준좌표 조회 operation. Never built from caller input. */
export const AIRKOREA_TM_COORDINATE_OPERATION = 'getTMStdrCrdnt';

/** `returnType=json` — documented JSON-response opt-in (「JSON 방식 호출 방법」). */
const AIRKOREA_FIXED_RETURN_TYPE = 'json';

/** `pageNo=1` — this provider never auto-paginates; see `provider.ts` for the completeness check. */
const AIRKOREA_FIXED_PAGE_NO = 1;

/**
 * `numOfRows=100` — a fixed page size matching the technical document's own request-table sample
 * value for this operation (§ b, `numOfRows` 샘플데이터: `100`). One 읍면동 name can officially
 * identify more than one row nationwide (동명이동 — the same administrative name recurring across
 * different 시군구), so this project-owned cap must be generous enough that a single ambiguous name
 * plausibly returns its full candidate set in one page; `provider.ts`'s `INCOMPLETE_RESULT` guard
 * fails closed if it does not (see `docs/airkorea-tm-coordinate-provider.md`).
 */
const AIRKOREA_FIXED_NUM_OF_ROWS = 100;

/** The official field-size bound for the request `umdName` (문서 항목크기: 60). */
const AIRKOREA_UMD_NAME_MAX_LENGTH = 60;

/** Matches a C0 control character or DEL — rejected in `umdName`. */
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export type ValidateAirKoreaTmCoordinateRequestResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly AirKoreaTmCoordinateRequestIssue[] };

export type BuildAirKoreaTmCoordinateRequestUrlResult =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly issues: readonly AirKoreaTmCoordinateRequestIssue[] };

/**
 * Whether `value` is a well-formed AirKorea request `umdName`: a non-empty string, no
 * leading/trailing whitespace (not silently trimmed — a padded name is rejected outright, matching
 * `isAirKoreaStationName`'s policy), at most {@link AIRKOREA_UMD_NAME_MAX_LENGTH} UTF-16 code units,
 * and free of C0 control characters/DEL. This is a request-side predicate only — the *response*
 * `umdName` field (and `sidoName`/`sggName`) document a different, smaller field size (20) and are
 * validated separately in `tm-coordinate-raw-schema.ts` (see that module's docblock for why the two
 * are not the same predicate).
 */
export function isAirKoreaAdministrativeDongName(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  if (value.length === 0 || value.length > AIRKOREA_UMD_NAME_MAX_LENGTH) {
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
 * Validate a TM-coordinate request at runtime. The input is treated as `unknown`: a non-object
 * (`null`, `undefined`, a string/number/boolean, an array, a function) does not throw — it fails
 * with `umdName` flagged `INVALID`, the same as an object with a malformed `umdName`, so the
 * validator is *total*. The request object is only read, never mutated.
 */
export function validateAirKoreaTmCoordinateRequest(
  input: unknown,
): ValidateAirKoreaTmCoordinateRequestResult {
  if (!isRecord(input)) {
    return { ok: false, issues: [{ field: 'umdName', reason: 'INVALID' }] };
  }

  if (!isAirKoreaAdministrativeDongName(input.umdName)) {
    return { ok: false, issues: [{ field: 'umdName', reason: 'INVALID' }] };
  }

  return { ok: true };
}

/**
 * Build the 공공데이터포털 TM 기준좌표 조회 request URL for a *validated* request. Re-validates
 * defensively (so it is safe to call in isolation) and returns the same value-free issues on
 * failure.
 *
 * Construction rules:
 * - The operation path is always {@link AIRKOREA_TM_COORDINATE_OPERATION} — never built from caller
 *   input.
 * - `URL` + `URLSearchParams` build the query — never string concatenation.
 * - Parameters are appended in a fixed, deterministic order: `serviceKey`, `returnType`, `pageNo`,
 *   `numOfRows`, `umdName` — no `ver` (this operation's request table does not document one).
 * - `URLSearchParams` percent-encodes the decoded service key (and the Korean `umdName`) exactly
 *   once.
 */
export function buildAirKoreaTmCoordinateRequestUrl(
  serviceKey: string,
  request: AirKoreaTmCoordinateRequest,
): BuildAirKoreaTmCoordinateRequestUrlResult {
  const validation = validateAirKoreaTmCoordinateRequest(request);
  if (!validation.ok) {
    return { ok: false, issues: validation.issues };
  }

  const url = new URL(`${AIRKOREA_TM_COORDINATE_BASE_URL}/${AIRKOREA_TM_COORDINATE_OPERATION}`);
  url.searchParams.set('serviceKey', serviceKey);
  url.searchParams.set('returnType', AIRKOREA_FIXED_RETURN_TYPE);
  url.searchParams.set('pageNo', String(AIRKOREA_FIXED_PAGE_NO));
  url.searchParams.set('numOfRows', String(AIRKOREA_FIXED_NUM_OF_ROWS));
  url.searchParams.set('umdName', request.umdName);

  return { ok: true, url };
}

/** Exported for `provider.ts`'s completeness (`INCOMPLETE_RESULT`) reasoning. */
export { AIRKOREA_FIXED_NUM_OF_ROWS, AIRKOREA_FIXED_PAGE_NO };
