import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// The native AsyncStorage module is replaced with an in-memory, call-recording mock, exactly as
// `index.test.tsx` does, so the real application store / persistence / hydration code runs
// unmodified. Nothing about the saved-location boundary is stubbed.
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
// `react`'s `useSyncExternalStore` and `useState` are replaced with minimal fakes, matching
// `index.test.tsx`, so `LocationSearchScreen` can be invoked as a plain function.
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
// `react-native` primitives, including `TextInput`, are replaced with minimal marker components.
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
const MockTextInput = vi.hoisted(() => function MockTextInput(): null {
  return null;
});
const MockScrollView = vi.hoisted(() => function MockScrollView(): null {
  return null;
});

vi.mock('react-native', () => ({
  View: MockView,
  Text: MockText,
  Pressable: MockPressable,
  TextInput: MockTextInput,
  ScrollView: MockScrollView,
  StyleSheet: { create: (styles: unknown) => styles },
}));

// ---------------------------------------------------------------------------
// `expo-router`'s `useRouter` is replaced with a fake returning call-recording `push`/`back`.
// ---------------------------------------------------------------------------

const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
  back: vi.fn(),
}));

vi.mock('expo-router', () => ({
  useRouter: () => routerMock,
}));

// ---------------------------------------------------------------------------
// Element-tree helpers, matching `index.test.tsx`.
// ---------------------------------------------------------------------------

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

function textInput(root: unknown): ElementLike {
  let found: ElementLike | undefined;
  walk(root, (element) => {
    if (element.type === MockTextInput) {
      found = element;
    }
  });
  if (found === undefined) {
    throw new Error('no TextInput was rendered');
  }
  return found;
}

/** The single scrollable result container, as an element — not merely an import check. */
function scrollView(root: unknown): ElementLike {
  const collected: ElementLike[] = [];
  walk(root, (element) => {
    if (element.type === MockScrollView) {
      collected.push(element);
    }
  });
  if (collected.length !== 1) {
    throw new Error(`expected exactly 1 ScrollView, found ${collected.length}`);
  }
  return collected[0] as ElementLike;
}

function press(element: ElementLike): void {
  (element.props.onPress as () => void)();
}

function changeText(element: ElementLike, value: string): void {
  (element.props.onChangeText as (next: string) => void)(value);
}

/** Let every pending microtask — and therefore any settled `add()` — run to completion. */
async function flush(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

// ---------------------------------------------------------------------------
// A minimal `useState` slot table, matching `index.test.tsx`: `render()` resets the cursor, so
// repeated renders read back the state their setters wrote, the way React would.
// ---------------------------------------------------------------------------

let hookSlots: unknown[] = [];
let hookCursor = 0;

async function loadScreen() {
  const { default: LocationSearchScreen } = await import('./locations');
  return function render() {
    hookCursor = 0;
    return LocationSearchScreen();
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

/** Hydrate the real store to a real EMPTY state, then return a fresh render(). */
async function hydratedRender(): Promise<() => unknown> {
  const render = await loadScreen();
  const { mobileSavedLocationHydrationStore } = await import(
    '../locations/mobile-saved-location-hydration-production'
  );
  await mobileSavedLocationHydrationStore.hydrate();
  return render;
}

// ---------------------------------------------------------------------------
// 1 — static rendering: title, back control, search input, accessibility, and no I/O on render.
// ---------------------------------------------------------------------------

describe('static rendering', () => {
  it('renders the screen title and a back control, with no results before typing', async () => {
    const render = await hydratedRender();
    const element = render();

    expect(texts(element)).toContain('지역 추가');
    expect(pressableByLabel(element, '뒤로 가기')).toBeDefined();
    expect(textInput(element).props.accessibilityLabel).toBe('지역 검색어 입력');
    // Only the title text and no result rows/add buttons for an empty query.
    expect(texts(element)).toEqual(['지역 추가', '뒤로']);
  });

  it('performs no search/storage I/O merely by rendering', async () => {
    const render = await hydratedRender();

    render();
    render();

    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.removeItem).toHaveBeenCalledTimes(0);
  });

  it('the back control calls router.back()', async () => {
    const render = await hydratedRender();
    press(pressableByLabel(render(), '뒤로 가기'));

    expect(routerMock.back).toHaveBeenCalledTimes(1);
  });

  it('gives every button at least a 48x48 touch target and an accessibility role/label', async () => {
    const render = await hydratedRender();
    changeText(textInput(render()), '중앙동');
    const element = render();

    for (const pressable of pressables(element)) {
      expect(pressable.props.accessibilityRole).toBe('button');
      expect(typeof pressable.props.accessibilityLabel).toBe('string');
      const style = pressable.props.style as { minHeight: number; minWidth: number };
      expect(style.minHeight).toBeGreaterThanOrEqual(48);
      expect(style.minWidth).toBeGreaterThanOrEqual(48);
    }
  });
});

// ---------------------------------------------------------------------------
// 2 — searching the real static catalog.
// ---------------------------------------------------------------------------

describe('search', () => {
  it('shows no results before a 2-character query', async () => {
    const render = await hydratedRender();
    const input = textInput(render());

    changeText(input, '강');

    expect(texts(render())).not.toContain('추가');
  });

  it('shows each real result\'s fullName with an "추가" control once the query reaches 2 characters', async () => {
    const render = await hydratedRender();
    const input = textInput(render());

    changeText(input, '강남구');
    const element = render();

    expect(texts(element)).toContain('서울특별시 강남구');
    expect(pressableByLabel(element, '서울특별시 강남구 추가')).toBeDefined();
  });

  it('updates results as the query changes', async () => {
    const render = await hydratedRender();
    const input = textInput(render());

    changeText(input, '강남구');
    expect(texts(render())).toContain('서울특별시 강남구');

    changeText(input, '제주특별자치도');
    const element = render();
    expect(texts(element)).toContain('제주특별자치도');
    expect(texts(element)).not.toContain('서울특별시 강남구');
  });
});

// ---------------------------------------------------------------------------
// 3 — the result list is scrollable, so a full 30-result page stays reachable.
// ---------------------------------------------------------------------------

describe('scrollable results', () => {
  it('renders the result list inside a ScrollView that flexes to fill the screen', async () => {
    const render = await hydratedRender();
    changeText(textInput(render()), '중앙동');
    const container = scrollView(render());

    expect((container.props.style as { flex: number }).flex).toBe(1);
  });

  it('keeps taps working while the keyboard is open', async () => {
    const render = await hydratedRender();
    changeText(textInput(render()), '중앙동');

    expect(scrollView(render()).props.keyboardShouldPersistTaps).toBe('handled');
  });

  it('puts every one of the 30 default-limit results inside the scroll container, not outside it', async () => {
    const render = await hydratedRender();
    changeText(textInput(render()), '중앙동');
    const element = render();
    const container = scrollView(element);

    // The real catalog has more than 30 "중앙동" entries, so the default limit fills a full page.
    const rowsInside = pressables(container).filter((pressable) =>
      String(pressable.props.accessibilityLabel).endsWith(' 추가'),
    );
    expect(rowsInside).toHaveLength(30);

    // Nothing but the back control lives outside the scroll container — the rows are not rendered
    // into a fixed-height parent that would clip them.
    const outside = pressables(element).filter((pressable) => !rowsInside.includes(pressable));
    expect(outside.map((pressable) => pressable.props.accessibilityLabel)).toEqual(['뒤로 가기']);
  });

  it('keeps a result near the bottom of the page reachable inside the scroll container', async () => {
    const render = await hydratedRender();
    changeText(textInput(render()), '중앙동');
    const container = scrollView(render());

    // 제주특별자치도 서귀포시 중앙동 sits deep in officialOrder — far below the fold on a phone.
    expect(texts(container)).toContain('제주특별자치도 서귀포시 중앙동');
    expect(pressableByLabel(container, '제주특별자치도 서귀포시 중앙동 추가')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 4 — adding a result: success persists through the real application store and navigates back.
// ---------------------------------------------------------------------------

describe('add', () => {
  it('persists a real candidate through the application store and navigates back on success', async () => {
    const render = await hydratedRender();
    const { mobileSavedLocationApplicationStore } = await import(
      '../locations/mobile-saved-location-application-production'
    );

    changeText(textInput(render()), '강남구');
    press(pressableByLabel(render(), '서울특별시 강남구 추가'));
    await flush();

    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(1);
    const [, serialized] = asyncStorageMock.setItem.mock.calls[0] as [string, string];
    const saved = JSON.parse(serialized) as { locations: { displayName: string }[] };
    expect(saved.locations).toHaveLength(1);
    expect(saved.locations[0]?.displayName).toBe('강남구');

    const snapshot = mobileSavedLocationApplicationStore.getSnapshot();
    expect(snapshot.status).toBe('READY');
    expect(routerMock.back).toHaveBeenCalledTimes(1);
  });

  it('shows the fixed duplicate copy and does not navigate back on a second add of the same place', async () => {
    const render = await hydratedRender();

    changeText(textInput(render()), '강남구');
    press(pressableByLabel(render(), '서울특별시 강남구 추가'));
    await flush();

    routerMock.back.mockClear();
    asyncStorageMock.setItem.mockClear();

    press(pressableByLabel(render(), '서울특별시 강남구 추가'));
    await flush();

    expect(texts(render())).toContain('이미 저장된 지역입니다.');
    expect(routerMock.back).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(0);
  });

  it('shows the fixed generic-failure copy when persistence fails, without raw error detail', async () => {
    asyncStorageMock.setItem.mockRejectedValue(new Error('synthetic native write failure'));
    const render = await hydratedRender();

    changeText(textInput(render()), '강남구');
    press(pressableByLabel(render(), '서울특별시 강남구 추가'));
    await flush();

    const rendered = texts(render()).join('\n');
    expect(rendered).toContain('지역을 저장하지 못했습니다.');
    expect(rendered).not.toContain('STORAGE_WRITE_FAILED');
    expect(rendered).not.toContain('synthetic native write failure');
    expect(routerMock.back).toHaveBeenCalledTimes(0);
  });

  it('disables every "추가" control while a write is in flight', async () => {
    let resolveSetItem: () => void = () => {};
    asyncStorageMock.setItem.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSetItem = () => resolve();
        }),
    );
    const render = await hydratedRender();

    changeText(textInput(render()), '강남구');
    press(pressableByLabel(render(), '서울특별시 강남구 추가'));

    const during = render();
    expect(pressables(during).length).toBeGreaterThan(0);
    for (const pressable of pressables(during)) {
      if (pressable.props.accessibilityLabel === '뒤로 가기') {
        continue;
      }
      expect(pressable.props.disabled).toBe(true);
    }

    resolveSetItem();
    await flush();
  });

  it('clears a prior add-failure message once the query changes', async () => {
    const render = await hydratedRender();

    changeText(textInput(render()), '강남구');
    press(pressableByLabel(render(), '서울특별시 강남구 추가'));
    await flush();
    press(pressableByLabel(render(), '서울특별시 강남구 추가'));
    await flush();
    expect(texts(render())).toContain('이미 저장된 지역입니다.');

    changeText(textInput(render()), '제주특별자치도');
    expect(texts(render())).not.toContain('이미 저장된 지역입니다.');
  });
});
