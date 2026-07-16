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

All exports are re-exported from `src/index.ts`.

Mapping source: KMA `기상청_단기예보 조회서비스` (공공데이터 ID `15084084`), 활용가이드 `2607`,
verified 2026-07-16. Details and the change log live in
[docs/kma-normalization.md](../../docs/kma-normalization.md).

## Scope in this PR

This PR adds the KMA forecast **normalization primitives** above (alongside the existing
`classifyFreshness`). It still makes **no network calls** and reads **no KMA API key** — it
only transforms raw values that a caller supplies. The actual KMA HTTP provider, `ServiceKey`
handling, and the raw-response runtime schema are deferred to PR #4. Unknown/undefined
`SKY`/`PTY` codes normalize to `UNKNOWN`, and unparseable/missing `PCP`/`SNO` values to `null`.

Because a bare parser cannot tell "field present with an official null value" from "field
absent," PR #4's raw-response schema and provider must preserve **field presence** and decide
the official null meaning there — distinguishing (1) field present + official null, (2) field
absent, (3) the string `-`, and (4) a numeric/string `0`. This parser does not turn a
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
