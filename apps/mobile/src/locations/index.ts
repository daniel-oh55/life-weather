/**
 * Public surface of the mobile saved-location boundary.
 *
 * A future location store / collection adapter consumes {@link mobileSavedLocation} to validate
 * persisted records, and calls {@link createWeatherRequestFromSavedLocation} to turn a saved
 * location into a contract-safe `WeatherRequestV1` before handing it to the weather API client.
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
