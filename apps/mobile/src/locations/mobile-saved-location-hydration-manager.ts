/**
 * Provider-neutral saved-location hydration manager.
 *
 * This module reads the {@link SavedLocationPersistence} boundary from PR #41/#42 exactly once per
 * hydration cycle and exposes the outcome as a small state machine
 * ({@link SavedLocationHydrationState}): `NOT_STARTED` → `LOADING` → one of `EMPTY` / `READY` /
 * `ERROR`. It owns three concerns and nothing else:
 *
 * - **single-flight hydration** — concurrent {@link SavedLocationHydrationManager.hydrate} calls
 *   made while a load is in flight share the same underlying operation, so `persistence.load()` is
 *   called at most once per cycle;
 * - **idempotent success, retryable failure** — once hydration reaches `EMPTY` or `READY`, further
 *   `hydrate()` calls are no-op successes that never call `load()` again; from `ERROR`, `hydrate()`
 *   starts a fresh attempt;
 * - **defensive, non-revealing failure** — a synchronous throw or a rejected promise from the
 *   injected `persistence.load()` is always converted to `{ status: 'ERROR', error: { kind:
 *   'STORAGE_READ_FAILED' } }`, never a rejected `hydrate()` promise and never a raw error, Zod
 *   issue, or stored location value.
 *
 * Out of scope for this module (later PRs): AsyncStorage / any concrete native store, React state /
 * hooks / context, `useSyncExternalStore` or other subscription contracts, screens, navigation,
 * add/remove/reorder mutation, auto-save, write queues/backoff, refresh or background rehydration,
 * stale-data policy, migration/repair, location permission/GPS, and any real network call.
 * Constructing a manager, or importing this module, performs no storage I/O, no environment access,
 * and no network call — the first `getState()` is always `NOT_STARTED`.
 */

import { type MobileSavedLocation } from './mobile-saved-location';
import { type SavedLocationPersistence } from './mobile-saved-location-persistence';

/** The three load-failure kinds this manager can surface — a subset of the persistence error kinds. */
export type SavedLocationHydrationErrorKind =
  | 'STORAGE_READ_FAILED'
  | 'INVALID_STORED_LOCATIONS'
  | 'UNSUPPORTED_STORED_VERSION';

/**
 * The public hydration state.
 *
 * - `NOT_STARTED` — the manager was created but {@link SavedLocationHydrationManager.hydrate} has
 *   never been called.
 * - `LOADING` — a hydration attempt is in flight.
 * - `EMPTY` — hydration succeeded and the stored collection has no locations.
 * - `READY` — hydration succeeded and `locations` holds the stored collection (never empty).
 * - `ERROR` — hydration failed; `error.kind` is the fixed, non-revealing discriminator. No raw
 *   storage error, Zod issue, stored string, location id, display name, coordinate, or grid is ever
 *   attached.
 */
export type SavedLocationHydrationState =
  | { readonly status: 'NOT_STARTED' }
  | { readonly status: 'LOADING' }
  | { readonly status: 'EMPTY' }
  | { readonly status: 'READY'; readonly locations: readonly MobileSavedLocation[] }
  | {
      readonly status: 'ERROR';
      readonly error: { readonly kind: SavedLocationHydrationErrorKind };
    };

/** The manager's public surface: read the current state, and (re)start hydration. */
export interface SavedLocationHydrationManager {
  /**
   * The current hydration state. Always returns a fresh top-level object (and, for `READY`, a
   * fresh `locations` array with fresh records and fresh non-null `kmaGrid` objects) so a caller
   * can never mutate the manager's internal state through a previously returned snapshot, and two
   * calls never share a reference.
   */
  getState(): SavedLocationHydrationState;

  /**
   * Start hydration, or join / no-op depending on the current state:
   *
   * - `NOT_STARTED` or `ERROR` — synchronously transitions to `LOADING`, then calls
   *   `persistence.load()` exactly once and settles to `EMPTY` / `READY` / `ERROR`.
   * - `LOADING` (hydration already in flight) — returns the same in-flight promise; `load()` is not
   *   called again.
   * - `EMPTY` or `READY` — a no-op that resolves immediately without calling `load()` again.
   *
   * The returned promise never rejects: any synchronous throw or rejection from `persistence.load()`
   * is caught and converted to the `ERROR` state before this promise resolves.
   */
  hydrate(): Promise<void>;
}

/** Fresh top-level object per call; only `READY`/`ERROR` carry data that also needs a fresh copy. */
type InternalState =
  | { readonly status: 'NOT_STARTED' | 'LOADING' | 'EMPTY' }
  | { readonly status: 'READY'; readonly locations: readonly MobileSavedLocation[] }
  | { readonly status: 'ERROR'; readonly kind: SavedLocationHydrationErrorKind };

/**
 * Clone one saved location for a hydration snapshot: a fresh top-level object, and a fresh
 * non-null `kmaGrid` (a null `kmaGrid` stays `null`). Every other field is a primitive and is safe
 * to copy by value. Never mutates the input, so a deep-frozen `persistence.load()` result is safe
 * to read from.
 */
function cloneSavedLocationSnapshot(location: MobileSavedLocation): MobileSavedLocation {
  return {
    ...location,
    kmaGrid: location.kmaGrid === null ? null : { ...location.kmaGrid },
  };
}

/**
 * Build a {@link SavedLocationHydrationManager} over an injected {@link SavedLocationPersistence}.
 *
 * Neither this factory nor importing the module calls `load` / `save` / `clear` or performs any
 * I/O — the injected persistence is only touched when {@link SavedLocationHydrationManager.hydrate}
 * is called, and only ever via `load()` (this manager never calls `save` or `clear`).
 */
export function createSavedLocationHydrationManager(
  persistence: SavedLocationPersistence,
): SavedLocationHydrationManager {
  let internal: InternalState = { status: 'NOT_STARTED' };
  let inFlight: Promise<void> | null = null;

  async function runHydration(): Promise<void> {
    try {
      const result = await persistence.load();
      if (!result.ok) {
        internal = { status: 'ERROR', kind: result.error.kind };
      } else if (result.locations.length === 0) {
        internal = { status: 'EMPTY' };
      } else {
        internal = { status: 'READY', locations: result.locations.map(cloneSavedLocationSnapshot) };
      }
    } catch {
      internal = { status: 'ERROR', kind: 'STORAGE_READ_FAILED' };
    } finally {
      inFlight = null;
    }
  }

  return {
    getState(): SavedLocationHydrationState {
      switch (internal.status) {
        case 'NOT_STARTED':
          return { status: 'NOT_STARTED' };
        case 'LOADING':
          return { status: 'LOADING' };
        case 'EMPTY':
          return { status: 'EMPTY' };
        case 'READY':
          return { status: 'READY', locations: internal.locations.map(cloneSavedLocationSnapshot) };
        case 'ERROR':
          return { status: 'ERROR', error: { kind: internal.kind } };
      }
    },

    // A plain (non-`async`) function, so a concurrent call that joins an in-flight hydration
    // returns that *exact* promise reference rather than a newly wrapped one — an `async` wrapper
    // here would allocate a new promise per call even when just forwarding `inFlight`.
    hydrate(): Promise<void> {
      if (internal.status === 'READY' || internal.status === 'EMPTY') {
        return Promise.resolve();
      }

      if (inFlight !== null) {
        return inFlight;
      }

      internal = { status: 'LOADING' };
      inFlight = runHydration();
      return inFlight;
    },
  };
}
