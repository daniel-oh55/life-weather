import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// The native AsyncStorage module is replaced with an in-memory, call-recording mock so the real
// persistence / hydration / application-store code runs unmodified against it, exactly as
// `mobile-saved-location-hydration-production.test.ts` does.
// ---------------------------------------------------------------------------

const asyncStorageMock = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: asyncStorageMock,
}));

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
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1 — importing the composition performs no storage I/O and starts no hydration.
// ---------------------------------------------------------------------------

describe('module import', () => {
  it('performs no storage I/O and leaves the snapshot at NOT_STARTED / IDLE', async () => {
    const { mobileSavedLocationApplicationStore } = await import(
      './mobile-saved-location-application-production'
    );

    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.removeItem).toHaveBeenCalledTimes(0);
    expect(mobileSavedLocationApplicationStore.getSnapshot()).toEqual({
      status: 'NOT_STARTED',
      writeStatus: 'IDLE',
    });
  });

  it('is a module-scope singleton — repeated imports return the same instance', async () => {
    const first = await import('./mobile-saved-location-application-production');
    const second = await import('./mobile-saved-location-application-production');

    expect(first.mobileSavedLocationApplicationStore).toBe(
      second.mobileSavedLocationApplicationStore,
    );
  });
});

// ---------------------------------------------------------------------------
// 2 — the injected hydration store is the existing production one: driving the app-root startup
// boundary moves the application store's snapshot, proving both observe the same instance.
// ---------------------------------------------------------------------------

describe('hydration store injection', () => {
  it('observes the same production hydration store the app-root startup drives', async () => {
    asyncStorageMock.getItem.mockResolvedValue(
      JSON.stringify({ version: 1, locations: [storedRecord('a', 0)] }),
    );

    const { mobileSavedLocationApplicationStore } = await import(
      './mobile-saved-location-application-production'
    );
    const { startMobileSavedLocationHydrationOnce } = await import(
      './mobile-saved-location-hydration-startup'
    );

    await startMobileSavedLocationHydrationOnce();

    const snapshot = mobileSavedLocationApplicationStore.getSnapshot();
    if (snapshot.status !== 'READY') {
      throw new Error(`expected READY, received ${snapshot.status}`);
    }
    expect(snapshot.locations.map((location) => location.id)).toEqual(['a']);
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(1);
  });

  it('delegates retryHydration to that same production hydration store', async () => {
    asyncStorageMock.getItem.mockRejectedValueOnce(new Error('synthetic storage failure'));
    asyncStorageMock.getItem.mockResolvedValue(null);

    const { mobileSavedLocationApplicationStore } = await import(
      './mobile-saved-location-application-production'
    );
    const { mobileSavedLocationHydrationStore } = await import(
      './mobile-saved-location-hydration-production'
    );

    await mobileSavedLocationHydrationStore.hydrate();
    expect(mobileSavedLocationApplicationStore.getSnapshot().status).toBe('ERROR');

    await mobileSavedLocationApplicationStore.retryHydration();

    expect(mobileSavedLocationApplicationStore.getSnapshot()).toEqual({
      status: 'EMPTY',
      writeStatus: 'IDLE',
    });
    expect(mobileSavedLocationHydrationStore.getSnapshot()).toEqual({ status: 'EMPTY' });
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 3 — the injected persistence is the concrete AsyncStorage binding: a real mutation writes the
// versioned V1 envelope to the stable key through `setItem`, exactly once, and never `removeItem`.
// ---------------------------------------------------------------------------

describe('persistence injection', () => {
  it('writes the canonical V1 envelope through AsyncStorage on a successful mutation', async () => {
    asyncStorageMock.getItem.mockResolvedValue(
      JSON.stringify({ version: 1, locations: [storedRecord('a', 0), storedRecord('b', 1)] }),
    );

    const { mobileSavedLocationApplicationStore } = await import(
      './mobile-saved-location-application-production'
    );
    const { mobileSavedLocationHydrationStore } = await import(
      './mobile-saved-location-hydration-production'
    );
    const { SAVED_LOCATION_PERSISTENCE_KEY } = await import('./index');

    await mobileSavedLocationHydrationStore.hydrate();
    const result = await mobileSavedLocationApplicationStore.remove('a');

    expect(result).toEqual({ ok: true });
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(1);
    const [key, serialized] = asyncStorageMock.setItem.mock.calls[0] as [string, string];
    expect(key).toBe(SAVED_LOCATION_PERSISTENCE_KEY);
    expect(JSON.parse(serialized)).toEqual({ version: 1, locations: [storedRecord('b', 0)] });
    expect(asyncStorageMock.removeItem).toHaveBeenCalledTimes(0);
  });

  it('writes an empty V1 envelope — never removeItem — when the last location is removed', async () => {
    asyncStorageMock.getItem.mockResolvedValue(
      JSON.stringify({ version: 1, locations: [storedRecord('a', 0)] }),
    );

    const { mobileSavedLocationApplicationStore } = await import(
      './mobile-saved-location-application-production'
    );
    const { mobileSavedLocationHydrationStore } = await import(
      './mobile-saved-location-hydration-production'
    );

    await mobileSavedLocationHydrationStore.hydrate();
    const result = await mobileSavedLocationApplicationStore.remove('a');

    expect(result).toEqual({ ok: true });
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(1);
    const [, serialized] = asyncStorageMock.setItem.mock.calls[0] as [string, string];
    expect(JSON.parse(serialized)).toEqual({ version: 1, locations: [] });
    expect(asyncStorageMock.removeItem).toHaveBeenCalledTimes(0);
    expect(mobileSavedLocationApplicationStore.getSnapshot()).toEqual({
      status: 'EMPTY',
      writeStatus: 'IDLE',
    });
  });

  it('surfaces a native write rejection as STORAGE_WRITE_FAILED and keeps the stored collection', async () => {
    asyncStorageMock.getItem.mockResolvedValue(
      JSON.stringify({ version: 1, locations: [storedRecord('a', 0)] }),
    );
    asyncStorageMock.setItem.mockRejectedValue(new Error('synthetic native write failure'));

    const { mobileSavedLocationApplicationStore } = await import(
      './mobile-saved-location-application-production'
    );
    const { mobileSavedLocationHydrationStore } = await import(
      './mobile-saved-location-hydration-production'
    );

    await mobileSavedLocationHydrationStore.hydrate();
    const result = await mobileSavedLocationApplicationStore.remove('a');

    expect(result).toEqual({ ok: false, error: { kind: 'STORAGE_WRITE_FAILED' } });
    expect(JSON.stringify(result)).not.toContain('synthetic native write failure');
    const snapshot = mobileSavedLocationApplicationStore.getSnapshot();
    if (snapshot.status !== 'READY') {
      throw new Error(`expected READY, received ${snapshot.status}`);
    }
    expect(snapshot.locations.map((location) => location.id)).toEqual(['a']);
    expect(snapshot.writeStatus).toBe('IDLE');
  });
});

// ---------------------------------------------------------------------------
// 4 — the pure barrel never exposes this native-backed composition.
// ---------------------------------------------------------------------------

describe('pure barrel non-exposure', () => {
  it('does not export the production application store from the pure barrel', async () => {
    const barrel = await import('./index');

    expect('mobileSavedLocationApplicationStore' in barrel).toBe(false);
    expect('createSavedLocationApplicationStore' in barrel).toBe(true);
  });
});
