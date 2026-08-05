/**
 * Current observation (초단기실황, `getUltraSrtNcst`) request input: its public type, runtime
 * validation, and deterministic URL construction for the 공공데이터포털 endpoint.
 *
 * This is the current-observation counterpart of `request.ts` (the forecast request). It is a
 * **separate** type and validator — 초단기실황 has no `product` choice (there is exactly one
 * operation) and its item shape is different (`obsrValue`, not `fcstValue`; no `fcstDate`/
 * `fcstTime`) — but it shares the base URL and the fixed pagination/format constants with the
 * forecast request, since both target the same 공공데이터포털 service with the same defensive
 * pagination policy. See `docs/kma-current-observation-provider.md` for the official-source
 * evidence behind the endpoint and parameters.
 *
 * Security: the service key is placed into the query with `URLSearchParams`, which percent-encodes
 * it exactly once. Neither the key, the built `URL`, nor the query string is ever logged or copied
 * into an error — a request error carries only value-free field issues.
 */

import {
  KMA_BASE_URL,
  KMA_FIXED_DATA_TYPE,
  KMA_FIXED_NUM_OF_ROWS,
  KMA_FIXED_PAGE_NO,
} from './request.js';
import { isCalendarDate, isClockTime, isNonNegativeSafeInteger } from './validation.js';

/** A current-observation request. All four fields vary per call; pagination/format are fixed. */
export interface KmaCurrentObservationRequest {
  /** Observation base date, official `YYYYMMDD`. */
  readonly baseDate: string;
  /** Observation base time, official `HHmm` (`HH24MI`) — an on-the-hour value for 초단기실황. */
  readonly baseTime: string;
  readonly nx: number;
  readonly ny: number;
}

/**
 * A single, value-free request-validation problem. Names the offending field only; the raw value
 * is deliberately never included so nothing (including a mistakenly-secret-shaped value) leaks.
 */
export interface KmaCurrentRequestIssue {
  readonly field: 'baseDate' | 'baseTime' | 'nx' | 'ny';
  readonly reason: 'INVALID';
}

/** The fixed 초단기실황 operation. Never built from caller input. */
export const KMA_CURRENT_OBSERVATION_OPERATION = 'getUltraSrtNcst';

export type ValidateKmaCurrentObservationRequestResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly KmaCurrentRequestIssue[] };

export type BuildKmaCurrentObservationRequestUrlResult =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly issues: readonly KmaCurrentRequestIssue[] };

/**
 * Whether `value` is a record-like object we can read fields off — a non-null, non-array object.
 * Deliberately not a strict plain-object check, matching the same allowance documented in
 * `request.ts` and `config.ts` (a `Date`/class instance/custom-prototype object also passes; that
 * is sufficient for a provider called from internal server code with a JSON-shaped request).
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
function createNonObjectCurrentRequestIssues(): KmaCurrentRequestIssue[] {
  return [
    { field: 'baseDate', reason: 'INVALID' },
    { field: 'baseTime', reason: 'INVALID' },
    { field: 'nx', reason: 'INVALID' },
    { field: 'ny', reason: 'INVALID' },
  ];
}

/**
 * Validate a current-observation request at runtime. The input is treated as `unknown`: a
 * non-object (`null`, `undefined`, a string/number/boolean, an array, a function) does not throw —
 * it fails with every field flagged `INVALID` in the fixed order below.
 *
 * For an object input, collects every problem in a fixed field order (`baseDate`, `baseTime`,
 * `nx`, `ny`). No numeric coercion: a numeric-string date/time or a string `nx`/`ny` is rejected,
 * not converted. `baseDate`/`baseTime` reuse the exact same `isCalendarDate`/`isClockTime`
 * predicates the forecast request and response boundaries use, so all three layers agree on what a
 * valid KMA date/time looks like. The request object is only read, never mutated. Every call
 * returns freshly-allocated issues, so mutating one result never leaks into a later call.
 */
export function validateKmaCurrentObservationRequest(
  input: unknown,
): ValidateKmaCurrentObservationRequestResult {
  if (!isRecord(input)) {
    return { ok: false, issues: createNonObjectCurrentRequestIssues() };
  }

  const issues: KmaCurrentRequestIssue[] = [];

  if (typeof input.baseDate !== 'string' || !isCalendarDate(input.baseDate)) {
    issues.push({ field: 'baseDate', reason: 'INVALID' });
  }
  if (typeof input.baseTime !== 'string' || !isClockTime(input.baseTime)) {
    issues.push({ field: 'baseTime', reason: 'INVALID' });
  }
  if (!isNonNegativeSafeInteger(input.nx)) {
    issues.push({ field: 'nx', reason: 'INVALID' });
  }
  if (!isNonNegativeSafeInteger(input.ny)) {
    issues.push({ field: 'ny', reason: 'INVALID' });
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/**
 * Build the 공공데이터포털 current-observation request URL for a *validated* request. Re-validates
 * defensively (so it is safe to call in isolation) and returns the same value-free issues on
 * failure.
 *
 * Construction rules:
 * - The operation path is always {@link KMA_CURRENT_OBSERVATION_OPERATION} — never built from
 *   caller input.
 * - `URL` + `URLSearchParams` build the query — never string concatenation.
 * - Parameters are appended in a fixed, deterministic order: `ServiceKey`, `pageNo`, `numOfRows`,
 *   `dataType`, `base_date`, `base_time`, `nx`, `ny` — the same names, casing, and fixed pagination
 *   (`pageNo=1`, `numOfRows=1000`, `dataType=JSON`) as the forecast request.
 * - `URLSearchParams` percent-encodes the decoded service key exactly once.
 */
export function buildKmaCurrentObservationRequestUrl(
  serviceKey: string,
  request: KmaCurrentObservationRequest,
): BuildKmaCurrentObservationRequestUrlResult {
  const validation = validateKmaCurrentObservationRequest(request);
  if (!validation.ok) {
    return { ok: false, issues: validation.issues };
  }

  const url = new URL(`${KMA_BASE_URL}/${KMA_CURRENT_OBSERVATION_OPERATION}`);
  url.searchParams.set('ServiceKey', serviceKey);
  url.searchParams.set('pageNo', String(KMA_FIXED_PAGE_NO));
  url.searchParams.set('numOfRows', String(KMA_FIXED_NUM_OF_ROWS));
  url.searchParams.set('dataType', KMA_FIXED_DATA_TYPE);
  url.searchParams.set('base_date', request.baseDate);
  url.searchParams.set('base_time', request.baseTime);
  url.searchParams.set('nx', String(request.nx));
  url.searchParams.set('ny', String(request.ny));

  return { ok: true, url };
}
