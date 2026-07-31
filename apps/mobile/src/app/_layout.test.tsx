import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// The native AsyncStorage module is replaced with an in-memory, call-recording mock so the real
// persistence / hydration-manager / application-store / startup code can run unmodified against
// it, exactly as `mobile-saved-location-hydration-production.test.ts` does.
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
// `react`'s `useEffect` is replaced with a capturing stub so the test can inspect how many mount
// effects `RootLayout` registers and invoke the captured callback on demand, without a renderer or
// DOM. Every other `react` export (used by the automatic JSX runtime) stays the real
// implementation.
// ---------------------------------------------------------------------------

interface CapturedEffect {
  readonly callback: () => void | (() => void);
  readonly deps: readonly unknown[] | undefined;
}

const capturedEffects = vi.hoisted(() => [] as CapturedEffect[]);
const useEffectMock = vi.hoisted(() => vi.fn());

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useEffect: useEffectMock };
});

// ---------------------------------------------------------------------------
// `expo-router`'s `Stack` is replaced with a minimal marker component so the test can assert
// `RootLayout` still returns a `<Stack />` element without loading real navigation.
// ---------------------------------------------------------------------------

const MockStack = vi.hoisted(() => function MockStack(): null {
  return null;
});

vi.mock('expo-router', () => ({
  Stack: MockStack,
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  capturedEffects.length = 0;
  useEffectMock.mockImplementation(
    (callback: () => void | (() => void), deps?: readonly unknown[]) => {
      capturedEffects.push({ callback, deps });
    },
  );
  asyncStorageMock.getItem.mockResolvedValue(null);
  asyncStorageMock.setItem.mockResolvedValue(undefined);
  asyncStorageMock.removeItem.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1/2/3/4 — importing `_layout` and calling the component performs no storage I/O, still returns a
// `<Stack />` element, registers exactly one mount effect, and both boundaries report their initial
// not-yet-started state before that effect has run.
// ---------------------------------------------------------------------------

describe('RootLayout call', () => {
  it('returns Stack, registers exactly one mount effect, and performs no storage I/O before the effect runs', async () => {
    const { default: RootLayout } = await import('./_layout');
    const { Stack } = await import('expo-router');
    const { mobileSavedLocationHydrationManager } = await import(
      '../locations/mobile-saved-location-hydration-production'
    );
    const { mobileSavedLocationApplicationStore } = await import(
      '../locations/mobile-saved-location-application-production'
    );

    const element = RootLayout();

    expect(element.type).toBe(Stack);
    expect(useEffectMock).toHaveBeenCalledTimes(1);
    expect(capturedEffects).toHaveLength(1);
    expect(capturedEffects[0]?.deps).toEqual([]);
    expect(mobileSavedLocationHydrationManager.getState()).toEqual({ status: 'NOT_STARTED' });
    expect(mobileSavedLocationApplicationStore.getSnapshot()).toEqual({
      status: 'NOT_STARTED',
      writeStatus: 'IDLE',
    });
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.removeItem).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// 5/6/7/8/9/10 — running the captured mount effect hydrates saved locations, then initializes the
// selected-location preference, via the two stable keys, exactly once each across repeated effect
// execution; no write/remove call is ever made; the callback never returns a cleanup function; and
// nothing is logged to the console.
// ---------------------------------------------------------------------------

describe('mount effect execution', () => {
  it('runs saved-location hydration then selected-location initialization exactly once and logs nothing', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});

    const { default: RootLayout } = await import('./_layout');
    const { SAVED_LOCATION_PERSISTENCE_KEY, SELECTED_LOCATION_PERSISTENCE_KEY } = await import(
      '../locations'
    );
    const { mobileSavedLocationHydrationManager } = await import(
      '../locations/mobile-saved-location-hydration-production'
    );
    const { mobileSavedLocationApplicationStore } = await import(
      '../locations/mobile-saved-location-application-production'
    );
    const { startMobileLocationApplicationOnce } = await import(
      '../locations/mobile-location-application-startup'
    );

    RootLayout();
    const effect = capturedEffects[0];
    if (effect === undefined) {
      throw new Error('expected RootLayout to have registered exactly one mount effect');
    }

    const cleanupFromFirstRun = effect.callback();
    expect(cleanupFromFirstRun).toBeUndefined();

    // Join the same startup promise the effect kicked off, rather than starting a new one.
    await startMobileLocationApplicationOnce();

    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(2);
    expect(asyncStorageMock.getItem).toHaveBeenCalledWith(SAVED_LOCATION_PERSISTENCE_KEY);
    expect(asyncStorageMock.getItem).toHaveBeenCalledWith(SELECTED_LOCATION_PERSISTENCE_KEY);
    expect(mobileSavedLocationHydrationManager.getState()).toEqual({ status: 'EMPTY' });
    expect(mobileSavedLocationApplicationStore.getSnapshot()).toEqual({
      status: 'EMPTY',
      selectedLocationId: null,
      writeStatus: 'IDLE',
    });

    const cleanupFromSecondRun = effect.callback();
    expect(cleanupFromSecondRun).toBeUndefined();
    await startMobileLocationApplicationOnce();

    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(2);
    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(0);
    expect(asyncStorageMock.removeItem).toHaveBeenCalledTimes(0);

    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleInfo).not.toHaveBeenCalled();
  });

  it('does not start selected-location initialization when saved-location hydration fails', async () => {
    asyncStorageMock.getItem.mockRejectedValueOnce(new Error('synthetic storage failure'));

    const { default: RootLayout } = await import('./_layout');
    const { mobileSavedLocationApplicationStore } = await import(
      '../locations/mobile-saved-location-application-production'
    );
    const { startMobileLocationApplicationOnce } = await import(
      '../locations/mobile-location-application-startup'
    );

    RootLayout();
    const effect = capturedEffects[0];
    if (effect === undefined) {
      throw new Error('expected RootLayout to have registered exactly one mount effect');
    }
    effect.callback();
    await startMobileLocationApplicationOnce();

    expect(mobileSavedLocationApplicationStore.getSnapshot()).toEqual({
      status: 'ERROR',
      error: { scope: 'SAVED_LOCATIONS', kind: 'STORAGE_READ_FAILED' },
      writeStatus: 'IDLE',
    });
    // Only the one saved-location read was attempted — no selected-location read followed the
    // saved-location failure.
    expect(asyncStorageMock.getItem).toHaveBeenCalledTimes(1);
  });
});
