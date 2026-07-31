import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SELECTED_LOCATION_PERSISTENCE_KEY, encodeSelectedLocationId } from './index';
import { mobileSelectedLocationPersistence } from './mobile-selected-location-async-storage';

// ---------------------------------------------------------------------------
// Mocked AsyncStorage. The native module is never loaded or touched — every method is a spy so
// the tests can both drive behavior (resolve / synchronous throw / promise rejection) and assert
// call counts, including that broad, forbidden operations are *never* invoked, and that the
// binding never calls `removeItem`. `vi.hoisted` and `vi.mock` are hoisted above these imports by
// Vitest, so the binding under test resolves the mock rather than the real native module.
// ---------------------------------------------------------------------------

const asyncStorageMock = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  // Forbidden operations. Present only so the suite can assert 0 calls.
  removeItem: vi.fn(),
  clear: vi.fn(),
  getAllKeys: vi.fn(),
  multiGet: vi.fn(),
  multiSet: vi.fn(),
  multiRemove: vi.fn(),
  mergeItem: vi.fn(),
  multiMerge: vi.fn(),
  flushGetRequests: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: asyncStorageMock,
}));

/** A marker asserted absent from any failure result — proves no native error leaks out. */
const SECRET_MARKER = 'SYNTHETIC_SELECTED_ASYNC_STORAGE_ERROR_MUST_NOT_LEAK';

/** Encode an id and return its serialized V1 string (throws in-test on failure). */
function serializedOf(id: string | null): string {
  const encoded = encodeSelectedLocationId(id);
  if (!encoded.ok) throw new Error('fixture encode failed');
  return encoded.serialized;
}

const FORBIDDEN_OPERATIONS = [
  'removeItem',
  'clear',
  'getAllKeys',
  'multiGet',
  'multiSet',
  'multiRemove',
  'mergeItem',
  'multiMerge',
  'flushGetRequests',
] as const;

function expectNoForbiddenApi() {
  for (const name of FORBIDDEN_OPERATIONS) {
    expect(asyncStorageMock[name], `forbidden operation ${name} must not be called`).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  asyncStorageMock.getItem.mockResolvedValue(null);
  asyncStorageMock.setItem.mockResolvedValue(undefined);
});

afterEach(() => {
  expectNoForbiddenApi();
});

// ---------------------------------------------------------------------------
// module import performs no storage I/O
// ---------------------------------------------------------------------------

describe('module import', () => {
  it('performs no storage I/O merely by importing / evaluating the binding', async () => {
    vi.clearAllMocks();
    vi.resetModules();
    await import('./mobile-selected-location-async-storage');

    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(0);
    expectNoForbiddenApi();
  });
});

// ---------------------------------------------------------------------------
// load
// ---------------------------------------------------------------------------

describe('mobileSelectedLocationPersistence.load', () => {
  it('reads the exact stable key exactly once and returns a successful null for a missing key', async () => {
    asyncStorageMock.getItem.mockResolvedValue(null);

    const result = await mobileSelectedLocationPersistence.load();

    expect(result).toEqual({ ok: true, selectedLocationId: null });
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(1);
    expect(asyncStorageMock.getItem).toHaveBeenCalledWith(SELECTED_LOCATION_PERSISTENCE_KEY);
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(0);
  });

  it('decodes a stored V1 envelope through the codec', async () => {
    asyncStorageMock.getItem.mockResolvedValue(serializedOf('kr_abc'));

    const result = await mobileSelectedLocationPersistence.load();

    expect(result).toEqual({ ok: true, selectedLocationId: 'kr_abc' });
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(0);
  });

  it('fails closed on a malformed stored value without repairing it', async () => {
    asyncStorageMock.getItem.mockResolvedValue('{not json');

    const result = await mobileSelectedLocationPersistence.load();

    expect(result).toEqual({ ok: false, error: { kind: 'INVALID_STORED_SELECTION' } });
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(0);
  });

  it('reports an unsupported integer version and never migrates it', async () => {
    asyncStorageMock.getItem.mockResolvedValue('{"version":2,"selectedLocationId":null}');

    const result = await mobileSelectedLocationPersistence.load();

    expect(result).toEqual({ ok: false, error: { kind: 'UNSUPPORTED_STORED_VERSION' } });
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// save
// ---------------------------------------------------------------------------

describe('mobileSelectedLocationPersistence.save', () => {
  it('writes the exact stable key and canonical V1 value exactly once for a string id', async () => {
    const result = await mobileSelectedLocationPersistence.save('kr_abc');

    expect(result).toEqual({ ok: true });
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(1);
    const [key, value] = asyncStorageMock.setItem.mock.calls[0];
    expect(key).toBe(SELECTED_LOCATION_PERSISTENCE_KEY);
    expect(value).toBe(serializedOf('kr_abc'));
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(0);
  });

  it('writes an explicit null envelope for null', async () => {
    const result = await mobileSelectedLocationPersistence.save(null);

    expect(result).toEqual({ ok: true });
    expect(asyncStorageMock.setItem.mock.calls[0][1]).toBe(
      '{"version":1,"selectedLocationId":null}',
    );
  });

  it('rejects an invalid id and never touches storage', async () => {
    const result = await mobileSelectedLocationPersistence.save(42);

    expect(result).toEqual({ ok: false, error: { kind: 'INVALID_SELECTED_LOCATION_ID' } });
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// synchronous throw and promise rejection map to the fixed storage error kinds
// ---------------------------------------------------------------------------

describe('mobileSelectedLocationPersistence — storage failures', () => {
  const thrownValues: [label: string, make: () => unknown][] = [
    ['an Error', () => new Error(SECRET_MARKER)],
    ['a string', () => SECRET_MARKER],
    ['a plain object', () => ({ secret: SECRET_MARKER })],
    ['a symbol', () => Symbol(SECRET_MARKER)],
  ];

  describe('load → STORAGE_READ_FAILED', () => {
    it.each(thrownValues)('maps a synchronous getItem throw of %s', async (_label, make) => {
      asyncStorageMock.getItem.mockImplementation(() => {
        throw make();
      });

      const result = await mobileSelectedLocationPersistence.load();

      expect(result).toEqual({ ok: false, error: { kind: 'STORAGE_READ_FAILED' } });
      expect(JSON.stringify(result)).not.toContain(SECRET_MARKER);
    });

    it.each(thrownValues)('maps a getItem promise rejection of %s', async (_label, make) => {
      asyncStorageMock.getItem.mockRejectedValue(make());

      const result = await mobileSelectedLocationPersistence.load();

      expect(result).toEqual({ ok: false, error: { kind: 'STORAGE_READ_FAILED' } });
      expect(JSON.stringify(result)).not.toContain(SECRET_MARKER);
    });
  });

  describe('save → STORAGE_WRITE_FAILED', () => {
    it.each(thrownValues)('maps a synchronous setItem throw of %s', async (_label, make) => {
      asyncStorageMock.setItem.mockImplementation(() => {
        throw make();
      });

      const result = await mobileSelectedLocationPersistence.save('kr_abc');

      expect(result).toEqual({ ok: false, error: { kind: 'STORAGE_WRITE_FAILED' } });
      expect(JSON.stringify(result)).not.toContain(SECRET_MARKER);
    });

    it.each(thrownValues)('maps a setItem promise rejection of %s', async (_label, make) => {
      asyncStorageMock.setItem.mockRejectedValue(make());

      const result = await mobileSelectedLocationPersistence.save('kr_abc');

      expect(result).toEqual({ ok: false, error: { kind: 'STORAGE_WRITE_FAILED' } });
      expect(JSON.stringify(result)).not.toContain(SECRET_MARKER);
    });
  });
});

// ---------------------------------------------------------------------------
// the forbidden AsyncStorage API is never used, including removeItem
// ---------------------------------------------------------------------------

describe('mobileSelectedLocationPersistence — minimal provider surface', () => {
  it('drives load and save without ever calling removeItem or a broad AsyncStorage operation', async () => {
    asyncStorageMock.getItem.mockResolvedValue(serializedOf('kr_abc'));

    await mobileSelectedLocationPersistence.load();
    await mobileSelectedLocationPersistence.save('kr_abc');

    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(1);
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(1);
    expectNoForbiddenApi();
  });
});

// ---------------------------------------------------------------------------
// fresh, fixed, non-native-referencing errors on repeated failures
// ---------------------------------------------------------------------------

describe('mobileSelectedLocationPersistence — fresh errors', () => {
  it('returns distinct result and nested error references for the same read failure twice', async () => {
    const nativeError = new Error(SECRET_MARKER);
    asyncStorageMock.getItem.mockRejectedValue(nativeError);

    const first = await mobileSelectedLocationPersistence.load();
    const second = await mobileSelectedLocationPersistence.load();

    expect(first).not.toBe(second);
    if (first.ok || second.ok) throw new Error('expected read failures');
    expect(first.error).not.toBe(second.error);
    expect(first).toEqual(second);
    expect(first.error).not.toBe(nativeError as unknown);
    expect(JSON.stringify(first)).toBe('{"ok":false,"error":{"kind":"STORAGE_READ_FAILED"}}');
  });

  it('returns distinct result and nested error references for the same write failure twice', async () => {
    asyncStorageMock.setItem.mockRejectedValue(new Error(SECRET_MARKER));

    const first = await mobileSelectedLocationPersistence.save('kr_abc');
    const second = await mobileSelectedLocationPersistence.save('kr_abc');

    expect(first).not.toBe(second);
    if (first.ok || second.ok) throw new Error('expected write failures');
    expect(first.error).not.toBe(second.error);
    expect(first).toEqual(second);
  });
});
