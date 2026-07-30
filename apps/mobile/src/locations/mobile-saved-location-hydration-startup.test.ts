import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// The production composition (`mobile-saved-location-hydration-production`) is mocked so these
// tests exercise only the one-shot guard in `mobile-saved-location-hydration-startup`, never the
// real AsyncStorage-backed manager. `vi.hoisted` lifts this mock function above the `vi.mock`
// factory, which Vitest hoists above these imports.
// ---------------------------------------------------------------------------

const hydrateMock = vi.hoisted(() => vi.fn());
const getStateMock = vi.hoisted(() => vi.fn());

vi.mock('./mobile-saved-location-hydration-production', () => ({
  mobileSavedLocationHydrationManager: {
    hydrate: hydrateMock,
    getState: getStateMock,
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  getStateMock.mockReturnValue({ status: 'NOT_STARTED' });
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
// manager returned.
// ---------------------------------------------------------------------------

describe('first start() call', () => {
  it('calls hydrate() exactly once and returns the manager promise by reference', async () => {
    const managerPromise = Promise.resolve();
    hydrateMock.mockReturnValue(managerPromise);
    const { startMobileSavedLocationHydrationOnce } = await import(
      './mobile-saved-location-hydration-startup'
    );

    const result = startMobileSavedLocationHydrationOnce();

    expect(hydrateMock).toHaveBeenCalledTimes(1);
    expect(result).toBe(managerPromise);

    await result;
  });
});

// ---------------------------------------------------------------------------
// 4/5 — concurrent / repeated calls while the first hydration is still pending all return the
// same promise reference, and the manager is called exactly once.
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
// still call the manager only once.
// ---------------------------------------------------------------------------

describe('repeated calls after settlement', () => {
  it('returns the same promise reference and calls hydrate() only once after completion', async () => {
    const managerPromise = Promise.resolve();
    hydrateMock.mockReturnValue(managerPromise);
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
// 7 — no automatic retry after the first hydration settles with the manager reporting ERROR.
// ---------------------------------------------------------------------------

describe('no automatic retry after ERROR', () => {
  it('does not call hydrate() again after the manager settles into ERROR', async () => {
    const managerPromise = Promise.resolve();
    hydrateMock.mockReturnValue(managerPromise);
    getStateMock.mockReturnValue({ status: 'ERROR', error: { kind: 'STORAGE_READ_FAILED' } });
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
