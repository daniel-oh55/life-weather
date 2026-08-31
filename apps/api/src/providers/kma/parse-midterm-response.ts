/**
 * Classify a raw, already-parsed KMA 중기예보 조회서비스 (`MidFcstInfoService`) JSON value into
 * exactly one of three outcomes: a validated success page, a preserved upstream error, or a
 * sanitized invalid-response report.
 *
 * This mirrors `parse-response.ts` / `parse-current-response.ts` exactly — **three** outcomes, not
 * the alert boundary's four. That is deliberate: the alert parser's dedicated `NO_DATA` branch
 * exists only because an Owner-authorized live diagnostic *confirmed* that `getPwnCd`'s `03`
 * carries no body and means "zero matches". No official documentation establishes an equivalent
 * dedicated no-data code for `getMidTa`/`getMidLandFcst`, and no live call is authorized in this
 * PR, so every non-success `resultCode` — `03` included — goes through the normal sanitized
 * upstream-error boundary rather than being *guessed* to mean no-data. A genuine success with
 * `totalCount === 0` is a valid empty page and never fabricates an item.
 *
 * The two operations are parsed by two separate entry points ({@link parseKmaMidtermTemperatureResponse}
 * / {@link parseKmaMidtermLandResponse}) against two separate body schemas, so a `getMidTa` payload
 * can never satisfy the `getMidLandFcst` contract or vice versa.
 *
 * These functions never fetch, never throw, and never touch an environment variable or the system
 * clock. They take an `unknown` (the caller is responsible for `JSON.parse`) and return a
 * discriminated result, so control flow stays explicit at the call site.
 *
 * Decision order (identical for both operations):
 *
 * 1. **Not even a KMA envelope** — no valid `response.header` (a two-digit `resultCode` and a
 *    `resultMsg` string) → `INVALID_RESPONSE`. A structurally malformed `resultCode` fails here and
 *    is an invalid response, *not* mistaken for a genuine upstream error.
 * 2. **Valid header, non-success `resultCode`** → `UPSTREAM_ERROR`, preserving only the official
 *    two-digit `resultCode`, even when the error response carries no usable body.
 * 3. **Success `resultCode` (`'00'`)** → the operation's full body is validated. A missing or
 *    malformed body under a success code is an `INVALID_RESPONSE`, not a silent empty page.
 *
 * Security: identical posture to the other three KMA parsers. An `UPSTREAM_ERROR` carries only the
 * official two-digit `resultCode` — the untrusted raw `resultMsg` is deliberately dropped, so a
 * secret-shaped token, CR/LF, or log-injection payload in an upstream message can never reach this
 * surface. An `INVALID_RESPONSE` carries only issue *paths* and Zod's type-level messages — never
 * the offending values, the response body, or a stack trace. (A service key lives in the request
 * URL, never the response, so it is structurally impossible for one to reach these results.)
 */

import type { z } from 'zod';

import {
  kmaMidtermLandSuccessResponseSchema,
  kmaMidtermTemperatureSuccessResponseSchema,
  type KmaMidtermLandItem,
  type KmaMidtermTemperatureItem,
} from './midterm-raw-schema.js';
import { KMA_SUCCESS_RESULT_CODE, kmaResponseEnvelopeSchema } from './raw-schema.js';

/**
 * A single sanitized validation problem. Only the location (`path`) and a type-level `message` are
 * exposed; the raw input value that failed is deliberately omitted so no untrusted payload (or
 * anything resembling a secret) leaks through the error surface.
 */
export interface KmaMidtermResponseIssue {
  /** JSON path to the offending node, e.g. `['response', 'body', 'items', 'item', 0, 'taMin4']`. */
  readonly path: readonly (string | number)[];
  /** A value-free description of the problem (Zod's message for the failed rule). */
  readonly message: string;
}

/** The official body fields shared by both mid-term success pages, minus the item list. */
interface KmaMidtermPageBase {
  readonly dataType: 'JSON';
  readonly pageNo: number;
  readonly numOfRows: number;
  readonly totalCount: number;
}

/** A validated 중기기온조회 success page. */
export interface KmaMidtermTemperaturePage extends KmaMidtermPageBase {
  readonly items: readonly KmaMidtermTemperatureItem[];
}

/** A validated 중기육상예보조회 success page. */
export interface KmaMidtermLandPage extends KmaMidtermPageBase {
  readonly items: readonly KmaMidtermLandItem[];
}

/**
 * A structurally valid KMA header whose `resultCode` is not the success code. Only the official
 * two-digit `resultCode` is preserved so the caller can map it; the raw `resultMsg` is **not**
 * carried (see the module doc's security note and `parse-response.ts` for the full rationale).
 */
export interface KmaMidtermUpstreamError {
  readonly kind: 'UPSTREAM_ERROR';
  readonly resultCode: string;
}

/** A response that is not a well-formed KMA success/error envelope, reduced to safe issues. */
export interface KmaMidtermInvalidResponse {
  readonly kind: 'INVALID_RESPONSE';
  readonly issues: readonly KmaMidtermResponseIssue[];
}

export type KmaMidtermResponseError = KmaMidtermUpstreamError | KmaMidtermInvalidResponse;

export type ParseKmaMidtermTemperatureResponseResult =
  | { readonly ok: true; readonly page: KmaMidtermTemperaturePage }
  | { readonly ok: false; readonly error: KmaMidtermResponseError };

export type ParseKmaMidtermLandResponseResult =
  | { readonly ok: true; readonly page: KmaMidtermLandPage }
  | { readonly ok: false; readonly error: KmaMidtermResponseError };

/**
 * Convert a `ZodError` into a deterministically ordered list of sanitized issues. Only `path` and
 * `message` are copied — never `input`, `code` internals, or the raw value. Identical algorithm to
 * the forecast/current-observation/alert parsers' `toSanitizedIssues`.
 */
function toSanitizedIssues(error: z.ZodError): readonly KmaMidtermResponseIssue[] {
  const issues: KmaMidtermResponseIssue[] = error.issues.map((issue) => ({
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
 * Steps 1–2 of the decision order, shared by both operations: reject anything that is not a KMA
 * envelope, and turn a valid header with a non-success code into an `UPSTREAM_ERROR`. Returns
 * `null` when the response carries a valid success header, i.e. when the caller should proceed to
 * validate its operation-specific body.
 */
function classifyMidtermEnvelope(input: unknown): KmaMidtermResponseError | null {
  const envelope = kmaResponseEnvelopeSchema.safeParse(input);
  if (!envelope.success) {
    return { kind: 'INVALID_RESPONSE', issues: toSanitizedIssues(envelope.error) };
  }

  const { resultCode } = envelope.data.response.header;
  if (resultCode !== KMA_SUCCESS_RESULT_CODE) {
    // Includes `03`: no official documentation establishes a dedicated no-data code for these
    // operations, so it is *not* guessed to be a valid empty result (see the module doc).
    return { kind: 'UPSTREAM_ERROR', resultCode };
  }

  return null;
}

/**
 * Parse and classify a raw 중기기온조회 (`getMidTa`) response. Pure, total, and non-throwing: any
 * input — including `null`, a primitive, or a malformed object — resolves to one of the three
 * result variants. The input is only read, never mutated. A 중기육상예보조회 payload does not
 * satisfy the temperature body schema and is reported as `INVALID_RESPONSE`.
 */
export function parseKmaMidtermTemperatureResponse(
  input: unknown,
): ParseKmaMidtermTemperatureResponseResult {
  const envelopeError = classifyMidtermEnvelope(input);
  if (envelopeError !== null) {
    return { ok: false, error: envelopeError };
  }

  const success = kmaMidtermTemperatureSuccessResponseSchema.safeParse(input);
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

/**
 * Parse and classify a raw 중기육상예보조회 (`getMidLandFcst`) response. Same totality, purity, and
 * security posture as {@link parseKmaMidtermTemperatureResponse}. A 중기기온조회 payload does not
 * satisfy the land body schema and is reported as `INVALID_RESPONSE`.
 */
export function parseKmaMidtermLandResponse(input: unknown): ParseKmaMidtermLandResponseResult {
  const envelopeError = classifyMidtermEnvelope(input);
  if (envelopeError !== null) {
    return { ok: false, error: envelopeError };
  }

  const success = kmaMidtermLandSuccessResponseSchema.safeParse(input);
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
