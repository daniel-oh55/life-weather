/**
 * Public surface of `apps/api`'s **server-side production composition** boundary.
 *
 * This layer is the explicit place that assembles the KMA components built by the earlier PRs into
 * live pipelines. **Five** callable production roots are composed here:
 *
 * - The **grid-based single-request** facade (PR #11): the PR #5 provider-from-env → the PR #7 hourly
 *   service, a system clock adapter → the PR #9 request factory, and the PR #10 scheduled facade
 *   over the two — yielding one live `KmaScheduledHourlyForecastFacade` keyed by `product`/`nx`/`ny`.
 *   As of PR #15 the grid composition injects the PR #14
 *   `selectLatestKmaForecastBaseTimeAfterAvailabilityDelay` selector into the request factory as its
 *   explicit production base-time choice, so every request is dated to an availability-threshold-aware
 *   issuance (단기예보 10분 · 초단기예보 15분 project policy) rather than the schedule-only default.
 * - The **location-based single-request** facade (PR #13): the same grid-based composition reused
 *   verbatim, with the PR #12 `convertKmaLatitudeLongitudeToGrid` converter assembled in front of
 *   it — yielding one live `KmaLocationScheduledHourlyForecastFacade` keyed by
 *   `product`/`latitude`/`longitude`. The grid-based composition and its result are unchanged, so
 *   the location pipeline **inherits** the PR #14 availability policy without importing or injecting
 *   the selector itself. Both single-request pipelines are availability-threshold-aware; the policy
 *   is a deterministic project threshold, not an official SLA, and carries no live-readiness
 *   guarantee, and each makes **at most one** provider call per invocation.
 * - The **grid-based fallback** service (PR #20, new): the PR #5 provider-from-env → the PR #7 hourly
 *   service, a system clock adapter → the PR #18 request-plan factory (injected with the PR #16
 *   `selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay` candidate selector), and the PR #19
 *   `createKmaHourlyFallbackService` over the plan factory, the hourly service, and the PR #17
 *   `classifyKmaHourlyFallbackEligibility` classifier — yielding one live `KmaHourlyFallbackService`
 *   keyed by `product`/`nx`/`ny`. It assembles the PR #16–#19 graph: a primary attempt and, only when
 *   the classifier reports the primary a no-data signal (exact upstream `'03'` or empty hourly), a
 *   single previous-issuance attempt (**at most two** provider calls, no third attempt). The two
 *   existing single-request roots are **unchanged**; this is a parallel root added beside them.
 * - The **location-based fallback** facade (PR #21, new): the same PR #20 grid fallback composition
 *   reused verbatim, with the PR #12 `convertKmaLatitudeLongitudeToGrid` converter assembled in front
 *   of it through the PR #21 location fallback facade — yielding one live
 *   `KmaLocationHourlyFallbackFacade` keyed by `product`/`latitude`/`longitude`. A supported location
 *   converts to a grid and runs the grid fallback service (**at most two** provider calls per call);
 *   an unsupported (physically valid but off-grid) location returns a value-free
 *   `LOCATION`/`UNSUPPORTED_LOCATION` result with **zero** provider calls; and an out-of-physical-range
 *   coordinate throws a converter `RangeError` synchronously. The PR #20 grid fallback root and both
 *   single-request roots are **unchanged**; this is a fourth parallel root added beside them.
 * - The **location-based hourly overview** application service (PR #27, new): the PR #21
 *   location-based fallback facade, the PR #26 `createKmaLiveSelectedHourlySourceMetadataResolver`
 *   selected-source metadata resolver, and the PR #24 `createKmaLocationHourlyOverviewService` hourly
 *   `WeatherOverview` application service assembled into one live `KmaLocationHourlyOverviewService`.
 *   It reuses the PR #21 location fallback composition verbatim (config failure passed through by the
 *   same `KmaProviderConfigError` reference) and only *selects* the metadata resolver's clock — the
 *   injected clock when supplied (shared with the request plan), else a fresh system clock adapter —
 *   leaving the PR #22 selector and PR #23 assembler as the PR #24 service's own defaults. A caller
 *   supplies a `product` + a full `WeatherLocation`; the result is the existing **PR #24 internal
 *   application result** (`{ ok, selection, overview }` on a supported location, or the `LOCATION`
 *   failure verbatim), which a future mobile-facing route must map to `overview` only rather than
 *   serialize directly. The four existing roots are **unchanged**; this is a fifth parallel root, and
 *   PR #31 now consumes it at startup (see below).
 *
 * PR #31 adds the **production `/weather` route composition**
 * (`createProductionWeatherRouteDependencies`): the adapter that turns the server-only `KMA_SERVICE_KEY`
 * into the PR #30 route's `WeatherRouteDependencies`. It builds the location hourly-overview root above,
 * binds the service to the route's narrow `(input, signal)` execution port, fixes the server-owned
 * `PRODUCTION_WEATHER_PRODUCT` (`SHORT_FORECAST`), and supplies the production response `meta` provider
 * (UTC `generatedAt` + a server-generated `requestId`). `apps/api/src/index.ts` calls it, mounts
 * `createWeatherRoute(...)` at `/weather`, and default-exports the Hono app — so `POST /weather` is now a
 * live production endpoint alongside `GET /health`. It reads `KMA_SERVICE_KEY` (server-only) at startup
 * and **fail-fast** throws when it is missing/invalid, but issues **no** external `fetch` at startup — the
 * KMA graph stays lazy until a real request arrives. See `docs/weather-production-wiring.md`.
 *
 * Boundary properties:
 *
 * - **No import-time work.** Importing this module reads no environment, creates no provider or
 *   clock, runs no converter, and starts no I/O. There is no module-scope singleton — a caller must
 *   invoke a composition function explicitly to build a graph.
 * - **Construction is network-free.** Building any graph only reads provider configuration and wires
 *   collaborators; the first converter run, the first clock read, and the first `fetch` happen only
 *   when the returned facade's / service's method is called.
 * - **Routing.** The four scheduled/fallback roots remain **unrouted**. The location hourly-overview
 *   root is now consumed by the PR #31 `createProductionWeatherRouteDependencies`, which
 *   `apps/api/src/index.ts` wires into the live `POST /weather` route; startup still issues no external
 *   `fetch` (the graph is lazy).
 *
 * It consumes only the `../providers/kma`, `../services`, `../presenters`, `../routes`, and
 * `@life-weather/weather-core` (the PR #12 converter, the PR #14 availability-delay selector, and the
 * PR #16 candidate selector) public surfaces. The KMA composition roots are exported only from here; the
 * PR #31 route composition is exported here too and consumed by `apps/api/src/index.ts`. See
 * `docs/kma-production-composition.md`, `docs/kma-location-scheduled-hourly.md`,
 * `docs/kma-hourly-fallback-composition.md`, `docs/kma-location-hourly-fallback.md`,
 * `docs/kma-location-hourly-overview-composition.md`, and `docs/weather-production-wiring.md`.
 */

export { createKmaSystemClock } from './system-clock';

export {
  createKmaScheduledHourlyCompositionFromEnv,
  type CreateKmaScheduledHourlyCompositionResult,
  type KmaScheduledHourlyCompositionDependencies,
} from './kma-scheduled-hourly';

export {
  createKmaLocationScheduledHourlyCompositionFromEnv,
  type CreateKmaLocationScheduledHourlyCompositionResult,
  type KmaLocationScheduledHourlyCompositionDependencies,
} from './kma-location-scheduled-hourly';

export {
  createKmaHourlyFallbackCompositionFromEnv,
  type CreateKmaHourlyFallbackCompositionResult,
  type KmaHourlyFallbackCompositionDependencies,
} from './kma-hourly-fallback';

export {
  createKmaLocationHourlyFallbackCompositionFromEnv,
  type CreateKmaLocationHourlyFallbackCompositionResult,
  type KmaLocationHourlyFallbackCompositionDependencies,
} from './kma-location-hourly-fallback';

export {
  createKmaLocationHourlyOverviewCompositionFromEnv,
  type CreateKmaLocationHourlyOverviewCompositionResult,
  type KmaLocationHourlyOverviewCompositionDependencies,
} from './kma-location-hourly-overview';

export {
  createProductionWeatherRouteDependencies,
  KMA_SERVICE_KEY_REQUIRED_MESSAGE,
  PRODUCTION_WEATHER_PRODUCT,
  type ProductionWeatherRouteOptions,
} from './weather-route';
