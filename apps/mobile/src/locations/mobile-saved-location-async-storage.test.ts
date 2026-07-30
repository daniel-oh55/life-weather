import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SAVED_LOCATION_PERSISTENCE_KEY,
  encodeSavedLocationCollection,
  type MobileSavedLocation,
} from './index';
import { mobileSavedLocationPersistence } from './mobile-saved-location-async-storage';

// ---------------------------------------------------------------------------
// Mocked AsyncStorage. The native module is never loaded or touched — every method is a spy so
// the tests can both drive behavior (resolve / synchronous throw / promise rejection) and assert
// call counts, including that the broad, forbidden operations are *never* invoked. `vi.hoisted`
// and `vi.mock` are hoisted above these imports by Vitest, so the binding under test resolves the
// mock rather than the real native module.
// ---------------------------------------------------------------------------

const asyncStorageMock = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  // Broad operations the binding must never use. Present only so the suite can assert 0 calls.
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

// ---------------------------------------------------------------------------
// Synthetic fixtures. Every value here is fabricated — synthetic ids, display names, coordinates,
// and a standard non-sensitive timezone — so no real user location, stored place, or device
// identifier is ever used. Each builder returns a fresh object.
// ---------------------------------------------------------------------------

/** A marker asserted absent from any failure result — proves no native error leaks out. */
const SECRET_MARKER = 'SYNTHETIC_ASYNC_STORAGE_ERROR_MUST_NOT_LEAK';

/** The nine shared `WeatherLocation` fields for a synthetic id. */
function sharedFields(id: string) {
  return {
    id,
    displayName: `Synthetic ${id}`,
    countryCode: 'KR',
    adminArea1: 'Synthetic Province',
    adminArea2: 'Synthetic District',
    adminArea3: null,
    latitude: 37.5,
    longitude: 127.0,
    timezone: 'Asia/Seoul',
  };
}

/** A fresh, valid saved-location record (sortOrder 0 unless overridden). */
function record(id: string, overrides: Partial<MobileSavedLocation> = {}): MobileSavedLocation {
  return {
    ...sharedFields(id),
    kmaGrid: { nx: 60, ny: 127 },
    isCurrent: false,
    sortOrder: 0,
    ...overrides,
  };
}

/** A fresh, canonical collection: sortOrder is assigned from array position. */
function collectionOf(
  ...specs: (Partial<MobileSavedLocation> & { id: string })[]
): MobileSavedLocation[] {
  return specs.map((spec, index) => record(spec.id, { ...spec, sortOrder: index }));
}

/** Encode a canonical collection and return its serialized V1 string (throws in-test on failure). */
function serializedOf(...specs: (Partial<MobileSavedLocation> & { id: string })[]): string {
  const encoded = encodeSavedLocationCollection(collectionOf(...specs));
  if (!encoded.ok) throw new Error('fixture encode failed');
  return encoded.serialized;
}

/** Recursively freeze a value so any attempted mutation throws in strict mode. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** Assert two success location arrays share no references at any level. */
function expectDistinctLocations(a: MobileSavedLocation[], b: MobileSavedLocation[]) {
  expect(a).not.toBe(b);
  a.forEach((recordA, index) => {
    const recordB = b[index];
    expect(recordA).not.toBe(recordB);
    if (recordA.kmaGrid !== null && recordB.kmaGrid !== null) {
      expect(recordA.kmaGrid).not.toBe(recordB.kmaGrid);
    }
  });
}

/** The three delegated methods plus the forbidden broad operations, for call-count assertions. */
const BROAD_OPERATIONS = [
  'clear',
  'getAllKeys',
  'multiGet',
  'multiSet',
  'multiRemove',
  'mergeItem',
  'multiMerge',
  'flushGetRequests',
] as const;

/** Assert none of the broad, forbidden AsyncStorage operations were called. */
function expectNoBroadApi() {
  for (const name of BROAD_OPERATIONS) {
    expect(asyncStorageMock[name], `broad operation ${name} must not be called`).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  // Reset implementations *and* call history between tests, then install sane defaults so a test
  // that does not configure a method still sees a resolving provider.
  vi.resetAllMocks();
  asyncStorageMock.getItem.mockResolvedValue(null);
  asyncStorageMock.setItem.mockResolvedValue(undefined);
  asyncStorageMock.removeItem.mockResolvedValue(undefined);
});

// The broad AsyncStorage API is never touched by any operation in this suite (10.9).
afterEach(() => {
  expectNoBroadApi();
});

// ---------------------------------------------------------------------------
// 10.1 — module import performs no storage I/O
// ---------------------------------------------------------------------------

describe('module import', () => {
  it('performs no storage I/O merely by importing / evaluating the binding', async () => {
    vi.clearAllMocks();
    vi.resetModules();
    await import('./mobile-saved-location-async-storage');

    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.removeItem).toHaveBeenCalledTimes(0);
    expectNoBroadApi();
  });
});

// ---------------------------------------------------------------------------
// 10.2 — load: missing key
// ---------------------------------------------------------------------------

describe('mobileSavedLocationPersistence.load — missing key', () => {
  it('reads the exact stable key exactly once and returns a fresh empty collection', async () => {
    asyncStorageMock.getItem.mockResolvedValue(null);

    const result = await mobileSavedLocationPersistence.load();

    expect(result).toEqual({ ok: true, locations: [] });
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(1);
    expect(asyncStorageMock.getItem).toHaveBeenCalledWith(SAVED_LOCATION_PERSISTENCE_KEY);
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.removeItem).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// 10.3 — load: valid value
// ---------------------------------------------------------------------------

describe('mobileSavedLocationPersistence.load — valid value', () => {
  it('decodes a stored V1 envelope through the codec and preserves the locations', async () => {
    asyncStorageMock.getItem.mockResolvedValue(
      serializedOf({ id: 'a' }, { id: 'b', isCurrent: true }),
    );

    const result = await mobileSavedLocationPersistence.load();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.locations.map((location) => location.id)).toEqual(['a', 'b']);
    expect(result.locations[1].isCurrent).toBe(true);
    expect(result.locations[0].kmaGrid).toEqual({ nx: 60, ny: 127 });
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(1);
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.removeItem).toHaveBeenCalledTimes(0);
  });

  it('returns fresh array / record / non-null kmaGrid references across repeated loads', async () => {
    asyncStorageMock.getItem.mockResolvedValue(serializedOf({ id: 'a' }, { id: 'b' }));

    const first = await mobileSavedLocationPersistence.load();
    const second = await mobileSavedLocationPersistence.load();

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expectDistinctLocations(first.locations, second.locations);
  });
});

// ---------------------------------------------------------------------------
// 10.4 — load: malformed / unsupported value fails closed, never repairs or deletes
// ---------------------------------------------------------------------------

describe('mobileSavedLocationPersistence.load — malformed / unsupported value', () => {
  const invalidStored: [label: string, value: unknown][] = [
    ['malformed JSON', '{not json'],
    ['an empty string', ''],
    ['a whitespace-only string', '   '],
    ['an invalid V1 shape', '{"version":1,"locations":{}}'],
    [
      'an invalid collection (duplicate id)',
      JSON.stringify({
        version: 1,
        locations: [record('dup', { sortOrder: 0 }), record('dup', { sortOrder: 1 })],
      }),
    ],
    ['a runtime non-string return', 42],
  ];

  it.each(invalidStored)(
    'fails closed on %s as INVALID_STORED_LOCATIONS without repairing or deleting',
    async (_label, value) => {
      asyncStorageMock.getItem.mockResolvedValue(value);

      const result = await mobileSavedLocationPersistence.load();

      expect(result).toEqual({ ok: false, error: { kind: 'INVALID_STORED_LOCATIONS' } });
      expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(0);
      expect(asyncStorageMock.removeItem).toHaveBeenCalledTimes(0);
    },
  );

  it('reports an unsupported integer version and never migrates or deletes', async () => {
    asyncStorageMock.getItem.mockResolvedValue('{"version":2,"locations":[]}');

    const result = await mobileSavedLocationPersistence.load();

    expect(result).toEqual({ ok: false, error: { kind: 'UNSUPPORTED_STORED_VERSION' } });
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.removeItem).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// 10.5 — save: valid collection
// ---------------------------------------------------------------------------

describe('mobileSavedLocationPersistence.save — valid collection', () => {
  it('writes the exact stable key and canonical V1 value exactly once', async () => {
    const collection = collectionOf({ id: 'a', isCurrent: true }, { id: 'b' });

    const result = await mobileSavedLocationPersistence.save(collection);

    expect(result).toEqual({ ok: true });
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(1);
    const [key, value] = asyncStorageMock.setItem.mock.calls[0];
    expect(key).toBe(SAVED_LOCATION_PERSISTENCE_KEY);
    const encoded = encodeSavedLocationCollection(collection);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(value).toBe(encoded.serialized);
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.removeItem).toHaveBeenCalledTimes(0);
  });

  it('does not mutate a deep-frozen input', async () => {
    const collection = collectionOf({ id: 'a', isCurrent: true }, { id: 'b' });
    const snapshot = JSON.stringify(collection);
    deepFreeze(collection);

    await expect(mobileSavedLocationPersistence.save(collection)).resolves.toEqual({ ok: true });
    expect(JSON.stringify(collection)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// 10.6 — save: invalid collection never touches storage
// ---------------------------------------------------------------------------

describe('mobileSavedLocationPersistence.save — invalid collection', () => {
  const invalidCollections: [label: string, value: unknown][] = [
    ['a non-array', { nope: true }],
    ['a duplicate id', [record('dup', { sortOrder: 0 }), record('dup', { sortOrder: 1 })]],
    [
      'two current locations',
      [
        record('a', { sortOrder: 0, isCurrent: true }),
        record('b', { sortOrder: 1, isCurrent: true }),
      ],
    ],
    ['a non-canonical sortOrder', [record('a', { sortOrder: 5 })]],
    ['an invalid coordinate', [{ ...record('a', { sortOrder: 0 }), latitude: 91 }]],
    ['an unknown record field', [{ ...record('a', { sortOrder: 0 }), extra: 'nope' }]],
  ];

  it.each(invalidCollections)(
    'rejects %s as INVALID_COLLECTION and never calls storage',
    async (_label, value) => {
      const result = await mobileSavedLocationPersistence.save(value);

      expect(result).toEqual({ ok: false, error: { kind: 'INVALID_COLLECTION' } });
      expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(0);
      expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(0);
      expect(asyncStorageMock.removeItem).toHaveBeenCalledTimes(0);
    },
  );
});

// ---------------------------------------------------------------------------
// 10.7 — clear
// ---------------------------------------------------------------------------

describe('mobileSavedLocationPersistence.clear', () => {
  it('removes the exact stable key exactly once and touches nothing else', async () => {
    const result = await mobileSavedLocationPersistence.clear();

    expect(result).toEqual({ ok: true });
    expect(asyncStorageMock.removeItem).toHaveBeenCalledTimes(1);
    expect(asyncStorageMock.removeItem).toHaveBeenCalledWith(SAVED_LOCATION_PERSISTENCE_KEY);
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(0);
  });

  it('succeeds when the provider resolves for an absent key', async () => {
    asyncStorageMock.removeItem.mockResolvedValue(undefined);

    const result = await mobileSavedLocationPersistence.clear();

    expect(result).toEqual({ ok: true });
    expect(asyncStorageMock.removeItem).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 10.8 — synchronous throw and promise rejection map to the fixed storage error kinds
// ---------------------------------------------------------------------------

describe('mobileSavedLocationPersistence — storage failures', () => {
  /** Non-Error thrown / rejected values that must still collapse to the fixed kind. */
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

      const result = await mobileSavedLocationPersistence.load();

      expect(result).toEqual({ ok: false, error: { kind: 'STORAGE_READ_FAILED' } });
      expect(JSON.stringify(result)).not.toContain(SECRET_MARKER);
    });

    it.each(thrownValues)('maps a getItem promise rejection of %s', async (_label, make) => {
      asyncStorageMock.getItem.mockRejectedValue(make());

      const result = await mobileSavedLocationPersistence.load();

      expect(result).toEqual({ ok: false, error: { kind: 'STORAGE_READ_FAILED' } });
      expect(JSON.stringify(result)).not.toContain(SECRET_MARKER);
    });
  });

  describe('save → STORAGE_WRITE_FAILED', () => {
    it.each(thrownValues)('maps a synchronous setItem throw of %s', async (_label, make) => {
      asyncStorageMock.setItem.mockImplementation(() => {
        throw make();
      });

      const result = await mobileSavedLocationPersistence.save(collectionOf({ id: 'a' }));

      expect(result).toEqual({ ok: false, error: { kind: 'STORAGE_WRITE_FAILED' } });
      expect(JSON.stringify(result)).not.toContain(SECRET_MARKER);
    });

    it.each(thrownValues)('maps a setItem promise rejection of %s', async (_label, make) => {
      asyncStorageMock.setItem.mockRejectedValue(make());

      const result = await mobileSavedLocationPersistence.save(collectionOf({ id: 'a' }));

      expect(result).toEqual({ ok: false, error: { kind: 'STORAGE_WRITE_FAILED' } });
      expect(JSON.stringify(result)).not.toContain(SECRET_MARKER);
    });
  });

  describe('clear → STORAGE_CLEAR_FAILED', () => {
    it.each(thrownValues)('maps a synchronous removeItem throw of %s', async (_label, make) => {
      asyncStorageMock.removeItem.mockImplementation(() => {
        throw make();
      });

      const result = await mobileSavedLocationPersistence.clear();

      expect(result).toEqual({ ok: false, error: { kind: 'STORAGE_CLEAR_FAILED' } });
      expect(JSON.stringify(result)).not.toContain(SECRET_MARKER);
    });

    it.each(thrownValues)('maps a removeItem promise rejection of %s', async (_label, make) => {
      asyncStorageMock.removeItem.mockRejectedValue(make());

      const result = await mobileSavedLocationPersistence.clear();

      expect(result).toEqual({ ok: false, error: { kind: 'STORAGE_CLEAR_FAILED' } });
      expect(JSON.stringify(result)).not.toContain(SECRET_MARKER);
    });
  });
});

// ---------------------------------------------------------------------------
// 10.9 — the broad AsyncStorage API is never used across load / save / clear
// ---------------------------------------------------------------------------

describe('mobileSavedLocationPersistence — minimal provider surface', () => {
  it('drives load, save, and clear without ever calling a broad AsyncStorage operation', async () => {
    asyncStorageMock.getItem.mockResolvedValue(serializedOf({ id: 'a' }));

    await mobileSavedLocationPersistence.load();
    await mobileSavedLocationPersistence.save(collectionOf({ id: 'a' }));
    await mobileSavedLocationPersistence.clear();

    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(1);
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(1);
    expect(asyncStorageMock.removeItem).toHaveBeenCalledTimes(1);
    expectNoBroadApi();
  });
});

// ---------------------------------------------------------------------------
// 10.10 — fresh, fixed, non-native-referencing errors on repeated failures
// ---------------------------------------------------------------------------

describe('mobileSavedLocationPersistence — fresh errors', () => {
  it('returns distinct result and nested error references for the same read failure twice', async () => {
    const nativeError = new Error(SECRET_MARKER);
    asyncStorageMock.getItem.mockRejectedValue(nativeError);

    const first = await mobileSavedLocationPersistence.load();
    const second = await mobileSavedLocationPersistence.load();

    expect(first).not.toBe(second);
    if (first.ok || second.ok) throw new Error('expected read failures');
    expect(first.error).not.toBe(second.error);
    expect(first).toEqual(second);
    // The native error object is never referenced by the public result.
    expect(first.error).not.toBe(nativeError as unknown);
    expect(JSON.stringify(first)).toBe('{"ok":false,"error":{"kind":"STORAGE_READ_FAILED"}}');
    expect(JSON.stringify(second)).not.toContain(SECRET_MARKER);
  });

  it('returns distinct result and nested error references for the same write failure twice', async () => {
    asyncStorageMock.setItem.mockRejectedValue(new Error(SECRET_MARKER));

    const first = await mobileSavedLocationPersistence.save(collectionOf({ id: 'a' }));
    const second = await mobileSavedLocationPersistence.save(collectionOf({ id: 'a' }));

    expect(first).not.toBe(second);
    if (first.ok || second.ok) throw new Error('expected write failures');
    expect(first.error).not.toBe(second.error);
    expect(first).toEqual(second);
  });
});
