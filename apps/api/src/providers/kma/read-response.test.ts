import { describe, expect, it, vi } from 'vitest';

import { readResponseTextWithLimit } from './read-response.js';

const encoder = new TextEncoder();

/** A `ReadableStream` that emits the given byte chunks, tracking whether it was cancelled. */
function streamOf(
  chunks: readonly Uint8Array[],
): { stream: ReadableStream<Uint8Array>; wasCancelled: () => boolean } {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, wasCancelled: () => cancelled };
}

/** A response whose body is a stream and whose `Content-Length` header can be set explicitly. */
function streamResponse(
  chunks: readonly Uint8Array[],
  contentLength?: string,
): { response: Response; wasCancelled: () => boolean } {
  const { stream, wasCancelled } = streamOf(chunks);
  const headers = contentLength === undefined ? undefined : { 'content-length': contentLength };
  return { response: new Response(stream, { headers }), wasCancelled };
}

/**
 * A response whose body is an *open* (never-closing) stream that yields `chunk` on every pull, so
 * that a reader cancellation genuinely invokes the underlying `cancel()` (a pre-closed stream would
 * already be drained, making `cancel()` a no-op). Tracks pulls (how often our reader asked for a
 * chunk) and whether the stream was cancelled.
 */
function openStreamResponse(
  chunk: Uint8Array,
  options: { contentLength?: string; cancelError?: unknown } = {},
): { response: Response; wasCancelled: () => boolean; pullCount: () => number } {
  let cancelled = false;
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
      if (options.cancelError !== undefined) {
        throw options.cancelError;
      }
    },
  });
  const headers =
    options.contentLength === undefined ? undefined : { 'content-length': options.contentLength };
  return {
    response: new Response(stream, { headers }),
    wasCancelled: () => cancelled,
    pullCount: () => pulls,
  };
}

/** A response whose body stream errors — at construction or after `afterChunks` chunks. */
function erroringStreamResponse(
  error: unknown,
  afterChunks = 0,
): { response: Response } {
  const encoder = new TextEncoder();
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (afterChunks === 0) {
        controller.error(error);
      }
    },
    pull(controller) {
      if (pulls < afterChunks) {
        pulls += 1;
        controller.enqueue(encoder.encode('x'));
        return;
      }
      controller.error(error);
    },
  });
  return { response: new Response(stream) };
}

/** A small delay, letting pending microtasks/timers settle before an assertion. */
function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A minimal deferred promise for controlling exact settlement timing in a test. */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

/**
 * Run `run`, then give any late microtask/timer-driven settlement a moment to surface before
 * asserting it never became a process-level `unhandledRejection`.
 */
async function assertNoUnhandledRejection(run: () => Promise<void>): Promise<void> {
  const captured: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    captured.push(reason);
  };
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    await run();
    await tick(20);
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
  }
  expect(captured).toEqual([]);
}

/**
 * A response whose body stream never enqueues/closes on its own (so a pending `read()` stays
 * pending forever unless cancelled), with a fully controllable `cancel()` outcome.
 */
function neverEnqueuingResponse(
  onCancel?: () => Promise<void> | void,
): { response: Response; cancelCalls: () => number } {
  let cancelCalls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull() {
      // Intentionally never enqueue/close/error.
    },
    cancel() {
      cancelCalls += 1;
      return onCancel?.();
    },
  });
  return { response: new Response(stream), cancelCalls: () => cancelCalls };
}

/**
 * A response whose body always has another chunk available on `pull` (so the streaming size limit
 * trips quickly), with a fully controllable `cancel()` outcome — same shape as
 * {@link neverEnqueuingResponse}.
 */
function alwaysProducingResponse(
  chunk: Uint8Array,
  onCancel?: () => Promise<void> | void,
): { response: Response; cancelCalls: () => number } {
  let cancelCalls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(chunk);
    },
    cancel() {
      cancelCalls += 1;
      return onCancel?.();
    },
  });
  return { response: new Response(stream), cancelCalls: () => cancelCalls };
}

/**
 * A fake `Response` backed by a hand-rolled reader (not a real `ReadableStream`) whose `read()`,
 * `cancel()`, and `releaseLock()` are each independently controllable. A real spec-compliant stream
 * settles a pending `read()` as soon as `cancel()` is invoked (`ReadableStreamClose` runs as part of
 * cancellation, ahead of the underlying source's own cancel algorithm settling), which makes it
 * impossible to observe a `read()` that is *still* pending some time after `cancel()` was called
 * using a real stream. This fake exists solely to exercise that genuinely non-cooperative scenario,
 * so the late-settlement retry-release path can be verified directly.
 */
function controllableReaderResponse(): {
  response: Response;
  resolveRead: (result: ReadableStreamReadResult<Uint8Array>) => void;
  rejectRead: (reason: unknown) => void;
  cancelCalls: () => number;
  releaseLockCalls: () => number;
} {
  const read = deferred<ReadableStreamReadResult<Uint8Array>>();
  let cancelCalls = 0;
  let releaseLockCalls = 0;
  const reader = {
    read: () => read.promise,
    cancel: () => {
      cancelCalls += 1;
      return Promise.resolve();
    },
    releaseLock: () => {
      releaseLockCalls += 1;
    },
  };
  const response = {
    headers: new Headers(),
    body: {
      getReader: () => reader,
    },
  } as unknown as Response;
  return {
    response,
    resolveRead: read.resolve,
    rejectRead: read.reject,
    cancelCalls: () => cancelCalls,
    releaseLockCalls: () => releaseLockCalls,
  };
}

describe('readResponseTextWithLimit — Content-Length gate', () => {
  it('cancels the body without reading a byte when Content-Length exceeds max', async () => {
    const { response, wasCancelled, pullCount } = openStreamResponse(encoder.encode('x'), {
      contentLength: '100',
    });
    const result = await readResponseTextWithLimit(response, 10);
    expect(result).toEqual({ ok: false, error: { kind: 'RESPONSE_TOO_LARGE' } });
    // Rejected on the header alone: the stream was never pulled, and the body was cancelled.
    expect(pullCount()).toBe(0);
    expect(wasCancelled()).toBe(true);
  });

  it('still returns RESPONSE_TOO_LARGE when the pre-read body cancel throws', async () => {
    const marker = 'SECRET_PRECHECK_CANCEL_MARKER';
    const { response, wasCancelled } = openStreamResponse(encoder.encode('x'), {
      contentLength: '100',
      cancelError: new Error(marker),
    });
    const result = await readResponseTextWithLimit(response, 10);
    expect(result).toEqual({ ok: false, error: { kind: 'RESPONSE_TOO_LARGE' } });
    expect(wasCancelled()).toBe(true);
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it('ignores a malformed Content-Length and streams instead', async () => {
    const { response } = streamResponse([encoder.encode('abc')], 'not-a-number');
    const result = await readResponseTextWithLimit(response, 10);
    expect(result).toEqual({ ok: true, text: 'abc' });
  });
});

describe('readResponseTextWithLimit — body stream failures', () => {
  it('maps a stream that errors before the first chunk to BODY_READ_ERROR', async () => {
    const marker = 'SECRET_STREAM_ERROR_MARKER';
    const { response } = erroringStreamResponse(new Error(marker));
    const result = await readResponseTextWithLimit(response, 1024);
    expect(result).toEqual({ ok: false, error: { kind: 'BODY_READ_ERROR' } });
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it('maps a stream that errors mid-read to BODY_READ_ERROR', async () => {
    const marker = 'SECRET_MID_STREAM_MARKER';
    const { response } = erroringStreamResponse(new Error(marker), 2);
    const result = await readResponseTextWithLimit(response, 1024);
    expect(result).toEqual({ ok: false, error: { kind: 'BODY_READ_ERROR' } });
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it('maps a getReader() failure to BODY_READ_ERROR (never throws)', async () => {
    const marker = 'SECRET_GET_READER_MARKER';
    const fakeResponse = {
      headers: new Headers(),
      body: {
        getReader() {
          throw new Error(marker);
        },
      },
    } as unknown as Response;
    let result: Awaited<ReturnType<typeof readResponseTextWithLimit>>;
    await expect(
      (async () => {
        result = await readResponseTextWithLimit(fakeResponse, 1024);
      })(),
    ).resolves.toBeUndefined();
    expect(result!).toEqual({ ok: false, error: { kind: 'BODY_READ_ERROR' } });
    expect(JSON.stringify(result!)).not.toContain(marker);
  });

  it('does not reject its promise on a stream error', async () => {
    const { response } = erroringStreamResponse(new Error('boom'));
    await expect(readResponseTextWithLimit(response, 1024)).resolves.toEqual({
      ok: false,
      error: { kind: 'BODY_READ_ERROR' },
    });
  });
});

describe('readResponseTextWithLimit — streaming size limit', () => {
  it('rejects and cancels the reader when the running total exceeds max', async () => {
    const { response, wasCancelled } = openStreamResponse(encoder.encode('12345'));
    const result = await readResponseTextWithLimit(response, 7);
    expect(result.ok).toBe(false);
    expect(wasCancelled()).toBe(true);
  });

  it('keeps RESPONSE_TOO_LARGE even when the overflow cancel throws', async () => {
    const marker = 'SECRET_OVERFLOW_CANCEL_MARKER';
    const { response, wasCancelled } = openStreamResponse(encoder.encode('12345'), {
      cancelError: new Error(marker),
    });
    const result = await readResponseTextWithLimit(response, 7);
    // A cancellation failure must not overwrite the RESPONSE_TOO_LARGE outcome, nor leak.
    expect(result).toEqual({ ok: false, error: { kind: 'RESPONSE_TOO_LARGE' } });
    expect(wasCancelled()).toBe(true);
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it('accepts a body of exactly max bytes', async () => {
    const { response } = streamResponse([encoder.encode('abcde')]);
    const result = await readResponseTextWithLimit(response, 5);
    expect(result).toEqual({ ok: true, text: 'abcde' });
  });

  it('accepts a body one byte under max', async () => {
    const { response } = streamResponse([encoder.encode('abcd')]);
    const result = await readResponseTextWithLimit(response, 5);
    expect(result).toEqual({ ok: true, text: 'abcd' });
  });

  it('does not expose the raw body in the error', async () => {
    const secret = 'SUPER_SECRET_BODY_MARKER';
    const { response } = streamResponse([encoder.encode(secret.repeat(10))]);
    const result = await readResponseTextWithLimit(response, 4);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe('readResponseTextWithLimit — reader lock release', () => {
  it('unlocks the body after a normal, fully-drained read', async () => {
    const { response } = streamResponse([encoder.encode('abc')]);
    const result = await readResponseTextWithLimit(response, 1024);
    expect(result).toEqual({ ok: true, text: 'abc' });
    expect(response.body?.locked).toBe(false);
  });

  it('unlocks the body after reading exactly max bytes', async () => {
    const { response } = streamResponse([encoder.encode('abcde')]);
    const result = await readResponseTextWithLimit(response, 5);
    expect(result).toEqual({ ok: true, text: 'abcde' });
    expect(response.body?.locked).toBe(false);
  });

  it('unlocks the body after an overflow', async () => {
    const { response, wasCancelled } = openStreamResponse(encoder.encode('12345'));
    const result = await readResponseTextWithLimit(response, 7);
    expect(result).toEqual({ ok: false, error: { kind: 'RESPONSE_TOO_LARGE' } });
    expect(wasCancelled()).toBe(true);
    expect(response.body?.locked).toBe(false);
  });

  it('unlocks the body after a first-read error', async () => {
    const marker = 'SECRET_FIRST_READ_LOCK_MARKER';
    const { response } = erroringStreamResponse(new Error(marker));
    const result = await readResponseTextWithLimit(response, 1024);
    expect(result).toEqual({ ok: false, error: { kind: 'BODY_READ_ERROR' } });
    expect(response.body?.locked).toBe(false);
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it('unlocks the body after a mid-read error', async () => {
    const { response } = erroringStreamResponse(new Error('mid-read boom'), 2);
    const result = await readResponseTextWithLimit(response, 1024);
    expect(result).toEqual({ ok: false, error: { kind: 'BODY_READ_ERROR' } });
    expect(response.body?.locked).toBe(false);
  });

  it('preserves the result and unlocks the body when the cancel throws on overflow', async () => {
    const marker = 'SECRET_CANCEL_LOCK_MARKER';
    const { response, wasCancelled } = openStreamResponse(encoder.encode('12345'), {
      cancelError: new Error(marker),
    });
    // The promise resolves (never rejects) despite the cancel throwing.
    const result = await readResponseTextWithLimit(response, 7);
    expect(result).toEqual({ ok: false, error: { kind: 'RESPONSE_TOO_LARGE' } });
    expect(wasCancelled()).toBe(true);
    // A cancel failure does not overwrite the outcome, does not leak, and still releases the lock.
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(response.body?.locked).toBe(false);
  });
});

describe('readResponseTextWithLimit — UTF-8 & empty bodies', () => {
  it('reassembles a multi-byte character split across chunk boundaries', async () => {
    const euro = encoder.encode('€'); // 3 bytes: E2 82 AC
    const { response } = streamResponse([euro.slice(0, 1), euro.slice(1, 2), euro.slice(2)]);
    const result = await readResponseTextWithLimit(response, 1024);
    expect(result).toEqual({ ok: true, text: '€' });
  });

  it('returns an empty string for a zero-byte streamed body', async () => {
    const { response } = streamResponse([]);
    const result = await readResponseTextWithLimit(response, 1024);
    expect(result).toEqual({ ok: true, text: '' });
  });

  it('returns an empty string for a bodyless response', async () => {
    const result = await readResponseTextWithLimit(new Response(null, { status: 204 }), 1024);
    expect(result).toEqual({ ok: true, text: '' });
  });
});

describe('readResponseTextWithLimit — abort signal while a read is pending', () => {
  it('cancels the reader when the signal fires without waiting for cancel() to settle', async () => {
    const cancel = deferred<void>();
    const { response, cancelCalls } = neverEnqueuingResponse(() => cancel.promise);
    const controller = new AbortController();

    const resultPromise = readResponseTextWithLimit(response, 1024, { signal: controller.signal });
    controller.abort();
    const result = await resultPromise;

    expect(result).toEqual({ ok: false, error: { kind: 'BODY_READ_ERROR' } });
    expect(cancelCalls()).toBe(1);

    // Cleanup: settle the intentionally-pending cancel so nothing dangles past this test.
    cancel.resolve();
  });

  it('unlocks the body after a signal-fired cancellation on a standard stream', async () => {
    const { response } = neverEnqueuingResponse();
    const controller = new AbortController();

    const resultPromise = readResponseTextWithLimit(response, 1024, { signal: controller.signal });
    controller.abort();
    await resultPromise;

    expect(response.body?.locked).toBe(false);
  });

  it('does not wait for a cancel() that never settles', async () => {
    const cancel = deferred<void>();
    const { response, cancelCalls } = neverEnqueuingResponse(() => cancel.promise);
    const controller = new AbortController();

    const resultPromise = readResponseTextWithLimit(response, 1024, { signal: controller.signal });
    controller.abort();
    // This must resolve even though the underlying cancel() has not settled yet — proves the
    // abort branch does not await cancellation.
    const result = await resultPromise;

    expect(result).toEqual({ ok: false, error: { kind: 'BODY_READ_ERROR' } });
    expect(cancelCalls()).toBe(1);

    // Cleanup: settle the intentionally-pending cancel so nothing dangles past this test.
    cancel.resolve();
  });

  it('does not surface a raw error when cancel() rejects after the signal fires', async () => {
    const marker = 'SECRET_ABORT_SIGNAL_CANCEL_REJECTION_MARKER';
    const { response, cancelCalls } = neverEnqueuingResponse(() => Promise.reject(new Error(marker)));
    const controller = new AbortController();

    const resultPromise = readResponseTextWithLimit(response, 1024, { signal: controller.signal });
    controller.abort();
    const result = await resultPromise;
    expect(result).toEqual({ ok: false, error: { kind: 'BODY_READ_ERROR' } });
    expect(JSON.stringify(result)).not.toContain(marker);

    await assertNoUnhandledRejection(async () => {
      await tick(20);
    });
    expect(cancelCalls()).toBe(1);
  });

  it('handles an already-aborted signal deterministically without ever reading a chunk', async () => {
    const { response, wasCancelled, pullCount } = openStreamResponse(encoder.encode('x'));
    const controller = new AbortController();
    controller.abort();

    const result = await readResponseTextWithLimit(response, 1024, { signal: controller.signal });

    expect(result).toEqual({ ok: false, error: { kind: 'BODY_READ_ERROR' } });
    expect(wasCancelled()).toBe(true);
    expect(pullCount()).toBe(0);
  });
});

describe('readResponseTextWithLimit — abort subscription count (P2-1)', () => {
  it('subscribes to the signal exactly once across multiple non-empty chunks', async () => {
    const { response } = streamResponse([
      encoder.encode('aaaa'),
      encoder.encode('bbbb'),
      encoder.encode('cccc'),
    ]);
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, 'addEventListener');
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    const result = await readResponseTextWithLimit(response, 1024, { signal: controller.signal });

    expect(result).toEqual({ ok: true, text: 'aaaabbbbcccc' });
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it('subscribes exactly once even across interleaved zero-byte chunks', async () => {
    const { response } = streamResponse([
      new Uint8Array(0),
      encoder.encode('a'),
      new Uint8Array(0),
      new Uint8Array(0),
      encoder.encode('b'),
    ]);
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, 'addEventListener');

    const result = await readResponseTextWithLimit(response, 1024, { signal: controller.signal });

    expect(result).toEqual({ ok: true, text: 'ab' });
    expect(addSpy).toHaveBeenCalledTimes(1);
  });

  it('subscribes exactly once regardless of how many small chunks are read', async () => {
    const chunks = Array.from({ length: 50 }, () => encoder.encode('x'));
    const { response } = streamResponse(chunks);
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, 'addEventListener');
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    const result = await readResponseTextWithLimit(response, 1024, { signal: controller.signal });

    expect(result).toEqual({ ok: true, text: 'x'.repeat(50) });
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it('removes the listener after success', async () => {
    const { response } = streamResponse([encoder.encode('abc')]);
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    await readResponseTextWithLimit(response, 1024, { signal: controller.signal });

    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('removes the listener after a streaming overflow', async () => {
    const { response } = openStreamResponse(encoder.encode('12345'));
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    const result = await readResponseTextWithLimit(response, 7, { signal: controller.signal });

    expect(result).toEqual({ ok: false, error: { kind: 'RESPONSE_TOO_LARGE' } });
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it('removes the listener after a read error', async () => {
    const { response } = erroringStreamResponse(new Error('boom'));
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    const result = await readResponseTextWithLimit(response, 1024, { signal: controller.signal });

    expect(result).toEqual({ ok: false, error: { kind: 'BODY_READ_ERROR' } });
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it('removes the listener after a caller abort fires mid-read', async () => {
    const { response } = neverEnqueuingResponse();
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    const resultPromise = readResponseTextWithLimit(response, 1024, { signal: controller.signal });
    controller.abort();
    await resultPromise;

    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it('does not touch AbortSignal listener APIs when called without a signal (unchanged behavior)', async () => {
    const { response } = streamResponse([encoder.encode('abc')]);
    const result = await readResponseTextWithLimit(response, 1024);
    expect(result).toEqual({ ok: true, text: 'abc' });
  });
});

describe('readResponseTextWithLimit — non-cooperative pending read (fake reader)', () => {
  it('starts cancellation and returns without waiting for the pending read to settle', async () => {
    const fake = controllableReaderResponse();
    const controller = new AbortController();

    const resultPromise = readResponseTextWithLimit(fake.response, 1024, {
      signal: controller.signal,
    });
    controller.abort();
    const result = await resultPromise;

    expect(result).toEqual({ ok: false, error: { kind: 'BODY_READ_ERROR' } });
    expect(fake.cancelCalls()).toBe(1);
    // The immediate attempt in `finally` already ran once, even though read() is still pending.
    expect(fake.releaseLockCalls()).toBe(1);

    // Cleanup: settle the intentionally-pending read so nothing dangles past this test.
    fake.resolveRead({ done: true, value: undefined });
  });

  it('retries the lock release once the pending read resolves late', async () => {
    const fake = controllableReaderResponse();
    const controller = new AbortController();

    const resultPromise = readResponseTextWithLimit(fake.response, 1024, {
      signal: controller.signal,
    });
    controller.abort();
    await resultPromise;
    expect(fake.releaseLockCalls()).toBe(1);

    fake.resolveRead({ done: true, value: undefined });
    await tick(20);
    expect(fake.releaseLockCalls()).toBe(2);
  });

  it('retries the lock release once the pending read rejects late, without an unhandled rejection', async () => {
    const marker = 'SECRET_LATE_PENDING_READ_REJECTION_MARKER';
    const fake = controllableReaderResponse();
    const controller = new AbortController();

    const resultPromise = readResponseTextWithLimit(fake.response, 1024, {
      signal: controller.signal,
    });
    controller.abort();
    const result = await resultPromise;
    expect(JSON.stringify(result)).not.toContain(marker);

    await assertNoUnhandledRejection(async () => {
      fake.rejectRead(new Error(marker));
      await tick(20);
    });
    expect(fake.releaseLockCalls()).toBe(2);
  });

  it('subscribes to the signal exactly once even when the pending read never settles', async () => {
    const fake = controllableReaderResponse();
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, 'addEventListener');
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    const resultPromise = readResponseTextWithLimit(fake.response, 1024, {
      signal: controller.signal,
    });
    controller.abort();
    await resultPromise;

    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);

    fake.resolveRead({ done: true, value: undefined });
  });
});

describe('readResponseTextWithLimit — RESPONSE_TOO_LARGE latches before cleanup', () => {
  it('latches from the Content-Length precheck even when cancel() never settles', async () => {
    const cancel = deferred<void>();
    let cancelCalls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        // Never enqueue: the precheck must reject before touching the stream.
      },
      cancel() {
        cancelCalls += 1;
        return cancel.promise;
      },
    });
    const response = new Response(stream, { headers: { 'content-length': '100' } });

    // This must resolve even though the underlying cancel() has not settled yet.
    const result = await readResponseTextWithLimit(response, 10);
    expect(result).toEqual({ ok: false, error: { kind: 'RESPONSE_TOO_LARGE' } });
    expect(cancelCalls).toBe(1);

    // Cleanup: settle the intentionally-pending cancel so nothing dangles past this test.
    cancel.resolve();
  });

  it('latches from the streaming limit even when cancel() never settles', async () => {
    const cancel = deferred<void>();
    const { response, cancelCalls } = alwaysProducingResponse(
      encoder.encode('12345'),
      () => cancel.promise,
    );

    // This must resolve even though the underlying cancel() has not settled yet.
    const result = await readResponseTextWithLimit(response, 7);
    expect(result).toEqual({ ok: false, error: { kind: 'RESPONSE_TOO_LARGE' } });
    expect(cancelCalls()).toBe(1);

    // Cleanup: settle the intentionally-pending cancel so nothing dangles past this test.
    cancel.resolve();
  });
});
