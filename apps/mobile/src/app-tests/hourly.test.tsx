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

  it('shows every optional field, including a zero value, when not null', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(
      successQuery(
        'a',
        successResponse([
          hourlyEntry({
            feelsLikeCelsius: 19,
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

    expect(rendered).toContain('체감 19°');
    expect(rendered).toContain('강수 0%');
    expect(rendered).toContain('강수량 0mm');
    expect(rendered).toContain('적설 0cm');
    expect(rendered).toContain('습도 0%');
    expect(rendered).toContain('바람 0m/s');
    expect(rendered).toContain('풍향 0°');
  });

  it('hides every optional field label when it is null', async () => {
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

    const rendered = texts(render()).join('\n');

    expect(rendered).not.toContain('체감');
    expect(rendered).not.toContain('강수 ');
    expect(rendered).not.toContain('강수량');
    expect(rendered).not.toContain('적설');
    expect(rendered).not.toContain('습도');
    expect(rendered).not.toContain('바람');
    expect(rendered).not.toContain('풍향');
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
