/**
 * AirKorea (에어코리아) TM-coordinate nearby-station request input: its public type, runtime
 * validation, and deterministic URL construction for the 공공데이터포털 `getNearbyMsrstnList`
 * (근접측정소 목록 조회) operation.
 *
 * Official-source evidence (see `docs/airkorea-nearby-station-provider.md` for the full record):
 * 한국환경공단_에어코리아_측정소정보 (Public Data Portal dataset `15073877`, portal metadata modified
 * 2026-06-30), reference document `한국환경공단 에어코리아 OpenAPI 기술문서_20260630.zip` →
 * `한국환경공단_에어코리아_측정소정보_기술문서_v1.2.docx`, operation 2 (근접측정소 목록 조회,
 * `getNearbyMsrstnList`), API명(영문) `MsrstnInfoInqireSvc`.
 *
 * The caller supplies only the two varying request fields — a TM (중부원점) coordinate pair
 * (`tmX`, `tmY`). The technical document's own 버전(ver) notes document that **not** sending `ver`
 * is what selects TM(중부원점)-coordinate semantics for `tmX`/`tmY` ("버전을 포함하지 않고 호출할
 * 경우: TM좌표(중부원점) 기반의 가까운 측정소 정보를 표출") — `ver=1.0`/`1.2` reinterpret `tmX`/`tmY`
 * as a *different* coordinate system (도로명주소API 좌표), and `ver=1.1`/`1.2` additionally include a
 * `stationCode` this provider does not consume. This provider therefore never sends `ver` — a
 * project-owned fixed request policy grounded in that documented default, not a copy of the
 * current-air-quality provider's `ver` handling (see the doc for the full version table). The only
 * other fixed parameter is `returnType=json` (documented JSON-response opt-in). This operation's
 * request table has no `pageNo`/`numOfRows`/`dataTerm` parameters (unlike
 * `getMsrstnAcctoRltmMesureDnsty`) — none are sent.
 *
 * Security: the service key is placed into the query with `URLSearchParams`, which percent-encodes
 * it exactly once. Neither the key, the built `URL`, nor the query string is ever logged or copied
 * into an error — a request error carries only value-free field issues.
 */

/** A TM(중부원점)-coordinate nearby-station request. Both fields vary per call. */
export interface AirKoreaNearbyStationRequest {
  /** TM_X 좌표 (TM측정방식 X좌표). */
  readonly tmX: number;
  /** TM_Y 좌표 (TM측정방식 Y좌표). */
  readonly tmY: number;
}

/**
 * A single, value-free request-validation problem. Names the offending field only; the raw value
 * is deliberately never included so nothing (including a mistakenly-secret-shaped value) leaks.
 */
export interface AirKoreaNearbyStationRequestIssue {
  readonly field: 'tmX' | 'tmY';
  readonly reason: 'INVALID';
}

/**
 * The 공공데이터포털 HTTPS host for `MsrstnInfoInqireSvc` (측정소정보 조회 서비스). The technical
 * document's Call Back URL is `http://apis.data.go.kr/...`, but this project always calls the
 * public data portal over HTTPS (matching the existing KMA and AirKorea current-air-quality
 * providers' documented deviation) — a service key must never be sent over a plaintext connection.
 */
export const AIRKOREA_NEARBY_STATION_BASE_URL = 'https://apis.data.go.kr/B552584/MsrstnInfoInqireSvc';

/** The fixed 근접측정소 목록 조회 operation. Never built from caller input. */
export const AIRKOREA_NEARBY_STATION_OPERATION = 'getNearbyMsrstnList';

/** `returnType=json` — documented JSON-response opt-in (「JSON 방식 호출 방법」). */
const AIRKOREA_FIXED_RETURN_TYPE = 'json';

export type ValidateAirKoreaNearbyStationRequestResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly AirKoreaNearbyStationRequestIssue[] };

export type BuildAirKoreaNearbyStationRequestUrlResult =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly issues: readonly AirKoreaNearbyStationRequestIssue[] };

/**
 * Whether `value` is a well-formed TM coordinate: a `number`, finite (rejects `NaN`, `Infinity`,
 * `-Infinity`), and one whose decimal string representation is not exponential notation (rejects a
 * magnitude so large or so close to zero that `String(value)` would produce e.g. `"1e+21"` —  such a
 * value could not be sent as a plain decimal query parameter). The technical document's own 항목크기
 * (`16.6`) is a legacy field-width hint, not a numeric-precision contract recoverable from a JS
 * `number` (floating-point values do not reliably preserve a fixed decimal-digit count), so it is
 * documented but not enforced here — see `docs/airkorea-nearby-station-provider.md`.
 */
export function isAirKoreaTmCoordinate(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return false;
  }
  return !/e/i.test(value.toString());
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
 * Validate a nearby-station request at runtime. The input is treated as `unknown`: a non-object
 * (`null`, `undefined`, a string/number/boolean, an array, a function) does not throw — it fails
 * with both `tmX` and `tmY` flagged `INVALID`, the same as an object with both fields malformed, so
 * the validator is *total*. Fields are checked in a fixed order (`tmX`, then `tmY`) so multiple
 * problems are reported deterministically. The request object is only read, never mutated.
 */
export function validateAirKoreaNearbyStationRequest(
  input: unknown,
): ValidateAirKoreaNearbyStationRequestResult {
  if (!isRecord(input)) {
    return {
      ok: false,
      issues: [
        { field: 'tmX', reason: 'INVALID' },
        { field: 'tmY', reason: 'INVALID' },
      ],
    };
  }

  const issues: AirKoreaNearbyStationRequestIssue[] = [];
  if (!isAirKoreaTmCoordinate(input.tmX)) {
    issues.push({ field: 'tmX', reason: 'INVALID' });
  }
  if (!isAirKoreaTmCoordinate(input.tmY)) {
    issues.push({ field: 'tmY', reason: 'INVALID' });
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true };
}

/**
 * Build the 공공데이터포털 근접측정소 목록 조회 request URL for a *validated* request. Re-validates
 * defensively (so it is safe to call in isolation) and returns the same value-free issues on
 * failure.
 *
 * Construction rules:
 * - The operation path is always {@link AIRKOREA_NEARBY_STATION_OPERATION} — never built from
 *   caller input.
 * - `URL` + `URLSearchParams` build the query — never string concatenation.
 * - Parameters are appended in a fixed, deterministic order: `serviceKey`, `returnType`, `tmX`,
 *   `tmY` — no `ver` (see the module docblock for why omitting it is the correct, evidence-based
 *   choice for this project).
 * - `URLSearchParams` percent-encodes the decoded service key exactly once.
 */
export function buildAirKoreaNearbyStationRequestUrl(
  serviceKey: string,
  request: AirKoreaNearbyStationRequest,
): BuildAirKoreaNearbyStationRequestUrlResult {
  const validation = validateAirKoreaNearbyStationRequest(request);
  if (!validation.ok) {
    return { ok: false, issues: validation.issues };
  }

  const url = new URL(`${AIRKOREA_NEARBY_STATION_BASE_URL}/${AIRKOREA_NEARBY_STATION_OPERATION}`);
  url.searchParams.set('serviceKey', serviceKey);
  url.searchParams.set('returnType', AIRKOREA_FIXED_RETURN_TYPE);
  url.searchParams.set('tmX', String(request.tmX));
  url.searchParams.set('tmY', String(request.tmY));

  return { ok: true, url };
}
