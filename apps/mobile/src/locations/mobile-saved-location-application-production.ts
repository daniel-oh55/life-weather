/**
 * Production composition of the saved-location application store.
 *
 * This module wires three existing production singletons into the provider-neutral application
 * store factory, exactly once each: the observable hydration store
 * ({@link mobileSavedLocationHydrationStore}, `./mobile-saved-location-hydration-production`), the
 * concrete AsyncStorage saved-location persistence instance ({@link mobileSavedLocationPersistence},
 * `./mobile-saved-location-async-storage`), and the concrete AsyncStorage selected-location
 * persistence instance ({@link mobileSelectedLocationPersistence},
 * `./mobile-selected-location-async-storage`). It owns no policy of its own — no storage key, no
 * envelope version, no collection invariant, no hydration state machine, no snapshot / notification
 * / mutation semantics — those all remain owned by the boundaries it only injects together.
 *
 * The existing hydration production composition is left untouched: this module reuses its exported
 * store rather than building a second manager or a second hydration store, so the app-root one-shot
 * startup, the hydration hook, and this application store all observe the same hydration instance.
 *
 * Importing this module, or reading the exported singleton, performs no storage I/O, calls no
 * `hydrate()`, and starts no selected-location initialization: the application store's construction
 * only reads the hydration store's synchronous, side-effect-free `getSnapshot()` and subscribes to
 * it. Selected-location initialization only ever starts from an explicit
 * `initializeSelectedLocation()` call (see `./mobile-location-application-startup`).
 *
 * Like the AsyncStorage bindings and the hydration composition it builds on, this module is
 * deliberately **not** re-exported from the pure `./index` barrel — importing it pulls in the native
 * `@react-native-async-storage/async-storage` module transitively. A runtime consumer (the React
 * hook, and a screen dispatching mutations) imports this file directly.
 */

import {
  createSavedLocationApplicationStore,
  type SavedLocationApplicationStore,
} from './mobile-saved-location-application-store';
import { mobileSavedLocationPersistence } from './mobile-saved-location-async-storage';
import { mobileSavedLocationHydrationStore } from './mobile-saved-location-hydration-production';
import { mobileSelectedLocationPersistence } from './mobile-selected-location-async-storage';

/**
 * The single production {@link SavedLocationApplicationStore} for the app runtime.
 *
 * Runtime consumers read its snapshot through the `useMobileSavedLocations` hook and dispatch
 * `retryHydration()` / `initializeSelectedLocation()` / `retryInitialization()` / `select()` /
 * `add()` / `remove()` against this singleton directly — there is deliberately no React Context,
 * provider, or generic action framework wrapping it.
 */
export const mobileSavedLocationApplicationStore: SavedLocationApplicationStore =
  createSavedLocationApplicationStore({
    hydrationStore: mobileSavedLocationHydrationStore,
    persistence: mobileSavedLocationPersistence,
    selectedLocationPersistence: mobileSelectedLocationPersistence,
  });
