/**
 * Public surface of `apps/api`'s **server-side production composition** boundary.
 *
 * This layer is the explicit place that assembles the KMA components built by the earlier PRs into
 * live pipelines. **Nine** callable production roots are composed here:
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
 * - The **scheduled current-observation** composition (PR #69, new): the PR #63
 *   `createKmaCurrentObservationProviderFromEnv` → the PR #67 `createKmaCurrentObservationService`, a
 *   system clock adapter (shared structurally with the hourly clock port) + the PR #79
 *   **availability-delay** `selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay` selector
 *   (wired here by **PR #80**; originally PR #69 injected the PR #64 schedule-only selector), injected
 *   **explicitly** (not left to the factory's schedule-only implicit default) → the PR #66
 *   `createKmaCurrentObservationRequestFactory`, and the PR #68
 *   `createKmaScheduledCurrentObservationFacade` over the two — yielding one live
 *   `KmaScheduledCurrentObservationFacade` keyed by `nx`/`ny`. This selection does **not** guarantee
 *   the upstream API has actually published the picked issuance's data, that a request at this
 *   instant succeeds, or that a previous-issuance fallback exists — the PR #79 selector only expresses
 *   a deterministic 10-minute project threshold, not an official SLA or live-readiness guarantee. The
 *   five hourly roots above are **unchanged**; this is a sixth parallel root added beside them, and it
 *   is **not** connected to any location→grid adapter, `WeatherOverview.current`, current
 *   `SourceMetadata`, or the `POST /weather` route. See
 *   `docs/kma-current-observation-production-composition.md`.
 *
 * - The **location-based scheduled current-observation** composition (PR #71, new): the PR #69 grid
 *   current-observation composition above, reused verbatim, with the existing production
 *   `convertKmaLatitudeLongitudeToGrid` converter assembled in front of it through the PR #70
 *   `createKmaLocationScheduledCurrentObservationFacade` location facade — yielding one live
 *   `KmaLocationScheduledCurrentObservationFacade` keyed by `latitude`/`longitude`. It forwards `env`
 *   and `dependencies` to the PR #69 composition by exact reference and passes through its
 *   `KmaProviderConfigError` unchanged on a configuration failure, with zero converter/clock/fetch
 *   calls at construction. The PR #69 composition and the PR #70 facade are **unchanged**; this is a
 *   seventh parallel root added beside them. `WeatherOverview.current`, current `SourceMetadata`, the
 *   `POST /weather` route, and a current-observation availability-delay selector remain **missing**
 *   — this root is still **not** connected to any route. See
 *   `docs/kma-location-scheduled-current-observation.md`.
 *
 * - The **location-based current overview** application service composition (PR #75, new): the PR #71
 *   location-based scheduled current-observation composition above, the PR #73
 *   `createKmaLiveCurrentSourceMetadataResolver` live current source metadata resolver, and the PR #74
 *   `createKmaLocationCurrentOverviewService` current-only `WeatherOverview` application service
 *   assembled into one live `KmaLocationCurrentOverviewService`. It reuses the PR #71 composition
 *   verbatim (config failure passed through by the same `KmaProviderConfigError` reference) and only
 *   *selects* the metadata resolver's clock — the injected clock when supplied (shared with the
 *   request), else a fresh system clock adapter — leaving the PR #74 service's own default assembler
 *   untouched. A caller supplies a full `WeatherLocation`; the result is the PR #74 service's own
 *   `{ ok, overview }` success or its verbatim `LOCATION`/`PROVIDER`/`NORMALIZATION` failure. The seven
 *   existing roots are **unchanged**; this is an eighth parallel root, and it is **not** connected to
 *   the `POST /weather` route — `current` remains missing from the production response. See
 *   `docs/kma-location-current-overview-composition.md`.
 *
 * - The **location-based combined current + hourly overview** composition (PR #78, new; **now consumed
 *   by the `POST /weather` route as of PR #81** — see below): the PR #27 location hourly-overview
 *   composition above and the PR #75 location current-overview composition above, both reused
 *   **verbatim** (each forwarded the exact same `env`/`dependencies` references), wired through the
 *   PR #77 `createKmaLocationCurrentHourlyOverviewService` combined application service — yielding one
 *   live `KmaLocationCurrentHourlyOverviewService`. Hourly is composed first, deterministically; a
 *   hourly config failure short-circuits before the current composition or the PR #77 factory ever run.
 *   Only after hourly succeeds is the current composition built, and its own config failure is *also* a
 *   composition failure (distinct from PR #77's own runtime degradation of a resolved current
 *   `ok: false` **application result** to `current: null`, which only applies once both live services
 *   already exist). An injected `dependencies.clock` is shared by reference across the four clock
 *   consumers (hourly request-plan, hourly metadata resolver, current request, current metadata
 *   resolver), while an injected `dependencies.fetchImpl` is forwarded by reference to both existing
 *   provider roots. When clock is omitted, this layer builds no clock of its own and each existing root
 *   keeps its own independent default. The eight existing roots are **unchanged**; this is a ninth
 *   combining root. See `docs/kma-location-current-hourly-overview-composition.md`.
 *
 * PR #31 adds the **production `/weather` route composition**
 * (`createProductionWeatherRouteDependencies`): the adapter that turns the server-only `KMA_SERVICE_KEY`
 * into the PR #30 route's `WeatherRouteDependencies`. As of **PR #81**, it builds the PR #78 combined
 * location current+hourly-overview root above (replacing the PR #27 hourly-only root it built through
 * PR #80), binds the service's `fetchCurrentHourlyWeatherOverviewForLocation` method to the route's narrow
 * `(input, signal)` execution port, fixes the server-owned `PRODUCTION_WEATHER_PRODUCT` (`SHORT_FORECAST`,
 * which continues to select only the hourly forecast source), and supplies the production response `meta`
 * provider (UTC `generatedAt` + a server-generated `requestId`). `apps/api/src/index.ts` calls it, mounts
 * `createWeatherRoute(...)` at `/weather`, and default-exports the Hono app — so `POST /weather` now
 * returns hourly **and** current-observation data (with the existing PR #77 current-failure degradation
 * to `current: null` inherited unchanged), alongside `GET /health`. It reads `KMA_SERVICE_KEY`
 * (server-only) at startup and **fail-fast** throws when it is missing/invalid (from either the hourly or
 * the current composition), but issues **no** external `fetch` at startup — the KMA graph stays lazy
 * until a real request arrives. The route factory and presenter are unchanged — the PR #77 result/input/
 * options types are deliberate aliases of the PR #24 hourly types, so no new contract was needed. See
 * `docs/weather-production-wiring.md`.
 *
 * Boundary properties:
 *
 * - **No import-time work.** Importing this module reads no environment, creates no provider or
 *   clock, runs no converter, and starts no I/O. There is no module-scope singleton — a caller must
 *   invoke a composition function explicitly to build a graph.
 * - **Construction is network-free.** Building any graph only reads provider configuration and wires
 *   collaborators; the first converter run, the first clock read, and the first `fetch` happen only
 *   when the returned facade's / service's method is called.
 * - **Routing.** The four hourly scheduled/fallback roots and the three grid/location current-only roots
 *   (PR #69, PR #71, PR #75) remain **unrouted** — they exist only as internal building blocks the PR #78
 *   combined root composes. As of **PR #81**, the PR #78 combined current+hourly root is consumed by the
 *   PR #31 `createProductionWeatherRouteDependencies`, which `apps/api/src/index.ts` wires into the live
 *   `POST /weather` route (replacing the PR #27 hourly-only root the route composition used through
 *   PR #80); startup still issues no external `fetch` (the graph is lazy). `POST /weather` now returns
 *   hourly **and** current-observation data, with a resolved current failure degrading to `current: null`
 *   (the existing PR #77 policy, inherited unchanged) rather than failing the request.
 *
 * It consumes only the `../providers/kma`, `../services`, `../presenters`, `../routes`, and
 * `@life-weather/weather-core` (the PR #12 converter, the PR #14 availability-delay selector, the
 * PR #16 candidate selector, and the PR #79 current-observation availability-delay selector, wired
 * here by PR #80) public surfaces. The KMA composition roots are exported only from here; the PR #31
 * route composition is
 * exported here too and consumed by `apps/api/src/index.ts`. See `docs/kma-production-composition.md`,
 * `docs/kma-location-scheduled-hourly.md`, `docs/kma-hourly-fallback-composition.md`,
 * `docs/kma-location-hourly-fallback.md`, `docs/kma-location-hourly-overview-composition.md`,
 * `docs/kma-current-observation-production-composition.md`,
 * `docs/kma-location-scheduled-current-observation.md`,
 * `docs/kma-location-current-overview-composition.md`,
 * `docs/kma-location-current-hourly-overview-composition.md`, and `docs/weather-production-wiring.md`.
 */

export { createKmaSystemClock } from './system-clock.js';

export {
  createKmaScheduledHourlyCompositionFromEnv,
  type CreateKmaScheduledHourlyCompositionResult,
  type KmaScheduledHourlyCompositionDependencies,
} from './kma-scheduled-hourly.js';

export {
  createKmaLocationScheduledHourlyCompositionFromEnv,
  type CreateKmaLocationScheduledHourlyCompositionResult,
  type KmaLocationScheduledHourlyCompositionDependencies,
} from './kma-location-scheduled-hourly.js';

export {
  createKmaHourlyFallbackCompositionFromEnv,
  type CreateKmaHourlyFallbackCompositionResult,
  type KmaHourlyFallbackCompositionDependencies,
} from './kma-hourly-fallback.js';

export {
  createKmaLocationHourlyFallbackCompositionFromEnv,
  type CreateKmaLocationHourlyFallbackCompositionResult,
  type KmaLocationHourlyFallbackCompositionDependencies,
} from './kma-location-hourly-fallback.js';

export {
  createKmaLocationHourlyOverviewCompositionFromEnv,
  type CreateKmaLocationHourlyOverviewCompositionResult,
  type KmaLocationHourlyOverviewCompositionDependencies,
} from './kma-location-hourly-overview.js';

export {
  createKmaScheduledCurrentObservationCompositionFromEnv,
  type CreateKmaScheduledCurrentObservationCompositionResult,
  type KmaScheduledCurrentObservationCompositionDependencies,
} from './kma-scheduled-current-observation.js';

export {
  createKmaLocationScheduledCurrentObservationCompositionFromEnv,
  type CreateKmaLocationScheduledCurrentObservationCompositionResult,
  type KmaLocationScheduledCurrentObservationCompositionDependencies,
} from './kma-location-scheduled-current-observation.js';

export {
  createKmaLocationCurrentOverviewCompositionFromEnv,
  type CreateKmaLocationCurrentOverviewCompositionResult,
  type KmaLocationCurrentOverviewCompositionDependencies,
} from './kma-location-current-overview.js';

export {
  createKmaLocationCurrentHourlyOverviewCompositionFromEnv,
  type CreateKmaLocationCurrentHourlyOverviewCompositionResult,
  type KmaLocationCurrentHourlyOverviewCompositionDependencies,
} from './kma-location-current-hourly-overview.js';

export {
  createProductionWeatherRouteDependencies,
  KMA_SERVICE_KEY_REQUIRED_MESSAGE,
  PRODUCTION_WEATHER_PRODUCT,
  type ProductionWeatherRouteOptions,
} from './weather-route.js';
