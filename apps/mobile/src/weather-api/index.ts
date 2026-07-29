/**
 * Public surface of the contract-safe mobile weather API client.
 *
 * The screen layer builds a `WeatherRequestV1` (mapping its local region store down to exactly
 * the shared `WeatherLocation` fields), calls `createWeatherApiClient({ baseUrl, fetchImpl })`,
 * and narrows the returned {@link WeatherApiResult}. Wiring the client into a screen is out of
 * scope for this module.
 */

export {
  createWeatherApiClient,
  type FetchWeatherOptions,
  type WeatherApiClient,
  type WeatherApiClientConfig,
  type WeatherApiFetch,
  type WeatherApiResult,
} from './weather-api-client';

export {
  weatherApiClientError,
  type WeatherApiClientError,
  type WeatherApiClientErrorKind,
} from './errors';
