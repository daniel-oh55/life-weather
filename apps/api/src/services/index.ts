/**
 * Public surface of `apps/api`'s **application services** — the orchestration layer that sequences
 * the KMA provider boundary and the domain normalizers, and assembles the requests they consume.
 *
 * Nine application components live here so far:
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
 *    invocation and **no** fallback execution: the factory itself never executes anything. The PR #20
 *    grid fallback composition (`../composition`) **consumes** it as its production request-plan
 *    source; no HTTP route consumes it.
 * 7. The PR #19 KMA **fallback orchestration service** (`createKmaHourlyFallbackService`): the first
 *    component that actually **executes** a `previous` request. It combines the PR #18 request-plan
 *    factory, this file's hourly service, and the PR #17 classifier into an at-most-two-attempt run —
 *    build the plan **once**, run the `primary` request through the hourly service **once**, classify
 *    that primary result **once**, and, only when the classifier reports eligible, run the plan's
 *    `previous` request through the hourly service **once** (a **maximum of two** service calls; no
 *    third attempt and no re-classification of the `previous` result). The same `options`/`AbortSignal`
 *    reference is forwarded to both service calls. It returns an execution trace — a
 *    `{ fallbackAttempted: false, primary }` or `{ fallbackAttempted: true, fallbackReason, primary,
 *    previous }` union — and never merges the results, selects a final source, or builds a
 *    `WeatherOverview`/`SourceMetadata`. The orchestration itself owns **no** composition
 *    responsibility: the PR #20 grid fallback composition (`../composition`) **consumes** it as the
 *    live production fallback service. No HTTP route or cache consumes it yet.
 * 8. The PR #21 KMA **location hourly-forecast fallback facade**
 *    (`createKmaLocationHourlyFallbackFacade`): a thin adapter that puts an injected
 *    latitude/longitude → grid converter in front of the PR #19 fallback service (input → grid →
 *    fallback execution trace). It calls the converter **exactly once**; on a supported location
 *    calls the fallback service **exactly once** and returns its Promise verbatim; on an unsupported
 *    location returns a fresh `LOCATION`-stage `UNSUPPORTED_LOCATION` result and never calls the
 *    fallback service; and lets a converter throw propagate synchronously. It duplicates **no**
 *    base-time, eligibility, provider, or abort policy — those stay with the fallback service and its
 *    collaborators.
 * 9. The PR #22 KMA **hourly fallback result selector** (`selectKmaHourlyFallbackResult`): a **pure,
 *    synchronous** function that reads one PR #19 execution trace and decides which hourly result — if
 *    any — a later assembler may use as its data source. A result is **usable** only when it is a
 *    success with a **non-empty** `hourly`; a usable `primary` is always selected first (fallback not
 *    used); otherwise, only when the trace attempted fallback and its `previous` result is usable, the
 *    previous result is selected; otherwise there is no selection. It is the sole owner of the
 *    `fallbackAttempted` (previous *invoked*) vs `fallbackUsed` (previous usable data actually
 *    *selected*) distinction — `fallbackUsed` is true only when the previous result is the selected
 *    source. Every branch carries the same own keys (`execution`/`fallbackUsed`/`result`/`selected`/
 *    `source`) and preserves the caller's exact `execution` reference and selected-result reference. It
 *    executes nothing, calls no Provider/network/clock/eligibility classifier, ranks no error kind,
 *    handles **no** `LOCATION` branch, and is wired into **no** `WeatherOverview`/`SourceMetadata`,
 *    composition root, or route yet.
 *
 * The grid-based single-request **production composition root** (system clock adapter,
 * provider-from-env wiring, a live facade instance) is built in PR #11 and lives in `../composition`;
 * PR #12 added the latitude/longitude → grid converter in `@life-weather/weather-core`; PR #13's
 * location facade connects that converter to the scheduled facade; PR #20 added the grid fallback
 * composition root that consumes the PR #18 factory and PR #19 orchestration; and PR #21 added the
 * location fallback composition root that wires the PR #12 converter in front of the PR #20 grid
 * fallback service (all production wiring lives in `../composition`). No HTTP route or startup is
 * wired to any of this yet — that is a later PR.
 *
 * Application services deliberately live **outside** `providers/kma` (they are not part of the
 * provider boundary) and are exported only from here, never from `providers/kma/index.ts`. See
 * `docs/kma-hourly-service.md`, `docs/kma-forecast-request-factory.md`,
 * `docs/kma-scheduled-hourly-facade.md`, `docs/kma-location-scheduled-hourly.md`,
 * `docs/kma-fallback-request-plan.md`, `docs/kma-hourly-fallback.md`,
 * `docs/kma-location-hourly-fallback.md`, and `docs/kma-hourly-fallback-selection.md`.
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

export {
  createKmaHourlyFallbackService,
  type KmaHourlyFallbackEligibilityClassifier,
  type KmaHourlyFallbackService,
  type KmaHourlyFallbackServiceInput,
  type KmaHourlyFallbackServiceOptions,
  type KmaHourlyFallbackServiceResult,
} from './kma-hourly-fallback';

export {
  createKmaLocationHourlyFallbackFacade,
  type KmaLocationHourlyFallbackFacade,
  type KmaLocationHourlyFallbackInput,
  type KmaLocationHourlyFallbackOptions,
  type KmaLocationHourlyFallbackResult,
} from './kma-location-hourly-fallback';

export {
  selectKmaHourlyFallbackResult,
  type KmaHourlyFallbackSelection,
  type KmaHourlyFallbackSelectionSource,
} from './kma-hourly-fallback-selection';
