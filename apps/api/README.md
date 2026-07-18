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
  - Implemented: the injected-clock request factory, selecting the scheduled `baseDate`/`baseTime`
    from the real PR #8 selector, and combining it with `product`/`nx`/`ny`.
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
    in `@life-weather/weather-core`, but `apps/api` does **not** call it yet: the factory input is
    still a caller-supplied `product`/`nx`/`ny`, and the latitude/longitude → grid adapter is a later PR.
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
- **Still not implemented.** `WeatherOverview` assembly, `SourceMetadata`, current weather, daily
  forecast (incl. `TMN`/`TMX`), feels-like computation, a common provider interface, **running the
  production composition root at API app startup**, the `/weather` route and its query validation,
  API-availability fallback/retry, and cache are **not** here — those are later PRs. The pure
  lat/long → grid converter itself now exists in `@life-weather/weather-core` (PR #12), but `apps/api`
  does not call it yet and the latitude/longitude adapter that would feed the scheduled facade is a
  later PR. The composition root itself is built but is **not** wired into `src/index.ts` and is
  connected to no route (`/health` unchanged).

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
  the PR #10 scheduled hourly facade, and the PR #11 production composition add **no new external
  dependency** — the provider uses Node 22 native `fetch`, `AbortController`, `ReadableStream`, and
  `TextDecoder`; the service only re-uses the provider and normalizer and a `HourlyForecast` type
  import from `@life-weather/contracts`; the request factory only re-uses the `weather-core` selector
  and a `KmaForecastRequest` type import from `providers/kma`; the facade only re-uses the request
  factory and hourly service type imports from the same `services` layer; and the composition layer
  only consumes the `providers/kma` and `services` public surfaces (its system clock uses Node's
  native `Date.now`).
