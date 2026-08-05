import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// `expo-router`'s `Tabs` is replaced with a minimal marker component (plus a `.Screen`
// sub-component) so the test can assert the declared tab routes and their options without loading
// real navigation.
// ---------------------------------------------------------------------------

const MockTabs = vi.hoisted(() => {
  function MockTabs(): null {
    return null;
  }
  MockTabs.Screen = function MockTabsScreen(): null {
    return null;
  };
  return MockTabs;
});

vi.mock('expo-router', () => ({
  Tabs: MockTabs,
}));

interface ElementLike {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
}

function isElement(node: unknown): node is ElementLike {
  return typeof node === 'object' && node !== null && 'type' in node && 'props' in node;
}

describe('(tabs) layout', () => {
  it('returns Tabs with exactly the 5 documented routes and their Korean titles, no side effects', async () => {
    const { default: TabsLayout } = await import('../app/(tabs)/_layout');
    const { Tabs } = await import('expo-router');

    const element = TabsLayout();

    expect(element.type).toBe(Tabs);

    const rawChildren = element.props.children;
    const children: unknown[] = Array.isArray(rawChildren) ? rawChildren : [rawChildren];
    const screens = children.filter(isElement);

    expect(screens).toHaveLength(5);
    expect(screens.every((screen) => screen.type === Tabs.Screen)).toBe(true);

    const optionsByName = new Map(
      screens.map((screen) => [screen.props.name as string, screen.props.options]),
    );
    expect([...optionsByName.keys()]).toEqual(['index', 'hourly', 'lifestyle', 'details', 'settings']);
    expect(optionsByName.get('index')).toMatchObject({ title: '오늘' });
    expect(optionsByName.get('hourly')).toMatchObject({ title: '시간별' });
    expect(optionsByName.get('lifestyle')).toMatchObject({ title: '생활날씨' });
    expect(optionsByName.get('details')).toMatchObject({ title: '상세기상' });
    expect(optionsByName.get('settings')).toMatchObject({ title: '설정' });
  });
});
