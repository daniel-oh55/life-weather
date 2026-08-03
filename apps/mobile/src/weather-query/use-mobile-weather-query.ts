/**
 * React subscription + lifecycle boundary over the production weather-query store.
 *
 * Takes the exact `SavedLocationApplicationSnapshot` the caller already read from
 * `useMobileSavedLocations()` — it never calls that hook itself, so a screen keeps exactly one
 * saved-location store subscription. This hook owns only the decision of *when* to
 * request/reset the weather query for the currently selected saved location, and the correlation
 * guard that keeps a stale query from ever being shown for the wrong (or no longer resolvable)
 * location.
 *
 * Out of scope here: saved-location mutation, storage I/O, and any real network call (both remain
 * owned by `../locations` and `./mobile-weather-query-production` respectively).
 */

import { useEffect, useSyncExternalStore } from 'react';

import { createWeatherRequestFromSavedLocation } from '../locations';
import type { SavedLocationApplicationSnapshot } from '../locations';

import { mobileWeatherQueryStore } from './mobile-weather-query-production';
import type { MobileWeatherQuerySnapshot } from './mobile-weather-query-store';

/**
 * A stable, frozen `IDLE` snapshot for the render-time correlation guard below. Never the store's
 * own snapshot reference — this is returned *instead of* the store snapshot precisely when that
 * snapshot must not be shown yet (or any more).
 */
const SYNTHETIC_IDLE_SNAPSHOT: MobileWeatherQuerySnapshot = Object.freeze({ status: 'IDLE' });

function subscribeToMobileWeatherQuery(listener: () => void): () => void {
  return mobileWeatherQueryStore.subscribe(listener);
}

function getMobileWeatherQuerySnapshot(): MobileWeatherQuerySnapshot {
  return mobileWeatherQueryStore.getSnapshot();
}

/**
 * Subscribe to the production weather-query store and drive it from `savedLocations`.
 *
 * An effect requests a query only when `savedLocations.status === 'READY'`, the selected id names a
 * record actually present in `locations`, and mapping that record through
 * `createWeatherRequestFromSavedLocation` succeeds — any other case (including one that violates the
 * `READY` invariant) resets the store instead of requesting, without ever throwing. The effect's
 * dependencies are the semantic key only (`savedLocations.status`, and the selected id while
 * `READY`), so adding/removing a *non-selected* location — which only changes the snapshot object,
 * not that key — never re-requests the same selection's weather. Every cleanup (selection change,
 * leaving `READY`, or unmount) resets the store, which aborts any in-flight request.
 *
 * The value returned is never a stale one: before the effect has run for the current
 * `savedLocations`/store state, or whenever the store's `locationId` does not match the currently
 * selected id, the stable {@link SYNTHETIC_IDLE_SNAPSHOT} is returned instead of the real store
 * snapshot.
 */
export function useMobileWeatherQuery(
  savedLocations: SavedLocationApplicationSnapshot,
): MobileWeatherQuerySnapshot {
  const query = useSyncExternalStore(
    subscribeToMobileWeatherQuery,
    getMobileWeatherQuerySnapshot,
    getMobileWeatherQuerySnapshot,
  );

  const selectedLocationId =
    savedLocations.status === 'READY' ? savedLocations.selectedLocationId : null;

  useEffect(() => {
    // Not READY: request nothing. Any previously in-flight query is already reset by the *previous*
    // effect's own cleanup below when `savedLocations.status`/`selectedLocationId` changed away from
    // a requesting READY state (or there was never a query to reset, on a non-READY mount).
    if (savedLocations.status !== 'READY') {
      return undefined;
    }

    const record = savedLocations.locations.find(
      (location) => location.id === savedLocations.selectedLocationId,
    );
    if (record === undefined) {
      mobileWeatherQueryStore.reset();
      return undefined;
    }

    const requestResult = createWeatherRequestFromSavedLocation(record);
    if (!requestResult.ok) {
      mobileWeatherQueryStore.reset();
      return undefined;
    }

    mobileWeatherQueryStore.request(savedLocations.selectedLocationId, requestResult.request);

    return () => {
      mobileWeatherQueryStore.reset();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- semantic key only, see the doc comment.
  }, [savedLocations.status, selectedLocationId]);

  if (savedLocations.status !== 'READY') {
    return SYNTHETIC_IDLE_SNAPSHOT;
  }
  if (query.status === 'IDLE') {
    return SYNTHETIC_IDLE_SNAPSHOT;
  }
  if (query.locationId !== savedLocations.selectedLocationId) {
    return SYNTHETIC_IDLE_SNAPSHOT;
  }
  return query;
}
