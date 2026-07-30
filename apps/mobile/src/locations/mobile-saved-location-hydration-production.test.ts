import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SAVED_LOCATION_PERSISTENCE_KEY } from './index';

// ---------------------------------------------------------------------------
// Mocked AsyncStorage. The native module is never loaded or touched by the pure barrel — the mock
// factory itself records every time the module is *resolved* (not just called), so the barrel
// isolation test below can prove the native module was never transitively loaded, not merely that
// its methods went uncalled. `vi.hoisted` and `vi.mock` are hoisted above these imports by Vitest.
// ---------------------------------------------------------------------------

const nativeModuleLoadSpy = vi.hoisted(() => vi.fn());

const asyncStorageMock = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => {
  nativeModuleLoadSpy();
  return { default: asyncStorageMock };
});

/** A marker asserted absent from state and console output — proves no raw value/error leaks out. */
const SECRET_MARKER = 'SYNTHETIC_HYDRATION_PRODUCTION_SECRET_MUST_NOT_LEAK';

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  nativeModuleLoadSpy.mockClear();
  asyncStorageMock.getItem.mockResolvedValue(null);
  asyncStorageMock.setItem.mockResolvedValue(undefined);
  asyncStorageMock.removeItem.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 10 — importing the pure barrel (`./index`) never transitively loads the native AsyncStorage
// module. This must run before any other test in this file imports the production module: the
// mock factory only fires on a module's *first* resolution in this test run (a later
// `vi.resetModules()` clears this file's own module cache but does not force Vitest to re-invoke
// an already-resolved manual mock factory), so this check only proves anything as the first
// resolution attempt.
// ---------------------------------------------------------------------------

describe('pure barrel isolation (must run first — see comment above)', () => {
  it('does not transitively load the native AsyncStorage module when importing the pure barrel', async () => {
    await import('./index');

    expect(nativeModuleLoadSpy).not.toHaveBeenCalled();
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.removeItem).toHaveBeenCalledTimes(0);
  });

  // Positive control, run immediately after: proves the load spy actually detects a native-module
  // load on its first real resolution, so the isolation assertion above is not vacuously true.
  it('sanity check: importing the production module does load the native AsyncStorage module', async () => {
    await import('./mobile-saved-location-hydration-production');

    expect(nativeModuleLoadSpy).toHaveBeenCalledTimes(1);
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
});

// ---------------------------------------------------------------------------
// 5/6/7/8 — a manual hydrate() call goes through the real production persistence: exactly one
// getItem on the exact stable key, EMPTY on a missing key, and no write/remove calls.
// ---------------------------------------------------------------------------

describe('manual hydrate()', () => {
  it('reads the exact stable key exactly once via the production persistence and reaches EMPTY on a missing key', async () => {
    asyncStorageMock.getItem.mockResolvedValue(null);
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
});
