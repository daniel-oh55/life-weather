import { describe, expect, it } from 'vitest';

import { readResponseTextWithLimit } from './read-response';

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
