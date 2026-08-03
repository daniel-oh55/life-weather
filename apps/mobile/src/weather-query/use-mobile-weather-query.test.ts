import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MobileSavedLocation, SavedLocationApplicationSnapshot } from '../locations';

// ---------------------------------------------------------------------------
// `react`'s `useSyncExternalStore` and `useEffect` are replaced with minimal fakes so the hook can
// be called as a plain function (there is no real renderer/dispatcher in this Node-based setup),
// exactly as `_layout.test.tsx` and `index.test.tsx` already do for their own hooks. `useEffect` is
// captured rather than auto-run: each test decides for itself when a captured effect (and its
// returned cleanup) actually executes, the same way React would decide based on the dependency
// array — which is itself asserted directly in the "no additional request" test below.
// ---------------------------------------------------------------------------

interface CapturedEffect {
  readonly callback: () => void | (() => void);
  readonly deps: readonly unknown[] | undefined;
}

const capturedEffects = vi.hoisted(() => [] as CapturedEffect[]);
const useEffectMock = vi.hoisted(() => vi.fn());
const useSyncExternalStoreMock = vi.hoisted(() => vi.fn());

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useEffect: useEffectMock,
    useSyncExternalStore: useSyncExternalStoreMock,
  };
});

// ---------------------------------------------------------------------------
// The production weather-query store is replaced with a call-recording mock: this hook test
// verifies only *when* the hook calls `request`/`retry`/`reset` and what it returns, never the
// store's own state machine (covered by `mobile-weather-query-store.test.ts`).
// ---------------------------------------------------------------------------

const mobileWeatherQueryStoreMock = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  subscribe: vi.fn(),
  request: vi.fn(),
  retry: vi.fn(),
  reset: vi.fn(),
}));

vi.mock('./mobile-weather-query-production', () => ({
  mobileWeatherQueryStore: mobileWeatherQueryStoreMock,
}));

// ---------------------------------------------------------------------------
// Synthetic fixtures. `../locations` (the real, pure, provider-neutral barrel — no native module)
// runs unmodified so `createWeatherRequestFromSavedLocation`'s real mapping/validation is exercised.
// ---------------------------------------------------------------------------

function record(id: string, sortOrder: number): MobileSavedLocation {
  return {
    id,
    displayName: `Synthetic ${id}`,
    countryCode: 'KR',
    adminArea1: 'Synthetic Province',
    adminArea2: 'Synthetic District',
    adminArea3: null,
    latitude: 37.5,
    longitude: 127.0,
    timezone: 'Asia/Seoul',
    kmaGrid: { nx: 60, ny: 127 },
    isCurrent: false,
    sortOrder,
  };
}

function notStarted(): SavedLocationApplicationSnapshot {
  return { status: 'NOT_STARTED', writeStatus: 'IDLE' };
}
function loading(): SavedLocationApplicationSnapshot {
  return { status: 'LOADING', writeStatus: 'IDLE' };
}
function selectionLoading(): SavedLocationApplicationSnapshot {
  return { status: 'SELECTION_LOADING', writeStatus: 'IDLE' };
}
function empty(): SavedLocationApplicationSnapshot {
  return { status: 'EMPTY', selectedLocationId: null, writeStatus: 'IDLE' };
}
function ready(
  locations: readonly MobileSavedLocation[],
  selectedLocationId: string,
): SavedLocationApplicationSnapshot {
  return { status: 'READY', locations, selectedLocationId, writeStatus: 'IDLE' };
}
function errorSnapshot(): SavedLocationApplicationSnapshot {
  return {
    status: 'ERROR',
    error: { scope: 'SAVED_LOCATIONS', kind: 'STORAGE_READ_FAILED' },
    writeStatus: 'IDLE',
  };
}

function latestEffect(): CapturedEffect {
  const effect = capturedEffects[capturedEffects.length - 1];
  if (effect === undefined) {
    throw new Error('expected an effect to have been captured');
  }
  return effect;
}

async function loadHook() {
  const { useMobileWeatherQuery } = await import('./use-mobile-weather-query');
  return useMobileWeatherQuery;
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  capturedEffects.length = 0;
  useEffectMock.mockImplementation(
    (callback: () => void | (() => void), deps?: readonly unknown[]) => {
      capturedEffects.push({ callback, deps });
    },
  );
  useSyncExternalStoreMock.mockImplementation(
    (
      _subscribe: (onStoreChange: () => void) => () => void,
      getSnapshot: () => unknown,
      _getServerSnapshot?: () => unknown,
    ) => getSnapshot(),
  );
  mobileWeatherQueryStoreMock.getSnapshot.mockReturnValue({ status: 'IDLE' });
  mobileWeatherQueryStoreMock.subscribe.mockReturnValue(() => {});
});

// ---------------------------------------------------------------------------
// No request while saved-location application isn't a validated READY selection.
// ---------------------------------------------------------------------------

describe('no request outside a validated READY selection', () => {
  it.each([
    ['NOT_STARTED', notStarted],
    ['LOADING', loading],
    ['SELECTION_LOADING', selectionLoading],
    ['EMPTY', empty],
    ['ERROR', errorSnapshot],
  ] as const)('requests 0 times for %s', async (_label, build) => {
    const useMobileWeatherQuery = await loadHook();

    useMobileWeatherQuery(build());
    latestEffect().callback();

    expect(mobileWeatherQueryStoreMock.request).toHaveBeenCalledTimes(0);
  });

  it('requests 0 times and resets when the selected id is not present in locations', async () => {
    const useMobileWeatherQuery = await loadHook();
    const snapshot = ready([record('a', 0)], 'missing-id');

    const result = useMobileWeatherQuery(snapshot);
    latestEffect().callback();

    expect(mobileWeatherQueryStoreMock.request).toHaveBeenCalledTimes(0);
    expect(mobileWeatherQueryStoreMock.reset).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: 'IDLE' });
  });

  it('requests 0 times and resets when the selected record fails request mapping (broken READY invariant)', async () => {
    const useMobileWeatherQuery = await loadHook();
    const brokenRecord = { ...record('a', 0), latitude: 'not-a-number' } as unknown as MobileSavedLocation;
    const snapshot = ready([brokenRecord], 'a');

    const result = useMobileWeatherQuery(snapshot);
    expect(() => latestEffect().callback()).not.toThrow();

    expect(mobileWeatherQueryStoreMock.request).toHaveBeenCalledTimes(0);
    expect(mobileWeatherQueryStoreMock.reset).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: 'IDLE' });
  });
});

// ---------------------------------------------------------------------------
// A validated READY selection requests exactly once, with exactly the shared fields.
// ---------------------------------------------------------------------------

describe('a validated READY selection', () => {
  it('requests exactly once with the mapped WeatherRequestV1, dropping local-only fields', async () => {
    const useMobileWeatherQuery = await loadHook();
    const snapshot = ready([record('a', 0)], 'a');

    useMobileWeatherQuery(snapshot);
    latestEffect().callback();

    expect(mobileWeatherQueryStoreMock.request).toHaveBeenCalledTimes(1);
    const call = mobileWeatherQueryStoreMock.request.mock.calls[0] as [{ location: { id: string } }];
    expect(call[0].location.id).toBe('a');
    expect(Object.keys(call[0].location).sort()).toEqual(
      [
        'adminArea1',
        'adminArea2',
        'adminArea3',
        'countryCode',
        'displayName',
        'id',
        'latitude',
        'longitude',
        'timezone',
      ].sort(),
    );
    expect(call[0].location).not.toHaveProperty('kmaGrid');
    expect(call[0].location).not.toHaveProperty('isCurrent');
    expect(call[0].location).not.toHaveProperty('sortOrder');
  });

  it('does not request again when only a non-selected location changes (same status/selectedId)', async () => {
    const useMobileWeatherQuery = await loadHook();
    const first = ready([record('a', 0), record('b', 1)], 'a');
    const second = ready([record('a', 0), record('b', 1), record('c', 2)], 'a');

    useMobileWeatherQuery(first);
    latestEffect().callback();
    expect(mobileWeatherQueryStoreMock.request).toHaveBeenCalledTimes(1);

    useMobileWeatherQuery(second);
    // The dependency array is the semantic key only, so a real React would see it unchanged and
    // never re-invoke the effect factory — this hook never re-requests for the same selection.
    expect(latestEffect().deps).toEqual(capturedEffects[0]?.deps);
    expect(mobileWeatherQueryStoreMock.request).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Selection change, unmount, and correlation guard.
// ---------------------------------------------------------------------------

describe('cleanup and correlation', () => {
  it("resets/aborts A's query before requesting B's when the selection changes", async () => {
    const useMobileWeatherQuery = await loadHook();
    const readyA = ready([record('a', 0), record('b', 1)], 'a');
    const readyB = ready([record('a', 0), record('b', 1)], 'b');

    useMobileWeatherQuery(readyA);
    const cleanupA = latestEffect().callback();
    expect(mobileWeatherQueryStoreMock.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ location: expect.objectContaining({ id: 'a' }) }),
    );

    cleanupA?.();
    expect(mobileWeatherQueryStoreMock.reset).toHaveBeenCalledTimes(1);

    useMobileWeatherQuery(readyB);
    latestEffect().callback();
    expect(mobileWeatherQueryStoreMock.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ location: expect.objectContaining({ id: 'b' }) }),
    );
  });

  it('resets/aborts on unmount', async () => {
    const useMobileWeatherQuery = await loadHook();
    const snapshot = ready([record('a', 0)], 'a');

    useMobileWeatherQuery(snapshot);
    const cleanup = latestEffect().callback();
    cleanup?.();

    expect(mobileWeatherQueryStoreMock.reset).toHaveBeenCalledTimes(1);
  });

  it('resets when leaving READY, even mid-flight (via the previous effect\'s own cleanup)', async () => {
    const useMobileWeatherQuery = await loadHook();
    useMobileWeatherQuery(ready([record('a', 0)], 'a'));
    const cleanup = latestEffect().callback();

    useMobileWeatherQuery(loading());
    // Real React runs the previous effect's cleanup before the new (non-READY) effect body.
    cleanup?.();
    latestEffect().callback();

    expect(mobileWeatherQueryStoreMock.reset).toHaveBeenCalledTimes(1);
    expect(mobileWeatherQueryStoreMock.request).toHaveBeenCalledTimes(1);
  });

  it('returns IDLE in the render window before the store snapshot correlates to the selected id', async () => {
    mobileWeatherQueryStoreMock.getSnapshot.mockReturnValue({
      status: 'SUCCESS',
      locationId: 'stale-location',
      data: {},
    });
    const useMobileWeatherQuery = await loadHook();

    const result = useMobileWeatherQuery(ready([record('a', 0)], 'a'));

    expect(result).toEqual({ status: 'IDLE' });
  });

  it('returns the real store snapshot once it correlates to the selected id', async () => {
    const successSnapshot = { status: 'SUCCESS', locationId: 'a', data: {} };
    mobileWeatherQueryStoreMock.getSnapshot.mockReturnValue(successSnapshot);
    const useMobileWeatherQuery = await loadHook();

    const result = useMobileWeatherQuery(ready([record('a', 0)], 'a'));

    expect(result).toBe(successSnapshot);
  });

  it('returns IDLE whenever savedLocations is not READY, regardless of the store snapshot', async () => {
    mobileWeatherQueryStoreMock.getSnapshot.mockReturnValue({
      status: 'SUCCESS',
      locationId: 'a',
      data: {},
    });
    const useMobileWeatherQuery = await loadHook();

    const result = useMobileWeatherQuery(loading());

    expect(result).toEqual({ status: 'IDLE' });
  });
});
