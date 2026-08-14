/**
 * Classify a raw, already-parsed AirKorea 근접측정소 목록 조회 (`getNearbyMsrstnList`) JSON value into
 * exactly one of three outcomes: a validated success page, a preserved upstream error, or a
 * sanitized invalid-response report.
 *
 * This is the nearby-station counterpart of `parse-current-response.ts` — same decision logic and
 * security posture, against this operation's own body schema (`nearby-station-raw-schema.ts`), but
 * reusing the shared envelope schema/success code from `current-raw-schema.ts` (see that module's
 * docblock and `nearby-station-raw-schema.ts` for why that reuse is intra-namespace, not
 * cross-provider).
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
 * 3. **Success `resultCode` (`'00'`)** — the full body is validated against this operation's body
 *    schema. A missing or malformed body under a success code is `INVALID_RESPONSE`.
 *
 * Security: no error variant carries the raw input value, a service key, or a raw upstream message.
 */

import type { z } from 'zod';

import { airKoreaResponseEnvelopeSchema, AIRKOREA_SUCCESS_RESULT_CODE } from './current-raw-schema.js';
import {
  airKoreaNearbyStationSuccessResponseSchema,
  type AirKoreaNearbyStationItem,
} from './nearby-station-raw-schema.js';

/**
 * A single sanitized validation problem. Only the location (`path`) and a type-level `message` are
 * exposed; the raw input value that failed is deliberately omitted.
 */
export interface AirKoreaNearbyStationResponseIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/** A validated 근접측정소 목록 조회 success page: the official body fields plus the item array. */
export interface AirKoreaNearbyStationPage {
  readonly numOfRows: number;
  readonly pageNo: number;
  readonly totalCount: number;
  readonly items: readonly AirKoreaNearbyStationItem[];
}

/**
 * A structurally valid AirKorea header whose `resultCode` is not the success code. Only the
 * official two-digit `resultCode` is preserved; the raw `resultMsg` is **not** carried.
 */
export interface AirKoreaNearbyStationUpstreamError {
  readonly kind: 'UPSTREAM_ERROR';
  readonly resultCode: string;
}

/** A response that is not a well-formed AirKorea success/error envelope, reduced to safe issues. */
export interface AirKoreaNearbyStationInvalidResponse {
  readonly kind: 'INVALID_RESPONSE';
  readonly issues: readonly AirKoreaNearbyStationResponseIssue[];
}

export type AirKoreaNearbyStationResponseError =
  | AirKoreaNearbyStationUpstreamError
  | AirKoreaNearbyStationInvalidResponse;

export type ParseAirKoreaNearbyStationResponseResult =
  | { readonly ok: true; readonly page: AirKoreaNearbyStationPage }
  | { readonly ok: false; readonly error: AirKoreaNearbyStationResponseError };

/**
 * Convert a `ZodError` into a deterministically ordered list of sanitized issues: only `path` and
 * `message` are copied, sorted by `(path, message)` with code-unit string comparison so the output
 * is independent of Zod's internal traversal order.
 */
function toSanitizedIssues(error: z.ZodError): readonly AirKoreaNearbyStationResponseIssue[] {
  const issues: AirKoreaNearbyStationResponseIssue[] = error.issues.map((issue) => ({
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
 * Parse and classify a raw AirKorea nearby-station response. Pure, total, and non-throwing: any
 * input — including `null`, a primitive, or a malformed object — resolves to one of the three result
 * variants. The input is only read, never mutated.
 */
export function parseAirKoreaNearbyStationResponse(
  input: unknown,
): ParseAirKoreaNearbyStationResponseResult {
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
  const success = airKoreaNearbyStationSuccessResponseSchema.safeParse(input);
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
      items: body.items,
    },
  };
}
