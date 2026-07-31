import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// The native AsyncStorage module is replaced with an in-memory, call-recording mock so the real
// persistence / hydration / application-store / hook code runs unmodified against it, exactly as
// `use-mobile-saved-location-hydration.test.ts` does.
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

function storedRecord(id: string, sortOrder: number) {
  return {
    ...sharedFields(id),
    kmaGrid: { nx: 60, ny: 127 },
    isCurrent: false,
    sortOrder,
  };
}

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
// 1 — importing the hook performs no side effects.
// ---------------------------------------------------------------------------

describe('module import', () => {
  it('performs no side effects on import', async () => {
    const { mobileSavedLocationApplicationStore } = await import(
      './mobile-saved-location-application-production'
    );
    await import('./use-mobile-saved-locations');

    expect(useSyncExternalStoreMock).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.removeItem).toHaveBeenCalledTimes(0);
    expect(mobileSavedLocationApplicationStore.getSnapshot()).toEqual({
      status: 'NOT_STARTED',
      writeStatus: 'IDLE',
    });
  });
});

// ---------------------------------------------------------------------------
// 2 — the hook returns the exact cached snapshot reference and is wired through
// `useSyncExternalStore` exactly once per call.
// ---------------------------------------------------------------------------

describe('hook wiring and return reference', () => {
  it('calls useSyncExternalStore once and returns the exact store snapshot reference', async () => {
    const { useMobileSavedLocations } = await import('./use-mobile-saved-locations');
    const { mobileSavedLocationApplicationStore } = await import(
      './mobile-saved-location-application-production'
    );

    const result = useMobileSavedLocations();

    expect(useSyncExternalStoreMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: 'NOT_STARTED', writeStatus: 'IDLE' });
    expect(result).toBe(mobileSavedLocationApplicationStore.getSnapshot());
    expect(Object.isFrozen(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3 — stable module-scope callbacks, with the client and server getter being one reference.
// ---------------------------------------------------------------------------

describe('callback reference stability', () => {
  it('passes the same subscribe/getSnapshot/getServerSnapshot references across repeated hook calls', async () => {
    const { useMobileSavedLocations } = await import('./use-mobile-saved-locations');

    useMobileSavedLocations();
    const firstCall = useSyncExternalStoreMock.mock.calls[0];
    if (firstCall === undefined) {
      throw new Error('expected the first hook call to have invoked useSyncExternalStore');
    }
    const [firstSubscribe, firstGetSnapshot, firstGetServerSnapshot] = firstCall;

    useMobileSavedLocations();
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
// 4 — the hook itself never starts hydration and never dispatches a mutation.
// ---------------------------------------------------------------------------

describe('hook has no side effects of its own', () => {
  it('does not hydrate, retry, or mutate however many times it is called', async () => {
    const { useMobileSavedLocations } = await import('./use-mobile-saved-locations');
    const { mobileSavedLocationApplicationStore } = await import(
      './mobile-saved-location-application-production'
    );
    const retrySpy = vi.spyOn(mobileSavedLocationApplicationStore, 'retryHydration');
    const addSpy = vi.spyOn(mobileSavedLocationApplicationStore, 'add');
    const removeSpy = vi.spyOn(mobileSavedLocationApplicationStore, 'remove');

    useMobileSavedLocations();
    useMobileSavedLocations();
    useMobileSavedLocations();

    expect(retrySpy).toHaveBeenCalledTimes(0);
    expect(addSpy).toHaveBeenCalledTimes(0);
    expect(removeSpy).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.removeItem).toHaveBeenCalledTimes(0);
    expect(mobileSavedLocationApplicationStore.getSnapshot().status).toBe('NOT_STARTED');
  });
});

// ---------------------------------------------------------------------------
// 5 — the delegated subscribe genuinely observes the real store, including the SAVING/IDLE write
// transitions a mutation produces.
// ---------------------------------------------------------------------------

describe('subscribe delegation', () => {
  it('observes the real hydration, selection, and write transitions through the delegated subscribe', async () => {
    const { SAVED_LOCATION_PERSISTENCE_KEY } = await import('./index');
    asyncStorageMock.getItem.mockImplementation(async (key: string) =>
      key === SAVED_LOCATION_PERSISTENCE_KEY
        ? JSON.stringify({ version: 1, locations: [storedRecord('a', 0)] })
        : null,
    );

    const { useMobileSavedLocations } = await import('./use-mobile-saved-locations');
    const { mobileSavedLocationApplicationStore } = await import(
      './mobile-saved-location-application-production'
    );
    const { mobileSavedLocationHydrationStore } = await import(
      './mobile-saved-location-hydration-production'
    );

    useMobileSavedLocations();
    const call = useSyncExternalStoreMock.mock.calls[0];
    if (call === undefined) {
      throw new Error('expected the hook call to have invoked useSyncExternalStore');
    }
    const [subscribe] = call as [(onStoreChange: () => void) => () => void];

    const observed: string[] = [];
    subscribe(() => {
      const snapshot = mobileSavedLocationApplicationStore.getSnapshot();
      observed.push(`${snapshot.status}:${snapshot.writeStatus}`);
    });

    await mobileSavedLocationHydrationStore.hydrate();
    await mobileSavedLocationApplicationStore.initializeSelectedLocation();
    await mobileSavedLocationApplicationStore.remove('a');

    expect(observed).toEqual([
      'LOADING:IDLE',
      'SELECTION_LOADING:IDLE',
      'READY:IDLE',
      'READY:SAVING',
      'EMPTY:IDLE',
    ]);
  });

  it('delegates unsubscribe to the store and is idempotent', async () => {
    const { useMobileSavedLocations } = await import('./use-mobile-saved-locations');
    const { mobileSavedLocationHydrationStore } = await import(
      './mobile-saved-location-hydration-production'
    );

    useMobileSavedLocations();
    const call = useSyncExternalStoreMock.mock.calls[0];
    if (call === undefined) {
      throw new Error('expected the hook call to have invoked useSyncExternalStore');
    }
    const [subscribe] = call as [(onStoreChange: () => void) => () => void];

    const kept = vi.fn();
    const removed = vi.fn();
    subscribe(kept);
    const unsubscribe = subscribe(removed);
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();

    await mobileSavedLocationHydrationStore.hydrate();

    expect(kept).toHaveBeenCalledTimes(2);
    expect(removed).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// 6 — the terminal snapshot is reflected on a later hook call, and the pure barrel never exports
// the hook.
// ---------------------------------------------------------------------------

describe('terminal snapshot and barrel non-exposure', () => {
  it('reflects the terminal snapshot after hydration, selection, and a mutation complete', async () => {
    const { SAVED_LOCATION_PERSISTENCE_KEY } = await import('./index');
    asyncStorageMock.getItem.mockImplementation(async (key: string) =>
      key === SAVED_LOCATION_PERSISTENCE_KEY
        ? JSON.stringify({ version: 1, locations: [storedRecord('a', 0), storedRecord('b', 1)] })
        : null,
    );

    const { useMobileSavedLocations } = await import('./use-mobile-saved-locations');
    const { mobileSavedLocationApplicationStore } = await import(
      './mobile-saved-location-application-production'
    );
    const { mobileSavedLocationHydrationStore } = await import(
      './mobile-saved-location-hydration-production'
    );

    const initial = useMobileSavedLocations();
    await mobileSavedLocationHydrationStore.hydrate();
    await mobileSavedLocationApplicationStore.initializeSelectedLocation();
    await mobileSavedLocationApplicationStore.remove('a');
    const final = useMobileSavedLocations();

    expect(initial.status).toBe('NOT_STARTED');
    expect(final).not.toBe(initial);
    expect(final).toBe(mobileSavedLocationApplicationStore.getSnapshot());
    if (final.status !== 'READY') {
      throw new Error(`expected READY, received ${final.status}`);
    }
    expect(final.locations.map((location) => location.id)).toEqual(['b']);
    expect(final.locations.map((location) => location.sortOrder)).toEqual([0]);
  });

  it('does not export the hook from the pure barrel', async () => {
    const barrel = await import('./index');

    expect('useMobileSavedLocations' in barrel).toBe(false);
  });
});
