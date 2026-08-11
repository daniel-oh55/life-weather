/**
 * Read a `Response` body to text under a hard byte cap, so a pathological or hostile upstream can
 * never make the AirKorea provider buffer an unbounded body.
 *
 * This is an **independent** implementation for the AirKorea provider namespace — it provides the
 * same class of safety guarantee as the KMA provider's `../kma/read-response.ts`, but is not
 * imported from it, per the project's provider-namespace isolation policy (`docs/
 * airkorea-current-air-quality-provider.md`).
 *
 * Two layers of defence:
 *
 * 1. If `Content-Length` is present, well-formed, and already exceeds `maxBytes`, the body is
 *    cancelled (best-effort, not awaited) and the read fails with `RESPONSE_TOO_LARGE` before a
 *    single byte is read.
 * 2. Otherwise the body is streamed chunk-by-chunk, summing `byteLength`; the reader is cancelled
 *    the instant the running total exceeds `maxBytes` (a lying or absent `Content-Length` cannot
 *    get past this).
 *
 * An optional `options.signal` lets the caller's shared timeout/caller-abort `AbortSignal` bound a
 * `read()` that would otherwise be left pending forever by a non-cooperative stream: the read races
 * against the signal firing, and a fired signal cancels the reader and fails with
 * `BODY_READ_ERROR` rather than hanging. Every *expected* stream failure (reader acquisition,
 * `read()`, or `cancel()`) is turned into a value, never thrown or surfaced raw: only a bare
 * `RESPONSE_TOO_LARGE` or `BODY_READ_ERROR` is ever returned. `releaseLock()` is attempted on every
 * exit path once a reader has been acquired, and any failure of the release/cancel path is
 * swallowed rather than overwriting the already-decided result.
 */

export type ReadAirKoreaResponseTextResult =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      readonly error:
        | { readonly kind: 'RESPONSE_TOO_LARGE' }
        | { readonly kind: 'BODY_READ_ERROR' };
    };

const RESPONSE_TOO_LARGE: ReadAirKoreaResponseTextResult = {
  ok: false,
  error: { kind: 'RESPONSE_TOO_LARGE' },
};

const BODY_READ_ERROR: ReadAirKoreaResponseTextResult = {
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

/** Cancel a reader, swallowing any failure — never surfaced as a raw transport error. */
async function cancelReaderSafely(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Not surfaced.
  }
}

/** Release a reader's lock, swallowing any failure — never surfaced as a raw transport error. */
function releaseReaderLockSafely(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock();
  } catch {
    // Not surfaced.
  }
}

/** Cancel a not-yet-read body (no reader acquired yet), swallowing any failure. */
async function cancelBodySafely(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (body === null) {
    return;
  }
  try {
    await body.cancel();
  } catch {
    // Not surfaced.
  }
}

/**
 * Read `response`'s body to a string, failing with `RESPONSE_TOO_LARGE` if it exceeds `maxBytes`
 * and with `BODY_READ_ERROR` if the underlying stream fails or `options.signal` fires before a
 * pending `read()` settles. Never throws for either expected failure. A body exactly `maxBytes`
 * succeeds; one byte more fails. A bodyless response (`body === null`) or a zero-byte body yields
 * the empty string.
 */
export async function readAirKoreaResponseTextWithLimit(
  response: Response,
  maxBytes: number,
  options?: { readonly signal?: AbortSignal },
): Promise<ReadAirKoreaResponseTextResult> {
  const declaredLength = parseContentLength(response.headers.get('content-length'));
  if (declaredLength !== null && declaredLength > maxBytes) {
    void cancelBodySafely(response.body);
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
    return BODY_READ_ERROR;
  }

  const signal = options?.signal;
  const decoder = new TextDecoder('utf-8');
  let total = 0;
  let text = '';

  try {
    for (;;) {
      if (signal?.aborted === true) {
        void cancelReaderSafely(reader);
        return BODY_READ_ERROR;
      }

      const pendingRead = reader.read();
      let readOutcome: { readonly done: boolean; readonly value: Uint8Array | undefined };
      if (signal !== undefined) {
        const aborted = await Promise.race([
          pendingRead.then(() => false),
          new Promise<boolean>((resolve) => {
            signal.addEventListener('abort', () => resolve(true), { once: true });
          }),
        ]);
        if (aborted) {
          void cancelReaderSafely(reader);
          return BODY_READ_ERROR;
        }
        readOutcome = await pendingRead;
      } else {
        readOutcome = await pendingRead;
      }

      if (readOutcome.done) {
        break;
      }
      if (readOutcome.value === undefined) {
        continue;
      }
      total += readOutcome.value.byteLength;
      if (total > maxBytes) {
        void cancelReaderSafely(reader);
        return RESPONSE_TOO_LARGE;
      }
      text += decoder.decode(readOutcome.value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, text };
  } catch {
    void cancelReaderSafely(reader);
    return BODY_READ_ERROR;
  } finally {
    releaseReaderLockSafely(reader);
  }
}
