/**
 * Classify a raw, already-parsed KMA forecast JSON value into exactly one of three outcomes:
 * a validated success page, a preserved upstream error, or a sanitized invalid-response report.
 *
 * This function never fetches, never throws, and never touches an environment variable or the
 * system clock. It takes an `unknown` (the caller is responsible for `JSON.parse`) and returns a
 * discriminated result, so control flow stays explicit at the call site. See
 * `docs/kma-response-boundary.md` for the official envelope and error-code evidence.
 *
 * Decision order:
 *
 * 1. **Not even a KMA envelope** — no valid `response.header` (a two-digit `resultCode` and a
 *    `resultMsg` string) → `INVALID_RESPONSE`. A structurally malformed `resultCode` (e.g. `''`,
 *    `'0'`, `'000'`, `'AB'`, `' 03 '`) fails here and is an invalid response, *not* mistaken for a
 *    genuine upstream error.
 * 2. **Valid header, non-success `resultCode`** → `UPSTREAM_ERROR`, preserving only the official
 *    two-digit `resultCode`. This covers `03` (NODATA_ERROR) and every other two-digit error
 *    code, and it holds even when the error response carries no usable body.
 * 3. **Success `resultCode` (`'00'`)** → the full body is validated. A missing or malformed body
 *    under a success code is an `INVALID_RESPONSE`, not a silent empty page.
 *
 * Security: neither the raw input value nor any service key can appear in an error. An
 * `UPSTREAM_ERROR` carries only the official two-digit `resultCode` — the untrusted raw
 * `resultMsg` is deliberately dropped, so a secret-shaped token, CR/LF, or log-injection payload
 * in an upstream message can never reach this surface. An `INVALID_RESPONSE` carries only issue
 * *paths* and Zod's type-level messages — never the offending values, the response body, or a
 * stack trace. (A service key lives in the request URL, never the response, so it is structurally
 * impossible for one to reach these results.)
 */

import type { z } from 'zod';

import {
  KMA_SUCCESS_RESULT_CODE,
  kmaForecastSuccessResponseSchema,
  kmaResponseEnvelopeSchema,
  type KmaForecastItem,
} from './raw-schema';

/**
 * A single sanitized validation problem. Only the location (`path`) and a type-level `message`
 * are exposed; the raw input value that failed is deliberately omitted so no untrusted payload
 * (or anything resembling a secret) leaks through the error surface.
 */
export interface KmaResponseIssue {
  /** JSON path to the offending node, e.g. `['response', 'body', 'items', 'item', 0, 'nx']`. */
  readonly path: readonly (string | number)[];
  /** A value-free description of the problem (Zod's message for the failed rule). */
  readonly message: string;
}

/**
 * A validated success page: the official body fields plus the validated `item` array. The
 * caller pairs this with a {@link KmaForecastProduct} when grouping into slots — the response
 * itself does not say which operation produced it.
 */
export interface KmaForecastPage {
  readonly dataType: 'JSON';
  readonly pageNo: number;
  readonly numOfRows: number;
  readonly totalCount: number;
  readonly items: readonly KmaForecastItem[];
}

/**
 * A structurally valid KMA header whose `resultCode` is not the success code — the upstream
 * service reported a problem (or "no data"). Only the official two-digit `resultCode` is
 * preserved so the caller can map it; the raw `resultMsg` is **not** carried. `resultMsg` is an
 * untrusted upstream string that could contain a secret-shaped token, CR/LF, a log-injection
 * payload, or an unexpectedly long/internal message, so it must never be copied onto this public
 * error surface. A safe, caller-owned canonical message can be derived from `resultCode` when one
 * is needed; a raw upstream message is never re-exposed here (security logging with length and
 * control-character limits, if ever wanted, is a separate PR #5 design). Nothing else from the
 * response is carried.
 */
export interface KmaUpstreamError {
  readonly kind: 'UPSTREAM_ERROR';
  readonly resultCode: string;
}

/** A response that is not a well-formed KMA success/error envelope, reduced to safe issues. */
export interface KmaInvalidResponse {
  readonly kind: 'INVALID_RESPONSE';
  readonly issues: readonly KmaResponseIssue[];
}

export type KmaForecastResponseError = KmaUpstreamError | KmaInvalidResponse;

export type ParseKmaForecastResponseResult =
  | { readonly ok: true; readonly page: KmaForecastPage }
  | { readonly ok: false; readonly error: KmaForecastResponseError };

/**
 * Convert a `ZodError` into a deterministically ordered list of sanitized issues. Only `path`
 * and `message` are copied — never `input`, `code` internals, or the raw value. Sorting by
 * `(path, message)` with code-unit string comparison makes the output independent of Zod's
 * internal traversal order, so the same malformed response always yields the same issue list.
 */
function toSanitizedIssues(error: z.ZodError): readonly KmaResponseIssue[] {
  const issues: KmaResponseIssue[] = error.issues.map((issue) => ({
    path: issue.path.map((segment) =>
      typeof segment === 'number' ? segment : String(segment),
    ),
    message: issue.message,
  }));

  return issues.sort((a, b) => {
    const pathA = a.path.join('');
    const pathB = b.path.join('');
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
 * Parse and classify a raw KMA forecast response. Pure, total, and non-throwing: any input —
 * including `null`, a primitive, or a malformed object — resolves to one of the three result
 * variants. The input is only read, never mutated.
 */
export function parseKmaForecastResponse(
  input: unknown,
): ParseKmaForecastResponseResult {
  // 1. Is this a KMA envelope at all? (header with a two-digit resultCode and a resultMsg string).
  //    A malformed resultCode fails here and is an INVALID_RESPONSE, never an upstream error.
  const envelope = kmaResponseEnvelopeSchema.safeParse(input);
  if (!envelope.success) {
    return {
      ok: false,
      error: { kind: 'INVALID_RESPONSE', issues: toSanitizedIssues(envelope.error) },
    };
  }

  const { resultCode } = envelope.data.response.header;

  // 2. Structurally valid header but not a success code → upstream error (incl. NODATA_ERROR).
  //    Only the official two-digit resultCode is exposed; the untrusted raw resultMsg is dropped.
  if (resultCode !== KMA_SUCCESS_RESULT_CODE) {
    return {
      ok: false,
      error: {
        kind: 'UPSTREAM_ERROR',
        resultCode,
      },
    };
  }

  // 3. Success code → the body must be well-formed, otherwise the response is invalid.
  const success = kmaForecastSuccessResponseSchema.safeParse(input);
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
      dataType: body.dataType,
      pageNo: body.pageNo,
      numOfRows: body.numOfRows,
      totalCount: body.totalCount,
      items: body.items.item,
    },
  };
}
