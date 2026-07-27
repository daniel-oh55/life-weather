# Umbrella decision policy (PR #32)

`packages/lifestyle-engine/src/umbrella.ts` implements `assessUmbrellaNeed`, the first **pure,
synchronous** life-weather calculation. Given a normalized hourly forecast list and an explicit
evaluation instant, it deterministically decides whether the user needs an umbrella.

> **This is Life Weather's initial product heuristic, not an official 기상청 (KMA) 생활지수.** The
> thresholds below are chosen for a good first mobile experience, not derived from a published KMA
> index. Treat them as product policy that will evolve.

The engine reads no clock, makes no network call, reads no environment variable, and never mutates
its input. The "current" instant is always the `evaluatedAt` input.

## Purpose

Turn an already-normalized forecast into a single, explainable umbrella decision the mobile app can
render directly — a status, a machine-readable reason code, stable Korean user copy, the evidence
behind the decision, a data-quality grade, and the policy version — without leaking any raw provider
payload.

## Input source data

The input is the normalized `HourlyForecast[]` from `@life-weather/contracts`, the same shape the
KMA composition pipeline already produces. The engine consumes, per hourly step:

- `forecastAt` — the ISO 8601 instant of the step (timezone required).
- `condition` — normalized sky/precipitation condition.
- `precipitationProbabilityPercent`, `precipitationAmountMillimeters`, `snowfallAmountCentimeters` —
  each nullable; a confirmed no-precipitation value is `0`, an unavailable value is `null`.

The engine never fetches data. It ignores fields not listed above for umbrella purposes.

## Evaluation window

- Start: the normalized `evaluatedAt`.
- End: `evaluatedAt + assessmentWindowHours` (12h).
- The window is inclusive at both ends: a forecast exactly at `+12h` is considered; one past
  `evaluatedAt` or beyond `+12h` is ignored.
- The **immediate** sub-window is `[evaluatedAt, evaluatedAt + immediateWindowHours]` (1h), inclusive
  — a strong signal here means "carry one now".

## Policy constants

Exposed as the frozen `UMBRELLA_POLICY` object (`policyVersion: 1.0.0`):

| Constant | Value | Meaning |
| --- | --- | --- |
| `assessmentWindowHours` | `12` | How far ahead a forecast is considered. |
| `immediateWindowHours` | `1` | A strong signal within this lead time → carry now. |
| `highProbabilityThresholdPercent` | `60` | Probability at/above this is a strong signal. |
| `moderateProbabilityThresholdPercent` | `30` | Probability at/above this (below high) is moderate. |
| `minimumDryForecastCount` | `6` | Distinct usable instants needed for a confident "not needed". |
| `minimumDryCoverageHours` | `5` | The last usable instant must be at least this far out. |

## Precipitation signals

**Strong** signal if any of:

- `condition` is one of `RAIN`, `SNOW`, `SLEET`, `SHOWER`, `THUNDERSTORM`;
- `precipitationAmountMillimeters > 0`;
- `snowfallAmountCentimeters > 0`;
- `precipitationProbabilityPercent >= 60`.

**Moderate** signal if it is not strong but `precipitationProbabilityPercent >= 30`.

Boundaries are inclusive: `60` is strong, `30` is moderate, `29` is neither. A precipitation or
snowfall amount of exactly `0` is a confirmed dry reading, not a signal. `FOG`, `CLOUDY`, and
`PARTLY_CLOUDY` are not precipitation conditions.

## Status decision order

Evaluated in strict priority order:

1. Strong signal within the immediate 1h window → `REQUIRED_NOW` / `PRECIPITATION_IMMINENT`.
2. Strong signal later in the 12h window → `REQUIRED_LATER` / `PRECIPITATION_LATER`.
3. No strong signal, but a moderate signal in the window → `RECOMMENDED` / `PRECIPITATION_POSSIBLE`.
4. No signal **and** sufficient dry coverage → `NOT_NEEDED` / `LOW_PRECIPITATION_RISK`.
5. No signal and insufficient coverage → `INSUFFICIENT_DATA` / `INSUFFICIENT_FORECAST`.

A precipitation signal can yield an umbrella recommendation even when the forecast set is sparse.
The absence of a signal alone is **not** grounds for `NOT_NEEDED`.

## Usable forecasts and the dry-coverage rule

A forecast is **usable** if it carries at least one decision-relevant fact:

- a known `condition` (not `UNKNOWN`), or
- a non-null `precipitationProbabilityPercent`, or
- a non-null `precipitationAmountMillimeters`, or
- a non-null `snowfallAmountCentimeters`.

A confident "no umbrella" (`NOT_NEEDED`) requires **sufficient dry coverage**, meaning both:

- at least `minimumDryForecastCount` (6) distinct usable `forecastAt` instants, and
- the last usable `forecastAt` at least `minimumDryCoverageHours` (5) hours after `evaluatedAt`
  (inclusive).

If there is no signal and coverage is not met, the result is `INSUFFICIENT_DATA`.

## Data quality

- `SUFFICIENT` — dry coverage is met (whether or not a signal was found).
- `LIMITED` — a signal was found but dry coverage was not met (e.g. an umbrella recommendation from
  sparse data).
- `INSUFFICIENT` — the status is `INSUFFICIENT_DATA`.

## Duplicate, ordering, and bad-data handling

- The input array's order is not trusted; the engine works on an internal, time-sorted copy and
  never mutates the input array or its objects.
- Duplicate `forecastAt` instants are order-independent: the strongest signal at an instant is
  preserved, and probability/precipitation/snowfall evidence uses the per-instant maximum.
- `consideredForecastCount` counts **distinct valid `forecastAt` instants inside the window**;
  `usableForecastCount` counts the subset of those that are usable. An instant is usable if any
  duplicate at that instant is usable.
- An `evaluatedAt` that is not a timezone-qualified ISO 8601 datetime throws a fixed `RangeError`
  synchronously; the message never echoes the raw input.
- A runtime-invalid individual `forecastAt` is excluded from the evidence rather than crashing the
  function.

## Evidence

Computed only from valid, in-window forecasts:

| Field | Meaning |
| --- | --- |
| `windowStartAt` | Normalized `evaluatedAt` (canonical UTC ISO 8601). |
| `windowEndAt` | `evaluatedAt + 12h`. |
| `firstRiskAt` | Earliest moderate-or-strong signal instant, or `null` when there is no signal. |
| `peakPrecipitationProbabilityPercent` | Null-ignoring maximum, or `null` if none present. |
| `peakPrecipitationAmountMillimeters` | Null-ignoring maximum, or `null` if none present. |
| `peakSnowfallAmountCentimeters` | Null-ignoring maximum, or `null` if none present. |
| `consideredForecastCount` | Distinct valid in-window `forecastAt` instants. |
| `usableForecastCount` | Distinct usable in-window `forecastAt` instants. |

Timestamps are canonical UTC ISO 8601. The engine does not format local time — the mobile presenter
formats `firstRiskAt` for display later. The result contains no raw forecast array and no provider
internal details.

## Policy version

The current policy is `1.0.0`, returned as `UMBRELLA_POLICY.policyVersion` and on every decision as
`policyVersion`. **Any future change to how a decision is reached — thresholds, window sizes, signal
definitions, or coverage rules — must bump this version** so consumers can tell decisions apart.

## Change history

- **1.0.0** — first umbrella-need policy: 12h window, 1h immediate window, 60%/30% probability
  thresholds, positive precipitation/snowfall as strong signals, and the 6-instant / 5-hour dry
  coverage rule for a confident "not needed".
