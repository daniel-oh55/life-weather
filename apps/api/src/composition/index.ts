/**
 * Public surface of `apps/api`'s **server-side production composition** boundary.
 *
 * This layer is the explicit place that assembles the KMA components built by the earlier PRs into
 * live pipelines. **Three** callable production roots are composed here:
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
 *   existing single-request roots are **unchanged**; this is a parallel root added beside them. A
 *   location → grid fallback root does **not** exist yet — that is a later PR.
 *
 * Boundary properties:
 *
 * - **No import-time work.** Importing this module reads no environment, creates no provider or
 *   clock, runs no converter, and starts no I/O. There is no module-scope singleton — a caller must
 *   invoke a composition function explicitly to build a graph.
 * - **Construction is network-free.** Building any graph only reads provider configuration and wires
 *   collaborators; the first converter run, the first clock read, and the first `fetch` happen only
 *   when the returned facade's / service's method is called.
 * - **Not yet routed.** None of the composition roots is wired into `apps/api/src/index.ts` or
 *   connected to a `/weather` route — that is a later PR.
 *
 * It consumes only the `../providers/kma`, `../services`, and `@life-weather/weather-core` (the
 * PR #12 converter, the PR #14 availability-delay selector, and the PR #16 candidate selector) public
 * surfaces and is exported only from here (never re-exported from those barrels or from
 * `apps/api/src/index.ts`). See `docs/kma-production-composition.md`,
 * `docs/kma-location-scheduled-hourly.md`, and `docs/kma-hourly-fallback-composition.md`.
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
