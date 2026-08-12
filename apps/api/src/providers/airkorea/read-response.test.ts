import { describe, expect, it, vi } from 'vitest';

import { readAirKoreaResponseTextWithLimit } from './read-response.js';

const encoder = new TextEncoder();

function responseFromChunks(
  chunks: readonly Uint8Array[],
  headers: Record<string, string> = {},
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  return new Response(stream, { headers });
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * A response whose body is an *open* (never-closing) stream that yields `chunk` on every pull, so
 * that a reader cancellation genuinely invokes the underlying `cancel()` (a pre-closed stream would
 * already be drained, making `cancel()` a no-op).
 */
function openStreamResponse(
  chunk: Uint8Array,
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
    },
  });
  return { response: new Response(stream), wasCancelled: () => cancelled, pullCount: () => pulls };
}

/** A response whose body stream never enqueues/closes on its own. */
function neverEnqueuingResponse(): { response: Response; cancelCalls: () => number } {
  let cancelCalls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull() {
      // Intentionally never enqueue/close/error.
    },
    cancel() {
      cancelCalls += 1;
    },
  });
  return { response: new Response(stream), cancelCalls: () => cancelCalls };
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
 * A fake `Response` backed by a hand-rolled reader (not a real `ReadableStream`) whose `read()`,
 * `cancel()`, and `releaseLock()` are each independently controllable. A real spec-compliant stream
 * settles a pending `read()` as soon as `cancel()` is invoked, which makes it impossible to observe a
 * `read()` that is *still* pending some time after `cancel()` was called using a real stream. This
 * fake exists solely to exercise that genuinely non-cooperative scenario, so the late-settlement
 * retry-release path can be verified directly.
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

describe('readAirKoreaResponseTextWithLimit — happy path', () => {
  it('reads a small single-chunk body fully', async () => {
    const response = responseFromChunks([utf8('{"ok":true}')]);
    const result = await readAirKoreaResponseTextWithLimit(response, 1024);
    expect(result).toEqual({ ok: true, text: '{"ok":true}' });
  });

  it('reassembles a multi-byte UTF-8 sequence split across chunks', async () => {
    const full = utf8('종로구');
    const first = full.slice(0, 2);
    const second = full.slice(2);
    const response = responseFromChunks([first, second]);
    const result = await readAirKoreaResponseTextWithLimit(response, 1024);
    expect(result).toEqual({ ok: true, text: '종로구' });
  });

  it('yields the empty string for a null body', async () => {
    const response = new Response(null);
    const result = await readAirKoreaResponseTextWithLimit(response, 1024);
    expect(result).toEqual({ ok: true, text: '' });
  });

  it('succeeds when the body is exactly maxBytes', async () => {
    const chunk = utf8('a'.repeat(10));
    const response = responseFromChunks([chunk]);
    const result = await readAirKoreaResponseTextWithLimit(response, 10);
    expect(result).toEqual({ ok: true, text: 'a'.repeat(10) });
  });
});

describe('readAirKoreaResponseTextWithLimit — size cap', () => {
  it('rejects via the Content-Length pre-check before reading any byte', async () => {
    const response = responseFromChunks([utf8('x'.repeat(20))], {
      'content-length': '2000000',
    });
    const result = await readAirKoreaResponseTextWithLimit(response, 1024);
    expect(result).toEqual({ ok: false, error: { kind: 'RESPONSE_TOO_LARGE' } });
  });

  it('rejects a streamed body exceeding maxBytes when Content-Length is absent', async () => {
    const response = responseFromChunks([utf8('a'.repeat(600)), utf8('b'.repeat(600))]);
    const result = await readAirKoreaResponseTextWithLimit(response, 1000);
    expect(result).toEqual({ ok: false, error: { kind: 'RESPONSE_TOO_LARGE' } });
  });

  it('rejects a streamed body exceeding maxBytes even with a lying small Content-Length', async () => {
    const response = responseFromChunks([utf8('a'.repeat(2000))], { 'content-length': '1' });
    const result = await readAirKoreaResponseTextWithLimit(response, 1000);
    expect(result).toEqual({ ok: false, error: { kind: 'RESPONSE_TOO_LARGE' } });
  });

  it('one byte over the cap fails', async () => {
    const response = responseFromChunks([utf8('a'.repeat(11))]);
    const result = await readAirKoreaResponseTextWithLimit(response, 10);
    expect(result.ok).toBe(false);
  });
});

describe('readAirKoreaResponseTextWithLimit — stream failures', () => {
  it('returns BODY_READ_ERROR (never throws) when read() rejects', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('SECRET_STREAM_ERROR_MESSAGE'));
      },
    });
    const response = new Response(stream);
    const result = await readAirKoreaResponseTextWithLimit(response, 1024);
    expect(result).toEqual({ ok: false, error: { kind: 'BODY_READ_ERROR' } });
    expect(JSON.stringify(result)).not.toContain('SECRET_STREAM_ERROR_MESSAGE');
  });

  it('returns BODY_READ_ERROR when getReader() throws', async () => {
    const response = responseFromChunks([utf8('x')]);
    // Simulate an already-locked/unreadable body by acquiring the reader ourselves first.
    const reader = response.body!.getReader();
    const result = await readAirKoreaResponseTextWithLimit(response, 1024);
    expect(result).toEqual({ ok: false, error: { kind: 'BODY_READ_ERROR' } });
    reader.releaseLock();
  });
});

describe('readAirKoreaResponseTextWithLimit — abort signal', () => {
  it('fails immediately for an already-aborted signal without hanging', async () => {
    const controller = new AbortController();
    controller.abort();
    // A body whose read() would otherwise never resolve.
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {
          // Never settles — proves the function does not simply await read() unbounded.
        });
      },
    });
    const response = new Response(stream);
    const result = await readAirKoreaResponseTextWithLimit(response, 1024, {
      signal: controller.signal,
    });
    expect(result).toEqual({ ok: false, error: { kind: 'BODY_READ_ERROR' } });
  });

  it('fails with BODY_READ_ERROR when the signal fires while a read() is outstanding', async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {
          // Never settles on its own; only the abort should unblock the read.
        });
      },
    });
    const response = new Response(stream);
    const resultPromise = readAirKoreaResponseTextWithLimit(response, 1024, {
      signal: controller.signal,
    });
    controller.abort();
    const result = await resultPromise;
    expect(result).toEqual({ ok: false, error: { kind: 'BODY_READ_ERROR' } });
  });

  it('does not fail when the signal never fires and the body completes normally', async () => {
    const controller = new AbortController();
    const response = responseFromChunks([utf8('ok')]);
    const result = await readAirKoreaResponseTextWithLimit(response, 1024, {
      signal: controller.signal,
    });
    expect(result).toEqual({ ok: true, text: 'ok' });
  });

  it('handles an already-aborted signal deterministically without ever reading a chunk', async () => {
    const { response, wasCancelled, pullCount } = openStreamResponse(encoder.encode('x'));
    const controller = new AbortController();
    controller.abort();

    const result = await readAirKoreaResponseTextWithLimit(response, 1024, {
      signal: controller.signal,
    });

    expect(result).toEqual({ ok: false, error: { kind: 'BODY_READ_ERROR' } });
    expect(wasCancelled()).toBe(true);
    expect(pullCount()).toBe(0);
  });
});

describe('readAirKoreaResponseTextWithLimit — abort listener lifecycle (P2-2)', () => {
  it('subscribes to the signal exactly once across multiple non-empty chunks (not one per chunk)', async () => {
    const response = responseFromChunks([utf8('aaaa'), utf8('bbbb'), utf8('cccc')]);
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, 'addEventListener');
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    const result = await readAirKoreaResponseTextWithLimit(response, 1024, {
      signal: controller.signal,
    });

    expect(result).toEqual({ ok: true, text: 'aaaabbbbcccc' });
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it('subscribes exactly once regardless of how many small chunks are read', async () => {
    const chunks = Array.from({ length: 50 }, () => utf8('x'));
    const response = responseFromChunks(chunks);
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, 'addEventListener');

    const result = await readAirKoreaResponseTextWithLimit(response, 1024, {
      signal: controller.signal,
    });

    expect(result).toEqual({ ok: true, text: 'x'.repeat(50) });
    expect(addSpy).toHaveBeenCalledTimes(1);
  });

  it('removes the listener after success', async () => {
    const response = responseFromChunks([utf8('abc')]);
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    await readAirKoreaResponseTextWithLimit(response, 1024, { signal: controller.signal });

    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('removes the listener after a streaming overflow (RESPONSE_TOO_LARGE preserved)', async () => {
    const { response } = openStreamResponse(utf8('12345'));
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    const result = await readAirKoreaResponseTextWithLimit(response, 7, {
      signal: controller.signal,
    });

    expect(result).toEqual({ ok: false, error: { kind: 'RESPONSE_TOO_LARGE' } });
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it('removes the listener after a read error', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('boom'));
      },
    });
    const response = new Response(stream);
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    const result = await readAirKoreaResponseTextWithLimit(response, 1024, {
      signal: controller.signal,
    });

    expect(result).toEqual({ ok: false, error: { kind: 'BODY_READ_ERROR' } });
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it('returns promptly and removes the listener when a caller/timeout signal fires mid-read', async () => {
    const { response, cancelCalls } = neverEnqueuingResponse();
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    const resultPromise = readAirKoreaResponseTextWithLimit(response, 1024, {
      signal: controller.signal,
    });
    controller.abort();
    const result = await resultPromise;

    expect(result).toEqual({ ok: false, error: { kind: 'BODY_READ_ERROR' } });
    expect(cancelCalls()).toBe(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it('does not touch AbortSignal listener APIs when called without a signal (unchanged behavior)', async () => {
    const response = responseFromChunks([utf8('abc')]);
    const result = await readAirKoreaResponseTextWithLimit(response, 1024);
    expect(result).toEqual({ ok: true, text: 'abc' });
  });
});

describe('readAirKoreaResponseTextWithLimit — non-cooperative pending read (fake reader)', () => {
  it('starts cancellation and returns without waiting for the pending read to settle', async () => {
    const fake = controllableReaderResponse();
    const controller = new AbortController();

    const resultPromise = readAirKoreaResponseTextWithLimit(fake.response, 1024, {
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

    const resultPromise = readAirKoreaResponseTextWithLimit(fake.response, 1024, {
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

    const resultPromise = readAirKoreaResponseTextWithLimit(fake.response, 1024, {
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

    const resultPromise = readAirKoreaResponseTextWithLimit(fake.response, 1024, {
      signal: controller.signal,
    });
    controller.abort();
    await resultPromise;

    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);

    fake.resolveRead({ done: true, value: undefined });
  });
});
