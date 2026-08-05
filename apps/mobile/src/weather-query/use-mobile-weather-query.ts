/**
 * Read-only React subscription boundary over the production weather-query store.
 *
 * Takes the exact `SavedLocationApplicationSnapshot` the caller already read from
 * `useMobileSavedLocations()` — it never calls that hook itself, so a screen keeps exactly one
 * saved-location store subscription. This hook only subscribes to the store and correlates its
 * snapshot with the currently selected saved location; it owns no request/reset/retry lifecycle and
 * no effect of its own. The store's request/reset lifecycle is owned exclusively by
 * `./use-mobile-weather-query-lifecycle`, called once from the `(tabs)` layout — this hook can be
 * called from any number of screens without duplicating that ownership.
 *
 * Out of scope here: saved-location mutation, storage I/O, and any real network call (both remain
 * owned by `../locations` and `./mobile-weather-query-production` respectively).
 */

import { useSyncExternalStore } from 'react';

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
 * Subscribe to the production weather-query store and correlate its snapshot with `savedLocations`.
 *
 * The value returned is never a stale one: whenever `savedLocations.status !== 'READY'`, the store's
 * `locationId` does not match the currently selected id, or the store itself is `IDLE`, the stable
 * {@link SYNTHETIC_IDLE_SNAPSHOT} is returned instead of the real store snapshot. Otherwise the
 * store's exact cached snapshot reference is returned unmodified. This hook performs no network,
 * storage, or reset side effect by itself — importing or calling it alone never starts or stops a
 * query.
 */
export function useMobileWeatherQuery(
  savedLocations: SavedLocationApplicationSnapshot,
): MobileWeatherQuerySnapshot {
  const query = useSyncExternalStore(
    subscribeToMobileWeatherQuery,
    getMobileWeatherQuerySnapshot,
    getMobileWeatherQuerySnapshot,
  );

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
