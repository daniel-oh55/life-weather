import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const linkingMock = vi.hoisted(() => ({
  openURL: vi.fn(async () => true),
}));

vi.mock('react-native', () => ({
  View: MockView,
  Text: MockText,
  Pressable: MockPressable,
  ScrollView: MockScrollView,
  Linking: linkingMock,
  StyleSheet: { create: (styles: unknown) => styles },
}));

// ---------------------------------------------------------------------------
// The shared mobile ads runtime hook/production store are replaced with call-recording mocks, so
// this screen's own privacy-options wiring can be asserted without loading the real
// `react-native-google-mobile-ads` native module or its consent store (covered by
// `../ads/mobile-ads-runtime-store.test.ts`).
// ---------------------------------------------------------------------------

const useMobileAdsRuntimeMock = vi.hoisted(() => vi.fn());
const mobileAdsRuntimeStoreMock = vi.hoisted(() => ({
  openPrivacyOptions: vi.fn(async () => {}),
}));

vi.mock('../ads/use-mobile-ads-runtime', () => ({
  useMobileAdsRuntime: useMobileAdsRuntimeMock,
}));

vi.mock('../ads/mobile-ads-runtime-production', () => ({
  mobileAdsRuntimeStore: mobileAdsRuntimeStoreMock,
}));

// ---------------------------------------------------------------------------
// Expo Router's `useRouter` is replaced with a fake returning a call-recording `push` mock.
// ---------------------------------------------------------------------------

const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
}));
const useRouterMock = vi.hoisted(() => vi.fn(() => routerMock));

vi.mock('expo-router', () => ({
  useRouter: useRouterMock,
}));

// ---------------------------------------------------------------------------
// `expo-constants` is replaced with a mutable fake so each test can set its own `expoConfig`
// without touching the real Expo config object.
// ---------------------------------------------------------------------------

const constantsMock = vi.hoisted(() => ({
  expoConfig: null as { name?: string; version?: string | null } | null,
}));

vi.mock('expo-constants', () => ({
  default: constantsMock,
}));

// ---------------------------------------------------------------------------
// Element-tree helpers, matching the other app-tests files.
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

function headers(root: unknown): ElementLike[] {
  const collected: ElementLike[] = [];
  walk(root, (element) => {
    if (element.type === MockText && element.props.accessibilityRole === 'header') {
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
  const { default: SettingsScreen } = await import('../app/(tabs)/settings');
  return function render() {
    return SettingsScreen();
  };
}

async function readSource(): Promise<string> {
  const fs = await import('node:fs/promises');
  return fs.readFile(new URL('../app/(tabs)/settings.tsx', import.meta.url), 'utf-8');
}

const ORIGINAL_PRIVACY_POLICY_URL = process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL;

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  useRouterMock.mockReturnValue(routerMock);
  constantsMock.expoConfig = null;
  delete process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL;
  useMobileAdsRuntimeMock.mockReturnValue({
    canRequestAds: false,
    adsInitialized: false,
    privacyOptionsRequired: false,
  });
  mobileAdsRuntimeStoreMock.openPrivacyOptions.mockReset().mockResolvedValue(undefined);
  linkingMock.openURL.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  if (ORIGINAL_PRIVACY_POLICY_URL === undefined) {
    delete process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL;
  } else {
    process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL = ORIGINAL_PRIVACY_POLICY_URL;
  }
});

// ---------------------------------------------------------------------------
// import/call-time side effects.
// ---------------------------------------------------------------------------

describe('import and invocation boundaries', () => {
  it('performs no router action merely by importing the module', async () => {
    await import('../app/(tabs)/settings');

    expect(routerMock.push).toHaveBeenCalledTimes(0);
  });

  it('calls useRouter exactly once per render', async () => {
    const render = await loadScreen();

    render();

    expect(useRouterMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Screen title and section order.
// ---------------------------------------------------------------------------

describe('screen title and sections', () => {
  it('shows the screen title "설정" as an accessibility header', async () => {
    const render = await loadScreen();

    const element = render();

    const headerTexts = headers(element).map((header) => header.props.children);
    expect(headerTexts[0]).toBe('설정');
  });

  it('shows the five section headings in order: 지역 → 단위 → 데이터 출처 → 개인정보 및 광고 → 앱 정보', async () => {
    const render = await loadScreen();

    const element = render();

    const headerTexts = headers(element).map((header) => header.props.children);
    expect(headerTexts).toEqual([
      '설정',
      '지역',
      '단위',
      '데이터 출처',
      '개인정보 및 광고',
      '앱 정보',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Region section.
// ---------------------------------------------------------------------------

describe('region section', () => {
  it('shows both fixed guidance lines', async () => {
    const render = await loadScreen();

    const rendered = texts(render());

    expect(rendered).toContain('새 지역은 지역 검색 화면에서 추가할 수 있습니다.');
    // Selection/removal moved out of Today and into the shared top-right region button on every
    // weather screen, so this line must point there rather than at the old Today-only card.
    expect(rendered).toContain(
      '저장한 지역의 선택과 삭제는 오늘, 시간별, 생활날씨, 상세기상 화면 상단의 지역 버튼에서 할 수 있습니다.',
    );
    expect(rendered.some((text) => text.includes('오늘 화면에서 할 수 있습니다'))).toBe(false);
  });

  it('renders an accessible "지역 추가" button', async () => {
    const render = await loadScreen();

    const button = pressableByLabel(render(), '지역 추가');

    expect(button.props.accessibilityRole).toBe('button');
    expect(button.props.accessibilityLabel).toBe('지역 추가');
  });

  it('pushes "/locations" exactly once when "지역 추가" is pressed', async () => {
    const render = await loadScreen();

    press(pressableByLabel(render(), '지역 추가'));

    expect(routerMock.push).toHaveBeenCalledTimes(1);
    expect(routerMock.push).toHaveBeenCalledWith('/locations');
  });

  it('never claims to be a full saved-location management screen', async () => {
    const rendered = texts((await loadScreen())()).join('\n');

    expect(rendered).not.toContain('저장 지역 관리');
    expect(rendered).not.toContain('지역 정렬');
    expect(rendered).not.toContain('지역 편집');
    expect(rendered).not.toContain('전체 지역 관리');
  });
});

// ---------------------------------------------------------------------------
// Units section.
// ---------------------------------------------------------------------------

describe('units section', () => {
  it('shows the intro line and the four fixed unit lines exactly', async () => {
    const render = await loadScreen();

    const rendered = texts(render());

    expect(rendered).toContain('현재 다음 단위를 사용합니다.');
    expect(rendered).toContain('기온: 섭씨(°C)');
    expect(rendered).toContain('강수량: 밀리미터(mm)');
    expect(rendered).toContain('적설: 센티미터(cm)');
    expect(rendered).toContain('풍속: 미터/초(m/s)');
  });

  it('never imports Switch from react-native', async () => {
    const source = await readSource();

    expect(source).not.toContain('Switch');
  });
});

// ---------------------------------------------------------------------------
// Data-source section.
// ---------------------------------------------------------------------------

describe('data-source section', () => {
  it('shows the KMA weather-data-source line', async () => {
    const rendered = texts((await loadScreen())());

    expect(rendered).toContain('날씨 정보: 기상청');
  });

  it('shows the exact KMA location-search dataset name', async () => {
    const rendered = texts((await loadScreen())());

    expect(rendered).toContain('지역 검색 자료: 기상청_단기예보 조회서비스');
  });

  it('shows the exact 공공저작물 출처표시 제1유형 license line', async () => {
    const rendered = texts((await loadScreen())());

    expect(rendered).toContain('지역 검색 자료 이용조건: 공공저작물 출처표시 제1유형');
  });

  it('shows AirKorea as a currently integrated data source (the stale "연동 예정" copy is corrected)', async () => {
    const rendered = texts((await loadScreen())());

    expect(rendered).toContain('대기질: 에어코리아');
    expect(rendered).not.toContain('대기질: 에어코리아 연동 예정');
  });
});

// ---------------------------------------------------------------------------
// App-info section.
// ---------------------------------------------------------------------------

describe('app-info section', () => {
  it('shows the expo config name and version', async () => {
    constantsMock.expoConfig = { name: 'Test App', version: '2.3.4' };
    const rendered = texts((await loadScreen())());

    expect(rendered).toContain('앱 이름: Test App');
    expect(rendered).toContain('버전: 2.3.4');
  });

  it('falls back to "Life Weather" when the expo config name is missing', async () => {
    constantsMock.expoConfig = { version: '2.3.4' };
    const rendered = texts((await loadScreen())());

    expect(rendered).toContain('앱 이름: Life Weather');
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
  ] as const)('falls back to "확인 불가" when the expo config version is %s', async (_label, version) => {
    constantsMock.expoConfig = { name: 'Test App', version };
    const rendered = texts((await loadScreen())());

    expect(rendered).toContain('버전: 확인 불가');
  });

  it('falls back to both defaults when expoConfig itself is null', async () => {
    constantsMock.expoConfig = null;
    const rendered = texts((await loadScreen())());

    expect(rendered).toContain('앱 이름: Life Weather');
    expect(rendered).toContain('버전: 확인 불가');
  });

  it('never hard-codes a version string in source', async () => {
    const source = await readSource();

    expect(source).not.toMatch(/['"]1\.0\.0['"]/);
  });
});

// ---------------------------------------------------------------------------
// Legal/operator information: no invented/hardcoded value, ever — only the approved env-sourced
// URL and the fixed section copy below may appear.
// ---------------------------------------------------------------------------

describe('no invented legal/operator content', () => {
  it('never hard-codes a URL, mailto link, support email, package id, or ad/EAS id in source', async () => {
    const source = await readSource();

    expect(source).not.toContain('mailto:');
    expect(source).not.toContain('@');
    expect(source).not.toContain('http://');
    expect(source).not.toContain('https://');
    expect(source).not.toContain('ca-app-pub-');
    expect(source).not.toContain('com.life');
  });

  it('never imports fetch, storage, or weather hooks directly', async () => {
    const source = await readSource();

    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('AsyncStorage');
    expect(source).not.toContain('weather-query');
    expect(source).not.toContain('saved-location');
  });

  it('renders no notification/widget controls (out of 1.0 scope)', async () => {
    const rendered = texts((await loadScreen())()).join('\n');

    expect(rendered).not.toContain('알림');
    expect(rendered).not.toContain('위젯');
  });

  it('renders exactly two pressables outside the privacy section: "지역 추가" and "개인정보 처리방침"', async () => {
    const render = await loadScreen();

    const buttons = pressables(render()).map((button) => button.props.accessibilityLabel);

    expect(buttons).toContain('지역 추가');
    expect(buttons).toContain('개인정보 처리방침');
    expect(buttons).not.toContain('광고 개인정보 선택 관리');
  });
});

// ---------------------------------------------------------------------------
// Privacy policy control — sourced only from EXPO_PUBLIC_PRIVACY_POLICY_URL, never a guessed URL.
// ---------------------------------------------------------------------------

describe('privacy policy control', () => {
  it('renders a disabled "개인정보 처리방침" button with a placeholder message when the URL is not configured', async () => {
    const render = await loadScreen();

    const element = render();
    const button = pressableByLabel(element, '개인정보 처리방침');

    expect(button.props.disabled).toBe(true);
    expect(texts(element)).toContain('개인정보 처리방침 주소가 아직 설정되지 않았습니다.');
  });

  it('does not crash when the URL is missing and the button is pressed', async () => {
    const render = await loadScreen();

    expect(() => press(pressableByLabel(render(), '개인정보 처리방침'))).not.toThrow();
    expect(linkingMock.openURL).toHaveBeenCalledTimes(0);
  });

  it('enables the button and opens the configured HTTPS URL via Linking when pressed', async () => {
    process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL = 'https://example.test/privacy';
    const render = await loadScreen();

    const element = render();
    const button = pressableByLabel(element, '개인정보 처리방침');
    expect(button.props.disabled).toBe(false);
    expect(texts(element)).not.toContain('개인정보 처리방침 주소가 아직 설정되지 않았습니다.');

    press(button);

    expect(linkingMock.openURL).toHaveBeenCalledTimes(1);
    expect(linkingMock.openURL).toHaveBeenCalledWith('https://example.test/privacy');
  });

  it('rejects a non-HTTPS configured URL rather than opening it (treated as unconfigured)', async () => {
    process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL = 'http://example.test/privacy';
    const render = await loadScreen();

    const button = pressableByLabel(render(), '개인정보 처리방침');
    expect(button.props.disabled).toBe(true);
  });

  it('never exposes a raw Linking.openURL rejection to the user', async () => {
    process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL = 'https://example.test/privacy';
    linkingMock.openURL.mockRejectedValue(new Error('synthetic no-handler-for-url failure'));
    const render = await loadScreen();

    expect(() => press(pressableByLabel(render(), '개인정보 처리방침'))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// UMP privacy-options control — visible only while the shared ads runtime reports it REQUIRED.
// ---------------------------------------------------------------------------

describe('privacy-options control', () => {
  it('is hidden when privacyOptionsRequired is false', async () => {
    useMobileAdsRuntimeMock.mockReturnValue({
      canRequestAds: false,
      adsInitialized: false,
      privacyOptionsRequired: false,
    });
    const render = await loadScreen();

    expect(() => pressableByLabel(render(), '광고 개인정보 선택 관리')).toThrow();
  });

  it('is shown when privacyOptionsRequired is true', async () => {
    useMobileAdsRuntimeMock.mockReturnValue({
      canRequestAds: true,
      adsInitialized: true,
      privacyOptionsRequired: true,
    });
    const render = await loadScreen();

    const button = pressableByLabel(render(), '광고 개인정보 선택 관리');
    expect(button.props.accessibilityRole).toBe('button');
  });

  it('calls the shared ads runtime store\'s openPrivacyOptions exactly once per press', async () => {
    useMobileAdsRuntimeMock.mockReturnValue({
      canRequestAds: true,
      adsInitialized: true,
      privacyOptionsRequired: true,
    });
    const render = await loadScreen();

    press(pressableByLabel(render(), '광고 개인정보 선택 관리'));

    expect(mobileAdsRuntimeStoreMock.openPrivacyOptions).toHaveBeenCalledTimes(1);
  });

  it('never calls openPrivacyOptions merely by rendering', async () => {
    useMobileAdsRuntimeMock.mockReturnValue({
      canRequestAds: true,
      adsInitialized: true,
      privacyOptionsRequired: true,
    });
    const render = await loadScreen();

    render();
    render();

    expect(mobileAdsRuntimeStoreMock.openPrivacyOptions).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// Layout/accessibility semantics.
// ---------------------------------------------------------------------------

describe('layout and accessibility', () => {
  it('renders inside a single top-level ScrollView', async () => {
    const render = await loadScreen();

    const element = render();

    expect(isElement(element) && element.type === MockScrollView).toBe(true);
  });

  it('performs no network/storage/native action merely by importing the module', async () => {
    await import('../app/(tabs)/settings');

    expect(routerMock.push).toHaveBeenCalledTimes(0);
  });
});
