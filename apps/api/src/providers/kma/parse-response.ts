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
 * 1. **Not even a KMA envelope** — no valid `response.header` (`resultCode`/`resultMsg` strings)
 *    → `INVALID_RESPONSE`.
 * 2. **Valid header, non-success `resultCode`** → `UPSTREAM_ERROR`, preserving the raw
 *    `resultCode`/`resultMsg`. This covers `03` (NODATA_ERROR) and every other official error
 *    code, and it holds even when the error response carries no usable body.
 * 3. **Success `resultCode` (`'00'`)** → the full body is validated. A missing or malformed body
 *    under a success code is an `INVALID_RESPONSE`, not a silent empty page.
 *
 * Security: neither the raw input value nor any service key can appear in an error. An
 * `UPSTREAM_ERROR` carries only the two official header strings; an `INVALID_RESPONSE` carries
 * only issue *paths* and Zod's type-level messages — never the offending values, the response
 * body, or a stack trace. (A service key lives in the request URL, never the response, so it is
 * structurally impossible for one to reach these results.)
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
  readonly dataType: string;
  readonly pageNo: number;
  readonly numOfRows: number;
  readonly totalCount: number;
  readonly items: readonly KmaForecastItem[];
}

/**
 * A structurally valid KMA header whose `resultCode` is not the success code — the upstream
 * service reported a problem (or "no data"). The original code and message are preserved so the
 * caller can log or map them; nothing else from the response is carried.
 */
export interface KmaUpstreamError {
  readonly kind: 'UPSTREAM_ERROR';
  readonly resultCode: string;
  readonly resultMessage: string;
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
  // 1. Is this a KMA envelope at all? (header with string resultCode/resultMsg)
  const envelope = kmaResponseEnvelopeSchema.safeParse(input);
  if (!envelope.success) {
    return {
      ok: false,
      error: { kind: 'INVALID_RESPONSE', issues: toSanitizedIssues(envelope.error) },
    };
  }

  const { resultCode, resultMsg } = envelope.data.response.header;

  // 2. Structurally valid header but not a success code → upstream error (incl. NODATA_ERROR).
  if (resultCode !== KMA_SUCCESS_RESULT_CODE) {
    return {
      ok: false,
      error: {
        kind: 'UPSTREAM_ERROR',
        resultCode,
        resultMessage: resultMsg,
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
