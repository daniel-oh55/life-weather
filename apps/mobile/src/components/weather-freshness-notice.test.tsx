import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// `react-native` primitives are replaced with minimal marker components, matching the other
// component/screen tests, so `WeatherFreshnessNotice` can be invoked as a plain function without a
// renderer.
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

vi.mock('react-native', () => ({
  View: MockView,
  Text: MockText,
  Pressable: MockPressable,
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));

// ---------------------------------------------------------------------------
// `react`'s `useState` and `useEffect` are replaced so the component can be invoked as a plain
// function (there is no real renderer/dispatcher in this Node-based setup):
// - `useState` uses a minimal slot table that persists across repeated `render()` calls, the same
//   approach `app-tests/index.test.tsx` uses, so a `setState` call inside a captured effect is
//   visible on the next `render()`.
// - `useEffect` is captured rather than auto-run, matching `use-mobile-weather-query-lifecycle.test.ts`:
//   each test decides for itself when the captured effect (and its returned cleanup) runs.
// ---------------------------------------------------------------------------

interface CapturedEffect {
  readonly callback: () => void | (() => void);
  readonly deps: readonly unknown[] | undefined;
}

const capturedEffects = vi.hoisted(() => [] as CapturedEffect[]);
const useEffectMock = vi.hoisted(() => vi.fn());
const useStateMock = vi.hoisted(() => vi.fn());

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: useStateMock,
    useEffect: useEffectMock,
  };
});

// ---------------------------------------------------------------------------
// Element-tree helpers, matching the other component/screen tests.
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

function press(element: ElementLike): void {
  (element.props.onPress as () => void)();
}

function latestEffect(): CapturedEffect {
  const effect = capturedEffects[capturedEffects.length - 1];
  if (effect === undefined) {
    throw new Error('expected an effect to have been captured');
  }
  return effect;
}

// ---------------------------------------------------------------------------
// Fixed synthetic "now" for every test. `vi.useFakeTimers()` fakes `Date` as well as
// `setTimeout`/`clearTimeout`, so `Date.now()` inside the component reads this system time.
// ---------------------------------------------------------------------------

const NOW_ISO = '2026-07-15T12:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
const ONE_HOUR_MS = 60 * 60 * 1000;

let hookSlots: unknown[] = [];
let hookCursor = 0;

async function loadComponent() {
  const mod = await import('./weather-freshness-notice');
  return mod.WeatherFreshnessNotice;
}

function isoAgo(millisecondsAgo: number): string {
  return new Date(NOW_MS - millisecondsAgo).toISOString();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  capturedEffects.length = 0;
  hookSlots = [];
  hookCursor = 0;

  useEffectMock.mockImplementation(
    (callback: () => void | (() => void), deps?: readonly unknown[]) => {
      capturedEffects.push({ callback, deps });
    },
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
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// classifyMobileWeatherFreshness — pure classifier matrix.
// ---------------------------------------------------------------------------

describe('classifyMobileWeatherFreshness', () => {
  it('classifies 59m59s ago as FRESH', async () => {
    const { classifyMobileWeatherFreshness } = await import('./weather-freshness-notice');
    const generatedAt = isoAgo(ONE_HOUR_MS - 1000);

    expect(classifyMobileWeatherFreshness(generatedAt, NOW_MS)).toBe('FRESH');
  });

  it('classifies exactly 60m ago as STALE', async () => {
    const { classifyMobileWeatherFreshness } = await import('./weather-freshness-notice');
    const generatedAt = isoAgo(ONE_HOUR_MS);

    expect(classifyMobileWeatherFreshness(generatedAt, NOW_MS)).toBe('STALE');
  });

  it('classifies more than 60m ago as STALE', async () => {
    const { classifyMobileWeatherFreshness } = await import('./weather-freshness-notice');
    const generatedAt = isoAgo(ONE_HOUR_MS + 60_000);

    expect(classifyMobileWeatherFreshness(generatedAt, NOW_MS)).toBe('STALE');
  });

  it('classifies a future generatedAt as FRESH (tolerates clock skew)', async () => {
    const { classifyMobileWeatherFreshness } = await import('./weather-freshness-notice');
    const generatedAt = new Date(NOW_MS + 5 * 60 * 1000).toISOString();

    expect(classifyMobileWeatherFreshness(generatedAt, NOW_MS)).toBe('FRESH');
  });

  it('classifies an invalid generatedAt as STALE, defensively', async () => {
    const { classifyMobileWeatherFreshness } = await import('./weather-freshness-notice');

    expect(classifyMobileWeatherFreshness('not-a-timestamp', NOW_MS)).toBe('STALE');
  });

  it('classifies a non-finite reference time as STALE, defensively', async () => {
    const { classifyMobileWeatherFreshness } = await import('./weather-freshness-notice');

    expect(classifyMobileWeatherFreshness(isoAgo(0), Number.NaN)).toBe('STALE');
    expect(classifyMobileWeatherFreshness(isoAgo(0), Number.POSITIVE_INFINITY)).toBe('STALE');
  });

  it('is deterministic for the same input/reference pair', async () => {
    const { classifyMobileWeatherFreshness } = await import('./weather-freshness-notice');
    const generatedAt = isoAgo(30 * 60 * 1000);

    const first = classifyMobileWeatherFreshness(generatedAt, NOW_MS);
    const second = classifyMobileWeatherFreshness(generatedAt, NOW_MS);

    expect(first).toBe(second);
  });

  it('never throws on a malformed generatedAt', async () => {
    const { classifyMobileWeatherFreshness } = await import('./weather-freshness-notice');

    expect(() => classifyMobileWeatherFreshness('', NOW_MS)).not.toThrow();
    expect(() => classifyMobileWeatherFreshness('🙂', NOW_MS)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// WeatherFreshnessNotice — visibility.
// ---------------------------------------------------------------------------

describe('visibility', () => {
  it('renders nothing (null) for a fresh generatedAt', async () => {
    const WeatherFreshnessNotice = await loadComponent();
    const onRefresh = vi.fn();

    const element = WeatherFreshnessNotice({ generatedAt: isoAgo(0), onRefresh });

    expect(element).toBeNull();
  });

  it('renders the stale notice for a generatedAt at/over the threshold', async () => {
    const WeatherFreshnessNotice = await loadComponent();
    const onRefresh = vi.fn();

    const element = WeatherFreshnessNotice({ generatedAt: isoAgo(ONE_HOUR_MS), onRefresh });

    expect(texts(element)).toContain('마지막 날씨 업데이트가 1시간 이상 지났어요.');
    expect(pressables(element).map((p) => p.props.accessibilityLabel)).toContain('날씨 새로고침');
  });

  it('renders only the fixed notice copy and refresh button — no other content is fabricated', async () => {
    const WeatherFreshnessNotice = await loadComponent();
    const onRefresh = vi.fn();

    const element = WeatherFreshnessNotice({ generatedAt: isoAgo(ONE_HOUR_MS), onRefresh });

    expect(texts(element)).toEqual(['마지막 날씨 업데이트가 1시간 이상 지났어요.', '새로고침']);
    expect(pressables(element)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// One-shot presentation timer.
// ---------------------------------------------------------------------------

describe('one-shot timer', () => {
  it('schedules exactly one timer, never an interval, when mounted fresh', async () => {
    const WeatherFreshnessNotice = await loadComponent();
    const onRefresh = vi.fn();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    WeatherFreshnessNotice({ generatedAt: isoAgo(0), onRefresh });
    latestEffect().callback();

    expect(vi.getTimerCount()).toBe(1);
    expect(setIntervalSpy).toHaveBeenCalledTimes(0);
  });

  it('transitions from FRESH to STALE exactly at the 60-minute boundary, with no polling', async () => {
    const WeatherFreshnessNotice = await loadComponent();
    const onRefresh = vi.fn();
    const generatedAt = isoAgo(0);

    function render() {
      hookCursor = 0;
      return WeatherFreshnessNotice({ generatedAt, onRefresh });
    }

    expect(render()).toBeNull();
    latestEffect().callback();
    expect(vi.getTimerCount()).toBe(1);

    // Not yet at the boundary: still fresh, and the single timer has not fired.
    vi.advanceTimersByTime(ONE_HOUR_MS - 1000);
    expect(render()).toBeNull();

    // Crossing the exact boundary fires the one scheduled timer and nothing else.
    vi.advanceTimersByTime(1000);
    expect(vi.getTimerCount()).toBe(0);
    const element = render();
    expect(texts(element)).toContain('마지막 날씨 업데이트가 1시간 이상 지났어요.');
  });

  it('schedules a single same-tick (0ms) confirmation timer when mounted already stale — never a poll', async () => {
    const WeatherFreshnessNotice = await loadComponent();
    const onRefresh = vi.fn();

    const element = WeatherFreshnessNotice({
      generatedAt: isoAgo(ONE_HOUR_MS + 60_000),
      onRefresh,
    });
    expect(texts(element)).toContain('마지막 날씨 업데이트가 1시간 이상 지났어요.');

    const cleanup = latestEffect().callback();
    expect(vi.getTimerCount()).toBe(1);

    // Firing it only confirms the already-correct STALE state; it never becomes a second timer.
    vi.runOnlyPendingTimers();
    expect(vi.getTimerCount()).toBe(0);
    cleanup?.();
  });

  it('clears the timer on unmount (the effect cleanup)', async () => {
    const WeatherFreshnessNotice = await loadComponent();
    const onRefresh = vi.fn();

    WeatherFreshnessNotice({ generatedAt: isoAgo(0), onRefresh });
    const cleanup = latestEffect().callback();
    expect(vi.getTimerCount()).toBe(1);

    cleanup?.();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('generatedAt change STALE -> FRESH: the stale notice disappears for the new timestamp without waiting for its own deadline', async () => {
    const WeatherFreshnessNotice = await loadComponent();
    const onRefresh = vi.fn();

    function render(generatedAt: string) {
      hookCursor = 0;
      return WeatherFreshnessNotice({ generatedAt, onRefresh });
    }

    const oldGeneratedAt = isoAgo(ONE_HOUR_MS + 60_000);
    expect(texts(render(oldGeneratedAt))).toContain('마지막 날씨 업데이트가 1시간 이상 지났어요.');
    const firstCleanup = latestEffect().callback();
    expect(vi.getTimerCount()).toBe(1);

    // React runs the previous effect's cleanup before the new effect body on a prop change.
    firstCleanup?.();
    expect(vi.getTimerCount()).toBe(0);

    const newGeneratedAt = isoAgo(0);
    render(newGeneratedAt);
    latestEffect().callback();
    expect(vi.getTimerCount()).toBe(1);

    // The new effect's same-tick reconcile timer corrects the visible freshness for the new (fresh)
    // timestamp immediately — no waiting for its own future stale deadline.
    vi.runOnlyPendingTimers();
    expect(render(newGeneratedAt)).toBeNull();
    expect(vi.getTimerCount()).toBe(1); // exactly one new deadline timer now armed

    // Advancing to the new 60-minute boundary makes it stale again, with no auto-refresh.
    vi.advanceTimersByTime(ONE_HOUR_MS);
    expect(texts(render(newGeneratedAt))).toContain('마지막 날씨 업데이트가 1시간 이상 지났어요.');
    expect(onRefresh).toHaveBeenCalledTimes(0);
  });

  it('generatedAt change FRESH -> already-STALE: the stale notice becomes visible for the new timestamp immediately', async () => {
    const WeatherFreshnessNotice = await loadComponent();
    const onRefresh = vi.fn();

    function render(generatedAt: string) {
      hookCursor = 0;
      return WeatherFreshnessNotice({ generatedAt, onRefresh });
    }

    const oldGeneratedAt = isoAgo(0);
    expect(render(oldGeneratedAt)).toBeNull();
    const firstCleanup = latestEffect().callback();
    expect(vi.getTimerCount()).toBe(1);

    firstCleanup?.();
    expect(vi.getTimerCount()).toBe(0);

    const newGeneratedAt = isoAgo(ONE_HOUR_MS + 60_000);
    render(newGeneratedAt);
    latestEffect().callback();
    expect(vi.getTimerCount()).toBe(1);

    // The new effect's same-tick reconcile timer corrects the visible freshness for the new
    // (already-stale) timestamp immediately, and arms no further timer.
    vi.runOnlyPendingTimers();
    expect(texts(render(newGeneratedAt))).toContain('마지막 날씨 업데이트가 1시간 이상 지났어요.');
    expect(vi.getTimerCount()).toBe(0);
    expect(onRefresh).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// Refresh remains explicit-only: the presentation timer may change what is visible, but it must
// never itself invoke `onRefresh`. Only the button press does.
// ---------------------------------------------------------------------------

describe('refresh is explicit only', () => {
  it('the FRESH -> STALE deadline timer never calls onRefresh; only the explicit button press does', async () => {
    const WeatherFreshnessNotice = await loadComponent();
    const onRefresh = vi.fn();
    const generatedAt = isoAgo(0);

    function render() {
      hookCursor = 0;
      return WeatherFreshnessNotice({ generatedAt, onRefresh });
    }

    expect(render()).toBeNull();
    latestEffect().callback();
    expect(vi.getTimerCount()).toBe(1);

    // Crossing the boundary flips the presentation to STALE without any refresh call.
    vi.advanceTimersByTime(ONE_HOUR_MS);
    expect(onRefresh).toHaveBeenCalledTimes(0);

    const element = render();
    const button = pressables(element).find(
      (p) => p.props.accessibilityLabel === '날씨 새로고침',
    );
    expect(button).toBeDefined();

    // Only the explicit press invokes onRefresh.
    press(button!);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('the same-tick (0ms) confirmation timer for an already-stale mount never calls onRefresh', async () => {
    const WeatherFreshnessNotice = await loadComponent();
    const onRefresh = vi.fn();

    WeatherFreshnessNotice({ generatedAt: isoAgo(ONE_HOUR_MS + 60_000), onRefresh });
    latestEffect().callback();
    expect(vi.getTimerCount()).toBe(1);

    vi.runOnlyPendingTimers();

    expect(onRefresh).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// Refresh button.
// ---------------------------------------------------------------------------

describe('refresh button', () => {
  it('calls onRefresh exactly once per press', async () => {
    const WeatherFreshnessNotice = await loadComponent();
    const onRefresh = vi.fn();

    const element = WeatherFreshnessNotice({ generatedAt: isoAgo(ONE_HOUR_MS), onRefresh });
    const button = pressables(element).find(
      (p) => p.props.accessibilityLabel === '날씨 새로고침',
    );
    expect(button).toBeDefined();

    press(button!);

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('exposes a >=48dp touch target and a non-empty accessibility label', async () => {
    const WeatherFreshnessNotice = await loadComponent();
    const onRefresh = vi.fn();

    const element = WeatherFreshnessNotice({ generatedAt: isoAgo(ONE_HOUR_MS), onRefresh });
    const button = pressables(element)[0];

    expect(button?.props.accessibilityRole).toBe('button');
    expect(button?.props.accessibilityLabel).toBe('날씨 새로고침');
    const style = button?.props.style as { minHeight: number; minWidth: number };
    expect(style.minHeight).toBeGreaterThanOrEqual(48);
    expect(style.minWidth).toBeGreaterThanOrEqual(48);
  });
});
