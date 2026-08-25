import type { WeatherSuccessResponseV1 } from '@life-weather/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { noSelectionSuccessResponseBody, successResponseBody } from '../weather-api/fixtures';

// ---------------------------------------------------------------------------
// The native AsyncStorage module is replaced with an in-memory, call-recording mock so the real
// persistence / hydration / application-store / hook code runs unmodified against it. Both the
// saved-location and selected-location stable keys share this one mock, so tests that need a
// specific saved-location envelope route by key via `mockImplementation`.
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
// can be invoked as a plain function (no renderer is available in this Node-based setup). Only
// React's scheduling is faked — the screen's own logic and every boundary beneath it run for real.
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
// `react-native` ships Flow syntax this Vitest/Rolldown setup cannot parse, so it is replaced with
// minimal marker components and a `StyleSheet.create` passthrough. `ScrollView` and
// `ActivityIndicator` are added here (beyond the prior debug layout's primitives) because the
// redesigned screen is a scrollable, loading-indicator-bearing layout.
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

vi.mock('react-native', () => ({
  View: MockView,
  Text: MockText,
  Pressable: MockPressable,
  ScrollView: MockScrollView,
  ActivityIndicator: MockActivityIndicator,
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));

// ---------------------------------------------------------------------------
// `expo-router`'s `useRouter` is replaced with a fake returning call-recording `push`/`back`
// mocks, so navigation can be asserted without a real navigation container.
// ---------------------------------------------------------------------------

const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
  back: vi.fn(),
}));

vi.mock('expo-router', () => ({
  useRouter: () => routerMock,
}));

// ---------------------------------------------------------------------------
// The weather-query React hook is replaced with a call-recording mock so `HomeScreen` can be
// invoked as a plain function without ever running the hook's real `useEffect` (there is no real
// renderer/dispatcher in this Node-based setup). The production weather-query store is replaced
// too, so a screen `다시 시도` press can be asserted against a bare `retry` spy without importing
// the real client/env wiring. Neither replacement re-implements or re-tests the hook/store
// themselves — both are covered by their own dedicated test files.
// ---------------------------------------------------------------------------

const useMobileWeatherQueryMock = vi.hoisted(() => vi.fn());

vi.mock('../weather-query/use-mobile-weather-query', () => ({
  useMobileWeatherQuery: useMobileWeatherQueryMock,
}));

const mobileWeatherQueryStoreMock = vi.hoisted(() => ({
  retry: vi.fn(),
}));

vi.mock('../weather-query/mobile-weather-query-production', () => ({
  mobileWeatherQueryStore: mobileWeatherQueryStoreMock,
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

let SAVED_KEY = '';
let SELECTED_KEY = '';

/** Route `getItem` by stable key: the saved-location envelope on its key, else `null`. */
function mockStoredEnvelope(...ids: string[]): void {
  const value = JSON.stringify({
    version: 1,
    locations: ids.map((id, index) => storedRecord(id, index)),
  });
  asyncStorageMock.getItem.mockImplementation(async (key: string) =>
    key === SAVED_KEY ? value : null,
  );
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
  const { default: HomeScreen } = await import('../app/(tabs)/index');
  return function render() {
    hookCursor = 0;
    return HomeScreen();
  };
}

/** Drive both saved-location hydration and selected-location initialization to completion. */
async function hydrateAndInitialize(): Promise<void> {
  const { mobileSavedLocationHydrationStore } = await import(
    '../locations/mobile-saved-location-hydration-production'
  );
  const { mobileSavedLocationApplicationStore } = await import(
    '../locations/mobile-saved-location-application-production'
  );
  await mobileSavedLocationHydrationStore.hydrate();
  await mobileSavedLocationApplicationStore.initializeSelectedLocation();
}

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  hookSlots = [];
  hookCursor = 0;
  const persistenceModule = await import('../locations');
  SAVED_KEY = persistenceModule.SAVED_LOCATION_PERSISTENCE_KEY;
  SELECTED_KEY = persistenceModule.SELECTED_LOCATION_PERSISTENCE_KEY;
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
  useMobileWeatherQueryMock.mockReturnValue({ status: 'IDLE' });
  mobileWeatherQueryStoreMock.retry.mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// header — the screen owns its own product header now that the Tabs header is suppressed for
// this route (see `../app/(tabs)/_layout`).
// ---------------------------------------------------------------------------

describe('header', () => {
  it('renders its own "오늘" title regardless of saved-location state', async () => {
    const render = await loadScreen();

    expect(texts(render())).toContain('오늘');
  });
});

// ---------------------------------------------------------------------------
// A. saved-location states
// ---------------------------------------------------------------------------

describe('saved-location states', () => {
  it('renders the not-started loading card with no controls and no storage I/O', async () => {
    const render = await loadScreen();

    const element = render();

    expect(texts(element)).toContain('저장된 지역을 불러오는 중입니다.');
    expect(pressables(element)).toHaveLength(0);
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(0);
  });

  it('renders the selection-loading card after saved hydration but before selection resolves', async () => {
    let resolveSelected: (value: string | null) => void = () => {};
    asyncStorageMock.getItem.mockImplementation(async (key: string) => {
      if (key === SELECTED_KEY) {
        return new Promise((resolve) => {
          resolveSelected = resolve;
        });
      }
      return null;
    });

    const render = await loadScreen();
    const { mobileSavedLocationHydrationStore } = await import(
      '../locations/mobile-saved-location-hydration-production'
    );
    const { mobileSavedLocationApplicationStore } = await import(
      '../locations/mobile-saved-location-application-production'
    );

    await mobileSavedLocationHydrationStore.hydrate();
    const initializing = mobileSavedLocationApplicationStore.initializeSelectedLocation();

    expect(texts(render())).toContain('선택 지역을 준비하는 중입니다.');
    expect(pressables(render())).toHaveLength(0);

    resolveSelected(null);
    await initializing;
  });

  it('renders a welcoming empty state with only the "지역 추가" CTA', async () => {
    const render = await loadScreen();

    await hydrateAndInitialize();
    const element = render();

    expect(texts(element)).toContain('저장된 지역이 없습니다.');
    expect(pressables(element).map((pressable) => pressable.props.accessibilityLabel)).toEqual([
      '지역 추가',
    ]);
    expect(pressables(element)[0]?.props.disabled).toBe(false);
  });

  it('shows the selected saved location in the header and every row with its controls when READY', async () => {
    mockStoredEnvelope('a', 'b', 'c');
    const render = await loadScreen();

    await hydrateAndInitialize();
    const element = render();

    // 'a' is sortOrder 0, so it resolves as the fallback selection.
    expect(texts(element)).toContain('Synthetic a');
    expect(texts(element)).toContain('저장 지역');
    expect(texts(element)).toEqual(
      expect.arrayContaining(['Synthetic a', 'Synthetic b', 'Synthetic c', '지역 추가']),
    );
    expect(pressableByLabel(element, 'Synthetic a 선택됨').props.disabled).toBe(true);
    expect(pressableByLabel(element, 'Synthetic b 선택').props.disabled).toBe(false);
    expect(pressableByLabel(element, 'Synthetic c 선택').props.disabled).toBe(false);
    expect(pressableByLabel(element, 'Synthetic a 삭제')).toBeDefined();
  });

  it('renders the error card with a retry control and no raw error detail', async () => {
    asyncStorageMock.getItem.mockRejectedValue(new Error('synthetic storage failure'));
    const render = await loadScreen();
    const { mobileSavedLocationHydrationStore } = await import(
      '../locations/mobile-saved-location-hydration-production'
    );

    await mobileSavedLocationHydrationStore.hydrate();
    const element = render();
    const rendered = texts(element).join('\n');

    expect(texts(element)).toContain('저장된 지역을 불러오지 못했습니다.');
    expect(pressableByLabel(element, '저장 지역 다시 불러오기')).toBeDefined();
    expect(rendered).not.toContain('STORAGE_READ_FAILED');
    expect(rendered).not.toContain('SAVED_LOCATIONS');
    expect(rendered).not.toContain('synthetic storage failure');
  });

  it('does not hydrate, retry, select, or mutate merely by rendering', async () => {
    const render = await loadScreen();
    const { mobileSavedLocationApplicationStore } = await import(
      '../locations/mobile-saved-location-application-production'
    );
    const retrySpy = vi.spyOn(mobileSavedLocationApplicationStore, 'retryInitialization');
    const selectSpy = vi.spyOn(mobileSavedLocationApplicationStore, 'select');
    const removeSpy = vi.spyOn(mobileSavedLocationApplicationStore, 'remove');
    const addSpy = vi.spyOn(mobileSavedLocationApplicationStore, 'add');

    render();
    render();
    render();

    expect(retrySpy).toHaveBeenCalledTimes(0);
    expect(selectSpy).toHaveBeenCalledTimes(0);
    expect(removeSpy).toHaveBeenCalledTimes(0);
    expect(addSpy).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.removeItem).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// "지역 추가" entry point.
// ---------------------------------------------------------------------------

describe('"지역 추가" entry point', () => {
  it('navigates to /locations when pressed from EMPTY', async () => {
    const render = await loadScreen();

    await hydrateAndInitialize();
    press(pressableByLabel(render(), '지역 추가'));

    expect(routerMock.push).toHaveBeenCalledTimes(1);
    expect(routerMock.push).toHaveBeenCalledWith('/locations');
    expect(routerMock.back).toHaveBeenCalledTimes(0);
  });

  it('navigates to /locations when pressed from the READY 저장 지역 card', async () => {
    mockStoredEnvelope('a');
    const render = await loadScreen();

    await hydrateAndInitialize();
    press(pressableByLabel(render(), '지역 추가'));

    expect(routerMock.push).toHaveBeenCalledWith('/locations');
  });

  it('does not appear outside EMPTY/READY', async () => {
    asyncStorageMock.getItem.mockRejectedValue(new Error('synthetic storage failure'));
    const render = await loadScreen();

    expect(() => pressableByLabel(render(), '지역 추가')).toThrow();

    const { mobileSavedLocationHydrationStore } = await import(
      '../locations/mobile-saved-location-hydration-production'
    );
    await mobileSavedLocationHydrationStore.hydrate();
    expect(() => pressableByLabel(render(), '지역 추가')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// retry — routed through retryInitialization().
// ---------------------------------------------------------------------------

describe('saved-location retry', () => {
  it('re-reads storage once and reflects the recovered state', async () => {
    let savedLocationAttempt = 0;
    asyncStorageMock.getItem.mockImplementation(async (key: string) => {
      if (key !== SAVED_KEY) {
        return null;
      }
      savedLocationAttempt += 1;
      if (savedLocationAttempt === 1) {
        throw new Error('synthetic storage failure');
      }
      return JSON.stringify({ version: 1, locations: [storedRecord('a', 0)] });
    });

    const render = await loadScreen();
    const { mobileSavedLocationHydrationStore } = await import(
      '../locations/mobile-saved-location-hydration-production'
    );
    const { mobileSavedLocationApplicationStore } = await import(
      '../locations/mobile-saved-location-application-production'
    );

    await mobileSavedLocationHydrationStore.hydrate();
    expect(texts(render())).toContain('저장된 지역을 불러오지 못했습니다.');

    press(pressableByLabel(render(), '저장 지역 다시 불러오기'));
    await flush();
    await mobileSavedLocationApplicationStore.initializeSelectedLocation();

    expect(texts(render())).toContain('Synthetic a');
    expect(pressableByLabel(render(), 'Synthetic a 선택됨')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// selecting a saved location.
// ---------------------------------------------------------------------------

describe('select', () => {
  it('persists the selection and moves the "선택됨" indicator', async () => {
    mockStoredEnvelope('a', 'b');
    const render = await loadScreen();

    await hydrateAndInitialize();
    press(pressableByLabel(render(), 'Synthetic b 선택'));
    await flush();

    const element = render();
    expect(pressableByLabel(element, 'Synthetic b 선택됨').props.disabled).toBe(true);
    expect(pressableByLabel(element, 'Synthetic a 선택').props.disabled).toBe(false);
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(1);
    const [key, value] = asyncStorageMock.setItem.mock.calls[0] as [string, string];
    expect(key).toBe(SELECTED_KEY);
    expect(JSON.parse(value)).toEqual({ version: 1, selectedLocationId: 'b' });
  });

  it('disables every select and delete control while a write is in flight', async () => {
    mockStoredEnvelope('a', 'b');
    let resolveSetItem: () => void = () => {};
    asyncStorageMock.setItem.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSetItem = () => resolve();
        }),
    );

    const render = await loadScreen();
    await hydrateAndInitialize();
    press(pressableByLabel(render(), 'Synthetic b 선택'));

    const during = render();
    const savedLocationButtons = pressables(during).filter((pressable) =>
      ['Synthetic a 선택', 'Synthetic b 선택됨', 'Synthetic a 삭제', 'Synthetic b 삭제'].includes(
        pressable.props.accessibilityLabel as string,
      ),
    );
    expect(savedLocationButtons.length).toBeGreaterThan(0);
    expect(savedLocationButtons.every((pressable) => pressable.props.disabled === true)).toBe(true);

    resolveSetItem();
    await flush();
  });

  it('shows generic copy when the selection write fails and keeps the prior selection', async () => {
    mockStoredEnvelope('a', 'b');
    asyncStorageMock.setItem.mockRejectedValue(new Error('synthetic native write failure'));

    const render = await loadScreen();
    await hydrateAndInitialize();
    press(pressableByLabel(render(), 'Synthetic b 선택'));
    await flush();

    const element = render();
    const rendered = texts(element).join('\n');
    expect(rendered).toContain('저장 지역 변경을 저장하지 못했습니다.');
    expect(rendered).not.toContain('STORAGE_WRITE_FAILED');
    expect(rendered).not.toContain('synthetic native write failure');
    expect(pressableByLabel(element, 'Synthetic a 선택됨')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// deleting a saved location.
// ---------------------------------------------------------------------------

describe('delete', () => {
  it('persists the removal and re-renders the real remaining collection', async () => {
    mockStoredEnvelope('a', 'b', 'c');
    const render = await loadScreen();

    await hydrateAndInitialize();
    press(pressableByLabel(render(), 'Synthetic b 삭제'));
    await flush();

    const element = render();
    expect(texts(element)).toEqual(
      expect.arrayContaining(['Synthetic a', 'Synthetic c']),
    );
    expect(texts(element)).not.toContain('Synthetic b');
  });

  it('moves the selected indicator to the documented fallback when the selected location is deleted', async () => {
    mockStoredEnvelope('a', 'b', 'c');
    const render = await loadScreen();

    await hydrateAndInitialize();
    // 'a' is selected by fallback; deleting it should move selection to 'b' (same post-delete index).
    press(pressableByLabel(render(), 'Synthetic a 삭제'));
    await flush();

    const element = render();
    expect(pressableByLabel(element, 'Synthetic b 선택됨')).toBeDefined();
    expect(pressableByLabel(element, 'Synthetic c 선택').props.disabled).toBe(false);
  });

  it('shows the empty state (with only "지역 추가") after the last saved location is deleted, without removeItem', async () => {
    mockStoredEnvelope('a');
    const render = await loadScreen();

    await hydrateAndInitialize();
    press(pressableByLabel(render(), 'Synthetic a 삭제'));
    await flush();

    const element = render();
    expect(texts(element)).toContain('저장된 지역이 없습니다.');
    expect(pressables(element).map((pressable) => pressable.props.accessibilityLabel)).toEqual([
      '지역 추가',
    ]);
    expect(asyncStorageMock.removeItem).toHaveBeenCalledTimes(0);
  });

  it('shows generic copy when the write fails and keeps the collection unchanged', async () => {
    mockStoredEnvelope('a', 'b');
    asyncStorageMock.setItem.mockRejectedValue(new Error('synthetic native write failure'));

    const render = await loadScreen();
    await hydrateAndInitialize();
    press(pressableByLabel(render(), 'Synthetic b 삭제'));
    await flush();

    const element = render();
    const rendered = texts(element).join('\n');

    expect(rendered).toContain('저장 지역 변경을 저장하지 못했습니다.');
    expect(rendered).not.toContain('STORAGE_WRITE_FAILED');
    expect(rendered).not.toContain('synthetic native write failure');
    expect(rendered).not.toContain(SAVED_KEY);
    expect(rendered).not.toContain('37.5');
    expect(rendered).not.toContain('127');
  });

  it('does not use isCurrent as the selected indicator', async () => {
    // A GPS-current record that is not the resolved selectedLocationId must not show "선택됨".
    const currentButNotSelected = { ...storedRecord('a', 0), isCurrent: true };
    const selected = storedRecord('b', 1);
    asyncStorageMock.getItem.mockImplementation(async (key: string) =>
      key === SAVED_KEY
        ? JSON.stringify({ version: 1, locations: [currentButNotSelected, selected] })
        : key === SELECTED_KEY
          ? JSON.stringify({ version: 1, selectedLocationId: 'b' })
          : null,
    );

    const render = await loadScreen();
    await hydrateAndInitialize();
    const element = render();

    expect(pressableByLabel(element, 'Synthetic a 선택').props.disabled).toBe(false);
    expect(pressableByLabel(element, 'Synthetic b 선택됨')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// B/C. weather hero — `useMobileWeatherQuery` and the production weather-query store's `retry`
// are mocked (see the top-level `vi.mock` calls); this screen owns only the presentation of
// whatever snapshot the (separately tested) hook returns, never the hook's own request/reset
// lifecycle.
// ---------------------------------------------------------------------------

/** A synthetic, contract-valid `current` block with every optional field populated. */
function syntheticCurrent(overrides: Partial<WeatherSuccessResponseV1['data']['current']> = {}) {
  return {
    observedAt: '2026-07-15T11:00:00Z',
    condition: 'CLEAR' as const,
    temperatureCelsius: 24,
    feelsLikeCelsius: 26,
    humidityPercent: 60,
    windSpeedMetersPerSecond: 3.2,
    windDirectionDegrees: 180,
    precipitationLastHourMillimeters: 0,
    visibilityMeters: 8000,
    ...overrides,
  };
}

/** A synthetic, contract-valid current-air-quality block. */
function syntheticAirQuality(
  overrides: Partial<NonNullable<WeatherSuccessResponseV1['data']['airQuality']['current']>> = {},
) {
  return {
    measuredAt: '2026-07-15T11:00:00Z',
    pm10MicrogramsPerCubicMeter: 30,
    pm25MicrogramsPerCubicMeter: 15,
    ozonePartsPerMillion: 0.02,
    comprehensiveAirQualityIndex: 55,
    overallGrade: 'MODERATE' as const,
    pm10Grade: 'MODERATE' as const,
    pm25Grade: 'GOOD' as const,
    ozoneGrade: 'GOOD' as const,
    ...overrides,
  };
}

function successSnapshot(
  overrides: {
    current?: WeatherSuccessResponseV1['data']['current'];
    airQualityCurrent?: WeatherSuccessResponseV1['data']['airQuality']['current'];
    hourly?: WeatherSuccessResponseV1['data']['hourly'];
  } = {},
): { readonly status: 'SUCCESS'; readonly locationId: string; readonly data: WeatherSuccessResponseV1 } {
  const base = successResponseBody();
  const current = overrides.current !== undefined ? overrides.current : base.data.current;
  const airQualityCurrent =
    overrides.airQualityCurrent !== undefined ? overrides.airQualityCurrent : base.data.airQuality.current;
  const hourly = overrides.hourly !== undefined ? overrides.hourly : base.data.hourly;
  const missingSections = base.data.missingSections.filter((section) => {
    if (section === 'CURRENT') return current !== null;
    if (section === 'AIR_QUALITY_CURRENT') return airQualityCurrent !== null;
    if (section === 'HOURLY') return hourly.length !== 0;
    return true;
  });
  return {
    status: 'SUCCESS',
    locationId: 'a',
    data: {
      ...base,
      data: {
        ...base.data,
        current,
        hourly,
        airQuality: { current: airQualityCurrent, daily: base.data.airQuality.daily },
        missingSections,
      },
    },
  };
}

describe('weather hero', () => {
  it('renders a loading state while the weather query is LOADING', async () => {
    mockStoredEnvelope('a');
    useMobileWeatherQueryMock.mockReturnValue({ status: 'LOADING', locationId: 'a' });

    const render = await loadScreen();
    await hydrateAndInitialize();
    const element = render();

    expect(texts(element)).toContain('날씨 정보를 불러오는 중입니다.');
  });

  it('renders temperature, condition, feels-like, humidity, and wind speed on SUCCESS with current', async () => {
    mockStoredEnvelope('a');
    useMobileWeatherQueryMock.mockReturnValue(successSnapshot({ current: syntheticCurrent() }));

    const render = await loadScreen();
    await hydrateAndInitialize();
    const element = render();

    expect(texts(element)).toEqual(
      expect.arrayContaining(['24°', '맑음', '체감 26°C', '습도 60%', '풍속 3.2m/s']),
    );
  });

  it('does not fabricate a current temperature and shows the unavailable message when current is null', async () => {
    mockStoredEnvelope('a');
    const snapshot = successSnapshot({ current: null });
    expect(snapshot.data.data.current).toBeNull();
    useMobileWeatherQueryMock.mockReturnValue(snapshot);

    const render = await loadScreen();
    await hydrateAndInitialize();
    const element = render();

    expect(texts(element)).toContain('현재 관측 정보를 확인할 수 없습니다.');
    // The hero must not show a fabricated current reading — but the (separately validated) hourly
    // preview may still legitimately show its own real temperatures.
    expect(texts(element)).not.toContain('맑음');
    expect(texts(element)).not.toContain('체감 26°C');
    expect(texts(element)).not.toContain('습도 60%');
  });

  it('still renders the hourly preview when current is missing but hourly is present', async () => {
    mockStoredEnvelope('a');
    const snapshot = successSnapshot({ current: null });

    const render = await loadScreen();
    useMobileWeatherQueryMock.mockReturnValue(snapshot);
    await hydrateAndInitialize();
    const element = render();

    expect(texts(element)).toContain('시간별');
    expect(texts(element)).not.toContain('표시할 시간별 예보가 없습니다.');
  });

  it('omits feels-like/humidity/wind lines that are null without fabricating values', async () => {
    mockStoredEnvelope('a');
    useMobileWeatherQueryMock.mockReturnValue(
      successSnapshot({
        current: syntheticCurrent({
          feelsLikeCelsius: null,
          humidityPercent: null,
          windSpeedMetersPerSecond: null,
        }),
      }),
    );

    const render = await loadScreen();
    await hydrateAndInitialize();
    const rendered = texts(render()).join('\n');

    expect(rendered).not.toContain('체감');
    expect(rendered).not.toContain('습도');
    expect(rendered).not.toContain('풍속');
  });

  it.each([
    ['CLEAR', '맑음'],
    ['UNKNOWN', '상태 미확인'],
  ] as const)('maps the %s condition to "%s"', async (condition, label) => {
    mockStoredEnvelope('a');
    useMobileWeatherQueryMock.mockReturnValue(
      successSnapshot({ current: syntheticCurrent({ condition }) }),
    );

    const render = await loadScreen();
    await hydrateAndInitialize();

    expect(texts(render())).toContain(label);
  });

  it('shows a grade-only pill when overallGrade is present and CAI is absent', async () => {
    mockStoredEnvelope('a');
    useMobileWeatherQueryMock.mockReturnValue(
      successSnapshot({
        current: syntheticCurrent(),
        airQualityCurrent: syntheticAirQuality({
          overallGrade: 'GOOD',
          comprehensiveAirQualityIndex: null,
        }),
      }),
    );

    const render = await loadScreen();
    await hydrateAndInitialize();

    expect(texts(render())).toContain('대기질 좋음');
  });

  it('shows a CAI-only pill when overallGrade is null, without fabricating a grade', async () => {
    mockStoredEnvelope('a');
    useMobileWeatherQueryMock.mockReturnValue(
      successSnapshot({
        current: syntheticCurrent(),
        airQualityCurrent: syntheticAirQuality({
          overallGrade: null,
          comprehensiveAirQualityIndex: 77,
        }),
      }),
    );

    const render = await loadScreen();
    await hydrateAndInitialize();
    const rendered = texts(render()).join('\n');

    expect(rendered).toContain('대기질 CAI 77');
    expect(rendered).not.toContain('좋음');
    expect(rendered).not.toContain('보통');
    expect(rendered).not.toContain('나쁨');
  });

  it('shows a combined grade-and-CAI pill when both are present', async () => {
    mockStoredEnvelope('a');
    useMobileWeatherQueryMock.mockReturnValue(
      successSnapshot({
        current: syntheticCurrent(),
        airQualityCurrent: syntheticAirQuality({
          overallGrade: 'MODERATE',
          comprehensiveAirQualityIndex: 47,
        }),
      }),
    );

    const render = await loadScreen();
    await hydrateAndInitialize();

    expect(texts(render())).toContain('대기질 보통 · CAI 47');
  });

  it('shows no air-quality pill when current air quality is absent', async () => {
    mockStoredEnvelope('a');
    useMobileWeatherQueryMock.mockReturnValue(
      successSnapshot({ current: syntheticCurrent(), airQualityCurrent: null }),
    );

    const render = await loadScreen();
    await hydrateAndInitialize();
    const rendered = texts(render()).join('\n');

    expect(rendered).not.toContain('대기질');
    expect(rendered).not.toContain('CAI');
  });

  it.each([
    ['CONFIGURATION', '날씨 서비스를 준비하지 못했습니다.'],
    ['NETWORK', '날씨 정보를 불러오지 못했습니다. 네트워크 연결을 확인해 주세요.'],
    ['API', '날씨 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'],
    ['INVALID_RESPONSE', '날씨 정보를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.'],
  ] as const)('shows the fixed %s copy with a retry control and no raw detail', async (presentation, copy) => {
    mockStoredEnvelope('a');
    useMobileWeatherQueryMock.mockReturnValue({ status: 'ERROR', locationId: 'a', presentation });

    const render = await loadScreen();
    await hydrateAndInitialize();
    const element = render();
    const rendered = texts(element).join('\n');

    expect(rendered).toContain(copy);
    expect(pressableByLabel(element, '날씨 다시 시도')).toBeDefined();
    expect(rendered).not.toContain(presentation);
  });

  it('calls the production store\'s retry exactly once per press and keeps saved-location management usable', async () => {
    mockStoredEnvelope('a', 'b');
    useMobileWeatherQueryMock.mockReturnValue({
      status: 'ERROR',
      locationId: 'a',
      presentation: 'NETWORK',
    });

    const render = await loadScreen();
    await hydrateAndInitialize();
    let element = render();
    press(pressableByLabel(element, '날씨 다시 시도'));

    expect(mobileWeatherQueryStoreMock.retry).toHaveBeenCalledTimes(1);

    // Saved-location controls remain reachable despite the weather error.
    element = render();
    expect(pressableByLabel(element, 'Synthetic b 선택').props.disabled).toBe(false);
    expect(pressableByLabel(element, 'Synthetic a 삭제')).toBeDefined();
  });

  it('does not render weather content outside READY, even if the query mock reports SUCCESS', async () => {
    useMobileWeatherQueryMock.mockReturnValue(successSnapshot({ current: syntheticCurrent() }));

    const render = await loadScreen();
    const element = render();

    expect(texts(element)).not.toContain('24°');
    expect(texts(element)).not.toContain('맑음');
  });
});

// ---------------------------------------------------------------------------
// D. lifestyle at-a-glance.
// ---------------------------------------------------------------------------

describe('lifestyle at-a-glance', () => {
  it('renders exactly the four existing lifestyle cards on SUCCESS', async () => {
    mockStoredEnvelope('a');
    useMobileWeatherQueryMock.mockReturnValue(successSnapshot({ current: syntheticCurrent() }));

    const render = await loadScreen();
    await hydrateAndInitialize();
    const element = render();

    expect(texts(element)).toContain('생활 한눈에');
    expect(texts(element)).toEqual(
      expect.arrayContaining(['우산', '옷차림', '마스크', '빨래']),
    );
  });

  it('renders each card\'s recommendation, and its reason only when it happens to equal the recommendation', async () => {
    mockStoredEnvelope('a');
    const snapshot = successSnapshot({ current: syntheticCurrent() });
    useMobileWeatherQueryMock.mockReturnValue(snapshot);

    const render = await loadScreen();
    await hydrateAndInitialize();
    const rendered = texts(render());

    const { createMobileLifestyleOverview } = await import(
      '../lifestyle/create-mobile-lifestyle-overview'
    );
    const cards = createMobileLifestyleOverview(snapshot.data);
    expect(cards.some((card) => card.reason !== card.recommendation)).toBe(true);

    for (const card of cards) {
      expect(rendered).toContain(card.recommendation);
      if (card.reason !== card.recommendation) {
        expect(rendered).not.toContain(card.reason);
      }
    }
  });

  it('does not fabricate a fifth lifestyle policy', async () => {
    mockStoredEnvelope('a');
    useMobileWeatherQueryMock.mockReturnValue(successSnapshot({ current: syntheticCurrent() }));

    const render = await loadScreen();
    await hydrateAndInitialize();
    const rendered = texts(render());

    for (const unsupported of ['세차', '야외운동', '일교차', '자외선', '출근길', '퇴근길']) {
      expect(rendered).not.toContain(unsupported);
    }
  });

  it('does not hide 판단 보류 when the engine reports INSUFFICIENT_DATA', async () => {
    mockStoredEnvelope('a');
    // Empty hourly and null air quality drive umbrella/outfit/laundry/mask to INSUFFICIENT_DATA.
    useMobileWeatherQueryMock.mockReturnValue(
      successSnapshot({ current: syntheticCurrent(), hourly: [], airQualityCurrent: null }),
    );

    const render = await loadScreen();
    await hydrateAndInitialize();

    expect(texts(render())).toContain('판단 보류');
  });
});

// ---------------------------------------------------------------------------
// E. hourly preview.
// ---------------------------------------------------------------------------

describe('hourly preview', () => {
  function hourlyEntry(hour: string, overrides: Record<string, unknown> = {}) {
    return {
      forecastAt: `2026-07-15T${hour}:00:00Z`,
      condition: 'CLEAR' as const,
      temperatureCelsius: 20,
      feelsLikeCelsius: 19,
      precipitationProbabilityPercent: 10,
      precipitationAmountMillimeters: 0,
      snowfallAmountCentimeters: 0,
      humidityPercent: 50,
      windSpeedMetersPerSecond: 1,
      windDirectionDegrees: 90,
      ...overrides,
    };
  }

  it('shows only a limited number of hourly entries, not the full list', async () => {
    mockStoredEnvelope('a');
    const hourly = Array.from({ length: 10 }, (_, index) =>
      hourlyEntry(String(index).padStart(2, '0')),
    );
    useMobileWeatherQueryMock.mockReturnValue(
      successSnapshot({ current: syntheticCurrent(), hourly }),
    );

    const render = await loadScreen();
    await hydrateAndInitialize();
    const element = render();

    const temperatureOccurrences = texts(element).filter((text) => text === '20°').length;
    expect(temperatureOccurrences).toBeLessThanOrEqual(6);
    expect(temperatureOccurrences).toBeGreaterThan(0);
  });

  it('formats hourly preview times in the selected location timezone, not device time', async () => {
    mockStoredEnvelope('a');
    useMobileWeatherQueryMock.mockReturnValue(
      successSnapshot({ current: syntheticCurrent(), hourly: [hourlyEntry('12')] }),
    );

    const render = await loadScreen();
    await hydrateAndInitialize();

    // 'Asia/Seoul' (the synthetic location's timezone) is UTC+9, so 12:00Z renders as 21:00.
    expect(texts(render())).toContain('21:00');
  });

  it('does not render a fake precipitation probability when it is null', async () => {
    mockStoredEnvelope('a');
    useMobileWeatherQueryMock.mockReturnValue(
      successSnapshot({
        current: syntheticCurrent(),
        hourly: [hourlyEntry('12', { precipitationProbabilityPercent: null })],
      }),
    );

    const render = await loadScreen();
    await hydrateAndInitialize();
    // A standalone "NN%" text node is how the hourly preview renders a real precipitation
    // probability; other "%" usages (e.g. "습도 60%") are unrelated fields and must not be confused
    // with a fabricated hourly value.
    expect(texts(render())).not.toEqual(expect.arrayContaining([expect.stringMatching(/^\d+%$/)]));
  });

  it('shows a safe no-data message when hourly is empty', async () => {
    mockStoredEnvelope('a');
    useMobileWeatherQueryMock.mockReturnValue(
      successSnapshot({ current: syntheticCurrent(), hourly: [] }),
    );

    const render = await loadScreen();
    await hydrateAndInitialize();

    expect(texts(render())).toContain('표시할 시간별 예보가 없습니다.');
  });

  it('renders the empty-hourly copy without treating it as an error (no-selection fixture)', async () => {
    mockStoredEnvelope('a');
    useMobileWeatherQueryMock.mockReturnValue({
      status: 'SUCCESS',
      locationId: 'a',
      data: noSelectionSuccessResponseBody(),
    });

    const render = await loadScreen();
    await hydrateAndInitialize();
    const element = render();

    expect(texts(element)).toContain('현재 관측 정보를 확인할 수 없습니다.');
    expect(texts(element)).toContain('표시할 시간별 예보가 없습니다.');
  });
});
