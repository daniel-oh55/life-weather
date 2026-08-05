/**
 * Read a `Response` body to text under a hard byte cap, so a pathological or hostile upstream can
 * never make the provider buffer an unbounded body. Two layers of defence:
 *
 * 1. If `Content-Length` is present and well-formed and already exceeds `maxBytes`, start
 *    cancelling the body (so the connection is not left dangling) and reject before reading a
 *    single byte.
 * 2. Otherwise stream the body chunk-by-chunk, summing `byteLength`, and cancel the reader the
 *    instant the running total exceeds `maxBytes` (a lying or absent `Content-Length` cannot get
 *    past this).
 *
 * Both size-limit checks **latch `RESPONSE_TOO_LARGE` the instant the overflow is detected** and
 * return immediately — cancellation is started but never awaited, so a `cancel()` that rejects, or
 * that never settles at all, can neither delay nor displace the `RESPONSE_TOO_LARGE` result (in
 * particular, it cannot be raced out by a concurrent caller abort/timeout in the caller that passed
 * `abortNotice`).
 *
 * Bytes are decoded with a streaming `TextDecoder`, so a multi-byte UTF-8 sequence split across a
 * chunk boundary is reassembled correctly rather than corrupted.
 *
 * An optional `abortNotice` lets a caller (the KMA transport) share its timeout/caller-abort signal
 * with this function so a **pending** `reader.read()` is not left unattended: if `abortNotice`
 * settles before the current `read()` does, this function immediately starts a best-effort
 * `reader.cancel()` (not awaited) and returns, rather than waiting on a `read()` that a
 * non-cooperative stream may never settle on its own. The original pending `read()` promise is not
 * abandoned — a handler is attached so that whenever it *does* eventually settle (resolve or
 * reject, however late), the lock release is retried, since the immediate release attempted on the
 * way out may run before that read settles and therefore may not succeed on a non-standard stream.
 * Without `abortNotice`, behavior is unchanged: `read()` is simply awaited.
 *
 * Every *expected* stream failure is turned into a value, never thrown: acquiring the reader,
 * `read()`, or a flushed `cancel()` that rejects all resolve to an explicit result. The raw body,
 * a raw stream error, a raw cancel error, and a raw lock-release error are never placed in the
 * result — the only failures are a bare `RESPONSE_TOO_LARGE` or a bare `BODY_READ_ERROR`. A
 * cancellation failure never overwrites a `RESPONSE_TOO_LARGE` outcome.
 *
 * Once a reader is acquired, `releaseLock()` is always *attempted* on the way out — a `cancel()` or a
 * fully-drained stream does not release the lock on its own — so on a standard Node Web Stream the
 * body ends up unlocked. If `releaseLock()` itself throws, that failure is swallowed (the decided
 * result is preserved and no raw error leaks). Calling `releaseLock()` (or `cancel()`) more than
 * once on the same reader is safe by construction — both helpers swallow every failure — which is
 * what makes the immediate attempt plus a later retry on late settlement safe to combine.
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
 * Cancel a reader, swallowing any failure. Cancelling signals the underlying source to discard the
 * rest of the body; it does **not** by itself release the reader's lock (that is done separately via
 * {@link releaseReaderLockSafely}). A cancel that rejects is an internal transport detail and must
 * never be surfaced as a raw error (nor may it overwrite the `RESPONSE_TOO_LARGE` outcome that
 * triggered the cancel).
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
 * Release a reader's lock, swallowing any failure. Under the Web Streams contract neither a
 * `cancel()` nor draining the stream to completion releases the lock on its own — an explicit
 * `releaseLock()` is required so the body ends up unlocked. Called on every path that successfully
 * acquired a reader. A release failure is an internal transport detail: it is never surfaced as a
 * raw error and must not overwrite the result already decided by the read.
 */
function releaseReaderLockSafely(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): void {
  try {
    reader.releaseLock();
  } catch {
    // A lock that cannot be released is not surfaced as a raw transport error.
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
 * Resolve `true` the instant `abortNotice` settles, or `false` once `pendingRead` settles first —
 * whichever happens first. Never rejects: `pendingRead`'s own success/failure is not decided here
 * (a rejection is folded into `false`, same as a resolution) — the caller re-awaits `pendingRead`
 * itself once this resolves `false` to get the real `{ done, value }` or the real rejection.
 * Attaching `.then(onFulfilled, onRejected)` directly to `pendingRead` here (rather than to some
 * derived promise) is what guarantees `pendingRead` always ends up with a rejection handler, so a
 * stream failure can never surface as an unhandled rejection regardless of which side of the race
 * wins.
 */
function isAbortNoticeFirst(
  pendingRead: Promise<ReadableStreamReadResult<Uint8Array>>,
  abortNotice: Promise<void>,
): Promise<boolean> {
  return Promise.race([
    pendingRead.then(
      () => false,
      () => false,
    ),
    abortNotice.then(() => true),
  ]);
}

/**
 * Read `response`'s body to a string, failing with `RESPONSE_TOO_LARGE` if it exceeds `maxBytes`
 * and with `BODY_READ_ERROR` if the underlying stream fails (reader acquisition or `read()` throws
 * or rejects) or if `options.abortNotice` settles before a pending `read()` does. Never throws for
 * any of those expected failures.
 *
 * A body that is exactly `maxBytes` succeeds; one byte more fails. A bodyless response (`body ===
 * null`) or a zero-byte body yields the empty string. Once a reader is acquired, an explicit
 * `releaseLock()` is *attempted* on **every** exit path — normal completion, overflow, a read error,
 * an `abortNotice` win, or a cancel error — in `finally` (a `cancel()` or a drained stream does not
 * release the lock on its own), so on a standard Node Web Stream `response.body.locked` ends up
 * `false`. A `releaseLock()` failure never overwrites the outcome the read already decided and is
 * never surfaced as a raw error. When `abortNotice` wins while a `read()` is still outstanding, the
 * immediate `finally` release may run before that `read()` actually settles (on a non-standard
 * stream); a second `releaseLock()` attempt is then retried once the pending `read()` does settle,
 * however late — repeated release attempts on the same reader are safe by construction.
 */
export async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number,
  options?: { readonly abortNotice?: Promise<void> },
): Promise<ReadResponseTextResult> {
  const declaredLength = parseContentLength(response.headers.get('content-length'));
  if (declaredLength !== null && declaredLength > maxBytes) {
    // Latch RESPONSE_TOO_LARGE immediately; cancellation is best-effort and started but never
    // awaited, so a hanging or rejecting cancel() can never delay or displace this outcome.
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
    // A body whose reader cannot be acquired is an internal transport error, never surfaced raw.
    return BODY_READ_ERROR;
  }

  const abortNotice = options?.abortNotice;
  const decoder = new TextDecoder('utf-8');
  let total = 0;
  let text = '';

  try {
    for (;;) {
      const pendingRead = reader.read();
      if (abortNotice !== undefined && (await isAbortNoticeFirst(pendingRead, abortNotice))) {
        // The abort notice fired while this read() was still outstanding. A non-cooperative
        // stream may never settle it on its own: start best-effort cancellation now (not awaited)
        // and attach a handler to the original pending read so that, whenever it does eventually
        // settle, the lock release is retried rather than the reader being left dangling.
        void cancelReaderSafely(reader);
        pendingRead.then(
          () => releaseReaderLockSafely(reader),
          () => releaseReaderLockSafely(reader),
        );
        return BODY_READ_ERROR;
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
        // Latch RESPONSE_TOO_LARGE immediately; cancellation is best-effort and started but never
        // awaited, so a hanging or rejecting cancel() (or a concurrent abort/timeout in a caller
        // racing this promise) can never delay or displace this outcome.
        void cancelReaderSafely(reader);
        return RESPONSE_TOO_LARGE;
      }
      text += decoder.decode(value, { stream: true });
    }
    // Flush any bytes the decoder buffered while waiting for the rest of a multi-byte sequence.
    text += decoder.decode();
    return { ok: true, text };
  } catch {
    // read() threw/rejected (a stream failure, or an abort propagated into the body): cancel the
    // body and report a bare BODY_READ_ERROR. The raw stream error is never surfaced.
    void cancelReaderSafely(reader);
    return BODY_READ_ERROR;
  } finally {
    // A cancel() or a drained stream does not release the reader's lock; attempt it explicitly on
    // every exit path (success, overflow, read error, abort-notice win, cancel error) so the body
    // ends up unlocked. This runs before the early returns above resolve, and a release failure
    // never changes the outcome. See the abort-notice branch above for the late-settlement retry.
    releaseReaderLockSafely(reader);
  }
}
