import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// `react-native` primitives are replaced with minimal marker components, matching the other
// app-tests files, so each placeholder screen can be invoked as a plain function without a
// renderer.
// ---------------------------------------------------------------------------

const MockView = vi.hoisted(() => function MockView(): null {
  return null;
});
const MockText = vi.hoisted(() => function MockText(): null {
  return null;
});

vi.mock('react-native', () => ({
  View: MockView,
  Text: MockText,
  StyleSheet: { create: (styles: unknown) => styles },
}));

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

beforeEach(() => {
  vi.resetModules();
});

describe.each([
  ['lifestyle', '../app/(tabs)/lifestyle', '생활날씨', '생활날씨 화면을 준비하고 있습니다.'],
  ['details', '../app/(tabs)/details', '상세기상', '상세 기상정보 화면을 준비하고 있습니다.'],
  ['settings', '../app/(tabs)/settings', '설정', '설정 화면을 준비하고 있습니다.'],
] as const)('%s placeholder screen', (_name, modulePath, title, body) => {
  it('renders its own title and preparing-copy, with no other text', async () => {
    const { default: Screen } = await import(modulePath);

    const element = Screen();

    expect(texts(element)).toEqual([title, body]);
  });
});
