import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocked AsyncStorage. The native module is never loaded or touched by the pure barrel — the
// `pure barrel isolation` test below swaps this mock factory for one that throws, so it proves the
// native module was never transitively loaded, not merely that its methods went uncalled.
// `vi.hoisted` and `vi.mock` are hoisted above these imports by Vitest.
// ---------------------------------------------------------------------------

const asyncStorageMock = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: asyncStorageMock,
}));

/** A marker asserted absent from state and console output — proves no raw value/error leaks out. */
const SECRET_MARKER = 'SYNTHETIC_HYDRATION_PRODUCTION_SECRET_MUST_NOT_LEAK';

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  asyncStorageMock.getItem.mockResolvedValue(null);
  asyncStorageMock.setItem.mockResolvedValue(undefined);
  asyncStorageMock.removeItem.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 10 — importing the pure barrel (`./index`) never transitively loads the native AsyncStorage
// module. Verified order-independently: the mock factory for the native module is swapped to one
// that throws for the duration of this test only, so this proves isolation regardless of what
// other tests in this file have already resolved, and regardless of run order.
// ---------------------------------------------------------------------------

describe('pure barrel isolation', () => {
  it('does not transitively load native AsyncStorage from the pure barrel', async () => {
    vi.resetModules();

    vi.doMock('@react-native-async-storage/async-storage', () => {
      throw new Error('native AsyncStorage must not be loaded by the pure barrel');
    });

    try {
      const barrel = await import('./index');
      // The barrel also exports the store factory now — proves that addition alone does not pull
      // in the native module either.
      expect(typeof barrel.createSavedLocationHydrationStore).toBe('function');
    } finally {
      vi.doMock('@react-native-async-storage/async-storage', () => ({
        default: asyncStorageMock,
      }));
      vi.resetModules();
    }
  });
});

// ---------------------------------------------------------------------------
// 1/2/3/4 — importing the production module succeeds, starts NOT_STARTED, performs no storage
// I/O, and does not auto-run hydrate().
// ---------------------------------------------------------------------------

describe('production module import', () => {
  it('imports successfully, exposes a manager starting at NOT_STARTED, and performs no storage I/O or auto hydration', async () => {
    const { mobileSavedLocationHydrationManager } = await import(
      './mobile-saved-location-hydration-production'
    );

    expect(mobileSavedLocationHydrationManager.getState()).toEqual({ status: 'NOT_STARTED' });
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.removeItem).toHaveBeenCalledTimes(0);

    // Flush a macrotask tick so any accidental deferred/microtask auto-hydration would have run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mobileSavedLocationHydrationManager.getState()).toEqual({ status: 'NOT_STARTED' });
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(0);
  });

  // 9 — the exported singleton is the same manager instance across repeated imports of the same
  // module (no re-composition per import).
  it('exposes the same manager instance across repeated imports of the same module instance', async () => {
    const first = await import('./mobile-saved-location-hydration-production');
    const second = await import('./mobile-saved-location-hydration-production');

    expect(first.mobileSavedLocationHydrationManager).toBe(second.mobileSavedLocationHydrationManager);
  });

  it('exposes a store whose initial snapshot is NOT_STARTED, stable by reference, deep-frozen, and performs no storage I/O', async () => {
    const { mobileSavedLocationHydrationStore } = await import(
      './mobile-saved-location-hydration-production'
    );

    const snapshot = mobileSavedLocationHydrationStore.getSnapshot();
    expect(snapshot).toEqual({ status: 'NOT_STARTED' });
    expect(mobileSavedLocationHydrationStore.getSnapshot()).toBe(snapshot);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.removeItem).toHaveBeenCalledTimes(0);
  });

  it('exposes the same store instance across repeated imports of the same module instance', async () => {
    const first = await import('./mobile-saved-location-hydration-production');
    const second = await import('./mobile-saved-location-hydration-production');

    expect(first.mobileSavedLocationHydrationStore).toBe(second.mobileSavedLocationHydrationStore);
  });

  it('builds the store over the same manager instance (one production graph)', async () => {
    const { mobileSavedLocationHydrationManager, mobileSavedLocationHydrationStore } = await import(
      './mobile-saved-location-hydration-production'
    );

    await mobileSavedLocationHydrationStore.hydrate();

    // If the store were built over a different manager instance, this would still read
    // NOT_STARTED — proving the store observed the exact same manager this module also exports.
    expect(mobileSavedLocationHydrationManager.getState()).toEqual({ status: 'EMPTY' });
  });
});

// ---------------------------------------------------------------------------
// 5/6/7/8 — a manual hydrate() call goes through the real production persistence: exactly one
// getItem on the exact stable key, EMPTY on a missing key, and no write/remove calls.
// ---------------------------------------------------------------------------

describe('manual hydrate()', () => {
  it('reads the exact stable key exactly once via the production persistence and reaches EMPTY on a missing key', async () => {
    asyncStorageMock.getItem.mockResolvedValue(null);
    const { SAVED_LOCATION_PERSISTENCE_KEY } = await import('./index');
    const { mobileSavedLocationHydrationManager } = await import(
      './mobile-saved-location-hydration-production'
    );

    await mobileSavedLocationHydrationManager.hydrate();

    expect(mobileSavedLocationHydrationManager.getState()).toEqual({ status: 'EMPTY' });
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(1);
    expect(asyncStorageMock.getItem).toHaveBeenCalledWith(SAVED_LOCATION_PERSISTENCE_KEY);
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.removeItem).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// Store hydrate() delegation: the store reads the exact stable key exactly once via the same
// production persistence, returns the manager's own join promise by reference, notifies through
// LOADING then the terminal status with an already-updated snapshot, and a repeated success call
// re-reads nothing and notifies nothing further.
// ---------------------------------------------------------------------------

describe('store hydrate()', () => {
  it('reads the exact stable key exactly once and reaches EMPTY on a missing key', async () => {
    asyncStorageMock.getItem.mockResolvedValue(null);
    const { SAVED_LOCATION_PERSISTENCE_KEY } = await import('./index');
    const { mobileSavedLocationHydrationStore } = await import(
      './mobile-saved-location-hydration-production'
    );

    await mobileSavedLocationHydrationStore.hydrate();

    expect(mobileSavedLocationHydrationStore.getSnapshot()).toEqual({ status: 'EMPTY' });
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(1);
    expect(asyncStorageMock.getItem).toHaveBeenCalledWith(SAVED_LOCATION_PERSISTENCE_KEY);
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.removeItem).toHaveBeenCalledTimes(0);
  });

  it('returns the exact manager join promise by reference', async () => {
    asyncStorageMock.getItem.mockResolvedValue(null);
    const { mobileSavedLocationHydrationManager, mobileSavedLocationHydrationStore } = await import(
      './mobile-saved-location-hydration-production'
    );
    const hydrateSpy = vi.spyOn(mobileSavedLocationHydrationManager, 'hydrate');

    const storePromise = mobileSavedLocationHydrationStore.hydrate();
    const managerPromise = hydrateSpy.mock.results[0]?.value as Promise<void> | undefined;

    expect(managerPromise).toBeDefined();
    expect(storePromise).toBe(managerPromise);

    await storePromise;
  });

  it('notifies LOADING then EMPTY, in order, with getSnapshot() already reflecting the new state at each notification', async () => {
    asyncStorageMock.getItem.mockResolvedValue(null);
    const { mobileSavedLocationHydrationStore } = await import(
      './mobile-saved-location-hydration-production'
    );
    const observedStatuses: string[] = [];
    mobileSavedLocationHydrationStore.subscribe(() => {
      observedStatuses.push(mobileSavedLocationHydrationStore.getSnapshot().status);
    });

    await mobileSavedLocationHydrationStore.hydrate();

    expect(observedStatuses).toEqual(['LOADING', 'EMPTY']);
  });

  it('does not re-read storage or notify again on a repeated success hydrate() call', async () => {
    asyncStorageMock.getItem.mockResolvedValue(null);
    const { mobileSavedLocationHydrationStore } = await import(
      './mobile-saved-location-hydration-production'
    );
    const listener = vi.fn();

    await mobileSavedLocationHydrationStore.hydrate();
    mobileSavedLocationHydrationStore.subscribe(listener);
    const snapshotAfterFirst = mobileSavedLocationHydrationStore.getSnapshot();

    await mobileSavedLocationHydrationStore.hydrate();

    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(1);
    expect(mobileSavedLocationHydrationStore.getSnapshot()).toBe(snapshotAfterFirst);
    expect(listener).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// 11 — no raw stored value or native error is ever logged by this composition.
// ---------------------------------------------------------------------------

describe('no logging of raw stored values or native errors', () => {
  it('never logs a raw malformed stored value while hydrating to ERROR', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    asyncStorageMock.getItem.mockResolvedValue(`{not json ${SECRET_MARKER}`);

    const { mobileSavedLocationHydrationManager } = await import(
      './mobile-saved-location-hydration-production'
    );
    await mobileSavedLocationHydrationManager.hydrate();

    const state = mobileSavedLocationHydrationManager.getState();
    expect(state).toEqual({ status: 'ERROR', error: { kind: 'INVALID_STORED_LOCATIONS' } });
    expect(JSON.stringify(state)).not.toContain(SECRET_MARKER);
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleInfo).not.toHaveBeenCalled();
  });

  it('never logs a native getItem rejection while hydrating to ERROR', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    asyncStorageMock.getItem.mockRejectedValue(new Error(SECRET_MARKER));

    const { mobileSavedLocationHydrationManager } = await import(
      './mobile-saved-location-hydration-production'
    );
    await mobileSavedLocationHydrationManager.hydrate();

    const state = mobileSavedLocationHydrationManager.getState();
    expect(state).toEqual({ status: 'ERROR', error: { kind: 'STORAGE_READ_FAILED' } });
    expect(JSON.stringify(state)).not.toContain(SECRET_MARKER);
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleInfo).not.toHaveBeenCalled();
  });

  it('exposes only the fixed ERROR kind through the store on a malformed stored value, and logs nothing', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    asyncStorageMock.getItem.mockResolvedValue(`{not json ${SECRET_MARKER}`);

    const { mobileSavedLocationHydrationStore } = await import(
      './mobile-saved-location-hydration-production'
    );
    await mobileSavedLocationHydrationStore.hydrate();

    const snapshot = mobileSavedLocationHydrationStore.getSnapshot();
    expect(snapshot).toEqual({ status: 'ERROR', error: { kind: 'INVALID_STORED_LOCATIONS' } });
    expect(JSON.stringify(snapshot)).not.toContain(SECRET_MARKER);
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleInfo).not.toHaveBeenCalled();
  });

  it('exposes only the fixed ERROR kind through the store on a native getItem rejection, and logs nothing', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    asyncStorageMock.getItem.mockRejectedValue(new Error(SECRET_MARKER));

    const { mobileSavedLocationHydrationStore } = await import(
      './mobile-saved-location-hydration-production'
    );
    await mobileSavedLocationHydrationStore.hydrate();

    const snapshot = mobileSavedLocationHydrationStore.getSnapshot();
    expect(snapshot).toEqual({ status: 'ERROR', error: { kind: 'STORAGE_READ_FAILED' } });
    expect(JSON.stringify(snapshot)).not.toContain(SECRET_MARKER);
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleInfo).not.toHaveBeenCalled();
  });
});
