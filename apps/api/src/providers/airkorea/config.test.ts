import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  validateAirKoreaProviderOptions,
  type AirKoreaProviderOptions,
  type ValidateAirKoreaProviderOptionsResult,
} from './config.js';
import {
  createAirKoreaCurrentAirQualityProvider,
  createAirKoreaCurrentAirQualityProviderFromEnv,
} from './provider.js';

/** An obviously fake, synthetic decoded service key — never a real/production-shaped string. */
const FAKE_KEY = 'FAKE-AIRKOREA-SERVICE-KEY-test+/==';

describe('validateAirKoreaProviderOptions — serviceKey', () => {
  it('accepts a valid decoded key and resolves the defaults', () => {
    const result = validateAirKoreaProviderOptions({ serviceKey: FAKE_KEY });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.serviceKey).toBe(FAKE_KEY);
      expect(result.config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
      expect(result.config.maxResponseBytes).toBe(DEFAULT_MAX_RESPONSE_BYTES);
      expect(result.config.fetchImpl).toBe(globalThis.fetch);
    }
  });

  it('reports MISSING for a missing key', () => {
    const result = validateAirKoreaProviderOptions({});
    expect(result).toEqual({
      ok: false,
      error: { kind: 'CONFIG_ERROR', field: 'serviceKey', reason: 'MISSING' },
    });
  });

  it('reports MISSING for an empty-string key', () => {
    const result = validateAirKoreaProviderOptions({ serviceKey: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('MISSING');
    }
  });

  it('reports MISSING for a whitespace-only key', () => {
    const result = validateAirKoreaProviderOptions({ serviceKey: '   \t\n' });
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
    const result = validateAirKoreaProviderOptions({ serviceKey: ` ${FAKE_KEY}` });
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
    const result = validateAirKoreaProviderOptions({ serviceKey: `${FAKE_KEY} ` });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe('serviceKey');
      expect(result.error.reason).toBe('INVALID');
    }
  });
});

describe('validateAirKoreaProviderOptions — timeoutMs', () => {
  it('uses the default when omitted', () => {
    const result = validateAirKoreaProviderOptions({ serviceKey: FAKE_KEY });
    expect(result.ok && result.config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('accepts a positive integer', () => {
    const result = validateAirKoreaProviderOptions({ serviceKey: FAKE_KEY, timeoutMs: 2500 });
    expect(result.ok && result.config.timeoutMs).toBe(2500);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['non-integer', 1500.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('reports INVALID for a %s timeout', (_label, timeoutMs) => {
    const result = validateAirKoreaProviderOptions({ serviceKey: FAKE_KEY, timeoutMs });
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

describe('validateAirKoreaProviderOptions — maxResponseBytes', () => {
  it('uses the default when omitted', () => {
    const result = validateAirKoreaProviderOptions({ serviceKey: FAKE_KEY });
    expect(result.ok && result.config.maxResponseBytes).toBe(DEFAULT_MAX_RESPONSE_BYTES);
  });

  it.each([
    ['zero', 0],
    ['negative', -100],
    ['non-integer', 1024.5],
  ])('reports INVALID for a %s maxResponseBytes', (_label, maxResponseBytes) => {
    const result = validateAirKoreaProviderOptions({ serviceKey: FAKE_KEY, maxResponseBytes });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe('maxResponseBytes');
      expect(result.error.reason).toBe('INVALID');
    }
  });
});

describe('validateAirKoreaProviderOptions — determinism & immutability', () => {
  it('does not mutate a frozen options object', () => {
    const options: AirKoreaProviderOptions = Object.freeze({
      serviceKey: FAKE_KEY,
      timeoutMs: 3000,
      maxResponseBytes: 1024,
    });
    expect(() => validateAirKoreaProviderOptions(options)).not.toThrow();
    expect(options).toEqual({ serviceKey: FAKE_KEY, timeoutMs: 3000, maxResponseBytes: 1024 });
  });

  it('checks serviceKey before the numeric options (deterministic field order)', () => {
    const result = validateAirKoreaProviderOptions({ serviceKey: '', timeoutMs: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe('serviceKey');
    }
  });

  it('never includes the service key in a config error', () => {
    const result = validateAirKoreaProviderOptions({ serviceKey: ` ${FAKE_KEY} ` });
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
  });
});

describe('validateAirKoreaProviderOptions — runtime totality on non-object input', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'nope'],
    ['a number', 42],
    ['a boolean', true],
    ['an array', []],
    ['a function', () => undefined],
  ])('returns CONFIG_ERROR(serviceKey, MISSING) without throwing for %s', (_label, input) => {
    let result: ValidateAirKoreaProviderOptionsResult;
    expect(() => {
      result = validateAirKoreaProviderOptions(input);
    }).not.toThrow();
    expect(result!).toEqual({
      ok: false,
      error: { kind: 'CONFIG_ERROR', field: 'serviceKey', reason: 'MISSING' },
    });
  });

  it('does not expose a function input (no raw source in the error)', () => {
    const marker = () => 'SECRET_CONFIG_FUNCTION_MARKER';
    const result = validateAirKoreaProviderOptions(marker);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'CONFIG_ERROR', field: 'serviceKey', reason: 'MISSING' },
    });
    expect(JSON.stringify(result)).not.toContain('SECRET_CONFIG_FUNCTION_MARKER');
  });
});

describe('createAirKoreaCurrentAirQualityProvider', () => {
  it('returns a provider for valid options', () => {
    const result = createAirKoreaCurrentAirQualityProvider({ serviceKey: FAKE_KEY });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.provider.fetchCurrentAirQuality).toBe('function');
    }
  });

  it('returns a config error (never throws) for invalid options', () => {
    const result = createAirKoreaCurrentAirQualityProvider({ serviceKey: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('CONFIG_ERROR');
    }
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'nope'],
    ['an array', []],
    ['a function', () => undefined],
  ])('returns CONFIG_ERROR(serviceKey, MISSING) without throwing for runtime %s', (_label, input) => {
    let result: ReturnType<typeof createAirKoreaCurrentAirQualityProvider>;
    expect(() => {
      result = createAirKoreaCurrentAirQualityProvider(input as unknown as AirKoreaProviderOptions);
    }).not.toThrow();
    expect(result!.ok).toBe(false);
    if (!result!.ok) {
      expect(result!.error).toEqual({
        kind: 'CONFIG_ERROR',
        field: 'serviceKey',
        reason: 'MISSING',
      });
    }
  });

  it('does not expose a function input passed to the factory (no raw source in the error)', () => {
    const marker = () => 'SECRET_FACTORY_FUNCTION_MARKER';
    const result = createAirKoreaCurrentAirQualityProvider(
      marker as unknown as AirKoreaProviderOptions,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        kind: 'CONFIG_ERROR',
        field: 'serviceKey',
        reason: 'MISSING',
      });
    }
    expect(JSON.stringify(result)).not.toContain('SECRET_FACTORY_FUNCTION_MARKER');
  });
});

describe('createAirKoreaCurrentAirQualityProviderFromEnv', () => {
  const originalKey = process.env.AIRKOREA_SERVICE_KEY;

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.AIRKOREA_SERVICE_KEY;
    } else {
      process.env.AIRKOREA_SERVICE_KEY = originalKey;
    }
  });

  it('reads only AIRKOREA_SERVICE_KEY from an explicit env object', () => {
    const result = createAirKoreaCurrentAirQualityProviderFromEnv({
      AIRKOREA_SERVICE_KEY: FAKE_KEY,
    });
    expect(result.ok).toBe(true);
  });

  it('reports a config error when the key is absent from the explicit env', () => {
    const result = createAirKoreaCurrentAirQualityProviderFromEnv({});
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
    process.env.AIRKOREA_SERVICE_KEY = FAKE_KEY;
    const result = createAirKoreaCurrentAirQualityProviderFromEnv({});
    expect(result.ok).toBe(false);
  });

  it('reads process.env at call time (not at import time)', () => {
    process.env.AIRKOREA_SERVICE_KEY = FAKE_KEY;
    expect(createAirKoreaCurrentAirQualityProviderFromEnv().ok).toBe(true);
    delete process.env.AIRKOREA_SERVICE_KEY;
    expect(createAirKoreaCurrentAirQualityProviderFromEnv().ok).toBe(false);
  });

  it('passes an injected fetchImpl through to the provider', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('', { status: 204 }),
    ) as unknown as typeof fetch;
    const result = createAirKoreaCurrentAirQualityProviderFromEnv(
      { AIRKOREA_SERVICE_KEY: FAKE_KEY },
      { fetchImpl },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 204 → empty body → EMPTY_RESPONSE, but the point is the injected fetch was used.
      await result.provider.fetchCurrentAirQuality({ stationName: '종로구' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
});
