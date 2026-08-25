/**
 * KMA (기상청) 기상특보 조회서비스 (`WthrWrnInfoService`) 특보코드조회 (`getPwnCd`) request input: its
 * public type, runtime validation, and deterministic URL construction.
 *
 * `getPwnCd` is a **separate service family** from `VilageFcstInfoService_2.0` (forecast /
 * current observation): it has its own base path and, per the Owner-authorized live JSON
 * diagnostic (2026-08-25, evidence recorded in `docs/kma-alert-event-provider.md`), its own
 * service-key query parameter casing — `serviceKey`, not the forecast/current boundary's
 * `ServiceKey`. Both request styles were confirmed against the official
 * `기상청21_기상특보 조회서비스_오픈API활용가이드_260601` guide plus that live diagnostic; no other KMA
 * request module is changed by this addition.
 *
 * The caller supplies only the *varying* request fields — `fromTmFc`/`toTmFc`/`areaCode`/
 * `warningType`/`stnId` are all optional filters. Per the official 260601 guide's request table,
 * `fromTmFc`/`toTmFc` are documented `항목구분 = 0` (optional) with documented upstream defaults
 * (omitted `fromTmFc` defaults to the current date's `00:00`, omitted `toTmFc` to the current
 * date's `23:59`) — this module never synthesizes those defaults itself; an omitted date is simply
 * left out of the query so the documented upstream default applies. `areaCode` (guide max size 10)
 * and `stnId` (guide max size 5) are enforced with those length limits when present. Pagination and
 * format are fixed internally (`pageNo=1`, `numOfRows=1000`, `dataType=JSON`), matching the fixed
 * values every other KMA request in this provider always sends.
 *
 * Security: the service key is placed into the query with `URLSearchParams`, which percent-encodes
 * it exactly once. Neither the key, the built `URL`, nor the query string is ever logged or copied
 * into an error — a request error carries only value-free field issues.
 */

import { isCalendarDate } from './validation.js';

/**
 * The official `warningType` (특보종류) candidate values confirmed by the 260601 guide. Not
 * exhaustive of every code KMA has ever defined — only these are documented as valid filter
 * values for `getPwnCd`, so an out-of-list value is rejected rather than silently forwarded.
 */
export const KMA_ALERT_WARNING_TYPES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13] as const;

export type KmaAlertWarningType = (typeof KMA_ALERT_WARNING_TYPES)[number];

function isSupportedWarningType(value: unknown): value is KmaAlertWarningType {
  return (
    typeof value === 'number' &&
    (KMA_ALERT_WARNING_TYPES as readonly number[]).includes(value)
  );
}

/**
 * A `getPwnCd` request. Every field is an optional filter that is simply omitted from the query
 * when absent — an omitted `fromTmFc`/`toTmFc` lets the documented upstream default apply (this
 * module never reads the system clock or synthesizes a date itself). Pagination/format are fixed
 * internally and cannot be overridden by the caller.
 */
export interface KmaAlertEventRequest {
  /** Issuance-date window start, official `YYYYMMDD`. Omitted → documented upstream default. */
  readonly fromTmFc?: string;
  /** Issuance-date window end, official `YYYYMMDD`. Omitted → documented upstream default. */
  readonly toTmFc?: string;
  /** Guide max size 10 when present. */
  readonly areaCode?: string;
  /** Documented spelling only — `warninType` is a guide typo and is never emitted. */
  readonly warningType?: KmaAlertWarningType;
  /** Guide max size 5 when present. */
  readonly stnId?: string;
}

/**
 * A single, value-free request-validation problem. Names the offending field only; the raw value
 * is deliberately never included so nothing (including a mistakenly-secret-shaped value) leaks.
 */
export interface KmaAlertRequestIssue {
  readonly field: 'fromTmFc' | 'toTmFc' | 'areaCode' | 'warningType' | 'stnId';
  readonly reason: 'INVALID';
}

/** The dedicated `WthrWrnInfoService` base URL — never shared with `VilageFcstInfoService_2.0`. */
export const KMA_ALERT_BASE_URL = 'https://apis.data.go.kr/1360000/WthrWrnInfoService';

/** The fixed 특보코드조회 operation. Never built from caller input. */
export const KMA_ALERT_OPERATION = 'getPwnCd';

/** Fixed pagination/format this request always sends (a caller cannot change these). */
export const KMA_ALERT_FIXED_PAGE_NO = 1;
export const KMA_ALERT_FIXED_NUM_OF_ROWS = 1000;
export const KMA_ALERT_FIXED_DATA_TYPE = 'JSON';

export type ValidateKmaAlertEventRequestResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly KmaAlertRequestIssue[] };

export type BuildKmaAlertEventRequestUrlResult =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly issues: readonly KmaAlertRequestIssue[] };

/**
 * Whether `value` is a record-like object we can read fields off — a non-null, non-array object.
 * Deliberately not a strict plain-object check, matching the same allowance documented in
 * `request.ts` / `current-request.ts` / `config.ts`.
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
function createNonObjectAlertRequestIssues(): KmaAlertRequestIssue[] {
  return [
    { field: 'fromTmFc', reason: 'INVALID' },
    { field: 'toTmFc', reason: 'INVALID' },
    { field: 'areaCode', reason: 'INVALID' },
    { field: 'warningType', reason: 'INVALID' },
    { field: 'stnId', reason: 'INVALID' },
  ];
}

/**
 * Validate a `getPwnCd` request at runtime. The input is treated as `unknown`: a non-object
 * (`null`, `undefined`, a string/number/boolean, an array, a function) does not throw — it fails
 * with every field flagged `INVALID` in the fixed order below.
 *
 * For an object input, collects every problem in a fixed field order (`fromTmFc`, `toTmFc`,
 * `areaCode`, `warningType`, `stnId`). `fromTmFc`/`toTmFc`, when present, reuse the exact same
 * `isCalendarDate` predicate the forecast/current-observation boundaries use — no numeric
 * coercion, no ordering constraint between the two dates (no official evidence such a constraint
 * exists, so none is imposed here); when absent, the request is valid and the documented upstream
 * default applies (this validator never synthesizes a date). `areaCode`, when present, must be a
 * non-empty string of at most 10 characters (the guide's documented max size; no further
 * character-class restriction is imposed — no official evidence supports one). `stnId`, when
 * present, must be a non-empty string of at most 5 characters (same rationale). `warningType`,
 * when present, must be one of {@link KMA_ALERT_WARNING_TYPES} exactly (a number, never a numeric
 * string). Every optional field may be `undefined` (omitted from the request entirely); an
 * explicit `null` is not treated the same as `undefined` and is rejected. The request object is
 * only read, never mutated. Every call returns freshly-allocated issues.
 */
export function validateKmaAlertEventRequest(
  input: unknown,
): ValidateKmaAlertEventRequestResult {
  if (!isRecord(input)) {
    return { ok: false, issues: createNonObjectAlertRequestIssues() };
  }

  const issues: KmaAlertRequestIssue[] = [];

  if (
    input.fromTmFc !== undefined &&
    (typeof input.fromTmFc !== 'string' || !isCalendarDate(input.fromTmFc))
  ) {
    issues.push({ field: 'fromTmFc', reason: 'INVALID' });
  }
  if (
    input.toTmFc !== undefined &&
    (typeof input.toTmFc !== 'string' || !isCalendarDate(input.toTmFc))
  ) {
    issues.push({ field: 'toTmFc', reason: 'INVALID' });
  }
  if (
    input.areaCode !== undefined &&
    (typeof input.areaCode !== 'string' ||
      input.areaCode === '' ||
      input.areaCode.length > 10)
  ) {
    issues.push({ field: 'areaCode', reason: 'INVALID' });
  }
  if (input.warningType !== undefined && !isSupportedWarningType(input.warningType)) {
    issues.push({ field: 'warningType', reason: 'INVALID' });
  }
  if (
    input.stnId !== undefined &&
    (typeof input.stnId !== 'string' || input.stnId === '' || input.stnId.length > 5)
  ) {
    issues.push({ field: 'stnId', reason: 'INVALID' });
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/**
 * Build the `getPwnCd` request URL for a *validated* request. Re-validates defensively (so it is
 * safe to call in isolation) and returns the same value-free issues on failure.
 *
 * Construction rules:
 * - The operation path is always {@link KMA_ALERT_OPERATION} — never built from caller input.
 * - `URL` + `URLSearchParams` build the query — never string concatenation.
 * - Parameters are appended in a fixed, deterministic order: `serviceKey`, `pageNo`, `numOfRows`,
 *   `dataType`, then `fromTmFc`/`toTmFc`/`areaCode`/`warningType`/`stnId` **only when present** on
 *   the request, each still in that fixed relative position — an absent optional field (including
 *   `fromTmFc`/`toTmFc`) is omitted from the query entirely, never sent as an empty string, so the
 *   documented upstream default applies. The documented `warningType` spelling is used;
 *   `warninType` (the guide's typo) is never emitted.
 * - `URLSearchParams` percent-encodes the decoded service key exactly once.
 */
export function buildKmaAlertEventRequestUrl(
  serviceKey: string,
  request: KmaAlertEventRequest,
): BuildKmaAlertEventRequestUrlResult {
  const validation = validateKmaAlertEventRequest(request);
  if (!validation.ok) {
    return { ok: false, issues: validation.issues };
  }

  const url = new URL(`${KMA_ALERT_BASE_URL}/${KMA_ALERT_OPERATION}`);
  url.searchParams.set('serviceKey', serviceKey);
  url.searchParams.set('pageNo', String(KMA_ALERT_FIXED_PAGE_NO));
  url.searchParams.set('numOfRows', String(KMA_ALERT_FIXED_NUM_OF_ROWS));
  url.searchParams.set('dataType', KMA_ALERT_FIXED_DATA_TYPE);
  if (request.fromTmFc !== undefined) {
    url.searchParams.set('fromTmFc', request.fromTmFc);
  }
  if (request.toTmFc !== undefined) {
    url.searchParams.set('toTmFc', request.toTmFc);
  }
  if (request.areaCode !== undefined) {
    url.searchParams.set('areaCode', request.areaCode);
  }
  if (request.warningType !== undefined) {
    url.searchParams.set('warningType', String(request.warningType));
  }
  if (request.stnId !== undefined) {
    url.searchParams.set('stnId', request.stnId);
  }

  return { ok: true, url };
}
