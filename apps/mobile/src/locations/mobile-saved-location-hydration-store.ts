/**
 * Provider-neutral observable store over the saved-location hydration manager.
 *
 * This module wraps a {@link SavedLocationHydrationManager} (PR #43) with the small
 * getSnapshot/subscribe/hydrate contract a future React `useSyncExternalStore` consumer needs: a
 * stable, deep-frozen cached snapshot that only changes reference on an actual semantic state
 * transition, and a subscription list notified only on those transitions. It owns no hydration
 * policy of its own — the manager remains the single source of truth for state, single-flight
 * behavior, and error kinds; this store only observes it.
 *
 * Out of scope for this module (later PRs): React, `useSyncExternalStore`, any hook/context/UI,
 * screens, location mutation, and any real network or storage access. Importing this module, or
 * calling {@link createSavedLocationHydrationStore}, performs no `hydrate()` call and no storage
 * I/O — only the manager's synchronous, side-effect-free `getState()` is read once, at construction.
 */

import { type MobileSavedLocation } from './mobile-saved-location';
import {
  type SavedLocationHydrationManager,
  type SavedLocationHydrationState,
} from './mobile-saved-location-hydration-manager';

/** Notified after a semantic hydration state transition. Carries no data — read `getSnapshot()`. */
export type SavedLocationHydrationStoreListener = () => void;

/** The observable store's public surface. */
export interface SavedLocationHydrationStore {
  /**
   * The cached hydration snapshot. Returns the exact same object reference across repeated calls
   * until a real semantic state transition occurs, so a `useSyncExternalStore` consumer can safely
   * compare by reference. The returned value (and, for `READY`, its `locations` array, each record,
   * and each non-null `kmaGrid`) is deep-frozen.
   */
  getSnapshot(): SavedLocationHydrationState;

  /**
   * Register a listener called only on a semantic state transition (never on registration, and
   * never for a state read that is semantically unchanged). Returns an idempotent unsubscribe
   * function; calling it more than once, or after the store has already stopped notifying it, is
   * safe.
   */
  subscribe(listener: SavedLocationHydrationStoreListener): () => void;

  /**
   * Delegate to the wrapped manager's `hydrate()` and return that exact promise reference. See
   * {@link createSavedLocationHydrationStore} for the concurrency and reentrancy contract.
   */
  hydrate(): Promise<void>;
}

/** `null` compares equal only to `null`; otherwise compares the two grid fields by value. */
function kmaGridsEqual(a: MobileSavedLocation['kmaGrid'], b: MobileSavedLocation['kmaGrid']): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.nx === b.nx && a.ny === b.ny;
}

/** Field-by-field value comparison for one saved-location record — never a reference comparison. */
function savedLocationsEqual(a: MobileSavedLocation, b: MobileSavedLocation): boolean {
  return (
    a.id === b.id &&
    a.displayName === b.displayName &&
    a.countryCode === b.countryCode &&
    a.adminArea1 === b.adminArea1 &&
    a.adminArea2 === b.adminArea2 &&
    a.adminArea3 === b.adminArea3 &&
    a.latitude === b.latitude &&
    a.longitude === b.longitude &&
    a.timezone === b.timezone &&
    kmaGridsEqual(a.kmaGrid, b.kmaGrid) &&
    a.isCurrent === b.isCurrent &&
    a.sortOrder === b.sortOrder
  );
}

/**
 * Semantic equality between two hydration states — never a reference comparison, since the manager
 * returns a fresh object on every `getState()` call. `READY` compares `locations` length, order, and
 * every field of every record; `ERROR` compares only `error.kind`; the other three statuses compare
 * equal whenever their `status` matches.
 */
function hydrationStatesEqual(
  a: SavedLocationHydrationState,
  b: SavedLocationHydrationState,
): boolean {
  if (a.status !== b.status) {
    return false;
  }

  switch (a.status) {
    case 'NOT_STARTED':
    case 'LOADING':
    case 'EMPTY':
      return true;
    case 'ERROR':
      return b.status === 'ERROR' && a.error.kind === b.error.kind;
    case 'READY': {
      if (b.status !== 'READY' || a.locations.length !== b.locations.length) {
        return false;
      }
      return a.locations.every((location, index) => savedLocationsEqual(location, b.locations[index]));
    }
  }
}

/**
 * Freeze exactly the mutable surface a hydration state can carry: the top-level object, `ERROR`'s
 * nested `error`, `READY`'s `locations` array, each record in it, and each non-null `kmaGrid`. The
 * manager already returns a fresh object graph per `getState()` call (see its own reference-safety
 * contract), so freezing this particular copy never affects the manager's internal state or any
 * previously cached snapshot.
 */
function freezeSnapshot(state: SavedLocationHydrationState): SavedLocationHydrationState {
  if (state.status === 'READY') {
    state.locations.forEach((location) => {
      if (location.kmaGrid !== null) {
        Object.freeze(location.kmaGrid);
      }
      Object.freeze(location);
    });
    Object.freeze(state.locations);
  } else if (state.status === 'ERROR') {
    Object.freeze(state.error);
  }
  return Object.freeze(state);
}

/**
 * Build a {@link SavedLocationHydrationStore} over an injected {@link SavedLocationHydrationManager}.
 *
 * Neither this factory nor importing the module calls `hydrate()` — the initial snapshot is seeded
 * from one synchronous, side-effect-free `manager.getState()` read.
 *
 * `hydrate()` delegates to `manager.hydrate()` and returns that exact promise. While a call is
 * in flight (tracked internally), every additional `hydrate()` call — concurrent, or reentrant from
 * inside a listener this store is notifying — returns that same tracked promise **without** calling
 * `manager.hydrate()` again, so the manager is called, and a settlement observer attached, at most
 * once per actual hydration cycle. The tracked promise reference is cleared *before* the terminal
 * `checkForTransition()` / listener notification runs, not after — so if a terminal listener
 * immediately starts a new retry cycle (from `ERROR`), that new cycle's own tracked promise is left
 * in place rather than being wiped out by this settlement continuing afterward.
 */
export function createSavedLocationHydrationStore(
  manager: SavedLocationHydrationManager,
): SavedLocationHydrationStore {
  let cachedSnapshot: SavedLocationHydrationState = freezeSnapshot(manager.getState());
  let pendingPromise: Promise<void> | null = null;
  const listeners = new Set<SavedLocationHydrationStoreListener>();

  function notifyListeners(): void {
    // Iterate a snapshot copy: a listener may unsubscribe or trigger a reentrant hydrate() during
    // notification, and neither may disturb this iteration or the live `listeners` Set.
    for (const listener of Array.from(listeners)) {
      listener();
    }
  }

  function checkForTransition(): void {
    const latest = freezeSnapshot(manager.getState());
    if (!hydrationStatesEqual(cachedSnapshot, latest)) {
      cachedSnapshot = latest;
      notifyListeners();
    }
  }

  return {
    getSnapshot(): SavedLocationHydrationState {
      return cachedSnapshot;
    },

    subscribe(listener: SavedLocationHydrationStoreListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    hydrate(): Promise<void> {
      if (pendingPromise !== null) {
        return pendingPromise;
      }

      const promise = manager.hydrate();
      pendingPromise = promise;
      checkForTransition();

      promise.then(() => {
        if (pendingPromise === promise) {
          pendingPromise = null;
        }
        checkForTransition();
      });

      return promise;
    },
  };
}
