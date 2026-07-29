import { describe, expect, it } from 'vitest';

import {
  SAVED_LOCATION_PERSISTENCE_KEY,
  SAVED_LOCATION_PERSISTENCE_VERSION,
  createSavedLocationPersistence,
  decodeSavedLocationCollection,
  encodeSavedLocationCollection,
  mobileSavedLocationPersistenceEnvelopeV1,
  type MobileSavedLocation,
  type SavedLocationKeyValueStorage,
} from './index';

// ---------------------------------------------------------------------------
// Synthetic fixtures. Everything here is fabricated — synthetic ids, display names, and
// coordinates, and a non-sensitive standard timezone — so no real user location, stored place,
// or device identifier is ever used. Each builder returns a *fresh* object.
// ---------------------------------------------------------------------------

/** A marker asserted absent from any failure result — proves nothing input-derived leaks out. */
const SECRET_MARKER = 'SYNTHETIC_PERSISTENCE_SECRET_MUST_NOT_LEAK';

/** Distinctive coordinates / grid asserted absent from any failure result. */
const SECRET_LATITUDE = 12.34;
const SECRET_LONGITUDE = 56.78;
const SECRET_NX = 321;
const SECRET_NY = 654;

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

/** A record carrying the secret marker and secret coordinates / grid. */
function markedRecord(id: string, overrides: Partial<MobileSavedLocation> = {}): MobileSavedLocation {
  return record(id, {
    displayName: SECRET_MARKER,
    latitude: SECRET_LATITUDE,
    longitude: SECRET_LONGITUDE,
    kmaGrid: { nx: SECRET_NX, ny: SECRET_NY },
    ...overrides,
  });
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

/** All tokens that must never appear in a serialized failure result. */
const FORBIDDEN_IN_ERRORS = [
  SECRET_MARKER,
  String(SECRET_LATITUDE),
  String(SECRET_LONGITUDE),
  String(SECRET_NX),
  String(SECRET_NY),
  SAVED_LOCATION_PERSISTENCE_KEY,
  'issues',
  'path',
  'message',
  'stack',
  'cause',
];

// ---------------------------------------------------------------------------
// Spy / fake key-value storage.
// ---------------------------------------------------------------------------

type Behavior<T> =
  | { type: 'resolve'; value: T }
  | { type: 'throw'; error: unknown } // synchronous throw, before a promise is returned
  | { type: 'reject'; error: unknown }; // asynchronous rejection

interface SpyStorage {
  storage: SavedLocationKeyValueStorage;
  getItemKeys: string[];
  setItemCalls: { key: string; value: string }[];
  removeItemKeys: string[];
}

/** A storage whose three methods record every call and follow the configured behavior. */
function createSpyStorage(behaviors: {
  getItem?: Behavior<unknown>;
  setItem?: Behavior<void>;
  removeItem?: Behavior<void>;
} = {}): SpyStorage {
  const getItemKeys: string[] = [];
  const setItemCalls: { key: string; value: string }[] = [];
  const removeItemKeys: string[] = [];

  function apply<T>(behavior: Behavior<T> | undefined, fallback: T): Promise<T> {
    if (behavior === undefined || behavior.type === 'resolve') {
      return Promise.resolve(behavior === undefined ? fallback : behavior.value);
    }
    if (behavior.type === 'throw') {
      throw behavior.error;
    }
    return Promise.reject(behavior.error);
  }

  const storage: SavedLocationKeyValueStorage = {
    getItem(key) {
      getItemKeys.push(key);
      return apply(behaviors.getItem, null) as Promise<string | null>;
    },
    setItem(key, value) {
      setItemCalls.push({ key, value });
      return apply<void>(behaviors.setItem, undefined);
    },
    removeItem(key) {
      removeItemKeys.push(key);
      return apply<void>(behaviors.removeItem, undefined);
    },
  };

  return { storage, getItemKeys, setItemCalls, removeItemKeys };
}

/** A stateful in-memory store, for tests that must observe a persisted value across calls. */
function createInMemoryStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  const storage: SavedLocationKeyValueStorage = {
    async getItem(key) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    async setItem(key, value) {
      map.set(key, value);
    },
    async removeItem(key) {
      map.delete(key);
    },
  };
  return { storage, map };
}

/** Encode a collection and return the serialized V1 string (throws in-test if encoding failed). */
function serializedOf(...specs: (Partial<MobileSavedLocation> & { id: string })[]): string {
  const encoded = encodeSavedLocationCollection(collectionOf(...specs));
  if (!encoded.ok) throw new Error('fixture encode failed');
  return encoded.serialized;
}

// ---------------------------------------------------------------------------
// 16.1 — envelope schema
// ---------------------------------------------------------------------------

describe('mobileSavedLocationPersistenceEnvelopeV1', () => {
  it('accepts an empty collection envelope', () => {
    expect(
      mobileSavedLocationPersistenceEnvelopeV1.safeParse({ version: 1, locations: [] }).success,
    ).toBe(true);
  });

  it('accepts an envelope with one location', () => {
    expect(
      mobileSavedLocationPersistenceEnvelopeV1.safeParse({
        version: 1,
        locations: collectionOf({ id: 'a' }),
      }).success,
    ).toBe(true);
  });

  it('accepts an envelope with several locations', () => {
    expect(
      mobileSavedLocationPersistenceEnvelopeV1.safeParse({
        version: 1,
        locations: collectionOf({ id: 'a' }, { id: 'b', isCurrent: true }, { id: 'c' }),
      }).success,
    ).toBe(true);
  });

  it('rejects a duplicate id', () => {
    const locations = [record('dup', { sortOrder: 0 }), record('dup', { sortOrder: 1 })];
    expect(
      mobileSavedLocationPersistenceEnvelopeV1.safeParse({ version: 1, locations }).success,
    ).toBe(false);
  });

  it('rejects two current locations', () => {
    const locations = [
      record('a', { sortOrder: 0, isCurrent: true }),
      record('b', { sortOrder: 1, isCurrent: true }),
    ];
    expect(
      mobileSavedLocationPersistenceEnvelopeV1.safeParse({ version: 1, locations }).success,
    ).toBe(false);
  });

  it('rejects a non-canonical sortOrder', () => {
    const locations = [record('a', { sortOrder: 1 }), record('b', { sortOrder: 0 })];
    expect(
      mobileSavedLocationPersistenceEnvelopeV1.safeParse({ version: 1, locations }).success,
    ).toBe(false);
  });

  it('rejects an unknown top-level field', () => {
    expect(
      mobileSavedLocationPersistenceEnvelopeV1.safeParse({ version: 1, locations: [], extra: 1 })
        .success,
    ).toBe(false);
  });

  it('rejects a wrong version literal', () => {
    expect(
      mobileSavedLocationPersistenceEnvelopeV1.safeParse({ version: 2, locations: [] }).success,
    ).toBe(false);
  });

  it('rejects an unknown field on a record', () => {
    const locations = [{ ...record('a', { sortOrder: 0 }), extra: 'nope' }];
    expect(
      mobileSavedLocationPersistenceEnvelopeV1.safeParse({ version: 1, locations }).success,
    ).toBe(false);
  });

  it('rejects an unknown field nested in kmaGrid', () => {
    const locations = [
      record('a', { sortOrder: 0, kmaGrid: { nx: 60, ny: 127, extra: 1 } as never }),
    ];
    expect(
      mobileSavedLocationPersistenceEnvelopeV1.safeParse({ version: 1, locations }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 16.2 — encode
// ---------------------------------------------------------------------------

describe('encodeSavedLocationCollection', () => {
  it('encodes an empty collection', () => {
    const encoded = encodeSavedLocationCollection([]);
    expect(encoded).toEqual({ ok: true, serialized: '{"version":1,"locations":[]}' });
  });

  it('encodes several locations to the exact { version, locations } shape', () => {
    const encoded = encodeSavedLocationCollection(collectionOf({ id: 'a' }, { id: 'b' }));
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const parsed = JSON.parse(encoded.serialized) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['version', 'locations']);
    expect(parsed.version).toBe(SAVED_LOCATION_PERSISTENCE_VERSION);
    expect((parsed.locations as unknown[]).length).toBe(2);
  });

  it('produces single-line valid JSON', () => {
    const encoded = encodeSavedLocationCollection(collectionOf({ id: 'a' }));
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(encoded.serialized).not.toContain('\n');
    expect(() => JSON.parse(encoded.serialized)).not.toThrow();
  });

  it('round-trips: decoding the encoded value equals the canonical collection', () => {
    const canonical = collectionOf({ id: 'a', isCurrent: true }, { id: 'b', kmaGrid: null });
    const encoded = encodeSavedLocationCollection(canonical);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = decodeSavedLocationCollection(encoded.serialized);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.locations).toEqual(canonical);
  });

  it('is deterministic across repeated calls', () => {
    const canonical = collectionOf({ id: 'a' }, { id: 'b' }, { id: 'c' });
    const first = encodeSavedLocationCollection(canonical);
    const second = encodeSavedLocationCollection(canonical);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.serialized).toBe(second.serialized);
  });

  it.each([
    ['a non-array', {}],
    ['null', null],
    ['a duplicate id', [record('dup', { sortOrder: 0 }), record('dup', { sortOrder: 1 })]],
    ['two current locations', [
      record('a', { sortOrder: 0, isCurrent: true }),
      record('b', { sortOrder: 1, isCurrent: true }),
    ]],
    ['a non-canonical sortOrder', [record('a', { sortOrder: 5 })]],
    ['an invalid record', [{ ...record('a', { sortOrder: 0 }), latitude: 91 }]],
  ])('rejects %s as INVALID_COLLECTION', (_label, input) => {
    expect(encodeSavedLocationCollection(input as unknown)).toEqual({
      ok: false,
      error: { kind: 'INVALID_COLLECTION' },
    });
  });

  it('does not touch storage for an invalid collection (pure result)', () => {
    // Purely a value-in / value-out function; nothing to spy on, but this documents the guarantee.
    const result = encodeSavedLocationCollection({ nope: true });
    expect(result.ok).toBe(false);
  });

  it('does not silently store an unknown record field', () => {
    const withExtra = [{ ...record('a', { sortOrder: 0 }), extra: 'nope' }];
    expect(encodeSavedLocationCollection(withExtra as unknown)).toEqual({
      ok: false,
      error: { kind: 'INVALID_COLLECTION' },
    });
  });

  it('does not mutate a deep-frozen input', () => {
    const canonical = collectionOf({ id: 'a', isCurrent: true }, { id: 'b' });
    const snapshot = JSON.stringify(canonical);
    deepFreeze(canonical);
    expect(() => encodeSavedLocationCollection(canonical)).not.toThrow();
    expect(JSON.stringify(canonical)).toBe(snapshot);
  });

  it.each([
    ['a function', () => undefined],
    ['a symbol', Symbol('x')],
    ['null', null],
    ['undefined', undefined],
    ['a plain object', { any: 'thing' }],
  ])('never throws for invalid input (%s)', (_label, input) => {
    expect(() => encodeSavedLocationCollection(input as unknown)).not.toThrow();
  });

  it('returns a fresh error object each call', () => {
    const first = encodeSavedLocationCollection({});
    const second = encodeSavedLocationCollection({});
    expect(first).not.toBe(second);
    if (first.ok || second.ok) throw new Error('expected failures');
    expect(first.error).not.toBe(second.error);
  });
});

// ---------------------------------------------------------------------------
// 16.3 — decode
// ---------------------------------------------------------------------------

describe('decodeSavedLocationCollection', () => {
  it('decodes a valid empty envelope', () => {
    const decoded = decodeSavedLocationCollection('{"version":1,"locations":[]}');
    expect(decoded).toEqual({ ok: true, locations: [] });
  });

  it('decodes a valid multi-location envelope', () => {
    const decoded = decodeSavedLocationCollection(serializedOf({ id: 'a' }, { id: 'b' }));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.locations.map((location) => location.id)).toEqual(['a', 'b']);
  });

  it.each([
    ['a number', 42],
    ['an object', {}],
    ['null', null],
    ['undefined', undefined],
  ])('rejects non-string input (%s) as INVALID_STORED_LOCATIONS', (_label, input) => {
    expect(decodeSavedLocationCollection(input as unknown)).toEqual({
      ok: false,
      error: { kind: 'INVALID_STORED_LOCATIONS' },
    });
  });

  it.each([
    ['empty string', ''],
    ['malformed JSON', '{not json'],
    ['a JSON number primitive', '42'],
    ['a JSON string primitive', '"hello"'],
    ['a JSON boolean primitive', 'true'],
    ['a JSON null', 'null'],
    ['a JSON array', '[]'],
    ['a missing version', '{"locations":[]}'],
    ['a string version', '{"version":"2","locations":[]}'],
    ['a null version', '{"version":null,"locations":[]}'],
    ['a fractional version', '{"version":1.5,"locations":[]}'],
    ['a top-level extra key', '{"version":1,"locations":[],"extra":1}'],
    ['missing locations', '{"version":1}'],
    ['a non-array locations', '{"version":1,"locations":{}}'],
  ])('rejects %s as INVALID_STORED_LOCATIONS', (_label, raw) => {
    expect(decodeSavedLocationCollection(raw)).toEqual({
      ok: false,
      error: { kind: 'INVALID_STORED_LOCATIONS' },
    });
  });

  it.each([
    ['integer version 0', '{"version":0,"locations":[]}'],
    ['integer version 2', '{"version":2,"locations":[]}'],
    ['a large integer version', '{"version":99,"locations":[]}'],
  ])('classifies %s as UNSUPPORTED_STORED_VERSION', (_label, raw) => {
    expect(decodeSavedLocationCollection(raw)).toEqual({
      ok: false,
      error: { kind: 'UNSUPPORTED_STORED_VERSION' },
    });
  });

  it('rejects a stored duplicate id', () => {
    const raw = JSON.stringify({
      version: 1,
      locations: [record('dup', { sortOrder: 0 }), record('dup', { sortOrder: 1 })],
    });
    expect(decodeSavedLocationCollection(raw)).toEqual({
      ok: false,
      error: { kind: 'INVALID_STORED_LOCATIONS' },
    });
  });

  it('rejects a stored current conflict', () => {
    const raw = JSON.stringify({
      version: 1,
      locations: [
        record('a', { sortOrder: 0, isCurrent: true }),
        record('b', { sortOrder: 1, isCurrent: true }),
      ],
    });
    expect(decodeSavedLocationCollection(raw)).toEqual({
      ok: false,
      error: { kind: 'INVALID_STORED_LOCATIONS' },
    });
  });

  it('rejects a stored sortOrder mismatch', () => {
    const raw = JSON.stringify({ version: 1, locations: [record('a', { sortOrder: 3 })] });
    expect(decodeSavedLocationCollection(raw)).toEqual({
      ok: false,
      error: { kind: 'INVALID_STORED_LOCATIONS' },
    });
  });

  it('rejects a stored record with an unknown field', () => {
    const raw = JSON.stringify({
      version: 1,
      locations: [{ ...record('a', { sortOrder: 0 }), extra: 'nope' }],
    });
    expect(decodeSavedLocationCollection(raw)).toEqual({
      ok: false,
      error: { kind: 'INVALID_STORED_LOCATIONS' },
    });
  });

  it('rejects a stored grid with an unknown field', () => {
    const raw = JSON.stringify({
      version: 1,
      locations: [record('a', { sortOrder: 0, kmaGrid: { nx: 1, ny: 2, extra: 3 } as never })],
    });
    expect(decodeSavedLocationCollection(raw)).toEqual({
      ok: false,
      error: { kind: 'INVALID_STORED_LOCATIONS' },
    });
  });

  it('exposes only { kind } on failure', () => {
    const raw = JSON.stringify({ version: 1, locations: [markedRecord('a'), markedRecord('a')] });
    const decoded = decodeSavedLocationCollection(raw);
    const serialized = JSON.stringify(decoded);
    expect(serialized).toBe('{"ok":false,"error":{"kind":"INVALID_STORED_LOCATIONS"}}');
    for (const forbidden of FORBIDDEN_IN_ERRORS) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('returns fresh references when the same raw is decoded twice', () => {
    const raw = serializedOf({ id: 'a' }, { id: 'b' });
    const first = decodeSavedLocationCollection(raw);
    const second = decodeSavedLocationCollection(raw);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expectDistinctLocations(first.locations, second.locations);
  });

  it('never throws for hostile inputs', () => {
    expect(() => decodeSavedLocationCollection(Symbol('x') as unknown)).not.toThrow();
    expect(() => decodeSavedLocationCollection(() => undefined)).not.toThrow();
    expect(() => decodeSavedLocationCollection('{"version":1')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 16.4 — load
// ---------------------------------------------------------------------------

describe('createSavedLocationPersistence().load', () => {
  it('reads the exact key exactly once', async () => {
    const spy = createSpyStorage({ getItem: { type: 'resolve', value: serializedOf({ id: 'a' }) } });
    await createSavedLocationPersistence(spy.storage).load();
    expect(spy.getItemKeys).toEqual([SAVED_LOCATION_PERSISTENCE_KEY]);
  });

  it('returns a fresh empty collection when the key is missing', async () => {
    const spy = createSpyStorage({ getItem: { type: 'resolve', value: null } });
    const result = await createSavedLocationPersistence(spy.storage).load();
    expect(result).toEqual({ ok: true, locations: [] });
  });

  it('returns fresh empty arrays across missing-key loads', async () => {
    const persistence = createSavedLocationPersistence(
      createSpyStorage({ getItem: { type: 'resolve', value: null } }).storage,
    );
    const first = await persistence.load();
    const second = await persistence.load();
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.locations).not.toBe(second.locations);
  });

  it('loads a valid stored envelope', async () => {
    const spy = createSpyStorage({
      getItem: { type: 'resolve', value: serializedOf({ id: 'a' }, { id: 'b', isCurrent: true }) },
    });
    const result = await createSavedLocationPersistence(spy.storage).load();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.locations.map((location) => location.id)).toEqual(['a', 'b']);
  });

  it('fails closed on a malformed stored value', async () => {
    const spy = createSpyStorage({ getItem: { type: 'resolve', value: '{not json' } });
    const result = await createSavedLocationPersistence(spy.storage).load();
    expect(result).toEqual({ ok: false, error: { kind: 'INVALID_STORED_LOCATIONS' } });
  });

  it('reports an unsupported stored version', async () => {
    const spy = createSpyStorage({
      getItem: { type: 'resolve', value: '{"version":2,"locations":[]}' },
    });
    const result = await createSavedLocationPersistence(spy.storage).load();
    expect(result).toEqual({ ok: false, error: { kind: 'UNSUPPORTED_STORED_VERSION' } });
  });

  it('treats a runtime non-string return as INVALID_STORED_LOCATIONS', async () => {
    const spy = createSpyStorage({ getItem: { type: 'resolve', value: 42 } });
    const result = await createSavedLocationPersistence(spy.storage).load();
    expect(result).toEqual({ ok: false, error: { kind: 'INVALID_STORED_LOCATIONS' } });
  });

  it('maps a synchronous getItem throw to STORAGE_READ_FAILED', async () => {
    const spy = createSpyStorage({ getItem: { type: 'throw', error: new Error(SECRET_MARKER) } });
    const result = await createSavedLocationPersistence(spy.storage).load();
    expect(result).toEqual({ ok: false, error: { kind: 'STORAGE_READ_FAILED' } });
  });

  it('maps an asynchronous getItem rejection to STORAGE_READ_FAILED', async () => {
    const spy = createSpyStorage({ getItem: { type: 'reject', error: new Error(SECRET_MARKER) } });
    const result = await createSavedLocationPersistence(spy.storage).load();
    expect(result).toEqual({ ok: false, error: { kind: 'STORAGE_READ_FAILED' } });
  });

  it('never writes or removes on corrupt data', async () => {
    const spy = createSpyStorage({ getItem: { type: 'resolve', value: '{not json' } });
    await createSavedLocationPersistence(spy.storage).load();
    expect(spy.setItemCalls).toEqual([]);
    expect(spy.removeItemKeys).toEqual([]);
  });

  it('never migrates or removes on an unsupported version', async () => {
    const spy = createSpyStorage({
      getItem: { type: 'resolve', value: '{"version":2,"locations":[]}' },
    });
    await createSavedLocationPersistence(spy.storage).load();
    expect(spy.setItemCalls).toEqual([]);
    expect(spy.removeItemKeys).toEqual([]);
  });

  it('returns fresh references across repeated loads of the same stored value', async () => {
    const persistence = createSavedLocationPersistence(
      createSpyStorage({ getItem: { type: 'resolve', value: serializedOf({ id: 'a' }) } }).storage,
    );
    const first = await persistence.load();
    const second = await persistence.load();
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expectDistinctLocations(first.locations, second.locations);
  });

  it('does not expose the raw stored value on failure', async () => {
    const raw = JSON.stringify({ version: 1, locations: [markedRecord('a'), markedRecord('a')] });
    const spy = createSpyStorage({ getItem: { type: 'resolve', value: raw } });
    const result = await createSavedLocationPersistence(spy.storage).load();
    const serialized = JSON.stringify(result);
    for (const forbidden of FORBIDDEN_IN_ERRORS) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// 16.5 — save
// ---------------------------------------------------------------------------

describe('createSavedLocationPersistence().save', () => {
  it('writes the exact key and V1 value exactly once', async () => {
    const spy = createSpyStorage();
    const collection = collectionOf({ id: 'a' }, { id: 'b' });
    const result = await createSavedLocationPersistence(spy.storage).save(collection);
    expect(result).toEqual({ ok: true });
    expect(spy.setItemCalls).toHaveLength(1);
    expect(spy.setItemCalls[0].key).toBe(SAVED_LOCATION_PERSISTENCE_KEY);
    const encoded = encodeSavedLocationCollection(collection);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(spy.setItemCalls[0].value).toBe(encoded.serialized);
  });

  it('saves an empty collection', async () => {
    const spy = createSpyStorage();
    const result = await createSavedLocationPersistence(spy.storage).save([]);
    expect(result).toEqual({ ok: true });
    expect(spy.setItemCalls[0].value).toBe('{"version":1,"locations":[]}');
  });

  it('writes a value that decodes back to the saved collection (V1 envelope)', async () => {
    const spy = createSpyStorage();
    const collection = collectionOf({ id: 'a', isCurrent: true }, { id: 'b' });
    await createSavedLocationPersistence(spy.storage).save(collection);
    const written = spy.setItemCalls[0].value;
    expect(JSON.parse(written).version).toBe(SAVED_LOCATION_PERSISTENCE_VERSION);
    const decoded = decodeSavedLocationCollection(written);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.locations).toEqual(collection);
  });

  it('rejects an invalid collection without touching storage', async () => {
    const spy = createSpyStorage();
    const result = await createSavedLocationPersistence(spy.storage).save({ nope: true });
    expect(result).toEqual({ ok: false, error: { kind: 'INVALID_COLLECTION' } });
    expect(spy.setItemCalls).toEqual([]);
    expect(spy.getItemKeys).toEqual([]);
    expect(spy.removeItemKeys).toEqual([]);
  });

  it('does not overwrite an existing stored value with an invalid collection', async () => {
    const existing = serializedOf({ id: 'existing' });
    const { storage, map } = createInMemoryStorage({
      [SAVED_LOCATION_PERSISTENCE_KEY]: existing,
    });
    const result = await createSavedLocationPersistence(storage).save({ nope: true });
    expect(result.ok).toBe(false);
    expect(map.get(SAVED_LOCATION_PERSISTENCE_KEY)).toBe(existing);
  });

  it('maps a synchronous setItem throw to STORAGE_WRITE_FAILED', async () => {
    const spy = createSpyStorage({ setItem: { type: 'throw', error: new Error(SECRET_MARKER) } });
    const result = await createSavedLocationPersistence(spy.storage).save(collectionOf({ id: 'a' }));
    expect(result).toEqual({ ok: false, error: { kind: 'STORAGE_WRITE_FAILED' } });
  });

  it('maps an asynchronous setItem rejection to STORAGE_WRITE_FAILED', async () => {
    const spy = createSpyStorage({ setItem: { type: 'reject', error: new Error(SECRET_MARKER) } });
    const result = await createSavedLocationPersistence(spy.storage).save(collectionOf({ id: 'a' }));
    expect(result).toEqual({ ok: false, error: { kind: 'STORAGE_WRITE_FAILED' } });
  });

  it('does not read or remove during a save', async () => {
    const spy = createSpyStorage();
    await createSavedLocationPersistence(spy.storage).save(collectionOf({ id: 'a' }));
    expect(spy.getItemKeys).toEqual([]);
    expect(spy.removeItemKeys).toEqual([]);
  });

  it('does not mutate a deep-frozen input', async () => {
    const collection = collectionOf({ id: 'a', isCurrent: true }, { id: 'b' });
    const snapshot = JSON.stringify(collection);
    deepFreeze(collection);
    const spy = createSpyStorage();
    await expect(createSavedLocationPersistence(spy.storage).save(collection)).resolves.toEqual({
      ok: true,
    });
    expect(JSON.stringify(collection)).toBe(snapshot);
  });

  it('returns a fixed, fresh error object each failing call', async () => {
    const persistence = createSavedLocationPersistence(createSpyStorage().storage);
    const first = await persistence.save({ nope: true });
    const second = await persistence.save({ nope: true });
    expect(first).not.toBe(second);
    if (first.ok || second.ok) throw new Error('expected failures');
    expect(first.error).not.toBe(second.error);
  });
});

// ---------------------------------------------------------------------------
// 16.6 — clear
// ---------------------------------------------------------------------------

describe('createSavedLocationPersistence().clear', () => {
  it('removes the exact key exactly once and touches nothing else', async () => {
    const spy = createSpyStorage();
    const result = await createSavedLocationPersistence(spy.storage).clear();
    expect(result).toEqual({ ok: true });
    expect(spy.removeItemKeys).toEqual([SAVED_LOCATION_PERSISTENCE_KEY]);
    expect(spy.setItemCalls).toEqual([]);
    expect(spy.getItemKeys).toEqual([]);
  });

  it('maps a synchronous removeItem throw to STORAGE_CLEAR_FAILED', async () => {
    const spy = createSpyStorage({
      removeItem: { type: 'throw', error: new Error(SECRET_MARKER) },
    });
    const result = await createSavedLocationPersistence(spy.storage).clear();
    expect(result).toEqual({ ok: false, error: { kind: 'STORAGE_CLEAR_FAILED' } });
  });

  it('maps an asynchronous removeItem rejection to STORAGE_CLEAR_FAILED', async () => {
    const spy = createSpyStorage({
      removeItem: { type: 'reject', error: new Error(SECRET_MARKER) },
    });
    const result = await createSavedLocationPersistence(spy.storage).clear();
    expect(result).toEqual({ ok: false, error: { kind: 'STORAGE_CLEAR_FAILED' } });
  });

  it('returns a fresh error object each failing call', async () => {
    const persistence = createSavedLocationPersistence(
      createSpyStorage({ removeItem: { type: 'reject', error: new Error('x') } }).storage,
    );
    const first = await persistence.clear();
    const second = await persistence.clear();
    expect(first).not.toBe(second);
    if (first.ok || second.ok) throw new Error('expected failures');
    expect(first.error).not.toBe(second.error);
  });
});

// ---------------------------------------------------------------------------
// 16.7 — error non-exposure across every kind
// ---------------------------------------------------------------------------

describe('persistence — fixed, non-revealing errors', () => {
  const cases: { kind: string; run: () => Promise<unknown> | unknown }[] = [
    {
      kind: 'INVALID_COLLECTION',
      run: () => encodeSavedLocationCollection([markedRecord('dup', { sortOrder: 0 }), markedRecord('dup', { sortOrder: 1 })]),
    },
    {
      kind: 'INVALID_STORED_LOCATIONS',
      run: () =>
        decodeSavedLocationCollection(
          JSON.stringify({ version: 1, locations: [markedRecord('a'), markedRecord('a')] }),
        ),
    },
    {
      kind: 'UNSUPPORTED_STORED_VERSION',
      run: () =>
        decodeSavedLocationCollection(
          JSON.stringify({ version: 2, locations: [markedRecord('a')] }),
        ),
    },
    {
      kind: 'STORAGE_READ_FAILED',
      run: () =>
        createSavedLocationPersistence(
          createSpyStorage({ getItem: { type: 'reject', error: new Error(SECRET_MARKER) } }).storage,
        ).load(),
    },
    {
      kind: 'STORAGE_WRITE_FAILED',
      run: () =>
        createSavedLocationPersistence(
          createSpyStorage({ setItem: { type: 'reject', error: new Error(SECRET_MARKER) } }).storage,
        ).save(collectionOf({ id: 'a' })),
    },
    {
      kind: 'STORAGE_CLEAR_FAILED',
      run: () =>
        createSavedLocationPersistence(
          createSpyStorage({ removeItem: { type: 'reject', error: new Error(SECRET_MARKER) } })
            .storage,
        ).clear(),
    },
  ];

  it.each(cases)('$kind serializes to only { kind } with nothing input-derived', async ({ kind, run }) => {
    const result = await run();
    expect(result).toEqual({ ok: false, error: { kind } });
    const serialized = JSON.stringify(result);
    expect(serialized).toBe(`{"ok":false,"error":{"kind":"${kind}"}}`);
    for (const forbidden of FORBIDDEN_IN_ERRORS) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it.each(cases)('$kind returns a fresh error object each call', async ({ run }) => {
    const first = (await run()) as { ok: boolean; error?: object };
    const second = (await run()) as { ok: boolean; error?: object };
    expect(first).not.toBe(second);
    expect(first.error).not.toBe(second.error);
  });
});
