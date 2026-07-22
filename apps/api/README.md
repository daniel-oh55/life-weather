# @life-weather/api

Hono API for Life Weather, structured for Vercel's zero-configuration Node.js function detection.

To develop locally (from the repository root):

```
pnpm install
pnpm dev:api
```

To type-check and test:

```
pnpm --filter @life-weather/api typecheck
pnpm --filter @life-weather/api test
```

This PR does not link this app to a real Vercel project. `vercel dev` will prompt to link/create
a project on first run; that step is intentionally deferred to a later PR.

## Current state

- `GET /health` returns a deterministic health payload (unchanged).
- **KMA raw-response boundary** — `src/providers/kma/` validates the raw 기상청 `getVilageFcst` /
  `getUltraSrtFcst` JSON at runtime with **Zod**, classifies it (success / upstream error /
  invalid response), and groups a validated page into per-time forecast slots with an explicit
  `ABSENT` / `NULL` / `VALUE` field-presence model. See
  [docs/kma-response-boundary.md](../../docs/kma-response-boundary.md). Boundary rules worth noting:
  - `dataType` must be exactly `"JSON"` (this boundary only validates already-parsed JSON); `"XML"`,
    `""`, `"json"`, or any other value is an invalid response.
  - `resultCode` must be exactly two digits (`/^\d{2}$/`). `"00"` is success; any other valid
    two-digit code (incl. unknown future ones like `99`) is an upstream error; a malformed code
    (`""`, `"0"`, `"000"`, `"AB"`, `" 03 "`) is an invalid response, never an upstream error.
  - An upstream error exposes **only** the two-digit `resultCode` — the untrusted raw `resultMsg`
    is dropped, so a secret-shaped token, CR/LF, or log-injection payload cannot leak.
  - Obvious pagination self-contradictions are rejected (`item > numOfRows`, `item > totalCount`,
    `totalCount === 0` with items present).
  - `category` is restricted to ASCII uppercase/digits (`/^[A-Z0-9]+$/`); unknown/future codes
    still pass as long as they match the pattern.
  - Evidence level: envelope/field **spec** is official, but the official examples are XML-centric,
    so the JSON serialization is modelled from the field-type spec; `fcstValue: null` and an empty
    success page are **defensive** allowances (no confirmed official sample). These — together with
    the concrete shape of the newly-provided 초단기예보 `POP` in a real response — remain to be
    confirmed by a **follow-up live integration check using a real service key**; no already-merged
    PR performed that authenticated-JSON verification.
- **KMA HTTP forecast provider** — PR #5 connects the boundary above to the real 공공데이터포털
  **HTTPS** endpoint. `createKmaForecastProvider` / `createKmaForecastProviderFromEnv` perform the
  `fetch` for `getVilageFcst` / `getUltraSrtFcst`, then run the PR #4 parser + slot grouping and
  correlate the response against the request. See
  [docs/kma-http-provider.md](../../docs/kma-http-provider.md). Highlights:
  - Server-only `KMA_SERVICE_KEY` (일반 인증키/Decoding). Read only when a factory is **called**
    (never at import); missing/empty/whitespace/leading-or-trailing-whitespace keys return a
    `CONFIG_ERROR` value (never a throw), and the key never appears in any error.
  - The key is placed via `URLSearchParams` and encoded **exactly once**; fixed `pageNo=1`,
    `numOfRows=1000`, `dataType=JSON` (a caller cannot override these).
  - Node-native `fetch` (`redirect: 'error'`), a default 10s timeout, caller-`AbortSignal` support,
    and a default 4 MiB response-body cap — all project defensive defaults, no new dependency,
    **no retry / no cache**.
  - The **timeout and caller-abort lifecycle spans the whole transport** — the `fetch`, the
    HTTP-status decision, *and* the full response-body read — so a stalled or aborted body after a
    header has arrived still resolves promptly (`TIMEOUT` / `ABORTED`), never hanging. A body-stream
    failure resolves to `NETWORK_ERROR` (or `TIMEOUT` / `ABORTED` if an abort caused it), never a
    rejected promise, and the raw stream/cancel/lock-release error is never surfaced. A
    `Content-Length` that already exceeds the cap cancels the body without reading a byte.
  - Once a body reader is acquired, `releaseLock()` is **attempted** on every exit path — normal
    completion, overflow, a read error, or a cancel error — because a `cancel()` or a drained stream
    does not release the lock on its own; on standard Node Web Streams the lock is released. If
    `releaseLock()` itself throws, the failure is swallowed (the decided result is preserved and no
    raw error leaks), but the lock release itself is not guaranteed in that case.
  - Both runtime validators (`validateKmaForecastRequest`, `validateKmaProviderOptions`) are
    **total** on non-object input: a `null`/string/array/function/etc. yields `INVALID_REQUEST` /
    `CONFIG_ERROR` instead of throwing. `INVALID_REQUEST` issues for a non-object request are built
    **fresh per call** (a new array of new objects), so mutating one returned result cannot corrupt
    a later call — there is no shared mutable state between calls. (`isRecord` here is a non-null,
    non-array object check, not a strict plain-object check; hostile-prototype/`Proxy` hardening is
    a later follow-up.)
  - Classifies errors as `TIMEOUT` / `ABORTED` / `NETWORK_ERROR` / `HTTP_ERROR(status)` /
    `RESPONSE_TOO_LARGE` / `EMPTY_RESPONSE` / `NON_JSON_RESPONSE` / `INVALID_JSON` /
    `GATEWAY_ERROR` / `KMA_UPSTREAM_ERROR` / `KMA_INVALID_RESPONSE` / `RESPONSE_MISMATCH` /
    `INCOMPLETE_PAGE` / `DUPLICATE_CATEGORY` — none carrying the key, URL, raw body, or exception.
- **KMA hourly forecast normalization** — PR #6 adds `normalizeKmaHourlyForecast`, a **pure adapter**
  that turns a provider success's slots into the common `@life-weather/contracts` `HourlyForecast[]`.
  See [docs/kma-hourly-normalization.md](../../docs/kma-hourly-normalization.md). Highlights:
  - Per-product category selection: 단기예보 `TMP`/`PCP`/`SNO`, 초단기예보 `T1H`/`RN1` (no 신적설).
    `SKY`+`PTY`→condition, `POP`/`REH`→%, `WSD`/`VEC`→wind — via `@life-weather/weather-core` parsers.
    `RN1` reuses the `PCP` parser (the guide shares one 강수량 범주 for both). 초단기예보 POP는
    두 공식 자료(API 허브 웹 변수 목록·활용가이드 `_260623.docx`)에 모두 포함됩니다(제공 시작 시각
    표기는 웹 `12 KST`·DOCX `11 KST`로 다르며, 원인은 미확인 — [docs/kma-hourly-normalization.md](../../docs/kma-hourly-normalization.md)
    참조). POP가 존재하면 다른 상품과 동일하게 정규화하고, 이전/부분 응답 등에서 ABSENT 또는
    NULL이면 nullable contract에 따라 `null`입니다(발표일자·발표시각 하드코딩 분기 없음). `UUU`/`VVV`/`WAV`/`TMN`/`TMX`/`LGT` and unknown codes are ignored, and no
    raw KMA value reaches the output.
  - `forecastAt` is composed as fixed-KST ISO (`YYYY-MM-DDTHH:mm:00+09:00`) with no `Date`, clock, or
    time-zone dependency; `feelsLikeCelsius` is fixed `null` (a derived value deferred to a later PR).
  - `temperatureCelsius` is required: an ABSENT/NULL/unparseable `TMP`/`T1H` is a normalization issue
    (the slot is never silently dropped nor defaulted to `0`). Every other field is nullable: ABSENT,
    NULL, or an unparseable/out-of-range/Missing value all become `null`.
  - Each candidate is validated with `hourlyForecast.safeParse`; output is sorted by `forecastAt` and
    issues by `(slotKey, field, reason)`. It never mutates the input and reads no clock. The HTTP
    provider does **not** call it automatically — network and domain errors stay in separate unions.
- **KMA hourly forecast application service** — PR #7 adds `createKmaHourlyForecastService`
  (`src/services/`), the thin orchestration layer that runs the PR #5 provider and the PR #6
  normalizer in sequence. See [docs/kma-hourly-service.md](../../docs/kma-hourly-service.md).
  Highlights:
  - Takes an **injected** `KmaForecastProvider` via a factory; construction is side-effect-free (no
    provider call, no `fetch`, no env read, no timer/listener). `fetchHourlyForecast(request, options)`
    calls the provider **exactly once**, forwarding the request and the caller's `AbortSignal` options
    unchanged (omitted options → `undefined`; no new `AbortController`, no re-validation of the
    request — the provider still owns that).
  - The result is a discriminated union with a `stage` marker: success is `{ ok: true, hourly }`
    (only the normalized `HourlyForecast[]` — no raw slots/values, `totalCount`, base issuance, grid,
    key, URL, or body); a provider failure is `{ ok: false, stage: 'PROVIDER', error }` with the
    provider's sanitized error passed through **verbatim** (never re-classified or mutated); a
    normalizer failure is `{ ok: false, stage: 'NORMALIZATION', issues }` with the all-or-nothing
    issue list untouched (never partial hourly data). The normalizer runs only on provider success.
  - No broad `try/catch` and no invented `INTERNAL_ERROR`: both collaborators return result unions
    rather than throwing, so a programmer error is not hidden behind a domain error. No retry, no
    cache, no fallback, no product merge. It is exported from `src/services/`, never from
    `src/providers/kma/` (an application service is not part of the provider boundary), and does not
    touch `src/index.ts` or the `/health` route.
- **KMA forecast request factory (injected clock)** — PR #9 adds `createKmaForecastRequestFactory`
  (`src/services/`), the application-level factory that combines an **injected clock**, the PR #8
  scheduled issue-time selector (`selectLatestKmaForecastBaseTime` in `@life-weather/weather-core`),
  and caller-supplied `product`/`nx`/`ny` into a complete `KmaForecastRequest`. See
  [docs/kma-forecast-request-factory.md](../../docs/kma-forecast-request-factory.md). Highlights:
  - Implemented: the injected-clock request factory, selecting `baseDate`/`baseTime` from a base-time
    selector and combining it with `product`/`nx`/`ny`. **PR #15** added a second, optional
    `baseTimeSelector` parameter (type `KmaForecastBaseTimeSelector`); when omitted it defaults to the
    PR #8 `selectLatestKmaForecastBaseTime` (schedule-only), and production composition injects the
    PR #14 availability-delay selector (see the availability bullet below).
  - The clock is **injected** — the factory never reads a system clock (no `Date.now()`, `new Date()`,
    `performance`, `process`) and provides no default clock. Construction reads the clock **zero**
    times; each `createScheduledRequest()` reads it **exactly once**, with no argument, and forwards
    that epoch to the selector verbatim. It calls the selector once — it never re-implements the
    KST schedule.
  - The result carries exactly `product`/`baseDate`/`baseTime`/`nx`/`ny` (explicit fields, never an
    `input` spread), is a **fresh** object per call, and never mutates the input; a runtime extra
    property on the input cannot leak into the result. Method named `createScheduledRequest`, not
    `createAvailableRequest`: it selects the scheduled issuance and makes **no** API-availability claim.
  - No new result union and no broad `try/catch`: a selector `RangeError` and any error the clock
    throws propagate **verbatim** (the clock's error keeps its exact reference).
  - `nx`/`ny` are assumed already computed; the factory does not transform or re-validate them — the
    provider still owns runtime request validation, so the factory does not call
    `validateKmaForecastRequest`. PR #12 adds the pure `convertKmaLatitudeLongitudeToGrid` converter
    in `@life-weather/weather-core`; the request factory and the existing grid-based scheduled facade
    still consume already-computed `product`/`nx`/`ny` and do **not** perform coordinate conversion
    themselves. PR #13 adds a **separate** location facade and production composition that consume that
    converter before delegating to the unchanged grid-based pipeline, so a `product`/`latitude`/
    `longitude` entry point now exists (see below), though it is not yet connected to API startup or an
    HTTP route.
  - **Connected by the PR #10 facade.** `createKmaScheduledHourlyForecastFacade` (below) sequences
    this factory → the hourly service. `KmaHourlyForecastService` still takes a **fully-assembled**
    `KmaForecastRequest` as input (contract unchanged), so a direct caller can keep calling it with a
    completed request. The separate PR #11 production composition root now instantiates the factory
    with a system or injected clock and wires the Provider, service, and facade into a live graph.
    The request factory itself still consumes only its injected clock, and the composition is not yet
    connected to API startup or a route.
- **KMA scheduled hourly forecast facade** — PR #10 adds `createKmaScheduledHourlyForecastFacade`
  (`src/services/`), a thin application facade that connects the PR #9 request factory and the PR #7
  hourly service in order. See [docs/kma-scheduled-hourly-facade.md](../../docs/kma-scheduled-hourly-facade.md).
  Highlights:
  - Both collaborators are **injected**; construction is side-effect-free (it calls neither
    collaborator and performs no I/O). One `fetchScheduledHourlyForecast(input, options)` call runs
    `requestFactory.createScheduledRequest(input)` **exactly once**, then, on success,
    `hourlyService.fetchHourlyForecast(request, options)` **exactly once**.
  - It passes `input`, the resulting request, and `options` through **by reference** (no clone,
    spread, mutation, re-validation, or default), forwards omitted `options` as exactly `undefined`,
    and returns the hourly service's Promise as the **same** reference — the method is not marked
    `async` and adds no Promise layer.
  - It defines **no** new result union and **no** new error type: a success, a `PROVIDER`-stage
    failure, and a `NORMALIZATION`-stage failure pass through unchanged; a factory throw propagates
    verbatim and the hourly service is **not** called; a hourly-service synchronous throw or rejected
    Promise propagates verbatim (no broad `try`/interception). Input `product`/`nx`/`ny`,
    `options`/result type are re-used from the two collaborators via type aliases.
  - **Not a composition root.** It creates no provider, reads no system clock / environment / service
    key, converts no lat/long → grid, and adds no availability delay, retry, or fallback.
- **KMA production composition root** — PR #11 adds `src/composition`, the explicit server-side wiring
  point: `createKmaSystemClock` (the production system clock adapter) and
  `createKmaScheduledHourlyCompositionFromEnv`, which assembles the PR #5 provider-from-env, PR #7
  hourly service, PR #9 request factory (with the PR #8 selector), and PR #10 scheduled facade into a
  live facade. See [docs/kma-production-composition.md](../../docs/kma-production-composition.md).
  Implemented:
  - The **system clock adapter** — `createKmaSystemClock()` reads `Date.now()` **zero** times on
    construction and **exactly once** per `nowEpochMilliseconds()` call (no argument, verbatim return,
    no cache / rounding / time-zone math); a `Date.now()` throw propagates by the same reference. It is
    the only place in the composition layer that reads the system time.
  - **Provider-from-env production composition** — a **callable** function (never an import-time
    singleton): importing the module reads no environment and builds nothing; `process.env` is read
    only when the function is called with `env` omitted. It uses `createKmaForecastProviderFromEnv` and
    leaves `KMA_SERVICE_KEY` reading/validation to the provider factory (composition reads no key).
  - **Assembly of request factory / hourly service / scheduled facade** from the selected clock and the
    provider, with **explicit `fetchImpl` / `clock` dependency injection** (production defaults: native
    `fetch` + the system clock). Construction reads no clock and issues no `fetch` — the first clock
    read and first `fetch` happen only when the returned facade runs.
  - A **config-failure result** — a provider `CONFIG_ERROR` is passed through **by reference** as
    `{ ok: false, error }` (no clock read, no `fetch`, no throw); success exposes **only**
    `{ ok, facade }` (no internal provider / factory / service / clock / env / key / URL).
  - **Full in-memory pipeline verification** — the composition tests assemble the real components and
    exercise a complete SHORT pipeline through an injected in-memory `fetchImpl` (no real service key,
    no external network, no fake timers), plus abort / provider-failure / normalization-failure /
    clock-error / repeated-call / secret-non-leakage cases.
- **KMA location scheduled hourly forecast facade** — PR #13 adds
  `createKmaLocationScheduledHourlyForecastFacade` (`src/services/`), a thin application adapter that
  puts an **injected** latitude/longitude → grid converter (PR #12's structure) in front of the PR #10
  scheduled facade, plus `createKmaLocationScheduledHourlyCompositionFromEnv` (`src/composition/`), the
  location production composition. See
  [docs/kma-location-scheduled-hourly.md](../../docs/kma-location-scheduled-hourly.md). Highlights:
  - `fetchScheduledHourlyForecastForLocation({ product, latitude, longitude }, options)` calls the
    converter **exactly once** (a fresh `{ latitude, longitude }` object — never the caller input
    spread, never carrying `product`); on a supported location it calls the scheduled facade **exactly
    once** with a fresh `{ product, nx, ny }` object (the converter's `nx`/`ny` passed through
    unchanged), forwards `options` by reference (omitted → exactly `undefined`), and returns the
    scheduled facade's Promise as the **same** reference (not marked `async`, no Promise layer).
  - It adds exactly one new outcome: a converter `null` (a physically valid coordinate the grid does
    not cover) becomes a value-free `{ ok: false, stage: 'LOCATION', error: { kind:
    'UNSUPPORTED_LOCATION' } }` — fresh per call, carrying no coordinate / grid / message. A success, a
    `PROVIDER`-stage failure, and a `NORMALIZATION`-stage failure pass through unchanged (never
    re-classified as `LOCATION`); a converter throw (e.g. an out-of-range `RangeError`) propagates
    **verbatim and synchronously** and the scheduled facade is **not** called (`RangeError` and
    unsupported-location are never merged).
  - **Location production composition** — `createKmaLocationScheduledHourlyCompositionFromEnv` reuses
    the PR #11 `createKmaScheduledHourlyCompositionFromEnv` verbatim (config `CONFIG_ERROR` passed
    through **by reference**, no converter run / clock read / `fetch` at construction), then selects the
    production `convertKmaLatitudeLongitudeToGrid` from the `@life-weather/weather-core` public surface
    (no private deep import) and wires the location facade. Success exposes **only** `{ ok, facade }`;
    the grid-based composition and its result are unchanged, no new dependency option is added, and no
    route is wired.
  - **Full in-memory Seoul pipeline verification** — the location composition tests assemble the real
    components (PR #12 converter → grid → scheduled facade) and exercise a complete Seoul SHORT pipeline
    (`{ latitude: 37.5665, longitude: 126.978 }` → `{ nx: 60, ny: 127 }`) through an injected in-memory
    `fetchImpl`, plus Tokyo-unsupported / invalid-coordinate / abort / provider-failure /
    normalization-failure / repeated-call / secret-non-leakage cases.
- **KMA availability-delay selector wired into production (PR #15).** PR #14 added the pure
  `selectLatestKmaForecastBaseTimeAfterAvailabilityDelay` in `@life-weather/weather-core` (단기예보
  +10m, 초단기예보 +15m; see
  [docs/kma-api-availability-time.md](../../docs/kma-api-availability-time.md)), and PR #15 now
  **consumes it in `apps/api` production**. See
  [docs/kma-production-composition.md](../../docs/kma-production-composition.md). Highlights:
  - The PR #9 request factory gains a second, optional `baseTimeSelector` parameter (a new
    `KmaForecastBaseTimeSelector` type). **Omitting it keeps the PR #8 schedule-only
    `selectLatestKmaForecastBaseTime` default**, so an existing one-argument caller is unchanged; the
    method is still `createScheduledRequest`, and the factory itself fixes no availability policy.
  - `createKmaScheduledHourlyCompositionFromEnv` **explicitly injects** the PR #14 availability-delay
    selector as its fixed production choice, so every production request is dated to an
    availability-threshold-aware issuance (e.g. SHORT 05:00 KST → `0200`, 05:10 → `0500`; ULTRA 06:30 →
    `0530`, 06:45 → `0630`).
  - `createKmaLocationScheduledHourlyCompositionFromEnv` reuses that grid composition verbatim, so the
    location production pipeline **inherits** the same policy without importing or injecting the
    selector itself (the location composition runtime is unchanged).
  - The exact SHORT-10-minute / ULTRA-15-minute inclusive threshold is a **deterministic project
    policy**, not an official SLA — it carries **no live-readiness guarantee** and PR #15 adds **no**
    retry, fallback, or live probe. A direct one-argument request-factory caller still gets the
    schedule-only default, and no HTTP route consumes any of this yet.
- **KMA primary/previous base-time candidates exist in weather-core, not yet consumed here (PR #16).**
  PR #16 added the pure `selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay` in
  `@life-weather/weather-core` (it returns `{ primary, previous }` from one instant; see
  [docs/kma-fallback-candidates.md](../../docs/kma-fallback-candidates.md)), but **`apps/api` does not
  consume it.** Production still injects only the PR #14 **single** availability-delay selector, the
  request factory still builds **one** request (one `createScheduledRequest` → one base time), and the
  provider is still called **once** per facade run. No-data / publication-in-progress classification and
  the single-previous-issuance fallback orchestration that would use these candidates are **later PRs**,
  and no route is wired.
- **KMA fallback-eligibility classifier** — PR #17 adds `classifyKmaHourlyFallbackEligibility`
  (`src/services/`), a **pure** function that inspects one `KmaHourlyForecastServiceResult` and decides
  whether a later orchestration step may try a single previous-issuance fallback. See
  [docs/kma-fallback-eligibility.md](../../docs/kma-fallback-eligibility.md). Highlights:
  - It takes the **service-level result only** (never the raw provider success): fallback-eligible for
    exactly two no-data signals — a `PROVIDER`-stage `KMA_UPSTREAM_ERROR` whose `resultCode` is
    **exactly** `'03'` (`KMA_NO_DATA`, 기상청 `NODATA_ERROR`) or a success with an empty `hourly` array
    (`EMPTY_HOURLY`). Every other result is `{ eligible: false }` (no `reason` key): a non-empty
    success, every other provider error (Abort / Timeout / HTTP / Network / gateway / invalid /
    mismatched / incomplete, and any non-`'03'` upstream code), and **every** normalization failure
    (`ABSENT`/`NULL`/`INVALID` alike — issues are never re-inspected).
  - Exact-match on `'03'` — no trim, `padStart`, numeric coercion, loose equality, or code-range
    bucketing (`'3'`, `'003'`, `' 03'`, `'03 '`, `' 03 '` are all ineligible). It does **not** read
    `totalCount` directly; `EMPTY_HOURLY` is the service-level empty-success signal, which the current
    pipeline can reach via a `totalCount === 0` success page (→ empty slots → empty `hourly`).
  - Deterministic and synchronous with a **fresh** result per call: no clock, environment, network,
    `Promise`, logging, `try/catch`, or mutation of the input (or its nested error/issues/hourly), and
    no original error/issues/hourly reference leaks into the output. It adds **no** new dependency.
  - **Not yet wired to the PR #16 candidates.** This PR only classifies — no request plan, no second
    request, no retry, and no fallback execution. The production facade still issues **at most one** KMA
    request per call, and no route consumes the classifier.
- **KMA fallback request-plan factory** — PR #18 adds `createKmaFallbackRequestPlanFactory`
  (`src/services/`), the application-level factory that combines an **injected clock** and an
  **injectable candidate selector** with caller-supplied `product`/`nx`/`ny` into a
  `{ primary, previous }` pair of complete `KmaForecastRequest`s from a **single** absolute reference.
  See [docs/kma-fallback-request-plan.md](../../docs/kma-fallback-request-plan.md). Highlights:
  - Implemented: from one clock read it builds two complete requests — `primary` (the PR #16
    availability-aware candidate) and `previous` (the one-step-back candidate) — sharing the same
    `product`/`nx`/`ny` and differing only in `baseDate`/`baseTime`. The selector is a
    `KmaForecastBaseTimeCandidatesSelector`; when omitted it defaults to the PR #16
    `selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay`, and the caller input type is the PR #9
    `KmaForecastRequestFactoryInput` alias. It does not change the PR #9 single request factory's
    schedule-only default.
  - Construction reads the clock and calls the selector **zero** times; each
    `createFallbackRequestPlan()` reads the clock **exactly once** (no argument, epoch forwarded
    verbatim) and calls the selector **exactly once**, so both requests come from one candidate pair.
    It does **not** call the PR #9 single request factory (calling it twice could read the clock twice
    and split the pair across an availability boundary).
  - Each request carries exactly `product`/`baseDate`/`baseTime`/`nx`/`ny` (explicit fields, never an
    `input` or candidate spread); the plan is fresh with distinct `primary`/`previous` objects per
    call, never mutates the input or the candidate result, and exposes no eligibility / candidate /
    reference-epoch / retry metadata. A clock error and a selector `RangeError` propagate **verbatim**
    (no partial plan, no broad `try/catch`, no logging).
  - **No PR #17 classifier invocation, no Provider / hourly-service call, and no fallback execution** —
    the factory itself only assembles the `{ primary, previous }` pair; the request plan is built
    *before* execution, whereas eligibility is decided *after* a primary service result exists, so a
    `previous` request being present does not mean it will be sent (that is the PR #19 fallback
    service's decision, not the factory's).
  - **Consumed in production by the fallback roots.** The **PR #20 grid fallback composition** assembles
    this factory (with the PR #16 candidate selector) into its production graph, and the **PR #21
    location fallback composition** reuses that same PR #20 root, so it consumes this factory
    indirectly. In those fallback roots an eligible primary lets the provider be called **at most
    twice** per run; the existing grid/location **single-request scheduled roots** still call it **at
    most once** per call. None of the four production roots is wired into `src/index.ts`, app startup,
    or the `/weather` route yet.
- **KMA hourly fallback orchestration service** — PR #19 adds `createKmaHourlyFallbackService`
  (`src/services/`), the application service that combines the PR #18 request-plan factory, the PR #7
  hourly service, and the PR #17 classifier into an at-most-two-attempt run. It is the first component
  that actually **executes** a `previous` request. See
  [docs/kma-hourly-fallback.md](../../docs/kma-hourly-fallback.md). Highlights:
  - One `fetchHourlyForecastWithFallback(input, options)` call builds the plan **once**, runs the
    plan's `primary` request through the hourly service **once**, and classifies that primary result
    **once**. On an ineligible primary it returns `{ fallbackAttempted: false, primary }` and never
    runs the previous request; on an eligible primary it runs the plan's `previous` request through the
    hourly service **once** and returns `{ fallbackAttempted: true, fallbackReason, primary, previous }`
    — a **maximum of two** service calls, no third attempt, and the `previous` result is **never
    re-classified** (the reason stays the primary's eligibility reason).
  - `input`, the plan's `primary`/`previous` requests, and both nested service results pass through
    **by reference** (no clone/spread/merge); the same `options`/`AbortSignal` reference is forwarded to
    both service calls (omitted → exactly `undefined`). It creates no `AbortController`, registers no
    listener, and never inspects `signal.aborted` — the provider keeps its existing abort ownership.
  - It defines **no** new result union and **no** new error type, wraps the collaborators in no broad
    `try/catch`, and logs nothing: a plan-factory / primary / classifier / previous collaborator error
    propagates **verbatim** as the returned Promise's rejection (same reference), never a partial
    result. `fallbackAttempted: true` means a previous **invocation** happened — not HTTP transport,
    network success, or previous-result success.
  - **Consumed by the PR #20 grid fallback composition** (a new parallel root — see below), but the two
    existing scheduled/location production facades are **unchanged** and still issue **at most one** KMA
    request per call. It performs **no** result merge, final source selection,
    `WeatherOverview`/`SourceMetadata` assembly, route, cache, or stale-data field, and adds **no** new
    dependency.
- **KMA grid hourly fallback production composition** — PR #20 adds
  `createKmaHourlyFallbackCompositionFromEnv` (`src/composition/`), a **third** callable production
  root that assembles the PR #16–#19 fallback graph beside (never replacing) the two existing
  single-request roots. See
  [docs/kma-hourly-fallback-composition.md](../../docs/kma-hourly-fallback-composition.md). Highlights:
  - Public API: `createKmaHourlyFallbackCompositionFromEnv(env?, dependencies?)` returns
    `{ ok: true, service }` (own keys exactly `ok`/`service`; `service` exposes only
    `fetchHourlyForecastWithFallback`) or, on a provider config failure,
    `{ ok: false, error }` with the provider's `KmaProviderConfigError` passed through **by reference**.
    `KmaHourlyFallbackCompositionDependencies` is a **direct alias** of
    `KmaScheduledHourlyCompositionDependencies` (`{ fetchImpl?, clock? }`) — no selector / classifier /
    timeout / retry / feature-flag option is added.
  - It assembles provider-from-env → PR #7 hourly service; the selected clock (injected `clock`, else
    `createKmaSystemClock`) + the **explicitly injected** PR #16
    `selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay` selector → the PR #18 request-plan
    factory; and the plan factory + hourly service + the **explicitly injected** PR #17
    `classifyKmaHourlyFallbackEligibility` classifier → the PR #19 `createKmaHourlyFallbackService`.
    Production defaults are native `fetch` (inside the provider factory) and the system clock; both are
    injectable for tests.
  - Construction reads the clock **zero** times and issues **zero** `fetch`es; the first clock read and
    first `fetch` happen only when the returned service runs. A run makes **at most one** provider call
    when the primary is ineligible and **at most two** (primary then a single previous) when the
    classifier reports the primary a no-data signal — clock read once per run, previous never
    re-classified, no third attempt.
  - The two existing single-request roots and their `{ ok, facade }` contracts are **unchanged**; the
    location → grid fallback root is added in PR #21 (below), and this root is not wired into
    `src/index.ts` or any route. It consumes only the `providers/kma`, `services`, and
    `@life-weather/weather-core` public surfaces (the PR #16 selector) and adds **no** new dependency.
- **KMA location hourly fallback facade + production composition** — PR #21 adds
  `createKmaLocationHourlyFallbackFacade` (`src/services/`), a thin adapter that puts the PR #12
  latitude/longitude → grid converter in front of the PR #19 fallback service, plus
  `createKmaLocationHourlyFallbackCompositionFromEnv` (`src/composition/`), a **fourth** callable
  production root that reuses the PR #20 grid fallback composition verbatim. See
  [docs/kma-location-hourly-fallback.md](../../docs/kma-location-hourly-fallback.md). Highlights:
  - `fetchHourlyForecastWithFallbackForLocation({ product, latitude, longitude }, options)` calls the
    converter **exactly once** with a fresh `{ latitude, longitude }` (never the caller input spread,
    never carrying `product`); on a supported location it calls the fallback service **exactly once**
    with a fresh `{ product, nx, ny }` and returns its Promise as the **same** reference (not marked
    `async`, no Promise layer, `options`/`signal` forwarded by reference).
  - A physically valid but off-grid coordinate becomes a value-free
    `{ ok: false, stage: 'LOCATION', error: { kind: 'UNSUPPORTED_LOCATION' } }` (fresh per call, no
    coordinate/grid/message, no fallback-service call); a converter throw (e.g. an out-of-range
    `RangeError`) propagates **verbatim and synchronously** and the fallback service is **not** called.
    The `KmaLocationHourlyFallbackResult` reuses the PR #13 `LOCATION` branch via `Extract` and the
    PR #19 execution trace unchanged — no `fallbackUsed`/`selected`/`final`/`grid` field is added.
  - **Location fallback production composition** — `createKmaLocationHourlyFallbackCompositionFromEnv`
    reuses `createKmaHourlyFallbackCompositionFromEnv` (config `CONFIG_ERROR` passed through by
    reference, no facade built), selects the production `convertKmaLatitudeLongitudeToGrid` from the
    `@life-weather/weather-core` public surface (no private deep import), and wires the location facade.
    Success exposes **only** `{ ok, facade }`; the PR #20 grid fallback root and both single-request
    roots are unchanged, no new dependency option is added, and no route is registered. A supported
    location makes **at most two** provider calls per invocation; an unsupported/invalid location makes
    **zero**. Construction reads the clock/network/converter **zero** times.
- **KMA hourly fallback result selector** — PR #22 adds `selectKmaHourlyFallbackResult`
  (`src/services/`), a **pure, synchronous** function that reads one PR #19
  `KmaHourlyFallbackServiceResult` execution trace and decides which hourly result — if any — a later
  `WeatherOverview`/`SourceMetadata` assembler may use as its data source. See
  [docs/kma-hourly-fallback-selection.md](../../docs/kma-hourly-fallback-selection.md). Highlights:
  - A result is **usable** only when it is a success (`ok: true`) with a **non-empty** `hourly`
    (`hourly.length > 0`); a success with an empty `hourly` and every error result (any
    `PROVIDER`-stage error incl. `KMA_UPSTREAM_ERROR '03'`, and every `NORMALIZATION`-stage error) are
    unusable. It reads only `ok`, `hourly.length`, and `fallbackAttempted` — never `resultCode`, a
    provider-error kind, or normalization issues, and it does **not** rank error kinds.
  - **Deterministic precedence:** a usable `primary` is always selected first
    (`source: 'PRIMARY'`, `fallbackUsed: false`), even when a structurally-valid trace also carries a
    usable `previous`; otherwise, only when the trace attempted fallback and its `previous` is usable,
    the previous result is selected (`source: 'PREVIOUS'`, `fallbackUsed: true`); otherwise there is no
    selection (`selected: false`, `source: null`, `result: null`, `fallbackUsed: false`).
  - It owns the `fallbackAttempted` vs `fallbackUsed` distinction: **`fallbackAttempted`** (on the
    PR #19 trace) means the previous service was *invoked*; **`fallbackUsed`** (computed here) means the
    previous result's usable data was actually *selected*. A previous HTTP 503 or empty success is
    `fallbackAttempted: true` but `fallbackUsed: false`.
  - Every branch has the **same** own keys (`execution`/`fallbackUsed`/`result`/`selected`/`source`),
    preserves the caller's exact `execution` reference and the selected result's exact reference (no
    clone/spread/mutation), and returns a **fresh** wrapper per call. It is synchronous (no `Promise`),
    logs nothing, holds no state, calls no Provider/network/clock/eligibility classifier, and handles
    **no** `LOCATION` branch (its input is a `KmaHourlyFallbackServiceResult`, not a
    `KmaLocationHourlyFallbackResult`).
  - It is **not** wired into any composition root, facade, `WeatherOverview`/`SourceMetadata`
    assembler, or route yet — this PR implements the **selection policy** only; its production
    consumer/assembler is a later PR. It adds **no** new dependency.
- **KMA hourly `WeatherOverview` assembler** — PR #23 adds `assembleKmaHourlyWeatherOverview`
  (`src/services/`), a **pure, synchronous** function that consumes a **precomputed PR #22 selection**
  and assembles the **hourly-only** partial `@life-weather/contracts` `WeatherOverview`. See
  [docs/kma-hourly-weather-overview.md](../../docs/kma-hourly-weather-overview.md). Highlights:
  - Public API: `assembleKmaHourlyWeatherOverview(input): WeatherOverview` with
    `KmaHourlyWeatherOverviewInput` (a `{ location, selection, source }` union correlated so a selected
    hourly source carries a `KmaHourlySourceMetadataInput` provenance context and a no-selection outcome
    carries `source: null`) and `KmaHourlySourceMetadataInput` (`Pick<SourceMetadata, 'sourceId' |
    'issuedAt' | 'fetchedAt' | 'retrievalMode'>`). No new factory/interface/class.
  - **Selected policy** — the selected result's `hourly` becomes the overview's `hourly`; `sources`
    carries exactly **one** KMA `HOURLY` `SourceMetadata`; `HOURLY` is **not** in `missingSections`
    (`CURRENT`/`DAILY`/`AIR_QUALITY_CURRENT`/`AIR_QUALITY_FORECAST`/`ALERTS` are). **No-selection
    policy** — `hourly` is `[]`, `sources` is `[]`, and `HOURLY` joins the missing set (all six
    sections missing); no source metadata is fabricated for a source that was not chosen.
  - **Provenance is caller-provided, never inferred** — `sourceId`/`issuedAt`/`fetchedAt`/
    `retrievalMode` come from the caller (an unknown issuance is passed as an explicit `issuedAt: null`);
    the assembler fixes only `provider: 'KMA'`, `sections: ['HOURLY']`, and `observedAt: null`, and reads
    **no** clock/base-time to reconstruct provenance. Every other section is a fixed placeholder
    (`current: null`, `daily: []`, `airQuality.current: null`, `airQuality.daily: []`, `alerts: []`), so
    the `WeatherOverview` `superRefine` invariant keeps placeholders and `missingSections` consistent.
  - **Selected-empty boundary guard.** The public selected type allows an empty `hourly` and the
    contracts list invariant is one-directional (it only rejects populated data in a section marked
    missing, never an empty `hourly` whose `HOURLY` is *not* marked missing), so the assembler owns that
    boundary: a **selected** result's `hourly` must pass an assembler-local nonempty schema, and a
    selected-empty input throws a **synchronous** Zod error before any overview/source is built. A
    **no-selection** empty `hourly` is normal (`HOURLY` is marked missing).
  - It returns `weatherOverview.parse(overview)`, so a malformed location/timestamp/`sourceId`, a
    selected-empty `hourly`, or an invariant breach throws a **synchronous** Zod error (no `safeParse`
    error union, no broad `try/catch`, no logging, no fallback/default timestamp). It allocates a fresh
    output per call
    (`hourly` is copied into a new array; parse produces fresh nested objects), mutates nothing, and
    preserves hourly value/order (no reference identity is contractual). It is **pure and synchronous**:
    no `Promise`, Provider, network, clock, environment, or `AbortSignal`; it runs the PR #22 selector
    for **nobody** (the caller does that first), handles **no** `LOCATION` branch, and builds no
    `current`/`daily`/air-quality/alerts data.
  - **Production wiring not implemented.** The assembler is wired into **no** composition root or route.
    The PR #24 application service (below) now narrows a location result's `LOCATION` branch, applies the
    selector, resolves the selected source's provenance via an **injected** resolver, and calls this
    assembler; the **production resolver** and **production composition** remain later PRs. It changes no
    existing runtime and adds **no** new dependency.
- **KMA location hourly `WeatherOverview` application service** — PR #24 adds
  `createKmaLocationHourlyOverviewService` (`src/services/`), the orchestration layer that connects the
  previous four hourly building blocks into a single call. See
  [docs/kma-location-hourly-overview.md](../../docs/kma-location-hourly-overview.md). Highlights:
  - Public API: `createKmaLocationHourlyOverviewService(locationFallbackFacade, sourceMetadataResolver,
    selectionPolicy?, overviewAssembler?): KmaLocationHourlyOverviewService` whose single method
    `fetchHourlyWeatherOverviewForLocation(input, options?): Promise<KmaLocationHourlyOverviewResult>`
    takes `KmaLocationHourlyOverviewInput` (`{ product, location: WeatherLocation }`) and
    `KmaLocationHourlyOverviewOptions` (alias of the PR #21 facade options). The resolver
    (`KmaSelectedHourlySourceMetadataResolver`, with `KmaSelectedHourlySourceMetadataResolverInput`) is a
    **required** dependency; `selectionPolicy`/`overviewAssembler` default to the real
    `selectKmaHourlyFallbackResult` / `assembleKmaHourlyWeatherOverview`. No new class.
  - **Pipeline** — `weatherLocation.parse(location)` **upfront** (an invalid location throws a
    synchronous `ZodError` and **no** collaborator runs) → PR #21 facade with the parsed
    `latitude`/`longitude` → a top-level `LOCATION` failure is returned **verbatim** → PR #22 selector on
    a supported trace → the injected resolver **exactly once** *only* on a selected trace → PR #23
    assembler → `{ ok: true, selection, overview }`.
  - **Result** — `LOCATION` is the exact facade result reference (no `overview`/`selection`/coordinates
    added). Every supported trace is `ok: true`; a **no-selection** trace is still a success whose "no
    usable hourly data" fact lives inside the result (`selection.selected: false`, `overview.hourly: []`,
    `HOURLY` in `missingSections`). A Provider/Normalization failure in the trace is **never** promoted to
    a new top-level error. Success own keys are exactly `ok`/`overview`/`selection`; the overview carries
    no application trace.
  - **Provenance boundary** — the service infers **no** provenance: it owns no clock/env/network, defines
    only the selected-source resolver *seam*, and never rebuilds a request plan or reconstructs a KMA base
    time (a plan built during the run and a resolver reading a clock afterwards can disagree at an
    availability-delay boundary). `issuedAt: null` is passed through.
  - **Errors** — the method is **not** `async`: an invalid location and a facade synchronous throw
    propagate synchronously (same reference); a facade rejection and a selector/resolver/assembler throw
    reject the returned Promise (same reference). No broad `try`/`catch`, wrapping, logging, or partial
    result. The PR #23 selected-empty guard still fires (synchronous `ZodError`) through the integrated
    service.
  - **Application service implemented; production resolver and production composition not.** It is wired
    into **no** composition root or route; the production metadata resolver and PR #24 production
    composition (and the `/weather` route) are later PRs. It changes no existing runtime and adds **no**
    new dependency.
- **Still not implemented.** The **production metadata resolver** and the **PR #24 production
  composition** that would assemble this application service into a callable root; `current`/`daily`/
  air-quality/alerts `WeatherOverview` sections and their `SourceMetadata`; a `fallbackUsed` API field;
  current weather, daily forecast (incl. `TMN`/`TMX`), feels-like computation; a common provider
  interface; **running any of the four production composition roots at API app startup**; the `/weather`
  route and its query validation; HTTP error/status mapping; API-availability retry beyond the single
  previous-issuance fallback; and cache are **not** here — those are later PRs. The PR #24 **application
  service** now connects the PR #21 facade, PR #22 selection policy, and PR #23 assembler, but no
  production resolver or production composition applies it yet. None of the four composition roots (grid
  scheduled, location scheduled, grid fallback, location fallback) is wired into `src/index.ts` and none
  is connected to a route (`/health` unchanged).

### Dependencies

- `zod` — runtime validation of the raw KMA response (same workspace version as
  `@life-weather/contracts`).
- `@life-weather/contracts` (workspace) — PR #6 adds this so the hourly normalizer can validate its
  output with the `hourlyForecast` schema. Direction is `apps/api → contracts`.
- `@life-weather/weather-core` (workspace) — shares `KmaForecastProduct` for slot identity and, from
  PR #6, the scalar/condition/amount parsers the normalizer calls; from PR #9, the request factory
  also consumes `selectLatestKmaForecastBaseTime` (the PR #8 selector). The dependency direction is
  `apps/api → weather-core`; `weather-core` never depends on `apps/api` or `contracts` at runtime.
- The HTTP provider, the PR #6 normalizer, the PR #7 application service, the PR #9 request factory,
  the PR #10 scheduled hourly facade, the PR #11 production composition, and the PR #13 location facade
  / location composition add **no new external dependency** — the provider uses Node 22 native `fetch`,
  `AbortController`, `ReadableStream`, and `TextDecoder`; the service only re-uses the provider and
  normalizer and a `HourlyForecast` type import from `@life-weather/contracts`; the request factory
  only re-uses the `weather-core` selector and a `KmaForecastRequest` type import from `providers/kma`;
  the scheduled facade only re-uses the request factory and hourly service type imports from the same
  `services` layer; the location facade only adds type-only imports of the `weather-core` converter
  types (`ConvertKmaLatitudeLongitudeToGridInput`, `KmaForecastGridCoordinate`, `KmaForecastProduct`)
  and its sibling scheduled-facade types; and the composition layer consumes the `providers/kma`,
  `services`, and `@life-weather/weather-core` public surfaces — the scheduled composition imports the
  PR #14 `selectLatestKmaForecastBaseTimeAfterAvailabilityDelay` (added as a production injection in
  PR #15), the PR #13 location composition imports `convertKmaLatitudeLongitudeToGrid`, and the PR #20
  grid fallback composition imports the PR #16 `selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay`
  and (type-only) the scheduled composition's dependency shape (its system clock uses Node's native
  `Date.now`). The PR #21 location fallback facade adds only **type-only** imports of its sibling
  location-scheduled and fallback-service types, and the PR #21 location fallback composition reuses the
  PR #20 grid fallback composition plus the public `convertKmaLatitudeLongitudeToGrid`. No new external
  dependency is added.
