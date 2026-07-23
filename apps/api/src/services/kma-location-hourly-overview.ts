/**
 * The KMA (기상청) **location hourly `WeatherOverview` application service**: the orchestration layer
 * that connects the four hourly building blocks into a single call, so a caller can go straight from a
 * `WeatherLocation` + `product` to a hourly-only partial {@link WeatherOverview} (or a `LOCATION`
 * failure) without wiring the pieces by hand.
 *
 * Pipeline it connects:
 *
 * ```text
 * { product, location }
 *   → weatherLocation.parse(location)                         // contracts runtime validation (upfront)
 *   → facade.fetchHourlyForecastWithFallbackForLocation(      // PR #21 location fallback facade
 *        { product, latitude, longitude }, options)
 *   → LOCATION failure → returned verbatim
 *   → execution trace  → selectKmaHourlyFallbackResult(trace) // PR #22 selector
 *                      → selected? → sourceMetadataResolver(   // injected, selected-source only
 *                                       { product, location, selection })
 *                      → assembleKmaHourlyWeatherOverview(     // PR #23 assembler
 *                                       { location, selection, source })
 *                      → { ok: true, selection, overview }
 * ```
 *
 * ### Upfront `WeatherLocation` validation
 *
 * The method's **first** step is `weatherLocation.parse(input.location)` — before the facade, the
 * converter, the selector, the resolver, or the assembler runs. An invalid location (bad `timezone`,
 * out-of-range `latitude`/`longitude`, empty `id`/`displayName`, malformed `countryCode`, …) throws a
 * **synchronous** Zod error and **no** collaborator is called. The parsed location (never the caller's
 * original object) is the one used everywhere downstream: the facade receives its
 * `latitude`/`longitude`, the resolver and assembler receive the parsed `location`. The caller's input
 * is never mutated. `zod` is never imported directly here — only the contracts public `weatherLocation`
 * schema.
 *
 * ### Result and the LOCATION boundary
 *
 * The facade returns either a `LOCATION`-stage unsupported-location failure or a PR #19 execution
 * trace. A `LOCATION` failure is returned **verbatim** — the exact facade result reference, with no
 * `overview`/`selection`/`source`/`coordinates`/`message` added; it stays a value-free discriminator.
 * A top-level type guard (`isKmaLocationFailure`) decides this on the **top-level** `stage` discriminant
 * only; the `PROVIDER`/`NORMALIZATION` stages live one level down inside the trace's `primary`/`previous`
 * results and are never confused with the location branch.
 *
 * Every non-`LOCATION` trace flows through the selector and assembler and yields an
 * `{ ok: true, selection, overview }` success — **even when `selection.selected === false`**. A trace
 * whose primary/previous attempts produced only empty pages or Provider/Normalization failures is not a
 * top-level error here: the application orchestration completed, and the "no usable hourly data" fact is
 * expressed *inside* the result — `selection.selected: false`, `overview.hourly: []`, and `HOURLY` in
 * `overview.missingSections`. This service never promotes a Provider/Normalization failure to a new
 * top-level error.
 *
 * ### Provenance boundary — a caller-injected resolver, no inference
 *
 * Since PR #25 the execution trace preserves, from the actual request plan, the sanitized
 * `KmaForecastIssuanceIdentity` (`product`/`baseDate`/`baseTime` only) of each attempted issuance;
 * it still carries no selected request, `issuedAt`, `fetchedAt`, retrieval mode, or app-internal
 * `sourceId`, so this service infers **none** of the latter. It defines only the selected-source
 * resolver *seam*: on a selected trace it calls the **injected**
 * {@link KmaSelectedHourlySourceMetadataResolver} exactly once with the `product`, the parsed
 * `location`, and the selected `selection`, and passes the resolver's output straight to the assembler.
 * It never rebuilds a request plan, reads a clock, or reconstructs a KMA base time itself — a request
 * plan built during the fallback run and a resolver reading a clock afterwards can disagree at an
 * availability-delay boundary, so this service deliberately consumes the *preserved* issuance identity
 * rather than re-deriving one. The PR #26 live resolver
 * (`createKmaLiveSelectedHourlySourceMetadataResolver`) is that production resolver: it reads
 * `selection.execution.primaryIssuance` / `previousIssuance` to build the KST `issuedAt`, a fixed
 * per-product `sourceId`, a `LIVE` retrieval mode, and a resolver-time `fetchedAt`. This service owns
 * none of that clock/base-time/`sourceId` policy — it only injects the resolver. `issuedAt: null` also
 * remains allowed by the PR #23 assembler, so a resolver with an unknown issuance can still pass it
 * through explicitly. This service's factory signature and runtime are unchanged by PR #26.
 *
 * ### Errors, Promise, and purity
 *
 * The method is intentionally **not** `async`. It parses the location synchronously, calls the facade
 * synchronously, and only `.then(...)`s the returned Promise, so:
 *
 * - a `weatherLocation.parse` error and a facade **synchronous** throw (e.g. an injected converter
 *   `RangeError`) propagate synchronously as the **same** error reference — never wrapped in a Promise;
 * - a facade Promise **rejection**, and a throw from the selector, resolver, or assembler inside the
 *   fulfillment handler, reject the returned Promise with the **same** error reference.
 *
 * There is no broad `try`/`catch`, no error wrapping/re-messaging, no custom error union, no logging,
 * and no partial result. The facade's Promise identity is deliberately **not** preserved (the `.then`
 * transformation is the orchestration). It reads no clock/environment/network, owns no
 * cache/state/singleton/counter, and mutates nothing — the input, parsed location, options, facade
 * result, execution trace, selection, resolver output, and overview are all left untouched, and every
 * call builds a fresh success wrapper. Construction is side-effect-free: it calls no collaborator and
 * merely closes over the four references.
 *
 * ### What it is not
 *
 * It does not implement the production resolver itself (that is PR #26's separate
 * `createKmaLiveSelectedHourlySourceMetadataResolver`, injected here), reconstruct provenance from a KMA
 * `baseDate`/`baseTime`, build a production composition root, wire `apps/api/src/index.ts`, register the
 * `/weather` route, map HTTP status/envelopes, add cache/stale-data, or assemble
 * current/daily/air-quality/alerts. Those remaining items are later PRs. See
 * `docs/kma-location-hourly-overview.md`.
 */

import {
  weatherLocation,
  type WeatherLocation,
  type WeatherOverview,
} from '@life-weather/contracts';

import {
  selectKmaHourlyFallbackResult,
  type KmaHourlyFallbackSelection,
} from './kma-hourly-fallback-selection';
import {
  assembleKmaHourlyWeatherOverview,
  type KmaHourlySourceMetadataInput,
} from './kma-hourly-weather-overview';
import type {
  KmaLocationHourlyFallbackFacade,
  KmaLocationHourlyFallbackInput,
  KmaLocationHourlyFallbackOptions,
  KmaLocationHourlyFallbackResult,
} from './kma-location-hourly-fallback';

/**
 * The caller-supplied input: a `product` plus a full contracts {@link WeatherLocation}. The `product`
 * reuses the PR #21 facade's `product` type (so the two entry points cannot drift), and the `location`
 * is the complete location contract — its `latitude`/`longitude` feed the facade after validation, and
 * the whole parsed object reaches the resolver and assembler.
 */
export interface KmaLocationHourlyOverviewInput {
  readonly product: KmaLocationHourlyFallbackInput['product'];
  readonly location: WeatherLocation;
}

/**
 * Per-call options. A deliberate **alias** of the PR #21
 * {@link KmaLocationHourlyFallbackOptions} (`{ signal? }`) — the caller's options is forwarded to the
 * facade untouched (by the same reference, or exactly `undefined` when omitted), so no new option shape
 * is introduced.
 */
export type KmaLocationHourlyOverviewOptions = KmaLocationHourlyFallbackOptions;

/**
 * The input the service hands the injected {@link KmaSelectedHourlySourceMetadataResolver} on a
 * **selected** trace: the caller's `product`, the parsed `location`, and the selected `selection` arm
 * (narrowed to `selected: true`, so the resolver always sees a concrete `PRIMARY`/`PREVIOUS` source and
 * a non-null `result`). The resolver reads these to decide the selected source's provenance; the service
 * never fabricates any of it.
 */
export interface KmaSelectedHourlySourceMetadataResolverInput {
  readonly product: KmaLocationHourlyOverviewInput['product'];
  readonly location: WeatherLocation;
  readonly selection: Extract<
    KmaHourlyFallbackSelection,
    {
      readonly selected: true;
    }
  >;
}

/**
 * The injected selected-source provenance resolver seam. Given the selected
 * {@link KmaSelectedHourlySourceMetadataResolverInput}, it returns the PR #23
 * {@link KmaHourlySourceMetadataInput} the assembler needs (`sourceId`/`issuedAt`/`fetchedAt`/
 * `retrievalMode`). It is a **required** dependency — the service ships no default resolver — and its
 * output is passed to the assembler by the same reference, unmodified. Whether it reads a clock, an
 * environment value, or a request plan is entirely the resolver's own concern; this service reads none
 * of those itself.
 */
export type KmaSelectedHourlySourceMetadataResolver = (
  input: KmaSelectedHourlySourceMetadataResolverInput,
) => KmaHourlySourceMetadataInput;

/**
 * The outcome of one call. Either an application success — the PR #22 `selection` and the PR #23
 * hourly-only `overview` — or the PR #21 facade's `LOCATION`-stage failure returned **verbatim**. The
 * `LOCATION` arm is **reused** from {@link KmaLocationHourlyFallbackResult} via `Extract` (never
 * redefined), so the service cannot disagree with the facade on its shape. The success arm carries
 * exactly `ok`/`selection`/`overview` — no `source`/`fallbackUsed`/execution-trace fields leak to the
 * top level (they live inside `selection`), and the overview carries no application trace.
 */
export type KmaLocationHourlyOverviewResult =
  | {
      readonly ok: true;
      readonly selection: KmaHourlyFallbackSelection;
      readonly overview: WeatherOverview;
    }
  | Extract<
      KmaLocationHourlyFallbackResult,
      {
        readonly stage: 'LOCATION';
      }
    >;

/** The service's single public method. */
export interface KmaLocationHourlyOverviewService {
  /**
   * Validate `input.location`, run the PR #21 location fallback facade, return a `LOCATION` failure
   * verbatim, and otherwise apply the PR #22 selector and PR #23 assembler — calling the injected
   * resolver **exactly once** only on a selected trace — to return `{ ok: true, selection, overview }`.
   * Not `async`: an invalid location and a facade synchronous throw propagate synchronously; a facade
   * rejection and a selector/resolver/assembler throw reject the returned Promise. `options` is
   * forwarded to the facade by reference (or `undefined` when omitted).
   */
  readonly fetchHourlyWeatherOverviewForLocation: (
    input: KmaLocationHourlyOverviewInput,
    options?: KmaLocationHourlyOverviewOptions,
  ) => Promise<KmaLocationHourlyOverviewResult>;
}

/**
 * Narrow a facade result to its `LOCATION`-stage failure using the **top-level** `stage` discriminant
 * only. The execution-trace branches ({@link KmaLocationHourlyFallbackResult}'s
 * `KmaHourlyFallbackServiceResult` members) carry no top-level `stage`; the `PROVIDER`/`NORMALIZATION`
 * stages live one level down in the trace's `primary`/`previous`, so they never satisfy this guard.
 * Module-local — never exported.
 */
function isKmaLocationFailure(
  result: KmaLocationHourlyFallbackResult,
): result is Extract<
  KmaLocationHourlyFallbackResult,
  {
    readonly stage: 'LOCATION';
  }
> {
  return 'stage' in result && result.stage === 'LOCATION';
}

/**
 * Create a location hourly-overview application service bound to an injected PR #21 location fallback
 * facade and a **required** selected-source metadata resolver, plus optional PR #22 selection policy and
 * PR #23 assembler collaborators that default to the real `selectKmaHourlyFallbackResult` and
 * `assembleKmaHourlyWeatherOverview`.
 *
 * Pure construction: it calls no collaborator, parses no location, reads no clock/environment/network,
 * registers no listener, and starts no timer — the returned object merely closes over the four
 * references. The same instance is safe to call many times; it holds no mutable state, cache, or
 * counter, and each call is independent of any previous one and returns a fresh wrapper object.
 */
export function createKmaLocationHourlyOverviewService(
  locationFallbackFacade: KmaLocationHourlyFallbackFacade,
  sourceMetadataResolver: KmaSelectedHourlySourceMetadataResolver,
  selectionPolicy: typeof selectKmaHourlyFallbackResult = selectKmaHourlyFallbackResult,
  overviewAssembler: typeof assembleKmaHourlyWeatherOverview = assembleKmaHourlyWeatherOverview,
): KmaLocationHourlyOverviewService {
  return {
    fetchHourlyWeatherOverviewForLocation(input, options) {
      // Step 1: validate the location upfront. An invalid location throws a synchronous Zod error and
      // no collaborator runs. The parsed value — never the caller's original object — is used
      // everywhere downstream.
      const location = weatherLocation.parse(input.location);

      // Step 2: run the location fallback facade with a fresh { product, latitude, longitude } object
      // (parsed coordinates) and the caller's options by reference. A facade synchronous throw
      // propagates verbatim here, before any `.then` runs.
      const resultPromise =
        locationFallbackFacade.fetchHourlyForecastWithFallbackForLocation(
          {
            product: input.product,
            latitude: location.latitude,
            longitude: location.longitude,
          },
          options,
        );

      return resultPromise.then((result) => {
        // Step 3: a LOCATION failure is returned exactly as the facade produced it — no selection,
        // overview, coordinates, or message added; the selector/resolver/assembler never run.
        if (isKmaLocationFailure(result)) {
          return result;
        }

        // Step 4: a supported trace is selected exactly once. The selector receives the facade's exact
        // execution-trace reference and its result reference is preserved in the success wrapper.
        const selection = selectionPolicy(result);

        // Step 5a: no usable hourly data. The resolver is NOT called; the assembler builds the
        // no-selection partial overview with `source: null`. This is still an application success.
        if (!selection.selected) {
          const overview = overviewAssembler({
            location,
            selection,
            source: null,
          });

          return {
            ok: true,
            selection,
            overview,
          };
        }

        // Step 5b: a usable source was selected. Resolve its provenance exactly once via the injected
        // resolver (its output reaches the assembler by the same reference, unmodified), then assemble.
        const source = sourceMetadataResolver({
          product: input.product,
          location,
          selection,
        });

        const overview = overviewAssembler({
          location,
          selection,
          source,
        });

        return {
          ok: true,
          selection,
          overview,
        };
      });
    },
  };
}
