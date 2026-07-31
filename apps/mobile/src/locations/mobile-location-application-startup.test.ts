import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Both collaborators are mocked so these tests exercise only the sequencing/one-shot guard in
// `mobile-location-application-startup`, never the real AsyncStorage-backed manager, store, or
// application store. `vi.hoisted` lifts these mock functions above the `vi.mock` factories, which
// Vitest hoists above these imports.
// ---------------------------------------------------------------------------

const startSavedHydrationMock = vi.hoisted(() => vi.fn());

vi.mock('./mobile-saved-location-hydration-startup', () => ({
  startMobileSavedLocationHydrationOnce: startSavedHydrationMock,
}));

const getSnapshotMock = vi.hoisted(() => vi.fn());
const initializeSelectedLocationMock = vi.hoisted(() => vi.fn());

vi.mock('./mobile-saved-location-application-production', () => ({
  mobileSavedLocationApplicationStore: {
    getSnapshot: getSnapshotMock,
    initializeSelectedLocation: initializeSelectedLocationMock,
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  startSavedHydrationMock.mockResolvedValue(undefined);
  initializeSelectedLocationMock.mockResolvedValue(undefined);
  getSnapshotMock.mockReturnValue({ status: 'READY', locations: [], selectedLocationId: 'a', writeStatus: 'IDLE' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// module import performs no I/O
// ---------------------------------------------------------------------------

describe('module import', () => {
  it('does not start the sequence merely by importing the module', async () => {
    await import('./mobile-location-application-startup');

    expect(startSavedHydrationMock).toHaveBeenCalledTimes(0);
    expect(initializeSelectedLocationMock).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// ordering: saved hydration first, selected initialization only after it settles successfully
// ---------------------------------------------------------------------------

describe('sequencing', () => {
  it('starts selected-location initialization only after saved-location hydration settles', async () => {
    let hydrationResolve: (() => void) | undefined;
    const hydrationPending = new Promise<void>((resolve) => {
      hydrationResolve = resolve;
    });
    startSavedHydrationMock.mockReturnValue(hydrationPending);
    getSnapshotMock.mockReturnValue({ status: 'EMPTY', selectedLocationId: null, writeStatus: 'IDLE' });

    const { startMobileLocationApplicationOnce } = await import(
      './mobile-location-application-startup'
    );

    const started = startMobileLocationApplicationOnce();
    await Promise.resolve();
    await Promise.resolve();

    expect(startSavedHydrationMock).toHaveBeenCalledTimes(1);
    expect(initializeSelectedLocationMock).toHaveBeenCalledTimes(0);

    hydrationResolve?.();
    await started;

    expect(initializeSelectedLocationMock).toHaveBeenCalledTimes(1);
  });

  it('does not start selected-location initialization when saved hydration settles into ERROR', async () => {
    startSavedHydrationMock.mockResolvedValue(undefined);
    getSnapshotMock.mockReturnValue({
      status: 'ERROR',
      error: { scope: 'SAVED_LOCATIONS', kind: 'STORAGE_READ_FAILED' },
      writeStatus: 'IDLE',
    });

    const { startMobileLocationApplicationOnce } = await import(
      './mobile-location-application-startup'
    );

    await startMobileLocationApplicationOnce();

    expect(startSavedHydrationMock).toHaveBeenCalledTimes(1);
    expect(initializeSelectedLocationMock).toHaveBeenCalledTimes(0);
  });

  it('starts selected-location initialization when saved hydration settles into READY', async () => {
    getSnapshotMock.mockReturnValue({
      status: 'READY',
      locations: [],
      selectedLocationId: 'a',
      writeStatus: 'IDLE',
    });

    const { startMobileLocationApplicationOnce } = await import(
      './mobile-location-application-startup'
    );

    await startMobileLocationApplicationOnce();

    expect(initializeSelectedLocationMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// one-shot: concurrent / repeated / post-settlement calls all share the same combined promise
// ---------------------------------------------------------------------------

describe('one-shot guard', () => {
  it('returns the same promise reference for concurrent calls and runs the sequence once', async () => {
    let hydrationResolve: (() => void) | undefined;
    const hydrationPending = new Promise<void>((resolve) => {
      hydrationResolve = resolve;
    });
    startSavedHydrationMock.mockReturnValue(hydrationPending);

    const { startMobileLocationApplicationOnce } = await import(
      './mobile-location-application-startup'
    );

    const first = startMobileLocationApplicationOnce();
    const second = startMobileLocationApplicationOnce();
    const third = startMobileLocationApplicationOnce();

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(startSavedHydrationMock).toHaveBeenCalledTimes(1);

    hydrationResolve?.();
    await first;

    expect(initializeSelectedLocationMock).toHaveBeenCalledTimes(1);
  });

  it('returns the same promise reference and runs nothing further after settlement', async () => {
    const { startMobileLocationApplicationOnce } = await import(
      './mobile-location-application-startup'
    );

    const first = startMobileLocationApplicationOnce();
    await first;

    const second = startMobileLocationApplicationOnce();
    const third = startMobileLocationApplicationOnce();

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(startSavedHydrationMock).toHaveBeenCalledTimes(1);
    expect(initializeSelectedLocationMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// no logging
// ---------------------------------------------------------------------------

describe('no logging', () => {
  it('never logs to the console', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});

    const { startMobileLocationApplicationOnce } = await import(
      './mobile-location-application-startup'
    );
    await startMobileLocationApplicationOnce();
    startMobileLocationApplicationOnce();

    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleInfo).not.toHaveBeenCalled();
  });
});
