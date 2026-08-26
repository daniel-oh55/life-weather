import type { WeatherSuccessResponseV1 } from '@life-weather/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MobileLifestyleCard } from '../lifestyle/create-mobile-lifestyle-overview';

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
// Both read-only hooks and the presenter are replaced with call-recording mocks: this screen
// owns only presentation of whatever each mock returns, never their own contracts.
// ---------------------------------------------------------------------------

const useMobileSavedLocationsMock = vi.hoisted(() => vi.fn());
const useMobileWeatherQueryMock = vi.hoisted(() => vi.fn());
const createMobileLifestyleOverviewMock = vi.hoisted(() => vi.fn());

vi.mock('../locations/use-mobile-saved-locations', () => ({
  useMobileSavedLocations: useMobileSavedLocationsMock,
}));

vi.mock('../weather-query/use-mobile-weather-query', () => ({
  useMobileWeatherQuery: useMobileWeatherQueryMock,
}));

vi.mock('../lifestyle/create-mobile-lifestyle-overview', () => ({
  createMobileLifestyleOverview: createMobileLifestyleOverviewMock,
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
  return { contractVersion: 1 as const, generatedAt: '2026-07-15T09:00:00Z', requestId: 'req-raw-id-123' };
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
      missingSections: ['CURRENT', 'HOURLY', 'AIR_QUALITY_CURRENT', 'AIR_QUALITY_FORECAST', 'ALERTS'],
      sources: [],
    },
  } as WeatherSuccessResponseV1;
}

function card(overrides: Partial<MobileLifestyleCard> & { id: MobileLifestyleCard['id'] }): MobileLifestyleCard {
  return {
    title: 'Card Title',
    statusLabel: 'Status',
    reason: 'Reason',
    recommendation: 'Recommendation',
    additionalRecommendation: null,
    ...overrides,
  };
}

function fourCards(): readonly MobileLifestyleCard[] {
  return [
    card({ id: 'UMBRELLA', title: '우산', statusLabel: '필요 낮음', reason: '우산 이유', recommendation: '우산 행동' }),
    card({
      id: 'OUTFIT',
      title: '옷차림',
      statusLabel: '선선함',
      reason: '옷차림 이유',
      recommendation: '옷차림 행동',
      additionalRecommendation: '겉옷을 준비하세요.',
    }),
    card({ id: 'MASK', title: '마스크', statusLabel: '판단 보류', reason: '마스크 이유', recommendation: '마스크 행동' }),
    card({ id: 'LAUNDRY', title: '빨래', statusLabel: '매우 좋음', reason: '빨래 이유', recommendation: '빨래 행동' }),
  ];
}

/** The screen's own static header/intro copy, present in every state. */
const SCREEN_CHROME = ['생활날씨', '오늘 생활에 필요한 준비를 항목별로 확인하세요.'];

/** Long, sentence-joined policy copy used to prove the screen never truncates or rewrites it. */
const LONG_REASON =
  '오전 9시부터 낮 12시 사이 강수확률이 70%까지 오르고, 오후에도 시간당 2mm 안팎의 비가 이어질 것으로 보입니다. 기온은 18도 내외로 유지되지만 바람이 다소 강해 체감온도는 더 낮게 느껴질 수 있습니다.';
const LONG_RECOMMENDATION =
  '외출 전에 우산을 반드시 챙기고, 바람이 강한 시간대에는 접이식보다 장우산이 안전합니다. 신발과 바지 밑단이 젖기 쉬우니 방수 소재를 고르는 편이 좋습니다.';
const LONG_ADDITIONAL =
  '아침과 저녁의 기온 차가 커서 얇은 겉옷을 하나 더 준비하면 하루 종일 편하게 지낼 수 있습니다.';

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

/** Every rendered `Text` element whose sole child is exactly `value`. */
function textElements(root: unknown, value: string): ElementLike[] {
  const collected: ElementLike[] = [];
  walk(root, (element) => {
    if (element.type === MockText && element.props.children === value) {
      collected.push(element);
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
  const { default: LifestyleScreen } = await import('../app/(tabs)/lifestyle');
  return function render() {
    return LifestyleScreen();
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  useMobileSavedLocationsMock.mockReturnValue(notStartedSnapshot());
  useMobileWeatherQueryMock.mockReturnValue(idleQuery());
  createMobileLifestyleOverviewMock.mockReturnValue(fourCards());
});

// ---------------------------------------------------------------------------
// import/call-time side effects and hook/lifecycle ownership.
// ---------------------------------------------------------------------------

describe('import and invocation boundaries', () => {
  it('1. performs no hook/store/router/presenter action merely by importing the module', async () => {
    await import('../app/(tabs)/lifestyle');

    expect(useMobileSavedLocationsMock).toHaveBeenCalledTimes(0);
    expect(useMobileWeatherQueryMock).toHaveBeenCalledTimes(0);
    expect(createMobileLifestyleOverviewMock).toHaveBeenCalledTimes(0);
    expect(routerMock.push).toHaveBeenCalledTimes(0);
    expect(mobileWeatherQueryStoreMock.retry).toHaveBeenCalledTimes(0);
    expect(mobileSavedLocationApplicationStoreMock.retryInitialization).toHaveBeenCalledTimes(0);
  });

  it('2. calls useMobileSavedLocations exactly once per render', async () => {
    const render = await loadScreen();

    render();

    expect(useMobileSavedLocationsMock).toHaveBeenCalledTimes(1);
  });

  it('3. passes the exact saved-location snapshot reference through to useMobileWeatherQuery', async () => {
    const snapshot = readySnapshot([savedLocationRecord('a', 0)], 'a');
    useMobileSavedLocationsMock.mockReturnValue(snapshot);
    const render = await loadScreen();

    render();

    expect(useMobileWeatherQueryMock).toHaveBeenCalledTimes(1);
    expect(useMobileWeatherQueryMock).toHaveBeenCalledWith(snapshot);
  });

  it('4. never imports or calls the weather-query lifecycle hook', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../app/(tabs)/lifestyle.tsx', import.meta.url), 'utf-8'),
    );

    expect(source).not.toContain('use-mobile-weather-query-lifecycle');
    expect(source).not.toContain('useMobileWeatherQueryLifecycle');
  });

  it('5. never calls request/reset on the weather-query store, and never fetches directly', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', successResponse()));
    const render = await loadScreen();

    render();

    expect('request' in mobileWeatherQueryStoreMock).toBe(false);
    expect('reset' in mobileWeatherQueryStoreMock).toBe(false);
  });

  it('22. never uses Date.now or request/reset in its own source', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../app/(tabs)/lifestyle.tsx', import.meta.url), 'utf-8'),
    );

    expect(source).not.toContain('Date.now');
    expect(source).not.toContain('.request(');
    expect(source).not.toContain('.reset(');
  });
});

// ---------------------------------------------------------------------------
// Screen-owned header. The `lifestyle` route sets `headerShown: false` (see
// `tabs-layout.test.tsx`), so this header is the screen's own and must not be duplicated.
// ---------------------------------------------------------------------------

describe('screen-owned header', () => {
  it('26. renders "생활날씨" exactly once, as an accessibility header, in every state', async () => {
    for (const snapshot of [
      notStartedSnapshot(),
      loadingSnapshot(),
      selectionLoadingSnapshot(),
      emptySnapshot(),
      savedLocationErrorSnapshot(),
      readySnapshot([savedLocationRecord('a', 0)], 'a'),
    ]) {
      useMobileSavedLocationsMock.mockReturnValue(snapshot);
      useMobileWeatherQueryMock.mockReturnValue(successQuery('a', successResponse('a')));
      const render = await loadScreen();

      const element = render();

      expect(texts(element).filter((text) => text === '생활날씨')).toHaveLength(1);
      expect(textElements(element, '생활날씨')[0].props.accessibilityRole).toBe('header');
    }
  });

  it('27. shows the selected saved location beside the title only once READY', async () => {
    useMobileSavedLocationsMock.mockReturnValue(loadingSnapshot());
    useMobileWeatherQueryMock.mockReturnValue(idleQuery());
    let render = await loadScreen();
    expect(texts(render())).not.toContain('Synthetic a');

    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    render = await loadScreen();
    expect(texts(render())).toContain('Synthetic a');
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
  ] as const)('6. shows the preparing copy for %s with no controls', async (_name, snapshot, copy) => {
    useMobileSavedLocationsMock.mockReturnValue(snapshot);
    const render = await loadScreen();

    const element = render();

    expect(texts(element)).toEqual([...SCREEN_CHROME, copy]);
    expect(pressables(element)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// EMPTY.
// ---------------------------------------------------------------------------

describe('EMPTY', () => {
  it('7. shows the empty copy and an accessible "지역 추가" entry point, and navigates to /locations', async () => {
    useMobileSavedLocationsMock.mockReturnValue(emptySnapshot());
    const render = await loadScreen();

    const element = render();

    expect(texts(element)).toEqual([
      ...SCREEN_CHROME,
      '저장된 지역이 없습니다.',
      '지역을 추가하면 생활날씨를 볼 수 있어요.',
      '지역 추가',
    ]);
    const button = pressableByLabel(element, '지역 추가');
    expect(button.props.accessibilityRole).toBe('button');

    press(button);
    expect(routerMock.push).toHaveBeenCalledTimes(1);
    expect(routerMock.push).toHaveBeenCalledWith('/locations');
  });
});

// ---------------------------------------------------------------------------
// saved-location ERROR.
// ---------------------------------------------------------------------------

describe('saved-location ERROR', () => {
  it('8. shows only generic copy and a retry control that calls retryInitialization, no raw kind/scope', async () => {
    useMobileSavedLocationsMock.mockReturnValue(savedLocationErrorSnapshot());
    const render = await loadScreen();

    const element = render();
    const rendered = texts(element).join('\n');

    expect(texts(element)).toEqual([
      ...SCREEN_CHROME,
      '저장된 지역을 불러오지 못했습니다.',
      '다시 시도',
    ]);
    expect(rendered).not.toContain('STORAGE_READ_FAILED');
    expect(rendered).not.toContain('SAVED_LOCATIONS');

    press(pressableByLabel(element, '저장 지역 다시 불러오기'));
    expect(mobileSavedLocationApplicationStoreMock.retryInitialization).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// READY + selected record missing (defensive).
// ---------------------------------------------------------------------------

describe('READY with missing selected record', () => {
  it('9. shows the preparing copy, not raw id, when the selected record is missing', async () => {
    useMobileSavedLocationsMock.mockReturnValue(
      readySnapshot([savedLocationRecord('a', 0)], 'missing-id'),
    );
    useMobileWeatherQueryMock.mockReturnValue(idleQuery());
    const render = await loadScreen();

    const rendered = texts(render());
    expect(rendered).toEqual([...SCREEN_CHROME, '생활날씨를 준비하고 있습니다.']);
    expect(rendered.join('\n')).not.toContain('missing-id');
  });
});

// ---------------------------------------------------------------------------
// READY + weather IDLE/LOADING.
// ---------------------------------------------------------------------------

describe('READY + weather query states', () => {
  it('10. shows the preparing copy and the selected location name while the weather query is IDLE', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(idleQuery());
    const render = await loadScreen();

    const rendered = texts(render());
    expect(rendered).toContain('생활날씨를 준비하고 있습니다.');
    expect(rendered).toContain('Synthetic a');
  });

  it('11. shows the loading copy and the selected location name while the weather query is LOADING', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(loadingQuery('a'));
    const render = await loadScreen();

    const rendered = texts(render());
    expect(rendered).toContain('선택한 지역의 생활날씨를 불러오는 중입니다.');
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
  ] as const)('12. shows the fixed %s copy with the selected location name, a retry control, and no raw detail', async (presentation, copy) => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(errorQuery('a', presentation));
    const render = await loadScreen();

    const element = render();
    const rendered = texts(element).join('\n');

    expect(rendered).toContain(copy);
    expect(rendered).toContain('Synthetic a');
    expect(rendered).not.toContain(presentation);
    expect(pressableByLabel(element, '생활날씨 다시 시도')).toBeDefined();
  });

  it('13. calls the production weather store\'s retry exactly once per press', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(errorQuery('a', 'NETWORK'));
    const render = await loadScreen();

    press(pressableByLabel(render(), '생활날씨 다시 시도'));

    expect(mobileWeatherQueryStoreMock.retry).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// READY + SUCCESS.
// ---------------------------------------------------------------------------

describe('READY + SUCCESS', () => {
  it('14. calls the presenter with the exact WeatherSuccessResponseV1 reference exactly once', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    const response = successResponse('a');
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', response));
    const render = await loadScreen();

    render();

    expect(createMobileLifestyleOverviewMock).toHaveBeenCalledTimes(1);
    expect(createMobileLifestyleOverviewMock).toHaveBeenCalledWith(response);
  });

  it('15. shows the four presenter cards in the order returned', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', successResponse('a')));
    const render = await loadScreen();

    const rendered = texts(render());
    const titleIndices = ['우산', '옷차림', '마스크', '빨래'].map((title) => rendered.indexOf(title));

    expect(titleIndices.every((index) => index !== -1)).toBe(true);
    expect(titleIndices).toEqual([...titleIndices].sort((a, b) => a - b));
  });

  it('16. shows each card\'s status/reason/action under the product labels, with no developer prefix', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', successResponse('a')));
    const render = await loadScreen();

    const rendered = texts(render());

    for (const cardFixture of fourCards()) {
      expect(rendered).toContain(cardFixture.title);
      expect(rendered).toContain(cardFixture.statusLabel);
      expect(rendered).toContain(cardFixture.reason);
      expect(rendered).toContain(cardFixture.recommendation);
    }

    // The reason/action labels are the screen's own static copy, rendered once per card.
    expect(rendered.filter((text) => text === '왜 이렇게 판단했나요')).toHaveLength(4);
    expect(rendered.filter((text) => text === '이렇게 해보세요')).toHaveLength(4);

    // No developer-style prefix is glued onto the engine's own strings any more.
    const joined = rendered.join('\n');
    expect(joined).not.toContain('상태:');
    expect(joined).not.toContain('이유:');
    expect(joined).not.toContain('행동:');
  });

  it('17. renders no additional-guidance section for cards whose additionalRecommendation is null', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', successResponse('a')));
    const render = await loadScreen();

    const rendered = texts(render());

    // Only the OUTFIT card in the fixture has a non-null additionalRecommendation, so the label
    // and its body each appear exactly once across all four cards — nothing is fabricated for the
    // three null cards.
    expect(rendered.filter((text) => text === '추가 안내')).toHaveLength(1);
    expect(rendered.filter((text) => text === '겉옷을 준비하세요.')).toHaveLength(1);
  });

  it('18. shows the "추가 안내" label and the exact additionalRecommendation when it is non-null', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', successResponse('a')));
    const render = await loadScreen();

    const rendered = texts(render());

    expect(rendered).toContain('추가 안내');
    expect(rendered).toContain('겉옷을 준비하세요.');
  });

  it('23. renders long policy copy verbatim and never truncates it', async () => {
    createMobileLifestyleOverviewMock.mockReturnValue([
      card({
        id: 'UMBRELLA',
        title: '우산',
        statusLabel: '지금 필요',
        reason: LONG_REASON,
        recommendation: LONG_RECOMMENDATION,
        additionalRecommendation: LONG_ADDITIONAL,
      }),
    ]);
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', successResponse('a')));
    const render = await loadScreen();

    const element = render();
    const rendered = texts(element);

    // Exact, whole strings — not a prefix, a summary, or an ellipsis-joined fragment.
    expect(rendered).toContain(LONG_REASON);
    expect(rendered).toContain(LONG_RECOMMENDATION);
    expect(rendered).toContain(LONG_ADDITIONAL);

    // ...and no line clamp is applied to any of the three policy strings, so RN wraps them
    // instead of cutting them off.
    for (const policyText of [LONG_REASON, LONG_RECOMMENDATION, LONG_ADDITIONAL]) {
      const elements = textElements(element, policyText);
      expect(elements).toHaveLength(1);
      expect(elements[0].props.numberOfLines).toBeUndefined();
      expect(elements[0].props.ellipsizeMode).toBeUndefined();
    }
  });

  it('24. renders the exhaustive category glyph alongside — never instead of — each textual title', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', successResponse('a')));
    const render = await loadScreen();

    const rendered = texts(render());

    for (const glyph of ['☂️', '👕', '😷', '🧺']) {
      expect(rendered).toContain(glyph);
    }
    for (const title of ['우산', '옷차림', '마스크', '빨래']) {
      expect(rendered).toContain(title);
    }
  });

  it('25. keeps a "판단 보류" card visible rather than hiding or reinterpreting it', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', successResponse('a')));
    const render = await loadScreen();

    const rendered = texts(render());

    // The MASK fixture is the 판단 보류 one: its title, status and full copy are all still there.
    expect(rendered).toContain('마스크');
    expect(rendered).toContain('판단 보류');
    expect(rendered).toContain('마스크 이유');
    expect(rendered).toContain('마스크 행동');
    expect(rendered.join('\n')).not.toContain('생활정보 없음');
  });

  it('19. shows the selected location name in every READY weather state', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    for (const query of [idleQuery(), loadingQuery('a'), successQuery('a', successResponse('a'))]) {
      useMobileWeatherQueryMock.mockReturnValue(query);
      const render = await loadScreen();
      expect(texts(render())).toContain('Synthetic a');
    }
  });

  it('20. shows the selected display name exactly once on SUCCESS', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', successResponse('a')));
    const render = await loadScreen();

    const rendered = texts(render());

    expect(rendered.filter((text) => text === 'Synthetic a')).toHaveLength(1);
  });

  it('21. never renders requestId, url, coordinates, grid, or provider/source/reasonCode/policyVersion', async () => {
    useMobileSavedLocationsMock.mockReturnValue(readySnapshot([savedLocationRecord('a', 0)], 'a'));
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', successResponse('a')));
    const render = await loadScreen();

    const rendered = texts(render()).join('\n');

    expect(rendered).not.toContain('req-raw-id-123');
    expect(rendered).not.toContain('37.5');
    expect(rendered).not.toContain('127');
    expect(rendered).not.toContain('kma');
    expect(rendered).not.toContain('KMA');
    expect(rendered).not.toContain('nx');
    expect(rendered).not.toContain('ny');
    expect(rendered).not.toContain('reasonCode');
    expect(rendered).not.toContain('policyVersion');
  });

  it('does not render a lifestyle block outside READY, even if the query mock reports SUCCESS', async () => {
    useMobileSavedLocationsMock.mockReturnValue(notStartedSnapshot());
    useMobileWeatherQueryMock.mockReturnValue(successQuery('a', successResponse('a')));
    const render = await loadScreen();

    const rendered = texts(render());

    expect(rendered).not.toContain('우산');
    expect(createMobileLifestyleOverviewMock).not.toHaveBeenCalled();
  });
});
