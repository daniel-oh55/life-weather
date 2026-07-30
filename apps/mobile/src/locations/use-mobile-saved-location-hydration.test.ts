import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// The native AsyncStorage module is replaced with an in-memory, call-recording mock so the real
// persistence / hydration-manager / production-composition code can run unmodified against it,
// exactly as `mobile-saved-location-hydration-production.test.ts` does.
// ---------------------------------------------------------------------------

const asyncStorageMock = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: asyncStorageMock,
}));

// ---------------------------------------------------------------------------
// `react`'s `useSyncExternalStore` is replaced with a mock so each call, and each argument passed to
// it, can be inspected directly without a renderer. Its default behavior calls the supplied
// `getSnapshot()` and returns the result, matching what React itself would do on an initial render.
// Every other `react` export stays the real implementation.
// ---------------------------------------------------------------------------

const useSyncExternalStoreMock = vi.hoisted(() => vi.fn());

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useSyncExternalStore: useSyncExternalStoreMock };
});

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  asyncStorageMock.getItem.mockResolvedValue(null);
  asyncStorageMock.setItem.mockResolvedValue(undefined);
  asyncStorageMock.removeItem.mockResolvedValue(undefined);
  useSyncExternalStoreMock.mockImplementation(
    (
      _subscribe: (onStoreChange: () => void) => () => void,
      getSnapshot: () => unknown,
      _getServerSnapshot?: () => unknown,
    ) => getSnapshot(),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1 — importing the hook module performs no side effects: no `useSyncExternalStore` call, no
// storage I/O, and the production manager/store both still read `NOT_STARTED`.
// ---------------------------------------------------------------------------

describe('module import', () => {
  it('performs no side effects on import', async () => {
    const { mobileSavedLocationHydrationManager, mobileSavedLocationHydrationStore } = await import(
      './mobile-saved-location-hydration-production'
    );
    await import('./use-mobile-saved-location-hydration');

    expect(useSyncExternalStoreMock).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.removeItem).toHaveBeenCalledTimes(0);
    expect(mobileSavedLocationHydrationManager.getState()).toEqual({ status: 'NOT_STARTED' });
    expect(mobileSavedLocationHydrationStore.getSnapshot()).toEqual({ status: 'NOT_STARTED' });
  });
});

// ---------------------------------------------------------------------------
// 2 — calling the hook calls `useSyncExternalStore` exactly once and returns the exact production
// store snapshot reference, initially `NOT_STARTED` and frozen.
// ---------------------------------------------------------------------------

describe('hook wiring and return reference', () => {
  it('calls useSyncExternalStore once and returns the exact store snapshot reference', async () => {
    const { useMobileSavedLocationHydration } = await import('./use-mobile-saved-location-hydration');
    const { mobileSavedLocationHydrationStore } = await import('./mobile-saved-location-hydration-production');

    const result = useMobileSavedLocationHydration();

    expect(useSyncExternalStoreMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: 'NOT_STARTED' });
    expect(result).toBe(mobileSavedLocationHydrationStore.getSnapshot());
    expect(Object.isFrozen(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3 — the subscribe / client getSnapshot / server getSnapshot references passed to
// `useSyncExternalStore` are stable across repeated hook calls, and the client and server getters
// are the exact same reference.
// ---------------------------------------------------------------------------

describe('callback reference stability', () => {
  it('passes the same subscribe/getSnapshot/getServerSnapshot references across repeated hook calls', async () => {
    const { useMobileSavedLocationHydration } = await import('./use-mobile-saved-location-hydration');

    useMobileSavedLocationHydration();
    const firstCall = useSyncExternalStoreMock.mock.calls[0];
    if (firstCall === undefined) {
      throw new Error('expected the first hook call to have invoked useSyncExternalStore');
    }
    const [firstSubscribe, firstGetSnapshot, firstGetServerSnapshot] = firstCall;

    useMobileSavedLocationHydration();
    const secondCall = useSyncExternalStoreMock.mock.calls[1];
    if (secondCall === undefined) {
      throw new Error('expected the second hook call to have invoked useSyncExternalStore');
    }
    const [secondSubscribe, secondGetSnapshot, secondGetServerSnapshot] = secondCall;

    expect(firstSubscribe).toBe(secondSubscribe);
    expect(firstGetSnapshot).toBe(secondGetSnapshot);
    expect(firstGetServerSnapshot).toBe(secondGetServerSnapshot);
    expect(firstGetSnapshot).toBe(firstGetServerSnapshot);
  });
});

// ---------------------------------------------------------------------------
// 4 — calling the hook, however many times, never starts hydration itself: manager/store stay
// `NOT_STARTED`, no storage I/O, and the store's own `hydrate()` is never invoked by the hook.
// ---------------------------------------------------------------------------

describe('hook does not start hydration', () => {
  it('does not start hydration by itself, however many times it is called', async () => {
    const { useMobileSavedLocationHydration } = await import('./use-mobile-saved-location-hydration');
    const { mobileSavedLocationHydrationManager, mobileSavedLocationHydrationStore } = await import(
      './mobile-saved-location-hydration-production'
    );
    const hydrateSpy = vi.spyOn(mobileSavedLocationHydrationStore, 'hydrate');

    useMobileSavedLocationHydration();
    useMobileSavedLocationHydration();
    useMobileSavedLocationHydration();

    expect(mobileSavedLocationHydrationManager.getState()).toEqual({ status: 'NOT_STARTED' });
    expect(mobileSavedLocationHydrationStore.getSnapshot()).toEqual({ status: 'NOT_STARTED' });
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.removeItem).toHaveBeenCalledTimes(0);
    expect(hydrateSpy).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// 5 — the subscribe callback passed to `useSyncExternalStore` genuinely delegates to the production
// store: registering a listener through it observes the real LOADING -> EMPTY transition, exactly
// twice, with `getSnapshot()` already reflecting each new state at the moment of notification.
// ---------------------------------------------------------------------------

describe('subscribe delegation', () => {
  it('delegates subscribe to the production store and reflects the new state at each notification', async () => {
    asyncStorageMock.getItem.mockResolvedValue(null);
    const { useMobileSavedLocationHydration } = await import('./use-mobile-saved-location-hydration');
    const { mobileSavedLocationHydrationStore } = await import('./mobile-saved-location-hydration-production');
    const { SAVED_LOCATION_PERSISTENCE_KEY } = await import('./index');

    useMobileSavedLocationHydration();
    const call = useSyncExternalStoreMock.mock.calls[0];
    if (call === undefined) {
      throw new Error('expected the hook call to have invoked useSyncExternalStore');
    }
    const [subscribe] = call as [(onStoreChange: () => void) => () => void];

    const observedStatuses: string[] = [];
    const listener = vi.fn(() => {
      observedStatuses.push(mobileSavedLocationHydrationStore.getSnapshot().status);
    });
    subscribe(listener);

    await mobileSavedLocationHydrationStore.hydrate();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(observedStatuses).toEqual(['LOADING', 'EMPTY']);
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(1);
    expect(asyncStorageMock.getItem).toHaveBeenCalledWith(SAVED_LOCATION_PERSISTENCE_KEY);
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.removeItem).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// 6 — the unsubscribe function returned by the delegated subscribe genuinely delegates to the
// production store: a listener removed before hydration starts never observes it (while a listener
// left registered still does, proving subscribe itself worked), calling unsubscribe twice never
// throws, and hydration still completes normally.
// ---------------------------------------------------------------------------

describe('unsubscribe delegation', () => {
  it('delegates unsubscribe to the production store, removes the listener, and is idempotent', async () => {
    asyncStorageMock.getItem.mockResolvedValue(null);
    const { useMobileSavedLocationHydration } = await import('./use-mobile-saved-location-hydration');
    const { mobileSavedLocationHydrationStore } = await import('./mobile-saved-location-hydration-production');

    useMobileSavedLocationHydration();
    const call = useSyncExternalStoreMock.mock.calls[0];
    if (call === undefined) {
      throw new Error('expected the hook call to have invoked useSyncExternalStore');
    }
    const [subscribe] = call as [(onStoreChange: () => void) => () => void];

    const keptListener = vi.fn();
    const removedListener = vi.fn();
    subscribe(keptListener);
    const unsubscribeRemoved = subscribe(removedListener);

    unsubscribeRemoved();
    expect(() => unsubscribeRemoved()).not.toThrow();

    await mobileSavedLocationHydrationStore.hydrate();

    expect(keptListener).toHaveBeenCalledTimes(2);
    expect(removedListener).toHaveBeenCalledTimes(0);
    expect(mobileSavedLocationHydrationStore.getSnapshot()).toEqual({ status: 'EMPTY' });
  });
});

// ---------------------------------------------------------------------------
// 7 — once real hydration reaches the terminal `EMPTY` state, calling the hook again returns that
// exact terminal snapshot (a different reference from the initial `NOT_STARTED` snapshot), storage
// was read exactly once in total, and nothing is logged.
// ---------------------------------------------------------------------------

describe('terminal snapshot reflected', () => {
  it('reflects the terminal EMPTY snapshot after hydration completes, reading storage once total and logging nothing', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    asyncStorageMock.getItem.mockResolvedValue(null);

    const { useMobileSavedLocationHydration } = await import('./use-mobile-saved-location-hydration');
    const { mobileSavedLocationHydrationStore } = await import('./mobile-saved-location-hydration-production');

    const initialResult = useMobileSavedLocationHydration();
    await mobileSavedLocationHydrationStore.hydrate();
    const finalResult = useMobileSavedLocationHydration();

    expect(finalResult.status).toBe('EMPTY');
    expect(finalResult).toBe(mobileSavedLocationHydrationStore.getSnapshot());
    expect(finalResult).not.toBe(initialResult);
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(1);
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleInfo).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 8 — the pure, provider-neutral barrel (`./index`) never exports the hook or the production
// store singleton — both stay behind a direct, runtime-only import.
// ---------------------------------------------------------------------------

describe('pure barrel non-exposure', () => {
  it('does not export the hook or the production store from the pure barrel', async () => {
    const barrel = await import('./index');

    expect('useMobileSavedLocationHydration' in barrel).toBe(false);
    expect('mobileSavedLocationHydrationStore' in barrel).toBe(false);
  });
});
