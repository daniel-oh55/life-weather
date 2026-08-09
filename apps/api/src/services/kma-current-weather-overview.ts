/**
 * The KMA (기상청) current-observation **current-only partial `WeatherOverview` assembler**: the
 * pure, deterministic application-service that turns one already-normalized contracts
 * {@link CurrentWeather} into a contracts {@link WeatherOverview} — but only for the **current**
 * section, the sole section this assembler supplies.
 *
 * This is the current-observation counterpart of `kma-hourly-weather-overview.ts`
 * (`assembleKmaHourlyWeatherOverview`). It follows the same shape — location + already-computed
 * data in, `weatherOverview.parse`-validated overview out, every other section a fixed placeholder
 * — but is a separate, parallel implementation: it is not generalized with the hourly assembler
 * into a shared abstraction, and it does not re-implement or duplicate the hourly assembler's
 * selection/provenance policy.
 *
 * ### Exact semantics
 *
 * Given the caller's `WeatherLocation` and `CurrentWeather`, it composes a single valid
 * `WeatherOverview` in which:
 *
 * 1. `current` carries the caller's `CurrentWeather` value verbatim (no field is recomputed,
 *    rounded, defaulted, or re-derived),
 * 2. `hourly`/`daily`/`alerts` are `[]`, `airQuality.current` is `null`, and `airQuality.daily` is
 *    `[]` — every section this assembler cannot supply,
 * 3. `missingSections` is exactly `['HOURLY', 'DAILY', 'AIR_QUALITY_CURRENT',
 *    'AIR_QUALITY_FORECAST', 'ALERTS']` (`CURRENT` is never in this list, since `current` is
 *    always present), and
 * 4. `sources` is exactly `[]`.
 *
 * ### `sources: []` — provenance is deferred, not invented
 *
 * The contracts `weatherOverview` schema enforces `current === null ↔ 'CURRENT' ∈ missingSections`,
 * but it does **not** require a `SourceMetadata` entry whenever `current` is present. This
 * assembler does not invent one: it never decides a `sourceId`, `provider`, `sections`, `issuedAt`,
 * `observedAt`, `fetchedAt`, or `retrievalMode` for the current data. Resolving current
 * `SourceMetadata` — and the relationship (if any) between `CurrentWeather.observedAt` and
 * `SourceMetadata.observedAt` — is a later PR's responsibility.
 *
 * ### Boundary — not the provider, not the service, not composition, not the route
 *
 * This assembler consumes an already-normalized `CurrentWeather`; it never calls a Provider,
 * current-observation service, location facade, or production composition, and it performs no
 * location → grid conversion. It builds no `hourly`/`daily`/air-quality/alerts data, wires into no
 * production composition root, and touches no route/cache/stale-data. Those are later PRs.
 *
 * ### Purity, allocation, and immutability
 *
 * Synchronous and pure: it returns no `Promise` and is not `async`; it performs no network,
 * Provider, service, or facade call; it reads no clock (`Date.now`/`new Date`), environment
 * (`process.env`), or `AbortSignal`; it logs nothing, holds no state/cache/singleton, and uses no
 * broad `try`/`catch`. It mutates nothing — not the input, the location, or the current weather. It
 * allocates a fresh output every call: `weatherOverview.parse` produces fresh nested objects, so
 * two calls with the same input never share output references. The final `weatherOverview.parse`
 * call is the only validation boundary — a malformed `WeatherLocation` or `CurrentWeather` surfaces
 * as a synchronous Zod error rather than a silently-wrong payload.
 *
 * See `docs/kma-current-weather-overview.md`.
 */

import {
  weatherOverview,
  type CurrentWeather,
  type WeatherLocation,
  type WeatherOverview,
} from '@life-weather/contracts';

/** The assembler input: a location and its already-normalized current observation. */
export interface KmaCurrentWeatherOverviewInput {
  readonly location: WeatherLocation;
  readonly current: CurrentWeather;
}

/**
 * Assemble the current-only partial {@link WeatherOverview} from a `WeatherLocation` and an
 * already-normalized `CurrentWeather`.
 *
 * The caller's `current` becomes the overview's `current` unchanged; every other data section is a
 * fixed empty/`null` placeholder, and `missingSections` names exactly those placeholders (`CURRENT`
 * is never included). `sources` is fixed `[]` — this assembler does not invent provenance for the
 * current data. The result is validated with `weatherOverview.parse`, so a malformed location or
 * current weather throws a synchronous Zod error.
 *
 * Pure and synchronous: it reads only the caller's `location` and `current`, allocates a fresh
 * overview each call, and mutates nothing.
 */
export function assembleKmaCurrentWeatherOverview(
  input: KmaCurrentWeatherOverviewInput,
): WeatherOverview {
  const overview = {
    location: input.location,
    current: input.current,
    hourly: [],
    daily: [],
    airQuality: {
      current: null,
      daily: [],
    },
    alerts: [],
    missingSections: [
      'HOURLY',
      'DAILY',
      'AIR_QUALITY_CURRENT',
      'AIR_QUALITY_FORECAST',
      'ALERTS',
    ],
    sources: [],
  } satisfies WeatherOverview;

  return weatherOverview.parse(overview);
}
