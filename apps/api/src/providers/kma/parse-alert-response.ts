/**
 * Classify a raw, already-parsed KMA 기상특보 조회서비스 (`getPwnCd`) JSON value into exactly one of
 * **four** outcomes: a validated success page, the confirmed operation-specific no-data outcome, a
 * preserved upstream error, or a sanitized invalid-response report.
 *
 * This is a deliberate divergence from `parse-response.ts` / `parse-current-response.ts` (both
 * three-outcome: success vs. upstream error, where a non-`'00'` code — including `03` — always
 * becomes a generic `UPSTREAM_ERROR`). The Owner-authorized live diagnostic (2026-08-25) confirmed
 * that for `getPwnCd` specifically, `resultCode === '03'` with no `response.body` is a **valid
 * zero-match result**, not an unavailable-data error — so this parser models it as its own `NO_DATA`
 * outcome rather than folding it into `UPSTREAM_ERROR`. See `docs/kma-alert-event-provider.md` for
 * the full evidence record.
 *
 * This function never fetches, never throws, and never touches an environment variable or the
 * system clock. It takes an `unknown` (the caller is responsible for `JSON.parse`) and returns a
 * discriminated result, so control flow stays explicit at the call site.
 *
 * Decision order:
 *
 * 1. **Not even a KMA envelope** — no valid `response.header` → `INVALID_RESPONSE`.
 * 2. **Valid header, success `resultCode` (`'00'`)** → the full body is validated. A missing or
 *    malformed body under a success code is `INVALID_RESPONSE`, not a silent empty page.
 * 3. **Valid header, `resultCode === '03'`** → must additionally match the confirmed no-body shape
 *    (`kmaAlertNoDataResponseSchema`, which rejects an unexpected `body` key). A `03` response that
 *    *does* carry a body contradicts the confirmed shape and is handled conservatively —
 *    `INVALID_RESPONSE`, never silently accepted as either a success page or `NO_DATA`. Nothing is
 *    manufactured here: `totalCount`/`pageNo`/`numOfRows`/`body`/`items` are never fabricated when
 *    the upstream omitted them — a caller (the provider) that wants a synthesized empty page does
 *    so itself, using its own known fixed-pagination context.
 * 4. **Valid header, any other non-`'00'` `resultCode`** → `UPSTREAM_ERROR`, preserving only the
 *    official two-digit code (the untrusted raw `resultMsg` is dropped, matching the forecast/
 *    current-observation parsers).
 *
 * Security: identical posture to the forecast/current-observation parsers — neither the raw input
 * value nor a service key can appear in a result. An `UPSTREAM_ERROR` carries only the official
 * two-digit `resultCode`. An `INVALID_RESPONSE` carries only issue *paths* and Zod's type-level
 * messages — never the offending values, the response body, or a stack trace.
 */

import type { z } from 'zod';

import {
  kmaAlertEventSuccessResponseSchema,
  kmaAlertNoDataResponseSchema,
  KMA_ALERT_NO_DATA_RESULT_CODE,
  type KmaAlertEventItem,
} from './alert-raw-schema.js';
import { KMA_SUCCESS_RESULT_CODE, kmaResponseEnvelopeSchema } from './raw-schema.js';

/**
 * A single sanitized validation problem. Only the location (`path`) and a type-level `message` are
 * exposed; the raw input value that failed is deliberately omitted.
 */
export interface KmaAlertResponseIssue {
  /** JSON path to the offending node, e.g. `['response', 'body', 'items', 'item', 0, 'tmFc']`. */
  readonly path: readonly (string | number)[];
  /** A value-free description of the problem (Zod's message for the failed rule). */
  readonly message: string;
}

/** A validated alert-event success page: the official body fields plus the validated item array. */
export interface KmaAlertEventPage {
  readonly dataType: 'JSON';
  readonly pageNo: number;
  readonly numOfRows: number;
  readonly totalCount: number;
  readonly items: readonly KmaAlertEventItem[];
}

/**
 * Every outcome {@link parseKmaAlertEventResponse} can produce, as a flat discriminated union (not
 * nested under an `ok` boolean) — see the module doc for why `NO_DATA` is a peer of `SUCCESS_PAGE`
 * rather than folded into an error branch.
 */
export type ParseKmaAlertEventResponseResult =
  | { readonly kind: 'SUCCESS_PAGE'; readonly page: KmaAlertEventPage }
  | { readonly kind: 'NO_DATA' }
  | { readonly kind: 'UPSTREAM_ERROR'; readonly resultCode: string }
  | { readonly kind: 'INVALID_RESPONSE'; readonly issues: readonly KmaAlertResponseIssue[] };

/**
 * Convert a `ZodError` into a deterministically ordered list of sanitized issues. Identical
 * algorithm to the forecast/current-observation parsers' `toSanitizedIssues`.
 */
function toSanitizedIssues(error: z.ZodError): readonly KmaAlertResponseIssue[] {
  const issues: KmaAlertResponseIssue[] = error.issues.map((issue) => ({
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
 * Parse and classify a raw `getPwnCd` response. Pure, total, and non-throwing: any input —
 * including `null`, a primitive, or a malformed object — resolves to one of the four result
 * variants. The input is only read, never mutated.
 */
export function parseKmaAlertEventResponse(input: unknown): ParseKmaAlertEventResponseResult {
  // 1. Is this a KMA envelope at all? (header with a two-digit resultCode and a resultMsg string).
  const envelope = kmaResponseEnvelopeSchema.safeParse(input);
  if (!envelope.success) {
    return { kind: 'INVALID_RESPONSE', issues: toSanitizedIssues(envelope.error) };
  }

  const { resultCode } = envelope.data.response.header;

  // 2. Success code → the body must be well-formed, otherwise the response is invalid.
  if (resultCode === KMA_SUCCESS_RESULT_CODE) {
    const success = kmaAlertEventSuccessResponseSchema.safeParse(input);
    if (!success.success) {
      return { kind: 'INVALID_RESPONSE', issues: toSanitizedIssues(success.error) };
    }
    const { body } = success.data.response;
    return {
      kind: 'SUCCESS_PAGE',
      page: {
        dataType: body.dataType,
        pageNo: body.pageNo,
        numOfRows: body.numOfRows,
        totalCount: body.totalCount,
        items: body.items.item,
      },
    };
  }

  // 3. The operation-specific confirmed no-data code → must match the confirmed no-body shape.
  //    A `03` that contradicts that confirmed shape (e.g. carries an unexpected body) is handled
  //    conservatively as INVALID_RESPONSE, never silently accepted as NO_DATA or a success page.
  if (resultCode === KMA_ALERT_NO_DATA_RESULT_CODE) {
    const noData = kmaAlertNoDataResponseSchema.safeParse(input);
    if (!noData.success) {
      return { kind: 'INVALID_RESPONSE', issues: toSanitizedIssues(noData.error) };
    }
    return { kind: 'NO_DATA' };
  }

  // 4. Any other non-success code → a genuine upstream error. Only the official two-digit
  //    resultCode is exposed; the untrusted raw resultMsg is dropped.
  return { kind: 'UPSTREAM_ERROR', resultCode };
}
