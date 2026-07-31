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
  type SelectedLocationPersistence,
  type SelectedLocationPersistenceLoadResult,
  type SelectedLocationPersistenceSaveResult,
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
function recordingPersistence(
  options: {
    load?: () => Promise<SavedLocationPersistenceLoadResult>;
    save?: (input: unknown) => Promise<SavedLocationPersistenceSaveResult>;
  } = {},
) {
  const loadMock = vi.fn(
    options.load ??
      (async (): Promise<SavedLocationPersistenceLoadResult> => ({ ok: true, locations: [] })),
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
 * A call-recording {@link SelectedLocationPersistence}. Defaults to a missing-preference `load`
 * (`selectedLocationId: null`) and an always-succeeding `save`.
 */
function recordingSelectedPersistence(
  options: {
    load?: () => Promise<SelectedLocationPersistenceLoadResult>;
    save?: (input: unknown) => Promise<SelectedLocationPersistenceSaveResult>;
  } = {},
) {
  const loadMock = vi.fn(
    options.load ??
      (async (): Promise<SelectedLocationPersistenceLoadResult> => ({
        ok: true,
        selectedLocationId: null,
      })),
  );
  const saveMock = vi.fn(
    options.save ?? (async (): Promise<SelectedLocationPersistenceSaveResult> => ({ ok: true })),
  );

  const persistence: SelectedLocationPersistence = { load: loadMock, save: saveMock };

  return { persistence, loadMock, saveMock };
}

/**
 * Compose the **real** hydration manager, the **real** observable hydration store, and the
 * application store under test over one recording saved-location persistence and one recording
 * selected-location persistence — the same wiring the production composition uses.
 */
function buildStore(
  persistence: SavedLocationPersistence,
  selectedLocationPersistence: SelectedLocationPersistence,
): { store: SavedLocationApplicationStore; hydrationStore: SavedLocationHydrationStore } {
  const hydrationStore = createSavedLocationHydrationStore(
    createSavedLocationHydrationManager(persistence),
  );
  return {
    store: createSavedLocationApplicationStore({
      hydrationStore,
      persistence,
      selectedLocationPersistence,
    }),
    hydrationStore,
  };
}

/**
 * Build a store, drive saved-location hydration to its terminal state from the given stored
 * collection, then drive selected-location initialization to its terminal state too — i.e. reach
 * the same EMPTY/READY terminal snapshot the PR #50 tests exercised, now always carrying a resolved
 * `selectedLocationId`.
 */
async function hydratedStore(
  stored: MobileSavedLocation[],
  selectedOptions: {
    load?: () => Promise<SelectedLocationPersistenceLoadResult>;
    save?: (input: unknown) => Promise<SelectedLocationPersistenceSaveResult>;
  } = {},
) {
  const harness = recordingPersistence({
    load: async () => ({ ok: true, locations: stored.map((location) => ({ ...location })) }),
  });
  const selected = recordingSelectedPersistence(selectedOptions);
  const { store, hydrationStore } = buildStore(harness.persistence, selected.persistence);
  await hydrationStore.hydrate();
  await store.initializeSelectedLocation();
  return { ...harness, selected, store, hydrationStore };
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
// construction: side-effect free on both persistences.
// ---------------------------------------------------------------------------

describe('construction', () => {
  it('performs no storage I/O on either boundary and starts at NOT_STARTED / IDLE', () => {
    const { persistence, loadMock, saveMock, clearMock } = recordingPersistence();
    const selected = recordingSelectedPersistence();

    const { store } = buildStore(persistence, selected.persistence);

    expect(loadMock).toHaveBeenCalledTimes(0);
    expect(saveMock).toHaveBeenCalledTimes(0);
    expect(clearMock).toHaveBeenCalledTimes(0);
    expect(selected.loadMock).toHaveBeenCalledTimes(0);
    expect(selected.saveMock).toHaveBeenCalledTimes(0);
    expect(store.getSnapshot()).toEqual({ status: 'NOT_STARTED', writeStatus: 'IDLE' });
    expect(Object.isFrozen(store.getSnapshot())).toBe(true);
  });

  it('does not notify a listener merely for registering', async () => {
    const { persistence } = recordingPersistence();
    const selected = recordingSelectedPersistence();
    const { store } = buildStore(persistence, selected.persistence);
    const listener = vi.fn();

    store.subscribe(listener);
    await Promise.resolve();

    expect(listener).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// hydration mapping: NOT_STARTED / LOADING / SELECTION_LOADING / SAVED_LOCATIONS ERROR. EMPTY and
// READY are reachable only after selected-location initialization also succeeds — see the
// `initializeSelectedLocation` section below.
// ---------------------------------------------------------------------------

describe('hydration state mapping', () => {
  it('maps NOT_STARTED -> LOADING -> SELECTION_LOADING (never straight to EMPTY/READY)', async () => {
    const pending = deferred<SavedLocationPersistenceLoadResult>();
    const { persistence } = recordingPersistence({ load: () => pending.promise });
    const selected = recordingSelectedPersistence();
    const { store, hydrationStore } = buildStore(persistence, selected.persistence);

    expect(store.getSnapshot()).toEqual({ status: 'NOT_STARTED', writeStatus: 'IDLE' });

    const hydrating = hydrationStore.hydrate();
    expect(store.getSnapshot()).toEqual({ status: 'LOADING', writeStatus: 'IDLE' });

    pending.resolve({ ok: true, locations: [] });
    await hydrating;

    expect(store.getSnapshot()).toEqual({ status: 'SELECTION_LOADING', writeStatus: 'IDLE' });
    expect(selected.loadMock).toHaveBeenCalledTimes(0);
  });

  it('maps a saved-location load failure to a SAVED_LOCATIONS-scoped ERROR', async () => {
    const { persistence } = recordingPersistence({
      load: async () => ({ ok: false, error: { kind: 'UNSUPPORTED_STORED_VERSION' } }),
    });
    const selected = recordingSelectedPersistence();
    const { store, hydrationStore } = buildStore(persistence, selected.persistence);

    await hydrationStore.hydrate();

    expect(store.getSnapshot()).toEqual({
      status: 'ERROR',
      error: { scope: 'SAVED_LOCATIONS', kind: 'UNSUPPORTED_STORED_VERSION' },
      writeStatus: 'IDLE',
    });
    expect(selected.loadMock).toHaveBeenCalledTimes(0);
  });

  it('never exposes a raw saved-location storage error through the ERROR snapshot', async () => {
    const { persistence } = recordingPersistence({
      load: async () => {
        throw new Error(SECRET_MARKER);
      },
    });
    const selected = recordingSelectedPersistence();
    const { store, hydrationStore } = buildStore(persistence, selected.persistence);

    await hydrationStore.hydrate();

    const snapshot = store.getSnapshot();
    expect(snapshot).toEqual({
      status: 'ERROR',
      error: { scope: 'SAVED_LOCATIONS', kind: 'STORAGE_READ_FAILED' },
      writeStatus: 'IDLE',
    });
    expect(JSON.stringify(snapshot)).not.toContain(SECRET_MARKER);
  });
});

// ---------------------------------------------------------------------------
// initializeSelectedLocation: never automatic, resolution algorithm, single-flight, idempotency,
// and the SELECTED_LOCATION-scoped ERROR.
// ---------------------------------------------------------------------------

describe('initializeSelectedLocation', () => {
  it('is a no-op that touches no persistence before saved-location hydration succeeds', async () => {
    const { persistence } = recordingPersistence();
    const selected = recordingSelectedPersistence();
    const { store } = buildStore(persistence, selected.persistence);

    await store.initializeSelectedLocation();

    expect(selected.loadMock).toHaveBeenCalledTimes(0);
    expect(store.getSnapshot()).toEqual({ status: 'NOT_STARTED', writeStatus: 'IDLE' });
  });

  it('is a no-op that touches no persistence while saved-location hydration is ERROR', async () => {
    const { persistence } = recordingPersistence({
      load: async () => ({ ok: false, error: { kind: 'STORAGE_READ_FAILED' } }),
    });
    const selected = recordingSelectedPersistence();
    const { store, hydrationStore } = buildStore(persistence, selected.persistence);

    await hydrationStore.hydrate();
    await store.initializeSelectedLocation();

    expect(selected.loadMock).toHaveBeenCalledTimes(0);
    expect(store.getSnapshot().status).toBe('ERROR');
  });

  it('resolves to null for an empty saved collection and never writes back the fallback', async () => {
    const { store, selected } = await hydratedStore([]);

    expect(store.getSnapshot()).toEqual({
      status: 'EMPTY',
      selectedLocationId: null,
      writeStatus: 'IDLE',
    });
    expect(selected.loadMock).toHaveBeenCalledTimes(1);
    expect(selected.saveMock).toHaveBeenCalledTimes(0);
  });

  it('restores a persisted id that is still present in the collection', async () => {
    const { store } = await hydratedStore([record('a', 0), record('b', 1)], {
      load: async () => ({ ok: true, selectedLocationId: 'b' }),
    });

    expect(expectReady(store.getSnapshot()).selectedLocationId).toBe('b');
  });

  it('falls back to the first (sortOrder 0) record for a null persisted preference', async () => {
    const { store, selected } = await hydratedStore([record('a', 0), record('b', 1)], {
      load: async () => ({ ok: true, selectedLocationId: null }),
    });

    expect(expectReady(store.getSnapshot()).selectedLocationId).toBe('a');
    expect(selected.saveMock).toHaveBeenCalledTimes(0);
  });

  it('falls back to the first record for a stale persisted id no longer in the collection', async () => {
    const { store, selected } = await hydratedStore([record('a', 0), record('b', 1)], {
      load: async () => ({ ok: true, selectedLocationId: 'gone' }),
    });

    expect(expectReady(store.getSnapshot()).selectedLocationId).toBe('a');
    expect(selected.saveMock).toHaveBeenCalledTimes(0);
  });

  it('reads selected-location persistence exactly once per cycle', async () => {
    const { selected } = await hydratedStore([record('a', 0)]);

    expect(selected.loadMock).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight promise across concurrent/reentrant calls', async () => {
    const pending = deferred<SelectedLocationPersistenceLoadResult>();
    const { persistence } = recordingPersistence({
      load: async () => ({ ok: true, locations: [record('a', 0)] }),
    });
    const selected = recordingSelectedPersistence({ load: () => pending.promise });
    const { store, hydrationStore } = buildStore(persistence, selected.persistence);
    await hydrationStore.hydrate();

    const first = store.initializeSelectedLocation();
    const second = store.initializeSelectedLocation();

    expect(second).toBe(first);
    pending.resolve({ ok: true, selectedLocationId: null });
    await first;

    expect(selected.loadMock).toHaveBeenCalledTimes(1);
  });

  it('is idempotent after success — a repeated call reads persistence no further', async () => {
    const { store, selected } = await hydratedStore([record('a', 0)]);

    await store.initializeSelectedLocation();
    await store.initializeSelectedLocation();

    expect(selected.loadMock).toHaveBeenCalledTimes(1);
  });

  it('maps a selected-location load failure to a SELECTED_LOCATION-scoped ERROR', async () => {
    const { persistence } = recordingPersistence({
      load: async () => ({ ok: true, locations: [record('a', 0)] }),
    });
    const selected = recordingSelectedPersistence({
      load: async () => ({ ok: false, error: { kind: 'INVALID_STORED_SELECTION' } }),
    });
    const { store, hydrationStore } = buildStore(persistence, selected.persistence);
    await hydrationStore.hydrate();

    await store.initializeSelectedLocation();

    expect(store.getSnapshot()).toEqual({
      status: 'ERROR',
      error: { scope: 'SELECTED_LOCATION', kind: 'INVALID_STORED_SELECTION' },
      writeStatus: 'IDLE',
    });
  });

  it('never rejects and never exposes a raw selected-location storage error', async () => {
    const { persistence } = recordingPersistence({
      load: async () => ({ ok: true, locations: [] }),
    });
    const selected = recordingSelectedPersistence({
      load: async () => {
        throw new Error(SECRET_MARKER);
      },
    });
    const { store, hydrationStore } = buildStore(persistence, selected.persistence);
    await hydrationStore.hydrate();

    await expect(store.initializeSelectedLocation()).resolves.toBeUndefined();

    const snapshot = store.getSnapshot();
    expect(snapshot).toEqual({
      status: 'ERROR',
      error: { scope: 'SELECTED_LOCATION', kind: 'STORAGE_READ_FAILED' },
      writeStatus: 'IDLE',
    });
    expect(JSON.stringify(snapshot)).not.toContain(SECRET_MARKER);
  });

  it('allows an explicit retry after ERROR to start a fresh read', async () => {
    let attempt = 0;
    const { persistence } = recordingPersistence({
      load: async () => ({ ok: true, locations: [record('a', 0)] }),
    });
    const selected = recordingSelectedPersistence({
      load: async () => {
        attempt += 1;
        return attempt === 1
          ? { ok: false, error: { kind: 'STORAGE_READ_FAILED' } }
          : { ok: true, selectedLocationId: 'a' };
      },
    });
    const { store, hydrationStore } = buildStore(persistence, selected.persistence);
    await hydrationStore.hydrate();

    await store.initializeSelectedLocation();
    expect(store.getSnapshot().status).toBe('ERROR');

    await store.initializeSelectedLocation();

    expect(expectReady(store.getSnapshot()).selectedLocationId).toBe('a');
    expect(selected.loadMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// retryInitialization: routes to the right boundary, no-ops elsewhere.
// ---------------------------------------------------------------------------

describe('retryInitialization', () => {
  it('is a no-op outside ERROR', async () => {
    const { store, loadMock, selected } = await hydratedStore([record('a', 0)]);

    await store.retryInitialization();

    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(selected.loadMock).toHaveBeenCalledTimes(1);
  });

  it('retries only saved-location hydration for a SAVED_LOCATIONS error, then runs selected init on success', async () => {
    let attempt = 0;
    const { persistence, loadMock } = recordingPersistence({
      load: async () => {
        attempt += 1;
        return attempt === 1
          ? { ok: false, error: { kind: 'STORAGE_READ_FAILED' } }
          : { ok: true, locations: [record('a', 0)] };
      },
    });
    const selected = recordingSelectedPersistence();
    const { store, hydrationStore } = buildStore(persistence, selected.persistence);
    await hydrationStore.hydrate();
    expect(store.getSnapshot()).toEqual({
      status: 'ERROR',
      error: { scope: 'SAVED_LOCATIONS', kind: 'STORAGE_READ_FAILED' },
      writeStatus: 'IDLE',
    });

    await store.retryInitialization();

    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(selected.loadMock).toHaveBeenCalledTimes(1);
    expect(expectReady(store.getSnapshot()).selectedLocationId).toBe('a');
  });

  it('does not start selected initialization when the saved-location retry fails again', async () => {
    const { persistence, loadMock } = recordingPersistence({
      load: async () => ({ ok: false, error: { kind: 'STORAGE_READ_FAILED' } }),
    });
    const selected = recordingSelectedPersistence();
    const { store, hydrationStore } = buildStore(persistence, selected.persistence);
    await hydrationStore.hydrate();

    await store.retryInitialization();

    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(selected.loadMock).toHaveBeenCalledTimes(0);
    expect(store.getSnapshot().status).toBe('ERROR');
  });

  it('retries only the selected-location load for a SELECTED_LOCATION error', async () => {
    let attempt = 0;
    const { persistence, loadMock } = recordingPersistence({
      load: async () => ({ ok: true, locations: [record('a', 0)] }),
    });
    const selected = recordingSelectedPersistence({
      load: async () => {
        attempt += 1;
        return attempt === 1
          ? { ok: false, error: { kind: 'STORAGE_READ_FAILED' } }
          : { ok: true, selectedLocationId: 'a' };
      },
    });
    const { store, hydrationStore } = buildStore(persistence, selected.persistence);
    await hydrationStore.hydrate();
    await store.initializeSelectedLocation();
    expect(store.getSnapshot().status).toBe('ERROR');

    await store.retryInitialization();

    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(selected.loadMock).toHaveBeenCalledTimes(2);
    expect(expectReady(store.getSnapshot()).selectedLocationId).toBe('a');
  });

  it('never rejects', async () => {
    const { persistence } = recordingPersistence({
      load: async () => ({ ok: false, error: { kind: 'STORAGE_READ_FAILED' } }),
    });
    const selected = recordingSelectedPersistence();
    const { store, hydrationStore } = buildStore(persistence, selected.persistence);
    await hydrationStore.hydrate();

    await expect(store.retryInitialization()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// snapshot identity and immutability.
// ---------------------------------------------------------------------------

describe('snapshot identity and immutability', () => {
  it('returns the exact same reference until a semantic transition occurs', async () => {
    const { store, hydrationStore } = await hydratedStore([record('a', 0)]);

    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);

    // No-op hydrate / re-init from terminal success states changes nothing semantically.
    await hydrationStore.hydrate();
    await store.initializeSelectedLocation();
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

  it('deep-freezes an ERROR snapshot from either scope', async () => {
    const { persistence } = recordingPersistence({
      load: async () => ({ ok: false, error: { kind: 'INVALID_STORED_LOCATIONS' } }),
    });
    const selected = recordingSelectedPersistence();
    const { store, hydrationStore } = buildStore(persistence, selected.persistence);

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
// subscription behavior.
// ---------------------------------------------------------------------------

describe('subscription', () => {
  it('notifies once per semantic transition through hydration, selection, and a no-op re-init', async () => {
    const { persistence } = recordingPersistence();
    const selected = recordingSelectedPersistence();
    const { store, hydrationStore } = buildStore(persistence, selected.persistence);
    const observed = statusRecorder(store);

    await hydrationStore.hydrate();
    await store.initializeSelectedLocation();
    await store.initializeSelectedLocation();
    await hydrationStore.hydrate();

    expect(observed).toEqual(['LOADING:IDLE', 'SELECTION_LOADING:IDLE', 'EMPTY:IDLE']);
  });

  it('stops notifying after unsubscribe and tolerates repeated unsubscribe calls', async () => {
    const { persistence } = recordingPersistence();
    const selected = recordingSelectedPersistence();
    const { store, hydrationStore } = buildStore(persistence, selected.persistence);
    const kept = vi.fn();
    const removed = vi.fn();

    store.subscribe(kept);
    const unsubscribe = store.subscribe(removed);
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();

    await hydrationStore.hydrate();
    await store.initializeSelectedLocation();

    // LOADING, then SELECTION_LOADING (saved hydration terminal, selection not yet loaded), then
    // EMPTY (selection resolved) — three semantic transitions.
    expect(kept).toHaveBeenCalledTimes(3);
    expect(removed).toHaveBeenCalledTimes(0);
  });

  it('isolates a throwing listener from the other listeners and from the mutation lifecycle', async () => {
    const { store, saveMock } = await hydratedStore([record('a', 0), record('b', 1)]);
    const throwing = vi.fn(() => {
      throw new Error(SECRET_MARKER);
    });
    const healthy = vi.fn();
    store.subscribe(throwing);
    store.subscribe(healthy);

    const result = await store.remove('b');

    expect(result).toEqual({ ok: true });
    expect(throwing).toHaveBeenCalledTimes(2);
    expect(healthy).toHaveBeenCalledTimes(2);
    expect(saveMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// retryHydration: unchanged exact-Promise delegation.
// ---------------------------------------------------------------------------

describe('retryHydration', () => {
  it('returns the exact promise reference the hydration store returned', async () => {
    const { persistence } = recordingPersistence();
    const selected = recordingSelectedPersistence();
    const { store, hydrationStore } = buildStore(persistence, selected.persistence);
    const expectedPromise = Promise.resolve();
    const hydrateSpy = vi.spyOn(hydrationStore, 'hydrate').mockReturnValue(expectedPromise);

    const returned = store.retryHydration();

    expect(returned).toBe(expectedPromise);
    expect(hydrateSpy).toHaveBeenCalledTimes(1);
    await returned;
  });
});

// ---------------------------------------------------------------------------
// select: readiness, no-op re-selection, validation, save-before-publish, and failure preservation.
// ---------------------------------------------------------------------------

describe('select', () => {
  it('publishes the new selection only after selectedLocationPersistence.save succeeds', async () => {
    const pendingSave = deferred<SelectedLocationPersistenceSaveResult>();
    const { store, selected } = await hydratedStore([record('a', 0), record('b', 1)]);
    selected.saveMock.mockReturnValueOnce(pendingSave.promise);
    const observed = statusRecorder(store);

    const selecting = store.select('b');

    const during = expectReady(store.getSnapshot());
    expect(during.writeStatus).toBe('SAVING');
    expect(during.selectedLocationId).toBe('a');

    pendingSave.resolve({ ok: true });
    const result = await selecting;

    expect(result).toEqual({ ok: true });
    expect(expectReady(store.getSnapshot()).selectedLocationId).toBe('b');
    expect(selected.saveMock).toHaveBeenCalledWith('b');
    expect(observed).toEqual(['READY:SAVING', 'READY:IDLE']);
  });

  it('re-selecting the current id is a successful no-op: zero writes, zero notifications', async () => {
    const { store, selected, saveMock } = await hydratedStore([record('a', 0), record('b', 1)]);
    const listener = vi.fn();
    store.subscribe(listener);

    const result = await store.select('a');

    expect(result).toEqual({ ok: true });
    expect(selected.saveMock).toHaveBeenCalledTimes(0);
    expect(saveMock).toHaveBeenCalledTimes(0);
    expect(listener).toHaveBeenCalledTimes(0);
  });

  it.each([
    ['an empty string', ''],
    ['a non-string', 42],
    ['null', null],
  ])('rejects %s as INVALID_LOCATION_ID without touching persistence', async (_label, id) => {
    const { store, selected } = await hydratedStore([record('a', 0), record('b', 1)]);

    const result = await store.select(id);

    expect(result).toEqual({ ok: false, error: { kind: 'INVALID_LOCATION_ID' } });
    expect(selected.saveMock).toHaveBeenCalledTimes(0);
  });

  it('rejects an id absent from the collection as LOCATION_NOT_FOUND', async () => {
    const { store, selected } = await hydratedStore([record('a', 0)]);

    const result = await store.select('missing');

    expect(result).toEqual({ ok: false, error: { kind: 'LOCATION_NOT_FOUND' } });
    expect(selected.saveMock).toHaveBeenCalledTimes(0);
  });

  it('rejects with NOT_READY from NOT_STARTED', async () => {
    const { persistence } = recordingPersistence();
    const selected = recordingSelectedPersistence();
    const { store } = buildStore(persistence, selected.persistence);

    expect(store.getSnapshot().status).toBe('NOT_STARTED');
    const result = await store.select('a');

    expect(result).toEqual({ ok: false, error: { kind: 'NOT_READY' } });
  });

  it('rejects with NOT_READY from LOADING', async () => {
    const pending = deferred<SavedLocationPersistenceLoadResult>();
    const { persistence } = recordingPersistence({ load: () => pending.promise });
    const selected = recordingSelectedPersistence();
    const { store, hydrationStore } = buildStore(persistence, selected.persistence);

    void hydrationStore.hydrate();
    expect(store.getSnapshot().status).toBe('LOADING');

    const result = await store.select('a');

    expect(result).toEqual({ ok: false, error: { kind: 'NOT_READY' } });
    pending.resolve({ ok: true, locations: [] });
  });

  it('rejects with NOT_READY from SELECTION_LOADING', async () => {
    const { persistence } = recordingPersistence({
      load: async () => ({ ok: true, locations: [record('a', 0)] }),
    });
    const pendingSelected = deferred<SelectedLocationPersistenceLoadResult>();
    const selected = recordingSelectedPersistence({ load: () => pendingSelected.promise });
    const { store, hydrationStore } = buildStore(persistence, selected.persistence);
    await hydrationStore.hydrate();
    void store.initializeSelectedLocation();
    expect(store.getSnapshot().status).toBe('SELECTION_LOADING');

    const result = await store.select('a');

    expect(result).toEqual({ ok: false, error: { kind: 'NOT_READY' } });
    pendingSelected.resolve({ ok: true, selectedLocationId: null });
  });

  it('rejects with NOT_READY from ERROR', async () => {
    const { persistence } = recordingPersistence({
      load: async () => ({ ok: false, error: { kind: 'STORAGE_READ_FAILED' } }),
    });
    const selected = recordingSelectedPersistence();
    const { store, hydrationStore } = buildStore(persistence, selected.persistence);
    await hydrationStore.hydrate();
    expect(store.getSnapshot().status).toBe('ERROR');

    const result = await store.select('a');

    expect(result).toEqual({ ok: false, error: { kind: 'NOT_READY' } });
  });

  it('rejects with NOT_READY from EMPTY (no locations to select)', async () => {
    const { store } = await hydratedStore([]);

    const result = await store.select('a');

    expect(result).toEqual({ ok: false, error: { kind: 'NOT_READY' } });
  });

  it('keeps the previous selection when the write fails', async () => {
    const { store, selected } = await hydratedStore([record('a', 0), record('b', 1)]);
    selected.saveMock.mockResolvedValueOnce({ ok: false, error: { kind: 'STORAGE_WRITE_FAILED' } });

    const result = await store.select('b');

    expect(result).toEqual({ ok: false, error: { kind: 'STORAGE_WRITE_FAILED' } });
    expect(expectReady(store.getSnapshot()).selectedLocationId).toBe('a');
    expect(store.getSnapshot().writeStatus).toBe('IDLE');
  });

  it('collapses a throwing selected-location save into STORAGE_WRITE_FAILED without leaking it', async () => {
    const { store, selected } = await hydratedStore([record('a', 0), record('b', 1)]);
    selected.saveMock.mockImplementationOnce(() => {
      throw new Error(SECRET_MARKER);
    });

    const result = await store.select('b');

    expect(result).toEqual({ ok: false, error: { kind: 'STORAGE_WRITE_FAILED' } });
    expect(JSON.stringify(result)).not.toContain(SECRET_MARKER);
    expect(expectReady(store.getSnapshot()).selectedLocationId).toBe('a');
  });

  it('never writes to saved-location persistence', async () => {
    const { store, selected, saveMock } = await hydratedStore([record('a', 0), record('b', 1)]);

    await store.select('b');

    expect(saveMock).toHaveBeenCalledTimes(0);
    expect(selected.saveMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// add: EMPTY-to-READY first add (dual write, in order) and READY add (selection preserved).
// ---------------------------------------------------------------------------

describe('add', () => {
  it('first add into EMPTY writes selected-location, then saved-location, in that order', async () => {
    const order: string[] = [];
    const { store, saveMock, selected } = await hydratedStore([]);
    saveMock.mockImplementation(async () => {
      order.push('collection');
      return { ok: true };
    });
    selected.saveMock.mockImplementation(async (id: unknown) => {
      order.push(`selected:${String(id)}`);
      return { ok: true };
    });

    const result = await store.add(candidate('a'));

    expect(result).toEqual({ ok: true });
    expect(order).toEqual(['selected:a', 'collection']);
    const ready = expectReady(store.getSnapshot());
    expect(ready.locations).toEqual([record('a', 0)]);
    expect(ready.selectedLocationId).toBe('a');
  });

  it('does not save the collection when the first-add selected-location write fails, and EMPTY stands', async () => {
    const { store, saveMock, selected } = await hydratedStore([]);
    selected.saveMock.mockResolvedValueOnce({ ok: false, error: { kind: 'STORAGE_WRITE_FAILED' } });

    const result = await store.add(candidate('a'));

    expect(result).toEqual({ ok: false, error: { kind: 'STORAGE_WRITE_FAILED' } });
    expect(saveMock).toHaveBeenCalledTimes(0);
    expect(store.getSnapshot()).toEqual({
      status: 'EMPTY',
      selectedLocationId: null,
      writeStatus: 'IDLE',
    });
  });

  it('leaves EMPTY published when the first-add collection write fails after the selected write succeeded', async () => {
    const { store, saveMock, selected } = await hydratedStore([]);
    saveMock.mockResolvedValueOnce({ ok: false, error: { kind: 'STORAGE_WRITE_FAILED' } });

    const result = await store.add(candidate('a'));

    expect(result).toEqual({ ok: false, error: { kind: 'STORAGE_WRITE_FAILED' } });
    expect(selected.saveMock).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toEqual({
      status: 'EMPTY',
      selectedLocationId: null,
      writeStatus: 'IDLE',
    });
  });

  it('appends to a READY collection, keeps the existing selection, and never writes selected-location', async () => {
    const { store, saveMock, selected } = await hydratedStore([record('a', 0), record('b', 1)], {
      load: async () => ({ ok: true, selectedLocationId: 'b' }),
    });

    const result = await store.add(candidate('c'));

    expect(result).toEqual({ ok: true });
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(selected.saveMock).toHaveBeenCalledTimes(0);
    const ready = expectReady(store.getSnapshot());
    expect(ready.locations.map((l) => l.id)).toEqual(['a', 'b', 'c']);
    expect(ready.selectedLocationId).toBe('b');
  });

  it('rejects a duplicate id without touching either persistence', async () => {
    const { store, saveMock, selected } = await hydratedStore([record('a', 0)]);

    const result = await store.add(candidate('a'));

    expect(result).toEqual({ ok: false, error: { kind: 'DUPLICATE_LOCATION_ID' } });
    expect(saveMock).toHaveBeenCalledTimes(0);
    expect(selected.saveMock).toHaveBeenCalledTimes(0);
  });

  it('rejects with NOT_READY from SELECTION_LOADING', async () => {
    const { persistence } = recordingPersistence({
      load: async () => ({ ok: true, locations: [] }),
    });
    const pendingSelected = deferred<SelectedLocationPersistenceLoadResult>();
    const selected = recordingSelectedPersistence({ load: () => pendingSelected.promise });
    const { store, hydrationStore } = buildStore(persistence, selected.persistence);
    await hydrationStore.hydrate();
    void store.initializeSelectedLocation();

    const result = await store.add(candidate('a'));

    expect(result).toEqual({ ok: false, error: { kind: 'NOT_READY' } });
    pendingSelected.resolve({ ok: true, selectedLocationId: null });
  });
});

// ---------------------------------------------------------------------------
// remove: non-selected removal touches only the collection key; removing the selected location
// writes the documented index-based fallback first.
// ---------------------------------------------------------------------------

describe('remove', () => {
  it('removing a non-selected location writes only the collection key and keeps the selection', async () => {
    const { store, saveMock, selected } = await hydratedStore([record('a', 0), record('b', 1)], {
      load: async () => ({ ok: true, selectedLocationId: 'a' }),
    });

    const result = await store.remove('b');

    expect(result).toEqual({ ok: true });
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(selected.saveMock).toHaveBeenCalledTimes(0);
    expect(expectReady(store.getSnapshot()).selectedLocationId).toBe('a');
  });

  it.each([
    ['first', ['a', 'b', 'c'], 'a', 'b'],
    ['middle', ['a', 'b', 'c'], 'b', 'c'],
    ['last', ['a', 'b', 'c'], 'c', 'b'],
  ])('removing the selected %s record falls back per the documented index rule', async (_label, ids, removedId, expectedFallback) => {
    const stored = ids.map((id, index) => record(id, index));
    const { store, saveMock, selected } = await hydratedStore(stored, {
      load: async () => ({ ok: true, selectedLocationId: removedId }),
    });
    const order: string[] = [];
    saveMock.mockImplementation(async () => {
      order.push('collection');
      return { ok: true };
    });
    selected.saveMock.mockImplementation(async () => {
      order.push('selected');
      return { ok: true };
    });

    const result = await store.remove(removedId);

    expect(result).toEqual({ ok: true });
    expect(order).toEqual(['selected', 'collection']);
    expect(selected.saveMock).toHaveBeenCalledWith(expectedFallback);
    expect(expectReady(store.getSnapshot()).selectedLocationId).toBe(expectedFallback);
  });

  it('removing the last remaining (selected) record falls back to null', async () => {
    const { store, saveMock, selected } = await hydratedStore([record('a', 0)]);

    const result = await store.remove('a');

    expect(result).toEqual({ ok: true });
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0]?.[0]).toEqual([]);
    expect(selected.saveMock).toHaveBeenCalledWith(null);
    expect(store.getSnapshot()).toEqual({
      status: 'EMPTY',
      selectedLocationId: null,
      writeStatus: 'IDLE',
    });
  });

  it('does not save the collection when the selected-location fallback write fails, and the prior snapshot stands', async () => {
    const { store, saveMock, selected } = await hydratedStore([record('a', 0), record('b', 1)], {
      load: async () => ({ ok: true, selectedLocationId: 'a' }),
    });
    selected.saveMock.mockResolvedValueOnce({ ok: false, error: { kind: 'STORAGE_WRITE_FAILED' } });

    const result = await store.remove('a');

    expect(result).toEqual({ ok: false, error: { kind: 'STORAGE_WRITE_FAILED' } });
    expect(saveMock).toHaveBeenCalledTimes(0);
    const ready = expectReady(store.getSnapshot());
    expect(ready.locations.map((l) => l.id)).toEqual(['a', 'b']);
    expect(ready.selectedLocationId).toBe('a');
  });

  it('keeps the previously committed collection and selection when the collection write fails after a successful fallback write', async () => {
    const { store, saveMock, selected } = await hydratedStore([record('a', 0), record('b', 1)], {
      load: async () => ({ ok: true, selectedLocationId: 'a' }),
    });
    saveMock.mockResolvedValueOnce({ ok: false, error: { kind: 'STORAGE_WRITE_FAILED' } });

    const result = await store.remove('a');

    expect(result).toEqual({ ok: false, error: { kind: 'STORAGE_WRITE_FAILED' } });
    expect(selected.saveMock).toHaveBeenCalledTimes(1);
    const ready = expectReady(store.getSnapshot());
    expect(ready.locations.map((l) => l.id)).toEqual(['a', 'b']);
    expect(ready.selectedLocationId).toBe('a');
    expect(store.getSnapshot().writeStatus).toBe('IDLE');
  });

  it('rejects an unknown id without touching either persistence', async () => {
    const { store, saveMock, selected } = await hydratedStore([record('a', 0)]);

    const result = await store.remove('missing');

    expect(result).toEqual({ ok: false, error: { kind: 'LOCATION_NOT_FOUND' } });
    expect(saveMock).toHaveBeenCalledTimes(0);
    expect(selected.saveMock).toHaveBeenCalledTimes(0);
  });

  it('rejects with NOT_READY from EMPTY', async () => {
    const { store } = await hydratedStore([]);

    const result = await store.remove('a');

    expect(result).toEqual({ ok: false, error: { kind: 'NOT_READY' } });
  });
});

// ---------------------------------------------------------------------------
// shared write lock across add / remove / select.
// ---------------------------------------------------------------------------

describe('shared write lock', () => {
  it('rejects a concurrent mutation of any kind with WRITE_IN_PROGRESS', async () => {
    const pendingSave = deferred<SavedLocationPersistenceSaveResult>();
    const { persistence, saveMock } = recordingPersistence({
      load: async () => ({ ok: true, locations: [record('a', 0), record('b', 1)] }),
      save: () => pendingSave.promise,
    });
    const selected = recordingSelectedPersistence();
    const { store, hydrationStore } = buildStore(persistence, selected.persistence);
    await hydrationStore.hydrate();
    await store.initializeSelectedLocation();

    const first = store.remove('b');
    const second = await store.select('b');
    const third = await store.add(candidate('c'));
    const fourth = await store.remove('a');

    expect(second).toEqual({ ok: false, error: { kind: 'WRITE_IN_PROGRESS' } });
    expect(third).toEqual({ ok: false, error: { kind: 'WRITE_IN_PROGRESS' } });
    expect(fourth).toEqual({ ok: false, error: { kind: 'WRITE_IN_PROGRESS' } });
    expect(saveMock).toHaveBeenCalledTimes(1);

    pendingSave.resolve({ ok: true });
    expect(await first).toEqual({ ok: true });
  });

  it('starts no second write when a listener mutates reentrantly during a SAVING notification', async () => {
    const pendingSave = deferred<SavedLocationPersistenceSaveResult>();
    const { persistence, saveMock } = recordingPersistence({
      load: async () => ({ ok: true, locations: [record('a', 0), record('b', 1)] }),
      save: () => pendingSave.promise,
    });
    const selected = recordingSelectedPersistence();
    const { store, hydrationStore } = buildStore(persistence, selected.persistence);
    await hydrationStore.hydrate();
    await store.initializeSelectedLocation();

    const reentrantResults: unknown[] = [];
    store.subscribe(() => {
      if (store.getSnapshot().writeStatus === 'SAVING') {
        void store.select('b').then((result) => reentrantResults.push(result));
      }
    });

    const first = store.remove('b');
    pendingSave.resolve({ ok: true });
    expect(await first).toEqual({ ok: true });
    await Promise.resolve();

    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(reentrantResults).toEqual([{ ok: false, error: { kind: 'WRITE_IN_PROGRESS' } }]);
  });
});
