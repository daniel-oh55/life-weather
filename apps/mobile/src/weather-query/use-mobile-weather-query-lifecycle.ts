/**
 * Sole React owner of the weather-query request/reset lifecycle.
 *
 * Takes the exact `SavedLocationApplicationSnapshot` the caller already read from
 * `useMobileSavedLocations()` — it never calls that hook itself. This hook owns only the decision
 * of *when* to request/reset the weather query for the currently selected saved location; it
 * publishes nothing and returns nothing, so it must be called exactly once in the production tree
 * (the `(tabs)` layout) regardless of how many screens separately read the query via the read-only
 * `useMobileWeatherQuery` hook.
 *
 * Out of scope here: saved-location mutation, storage I/O, any real network call, and reading the
 * query snapshot itself (both remain owned by `../locations` and `./mobile-weather-query-store`
 * respectively; snapshot reads belong to `./use-mobile-weather-query`).
 */

import { useEffect } from 'react';

import { createWeatherRequestFromSavedLocation } from '../locations';
import type { SavedLocationApplicationSnapshot } from '../locations';

import { mobileWeatherQueryStore } from './mobile-weather-query-production';

/**
 * Drive the production weather-query store's request/reset lifecycle from `savedLocations`.
 *
 * An effect requests a query only when `savedLocations.status === 'READY'`, the selected id names a
 * record actually present in `locations`, and mapping that record through
 * `createWeatherRequestFromSavedLocation` succeeds. Otherwise the effect never throws, and what it
 * does instead depends on which case applies: on an initial non-`READY` mount it starts no request
 * and calls no reset (there is no previous query to tear down yet); on a transition away from a
 * requesting `READY` state (to non-`READY`, or to a different selection) the *previous* effect's own
 * cleanup already reset the store, so the new effect does not reset again; only a `READY` snapshot
 * that itself violates the invariant (an unresolvable selected id, or a mapping failure) makes the
 * current effect call `reset()` explicitly instead of requesting. The effect's dependencies are the
 * semantic key only (`savedLocations.status`, and the selected id while `READY`), so adding/removing
 * a *non-selected* location — which only changes the snapshot object, not that key — never
 * re-requests the same selection's weather. Every cleanup (selection change, leaving `READY`, or
 * unmount) resets the store, which aborts any in-flight request.
 */
export function useMobileWeatherQueryLifecycle(
  savedLocations: SavedLocationApplicationSnapshot,
): void {
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

    mobileWeatherQueryStore.request(requestResult.request);

    return () => {
      mobileWeatherQueryStore.reset();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- semantic key only, see the doc comment.
  }, [savedLocations.status, selectedLocationId]);
}
