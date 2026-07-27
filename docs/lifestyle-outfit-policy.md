# Outfit recommendation policy (PR #33)

`packages/lifestyle-engine/src/outfit.ts` implements `assessOutfitRecommendation`, the second
**pure, synchronous** life-weather calculation. Given a normalized hourly forecast list and an
explicit evaluation instant, it deterministically recommends an outfit for the next 6 hours based on
the felt (effective) temperature.

> **This is Life Weather's initial product heuristic, not an official 기상청 (KMA) 생활지수.** The
> thresholds below are chosen for a good first mobile experience, not derived from a published KMA
> index. Treat them as product policy that will evolve.

The engine reads no clock, makes no network call, reads no environment variable, and never mutates
its input. The "current" instant is always the `evaluatedAt` input.

## Purpose

Turn an already-normalized forecast into a single, explainable outfit recommendation the mobile app
can render directly — a status, a machine-readable reason code, stable Korean user copy, a layering
hint, the evidence behind the decision, a data-quality grade, and the policy version — without
leaking any raw provider payload. The copy avoids any medical or illness-risk phrasing.

## Input source data

The input is the normalized `HourlyForecast[]` from `@life-weather/contracts`, the same shape the
KMA composition pipeline already produces. For outfit purposes the engine consumes, per hourly step:

- `forecastAt` — the ISO 8601 instant of the step (timezone required).
- `feelsLikeCelsius` — the upstream felt temperature; nullable.
- `temperatureCelsius` — the actual air temperature; the fallback when the felt value is absent.

The engine never fetches data. It ignores every other field (condition, precipitation, humidity,
wind, …) for outfit purposes — differences in those fields never change the result when the
effective temperatures are equal.

## Effective temperature priority

The judging temperature of each step uses a fixed priority:

1. `feelsLikeCelsius` when it is a finite number → source `FEELS_LIKE`.
2. otherwise `temperatureCelsius` when it is a finite number → source `AIR_TEMPERATURE`.
3. otherwise the step is **unusable** for temperature.

A `null` `feelsLikeCelsius` falls back to `temperatureCelsius`. `NaN`, `Infinity`, `-Infinity`, and
non-number runtime values are never used. **This PR does not compute a new feels-like value** — it
prefers the upstream `feelsLikeCelsius` and only falls back to the air temperature. Humidity, wind,
precipitation, UV, gender, age, and activity level are not inputs of this policy.

## Evaluation window

- Start: the normalized `evaluatedAt`.
- End: `evaluatedAt + assessmentWindowHours` (6h).
- The window is inclusive at both ends: a forecast exactly at `+6h` is considered; one before
  `evaluatedAt` or beyond `+6h` is ignored.

`Date.now()` is never called; the current instant is always `evaluatedAt`. `evaluatedAt` must be a
timezone-qualified ISO 8601 datetime — seconds precision or exactly 3-digit millisecond precision,
matching the contracts `isoDateTime` policy (a timezone is required; a minute-only datetime, an
impossible calendar date, or any malformed string is rejected). An invalid `evaluatedAt` throws a
fixed `RangeError` synchronously whose message never echoes the raw input. A runtime-invalid
individual `forecastAt` is excluded from the assessment and evidence rather than crashing the
function.

## Policy constants

Exposed as the frozen `OUTFIT_POLICY` object (`policyVersion: 1.0.0`):

| Constant | Value | Meaning |
| --- | --- | --- |
| `assessmentWindowHours` | `6` | How far ahead a forecast is considered. |
| `minimumForecastCount` | `3` | Distinct usable instants needed for `SUFFICIENT`. |
| `minimumCoverageHours` | `2` | The last usable instant must be at least this far out for `SUFFICIENT`. |
| `layeringTemperatureRangeThresholdCelsius` | `8` | A spread at/above this recommends layering. |
| `extremeColdMaximumCelsius` | `-10` | Inclusive upper bound of `EXTREME_COLD`. |
| `veryColdMaximumCelsius` | `0` | Inclusive upper bound of `VERY_COLD`. |
| `coldMaximumCelsius` | `8` | Inclusive upper bound of `COLD`. |
| `coolMaximumCelsius` | `14` | Inclusive upper bound of `COOL`. |
| `mildMaximumCelsius` | `20` | Inclusive upper bound of `MILD`. |
| `warmMaximumCelsius` | `24` | Inclusive upper bound of `WARM`. |
| `hotMaximumCelsius` | `28` | Inclusive upper bound of `HOT`; above this is `VERY_HOT`. |

## Duplicate, ordering, and conservative-minimum policy

- The input array's order is not trusted; the engine works on an internal aggregate keyed by
  absolute instant and never mutates the input array or its objects.
- Duplicate `forecastAt` instants — including the same absolute instant written with a different
  timezone offset — collapse to one instant. Input order does not change the result.
- Each instant's **representative temperature** is the *minimum* usable effective temperature at
  that instant (the more conservative, warmer-dressing choice). When two forecasts tie at that
  minimum and one is `FEELS_LIKE` while the other is `AIR_TEMPERATURE`, `FEELS_LIKE` wins the source.
- An instant with only unusable forecasts is *considered* but not *usable*.

## Reference temperature and outfit status

The **reference temperature** is the lowest representative temperature across the window's usable
instants — a conservative initial product policy that avoids under-dressing over the next 6 hours.
`referenceAt` is the earliest instant at which that lowest representative temperature occurs, as a
canonical UTC ISO timestamp. `referenceTemperatureSource` is the source (`FEELS_LIKE` /
`AIR_TEMPERATURE`) of that reference; on a same-instant value tie `FEELS_LIKE` is preferred.

The reference temperature maps to a status with **inclusive** upper bounds:

| Reference (°C) | Status | Reason code |
| --- | --- | --- |
| `≤ -10` | `EXTREME_COLD` | `EXTREME_COLD_CONDITIONS` |
| `-10 < t ≤ 0` | `VERY_COLD` | `VERY_COLD_CONDITIONS` |
| `0 < t ≤ 8` | `COLD` | `COLD_CONDITIONS` |
| `8 < t ≤ 14` | `COOL` | `COOL_CONDITIONS` |
| `14 < t ≤ 20` | `MILD` | `MILD_CONDITIONS` |
| `20 < t ≤ 24` | `WARM` | `WARM_CONDITIONS` |
| `24 < t ≤ 28` | `HOT` | `HOT_CONDITIONS` |
| `> 28` | `VERY_HOT` | `VERY_HOT_CONDITIONS` |

Each status carries fixed Korean `reason` / `recommendation` copy, kept in a single source of truth
so status and copy can never drift apart. Boundaries are pinned by tests.

## Layering

`temperatureRangeCelsius` is `maximumEffectiveTemperatureCelsius - minimumEffectiveTemperatureCelsius`
over the representative temperatures. When it is `>= layeringTemperatureRangeThresholdCelsius` (8,
inclusive), `layeringRecommended` is `true` and `additionalRecommendation` is
`시간대별 온도 차가 커서 벗고 입기 쉬운 겉옷을 준비하세요.`; otherwise `additionalRecommendation`
is `null`. When there is no usable forecast the range cannot be computed, so
`temperatureRangeCelsius` is `null`, `layeringRecommended` is `false`, and `additionalRecommendation`
is `null`.

## Data availability and data quality

- **`SUFFICIENT`** — at least `minimumForecastCount` (3) distinct usable instants **and** the last
  usable instant at least `minimumCoverageHours` (2) hours after `evaluatedAt` (inclusive).
- **`LIMITED`** — at least one usable instant, but the `SUFFICIENT` coverage is not met. A real
  recommendation is still returned.
- **`INSUFFICIENT`** — no usable instant at all; the status is `INSUFFICIENT_DATA` /
  `INSUFFICIENT_FORECAST`.

Coverage is a data-quality signal, **not** a precondition for producing an outfit status: a single
usable temperature is enough to return a recommendation (with `LIMITED` quality).

## Evidence

Computed only from valid, in-window forecasts:

| Field | Meaning |
| --- | --- |
| `windowStartAt` | Normalized `evaluatedAt` (canonical UTC ISO 8601). |
| `windowEndAt` | `evaluatedAt + 6h`. |
| `referenceAt` | Earliest instant of the lowest representative temperature, or `null`. |
| `referenceTemperatureCelsius` | The lowest representative temperature, or `null`. |
| `referenceTemperatureSource` | `FEELS_LIKE` / `AIR_TEMPERATURE` / `null`. |
| `minimumEffectiveTemperatureCelsius` | Minimum representative temperature, or `null`. |
| `maximumEffectiveTemperatureCelsius` | Maximum representative temperature, or `null`. |
| `temperatureRangeCelsius` | `max - min`, or `null`. |
| `consideredForecastCount` | Distinct valid in-window `forecastAt` instants. |
| `usableForecastCount` | Distinct usable in-window `forecastAt` instants. |

Numbers keep the input's precision — the engine does not round temperatures. Timestamps are
canonical UTC ISO 8601; the engine does not format local time — the mobile presenter formats them for
display later. The result contains no raw forecast array, no unused fields, and no provider internal
details.

## Policy version

The current policy is `1.0.0`, returned as `OUTFIT_POLICY.policyVersion` and on every decision as
`policyVersion`. **Any future change to how a decision is reached — bands, boundaries, the window,
the effective-temperature priority, the conservative-minimum rule, the layering threshold, or the
coverage rules — must bump this version** so consumers can tell decisions apart.

## Change history

- **1.0.0** — first outfit recommendation policy: 6h window, effective temperature preferring
  `feelsLikeCelsius` with an air-temperature fallback, per-instant conservative minimum, the eight
  temperature bands with inclusive upper bounds, the 8°C layering threshold, and the 3-instant /
  2-hour coverage rule for `SUFFICIENT` data quality.
