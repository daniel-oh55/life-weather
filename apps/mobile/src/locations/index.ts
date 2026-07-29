/**
 * Public surface of the mobile saved-location boundary.
 *
 * The single-record layer validates one persisted {@link mobileSavedLocation} and turns it into a
 * contract-safe `WeatherRequestV1` via {@link createWeatherRequestFromSavedLocation}. The
 * collection layer manages many records as one canonical, validated value
 * ({@link mobileSavedLocationCollection}) with pure add / remove / reorder / set-current
 * operations. A future storage adapter consumes the collection schema as its persistence boundary.
 * Storage, permission, and screen wiring are out of scope for this module.
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
