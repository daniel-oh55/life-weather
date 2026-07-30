/**
 * Production composition of the saved-location hydration manager and its observable store.
 *
 * This module wires three existing boundaries together, in one direction: the concrete AsyncStorage
 * persistence instance ({@link mobileSavedLocationPersistence},
 * {@link ./mobile-saved-location-async-storage}), the provider-neutral hydration manager factory
 * ({@link createSavedLocationHydrationManager}, {@link ./mobile-saved-location-hydration-manager}),
 * and the provider-neutral observable store factory ({@link createSavedLocationHydrationStore},
 * {@link ./mobile-saved-location-hydration-store}). It owns no policy of its own — no storage key,
 * no envelope version, no error kind, no collection invariant, no snapshot/notification semantics —
 * those all remain owned by the boundaries this module only injects together, in order: persistence
 * → manager → store.
 *
 * Importing this module, or reading either exported singleton, performs no storage I/O and does not
 * call `hydrate()`: constructing the persistence instance, the hydration manager, and the store is
 * synchronous and side-effect free (see all three source modules), so
 * `mobileSavedLocationHydrationManager.getState()` starts at `NOT_STARTED` and
 * `mobileSavedLocationHydrationStore.getSnapshot()` starts at `NOT_STARTED` too, until a runtime
 * consumer explicitly calls `hydrate()`.
 *
 * This module is deliberately **not** re-exported from the pure `./index` barrel — same reason as
 * the AsyncStorage binding it composes: importing it pulls in the native
 * `@react-native-async-storage/async-storage` module transitively, and the pure barrel must stay
 * safe for Node-based unit tests and pure domain consumers. A runtime consumer imports this file
 * directly.
 *
 * Out of scope here (later PRs): calling `hydrate()` at app start, React state/hooks/context,
 * screens, navigation, and any real device QA.
 */

import { mobileSavedLocationPersistence } from './mobile-saved-location-async-storage';
import {
  createSavedLocationHydrationManager,
  type SavedLocationHydrationManager,
} from './mobile-saved-location-hydration-manager';
import {
  createSavedLocationHydrationStore,
  type SavedLocationHydrationStore,
} from './mobile-saved-location-hydration-store';

/**
 * The single production {@link SavedLocationHydrationManager} for the app runtime, built by
 * injecting the concrete AsyncStorage persistence instance into the provider-neutral hydration
 * manager factory exactly once at module scope.
 */
export const mobileSavedLocationHydrationManager: SavedLocationHydrationManager =
  createSavedLocationHydrationManager(mobileSavedLocationPersistence);

/**
 * The single production {@link SavedLocationHydrationStore}, built by injecting
 * {@link mobileSavedLocationHydrationManager} into the provider-neutral store factory exactly once
 * at module scope — after the manager above, and over that same manager instance.
 */
export const mobileSavedLocationHydrationStore: SavedLocationHydrationStore =
  createSavedLocationHydrationStore(mobileSavedLocationHydrationManager);
