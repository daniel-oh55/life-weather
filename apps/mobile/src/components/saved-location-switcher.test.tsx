import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// `react-native` ships Flow syntax this Vitest/Rolldown setup cannot parse, so it is replaced with
// minimal marker components and a `StyleSheet.create` passthrough — the same approach the
// `app-tests` files use. Only the primitives are faked; the component's own logic runs for real.
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
const MockScrollView = vi.hoisted(() => function MockScrollView(): null {
  return null;
});
const MockActivityIndicator = vi.hoisted(() => function MockActivityIndicator(): null {
  return null;
});
const MockModal = vi.hoisted(() => function MockModal(): null {
  return null;
});

vi.mock('react-native', () => ({
  View: MockView,
  Text: MockText,
  Pressable: MockPressable,
  ScrollView: MockScrollView,
  ActivityIndicator: MockActivityIndicator,
  Modal: MockModal,
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));

// ---------------------------------------------------------------------------
// `react`'s `useState` is replaced with a minimal slot table so the component can be invoked as a
// plain function (no renderer is available in this Node-based setup).
// ---------------------------------------------------------------------------

const useStateMock = vi.hoisted(() => vi.fn());

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useState: useStateMock };
});

// ---------------------------------------------------------------------------
// Expo Router's `useRouter` is replaced with a fake returning a call-recording `push` mock.
// ---------------------------------------------------------------------------

const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
  back: vi.fn(),
}));

vi.mock('expo-router', () => ({
  useRouter: () => routerMock,
}));

// ---------------------------------------------------------------------------
// The production application store is replaced with bare spies for exactly the two mutations this
// component is allowed to dispatch. Deliberately *not* a reimplementation of its real semantics —
// the write lock, fallback selection, and EMPTY transition are the store's own contract, covered by
// `../locations/mobile-saved-location-application-store.test.ts`. The absence of every other method
// here also proves this component never reaches for one.
// ---------------------------------------------------------------------------

const applicationStoreMock = vi.hoisted(() => ({
  select: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../locations/mobile-saved-location-application-production', () => ({
  mobileSavedLocationApplicationStore: applicationStoreMock,
}));

// ---------------------------------------------------------------------------
// Synthetic fixtures.
// ---------------------------------------------------------------------------

function savedLocationRecord(
  id: string,
  sortOrder: number,
  overrides: {
    displayName?: string;
    adminArea1?: string | null;
    adminArea2?: string | null;
    adminArea3?: string | null;
  } = {},
) {
  return {
    id,
    displayName: overrides.displayName ?? `Synthetic ${id}`,
    countryCode: 'KR',
    adminArea1: overrides.adminArea1 !== undefined ? overrides.adminArea1 : 'Synthetic Province',
    adminArea2: overrides.adminArea2 !== undefined ? overrides.adminArea2 : 'Synthetic District',
    adminArea3: overrides.adminArea3 !== undefined ? overrides.adminArea3 : null,
    latitude: 37.5,
    longitude: 127.0,
    timezone: 'Asia/Seoul',
    kmaGrid: { nx: 60, ny: 127 },
    isCurrent: false,
    sortOrder,
  };
}

type SavedLocationRecord = ReturnType<typeof savedLocationRecord>;

function readySnapshot(
  locations: SavedLocationRecord[],
  selectedLocationId: string,
  writeStatus: 'IDLE' | 'SAVING' = 'IDLE',
) {
  return { status: 'READY' as const, locations, selectedLocationId, writeStatus };
}
function notStartedSnapshot() {
  return { status: 'NOT_STARTED' as const, writeStatus: 'IDLE' as const };
}
function loadingSnapshot() {
  return { status: 'LOADING' as const, writeStatus: 'IDLE' as const };
}
function selectionLoadingSnapshot() {
  return { status: 'SELECTION_LOADING' as const, writeStatus: 'IDLE' as const };
}
function emptySnapshot() {
  return { status: 'EMPTY' as const, selectedLocationId: null, writeStatus: 'IDLE' as const };
}
function errorSnapshot() {
  return {
    status: 'ERROR' as const,
    error: { scope: 'SAVED_LOCATIONS' as const, kind: 'STORAGE_READ_FAILED' as const },
    writeStatus: 'IDLE' as const,
  };
}

function ok() {
  return { ok: true as const };
}
function failed(kind: string) {
  return { ok: false as const, error: { kind } };
}

// ---------------------------------------------------------------------------
// Element-tree helpers, matching the `app-tests` approach.
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

function elementsOfType(root: unknown, type: unknown): ElementLike[] {
  const collected: ElementLike[] = [];
  walk(root, (element) => {
    if (element.type === type) {
      collected.push(element);
    }
  });
  return collected;
}

function pressables(root: unknown): ElementLike[] {
  return elementsOfType(root, MockPressable);
}

function pressableLabels(root: unknown): string[] {
  return pressables(root).map((element) => element.props.accessibilityLabel as string);
}

function findPressable(root: unknown, accessibilityLabel: string): ElementLike | undefined {
  return pressables(root).find(
    (element) => element.props.accessibilityLabel === accessibilityLabel,
  );
}

function pressableByLabel(root: unknown, accessibilityLabel: string): ElementLike {
  const match = findPressable(root, accessibilityLabel);
  if (match === undefined) {
    throw new Error(`no pressable labelled "${accessibilityLabel}" was rendered`);
  }
  return match;
}

/** Mirrors React Native's `Pressable`: a `disabled` control never invokes `onPress`. */
function press(element: ElementLike): void {
  if (element.props.disabled === true) {
    return;
  }
  (element.props.onPress as () => void)();
}

function modal(root: unknown): ElementLike | undefined {
  return elementsOfType(root, MockModal)[0];
}

/** The saved-region names, in render order, as shown by each row's own name `Text`. */
function rowNames(root: unknown): string[] {
  return pressables(root)
    .map((element) => element.props.accessibilityLabel as string)
    .filter((label) => label.endsWith(' 선택') || label.endsWith(' 선택됨'))
    .map((label) => label.replace(/ 선택됨?$/u, ''));
}

/** Lets pending promise callbacks (the awaited mutation results) run. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

// ---------------------------------------------------------------------------
// A minimal `useState` slot table: `render()` resets the cursor, so repeated renders read back the
// state their setters wrote, the way React would.
// ---------------------------------------------------------------------------

let hookSlots: unknown[] = [];
let hookCursor = 0;

async function loadComponent() {
  const { SavedLocationSwitcher } = await import('./saved-location-switcher');
  return function render(savedLocations: unknown) {
    hookCursor = 0;
    return SavedLocationSwitcher({ savedLocations } as never);
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  hookSlots = [];
  hookCursor = 0;
  useStateMock.mockImplementation((initial: unknown) => {
    const slot = hookCursor;
    hookCursor += 1;
    if (!(slot in hookSlots)) {
      hookSlots[slot] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    }
    const setState = (next: unknown) => {
      hookSlots[slot] =
        typeof next === 'function'
          ? (next as (previous: unknown) => unknown)(hookSlots[slot])
          : next;
    };
    return [hookSlots[slot], setState];
  });
  applicationStoreMock.select.mockResolvedValue(ok());
  applicationStoreMock.remove.mockResolvedValue(ok());
});

// ---------------------------------------------------------------------------
// import-time side effects.
// ---------------------------------------------------------------------------

describe('import boundaries', () => {
  it('performs no store, router, or state I/O merely by importing the module', async () => {
    await import('./saved-location-switcher');

    expect(useStateMock).toHaveBeenCalledTimes(0);
    expect(routerMock.push).toHaveBeenCalledTimes(0);
    expect(applicationStoreMock.select).toHaveBeenCalledTimes(0);
    expect(applicationStoreMock.remove).toHaveBeenCalledTimes(0);
  });

  it('never imports the weather-query lifecycle, requests weather, or uses timers/storage', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./saved-location-switcher.tsx', import.meta.url), 'utf-8'),
    );

    expect(source).not.toContain('use-mobile-weather-query');
    expect(source).not.toContain('useMobileWeatherQueryLifecycle');
    expect(source).not.toContain('mobileWeatherQueryStore');
    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('setTimeout');
    expect(source).not.toContain('setInterval');
    expect(source).not.toContain('AsyncStorage');
    // The snapshot arrives as a prop; a second subscription would defeat the whole point.
    expect(source).not.toContain("from '../locations/use-mobile-saved-locations'");
    expect(source).not.toContain('useMobileSavedLocations(savedLocations');
    expect(source).not.toContain('useSyncExternalStore');
  });
});

// ---------------------------------------------------------------------------
// A. non-READY snapshots.
// ---------------------------------------------------------------------------

describe('A. non-READY snapshots', () => {
  it.each([
    ['NOT_STARTED', notStartedSnapshot()],
    ['LOADING', loadingSnapshot()],
    ['SELECTION_LOADING', selectionLoadingSnapshot()],
    ['EMPTY', emptySnapshot()],
    ['ERROR', errorSnapshot()],
  ] as const)('renders nothing at all for %s', async (_name, snapshot) => {
    const render = await loadComponent();

    const element = render(snapshot);

    expect(element).toBeNull();
    expect(pressables(element)).toHaveLength(0);
    expect(modal(element)).toBeUndefined();
    expect(texts(element)).toHaveLength(0);
  });

  it('renders nothing for a defensive READY whose selected id resolves to no record', async () => {
    const render = await loadComponent();

    const element = render(readySnapshot([savedLocationRecord('a', 0)], 'missing'));

    expect(element).toBeNull();
    expect(pressables(element)).toHaveLength(0);
  });

  it('does not fabricate a region name from the first saved location when the selection is missing', async () => {
    const render = await loadComponent();

    expect(texts(render(readySnapshot([savedLocationRecord('a', 0)], 'missing')))).not.toContain(
      'Synthetic a',
    );
  });
});

// ---------------------------------------------------------------------------
// B. the READY button.
// ---------------------------------------------------------------------------

describe('B. READY button', () => {
  it('shows the selected display name with a chevron and an accessible label', async () => {
    const render = await loadComponent();

    const element = render(
      readySnapshot([savedLocationRecord('a', 0), savedLocationRecord('b', 1)], 'b'),
    );

    const trigger = pressableByLabel(element, '지역 선택, 현재 Synthetic b');
    expect(trigger.props.accessibilityRole).toBe('button');
    expect(texts(element)).toContain('Synthetic b');
    expect(texts(element)).toContain('▾');
  });

  it('names the selected location, not the first saved one', async () => {
    const render = await loadComponent();

    const element = render(
      readySnapshot([savedLocationRecord('a', 0), savedLocationRecord('b', 1)], 'b'),
    );

    expect(texts(element)).not.toContain('Synthetic a');
    expect(findPressable(element, '지역 선택, 현재 Synthetic a')).toBeUndefined();
  });

  it('renders no raw id, coordinate, KMA grid, or error kind', async () => {
    const render = await loadComponent();
    const location = savedLocationRecord('secret-id-1', 0, { displayName: '중구' });

    const element = render(readySnapshot([location], 'secret-id-1'));
    const rendered = [...texts(element), ...pressableLabels(element)].join('\n');

    expect(rendered).not.toContain('secret-id-1');
    expect(rendered).not.toContain('37.5');
    expect(rendered).not.toContain('127');
    expect(rendered).not.toContain('nx');
    expect(rendered).not.toContain('STORAGE');
  });

  it('renders only the trigger before it is pressed — no sheet, no rows', async () => {
    const render = await loadComponent();

    const element = render(
      readySnapshot([savedLocationRecord('a', 0), savedLocationRecord('b', 1)], 'a'),
    );

    expect(pressableLabels(element)).toEqual(['지역 선택, 현재 Synthetic a']);
    expect(modal(element)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// C. open / close.
// ---------------------------------------------------------------------------

describe('C. open and close', () => {
  it('opens the sheet only on an explicit trigger press', async () => {
    const render = await loadComponent();
    const snapshot = readySnapshot([savedLocationRecord('a', 0)], 'a');

    expect(modal(render(snapshot))).toBeUndefined();
    press(pressableByLabel(render(snapshot), '지역 선택, 현재 Synthetic a'));

    const opened = render(snapshot);
    expect(modal(opened)).toBeDefined();
    expect(texts(opened)).toContain('지역 선택');
    expect(pressableByLabel(opened, '지역 선택, 현재 Synthetic a').props.accessibilityState).toEqual(
      { expanded: true },
    );
  });

  it('closes on the close control', async () => {
    const render = await loadComponent();
    const snapshot = readySnapshot([savedLocationRecord('a', 0)], 'a');

    press(pressableByLabel(render(snapshot), '지역 선택, 현재 Synthetic a'));
    press(pressableByLabel(render(snapshot), '지역 선택 닫기'));

    expect(modal(render(snapshot))).toBeUndefined();
  });

  it('closes on the backdrop', async () => {
    const render = await loadComponent();
    const snapshot = readySnapshot([savedLocationRecord('a', 0)], 'a');

    press(pressableByLabel(render(snapshot), '지역 선택, 현재 Synthetic a'));
    press(pressableByLabel(render(snapshot), '지역 선택 배경 닫기'));

    expect(modal(render(snapshot))).toBeUndefined();
  });

  it('closes on the Android back request via onRequestClose', async () => {
    const render = await loadComponent();
    const snapshot = readySnapshot([savedLocationRecord('a', 0)], 'a');

    press(pressableByLabel(render(snapshot), '지역 선택, 현재 Synthetic a'));
    const sheet = modal(render(snapshot));
    expect(sheet).toBeDefined();
    (sheet?.props.onRequestClose as () => void)();

    expect(modal(render(snapshot))).toBeUndefined();
  });

  it('dispatches no mutation and no navigation merely by opening and closing', async () => {
    const render = await loadComponent();
    const snapshot = readySnapshot(
      [savedLocationRecord('a', 0), savedLocationRecord('b', 1)],
      'a',
    );

    press(pressableByLabel(render(snapshot), '지역 선택, 현재 Synthetic a'));
    render(snapshot);
    press(pressableByLabel(render(snapshot), '지역 선택 닫기'));
    render(snapshot);

    expect(applicationStoreMock.select).toHaveBeenCalledTimes(0);
    expect(applicationStoreMock.remove).toHaveBeenCalledTimes(0);
    expect(routerMock.push).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// D. order.
// ---------------------------------------------------------------------------

describe('D. saved-location order', () => {
  it('renders the snapshot order exactly, without sorting, deduping, or reordering', async () => {
    const render = await loadComponent();
    // Deliberately not sorted by sortOrder or by name — the snapshot's array order is authoritative.
    const snapshot = readySnapshot(
      [
        savedLocationRecord('c', 2, { displayName: '강남구' }),
        savedLocationRecord('a', 0, { displayName: '중구' }),
        savedLocationRecord('b', 1, { displayName: '종로구' }),
      ],
      'a',
    );

    press(pressableByLabel(render(snapshot), '지역 선택, 현재 중구'));

    expect(rowNames(render(snapshot))).toEqual(['강남구', '중구', '종로구']);
  });

  it('shows a secondary administrative context without repeating the display name', async () => {
    const render = await loadComponent();
    const snapshot = readySnapshot(
      [
        savedLocationRecord('a', 0, {
          displayName: '중구',
          adminArea1: '서울특별시',
          adminArea2: '중구',
          adminArea3: null,
        }),
      ],
      'a',
    );

    press(pressableByLabel(render(snapshot), '지역 선택, 현재 중구'));
    const opened = render(snapshot);

    expect(texts(opened)).toContain('서울특별시');
    expect(texts(opened).filter((text) => text === '중구')).toHaveLength(2); // trigger + row name
    expect(texts(opened)).not.toContain('서울특별시 중구');
  });

  it('omits the context line entirely when no administrative area adds anything', async () => {
    const render = await loadComponent();
    const snapshot = readySnapshot(
      [
        savedLocationRecord('a', 0, {
          displayName: '중구',
          adminArea1: null,
          adminArea2: '중구',
          adminArea3: '   ',
        }),
      ],
      'a',
    );

    press(pressableByLabel(render(snapshot), '지역 선택, 현재 중구'));

    expect(texts(render(snapshot)).filter((text) => text === '중구')).toHaveLength(2);
    expect(texts(render(snapshot))).not.toContain('   ');
  });
});

// ---------------------------------------------------------------------------
// E. the selected row.
// ---------------------------------------------------------------------------

describe('E. selected row', () => {
  it('marks the selected row textually and through accessibility state', async () => {
    const render = await loadComponent();
    const snapshot = readySnapshot(
      [savedLocationRecord('a', 0), savedLocationRecord('b', 1)],
      'b',
    );

    press(pressableByLabel(render(snapshot), '지역 선택, 현재 Synthetic b'));
    const opened = render(snapshot);

    const selected = pressableByLabel(opened, 'Synthetic b 선택됨');
    expect(selected.props.accessibilityState).toEqual({ selected: true, disabled: true });
    expect(texts(opened)).toContain('✓');
    const unselected = pressableByLabel(opened, 'Synthetic a 선택');
    expect(unselected.props.accessibilityState).toEqual({ selected: false, disabled: false });
  });

  it('issues no redundant select mutation from the selected row', async () => {
    const render = await loadComponent();
    const snapshot = readySnapshot(
      [savedLocationRecord('a', 0), savedLocationRecord('b', 1)],
      'b',
    );

    press(pressableByLabel(render(snapshot), '지역 선택, 현재 Synthetic b'));
    const selected = pressableByLabel(render(snapshot), 'Synthetic b 선택됨');
    expect(selected.props.disabled).toBe(true);
    press(selected);
    await flush();

    expect(applicationStoreMock.select).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// F. select.
// ---------------------------------------------------------------------------

describe('F. select', () => {
  it('calls select exactly once with the pressed location id and closes the sheet on success', async () => {
    const render = await loadComponent();
    const snapshot = readySnapshot(
      [savedLocationRecord('a', 0), savedLocationRecord('b', 1), savedLocationRecord('c', 2)],
      'a',
    );

    press(pressableByLabel(render(snapshot), '지역 선택, 현재 Synthetic a'));
    press(pressableByLabel(render(snapshot), 'Synthetic c 선택'));
    await flush();

    expect(applicationStoreMock.select).toHaveBeenCalledTimes(1);
    expect(applicationStoreMock.select).toHaveBeenCalledWith('c');
    expect(applicationStoreMock.remove).toHaveBeenCalledTimes(0);
    expect(modal(render(snapshot))).toBeUndefined();
  });

  it('passes the pressed id, never the currently selected one', async () => {
    const render = await loadComponent();
    const snapshot = readySnapshot(
      [savedLocationRecord('a', 0), savedLocationRecord('b', 1)],
      'a',
    );

    press(pressableByLabel(render(snapshot), '지역 선택, 현재 Synthetic a'));
    press(pressableByLabel(render(snapshot), 'Synthetic b 선택'));
    await flush();

    expect(applicationStoreMock.select.mock.calls).toEqual([['b']]);
  });

  it('navigates nowhere and touches no other store method when selecting', async () => {
    const render = await loadComponent();
    const snapshot = readySnapshot(
      [savedLocationRecord('a', 0), savedLocationRecord('b', 1)],
      'a',
    );

    press(pressableByLabel(render(snapshot), '지역 선택, 현재 Synthetic a'));
    press(pressableByLabel(render(snapshot), 'Synthetic b 선택'));
    await flush();

    expect(routerMock.push).toHaveBeenCalledTimes(0);
    expect(Object.keys(applicationStoreMock)).toEqual(['select', 'remove']);
  });
});

// ---------------------------------------------------------------------------
// G. select failure.
// ---------------------------------------------------------------------------

describe('G. select failure', () => {
  it('keeps the sheet open and usable, showing only generic copy', async () => {
    applicationStoreMock.select.mockResolvedValue(failed('STORAGE_WRITE_FAILED'));
    const render = await loadComponent();
    const snapshot = readySnapshot(
      [savedLocationRecord('a', 0), savedLocationRecord('b', 1)],
      'a',
    );

    press(pressableByLabel(render(snapshot), '지역 선택, 현재 Synthetic a'));
    press(pressableByLabel(render(snapshot), 'Synthetic b 선택'));
    await flush();

    const element = render(snapshot);
    const rendered = [...texts(element), ...pressableLabels(element)].join('\n');
    expect(modal(element)).toBeDefined();
    expect(rendered).toContain('지역을 변경하지 못했습니다.');
    expect(rendered).not.toContain('STORAGE_WRITE_FAILED');
    expect(pressableByLabel(element, 'Synthetic b 선택').props.disabled).toBe(false);
  });

  it('does not retry the failed select automatically', async () => {
    applicationStoreMock.select.mockResolvedValue(failed('STORAGE_WRITE_FAILED'));
    const render = await loadComponent();
    const snapshot = readySnapshot(
      [savedLocationRecord('a', 0), savedLocationRecord('b', 1)],
      'a',
    );

    press(pressableByLabel(render(snapshot), '지역 선택, 현재 Synthetic a'));
    press(pressableByLabel(render(snapshot), 'Synthetic b 선택'));
    await flush();
    render(snapshot);
    await flush();

    expect(applicationStoreMock.select).toHaveBeenCalledTimes(1);
  });

  it('clears the previous failure message on the next dispatch', async () => {
    applicationStoreMock.select
      .mockResolvedValueOnce(failed('STORAGE_WRITE_FAILED'))
      .mockResolvedValueOnce(ok());
    const render = await loadComponent();
    const snapshot = readySnapshot(
      [savedLocationRecord('a', 0), savedLocationRecord('b', 1)],
      'a',
    );

    press(pressableByLabel(render(snapshot), '지역 선택, 현재 Synthetic a'));
    press(pressableByLabel(render(snapshot), 'Synthetic b 선택'));
    await flush();
    expect(texts(render(snapshot))).toContain('지역을 변경하지 못했습니다.');

    press(pressableByLabel(render(snapshot), 'Synthetic b 선택'));
    await flush();

    expect(texts(render(snapshot))).not.toContain('지역을 변경하지 못했습니다.');
  });
});

// ---------------------------------------------------------------------------
// H. delete.
// ---------------------------------------------------------------------------

describe('H. delete', () => {
  it('calls remove exactly once with the pressed id and never selects a fallback itself', async () => {
    const render = await loadComponent();
    const snapshot = readySnapshot(
      [savedLocationRecord('a', 0), savedLocationRecord('b', 1)],
      'a',
    );

    press(pressableByLabel(render(snapshot), '지역 선택, 현재 Synthetic a'));
    press(pressableByLabel(render(snapshot), 'Synthetic a 삭제'));
    await flush();

    expect(applicationStoreMock.remove).toHaveBeenCalledTimes(1);
    expect(applicationStoreMock.remove).toHaveBeenCalledWith('a');
    expect(applicationStoreMock.select).toHaveBeenCalledTimes(0);
  });

  it('keeps the sheet open after a successful removal', async () => {
    const render = await loadComponent();
    const before = readySnapshot(
      [savedLocationRecord('a', 0), savedLocationRecord('b', 1)],
      'a',
    );

    press(pressableByLabel(render(before), '지역 선택, 현재 Synthetic a'));
    press(pressableByLabel(render(before), 'Synthetic b 삭제'));
    await flush();

    // The store publishes the next snapshot; the component simply renders it.
    const after = readySnapshot([savedLocationRecord('a', 0)], 'a');
    const element = render(after);
    expect(modal(element)).toBeDefined();
    expect(rowNames(element)).toEqual(['Synthetic a']);
  });

  it('shows only generic copy when the removal fails', async () => {
    applicationStoreMock.remove.mockResolvedValue(failed('STORAGE_WRITE_FAILED'));
    const render = await loadComponent();
    const snapshot = readySnapshot(
      [savedLocationRecord('a', 0), savedLocationRecord('b', 1)],
      'a',
    );

    press(pressableByLabel(render(snapshot), '지역 선택, 현재 Synthetic a'));
    press(pressableByLabel(render(snapshot), 'Synthetic b 삭제'));
    await flush();

    const element = render(snapshot);
    const rendered = [...texts(element), ...pressableLabels(element)].join('\n');
    expect(rendered).toContain('지역을 삭제하지 못했습니다.');
    expect(rendered).not.toContain('STORAGE_WRITE_FAILED');
    expect(rendered).not.toContain('지역을 변경하지 못했습니다.');
    expect(modal(element)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// I. SAVING.
// ---------------------------------------------------------------------------

describe('I. SAVING', () => {
  it('disables every mutation control while a write is in flight', async () => {
    const render = await loadComponent();
    const idle = readySnapshot([savedLocationRecord('a', 0), savedLocationRecord('b', 1)], 'a');

    press(pressableByLabel(render(idle), '지역 선택, 현재 Synthetic a'));
    const saving = readySnapshot(
      [savedLocationRecord('a', 0), savedLocationRecord('b', 1)],
      'a',
      'SAVING',
    );
    const element = render(saving);

    expect(pressableByLabel(element, 'Synthetic b 선택').props.disabled).toBe(true);
    expect(pressableByLabel(element, 'Synthetic a 선택됨').props.disabled).toBe(true);
    expect(pressableByLabel(element, 'Synthetic a 삭제').props.disabled).toBe(true);
    expect(pressableByLabel(element, 'Synthetic b 삭제').props.disabled).toBe(true);
    expect(pressableByLabel(element, '지역 추가').props.disabled).toBe(true);
    expect(elementsOfType(element, MockActivityIndicator)).toHaveLength(1);
  });

  it('still allows closing the sheet while saving', async () => {
    const render = await loadComponent();
    const idle = readySnapshot([savedLocationRecord('a', 0)], 'a');

    press(pressableByLabel(render(idle), '지역 선택, 현재 Synthetic a'));
    const saving = readySnapshot([savedLocationRecord('a', 0)], 'a', 'SAVING');
    expect(pressableByLabel(render(saving), '지역 선택 닫기').props.disabled).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// J. add.
// ---------------------------------------------------------------------------

describe('J. add location', () => {
  it('closes the sheet and pushes /locations exactly once', async () => {
    const render = await loadComponent();
    const snapshot = readySnapshot([savedLocationRecord('a', 0)], 'a');

    press(pressableByLabel(render(snapshot), '지역 선택, 현재 Synthetic a'));
    expect(texts(render(snapshot))).toContain('+ 지역 추가');
    press(pressableByLabel(render(snapshot), '지역 추가'));

    expect(routerMock.push).toHaveBeenCalledTimes(1);
    expect(routerMock.push).toHaveBeenCalledWith('/locations');
    expect(modal(render(snapshot))).toBeUndefined();
  });

  it('adds nothing itself — no add mutation exists on the surface it dispatches against', async () => {
    const render = await loadComponent();
    const snapshot = readySnapshot([savedLocationRecord('a', 0)], 'a');

    press(pressableByLabel(render(snapshot), '지역 선택, 현재 Synthetic a'));
    press(pressableByLabel(render(snapshot), '지역 추가'));
    await flush();

    expect('add' in applicationStoreMock).toBe(false);
    expect(applicationStoreMock.select).toHaveBeenCalledTimes(0);
    expect(applicationStoreMock.remove).toHaveBeenCalledTimes(0);
  });
});
