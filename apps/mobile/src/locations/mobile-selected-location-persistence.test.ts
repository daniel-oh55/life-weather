import { describe, expect, it } from 'vitest';

import {
  SELECTED_LOCATION_PERSISTENCE_KEY,
  SELECTED_LOCATION_PERSISTENCE_VERSION,
  createSelectedLocationPersistence,
  decodeSelectedLocationId,
  encodeSelectedLocationId,
  mobileSelectedLocationPersistenceEnvelopeV1,
  type SelectedLocationKeyValueStorage,
} from './index';

// ---------------------------------------------------------------------------
// Synthetic fixtures. Everything here is fabricated — synthetic ids only — so no real user
// location, stored place, or device identifier is ever used.
// ---------------------------------------------------------------------------

/** A marker asserted absent from any failure result — proves nothing input-derived leaks out. */
const SECRET_MARKER = 'SYNTHETIC_SELECTED_LOCATION_SECRET_MUST_NOT_LEAK';

/** All tokens that must never appear in a serialized failure result. */
const FORBIDDEN_IN_ERRORS = [
  SECRET_MARKER,
  SELECTED_LOCATION_PERSISTENCE_KEY,
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
  storage: SelectedLocationKeyValueStorage;
  getItemKeys: string[];
  setItemCalls: { key: string; value: string }[];
}

/** A storage whose two methods record every call and follow the configured behavior. */
function createSpyStorage(
  behaviors: {
    getItem?: Behavior<unknown>;
    setItem?: Behavior<void>;
  } = {},
): SpyStorage {
  const getItemKeys: string[] = [];
  const setItemCalls: { key: string; value: string }[] = [];

  function apply<T>(behavior: Behavior<T> | undefined, fallback: T): Promise<T> {
    if (behavior === undefined || behavior.type === 'resolve') {
      return Promise.resolve(behavior === undefined ? fallback : behavior.value);
    }
    if (behavior.type === 'throw') {
      throw behavior.error;
    }
    return Promise.reject(behavior.error);
  }

  const storage: SelectedLocationKeyValueStorage = {
    getItem(key) {
      getItemKeys.push(key);
      return apply(behaviors.getItem, null) as Promise<string | null>;
    },
    setItem(key, value) {
      setItemCalls.push({ key, value });
      return apply<void>(behaviors.setItem, undefined);
    },
  };

  return { storage, getItemKeys, setItemCalls };
}

/** A stateful in-memory store, for tests that must observe a persisted value across calls. */
function createInMemoryStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  const storage: SelectedLocationKeyValueStorage = {
    async getItem(key) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    async setItem(key, value) {
      map.set(key, value);
    },
  };
  return { storage, map };
}

/** Encode an id and return the serialized V1 string (throws in-test if encoding failed). */
function serializedOf(id: string | null): string {
  const encoded = encodeSelectedLocationId(id);
  if (!encoded.ok) throw new Error('fixture encode failed');
  return encoded.serialized;
}

// ---------------------------------------------------------------------------
// envelope schema
// ---------------------------------------------------------------------------

describe('mobileSelectedLocationPersistenceEnvelopeV1', () => {
  it('accepts a string id', () => {
    expect(
      mobileSelectedLocationPersistenceEnvelopeV1.safeParse({
        version: 1,
        selectedLocationId: 'kr_abc',
      }).success,
    ).toBe(true);
  });

  it('accepts a null id', () => {
    expect(
      mobileSelectedLocationPersistenceEnvelopeV1.safeParse({
        version: 1,
        selectedLocationId: null,
      }).success,
    ).toBe(true);
  });

  it('rejects an empty-string id', () => {
    expect(
      mobileSelectedLocationPersistenceEnvelopeV1.safeParse({ version: 1, selectedLocationId: '' })
        .success,
    ).toBe(false);
  });

  it('rejects a missing selectedLocationId', () => {
    expect(mobileSelectedLocationPersistenceEnvelopeV1.safeParse({ version: 1 }).success).toBe(
      false,
    );
  });

  it('rejects an unknown top-level field', () => {
    expect(
      mobileSelectedLocationPersistenceEnvelopeV1.safeParse({
        version: 1,
        selectedLocationId: null,
        extra: 1,
      }).success,
    ).toBe(false);
  });

  it('rejects a wrong version literal', () => {
    expect(
      mobileSelectedLocationPersistenceEnvelopeV1.safeParse({
        version: 2,
        selectedLocationId: null,
      }).success,
    ).toBe(false);
  });

  it('rejects a non-string, non-null id', () => {
    expect(
      mobileSelectedLocationPersistenceEnvelopeV1.safeParse({ version: 1, selectedLocationId: 42 })
        .success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// key and version are stable and distinct from the saved-location envelope
// ---------------------------------------------------------------------------

describe('key and version constants', () => {
  it('uses a stable key distinct from the saved-location key', async () => {
    const { SAVED_LOCATION_PERSISTENCE_KEY } = await import('./index');
    expect(SELECTED_LOCATION_PERSISTENCE_KEY).toBe('@life-weather/mobile/selected-location');
    expect(SELECTED_LOCATION_PERSISTENCE_KEY).not.toBe(SAVED_LOCATION_PERSISTENCE_KEY);
  });

  it('declares version 1', () => {
    expect(SELECTED_LOCATION_PERSISTENCE_VERSION).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// encode
// ---------------------------------------------------------------------------

describe('encodeSelectedLocationId', () => {
  it('encodes a string id to the exact { version, selectedLocationId } shape', () => {
    const encoded = encodeSelectedLocationId('kr_abc');
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const parsed = JSON.parse(encoded.serialized) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['version', 'selectedLocationId']);
    expect(parsed.version).toBe(SELECTED_LOCATION_PERSISTENCE_VERSION);
    expect(parsed.selectedLocationId).toBe('kr_abc');
  });

  it('encodes null explicitly (not by omission)', () => {
    const encoded = encodeSelectedLocationId(null);
    expect(encoded).toEqual({ ok: true, serialized: '{"version":1,"selectedLocationId":null}' });
  });

  it('produces single-line valid JSON', () => {
    const encoded = encodeSelectedLocationId('kr_abc');
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(encoded.serialized).not.toContain('\n');
    expect(() => JSON.parse(encoded.serialized)).not.toThrow();
  });

  it('round-trips a string id', () => {
    const encoded = encodeSelectedLocationId('kr_xyz');
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = decodeSelectedLocationId(encoded.serialized);
    expect(decoded).toEqual({ ok: true, selectedLocationId: 'kr_xyz' });
  });

  it('round-trips null', () => {
    const encoded = encodeSelectedLocationId(null);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = decodeSelectedLocationId(encoded.serialized);
    expect(decoded).toEqual({ ok: true, selectedLocationId: null });
  });

  it('is deterministic across repeated calls', () => {
    const first = encodeSelectedLocationId('kr_abc');
    const second = encodeSelectedLocationId('kr_abc');
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.serialized).toBe(second.serialized);
  });

  it.each([
    ['an empty string', ''],
    ['a number', 42],
    ['an object', {}],
    ['undefined', undefined],
    ['a boolean', true],
  ])('rejects %s as INVALID_SELECTED_LOCATION_ID', (_label, input) => {
    expect(encodeSelectedLocationId(input as unknown)).toEqual({
      ok: false,
      error: { kind: 'INVALID_SELECTED_LOCATION_ID' },
    });
  });

  it.each([
    ['a function', () => undefined],
    ['a symbol', Symbol('x')],
    ['undefined', undefined],
    ['a plain object', { any: 'thing' }],
  ])('never throws for invalid input (%s)', (_label, input) => {
    expect(() => encodeSelectedLocationId(input as unknown)).not.toThrow();
  });

  it('returns a fresh error object each call', () => {
    const first = encodeSelectedLocationId(42);
    const second = encodeSelectedLocationId(42);
    expect(first).not.toBe(second);
    if (first.ok || second.ok) throw new Error('expected failures');
    expect(first.error).not.toBe(second.error);
  });
});

// ---------------------------------------------------------------------------
// decode
// ---------------------------------------------------------------------------

describe('decodeSelectedLocationId', () => {
  it('decodes a valid string-id envelope', () => {
    const decoded = decodeSelectedLocationId(serializedOf('kr_abc'));
    expect(decoded).toEqual({ ok: true, selectedLocationId: 'kr_abc' });
  });

  it('decodes a valid null-id envelope', () => {
    const decoded = decodeSelectedLocationId(serializedOf(null));
    expect(decoded).toEqual({ ok: true, selectedLocationId: null });
  });

  it.each([
    ['a number', 42],
    ['an object', {}],
    ['null', null],
    ['undefined', undefined],
  ])('rejects non-string input (%s) as INVALID_STORED_SELECTION', (_label, input) => {
    expect(decodeSelectedLocationId(input as unknown)).toEqual({
      ok: false,
      error: { kind: 'INVALID_STORED_SELECTION' },
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
    ['a missing version', '{"selectedLocationId":null}'],
    ['a string version', '{"version":"2","selectedLocationId":null}'],
    ['a null version', '{"version":null,"selectedLocationId":null}'],
    ['a fractional version', '{"version":1.5,"selectedLocationId":null}'],
    ['a top-level extra key', '{"version":1,"selectedLocationId":null,"extra":1}'],
    ['a missing selectedLocationId', '{"version":1}'],
    ['an empty-string selectedLocationId', '{"version":1,"selectedLocationId":""}'],
    ['a numeric selectedLocationId', '{"version":1,"selectedLocationId":42}'],
  ])('rejects %s as INVALID_STORED_SELECTION', (_label, raw) => {
    expect(decodeSelectedLocationId(raw)).toEqual({
      ok: false,
      error: { kind: 'INVALID_STORED_SELECTION' },
    });
  });

  it.each([
    ['integer version 0', '{"version":0,"selectedLocationId":null}'],
    ['integer version 2', '{"version":2,"selectedLocationId":null}'],
    ['a large integer version', '{"version":99,"selectedLocationId":null}'],
  ])('classifies %s as UNSUPPORTED_STORED_VERSION', (_label, raw) => {
    expect(decodeSelectedLocationId(raw)).toEqual({
      ok: false,
      error: { kind: 'UNSUPPORTED_STORED_VERSION' },
    });
  });

  it('exposes only { kind } on failure', () => {
    const serialized = JSON.stringify(decodeSelectedLocationId(SECRET_MARKER));
    expect(serialized).toBe('{"ok":false,"error":{"kind":"INVALID_STORED_SELECTION"}}');
    for (const forbidden of FORBIDDEN_IN_ERRORS) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('never throws for hostile inputs', () => {
    expect(() => decodeSelectedLocationId(Symbol('x') as unknown)).not.toThrow();
    expect(() => decodeSelectedLocationId(() => undefined)).not.toThrow();
    expect(() => decodeSelectedLocationId('{"version":1')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// load
// ---------------------------------------------------------------------------

describe('createSelectedLocationPersistence().load', () => {
  it('reads the exact key exactly once', async () => {
    const spy = createSpyStorage({ getItem: { type: 'resolve', value: serializedOf('kr_abc') } });
    await createSelectedLocationPersistence(spy.storage).load();
    expect(spy.getItemKeys).toEqual([SELECTED_LOCATION_PERSISTENCE_KEY]);
  });

  it('returns a successful null selection when the key is missing', async () => {
    const spy = createSpyStorage({ getItem: { type: 'resolve', value: null } });
    const result = await createSelectedLocationPersistence(spy.storage).load();
    expect(result).toEqual({ ok: true, selectedLocationId: null });
  });

  it('loads a valid stored string id', async () => {
    const spy = createSpyStorage({ getItem: { type: 'resolve', value: serializedOf('kr_abc') } });
    const result = await createSelectedLocationPersistence(spy.storage).load();
    expect(result).toEqual({ ok: true, selectedLocationId: 'kr_abc' });
  });

  it('loads a valid stored null id', async () => {
    const spy = createSpyStorage({ getItem: { type: 'resolve', value: serializedOf(null) } });
    const result = await createSelectedLocationPersistence(spy.storage).load();
    expect(result).toEqual({ ok: true, selectedLocationId: null });
  });

  it('fails closed on a malformed stored value', async () => {
    const spy = createSpyStorage({ getItem: { type: 'resolve', value: '{not json' } });
    const result = await createSelectedLocationPersistence(spy.storage).load();
    expect(result).toEqual({ ok: false, error: { kind: 'INVALID_STORED_SELECTION' } });
  });

  it('reports an unsupported stored version', async () => {
    const spy = createSpyStorage({
      getItem: { type: 'resolve', value: '{"version":2,"selectedLocationId":null}' },
    });
    const result = await createSelectedLocationPersistence(spy.storage).load();
    expect(result).toEqual({ ok: false, error: { kind: 'UNSUPPORTED_STORED_VERSION' } });
  });

  it('maps a synchronous getItem throw to STORAGE_READ_FAILED', async () => {
    const spy = createSpyStorage({ getItem: { type: 'throw', error: new Error(SECRET_MARKER) } });
    const result = await createSelectedLocationPersistence(spy.storage).load();
    expect(result).toEqual({ ok: false, error: { kind: 'STORAGE_READ_FAILED' } });
  });

  it('maps an asynchronous getItem rejection to STORAGE_READ_FAILED', async () => {
    const spy = createSpyStorage({ getItem: { type: 'reject', error: new Error(SECRET_MARKER) } });
    const result = await createSelectedLocationPersistence(spy.storage).load();
    expect(result).toEqual({ ok: false, error: { kind: 'STORAGE_READ_FAILED' } });
  });

  it('never writes on corrupt data', async () => {
    const spy = createSpyStorage({ getItem: { type: 'resolve', value: '{not json' } });
    await createSelectedLocationPersistence(spy.storage).load();
    expect(spy.setItemCalls).toEqual([]);
  });

  it('never migrates on an unsupported version', async () => {
    const spy = createSpyStorage({
      getItem: { type: 'resolve', value: '{"version":2,"selectedLocationId":null}' },
    });
    await createSelectedLocationPersistence(spy.storage).load();
    expect(spy.setItemCalls).toEqual([]);
  });

  it('does not expose the raw stored value on failure', async () => {
    const spy = createSpyStorage({ getItem: { type: 'resolve', value: SECRET_MARKER } });
    const result = await createSelectedLocationPersistence(spy.storage).load();
    const serialized = JSON.stringify(result);
    for (const forbidden of FORBIDDEN_IN_ERRORS) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// save
// ---------------------------------------------------------------------------

describe('createSelectedLocationPersistence().save', () => {
  it('writes the exact key and V1 value exactly once for a string id', async () => {
    const spy = createSpyStorage();
    const result = await createSelectedLocationPersistence(spy.storage).save('kr_abc');
    expect(result).toEqual({ ok: true });
    expect(spy.setItemCalls).toHaveLength(1);
    expect(spy.setItemCalls[0].key).toBe(SELECTED_LOCATION_PERSISTENCE_KEY);
    expect(spy.setItemCalls[0].value).toBe(serializedOf('kr_abc'));
  });

  it('writes an explicit null envelope — never omission — for null', async () => {
    const spy = createSpyStorage();
    const result = await createSelectedLocationPersistence(spy.storage).save(null);
    expect(result).toEqual({ ok: true });
    expect(spy.setItemCalls[0].value).toBe('{"version":1,"selectedLocationId":null}');
  });

  it('writes a value that decodes back to the saved id', async () => {
    const spy = createSpyStorage();
    await createSelectedLocationPersistence(spy.storage).save('kr_abc');
    const written = spy.setItemCalls[0].value;
    expect(JSON.parse(written).version).toBe(SELECTED_LOCATION_PERSISTENCE_VERSION);
    expect(decodeSelectedLocationId(written)).toEqual({ ok: true, selectedLocationId: 'kr_abc' });
  });

  it('rejects an invalid id without touching storage', async () => {
    const spy = createSpyStorage();
    const result = await createSelectedLocationPersistence(spy.storage).save(42);
    expect(result).toEqual({ ok: false, error: { kind: 'INVALID_SELECTED_LOCATION_ID' } });
    expect(spy.setItemCalls).toEqual([]);
    expect(spy.getItemKeys).toEqual([]);
  });

  it('does not overwrite an existing stored value with an invalid id', async () => {
    const existing = serializedOf('kr_existing');
    const { storage, map } = createInMemoryStorage({
      [SELECTED_LOCATION_PERSISTENCE_KEY]: existing,
    });
    const result = await createSelectedLocationPersistence(storage).save(42);
    expect(result.ok).toBe(false);
    expect(map.get(SELECTED_LOCATION_PERSISTENCE_KEY)).toBe(existing);
  });

  it('maps a synchronous setItem throw to STORAGE_WRITE_FAILED', async () => {
    const spy = createSpyStorage({ setItem: { type: 'throw', error: new Error(SECRET_MARKER) } });
    const result = await createSelectedLocationPersistence(spy.storage).save('kr_abc');
    expect(result).toEqual({ ok: false, error: { kind: 'STORAGE_WRITE_FAILED' } });
  });

  it('maps an asynchronous setItem rejection to STORAGE_WRITE_FAILED', async () => {
    const spy = createSpyStorage({ setItem: { type: 'reject', error: new Error(SECRET_MARKER) } });
    const result = await createSelectedLocationPersistence(spy.storage).save('kr_abc');
    expect(result).toEqual({ ok: false, error: { kind: 'STORAGE_WRITE_FAILED' } });
  });

  it('does not read during a save', async () => {
    const spy = createSpyStorage();
    await createSelectedLocationPersistence(spy.storage).save('kr_abc');
    expect(spy.getItemKeys).toEqual([]);
  });

  it('returns a fixed, fresh error object each failing call', async () => {
    const persistence = createSelectedLocationPersistence(createSpyStorage().storage);
    const first = await persistence.save(42);
    const second = await persistence.save(42);
    expect(first).not.toBe(second);
    if (first.ok || second.ok) throw new Error('expected failures');
    expect(first.error).not.toBe(second.error);
  });
});

// ---------------------------------------------------------------------------
// error non-exposure and factory I/O guarantees
// ---------------------------------------------------------------------------

describe('persistence — fixed, non-revealing errors', () => {
  const cases: { kind: string; run: () => Promise<unknown> | unknown }[] = [
    { kind: 'INVALID_SELECTED_LOCATION_ID', run: () => encodeSelectedLocationId({ marker: SECRET_MARKER }) },
    { kind: 'INVALID_STORED_SELECTION', run: () => decodeSelectedLocationId(SECRET_MARKER) },
    {
      kind: 'UNSUPPORTED_STORED_VERSION',
      run: () => decodeSelectedLocationId('{"version":2,"selectedLocationId":null}'),
    },
    {
      kind: 'STORAGE_READ_FAILED',
      run: () =>
        createSelectedLocationPersistence(
          createSpyStorage({ getItem: { type: 'reject', error: new Error(SECRET_MARKER) } }).storage,
        ).load(),
    },
    {
      kind: 'STORAGE_WRITE_FAILED',
      run: () =>
        createSelectedLocationPersistence(
          createSpyStorage({ setItem: { type: 'reject', error: new Error(SECRET_MARKER) } }).storage,
        ).save('kr_abc'),
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

describe('factory I/O guarantees', () => {
  it('performs no storage I/O on construction', () => {
    const spy = createSpyStorage();
    createSelectedLocationPersistence(spy.storage);
    expect(spy.getItemKeys).toEqual([]);
    expect(spy.setItemCalls).toEqual([]);
  });
});
