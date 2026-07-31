import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// The native AsyncStorage module is replaced with an in-memory, call-recording mock so the real
// persistence / hydration-manager / production-composition / hook code can run unmodified against
// it, exactly as `use-mobile-saved-location-hydration.test.ts` does.
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
// `react`'s `useSyncExternalStore` is replaced with a mock so `HomeScreen` can be invoked as a plain
// function (no renderer) while still delegating to the real hook/store. Its default behavior calls
// the supplied `getSnapshot()` and returns the result, matching what React itself would do on an
// initial render. Every other `react` export stays the real implementation.
// ---------------------------------------------------------------------------

const useSyncExternalStoreMock = vi.hoisted(() => vi.fn());

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useSyncExternalStore: useSyncExternalStoreMock };
});

// ---------------------------------------------------------------------------
// `react-native` ships Flow syntax its `index.js` cannot be parsed by this Vitest/Rolldown setup, so
// it is replaced with minimal marker components/`StyleSheet.create` passthrough — matching how
// `_layout.test.tsx` mocks `expo-router`'s `Stack`. `HomeScreen` is still invoked as a real function
// and its returned element tree is inspected directly, so this only removes an unparseable native
// dependency and asserts nothing about React Native internals.
// ---------------------------------------------------------------------------

const MockView = vi.hoisted(() => function MockView(): null {
  return null;
});
const MockText = vi.hoisted(() => function MockText(): null {
  return null;
});

vi.mock('react-native', () => ({
  View: MockView,
  Text: MockText,
  StyleSheet: { create: (styles: unknown) => styles },
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

function extractText(element: ReturnType<typeof import('./index').default>): string {
  const textElement = (element as { props: { children: unknown } }).props.children as {
    props: { children: string };
  };
  return textElement.props.children;
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
// 1 — before any hydration is driven, the screen shows the NOT_STARTED copy and performs no
// storage I/O by itself.
// ---------------------------------------------------------------------------

describe('NOT_STARTED', () => {
  it('renders the not-started copy without touching storage', async () => {
    const { default: HomeScreen } = await import('./index');

    const element = HomeScreen();

    expect(extractText(element)).toBe('저장 지역을 준비하고 있습니다.');
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// 2 — while the real store's `hydrate()` promise is still pending, the screen shows the LOADING
// copy (the manager transitions to LOADING synchronously before `persistence.load()` settles).
// ---------------------------------------------------------------------------

describe('LOADING', () => {
  it('renders the loading copy while hydration is in flight', async () => {
    let resolveGetItem: (value: string | null) => void = () => {};
    asyncStorageMock.getItem.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGetItem = resolve;
        }),
    );

    const { default: HomeScreen } = await import('./index');
    const { mobileSavedLocationHydrationStore } = await import(
      '../locations/mobile-saved-location-hydration-production'
    );

    const hydratePromise = mobileSavedLocationHydrationStore.hydrate();
    const element = HomeScreen();

    expect(extractText(element)).toBe('저장된 지역을 불러오는 중입니다.');

    // The manager defers its `persistence.load()` call by one microtask (see
    // `mobile-saved-location-hydration-manager.ts`), so wait until `getItem` has actually been
    // invoked before resolving it, rather than assuming a fixed number of ticks.
    while (asyncStorageMock.getItem.mock.calls.length === 0) {
      await Promise.resolve();
    }
    resolveGetItem(null);
    await hydratePromise;
  });
});

// ---------------------------------------------------------------------------
// 3 — a successful hydration against an empty stored collection shows the EMPTY copy.
// ---------------------------------------------------------------------------

describe('EMPTY', () => {
  it('renders the empty copy once hydration resolves to no saved locations', async () => {
    asyncStorageMock.getItem.mockResolvedValue(null);

    const { default: HomeScreen } = await import('./index');
    const { mobileSavedLocationHydrationStore } = await import(
      '../locations/mobile-saved-location-hydration-production'
    );

    await mobileSavedLocationHydrationStore.hydrate();
    const element = HomeScreen();

    expect(extractText(element)).toBe('저장된 지역이 없습니다.');
  });
});

// ---------------------------------------------------------------------------
// 4 — a successful hydration with saved locations shows the READY copy with the exact count taken
// from the snapshot (not a hardcoded value).
// ---------------------------------------------------------------------------

describe('READY', () => {
  it('renders the ready copy with the exact saved-location count from the snapshot', async () => {
    asyncStorageMock.getItem.mockResolvedValue(
      JSON.stringify({
        version: 1,
        locations: [storedRecord('a', 0), storedRecord('b', 1), storedRecord('c', 2)],
      }),
    );

    const { default: HomeScreen } = await import('./index');
    const { mobileSavedLocationHydrationStore } = await import(
      '../locations/mobile-saved-location-hydration-production'
    );

    await mobileSavedLocationHydrationStore.hydrate();
    const element = HomeScreen();

    expect(extractText(element)).toBe('저장된 지역이 준비되었습니다.\n저장 지역 수: 3');
  });
});

// ---------------------------------------------------------------------------
// 5 — a failed hydration shows the ERROR copy and never leaks the raw error kind or any storage
// detail into the rendered text.
// ---------------------------------------------------------------------------

describe('ERROR', () => {
  it('renders the error copy without exposing the raw error kind', async () => {
    asyncStorageMock.getItem.mockRejectedValue(new Error('synthetic storage failure'));

    const { default: HomeScreen } = await import('./index');
    const { mobileSavedLocationHydrationStore } = await import(
      '../locations/mobile-saved-location-hydration-production'
    );

    await mobileSavedLocationHydrationStore.hydrate();
    const element = HomeScreen();
    const text = extractText(element);

    expect(text).toBe('저장된 지역을 불러오지 못했습니다.');
    expect(text).not.toContain('STORAGE_READ_FAILED');
    expect(text).not.toContain('synthetic storage failure');
  });
});

// ---------------------------------------------------------------------------
// 6 — calling the screen, however many times, never itself starts hydration or touches storage;
// it only ever reflects whatever state the store already holds.
// ---------------------------------------------------------------------------

describe('no hydration side effects from the screen', () => {
  it('does not call hydrate() or storage APIs by rendering the screen', async () => {
    const { default: HomeScreen } = await import('./index');
    const { mobileSavedLocationHydrationStore } = await import(
      '../locations/mobile-saved-location-hydration-production'
    );
    const hydrateSpy = vi.spyOn(mobileSavedLocationHydrationStore, 'hydrate');

    HomeScreen();
    HomeScreen();
    HomeScreen();

    expect(hydrateSpy).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.removeItem).toHaveBeenCalledTimes(0);
  });
});
