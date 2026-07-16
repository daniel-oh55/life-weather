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

All exports are re-exported from `src/index.ts`.

## Scope in this PR

This PR adds the `classifyFreshness` function only. It does **not** implement any KMA/
AirKorea code mapping or provider integration — those are deferred to later provider PRs.

In this PR `weather-core` has **no runtime dependencies** and does not depend on
`@life-weather/contracts`. A workspace dependency on `contracts` will only be added when a
consumer genuinely needs it.

## Principles

- Pure TypeScript, no runtime dependency on React Native, Node.js, or the browser.
- No side effects on import.
- No environment variable access.
- No network calls.
- Deterministic: no `Date.now()` / system clock, no global mutable state; the same input
  always yields the same result.
