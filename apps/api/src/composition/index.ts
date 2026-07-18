/**
 * Public surface of `apps/api`'s **server-side production composition** boundary.
 *
 * This layer is the explicit place that assembles the KMA components built by the earlier PRs into
 * live pipelines. Two production facades are composed here:
 *
 * - The **grid-based** production facade (PR #11): the PR #5 provider-from-env → the PR #7 hourly
 *   service, a system clock adapter → the PR #9 request factory, and the PR #10 scheduled facade
 *   over the two — yielding one live `KmaScheduledHourlyForecastFacade` keyed by `product`/`nx`/`ny`.
 * - The **location-based** production facade (PR #13): the same grid-based composition reused
 *   verbatim, with the PR #12 `convertKmaLatitudeLongitudeToGrid` converter assembled in front of
 *   it — yielding one live `KmaLocationScheduledHourlyForecastFacade` keyed by
 *   `product`/`latitude`/`longitude`. The grid-based composition and its result are unchanged.
 *
 * Boundary properties:
 *
 * - **No import-time work.** Importing this module reads no environment, creates no provider or
 *   clock, runs no converter, and starts no I/O. There is no module-scope singleton — a caller must
 *   invoke a composition function explicitly to build a graph.
 * - **Construction is network-free.** Building either graph only reads provider configuration and
 *   wires collaborators; the first converter run, the first clock read, and the first `fetch` happen
 *   only when the returned facade's method is called.
 * - **Not yet routed.** Neither composition root is wired into `apps/api/src/index.ts` or connected
 *   to a `/weather` route — that is a later PR.
 *
 * It consumes only the `../providers/kma`, `../services`, and `@life-weather/weather-core` (the
 * PR #12 converter) public surfaces and is exported only from here (never re-exported from those
 * barrels or from `apps/api/src/index.ts`). See `docs/kma-production-composition.md` and
 * `docs/kma-location-scheduled-hourly.md`.
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
