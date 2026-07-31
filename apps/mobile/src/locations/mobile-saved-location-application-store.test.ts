import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createSavedLocationApplicationStore,
  createSavedLocationHydrationManager,
  createSavedLocationHydrationStore,
  type MobileSavedLocation,
  type SavedLocationApplicationSnapshot,
  type SavedLocationApplicationStore,
  type SavedLocationHydrationStore,
  type SavedLocationPersistence,
  type SavedLocationPersistenceLoadResult,
  type SavedLocationPersistenceSaveResult,
} from './index';

// ---------------------------------------------------------------------------
// Synthetic fixtures. Every value is fabricated — no real user location, stored place, or device
// identifier is used anywhere in this file.
// ---------------------------------------------------------------------------

const SECRET_MARKER = 'SYNTHETIC_APPLICATION_STORE_SECRET_MUST_NOT_LEAK';

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

/** A fresh, valid saved-location record at the given canonical position. */
function record(id: string, sortOrder: number, isCurrent = false): MobileSavedLocation {
  return {
    ...sharedFields(id),
    kmaGrid: { nx: 60, ny: 127 },
    isCurrent,
    sortOrder,
  };
}

/** A fresh, valid add candidate — the record shape **minus** `sortOrder`. */
function candidate(id: string, isCurrent = false) {
  return {
    ...sharedFields(id),
    kmaGrid: { nx: 60, ny: 127 },
    isCurrent,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * A call-recording {@link SavedLocationPersistence}. `load` and `save` are scriptable per test;
 * `clear` always succeeds but exists purely so tests can prove it is **never** called — the last
 * removal must go through `save([])`, not `clear()`.
 */
function recordingPersistence(options: {
  load?: () => Promise<SavedLocationPersistenceLoadResult>;
  save?: (input: unknown) => Promise<SavedLocationPersistenceSaveResult>;
} = {}) {
  const loadMock = vi.fn(
    options.load ?? (async (): Promise<SavedLocationPersistenceLoadResult> => ({ ok: true, locations: [] })),
  );
  const saveMock = vi.fn(
    options.save ?? (async (): Promise<SavedLocationPersistenceSaveResult> => ({ ok: true })),
  );
  const clearMock = vi.fn(async () => ({ ok: true }) as const);

  const persistence: SavedLocationPersistence = {
    load: loadMock,
    save: saveMock,
    clear: clearMock,
  };

  return { persistence, loadMock, saveMock, clearMock };
}

/**
 * Compose the **real** hydration manager, the **real** observable hydration store, and the
 * application store under test over one recording persistence — the same wiring the production
 * composition uses. Nothing about the hydration state machine is faked, so every assertion below
 * runs against the genuine hydration contract this store must preserve.
 */
function buildStore(persistence: SavedLocationPersistence): {
  store: SavedLocationApplicationStore;
  hydrationStore: SavedLocationHydrationStore;
} {
  const hydrationStore = createSavedLocationHydrationStore(
    createSavedLocationHydrationManager(persistence),
  );
  return {
    store: createSavedLocationApplicationStore({ hydrationStore, persistence }),
    hydrationStore,
  };
}

/** Build a store and drive it to its terminal hydration state from the given stored collection. */
async function hydratedStore(stored: MobileSavedLocation[]) {
  const harness = recordingPersistence({
    load: async () => ({ ok: true, locations: stored.map((location) => ({ ...location })) }),
  });
  const { store, hydrationStore } = buildStore(harness.persistence);
  await hydrationStore.hydrate();
  return { ...harness, store, hydrationStore };
}

/** Collect the `status`/`writeStatus` pair observed at each notification. */
function statusRecorder(store: SavedLocationApplicationStore): string[] {
  const observed: string[] = [];
  store.subscribe(() => {
    const snapshot = store.getSnapshot();
    observed.push(`${snapshot.status}:${snapshot.writeStatus}`);
  });
  return observed;
}

function expectReady(
  snapshot: SavedLocationApplicationSnapshot,
): Extract<SavedLocationApplicationSnapshot, { status: 'READY' }> {
  if (snapshot.status !== 'READY') {
    throw new Error(`expected a READY snapshot, received ${snapshot.status}`);
  }
  return snapshot;
}

let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  consoleSpies = [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
    vi.spyOn(console, 'info').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  consoleSpies.forEach((spy) => {
    expect(spy).not.toHaveBeenCalled();
  });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1 — construction is side-effect free: no load / save / clear, and the initial snapshot mirrors the
// hydration store's own NOT_STARTED state with an IDLE write status.
// ---------------------------------------------------------------------------

describe('construction', () => {
  it('performs no storage I/O and starts at NOT_STARTED / IDLE', () => {
    const { persistence, loadMock, saveMock, clearMock } = recordingPersistence();

    const { store } = buildStore(persistence);

    expect(loadMock).toHaveBeenCalledTimes(0);
    expect(saveMock).toHaveBeenCalledTimes(0);
    expect(clearMock).toHaveBeenCalledTimes(0);
    expect(store.getSnapshot()).toEqual({ status: 'NOT_STARTED', writeStatus: 'IDLE' });
    expect(Object.isFrozen(store.getSnapshot())).toBe(true);
  });

  it('does not notify a listener merely for registering', async () => {
    const { persistence } = recordingPersistence();
    const { store } = buildStore(persistence);
    const listener = vi.fn();

    store.subscribe(listener);
    await Promise.resolve();

    expect(listener).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// 2 — the five hydration states map onto the application snapshot, with the write dimension always
// IDLE for the three non-hydrated ones.
// ---------------------------------------------------------------------------

describe('hydration state mapping', () => {
  it('maps NOT_STARTED -> LOADING -> EMPTY', async () => {
    const pending = deferred<SavedLocationPersistenceLoadResult>();
    const { persistence } = recordingPersistence({ load: () => pending.promise });
    const { store, hydrationStore } = buildStore(persistence);

    expect(store.getSnapshot()).toEqual({ status: 'NOT_STARTED', writeStatus: 'IDLE' });

    const hydrating = hydrationStore.hydrate();
    expect(store.getSnapshot()).toEqual({ status: 'LOADING', writeStatus: 'IDLE' });

    pending.resolve({ ok: true, locations: [] });
    await hydrating;

    expect(store.getSnapshot()).toEqual({ status: 'EMPTY', writeStatus: 'IDLE' });
  });

  it('maps a non-empty stored collection to READY with its locations', async () => {
    const { store } = await hydratedStore([record('a', 0), record('b', 1)]);

    const snapshot = expectReady(store.getSnapshot());
    expect(snapshot.writeStatus).toBe('IDLE');
    expect(snapshot.locations.map((location) => location.id)).toEqual(['a', 'b']);
    expect(snapshot.locations.map((location) => location.sortOrder)).toEqual([0, 1]);
  });

  it('maps a load failure to ERROR with the hydration error kind and an IDLE write status', async () => {
    const { persistence } = recordingPersistence({
      load: async () => ({ ok: false, error: { kind: 'UNSUPPORTED_STORED_VERSION' } }),
    });
    const { store, hydrationStore } = buildStore(persistence);

    await hydrationStore.hydrate();

    expect(store.getSnapshot()).toEqual({
      status: 'ERROR',
      error: { kind: 'UNSUPPORTED_STORED_VERSION' },
      writeStatus: 'IDLE',
    });
  });

  it('never exposes a raw storage error through the ERROR snapshot', async () => {
    const { persistence } = recordingPersistence({
      load: async () => {
        throw new Error(SECRET_MARKER);
      },
    });
    const { store, hydrationStore } = buildStore(persistence);

    await hydrationStore.hydrate();

    const snapshot = store.getSnapshot();
    expect(snapshot).toEqual({
      status: 'ERROR',
      error: { kind: 'STORAGE_READ_FAILED' },
      writeStatus: 'IDLE',
    });
    expect(JSON.stringify(snapshot)).not.toContain(SECRET_MARKER);
  });
});

// ---------------------------------------------------------------------------
// 3 — snapshot reference stability and deep-freeze.
// ---------------------------------------------------------------------------

describe('snapshot identity and immutability', () => {
  it('returns the exact same reference until a semantic transition occurs', async () => {
    const { store, hydrationStore } = await hydratedStore([record('a', 0)]);

    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);
    expect(store.getSnapshot()).toBe(first);

    // A no-op hydrate from a terminal success state changes nothing semantically.
    await hydrationStore.hydrate();
    expect(store.getSnapshot()).toBe(first);
  });

  it('deep-freezes the READY snapshot, its locations array, records, and grids', async () => {
    const { store } = await hydratedStore([record('a', 0), record('b', 1)]);

    const snapshot = expectReady(store.getSnapshot());
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.locations)).toBe(true);
    snapshot.locations.forEach((location) => {
      expect(Object.isFrozen(location)).toBe(true);
      expect(Object.isFrozen(location.kmaGrid)).toBe(true);
    });
  });

  it('deep-freezes the ERROR snapshot and its nested error', async () => {
    const { persistence } = recordingPersistence({
      load: async () => ({ ok: false, error: { kind: 'INVALID_STORED_LOCATIONS' } }),
    });
    const { store, hydrationStore } = buildStore(persistence);

    await hydrationStore.hydrate();

    const snapshot = store.getSnapshot();
    if (snapshot.status !== 'ERROR') {
      throw new Error(`expected an ERROR snapshot, received ${snapshot.status}`);
    }
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.error)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4 — subscription behavior: transition-only notification, idempotent unsubscribe, and per-listener
// exception isolation.
// ---------------------------------------------------------------------------

describe('subscription', () => {
  it('notifies once per semantic transition and not for a semantic no-op', async () => {
    const { persistence } = recordingPersistence();
    const { store, hydrationStore } = buildStore(persistence);
    const observed = statusRecorder(store);

    await hydrationStore.hydrate();
    await hydrationStore.hydrate();
    await hydrationStore.hydrate();

    expect(observed).toEqual(['LOADING:IDLE', 'EMPTY:IDLE']);
  });

  it('stops notifying after unsubscribe and tolerates repeated unsubscribe calls', async () => {
    const { persistence } = recordingPersistence();
    const { store, hydrationStore } = buildStore(persistence);
    const kept = vi.fn();
    const removed = vi.fn();

    store.subscribe(kept);
    const unsubscribe = store.subscribe(removed);
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();

    await hydrationStore.hydrate();

    expect(kept).toHaveBeenCalledTimes(2);
    expect(removed).toHaveBeenCalledTimes(0);
  });

  it('isolates a throwing listener from the other listeners and from the mutation lifecycle', async () => {
    const { store, saveMock } = await hydratedStore([record('a', 0)]);
    const throwing = vi.fn(() => {
      throw new Error(SECRET_MARKER);
    });
    const healthy = vi.fn();
    store.subscribe(throwing);
    store.subscribe(healthy);

    const result = await store.remove('a');

    expect(result).toEqual({ ok: true });
    expect(throwing).toHaveBeenCalledTimes(2);
    expect(healthy).toHaveBeenCalledTimes(2);
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toEqual({ status: 'EMPTY', writeStatus: 'IDLE' });
  });
});

// ---------------------------------------------------------------------------
// 5 — explicit retry delegates to the hydration store and adds no policy of its own.
// ---------------------------------------------------------------------------

describe('retryHydration', () => {
  it('returns the exact promise reference the hydration store returned', async () => {
    const { persistence } = recordingPersistence();
    const { store, hydrationStore } = buildStore(persistence);
    const expected = Promise.resolve();
    const hydrateSpy = vi.spyOn(hydrationStore, 'hydrate').mockReturnValue(expected);

    const returned = store.retryHydration();

    expect(returned).toBe(expected);
    expect(hydrateSpy).toHaveBeenCalledTimes(1);
    await returned;
  });

  it('keeps the hydration store single-flight across concurrent retries', async () => {
    const pending = deferred<SavedLocationPersistenceLoadResult>();
    const { persistence, loadMock } = recordingPersistence({ load: () => pending.promise });
    const { store } = buildStore(persistence);

    const first = store.retryHydration();
    const second = store.retryHydration();

    expect(second).toBe(first);
    pending.resolve({ ok: true, locations: [] });
    await first;

    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toEqual({ status: 'EMPTY', writeStatus: 'IDLE' });
  });

  it('recovers from ERROR to READY through an explicit retry, without any timer', async () => {
    let attempt = 0;
    const { persistence, loadMock } = recordingPersistence({
      load: async () => {
        attempt += 1;
        return attempt === 1
          ? { ok: false, error: { kind: 'STORAGE_READ_FAILED' } }
          : { ok: true, locations: [record('a', 0)] };
      },
    });
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const { store, hydrationStore } = buildStore(persistence);
    const observed = statusRecorder(store);

    await hydrationStore.hydrate();
    expect(store.getSnapshot().status).toBe('ERROR');

    await store.retryHydration();

    expect(expectReady(store.getSnapshot()).locations.map((l) => l.id)).toEqual(['a']);
    expect(observed).toEqual(['LOADING:IDLE', 'ERROR:IDLE', 'LOADING:IDLE', 'READY:IDLE']);
    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it('does not retry automatically after a failed hydration', async () => {
    const { persistence, loadMock } = recordingPersistence({
      load: async () => ({ ok: false, error: { kind: 'STORAGE_READ_FAILED' } }),
    });
    const { store, hydrationStore } = buildStore(persistence);

    await hydrationStore.hydrate();
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().status).toBe('ERROR');
  });
});

// ---------------------------------------------------------------------------
// 6 — add: the allowed states, the exact write, and every failure that must not reach persistence.
// ---------------------------------------------------------------------------

describe('add', () => {
  it('goes EMPTY -> SAVING -> READY and saves the canonical collection exactly once', async () => {
    const { store, saveMock, clearMock } = await hydratedStore([]);
    const observed = statusRecorder(store);

    const result = await store.add(candidate('a'));

    expect(result).toEqual({ ok: true });
    expect(observed).toEqual(['EMPTY:SAVING', 'READY:IDLE']);
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0]?.[0]).toEqual([record('a', 0)]);
    expect(clearMock).toHaveBeenCalledTimes(0);
    expect(expectReady(store.getSnapshot()).locations).toEqual([record('a', 0)]);
  });

  it('appends to a READY collection with the canonical sortOrder', async () => {
    const { store, saveMock } = await hydratedStore([record('a', 0), record('b', 1)]);

    const result = await store.add(candidate('c'));

    expect(result).toEqual({ ok: true });
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0]?.[0]).toEqual([record('a', 0), record('b', 1), record('c', 2)]);
    expect(expectReady(store.getSnapshot()).locations.map((l) => l.sortOrder)).toEqual([0, 1, 2]);
  });

  it('rejects a duplicate id without touching persistence and without changing the snapshot', async () => {
    const { store, saveMock } = await hydratedStore([record('a', 0)]);
    const before = store.getSnapshot();
    const listener = vi.fn();
    store.subscribe(listener);

    const result = await store.add(candidate('a'));

    expect(result).toEqual({ ok: false, error: { kind: 'DUPLICATE_LOCATION_ID' } });
    expect(saveMock).toHaveBeenCalledTimes(0);
    expect(store.getSnapshot()).toBe(before);
    expect(listener).toHaveBeenCalledTimes(0);
  });

  it('rejects an invalid candidate without touching persistence', async () => {
    const { store, saveMock } = await hydratedStore([]);

    const result = await store.add({ id: 'a', displayName: SECRET_MARKER });

    expect(result).toEqual({ ok: false, error: { kind: 'INVALID_LOCATION' } });
    expect(saveMock).toHaveBeenCalledTimes(0);
    expect(JSON.stringify(result)).not.toContain(SECRET_MARKER);
  });

  it('rejects a second current location without touching persistence', async () => {
    const { store, saveMock } = await hydratedStore([record('a', 0, true)]);

    const result = await store.add(candidate('b', true));

    expect(result).toEqual({ ok: false, error: { kind: 'CURRENT_LOCATION_CONFLICT' } });
    expect(saveMock).toHaveBeenCalledTimes(0);
  });

  it.each(['NOT_STARTED', 'LOADING', 'ERROR'] as const)(
    'rejects with NOT_READY from %s without touching persistence',
    async (targetStatus) => {
      const pending = deferred<SavedLocationPersistenceLoadResult>();
      const { persistence, saveMock } = recordingPersistence({
        load:
          targetStatus === 'ERROR'
            ? async () => ({ ok: false, error: { kind: 'STORAGE_READ_FAILED' } })
            : () => pending.promise,
      });
      const { store, hydrationStore } = buildStore(persistence);

      if (targetStatus === 'LOADING') {
        void hydrationStore.hydrate();
      } else if (targetStatus === 'ERROR') {
        await hydrationStore.hydrate();
      }
      expect(store.getSnapshot().status).toBe(targetStatus);

      const result = await store.add(candidate('a'));

      expect(result).toEqual({ ok: false, error: { kind: 'NOT_READY' } });
      expect(saveMock).toHaveBeenCalledTimes(0);

      pending.resolve({ ok: true, locations: [] });
    },
  );

  it('keeps the previously committed collection when the write fails', async () => {
    const { store, saveMock } = await hydratedStore([record('a', 0)]);
    saveMock.mockResolvedValueOnce({ ok: false, error: { kind: 'STORAGE_WRITE_FAILED' } });
    const observed = statusRecorder(store);

    const result = await store.add(candidate('b'));

    expect(result).toEqual({ ok: false, error: { kind: 'STORAGE_WRITE_FAILED' } });
    expect(observed).toEqual(['READY:SAVING', 'READY:IDLE']);
    expect(expectReady(store.getSnapshot()).locations.map((l) => l.id)).toEqual(['a']);
  });

  it('collapses a persistence implementation that throws into STORAGE_WRITE_FAILED', async () => {
    const { store, saveMock } = await hydratedStore([record('a', 0)]);
    saveMock.mockImplementationOnce(() => {
      throw new Error(SECRET_MARKER);
    });

    const result = await store.add(candidate('b'));

    expect(result).toEqual({ ok: false, error: { kind: 'STORAGE_WRITE_FAILED' } });
    expect(JSON.stringify(result)).not.toContain(SECRET_MARKER);
    expect(store.getSnapshot().writeStatus).toBe('IDLE');
    expect(expectReady(store.getSnapshot()).locations.map((l) => l.id)).toEqual(['a']);
  });
});

// ---------------------------------------------------------------------------
// 7 — remove: canonical re-indexing, the empty-envelope write, and every rejected input.
// ---------------------------------------------------------------------------

describe('remove', () => {
  it('re-indexes the remaining records after removing a middle one and saves exactly once', async () => {
    const { store, saveMock } = await hydratedStore([
      record('a', 0),
      record('b', 1),
      record('c', 2),
    ]);

    const result = await store.remove('b');

    expect(result).toEqual({ ok: true });
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0]?.[0]).toEqual([record('a', 0), record('c', 1)]);
    const snapshot = expectReady(store.getSnapshot());
    expect(snapshot.locations.map((l) => l.id)).toEqual(['a', 'c']);
    expect(snapshot.locations.map((l) => l.sortOrder)).toEqual([0, 1]);
  });

  it('saves an empty collection — never clear() — when the last record is removed', async () => {
    const { store, saveMock, clearMock } = await hydratedStore([record('a', 0)]);
    const observed = statusRecorder(store);

    const result = await store.remove('a');

    expect(result).toEqual({ ok: true });
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0]?.[0]).toEqual([]);
    expect(clearMock).toHaveBeenCalledTimes(0);
    expect(observed).toEqual(['READY:SAVING', 'EMPTY:IDLE']);
    expect(store.getSnapshot()).toEqual({ status: 'EMPTY', writeStatus: 'IDLE' });
  });

  it('rejects an unknown id without touching persistence', async () => {
    const { store, saveMock } = await hydratedStore([record('a', 0)]);

    const result = await store.remove('missing');

    expect(result).toEqual({ ok: false, error: { kind: 'LOCATION_NOT_FOUND' } });
    expect(saveMock).toHaveBeenCalledTimes(0);
  });

  it.each([
    ['an empty string', ''],
    ['a non-string', 42],
    ['null', null],
  ])('rejects %s id without touching persistence', async (_label, locationId) => {
    const { store, saveMock } = await hydratedStore([record('a', 0)]);

    const result = await store.remove(locationId);

    expect(result).toEqual({ ok: false, error: { kind: 'INVALID_LOCATION_ID' } });
    expect(saveMock).toHaveBeenCalledTimes(0);
  });

  it('rejects with NOT_READY from EMPTY without touching persistence', async () => {
    const { store, saveMock } = await hydratedStore([]);

    const result = await store.remove('a');

    expect(result).toEqual({ ok: false, error: { kind: 'NOT_READY' } });
    expect(saveMock).toHaveBeenCalledTimes(0);
  });

  it('keeps the previously committed collection when the write fails', async () => {
    const { store, saveMock } = await hydratedStore([record('a', 0), record('b', 1)]);
    saveMock.mockResolvedValueOnce({ ok: false, error: { kind: 'STORAGE_WRITE_FAILED' } });

    const result = await store.remove('a');

    expect(result).toEqual({ ok: false, error: { kind: 'STORAGE_WRITE_FAILED' } });
    expect(expectReady(store.getSnapshot()).locations.map((l) => l.id)).toEqual(['a', 'b']);
    expect(store.getSnapshot().writeStatus).toBe('IDLE');
  });
});

// ---------------------------------------------------------------------------
// 8 — no optimistic update: while a write is in flight the published collection is still the old,
// committed one.
// ---------------------------------------------------------------------------

describe('save-before-publish', () => {
  it('does not publish the new collection until the write resolves', async () => {
    const pendingSave = deferred<SavedLocationPersistenceSaveResult>();
    const { persistence } = recordingPersistence({
      load: async () => ({ ok: true, locations: [record('a', 0), record('b', 1)] }),
      save: () => pendingSave.promise,
    });
    const { store, hydrationStore } = buildStore(persistence);
    await hydrationStore.hydrate();

    const removing = store.remove('a');

    const during = expectReady(store.getSnapshot());
    expect(during.writeStatus).toBe('SAVING');
    expect(during.locations.map((l) => l.id)).toEqual(['a', 'b']);

    pendingSave.resolve({ ok: true });
    await removing;

    expect(expectReady(store.getSnapshot()).locations.map((l) => l.id)).toEqual(['b']);
    expect(store.getSnapshot().writeStatus).toBe('IDLE');
  });
});

// ---------------------------------------------------------------------------
// 9 — concurrency and reentrancy: exactly one write at a time, no queue, no second save.
// ---------------------------------------------------------------------------

describe('concurrency and reentrancy', () => {
  it('rejects a concurrent mutation with WRITE_IN_PROGRESS and starts no second write', async () => {
    const pendingSave = deferred<SavedLocationPersistenceSaveResult>();
    const { persistence, saveMock } = recordingPersistence({
      load: async () => ({ ok: true, locations: [record('a', 0), record('b', 1)] }),
      save: () => pendingSave.promise,
    });
    const { store, hydrationStore } = buildStore(persistence);
    await hydrationStore.hydrate();

    const first = store.remove('a');
    const second = await store.remove('b');
    const third = await store.add(candidate('c'));

    expect(second).toEqual({ ok: false, error: { kind: 'WRITE_IN_PROGRESS' } });
    expect(third).toEqual({ ok: false, error: { kind: 'WRITE_IN_PROGRESS' } });
    expect(saveMock).toHaveBeenCalledTimes(1);

    pendingSave.resolve({ ok: true });

    expect(await first).toEqual({ ok: true });
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0]?.[0]).toEqual([record('b', 0)]);
    expect(expectReady(store.getSnapshot()).locations.map((l) => l.id)).toEqual(['b']);
  });

  it('starts no second write when a listener mutates reentrantly during the SAVING notification', async () => {
    const pendingSave = deferred<SavedLocationPersistenceSaveResult>();
    const { persistence, saveMock } = recordingPersistence({
      load: async () => ({ ok: true, locations: [record('a', 0), record('b', 1)] }),
      save: () => pendingSave.promise,
    });
    const { store, hydrationStore } = buildStore(persistence);
    await hydrationStore.hydrate();

    const reentrantResults: unknown[] = [];
    store.subscribe(() => {
      if (store.getSnapshot().writeStatus === 'SAVING') {
        void store.remove('b').then((result) => reentrantResults.push(result));
      }
    });

    const first = store.remove('a');
    pendingSave.resolve({ ok: true });
    expect(await first).toEqual({ ok: true });
    await Promise.resolve();

    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(reentrantResults).toEqual([{ ok: false, error: { kind: 'WRITE_IN_PROGRESS' } }]);
    expect(expectReady(store.getSnapshot()).locations.map((l) => l.id)).toEqual(['b']);
  });

  it('allows a fresh mutation only after the previous one has fully settled', async () => {
    const { store, saveMock } = await hydratedStore([
      record('a', 0),
      record('b', 1),
      record('c', 2),
    ]);

    expect(await store.remove('a')).toEqual({ ok: true });
    expect(await store.remove('b')).toEqual({ ok: true });

    expect(saveMock).toHaveBeenCalledTimes(2);
    expect(saveMock.mock.calls[0]?.[0]).toEqual([record('b', 0), record('c', 1)]);
    expect(saveMock.mock.calls[1]?.[0]).toEqual([record('c', 0)]);
    expect(expectReady(store.getSnapshot()).locations.map((l) => l.id)).toEqual(['c']);
  });
});
