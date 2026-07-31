/**
 * Concrete AsyncStorage production binding for the selected-location persistence boundary.
 *
 * The provider-neutral persistence boundary in {@link ./mobile-selected-location-persistence} owns
 * every policy — the stable storage key, the versioned V1 envelope, the encode/decode codec, and the
 * fixed, non-revealing error kinds. This module adds only the missing concrete piece: it adapts the
 * real Expo `@react-native-async-storage/async-storage` device store to that boundary's minimal
 * {@link SelectedLocationKeyValueStorage} port and builds the one production
 * {@link SelectedLocationPersistence} instance the app runtime uses.
 *
 * The binding is deliberately thin. It forwards exactly two methods — `getItem`, `setItem` — to
 * AsyncStorage and does nothing else: it never re-declares the storage key, never wraps calls in
 * `try/catch` (the boundary already translates a throw or rejection into the fixed
 * `STORAGE_READ_FAILED` / `STORAGE_WRITE_FAILED` kinds), never logs, and never uses any broad
 * AsyncStorage operation such as `clear()`, `getAllKeys()`, or the `multi*` batch methods.
 *
 * Importing this module, or reading {@link mobileSelectedLocationPersistence}, performs **no**
 * storage I/O: no `getItem` / `setItem`, no hydration, no network call, and no environment access.
 * Only the provider object and the persistence instance are created at import time.
 *
 * This binding is intentionally **not** re-exported from the pure `./index` barrel, so Node-based
 * unit tests and pure domain consumers never transitively load the native module — the same
 * boundary the existing saved-location binding
 * ({@link ./mobile-saved-location-async-storage}) already draws, kept as a small, separate concrete
 * binding rather than a shared generic storage abstraction.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  createSelectedLocationPersistence,
  type SelectedLocationKeyValueStorage,
  type SelectedLocationPersistence,
} from './mobile-selected-location-persistence';

/**
 * The {@link SelectedLocationKeyValueStorage} port backed by the real AsyncStorage device store.
 *
 * Each method forwards its arguments unchanged to the matching AsyncStorage method and returns the
 * provider's promise as-is — no key literal is introduced here (the caller passes the boundary's
 * stable key), no value is transformed, and no error is caught or translated.
 */
const asyncStorageSelectedLocationKeyValueStorage: SelectedLocationKeyValueStorage = {
  getItem(key) {
    return AsyncStorage.getItem(key);
  },

  setItem(key, value) {
    return AsyncStorage.setItem(key, value);
  },
};

/**
 * The single production {@link SelectedLocationPersistence} instance for the app runtime.
 *
 * Built once from the AsyncStorage-backed port via the existing
 * {@link createSelectedLocationPersistence} factory. Creating it touches no storage; the device
 * store is only read or written when `load` / `save` are actually called.
 */
export const mobileSelectedLocationPersistence: SelectedLocationPersistence =
  createSelectedLocationPersistence(asyncStorageSelectedLocationKeyValueStorage);
