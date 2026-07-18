/**
 * Public surface of `apps/api`'s **application services** — the orchestration layer that sequences
 * the KMA provider boundary and the domain normalizers, and assembles the requests they consume.
 *
 * Three application components live here so far:
 *
 * 1. The PR #7 KMA **hourly-forecast orchestration** (`createKmaHourlyForecastService`): it calls
 *    the PR #5 HTTP provider and the PR #6 hourly normalizer in order and reports a `PROVIDER`- or
 *    `NORMALIZATION`-stage failure distinctly.
 * 2. The PR #9 KMA **request factory** (`createKmaForecastRequestFactory`): it combines an injected
 *    clock, the PR #8 scheduled issue-time selector, and caller-supplied `product`/`nx`/`ny` into a
 *    complete `KmaForecastRequest`.
 * 3. The PR #10 KMA **scheduled hourly facade** (`createKmaScheduledHourlyForecastFacade`): a thin
 *    connector that runs the request factory then the hourly service in order (input → request →
 *    hourly result), passing `input`/request/`options`/Promise through by reference and adding no
 *    new rule. It connects the request factory and the hourly service, but a **production
 *    composition root** (system clock adapter, provider-from-env wiring, a live facade instance) is
 *    still absent — that is a later PR.
 *
 * Application services deliberately live **outside** `providers/kma` (they are not part of the
 * provider boundary) and are exported only from here, never from `providers/kma/index.ts`. See
 * `docs/kma-hourly-service.md`, `docs/kma-forecast-request-factory.md`, and
 * `docs/kma-scheduled-hourly-facade.md`.
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

export {
  createKmaScheduledHourlyForecastFacade,
  type KmaScheduledHourlyForecastFacade,
  type KmaScheduledHourlyForecastInput,
  type KmaScheduledHourlyForecastOptions,
  type KmaScheduledHourlyForecastResult,
} from './kma-scheduled-hourly-forecast';
