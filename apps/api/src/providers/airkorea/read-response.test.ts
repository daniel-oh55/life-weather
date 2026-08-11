import { describe, expect, it } from 'vitest';

import { readAirKoreaResponseTextWithLimit } from './read-response.js';

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
});
