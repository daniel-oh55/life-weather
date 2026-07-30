import { describe, expect, it, vi } from 'vitest';

import {
  createSavedLocationHydrationManager,
  type MobileSavedLocation,
  type SavedLocationPersistence,
  type SavedLocationPersistenceLoadResult,
} from './index';

// ---------------------------------------------------------------------------
// Synthetic fixtures. Every value here is fabricated — synthetic ids, display names, coordinates,
// and a standard non-sensitive timezone — so no real user location, stored place, or device
// identifier is ever used. Each builder returns a fresh object.
// ---------------------------------------------------------------------------

/** A marker asserted absent from any error state — proves no raw error / stored value leaks out. */
const SECRET_MARKER = 'SYNTHETIC_HYDRATION_SECRET_MUST_NOT_LEAK';
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
function markedRecord(id: string): MobileSavedLocation {
  return record(id, {
    displayName: SECRET_MARKER,
    latitude: SECRET_LATITUDE,
    longitude: SECRET_LONGITUDE,
    kmaGrid: { nx: SECRET_NX, ny: SECRET_NY },
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

/** A fake `SavedLocationPersistence` whose `load` is fully scripted; `save`/`clear` are spies. */
function fakePersistence(load: () => Promise<SavedLocationPersistenceLoadResult>): {
  persistence: SavedLocationPersistence;
  loadCalls: number[];
  save: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
} {
  let calls = 0;
  const loadCalls: number[] = [];
  const save = vi.fn(async () => ({ ok: true as const }));
  const clear = vi.fn(async () => ({ ok: true as const }));
  return {
    persistence: {
      load: () => {
        calls += 1;
        loadCalls.push(calls);
        return load();
      },
      save,
      clear,
    },
    loadCalls,
    save,
    clear,
  };
}

/** Resolve `load()` after one microtask so `LOADING` can be observed before settlement. */
function resolvedAfterMicrotask(
  result: SavedLocationPersistenceLoadResult,
): () => Promise<SavedLocationPersistenceLoadResult> {
  return () => Promise.resolve().then(() => result);
}

// ---------------------------------------------------------------------------
// 1 — import / factory construction perform no storage I/O
// ---------------------------------------------------------------------------

describe('createSavedLocationHydrationManager — construction', () => {
  it('performs zero load / save / clear calls merely by constructing the manager', () => {
    const { persistence, save, clear } = fakePersistence(async () => ({ ok: true, locations: [] }));
    const loadSpy = vi.fn(persistence.load);

    createSavedLocationHydrationManager({ ...persistence, load: loadSpy });

    expect(loadSpy).toHaveBeenCalledTimes(0);
    expect(save).toHaveBeenCalledTimes(0);
    expect(clear).toHaveBeenCalledTimes(0);
  });

  // 2 — initial state is NOT_STARTED
  it('starts in the NOT_STARTED state', () => {
    const { persistence } = fakePersistence(async () => ({ ok: true, locations: [] }));
    const manager = createSavedLocationHydrationManager(persistence);

    expect(manager.getState()).toEqual({ status: 'NOT_STARTED' });
  });
});

// ---------------------------------------------------------------------------
// 3 — synchronous LOADING transition before load() settles
// ---------------------------------------------------------------------------

describe('createSavedLocationHydrationManager — hydrate transitions', () => {
  it('synchronously transitions to LOADING before the injected load() settles', async () => {
    const { persistence } = fakePersistence(resolvedAfterMicrotask({ ok: true, locations: [] }));
    const manager = createSavedLocationHydrationManager(persistence);

    const pending = manager.hydrate();
    expect(manager.getState()).toEqual({ status: 'LOADING' });

    await pending;
    expect(manager.getState()).toEqual({ status: 'EMPTY' });
  });

  // 4 — missing / empty result -> EMPTY
  it('transitions to EMPTY when load() resolves with an empty collection', async () => {
    const { persistence } = fakePersistence(async () => ({ ok: true, locations: [] }));
    const manager = createSavedLocationHydrationManager(persistence);

    await manager.hydrate();

    expect(manager.getState()).toEqual({ status: 'EMPTY' });
  });

  // 5 & 6 — non-empty result -> READY, values preserved, fresh references
  it('transitions to READY with preserved values on a non-empty result', async () => {
    const locations = collectionOf({ id: 'a' }, { id: 'b', isCurrent: true });
    const { persistence } = fakePersistence(async () => ({ ok: true, locations }));
    const manager = createSavedLocationHydrationManager(persistence);

    await manager.hydrate();
    const state = manager.getState();

    expect(state.status).toBe('READY');
    if (state.status !== 'READY') return;
    expect(state.locations.map((l) => l.id)).toEqual(['a', 'b']);
    expect(state.locations[1].isCurrent).toBe(true);
    expect(state.locations[0].kmaGrid).toEqual({ nx: 60, ny: 127 });
  });

  it('returns fresh READY array / record / non-null kmaGrid references on repeated getState() calls', async () => {
    const locations = collectionOf({ id: 'a' }, { id: 'b' });
    const { persistence } = fakePersistence(async () => ({ ok: true, locations }));
    const manager = createSavedLocationHydrationManager(persistence);

    await manager.hydrate();
    const first = manager.getState();
    const second = manager.getState();

    expect(first.status === 'READY' && second.status === 'READY').toBe(true);
    if (first.status !== 'READY' || second.status !== 'READY') return;
    expect(first).not.toBe(second);
    expect(first.locations).not.toBe(second.locations);
    first.locations.forEach((locationA, index) => {
      const locationB = second.locations[index];
      expect(locationA).not.toBe(locationB);
      expect(locationA.kmaGrid).not.toBe(locationB.kmaGrid);
    });
    // Never shares a reference with the persistence-provided input either.
    expect(first.locations).not.toBe(locations);
    expect(first.locations[0]).not.toBe(locations[0]);
    expect(first.locations[0].kmaGrid).not.toBe(locations[0].kmaGrid);
  });
});

// ---------------------------------------------------------------------------
// 7 — the three persistence error kinds map to the matching ERROR state
// ---------------------------------------------------------------------------

describe('createSavedLocationHydrationManager — persistence error kinds', () => {
  const kinds = [
    'STORAGE_READ_FAILED',
    'INVALID_STORED_LOCATIONS',
    'UNSUPPORTED_STORED_VERSION',
  ] as const;

  it.each(kinds)('maps a %s persistence failure to the matching ERROR state', async (kind) => {
    const { persistence } = fakePersistence(async () => ({ ok: false, error: { kind } }));
    const manager = createSavedLocationHydrationManager(persistence);

    await manager.hydrate();

    expect(manager.getState()).toEqual({ status: 'ERROR', error: { kind } });
  });
});

// ---------------------------------------------------------------------------
// 8 & 9 — synchronous throw and promise rejection both collapse to STORAGE_READ_FAILED
// ---------------------------------------------------------------------------

describe('createSavedLocationHydrationManager — defensive load() failure', () => {
  it('converts a synchronous load() throw to ERROR / STORAGE_READ_FAILED without rejecting', async () => {
    const persistence: SavedLocationPersistence = {
      load: () => {
        throw new Error(SECRET_MARKER);
      },
      save: vi.fn(),
      clear: vi.fn(),
    };
    const manager = createSavedLocationHydrationManager(persistence);

    await expect(manager.hydrate()).resolves.toBeUndefined();
    expect(manager.getState()).toEqual({
      status: 'ERROR',
      error: { kind: 'STORAGE_READ_FAILED' },
    });
  });

  it('converts a rejected load() promise to ERROR / STORAGE_READ_FAILED without rejecting', async () => {
    const { persistence } = fakePersistence(() => Promise.reject(new Error(SECRET_MARKER)));
    const manager = createSavedLocationHydrationManager(persistence);

    await expect(manager.hydrate()).resolves.toBeUndefined();
    expect(manager.getState()).toEqual({
      status: 'ERROR',
      error: { kind: 'STORAGE_READ_FAILED' },
    });
  });
});

// ---------------------------------------------------------------------------
// 10 — concurrent hydrate() calls share one in-flight load
// ---------------------------------------------------------------------------

describe('createSavedLocationHydrationManager — concurrency', () => {
  it('calls load() exactly once across overlapping concurrent hydrate() calls', async () => {
    const { persistence, loadCalls } = fakePersistence(
      resolvedAfterMicrotask({ ok: true, locations: [] }),
    );
    const manager = createSavedLocationHydrationManager(persistence);

    const first = manager.hydrate();
    const second = manager.hydrate();
    const third = manager.hydrate();

    expect(first).toBe(second);
    expect(second).toBe(third);

    await Promise.all([first, second, third]);

    expect(loadCalls).toEqual([1]);
    expect(manager.getState()).toEqual({ status: 'EMPTY' });
  });

  // 11 — repeated hydrate() after READY does not call load() again
  it('does not call load() again after reaching READY', async () => {
    const { persistence, loadCalls } = fakePersistence(async () => ({
      ok: true,
      locations: collectionOf({ id: 'a' }),
    }));
    const manager = createSavedLocationHydrationManager(persistence);

    await manager.hydrate();
    await manager.hydrate();
    await manager.hydrate();

    expect(loadCalls).toEqual([1]);
    expect(manager.getState().status).toBe('READY');
  });

  // 12 — repeated hydrate() after EMPTY does not call load() again
  it('does not call load() again after reaching EMPTY', async () => {
    const { persistence, loadCalls } = fakePersistence(async () => ({ ok: true, locations: [] }));
    const manager = createSavedLocationHydrationManager(persistence);

    await manager.hydrate();
    await manager.hydrate();

    expect(loadCalls).toEqual([1]);
    expect(manager.getState()).toEqual({ status: 'EMPTY' });
  });

  // 13 & 14 — ERROR allows retry, and a successful retry reaches a terminal success state
  it('allows a retry after ERROR, and a successful retry reaches READY', async () => {
    let attempt = 0;
    const { persistence, loadCalls } = fakePersistence(async () => {
      attempt += 1;
      if (attempt === 1) {
        return { ok: false, error: { kind: 'STORAGE_READ_FAILED' } };
      }
      return { ok: true, locations: collectionOf({ id: 'a' }) };
    });
    const manager = createSavedLocationHydrationManager(persistence);

    await manager.hydrate();
    expect(manager.getState()).toEqual({
      status: 'ERROR',
      error: { kind: 'STORAGE_READ_FAILED' },
    });

    await manager.hydrate();

    expect(loadCalls).toEqual([1, 2]);
    expect(manager.getState().status).toBe('READY');
  });

  // 13b — a synchronous load() throw must not leave a stale in-flight promise behind: the next
  // hydrate() from ERROR has to start a genuinely new cycle (fresh LOADING, fresh promise, a second
  // load() call), and a subsequent call after terminal success must not call load() a third time.
  it('allows a retry after a synchronous load() throw, and does not leave a stale in-flight promise', async () => {
    let attempt = 0;
    const loadCalls: number[] = [];
    const save = vi.fn(async () => ({ ok: true as const }));
    const clear = vi.fn(async () => ({ ok: true as const }));
    const persistence: SavedLocationPersistence = {
      load: (): Promise<SavedLocationPersistenceLoadResult> => {
        attempt += 1;
        loadCalls.push(attempt);
        if (attempt === 1) {
          throw new Error(SECRET_MARKER);
        }
        return Promise.resolve({ ok: true, locations: [] });
      },
      save,
      clear,
    };
    const manager = createSavedLocationHydrationManager(persistence);

    const first = manager.hydrate();
    await expect(first).resolves.toBeUndefined();
    expect(manager.getState()).toEqual({
      status: 'ERROR',
      error: { kind: 'STORAGE_READ_FAILED' },
    });

    const second = manager.hydrate();
    // The LOADING transition is synchronous, and the second promise is a fresh reference — proof
    // the manager did not reuse a stale, already-settled in-flight promise from the first attempt.
    expect(manager.getState()).toEqual({ status: 'LOADING' });
    expect(second).not.toBe(first);

    await second;

    expect(loadCalls).toEqual([1, 2]);
    expect(manager.getState()).toEqual({ status: 'EMPTY' });

    await manager.hydrate();
    expect(loadCalls).toEqual([1, 2]);
  });

  it('allows a retry after ERROR to reach EMPTY as a terminal success state', async () => {
    let attempt = 0;
    const { persistence, loadCalls } = fakePersistence(async () => {
      attempt += 1;
      if (attempt === 1) {
        return { ok: false, error: { kind: 'INVALID_STORED_LOCATIONS' } };
      }
      return { ok: true, locations: [] };
    });
    const manager = createSavedLocationHydrationManager(persistence);

    await manager.hydrate();
    await manager.hydrate();

    expect(loadCalls).toEqual([1, 2]);
    expect(manager.getState()).toEqual({ status: 'EMPTY' });
  });
});

// ---------------------------------------------------------------------------
// 15 — a deep-frozen persistence result is handled without mutation attempts throwing
// ---------------------------------------------------------------------------

describe('createSavedLocationHydrationManager — deep-frozen input', () => {
  it('hydrates successfully from a deep-frozen persistence result', async () => {
    const locations = deepFreeze(collectionOf({ id: 'a', isCurrent: true }, { id: 'b' }));
    const { persistence } = fakePersistence(async () => ({ ok: true, locations }));
    const manager = createSavedLocationHydrationManager(persistence);

    await expect(manager.hydrate()).resolves.toBeUndefined();
    const state = manager.getState();
    expect(state.status).toBe('READY');
    if (state.status !== 'READY') return;
    expect(state.locations.map((l) => l.id)).toEqual(['a', 'b']);
    expect(state.locations).not.toBe(locations);
  });
});

// ---------------------------------------------------------------------------
// 16 — no raw error / location info ever leaks through the state
// ---------------------------------------------------------------------------

describe('createSavedLocationHydrationManager — non-revealing state', () => {
  it('never leaks a raw error message through the ERROR state', async () => {
    const { persistence } = fakePersistence(() => Promise.reject(new Error(SECRET_MARKER)));
    const manager = createSavedLocationHydrationManager(persistence);

    await manager.hydrate();
    const state = manager.getState();

    expect(JSON.stringify(state)).not.toContain(SECRET_MARKER);
    expect(state).toEqual({ status: 'ERROR', error: { kind: 'STORAGE_READ_FAILED' } });
  });

  it('a READY state carries the actual location fields, not a leaked marker on failure paths', async () => {
    const { persistence } = fakePersistence(async () => ({
      ok: true,
      locations: [markedRecord('marked')],
    }));
    const manager = createSavedLocationHydrationManager(persistence);

    await manager.hydrate();
    const state = manager.getState();

    // READY legitimately carries the stored location's own fields (it is not an error state) —
    // this only proves the manager forwards them unchanged, not that it invents new exposure.
    expect(state.status).toBe('READY');
    if (state.status !== 'READY') return;
    expect(state.locations[0].displayName).toBe(SECRET_MARKER);
  });
});

// ---------------------------------------------------------------------------
// 17 — the manager never calls save() or clear()
// ---------------------------------------------------------------------------

describe('createSavedLocationHydrationManager — read-only', () => {
  it('never calls persistence.save or persistence.clear across NOT_STARTED / retry flows', async () => {
    let attempt = 0;
    const save = vi.fn(async () => ({ ok: true as const }));
    const clear = vi.fn(async () => ({ ok: true as const }));
    const persistence: SavedLocationPersistence = {
      load: async () => {
        attempt += 1;
        if (attempt === 1) {
          return { ok: false, error: { kind: 'STORAGE_READ_FAILED' } };
        }
        return { ok: true, locations: collectionOf({ id: 'a' }) };
      },
      save,
      clear,
    };
    const manager = createSavedLocationHydrationManager(persistence);

    await manager.hydrate();
    await manager.hydrate();
    manager.getState();

    expect(save).toHaveBeenCalledTimes(0);
    expect(clear).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// 18 — the pure barrel never transitively loads the native AsyncStorage module
// ---------------------------------------------------------------------------

describe('pure barrel', () => {
  it('does not transitively load the native AsyncStorage module', async () => {
    vi.doMock('@react-native-async-storage/async-storage', () => {
      throw new Error('native AsyncStorage must not be loaded by the pure barrel');
    });
    vi.resetModules();

    await expect(import('./index')).resolves.toBeDefined();

    vi.doUnmock('@react-native-async-storage/async-storage');
    vi.resetModules();
  });
});
