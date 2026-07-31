/**
 * Provider-neutral **application store** for the mobile saved-location collection.
 *
 * Everything below this module is already in place: the pure collection operations (PR #40), the
 * versioned persistence codec and its key-value port (PR #41/#42), the hydration manager (PR #43),
 * and the observable hydration store (PR #46). What none of them owns is the write side — computing
 * a mutation from the hydrated collection, persisting it, and only then publishing it to React
 * consumers. That is this module's single responsibility:
 *
 * - **observe hydration** — it subscribes to an injected {@link SavedLocationHydrationStore} and
 *   maps its five states onto its own snapshot, adding a write dimension (`IDLE` / `SAVING`);
 * - **own the committed collection** — once hydration succeeds, the committed collection (not the
 *   hydration snapshot) is the source of truth, so a mutation that empties or fills it flips the
 *   published status between `EMPTY` and `READY`;
 * - **persist before publishing** — `add` / `remove` run the matching pure collection operation,
 *   call `persistence.save()` exactly once, and publish the new collection **only after** that save
 *   succeeds. There is no optimistic update, and therefore nothing to roll back on failure: a failed
 *   write leaves the previously committed collection exactly as it was;
 * - **delegate explicit retry** — `retryHydration()` forwards to the hydration store's `hydrate()`
 *   and returns that exact promise, adding no timer, backoff, or automatic retry of its own.
 *
 * It redefines none of the boundaries beneath it — no storage key, no envelope version, no
 * collection invariant, no hydration state machine, no error kind semantics. It imports no React,
 * Expo, AsyncStorage, production singleton, logging, or telemetry; importing this module or calling
 * {@link createSavedLocationApplicationStore} performs no `hydrate()` call and no storage I/O (only
 * the hydration store's synchronous, side-effect-free `getSnapshot()` is read once, at construction).
 *
 * Out of scope here (later PRs): reorder, set-current / selected-location state, clear-all,
 * migration, refresh or background rehydration, a write queue / debounce / batching /
 * compare-and-swap, weather requests, location permission, and any UI.
 */

import { type MobileSavedLocation } from './mobile-saved-location';
import {
  addSavedLocation,
  removeSavedLocation,
  type SavedLocationCollectionErrorKind,
  type SavedLocationCollectionResult,
} from './mobile-saved-location-collection';
import {
  type SavedLocationHydrationErrorKind,
  type SavedLocationHydrationState,
} from './mobile-saved-location-hydration-manager';
import { type SavedLocationHydrationStore } from './mobile-saved-location-hydration-store';
import {
  type SavedLocationPersistence,
  type SavedLocationPersistenceSaveResult,
} from './mobile-saved-location-persistence';

/** Whether a persisted write is currently in flight. Only a hydrated state can ever be `SAVING`. */
export type SavedLocationApplicationWriteStatus = 'IDLE' | 'SAVING';

/**
 * The published application snapshot: the hydration status a consumer must render, plus the write
 * status it must reflect (e.g. by disabling mutation controls).
 *
 * `NOT_STARTED` / `LOADING` / `ERROR` are always `IDLE` — a mutation can only run once hydration has
 * succeeded, so no write can be in flight in those states. `EMPTY` and `READY` are derived from the
 * **committed collection**, not from the hydration snapshot, so removing the last location publishes
 * `EMPTY` and adding to an empty collection publishes `READY`. `ERROR.error.kind` is the hydration
 * manager's fixed, non-revealing discriminator, passed through unchanged and never reinterpreted.
 */
export type SavedLocationApplicationSnapshot =
  | { readonly status: 'NOT_STARTED'; readonly writeStatus: 'IDLE' }
  | { readonly status: 'LOADING'; readonly writeStatus: 'IDLE' }
  | { readonly status: 'EMPTY'; readonly writeStatus: SavedLocationApplicationWriteStatus }
  | {
      readonly status: 'READY';
      readonly locations: readonly MobileSavedLocation[];
      readonly writeStatus: SavedLocationApplicationWriteStatus;
    }
  | {
      readonly status: 'ERROR';
      readonly error: { readonly kind: SavedLocationHydrationErrorKind };
      readonly writeStatus: 'IDLE';
    };

/**
 * The fixed, non-revealing failure discriminators a mutation can return.
 *
 * - `NOT_READY` — the store is not in a state this mutation is allowed from (`add` needs `EMPTY` or
 *   `READY`; `remove` needs `READY`). No collection operation and no write is attempted.
 * - `WRITE_IN_PROGRESS` — another mutation is already `SAVING`; this call starts no second write and
 *   leaves the in-flight one untouched.
 * - `INVALID_COLLECTION` / `INVALID_LOCATION` / `DUPLICATE_LOCATION_ID` /
 *   `CURRENT_LOCATION_CONFLICT` / `INVALID_LOCATION_ID` / `LOCATION_NOT_FOUND` — surfaced from the
 *   pure collection operation, which runs **before** any write, so the stored data is untouched.
 * - `STORAGE_WRITE_FAILED` — `persistence.save()` failed; the previously committed collection stands.
 *
 * No raw storage error, native message, stack, Zod issue, storage key, location id, display name,
 * coordinate, or grid is ever attached, and nothing is logged.
 */
export type SavedLocationApplicationErrorKind =
  | 'NOT_READY'
  | 'WRITE_IN_PROGRESS'
  | 'INVALID_COLLECTION'
  | 'INVALID_LOCATION'
  | 'DUPLICATE_LOCATION_ID'
  | 'CURRENT_LOCATION_CONFLICT'
  | 'INVALID_LOCATION_ID'
  | 'LOCATION_NOT_FOUND'
  | 'STORAGE_WRITE_FAILED';

/**
 * The outcome of a mutation. Success carries no data — the caller reads the (already updated)
 * snapshot — and failure carries only a fixed `kind`.
 */
export type SavedLocationApplicationMutationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: { readonly kind: SavedLocationApplicationErrorKind } };

/** Notified after a semantic snapshot transition. Carries no data — read `getSnapshot()`. */
export type SavedLocationApplicationStoreListener = () => void;

/** The two provider-neutral collaborators this store composes. Both are injected, never imported. */
export interface SavedLocationApplicationStoreDependencies {
  readonly hydrationStore: SavedLocationHydrationStore;
  readonly persistence: SavedLocationPersistence;
}

/** The application store's public surface. */
export interface SavedLocationApplicationStore {
  /**
   * The cached application snapshot. Returns the exact same object reference across repeated calls
   * until a real semantic transition occurs, so a `useSyncExternalStore` consumer can compare by
   * reference. The returned value (and, for `READY`, its `locations` array, each record, and each
   * non-null `kmaGrid`; for `ERROR`, its nested `error`) is deep-frozen.
   */
  getSnapshot(): SavedLocationApplicationSnapshot;

  /**
   * Register a listener called only on a semantic transition (never on registration, and never for
   * a state that is semantically unchanged). Returns an idempotent unsubscribe function.
   */
  subscribe(listener: SavedLocationApplicationStoreListener): () => void;

  /**
   * Re-run hydration explicitly, for a user-initiated retry from `ERROR`. Delegates to the injected
   * hydration store's `hydrate()` and returns that **exact promise reference**, so its existing
   * single-flight, idempotent-success, and retryable-failure contract applies unchanged. This store
   * adds no timer, backoff, or automatic retry, and never reinterprets the hydration error kind.
   */
  retryHydration(): Promise<void>;

  /**
   * Append a candidate location and persist the result. Allowed from `EMPTY` and `READY` only.
   * See {@link createSavedLocationApplicationStore} for the exact ordering guarantees.
   */
  add(candidate: unknown): Promise<SavedLocationApplicationMutationResult>;

  /**
   * Remove the location with the given id and persist the result. Allowed from `READY` only.
   * See {@link createSavedLocationApplicationStore} for the exact ordering guarantees.
   */
  remove(locationId: unknown): Promise<SavedLocationApplicationMutationResult>;
}

/** A fresh failure result per call, so no caller can observe or mutate a shared one. */
function mutationFailure(
  kind: SavedLocationApplicationErrorKind,
): SavedLocationApplicationMutationResult {
  return { ok: false, error: { kind } };
}

/**
 * Map a pure collection failure onto this boundary's public union.
 *
 * Every kind maps to the identically named application kind except `INVALID_REORDER`, which is
 * unreachable here — this store never calls `reorderSavedLocations` — and is collapsed defensively
 * rather than widening the public union with a kind this boundary can never actually produce.
 */
function mapCollectionErrorKind(
  kind: SavedLocationCollectionErrorKind,
): SavedLocationApplicationErrorKind {
  return kind === 'INVALID_REORDER' ? 'INVALID_COLLECTION' : kind;
}

/** `null` compares equal only to `null`; otherwise compares the two grid fields by value. */
function kmaGridsEqual(a: MobileSavedLocation['kmaGrid'], b: MobileSavedLocation['kmaGrid']): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.nx === b.nx && a.ny === b.ny;
}

/**
 * Field-by-field value comparison for one saved-location record — never a reference comparison.
 *
 * Deliberately local to this module rather than shared with the hydration store's equivalent
 * helper: that store's public contract is frozen, and widening it with an internal comparator
 * export purely for reuse would change a protected boundary's surface.
 */
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

/** Same array reference is the common case (the committed collection is replaced, never edited). */
function locationListsEqual(
  a: readonly MobileSavedLocation[],
  b: readonly MobileSavedLocation[],
): boolean {
  if (a === b) {
    return true;
  }
  if (a.length !== b.length) {
    return false;
  }
  return a.every((location, index) => savedLocationsEqual(location, b[index]));
}

/**
 * Semantic equality between two application snapshots — never a reference comparison. `status` and
 * `writeStatus` must both match; `ERROR` then compares only `error.kind`, and `READY` compares the
 * length, order, and every field of every record.
 */
function applicationSnapshotsEqual(
  a: SavedLocationApplicationSnapshot,
  b: SavedLocationApplicationSnapshot,
): boolean {
  if (a.status !== b.status || a.writeStatus !== b.writeStatus) {
    return false;
  }

  switch (a.status) {
    case 'NOT_STARTED':
    case 'LOADING':
    case 'EMPTY':
      return true;
    case 'ERROR':
      return b.status === 'ERROR' && a.error.kind === b.error.kind;
    case 'READY':
      return b.status === 'READY' && locationListsEqual(a.locations, b.locations);
  }
}

/**
 * Freeze exactly the mutable surface a snapshot can carry: the top-level object, `ERROR`'s nested
 * `error`, `READY`'s `locations` array, each record in it, and each non-null `kmaGrid`.
 *
 * For `READY`, `locations` **is** the committed collection, so freezing it also makes the store's
 * own committed value immutable — which is safe and intended: the pure collection operations and the
 * persistence codec both read their inputs without mutating them and explicitly accept deep-frozen
 * values, and a new collection is always a fresh array rather than an edit of this one.
 */
function freezeSnapshot(
  snapshot: SavedLocationApplicationSnapshot,
): SavedLocationApplicationSnapshot {
  if (snapshot.status === 'READY') {
    snapshot.locations.forEach((location) => {
      if (location.kmaGrid !== null) {
        Object.freeze(location.kmaGrid);
      }
      Object.freeze(location);
    });
    Object.freeze(snapshot.locations);
  } else if (snapshot.status === 'ERROR') {
    Object.freeze(snapshot.error);
  }
  return Object.freeze(snapshot);
}

/**
 * The collection a hydration state hands over, or `null` when hydration has not succeeded yet.
 * `READY.locations` is reused as-is rather than cloned: the hydration store already publishes a
 * deep-frozen array, so sharing it is immutable by construction.
 */
function committedFromHydration(
  state: SavedLocationHydrationState,
): readonly MobileSavedLocation[] | null {
  if (state.status === 'EMPTY') {
    return [];
  }
  if (state.status === 'READY') {
    return state.locations;
  }
  return null;
}

/**
 * Build a {@link SavedLocationApplicationStore} over an injected hydration store and persistence.
 *
 * Construction reads the hydration store's current snapshot once and subscribes to it — no
 * `hydrate()` call, no storage I/O, no timer.
 *
 * **Mutation ordering.** `add` and `remove` both follow the same fixed sequence, and the steps
 * before the first `await` run synchronously within the call:
 *
 * 1. reject with `WRITE_IN_PROGRESS` if a write is already `SAVING`, then with `NOT_READY` if the
 *    current state does not allow this mutation — in both cases without touching persistence;
 * 2. run the matching pure collection operation against the **committed** collection, returning its
 *    fixed error unchanged (still without touching persistence) when it fails;
 * 3. publish `writeStatus: 'SAVING'` and notify;
 * 4. call `persistence.save()` **exactly once** with the new canonical collection — including the
 *    empty collection produced by removing the last location, which is saved as a normal versioned
 *    envelope rather than via `clear()`, so every mutation uses one and the same write path;
 * 5. on success, and only then, adopt the new collection as committed;
 * 6. on failure, leave the previously committed collection exactly as it was — no optimistic value
 *    was ever published, so there is nothing to roll back;
 * 7. return to `writeStatus: 'IDLE'` and notify, then return the fixed result.
 *
 * **Concurrency and reentrancy.** A second `add`/`remove` issued while a write is in flight —
 * including one issued reentrantly from a listener this store is notifying — returns
 * `WRITE_IN_PROGRESS` without calling `persistence.save()` again and without disturbing the first
 * write's collection or promise. There is deliberately no write queue, debounce, batching, or
 * compare-and-swap. All store state is settled *before* the terminal notification, so a listener
 * that starts a fresh mutation from within it observes a fully consistent store.
 */
export function createSavedLocationApplicationStore({
  hydrationStore,
  persistence,
}: SavedLocationApplicationStoreDependencies): SavedLocationApplicationStore {
  let hydrationSnapshot: SavedLocationHydrationState = hydrationStore.getSnapshot();
  let committed: readonly MobileSavedLocation[] | null =
    committedFromHydration(hydrationSnapshot);
  let writeStatus: SavedLocationApplicationWriteStatus = 'IDLE';
  const listeners = new Set<SavedLocationApplicationStoreListener>();

  function buildSnapshot(): SavedLocationApplicationSnapshot {
    switch (hydrationSnapshot.status) {
      case 'NOT_STARTED':
        return { status: 'NOT_STARTED', writeStatus: 'IDLE' };
      case 'LOADING':
        return { status: 'LOADING', writeStatus: 'IDLE' };
      case 'ERROR':
        return {
          status: 'ERROR',
          error: { kind: hydrationSnapshot.error.kind },
          writeStatus: 'IDLE',
        };
      case 'EMPTY':
      case 'READY': {
        // Past this point the committed collection — not the hydration snapshot — decides between
        // EMPTY and READY, so a mutation can flip the published status in either direction.
        const locations = committed ?? [];
        return locations.length === 0
          ? { status: 'EMPTY', writeStatus }
          : { status: 'READY', locations, writeStatus };
      }
    }
  }

  let cachedSnapshot: SavedLocationApplicationSnapshot = freezeSnapshot(buildSnapshot());

  // Each listener is isolated in its own try/catch: one subscriber throwing must not stop the
  // remaining subscribers from observing the transition, and must not corrupt an in-flight
  // mutation. A subscriber's error is never stored, exposed, or logged.
  function notifyListeners(): void {
    // Iterate a snapshot copy: a listener may unsubscribe or start a reentrant mutation during
    // notification, and neither may disturb this iteration or the live `listeners` Set.
    for (const listener of Array.from(listeners)) {
      try {
        listener();
      } catch {
        // Swallowed intentionally — see the function-level note above.
      }
    }
  }

  /** Rebuild the snapshot and notify only when it is semantically different from the cached one. */
  function republish(): void {
    const next = freezeSnapshot(buildSnapshot());
    if (applicationSnapshotsEqual(cachedSnapshot, next)) {
      return;
    }
    cachedSnapshot = next;
    notifyListeners();
  }

  // Adopting the hydration collection on every transition can never discard a persisted mutation:
  // the hydration store only transitions out of NOT_STARTED / ERROR (where nothing is committed and
  // no mutation is allowed), and its EMPTY / READY states are terminal, so it never notifies again
  // once a collection is committed here.
  hydrationStore.subscribe(() => {
    hydrationSnapshot = hydrationStore.getSnapshot();
    committed = committedFromHydration(hydrationSnapshot);
    republish();
  });

  async function applyMutation(
    readyOnly: boolean,
    compute: (current: readonly MobileSavedLocation[]) => SavedLocationCollectionResult,
  ): Promise<SavedLocationApplicationMutationResult> {
    if (writeStatus === 'SAVING') {
      return mutationFailure('WRITE_IN_PROGRESS');
    }
    if (committed === null || (readyOnly && committed.length === 0)) {
      return mutationFailure('NOT_READY');
    }

    const computed = compute(committed);
    if (!computed.ok) {
      return mutationFailure(mapCollectionErrorKind(computed.error.kind));
    }
    const nextCollection = computed.locations;

    writeStatus = 'SAVING';
    republish();

    let saved: SavedLocationPersistenceSaveResult;
    try {
      saved = await persistence.save(nextCollection);
    } catch {
      // The persistence boundary is contractually throw-free; this guard only keeps a hostile or
      // broken injected implementation from rejecting the caller's mutation promise.
      saved = { ok: false, error: { kind: 'STORAGE_WRITE_FAILED' } };
    }

    if (!saved.ok) {
      writeStatus = 'IDLE';
      republish();
      return mutationFailure(
        saved.error.kind === 'INVALID_COLLECTION' ? 'INVALID_COLLECTION' : 'STORAGE_WRITE_FAILED',
      );
    }

    // Publish only after the write succeeded, and settle every field before notifying so a
    // reentrant mutation started from a listener sees a fully consistent store.
    committed = nextCollection;
    writeStatus = 'IDLE';
    republish();
    return { ok: true };
  }

  return {
    getSnapshot(): SavedLocationApplicationSnapshot {
      return cachedSnapshot;
    },

    subscribe(listener: SavedLocationApplicationStoreListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    // A plain (non-`async`) method, so the hydration store's *exact* promise reference is returned
    // rather than a newly wrapped one — an `async` wrapper would allocate a new promise per call.
    retryHydration(): Promise<void> {
      return hydrationStore.hydrate();
    },

    add(candidate: unknown): Promise<SavedLocationApplicationMutationResult> {
      return applyMutation(false, (current) => addSavedLocation(current, candidate));
    },

    remove(locationId: unknown): Promise<SavedLocationApplicationMutationResult> {
      return applyMutation(true, (current) => removeSavedLocation(current, locationId));
    },
  };
}
