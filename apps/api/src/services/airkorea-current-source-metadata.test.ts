import { describe, expect, it, vi } from 'vitest';

import { isoDateTime } from '@life-weather/contracts';

import {
  createAirKoreaLiveCurrentSourceMetadataResolver,
  type AirKoreaCurrentSourceMetadataClock,
} from './airkorea-current-source-metadata.js';

function fixedClock(epochMilliseconds: number) {
  const nowEpochMilliseconds = vi.fn(() => epochMilliseconds);
  const clock: AirKoreaCurrentSourceMetadataClock = { nowEpochMilliseconds };
  return { clock, nowEpochMilliseconds };
}

describe('createAirKoreaLiveCurrentSourceMetadataResolver — construction', () => {
  it('reads the clock zero times at construction', () => {
    const { clock, nowEpochMilliseconds } = fixedClock(Date.UTC(2026, 7, 10, 5, 10, 0));

    createAirKoreaLiveCurrentSourceMetadataResolver(clock);

    expect(nowEpochMilliseconds).not.toHaveBeenCalled();
  });
});

describe('createAirKoreaLiveCurrentSourceMetadataResolver — valid call', () => {
  it('reads the clock exactly once per call', () => {
    const { clock, nowEpochMilliseconds } = fixedClock(Date.UTC(2026, 7, 10, 5, 10, 0));
    const resolver = createAirKoreaLiveCurrentSourceMetadataResolver(clock);

    resolver();

    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
  });

  it('returns the fixed canonical sourceId, never a station/TM/location trace', () => {
    const { clock } = fixedClock(Date.UTC(2026, 7, 10, 5, 10, 0));
    const resolver = createAirKoreaLiveCurrentSourceMetadataResolver(clock);

    const result = resolver();

    expect(result.sourceId).toBe('airkorea-current-air-quality');
  });

  it('returns retrievalMode fixed to LIVE', () => {
    const { clock } = fixedClock(Date.UTC(2026, 7, 10, 5, 10, 0));
    const resolver = createAirKoreaLiveCurrentSourceMetadataResolver(clock);

    expect(resolver().retrievalMode).toBe('LIVE');
  });

  it('formats fetchedAt as a contract-valid UTC Z isoDateTime derived from the clock value', () => {
    const epochMilliseconds = Date.UTC(2026, 7, 10, 5, 10, 22, 333);
    const { clock } = fixedClock(epochMilliseconds);
    const resolver = createAirKoreaLiveCurrentSourceMetadataResolver(clock);

    const result = resolver();

    expect(result.fetchedAt).toBe('2026-08-10T05:10:22.333Z');
    expect(isoDateTime.safeParse(result.fetchedAt).success).toBe(true);
  });

  it('returns a fresh object with exactly the three sorted own keys, a new reference each call', () => {
    const { clock } = fixedClock(Date.UTC(2026, 7, 10, 5, 10, 0));
    const resolver = createAirKoreaLiveCurrentSourceMetadataResolver(clock);

    const first = resolver();
    const second = resolver();

    expect(Object.keys(first).sort()).toEqual(['fetchedAt', 'retrievalMode', 'sourceId']);
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});

describe('createAirKoreaLiveCurrentSourceMetadataResolver — invalid clock value', () => {
  it.each([
    { name: 'NaN', value: Number.NaN },
    { name: 'Infinity', value: Number.POSITIVE_INFINITY },
    { name: 'fractional', value: 1.5 },
    { name: 'unsafe integer', value: Number.MAX_SAFE_INTEGER + 10 },
  ])('throws a static RangeError for a $name clock value, after reading it exactly once', ({ value }) => {
    const { clock, nowEpochMilliseconds } = fixedClock(value);
    const resolver = createAirKoreaLiveCurrentSourceMetadataResolver(clock);

    expect(() => resolver()).toThrow(RangeError);
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
  });

  it('never includes the raw malformed value in the thrown message', () => {
    const { clock } = fixedClock(Number.NaN);
    const resolver = createAirKoreaLiveCurrentSourceMetadataResolver(clock);

    let caught: unknown;
    try {
      resolver();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RangeError);
    expect((caught as Error).message).not.toContain('NaN');
  });

  it('throws the same static message for every invalid-value case', () => {
    const messages: string[] = [];
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      const { clock } = fixedClock(value);
      const resolver = createAirKoreaLiveCurrentSourceMetadataResolver(clock);
      try {
        resolver();
      } catch (error) {
        messages.push((error as Error).message);
      }
    }

    expect(new Set(messages).size).toBe(1);
  });
});

describe('createAirKoreaLiveCurrentSourceMetadataResolver — throwing clock', () => {
  it('propagates the exact same error reference the clock throws, after reading it exactly once', () => {
    const marker = new Error('clock exploded');
    const nowEpochMilliseconds = vi.fn(() => {
      throw marker;
    });
    const clock: AirKoreaCurrentSourceMetadataClock = { nowEpochMilliseconds };
    const resolver = createAirKoreaLiveCurrentSourceMetadataResolver(clock);

    let caught: unknown;
    try {
      resolver();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(marker);
    expect(nowEpochMilliseconds).toHaveBeenCalledTimes(1);
  });
});
