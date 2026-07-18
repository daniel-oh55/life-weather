/**
 * Public surface of `apps/api`'s **application services** — the orchestration layer that sequences
 * the KMA provider boundary and the domain normalizers, and assembles the requests they consume.
 *
 * Two application services live here so far:
 *
 * 1. The PR #7 KMA **hourly-forecast orchestration** (`createKmaHourlyForecastService`): it calls
 *    the PR #5 HTTP provider and the PR #6 hourly normalizer in order and reports a `PROVIDER`- or
 *    `NORMALIZATION`-stage failure distinctly.
 * 2. The PR #9 KMA **request factory** (`createKmaForecastRequestFactory`): it combines an injected
 *    clock, the PR #8 scheduled issue-time selector, and caller-supplied `product`/`nx`/`ny` into a
 *    complete `KmaForecastRequest`. The factory and the hourly service are **not** auto-wired yet —
 *    a caller/composition layer sequences factory → service in a later PR.
 *
 * Application services deliberately live **outside** `providers/kma` (they are not part of the
 * provider boundary) and are exported only from here, never from `providers/kma/index.ts`. See
 * `docs/kma-hourly-service.md` and `docs/kma-forecast-request-factory.md`.
 */

export {
  createKmaHourlyForecastService,
  type KmaHourlyForecastService,
  type KmaHourlyForecastServiceOptions,
  type KmaHourlyForecastServiceResult,
} from './kma-hourly-forecast';

export {
  createKmaForecastRequestFactory,
  type KmaForecastRequestClock,
  type KmaForecastRequestFactory,
  type KmaForecastRequestFactoryInput,
} from './kma-forecast-request';
