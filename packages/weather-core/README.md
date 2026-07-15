# @life-weather/weather-core

Home for weather-domain logic: normalizing provider-specific weather codes (e.g. KMA) into
a common internal weather state, and other weather-domain calculations.

## What this package provides

- **Freshness** (`freshness.ts`): `classifyFreshness`, a pure, deterministic function that
  classifies an observation as `FRESH`, `STALE`, `FUTURE`, or `UNKNOWN` relative to a
  caller-supplied reference instant. It never reads the system clock (`referenceAt` is an
  input), throws `RangeError` on invalid configuration, and does not mutate its input. The
  `FreshnessStatus` constant/type is defined locally.

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
