# @life-weather/lifestyle-engine

Home for deterministic "life weather" calculations derived from normalized weather data — umbrella,
mask, outfit, laundry, car wash, exercise, and commute recommendations.

## Implemented

### Umbrella decision engine — `assessUmbrellaNeed`

The first real life-weather calculation. It takes a normalized `HourlyForecast[]` (from
`@life-weather/contracts`) and an explicit evaluation instant, and returns a deterministic
umbrella decision: a status, a machine-readable reason code, stable Korean user copy, the
evidence the decision rests on, a data-quality grade, and the policy version.

```ts
import { assessUmbrellaNeed } from '@life-weather/lifestyle-engine';

const decision = assessUmbrellaNeed({
  evaluatedAt: '2026-07-15T12:00:00+09:00',
  hourlyForecasts, // readonly HourlyForecast[]
});

decision.status; // 'REQUIRED_NOW' | 'REQUIRED_LATER' | 'RECOMMENDED' | 'NOT_NEEDED' | 'INSUFFICIENT_DATA'
```

**Input** — the normalized hourly forecast list already produced upstream. Each step carries a
`forecastAt` instant, a `condition`, and nullable `precipitationProbabilityPercent`,
`precipitationAmountMillimeters`, and `snowfallAmountCentimeters`. The engine never fetches this
data itself.

**Evaluation window** — `[evaluatedAt, evaluatedAt + 12h]`, inclusive at both ends. Past forecasts
and forecasts beyond 12 hours are ignored.

**Precipitation signals**

- *Strong*: a precipitation condition (`RAIN`, `SNOW`, `SLEET`, `SHOWER`, `THUNDERSTORM`), a
  positive precipitation amount, a positive snowfall amount, or a probability `>= 60%`.
- *Moderate*: not strong, but a probability `>= 30%`.

Boundaries are inclusive: `60` is strong, `30` is moderate, `29` is neither, and an amount or
snowfall of exactly `0` is not a signal.

**Status priority**

1. Strong signal within 1h → `REQUIRED_NOW` (`PRECIPITATION_IMMINENT`)
2. Strong signal later in the window → `REQUIRED_LATER` (`PRECIPITATION_LATER`)
3. Moderate signal in the window → `RECOMMENDED` (`PRECIPITATION_POSSIBLE`)
4. No signal **and** sufficient dry coverage → `NOT_NEEDED` (`LOW_PRECIPITATION_RISK`)
5. Otherwise → `INSUFFICIENT_DATA` (`INSUFFICIENT_FORECAST`)

A precipitation signal can produce an umbrella recommendation even from sparse data (with
`dataQuality: 'LIMITED'`). The absence of a signal is **not** enough for `NOT_NEEDED`: a confident
"no" needs a sufficiently broad dry forecast (at least 6 distinct usable `forecastAt` instants, the
last one at least 5 hours out).

**Data quality** — `SUFFICIENT` when dry coverage is met, `LIMITED` when a signal was found but
coverage was not met, `INSUFFICIENT` when the status is `INSUFFICIENT_DATA`.

**Evidence** — window bounds, the earliest risk instant (`firstRiskAt`, or `null`), the peak
probability / precipitation / snowfall (null-ignoring maxima), and the considered vs. usable
forecast counts. Counts are over **distinct `forecastAt` instants**; duplicates of the same instant
collapse to one, keeping the strongest signal and the per-instant maxima. Timestamps are canonical
UTC ISO 8601 — the mobile presenter is responsible for formatting `firstRiskAt` for display; this
engine never formats local time. No raw provider payload is exposed in the result.

The policy constants live in the frozen `UMBRELLA_POLICY` export. These thresholds are Life
Weather's **initial product heuristic, not an official 기상청 (KMA) 생활지수**. See
[`docs/lifestyle-umbrella-policy.md`](../../docs/lifestyle-umbrella-policy.md) for the full policy
and its change history. Any change to how a decision is reached must bump `policyVersion`.

### Outfit recommendation engine — `assessOutfitRecommendation`

The second life-weather calculation. It takes the same normalized `HourlyForecast[]` and an
explicit evaluation instant, analyses the **felt (effective) temperature** over the next 6 hours,
and returns a deterministic outfit recommendation: a status, a machine-readable reason code, stable
Korean user copy, a layering hint, the evidence the decision rests on, a data-quality grade, and the
policy version.

```ts
import { assessOutfitRecommendation } from '@life-weather/lifestyle-engine';

const decision = assessOutfitRecommendation({
  evaluatedAt: '2026-07-15T12:00:00+09:00',
  hourlyForecasts, // readonly HourlyForecast[]
});

decision.status; // 'EXTREME_COLD' | 'VERY_COLD' | 'COLD' | 'COOL' | 'MILD' | 'WARM' | 'HOT' | 'VERY_HOT' | 'INSUFFICIENT_DATA'
```

**Effective temperature** — for each step the engine prefers `feelsLikeCelsius` when it is a finite
number (`FEELS_LIKE`), otherwise it falls back to `temperatureCelsius` (`AIR_TEMPERATURE`); a step
with neither finite value is unusable. No new feels-like value is computed here — humidity, wind,
precipitation, UV, and personalization are not inputs of this policy.

**Evaluation window** — `[evaluatedAt, evaluatedAt + 6h]`, inclusive at both ends. Past forecasts
and forecasts beyond 6 hours are ignored.

**Reference temperature** — forecasts sharing one absolute instant collapse to a single
representative temperature (the *minimum* effective temperature at that instant; on a value tie
`FEELS_LIKE` wins the source). The **reference temperature** is the lowest representative temperature
across the window — a conservative choice that avoids under-dressing — reported at the earliest
instant it occurs. The reference decides the band:

| Reference (°C) | Status |
| --- | --- |
| `≤ -10` | `EXTREME_COLD` |
| `-10 < t ≤ 0` | `VERY_COLD` |
| `0 < t ≤ 8` | `COLD` |
| `8 < t ≤ 14` | `COOL` |
| `14 < t ≤ 20` | `MILD` |
| `20 < t ≤ 24` | `WARM` |
| `24 < t ≤ 28` | `HOT` |
| `> 28` | `VERY_HOT` |

Upper bounds are inclusive and pinned by tests.

**Layering** — `temperatureRangeCelsius` is `max - min` of the representative temperatures. When it
is `>= 8` (inclusive), `layeringRecommended` is `true` and `additionalRecommendation` carries the
Korean layering hint; otherwise the hint is `null`. With no usable forecast the range is `null`,
layering is `false`, and the hint is `null`.

**Data quality** — `SUFFICIENT` when there are at least 3 distinct usable instants and the last is at
least 2 hours out; `LIMITED` when there is at least one usable instant but coverage is not met (a
recommendation is still returned); `INSUFFICIENT` when no instant is usable (`INSUFFICIENT_DATA`).

**Evidence** — window bounds, the reference instant / temperature / source, the min/max effective
temperature and their range, and the considered vs. usable counts over distinct instants. Numbers
keep the input's precision (nothing is rounded); timestamps are canonical UTC ISO 8601. No raw
provider payload is exposed.

The policy constants live in the frozen `OUTFIT_POLICY` export. These thresholds are Life Weather's
**initial product heuristic, not an official 기상청 (KMA) 생활지수**. See
[`docs/lifestyle-outfit-policy.md`](../../docs/lifestyle-outfit-policy.md) for the full policy and
its change history. Any change to how a decision is reached must bump `policyVersion`.

## Principles

- Pure TypeScript, no runtime dependency on React Native, Node.js, Hono, or the browser.
- No side effects on import.
- No environment variable access.
- No network calls.
- Never reads the system clock — the current instant is always the `evaluatedAt` input.
- Never mutates its input.
