/**
 * Thin React subscription boundary over the production saved-location hydration store.
 *
 * This module owns exactly one concern: exposing
 * {@link mobileSavedLocationHydrationStore} to React via `useSyncExternalStore` so a component can
 * read its current, exact cached snapshot and re-render on a real semantic state transition. It
 * redefines no policy of its own — no storage key, no envelope version, no error kind, no retry or
 * one-shot startup policy, no snapshot/notification semantics — all of that remains owned by the
 * store, the manager beneath it, and the app-root startup boundary.
 *
 * Out of scope here (later PRs): calling `hydrate()`, calling
 * {@link startMobileSavedLocationHydrationOnce}, any explicit retry, screens, context/providers,
 * loading/empty/ready/error UI, and any location mutation or real device QA.
 */

import { useSyncExternalStore } from 'react';

import type { SavedLocationHydrationState } from './mobile-saved-location-hydration-manager';
import { mobileSavedLocationHydrationStore } from './mobile-saved-location-hydration-production';

/**
 * Delegates to the production store's `subscribe` — defined once at module scope so the reference
 * passed to `useSyncExternalStore` never changes across renders or hook calls.
 */
function subscribeToMobileSavedLocationHydration(listener: () => void): () => void {
  return mobileSavedLocationHydrationStore.subscribe(listener);
}

/**
 * Delegates to the production store's `getSnapshot` — defined once at module scope so the reference
 * passed to `useSyncExternalStore` (as both the client and server getter) never changes across
 * renders or hook calls.
 */
function getMobileSavedLocationHydrationSnapshot(): SavedLocationHydrationState {
  return mobileSavedLocationHydrationStore.getSnapshot();
}

/**
 * Subscribe to the production saved-location hydration store and return its current, exact cached
 * snapshot.
 *
 * Uses React's `useSyncExternalStore` with stable, module-scope subscribe/getter callbacks (the same
 * getter for both the client and server snapshot, since this store's cached snapshot is already safe
 * to read on either side). The returned value is the store's own cached snapshot reference — never
 * copied, spread, mapped, or re-validated. This hook never calls `hydrate()`, never starts app-root
 * hydration, and performs no storage I/O by itself; importing or calling it only subscribes to and
 * reads whatever state the store (driven elsewhere, e.g. the app-root one-shot startup) already
 * holds.
 */
export function useMobileSavedLocationHydration(): SavedLocationHydrationState {
  return useSyncExternalStore(
    subscribeToMobileSavedLocationHydration,
    getMobileSavedLocationHydrationSnapshot,
    getMobileSavedLocationHydrationSnapshot,
  );
}
