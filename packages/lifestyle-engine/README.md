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

## Principles

- Pure TypeScript, no runtime dependency on React Native, Node.js, Hono, or the browser.
- No side effects on import.
- No environment variable access.
- No network calls.
- Never reads the system clock — the current instant is always the `evaluatedAt` input.
- Never mutates its input.
