/**
 * Public surface of the mobile weather-query boundary.
 *
 * Pure and provider-neutral: only the store factory and its types are exported here. The
 * production composition (`./mobile-weather-query-production`, which reads
 * `EXPO_PUBLIC_API_BASE_URL` and constructs the real `WeatherApiClient`) and the React hook
 * (`./use-mobile-weather-query`) are deliberately **not** re-exported, so a pure/Node consumer of
 * this barrel never transitively loads the environment or React.
 */

export {
  createMobileWeatherQueryStore,
  type MobileWeatherQueryErrorPresentation,
  type MobileWeatherQuerySnapshot,
  type MobileWeatherQueryStore,
  type MobileWeatherQueryStoreDependencies,
} from './mobile-weather-query-store';
