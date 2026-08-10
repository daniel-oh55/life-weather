/**
 * The KMA (기상청) **location current `WeatherOverview` application service**: the orchestration
 * layer that connects a `WeatherLocation` to a current-only partial {@link WeatherOverview} (or the
 * unchanged location/provider/normalization failure), so a caller does not have to wire the location
 * current-observation facade, the current source metadata resolver, and the current assembler by
 * hand.
 *
 * Pipeline it connects:
 *
 * ```text
 * { location }
 *   → weatherLocation.parse(location)                          // contracts runtime validation (upfront)
 *   → locationCurrentFacade.fetchScheduledCurrentWeatherForLocation( // PR #70 location facade
 *        { latitude, longitude }, options)
 *   → ok:false → returned verbatim (LOCATION / PROVIDER / NORMALIZATION)
 *   → ok:true  → sourceMetadataResolver()                       // PR #73 nullary resolver
 *              → assembleKmaCurrentWeatherOverview({             // PR #72/#73 assembler
 *                     location, current: result.current, source })
 *              → { ok: true, overview }
 * ```
 *
 * This is the current-observation counterpart of `kma-location-hourly-overview.ts`
 * (`createKmaLocationHourlyOverviewService`) — a **separate**, parallel implementation, not a
 * generalization of it. Current has no fallback selection, no `PRIMARY`/`PREVIOUS` source, and no
 * "no usable data" success branch: the location facade's result is a plain `ok`/`ok:false` union
 * (`LOCATION`/`PROVIDER`/`NORMALIZATION`), and every failure stays a failure at this boundary — there
 * is no empty-current success the way there is an empty-hourly success.
 *
 * ### Upfront `WeatherLocation` validation
 *
 * The method's **first** step is `weatherLocation.parse(input.location)` — before the facade, the
 * resolver, or the assembler runs. An invalid location (bad `timezone`, out-of-range
 * `latitude`/`longitude`, empty `id`/`displayName`, malformed `countryCode`, …) throws a
 * **synchronous** Zod error and **no** collaborator is called. The parsed location (never the
 * caller's original object) is the one used downstream: the facade receives its
 * `latitude`/`longitude`, and the assembler receives the parsed `location`. The caller's input is
 * never mutated. `zod` is never imported directly here — only the contracts public `weatherLocation`
 * schema.
 *
 * ### Failure boundary — returned verbatim, no reinterpretation
 *
 * The location facade can fail at three stages — `LOCATION` (unsupported coordinate),
 * `PROVIDER` (transport/upstream), or `NORMALIZATION` (malformed observation). Every `ok: false`
 * result is returned as the **exact** facade result reference, with no `overview`/`location`/
 * `coordinates`/`source`/message added and no stage collapsed or reinterpreted. The resolver and the
 * assembler never run on a failure — the assembler requires a valid `CurrentWeather`, and absence of
 * one stays a failure here rather than becoming an empty-current success.
 *
 * ### Success boundary — a caller-injected resolver, no inference
 *
 * On a facade success this service calls the **injected**, required, **nullary**
 * {@link KmaCurrentSourceMetadataResolver} **exactly once** — no location, current, coordinates,
 * grid, request, or base time is passed to it, since the current-observation resolver decides its
 * three provenance facts (`sourceId`/`fetchedAt`/`retrievalMode`) on its own. The resolver's output
 * reaches the assembler by the same reference, unmodified. This service never re-resolves source
 * metadata, rebuilds a `sourceId`, or reads a clock itself — that policy lives entirely in the
 * injected resolver (the PR #73 live resolver in production, still not wired here).
 *
 * ### Errors, Promise, and purity
 *
 * The method is intentionally **not** `async`. It parses the location synchronously, calls the
 * facade synchronously, and only `.then(...)`s the returned Promise, so:
 *
 * - a `weatherLocation.parse` error and a facade **synchronous** throw propagate synchronously as
 *   the **same** error reference — never wrapped in a Promise;
 * - a facade Promise **rejection**, and a throw from the resolver or the assembler inside the
 *   fulfillment handler, reject the returned Promise with the **same** error reference.
 *
 * There is no broad `try`/`catch`, no error wrapping/re-messaging, no custom error union, no
 * logging, and no partial result. The facade's Promise identity is deliberately **not** preserved
 * (the `.then` transformation is the orchestration). It reads no clock/environment/network, owns no
 * cache/state/singleton/counter, and mutates nothing — the input, parsed location, options, facade
 * result, current weather, resolver output, and overview are all left untouched, and every call
 * builds a fresh success wrapper. Construction is side-effect-free: it calls no collaborator and
 * merely closes over the three references.
 *
 * ### What it is not
 *
 * It does not implement the production resolver itself (that is PR #73's separate
 * `createKmaLiveCurrentSourceMetadataResolver`, injected here), inject a system clock, build a
 * production composition root, wire `apps/api/src/index.ts`, register the `/weather` route, map HTTP
 * status/envelopes, add cache/stale-data/availability-delay selection, or assemble
 * hourly/daily/air-quality/alerts. Those remaining items are later PRs. See
 * `docs/kma-location-current-overview.md`.
 */

import {
  weatherLocation,
  type WeatherLocation,
  type WeatherOverview,
} from '@life-weather/contracts';

import {
  assembleKmaCurrentWeatherOverview,
  type KmaCurrentWeatherOverviewInput,
} from './kma-current-weather-overview.js';
import type { KmaCurrentSourceMetadataResolver } from './kma-current-source-metadata.js';
import type {
  KmaLocationScheduledCurrentObservationFacade,
  KmaLocationScheduledCurrentObservationOptions,
  KmaLocationScheduledCurrentObservationResult,
} from './kma-location-scheduled-current-observation.js';

/** The caller-supplied input: a full contracts {@link WeatherLocation}. */
export interface KmaLocationCurrentOverviewInput {
  readonly location: WeatherLocation;
}

/**
 * Per-call options. A deliberate **alias** of the PR #70
 * {@link KmaLocationScheduledCurrentObservationOptions} (`{ signal? }`) — the caller's options is
 * forwarded to the facade untouched (by the same reference, or exactly `undefined` when omitted), so
 * no new option shape is introduced.
 */
export type KmaLocationCurrentOverviewOptions =
  KmaLocationScheduledCurrentObservationOptions;

/**
 * The outcome of one call. Either an application success — the current-only `overview` — or the
 * location facade's own failure (`LOCATION`/`PROVIDER`/`NORMALIZATION`) returned **verbatim**. The
 * failure arm is **reused** from {@link KmaLocationScheduledCurrentObservationResult} via `Extract`
 * (never redefined), so this service cannot disagree with the facade on its shape. The success arm
 * carries exactly `ok`/`overview` — no `current`/`source`/`request`/`grid`/coordinates leak to the
 * top level (they live inside `overview`).
 */
export type KmaLocationCurrentOverviewResult =
  | {
      readonly ok: true;
      readonly overview: WeatherOverview;
    }
  | Extract<
      KmaLocationScheduledCurrentObservationResult,
      {
        readonly ok: false;
      }
    >;

/** The service's single public method. */
export interface KmaLocationCurrentOverviewService {
  /**
   * Validate `input.location`, run the PR #70 location scheduled current-observation facade, return
   * any facade failure verbatim, and otherwise call the injected resolver and the assembler —
   * exactly once each — to return `{ ok: true, overview }`. Not `async`: an invalid location and a
   * facade synchronous throw propagate synchronously; a facade rejection and a resolver/assembler
   * throw reject the returned Promise. `options` is forwarded to the facade by reference (or
   * `undefined` when omitted).
   */
  readonly fetchCurrentWeatherOverviewForLocation: (
    input: KmaLocationCurrentOverviewInput,
    options?: KmaLocationCurrentOverviewOptions,
  ) => Promise<KmaLocationCurrentOverviewResult>;
}

/**
 * Create a location current-overview application service bound to an injected PR #70 location
 * scheduled current-observation facade and a **required** nullary current source metadata resolver,
 * plus an optional PR #72/#73 assembler collaborator that defaults to the real
 * `assembleKmaCurrentWeatherOverview`.
 *
 * Pure construction: it calls no collaborator, parses no location, reads no clock/environment/
 * network, registers no listener, and starts no timer — the returned object merely closes over the
 * three references. The same instance is safe to call many times; it holds no mutable state, cache,
 * or counter, and each call is independent of any previous one and returns a fresh wrapper object.
 */
export function createKmaLocationCurrentOverviewService(
  locationCurrentFacade: KmaLocationScheduledCurrentObservationFacade,
  sourceMetadataResolver: KmaCurrentSourceMetadataResolver,
  overviewAssembler: (
    input: KmaCurrentWeatherOverviewInput,
  ) => WeatherOverview = assembleKmaCurrentWeatherOverview,
): KmaLocationCurrentOverviewService {
  return {
    fetchCurrentWeatherOverviewForLocation(input, options) {
      // Step 1: validate the location upfront. An invalid location throws a synchronous Zod error
      // and no collaborator runs. The parsed value — never the caller's original object — is used
      // everywhere downstream.
      const location = weatherLocation.parse(input.location);

      // Step 2: run the location facade with a fresh { latitude, longitude } object (parsed
      // coordinates) and the caller's options by reference. A facade synchronous throw propagates
      // verbatim here, before any `.then` runs.
      const resultPromise =
        locationCurrentFacade.fetchScheduledCurrentWeatherForLocation(
          {
            latitude: location.latitude,
            longitude: location.longitude,
          },
          options,
        );

      return resultPromise.then((result) => {
        // Step 3: any failure (LOCATION / PROVIDER / NORMALIZATION) is returned exactly as the
        // facade produced it — the resolver and assembler never run.
        if (!result.ok) {
          return result;
        }

        // Step 4: a successful CurrentWeather. Resolve its provenance exactly once via the injected
        // nullary resolver (its output reaches the assembler by the same reference, unmodified),
        // then assemble.
        const source = sourceMetadataResolver();

        const overview = overviewAssembler({
          location,
          current: result.current,
          source,
        });

        return {
          ok: true,
          overview,
        };
      });
    },
  };
}
