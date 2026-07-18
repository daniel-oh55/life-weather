/**
 * Public surface of `apps/api`'s **server-side production composition** boundary.
 *
 * This layer is the explicit place that assembles the KMA components built by the earlier PRs into a
 * live pipeline: the PR #5 provider-from-env → the PR #7 hourly service, a system clock adapter → the
 * PR #9 request factory, and the PR #10 scheduled facade over the two — yielding one live
 * `KmaScheduledHourlyForecastFacade`.
 *
 * Boundary properties:
 *
 * - **No import-time work.** Importing this module reads no environment, creates no provider or
 *   clock, and starts no I/O. There is no module-scope singleton — a caller must invoke
 *   {@link createKmaScheduledHourlyCompositionFromEnv} explicitly to build a graph.
 * - **Construction is network-free.** Building the graph only reads provider configuration and wires
 *   collaborators; the first clock read and the first `fetch` happen only when the returned facade's
 *   method is called.
 * - **Not yet routed.** This composition root is not wired into `apps/api/src/index.ts` and not
 *   connected to a `/weather` route — that is a later PR.
 *
 * It consumes only the `../providers/kma` and `../services` public surfaces and is exported only from
 * here (never re-exported from those barrels or from `apps/api/src/index.ts`). See
 * `docs/kma-production-composition.md`.
 */

export { createKmaSystemClock } from './system-clock';

export {
  createKmaScheduledHourlyCompositionFromEnv,
  type CreateKmaScheduledHourlyCompositionResult,
  type KmaScheduledHourlyCompositionDependencies,
} from './kma-scheduled-hourly';
