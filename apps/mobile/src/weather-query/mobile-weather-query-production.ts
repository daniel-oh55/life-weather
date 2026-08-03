/**
 * Production composition of the mobile weather-query store.
 *
 * Reads the one public environment variable this boundary needs
 * (`EXPO_PUBLIC_API_BASE_URL`, via an exact static `process.env` property access — never a dynamic
 * key or an environment dump) and constructs the existing contract-safe `WeatherApiClient`
 * (`../weather-api`) with it, then wires that client into the provider-neutral
 * {@link createMobileWeatherQueryStore} factory exactly once.
 *
 * Importing this module performs no network I/O: `createWeatherApiClient` only normalizes/validates
 * its config (never throwing, even for a missing/blank/invalid base URL — an unusable
 * configuration instead surfaces as an `invalidClientConfiguration` result on the first
 * `fetchWeather` call), and `createMobileWeatherQueryStore` only initializes in-memory state.
 *
 * This module owns no query-state policy of its own — no state machine, no generation/abort
 * semantics, no error mapping — those all remain owned by `./mobile-weather-query-store`. Like the
 * other production composition modules in this app, it is deliberately **not** re-exported from the
 * pure `./index` barrel: a runtime consumer (the React hook) imports this file directly.
 */

import { createWeatherApiClient } from '../weather-api';

import {
  createMobileWeatherQueryStore,
  type MobileWeatherQueryStore,
} from './mobile-weather-query-store';

const baseUrl = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

const client = createWeatherApiClient({ baseUrl });

/** The single production {@link MobileWeatherQueryStore} for the app runtime. */
export const mobileWeatherQueryStore: MobileWeatherQueryStore = createMobileWeatherQueryStore({
  client,
});
