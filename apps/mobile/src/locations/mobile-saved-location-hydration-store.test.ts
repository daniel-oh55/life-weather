import { describe, expect, it, vi } from 'vitest';

import {
  createSavedLocationHydrationStore,
  type MobileSavedLocation,
  type SavedLocationHydrationManager,
  type SavedLocationHydrationState,
} from './index';

// ---------------------------------------------------------------------------
// Synthetic fixtures. Every value is fabricated — no real user location, stored place, or device
// identifier is used anywhere in this file.
// ---------------------------------------------------------------------------

const SECRET_MARKER = 'SYNTHETIC_HYDRATION_STORE_SECRET_MUST_NOT_LEAK';

function sharedFields(id: string) {
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
  };
}

/** A fresh, valid saved-location record. Every call returns a brand-new object graph. */
function record(id: string, overrides: Partial<MobileSavedLocation> = {}): MobileSavedLocation {
  return {
    ...sharedFields(id),
    kmaGrid: { nx: 60, ny: 127 },
    isCurrent: false,
    sortOrder: 0,
    ...overrides,
  };
}

/** Deep-clone one record — a fresh top-level object and a fresh non-null `kmaGrid`. */
function cloneRecord(location: MobileSavedLocation): MobileSavedLocation {
  return {
    ...location,
    kmaGrid: location.kmaGrid === null ? null : { ...location.kmaGrid },
  };
}

/** Clone a hydration state the way the real manager does: a fresh top-level object every time. */
function cloneState(state: SavedLocationHydrationState): SavedLocationHydrationState {
  switch (state.status) {
    case 'READY':
      return { status: 'READY', locations: state.locations.map(cloneRecord) };
    case 'ERROR':
      return { status: 'ERROR', error: { kind: state.error.kind } };
    default:
      return { status: state.status };
  }
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * A fully scriptable fake {@link SavedLocationHydrationManager}. `getState()` always returns a
 * fresh clone of whatever `setState` last recorded (mirroring the real manager's reference-safety
 * contract). `hydrate()` is a bare `vi.fn()` — each test supplies its own `mockImplementation` (or
 * `mockReturnValue`) so it can script exactly which state transitions happen and when the returned
 * promise settles, independent of the real manager's actual single-flight behavior.
 */
function fakeManager(initial: SavedLocationHydrationState): {
  manager: SavedLocationHydrationManager;
  setState: (next: SavedLocationHydrationState) => void;
  hydrateMock: ReturnType<typeof vi.fn>;
} {
  let current = initial;
  const hydrateMock = vi.fn();
  return {
    manager: {
      getState: () => cloneState(current),
      hydrate: hydrateMock,
    },
    setState: (next) => {
      current = next;
    },
    hydrateMock,
  };
}

// ---------------------------------------------------------------------------
// 1/2/3/4 — construction: zero hydrate() calls, seeded initial snapshot, stable reference, frozen.
// ---------------------------------------------------------------------------

describe('createSavedLocationHydrationStore — construction', () => {
  it('performs zero manager hydrate() calls merely by constructing the store', () => {
    const { manager, hydrateMock } = fakeManager({ status: 'NOT_STARTED' });

    createSavedLocationHydrationStore(manager);

    expect(hydrateMock).toHaveBeenCalledTimes(0);
  });

  it('seeds the initial snapshot from the manager current state', () => {
    const locations = [record('a'), record('b', { isCurrent: true, sortOrder: 1 })];
    const { manager } = fakeManager({ status: 'READY', locations });
    const store = createSavedLocationHydrationStore(manager);

    expect(store.getSnapshot()).toEqual({ status: 'READY', locations });
  });

  it('returns the exact same snapshot reference across repeated getSnapshot() calls', () => {
    const { manager } = fakeManager({ status: 'NOT_STARTED' });
    const store = createSavedLocationHydrationStore(manager);

    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });

  it('deep-freezes the initial snapshot, including nested READY records and grids', () => {
    const locations = [record('a')];
    const { manager } = fakeManager({ status: 'READY', locations });
    const store = createSavedLocationHydrationStore(manager);

    const snapshot = store.getSnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    if (snapshot.status !== 'READY') throw new Error('expected READY');
    expect(Object.isFrozen(snapshot.locations)).toBe(true);
    expect(Object.isFrozen(snapshot.locations[0])).toBe(true);
    expect(Object.isFrozen(snapshot.locations[0]?.kmaGrid)).toBe(true);
    expect(() => {
      snapshot.locations[0].sortOrder = 99;
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5 — subscribing never calls the listener immediately.
// ---------------------------------------------------------------------------

describe('createSavedLocationHydrationStore — subscribe', () => {
  it('does not call a newly registered listener immediately', () => {
    const { manager } = fakeManager({ status: 'NOT_STARTED' });
    const store = createSavedLocationHydrationStore(manager);
    const listener = vi.fn();

    store.subscribe(listener);

    expect(listener).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// 6/7/8 — first hydrate() returns the manager's exact promise, transitions synchronously, and
// notifies once per real transition.
// ---------------------------------------------------------------------------

describe('createSavedLocationHydrationStore — first hydrate()', () => {
  it('returns the exact manager promise reference', () => {
    const { manager, hydrateMock } = fakeManager({ status: 'NOT_STARTED' });
    const managerPromise = Promise.resolve();
    hydrateMock.mockReturnValue(managerPromise);
    const store = createSavedLocationHydrationStore(manager);

    expect(store.hydrate()).toBe(managerPromise);
  });

  it('transitions the cached snapshot synchronously to LOADING and notifies once', async () => {
    const { manager, setState, hydrateMock } = fakeManager({ status: 'NOT_STARTED' });
    const pending = deferred<void>();
    hydrateMock.mockImplementation(() => {
      setState({ status: 'LOADING' });
      return pending.promise;
    });
    const store = createSavedLocationHydrationStore(manager);
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getSnapshot();

    store.hydrate();

    expect(store.getSnapshot()).toEqual({ status: 'LOADING' });
    expect(store.getSnapshot()).not.toBe(before);
    expect(listener).toHaveBeenCalledTimes(1);

    setState({ status: 'EMPTY' });
    pending.resolve();
    await pending.promise;
  });

  it('transitions to EMPTY with a new reference and one more notification once the promise settles', async () => {
    const { manager, setState, hydrateMock } = fakeManager({ status: 'NOT_STARTED' });
    const pending = deferred<void>();
    hydrateMock.mockImplementation(() => {
      setState({ status: 'LOADING' });
      return pending.promise;
    });
    const store = createSavedLocationHydrationStore(manager);
    const listener = vi.fn();
    store.subscribe(listener);

    const result = store.hydrate();
    const loadingSnapshot = store.getSnapshot();
    setState({ status: 'EMPTY' });
    pending.resolve();
    await result;

    expect(store.getSnapshot()).toEqual({ status: 'EMPTY' });
    expect(store.getSnapshot()).not.toBe(loadingSnapshot);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 9/10/11 — concurrency: pending calls share promise identity, no duplicate LOADING notification,
// and no duplicate settlement observer.
// ---------------------------------------------------------------------------

describe('createSavedLocationHydrationStore — concurrency', () => {
  it('keeps promise identity and calls the manager only once across concurrent pending calls', async () => {
    const { manager, setState, hydrateMock } = fakeManager({ status: 'NOT_STARTED' });
    const pending = deferred<void>();
    hydrateMock.mockImplementation(() => {
      setState({ status: 'LOADING' });
      return pending.promise;
    });
    const store = createSavedLocationHydrationStore(manager);
    const listener = vi.fn();
    store.subscribe(listener);

    const first = store.hydrate();
    const second = store.hydrate();
    const third = store.hydrate();

    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(hydrateMock).toHaveBeenCalledTimes(1);
    // 10 — the repeated pending calls did not re-notify LOADING.
    expect(listener).toHaveBeenCalledTimes(1);

    setState({ status: 'EMPTY' });
    pending.resolve();
    await Promise.all([first, second, third]);

    // 11 — exactly one settlement notification too (not one per pending call).
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 12/13 — settled READY/EMPTY no-op hydrate() leaves the snapshot reference and listener count
// unchanged.
// ---------------------------------------------------------------------------

describe('createSavedLocationHydrationStore — terminal no-op hydrate()', () => {
  it('leaves the snapshot reference and listener count unchanged for a no-op hydrate() from EMPTY', async () => {
    const { manager, hydrateMock } = fakeManager({ status: 'EMPTY' });
    hydrateMock.mockResolvedValue(undefined);
    const store = createSavedLocationHydrationStore(manager);
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getSnapshot();

    await store.hydrate();

    expect(store.getSnapshot()).toBe(before);
    expect(listener).toHaveBeenCalledTimes(0);
  });

  it('leaves the snapshot reference and listener count unchanged for a no-op hydrate() from READY', async () => {
    const locations = [record('a')];
    const { manager, hydrateMock } = fakeManager({ status: 'READY', locations });
    hydrateMock.mockResolvedValue(undefined);
    const store = createSavedLocationHydrationStore(manager);
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getSnapshot();

    await store.hydrate();

    expect(store.getSnapshot()).toBe(before);
    expect(listener).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// 14/15 — ERROR -> LOADING -> ERROR retry cycle notifies at each real transition, and the store
// itself never auto-retries.
// ---------------------------------------------------------------------------

describe('createSavedLocationHydrationStore — ERROR retry cycle', () => {
  it('notifies through an explicit ERROR -> LOADING -> ERROR retry and does not auto-retry', async () => {
    const { manager, setState, hydrateMock } = fakeManager({
      status: 'ERROR',
      error: { kind: 'STORAGE_READ_FAILED' },
    });
    const pending = deferred<void>();
    hydrateMock.mockImplementation(() => {
      setState({ status: 'LOADING' });
      return pending.promise;
    });
    const store = createSavedLocationHydrationStore(manager);
    const listener = vi.fn();
    store.subscribe(listener);

    const result = store.hydrate();
    expect(store.getSnapshot()).toEqual({ status: 'LOADING' });
    expect(listener).toHaveBeenCalledTimes(1);

    setState({ status: 'ERROR', error: { kind: 'INVALID_STORED_LOCATIONS' } });
    pending.resolve();
    await result;

    expect(store.getSnapshot()).toEqual({
      status: 'ERROR',
      error: { kind: 'INVALID_STORED_LOCATIONS' },
    });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(hydrateMock).toHaveBeenCalledTimes(1);

    // 15 — settling into ERROR does not by itself trigger another manager call.
    await Promise.resolve();
    await Promise.resolve();
    expect(hydrateMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 16/17/18 — semantic equality: identical ERROR kind and identical READY values (fresh objects)
// never notify; a single changed field does.
// ---------------------------------------------------------------------------

describe('createSavedLocationHydrationStore — semantic equality', () => {
  it('does not notify when a hydrate() cycle reports the same ERROR kind throughout', async () => {
    const { manager, hydrateMock } = fakeManager({
      status: 'ERROR',
      error: { kind: 'STORAGE_READ_FAILED' },
    });
    // Deliberately does not transition state at all — proves the dedup is semantic, not "any call".
    hydrateMock.mockResolvedValue(undefined);
    const store = createSavedLocationHydrationStore(manager);
    const listener = vi.fn();
    store.subscribe(listener);

    await store.hydrate();

    expect(listener).toHaveBeenCalledTimes(0);
    expect(store.getSnapshot()).toEqual({ status: 'ERROR', error: { kind: 'STORAGE_READ_FAILED' } });
  });

  it('does not notify when a hydrate() cycle reports value-identical READY locations from a fresh object', async () => {
    const locations = [record('a'), record('b', { isCurrent: true, sortOrder: 1 })];
    const { manager, hydrateMock } = fakeManager({ status: 'READY', locations });
    // Resolves to a freshly built, value-identical locations array — proves value comparison, not
    // reference comparison.
    hydrateMock.mockResolvedValue(undefined);
    const store = createSavedLocationHydrationStore(manager);
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getSnapshot();

    await store.hydrate();

    expect(listener).toHaveBeenCalledTimes(0);
    expect(store.getSnapshot()).toBe(before);
  });

  it('notifies with a new snapshot reference when one READY location field changes', async () => {
    const { manager, setState, hydrateMock } = fakeManager({
      status: 'READY',
      locations: [record('a')],
    });
    const pending = deferred<void>();
    hydrateMock.mockImplementation(() => {
      setState({ status: 'LOADING' });
      return pending.promise;
    });
    const store = createSavedLocationHydrationStore(manager);
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getSnapshot();

    const result = store.hydrate();
    setState({ status: 'READY', locations: [record('a', { displayName: 'Changed' })] });
    pending.resolve();
    await result;

    const after = store.getSnapshot();
    expect(after).not.toBe(before);
    if (after.status !== 'READY') throw new Error('expected READY');
    expect(after.locations[0]?.displayName).toBe('Changed');
    // LOADING + READY = two real transitions.
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 19/20/21 — unsubscribe stops notifications, is idempotent, and does not disturb other listeners'
// iteration when called mid-notification.
// ---------------------------------------------------------------------------

describe('createSavedLocationHydrationStore — unsubscribe', () => {
  it('stops calling a listener after it unsubscribes', async () => {
    const { manager, setState, hydrateMock } = fakeManager({ status: 'NOT_STARTED' });
    hydrateMock.mockImplementation(() => {
      setState({ status: 'LOADING' });
      return Promise.resolve();
    });
    const store = createSavedLocationHydrationStore(manager);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    unsubscribe();
    await store.hydrate();

    expect(listener).toHaveBeenCalledTimes(0);
  });

  it('is safe to call unsubscribe more than once', () => {
    const { manager } = fakeManager({ status: 'NOT_STARTED' });
    const store = createSavedLocationHydrationStore(manager);
    const unsubscribe = store.subscribe(vi.fn());

    expect(() => {
      unsubscribe();
      unsubscribe();
    }).not.toThrow();
  });

  it('keeps notifying other listeners when one listener unsubscribes itself mid-notification', async () => {
    const { manager, setState, hydrateMock } = fakeManager({ status: 'NOT_STARTED' });
    let callCount = 0;
    hydrateMock.mockImplementation(() => {
      callCount += 1;
      setState(callCount === 1 ? { status: 'LOADING' } : { status: 'EMPTY' });
      return Promise.resolve();
    });
    const store = createSavedLocationHydrationStore(manager);
    const other = vi.fn();
    let selfUnsubscribe: (() => void) | undefined;
    const selfUnsubscribing = vi.fn(() => {
      selfUnsubscribe?.();
    });
    selfUnsubscribe = store.subscribe(selfUnsubscribing);
    store.subscribe(other);

    await store.hydrate();

    expect(selfUnsubscribing).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);

    // A second real transition (LOADING -> EMPTY) proves the self-unsubscribing listener really
    // stopped, while `other` — never unsubscribed — keeps being notified.
    await store.hydrate();

    expect(selfUnsubscribing).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 22 — a LOADING listener that reentrantly calls hydrate() causes no duplicate manager call,
// settlement observer, or notification.
// ---------------------------------------------------------------------------

describe('createSavedLocationHydrationStore — reentrancy', () => {
  it('does not duplicate the manager call, observer, or notification when a LOADING listener reentrantly hydrates', async () => {
    const { manager, setState, hydrateMock } = fakeManager({ status: 'NOT_STARTED' });
    const pending = deferred<void>();
    hydrateMock.mockImplementation(() => {
      setState({ status: 'LOADING' });
      return pending.promise;
    });
    const store = createSavedLocationHydrationStore(manager);
    const listener = vi.fn(() => {
      // Reentrant call, but only while this notification is the LOADING transition — matching the
      // spec's "a LOADING listener reentrantly hydrates" scenario, not every future notification.
      if (store.getSnapshot().status === 'LOADING') {
        store.hydrate();
      }
    });
    store.subscribe(listener);

    const outer = store.hydrate();

    expect(hydrateMock).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);

    setState({ status: 'EMPTY' });
    pending.resolve();
    await outer;

    expect(hydrateMock).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toEqual({ status: 'EMPTY' });
  });
});

// ---------------------------------------------------------------------------
// 23 — the cached READY snapshot (including nested records and grids) stays deep-frozen after a
// real hydrate() cycle, not only at construction.
// ---------------------------------------------------------------------------

describe('createSavedLocationHydrationStore — deep-freeze after hydrate()', () => {
  it('deep-freezes the READY snapshot reached via hydrate(), including nested records and grids', async () => {
    const locations = [record('a', { isCurrent: true })];
    const { manager, setState, hydrateMock } = fakeManager({ status: 'NOT_STARTED' });
    hydrateMock.mockImplementation(() => {
      setState({ status: 'READY', locations });
      return Promise.resolve();
    });
    const store = createSavedLocationHydrationStore(manager);

    await store.hydrate();

    const snapshot = store.getSnapshot();
    expect(snapshot.status).toBe('READY');
    if (snapshot.status !== 'READY') return;
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.locations)).toBe(true);
    expect(Object.isFrozen(snapshot.locations[0])).toBe(true);
    expect(Object.isFrozen(snapshot.locations[0]?.kmaGrid)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 24 — no raw location value or error is ever logged by the store across a full error + recovery
// lifecycle.
// ---------------------------------------------------------------------------

describe('createSavedLocationHydrationStore — no logging', () => {
  it('never logs to the console across an ERROR then successful-retry lifecycle', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});

    const { manager, setState, hydrateMock } = fakeManager({ status: 'NOT_STARTED' });
    let attempt = 0;
    hydrateMock.mockImplementation(() => {
      attempt += 1;
      setState({ status: 'LOADING' });
      if (attempt === 1) {
        setState({ status: 'ERROR', error: { kind: 'STORAGE_READ_FAILED' } });
        return Promise.resolve();
      }
      setState({ status: 'READY', locations: [record('a', { displayName: SECRET_MARKER })] });
      return Promise.resolve();
    });
    const store = createSavedLocationHydrationStore(manager);
    store.subscribe(vi.fn());

    await store.hydrate();
    await store.hydrate();

    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleInfo).not.toHaveBeenCalled();
  });
});
