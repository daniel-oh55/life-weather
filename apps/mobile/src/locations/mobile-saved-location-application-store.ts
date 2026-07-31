/**
 * Provider-neutral **application store** for the mobile saved-location collection and the
 * device's **selected** location preference.
 *
 * Everything below this module is already in place: the pure collection operations (PR #40), the
 * versioned saved-location persistence codec (PR #41/#42), the hydration manager/store (PR #43/#46),
 * and the versioned **selected**-location persistence codec
 * ({@link ./mobile-selected-location-persistence}, PR #52). What none of them owns is coordinating
 * the two: computing a collection mutation, computing the selection that mutation implies, persisting
 * both in the documented order, and only then publishing either to React consumers. That is this
 * module's responsibility.
 *
 * `isCurrent` (owned by {@link ./mobile-saved-location}) is the device's real GPS-derived current
 * location and is never read or written here. `selectedLocationId` (this module) is the id of the
 * saved location the user is currently viewing. The two are never combined.
 *
 * - **observe saved-location hydration** — subscribes to an injected
 *   {@link SavedLocationHydrationStore} and derives `EMPTY`/`READY` from its own committed
 *   collection, exactly as before;
 * - **own the selected-location initialization state machine** — a small
 *   `NOT_STARTED`/`LOADING`/`READY`/`ERROR` internal state, started only by
 *   {@link SavedLocationApplicationStore.initializeSelectedLocation}, never by construction or
 *   import, and never by observing saved-location hydration;
 * - **resolve stale/missing preferences safely** — a persisted id that is `null`, or that is not
 *   present in the hydrated collection, falls back to the first (`sortOrder === 0`) saved location,
 *   without ever writing that fallback back to storage;
 * - **persist before publishing, in the documented cross-key order** — `select` writes only the
 *   selected-location key; the first `add` into an empty collection writes the selected-location key
 *   **before** the collection key; a `remove` of the currently selected location writes the fallback
 *   selected-location key **before** the collection key. Every other `add`/`remove` touches only the
 *   collection key. No mutation ever publishes a new value before its write(s) succeed;
 * - **share one write lock** — `add`, `remove`, and `select` all read and set the same
 *   `writeStatus`, so at most one write of any kind is ever in flight.
 *
 * It redefines no boundary beneath it — no storage key, no envelope version, no collection
 * invariant, no hydration state machine, no error kind semantics. It imports no React, Expo,
 * AsyncStorage, production singleton, logging, or telemetry.
 *
 * Out of scope here (later PRs): reorder, clear-all, migration, refresh or background rehydration, a
 * write queue / debounce / batching / compare-and-swap beyond the single shared lock, weather
 * requests, location permission, and any UI.
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
import {
  type SelectedLocationPersistence,
  type SelectedLocationPersistenceLoadResult,
  type SelectedLocationPersistenceSaveResult,
} from './mobile-selected-location-persistence';

/** Whether a persisted write is currently in flight. Only a hydrated state can ever be `SAVING`. */
export type SavedLocationApplicationWriteStatus = 'IDLE' | 'SAVING';

/** The fixed, non-revealing failure kinds `initializeSelectedLocation()` can settle to. */
type SelectedLocationInitializationErrorKind = Extract<
  SelectedLocationPersistenceLoadResult,
  { readonly ok: false }
>['error']['kind'];

/** Which of the two independently-loaded boundaries an `ERROR` snapshot originates from. */
export type SavedLocationApplicationErrorScope = 'SAVED_LOCATIONS' | 'SELECTED_LOCATION';

/**
 * The fixed, non-revealing `ERROR` payload. `scope` lets a UI route an explicit retry to the right
 * boundary; `kind` is that boundary's own fixed discriminator, passed through unchanged.
 */
export type SavedLocationApplicationErrorInfo =
  | { readonly scope: 'SAVED_LOCATIONS'; readonly kind: SavedLocationHydrationErrorKind }
  | { readonly scope: 'SELECTED_LOCATION'; readonly kind: SelectedLocationInitializationErrorKind };

/**
 * The published application snapshot.
 *
 * `NOT_STARTED` / `LOADING` describe saved-location hydration, exactly as before. `SELECTION_LOADING`
 * is new: the saved collection has hydrated but the selected-location preference has not finished
 * loading yet, so neither `EMPTY` nor `READY` may be published (a `READY` snapshot must always carry
 * an authoritative `selectedLocationId`). `EMPTY` always carries `selectedLocationId: null`. `READY`
 * always carries a `selectedLocationId` that is a non-empty string present in `locations` — that
 * invariant is enforced by this module, never merely assumed. `ERROR.error.scope` distinguishes a
 * saved-location hydration failure from a selected-location initialization failure.
 */
export type SavedLocationApplicationSnapshot =
  | { readonly status: 'NOT_STARTED'; readonly writeStatus: 'IDLE' }
  | { readonly status: 'LOADING'; readonly writeStatus: 'IDLE' }
  | { readonly status: 'SELECTION_LOADING'; readonly writeStatus: 'IDLE' }
  | {
      readonly status: 'EMPTY';
      readonly selectedLocationId: null;
      readonly writeStatus: SavedLocationApplicationWriteStatus;
    }
  | {
      readonly status: 'READY';
      readonly locations: readonly MobileSavedLocation[];
      readonly selectedLocationId: string;
      readonly writeStatus: SavedLocationApplicationWriteStatus;
    }
  | {
      readonly status: 'ERROR';
      readonly error: SavedLocationApplicationErrorInfo;
      readonly writeStatus: 'IDLE';
    };

/**
 * The fixed, non-revealing failure discriminators a mutation can return.
 *
 * - `NOT_READY` — the store is not in a state this mutation is allowed from (`add` needs `EMPTY` or
 *   `READY`; `remove`/`select` need `READY`). No collection operation and no write is attempted.
 * - `WRITE_IN_PROGRESS` — another mutation (`add`, `remove`, or `select` — they share one lock) is
 *   already `SAVING`; this call starts no second write and leaves the in-flight one untouched.
 * - `INVALID_COLLECTION` / `INVALID_LOCATION` / `DUPLICATE_LOCATION_ID` /
 *   `CURRENT_LOCATION_CONFLICT` / `INVALID_LOCATION_ID` / `LOCATION_NOT_FOUND` — surfaced from the
 *   pure collection operation (for `add`/`remove`) or from `select`'s own id validation, both of
 *   which run **before** any write, so stored data is untouched.
 * - `STORAGE_WRITE_FAILED` — a `persistence.save()` or `selectedLocationPersistence.save()` call
 *   failed; the previously committed collection and/or selection stand.
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

/** The three provider-neutral collaborators this store composes. All are injected, never imported. */
export interface SavedLocationApplicationStoreDependencies {
  readonly hydrationStore: SavedLocationHydrationStore;
  readonly persistence: SavedLocationPersistence;
  readonly selectedLocationPersistence: SelectedLocationPersistence;
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
   * Re-run saved-location hydration explicitly, for a user-initiated retry from a `SAVED_LOCATIONS`
   * `ERROR`. Delegates to the injected hydration store's `hydrate()` and returns that **exact
   * promise reference**, so its existing single-flight, idempotent-success, and retryable-failure
   * contract applies unchanged. This store adds no timer, backoff, or automatic retry, and never
   * reinterprets the hydration error kind.
   */
  retryHydration(): Promise<void>;

  /**
   * Start (or join, or idempotently no-op) selected-location preference initialization. Never called
   * by construction or import. Intended to be called once, after saved-location hydration has
   * succeeded, by the app-level startup orchestrator — but calling it before that (while nothing is
   * committed yet) is a safe no-op that touches no persistence. See the module documentation for the
   * exact resolution algorithm and single-flight contract.
   */
  initializeSelectedLocation(): Promise<void>;

  /**
   * A single UI-facing retry entry point that routes to whichever boundary is currently `ERROR`: a
   * `SAVED_LOCATIONS` error retries hydration and, only if that succeeds, starts selected-location
   * initialization; a `SELECTED_LOCATION` error retries only the selected-location load. A no-op
   * outside `ERROR`. Never rejects, and adds no timer, backoff, or automatic retry.
   */
  retryInitialization(): Promise<void>;

  /**
   * Select a different saved location as the one the user is currently viewing. Allowed from `READY`
   * only. Selecting the already-selected id is a successful no-op (zero writes, zero notifications).
   * See {@link createSavedLocationApplicationStore} for the exact ordering guarantees.
   */
  select(locationId: unknown): Promise<SavedLocationApplicationMutationResult>;

  /**
   * Append a candidate location and persist the result. Allowed from `EMPTY` and `READY` only. The
   * first location added to an empty collection also becomes selected. See
   * {@link createSavedLocationApplicationStore} for the exact ordering guarantees.
   */
  add(candidate: unknown): Promise<SavedLocationApplicationMutationResult>;

  /**
   * Remove the location with the given id and persist the result. Allowed from `READY` only.
   * Removing the currently selected location also persists and publishes the documented fallback
   * selection. See {@link createSavedLocationApplicationStore} for the exact ordering guarantees.
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
 * `writeStatus` must both match; `ERROR` then compares `error.scope`/`error.kind`, and `READY`
 * compares `selectedLocationId` plus the length, order, and every field of every record.
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
    case 'SELECTION_LOADING':
    case 'EMPTY':
      return true;
    case 'ERROR':
      return (
        b.status === 'ERROR' && a.error.scope === b.error.scope && a.error.kind === b.error.kind
      );
    case 'READY':
      return (
        b.status === 'READY' &&
        a.selectedLocationId === b.selectedLocationId &&
        locationListsEqual(a.locations, b.locations)
      );
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
 * The saved location this app-issued opaque id resolves to under the collection's canonical
 * `sortOrder`, i.e. the record at `sortOrder === 0`. The collection is always canonical here (every
 * pure collection operation rewrites `sortOrder` to `0..n-1` in array order), so this is simply the
 * first element — `.find` is used defensively rather than assuming the array is never reordered by
 * a future change to this module.
 */
function firstByCanonicalSortOrder(
  collection: readonly MobileSavedLocation[],
): MobileSavedLocation | undefined {
  return collection.find((location) => location.sortOrder === 0) ?? collection[0];
}

/**
 * Resolve the authoritative selected-location id for a hydrated collection and a raw persisted
 * preference, per the documented resolution algorithm:
 *
 * - an empty collection always resolves to `null`;
 * - a persisted id that names a record still present in the collection is used as-is;
 * - a `null`, missing, or stale (not-present) persisted id falls back to the first
 *   (`sortOrder === 0`) record.
 *
 * This never writes anything — the caller decides whether/when to persist a resolved fallback (this
 * module never does, by design; see the module documentation).
 */
function resolveSelectedLocationId(
  collection: readonly MobileSavedLocation[],
  persistedId: string | null,
): string | null {
  if (collection.length === 0) {
    return null;
  }
  if (persistedId !== null && collection.some((location) => location.id === persistedId)) {
    return persistedId;
  }
  return firstByCanonicalSortOrder(collection)?.id ?? null;
}

/**
 * Given the collection **after** a removal and the removed record's index **before** removal,
 * compute the documented fallback: the record now at that same index, or — if the removal emptied
 * the tail — the new last record, or `null` if the collection is now empty.
 */
function computeRemovalFallbackId(
  after: readonly MobileSavedLocation[],
  removedIndex: number,
): string | null {
  if (after.length === 0) {
    return null;
  }
  if (removedIndex < after.length) {
    return after[removedIndex]?.id ?? null;
  }
  return after[after.length - 1]?.id ?? null;
}

/** Internal selected-location initialization state. Distinct from the published snapshot shape. */
type SelectedLocationInternalState =
  | { readonly status: 'NOT_STARTED' }
  | { readonly status: 'LOADING' }
  | { readonly status: 'READY'; readonly selectedLocationId: string | null }
  | { readonly status: 'ERROR'; readonly kind: SelectedLocationInitializationErrorKind };

/**
 * Build a {@link SavedLocationApplicationStore} over an injected hydration store, saved-location
 * persistence, and selected-location persistence.
 *
 * Construction reads the hydration store's current snapshot once and subscribes to it — no
 * `hydrate()` call, no storage I/O, no timer, and no selected-location read (that only ever starts
 * from an explicit {@link SavedLocationApplicationStore.initializeSelectedLocation} call).
 *
 * **Mutation ordering.** The steps before the first `await` in every mutation run synchronously
 * within the call, and every mutation shares the same `writeStatus` lock:
 *
 * 1. reject with `WRITE_IN_PROGRESS` if a write is already `SAVING`, then with `NOT_READY` if the
 *    current state does not allow this mutation — in both cases without touching persistence;
 * 2. `add`/`remove` run the matching pure collection operation against the **committed** collection,
 *    returning its fixed error unchanged (still without touching persistence) when it fails;
 *    `select` validates its id argument and, for a no-op re-selection, returns success without any
 *    write or notification;
 * 3. publish `writeStatus: 'SAVING'` and notify;
 * 4. write the affected key(s) in the documented order — `select` writes only the selected-location
 *    key; a first add into an empty collection writes the selected-location key **before** the
 *    collection key; a remove of the selected location writes the fallback selected-location key
 *    **before** the collection key; every other `add`/`remove` writes only the collection key;
 * 5. on success, and only then, adopt the new collection/selection as committed;
 * 6. on failure of any write in the sequence, stop — no further write in that sequence is attempted,
 *    and the previously committed value(s) stand. No optimistic value was ever published, so there is
 *    nothing to roll back. A failure between two writes in the same mutation can leave the
 *    selected-location key holding a fallback the collection key does not yet reflect; this residual
 *    is safe because the next `initializeSelectedLocation()` always re-validates the persisted id
 *    against the (unwritten, still-previous) collection and never reads a stale id that no longer
 *    exists;
 * 7. return to `writeStatus: 'IDLE'` and notify, then return the fixed result.
 *
 * **Concurrency and reentrancy.** A second `add`/`remove`/`select` issued while a write is in flight
 * — including one issued reentrantly from a listener this store is notifying — returns
 * `WRITE_IN_PROGRESS` without starting a second write and without disturbing the first mutation's
 * state or promise. There is deliberately no write queue, debounce, batching, or compare-and-swap.
 * All store state is settled *before* the terminal notification, so a listener that starts a fresh
 * mutation from within it observes a fully consistent store.
 */
export function createSavedLocationApplicationStore({
  hydrationStore,
  persistence,
  selectedLocationPersistence,
}: SavedLocationApplicationStoreDependencies): SavedLocationApplicationStore {
  let hydrationSnapshot: SavedLocationHydrationState = hydrationStore.getSnapshot();
  let committed: readonly MobileSavedLocation[] | null =
    committedFromHydration(hydrationSnapshot);
  let writeStatus: SavedLocationApplicationWriteStatus = 'IDLE';
  let selectedState: SelectedLocationInternalState = { status: 'NOT_STARTED' };
  let selectedInitInFlight: Promise<void> | null = null;
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
          error: { scope: 'SAVED_LOCATIONS', kind: hydrationSnapshot.error.kind },
          writeStatus: 'IDLE',
        };
      case 'EMPTY':
      case 'READY': {
        // Past this point the committed collection — not the hydration snapshot — decides between
        // EMPTY and READY, so a mutation can flip the published status in either direction. But a
        // READY snapshot must always carry an authoritative selectedLocationId, so selected-location
        // initialization must finish first.
        if (selectedState.status === 'ERROR') {
          return {
            status: 'ERROR',
            error: { scope: 'SELECTED_LOCATION', kind: selectedState.kind },
            writeStatus: 'IDLE',
          };
        }
        if (selectedState.status !== 'READY') {
          return { status: 'SELECTION_LOADING', writeStatus: 'IDLE' };
        }

        const locations = committed ?? [];
        if (locations.length === 0) {
          return { status: 'EMPTY', selectedLocationId: null, writeStatus };
        }
        return {
          status: 'READY',
          locations,
          selectedLocationId: selectedState.selectedLocationId ?? locations[0]!.id,
          writeStatus,
        };
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

  /** Persist a saved-location collection; `null` on success, else the mutation error to surface. */
  async function performCollectionSave(
    nextCollection: readonly MobileSavedLocation[],
  ): Promise<SavedLocationApplicationErrorKind | null> {
    let saved: SavedLocationPersistenceSaveResult;
    try {
      saved = await persistence.save(nextCollection);
    } catch {
      // The persistence boundary is contractually throw-free; this guard only keeps a hostile or
      // broken injected implementation from rejecting the caller's mutation promise.
      saved = { ok: false, error: { kind: 'STORAGE_WRITE_FAILED' } };
    }
    if (saved.ok) {
      return null;
    }
    return saved.error.kind === 'INVALID_COLLECTION' ? 'INVALID_COLLECTION' : 'STORAGE_WRITE_FAILED';
  }

  /** Persist a selected-location id; `null` on success, else the mutation error to surface. */
  async function performSelectedSave(
    id: string | null,
  ): Promise<SavedLocationApplicationErrorKind | null> {
    let saved: SelectedLocationPersistenceSaveResult;
    try {
      saved = await selectedLocationPersistence.save(id);
    } catch {
      saved = { ok: false, error: { kind: 'STORAGE_WRITE_FAILED' } };
    }
    return saved.ok ? null : 'STORAGE_WRITE_FAILED';
  }

  async function runSelectedInitialization(): Promise<void> {
    let loadResult: SelectedLocationPersistenceLoadResult;
    try {
      loadResult = await selectedLocationPersistence.load();
    } catch {
      // The persistence boundary is contractually throw-free; this guard only keeps a hostile or
      // broken injected implementation from producing an unhandled rejection here.
      loadResult = { ok: false, error: { kind: 'STORAGE_READ_FAILED' } };
    }

    if (!loadResult.ok) {
      selectedState = { status: 'ERROR', kind: loadResult.error.kind };
      selectedInitInFlight = null;
      republish();
      return;
    }

    // `committed` cannot change while initialization is in flight: the top-level status is
    // SELECTION_LOADING until this settles, and every mutation requires EMPTY/READY, so no mutation
    // can run concurrently with this read.
    const resolved = resolveSelectedLocationId(committed ?? [], loadResult.selectedLocationId);
    selectedState = { status: 'READY', selectedLocationId: resolved };
    selectedInitInFlight = null;
    republish();
  }

  function initializeSelectedLocation(): Promise<void> {
    if (selectedState.status === 'READY') {
      return Promise.resolve();
    }
    if (selectedInitInFlight !== null) {
      return selectedInitInFlight;
    }
    // Saved-location hydration has not succeeded yet — nothing to resolve the preference against,
    // and no persistence read is performed until it has.
    if (committed === null) {
      return Promise.resolve();
    }

    selectedState = { status: 'LOADING' };
    republish();
    const promise = runSelectedInitialization();
    selectedInitInFlight = promise;
    return promise;
  }

  async function retryInitialization(): Promise<void> {
    if (hydrationSnapshot.status === 'ERROR') {
      await hydrationStore.hydrate();
      // The hydration store's subscribe callback above runs synchronously as part of settling that
      // promise, so `committed` already reflects the retry's outcome here.
      if (committed !== null) {
        await initializeSelectedLocation();
      }
      return;
    }
    if (selectedState.status === 'ERROR') {
      await initializeSelectedLocation();
    }
  }

  function isReadyForMutation(requireNonEmpty: boolean): boolean {
    if (committed === null || selectedState.status !== 'READY') {
      return false;
    }
    return !requireNonEmpty || committed.length > 0;
  }

  async function add(candidateInput: unknown): Promise<SavedLocationApplicationMutationResult> {
    if (writeStatus === 'SAVING') {
      return mutationFailure('WRITE_IN_PROGRESS');
    }
    if (!isReadyForMutation(false)) {
      return mutationFailure('NOT_READY');
    }

    const current = committed as readonly MobileSavedLocation[];
    const computed: SavedLocationCollectionResult = addSavedLocation(current, candidateInput);
    if (!computed.ok) {
      return mutationFailure(mapCollectionErrorKind(computed.error.kind));
    }

    const nextCollection = computed.locations;
    const isFirstAdd = current.length === 0;

    writeStatus = 'SAVING';
    republish();

    if (isFirstAdd) {
      const added = nextCollection[0];
      if (added === undefined) {
        // Defensive only: addSavedLocation on an empty collection always yields exactly one record.
        writeStatus = 'IDLE';
        republish();
        return mutationFailure('INVALID_COLLECTION');
      }

      const selectedError = await performSelectedSave(added.id);
      if (selectedError !== null) {
        writeStatus = 'IDLE';
        republish();
        return mutationFailure(selectedError);
      }

      const collectionError = await performCollectionSave(nextCollection);
      if (collectionError !== null) {
        writeStatus = 'IDLE';
        republish();
        return mutationFailure(collectionError);
      }

      committed = nextCollection;
      selectedState = { status: 'READY', selectedLocationId: added.id };
      writeStatus = 'IDLE';
      republish();
      return { ok: true };
    }

    const collectionError = await performCollectionSave(nextCollection);
    if (collectionError !== null) {
      writeStatus = 'IDLE';
      republish();
      return mutationFailure(collectionError);
    }

    committed = nextCollection;
    writeStatus = 'IDLE';
    republish();
    return { ok: true };
  }

  async function remove(locationIdInput: unknown): Promise<SavedLocationApplicationMutationResult> {
    if (writeStatus === 'SAVING') {
      return mutationFailure('WRITE_IN_PROGRESS');
    }
    if (!isReadyForMutation(true)) {
      return mutationFailure('NOT_READY');
    }

    const current = committed as readonly MobileSavedLocation[];
    const computed: SavedLocationCollectionResult = removeSavedLocation(current, locationIdInput);
    if (!computed.ok) {
      return mutationFailure(mapCollectionErrorKind(computed.error.kind));
    }

    const nextCollection = computed.locations;
    // `computed.ok` guarantees removeSavedLocation validated locationIdInput as a non-empty string
    // present in `current`.
    const removedId = locationIdInput as string;
    const currentSelectedId =
      selectedState.status === 'READY' ? selectedState.selectedLocationId : null;
    const removedWasSelected = removedId === currentSelectedId;

    writeStatus = 'SAVING';
    republish();

    if (!removedWasSelected) {
      const collectionError = await performCollectionSave(nextCollection);
      if (collectionError !== null) {
        writeStatus = 'IDLE';
        republish();
        return mutationFailure(collectionError);
      }

      committed = nextCollection;
      writeStatus = 'IDLE';
      republish();
      return { ok: true };
    }

    const removedIndex = current.findIndex((location) => location.id === removedId);
    const fallbackId = computeRemovalFallbackId(nextCollection, removedIndex);

    const selectedError = await performSelectedSave(fallbackId);
    if (selectedError !== null) {
      writeStatus = 'IDLE';
      republish();
      return mutationFailure(selectedError);
    }

    const collectionError = await performCollectionSave(nextCollection);
    if (collectionError !== null) {
      writeStatus = 'IDLE';
      republish();
      return mutationFailure(collectionError);
    }

    committed = nextCollection;
    selectedState = { status: 'READY', selectedLocationId: fallbackId };
    writeStatus = 'IDLE';
    republish();
    return { ok: true };
  }

  async function select(locationIdInput: unknown): Promise<SavedLocationApplicationMutationResult> {
    if (writeStatus === 'SAVING') {
      return mutationFailure('WRITE_IN_PROGRESS');
    }
    if (!isReadyForMutation(true)) {
      return mutationFailure('NOT_READY');
    }
    if (typeof locationIdInput !== 'string' || locationIdInput.trim() === '') {
      return mutationFailure('INVALID_LOCATION_ID');
    }

    const current = committed as readonly MobileSavedLocation[];
    const currentSelectedId =
      selectedState.status === 'READY' ? selectedState.selectedLocationId : null;

    if (locationIdInput === currentSelectedId) {
      // Successful no-op: zero persistence writes, zero notifications — the snapshot is already
      // semantically exactly this.
      return { ok: true };
    }
    if (!current.some((location) => location.id === locationIdInput)) {
      return mutationFailure('LOCATION_NOT_FOUND');
    }

    writeStatus = 'SAVING';
    republish();

    const selectedError = await performSelectedSave(locationIdInput);
    if (selectedError !== null) {
      writeStatus = 'IDLE';
      republish();
      return mutationFailure(selectedError);
    }

    selectedState = { status: 'READY', selectedLocationId: locationIdInput };
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

    initializeSelectedLocation,
    retryInitialization,
    select,
    add,
    remove,
  };
}
