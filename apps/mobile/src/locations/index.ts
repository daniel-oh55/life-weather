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
 * concurrent hydration, idempotent success, and retryable failure. On top of that, the **observable
 * hydration store** ({@link ./mobile-saved-location-hydration-store}) wraps the manager with a
 * stable, deep-frozen cached snapshot and a subscribe/notify contract a React `useSyncExternalStore`
 * consumer can read. On top of both, the **application store**
 * ({@link ./mobile-saved-location-application-store}) observes that hydration store, owns the
 * committed collection, and adds the write side: explicit hydration retry plus persistence-backed
 * add / remove that publish a new collection only after `persistence.save()` succeeds. All of these
 * layers stay provider-neutral and are exported from this same pure barrel. React hooks/context,
 * screen wiring, and location permission remain out of scope for this module.
 *
 * Alongside the saved-location boundary, this barrel also exports the **KMA Korean location
 * catalog** (`./catalog/kma-korean-location-catalog`, generated from an official KMA reference
 * dataset — see `docs/kma-korean-location-catalog.md`), its provenance manifest, a substring
 * search over that static catalog ({@link searchKmaKoreanLocations}), and the mapping from a
 * catalog entry to a {@link MobileSavedLocationCandidate}
 * ({@link createSavedLocationCandidateFromKmaCatalogEntry}). These stay provider-neutral too — no
 * network or storage I/O, no UI.
 *
 * This barrel also exports the **selected-location persistence** boundary
 * ({@link ./mobile-selected-location-persistence}) — a separate versioned V1 envelope, under a
 * separate stable key, for the id of the saved location the user is currently viewing
 * (`selectedLocationId`). This is a distinct concept from a saved location's `isCurrent` flag (the
 * device's real GPS-derived current-location record) and the two are never combined. The
 * coordination of this selection against the saved-location collection — resolution/fallback,
 * `select()`, and the cross-key write ordering for the first add and a selected removal — lives in
 * the existing application store ({@link ./mobile-saved-location-application-store}), not a new
 * module; see `docs/mobile-selected-location.md`. The concrete AsyncStorage binding for this
 * persistence (`./mobile-selected-location-async-storage`) follows the same pure/native barrel
 * split as the saved-location binding and is not exported here.
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

export {
  createSavedLocationHydrationStore,
  type SavedLocationHydrationStore,
  type SavedLocationHydrationStoreListener,
} from './mobile-saved-location-hydration-store';

export {
  createSavedLocationApplicationStore,
  type SavedLocationApplicationErrorInfo,
  type SavedLocationApplicationErrorKind,
  type SavedLocationApplicationErrorScope,
  type SavedLocationApplicationMutationResult,
  type SavedLocationApplicationSnapshot,
  type SavedLocationApplicationStore,
  type SavedLocationApplicationStoreDependencies,
  type SavedLocationApplicationStoreListener,
  type SavedLocationApplicationWriteStatus,
} from './mobile-saved-location-application-store';

export {
  SELECTED_LOCATION_PERSISTENCE_VERSION,
  SELECTED_LOCATION_PERSISTENCE_KEY,
  mobileSelectedLocationPersistenceEnvelopeV1,
  encodeSelectedLocationId,
  decodeSelectedLocationId,
  createSelectedLocationPersistence,
  type MobileSelectedLocationPersistenceEnvelopeV1,
  type SelectedLocationKeyValueStorage,
  type SelectedLocationPersistenceErrorKind,
  type SelectedLocationPersistenceEncodeResult,
  type SelectedLocationPersistenceDecodeResult,
  type SelectedLocationPersistenceLoadResult,
  type SelectedLocationPersistenceSaveResult,
  type SelectedLocationPersistence,
} from './mobile-selected-location-persistence';

export {
  kmaKoreanLocationCatalog,
  kmaKoreanLocationCatalogEntry,
  kmaKoreanLocationKmaGrid,
  type KmaKoreanLocationCatalogEntry,
} from './catalog/kma-korean-location-catalog';

export {
  kmaKoreanLocationSourceManifest,
  type KmaKoreanLocationSourceManifest,
} from './catalog/kma-korean-location-source-manifest';

export {
  searchKmaKoreanLocations,
  type KmaKoreanLocationSearchErrorKind,
  type KmaKoreanLocationSearchOptions,
  type KmaKoreanLocationSearchResult,
} from './kma-korean-location-search';

export {
  createSavedLocationCandidateFromKmaCatalogEntry,
  type SavedLocationCandidateFromCatalogErrorKind,
  type SavedLocationCandidateFromCatalogResult,
} from './kma-korean-location-candidate';
