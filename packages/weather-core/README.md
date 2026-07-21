# @life-weather/weather-core

Home for weather-domain logic: normalizing provider-specific weather codes (e.g. KMA) into
a common internal weather state, and other weather-domain calculations.

## What this package provides

- **Freshness** (`freshness.ts`): `classifyFreshness`, a pure, deterministic function that
  classifies an observation as `FRESH`, `STALE`, `FUTURE`, or `UNKNOWN` relative to a
  caller-supplied reference instant. Timestamps must be timezone-qualified ISO 8601
  datetimes (UTC `Z` or a numeric offset) at a **fixed precision**: seconds are required and
  fractional seconds are either absent or **exactly 3 digits** (milliseconds). Timezone-less,
  date-only, minute-precision (`2026-07-15T12:00Z`), wrong-fractional-precision
  (`...00.1Z`, `...00.0001Z`), non-ISO, and impossible calendar dates (e.g. `2026-02-30`,
  `2025-02-29`, `24:00:00`) are rejected — an invalid `referenceAt` throws `RangeError`, an
  invalid `observedAt` yields `UNKNOWN`. It validates each date/time component directly
  (month, day with the 4/100/400 leap-year rule, hour, minute, second, offset) so
  `Date.parse`'s silent roll-over cannot slip through. It never reads the system clock
  (`referenceAt` is an input), throws `RangeError` on invalid configuration, and does not
  mutate its input. The `FreshnessStatus` constant/type is defined locally.

  This timestamp precision policy intentionally matches `isoDateTime` in
  `@life-weather/contracts`. The freshness comparison is millisecond-resolution (via
  `Date.parse`), so accepting arbitrary precision would either reject seconds-less inputs the
  contract admits or silently truncate sub-millisecond digits; the two layers accept exactly
  the same shapes. Note this is a distinct concern from named-IANA-zone validation, which
  lives in the contracts package — freshness only deals with absolute instants carrying a
  numeric `Z`/`±HH:MM` offset.

- **KMA forecast normalization** (`kma/`): pure, deterministic primitives that turn Korea
  Meteorological Administration short-term (`단기예보`) and ultra-short-term (`초단기예보`) raw
  values into common values. See [docs/kma-normalization.md](../../docs/kma-normalization.md)
  for the full code tables and their official source.
  - `normalizeKmaWeatherCondition({ product, skyCode, precipitationTypeCode })` — maps a
    `SKY`/`PTY` code pair to a `WeatherCondition`. **PTY wins** over `SKY`; `SKY` is consulted
    **only** on the explicit "no precipitation" code (`0`); a missing or unknown `PTY` never
    falls back to `SKY`; anything unmapped (including a `PTY` code valid only for the other
    product, e.g. 빗방울/눈날림 `5`/`6`/`7` under 단기예보) is `UNKNOWN`. PTY `0`–`4`
    (없음·비·비/눈·눈·소나기) are shared by both products, so 소나기 `4` → `SHOWER` under both.
    The forecast `product` is a required input because the same number can differ across
    products.
  - `parseKmaPrecipitationAmountMillimeters(raw)` / `parseKmaSnowfallAmountCentimeters(raw)` —
    parse the categorical `PCP` (mm) / `SNO` (cm) forecast strings. An official "no amount"
    reading (`강수없음`/`적설없음`, the hyphen `-`, `0`/`0.0`) → `0`; an exact number → itself;
    `T 미만` → `T / 2`; `T 이상` → lower bound `T`; a range `L~U` → lower bound `L` (**`PCP`
    only** — `SNO` has no official range, so a `SNO` range string → `null`). An official Missing
    sentinel (any numeric component `>= 900`, mirroring `+900 이상`/`-900 이하`), a value in the
    wrong unit (cm in `PCP`, mm in `SNO`), a negative value, a JavaScript `null`/`undefined`
    argument, or an unparseable string → `null`. The result is always `null` or a finite number
    `>= 0` and `< 900`. A JavaScript `null`/`undefined` argument means "no value supplied by the
    caller" (→ `null`) and is deliberately **not** collapsed into the `0` of the official `-`
    token — see [docs/kma-normalization.md](../../docs/kma-normalization.md).

- **KMA forecast issue-time selection** (`kma/issue-time.ts`): `selectLatestKmaForecastBaseTime`,
  a pure, deterministic function that, given a `product` and a caller-supplied absolute
  `referenceEpochMilliseconds`, returns the latest **scheduled** KMA `{ baseDate, baseTime }`
  at or before that instant. KST is a fixed `UTC+09:00` (no DST), read via `Date`'s UTC getters
  on an offset-shifted instant — never host-local getters, `Intl`, or the system clock. The
  official schedules (단기예보 `0200/0500/…/2300`, 초단기예보 hourly `HH30`) come from the KMA
  guide; the selection is **inclusive** at each issue time, rolls to the previous KST day before
  the day's first issue time (month-end / year-end / leap-day exact), and rejects an invalid
  `referenceEpochMilliseconds` (NaN/±Infinity/fractional/unsafe integer, out-of-`Date`-range, or
  a KST year outside `1000`–`9999`) or an unsupported `product` with `RangeError`. It selects a
  **scheduled** issue time only and makes **no** claim about API availability (no publication lag,
  safety margin, retry, or fallback). See [docs/kma-issue-time.md](../../docs/kma-issue-time.md).

- **KMA forecast API-availability-delay issue-time selection**
  (`kma/api-availability-time.ts`): `selectLatestKmaForecastBaseTimeAfterAvailabilityDelay`, a pure,
  deterministic function that selects the latest issuance whose **documented API availability delay**
  has already elapsed at a caller-supplied absolute instant — i.e. the latest issuance for which
  `official issuance time + delay ≤ reference`. The delays come from the guide's `API 제공 시간`:
  단기예보 (`getVilageFcst`) a fixed **+10 minutes**, 초단기예보 (`getUltraSrtFcst`) a fixed
  **+15 minutes**; the threshold is **inclusive** (e.g. SHORT `05:10:00.000` KST → `0500`,
  `05:09:59.999` → `0200`). It **reuses** `selectLatestKmaForecastBaseTime` (called on the original
  instant to reuse its validation contract, then on `reference − delay` to reuse its schedule
  selection) — it re-implements **no** schedule, KST calendar, rollover, or year validation, and does
  not change the scheduled selector. Its input type is an **alias** of
  `SelectLatestKmaForecastBaseTimeInput` and it returns the same `KmaForecastBaseTime`. Same
  `RangeError` contract as the scheduled selector (invalid `referenceEpochMilliseconds`, an
  availability-adjusted `base_date` year outside `1000`–`9999`, or an unsupported `product`; value-free
  messages). It is a **schedule-based availability candidate** only — **no** safety margin, **no** live
  availability guarantee, **no** retry/fallback, **no** clock/environment/network. As of PR #15 it is
  **consumed by `apps/api`**: the production scheduled composition injects it into the request factory
  (the location composition inherits it), while a direct one-argument factory caller still uses the
  scheduled selector. See [docs/kma-api-availability-time.md](../../docs/kma-api-availability-time.md).

- **KMA primary/previous base-time candidates** (`kma/fallback-candidates.ts`):
  `selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay`, a pure, deterministic function that, from
  one caller-supplied absolute instant, returns `{ primary, previous }` — `primary` is exactly the PR #14
  availability-delay selection at the reference, and `previous` is the single official scheduled issuance
  immediately before it (the one candidate a later PR may fall back to once). It **composes** the PR #14
  selector twice: on the original reference for `primary`, then on the reference shifted back by exactly
  one product-specific issuance interval (SHORT 3 hours, ULTRA 1 hour) for `previous`. Because the current
  official schedule and the availability threshold are uniform per product, subtracting one interval lands
  `previous` on exactly the issuance before `primary` — so it re-implements **no** schedule array, KST
  calendar, rollover, availability threshold, or year validation. Its input type is an **alias** of the
  PR #14 input, the result carries exactly `primary`/`previous`, and each candidate reuses
  `KmaForecastBaseTime`. Same `RangeError` contract as the composed selector, propagated verbatim — if the
  `previous` candidate rolls below year `1000` the **whole** call throws (never a partial `primary`-only
  result); value-free messages. It builds **only** the candidates: **no** provider call, second request,
  retry, fallback execution, `resultCode`/`totalCount`/empty-`hourly`/normalization classification, or
  live-availability guarantee, and it is **not yet consumed by `apps/api`** (production behaviour is
  unchanged). See [docs/kma-fallback-candidates.md](../../docs/kma-fallback-candidates.md).

- **KMA latitude/longitude → forecast grid conversion** (`kma/grid.ts`):
  `convertKmaLatitudeLongitudeToGrid({ latitude, longitude })`, a pure, deterministic function
  that projects a coordinate to the KMA 동네예보 grid cell `{ nx, ny }` via the official DFS
  Lambert Conformal Conic transform (5 km grid; `nx` `1–149`, `ny` `1–253`). It returns `{ nx, ny }`
  for a supported location, `null` for a valid coordinate the grid does not support (outside the
  official latitude/longitude coverage box, or projecting off-grid — off-grid results are never
  clamped), and throws `RangeError` for a non-finite value or a latitude/longitude outside its
  physical range (`[-90, 90]` / `[-180, 180]`), with value-free messages that never echo the raw
  input. It makes **no** network call and reads **no** API key — the projection is a local
  computation using only `Math`, not the KMA coordinate-conversion service. See
  [docs/kma-grid-conversion.md](../../docs/kma-grid-conversion.md).

All exports are re-exported from `src/index.ts`.

Mapping source: KMA `기상청_단기예보 조회서비스` (공공데이터 ID `15084084`), 활용가이드 `2607`,
verified 2026-07-16. Details and the change log live in
[docs/kma-normalization.md](../../docs/kma-normalization.md).

## Current scope (PR #16)

As of PR #16 this package provides:

- `classifyFreshness` (freshness classifier) — implemented.
- KMA condition (`SKY`/`PTY`) and categorical amount (`PCP`/`SNO`) parsers — implemented.
- KMA general scalar parsers (`TMP`/`T1H`, `POP`/`REH`, `WSD`, `VEC`) — implemented.
- KMA scheduled issue-time selector (`selectLatestKmaForecastBaseTime`) — implemented.
- KMA grid converter (`convertKmaLatitudeLongitudeToGrid`) — implemented (PR #12).
- **PR #14 KMA API-availability-delay selector**
  (`selectLatestKmaForecastBaseTimeAfterAvailabilityDelay`) — implemented. It composes the scheduled
  selector with guide-derived **project-defined** thresholds (단기예보 +10m, 초단기예보 +15m), modelled
  from the official guide's approximate provision times; the exact inclusive thresholds are a
  deterministic **project policy, not an official fixed SLA** or a live-availability guarantee. It adds
  no new runtime dependency, and (as of PR #15) is consumed by the `apps/api` production scheduled
  composition.
- **PR #16 KMA primary/previous base-time candidates**
  (`selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay`) — implemented. From one absolute instant
  it returns `{ primary, previous }`: `primary` is the PR #14 availability-delay selection, and `previous`
  is the single scheduled issuance immediately before it. It reuses the PR #14 selector on two references
  (the original for `primary`, `reference − one issuance interval` for `previous`; SHORT 3h, ULTRA 1h),
  owning only the uniform per-product issuance interval and re-implementing no schedule/threshold/calendar
  logic. It adds **no new runtime dependency**, is **not yet wired into `apps/api`** (production still
  issues at most one KMA request per facade call), and performs **no retry or fallback execution**.

`weather-core` still has **no runtime dependencies** (no Zod, no runtime dependency on
`@life-weather/contracts`), makes **no network calls**, and reads **no KMA API key** — every
function only transforms values a caller supplies. Network, `ServiceKey`, the KMA HTTP Provider,
the hourly normalizer wiring, and the application service all live in `apps/api`;
`weather-core` neither imports nor calls them. The scheduled issue-time selector
(`selectLatestKmaForecastBaseTime`) **is** consumed in `apps/api` — the PR #9 request factory selects
`baseDate`/`baseTime` from it, the PR #10 scheduled facade sequences that factory with the hourly
service, and the PR #11 production composition root assembles the whole graph. The PR #12 grid
converter is consumed by the PR #13 location facade/composition (lat/long → `nx`/`ny` → the scheduled
pipeline), though neither composition root is wired into a route yet. The **PR #14
availability-delay selector** (`selectLatestKmaForecastBaseTimeAfterAvailabilityDelay`) is, as of
**PR #15**, consumed too — the production scheduled composition injects it into the request factory
(the location composition inherits it), while the request factory's **default** stays the scheduled
selector, so a direct one-argument caller is unchanged. The selector itself remains pure; the
production policy choice lives in the `apps/api` composition, and no route consumes it yet. The **PR #16
primary/previous candidate selector** (`selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay`)
is, by contrast, **not yet consumed anywhere** — it is a pure building block for a later orchestration
PR, and production still issues at most one KMA request per facade call.
Unknown/undefined `SKY`/`PTY` codes normalize to `UNKNOWN`, and unparseable/missing `PCP`/`SNO`
values to `null`.

Because a bare parser cannot tell "field present with an official null value" from "field
absent," the KMA raw-response schema and provider in `apps/api` preserve **field presence** and
decide the official null meaning there — distinguishing (1) field present + official null,
(2) field absent, (3) the string `-`, and (4) a numeric/string `0`. This parser does not turn a
JavaScript `null`/`undefined` argument into `0`.

`weather-core` has **no runtime dependencies** — in particular no Zod and no runtime
dependency on `@life-weather/contracts`. `contracts` is a **dev-only** dependency used solely
by a compile-time type test that proves `normalizeKmaWeatherCondition`'s return type is
assignable to the contract's `WeatherCondition`; the shipped modules import neither the
contract type nor its runtime, so consumers inherit no undeclared dependency (and `pnpm why
zod` shows Zod only along that dev-only `contracts` path, never as a runtime dependency).

## Principles

- Pure TypeScript, no runtime dependency on React Native, Node.js, or the browser.
- No side effects on import.
- No environment variable access.
- No network calls.
- Deterministic: no `Date.now()` / system clock, no global mutable state; the same input
  always yields the same result.
