import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// The production composition (`mobile-saved-location-hydration-production`) is mocked so these
// tests exercise only the one-shot guard in `mobile-saved-location-hydration-startup`, never the
// real AsyncStorage-backed manager or store. The mock deliberately exposes **only** the store's
// surface (`hydrate`/`getSnapshot`/`subscribe`) and no `mobileSavedLocationHydrationManager` export
// at all — if the startup module were changed to import the lower-level manager directly instead of
// the store, that import would resolve to `undefined` and every test below would fail immediately.
// `vi.hoisted` lifts these mock functions above the `vi.mock` factory, which Vitest hoists above
// these imports.
// ---------------------------------------------------------------------------

const hydrateMock = vi.hoisted(() => vi.fn());
const getSnapshotMock = vi.hoisted(() => vi.fn());
const subscribeMock = vi.hoisted(() => vi.fn());

vi.mock('./mobile-saved-location-hydration-production', () => ({
  mobileSavedLocationHydrationStore: {
    hydrate: hydrateMock,
    getSnapshot: getSnapshotMock,
    subscribe: subscribeMock,
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  getSnapshotMock.mockReturnValue({ status: 'NOT_STARTED' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1 — importing the startup module alone never calls hydrate().
// ---------------------------------------------------------------------------

describe('module import', () => {
  it('does not call hydrate() on import alone', async () => {
    await import('./mobile-saved-location-hydration-startup');

    expect(hydrateMock).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// 2/3 — the first start call invokes hydrate() exactly once and returns the exact promise the
// store returned.
// ---------------------------------------------------------------------------

describe('first start() call', () => {
  it('calls hydrate() exactly once and returns the store promise by reference', async () => {
    const storePromise = Promise.resolve();
    hydrateMock.mockReturnValue(storePromise);
    const { startMobileSavedLocationHydrationOnce } = await import(
      './mobile-saved-location-hydration-startup'
    );

    const result = startMobileSavedLocationHydrationOnce();

    expect(hydrateMock).toHaveBeenCalledTimes(1);
    expect(result).toBe(storePromise);

    await result;
  });
});

// ---------------------------------------------------------------------------
// 4/5 — concurrent / repeated calls while the first hydration is still pending all return the
// same promise reference, and the store is called exactly once.
// ---------------------------------------------------------------------------

describe('concurrent / repeated calls while pending', () => {
  it('returns the same promise reference and calls hydrate() only once', async () => {
    let resolvePending: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      resolvePending = resolve;
    });
    hydrateMock.mockReturnValue(pending);
    const { startMobileSavedLocationHydrationOnce } = await import(
      './mobile-saved-location-hydration-startup'
    );

    const first = startMobileSavedLocationHydrationOnce();
    const second = startMobileSavedLocationHydrationOnce();
    const third = startMobileSavedLocationHydrationOnce();

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(hydrateMock).toHaveBeenCalledTimes(1);

    resolvePending?.();
    await first;
  });
});

// ---------------------------------------------------------------------------
// 6 — repeated calls after the first promise has settled still return the same reference and
// still call the store only once.
// ---------------------------------------------------------------------------

describe('repeated calls after settlement', () => {
  it('returns the same promise reference and calls hydrate() only once after completion', async () => {
    const storePromise = Promise.resolve();
    hydrateMock.mockReturnValue(storePromise);
    const { startMobileSavedLocationHydrationOnce } = await import(
      './mobile-saved-location-hydration-startup'
    );

    const first = startMobileSavedLocationHydrationOnce();
    await first;

    const second = startMobileSavedLocationHydrationOnce();
    const third = startMobileSavedLocationHydrationOnce();

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(hydrateMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 7 — no automatic retry after the first hydration settles with the store reporting ERROR.
// ---------------------------------------------------------------------------

describe('no automatic retry after ERROR', () => {
  it('does not call hydrate() again after the store settles into ERROR', async () => {
    const storePromise = Promise.resolve();
    hydrateMock.mockReturnValue(storePromise);
    getSnapshotMock.mockReturnValue({ status: 'ERROR', error: { kind: 'STORAGE_READ_FAILED' } });
    const { startMobileSavedLocationHydrationOnce } = await import(
      './mobile-saved-location-hydration-startup'
    );

    const first = startMobileSavedLocationHydrationOnce();
    await first;

    const second = startMobileSavedLocationHydrationOnce();

    expect(second).toBe(first);
    expect(hydrateMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 8 — no console logging of any kind.
// ---------------------------------------------------------------------------

describe('no logging', () => {
  it('never logs to the console', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    hydrateMock.mockReturnValue(Promise.resolve());
    const { startMobileSavedLocationHydrationOnce } = await import(
      './mobile-saved-location-hydration-startup'
    );

    await startMobileSavedLocationHydrationOnce();
    startMobileSavedLocationHydrationOnce();

    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleInfo).not.toHaveBeenCalled();
  });
});
