/**
 * Public surface of the mobile saved-location boundary.
 *
 * The single-record layer validates one persisted {@link mobileSavedLocation} and turns it into a
 * contract-safe `WeatherRequestV1` via {@link createWeatherRequestFromSavedLocation}. The
 * collection layer manages many records as one canonical, validated value
 * ({@link mobileSavedLocationCollection}) with pure add / remove / reorder / set-current
 * operations. The persistence layer wraps that collection in a versioned V1 envelope and an
 * encode / decode codec, and load / save / clear it over an injected, provider-neutral key-value
 * storage port — without importing any concrete native store.
 *
 * This barrel stays a **pure, provider-neutral** surface: the concrete AsyncStorage production
 * binding lives in a separate module (`./mobile-saved-location-async-storage`) and is deliberately
 * **not** re-exported here, so Node-based unit tests and pure domain consumers never transitively
 * load the native module. A runtime consumer imports that binding directly.
 *
 * On top of persistence, the **hydration manager** layer
 * ({@link ./mobile-saved-location-hydration-manager}) reads that persistence boundary and exposes a
 * small `NOT_STARTED` / `LOADING` / `EMPTY` / `READY` / `ERROR` state machine with single-flight
 * concurrent hydration, idempotent success, and retryable failure. It stays provider-neutral too and
 * is exported from this same pure barrel. React state/hooks/context, screen wiring, and location
 * permission remain out of scope for this module.
 */

export {
  mobileKmaGrid,
  mobileSavedLocation,
  createWeatherRequestFromSavedLocation,
  type MobileKmaGrid,
  type MobileSavedLocation,
  type SavedLocationWeatherRequestResult,
} from './mobile-saved-location';

export {
  mobileSavedLocationCandidate,
  mobileSavedLocationCollection,
  addSavedLocation,
  removeSavedLocation,
  reorderSavedLocations,
  setCurrentSavedLocation,
  type MobileSavedLocationCandidate,
  type MobileSavedLocationCollection,
  type SavedLocationCollectionErrorKind,
  type SavedLocationCollectionResult,
} from './mobile-saved-location-collection';

export {
  SAVED_LOCATION_PERSISTENCE_VERSION,
  SAVED_LOCATION_PERSISTENCE_KEY,
  mobileSavedLocationPersistenceEnvelopeV1,
  encodeSavedLocationCollection,
  decodeSavedLocationCollection,
  createSavedLocationPersistence,
  type MobileSavedLocationPersistenceEnvelopeV1,
  type SavedLocationKeyValueStorage,
  type SavedLocationPersistenceErrorKind,
  type SavedLocationPersistenceEncodeResult,
  type SavedLocationPersistenceDecodeResult,
  type SavedLocationPersistenceLoadResult,
  type SavedLocationPersistenceSaveResult,
  type SavedLocationPersistenceClearResult,
  type SavedLocationPersistence,
} from './mobile-saved-location-persistence';

export {
  createSavedLocationHydrationManager,
  type SavedLocationHydrationErrorKind,
  type SavedLocationHydrationState,
  type SavedLocationHydrationManager,
} from './mobile-saved-location-hydration-manager';
