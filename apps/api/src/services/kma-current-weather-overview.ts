/**
 * The KMA (기상청) current-observation **current-only partial `WeatherOverview` assembler**: the
 * pure, deterministic application-service that turns one already-normalized contracts
 * {@link CurrentWeather} plus a caller-supplied live source context into a contracts
 * {@link WeatherOverview} — but only for the **current** section, the sole section this assembler
 * supplies.
 *
 * This is the current-observation counterpart of `kma-hourly-weather-overview.ts`
 * (`assembleKmaHourlyWeatherOverview`). It follows the same shape — location + already-computed
 * data + caller-provided provenance in, `weatherOverview.parse`-validated overview out, every other
 * section a fixed placeholder — but is a separate, parallel implementation: it is not generalized
 * with the hourly assembler into a shared abstraction, and it does not re-implement or duplicate the
 * hourly assembler's selection/provenance policy.
 *
 * ### Exact semantics
 *
 * Given the caller's `WeatherLocation`, `CurrentWeather`, and `source` provenance context, it
 * composes a single valid `WeatherOverview` in which:
 *
 * 1. `current` carries the caller's `CurrentWeather` value verbatim (no field is recomputed,
 *    rounded, defaulted, or re-derived),
 * 2. `hourly`/`daily`/`alerts` are `[]`, `airQuality.current` is `null`, and `airQuality.daily` is
 *    `[]` — every section this assembler cannot supply,
 * 3. `missingSections` is exactly `['HOURLY', 'DAILY', 'AIR_QUALITY_CURRENT',
 *    'AIR_QUALITY_FORECAST', 'ALERTS']` (`CURRENT` is never in this list, since `current` is
 *    always present), and
 * 4. `sources` is exactly one KMA `CURRENT` {@link SourceMetadata} entry.
 *
 * ### Current `SourceMetadata` — explicit-field construction, fixed current-data policy
 *
 * As of PR #73 this assembler is **metadata-aware**: the caller supplies exactly the three
 * provenance facts a live current source metadata resolver can materialize on its own —
 * {@link KmaCurrentSourceMetadataInput} (`sourceId`/`fetchedAt`/`retrievalMode`) — and the
 * assembler fixes the remaining four `SourceMetadata` fields from current-data semantics:
 *
 * - `provider` is fixed `'KMA'`.
 * - `sections` is fixed `['CURRENT']`.
 * - `issuedAt` is fixed `null` — 초단기실황 (current observation) is never expressed as forecast
 *   issuance metadata, and the assembler never copies or reconstructs a request-factory
 *   `baseDate`/`baseTime` into it.
 * - `observedAt` is fixed to `input.current.observedAt` verbatim — the assembler never reads a
 *   clock, re-derives, rounds, or defaults it.
 *
 * The `SourceMetadata` object is built with **explicit, named fields** — never `{ ...input.source
 * }` — so a runtime value that bypassed the `KmaCurrentSourceMetadataInput` type (e.g. an extra
 * `provider`/`sections`/`issuedAt`/`observedAt`/`location`/coordinate property on `input.source`)
 * can never override or leak into the fixed current-data policy fields. Only `sourceId`,
 * `fetchedAt`, and `retrievalMode` are read from `input.source`.
 *
 * ### Boundary — not the provider, not the service, not composition, not the route
 *
 * This assembler consumes an already-normalized `CurrentWeather` and a caller-provided source
 * context; it never calls a Provider, current-observation service, location facade, resolver, or
 * production composition, and it performs no location → grid conversion. It builds no
 * `hourly`/`daily`/air-quality/alerts data, wires into no production composition root, and touches
 * no route/cache/stale-data. Those are later PRs.
 *
 * ### Purity, allocation, and immutability
 *
 * Synchronous and pure: it returns no `Promise` and is not `async`; it performs no network,
 * Provider, service, facade, or resolver call; it reads no clock (`Date.now`/`new Date`),
 * environment (`process.env`), or `AbortSignal`; it logs nothing, holds no state/cache/singleton,
 * and uses no broad `try`/`catch`. It mutates nothing — not the input, the location, the current
 * weather, or the source context. It allocates a fresh output every call: `weatherOverview.parse`
 * produces fresh nested objects, so two calls with the same input never share output references.
 * The final `weatherOverview.parse` call is the only validation boundary — a malformed
 * `WeatherLocation`, `CurrentWeather`, `sourceId`, `fetchedAt`, or `retrievalMode` surfaces as a
 * synchronous Zod error rather than a silently-wrong payload.
 *
 * See `docs/kma-current-weather-overview.md` and `docs/kma-current-source-metadata.md`.
 */

import {
  weatherOverview,
  type CurrentWeather,
  type SourceMetadata,
  type WeatherLocation,
  type WeatherOverview,
} from '@life-weather/contracts';

/**
 * The provenance a caller must supply for the current source: exactly the three
 * {@link SourceMetadata} fields a live current source metadata resolver
 * (`kma-current-source-metadata.ts`) can materialize on its own — the app-internal `sourceId`, the
 * `fetchedAt` retrieval instant, and the `retrievalMode`. The assembler fixes the remaining
 * `SourceMetadata` fields itself (`provider: 'KMA'`, `sections: ['CURRENT']`, `issuedAt: null`,
 * `observedAt: CurrentWeather.observedAt`), so they are deliberately absent here.
 */
export type KmaCurrentSourceMetadataInput = Pick<
  SourceMetadata,
  'sourceId' | 'fetchedAt' | 'retrievalMode'
>;

/** The assembler input: a location, its already-normalized current observation, and its source context. */
export interface KmaCurrentWeatherOverviewInput {
  readonly location: WeatherLocation;
  readonly current: CurrentWeather;
  readonly source: KmaCurrentSourceMetadataInput;
}

/**
 * Assemble the current-only partial {@link WeatherOverview} from a `WeatherLocation`, an
 * already-normalized `CurrentWeather`, and a caller-supplied source context.
 *
 * The caller's `current` becomes the overview's `current` unchanged; every other data section is a
 * fixed empty/`null` placeholder, and `missingSections` names exactly those placeholders (`CURRENT`
 * is never included). `sources` carries exactly one KMA `CURRENT` {@link SourceMetadata} entry,
 * built from explicit, named fields — the caller's `sourceId`/`fetchedAt`/`retrievalMode` plus the
 * assembler's fixed `provider`/`sections`/`issuedAt`/`observedAt` — so no extra property on
 * `input.source` can override or leak into the fixed policy fields. The result is validated with
 * `weatherOverview.parse`, so a malformed location, current weather, or source field throws a
 * synchronous Zod error.
 *
 * Pure and synchronous: it reads only the caller's `location`, `current`, and `source`, allocates a
 * fresh overview each call, and mutates nothing.
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
    sources: [
      {
        sourceId: input.source.sourceId,
        provider: 'KMA',
        sections: ['CURRENT'],
        issuedAt: null,
        observedAt: input.current.observedAt,
        fetchedAt: input.source.fetchedAt,
        retrievalMode: input.source.retrievalMode,
      },
    ],
  } satisfies WeatherOverview;

  return weatherOverview.parse(overview);
}
