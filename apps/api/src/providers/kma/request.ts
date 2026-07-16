/**
 * Forecast request input: its public type, runtime validation, the fixed product→operation
 * mapping, and deterministic URL construction for the 공공데이터포털 endpoint.
 *
 * The caller supplies only the *varying* request fields (product, base issuance, grid point). The
 * fixed query parameters that this provider always sends — `pageNo=1`, `numOfRows=1000`,
 * `dataType=JSON` — are internal constants a caller cannot override, so every fetch retrieves one
 * complete forecast issuance as JSON (the shape the PR #4 response boundary expects). See
 * `docs/kma-http-provider.md` for the official-source evidence behind the endpoint and parameters.
 *
 * Security: the service key is placed into the query with `URLSearchParams`, which percent-encodes
 * it exactly once. Neither the key, the built `URL`, nor the query string is ever logged or copied
 * into an error — a request error carries only value-free field issues.
 */

import { KmaForecastProduct } from '@life-weather/weather-core';

import { isCalendarDate, isClockTime, isNonNegativeSafeInteger } from './validation';

/**
 * A forecast request. Only these five vary per call; pagination and format are fixed internally
 * (see {@link KMA_FIXED_PAGE_NO} / {@link KMA_FIXED_NUM_OF_ROWS} / {@link KMA_FIXED_DATA_TYPE}).
 */
export interface KmaForecastRequest {
  readonly product: KmaForecastProduct;
  /** Base issuance date, official `YYYYMMDD`. */
  readonly baseDate: string;
  /** Base issuance time, official `HHmm` (`HH24MI`). */
  readonly baseTime: string;
  readonly nx: number;
  readonly ny: number;
}

/**
 * A single, value-free request-validation problem. Names the offending field only; the raw value
 * is deliberately never included so nothing (including a mistakenly-secret-shaped value) leaks.
 */
export interface KmaRequestIssue {
  readonly field: 'product' | 'baseDate' | 'baseTime' | 'nx' | 'ny';
  readonly reason: 'INVALID';
}

/** The 공공데이터포털 base URL for `VilageFcstInfoService_2.0`. HTTPS in production (not plain HTTP). */
export const KMA_BASE_URL =
  'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0';

/** Fixed pagination/format the provider always sends (a caller cannot change these). */
export const KMA_FIXED_PAGE_NO = 1;
export const KMA_FIXED_NUM_OF_ROWS = 1000;
export const KMA_FIXED_DATA_TYPE = 'JSON';

/**
 * The only product→operation mapping. Operation paths are selected *exclusively* from this table,
 * never built from caller input, so a malicious `product` can never reach the URL path.
 *
 * - `SHORT_FORECAST` → `getVilageFcst` (단기예보)
 * - `ULTRA_SHORT_FORECAST` → `getUltraSrtFcst` (초단기예보)
 */
const KMA_OPERATION_BY_PRODUCT = {
  [KmaForecastProduct.SHORT_FORECAST]: 'getVilageFcst',
  [KmaForecastProduct.ULTRA_SHORT_FORECAST]: 'getUltraSrtFcst',
} as const;

export type KmaForecastOperation =
  (typeof KMA_OPERATION_BY_PRODUCT)[keyof typeof KMA_OPERATION_BY_PRODUCT];

export type ValidateKmaForecastRequestResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly KmaRequestIssue[] };

export type BuildKmaForecastRequestUrlResult =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly issues: readonly KmaRequestIssue[] };

/** Whether `product` is one of the two supported forecast products. */
function isSupportedProduct(product: unknown): product is KmaForecastProduct {
  return (
    product === KmaForecastProduct.SHORT_FORECAST ||
    product === KmaForecastProduct.ULTRA_SHORT_FORECAST
  );
}

/** Whether `value` is a plain object we can read fields off — not `null`, an array, or a primitive. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The value-free issue list returned for a non-object request: every field flagged `INVALID`, in
 * the same fixed order as an object request, so a `null`/string/array/etc. input is *total* rather
 * than throwing on a property read.
 */
const NON_OBJECT_REQUEST_ISSUES: readonly KmaRequestIssue[] = [
  { field: 'product', reason: 'INVALID' },
  { field: 'baseDate', reason: 'INVALID' },
  { field: 'baseTime', reason: 'INVALID' },
  { field: 'nx', reason: 'INVALID' },
  { field: 'ny', reason: 'INVALID' },
];

/**
 * Validate a forecast request at runtime. The input is treated as `unknown` because a request
 * crosses a trust boundary even though its TypeScript type says {@link KmaForecastRequest}: a
 * non-object (`null`, `undefined`, a string/number/boolean, an array, a function) does not throw —
 * it fails with every field flagged `INVALID` in the fixed order below.
 *
 * For an object input, collects every problem in a fixed field order (`product`, `baseDate`,
 * `baseTime`, `nx`, `ny`) so the issue list is deterministic regardless of how many fields are
 * wrong. No numeric coercion: a numeric-string date/time or a string `nx`/`ny` is rejected, not
 * converted. The official issuance *schedule* (e.g. 단기예보 발표시각) is **not** enforced here — a
 * structurally valid but non-canonical time such as `0615` is accepted; schedule selection is a
 * later PR's concern. The request object is only read, never mutated.
 */
export function validateKmaForecastRequest(
  input: unknown,
): ValidateKmaForecastRequestResult {
  if (!isRecord(input)) {
    return { ok: false, issues: NON_OBJECT_REQUEST_ISSUES };
  }

  const issues: KmaRequestIssue[] = [];

  if (!isSupportedProduct(input.product)) {
    issues.push({ field: 'product', reason: 'INVALID' });
  }
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
 * Build the 공공데이터포털 forecast request URL for a *validated* request. Re-validates defensively
 * (so it is safe to call in isolation) and returns the same value-free issues on failure.
 *
 * Construction rules:
 * - The operation path comes only from {@link KMA_OPERATION_BY_PRODUCT}.
 * - `URL` + `URLSearchParams` build the query — never string concatenation.
 * - Parameters are appended in a fixed, deterministic order: `ServiceKey`, `pageNo`, `numOfRows`,
 *   `dataType`, `base_date`, `base_time`, `nx`, `ny`. Names and casing match the official endpoint
 *   exactly (`ServiceKey`, not `serviceKey`/`authKey`).
 * - `URLSearchParams` percent-encodes the decoded service key exactly once, so
 *   `url.searchParams.get('ServiceKey')` round-trips back to the original key while the serialized
 *   query shows `+`, `/`, `=` as `%2B`, `%2F`, `%3D` (and never double-encodes a `%`).
 */
export function buildKmaForecastRequestUrl(
  serviceKey: string,
  request: KmaForecastRequest,
): BuildKmaForecastRequestUrlResult {
  const validation = validateKmaForecastRequest(request);
  if (!validation.ok) {
    return { ok: false, issues: validation.issues };
  }

  const operation = KMA_OPERATION_BY_PRODUCT[request.product];
  const url = new URL(`${KMA_BASE_URL}/${operation}`);
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
