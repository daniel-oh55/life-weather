import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MobileSavedLocation, SavedLocationApplicationSnapshot } from '../locations';

// ---------------------------------------------------------------------------
// `react`'s `useSyncExternalStore` is replaced with a minimal fake so the hook can be called as a
// plain function (there is no real renderer/dispatcher in this Node-based setup). `useEffect` is
// replaced with a call-recording spy only to prove this read-only hook never calls it — the hook
// itself no longer imports `useEffect` at all, and this guards against that regressing.
// ---------------------------------------------------------------------------

const useSyncExternalStoreMock = vi.hoisted(() => vi.fn());
const useEffectMock = vi.hoisted(() => vi.fn());

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useSyncExternalStore: useSyncExternalStoreMock,
    useEffect: useEffectMock,
  };
});

// ---------------------------------------------------------------------------
// The production weather-query store is replaced with a call-recording mock: this hook test
// verifies only *what* the hook reads/returns and that it never dispatches `request`/`retry`/
// `reset`, never the store's own state machine (covered by `mobile-weather-query-store.test.ts`) or
// the request/reset lifecycle decision (covered by `use-mobile-weather-query-lifecycle.test.ts`).
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
// Synthetic fixtures.
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

function loading(): SavedLocationApplicationSnapshot {
  return { status: 'LOADING', writeStatus: 'IDLE' };
}
function ready(
  locations: readonly MobileSavedLocation[],
  selectedLocationId: string,
): SavedLocationApplicationSnapshot {
  return { status: 'READY', locations, selectedLocationId, writeStatus: 'IDLE' };
}

async function loadHook() {
  const { useMobileWeatherQuery } = await import('./use-mobile-weather-query');
  return useMobileWeatherQuery;
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
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
// Subscription contract: stable module-scope subscribe/getSnapshot, same getter for client/server.
// ---------------------------------------------------------------------------

describe('subscription', () => {
  it('subscribes via useSyncExternalStore with the same getter for client and server snapshots', async () => {
    const useMobileWeatherQuery = await loadHook();

    useMobileWeatherQuery(ready([record('a', 0)], 'a'));

    expect(useSyncExternalStoreMock).toHaveBeenCalledTimes(1);
    const [subscribeArg, getSnapshotArg, getServerSnapshotArg] =
      useSyncExternalStoreMock.mock.calls[0] as [unknown, unknown, unknown];
    expect(getSnapshotArg).toBe(getServerSnapshotArg);

    useMobileWeatherQuery(ready([record('a', 0)], 'a'));

    const [subscribeArg2, getSnapshotArg2] = useSyncExternalStoreMock.mock.calls[1] as [
      unknown,
      unknown,
    ];
    expect(subscribeArg2).toBe(subscribeArg);
    expect(getSnapshotArg2).toBe(getSnapshotArg);
  });

  it("delegates subscribe/getSnapshot to the production store's own methods", async () => {
    const useMobileWeatherQuery = await loadHook();
    useMobileWeatherQuery(ready([record('a', 0)], 'a'));
    const [subscribeArg, getSnapshotArg] = useSyncExternalStoreMock.mock.calls[0] as [
      (listener: () => void) => () => void,
      () => unknown,
    ];

    const listener = () => {};
    subscribeArg(listener);
    expect(mobileWeatherQueryStoreMock.subscribe).toHaveBeenCalledWith(listener);

    getSnapshotArg();
    expect(mobileWeatherQueryStoreMock.getSnapshot).toHaveBeenCalledTimes(2); // once by the mock impl above, once here
  });
});

// ---------------------------------------------------------------------------
// This hook owns no lifecycle: no `useEffect`, no `request`/`retry`/`reset` dispatch, ever.
// ---------------------------------------------------------------------------

describe('no lifecycle ownership', () => {
  it('never calls useEffect', async () => {
    const useMobileWeatherQuery = await loadHook();

    useMobileWeatherQuery(ready([record('a', 0)], 'a'));

    expect(useEffectMock).toHaveBeenCalledTimes(0);
  });

  it('never dispatches request/reset/retry on the store', async () => {
    const useMobileWeatherQuery = await loadHook();

    useMobileWeatherQuery(ready([record('a', 0)], 'a'));
    useMobileWeatherQuery(loading());

    expect(mobileWeatherQueryStoreMock.request).toHaveBeenCalledTimes(0);
    expect(mobileWeatherQueryStoreMock.reset).toHaveBeenCalledTimes(0);
    expect(mobileWeatherQueryStoreMock.retry).toHaveBeenCalledTimes(0);
  });

  it('two independent consumers reading the same snapshot dispatch no request/reset', async () => {
    const useMobileWeatherQuery = await loadHook();
    const snapshot = ready([record('a', 0)], 'a');

    useMobileWeatherQuery(snapshot);
    useMobileWeatherQuery(snapshot);
    useMobileWeatherQuery(snapshot);

    expect(mobileWeatherQueryStoreMock.request).toHaveBeenCalledTimes(0);
    expect(mobileWeatherQueryStoreMock.reset).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// Correlation guard: synthetic IDLE unless the store snapshot correlates to the selected id.
// ---------------------------------------------------------------------------

describe('correlation guard', () => {
  it('returns synthetic IDLE whenever savedLocations is not READY, regardless of the store snapshot', async () => {
    mobileWeatherQueryStoreMock.getSnapshot.mockReturnValue({
      status: 'SUCCESS',
      locationId: 'a',
      data: {},
    });
    const useMobileWeatherQuery = await loadHook();

    const result = useMobileWeatherQuery(loading());

    expect(result).toEqual({ status: 'IDLE' });
  });

  it('returns synthetic IDLE when the store itself is IDLE', async () => {
    mobileWeatherQueryStoreMock.getSnapshot.mockReturnValue({ status: 'IDLE' });
    const useMobileWeatherQuery = await loadHook();

    const result = useMobileWeatherQuery(ready([record('a', 0)], 'a'));

    expect(result).toEqual({ status: 'IDLE' });
  });

  it('returns synthetic IDLE when the store snapshot correlates to a different location', async () => {
    mobileWeatherQueryStoreMock.getSnapshot.mockReturnValue({
      status: 'SUCCESS',
      locationId: 'stale-location',
      data: {},
    });
    const useMobileWeatherQuery = await loadHook();

    const result = useMobileWeatherQuery(ready([record('a', 0)], 'a'));

    expect(result).toEqual({ status: 'IDLE' });
  });

  it('returns the exact store snapshot reference once it correlates to the selected id', async () => {
    const successSnapshot = { status: 'SUCCESS', locationId: 'a', data: {} };
    mobileWeatherQueryStoreMock.getSnapshot.mockReturnValue(successSnapshot);
    const useMobileWeatherQuery = await loadHook();

    const result = useMobileWeatherQuery(ready([record('a', 0)], 'a'));

    expect(result).toBe(successSnapshot);
  });

  it('returns a stable synthetic IDLE reference across independent non-correlating calls', async () => {
    const useMobileWeatherQuery = await loadHook();

    const first = useMobileWeatherQuery(loading());
    const second = useMobileWeatherQuery(ready([record('a', 0)], 'a'));

    expect(first).toBe(second);
  });
});
