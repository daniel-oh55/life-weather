import { KmaForecastProduct } from '@life-weather/weather-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KmaCurrentObservationRequest } from './current-request.js';
import { getKmaCurrentObservationField } from './group-current-observation-items.js';
import { getKmaForecastField } from './group-forecast-items.js';
import {
  createKmaCurrentObservationProvider,
  createKmaForecastProvider,
  type KmaCurrentObservationProvider,
  type KmaForecastProvider,
} from './provider.js';
import type { KmaForecastRequest, KmaRequestIssue } from './request.js';

/** An obviously fake decoded service key. Never a real/production-shaped string. */
const FAKE_KEY = 'test-key+with/slash==';

const REQUEST: KmaForecastRequest = {
  product: KmaForecastProduct.SHORT_FORECAST,
  baseDate: '20260716',
  baseTime: '0500',
  nx: 60,
  ny: 127,
};

interface RawItem {
  baseDate: string;
  baseTime: string;
  category: string;
  fcstDate: string;
  fcstTime: string;
  fcstValue: string | null;
  nx: number;
  ny: number;
}

/** A raw forecast item that matches {@link REQUEST}'s identity unless overridden. */
function item(overrides: Partial<RawItem> = {}): RawItem {
  return {
    baseDate: '20260716',
    baseTime: '0500',
    category: 'TMP',
    fcstDate: '20260716',
    fcstTime: '0600',
    fcstValue: '25',
    nx: 60,
    ny: 127,
    ...overrides,
  };
}

interface BodyOptions {
  pageNo?: number;
  numOfRows?: number;
  totalCount?: number;
  items?: readonly RawItem[];
  resultCode?: string;
  resultMsg?: string;
}

/** Serialize a KMA success/error envelope to a JSON string. */
function body(options: BodyOptions = {}): string {
  const items = options.items ?? [item()];
  return JSON.stringify({
    response: {
      header: {
        resultCode: options.resultCode ?? '00',
        resultMsg: options.resultMsg ?? 'NORMAL_SERVICE',
      },
      body: {
        dataType: 'JSON',
        pageNo: options.pageNo ?? 1,
        numOfRows: options.numOfRows ?? 1000,
        totalCount: options.totalCount ?? items.length,
        items: { item: items },
      },
    },
  });
}

function jsonOk(bodyString: string): Response {
  return new Response(bodyString, { status: 200 });
}

function fetchReturning(response: Response): typeof fetch {
  return (async () => response) as unknown as typeof fetch;
}

function fetchRejecting(error: unknown): typeof fetch {
  return (async () => {
    throw error;
  }) as unknown as typeof fetch;
}

/** A fetch that never settles until its signal aborts, then rejects like the platform does. */
function fetchHangingUntilAbort(): typeof fetch {
  return ((_input: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    })) as unknown as typeof fetch;
}

/**
 * A fetch that resolves a 200 Response immediately but whose body stream stalls (never enqueues)
 * until the fetch's own abort signal fires — at which point the body errors, exactly as the
 * platform's `fetch` body does when a request is aborted mid-stream. This exercises the case where
 * the response *header* arrives fine but the *body* hangs, so the timeout/caller-abort lifecycle
 * must still cover the body read. `bodyObservedAbort()` reports whether the body saw the abort.
 */
function fetchHeaderThenBodyTiedToSignal(): {
  fetchImpl: typeof fetch;
  bodyObservedAbort: () => boolean;
} {
  let observed = false;
  const fetchImpl = ((_input: unknown, init?: RequestInit) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener('abort', () => {
          observed = true;
          controller.error(new DOMException('The operation was aborted.', 'AbortError'));
        });
      },
    });
    return Promise.resolve(new Response(stream, { status: 200 }));
  }) as unknown as typeof fetch;
  return { fetchImpl, bodyObservedAbort: () => observed };
}

/** A fetch that resolves a 200 Response whose body stream fails (errors), never carrying data. */
function fetchBodyStreamErrors(error: unknown, afterChunks = 0): typeof fetch {
  const encoder = new TextEncoder();
  return (() => {
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
          controller.enqueue(encoder.encode('{'));
          return;
        }
        controller.error(error);
      },
    });
    return Promise.resolve(new Response(stream, { status: 200 }));
  }) as unknown as typeof fetch;
}

/** A tiny delay to let the fetch resolve and the body read begin before the test acts. */
function tick(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Non-cooperative fetch/body mocks (P2 remediation — transport termination guarantee).
//
// Unlike `fetchHangingUntilAbort` and `fetchHeaderThenBodyTiedToSignal` above (which *cooperate*
// by rejecting/erroring once the abort signal fires), everything below ignores the abort signal
// completely: no listener is ever attached to it. These exist to prove the provider still
// terminates within the timeout/caller-abort — and never leaks an unhandled rejection from a late
// settlement — even when the injected fetch/body genuinely never reacts to being aborted.
// ---------------------------------------------------------------------------

/** A fetch that never settles and never even looks at `init`/the signal. */
function fetchIgnoringAbortForever(): typeof fetch {
  return (() =>
    new Promise<Response>(() => {
      // Intentionally never resolves/rejects and never inspects the signal.
    })) as unknown as typeof fetch;
}

/**
 * A fetch whose settlement is driven manually via `resolveWith`/`rejectWith`, and which never looks
 * at the signal. Lets a test simulate a fetch that settles *late* — after the provider has already
 * returned a TIMEOUT/ABORTED result — without a real hang.
 */
function controllableFetch(): {
  fetchImpl: typeof fetch;
  resolveWith: (response: Response) => void;
  rejectWith: (reason: unknown) => void;
} {
  let resolveFn!: (response: Response) => void;
  let rejectFn!: (reason: unknown) => void;
  const fetchImpl = (() =>
    new Promise<Response>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    })) as unknown as typeof fetch;
  return {
    fetchImpl,
    resolveWith: (response) => resolveFn(response),
    rejectWith: (reason) => rejectFn(reason),
  };
}

/** A 200 Response whose body stream never enqueues/closes/errors, so `reader.read()` hangs forever. */
function fetchWithHangingBody(): typeof fetch {
  const stream = new ReadableStream<Uint8Array>({
    pull() {
      // Intentionally never enqueue/close/error, and never inspects any signal.
    },
  });
  return (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;
}

/**
 * A 200 Response whose body is controlled manually via `push`/`close`, and which never inspects any
 * signal. Starts pending (nothing enqueued) so a test can drive a real timeout/abort first, then
 * complete the body *late* to exercise a late body success without a real hang. `wasCancelled()`
 * reports whether anything called `cancel()` on the underlying stream.
 */
function controllableHangingBodyResponse(): {
  response: Response;
  push: (chunk: string) => void;
  close: () => void;
  wasCancelled: () => boolean;
} {
  let cancelled = false;
  let controllerRef!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(stream, { status: 200 }),
    push: (chunk) => controllerRef.enqueue(encoder.encode(chunk)),
    close: () => controllerRef.close(),
    wasCancelled: () => cancelled,
  };
}

/**
 * Run `run`, then give any late microtask/timer-driven settlement a moment to surface before
 * asserting it never became a process-level `unhandledRejection` — the concrete way to verify that
 * a fetch/body promise settling *after* the provider has already returned cannot leak one.
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

function providerWith(
  fetchImpl: typeof fetch,
  options: { timeoutMs?: number; maxResponseBytes?: number } = {},
): KmaForecastProvider {
  const created = createKmaForecastProvider({ serviceKey: FAKE_KEY, fetchImpl, ...options });
  if (!created.ok) {
    throw new Error('unexpected config error in test setup');
  }
  return created.provider;
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
 * A response whose body stream never enqueues/closes on its own (so a pending `read()` stays
 * pending forever unless cancelled), with a fully controllable `cancel()` outcome. `status`
 * defaults to 200 so the body is actually read; pass a non-2xx status to exercise the HTTP-error
 * cancellation path instead (which never reads the body).
 */
function hangingReadResponse(
  status = 200,
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
  return { response: new Response(stream, { status }), cancelCalls: () => cancelCalls };
}

/**
 * A 200 response whose body always has another chunk available on `pull` (so the streaming size
 * limit trips on the first chunk under a small `maxResponseBytes`), with a fully controllable
 * `cancel()` outcome — same shape as {@link hangingReadResponse}.
 */
function overflowingBodyResponse(
  onCancel?: () => Promise<void> | void,
): { response: Response; cancelCalls: () => number } {
  const encoder = new TextEncoder();
  let cancelCalls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(encoder.encode('x'.repeat(64)));
    },
    cancel() {
      cancelCalls += 1;
      return onCancel?.();
    },
  });
  return { response: new Response(stream, { status: 200 }), cancelCalls: () => cancelCalls };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

describe('fetchForecast — request validation', () => {
  it('returns INVALID_REQUEST without calling fetch for a bad request', async () => {
    const spy = vi.fn(fetchReturning(jsonOk(body())));
    const result = await providerWith(spy as unknown as typeof fetch).fetchForecast({
      ...REQUEST,
      baseTime: '2400',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('INVALID_REQUEST');
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('fetchForecast — fetch options', () => {
  it('issues a GET with Accept: application/json, redirect: error, and an AbortSignal', async () => {
    const calls: { input: unknown; init: RequestInit | undefined }[] = [];
    const fetchImpl = ((input: unknown, init?: RequestInit) => {
      calls.push({ input, init });
      return Promise.resolve(jsonOk(body()));
    }) as unknown as typeof fetch;

    await providerWith(fetchImpl).fetchForecast(REQUEST);

    expect(calls).toHaveLength(1);
    const { input, init } = calls[0];
    expect(input).toBeInstanceOf(URL);
    expect(init?.method).toBe('GET');
    expect(init?.headers).toEqual({ Accept: 'application/json' });
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('does not use the global fetch when an implementation is injected', async () => {
    const globalSpy = vi.spyOn(globalThis, 'fetch');
    await providerWith(fetchReturning(jsonOk(body()))).fetchForecast(REQUEST);
    expect(globalSpy).not.toHaveBeenCalled();
    globalSpy.mockRestore();
  });

  it('does not log the URL or service key', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await providerWith(fetchReturning(jsonOk(body()))).fetchForecast(REQUEST);

    for (const spy of [logSpy, errorSpy, warnSpy]) {
      expect(spy).not.toHaveBeenCalled();
    }
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe('fetchForecast — timeout & caller abort', () => {
  it('maps a provider timeout to TIMEOUT', async () => {
    const result = await providerWith(fetchHangingUntilAbort(), { timeoutMs: 10 }).fetchForecast(
      REQUEST,
    );
    expect(result).toEqual({ ok: false, error: { kind: 'TIMEOUT' } });
  });

  it('returns ABORTED without calling fetch when the caller signal is already aborted', async () => {
    const spy = vi.fn(fetchReturning(jsonOk(body())));
    const controller = new AbortController();
    controller.abort();
    const result = await providerWith(spy as unknown as typeof fetch).fetchForecast(REQUEST, {
      signal: controller.signal,
    });
    expect(result).toEqual({ ok: false, error: { kind: 'ABORTED' } });
    expect(spy).not.toHaveBeenCalled();
  });

  it('maps a mid-flight caller abort to ABORTED', async () => {
    const controller = new AbortController();
    const promise = providerWith(fetchHangingUntilAbort(), { timeoutMs: 10_000 }).fetchForecast(
      REQUEST,
      { signal: controller.signal },
    );
    controller.abort();
    expect(await promise).toEqual({ ok: false, error: { kind: 'ABORTED' } });
  });

  it('maps a generic fetch rejection to NETWORK_ERROR', async () => {
    const result = await providerWith(fetchRejecting(new Error('boom'))).fetchForecast(REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'NETWORK_ERROR' } });
  });

  it('never exposes a fetch exception message', async () => {
    const secret = 'SECRET_FETCH_EXCEPTION_MARKER';
    const result = await providerWith(fetchRejecting(new Error(secret))).fetchForecast(REQUEST);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('clears the timeout timer and removes the caller-abort listener on success', async () => {
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    await providerWith(fetchReturning(jsonOk(body())), { timeoutMs: 54_321 }).fetchForecast(
      REQUEST,
      { signal: controller.signal },
    );

    const callIndex = setSpy.mock.calls.findIndex((call) => call[1] === 54_321);
    expect(callIndex).toBeGreaterThanOrEqual(0);
    expect(clearSpy).toHaveBeenCalledWith(setSpy.mock.results[callIndex]?.value);
    expect(removeSpy).toHaveBeenCalled();

    setSpy.mockRestore();
    clearSpy.mockRestore();
  });

  it('resolves the timeout-vs-abort race deterministically (mid-flight abort → ABORTED)', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const controller = new AbortController();
      const promise = providerWith(fetchHangingUntilAbort(), { timeoutMs: 10_000 }).fetchForecast(
        REQUEST,
        { signal: controller.signal },
      );
      controller.abort();
      expect(await promise).toEqual({ ok: false, error: { kind: 'ABORTED' } });
    }
  });
});

describe('fetchForecast — timeout & caller abort cover the body read', () => {
  it('enforces the timeout while the body stalls after the header arrives (→ TIMEOUT)', async () => {
    const { fetchImpl, bodyObservedAbort } = fetchHeaderThenBodyTiedToSignal();
    const result = await providerWith(fetchImpl, { timeoutMs: 10 }).fetchForecast(REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'TIMEOUT' } });
    // The abort reached the body (not just the header): the timer was still armed during the read.
    expect(bodyObservedAbort()).toBe(true);
  });

  it('does not reject its promise on a body timeout', async () => {
    const { fetchImpl } = fetchHeaderThenBodyTiedToSignal();
    await expect(
      providerWith(fetchImpl, { timeoutMs: 10 }).fetchForecast(REQUEST),
    ).resolves.toEqual({ ok: false, error: { kind: 'TIMEOUT' } });
  });

  it('clears the timeout timer and removes the caller-abort listener after a body timeout', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const { fetchImpl } = fetchHeaderThenBodyTiedToSignal();
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    await providerWith(fetchImpl, { timeoutMs: 10 }).fetchForecast(REQUEST, {
      signal: controller.signal,
    });

    expect(clearSpy).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('applies a caller abort while the body is being read after the header arrives (→ ABORTED)', async () => {
    const { fetchImpl, bodyObservedAbort } = fetchHeaderThenBodyTiedToSignal();
    const controller = new AbortController();
    const promise = providerWith(fetchImpl, { timeoutMs: 10_000 }).fetchForecast(REQUEST, {
      signal: controller.signal,
    });
    // Let the fetch resolve and the body read begin, then abort mid-read.
    await tick();
    controller.abort();
    expect(await promise).toEqual({ ok: false, error: { kind: 'ABORTED' } });
    expect(bodyObservedAbort()).toBe(true);
  });
});

describe('fetchForecast — transport terminates even when fetchImpl/body ignores the abort signal', () => {
  it('a pending fetch that ignores the signal still resolves TIMEOUT within the timeout', async () => {
    const result = await providerWith(fetchIgnoringAbortForever(), {
      timeoutMs: 10,
    }).fetchForecast(REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'TIMEOUT' } });
  });

  it('a pending fetch that ignores the signal still resolves ABORTED on caller abort', async () => {
    const controller = new AbortController();
    const promise = providerWith(fetchIgnoringAbortForever(), {
      timeoutMs: 10_000,
    }).fetchForecast(REQUEST, { signal: controller.signal });
    controller.abort();
    expect(await promise).toEqual({ ok: false, error: { kind: 'ABORTED' } });
  });

  it('resolves the timeout-vs-abort race deterministically with a non-cooperative pending fetch', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const controller = new AbortController();
      const promise = providerWith(fetchIgnoringAbortForever(), {
        timeoutMs: 10_000,
      }).fetchForecast(REQUEST, { signal: controller.signal });
      controller.abort();
      expect(await promise).toEqual({ ok: false, error: { kind: 'ABORTED' } });
    }
  });

  it('a fetch that resolves late (after TIMEOUT) never changes the result and its body is cancelled', async () => {
    const { fetchImpl, resolveWith } = controllableFetch();
    const result = await providerWith(fetchImpl, { timeoutMs: 10 }).fetchForecast(REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'TIMEOUT' } });

    const late = controllableHangingBodyResponse();
    await assertNoUnhandledRejection(async () => {
      resolveWith(late.response);
      await tick(20);
    });
    expect(late.wasCancelled()).toBe(true);
  });

  it('a fetch that rejects late (after TIMEOUT) never becomes an unhandled rejection', async () => {
    const { fetchImpl, rejectWith } = controllableFetch();
    const result = await providerWith(fetchImpl, { timeoutMs: 10 }).fetchForecast(REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'TIMEOUT' } });

    await assertNoUnhandledRejection(async () => {
      rejectWith(new Error('SECRET_LATE_FETCH_REJECTION_MARKER'));
      await tick(20);
    });
  });

  it('a pending body read that ignores the signal still resolves TIMEOUT within the timeout', async () => {
    const result = await providerWith(fetchWithHangingBody(), { timeoutMs: 10 }).fetchForecast(
      REQUEST,
    );
    expect(result).toEqual({ ok: false, error: { kind: 'TIMEOUT' } });
  });

  it('a pending body read that ignores the signal still resolves ABORTED on caller abort', async () => {
    const controller = new AbortController();
    const promise = providerWith(fetchWithHangingBody(), { timeoutMs: 10_000 }).fetchForecast(
      REQUEST,
      { signal: controller.signal },
    );
    await tick();
    controller.abort();
    expect(await promise).toEqual({ ok: false, error: { kind: 'ABORTED' } });
  });

  it('cancels a hanging body reader on TIMEOUT without waiting for cancel() to settle', async () => {
    const cancel = deferred<void>();
    const { response, cancelCalls } = hangingReadResponse(200, () => cancel.promise);
    const result = await providerWith(fetchReturning(response), { timeoutMs: 10 }).fetchForecast(
      REQUEST,
    );
    expect(result).toEqual({ ok: false, error: { kind: 'TIMEOUT' } });

    // The provider already returned above even though cancel() has not settled yet.
    await assertNoUnhandledRejection(async () => {
      await tick(20);
    });
    expect(cancelCalls()).toBe(1);
    expect(response.body?.locked).toBe(false);

    // Settling cancel() late must not throw, leak, or change anything already decided.
    cancel.resolve();
    await tick(20);
  });

  it('cancels a hanging body reader on caller ABORT without waiting for cancel() to settle', async () => {
    const cancel = deferred<void>();
    const { response, cancelCalls } = hangingReadResponse(200, () => cancel.promise);
    const controller = new AbortController();
    const promise = providerWith(fetchReturning(response), { timeoutMs: 10_000 }).fetchForecast(
      REQUEST,
      { signal: controller.signal },
    );
    await tick();
    controller.abort();
    expect(await promise).toEqual({ ok: false, error: { kind: 'ABORTED' } });

    await assertNoUnhandledRejection(async () => {
      await tick(20);
    });
    expect(cancelCalls()).toBe(1);
    expect(response.body?.locked).toBe(false);

    cancel.resolve();
    await tick(20);
  });

  it('a hanging body reader whose cancel() rejects never becomes an unhandled rejection', async () => {
    const marker = 'SECRET_HANGING_READ_CANCEL_REJECTION_MARKER';
    const { response, cancelCalls } = hangingReadResponse(200, () => Promise.reject(new Error(marker)));
    const result = await providerWith(fetchReturning(response), { timeoutMs: 10 }).fetchForecast(
      REQUEST,
    );
    expect(result).toEqual({ ok: false, error: { kind: 'TIMEOUT' } });
    expect(JSON.stringify(result)).not.toContain(marker);

    await assertNoUnhandledRejection(async () => {
      await tick(20);
    });
    expect(cancelCalls()).toBe(1);
  });
});

describe('fetchForecast — non-blocking response-body cancellation on an already-decided result (P2-2)', () => {
  it('returns HTTP_ERROR without waiting for a non-2xx body cancel() that never settles', async () => {
    const cancel = deferred<void>();
    const { response, cancelCalls } = hangingReadResponse(500, () => cancel.promise);
    const result = await providerWith(fetchReturning(response)).fetchForecast(REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'HTTP_ERROR', status: 500 } });
    expect(cancelCalls()).toBe(1);

    await assertNoUnhandledRejection(async () => {
      cancel.resolve();
      await tick(20);
    });
  });

  it('returns HTTP_ERROR unchanged when the non-2xx body cancel() rejects, without an unhandled rejection', async () => {
    const marker = 'SECRET_HTTP_ERROR_CANCEL_REJECTION_MARKER';
    const { response, cancelCalls } = hangingReadResponse(503, () => Promise.reject(new Error(marker)));
    const result = await providerWith(fetchReturning(response)).fetchForecast(REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'HTTP_ERROR', status: 503 } });
    expect(JSON.stringify(result)).not.toContain(marker);

    await assertNoUnhandledRejection(async () => {
      await tick(20);
    });
    expect(cancelCalls()).toBe(1);
  });
});

describe('fetchForecast — RESPONSE_TOO_LARGE outranks a concurrent abort even when cancel() hangs (P2-3)', () => {
  it('keeps RESPONSE_TOO_LARGE over a concurrent caller abort', async () => {
    const cancel = deferred<void>();
    const { response, cancelCalls } = overflowingBodyResponse(() => cancel.promise);
    const controller = new AbortController();
    const promise = providerWith(fetchReturning(response), {
      timeoutMs: 10_000,
      maxResponseBytes: 16,
    }).fetchForecast(REQUEST, { signal: controller.signal });
    // Give the overflow a chance to be detected and latched before the caller aborts.
    await tick();
    controller.abort();
    expect(await promise).toEqual({ ok: false, error: { kind: 'RESPONSE_TOO_LARGE' } });
    expect(cancelCalls()).toBe(1);

    await assertNoUnhandledRejection(async () => {
      cancel.resolve();
      await tick(20);
    });
  });

  it('keeps RESPONSE_TOO_LARGE over a concurrent TIMEOUT', async () => {
    const cancel = deferred<void>();
    const { response, cancelCalls } = overflowingBodyResponse(() => cancel.promise);
    const promise = providerWith(fetchReturning(response), {
      timeoutMs: 15,
      maxResponseBytes: 16,
    }).fetchForecast(REQUEST);
    expect(await promise).toEqual({ ok: false, error: { kind: 'RESPONSE_TOO_LARGE' } });
    expect(cancelCalls()).toBe(1);

    await assertNoUnhandledRejection(async () => {
      cancel.resolve();
      await tick(20);
    });
  });

  it('keeps RESPONSE_TOO_LARGE when the overflow cancel() synchronously fires the caller abort (deterministic)', async () => {
    // No tick()/timer involved: the overflow's own cancel() cleanup synchronously calls
    // controller.abort() before readResponseTextWithLimit returns, so this exercises the exact
    // ordering from the spec — overflow detected, cancel() called, cancel() synchronously aborts
    // the caller signal, and the already-latched RESPONSE_TOO_LARGE must still win.
    const controller = new AbortController();
    const { response, cancelCalls } = overflowingBodyResponse(() => {
      controller.abort();
    });

    const result = await providerWith(fetchReturning(response), {
      timeoutMs: 10_000,
      maxResponseBytes: 16,
    }).fetchForecast(REQUEST, { signal: controller.signal });

    expect(result).toEqual({ ok: false, error: { kind: 'RESPONSE_TOO_LARGE' } });
    expect(cancelCalls()).toBe(1);
    expect(response.body?.locked).toBe(false);
    expect('forecast' in result).toBe(false);

    await assertNoUnhandledRejection(async () => {
      await tick(20);
    });
  });
});

describe('fetchForecast — body stream failures', () => {
  it('maps a body stream error to NETWORK_ERROR', async () => {
    const result = await providerWith(
      fetchBodyStreamErrors(new Error('body boom')),
    ).fetchForecast(REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'NETWORK_ERROR' } });
  });

  it('maps a mid-body stream error to NETWORK_ERROR', async () => {
    const result = await providerWith(
      fetchBodyStreamErrors(new Error('mid-body boom'), 2),
    ).fetchForecast(REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'NETWORK_ERROR' } });
  });

  it('never exposes a raw body stream error message', async () => {
    const secret = 'SECRET_BODY_STREAM_MARKER';
    const result = await providerWith(
      fetchBodyStreamErrors(new Error(secret)),
    ).fetchForecast(REQUEST);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('does not reject its promise on a body stream error', async () => {
    await expect(
      providerWith(fetchBodyStreamErrors(new Error('boom'))).fetchForecast(REQUEST),
    ).resolves.toEqual({ ok: false, error: { kind: 'NETWORK_ERROR' } });
  });
});

describe('fetchForecast — runtime malformed request (validator totality)', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'not-a-request'],
    ['a number', 42],
    ['a boolean', true],
    ['an array', []],
  ])('returns INVALID_REQUEST without calling fetch for %s (never throws)', async (_label, malformed) => {
    const spy = vi.fn(fetchReturning(jsonOk(body())));
    let result: Awaited<ReturnType<KmaForecastProvider['fetchForecast']>>;
    await expect(
      (async () => {
        result = await providerWith(spy as unknown as typeof fetch).fetchForecast(
          malformed as unknown as KmaForecastRequest,
        );
      })(),
    ).resolves.toBeUndefined();
    expect(result!.ok).toBe(false);
    if (!result!.ok) {
      expect(result!.error.kind).toBe('INVALID_REQUEST');
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not expose the raw malformed input', async () => {
    const secret = 'SECRET_MALFORMED_REQUEST_INPUT';
    const result = await providerWith(fetchReturning(jsonOk(body()))).fetchForecast(
      secret as unknown as KmaForecastRequest,
    );
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('does not let mutating a first INVALID_REQUEST result corrupt a later call', async () => {
    const spy = vi.fn(fetchReturning(jsonOk(body())));
    const provider = providerWith(spy as unknown as typeof fetch);

    const first = await provider.fetchForecast(null as unknown as KmaForecastRequest);
    if (first.ok || first.error.kind !== 'INVALID_REQUEST') {
      throw new Error(`expected INVALID_REQUEST, got ${JSON.stringify(first)}`);
    }
    const firstArray = first.error.issues;
    const firstObjects = [...first.error.issues];
    // Tamper with the first result through runtime casts (readonly is compile-time only).
    (first.error.issues as KmaRequestIssue[]).pop();
    (firstObjects[0] as { field: string }).field = 'MUTATED';
    (firstObjects[0] as { reason: string }).reason = 'TAMPERED';

    const second = await provider.fetchForecast(undefined as unknown as KmaForecastRequest);
    if (second.ok || second.error.kind !== 'INVALID_REQUEST') {
      throw new Error(`expected INVALID_REQUEST, got ${JSON.stringify(second)}`);
    }

    // The second result carries the exact, uncorrupted five issues in fixed order.
    expect(second.error.issues.map((issue) => issue.field)).toEqual([
      'product',
      'baseDate',
      'baseTime',
      'nx',
      'ny',
    ]);
    for (const issue of second.error.issues) {
      expect(issue.reason).toBe('INVALID');
    }
    // No shared array or issue-object reference between the two calls.
    expect(second.error.issues).not.toBe(firstArray);
    for (const issue of second.error.issues) {
      expect(firstObjects).not.toContain(issue);
    }
    // Neither call touched fetch, and the tampered marker never leaked into the second result.
    expect(spy).not.toHaveBeenCalled();
    expect(JSON.stringify(second)).not.toContain('MUTATED');
    expect(JSON.stringify(second)).not.toContain('TAMPERED');
  });
});

describe('fetchForecast — HTTP status', () => {
  it.each([400, 401, 403, 404, 408, 429, 500, 503])(
    'maps HTTP %i to HTTP_ERROR with only the status',
    async (status) => {
      const result = await providerWith(
        fetchReturning(new Response('secret error page body', { status })),
      ).fetchForecast(REQUEST);
      expect(result).toEqual({ ok: false, error: { kind: 'HTTP_ERROR', status } });
    },
  );

  it('does not expose an HTTP error body', async () => {
    const result = await providerWith(
      fetchReturning(new Response('SECRET_ERROR_PAGE', { status: 500 })),
    ).fetchForecast(REQUEST);
    expect(JSON.stringify(result)).not.toContain('SECRET_ERROR_PAGE');
  });
});

describe('fetchForecast — response size', () => {
  it('rejects an over-large body with RESPONSE_TOO_LARGE', async () => {
    const huge = 'x'.repeat(10_000);
    const result = await providerWith(fetchReturning(jsonOk(huge)), {
      maxResponseBytes: 128,
    }).fetchForecast(REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'RESPONSE_TOO_LARGE' } });
  });
});

describe('fetchForecast — body format', () => {
  it('classifies an empty body as EMPTY_RESPONSE', async () => {
    const result = await providerWith(fetchReturning(new Response('', { status: 200 }))).fetchForecast(
      REQUEST,
    );
    expect(result).toEqual({ ok: false, error: { kind: 'EMPTY_RESPONSE' } });
  });

  it('classifies a whitespace-only body as EMPTY_RESPONSE', async () => {
    const result = await providerWith(fetchReturning(jsonOk('   \n\t '))).fetchForecast(REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'EMPTY_RESPONSE' } });
  });

  it('classifies malformed JSON as INVALID_JSON', async () => {
    const result = await providerWith(fetchReturning(jsonOk('{ not json'))).fetchForecast(REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'INVALID_JSON' } });
  });

  it('classifies arbitrary XML as NON_JSON_RESPONSE', async () => {
    const result = await providerWith(fetchReturning(jsonOk('<foo><bar>x</bar></foo>'))).fetchForecast(
      REQUEST,
    );
    expect(result).toEqual({ ok: false, error: { kind: 'NON_JSON_RESPONSE' } });
  });

  it('classifies HTML as NON_JSON_RESPONSE', async () => {
    const html = '<!DOCTYPE html><html><body>502</body></html>';
    const result = await providerWith(fetchReturning(jsonOk(html))).fetchForecast(REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'NON_JSON_RESPONSE' } });
  });

  it('maps a gateway XML body (with reason code) to GATEWAY_ERROR', async () => {
    const xml =
      '<OpenAPI_ServiceResponse><cmmMsgHeader><returnReasonCode>30</returnReasonCode>' +
      '<returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg></cmmMsgHeader></OpenAPI_ServiceResponse>';
    const result = await providerWith(fetchReturning(jsonOk(xml))).fetchForecast(REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'GATEWAY_ERROR', reasonCode: '30' } });
  });

  it('maps a gateway XML body (without reason code) to GATEWAY_ERROR with reasonCode null', async () => {
    const xml = '<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>x</errMsg></cmmMsgHeader></OpenAPI_ServiceResponse>';
    const result = await providerWith(fetchReturning(jsonOk(xml))).fetchForecast(REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'GATEWAY_ERROR', reasonCode: null } });
  });

  it('never exposes a secret-shaped returnAuthMsg from a gateway body', async () => {
    const secret = 'SECRET_AUTH_MSG_zZ99==';
    const xml = `<OpenAPI_ServiceResponse><returnReasonCode>30</returnReasonCode><returnAuthMsg>${secret}</returnAuthMsg></OpenAPI_ServiceResponse>`;
    const result = await providerWith(fetchReturning(jsonOk(xml))).fetchForecast(REQUEST);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe('fetchForecast — PR #4 parser connection', () => {
  it('returns a success for a normal KMA success body', async () => {
    const result = await providerWith(fetchReturning(jsonOk(body()))).fetchForecast(REQUEST);
    expect(result.ok).toBe(true);
  });

  it.each(['03', '30'])('maps upstream resultCode %s to KMA_UPSTREAM_ERROR', async (resultCode) => {
    const result = await providerWith(
      fetchReturning(jsonOk(body({ resultCode, resultMsg: 'anything' }))),
    ).fetchForecast(REQUEST);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'KMA_UPSTREAM_ERROR', resultCode },
    });
  });

  it('never exposes a raw upstream resultMsg', async () => {
    const secret = 'SECRET_RESULT_MSG_marker';
    const result = await providerWith(
      fetchReturning(jsonOk(body({ resultCode: '03', resultMsg: secret }))),
    ).fetchForecast(REQUEST);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('maps a malformed success body to KMA_INVALID_RESPONSE with sanitized issues', async () => {
    const malformed = JSON.stringify({
      response: {
        header: { resultCode: '00', resultMsg: 'NORMAL_SERVICE' },
        body: {
          dataType: 'JSON',
          pageNo: 1,
          numOfRows: 1000,
          totalCount: 1,
          items: { item: [{ baseDate: '20260716' }] }, // missing required fields
        },
      },
    });
    const result = await providerWith(fetchReturning(jsonOk(malformed))).fetchForecast(REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'KMA_INVALID_RESPONSE') {
      expect(result.error.issues.length).toBeGreaterThan(0);
      for (const issue of result.error.issues) {
        expect(Array.isArray(issue.path)).toBe(true);
        expect(typeof issue.message).toBe('string');
      }
    } else {
      throw new Error(`expected KMA_INVALID_RESPONSE, got ${JSON.stringify(result)}`);
    }
  });

  it('maps a malformed resultCode to KMA_INVALID_RESPONSE (not upstream error)', async () => {
    const result = await providerWith(
      fetchReturning(jsonOk(body({ resultCode: '0' }))),
    ).fetchForecast(REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('KMA_INVALID_RESPONSE');
    }
  });
});

describe('fetchForecast — request/response correlation', () => {
  it('flags a pageNo mismatch', async () => {
    const result = await providerWith(
      fetchReturning(jsonOk(body({ pageNo: 2 }))),
    ).fetchForecast(REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'RESPONSE_MISMATCH', field: 'pageNo' } });
  });

  it('flags a numOfRows mismatch', async () => {
    const result = await providerWith(
      fetchReturning(jsonOk(body({ numOfRows: 500, totalCount: 1 }))),
    ).fetchForecast(REQUEST);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'RESPONSE_MISMATCH', field: 'numOfRows' },
    });
  });

  it.each([
    ['baseDate', { baseDate: '20260717' }],
    ['baseTime', { baseTime: '0600' }],
    ['nx', { nx: 61 }],
    ['ny', { ny: 128 }],
  ])('flags a %s mismatch on an item', async (field, overrides) => {
    const result = await providerWith(
      fetchReturning(jsonOk(body({ items: [item(overrides)] }))),
    ).fetchForecast(REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'RESPONSE_MISMATCH', field } });
  });

  it('reports the highest-priority field when several mismatch', async () => {
    // baseDate is earlier in the fixed order than nx, so baseDate wins.
    const result = await providerWith(
      fetchReturning(jsonOk(body({ items: [item({ baseDate: '20260717', nx: 61 })] }))),
    ).fetchForecast(REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'RESPONSE_MISMATCH', field: 'baseDate' } });
  });

  it('is independent of item order', async () => {
    const good = item();
    const bad = item({ baseTime: '0600' });
    const forward = await providerWith(
      fetchReturning(jsonOk(body({ items: [good, bad], totalCount: 2 }))),
    ).fetchForecast(REQUEST);
    const reverse = await providerWith(
      fetchReturning(jsonOk(body({ items: [bad, good], totalCount: 2 }))),
    ).fetchForecast(REQUEST);
    expect(forward).toEqual(reverse);
    expect(forward).toEqual({ ok: false, error: { kind: 'RESPONSE_MISMATCH', field: 'baseTime' } });
  });

  it('flags an incomplete page when totalCount exceeds the received count', async () => {
    const items = [item({ category: 'TMP' }), item({ category: 'SKY', fcstValue: '1' })];
    const result = await providerWith(
      fetchReturning(jsonOk(body({ items, totalCount: 5 }))),
    ).fetchForecast(REQUEST);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'INCOMPLETE_PAGE', totalCount: 5, receivedCount: 2 },
    });
  });

  it('accepts an empty page with totalCount 0', async () => {
    const result = await providerWith(
      fetchReturning(jsonOk(body({ items: [], totalCount: 0 }))),
    ).fetchForecast(REQUEST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.forecast.totalCount).toBe(0);
      expect(result.forecast.slots).toEqual([]);
    }
  });

  it('accepts a complete page', async () => {
    const items = [item({ category: 'TMP' }), item({ category: 'SKY', fcstValue: '1' })];
    const result = await providerWith(
      fetchReturning(jsonOk(body({ items, totalCount: 2 }))),
    ).fetchForecast(REQUEST);
    expect(result.ok).toBe(true);
  });
});

describe('fetchForecast — slot grouping connection', () => {
  it('groups items into slots and preserves the SHORT_FORECAST product', async () => {
    const result = await providerWith(fetchReturning(jsonOk(body()))).fetchForecast(REQUEST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.forecast.product).toBe(KmaForecastProduct.SHORT_FORECAST);
      expect(result.forecast.slots.length).toBeGreaterThan(0);
      expect(result.forecast.slots[0].product).toBe(KmaForecastProduct.SHORT_FORECAST);
    }
  });

  it('preserves the ULTRA_SHORT_FORECAST product', async () => {
    const result = await providerWith(fetchReturning(jsonOk(body()))).fetchForecast({
      ...REQUEST,
      product: KmaForecastProduct.ULTRA_SHORT_FORECAST,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.forecast.product).toBe(KmaForecastProduct.ULTRA_SHORT_FORECAST);
      expect(result.forecast.slots[0].product).toBe(KmaForecastProduct.ULTRA_SHORT_FORECAST);
    }
  });

  it('preserves the ABSENT / NULL / VALUE field-presence distinction', async () => {
    const items = [
      item({ category: 'TMP', fcstValue: '25' }),
      item({ category: 'REH', fcstValue: null }),
    ];
    const result = await providerWith(
      fetchReturning(jsonOk(body({ items, totalCount: 2 }))),
    ).fetchForecast(REQUEST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const slot = result.forecast.slots[0];
      expect(getKmaForecastField(slot, 'TMP')).toEqual({ state: 'VALUE', value: '25' });
      expect(getKmaForecastField(slot, 'REH')).toEqual({ state: 'NULL' });
      expect(getKmaForecastField(slot, 'PTY')).toEqual({ state: 'ABSENT' });
    }
  });

  it('preserves an unknown but structurally valid category', async () => {
    const result = await providerWith(
      fetchReturning(jsonOk(body({ items: [item({ category: 'ABCD' })] }))),
    ).fetchForecast(REQUEST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(getKmaForecastField(result.forecast.slots[0], 'ABCD')).toEqual({
        state: 'VALUE',
        value: '25',
      });
    }
  });

  it('maps a duplicate category to DUPLICATE_CATEGORY', async () => {
    const items = [item({ category: 'TMP' }), item({ category: 'TMP' })];
    const result = await providerWith(
      fetchReturning(jsonOk(body({ items, totalCount: 2 }))),
    ).fetchForecast(REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'DUPLICATE_CATEGORY') {
      expect(result.error.category).toBe('TMP');
      expect(typeof result.error.slotKey).toBe('string');
    } else {
      throw new Error(`expected DUPLICATE_CATEGORY, got ${JSON.stringify(result)}`);
    }
  });

  it('sorts slots deterministically by forecast time', async () => {
    const items = [
      item({ fcstTime: '0700', category: 'TMP' }),
      item({ fcstTime: '0600', category: 'TMP' }),
    ];
    const result = await providerWith(
      fetchReturning(jsonOk(body({ items, totalCount: 2 }))),
    ).fetchForecast(REQUEST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.forecast.slots.map((slot) => slot.forecastTime)).toEqual(['0600', '0700']);
    }
  });

  it('does not mutate the request object', async () => {
    const request = deepFreeze({ ...REQUEST });
    const result = await providerWith(fetchReturning(jsonOk(body()))).fetchForecast(request);
    expect(result.ok).toBe(true);
    expect(request).toEqual(REQUEST);
  });

  it('is deterministic for the same mocked response', async () => {
    const first = await providerWith(fetchReturning(jsonOk(body()))).fetchForecast(REQUEST);
    const second = await providerWith(fetchReturning(jsonOk(body()))).fetchForecast(REQUEST);
    expect(first).toEqual(second);
  });
});

describe('fetchForecast — success result shape', () => {
  it('returns request identity, totalCount, and slots without any raw upstream data', async () => {
    const result = await providerWith(fetchReturning(jsonOk(body()))).fetchForecast(REQUEST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.forecast).toMatchObject({
        product: KmaForecastProduct.SHORT_FORECAST,
        baseDate: '20260716',
        baseTime: '0500',
        nx: 60,
        ny: 127,
        totalCount: 1,
      });
      const serialized = JSON.stringify(result.forecast);
      expect(serialized).not.toContain(FAKE_KEY);
      expect(serialized).not.toContain('apis.data.go.kr');
      expect(serialized).not.toContain('ServiceKey');
      expect(serialized).not.toContain('resultMsg');
      expect(serialized).not.toContain('NORMAL_SERVICE');
    }
  });
});

describe('fetchForecast — secret non-exposure across error variants', () => {
  const gatewaySecret = 'GATEWAY_SECRET_AUTH==';
  const gatewayXml = `<OpenAPI_ServiceResponse><returnReasonCode>30</returnReasonCode><returnAuthMsg>${gatewaySecret}</returnAuthMsg></OpenAPI_ServiceResponse>`;

  const scenarios: { name: string; fetchImpl: typeof fetch; forbidden: string[] }[] = [
    {
      name: 'HTTP_ERROR',
      fetchImpl: fetchReturning(new Response('SECRET_HTTP_BODY', { status: 500 })),
      forbidden: ['SECRET_HTTP_BODY'],
    },
    {
      name: 'NETWORK_ERROR',
      fetchImpl: fetchRejecting(new Error('SECRET_NETWORK_EXCEPTION')),
      forbidden: ['SECRET_NETWORK_EXCEPTION'],
    },
    {
      name: 'GATEWAY_ERROR',
      fetchImpl: fetchReturning(jsonOk(gatewayXml)),
      forbidden: [gatewaySecret],
    },
    {
      name: 'KMA_UPSTREAM_ERROR',
      fetchImpl: fetchReturning(jsonOk(body({ resultCode: '03', resultMsg: 'SECRET_UPSTREAM_MSG' }))),
      forbidden: ['SECRET_UPSTREAM_MSG'],
    },
    {
      name: 'INVALID_JSON',
      fetchImpl: fetchReturning(jsonOk('{ "SECRET_JSON_FRAGMENT": ')),
      forbidden: ['SECRET_JSON_FRAGMENT'],
    },
  ];

  it.each(scenarios)('$name never leaks secrets or the URL/key', async ({ fetchImpl, forbidden }) => {
    const result = await providerWith(fetchImpl).fetchForecast(REQUEST);
    const serialized = JSON.stringify(result);
    for (const secret of [...forbidden, FAKE_KEY, 'apis.data.go.kr', 'ServiceKey']) {
      expect(serialized).not.toContain(secret);
    }
  });
});

// ---------------------------------------------------------------------------
// fetchCurrentObservation (PR #63 — 초단기실황, getUltraSrtNcst)
// ---------------------------------------------------------------------------

const CURRENT_REQUEST: KmaCurrentObservationRequest = {
  baseDate: '20260716',
  baseTime: '0600',
  nx: 60,
  ny: 127,
};

interface RawCurrentItem {
  baseDate: string;
  baseTime: string;
  category: string;
  obsrValue: string | null;
  nx: number;
  ny: number;
}

/** A raw current-observation item that matches {@link CURRENT_REQUEST}'s identity unless overridden. */
function currentItem(overrides: Partial<RawCurrentItem> = {}): RawCurrentItem {
  return {
    baseDate: '20260716',
    baseTime: '0600',
    category: 'T1H',
    obsrValue: '23.5',
    nx: 60,
    ny: 127,
    ...overrides,
  };
}

interface CurrentBodyOptions {
  pageNo?: number;
  numOfRows?: number;
  totalCount?: number;
  items?: readonly RawCurrentItem[];
  resultCode?: string;
  resultMsg?: string;
}

/** Serialize a KMA current-observation success/error envelope to a JSON string. */
function currentBody(options: CurrentBodyOptions = {}): string {
  const items = options.items ?? [currentItem()];
  return JSON.stringify({
    response: {
      header: {
        resultCode: options.resultCode ?? '00',
        resultMsg: options.resultMsg ?? 'NORMAL_SERVICE',
      },
      body: {
        dataType: 'JSON',
        pageNo: options.pageNo ?? 1,
        numOfRows: options.numOfRows ?? 1000,
        totalCount: options.totalCount ?? items.length,
        items: { item: items },
      },
    },
  });
}

function currentProviderWith(
  fetchImpl: typeof fetch,
  options: { timeoutMs?: number; maxResponseBytes?: number } = {},
): KmaCurrentObservationProvider {
  const created = createKmaCurrentObservationProvider({
    serviceKey: FAKE_KEY,
    fetchImpl,
    ...options,
  });
  if (!created.ok) {
    throw new Error('unexpected config error in test setup');
  }
  return created.provider;
}

describe('fetchCurrentObservation — request validation', () => {
  it('returns INVALID_REQUEST without calling fetch for a bad request', async () => {
    const spy = vi.fn(fetchReturning(jsonOk(currentBody())));
    const result = await currentProviderWith(
      spy as unknown as typeof fetch,
    ).fetchCurrentObservation({ ...CURRENT_REQUEST, baseTime: '2400' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('INVALID_REQUEST');
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('fetchCurrentObservation — fetch options', () => {
  it('issues a GET with Accept: application/json, redirect: error, and an AbortSignal', async () => {
    const calls: { input: unknown; init: RequestInit | undefined }[] = [];
    const fetchImpl = ((input: unknown, init?: RequestInit) => {
      calls.push({ input, init });
      return Promise.resolve(jsonOk(currentBody()));
    }) as unknown as typeof fetch;

    await currentProviderWith(fetchImpl).fetchCurrentObservation(CURRENT_REQUEST);

    expect(calls).toHaveLength(1);
    const { input, init } = calls[0]!;
    expect(input).toBeInstanceOf(URL);
    expect((input as URL).pathname.endsWith('/getUltraSrtNcst')).toBe(true);
    expect(init?.method).toBe('GET');
    expect(init?.headers).toEqual({ Accept: 'application/json' });
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('does not log the URL or service key', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await currentProviderWith(fetchReturning(jsonOk(currentBody()))).fetchCurrentObservation(
      CURRENT_REQUEST,
    );

    for (const spy of [logSpy, errorSpy, warnSpy]) {
      expect(spy).not.toHaveBeenCalled();
    }
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe('fetchCurrentObservation — timeout & caller abort (shared transport)', () => {
  it('maps a provider timeout to TIMEOUT', async () => {
    const result = await currentProviderWith(fetchHangingUntilAbort(), {
      timeoutMs: 10,
    }).fetchCurrentObservation(CURRENT_REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'TIMEOUT' } });
  });

  it('returns ABORTED without calling fetch when the caller signal is already aborted', async () => {
    const spy = vi.fn(fetchReturning(jsonOk(currentBody())));
    const controller = new AbortController();
    controller.abort();
    const result = await currentProviderWith(
      spy as unknown as typeof fetch,
    ).fetchCurrentObservation(CURRENT_REQUEST, { signal: controller.signal });
    expect(result).toEqual({ ok: false, error: { kind: 'ABORTED' } });
    expect(spy).not.toHaveBeenCalled();
  });

  it('maps a mid-flight caller abort to ABORTED', async () => {
    const controller = new AbortController();
    const promise = currentProviderWith(fetchHangingUntilAbort(), {
      timeoutMs: 10_000,
    }).fetchCurrentObservation(CURRENT_REQUEST, { signal: controller.signal });
    controller.abort();
    expect(await promise).toEqual({ ok: false, error: { kind: 'ABORTED' } });
  });

  it('maps a generic fetch rejection to NETWORK_ERROR', async () => {
    const result = await currentProviderWith(
      fetchRejecting(new Error('boom')),
    ).fetchCurrentObservation(CURRENT_REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'NETWORK_ERROR' } });
  });

  it('never exposes a fetch exception message', async () => {
    const secret = 'SECRET_CURRENT_FETCH_EXCEPTION_MARKER';
    const result = await currentProviderWith(
      fetchRejecting(new Error(secret)),
    ).fetchCurrentObservation(CURRENT_REQUEST);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('enforces the timeout while the body stalls after the header arrives (→ TIMEOUT)', async () => {
    const { fetchImpl, bodyObservedAbort } = fetchHeaderThenBodyTiedToSignal();
    const result = await currentProviderWith(fetchImpl, {
      timeoutMs: 10,
    }).fetchCurrentObservation(CURRENT_REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'TIMEOUT' } });
    expect(bodyObservedAbort()).toBe(true);
  });

  it('applies a caller abort while the body is being read after the header arrives (→ ABORTED)', async () => {
    const { fetchImpl, bodyObservedAbort } = fetchHeaderThenBodyTiedToSignal();
    const controller = new AbortController();
    const promise = currentProviderWith(fetchImpl, {
      timeoutMs: 10_000,
    }).fetchCurrentObservation(CURRENT_REQUEST, { signal: controller.signal });
    await tick();
    controller.abort();
    expect(await promise).toEqual({ ok: false, error: { kind: 'ABORTED' } });
    expect(bodyObservedAbort()).toBe(true);
  });
});

describe('fetchCurrentObservation — transport terminates even when fetchImpl/body ignores the abort signal (shared transport)', () => {
  it('a pending fetch that ignores the signal still resolves TIMEOUT within the timeout', async () => {
    const result = await currentProviderWith(fetchIgnoringAbortForever(), {
      timeoutMs: 10,
    }).fetchCurrentObservation(CURRENT_REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'TIMEOUT' } });
  });

  it('a pending body read that ignores the signal still resolves TIMEOUT within the timeout', async () => {
    const result = await currentProviderWith(fetchWithHangingBody(), {
      timeoutMs: 10,
    }).fetchCurrentObservation(CURRENT_REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'TIMEOUT' } });
  });

  it('a fetch that resolves late (after TIMEOUT) never changes the result and its body is cancelled', async () => {
    const { fetchImpl, resolveWith } = controllableFetch();
    const result = await currentProviderWith(fetchImpl, {
      timeoutMs: 10,
    }).fetchCurrentObservation(CURRENT_REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'TIMEOUT' } });

    const late = controllableHangingBodyResponse();
    await assertNoUnhandledRejection(async () => {
      resolveWith(late.response);
      await tick(20);
    });
    expect(late.wasCancelled()).toBe(true);
  });

  it('cancels a hanging body reader on TIMEOUT without waiting for cancel() to settle (P2-1)', async () => {
    const cancel = deferred<void>();
    const { response, cancelCalls } = hangingReadResponse(200, () => cancel.promise);
    const result = await currentProviderWith(fetchReturning(response), {
      timeoutMs: 10,
    }).fetchCurrentObservation(CURRENT_REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'TIMEOUT' } });

    await assertNoUnhandledRejection(async () => {
      await tick(20);
    });
    expect(cancelCalls()).toBe(1);
    expect(response.body?.locked).toBe(false);

    cancel.resolve();
    await tick(20);
  });

  it('returns HTTP_ERROR without waiting for a non-2xx body cancel() that never settles (P2-2)', async () => {
    const cancel = deferred<void>();
    const { response, cancelCalls } = hangingReadResponse(500, () => cancel.promise);
    const result = await currentProviderWith(fetchReturning(response)).fetchCurrentObservation(
      CURRENT_REQUEST,
    );
    expect(result).toEqual({ ok: false, error: { kind: 'HTTP_ERROR', status: 500 } });
    expect(cancelCalls()).toBe(1);

    await assertNoUnhandledRejection(async () => {
      cancel.resolve();
      await tick(20);
    });
  });

  it('keeps RESPONSE_TOO_LARGE over a concurrent TIMEOUT even when cancel() hangs (P2-3)', async () => {
    const cancel = deferred<void>();
    const { response, cancelCalls } = overflowingBodyResponse(() => cancel.promise);
    const promise = currentProviderWith(fetchReturning(response), {
      timeoutMs: 15,
      maxResponseBytes: 16,
    }).fetchCurrentObservation(CURRENT_REQUEST);
    expect(await promise).toEqual({ ok: false, error: { kind: 'RESPONSE_TOO_LARGE' } });
    expect(cancelCalls()).toBe(1);

    await assertNoUnhandledRejection(async () => {
      cancel.resolve();
      await tick(20);
    });
  });

  it('keeps RESPONSE_TOO_LARGE when the overflow cancel() synchronously fires the caller abort (deterministic, mirrored)', async () => {
    const controller = new AbortController();
    const { response, cancelCalls } = overflowingBodyResponse(() => {
      controller.abort();
    });

    const result = await currentProviderWith(fetchReturning(response), {
      timeoutMs: 10_000,
      maxResponseBytes: 16,
    }).fetchCurrentObservation(CURRENT_REQUEST, { signal: controller.signal });

    expect(result).toEqual({ ok: false, error: { kind: 'RESPONSE_TOO_LARGE' } });
    expect(cancelCalls()).toBe(1);

    await assertNoUnhandledRejection(async () => {
      await tick(20);
    });
  });
});

describe('fetchCurrentObservation — body stream failures (shared transport)', () => {
  it('maps a body stream error to NETWORK_ERROR', async () => {
    const result = await currentProviderWith(
      fetchBodyStreamErrors(new Error('body boom')),
    ).fetchCurrentObservation(CURRENT_REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'NETWORK_ERROR' } });
  });

  it('never exposes a raw body stream error message', async () => {
    const secret = 'SECRET_CURRENT_BODY_STREAM_MARKER';
    const result = await currentProviderWith(
      fetchBodyStreamErrors(new Error(secret)),
    ).fetchCurrentObservation(CURRENT_REQUEST);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe('fetchCurrentObservation — runtime malformed request (validator totality)', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'not-a-request'],
    ['a number', 42],
    ['an array', []],
  ])('returns INVALID_REQUEST without calling fetch for %s', async (_label, input) => {
    const spy = vi.fn(fetchReturning(jsonOk(currentBody())));
    const result = await currentProviderWith(
      spy as unknown as typeof fetch,
    ).fetchCurrentObservation(input as unknown as KmaCurrentObservationRequest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('INVALID_REQUEST');
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('fetchCurrentObservation — HTTP status', () => {
  it.each([400, 401, 403, 404, 500, 503])(
    'maps HTTP %i to HTTP_ERROR with only the status',
    async (status) => {
      const result = await currentProviderWith(
        fetchReturning(new Response('secret error page body', { status })),
      ).fetchCurrentObservation(CURRENT_REQUEST);
      expect(result).toEqual({ ok: false, error: { kind: 'HTTP_ERROR', status } });
    },
  );

  it('does not expose an HTTP error body', async () => {
    const result = await currentProviderWith(
      fetchReturning(new Response('SECRET_ERROR_PAGE', { status: 500 })),
    ).fetchCurrentObservation(CURRENT_REQUEST);
    expect(JSON.stringify(result)).not.toContain('SECRET_ERROR_PAGE');
  });
});

describe('fetchCurrentObservation — response size', () => {
  it('rejects an over-large body with RESPONSE_TOO_LARGE', async () => {
    const huge = 'x'.repeat(10_000);
    const result = await currentProviderWith(fetchReturning(jsonOk(huge)), {
      maxResponseBytes: 128,
    }).fetchCurrentObservation(CURRENT_REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'RESPONSE_TOO_LARGE' } });
  });
});

describe('fetchCurrentObservation — body format (shared classification)', () => {
  it('classifies an empty body as EMPTY_RESPONSE', async () => {
    const result = await currentProviderWith(
      fetchReturning(new Response('', { status: 200 })),
    ).fetchCurrentObservation(CURRENT_REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'EMPTY_RESPONSE' } });
  });

  it('classifies malformed JSON as INVALID_JSON', async () => {
    const result = await currentProviderWith(
      fetchReturning(jsonOk('{ not json')),
    ).fetchCurrentObservation(CURRENT_REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'INVALID_JSON' } });
  });

  it('classifies arbitrary XML as NON_JSON_RESPONSE', async () => {
    const result = await currentProviderWith(
      fetchReturning(jsonOk('<foo><bar>x</bar></foo>')),
    ).fetchCurrentObservation(CURRENT_REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'NON_JSON_RESPONSE' } });
  });

  it('maps a gateway XML body (with reason code) to GATEWAY_ERROR', async () => {
    const xml =
      '<OpenAPI_ServiceResponse><cmmMsgHeader><returnReasonCode>30</returnReasonCode>' +
      '<returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg></cmmMsgHeader></OpenAPI_ServiceResponse>';
    const result = await currentProviderWith(
      fetchReturning(jsonOk(xml)),
    ).fetchCurrentObservation(CURRENT_REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'GATEWAY_ERROR', reasonCode: '30' } });
  });

  it('never exposes a secret-shaped returnAuthMsg from a gateway body', async () => {
    const secret = 'CURRENT_GATEWAY_SECRET_AUTH==';
    const xml = `<OpenAPI_ServiceResponse><returnReasonCode>30</returnReasonCode><returnAuthMsg>${secret}</returnAuthMsg></OpenAPI_ServiceResponse>`;
    const result = await currentProviderWith(
      fetchReturning(jsonOk(xml)),
    ).fetchCurrentObservation(CURRENT_REQUEST);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe('fetchCurrentObservation — response parser connection', () => {
  it('returns a success for a normal KMA success body', async () => {
    const result = await currentProviderWith(
      fetchReturning(jsonOk(currentBody())),
    ).fetchCurrentObservation(CURRENT_REQUEST);
    expect(result.ok).toBe(true);
  });

  it.each(['03', '30'])('maps upstream resultCode %s to KMA_UPSTREAM_ERROR', async (resultCode) => {
    const result = await currentProviderWith(
      fetchReturning(jsonOk(currentBody({ resultCode, resultMsg: 'anything' }))),
    ).fetchCurrentObservation(CURRENT_REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'KMA_UPSTREAM_ERROR', resultCode } });
  });

  it('never exposes a raw upstream resultMsg', async () => {
    const secret = 'SECRET_CURRENT_RESULT_MSG_marker';
    const result = await currentProviderWith(
      fetchReturning(jsonOk(currentBody({ resultCode: '03', resultMsg: secret }))),
    ).fetchCurrentObservation(CURRENT_REQUEST);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('maps a malformed success body to KMA_INVALID_RESPONSE with sanitized issues', async () => {
    const malformed = JSON.stringify({
      response: {
        header: { resultCode: '00', resultMsg: 'NORMAL_SERVICE' },
        body: {
          dataType: 'JSON',
          pageNo: 1,
          numOfRows: 1000,
          totalCount: 1,
          items: { item: [{ baseDate: '20260716' }] }, // missing required fields
        },
      },
    });
    const result = await currentProviderWith(
      fetchReturning(jsonOk(malformed)),
    ).fetchCurrentObservation(CURRENT_REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'KMA_INVALID_RESPONSE') {
      expect(result.error.issues.length).toBeGreaterThan(0);
      for (const issue of result.error.issues) {
        expect(Array.isArray(issue.path)).toBe(true);
        expect(typeof issue.message).toBe('string');
      }
    } else {
      throw new Error(`expected KMA_INVALID_RESPONSE, got ${JSON.stringify(result)}`);
    }
  });
});

describe('fetchCurrentObservation — request/response correlation', () => {
  it('flags a pageNo mismatch', async () => {
    const result = await currentProviderWith(
      fetchReturning(jsonOk(currentBody({ pageNo: 2 }))),
    ).fetchCurrentObservation(CURRENT_REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'RESPONSE_MISMATCH', field: 'pageNo' } });
  });

  it.each([
    ['baseDate', { baseDate: '20260717' }],
    ['baseTime', { baseTime: '0700' }],
    ['nx', { nx: 61 }],
    ['ny', { ny: 128 }],
  ])('flags a %s mismatch on an item', async (field, overrides) => {
    const result = await currentProviderWith(
      fetchReturning(jsonOk(currentBody({ items: [currentItem(overrides)] }))),
    ).fetchCurrentObservation(CURRENT_REQUEST);
    expect(result).toEqual({ ok: false, error: { kind: 'RESPONSE_MISMATCH', field } });
  });

  it('never reveals the actual mismatched date/time/grid value', async () => {
    const result = await currentProviderWith(
      fetchReturning(jsonOk(currentBody({ items: [currentItem({ baseDate: '20260717' })] }))),
    ).fetchCurrentObservation(CURRENT_REQUEST);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('20260717');
    expect(serialized).toEqual(
      JSON.stringify({ ok: false, error: { kind: 'RESPONSE_MISMATCH', field: 'baseDate' } }),
    );
  });

  it('flags an incomplete page when totalCount exceeds the received count', async () => {
    const items = [currentItem({ category: 'T1H' }), currentItem({ category: 'REH' })];
    const result = await currentProviderWith(
      fetchReturning(jsonOk(currentBody({ items, totalCount: 5 }))),
    ).fetchCurrentObservation(CURRENT_REQUEST);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'INCOMPLETE_PAGE', totalCount: 5, receivedCount: 2 },
    });
  });

  it('accepts an empty page with totalCount 0 (slot is null)', async () => {
    const result = await currentProviderWith(
      fetchReturning(jsonOk(currentBody({ items: [], totalCount: 0 }))),
    ).fetchCurrentObservation(CURRENT_REQUEST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.observation.totalCount).toBe(0);
      expect(result.observation.slot).toBeNull();
    }
  });
});

describe('fetchCurrentObservation — grouping connection', () => {
  it('groups items into a single slot at most (post-correlation identity is unique)', async () => {
    const items = [
      currentItem({ category: 'T1H', obsrValue: '23.5' }),
      currentItem({ category: 'REH', obsrValue: '55' }),
    ];
    const result = await currentProviderWith(
      fetchReturning(jsonOk(currentBody({ items, totalCount: 2 }))),
    ).fetchCurrentObservation(CURRENT_REQUEST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.observation.slot).not.toBeNull();
    }
  });

  it('preserves the ABSENT / NULL / VALUE field-presence distinction', async () => {
    const items = [
      currentItem({ category: 'T1H', obsrValue: '23.5' }),
      currentItem({ category: 'REH', obsrValue: null }),
    ];
    const result = await currentProviderWith(
      fetchReturning(jsonOk(currentBody({ items, totalCount: 2 }))),
    ).fetchCurrentObservation(CURRENT_REQUEST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const slot = result.observation.slot!;
      expect(getKmaCurrentObservationField(slot, 'T1H')).toEqual({
        state: 'VALUE',
        value: '23.5',
      });
      expect(getKmaCurrentObservationField(slot, 'REH')).toEqual({ state: 'NULL' });
      expect(getKmaCurrentObservationField(slot, 'VEC')).toEqual({ state: 'ABSENT' });
    }
  });

  it('maps a duplicate category to DUPLICATE_CATEGORY', async () => {
    const items = [currentItem({ category: 'T1H' }), currentItem({ category: 'T1H' })];
    const result = await currentProviderWith(
      fetchReturning(jsonOk(currentBody({ items, totalCount: 2 }))),
    ).fetchCurrentObservation(CURRENT_REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'DUPLICATE_CATEGORY') {
      expect(result.error.category).toBe('T1H');
      expect(typeof result.error.slotKey).toBe('string');
    } else {
      throw new Error(`expected DUPLICATE_CATEGORY, got ${JSON.stringify(result)}`);
    }
  });

  it('does not mutate the request object', async () => {
    const request = deepFreeze({ ...CURRENT_REQUEST });
    const result = await currentProviderWith(
      fetchReturning(jsonOk(currentBody())),
    ).fetchCurrentObservation(request);
    expect(result.ok).toBe(true);
    expect(request).toEqual(CURRENT_REQUEST);
  });

  it('is deterministic for the same mocked response', async () => {
    const first = await currentProviderWith(
      fetchReturning(jsonOk(currentBody())),
    ).fetchCurrentObservation(CURRENT_REQUEST);
    const second = await currentProviderWith(
      fetchReturning(jsonOk(currentBody())),
    ).fetchCurrentObservation(CURRENT_REQUEST);
    expect(first).toEqual(second);
  });
});

describe('fetchCurrentObservation — success result shape', () => {
  it('returns request identity, totalCount, and a slot without any raw upstream data', async () => {
    const result = await currentProviderWith(
      fetchReturning(jsonOk(currentBody())),
    ).fetchCurrentObservation(CURRENT_REQUEST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.observation).toMatchObject({
        baseDate: '20260716',
        baseTime: '0600',
        nx: 60,
        ny: 127,
        totalCount: 1,
      });
      const serialized = JSON.stringify(result.observation);
      expect(serialized).not.toContain(FAKE_KEY);
      expect(serialized).not.toContain('apis.data.go.kr');
      expect(serialized).not.toContain('ServiceKey');
      expect(serialized).not.toContain('resultMsg');
      expect(serialized).not.toContain('NORMAL_SERVICE');
    }
  });
});

describe('fetchCurrentObservation — secret non-exposure across error variants', () => {
  const gatewaySecret = 'CURRENT_GATEWAY_SECRET_AUTH==';
  const gatewayXml = `<OpenAPI_ServiceResponse><returnReasonCode>30</returnReasonCode><returnAuthMsg>${gatewaySecret}</returnAuthMsg></OpenAPI_ServiceResponse>`;

  const scenarios: { name: string; fetchImpl: typeof fetch; forbidden: string[] }[] = [
    {
      name: 'HTTP_ERROR',
      fetchImpl: fetchReturning(new Response('SECRET_HTTP_BODY', { status: 500 })),
      forbidden: ['SECRET_HTTP_BODY'],
    },
    {
      name: 'NETWORK_ERROR',
      fetchImpl: fetchRejecting(new Error('SECRET_NETWORK_EXCEPTION')),
      forbidden: ['SECRET_NETWORK_EXCEPTION'],
    },
    {
      name: 'GATEWAY_ERROR',
      fetchImpl: fetchReturning(jsonOk(gatewayXml)),
      forbidden: [gatewaySecret],
    },
    {
      name: 'KMA_UPSTREAM_ERROR',
      fetchImpl: fetchReturning(
        jsonOk(currentBody({ resultCode: '03', resultMsg: 'SECRET_UPSTREAM_MSG' })),
      ),
      forbidden: ['SECRET_UPSTREAM_MSG'],
    },
  ];

  it.each(scenarios)('$name never leaks secrets or the URL/key', async ({ fetchImpl, forbidden }) => {
    const result = await currentProviderWith(fetchImpl).fetchCurrentObservation(CURRENT_REQUEST);
    const serialized = JSON.stringify(result);
    for (const secret of [...forbidden, FAKE_KEY, 'apis.data.go.kr', 'ServiceKey']) {
      expect(serialized).not.toContain(secret);
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
