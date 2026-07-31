/**
 * Thin React subscription boundary over the production saved-location application store.
 *
 * This module owns exactly one concern: exposing
 * {@link mobileSavedLocationApplicationStore}'s snapshot to React via `useSyncExternalStore`, so a
 * component can read its current, exact cached snapshot and re-render on a real semantic transition.
 * It redefines no policy of its own — no storage key, no envelope version, no error kind, no
 * hydration / retry / one-shot startup policy, no mutation ordering, no snapshot semantics.
 *
 * Mutations are deliberately **not** returned from this hook: a screen dispatches
 * `retryHydration()` / `add()` / `remove()` against the production store directly, so there is no
 * React Context, provider, or generic action framework to keep in sync with this subscription.
 *
 * Out of scope here: calling `hydrate()` or any mutation from the hook itself, screens, and any
 * real device QA.
 */

import { useSyncExternalStore } from 'react';

import { mobileSavedLocationApplicationStore } from './mobile-saved-location-application-production';
import type { SavedLocationApplicationSnapshot } from './mobile-saved-location-application-store';

/**
 * Delegates to the production store's `subscribe` — defined once at module scope so the reference
 * passed to `useSyncExternalStore` never changes across renders or hook calls.
 */
function subscribeToMobileSavedLocations(listener: () => void): () => void {
  return mobileSavedLocationApplicationStore.subscribe(listener);
}

/**
 * Delegates to the production store's `getSnapshot` — defined once at module scope so the reference
 * passed to `useSyncExternalStore` (as both the client and server getter) never changes across
 * renders or hook calls.
 */
function getMobileSavedLocationsSnapshot(): SavedLocationApplicationSnapshot {
  return mobileSavedLocationApplicationStore.getSnapshot();
}

/**
 * Subscribe to the production saved-location application store and return its current, exact cached
 * snapshot.
 *
 * Uses React's `useSyncExternalStore` with stable, module-scope subscribe/getter callbacks (the same
 * getter for both the client and server snapshot, since this store's cached snapshot is already safe
 * to read on either side). The returned value is the store's own cached snapshot reference — never
 * copied, spread, mapped, or re-validated. This hook never starts hydration and never dispatches a
 * mutation; importing or calling it performs no storage I/O by itself.
 */
export function useMobileSavedLocations(): SavedLocationApplicationSnapshot {
  return useSyncExternalStore(
    subscribeToMobileSavedLocations,
    getMobileSavedLocationsSnapshot,
    getMobileSavedLocationsSnapshot,
  );
}
