/**
 * Minimal, dependency-free detection of a 공공데이터포털 **gateway** error body.
 *
 * When the portal's API gateway rejects a request *before* it reaches the KMA service (an
 * unregistered/over-quota/unsigned key, etc.), some responses are an XML envelope
 * (`OpenAPI_ServiceResponse` → `cmmMsgHeader` → `returnReasonCode` / `returnAuthMsg`) rather than
 * the JSON forecast body — and it may arrive under an HTTP `200`. This module recognizes that
 * wrapper structurally (no XML parser is added) and extracts *only* the numeric `returnReasonCode`.
 *
 * Evidence note: against the HTTPS host, a fake/absent key was observed to yield an HTTP `401`
 * plaintext body (`Unauthorized`) — the front gateway short-circuits before emitting the
 * `OpenAPI_ServiceResponse` XML — so the live `200`+XML gateway path could **not** be re-confirmed
 * with a fake key. The wrapper tag names below come from the PR #4 boundary doc and the portal's
 * documented gateway structure; see `docs/kma-http-provider.md`. The `401`-plaintext path is
 * handled upstream as an `HTTP_ERROR`.
 *
 * Security: the raw `returnAuthMsg` (an untrusted upstream string that could carry a secret-shaped
 * token or CR/LF) and the raw XML are **never** returned — only `isGatewayError` and, if present
 * and numeric, the `returnReasonCode` digits.
 */

/** The result of inspecting a body for the portal gateway wrapper. */
export interface KmaGatewayErrorDetection {
  /** True when the body is the 공공데이터포털 gateway XML wrapper (not the JSON forecast body). */
  readonly isGatewayError: boolean;
  /** The numeric `returnReasonCode` (e.g. `'30'`) when present and well-formed; otherwise `null`. */
  readonly reasonCode: string | null;
}

/**
 * Wrapper markers that identify the gateway envelope. Any one is sufficient — a genuine forecast
 * JSON body or arbitrary HTML contains none of them, so it is never misclassified as a gateway
 * error (the caller reports that as `NON_JSON_RESPONSE` / `INVALID_JSON` instead).
 */
const GATEWAY_MARKERS = [
  '<OpenAPI_ServiceResponse',
  '<cmmMsgHeader',
  '<returnReasonCode>',
  '<returnAuthMsg>',
] as const;

const RETURN_REASON_CODE = /<returnReasonCode>\s*([\s\S]*?)\s*<\/returnReasonCode>/;

/**
 * Detect whether `text` is a 공공데이터포털 gateway error body and, if so, extract its numeric
 * `returnReasonCode`. A malformed/absent/non-numeric reason code yields `reasonCode: null` while
 * still reporting `isGatewayError: true`. Pure and side-effect-free.
 */
export function detectKmaGatewayError(text: string): KmaGatewayErrorDetection {
  const isGatewayError = GATEWAY_MARKERS.some((marker) => text.includes(marker));
  if (!isGatewayError) {
    return { isGatewayError: false, reasonCode: null };
  }

  const match = RETURN_REASON_CODE.exec(text);
  const rawReasonCode = match === null ? null : match[1].trim();
  const reasonCode =
    rawReasonCode !== null && /^\d+$/.test(rawReasonCode) ? rawReasonCode : null;

  return { isGatewayError: true, reasonCode };
}
