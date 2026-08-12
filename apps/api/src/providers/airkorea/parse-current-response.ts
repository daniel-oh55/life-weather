/**
 * Classify a raw, already-parsed AirKorea 측정소별 실시간 측정정보 조회 (`getMsrstnAcctoRltmMesureDnsty`)
 * JSON value into exactly one of three outcomes: a validated success page, a preserved upstream
 * error, or a sanitized invalid-response report.
 *
 * This is the AirKorea counterpart of the KMA provider's `parse-current-response.ts` — same
 * decision logic and security posture, independently implemented (not imported) per the project's
 * provider-namespace isolation policy, against this operation's own envelope/body schemas
 * (`current-raw-schema.ts`).
 *
 * This function never fetches, never throws, and never touches an environment variable or the
 * system clock. It takes an `unknown` (the caller is responsible for `JSON.parse`) and returns a
 * discriminated result.
 *
 * Decision order:
 *
 * 1. **Not even an AirKorea envelope** — no valid `response.header` → `INVALID_RESPONSE`.
 * 2. **Valid header, non-success `resultCode`** → `UPSTREAM_ERROR`, preserving only the official
 *    two-digit `resultCode` (the untrusted raw `resultMsg` is dropped).
 * 3. **Success `resultCode` (`'00'`)** — the full body is validated against the operation's body
 *    schema. A missing or malformed body under a success code is `INVALID_RESPONSE`.
 *
 * Security: no error variant carries the raw input value, a service key, or a raw upstream message.
 */

import type { z } from 'zod';

import {
  airKoreaCurrentAirQualitySuccessResponseSchema,
  airKoreaResponseEnvelopeSchema,
  AIRKOREA_SUCCESS_RESULT_CODE,
  type AirKoreaCurrentAirQualityItem,
} from './current-raw-schema.js';

/**
 * A single sanitized validation problem. Only the location (`path`) and a type-level `message` are
 * exposed; the raw input value that failed is deliberately omitted.
 */
export interface AirKoreaCurrentResponseIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/** A validated 측정소별 실시간 측정정보 조회 success page: the official body fields plus the item array. */
export interface AirKoreaCurrentAirQualityPage {
  readonly numOfRows: number;
  readonly pageNo: number;
  readonly totalCount: number;
  readonly items: readonly AirKoreaCurrentAirQualityItem[];
}

/**
 * A structurally valid AirKorea header whose `resultCode` is not the success code. Only the
 * official two-digit `resultCode` is preserved; the raw `resultMsg` is **not** carried.
 */
export interface AirKoreaCurrentUpstreamError {
  readonly kind: 'UPSTREAM_ERROR';
  readonly resultCode: string;
}

/** A response that is not a well-formed AirKorea success/error envelope, reduced to safe issues. */
export interface AirKoreaCurrentInvalidResponse {
  readonly kind: 'INVALID_RESPONSE';
  readonly issues: readonly AirKoreaCurrentResponseIssue[];
}

export type AirKoreaCurrentResponseError =
  | AirKoreaCurrentUpstreamError
  | AirKoreaCurrentInvalidResponse;

export type ParseAirKoreaCurrentAirQualityResponseResult =
  | { readonly ok: true; readonly page: AirKoreaCurrentAirQualityPage }
  | { readonly ok: false; readonly error: AirKoreaCurrentResponseError };

/**
 * Convert a `ZodError` into a deterministically ordered list of sanitized issues: only `path` and
 * `message` are copied, sorted by `(path, message)` with code-unit string comparison so the output
 * is independent of Zod's internal traversal order.
 */
function toSanitizedIssues(error: z.ZodError): readonly AirKoreaCurrentResponseIssue[] {
  const issues: AirKoreaCurrentResponseIssue[] = error.issues.map((issue) => ({
    path: issue.path.map((segment) => (typeof segment === 'number' ? segment : String(segment))),
    message: issue.message,
  }));

  return issues.sort((a, b) => {
    const pathA = a.path.join('');
    const pathB = b.path.join('');
    if (pathA !== pathB) {
      return pathA < pathB ? -1 : 1;
    }
    if (a.message !== b.message) {
      return a.message < b.message ? -1 : 1;
    }
    return 0;
  });
}

/**
 * Parse and classify a raw AirKorea current-air-quality response. Pure, total, and non-throwing:
 * any input — including `null`, a primitive, or a malformed object — resolves to one of the three
 * result variants. The input is only read, never mutated.
 */
export function parseAirKoreaCurrentAirQualityResponse(
  input: unknown,
): ParseAirKoreaCurrentAirQualityResponseResult {
  // 1. Is this an AirKorea envelope at all? (header with a two-digit resultCode and resultMsg).
  const envelope = airKoreaResponseEnvelopeSchema.safeParse(input);
  if (!envelope.success) {
    return {
      ok: false,
      error: { kind: 'INVALID_RESPONSE', issues: toSanitizedIssues(envelope.error) },
    };
  }

  const { resultCode } = envelope.data.response.header;

  // 2. Structurally valid header but not a success code → upstream error.
  if (resultCode !== AIRKOREA_SUCCESS_RESULT_CODE) {
    return { ok: false, error: { kind: 'UPSTREAM_ERROR', resultCode } };
  }

  // 3. Success code → the body must be well-formed, otherwise the response is invalid.
  const success = airKoreaCurrentAirQualitySuccessResponseSchema.safeParse(input);
  if (!success.success) {
    return {
      ok: false,
      error: { kind: 'INVALID_RESPONSE', issues: toSanitizedIssues(success.error) },
    };
  }

  const { body } = success.data.response;
  return {
    ok: true,
    page: {
      numOfRows: body.numOfRows,
      pageNo: body.pageNo,
      totalCount: body.totalCount,
      items: body.items.item,
    },
  };
}
