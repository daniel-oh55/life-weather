/**
 * Production composition of the saved-location hydration manager.
 *
 * This module wires exactly two existing boundaries together: the concrete AsyncStorage
 * persistence instance ({@link mobileSavedLocationPersistence},
 * {@link ./mobile-saved-location-async-storage}) and the provider-neutral hydration manager
 * factory ({@link createSavedLocationHydrationManager},
 * {@link ./mobile-saved-location-hydration-manager}). It owns no policy of its own — no storage
 * key, no envelope version, no error kind, no collection invariant — those all remain owned by the
 * boundaries this module only injects together.
 *
 * Importing this module, or reading {@link mobileSavedLocationHydrationManager}, performs no
 * storage I/O and does not call `hydrate()`: constructing the persistence instance and the
 * hydration manager is synchronous and side-effect free (see both source modules), so the exported
 * singleton starts at `NOT_STARTED` until a runtime consumer explicitly calls `hydrate()`.
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

/**
 * The single production {@link SavedLocationHydrationManager} for the app runtime, built by
 * injecting the concrete AsyncStorage persistence instance into the provider-neutral hydration
 * manager factory exactly once at module scope.
 */
export const mobileSavedLocationHydrationManager: SavedLocationHydrationManager =
  createSavedLocationHydrationManager(mobileSavedLocationPersistence);
