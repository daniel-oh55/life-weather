import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// The native AsyncStorage module is replaced with an in-memory, call-recording mock so the real
// persistence / hydration / application-store / hook code runs unmodified against it, exactly as
// `use-mobile-saved-locations.test.ts` does. Nothing about the saved-location boundary is stubbed:
// every assertion below goes through the real store and the real codec.
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
// `react`'s `useSyncExternalStore` and `useState` are replaced with minimal fakes so `HomeScreen`
// can be invoked as a plain function (no renderer is available in this Node-based setup). The
// `useSyncExternalStore` fake reads the supplied `getSnapshot()`, matching what React does on an
// initial render; the `useState` fake keeps per-render-slot state across the manual `render()` calls
// below. Only React's scheduling is faked — the screen's own logic and every boundary beneath it
// run for real. Every other `react` export stays the real implementation.
// ---------------------------------------------------------------------------

const useSyncExternalStoreMock = vi.hoisted(() => vi.fn());
const useStateMock = vi.hoisted(() => vi.fn());

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useSyncExternalStore: useSyncExternalStoreMock,
    useState: useStateMock,
  };
});

// ---------------------------------------------------------------------------
// `react-native` ships Flow syntax its `index.js` cannot be parsed by this Vitest/Rolldown setup, so
// it is replaced with minimal marker components and a `StyleSheet.create` passthrough — matching how
// `_layout.test.tsx` mocks `expo-router`'s `Stack`. `HomeScreen` is still invoked as a real function
// and its returned element tree is inspected directly.
// ---------------------------------------------------------------------------

const MockView = vi.hoisted(() => function MockView(): null {
  return null;
});
const MockText = vi.hoisted(() => function MockText(): null {
  return null;
});
const MockPressable = vi.hoisted(() => function MockPressable(): null {
  return null;
});

vi.mock('react-native', () => ({
  View: MockView,
  Text: MockText,
  Pressable: MockPressable,
  StyleSheet: { create: (styles: unknown) => styles },
}));

// ---------------------------------------------------------------------------
// Synthetic fixtures and element-tree helpers.
// ---------------------------------------------------------------------------

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

function storedEnvelope(...ids: string[]): string {
  return JSON.stringify({
    version: 1,
    locations: ids.map((id, index) => storedRecord(id, index)),
  });
}

interface ElementLike {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
}

function isElement(node: unknown): node is ElementLike {
  return typeof node === 'object' && node !== null && 'type' in node && 'props' in node;
}

function walk(node: unknown, visit: (element: ElementLike) => void): void {
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit));
    return;
  }
  if (!isElement(node)) {
    return;
  }
  visit(node);
  walk(node.props.children, visit);
}

/** Every rendered `Text` string, in document order. */
function texts(root: unknown): string[] {
  const collected: string[] = [];
  walk(root, (element) => {
    if (element.type === MockText && typeof element.props.children === 'string') {
      collected.push(element.props.children);
    }
  });
  return collected;
}

function pressables(root: unknown): ElementLike[] {
  const collected: ElementLike[] = [];
  walk(root, (element) => {
    if (element.type === MockPressable) {
      collected.push(element);
    }
  });
  return collected;
}

function pressableByLabel(root: unknown, accessibilityLabel: string): ElementLike {
  const match = pressables(root).find(
    (element) => element.props.accessibilityLabel === accessibilityLabel,
  );
  if (match === undefined) {
    throw new Error(`no pressable labelled "${accessibilityLabel}" was rendered`);
  }
  return match;
}

function press(element: ElementLike): void {
  (element.props.onPress as () => void)();
}

/** Let every pending microtask — and therefore any settled mutation — run to completion. */
async function flush(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

// ---------------------------------------------------------------------------
// A minimal `useState` slot table: `render()` resets the cursor, so repeated renders read back the
// state their setters wrote, the way React would.
// ---------------------------------------------------------------------------

let hookSlots: unknown[] = [];
let hookCursor = 0;

async function loadScreen() {
  const { default: HomeScreen } = await import('./index');
  return function render() {
    hookCursor = 0;
    return HomeScreen();
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  hookSlots = [];
  hookCursor = 0;
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
  useStateMock.mockImplementation((initial: unknown) => {
    const slot = hookCursor;
    hookCursor += 1;
    if (!(slot in hookSlots)) {
      hookSlots[slot] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    }
    const setState = (next: unknown) => {
      hookSlots[slot] =
        typeof next === 'function' ? (next as (previous: unknown) => unknown)(hookSlots[slot]) : next;
    };
    return [hookSlots[slot], setState];
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1 — the five read-only states keep the PR #49 copy, and only ERROR / READY add controls.
// ---------------------------------------------------------------------------

describe('read-only states', () => {
  it('renders the not-started copy with no controls and no storage I/O', async () => {
    const render = await loadScreen();

    const element = render();

    expect(texts(element)).toEqual(['저장 지역을 준비하고 있습니다.']);
    expect(pressables(element)).toHaveLength(0);
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(0);
  });

  it('renders the loading copy while hydration is in flight', async () => {
    let resolveGetItem: (value: string | null) => void = () => {};
    asyncStorageMock.getItem.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGetItem = resolve;
        }),
    );

    const render = await loadScreen();
    const { mobileSavedLocationHydrationStore } = await import(
      '../locations/mobile-saved-location-hydration-production'
    );

    const hydrating = mobileSavedLocationHydrationStore.hydrate();

    expect(texts(render())).toEqual(['저장된 지역을 불러오는 중입니다.']);
    expect(pressables(render())).toHaveLength(0);

    while (asyncStorageMock.getItem.mock.calls.length === 0) {
      await Promise.resolve();
    }
    resolveGetItem(null);
    await hydrating;
  });

  it('renders the empty copy with no controls', async () => {
    const render = await loadScreen();
    const { mobileSavedLocationHydrationStore } = await import(
      '../locations/mobile-saved-location-hydration-production'
    );

    await mobileSavedLocationHydrationStore.hydrate();

    expect(texts(render())).toEqual(['저장된 지역이 없습니다.']);
    expect(pressables(render())).toHaveLength(0);
  });

  it('renders the ready copy, one row per saved location, and a delete control for each', async () => {
    asyncStorageMock.getItem.mockResolvedValue(storedEnvelope('a', 'b', 'c'));
    const render = await loadScreen();
    const { mobileSavedLocationHydrationStore } = await import(
      '../locations/mobile-saved-location-hydration-production'
    );

    await mobileSavedLocationHydrationStore.hydrate();
    const element = render();

    expect(texts(element)).toEqual([
      '저장된 지역이 준비되었습니다.\n저장 지역 수: 3',
      'Synthetic a',
      '삭제',
      'Synthetic b',
      '삭제',
      'Synthetic c',
      '삭제',
    ]);
    expect(
      pressables(element).map((pressable) => pressable.props.accessibilityLabel),
    ).toEqual(['Synthetic a 삭제', 'Synthetic b 삭제', 'Synthetic c 삭제']);
    expect(pressables(element).every((pressable) => pressable.props.disabled === false)).toBe(true);
  });

  it('renders the error copy with a retry control and no raw error detail', async () => {
    asyncStorageMock.getItem.mockRejectedValue(new Error('synthetic storage failure'));
    const render = await loadScreen();
    const { mobileSavedLocationHydrationStore } = await import(
      '../locations/mobile-saved-location-hydration-production'
    );

    await mobileSavedLocationHydrationStore.hydrate();
    const element = render();
    const rendered = texts(element).join('\n');

    expect(texts(element)).toEqual(['저장된 지역을 불러오지 못했습니다.', '다시 시도']);
    expect(pressableByLabel(element, '저장 지역 다시 불러오기')).toBeDefined();
    expect(rendered).not.toContain('STORAGE_READ_FAILED');
    expect(rendered).not.toContain('synthetic storage failure');
  });

  it('does not hydrate, retry, or mutate merely by rendering', async () => {
    const render = await loadScreen();
    const { mobileSavedLocationApplicationStore } = await import(
      '../locations/mobile-saved-location-application-production'
    );
    const retrySpy = vi.spyOn(mobileSavedLocationApplicationStore, 'retryHydration');
    const removeSpy = vi.spyOn(mobileSavedLocationApplicationStore, 'remove');
    const addSpy = vi.spyOn(mobileSavedLocationApplicationStore, 'add');

    render();
    render();
    render();

    expect(retrySpy).toHaveBeenCalledTimes(0);
    expect(removeSpy).toHaveBeenCalledTimes(0);
    expect(addSpy).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.removeItem).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// 2 — explicit retry from ERROR.
// ---------------------------------------------------------------------------

describe('retry', () => {
  it('re-reads storage once and reflects the recovered state', async () => {
    asyncStorageMock.getItem.mockRejectedValueOnce(new Error('synthetic storage failure'));
    asyncStorageMock.getItem.mockResolvedValue(storedEnvelope('a'));

    const render = await loadScreen();
    const { mobileSavedLocationHydrationStore } = await import(
      '../locations/mobile-saved-location-hydration-production'
    );

    await mobileSavedLocationHydrationStore.hydrate();
    expect(texts(render())).toContain('저장된 지역을 불러오지 못했습니다.');

    press(pressableByLabel(render(), '저장 지역 다시 불러오기'));
    await flush();

    expect(texts(render())).toEqual([
      '저장된 지역이 준비되었습니다.\n저장 지역 수: 1',
      'Synthetic a',
      '삭제',
    ]);
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(2);
  });

  it('starts no second load when the retry control is tapped repeatedly', async () => {
    let resolveGetItem: (value: string | null) => void = () => {};
    asyncStorageMock.getItem.mockRejectedValueOnce(new Error('synthetic storage failure'));
    asyncStorageMock.getItem.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGetItem = resolve;
        }),
    );

    const render = await loadScreen();
    const { mobileSavedLocationHydrationStore } = await import(
      '../locations/mobile-saved-location-hydration-production'
    );

    await mobileSavedLocationHydrationStore.hydrate();
    const retry = pressableByLabel(render(), '저장 지역 다시 불러오기');

    press(retry);
    press(retry);
    press(retry);
    await Promise.resolve();

    // The retry control is gone the moment hydration is back in flight, and the three taps shared
    // the store's single in-flight load rather than starting three reads.
    expect(texts(render())).toEqual(['저장된 지역을 불러오는 중입니다.']);
    expect(pressables(render())).toHaveLength(0);

    while (asyncStorageMock.getItem.mock.calls.length < 2) {
      await Promise.resolve();
    }
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(2);
    resolveGetItem(null);
    await flush();
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 3 — deleting a saved location.
// ---------------------------------------------------------------------------

describe('delete', () => {
  it('persists the removal and re-renders the real remaining collection', async () => {
    asyncStorageMock.getItem.mockResolvedValue(storedEnvelope('a', 'b', 'c'));
    const render = await loadScreen();
    const { mobileSavedLocationHydrationStore } = await import(
      '../locations/mobile-saved-location-hydration-production'
    );

    await mobileSavedLocationHydrationStore.hydrate();
    press(pressableByLabel(render(), 'Synthetic b 삭제'));
    await flush();

    expect(texts(render())).toEqual([
      '저장된 지역이 준비되었습니다.\n저장 지역 수: 2',
      'Synthetic a',
      '삭제',
      'Synthetic c',
      '삭제',
    ]);
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(1);
    const [, serialized] = asyncStorageMock.setItem.mock.calls[0] as [string, string];
    expect(JSON.parse(serialized)).toEqual({
      version: 1,
      locations: [storedRecord('a', 0), storedRecord('c', 1)],
    });
  });

  it('shows the empty state after the last saved location is deleted, without removeItem', async () => {
    asyncStorageMock.getItem.mockResolvedValue(storedEnvelope('a'));
    const render = await loadScreen();
    const { mobileSavedLocationHydrationStore } = await import(
      '../locations/mobile-saved-location-hydration-production'
    );

    await mobileSavedLocationHydrationStore.hydrate();
    press(pressableByLabel(render(), 'Synthetic a 삭제'));
    await flush();

    expect(texts(render())).toEqual(['저장된 지역이 없습니다.']);
    expect(pressables(render())).toHaveLength(0);
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(1);
    expect(asyncStorageMock.removeItem).toHaveBeenCalledTimes(0);
  });

  it('disables every delete control while the write is in flight', async () => {
    asyncStorageMock.getItem.mockResolvedValue(storedEnvelope('a', 'b'));
    let resolveSetItem: () => void = () => {};
    asyncStorageMock.setItem.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSetItem = () => resolve();
        }),
    );

    const render = await loadScreen();
    const { mobileSavedLocationHydrationStore } = await import(
      '../locations/mobile-saved-location-hydration-production'
    );

    await mobileSavedLocationHydrationStore.hydrate();
    press(pressableByLabel(render(), 'Synthetic a 삭제'));

    const during = render();
    expect(pressables(during).every((pressable) => pressable.props.disabled === true)).toBe(true);
    // No optimistic update: both rows are still shown while the write is in flight.
    expect(texts(during)).toContain('저장된 지역이 준비되었습니다.\n저장 지역 수: 2');

    resolveSetItem();
    await flush();

    const after = render();
    expect(texts(after)).toContain('저장된 지역이 준비되었습니다.\n저장 지역 수: 1');
    expect(pressables(after).every((pressable) => pressable.props.disabled === false)).toBe(true);
  });

  it('shows generic copy when the write fails and keeps the collection unchanged', async () => {
    asyncStorageMock.getItem.mockResolvedValue(storedEnvelope('a', 'b'));
    asyncStorageMock.setItem.mockRejectedValue(new Error('synthetic native write failure'));

    const render = await loadScreen();
    const { mobileSavedLocationHydrationStore } = await import(
      '../locations/mobile-saved-location-hydration-production'
    );

    await mobileSavedLocationHydrationStore.hydrate();
    press(pressableByLabel(render(), 'Synthetic a 삭제'));
    await flush();

    const element = render();
    const rendered = texts(element).join('\n');

    expect(texts(element)).toEqual([
      '저장된 지역이 준비되었습니다.\n저장 지역 수: 2',
      'Synthetic a',
      '삭제',
      'Synthetic b',
      '삭제',
      '저장 지역 변경을 저장하지 못했습니다.',
    ]);
    expect(rendered).not.toContain('STORAGE_WRITE_FAILED');
    expect(rendered).not.toContain('synthetic native write failure');
    expect(rendered).not.toContain('@life-weather/mobile/saved-locations');
    expect(rendered).not.toContain('37.5');
    expect(rendered).not.toContain('127');
  });

  it('clears the failure copy once a later delete succeeds', async () => {
    asyncStorageMock.getItem.mockResolvedValue(storedEnvelope('a', 'b'));
    asyncStorageMock.setItem.mockRejectedValueOnce(new Error('synthetic native write failure'));
    asyncStorageMock.setItem.mockResolvedValue(undefined);

    const render = await loadScreen();
    const { mobileSavedLocationHydrationStore } = await import(
      '../locations/mobile-saved-location-hydration-production'
    );

    await mobileSavedLocationHydrationStore.hydrate();
    press(pressableByLabel(render(), 'Synthetic a 삭제'));
    await flush();
    expect(texts(render())).toContain('저장 지역 변경을 저장하지 못했습니다.');

    press(pressableByLabel(render(), 'Synthetic a 삭제'));
    await flush();

    expect(texts(render())).toEqual([
      '저장된 지역이 준비되었습니다.\n저장 지역 수: 1',
      'Synthetic b',
      '삭제',
    ]);
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(2);
  });
});
