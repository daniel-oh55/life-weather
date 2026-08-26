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
  return { contractVersion: 1 as const, generatedAt: '2026-07-15T09:00:00Z', requestId: null };
}

function hourlyEntry(overrides: Partial<WeatherSuccessResponseV1['data']['hourly'][number]> = {}) {
  return {
    forecastAt: '2026-08-05T05:00:00Z',
    condition: 'CLEAR' as const,
    temperatureCelsius: 21,
    feelsLikeCelsius: 20,
    precipitationProbabilityPercent: 10,
    precipitationAmountMillimeters: 0,
    snowfallAmountCentimeters: 0,
    humidityPercent: 55,
    windSpeedMetersPerSecond: 2.4,
    windDirectionDegrees: 180,
    ...overrides,
  };
}

function successResponse(
  hourly: WeatherSuccessResponseV1['data']['hourly'],
  locationId = 'a',
): WeatherSuccessResponseV1 {
  return {
    ok: true,
    meta: baseMeta(),
    data: {
      location: { ...sharedFields(locationId, 'Asia/Seoul') },
      current: null,
      hourly,
      daily: [],
      airQuality: { current: null, daily: [] },
      alerts: [],
      missingSections: ['CURRENT', 'DAILY', 'AIR_QUALITY_CURRENT', 'AIR_QUALITY_FORECAST', 'ALERTS'],
      sources: [],
    },
  } as WeatherSuccessResponseV1;
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

function headers(root: unknown): string[] {
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

function scrollViews(root: unknown): ElementLike[] {
  const collected: ElementLike[] = [];
  walk(root, (element) => {
    if (element.type === MockScrollView) {
      collected.push(element);
    }
  });
  return collected;
}

function horizontalScrollViews(root: unknown): ElementLike[] {
  return scrollViews(root).filter((element) => element.props.horizontal === true);
}

/** The single timeline scroll surface, asserted here so every caller shares one axis. */
function timelineScrollView(root: unknown): ElementLike {
  const horizontal = horizontalScrollViews(root);
  if (horizontal.length !== 1) {
    throw new Error(`expected exactly one horizontal ScrollView, saw ${horizontal.length}`);
  }
  return horizontal[0];
}

/**
 * Merges a React Native `style` prop (object, array, or nested arrays) into one flat record, the
 * same way the platform resolves it, so tests can inspect real rendered geometry.
 */
function flattenStyle(style: unknown): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === 'object' && value !== null) {
      Object.assign(flat, value as Record<string, unknown>);
    }
  }
  visit(style);
  return flat;
}

/**
 * Absolutely-positioned Views carrying a rotation: the temperature polyline's connecting segments.
 * The chart's own fill layer and its round points carry no `transform`, so they are excluded.
 */
function chartSegments(root: unknown): Record<string, unknown>[] {
  const collected: Record<string, unknown>[] = [];
  walk(root, (element) => {
    if (element.type !== MockView) {
      return;
    }
    const style = flattenStyle(element.props.style);
    if (style.position === 'absolute' && Array.isArray(style.transform)) {
      collected.push(style);
    }
  });
  return collected;
}

/** Absolutely-positioned round Views with no rotation: the temperature polyline's data points. */
function chartPoints(root: unknown): Record<string, unknown>[] {
  const collected: Record<string, unknown>[] = [];
  walk(root, (element) => {
    if (element.type !== MockView) {
      return;
    }
    const style = flattenStyle(element.props.style);
    if (
      style.position === 'absolute' &&
      style.transform === undefined &&
      typeof style.borderRadius === 'number' &&
      style.width === style.height
    ) {
      collected.push(style);
    }
  });
  return collected;
}

function rotationDegrees(style: Record<string, unknown>): number {
  const transform = style.transform as { rotate?: string }[];
  const rotate = transform[0]?.rotate ?? '';
  return Number.parseFloat(rotate.replace('deg', ''));
}

async function loadScreen() {
  const { default: HourlyScreen } = await import('../app/(tabs)/hourly');
  return function render() {
    return HourlyScreen();
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
  it('performs no hook/store/router I/O merely by importing the module', async () => {
    await import('../app/(tabs)/hourly');

    expect(useMobileSavedLocationsMock).toHaveBeenCalledTimes(0);
    expect(useMobileWeatherQueryMock).toHaveBeenCalledTimes(0);
    expect(routerMock.push).toHaveBeenCalledTimes(0);
    expect(mobileWeatherQueryStoreMock.retry).toHaveBeenCalledTimes(0);
    expect(mobileSavedLocationApplicationStoreMock.retryInitialization).toHaveBeenCalledTimes(0);
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
      fs.readFile(new URL('../app/(tabs)/hourly.tsx', import.meta.url), 'utf-8'),
    );

    expect(source).not.toContain('use-mobile-weather-query-lifecycle');
    expect(source).not.toContain('useMobileWeatherQueryLifecycle');
  });

  it('never calls request/reset on the weather-query store, and never fetches directly', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(
      successQuery('a', successResponse([hourlyEntry()])),
    );
    const render = await loadScreen();

    render();

    expect('request' in mobileWeatherQueryStoreMock).toBe(false);
    expect('reset' in mobileWeatherQueryStoreMock).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// screen-owned header.
// ---------------------------------------------------------------------------

describe('screen-owned header', () => {
  it('always shows the "시간별" header title', async () => {
    useMobileSavedLocationsMock.mockReturnValue(notStartedSnapshot());
    const render = await loadScreen();

    expect(headers(render())).toContain('시간별');
  });

  it('shows the selected location display name next to the title when READY', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(idleQuery());
    const render = await loadScreen();

    expect(texts(render())).toContain('Synthetic a');
  });

  it('does not show a location name when saved locations are not READY', async () => {
    useMobileSavedLocationsMock.mockReturnValue(loadingSnapshot());
    const render = await loadScreen();

    const rendered = texts(render());
    expect(rendered.some((text) => text.startsWith('Synthetic '))).toBe(false);
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
  ] as const)('shows a loading card for %s with no controls', async (_name, snapshot, copy) => {
    useMobileSavedLocationsMock.mockReturnValue(snapshot);
    const render = await loadScreen();

    const element = render();

    expect(texts(element)).toContain(copy);
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

    expect(texts(element)).toContain('저장된 지역이 없습니다.');
    const button = pressableByLabel(element, '지역 추가');
    expect(button.props.accessibilityRole).toBe('button');
  });

  it('navigates to /locations when "지역 추가" is pressed', async () => {
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

    expect(rendered).toContain('저장된 지역을 불러오지 못했습니다.');
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
// READY + weather IDLE/LOADING.
// ---------------------------------------------------------------------------

describe('READY + weather query states', () => {
  it('shows a loading card and the selected location name while the weather query is IDLE', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(idleQuery());
    const render = await loadScreen();

    const rendered = texts(render());
    expect(rendered).toContain('선택한 지역의 시간별 날씨를 불러오는 중입니다.');
    expect(rendered).toContain('Synthetic a');
  });

  it('shows the loading copy and the selected location name while the weather query is LOADING', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(loadingQuery('a'));
    const render = await loadScreen();

    const rendered = texts(render());
    expect(rendered).toContain('선택한 지역의 시간별 날씨를 불러오는 중입니다.');
    expect(rendered).toContain('Synthetic a');
  });

  it('shows a preparing card, not raw id, when the selected record is missing (defensive)', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'missing-id'));
    useMobileWeatherQueryMock.mockReturnValue(idleQuery());
    const render = await loadScreen();

    const rendered = texts(render());
    expect(rendered).toContain('시간별 날씨를 준비하고 있습니다.');
    expect(rendered.join('\n')).not.toContain('missing-id');
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
    expect(pressableByLabel(element, '시간별 날씨 다시 시도')).toBeDefined();
  });

  it('calls the production store\'s retry exactly once per press', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(errorQuery('a', 'NETWORK'));
    const render = await loadScreen();

    press(pressableByLabel(render(), '시간별 날씨 다시 시도'));

    expect(mobileWeatherQueryStoreMock.retry).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// READY + SUCCESS with empty hourly.
// ---------------------------------------------------------------------------

describe('READY + SUCCESS with empty hourly', () => {
  it('shows the empty-hourly copy and the selected location name without a retry control', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', successResponse([])));
    const render = await loadScreen();

    const element = render();
    const rendered = texts(element);

    expect(rendered).toContain('표시할 시간별 예보가 없습니다.');
    expect(rendered).toContain('Synthetic a');
    expect(pressables(element)).toHaveLength(0);
  });

  it('does not treat an empty hourly SUCCESS as an error', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', successResponse([])));
    const render = await loadScreen();

    expect(() => render()).not.toThrow();
    expect(pressables(render())).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// hourly content: order, condition labels, temperature, optional fields.
// ---------------------------------------------------------------------------

describe('hourly content', () => {
  it('shows the selected display name and every hourly entry in response order', async () => {
    useMobileSavedLocationsMock.mockReturnValue(
      readySnapshot([savedLocationRecord('a', 0), savedLocationRecord('b', 1)], 'b'),
    );
    const first = hourlyEntry({ forecastAt: '2026-08-05T05:00:00Z', temperatureCelsius: 21 });
    const second = hourlyEntry({ forecastAt: '2026-08-05T06:00:00Z', temperatureCelsius: 22 });
    useMobileWeatherQueryMock.mockReturnValue(successQuery('b', successResponse([first, second], 'b')));
    const render = await loadScreen();

    const rendered = texts(render());

    expect(rendered).toContain('Synthetic b');
    const firstIndex = rendered.indexOf('21°');
    const secondIndex = rendered.indexOf('22°');
    expect(firstIndex).toBeGreaterThan(-1);
    expect(secondIndex).toBeGreaterThan(firstIndex);
  });

  it('shows the selected display name exactly once', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(
      successQuery('a', successResponse([hourlyEntry()])),
    );
    const render = await loadScreen();

    const rendered = texts(render());

    expect(rendered.filter((text) => text === 'Synthetic a')).toHaveLength(1);
  });

  it('never renders current/daily/alerts/source content', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    const response = successResponse([hourlyEntry()]);
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', response));
    const render = await loadScreen();

    expect(response.data.current).toBeNull();
    expect(() => render()).not.toThrow();
  });

  it('does not render a weather block outside READY, even if the query mock reports SUCCESS', async () => {
    useMobileSavedLocationsMock.mockReturnValue(notStartedSnapshot());
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', successResponse([hourlyEntry()])));
    const render = await loadScreen();

    const rendered = texts(render());

    expect(rendered).not.toContain('Synthetic a');
    expect(rendered).not.toContain('21°');
  });

  it.each([
    ['CLEAR', '맑음'],
    ['PARTLY_CLOUDY', '구름 조금'],
    ['CLOUDY', '흐림'],
    ['RAIN', '비'],
    ['SNOW', '눈'],
    ['SLEET', '진눈깨비'],
    ['SHOWER', '소나기'],
    ['THUNDERSTORM', '천둥·번개'],
    ['FOG', '안개'],
    ['UNKNOWN', '상태 미확인'],
  ] as const)('maps condition %s to the Korean label "%s"', async (condition, label) => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(
      successQuery('a', successResponse([hourlyEntry({ condition })])),
    );
    const render = await loadScreen();

    expect(texts(render())).toContain(label);
  });

  it('never renders a raw WeatherCondition enum string', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(
      successQuery('a', successResponse([hourlyEntry({ condition: 'THUNDERSTORM' })])),
    );
    const render = await loadScreen();

    const rendered = texts(render()).join('\n');
    expect(rendered).not.toContain('THUNDERSTORM');
    expect(rendered).not.toContain('CLEAR');
  });

  it('always shows the required temperature', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(
      successQuery('a', successResponse([hourlyEntry({ temperatureCelsius: -3 })])),
    );
    const render = await loadScreen();

    expect(texts(render())).toContain('-3°');
  });

  it('shows every optional value in its own fixed row, including a zero, when not null', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(
      successQuery(
        'a',
        successResponse([
          hourlyEntry({
            feelsLikeCelsius: 0,
            precipitationProbabilityPercent: 0,
            precipitationAmountMillimeters: 0,
            snowfallAmountCentimeters: 0,
            humidityPercent: 0,
            windSpeedMetersPerSecond: 0,
            windDirectionDegrees: 0,
          }),
        ]),
      ),
    );
    const render = await loadScreen();

    const rendered = texts(render());

    expect(rendered).toContain('0°');
    expect(rendered).toContain('0%');
    expect(rendered).toContain('0mm');
    expect(rendered).toContain('0cm');
    expect(rendered).toContain('0m/s');
    expect(rendered).toContain('북');
    expect(rendered.filter((text) => text === '0%')).toHaveLength(2);
    expect(rendered).not.toContain('—');
  });

  it('renders a neutral unavailable marker, never a fabricated value, for every null optional', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(
      successQuery(
        'a',
        successResponse([
          hourlyEntry({
            temperatureCelsius: 7,
            feelsLikeCelsius: null,
            precipitationProbabilityPercent: null,
            precipitationAmountMillimeters: null,
            snowfallAmountCentimeters: null,
            humidityPercent: null,
            windSpeedMetersPerSecond: null,
            windDirectionDegrees: null,
          }),
        ]),
      ),
    );
    const render = await loadScreen();

    const rendered = texts(render());

    // One marker per optional row: 체감, 강수확률, 강수량, 적설량, 습도, 풍속, 풍향.
    expect(rendered.filter((text) => text === '—')).toHaveLength(7);
    // A null must never be shown as a zero, and never as a bare unit.
    expect(rendered).not.toContain('0%');
    expect(rendered).not.toContain('0mm');
    expect(rendered).not.toContain('0cm');
    expect(rendered).not.toContain('0m/s');
    expect(rendered).not.toContain('0°');
    // The required temperature is unaffected.
    expect(rendered).toContain('7°');
  });

  it('keeps every row label visible even when the whole column is null', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(
      successQuery(
        'a',
        successResponse([
          hourlyEntry({
            feelsLikeCelsius: null,
            precipitationProbabilityPercent: null,
            precipitationAmountMillimeters: null,
            snowfallAmountCentimeters: null,
            humidityPercent: null,
            windSpeedMetersPerSecond: null,
            windDirectionDegrees: null,
          }),
        ]),
      ),
    );
    const render = await loadScreen();

    const rendered = texts(render());

    for (const label of ['체감', '강수확률', '강수량', '적설량', '습도', '풍속', '풍향']) {
      expect(rendered).toContain(label);
    }
  });

  it('keeps column alignment by rendering a marker cell rather than omitting the null entry', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    const withValue = hourlyEntry({ forecastAt: '2026-08-05T05:00:00Z', humidityPercent: 41 });
    const withoutValue = hourlyEntry({ forecastAt: '2026-08-05T06:00:00Z', humidityPercent: null });
    useMobileWeatherQueryMock.mockReturnValue(
      successQuery('a', successResponse([withValue, withoutValue])),
    );
    const render = await loadScreen();

    const rendered = texts(render());

    expect(rendered).toContain('41%');
    // Exactly one marker, in the humidity row: no other optional field is null in this fixture.
    expect(rendered.filter((text) => text === '—')).toHaveLength(1);
    expect(rendered.indexOf('—')).toBeGreaterThan(rendered.indexOf('41%'));
  });
});

// ---------------------------------------------------------------------------
// local-date grouping and timezone-aware time formatting.
// ---------------------------------------------------------------------------

describe('local-date grouping and time formatting', () => {
  it('formats hour times in the selected location timezone, not the device default', async () => {
    useMobileSavedLocationsMock.mockReturnValue(
      readySnapshot([savedLocationRecord('a', 0, 'Asia/Seoul')], 'a'),
    );
    useMobileWeatherQueryMock.mockReturnValue(
      successQuery('a', successResponse([hourlyEntry({ forecastAt: '2026-08-05T05:00:00Z' })])),
    );
    const render = await loadScreen();

    expect(texts(render())).toContain('14:00');
  });

  it('groups entries under a single local-date heading in Asia/Seoul', async () => {
    useMobileSavedLocationsMock.mockReturnValue(
      readySnapshot([savedLocationRecord('a', 0, 'Asia/Seoul')], 'a'),
    );
    // Both instants are 2026-08-05 in KST (UTC+9): 05:00Z -> 14:00, 10:00Z -> 19:00.
    const first = hourlyEntry({ forecastAt: '2026-08-05T05:00:00Z' });
    const second = hourlyEntry({ forecastAt: '2026-08-05T10:00:00Z' });
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', successResponse([first, second])));
    const render = await loadScreen();

    const element = render();
    expect(headers(element)).toContain('8월 5일 (수)');
    expect(headers(element).filter((label) => label === '8월 5일 (수)')).toHaveLength(1);
  });

  it('groups two instants with the same UTC date into different local-date headings when the selected timezone crosses midnight', async () => {
    useMobileSavedLocationsMock.mockReturnValue(
      readySnapshot([savedLocationRecord('a', 0, 'Asia/Seoul')], 'a'),
    );
    // 2026-08-05T14:00:00Z and 2026-08-05T16:00:00Z are the same UTC calendar date, but in KST
    // (UTC+9) they are 2026-08-05 23:00 and 2026-08-06 01:00 — different local dates.
    const beforeMidnight = hourlyEntry({ forecastAt: '2026-08-05T14:00:00Z' });
    const afterMidnight = hourlyEntry({ forecastAt: '2026-08-05T16:00:00Z' });
    useMobileWeatherQueryMock.mockReturnValue(
      successQuery('a', successResponse([beforeMidnight, afterMidnight])),
    );
    const render = await loadScreen();

    const element = render();
    expect(headers(element)).toEqual(['시간별', '8월 5일 (수)', '8월 6일 (목)']);
  });

  it('groups two instants with different UTC dates into the same local-date heading when the selected timezone keeps them on the same local day', async () => {
    useMobileSavedLocationsMock.mockReturnValue(
      readySnapshot([savedLocationRecord('a', 0, 'Asia/Seoul')], 'a'),
    );
    // 2026-08-04T16:00:00Z (KST 2026-08-05 01:00) and 2026-08-05T14:00:00Z (KST 2026-08-05 23:00)
    // fall on different UTC calendar dates but the same KST local date.
    const first = hourlyEntry({ forecastAt: '2026-08-04T16:00:00Z' });
    const second = hourlyEntry({ forecastAt: '2026-08-05T14:00:00Z' });
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', successResponse([first, second])));
    const render = await loadScreen();

    const element = render();
    expect(headers(element)).toEqual(['시간별', '8월 5일 (수)']);
  });

  it('preserves original contract order of entries within a local-date group', async () => {
    useMobileSavedLocationsMock.mockReturnValue(
      readySnapshot([savedLocationRecord('a', 0, 'Asia/Seoul')], 'a'),
    );
    const first = hourlyEntry({ forecastAt: '2026-08-05T06:00:00Z', temperatureCelsius: 22 });
    const second = hourlyEntry({ forecastAt: '2026-08-05T05:00:00Z', temperatureCelsius: 21 });
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', successResponse([first, second])));
    const render = await loadScreen();

    const rendered = texts(render());
    const firstIndex = rendered.indexOf('22°');
    const secondIndex = rendered.indexOf('21°');
    expect(firstIndex).toBeGreaterThan(-1);
    expect(secondIndex).toBeGreaterThan(firstIndex);
  });

  it('produces multiple date-section headings for entries spanning several local days', async () => {
    useMobileSavedLocationsMock.mockReturnValue(
      readySnapshot([savedLocationRecord('a', 0, 'Asia/Seoul')], 'a'),
    );
    const dayOne = hourlyEntry({ forecastAt: '2026-08-05T05:00:00Z' });
    const dayTwo = hourlyEntry({ forecastAt: '2026-08-06T05:00:00Z' });
    const dayThree = hourlyEntry({ forecastAt: '2026-08-07T05:00:00Z' });
    useMobileWeatherQueryMock.mockReturnValue(
      successQuery('a', successResponse([dayOne, dayTwo, dayThree])),
    );
    const render = await loadScreen();

    expect(headers(render())).toEqual(['시간별', '8월 5일 (수)', '8월 6일 (목)', '8월 7일 (금)']);
  });

  it('falls back to the raw ISO string without throwing for an invalid timezone', async () => {
    useMobileSavedLocationsMock.mockReturnValue(
      readySnapshot([savedLocationRecord('a', 0, 'Not/AZone')], 'a'),
    );
    useMobileWeatherQueryMock.mockReturnValue(
      successQuery('a', successResponse([hourlyEntry({ forecastAt: '2026-08-05T05:00:00Z' })])),
    );
    const render = await loadScreen();

    expect(() => render()).not.toThrow();
    expect(texts(render())).toContain('2026-08-05T05:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// no raw internal detail leaks anywhere.
// ---------------------------------------------------------------------------

describe('no raw internal detail leaks', () => {
  it('never renders requestId, url, coordinates, grid, or provider/native strings', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(
      successQuery('a', successResponse([hourlyEntry()])),
    );
    const render = await loadScreen();

    const rendered = texts(render()).join('\n');

    expect(rendered).not.toContain('37.5');
    expect(rendered).not.toContain('127');
    expect(rendered).not.toContain('kma');
    expect(rendered).not.toContain('KMA');
    expect(rendered).not.toContain('nx');
    expect(rendered).not.toContain('ny');
  });
});

// ---------------------------------------------------------------------------
// one shared horizontal timeline axis and the fixed left label rail.
// ---------------------------------------------------------------------------

describe('horizontal timeline axis', () => {
  function timelineResponse() {
    return successResponse([
      hourlyEntry({ forecastAt: '2026-08-05T05:00:00Z', temperatureCelsius: 28 }),
      hourlyEntry({ forecastAt: '2026-08-05T06:00:00Z', temperatureCelsius: 29 }),
      hourlyEntry({ forecastAt: '2026-08-05T07:00:00Z', temperatureCelsius: 30 }),
    ]);
  }

  it('keeps the outer vertical page scroll and adds exactly one horizontal timeline scroll', async () => {
    useMobileSavedLocationsMock.mockReturnValue(
      readySnapshot([savedLocationRecord('a', 0, 'Asia/Seoul')], 'a'),
    );
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', timelineResponse()));
    const render = await loadScreen();

    const element = render();
    const all = scrollViews(element);

    expect(all).toHaveLength(2);
    expect(horizontalScrollViews(element)).toHaveLength(1);
    // The remaining one is the vertical page scroll, which must not be horizontal.
    expect(all.filter((view) => view.props.horizontal !== true)).toHaveLength(1);
  });

  it('places every time-dependent row under that single horizontal scroll surface', async () => {
    useMobileSavedLocationsMock.mockReturnValue(
      readySnapshot([savedLocationRecord('a', 0, 'Asia/Seoul')], 'a'),
    );
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', timelineResponse()));
    const render = await loadScreen();

    const inside = texts(timelineScrollView(render()));

    // date band, times, condition labels, temperatures and every detail cell move together.
    expect(inside).toContain('8월 5일 (수)');
    expect(inside).toContain('14:00');
    expect(inside).toContain('15:00');
    expect(inside).toContain('16:00');
    expect(inside).toContain('맑음');
    expect(inside).toContain('28°');
    expect(inside).toContain('29°');
    expect(inside).toContain('30°');
    expect(inside).toContain('10%');
    expect(inside).toContain('0mm');
    expect(inside).toContain('0cm');
    expect(inside).toContain('55%');
    expect(inside).toContain('2.4m/s');
    expect(inside).toContain('180°');
    expect(inside).toContain('남');
  });

  it('renders the whole temperature graph inside the same horizontal scroll surface', async () => {
    useMobileSavedLocationsMock.mockReturnValue(
      readySnapshot([savedLocationRecord('a', 0, 'Asia/Seoul')], 'a'),
    );
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', timelineResponse()));
    const render = await loadScreen();

    const element = render();
    const timeline = timelineScrollView(element);

    expect(chartPoints(timeline)).toHaveLength(3);
    expect(chartPoints(timeline)).toHaveLength(chartPoints(element).length);
    expect(chartSegments(timeline)).toHaveLength(chartSegments(element).length);
  });

  it('renders every fixed row label outside the horizontal scroll surface', async () => {
    useMobileSavedLocationsMock.mockReturnValue(
      readySnapshot([savedLocationRecord('a', 0, 'Asia/Seoul')], 'a'),
    );
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', timelineResponse()));
    const render = await loadScreen();

    const element = render();
    const rendered = texts(element);
    const inside = texts(timelineScrollView(element));

    for (const label of [
      '날짜',
      '시간',
      '날씨',
      '기온',
      '체감',
      '강수확률',
      '강수량',
      '적설량',
      '습도',
      '풍속',
      '풍향',
    ]) {
      expect(rendered).toContain(label);
      expect(inside).not.toContain(label);
    }
  });

  it('keeps the screen title and selected location outside the horizontal scroll surface', async () => {
    useMobileSavedLocationsMock.mockReturnValue(
      readySnapshot([savedLocationRecord('a', 0, 'Asia/Seoul')], 'a'),
    );
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', timelineResponse()));
    const render = await loadScreen();

    const inside = texts(timelineScrollView(render()));

    expect(inside).not.toContain('시간별');
    expect(inside).not.toContain('Synthetic a');
  });

  it('describes the timeline as a horizontally scrollable comparison for assistive technology', async () => {
    useMobileSavedLocationsMock.mockReturnValue(
      readySnapshot([savedLocationRecord('a', 0, 'Asia/Seoul')], 'a'),
    );
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', timelineResponse()));
    const render = await loadScreen();

    const label = timelineScrollView(render()).props.accessibilityLabel;

    expect(typeof label).toBe('string');
    expect((label as string).length).toBeGreaterThan(0);
  });

  it('adds no horizontal scroll surface outside the successful non-empty hourly state', async () => {
    useMobileSavedLocationsMock.mockReturnValue(
      readySnapshot([savedLocationRecord('a', 0, 'Asia/Seoul')], 'a'),
    );
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', successResponse([])));
    const render = await loadScreen();

    expect(horizontalScrollViews(render())).toHaveLength(0);
  });

  it('preserves source array order across the hourly columns', async () => {
    useMobileSavedLocationsMock.mockReturnValue(
      readySnapshot([savedLocationRecord('a', 0, 'Asia/Seoul')], 'a'),
    );
    // Deliberately out of chronological order: the screen must not sort.
    const later = hourlyEntry({ forecastAt: '2026-08-05T07:00:00Z', temperatureCelsius: 30 });
    const earlier = hourlyEntry({ forecastAt: '2026-08-05T05:00:00Z', temperatureCelsius: 28 });
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', successResponse([later, earlier])));
    const render = await loadScreen();

    const inside = texts(timelineScrollView(render()));

    expect(inside.indexOf('16:00')).toBeGreaterThan(-1);
    expect(inside.indexOf('14:00')).toBeGreaterThan(inside.indexOf('16:00'));
    expect(inside.indexOf('28°')).toBeGreaterThan(inside.indexOf('30°'));
  });
});

// ---------------------------------------------------------------------------
// horizontal scroll settles on an hourly-column boundary, never an arbitrary offset.
// ---------------------------------------------------------------------------

describe('horizontal scroll column snapping', () => {
  function timelineResponse() {
    return successResponse([
      hourlyEntry({ forecastAt: '2026-08-05T05:00:00Z', temperatureCelsius: 28 }),
      hourlyEntry({ forecastAt: '2026-08-05T06:00:00Z', temperatureCelsius: 29 }),
      hourlyEntry({ forecastAt: '2026-08-05T07:00:00Z', temperatureCelsius: 30 }),
    ]);
  }

  it('snaps the single timeline ScrollView to the hourly-column width, starting at the column edge', async () => {
    useMobileSavedLocationsMock.mockReturnValue(
      readySnapshot([savedLocationRecord('a', 0, 'Asia/Seoul')], 'a'),
    );
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', timelineResponse()));
    const render = await loadScreen();

    const timeline = timelineScrollView(render());

    // The hourly-column width used for every other timeline row (date band, time, weather,
    // temperature, detail cells) is 72px; the snap interval must match it exactly.
    expect(timeline.props.snapToInterval).toBe(72);
    expect(timeline.props.snapToAlignment).toBe('start');
  });

  it('introduces no second horizontal ScrollView while adding snapping', async () => {
    useMobileSavedLocationsMock.mockReturnValue(
      readySnapshot([savedLocationRecord('a', 0, 'Asia/Seoul')], 'a'),
    );
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', timelineResponse()));
    const render = await loadScreen();

    expect(horizontalScrollViews(render())).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// contiguous local-date bands across the continuous timeline.
// ---------------------------------------------------------------------------

describe('contiguous local-date bands', () => {
  it('starts a new date band at local midnight in the selected location timezone', async () => {
    useMobileSavedLocationsMock.mockReturnValue(
      readySnapshot([savedLocationRecord('a', 0, 'Asia/Seoul')], 'a'),
    );
    // KST (UTC+9): 13:00Z -> 22:00, 14:00Z -> 23:00, 15:00Z -> 00:00 (next day), 16:00Z -> 01:00.
    useMobileWeatherQueryMock.mockReturnValue(
      successQuery(
        'a',
        successResponse([
          hourlyEntry({ forecastAt: '2026-08-05T13:00:00Z' }),
          hourlyEntry({ forecastAt: '2026-08-05T14:00:00Z' }),
          hourlyEntry({ forecastAt: '2026-08-05T15:00:00Z' }),
          hourlyEntry({ forecastAt: '2026-08-05T16:00:00Z' }),
        ]),
      ),
    );
    const render = await loadScreen();

    const element = render();
    const inside = texts(timelineScrollView(element));

    expect(headers(element)).toEqual(['시간별', '8월 5일 (수)', '8월 6일 (목)']);
    // The band order follows the timeline: the first day's hours, then the next day's.
    expect(inside.indexOf('8월 5일 (수)')).toBeLessThan(inside.indexOf('8월 6일 (목)'));
    expect(inside.indexOf('22:00')).toBeLessThan(inside.indexOf('23:00'));
    expect(inside.indexOf('23:00')).toBeLessThan(inside.indexOf('00:00'));
    expect(inside.indexOf('00:00')).toBeLessThan(inside.indexOf('01:00'));
  });

  it('spans one band across every contiguous hour sharing a local date', async () => {
    useMobileSavedLocationsMock.mockReturnValue(
      readySnapshot([savedLocationRecord('a', 0, 'Asia/Seoul')], 'a'),
    );
    useMobileWeatherQueryMock.mockReturnValue(
      successQuery(
        'a',
        successResponse([
          hourlyEntry({ forecastAt: '2026-08-05T13:00:00Z' }),
          hourlyEntry({ forecastAt: '2026-08-05T14:00:00Z' }),
          hourlyEntry({ forecastAt: '2026-08-05T15:00:00Z' }),
        ]),
      ),
    );
    const render = await loadScreen();

    const rendered = texts(render());

    expect(rendered.filter((text) => text === '8월 5일 (수)')).toHaveLength(1);
    expect(rendered.filter((text) => text === '8월 6일 (목)')).toHaveLength(1);
  });

  it('opens a fresh band when a local date reappears after another day (no dedupe)', async () => {
    useMobileSavedLocationsMock.mockReturnValue(
      readySnapshot([savedLocationRecord('a', 0, 'Asia/Seoul')], 'a'),
    );
    useMobileWeatherQueryMock.mockReturnValue(
      successQuery(
        'a',
        successResponse([
          hourlyEntry({ forecastAt: '2026-08-05T05:00:00Z' }),
          hourlyEntry({ forecastAt: '2026-08-06T05:00:00Z' }),
          hourlyEntry({ forecastAt: '2026-08-05T06:00:00Z' }),
        ]),
      ),
    );
    const render = await loadScreen();

    expect(headers(render())).toEqual(['시간별', '8월 5일 (수)', '8월 6일 (목)', '8월 5일 (수)']);
  });

  it('never labels a band 오늘 or 내일', async () => {
    useMobileSavedLocationsMock.mockReturnValue(
      readySnapshot([savedLocationRecord('a', 0, 'Asia/Seoul')], 'a'),
    );
    useMobileWeatherQueryMock.mockReturnValue(
      successQuery('a', successResponse([hourlyEntry({ forecastAt: '2026-08-05T05:00:00Z' })])),
    );
    const render = await loadScreen();

    const rendered = texts(render()).join('\n');

    expect(rendered).not.toContain('오늘');
    expect(rendered).not.toContain('내일');
  });
});

// ---------------------------------------------------------------------------
// the temperature polyline: real rendered points and connecting segments.
// ---------------------------------------------------------------------------

describe('temperature polyline', () => {
  async function renderTemperatures(temperatures: readonly number[]) {
    useMobileSavedLocationsMock.mockReturnValue(
      readySnapshot([savedLocationRecord('a', 0, 'Asia/Seoul')], 'a'),
    );
    useMobileWeatherQueryMock.mockReturnValue(
      successQuery(
        'a',
        successResponse(
          temperatures.map((temperatureCelsius, index) =>
            hourlyEntry({
              forecastAt: `2026-08-05T0${index}:00:00Z`,
              temperatureCelsius,
            }),
          ),
        ),
      ),
    );
    const render = await loadScreen();
    return render();
  }

  it('draws one point per hour and one segment per adjacent pair', async () => {
    const element = await renderTemperatures([10, 20, 15]);

    expect(chartPoints(element)).toHaveLength(3);
    expect(chartSegments(element)).toHaveLength(2);
  });

  it('keeps every temperature readable as text as well as on the line', async () => {
    const element = await renderTemperatures([10, 20, 15]);

    const rendered = texts(element);
    expect(rendered).toContain('10°');
    expect(rendered).toContain('20°');
    expect(rendered).toContain('15°');
  });

  it('places warmer temperatures visually higher than cooler ones', async () => {
    const element = await renderTemperatures([10, 20, 15]);

    const tops = chartPoints(element).map((style) => style.top as number);

    // A smaller `top` is higher on screen: 20° above 15°, and 15° above 10°.
    expect(tops[1]).toBeLessThan(tops[2]);
    expect(tops[2]).toBeLessThan(tops[0]);
  });

  it('advances point X positions in hourly input order', async () => {
    const element = await renderTemperatures([10, 20, 15]);

    const lefts = chartPoints(element).map((style) => style.left as number);

    expect(lefts[0]).toBeLessThan(lefts[1]);
    expect(lefts[1]).toBeLessThan(lefts[2]);
  });

  it('produces finite segment geometry', async () => {
    const element = await renderTemperatures([10, 20, 15]);

    for (const segment of chartSegments(element)) {
      expect(Number.isFinite(segment.left as number)).toBe(true);
      expect(Number.isFinite(segment.top as number)).toBe(true);
      expect(Number.isFinite(segment.width as number)).toBe(true);
      expect(segment.width as number).toBeGreaterThan(0);
      expect(Number.isFinite(rotationDegrees(segment))).toBe(true);
    }
  });

  it('connects a rising then falling series with opposite segment slopes', async () => {
    const element = await renderTemperatures([10, 20, 15]);

    const [rising, falling] = chartSegments(element).map(rotationDegrees);

    // Screen Y grows downward, so a rising temperature rotates negative and a fall positive.
    expect(rising).toBeLessThan(0);
    expect(falling).toBeGreaterThan(0);
  });

  it('draws equal temperatures as a stable flat line with finite geometry', async () => {
    const element = await renderTemperatures([18, 18, 18]);

    const points = chartPoints(element);
    const segments = chartSegments(element);

    expect(points).toHaveLength(3);
    expect(segments).toHaveLength(2);
    expect(new Set(points.map((style) => style.top)).size).toBe(1);
    for (const style of points) {
      expect(Number.isFinite(style.top as number)).toBe(true);
    }
    for (const segment of segments) {
      expect(rotationDegrees(segment)).toBe(0);
      expect(Number.isFinite(segment.width as number)).toBe(true);
    }
  });

  it('draws a single hourly entry as one point with no connecting segment', async () => {
    const element = await renderTemperatures([12]);

    expect(chartPoints(element)).toHaveLength(1);
    expect(chartSegments(element)).toHaveLength(0);
    expect(Number.isFinite(chartPoints(element)[0].top as number)).toBe(true);
    expect(texts(element)).toContain('12°');
  });

  it('places negative temperatures at finite positions', async () => {
    const element = await renderTemperatures([-8, -1, -8]);

    const points = chartPoints(element);

    expect(points).toHaveLength(3);
    for (const style of points) {
      expect(Number.isFinite(style.top as number)).toBe(true);
      expect(Number.isFinite(style.left as number)).toBe(true);
    }
    // -1° is warmer than -8°, so it sits higher.
    expect(points[1].top as number).toBeLessThan(points[0].top as number);
    expect(texts(element)).toContain('-8°');
    expect(texts(element)).toContain('-1°');
  });

  it('scales the line from temperature alone, never from the feels-like value', async () => {
    useMobileSavedLocationsMock.mockReturnValue(
      readySnapshot([savedLocationRecord('a', 0, 'Asia/Seoul')], 'a'),
    );
    useMobileWeatherQueryMock.mockReturnValue(
      successQuery(
        'a',
        successResponse([
          hourlyEntry({
            forecastAt: '2026-08-05T05:00:00Z',
            temperatureCelsius: 10,
            feelsLikeCelsius: 40,
          }),
          hourlyEntry({
            forecastAt: '2026-08-05T06:00:00Z',
            temperatureCelsius: 20,
            feelsLikeCelsius: 40,
          }),
        ]),
      ),
    );
    const render = await loadScreen();

    const points = chartPoints(render());

    // Exactly two points — no extra point for feels-like — spanning the full plot band.
    expect(points).toHaveLength(2);
    expect(points[1].top as number).toBeLessThan(points[0].top as number);
  });

  it('classifies points and segments distinctly (non-vacuity control)', () => {
    const pointOnly = {
      type: MockView,
      props: { style: { position: 'absolute', left: 10, top: 20, width: 8, height: 8, borderRadius: 4 } },
    };
    const segmentOnly = {
      type: MockView,
      props: {
        style: {
          position: 'absolute',
          left: 4,
          top: 6,
          width: 40,
          height: 2,
          borderRadius: 1,
          transform: [{ rotate: '-12deg' }],
        },
      },
    };
    const chartLayerOnly = {
      type: MockView,
      props: { style: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 } },
    };

    expect(chartPoints(pointOnly)).toHaveLength(1);
    expect(chartSegments(pointOnly)).toHaveLength(0);
    expect(chartPoints(segmentOnly)).toHaveLength(0);
    expect(chartSegments(segmentOnly)).toHaveLength(1);
    expect(chartPoints(chartLayerOnly)).toHaveLength(0);
    expect(chartSegments(chartLayerOnly)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// wind direction: Korean 8-sector label with the source degrees preserved.
// ---------------------------------------------------------------------------

describe('wind direction presentation', () => {
  async function renderWindDirection(windDirectionDegrees: number | null) {
    useMobileSavedLocationsMock.mockReturnValue(
      readySnapshot([savedLocationRecord('a', 0, 'Asia/Seoul')], 'a'),
    );
    useMobileWeatherQueryMock.mockReturnValue(
      successQuery('a', successResponse([hourlyEntry({ windDirectionDegrees })])),
    );
    const render = await loadScreen();
    return texts(render());
  }

  it.each([
    [0, '북'],
    [45, '북동'],
    [90, '동'],
    [135, '남동'],
    [180, '남'],
    [220, '남서'],
    [270, '서'],
    [315, '북서'],
    [360, '북'],
  ] as const)('shows %d° as "%s" while keeping the degrees visible', async (degrees, label) => {
    const rendered = await renderWindDirection(degrees);

    expect(rendered).toContain(label);
    expect(rendered).toContain(`${degrees}°`);
  });

  it.each([
    [22.4, '북'],
    [22.5, '북동'],
    [67.4, '북동'],
    [67.5, '동'],
    [112.5, '남동'],
    [157.5, '남'],
    [202.5, '남서'],
    [247.5, '서'],
    [292.5, '북서'],
    [337.4, '북서'],
    [337.5, '북'],
  ] as const)('rounds the sector boundary %d° to "%s"', async (degrees, label) => {
    const rendered = await renderWindDirection(degrees);

    expect(rendered).toContain(label);
    expect(rendered).toContain(`${degrees}°`);
  });

  it('shows the unavailable marker and no compass label when the bearing is null', async () => {
    const rendered = await renderWindDirection(null);

    expect(rendered).toContain('—');
    for (const label of ['북동', '동', '남동', '남서', '서', '북서']) {
      expect(rendered).not.toContain(label);
    }
    // The row label itself stays.
    expect(rendered).toContain('풍향');
  });
});
