/**
 * Classify a raw, already-parsed KMA 초단기실황 (current observation, `getUltraSrtNcst`) JSON value
 * into exactly one of three outcomes: a validated success page, a preserved upstream error, or a
 * sanitized invalid-response report.
 *
 * This is the current-observation counterpart of `parse-response.ts` (the forecast parser). The
 * decision logic and security posture are **identical** to the forecast parser — only the body
 * schema differs (`current-raw-schema.ts`'s `obsrValue` item, not `raw-schema.ts`'s `fcstValue`
 * item). The envelope/header classification reuses `raw-schema.ts`'s `kmaResponseEnvelopeSchema`
 * and `KMA_SUCCESS_RESULT_CODE` directly, so both parsers agree byte-for-byte on what counts as a
 * valid header and a success code. See `docs/kma-current-observation-provider.md`.
 *
 * This function never fetches, never throws, and never touches an environment variable or the
 * system clock. It takes an `unknown` (the caller is responsible for `JSON.parse`) and returns a
 * discriminated result, so control flow stays explicit at the call site.
 *
 * Decision order (identical to the forecast parser):
 *
 * 1. **Not even a KMA envelope** — no valid `response.header` → `INVALID_RESPONSE`.
 * 2. **Valid header, non-success `resultCode`** → `UPSTREAM_ERROR`, preserving only the official
 *    two-digit `resultCode`.
 * 3. **Success `resultCode` (`'00'`)** → the full body is validated against the current-observation
 *    body schema. A missing or malformed body under a success code is `INVALID_RESPONSE`.
 *
 * Security: identical to the forecast parser — neither the raw input value nor a service key can
 * appear in an error. An `UPSTREAM_ERROR` carries only the official two-digit `resultCode` (the
 * untrusted raw `resultMsg` is dropped). An `INVALID_RESPONSE` carries only issue *paths* and Zod's
 * type-level messages — never the offending values, the response body, or a stack trace.
 */

import type { z } from 'zod';

import {
  kmaCurrentObservationSuccessResponseSchema,
  type KmaCurrentObservationItem,
} from './current-raw-schema.js';
import { KMA_SUCCESS_RESULT_CODE, kmaResponseEnvelopeSchema } from './raw-schema.js';

/**
 * A single sanitized validation problem. Only the location (`path`) and a type-level `message` are
 * exposed; the raw input value that failed is deliberately omitted.
 */
export interface KmaCurrentResponseIssue {
  /** JSON path to the offending node, e.g. `['response', 'body', 'items', 'item', 0, 'nx']`. */
  readonly path: readonly (string | number)[];
  /** A value-free description of the problem (Zod's message for the failed rule). */
  readonly message: string;
}

/** A validated current-observation success page: the official body fields plus the item array. */
export interface KmaCurrentObservationPage {
  readonly dataType: 'JSON';
  readonly pageNo: number;
  readonly numOfRows: number;
  readonly totalCount: number;
  readonly items: readonly KmaCurrentObservationItem[];
}

/**
 * A structurally valid KMA header whose `resultCode` is not the success code. Only the official
 * two-digit `resultCode` is preserved; the raw `resultMsg` is **not** carried (same rationale as
 * the forecast boundary's `KmaUpstreamError` — an untrusted upstream string must never reach a
 * public error surface).
 */
export interface KmaCurrentUpstreamError {
  readonly kind: 'UPSTREAM_ERROR';
  readonly resultCode: string;
}

/** A response that is not a well-formed KMA success/error envelope, reduced to safe issues. */
export interface KmaCurrentInvalidResponse {
  readonly kind: 'INVALID_RESPONSE';
  readonly issues: readonly KmaCurrentResponseIssue[];
}

export type KmaCurrentObservationResponseError =
  | KmaCurrentUpstreamError
  | KmaCurrentInvalidResponse;

export type ParseKmaCurrentObservationResponseResult =
  | { readonly ok: true; readonly page: KmaCurrentObservationPage }
  | { readonly ok: false; readonly error: KmaCurrentObservationResponseError };

/**
 * Convert a `ZodError` into a deterministically ordered list of sanitized issues. Identical
 * algorithm to the forecast parser's `toSanitizedIssues`: only `path` and `message` are copied,
 * sorted by `(path, message)` with code-unit string comparison so the output is independent of
 * Zod's internal traversal order.
 */
function toSanitizedIssues(error: z.ZodError): readonly KmaCurrentResponseIssue[] {
  const issues: KmaCurrentResponseIssue[] = error.issues.map((issue) => ({
    path: issue.path.map((segment) =>
      typeof segment === 'number' ? segment : String(segment),
    ),
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
 * Parse and classify a raw KMA current-observation response. Pure, total, and non-throwing: any
 * input — including `null`, a primitive, or a malformed object — resolves to one of the three
 * result variants. The input is only read, never mutated.
 */
export function parseKmaCurrentObservationResponse(
  input: unknown,
): ParseKmaCurrentObservationResponseResult {
  // 1. Is this a KMA envelope at all? (header with a two-digit resultCode and a resultMsg string).
  const envelope = kmaResponseEnvelopeSchema.safeParse(input);
  if (!envelope.success) {
    return {
      ok: false,
      error: { kind: 'INVALID_RESPONSE', issues: toSanitizedIssues(envelope.error) },
    };
  }

  const { resultCode } = envelope.data.response.header;

  // 2. Structurally valid header but not a success code → upstream error.
  if (resultCode !== KMA_SUCCESS_RESULT_CODE) {
    return {
      ok: false,
      error: { kind: 'UPSTREAM_ERROR', resultCode },
    };
  }

  // 3. Success code → the body must be well-formed, otherwise the response is invalid.
  const success = kmaCurrentObservationSuccessResponseSchema.safeParse(input);
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
