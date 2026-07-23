/**
 * The KMA (기상청) hourly **partial `WeatherOverview` assembler**: the pure, deterministic
 * application-service that turns one already-computed PR #22 hourly-fallback selection into the
 * contracts {@link WeatherOverview} — but only for the **hourly** section, the sole section the
 * pipeline can currently supply.
 *
 * The PR #22 selector decides *which* hourly result — the availability-aware `PRIMARY`, the
 * single-step-back `PREVIOUS`, or *none* — a downstream consumer may use as its data source. It stops
 * there: it builds no `WeatherOverview` and no `SourceMetadata`. This assembler is that downstream
 * consumer for the hourly slice. Given the caller's `WeatherLocation`, the selection, and (only for a
 * selected source) an explicit `SourceMetadata` provenance context, it composes a single valid
 * `WeatherOverview` in which:
 *
 * 1. `hourly` carries the selected result's forecast (or `[]` when nothing was selected),
 * 2. `sources` carries exactly one KMA `HOURLY` {@link SourceMetadata} (or `[]` when nothing was
 *    selected), and
 * 3. `missingSections` names exactly the sections this partial overview does **not** yet supply.
 *
 * Every other section is a fixed placeholder: `current: null`, `daily: []`, `airQuality.current: null`,
 * `airQuality.daily: []`, `alerts: []`. The contracts `weatherOverview` schema enforces the
 * object-section biconditionals (`current` ↔ `CURRENT`, `airQuality.current` ↔ `AIR_QUALITY_CURRENT`)
 * and rejects populated list data when its section is marked missing (a populated `hourly` must **not**
 * mark `HOURLY` missing). Because the schema does **not** by itself reject an empty `hourly` list whose
 * section is *not* marked missing, this assembler additionally validates that every selected result
 * contains at least one hourly entry (the module-local `nonEmptyHourlyForecasts` guard) before creating
 * the selected overview; the no-selection arm instead empties `hourly` and marks `HOURLY` missing. So in
 * every assembled output `HOURLY` presence matches the selected / no-selection state exactly. The
 * assembler returns `weatherOverview.parse(overview)`, so a malformed location, a bad timestamp, an
 * empty `sourceId`, a selected-empty `hourly`, or any invariant breach surfaces as a synchronous Zod
 * validation error rather than a silently-wrong payload.
 *
 * ### Selected vs no-selection
 *
 * - **hourly source selected** (`selection.selected === true`) — the selected result's `hourly` is the
 *   overview's `hourly`; the caller's provenance becomes one KMA `HOURLY` source; `HOURLY` is **not**
 *   missing. Missing: `CURRENT`, `DAILY`, `AIR_QUALITY_CURRENT`, `AIR_QUALITY_FORECAST`, `ALERTS`.
 * - **no selection** (`selection.selected === false`) — `hourly` is `[]`, `sources` is `[]`, and
 *   `HOURLY` joins the missing set. Missing: `CURRENT`, `HOURLY`, `DAILY`, `AIR_QUALITY_CURRENT`,
 *   `AIR_QUALITY_FORECAST`, `ALERTS`. No source metadata is fabricated for a source that was not chosen.
 *
 * ### Provenance boundary — caller-provided, never inferred
 *
 * A `KmaHourlyForecastServiceResult` carries only the normalized `hourly` array; it has no selected
 * request, base issuance, `issuedAt`, `fetchedAt`, retrieval mode, or app-internal `sourceId`. So the
 * assembler never *infers* provenance. The caller supplies `sourceId`, `issuedAt`, `fetchedAt`, and
 * `retrievalMode` on a selected source; the assembler fixes only the three facts that are structurally
 * true here — `provider: 'KMA'`, `sections: ['HOURLY']`, `observedAt: null` (forecast data has no
 * observation instant). A caller that knows the issuance — since PR #26 the live
 * `createKmaLiveSelectedHourlySourceMetadataResolver`, which reads the preserved PR #25 issuance
 * identity — supplies a concrete `issuedAt`; a caller that cannot determine it passes `issuedAt: null`
 * explicitly. Either way the assembler itself never reads a clock or reconstructs a KMA base time — its
 * provenance-agnostic, clock-free, pure policy is unchanged.
 *
 * ### Boundary — not the selector, not the location branch, not composition
 *
 * The PR #22 selector runs **first**, in the caller; this assembler consumes its precomputed
 * {@link KmaHourlyFallbackSelection} and never re-derives which result to use, never re-checks
 * eligibility, and never inspects error kinds. It also does not narrow a location result's `LOCATION` /
 * `UNSUPPORTED_LOCATION` branch (a later application service does that before selecting), builds no
 * `current`/`daily`/air-quality/alerts data, wires into no production composition root, and touches no
 * route/cache/stale-data. Those are later PRs.
 *
 * ### Purity, allocation, and immutability
 *
 * Synchronous and pure: it returns no `Promise` and is not `async`; it performs no network, Provider,
 * service, selector, or fallback call; it reads no clock (`Date.now`/`new Date`), environment
 * (`process.env`), or `AbortSignal`; it logs nothing, holds no state/cache/singleton, and uses no broad
 * `try`/`catch`. It mutates nothing — not the input, the location, the selection, the execution trace,
 * the selected result, its `hourly`, or the source context. As the overview's owner it allocates a
 * fresh output every call: `hourly` is copied out of the readonly service result into a new array (so
 * the output array is a different reference), and `weatherOverview.parse` produces fresh nested
 * objects. Value and order of `hourly` are preserved, but no reference identity (location, hourly
 * array, hourly item, source metadata) is contractual.
 *
 * See `docs/kma-hourly-weather-overview.md`.
 */

import {
  hourlyForecast,
  weatherOverview,
  type SourceMetadata,
  type WeatherLocation,
  type WeatherOverview,
} from '@life-weather/contracts';

import type { KmaHourlyFallbackSelection } from './kma-hourly-fallback-selection';

/**
 * The assembler-local **nonempty guard** for a *selected* result's hourly list. The public
 * {@link KmaHourlyFallbackSelection} selected arm types `result.hourly` as a plain
 * `readonly HourlyForecast[]`, so an empty array is structurally allowed at the type level even though a
 * correct PR #22 selector never produces one. The contracts `weatherOverview` schema does not reject an
 * empty `hourly` whose `HOURLY` section is *not* marked missing either (its list invariant is
 * one-directional: it only rejects populated data in a section that *is* marked missing). So this module
 * composes the contracts public `hourlyForecast` element schema into a `min(1)` array and validates the
 * selected result at the assembler boundary — turning a selected-empty input into a synchronous Zod
 * error before any overview object or source metadata is built.
 *
 * It is module-local (never exported), parses nothing at import time, reads no clock/network/environment
 * and logs nothing, and adds no new dependency: it only combines the contracts public `hourlyForecast`
 * schema (`zod` is never imported directly here).
 */
const nonEmptyHourlyForecasts = hourlyForecast.array().min(1);

/**
 * The provenance a caller must supply for a **selected** hourly source. It is exactly the four
 * {@link SourceMetadata} fields the assembler cannot know on its own — the app-internal `sourceId`, the
 * `issuedAt` issuance instant (`null` when the current pipeline cannot yet determine it), the
 * `fetchedAt` retrieval instant, and the `retrievalMode`. The assembler fixes the remaining
 * `SourceMetadata` fields itself (`provider: 'KMA'`, `sections: ['HOURLY']`, `observedAt: null`), so
 * they are deliberately absent here.
 */
export type KmaHourlySourceMetadataInput = Pick<
  SourceMetadata,
  'sourceId' | 'issuedAt' | 'fetchedAt' | 'retrievalMode'
>;

/**
 * The assembler input, correlated so a selected source carries provenance and a no-selection source is
 * exactly `null`:
 *
 * - a **selected** hourly source (`selection.selected === true`) requires a
 *   {@link KmaHourlySourceMetadataInput} `source` context, and
 * - **no selection** (`selection.selected === false`) requires `source: null` — the assembler
 *   fabricates no provenance for a source that was not chosen.
 *
 * The two `selection` arms are narrowed from {@link KmaHourlyFallbackSelection} so the union cannot pair
 * a selected result with a `null` source, or a no-selection outcome with a source context.
 */
export type KmaHourlyWeatherOverviewInput =
  | {
      readonly location: WeatherLocation;
      readonly selection: Extract<
        KmaHourlyFallbackSelection,
        {
          readonly selected: true;
        }
      >;
      readonly source: KmaHourlySourceMetadataInput;
    }
  | {
      readonly location: WeatherLocation;
      readonly selection: Extract<
        KmaHourlyFallbackSelection,
        {
          readonly selected: false;
        }
      >;
      readonly source: null;
    };

/**
 * Narrow the correlated input to its selected arm. The `selection.selected` discriminant lives one
 * level down, so a user-defined guard is used to narrow the whole `input` union (and with it the
 * non-null `source`) rather than only the nested `selection`.
 */
function isSelectedOverviewInput(
  input: KmaHourlyWeatherOverviewInput,
): input is Extract<
  KmaHourlyWeatherOverviewInput,
  { readonly selection: { readonly selected: true } }
> {
  return input.selection.selected;
}

/**
 * Assemble the hourly-only partial {@link WeatherOverview} from one precomputed PR #22 selection.
 *
 * On a selected source it first rejects an empty selected `hourly` with the module-local
 * `nonEmptyHourlyForecasts` guard, then maps the selected `hourly` into the overview, records the
 * caller's provenance as one KMA `HOURLY` {@link SourceMetadata}, and leaves `HOURLY` out of
 * `missingSections`; on no selection it emits an empty `hourly`/`sources` and adds `HOURLY` to the
 * missing set. Every other section is a fixed placeholder. The result is validated with
 * `weatherOverview.parse`, so an invalid location, timestamp, `sourceId`, a selected-empty `hourly`, or
 * an invariant breach throws a synchronous Zod error.
 *
 * Pure and synchronous: it reads only the caller's `location`, `selection`, and (when selected)
 * `source`, allocates a fresh overview each call, and mutates nothing. It infers no provenance, reads no
 * clock/environment/network, runs no selector, and handles no `LOCATION` branch.
 */
export function assembleKmaHourlyWeatherOverview(
  input: KmaHourlyWeatherOverviewInput,
): WeatherOverview {
  if (isSelectedOverviewInput(input)) {
    // A hourly source was selected. The public selected type allows an empty `hourly`, and the contracts
    // schema does not reject an empty `hourly` whose HOURLY section is not marked missing, so guard the
    // selected precondition here: a selected result must carry at least one hourly entry. This throws a
    // synchronous ZodError before any overview object or source metadata is built.
    const hourly = nonEmptyHourlyForecasts.parse(input.selection.result.hourly);

    // The selected forecast becomes the overview's `hourly` (a fresh array from the parse above), the
    // caller's provenance becomes the one KMA `HOURLY` source, and `HOURLY` is not missing.
    const overview = {
      location: input.location,
      current: null,
      hourly,
      daily: [],
      airQuality: {
        current: null,
        daily: [],
      },
      alerts: [],
      missingSections: [
        'CURRENT',
        'DAILY',
        'AIR_QUALITY_CURRENT',
        'AIR_QUALITY_FORECAST',
        'ALERTS',
      ],
      sources: [
        {
          sourceId: input.source.sourceId,
          provider: 'KMA',
          sections: ['HOURLY'],
          issuedAt: input.source.issuedAt,
          observedAt: null,
          fetchedAt: input.source.fetchedAt,
          retrievalMode: input.source.retrievalMode,
        },
      ],
    } satisfies WeatherOverview;

    return weatherOverview.parse(overview);
  }

  // No usable hourly source: `hourly` and `sources` are empty and `HOURLY` joins the missing set. No
  // source metadata is fabricated for a source that was not chosen.
  const overview = {
    location: input.location,
    current: null,
    hourly: [],
    daily: [],
    airQuality: {
      current: null,
      daily: [],
    },
    alerts: [],
    missingSections: [
      'CURRENT',
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
