/**
 * Read a `Response` body to text under a hard byte cap, so a pathological or hostile upstream can
 * never make the provider buffer an unbounded body. Two layers of defence:
 *
 * 1. If `Content-Length` is present and well-formed and already exceeds `maxBytes`, reject before
 *    reading a single byte.
 * 2. Otherwise stream the body chunk-by-chunk, summing `byteLength`, and cancel the reader the
 *    instant the running total exceeds `maxBytes` (a lying or absent `Content-Length` cannot get
 *    past this).
 *
 * Bytes are decoded with a streaming `TextDecoder`, so a multi-byte UTF-8 sequence split across a
 * chunk boundary is reassembled correctly rather than corrupted. The raw body is never placed in
 * the error — the only failure is a bare `RESPONSE_TOO_LARGE`.
 */

export type ReadResponseTextResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: { readonly kind: 'RESPONSE_TOO_LARGE' } };

const RESPONSE_TOO_LARGE: ReadResponseTextResult = {
  ok: false,
  error: { kind: 'RESPONSE_TOO_LARGE' },
};

/** Parse a `Content-Length` header into a non-negative integer, or `null` if absent/malformed. */
function parseContentLength(header: string | null): number | null {
  if (header === null || !/^\d+$/.test(header)) {
    return null;
  }
  const value = Number(header);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Read `response`'s body to a string, failing with `RESPONSE_TOO_LARGE` if it exceeds `maxBytes`.
 *
 * A body that is exactly `maxBytes` succeeds; one byte more fails. A bodyless response (`body ===
 * null`) or a zero-byte body yields the empty string. The reader is always released — cancelled on
 * overflow, drained to completion otherwise.
 */
export async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number,
): Promise<ReadResponseTextResult> {
  const declaredLength = parseContentLength(response.headers.get('content-length'));
  if (declaredLength !== null && declaredLength > maxBytes) {
    return RESPONSE_TOO_LARGE;
  }

  const body = response.body;
  if (body === null) {
    return { ok: true, text: '' };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let total = 0;
  let text = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value === undefined) {
      continue;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return RESPONSE_TOO_LARGE;
    }
    text += decoder.decode(value, { stream: true });
  }

  // Flush any bytes the decoder buffered while waiting for the rest of a multi-byte sequence.
  text += decoder.decode();
  return { ok: true, text };
}
