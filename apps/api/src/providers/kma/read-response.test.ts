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
 * already be drained, making `cancel()` a no-op).
 */
function openStreamResponse(
  chunk: Uint8Array,
): { response: Response; wasCancelled: () => boolean } {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  return { response: new Response(stream), wasCancelled: () => cancelled };
}

describe('readResponseTextWithLimit — Content-Length gate', () => {
  it('rejects before reading when Content-Length exceeds max', async () => {
    const { response, wasCancelled } = streamResponse([encoder.encode('abc')], '100');
    const result = await readResponseTextWithLimit(response, 10);
    expect(result).toEqual({ ok: false, error: { kind: 'RESPONSE_TOO_LARGE' } });
    // Never entered the stream loop, so the underlying stream was not cancelled by us.
    expect(wasCancelled()).toBe(false);
  });

  it('ignores a malformed Content-Length and streams instead', async () => {
    const { response } = streamResponse([encoder.encode('abc')], 'not-a-number');
    const result = await readResponseTextWithLimit(response, 10);
    expect(result).toEqual({ ok: true, text: 'abc' });
  });
});

describe('readResponseTextWithLimit — streaming size limit', () => {
  it('rejects and cancels the reader when the running total exceeds max', async () => {
    const { response, wasCancelled } = openStreamResponse(encoder.encode('12345'));
    const result = await readResponseTextWithLimit(response, 7);
    expect(result.ok).toBe(false);
    expect(wasCancelled()).toBe(true);
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
