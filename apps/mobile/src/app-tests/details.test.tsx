import type { WeatherSuccessResponseV1 } from '@life-weather/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// `react-native` primitives are replaced with minimal marker components, matching the other
// app-tests files, so the screen can be invoked as a plain function without a renderer.
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
// Expo Router's `useRouter` is replaced with a fake returning a call-recording `push` mock.
// ---------------------------------------------------------------------------

const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
}));

vi.mock('expo-router', () => ({
  useRouter: () => routerMock,
}));

// ---------------------------------------------------------------------------
// Both read-only hooks are replaced with call-recording mocks: this screen owns only the
// presentation of whatever snapshot each hook returns, never the hook's own subscription or
// lifecycle contract (each is covered by its own dedicated test file).
// ---------------------------------------------------------------------------

const useMobileSavedLocationsMock = vi.hoisted(() => vi.fn());
const useMobileWeatherQueryMock = vi.hoisted(() => vi.fn());

vi.mock('../locations/use-mobile-saved-locations', () => ({
  useMobileSavedLocations: useMobileSavedLocationsMock,
}));

vi.mock('../weather-query/use-mobile-weather-query', () => ({
  useMobileWeatherQuery: useMobileWeatherQueryMock,
}));

// ---------------------------------------------------------------------------
// The two production stores the screen dispatches explicit retries against are replaced with
// bare spies for their single relevant method — never a reimplementation of their real contract.
// ---------------------------------------------------------------------------

const mobileSavedLocationApplicationStoreMock = vi.hoisted(() => ({
  retryInitialization: vi.fn(),
}));

vi.mock('../locations/mobile-saved-location-application-production', () => ({
  mobileSavedLocationApplicationStore: mobileSavedLocationApplicationStoreMock,
}));

const mobileWeatherQueryStoreMock = vi.hoisted(() => ({
  retry: vi.fn(),
}));

vi.mock('../weather-query/mobile-weather-query-production', () => ({
  mobileWeatherQueryStore: mobileWeatherQueryStoreMock,
}));

// ---------------------------------------------------------------------------
// The pure presentation boundary is mocked: this screen test verifies wiring and rendering of
// whatever the boundary returns, not the alert/current mapping policy itself (covered by
// `../details/create-mobile-weather-details.test.ts`).
// ---------------------------------------------------------------------------

const createMobileWeatherDetailsMock = vi.hoisted(() => vi.fn());

vi.mock('../details/create-mobile-weather-details', () => ({
  createMobileWeatherDetails: createMobileWeatherDetailsMock,
}));

// ---------------------------------------------------------------------------
// Synthetic fixtures and element-tree helpers.
// ---------------------------------------------------------------------------

function sharedFields(id: string, timezone: string) {
  return {
    id,
    displayName: `Synthetic ${id}`,
    countryCode: 'KR',
    adminArea1: 'Synthetic Province',
    adminArea2: 'Synthetic District',
    adminArea3: null,
    latitude: 37.5,
    longitude: 127.0,
    timezone,
  };
}

function savedLocationRecord(id: string, sortOrder: number, timezone = 'Asia/Seoul') {
  return {
    ...sharedFields(id, timezone),
    kmaGrid: { nx: 60, ny: 127 },
    isCurrent: false,
    sortOrder,
  };
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
function readySnapshot(
  locations: ReturnType<typeof savedLocationRecord>[],
  selectedLocationId: string,
) {
  return {
    status: 'READY' as const,
    locations,
    selectedLocationId,
    writeStatus: 'IDLE' as const,
  };
}
function savedLocationErrorSnapshot() {
  return {
    status: 'ERROR' as const,
    error: { scope: 'SAVED_LOCATIONS' as const, kind: 'STORAGE_READ_FAILED' as const },
    writeStatus: 'IDLE' as const,
  };
}

function idleQuery() {
  return { status: 'IDLE' as const };
}
function loadingQuery(locationId: string) {
  return { status: 'LOADING' as const, locationId };
}
function errorQuery(
  locationId: string,
  presentation: 'CONFIGURATION' | 'NETWORK' | 'API' | 'INVALID_RESPONSE',
) {
  return { status: 'ERROR' as const, locationId, presentation };
}
function successQuery(locationId: string, data: WeatherSuccessResponseV1) {
  return { status: 'SUCCESS' as const, locationId, data };
}

function baseMeta() {
  return { contractVersion: 1 as const, generatedAt: '2026-08-05T05:00:00Z', requestId: null };
}

function successResponse(locationId = 'a'): WeatherSuccessResponseV1 {
  return {
    ok: true,
    meta: baseMeta(),
    data: {
      location: { ...sharedFields(locationId, 'Asia/Seoul') },
      current: null,
      hourly: [],
      daily: [],
      airQuality: { current: null, daily: [] },
      alerts: [],
      missingSections: ['CURRENT', 'HOURLY', 'DAILY', 'AIR_QUALITY_CURRENT', 'AIR_QUALITY_FORECAST', 'ALERTS'],
      sources: [],
    },
  } as WeatherSuccessResponseV1;
}

function unavailableAlertsPresentation() {
  return { status: 'UNAVAILABLE' as const, message: '기상특보 정보를 제공하지 못했습니다.', cards: [] };
}
function noneAlertsPresentation() {
  return { status: 'NONE' as const, message: '현재 발표된 기상특보가 없습니다.', cards: [] };
}
function availableAlertsPresentation() {
  return {
    status: 'AVAILABLE' as const,
    message: null,
    cards: [
      {
        title: 'Synthetic Alert',
        severityLabel: '경보',
        typeLabel: '호우',
        issuedAtLabel: '8월 5일 (수) 12:00',
        effectiveAtLabel: '8월 5일 (수) 13:00',
        expiresAtLabel: '8월 5일 (수) 20:00',
        areasLabel: 'Area One, Area Two',
        description: 'Synthetic description text.',
      },
    ],
  };
}
function unavailableCurrentPresentation() {
  return { status: 'UNAVAILABLE' as const, message: '현재 관측 정보를 제공하지 못했습니다.' };
}
function availableCurrentPresentation() {
  return {
    status: 'AVAILABLE' as const,
    message: null,
    observedAtLabel: '8월 5일 (수) 14:00',
    conditionLabel: '맑음',
    temperatureLabel: '23°C',
    details: [
      { id: 'FEELS_LIKE' as const, text: '체감온도 20°C' },
      { id: 'HUMIDITY' as const, text: '습도 55%' },
    ],
  };
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

function texts(root: unknown): string[] {
  const collected: string[] = [];
  walk(root, (element) => {
    if (element.type === MockText && typeof element.props.children === 'string') {
      collected.push(element.props.children);
    }
  });
  return collected;
}

function headerTexts(root: unknown): string[] {
  const collected: string[] = [];
  walk(root, (element) => {
    if (
      element.type === MockText &&
      element.props.accessibilityRole === 'header' &&
      typeof element.props.children === 'string'
    ) {
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

function findScrollView(root: unknown): ElementLike | null {
  let found: ElementLike | null = null;
  walk(root, (element) => {
    if (element.type === MockScrollView && found === null) {
      found = element;
    }
  });
  return found;
}

async function loadScreen() {
  const { default: DetailsScreen } = await import('../app/(tabs)/details');
  return function render() {
    return DetailsScreen();
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  useMobileSavedLocationsMock.mockReturnValue(notStartedSnapshot());
  useMobileWeatherQueryMock.mockReturnValue(idleQuery());
});

// ---------------------------------------------------------------------------
// import/call-time side effects and hook/lifecycle ownership.
// ---------------------------------------------------------------------------

describe('import and invocation boundaries', () => {
  it('performs no hook/store/router/presenter I/O merely by importing the module', async () => {
    await import('../app/(tabs)/details');

    expect(useMobileSavedLocationsMock).toHaveBeenCalledTimes(0);
    expect(useMobileWeatherQueryMock).toHaveBeenCalledTimes(0);
    expect(routerMock.push).toHaveBeenCalledTimes(0);
    expect(mobileWeatherQueryStoreMock.retry).toHaveBeenCalledTimes(0);
    expect(mobileSavedLocationApplicationStoreMock.retryInitialization).toHaveBeenCalledTimes(0);
    expect(createMobileWeatherDetailsMock).toHaveBeenCalledTimes(0);
  });

  it('calls useMobileSavedLocations exactly once per render', async () => {
    const render = await loadScreen();

    render();

    expect(useMobileSavedLocationsMock).toHaveBeenCalledTimes(1);
  });

  it('passes the exact saved-location snapshot reference through to useMobileWeatherQuery', async () => {
    const snapshot = readySnapshot([savedLocationRecord('a', 0)], 'a');
    useMobileSavedLocationsMock.mockReturnValue(snapshot);
    const render = await loadScreen();

    render();

    expect(useMobileWeatherQueryMock).toHaveBeenCalledTimes(1);
    expect(useMobileWeatherQueryMock).toHaveBeenCalledWith(snapshot);
  });

  it('never imports or calls the weather-query lifecycle hook', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../app/(tabs)/details.tsx', import.meta.url), 'utf-8'),
    );

    expect(source).not.toContain('use-mobile-weather-query-lifecycle');
    expect(source).not.toContain('useMobileWeatherQueryLifecycle');
  });

  it('never calls request/reset on the weather-query store, and never fetches or reads Date.now directly', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../app/(tabs)/details.tsx', import.meta.url), 'utf-8'),
    );

    expect('request' in mobileWeatherQueryStoreMock).toBe(false);
    expect('reset' in mobileWeatherQueryStoreMock).toBe(false);
    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('Date.now');
  });
});

// ---------------------------------------------------------------------------
// top-level ScrollView.
// ---------------------------------------------------------------------------

describe('layout', () => {
  it('renders a top-level ScrollView', async () => {
    const render = await loadScreen();

    expect(findScrollView(render())).not.toBeNull();
  });

  it('renders the screen title with header semantics', async () => {
    const render = await loadScreen();

    expect(headerTexts(render())).toContain('상세기상');
  });
});

// ---------------------------------------------------------------------------
// saved-location preparation states.
// ---------------------------------------------------------------------------

describe('saved-location preparation states', () => {
  it.each([
    ['NOT_STARTED', notStartedSnapshot(), '저장된 지역을 불러오는 중입니다.'],
    ['LOADING', loadingSnapshot(), '저장된 지역을 불러오는 중입니다.'],
    ['SELECTION_LOADING', selectionLoadingSnapshot(), '선택 지역을 준비하는 중입니다.'],
  ] as const)('shows the preparing copy for %s with no controls', async (_name, snapshot, copy) => {
    useMobileSavedLocationsMock.mockReturnValue(snapshot);
    const render = await loadScreen();

    const element = render();

    expect(texts(element)).toEqual(['상세기상', copy]);
    expect(pressables(element)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// EMPTY.
// ---------------------------------------------------------------------------

describe('EMPTY', () => {
  it('shows the empty copy and an accessible "지역 추가" entry point', async () => {
    useMobileSavedLocationsMock.mockReturnValue(emptySnapshot());
    const render = await loadScreen();

    const element = render();

    expect(texts(element)).toEqual([
      '상세기상',
      '저장된 지역이 없습니다.',
      '지역을 추가하면 상세기상을 볼 수 있어요.',
      '지역 추가',
    ]);
    const button = pressableByLabel(element, '지역 추가');
    expect(button.props.accessibilityRole).toBe('button');
  });

  it('navigates to /locations exactly once when "지역 추가" is pressed', async () => {
    useMobileSavedLocationsMock.mockReturnValue(emptySnapshot());
    const render = await loadScreen();

    press(pressableByLabel(render(), '지역 추가'));

    expect(routerMock.push).toHaveBeenCalledTimes(1);
    expect(routerMock.push).toHaveBeenCalledWith('/locations');
  });
});

// ---------------------------------------------------------------------------
// saved-location ERROR.
// ---------------------------------------------------------------------------

describe('saved-location ERROR', () => {
  it('shows only generic copy and a retry control, no raw kind/scope', async () => {
    useMobileSavedLocationsMock.mockReturnValue(savedLocationErrorSnapshot());
    const render = await loadScreen();

    const element = render();
    const rendered = texts(element).join('\n');

    expect(texts(element)).toEqual(['상세기상', '저장된 지역을 불러오지 못했습니다.', '다시 시도']);
    expect(rendered).not.toContain('STORAGE_READ_FAILED');
    expect(rendered).not.toContain('SAVED_LOCATIONS');
    expect(pressableByLabel(element, '저장 지역 다시 불러오기')).toBeDefined();
  });

  it('calls retryInitialization exactly once per press', async () => {
    useMobileSavedLocationsMock.mockReturnValue(savedLocationErrorSnapshot());
    const render = await loadScreen();

    press(pressableByLabel(render(), '저장 지역 다시 불러오기'));

    expect(mobileSavedLocationApplicationStoreMock.retryInitialization).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// READY + selected record missing (defensive).
// ---------------------------------------------------------------------------

describe('READY with selected record missing', () => {
  it('shows the preparing copy, not raw id, and does not crash', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'missing-id'));
    useMobileWeatherQueryMock.mockReturnValue(idleQuery());
    const render = await loadScreen();

    const rendered = texts(render());
    expect(rendered).toEqual(['상세기상', '상세기상을 준비하고 있습니다.']);
    expect(rendered.join('\n')).not.toContain('missing-id');
  });
});

// ---------------------------------------------------------------------------
// READY + weather IDLE/LOADING.
// ---------------------------------------------------------------------------

describe('READY + weather query states', () => {
  it('shows the preparing copy and the selected location name while the weather query is IDLE', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(idleQuery());
    const render = await loadScreen();

    const rendered = texts(render());
    expect(rendered).toContain('상세기상을 준비하고 있습니다.');
    expect(rendered).toContain('Synthetic a');
  });

  it('shows the loading copy and the selected location name while the weather query is LOADING', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(loadingQuery('a'));
    const render = await loadScreen();

    const rendered = texts(render());
    expect(rendered).toContain('선택한 지역의 상세기상을 불러오는 중입니다.');
    expect(rendered).toContain('Synthetic a');
  });
});

// ---------------------------------------------------------------------------
// READY + weather ERROR.
// ---------------------------------------------------------------------------

describe('READY + weather ERROR', () => {
  it.each([
    ['CONFIGURATION', '날씨 서비스를 준비하지 못했습니다.'],
    ['NETWORK', '날씨 정보를 불러오지 못했습니다. 네트워크 연결을 확인해 주세요.'],
    ['API', '날씨 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'],
    ['INVALID_RESPONSE', '날씨 정보를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.'],
  ] as const)('shows the fixed %s copy with the selected location name, a retry control, and no raw detail', async (presentation, copy) => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(errorQuery('a', presentation));
    const render = await loadScreen();

    const element = render();
    const rendered = texts(element).join('\n');

    expect(rendered).toContain(copy);
    expect(rendered).toContain('Synthetic a');
    expect(rendered).not.toContain(presentation);
    expect(pressableByLabel(element, '상세기상 다시 시도')).toBeDefined();
  });

  it('calls the production store\'s retry exactly once per press', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(errorQuery('a', 'NETWORK'));
    const render = await loadScreen();

    press(pressableByLabel(render(), '상세기상 다시 시도'));

    expect(mobileWeatherQueryStoreMock.retry).toHaveBeenCalledTimes(1);
  });

  it('never calls the presenter outside SUCCESS', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(errorQuery('a', 'NETWORK'));
    const render = await loadScreen();

    render();

    expect(createMobileWeatherDetailsMock).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// READY + SUCCESS: presenter wiring.
// ---------------------------------------------------------------------------

describe('READY + SUCCESS presenter wiring', () => {
  it('calls the presenter exactly once with the exact response reference and selected timezone', async () => {
    const response = successResponse('a');
    useMobileSavedLocationsMock.mockReturnValue(
      readySnapshot([savedLocationRecord('a', 0, 'Asia/Seoul')], 'a'),
    );
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', response));
    createMobileWeatherDetailsMock.mockReturnValue({
      alerts: unavailableAlertsPresentation(),
      current: unavailableCurrentPresentation(),
    });
    const render = await loadScreen();

    render();

    expect(createMobileWeatherDetailsMock).toHaveBeenCalledTimes(1);
    expect(createMobileWeatherDetailsMock).toHaveBeenCalledWith(response, 'Asia/Seoul');
  });

  it('shows the selected location name exactly once in SUCCESS', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', successResponse('a')));
    createMobileWeatherDetailsMock.mockReturnValue({
      alerts: unavailableAlertsPresentation(),
      current: unavailableCurrentPresentation(),
    });
    const render = await loadScreen();

    const rendered = texts(render());

    expect(rendered.filter((text) => text === 'Synthetic a')).toHaveLength(1);
  });

  it('shows the selected location name in every READY weather state, not just SUCCESS', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    createMobileWeatherDetailsMock.mockReturnValue({
      alerts: unavailableAlertsPresentation(),
      current: unavailableCurrentPresentation(),
    });
    const render = await loadScreen();

    useMobileWeatherQueryMock.mockReturnValue(idleQuery());
    expect(texts(render())).toContain('Synthetic a');

    useMobileWeatherQueryMock.mockReturnValue(loadingQuery('a'));
    expect(texts(render())).toContain('Synthetic a');

    useMobileWeatherQueryMock.mockReturnValue(errorQuery('a', 'NETWORK'));
    expect(texts(render())).toContain('Synthetic a');

    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', successResponse('a')));
    expect(texts(render())).toContain('Synthetic a');
  });
});

// ---------------------------------------------------------------------------
// READY + SUCCESS: section order and content.
// ---------------------------------------------------------------------------

describe('READY + SUCCESS section order and content', () => {
  it('renders 기상특보 before 현재 관측', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', successResponse('a')));
    createMobileWeatherDetailsMock.mockReturnValue({
      alerts: availableAlertsPresentation(),
      current: availableCurrentPresentation(),
    });
    const render = await loadScreen();

    const headers = headerTexts(render());
    const alertIndex = headers.indexOf('기상특보');
    const currentIndex = headers.indexOf('현재 관측');

    expect(alertIndex).toBeGreaterThan(-1);
    expect(currentIndex).toBeGreaterThan(alertIndex);
  });

  it('shows both section titles with header semantics', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', successResponse('a')));
    createMobileWeatherDetailsMock.mockReturnValue({
      alerts: unavailableAlertsPresentation(),
      current: unavailableCurrentPresentation(),
    });
    const render = await loadScreen();

    expect(headerTexts(render())).toEqual(expect.arrayContaining(['기상특보', '현재 관측']));
  });

  it('shows the alert UNAVAILABLE message', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', successResponse('a')));
    createMobileWeatherDetailsMock.mockReturnValue({
      alerts: unavailableAlertsPresentation(),
      current: unavailableCurrentPresentation(),
    });
    const render = await loadScreen();

    expect(texts(render())).toContain('기상특보 정보를 제공하지 못했습니다.');
  });

  it('shows the alert NONE message', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', successResponse('a')));
    createMobileWeatherDetailsMock.mockReturnValue({
      alerts: noneAlertsPresentation(),
      current: unavailableCurrentPresentation(),
    });
    const render = await loadScreen();

    expect(texts(render())).toContain('현재 발표된 기상특보가 없습니다.');
  });

  it('shows every required alert card field for AVAILABLE, with a header title', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', successResponse('a')));
    createMobileWeatherDetailsMock.mockReturnValue({
      alerts: availableAlertsPresentation(),
      current: unavailableCurrentPresentation(),
    });
    const render = await loadScreen();

    const element = render();
    const rendered = texts(element);

    expect(headerTexts(element)).toContain('Synthetic Alert');
    expect(rendered).toContain('경보');
    expect(rendered).toContain('호우');
    expect(rendered).toContain('8월 5일 (수) 12:00');
    expect(rendered).toContain('8월 5일 (수) 13:00');
    expect(rendered).toContain('8월 5일 (수) 20:00');
    expect(rendered).toContain('Area One, Area Two');
    expect(rendered).toContain('Synthetic description text.');
    expect(rendered).toContain('대상 지역');
    expect(rendered).toContain('상세 안내');
    expect(rendered).toContain('발표');
    expect(rendered).toContain('발효');
    expect(rendered).toContain('종료');
  });

  it('omits effective/expires/description lines when they are null', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', successResponse('a')));
    createMobileWeatherDetailsMock.mockReturnValue({
      alerts: {
        status: 'AVAILABLE' as const,
        message: null,
        cards: [
          {
            title: 'Synthetic Alert',
            severityLabel: '경보',
            typeLabel: '호우',
            issuedAtLabel: '8월 5일 (수) 12:00',
            effectiveAtLabel: null,
            expiresAtLabel: null,
            areasLabel: 'Area One',
            description: null,
          },
        ],
      },
      current: unavailableCurrentPresentation(),
    });
    const render = await loadScreen();

    const rendered = texts(render()).join('\n');

    expect(rendered).not.toContain('발효');
    expect(rendered).not.toContain('종료');
    expect(rendered).not.toContain('상세 안내');
  });

  it('shows the current UNAVAILABLE message', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', successResponse('a')));
    createMobileWeatherDetailsMock.mockReturnValue({
      alerts: unavailableAlertsPresentation(),
      current: unavailableCurrentPresentation(),
    });
    const render = await loadScreen();

    expect(texts(render())).toContain('현재 관측 정보를 제공하지 못했습니다.');
  });

  it('shows the required current fields and every detail in order for AVAILABLE', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', successResponse('a')));
    createMobileWeatherDetailsMock.mockReturnValue({
      alerts: unavailableAlertsPresentation(),
      current: availableCurrentPresentation(),
    });
    const render = await loadScreen();

    const rendered = texts(render());

    expect(rendered).toContain('관측 8월 5일 (수) 14:00');
    expect(rendered).toContain('맑음');
    expect(rendered).toContain('23°C');
    const feelsLikeIndex = rendered.indexOf('체감온도 20°C');
    const humidityIndex = rendered.indexOf('습도 55%');
    expect(feelsLikeIndex).toBeGreaterThan(-1);
    expect(humidityIndex).toBeGreaterThan(feelsLikeIndex);
  });
});

// ---------------------------------------------------------------------------
// no raw internal detail leaks anywhere.
// ---------------------------------------------------------------------------

describe('no raw internal detail leaks', () => {
  it('never renders requestId, url, coordinates, grid, or provider/native strings', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', successResponse('a')));
    createMobileWeatherDetailsMock.mockReturnValue({
      alerts: availableAlertsPresentation(),
      current: availableCurrentPresentation(),
    });
    const render = await loadScreen();

    const rendered = texts(render()).join('\n');

    expect(rendered).not.toContain('37.5');
    expect(rendered).not.toContain('127');
    expect(rendered).not.toContain('kma');
    expect(rendered).not.toContain('KMA');
    expect(rendered).not.toContain('nx');
    expect(rendered).not.toContain('ny');
    expect(rendered).not.toContain('synthetic-request-id');
  });
});

// ---------------------------------------------------------------------------
// accessibility: buttons.
// ---------------------------------------------------------------------------

describe('accessibility', () => {
  it('gives the "지역 추가" button an accessible role/label and minimum touch style', async () => {
    useMobileSavedLocationsMock.mockReturnValue(emptySnapshot());
    const render = await loadScreen();

    const button = pressableByLabel(render(), '지역 추가');
    const style = button.props.style as { minHeight: number; minWidth: number };

    expect(button.props.accessibilityRole).toBe('button');
    expect(style.minHeight).toBeGreaterThanOrEqual(48);
    expect(style.minWidth).toBeGreaterThanOrEqual(48);
  });

  it('gives the weather retry button an accessible role/label and minimum touch style', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(errorQuery('a', 'NETWORK'));
    const render = await loadScreen();

    const button = pressableByLabel(render(), '상세기상 다시 시도');
    const style = button.props.style as { minHeight: number; minWidth: number };

    expect(button.props.accessibilityRole).toBe('button');
    expect(style.minHeight).toBeGreaterThanOrEqual(48);
    expect(style.minWidth).toBeGreaterThanOrEqual(48);
  });
});
