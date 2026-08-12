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
 * Both size-limit checks **latch `RESPONSE_TOO_LARGE` the instant the overflow is detected** and
 * return immediately — cancellation is started but never awaited, so a `cancel()` that rejects, or
 * that never settles at all, can neither delay nor displace the `RESPONSE_TOO_LARGE` result.
 *
 * An optional `options.signal` lets the caller's shared timeout/caller-abort `AbortSignal` bound a
 * `read()` that would otherwise be left pending forever by a non-cooperative stream. Exactly **one**
 * `abort` listener is attached to `signal` for the *entire reader lifecycle* — never one per chunk,
 * so the abort reaction graph cannot grow in proportion to the number of chunks read. A single
 * mutable `wakeCurrentRead` wakes whichever `read()` is currently outstanding (if any); when `signal`
 * fires between reads (nothing outstanding to wake), the next loop iteration's `signal.aborted` check
 * catches it instead. Either way, this function immediately starts a best-effort `reader.cancel()`
 * (not awaited) and returns `BODY_READ_ERROR` promptly, rather than waiting on a `read()` that a
 * non-cooperative stream may never settle on its own. The original pending `read()` promise is not
 * abandoned — a handler is attached so that whenever it *does* eventually settle (resolve or reject,
 * however late), the lock release is retried, since the immediate release attempted on the way out
 * may run before that read settles and therefore may not succeed on a non-standard stream. A late
 * rejection is handled (never an unhandled rejection). The listener is removed on every exit path.
 * Without `options.signal`, behavior is unchanged: `read()` is simply awaited.
 *
 * Every *expected* stream failure (reader acquisition, `read()`, or `cancel()`) is turned into a
 * value, never thrown or surfaced raw: only a bare `RESPONSE_TOO_LARGE` or `BODY_READ_ERROR` is ever
 * returned. `releaseLock()` is attempted on every exit path once a reader has been acquired, and any
 * failure of the release/cancel path is swallowed rather than overwriting the already-decided
 * result. Calling `releaseLock()` (or `cancel()`) more than once on the same reader is safe by
 * construction, which is what makes the immediate attempt plus a later retry on late settlement safe
 * to combine.
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

/**
 * Cancel a reader, swallowing any failure — never surfaced as a raw transport error, and never
 * allowed to overwrite an outcome already decided by the caller.
 */
async function cancelReaderSafely(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Not surfaced.
  }
}

/**
 * Release a reader's lock, swallowing any failure. Safe to call more than once on the same reader —
 * this is what makes an immediate attempt plus a later retry-on-late-settlement combination safe.
 */
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
 *
 * Once a reader is acquired, `releaseLock()` is *attempted* on every exit path in `finally`. When
 * `signal` fires while a `read()` is still outstanding, that immediate `finally` release may run
 * before the pending `read()` actually settles (on a non-cooperative stream); a second
 * `releaseLock()` attempt is then retried once the pending `read()` does settle, however late.
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

  // Exactly one `abort` subscription for the whole reader lifecycle (not one per chunk).
  // `wakeCurrentRead` wakes whichever `reader.read()` is currently outstanding; it is `null`
  // between reads, so a signal that fires between chunks has nothing to wake and is instead caught
  // by the `signal.aborted` check at the top of the next loop iteration.
  let wakeCurrentRead: (() => void) | null = null;
  const onAbort = (): void => {
    wakeCurrentRead?.();
  };
  if (signal !== undefined) {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    for (;;) {
      if (signal?.aborted === true) {
        // The signal was already fired (or fired between reads, with no pending read to wake).
        void cancelReaderSafely(reader);
        return BODY_READ_ERROR;
      }

      const pendingRead = reader.read();
      if (signal !== undefined) {
        const aborted = await new Promise<boolean>((resolve) => {
          wakeCurrentRead = () => resolve(true);
          pendingRead.then(
            () => resolve(false),
            () => resolve(false),
          );
        });
        wakeCurrentRead = null;
        if (aborted) {
          // The signal fired while this read() was still outstanding. A non-cooperative stream
          // may never settle it on its own: start best-effort cancellation now (not awaited) and
          // attach a handler to the original pending read so that, whenever it does eventually
          // settle (resolve or reject, however late), the lock release is retried rather than the
          // reader being left dangling. Attaching both handlers here also guarantees the pending
          // read's rejection is observed, so it never becomes an unhandled rejection.
          void cancelReaderSafely(reader);
          pendingRead.then(
            () => releaseReaderLockSafely(reader),
            () => releaseReaderLockSafely(reader),
          );
          return BODY_READ_ERROR;
        }
      }

      const { done, value } = await pendingRead;
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        void cancelReaderSafely(reader);
        return RESPONSE_TOO_LARGE;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, text };
  } catch {
    void cancelReaderSafely(reader);
    return BODY_READ_ERROR;
  } finally {
    releaseReaderLockSafely(reader);
    if (signal !== undefined) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}
