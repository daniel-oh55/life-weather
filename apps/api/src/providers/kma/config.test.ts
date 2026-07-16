import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  validateKmaProviderOptions,
  type KmaForecastProviderOptions,
} from './config';
import {
  createKmaForecastProvider,
  createKmaForecastProviderFromEnv,
} from './provider';

/** An obviously fake decoded service key — never a real/production-shaped string. */
const FAKE_KEY = 'test-key+with/slash==';

describe('validateKmaProviderOptions — serviceKey', () => {
  it('accepts a valid decoded key and resolves the defaults', () => {
    const result = validateKmaProviderOptions({ serviceKey: FAKE_KEY });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.serviceKey).toBe(FAKE_KEY);
      expect(result.config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
      expect(result.config.maxResponseBytes).toBe(DEFAULT_MAX_RESPONSE_BYTES);
      expect(result.config.fetchImpl).toBe(globalThis.fetch);
    }
  });

  it('reports MISSING for a missing key', () => {
    const result = validateKmaProviderOptions({});
    expect(result).toEqual({
      ok: false,
      error: { kind: 'CONFIG_ERROR', field: 'serviceKey', reason: 'MISSING' },
    });
  });

  it('reports MISSING for an empty-string key', () => {
    const result = validateKmaProviderOptions({ serviceKey: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('MISSING');
    }
  });

  it('reports MISSING for a whitespace-only key', () => {
    const result = validateKmaProviderOptions({ serviceKey: '   \t\n' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        kind: 'CONFIG_ERROR',
        field: 'serviceKey',
        reason: 'MISSING',
      });
    }
  });

  it('reports INVALID (not trimmed) for leading whitespace', () => {
    const result = validateKmaProviderOptions({ serviceKey: ` ${FAKE_KEY}` });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        kind: 'CONFIG_ERROR',
        field: 'serviceKey',
        reason: 'INVALID',
      });
    }
  });

  it('reports INVALID (not trimmed) for trailing whitespace', () => {
    const result = validateKmaProviderOptions({ serviceKey: `${FAKE_KEY} ` });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe('serviceKey');
      expect(result.error.reason).toBe('INVALID');
    }
  });
});

describe('validateKmaProviderOptions — timeoutMs', () => {
  it('uses the default when omitted', () => {
    const result = validateKmaProviderOptions({ serviceKey: FAKE_KEY });
    expect(result.ok && result.config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('accepts a positive integer', () => {
    const result = validateKmaProviderOptions({ serviceKey: FAKE_KEY, timeoutMs: 2500 });
    expect(result.ok && result.config.timeoutMs).toBe(2500);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['non-integer', 1500.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('reports INVALID for a %s timeout', (_label, timeoutMs) => {
    const result = validateKmaProviderOptions({ serviceKey: FAKE_KEY, timeoutMs });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        kind: 'CONFIG_ERROR',
        field: 'timeoutMs',
        reason: 'INVALID',
      });
    }
  });
});

describe('validateKmaProviderOptions — maxResponseBytes', () => {
  it('uses the default when omitted', () => {
    const result = validateKmaProviderOptions({ serviceKey: FAKE_KEY });
    expect(result.ok && result.config.maxResponseBytes).toBe(DEFAULT_MAX_RESPONSE_BYTES);
  });

  it.each([
    ['zero', 0],
    ['negative', -100],
    ['non-integer', 1024.5],
  ])('reports INVALID for a %s maxResponseBytes', (_label, maxResponseBytes) => {
    const result = validateKmaProviderOptions({ serviceKey: FAKE_KEY, maxResponseBytes });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe('maxResponseBytes');
      expect(result.error.reason).toBe('INVALID');
    }
  });
});

describe('validateKmaProviderOptions — determinism & immutability', () => {
  it('does not mutate a frozen options object', () => {
    const options: KmaForecastProviderOptions = Object.freeze({
      serviceKey: FAKE_KEY,
      timeoutMs: 3000,
      maxResponseBytes: 1024,
    });
    expect(() => validateKmaProviderOptions(options)).not.toThrow();
    expect(options).toEqual({ serviceKey: FAKE_KEY, timeoutMs: 3000, maxResponseBytes: 1024 });
  });

  it('checks serviceKey before the numeric options (deterministic field order)', () => {
    const result = validateKmaProviderOptions({ serviceKey: '', timeoutMs: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe('serviceKey');
    }
  });

  it('never includes the service key in a config error', () => {
    const result = validateKmaProviderOptions({ serviceKey: ` ${FAKE_KEY} ` });
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
  });
});

describe('createKmaForecastProvider', () => {
  it('returns a provider for valid options', () => {
    const result = createKmaForecastProvider({ serviceKey: FAKE_KEY });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.provider.fetchForecast).toBe('function');
    }
  });

  it('returns a config error (never throws) for invalid options', () => {
    const result = createKmaForecastProvider({ serviceKey: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('CONFIG_ERROR');
    }
  });
});

describe('createKmaForecastProviderFromEnv', () => {
  const originalKey = process.env.KMA_SERVICE_KEY;

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.KMA_SERVICE_KEY;
    } else {
      process.env.KMA_SERVICE_KEY = originalKey;
    }
  });

  it('reads only KMA_SERVICE_KEY from an explicit env object', () => {
    const result = createKmaForecastProviderFromEnv({ KMA_SERVICE_KEY: FAKE_KEY });
    expect(result.ok).toBe(true);
  });

  it('reports a config error when the key is absent from the explicit env', () => {
    const result = createKmaForecastProviderFromEnv({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        kind: 'CONFIG_ERROR',
        field: 'serviceKey',
        reason: 'MISSING',
      });
    }
  });

  it('uses the explicit env even when process.env has a key (no ambient read)', () => {
    process.env.KMA_SERVICE_KEY = FAKE_KEY;
    const result = createKmaForecastProviderFromEnv({});
    expect(result.ok).toBe(false);
  });

  it('reads process.env at call time (not at import time)', () => {
    // Not set at import — set now, and the call observes it. This only passes if the read happens
    // when the factory is invoked, not when the module was first imported.
    process.env.KMA_SERVICE_KEY = FAKE_KEY;
    expect(createKmaForecastProviderFromEnv().ok).toBe(true);
    delete process.env.KMA_SERVICE_KEY;
    expect(createKmaForecastProviderFromEnv().ok).toBe(false);
  });

  it('passes an injected fetchImpl through to the provider', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('', { status: 204 }),
    ) as unknown as typeof fetch;
    const result = createKmaForecastProviderFromEnv({ KMA_SERVICE_KEY: FAKE_KEY }, { fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 204 → empty body → EMPTY_RESPONSE, but the point is the injected fetch was used.
      await result.provider.fetchForecast({
        product: 'SHORT_FORECAST',
        baseDate: '20260716',
        baseTime: '0500',
        nx: 60,
        ny: 127,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
});
