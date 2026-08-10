import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createKmaLiveCurrentSourceMetadataResolver,
  type KmaCurrentSourceMetadataClock,
} from './kma-current-source-metadata.js';

/**
 * These tests exercise the PR #73 live current source metadata resolver in isolation. It is a
 * nullary resolver (unlike the PR #26 hourly resolver, it takes no input — current observation has
 * no issuance identity or PRIMARY/PREVIOUS selection to correlate), so every fixture here is just an
 * injected clock. Every fixture is built fresh per test — no shared mutable clock — so call counts,
 * references, and error identity are directly assertable. The static error-message string the
 * runtime uses is duplicated here as a constant; it is module-local in the runtime and is asserted
 * for its exact static value (never carrying the raw malformed input).
 */

// ---------------------------------------------------------------------------
// Static error message (duplicated from the runtime; asserted verbatim).
// ---------------------------------------------------------------------------

const INVALID_CLOCK_MESSAGE = 'Invalid KMA current source metadata clock value';

// ---------------------------------------------------------------------------
// Fixed canonical sourceId and exact metadata key contracts.
// ---------------------------------------------------------------------------

const CANONICAL_SOURCE_ID = 'kma-ultra-short-current-observation';

/** The exact sorted own keys of the resolver's output metadata object. */
const METADATA_KEYS = ['fetchedAt', 'retrievalMode', 'sourceId'] as const;

/** Fields that must never appear on the resolver output — no transport/location/request leakage. */
const FORBIDDEN_METADATA_KEYS = [
  'provider',
  'sections',
  'issuedAt',
  'observedAt',
  'location',
  'latitude',
  'longitude',
  'nx',
  'ny',
  'request',
  'baseDate',
  'baseTime',
  'serviceKey',
  'ServiceKey',
  'url',
  'query',
  'raw',
  'rawBody',
  'id',
] as const;

// ---------------------------------------------------------------------------
// A fixed clock instant: 2026-08-09T12:34:56.789Z. `Date.UTC` is a pure static
// computation (not a global-Date replacement), so the epoch and its ISO string
// are tied together for the assertions.
// ---------------------------------------------------------------------------

const FETCHED_AT_EPOCH_MS = Date.UTC(2026, 7, 9, 12, 34, 56, 789);
const FETCHED_AT_ISO = '2026-08-09T12:34:56.789Z';

/** UTC `Z` with exactly three fractional-second digits. */
const UTC_MILLISECONDS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ---------------------------------------------------------------------------
// Clock stubs.
// ---------------------------------------------------------------------------

/** A fresh fake clock that returns a fixed epoch and records its calls. */
function makeClock(value: number = FETCHED_AT_EPOCH_MS) {
  const nowEpochMilliseconds = vi.fn((): number => value);
  const clock: KmaCurrentSourceMetadataClock = { nowEpochMilliseconds };
  return { clock, nowEpochMilliseconds };
}

/** A fresh fake clock that throws the given error, recording its calls. */
function makeThrowingClock(error: unknown) {
  const nowEpochMilliseconds = vi.fn((): number => {
    throw error;
  });
  const clock: KmaCurrentSourceMetadataClock = { nowEpochMilliseconds };
  return { clock, nowEpochMilliseconds };
}

// ---------------------------------------------------------------------------
// Assertion helpers.
// ---------------------------------------------------------------------------

/** Capture whatever a thunk throws synchronously, or `undefined` when it does not throw. */
function captureSynchronousError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Spy on the console methods that must never be called by this resolver. */
function spyOnConsole() {
  return {
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    info: vi.spyOn(console, 'info').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
  };
}

/** Assert none of the console spies was called. */
function expectSilent(spies: ReturnType<typeof spyOnConsole>): void {
  expect(spies.log).not.toHaveBeenCalled();
  expect(spies.info).not.toHaveBeenCalled();
  expect(spies.warn).not.toHaveBeenCalled();
  expect(spies.error).not.toHaveBeenCalled();
  expect(spies.debug).not.toHaveBeenCalled();
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixture sanity.
// ---------------------------------------------------------------------------

describe('fixture sanity', () => {
  it('ties the fixed clock epoch to its ISO string', () => {
    expect(new Date(FETCHED_AT_EPOCH_MS).toISOString()).toBe(FETCHED_AT_ISO);
  });
});

// ---------------------------------------------------------------------------
// A — construction is side-effect-free.
// ---------------------------------------------------------------------------

describe('createKmaLiveCurrentSourceMetadataResolver — construction', () => {
  it('reads the clock zero times on construction alone', () => {
    const { clock, nowEpochMilliseconds } = makeClock();
    createKmaLiveCurrentSourceMetadataResolver(clock);
    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
  });

  it('calls no fetch, env, or console at construction', () => {
    const spies = spyOnConsole();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { clock } = makeClock();

    createKmaLiveCurrentSourceMetadataResolver(clock);

    expect(fetchSpy).not.toHaveBeenCalled();
    expectSilent(spies);
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// B — valid output.
// ---------------------------------------------------------------------------

describe('resolver — valid output', () => {
  it('returns the canonical sourceId, LIVE retrievalMode, and the clock-derived fetchedAt', () => {
    const { clock, nowEpochMilliseconds } = makeClock();
    const resolve = createKmaLiveCurrentSourceMetadataResolver(clock);

    const metadata = resolve();

    expect(metadata.sourceId).toBe(CANONICAL_SOURCE_ID);
    expect(metadata.retrievalMode).toBe('LIVE');
    expect(metadata.fetchedAt).toBe(FETCHED_AT_ISO);
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
  });

  it('emits UTC Z with exactly three millisecond digits', () => {
    const { clock } = makeClock();
    const resolve = createKmaLiveCurrentSourceMetadataResolver(clock);

    const fetchedAt = resolve().fetchedAt;

    expect(fetchedAt).toMatch(UTC_MILLISECONDS_PATTERN);
  });
});

// ---------------------------------------------------------------------------
// C — clock read count.
// ---------------------------------------------------------------------------

describe('resolver — clock read count', () => {
  it('reads the clock exactly once per call', () => {
    const { clock, nowEpochMilliseconds } = makeClock();
    const resolve = createKmaLiveCurrentSourceMetadataResolver(clock);

    resolve();

    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
  });

  it('reads the clock exactly twice across two calls, yielding fresh, independent results', () => {
    const { clock, nowEpochMilliseconds } = makeClock();
    const resolve = createKmaLiveCurrentSourceMetadataResolver(clock);

    const first = resolve();
    const second = resolve();

    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(2);
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});

// ---------------------------------------------------------------------------
// D — exact output shape.
// ---------------------------------------------------------------------------

describe('resolver — exact output shape', () => {
  it('has exactly the three sorted own keys: fetchedAt, retrievalMode, sourceId', () => {
    const { clock } = makeClock();
    const resolve = createKmaLiveCurrentSourceMetadataResolver(clock);

    const metadata = resolve();

    expect(Object.keys(metadata).sort()).toEqual([...METADATA_KEYS]);
  });

  it('produces output with no forbidden leakage keys', () => {
    const { clock } = makeClock();
    const resolve = createKmaLiveCurrentSourceMetadataResolver(clock);

    const metadata = resolve();

    const record = metadata as unknown as Record<string, unknown>;
    for (const key of FORBIDDEN_METADATA_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(record, key)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// E — invalid clock values (static RangeError).
// ---------------------------------------------------------------------------

describe('resolver — invalid clock values (static RangeError)', () => {
  const invalidClockValues: ReadonlyArray<{ readonly name: string; readonly value: number }> = [
    { name: 'NaN', value: NaN },
    { name: 'Infinity', value: Infinity },
    { name: '-Infinity', value: -Infinity },
    { name: 'fractional epoch', value: 1_784_000_000_000.5 },
    { name: 'unsafe integer', value: Number.MAX_SAFE_INTEGER + 2 },
    { name: 'out-of-Date-range safe integer', value: 8_700_000_000_000_000 },
  ];

  for (const { name, value } of invalidClockValues) {
    it(`rejects a ${name} clock value with a static RangeError`, () => {
      const { clock, nowEpochMilliseconds } = makeClock(value);
      const resolve = createKmaLiveCurrentSourceMetadataResolver(clock);

      const error = captureSynchronousError(() => resolve());

      expect(error).toBeInstanceOf(RangeError);
      expect((error as Error).message).toBe(INVALID_CLOCK_MESSAGE);
      expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
    });

    it(`never leaks the raw malformed clock value (${name}) into the error message`, () => {
      const { clock } = makeClock(value);
      const resolve = createKmaLiveCurrentSourceMetadataResolver(clock);

      const error = captureSynchronousError(() => resolve());

      expect((error as Error).message).toBe(INVALID_CLOCK_MESSAGE);
      expect((error as Error).message).not.toContain(String(value));
    });
  }

  it('accepts epoch 0', () => {
    const { clock } = makeClock(0);
    const resolve = createKmaLiveCurrentSourceMetadataResolver(clock);

    expect(resolve().fetchedAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('accepts a negative valid epoch', () => {
    const { clock } = makeClock(-1);
    const resolve = createKmaLiveCurrentSourceMetadataResolver(clock);

    expect(resolve().fetchedAt).toBe('1969-12-31T23:59:59.999Z');
  });

  it('returns no partial object on an invalid clock value and logs nothing', () => {
    const spies = spyOnConsole();
    const { clock } = makeClock(NaN);
    const resolve = createKmaLiveCurrentSourceMetadataResolver(clock);

    let returned: unknown;
    captureSynchronousError(() => {
      returned = resolve();
    });

    expect(returned).toBeUndefined();
    expectSilent(spies);
  });
});

// ---------------------------------------------------------------------------
// F — throwing clock.
// ---------------------------------------------------------------------------

describe('resolver — throwing clock', () => {
  it('propagates the same error reference synchronously (read once)', () => {
    const sentinel = new Error('CURRENT_CLOCK_THROW_SENTINEL');
    const { clock, nowEpochMilliseconds } = makeThrowingClock(sentinel);
    const resolve = createKmaLiveCurrentSourceMetadataResolver(clock);

    const error = captureSynchronousError(() => resolve());

    expect(error).toBe(sentinel);
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
  });
});
