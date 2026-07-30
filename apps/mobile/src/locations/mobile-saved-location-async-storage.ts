/**
 * Concrete AsyncStorage production binding for the saved-location persistence boundary.
 *
 * The provider-neutral persistence boundary in
 * {@link ./mobile-saved-location-persistence} owns every policy — the stable storage key, the
 * versioned V1 envelope, the encode/decode codec, and the fixed, non-revealing error kinds. This
 * module adds only the missing concrete piece: it adapts the real Expo
 * `@react-native-async-storage/async-storage` device store to that boundary's minimal
 * {@link SavedLocationKeyValueStorage} port and builds the one production
 * {@link SavedLocationPersistence} instance the app runtime uses.
 *
 * The binding is deliberately thin. It forwards exactly three methods — `getItem`, `setItem`,
 * `removeItem` — to AsyncStorage and does nothing else: it never re-declares the storage key,
 * never wraps calls in `try/catch` (the boundary already translates a throw or rejection into the
 * fixed `STORAGE_READ_FAILED` / `STORAGE_WRITE_FAILED` / `STORAGE_CLEAR_FAILED` kinds), never
 * logs, and never uses any broad AsyncStorage operation such as `clear()`, `getAllKeys()`, or the
 * `multi*` batch methods that could read or erase unrelated app data.
 *
 * AsyncStorage is asynchronous, persistent, **unencrypted** key-value storage. This binding stores
 * only the saved-location collection under the boundary's single key; no API key, token, password,
 * or authentication secret is ever written here, and no raw error or stored value is logged.
 *
 * Importing this module, or reading {@link mobileSavedLocationPersistence}, performs **no** storage
 * I/O: no `getItem` / `setItem` / `removeItem`, no hydration, no migration, no deletion, no network
 * call, and no environment access. Only the provider object and the persistence instance are
 * created at import time.
 *
 * This binding is intentionally **not** re-exported from the pure `./index` barrel, so Node-based
 * unit tests and pure domain consumers never transitively load the native module. A runtime
 * consumer imports it directly from this file. Out of scope here (later PRs): app-start hydration,
 * React state, the location-management screen, auto-save orchestration, migration execution, and
 * location permission. Because this adds a native module, an existing development client must be
 * rebuilt before the new binding runs on a real device.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  createSavedLocationPersistence,
  type SavedLocationKeyValueStorage,
  type SavedLocationPersistence,
} from './mobile-saved-location-persistence';

/**
 * The {@link SavedLocationKeyValueStorage} port backed by the real AsyncStorage device store.
 *
 * Each method forwards its arguments unchanged to the matching AsyncStorage method and returns the
 * provider's promise as-is — no key literal is introduced here (the caller passes the boundary's
 * stable key), no value is transformed, and no error is caught or translated. A synchronous throw
 * or a rejected promise propagates untouched to {@link createSavedLocationPersistence}, which owns
 * the fixed error classification.
 */
const asyncStorageSavedLocationKeyValueStorage: SavedLocationKeyValueStorage = {
  getItem(key) {
    return AsyncStorage.getItem(key);
  },

  setItem(key, value) {
    return AsyncStorage.setItem(key, value);
  },

  removeItem(key) {
    return AsyncStorage.removeItem(key);
  },
};

/**
 * The single production {@link SavedLocationPersistence} instance for the app runtime.
 *
 * Built once from the AsyncStorage-backed port via the existing
 * {@link createSavedLocationPersistence} factory. Creating it touches no storage; the device store
 * is only read or written when `load` / `save` / `clear` are actually called.
 */
export const mobileSavedLocationPersistence: SavedLocationPersistence =
  createSavedLocationPersistence(asyncStorageSavedLocationKeyValueStorage);
