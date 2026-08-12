/**
 * Public surface of `apps/api`'s **application services** — the orchestration layer that sequences
 * the KMA provider boundary and the domain normalizers, and assembles the requests they consume.
 *
 * Twenty-two application components live here so far:
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
 *    provider's, facade's, or composition's responsibility. The PR #20 grid fallback composition injects
 *    it, so it now runs inside the `POST /weather` production route's fallback graph.
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
 *    source, which now runs inside the `POST /weather` production route's fallback graph.
 * 7. The PR #19 KMA **fallback orchestration service** (`createKmaHourlyFallbackService`): the first
 *    component that actually **executes** a `previous` request. It combines the PR #18 request-plan
 *    factory, this file's hourly service, and the PR #17 classifier into an at-most-two-attempt run —
 *    build the plan **once**, run the `primary` request through the hourly service **once**, classify
 *    that primary result **once**, and, only when the classifier reports eligible, run the plan's
 *    `previous` request through the hourly service **once** (a **maximum of two** service calls; no
 *    third attempt and no re-classification of the `previous` result). The same `options`/`AbortSignal`
 *    reference is forwarded to both service calls. It returns an execution trace — a
 *    `{ fallbackAttempted: false, primaryIssuance, primary }` or `{ fallbackAttempted: true,
 *    fallbackReason, primaryIssuance, primary, previousIssuance, previous }` union — and never merges
 *    the results, selects a final source, or builds a `WeatherOverview`/`SourceMetadata`. Since PR #25
 *    the trace also preserves, from the **actual** request plan, the sanitized
 *    `KmaForecastIssuanceIdentity` (`product`/`baseDate`/`baseTime` only) of each issuance an attempt
 *    was associated with: `primaryIssuance` on every branch, and `previousIssuance` only on the branch
 *    where the previous hourly-service invocation occurred and resolved to a service result — the
 *    no-fallback branch has no previous invocation and therefore no previous identity. Identity
 *    existence does not prove an HTTP dispatch (a pre-aborted invocation can return `ABORTED` without
 *    network I/O). The identities carry no `nx`/`ny`, request object, plan, ServiceKey, URL, query, or
 *    raw body, and are
 *    derived once from the existing plan — the service reads no clock and makes no extra
 *    selector/plan-factory call. The `PRIMARY`/`PREVIOUS` distinction stays with the later selection
 *    step. The orchestration itself owns **no** composition responsibility: the PR #20 grid fallback
 *    composition (`../composition`) **consumes** it as the live production fallback service, which now
 *    runs inside the `POST /weather` production route's fallback graph. No cache consumes it yet; the
 *    PR #26 live selected-source metadata resolver (component 12)
 *    consumes these preserved identities to materialize the selected source's `SourceMetadata`.
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
 *    handles **no** `LOCATION` branch, and builds **no** `WeatherOverview`/`SourceMetadata` itself. It
 *    is the PR #24 application service's fixed production **default** selector, and through the PR #27
 *    fifth composition root (`createKmaLocationHourlyOverviewCompositionFromEnv`) it is part of the
 *    live production graph, which is **now wired into** `apps/api/src/index.ts` startup and served at the
 *    `POST /weather` production route.
 * 10. The PR #23 KMA **hourly `WeatherOverview` assembler** (`assembleKmaHourlyWeatherOverview`): a
 *    **pure, synchronous** function that consumes a **precomputed PR #22 selection** and assembles the
 *    hourly-only partial contracts `WeatherOverview`. When a hourly source is selected it maps the
 *    selected result's `hourly` into the overview and records **one** KMA `HOURLY` `SourceMetadata`;
 *    when there is no selection it emits an empty `hourly`/`sources` and adds `HOURLY` to
 *    `missingSections`. Every other section is a fixed placeholder (`current: null`, `daily: []`,
 *    `airQuality.current: null`, `airQuality.daily: []`, `alerts: []`), so `missingSections` always
 *    lists exactly the sections not yet supplied. The source metadata's provenance
 *    (`sourceId`/`issuedAt`/`fetchedAt`/`retrievalMode`) is **caller-provided** — the assembler infers
 *    none of it and fixes only `provider: 'KMA'`, `sections: ['HOURLY']`, and `observedAt: null`; an
 *    unknown issuance is passed as an explicit `issuedAt: null`. Because the public selected type allows
 *    an empty `hourly` and the contracts list invariant is one-directional (it only rejects populated
 *    data in a section marked missing, never an empty `hourly` whose `HOURLY` is *not* marked missing),
 *    the assembler owns that boundary: a **selected** result's `hourly` is validated with an
 *    assembler-local nonempty schema, so a selected-empty input throws a **synchronous** Zod error before
 *    any overview/source is built; a **no-selection** empty `hourly` is normal (`HOURLY` is marked
 *    missing). It then validates the whole payload with `weatherOverview.parse` (a malformed
 *    location/timestamp/`sourceId` or invariant breach also throws a synchronous Zod error), allocates a
 *    fresh output every call, and mutates nothing. It runs the selector for **nobody** (the caller does
 *    that first), handles **no** `LOCATION` branch, and builds no `current`/`daily`/air-quality/alerts
 *    data. It is the PR #24 application service's fixed production **default** assembler, and through
 *    the PR #27 fifth composition root (`createKmaLocationHourlyOverviewCompositionFromEnv`) it is part
 *    of the live production graph, which is **now wired into** `apps/api/src/index.ts` startup and served
 *    at the `POST /weather` production route.
 * 11. The PR #24 KMA **location hourly `WeatherOverview` application service**
 *    (`createKmaLocationHourlyOverviewService`): the orchestration layer that connects the previous four
 *    hourly building blocks into a single call. Per call it (a) runs the contracts `weatherLocation`
 *    runtime parse on the caller's location **upfront** — an invalid location throws a **synchronous**
 *    Zod error and **no** collaborator runs — then (b) runs the PR #21 location fallback facade with the
 *    parsed `latitude`/`longitude`, (c) narrows a top-level `LOCATION` failure and returns it
 *    **verbatim**, (d) applies the PR #22 selector to a supported execution trace, (e) calls the
 *    **injected** selected-source metadata resolver **exactly once** *only* on a selected trace (never on
 *    a no-selection trace), and (f) applies the PR #23 assembler, returning `{ ok: true, selection,
 *    overview }`. A no-selection trace is still an application **success** (`ok: true`) whose
 *    "no usable hourly data" fact is expressed inside the result (`selection.selected: false`,
 *    `overview.hourly: []`, `HOURLY` in `missingSections`) — a Provider/Normalization failure in the
 *    trace is **never** promoted to a new top-level error. The method is intentionally **not** `async`:
 *    an invalid location and a facade synchronous throw propagate synchronously (same error reference),
 *    while a facade rejection and a selector/resolver/assembler throw reject the returned Promise (same
 *    error reference), with **no** broad `try`/`catch`, wrapping, logging, or partial result. Provenance
 *    is **not** inferred: the service owns **no** clock/env/network, defines only the selected-source
 *    resolver *seam*, and never rebuilds a request plan or reconstructs a KMA base time. The **production
 *    resolver** is now the PR #26 component 12 below; together with it this service is assembled by the
 *    PR #27 `createKmaLocationHourlyOverviewCompositionFromEnv` — the fifth callable production
 *    composition root — where it is available as a live service. That composition root is **now wired
 *    into** `apps/api/src/index.ts` startup and mounted at the `POST /weather` production route. Because
 *    the internal application result carries the `selection`/execution trace alongside the `overview`,
 *    the production route serializes the `overview` only (through the PR #29 presenter).
 * 12. The PR #26 KMA **live selected-source metadata resolver**
 *    (`createKmaLiveSelectedHourlySourceMetadataResolver`): the production
 *    `KmaSelectedHourlySourceMetadataResolver` the component 11 service injects. It **consumes** the
 *    sanitized PR #25 issuance identity the execution trace preserved and materializes the four PR #23
 *    `KmaHourlySourceMetadataInput` provenance facts. A `PRIMARY` selection uses the actual
 *    `execution.primaryIssuance`; a `PREVIOUS` selection uses the actual `execution.previousIssuance`
 *    (present only on a fallback-attempted trace). `issuedAt` is that issuance's provider-native
 *    `baseDate`/`baseTime` expressed as a KST (`+09:00`) ISO instant with seconds — built by explicit
 *    string composition, never through a `Date`, and never recomputed from a clock, request plan, or
 *    base-time selector (schedule canonicality stays with the weather-core selector, so a structurally
 *    valid non-canonical `0615` still converts; the contracts `isoDateTime` schema rejects impossible
 *    calendar/clock values). `sourceId` is a fixed per-product app-internal id
 *    (`kma-short-forecast-hourly` / `kma-ultra-short-forecast-hourly`) that encodes **neither** the
 *    individual issuance, the `PRIMARY`/`PREVIOUS` distinction, `fallbackUsed`, nor the location — the
 *    logical source is `sourceId`, the individual issuance is `issuedAt`. `retrievalMode` is fixed
 *    `'LIVE'` (no cache exists yet). It asserts `input.product === issuance.product` **before** reading
 *    the clock, reads the injected clock **exactly once** per valid call to stamp `fetchedAt` (a UTC
 *    `Z` millisecond instant meaning "resolver materialization time", **not** an exact transport
 *    timestamp), and returns a **fresh** object with exactly the four sorted own keys
 *    `fetchedAt`/`issuedAt`/`retrievalMode`/`sourceId`. Every invalid input (non-object/unsupported
 *    issuance, non-selected/unknown-source selection, `PREVIOUS` without fallback, product mismatch,
 *    invalid clock value) fails synchronously with a **static** `RangeError` **before** the clock is
 *    read; inside component 11's `.then` handler that synchronous throw becomes the returned Promise's
 *    rejection with the same reference. It reads no env/network, opens no `fetch`/`AbortController`,
 *    and adds no dependency. The PR #27 `createKmaLocationHourlyOverviewCompositionFromEnv` — the
 *    fifth callable production composition root — injects it into the component 11 service, which is
 *    **now wired into** `apps/api/src/index.ts` startup and served at the `POST /weather` production
 *    route.
 *
 * 13. The PR #66 KMA current-observation (초단기실황) **request factory**
 *    (`createKmaCurrentObservationRequestFactory`): the current-observation counterpart of
 *    component 2, combining an injected clock, an injectable base-time selector, and
 *    caller-supplied `nx`/`ny` into a complete `KmaCurrentObservationRequest`. The selector is a
 *    `KmaCurrentObservationBaseTimeSelector`; when omitted it defaults to the PR #64 schedule-only
 *    `selectLatestKmaCurrentObservationBaseTime`. Unlike component 2 it has no `product` field. As
 *    of **PR #80**, the PR #69 production composition (`../composition`) injects the PR #79
 *    availability-delay `selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay` selector
 *    here as its explicit non-default choice — a direct one-argument caller of this factory still
 *    gets the schedule-only default. The factory itself fixes **no** availability policy: it calls
 *    the clock exactly once and the selector exactly once per `createScheduledRequest()` call,
 *    assembles no more than the request, and is not consumed by any service or route directly (only
 *    through the composition roots that wire it).
 * 14. The PR #67 KMA current-observation (초단기실황) **application service**
 *    (`createKmaCurrentObservationService`): the current-observation counterpart of component 1,
 *    running the PR #63 current-observation HTTP provider and the PR #63 `normalizeKmaCurrentObservation`
 *    adapter in sequence over an already-built `KmaCurrentObservationRequest` (the component 13
 *    factory output). It calls the injected provider **exactly once**, forwarding `request`/`options`
 *    (including `signal`) unchanged; a provider failure is returned verbatim as a `PROVIDER`-stage
 *    error; a provider success is handed to the real normalizer exactly once, and a normalization
 *    failure is returned verbatim as a `NORMALIZATION`-stage error; a normalization success returns
 *    only `{ ok: true, current }`. It creates **no** request, calls **no** clock/base-time selector,
 *    performs **no** location→grid conversion, and is not yet consumed by any composition, route, or
 *    `POST /weather`.
 * 15. The PR #68 KMA **scheduled current-observation facade**
 *    (`createKmaScheduledCurrentObservationFacade`): the current-observation counterpart of
 *    component 3, a thin connector that runs the component 13 request factory then the component 14
 *    service in order (input → request → current-observation result), passing `input`/request/
 *    `options`/Promise through by reference and adding no new rule. It calls the request factory
 *    **exactly once**; on factory success it calls the current-observation service **exactly once**
 *    and returns the service's Promise verbatim; on a factory throw the service is **not** called
 *    and the same error reference propagates. It creates **no** request/result union of its own,
 *    is not `async`, and is not yet consumed by any composition, route, or `POST /weather`.
 * 16. The PR #70 KMA **location scheduled current-observation facade**
 *    (`createKmaLocationScheduledCurrentObservationFacade`): the current-observation counterpart of
 *    component 4, a thin adapter that puts an injected latitude/longitude → grid converter in front
 *    of component 15 (input → grid → scheduled current-observation result), adding only a
 *    `LOCATION`-stage `UNSUPPORTED_LOCATION` result for a physically valid coordinate the KMA grid
 *    does not cover. It calls the converter **exactly once** with a fresh
 *    `{ latitude, longitude }`; on a supported location it calls component 15 **exactly once** with
 *    a fresh `{ nx, ny }` and returns its Promise verbatim; on an unsupported location it returns a
 *    fresh `LOCATION` result and never calls component 15; and a converter throw propagates
 *    synchronously. It selects **no** concrete production converter (that is the composition
 *    layer's job) and is not yet consumed by any composition, route, or `POST /weather`.
 *
 * 17. The PR #72 KMA **current-only `WeatherOverview` assembler**
 *    (`assembleKmaCurrentWeatherOverview`): the current-observation counterpart of component 10, a
 *    **pure, synchronous** function that consumes a caller's `WeatherLocation`, already-normalized
 *    `CurrentWeather`, and (since PR #73) a caller-supplied source context, and assembles the
 *    current-only partial contracts `WeatherOverview`. The caller's `current` becomes the
 *    overview's `current` unchanged (no field is recomputed, rounded, defaulted, or re-derived);
 *    every other section is a fixed placeholder (`hourly: []`, `daily: []`,
 *    `airQuality.current: null`, `airQuality.daily: []`, `alerts: []`), so `missingSections` is
 *    always exactly `['HOURLY', 'DAILY', 'AIR_QUALITY_CURRENT', 'AIR_QUALITY_FORECAST', 'ALERTS']`
 *    (never `CURRENT`, since `current` is always present). As of PR #73 `sources` carries exactly
 *    one KMA `CURRENT` `SourceMetadata` entry: the caller supplies `sourceId`/`fetchedAt`/
 *    `retrievalMode` (`KmaCurrentSourceMetadataInput`), and the assembler fixes `provider: 'KMA'`,
 *    `sections: ['CURRENT']`, `issuedAt: null`, and `observedAt: input.current.observedAt` from
 *    current-data semantics — built from explicit named fields, never a `{ ...input.source }`
 *    spread, so an extra runtime property on `input.source` can never override the fixed policy
 *    fields. (PR #72's `sources: []` behavior — provenance deferred entirely — is superseded by
 *    this metadata-aware contract.) It then validates the whole payload with `weatherOverview.parse`
 *    (a malformed location/current-weather/`sourceId`/`fetchedAt`/`retrievalMode` or invariant
 *    breach throws a synchronous Zod error), allocates a fresh output every call, and mutates
 *    nothing. It calls **no** Provider/service/facade/resolver/composition, performs **no**
 *    location→grid conversion, and reads no clock/environment/network. It is not the hourly
 *    assembler generalized — the two remain separate, parallel implementations — and it is **not
 *    yet** consumed by any application orchestration, composition root, or `POST /weather` route.
 * 18. The PR #73 KMA **live current source metadata resolver**
 *    (`createKmaLiveCurrentSourceMetadataResolver`): the current-observation counterpart of
 *    component 12, a nullary `KmaCurrentSourceMetadataResolver` that materializes the three
 *    provenance facts component 17's `KmaCurrentSourceMetadataInput` needs. Unlike component 12 it
 *    takes **no input** — current observation has no issuance identity or `PRIMARY`/`PREVIOUS`
 *    selection to correlate — so every fact is either a fixed constant or the injected clock:
 *    `sourceId` is the fixed canonical `'kma-ultra-short-current-observation'` identifier (no
 *    location, coordinate, grid cell, base date/time, or observation instant encoded); `retrievalMode`
 *    is fixed `'LIVE'`; `fetchedAt` is read from the injected clock **exactly once** per valid call,
 *    meaning "resolver materialization time", not an exact transport timestamp. An invalid clock
 *    value or a throwing clock propagates synchronously (same error reference) as a **static**
 *    `RangeError` after that single read. Construction reads the clock zero times. It is a separate,
 *    parallel implementation from component 12 — current and forecast provenance semantics are not
 *    generalized into a shared abstraction — and it is **not yet** wired into component 17, any
 *    application orchestration, composition root, or `POST /weather` route.
 * 19. The PR #74 KMA **location current `WeatherOverview` application service**
 *    (`createKmaLocationCurrentOverviewService`): the current-observation counterpart of
 *    component 11, connecting component 16 (the location scheduled current-observation facade),
 *    component 18 (the injected nullary current source metadata resolver), and component 17 (the
 *    current assembler) into a single call. Per call it (a) runs the contracts `weatherLocation`
 *    runtime parse on the caller's location **upfront** — an invalid location throws a
 *    **synchronous** Zod error and **no** collaborator runs — then (b) runs component 16 with the
 *    parsed `latitude`/`longitude`, (c) returns any `ok: false` result (`LOCATION`/`PROVIDER`/
 *    `NORMALIZATION`) **verbatim** (never reinterpreted, never promoted to a partial success —
 *    current has no "no usable data" success branch the way hourly does), and (d) on a success calls
 *    the **injected**, required, **nullary** resolver **exactly once** and the assembler **exactly
 *    once**, returning `{ ok: true, overview }`. The method is intentionally **not** `async`: an
 *    invalid location and a facade synchronous throw propagate synchronously (same error reference),
 *    while a facade rejection and a resolver/assembler throw reject the returned Promise (same error
 *    reference), with **no** broad `try`/`catch`, wrapping, logging, or partial result. This service
 *    owns **no** clock/env/network and injects no default resolver — the production PR #73 live
 *    resolver is not selected here. It is not yet consumed by any production composition root or
 *    `POST /weather` route.
 *
 * 20. The PR #76 KMA **current + hourly `WeatherOverview` aggregate assembler**
 *    (`assembleKmaCurrentHourlyWeatherOverview`): a **pure, synchronous** function that combines an
 *    already-computed component 11 hourly overview success with an optional already-computed
 *    component 19 current overview success into a single current+hourly partial contracts
 *    `WeatherOverview`. It calls **neither** service — it only reads the two services' public result
 *    types (`Extract<..., { ok: true }>` of each) and composes their already-produced `overview`
 *    values. The hourly success `overview` is the baseline for every non-current section (`hourly`,
 *    `daily`, `airQuality`, `alerts`, the non-`CURRENT` `missingSections`, and hourly `sources`); it
 *    reads only `input.hourly.overview`, **never** `input.hourly.selection` (the PR #22 execution
 *    trace). `input.current === null` means only that the caller has already decided current
 *    contributes nothing to this aggregate — the assembler never inspects or infers why (LOCATION,
 *    PROVIDER, or NORMALIZATION failure), and that degradation policy is deliberately left to a later
 *    application orchestration. When `current` is present, its location must equal the hourly
 *    baseline's location **by value** (every `WeatherLocation` contract field, not object identity) or
 *    the assembler throws a synchronous, static, value-free `RangeError`; otherwise `current` and
 *    `sources` overlay the baseline — `CURRENT` is removed from the baseline's `missingSections` (and
 *    nothing else changes; the current overview's own `missingSections` is never unioned in), and
 *    `sources` becomes the current overview's sources followed by the baseline's sources (deterministic
 *    order, no sort/dedupe/merge). It validates the assembled payload with `weatherOverview.parse` — the
 *    sole runtime invariant guard — reads no clock/environment/network, mutates nothing, and allocates a
 *    fresh output every call. It re-implements **no** PR #23/#72/#73 assembler policy, and it is **not
 *    yet** wired into any production composition root, `POST /weather` route, or presenter.
 *
 * 21. The PR #77 KMA **location current + hourly `WeatherOverview` application orchestration**
 *    (`createKmaLocationCurrentHourlyOverviewService`): the first component that actually
 *    **invokes** component 11 (the PR #24 hourly overview service) and component 19 (the PR #74
 *    current overview service) and combines their results through component 20 (the PR #76
 *    aggregate assembler), which itself calls neither. Execution is **sequential, not
 *    concurrent**: it always calls component 11 first, with the caller's exact `input`/`options`
 *    references; a top-level hourly `LOCATION` failure is returned **verbatim** and neither
 *    component 19 nor component 20 runs. Every hourly `{ ok: true }` result — including a
 *    no-selection success — then calls component 19 exactly once with a **fresh**
 *    `{ location: hourlyResult.overview.location }` input (the hourly baseline's own parsed
 *    location, never the caller's raw input) and the caller's exact `options` reference. This PR
 *    owns the one explicit degradation policy at this boundary: any current result that
 *    **resolves** with `ok: false` (`LOCATION`/`PROVIDER`/`NORMALIZATION`, inspected uniformly,
 *    never differentiated) is **not** returned — component 20 is called with `current: null`
 *    instead, so the aggregate expresses current unavailability as `current: null` and `CURRENT`
 *    in `missingSections` rather than a top-level error. A current **success** reaches component
 *    20 by exact reference. Unexpected throws/rejections are never degraded: a hourly synchronous
 *    throw propagates synchronously, and a hourly rejection, a current synchronous throw/
 *    rejection, or a component-20 throw reject the returned Promise with the same reference —
 *    there is no broad `try`/`catch`. The combined result is **intentionally** kept exactly
 *    {@link KmaLocationHourlyOverviewResult}-compatible (`{ ok: true, selection, overview }` or
 *    the hourly `LOCATION` failure verbatim) so a later production-wiring PR can reuse the
 *    existing hourly presenter boundary unchanged. Construction is side-effect-free — it merely
 *    closes over the three injected references. It re-implements **no** `WeatherOverview` merging,
 *    hourly fallback/selection policy, or current provider/normalization inspection, and it is
 *    **not yet** wired into any production composition root, `POST /weather` route, or presenter.
 *
 * 22. The PR #85 AirKorea **location current air-quality application service**
 *    (`createAirKoreaLocationCurrentAirQualityService`): the first application-layer component in the
 *    separate AirKorea provider namespace, connecting a `WeatherLocation` to a `CurrentAirQuality` by
 *    chaining the PR #84 administrative-name → TM-coordinate provider, the PR #83 TM-coordinate →
 *    nearby-station provider, and the PR #82 current-air-quality provider/normalizer — three
 *    independent boundaries none of which selects a candidate for the others. It supports only a
 *    Korean location with a non-null `adminArea1`/`adminArea3` (province/district-level locations with
 *    a `null` `adminArea3` fail closed as `UNSUPPORTED_ADMINISTRATIVE_LEVEL`, never guessing a child
 *    dong), resolves the PR #84 TM candidate by an **exact** `sidoName`/`sggName`/`umdName` match
 *    against the location's administrative fields (`sggName` skipped only when `adminArea2` is `null`;
 *    zero or multiple exact matches are `TM_COORDINATE_NOT_FOUND`/`AMBIGUOUS_TM_COORDINATE`, never
 *    `candidates[0]`), and selects the PR #83 station with the smallest `distanceKm` (a `stationName`
 *    ascending tie-break for equal distances, never upstream order). Execution is strictly
 *    sequential — TM lookup → candidate resolution → nearby-station lookup → closest-station selection
 *    → current-air-quality lookup → normalization — with **at most three** provider calls and no
 *    retry/fallback/cache. Every provider-stage failure carries that provider's own error **by exact
 *    reference**; `NORMALIZATION` reuses the existing PR #82 `normalizeAirKoreaCurrentAirQuality`
 *    verbatim. `options` (and any `AbortSignal`) is forwarded by exact reference to all three
 *    providers; construction is side-effect-free. It is **not** wired into any production composition
 *    root, `POST /weather` route, or the KMA `WeatherOverview` assembly — `AIR_QUALITY_CURRENT` stays
 *    missing from production responses after this PR. See
 *    `docs/airkorea-location-current-air-quality-service.md`.
 *
 * The grid-based single-request **production composition root** (system clock adapter,
 * provider-from-env wiring, a live facade instance) is built in PR #11 and lives in `../composition`;
 * PR #12 added the latitude/longitude → grid converter in `@life-weather/weather-core`; PR #13's
 * location scheduled sibling connects that converter to the scheduled facade; PR #20 added the grid
 * fallback composition root that consumes the PR #18 factory and PR #19 orchestration; PR #21 added
 * the location fallback composition root that wires the PR #12 converter in front of the PR #20 grid
 * fallback service; and PR #27 added the location hourly overview composition root
 * (`createKmaLocationHourlyOverviewCompositionFromEnv`) that assembles the PR #24 service over the
 * PR #21 location fallback facade and the PR #26 live resolver (all production wiring lives in
 * `../composition`). That is **five** callable production composition roots in total. The location hourly
 * overview root is **now wired into** `apps/api/src/index.ts` startup and mounted at the `POST /weather`
 * production route; the other four roots (grid scheduled, location scheduled, grid fallback, location
 * fallback) are internal building blocks and are **not** exposed as their own HTTP routes.
 *
 * Application services deliberately live **outside** `providers/kma` (they are not part of the
 * provider boundary) and are exported only from here, never from `providers/kma/index.ts`. See
 * `docs/kma-hourly-service.md`, `docs/kma-forecast-request-factory.md`,
 * `docs/kma-scheduled-hourly-facade.md`, `docs/kma-location-scheduled-hourly.md`,
 * `docs/kma-fallback-request-plan.md`, `docs/kma-hourly-fallback.md`,
 * `docs/kma-location-hourly-fallback.md`, `docs/kma-hourly-fallback-selection.md`,
 * `docs/kma-hourly-weather-overview.md`, `docs/kma-location-hourly-overview.md`,
 * `docs/kma-selected-hourly-source-metadata.md`,
 * `docs/kma-current-observation-request-factory.md`,
 * `docs/kma-current-observation-service.md`,
 * `docs/kma-scheduled-current-observation-facade.md`,
 * `docs/kma-location-scheduled-current-observation.md`,
 * `docs/kma-current-weather-overview.md`,
 * `docs/kma-current-source-metadata.md`,
 * `docs/kma-location-current-overview.md`,
 * `docs/kma-current-hourly-weather-overview.md`, and
 * `docs/kma-location-current-hourly-overview.md`.
 */

export {
  createKmaHourlyForecastService,
  type KmaHourlyForecastService,
  type KmaHourlyForecastServiceOptions,
  type KmaHourlyForecastServiceResult,
} from './kma-hourly-forecast.js';

export {
  createKmaForecastRequestFactory,
  type KmaForecastBaseTimeSelector,
  type KmaForecastRequestClock,
  type KmaForecastRequestFactory,
  type KmaForecastRequestFactoryInput,
} from './kma-forecast-request.js';

export {
  createKmaScheduledHourlyForecastFacade,
  type KmaScheduledHourlyForecastFacade,
  type KmaScheduledHourlyForecastInput,
  type KmaScheduledHourlyForecastOptions,
  type KmaScheduledHourlyForecastResult,
} from './kma-scheduled-hourly-forecast.js';

export {
  createKmaLocationScheduledHourlyForecastFacade,
  type KmaLocationForecastGridConverter,
  type KmaLocationScheduledHourlyForecastFacade,
  type KmaLocationScheduledHourlyForecastInput,
  type KmaLocationScheduledHourlyForecastOptions,
  type KmaLocationScheduledHourlyForecastResult,
  type KmaUnsupportedLocationError,
} from './kma-location-scheduled-hourly-forecast.js';

export {
  classifyKmaHourlyFallbackEligibility,
  type KmaHourlyFallbackEligibility,
  type KmaHourlyFallbackReason,
} from './kma-hourly-fallback-eligibility.js';

export {
  createKmaFallbackRequestPlanFactory,
  type KmaFallbackRequestPlan,
  type KmaFallbackRequestPlanFactory,
  type KmaFallbackRequestPlanFactoryInput,
  type KmaForecastBaseTimeCandidatesSelector,
} from './kma-fallback-request-plan.js';

export type { KmaForecastIssuanceIdentity } from './kma-forecast-issuance-identity.js';

export {
  createKmaHourlyFallbackService,
  type KmaHourlyFallbackEligibilityClassifier,
  type KmaHourlyFallbackService,
  type KmaHourlyFallbackServiceInput,
  type KmaHourlyFallbackServiceOptions,
  type KmaHourlyFallbackServiceResult,
} from './kma-hourly-fallback.js';

export {
  createKmaLocationHourlyFallbackFacade,
  type KmaLocationHourlyFallbackFacade,
  type KmaLocationHourlyFallbackInput,
  type KmaLocationHourlyFallbackOptions,
  type KmaLocationHourlyFallbackResult,
} from './kma-location-hourly-fallback.js';

export {
  selectKmaHourlyFallbackResult,
  type KmaHourlyFallbackSelection,
  type KmaHourlyFallbackSelectionSource,
} from './kma-hourly-fallback-selection.js';

export {
  assembleKmaHourlyWeatherOverview,
  type KmaHourlySourceMetadataInput,
  type KmaHourlyWeatherOverviewInput,
} from './kma-hourly-weather-overview.js';

export {
  createKmaLocationHourlyOverviewService,
  type KmaLocationHourlyOverviewInput,
  type KmaLocationHourlyOverviewOptions,
  type KmaSelectedHourlySourceMetadataResolverInput,
  type KmaSelectedHourlySourceMetadataResolver,
  type KmaLocationHourlyOverviewResult,
  type KmaLocationHourlyOverviewService,
} from './kma-location-hourly-overview.js';

export {
  convertKmaForecastIssuanceToIssuedAt,
  createKmaLiveSelectedHourlySourceMetadataResolver,
  type KmaSelectedHourlySourceMetadataClock,
} from './kma-selected-hourly-source-metadata.js';

export {
  createKmaCurrentObservationRequestFactory,
  type KmaCurrentObservationBaseTimeSelector,
  type KmaCurrentObservationRequestClock,
  type KmaCurrentObservationRequestFactory,
  type KmaCurrentObservationRequestFactoryInput,
} from './kma-current-observation-request.js';

export {
  createKmaCurrentObservationService,
  type KmaCurrentObservationService,
  type KmaCurrentObservationServiceOptions,
  type KmaCurrentObservationServiceResult,
} from './kma-current-observation.js';

export {
  createKmaScheduledCurrentObservationFacade,
  type KmaScheduledCurrentObservationFacade,
  type KmaScheduledCurrentObservationInput,
  type KmaScheduledCurrentObservationOptions,
  type KmaScheduledCurrentObservationResult,
} from './kma-scheduled-current-observation.js';

export {
  createKmaLocationScheduledCurrentObservationFacade,
  type KmaCurrentObservationUnsupportedLocationError,
  type KmaLocationCurrentObservationGridConverter,
  type KmaLocationScheduledCurrentObservationFacade,
  type KmaLocationScheduledCurrentObservationInput,
  type KmaLocationScheduledCurrentObservationOptions,
  type KmaLocationScheduledCurrentObservationResult,
} from './kma-location-scheduled-current-observation.js';

export {
  assembleKmaCurrentWeatherOverview,
  type KmaCurrentSourceMetadataInput,
  type KmaCurrentWeatherOverviewInput,
} from './kma-current-weather-overview.js';

export {
  createKmaLiveCurrentSourceMetadataResolver,
  type KmaCurrentSourceMetadataClock,
  type KmaCurrentSourceMetadataResolver,
} from './kma-current-source-metadata.js';

export {
  createKmaLocationCurrentOverviewService,
  type KmaLocationCurrentOverviewInput,
  type KmaLocationCurrentOverviewOptions,
  type KmaLocationCurrentOverviewResult,
  type KmaLocationCurrentOverviewService,
} from './kma-location-current-overview.js';

export {
  assembleKmaCurrentHourlyWeatherOverview,
  type KmaCurrentHourlyWeatherOverviewInput,
} from './kma-current-hourly-weather-overview.js';

export {
  createKmaLocationCurrentHourlyOverviewService,
  type KmaLocationCurrentHourlyOverviewInput,
  type KmaLocationCurrentHourlyOverviewOptions,
  type KmaLocationCurrentHourlyOverviewResult,
  type KmaLocationCurrentHourlyOverviewService,
} from './kma-location-current-hourly-overview.js';

export {
  createAirKoreaLocationCurrentAirQualityService,
  type AirKoreaLocationCurrentAirQualityInput,
  type AirKoreaLocationCurrentAirQualityLocationError,
  type AirKoreaLocationCurrentAirQualityOptions,
  type AirKoreaLocationCurrentAirQualityResult,
  type AirKoreaLocationCurrentAirQualityService,
} from './airkorea-location-current-air-quality.js';
