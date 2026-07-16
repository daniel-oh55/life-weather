/**
 * Read a `Response` body to text under a hard byte cap, so a pathological or hostile upstream can
 * never make the provider buffer an unbounded body. Two layers of defence:
 *
 * 1. If `Content-Length` is present and well-formed and already exceeds `maxBytes`, cancel the body
 *    (so the connection is not left dangling) and reject before reading a single byte.
 * 2. Otherwise stream the body chunk-by-chunk, summing `byteLength`, and cancel the reader the
 *    instant the running total exceeds `maxBytes` (a lying or absent `Content-Length` cannot get
 *    past this).
 *
 * Bytes are decoded with a streaming `TextDecoder`, so a multi-byte UTF-8 sequence split across a
 * chunk boundary is reassembled correctly rather than corrupted.
 *
 * Every *expected* stream failure is turned into a value, never thrown: acquiring the reader,
 * `read()`, or a flushed `cancel()` that rejects all resolve to an explicit result. The raw body,
 * a raw stream error, and a raw cancel error are never placed in the result — the only failures are
 * a bare `RESPONSE_TOO_LARGE` or a bare `BODY_READ_ERROR`. A cancellation failure never overwrites
 * a `RESPONSE_TOO_LARGE` outcome.
 */

export type ReadResponseTextResult =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      readonly error:
        | { readonly kind: 'RESPONSE_TOO_LARGE' }
        | { readonly kind: 'BODY_READ_ERROR' };
    };

const RESPONSE_TOO_LARGE: ReadResponseTextResult = {
  ok: false,
  error: { kind: 'RESPONSE_TOO_LARGE' },
};

const BODY_READ_ERROR: ReadResponseTextResult = {
  ok: false,
  error: { kind: 'BODY_READ_ERROR' },
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
 * Cancel a reader, swallowing any failure. Cancelling releases the reader's lock; a cancel that
 * rejects is an internal transport detail and must never be surfaced as a raw error (nor may it
 * overwrite the `RESPONSE_TOO_LARGE` outcome that triggered the cancel).
 */
async function cancelReaderSafely(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // A body that cannot be cancelled is not surfaced as a raw transport error.
  }
}

/**
 * Cancel a not-yet-read body, swallowing any failure. Used by the `Content-Length` pre-check, which
 * has not acquired a reader, so it cancels the stream directly. A `null` body is a no-op.
 */
async function cancelBodySafely(
  body: ReadableStream<Uint8Array> | null,
): Promise<void> {
  if (body === null) {
    return;
  }
  try {
    await body.cancel();
  } catch {
    // A body that cannot be cancelled is not surfaced as a raw transport error.
  }
}

/**
 * Read `response`'s body to a string, failing with `RESPONSE_TOO_LARGE` if it exceeds `maxBytes`
 * and with `BODY_READ_ERROR` if the underlying stream fails (reader acquisition or `read()` throws
 * or rejects). Never throws for either of those expected stream failures.
 *
 * A body that is exactly `maxBytes` succeeds; one byte more fails. A bodyless response (`body ===
 * null`) or a zero-byte body yields the empty string. The reader lock is released on every failing
 * path via `cancel()`; on normal completion the fully-drained reader falls out of scope.
 */
export async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number,
): Promise<ReadResponseTextResult> {
  const declaredLength = parseContentLength(response.headers.get('content-length'));
  if (declaredLength !== null && declaredLength > maxBytes) {
    // Cancel the body without reading a byte; a cancel failure never changes the outcome.
    await cancelBodySafely(response.body);
    return RESPONSE_TOO_LARGE;
  }

  const body = response.body;
  if (body === null) {
    return { ok: true, text: '' };
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = body.getReader();
  } catch {
    // A body whose reader cannot be acquired is an internal transport error, never surfaced raw.
    return BODY_READ_ERROR;
  }

  const decoder = new TextDecoder('utf-8');
  let total = 0;
  let text = '';

  try {
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
        await cancelReaderSafely(reader);
        return RESPONSE_TOO_LARGE;
      }
      text += decoder.decode(value, { stream: true });
    }
    // Flush any bytes the decoder buffered while waiting for the rest of a multi-byte sequence.
    text += decoder.decode();
    return { ok: true, text };
  } catch {
    // read() threw/rejected (a stream failure, or an abort propagated into the body): cancel to
    // release the lock and report a bare BODY_READ_ERROR. The raw stream error is never surfaced.
    await cancelReaderSafely(reader);
    return BODY_READ_ERROR;
  }
}
