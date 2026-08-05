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

vi.mock('react-native', () => ({
  View: MockView,
  Text: MockText,
  Pressable: MockPressable,
  ScrollView: MockScrollView,
  StyleSheet: { create: (styles: unknown) => styles },
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

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  useRouterMock.mockReturnValue(routerMock);
  constantsMock.expoConfig = null;
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

  it('shows the four section headings in order: 지역 → 단위 → 데이터 출처 → 앱 정보', async () => {
    const render = await loadScreen();

    const element = render();

    const headerTexts = headers(element).map((header) => header.props.children);
    expect(headerTexts).toEqual(['설정', '지역', '단위', '데이터 출처', '앱 정보']);
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
    expect(rendered).toContain('지역 선택과 삭제는 오늘 화면에서 할 수 있습니다.');
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

  it('shows AirKorea as planned-only, never as currently provided', async () => {
    const rendered = texts((await loadScreen())());

    expect(rendered).toContain('대기질: 에어코리아 연동 예정');
    expect(rendered).not.toContain('에어코리아 제공');
    expect(rendered).not.toContain('대기질 정보: 에어코리아');
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
// Legal/operator information and forbidden controls are absent.
// ---------------------------------------------------------------------------

describe('no legal/operator/forbidden content', () => {
  it('never shows a URL, mailto link, support email, package id, or ad/EAS id', async () => {
    const rendered = texts((await loadScreen())()).join('\n');

    expect(rendered).not.toContain('http://');
    expect(rendered).not.toContain('https://');
    expect(rendered).not.toContain('mailto:');
    expect(rendered).not.toContain('@');
  });

  it('never imports or calls Linking, fetch, storage, or weather hooks', async () => {
    const source = await readSource();

    expect(source).not.toContain('Linking');
    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('AsyncStorage');
    expect(source).not.toContain('weather-query');
    expect(source).not.toContain('saved-location');
    expect(source).not.toContain('http://');
    expect(source).not.toContain('https://');
    expect(source).not.toContain('mailto:');
  });

  it('renders no privacy/ad/notification/widget controls', async () => {
    const rendered = texts((await loadScreen())()).join('\n');

    expect(rendered).not.toContain('개인정보');
    expect(rendered).not.toContain('광고');
    expect(rendered).not.toContain('알림');
    expect(rendered).not.toContain('위젯');
  });

  it('renders exactly one pressable: "지역 추가"', async () => {
    const render = await loadScreen();

    const buttons = pressables(render());

    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.props.accessibilityLabel).toBe('지역 추가');
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
