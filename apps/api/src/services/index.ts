/**
 * Public surface of `apps/api`'s **application services** — the orchestration layer that sequences
 * the KMA provider boundary and the domain normalizers, and assembles the requests they consume.
 *
 * Six application components live here so far:
 *
 * 1. The PR #7 KMA **hourly-forecast orchestration** (`createKmaHourlyForecastService`): it calls
 *    the PR #5 HTTP provider and the PR #6 hourly normalizer in order and reports a `PROVIDER`- or
 *    `NORMALIZATION`-stage failure distinctly.
 * 2. The PR #9 KMA **request factory** (`createKmaForecastRequestFactory`): it combines an injected
 *    clock, an injectable base-time selector, and caller-supplied `product`/`nx`/`ny` into a
 *    complete `KmaForecastRequest`. The selector is a `KmaForecastBaseTimeSelector`; when omitted it
 *    defaults to the PR #8 schedule-only `selectLatestKmaForecastBaseTime`. The factory itself fixes
 *    **no** availability policy — the production composition (`../composition`) injects the PR #14
 *    availability-delay selector as its explicit production choice, while a direct one-argument
 *    caller still gets the schedule-only default. No HTTP route consumes any of this yet.
 * 3. The PR #10 KMA **scheduled hourly facade** (`createKmaScheduledHourlyForecastFacade`): a thin
 *    connector that runs the request factory then the hourly service in order (input → request →
 *    hourly result), passing `input`/request/`options`/Promise through by reference and adding no
 *    new rule.
 * 4. The PR #13 KMA **location scheduled hourly facade**
 *    (`createKmaLocationScheduledHourlyForecastFacade`): a thin adapter that puts an injected
 *    latitude/longitude → grid converter in front of the scheduled facade (input → grid →
 *    scheduled result), adding only a `LOCATION`-stage `UNSUPPORTED_LOCATION` result for a
 *    physically valid coordinate the KMA grid does not cover.
 * 5. The PR #17 KMA **fallback-eligibility classifier** (`classifyKmaHourlyFallbackEligibility`): a
 *    pure function that inspects one `KmaHourlyForecastServiceResult` and decides whether a later
 *    orchestration step may try a single previous-issuance fallback. It is fallback-eligible only
 *    for the two no-data signals — a `PROVIDER`-stage `KMA_UPSTREAM_ERROR` with `resultCode`
 *    exactly `'03'` (`KMA_NO_DATA`) or a success with an empty `hourly` array (`EMPTY_HOURLY`);
 *    every other result is ineligible. It performs **no** actual fallback execution and is not the
 *    provider's, facade's, or composition's responsibility; no route consumes it yet.
 * 6. The PR #18 KMA **fallback request-plan factory** (`createKmaFallbackRequestPlanFactory`):
 *    combines an injected clock, an injectable candidate selector, and caller-supplied
 *    `product`/`nx`/`ny` into a `{ primary, previous }` pair of complete `KmaForecastRequest`s from a
 *    **single** absolute reference — the clock is read **exactly once** and the candidate selector is
 *    called **exactly once** per plan (construction calls neither). The selector is a
 *    `KmaForecastBaseTimeCandidatesSelector`; when omitted it defaults to the PR #16
 *    availability-aware `selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay`. It builds the
 *    two requests only — it performs **no** provider, hourly-service, or PR #17 classifier
 *    invocation and **no** fallback execution. It is **not** wired into the production composition
 *    yet (so current production behaviour is unchanged), and no HTTP route consumes it.
 *
 * The grid-based **production composition root** (system clock adapter, provider-from-env wiring, a
 * live facade instance) is built in PR #11 and lives in `../composition`; PR #12 added the
 * latitude/longitude → grid converter in `@life-weather/weather-core`; and PR #13's location facade
 * connects that converter to the scheduled facade (its production wiring also lives in
 * `../composition`). No HTTP route is wired to any of this yet — that is a later PR.
 *
 * Application services deliberately live **outside** `providers/kma` (they are not part of the
 * provider boundary) and are exported only from here, never from `providers/kma/index.ts`. See
 * `docs/kma-hourly-service.md`, `docs/kma-forecast-request-factory.md`,
 * `docs/kma-scheduled-hourly-facade.md`, `docs/kma-location-scheduled-hourly.md`, and
 * `docs/kma-fallback-request-plan.md`.
 */

export {
  createKmaHourlyForecastService,
  type KmaHourlyForecastService,
  type KmaHourlyForecastServiceOptions,
  type KmaHourlyForecastServiceResult,
} from './kma-hourly-forecast';

export {
  createKmaForecastRequestFactory,
  type KmaForecastBaseTimeSelector,
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

export {
  createKmaLocationScheduledHourlyForecastFacade,
  type KmaLocationForecastGridConverter,
  type KmaLocationScheduledHourlyForecastFacade,
  type KmaLocationScheduledHourlyForecastInput,
  type KmaLocationScheduledHourlyForecastOptions,
  type KmaLocationScheduledHourlyForecastResult,
  type KmaUnsupportedLocationError,
} from './kma-location-scheduled-hourly-forecast';

export {
  classifyKmaHourlyFallbackEligibility,
  type KmaHourlyFallbackEligibility,
  type KmaHourlyFallbackReason,
} from './kma-hourly-fallback-eligibility';

export {
  createKmaFallbackRequestPlanFactory,
  type KmaFallbackRequestPlan,
  type KmaFallbackRequestPlanFactory,
  type KmaFallbackRequestPlanFactoryInput,
  type KmaForecastBaseTimeCandidatesSelector,
} from './kma-fallback-request-plan';
