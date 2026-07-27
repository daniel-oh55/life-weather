# Laundry drying-suitability policy (PR #35)

`packages/lifestyle-engine/src/laundry.ts` implements `assessLaundryDryingSuitability`, the fourth
**pure, synchronous** life-weather calculation. Given a normalized hourly forecast list and an
explicit evaluation instant, it deterministically decides how suitable it is to dry laundry
**outdoors** starting now.

> **This is Life Weather's initial product heuristic, not an official 기상청 (KMA) 빨래지수 /
> 생활기상지수.** Every threshold and the final status mapping below are chosen for a consistent first
> mobile experience — they are **not a clone of a published KMA index** and **not a KMA-endorsed
> behavioural standard**. Treat them as product policy that will evolve with user feedback and real
> operational data.

The engine reads no clock, makes no network call, reads no environment variable, and never mutates
its input. The "current" instant is always the `evaluatedAt` input.

## Purpose and scope

Turn an already-normalized forecast into a single, explainable outdoor-drying verdict the mobile app
can render directly — a status, a machine-readable reason code, stable Korean user copy, the driver
behind the decision, the evidence, a data-quality grade, and the policy version — without leaking any
raw provider payload.

### What "outdoor drying suitability" means

The engine answers exactly one question:

> *If I hang laundry outdoors **now**, will the next few hours be suitable for drying it outdoors?*

It deliberately does **not** decide:

- whether laundry can or should be washed,
- fabric-specific drying methods,
- indoor humidity, dryer usage, or electricity cost,
- an estimated drying-completion time,
- particulate-matter (미세먼지) / 황사 / 꽃가루 suitability for outdoor drying — that is a separate
  concern from the mask engine and is deferred to a future policy.

## Input source data

The input is the normalized `HourlyForecast[]` from `@life-weather/contracts`, the same shape the KMA
composition pipeline already produces. Per hourly step the engine consumes:

- `forecastAt` — the ISO 8601 instant of the step (timezone required).
- `condition` — normalized sky/precipitation condition.
- `precipitationProbabilityPercent`, `precipitationAmountMillimeters`, `snowfallAmountCentimeters` —
  each nullable.
- `humidityPercent`, `temperatureCelsius`, `windSpeedMetersPerSecond` — humidity and wind nullable.

The engine never fetches data and ignores fields not listed above (including `windDirectionDegrees`
and `feelsLikeCelsius`).

## Evaluation window

- Start: the normalized `evaluatedAt`.
- End: `evaluatedAt + evaluationWindowHours` (8h).
- The window is inclusive at both ends: a forecast exactly at `evaluatedAt` or exactly at `+8h` is
  considered; anything before `evaluatedAt` or beyond `+8h` is ignored.

## Same-instant duplicate handling

Input order is not trusted, and the same absolute instant may appear more than once — even under
different timezone spellings (e.g. `...14:00:00Z` and `...23:00:00+09:00`). Duplicates at one instant
collapse to a single **conservative** representative so a provider conflict never makes outdoor
drying look better than it is:

| Representative | Rule |
| --- | --- |
| `wetCondition` | `true` if **any** duplicate is a known precipitation condition. |
| `precipitationAssessable` | `true` if any duplicate has a known condition (wet or dry) or a usable probability / precipitation amount / snowfall. |
| probability / precipitation amount / snowfall | **maximum** of the usable values. |
| humidity | **maximum** of the usable values. |
| temperature | **minimum** of the usable values. |
| wind | **maximum** of the usable values. |

When no usable value exists for a field, its representative is `null`. The result is independent of
input order.

## Policy constants

Exposed as the frozen `LAUNDRY_POLICY` object (`policyVersion: 1.0.0`):

| Constant | Value | Meaning |
| --- | --- | --- |
| `evaluationWindowHours` | `8` | How far ahead a forecast is considered. |
| `minimumDryingForecastCount` | `4` | Distinct drying instants needed for a positive verdict. |
| `minimumDryingCoverageHours` | `4` | The last drying instant must be at least this far out. |
| `strongPrecipitationProbabilityPercent` | `60` | Probability at/above this is a strong signal. |
| `possiblePrecipitationProbabilityPercent` | `30` | Probability at/above this (below strong) is possible. |
| `strongWindMetersPerSecond` | `10` | Wind at/above this can blow laundry off the line. |
| `highHumidityPercent` | `85` | Humidity at/above this makes outdoor drying slow / unreliable. |
| `excellentMaximumHumidityPercent` | `55` | EXCELLENT requires humidity at/below this. |
| `goodMaximumHumidityPercent` | `70` | GOOD requires humidity at/below this. |
| `excellentMinimumTemperatureCelsius` | `18` | EXCELLENT requires temperature at/above this. |
| `goodMinimumTemperatureCelsius` | `10` | GOOD requires temperature at/above this. |

The object is `Object.freeze(... as const)`, so a consumer cannot mutate the shared thresholds at
runtime.

## Runtime value normalization

The engine tolerates inputs that bypassed the TypeScript types:

- A non-array `hourlyForecasts` is treated as empty.
- Array items that are `null`, arrays, numbers, strings, booleans, or plain objects with an invalid
  `forecastAt` are excluded. An invalid individual `forecastAt` never fails the whole call.
- `temperatureCelsius`: usable when `typeof === 'number'` and finite (**negatives allowed**).
- `humidityPercent` / `precipitationProbabilityPercent`: usable when a finite number in `[0, 100]`.
- `precipitationAmountMillimeters` / `snowfallAmountCentimeters` / `windSpeedMetersPerSecond`: usable
  when a finite number `>= 0`.
- Invalid numbers (`NaN`, `±Infinity`, out-of-range, negative where non-negative is required) become
  `null` for that field — never a throw. Numbers are never rounded.

**Conditions.** Only `RAIN`, `SNOW`, `SLEET`, `SHOWER`, `THUNDERSTORM` count as precipitation
signals. `CLEAR`, `PARTLY_CLOUDY`, `CLOUDY`, `FOG` are known non-precipitation conditions (a
confirmed "no rain" reading). `UNKNOWN`, any other string, and non-strings are not used for
condition-based precipitation judgement, and the original unknown string is never exposed in the
result.

## Adverse signals

Per representative instant:

- **Strong precipitation** if any of: `wetCondition === true`; `precipitationAmountMillimeters > 0`;
  `snowfallAmountCentimeters > 0`; `precipitationProbabilityPercent >= 60`.
- **Strong wind** if `windSpeedMetersPerSecond >= 10`.
- **Possible precipitation** if it is not strong precipitation but
  `precipitationProbabilityPercent >= 30`.
- **High humidity** if `humidityPercent >= 85`.

Boundaries are inclusive: `60` / `10` / `30` / `85` all trigger; `59.9999`, `9.9999`, `29.9999`,
`84.9999` do not. A precipitation or snowfall amount of exactly `0` is a confirmed dry reading, not a
signal. Strong wind and high humidity are independent factors.

## Drying forecast and coverage

An instant is a **drying forecast** (usable for a positive verdict) only when it has all three:

- a usable `temperatureCelsius`,
- a usable `humidityPercent`,
- `precipitationAssessable === true`.

- `dryingForecastCount` — the number of distinct drying-forecast instants in the window.
- `lastDryingForecastAt` — the latest drying-forecast instant (canonical UTC), or `null`.
- `dryingCoverageMet` — `true` when both `dryingForecastCount >= 4` and
  `lastDryingForecastAt >= evaluatedAt + 4h`. Exactly 4 instants and exactly `+4h` meet coverage.

A clear adverse signal (precipitation / wind / high humidity) can return a real status even when
coverage is not met. A positive FAIR/GOOD/EXCELLENT verdict is only returned when
`dryingCoverageMet === true`.

## Status decision order

Evaluated in strict priority order; the first match wins:

| # | Condition | Status | Reason code | Driver |
| --- | --- | --- | --- | --- |
| 1 | Any strong precipitation signal | `NOT_RECOMMENDED` | `PRECIPITATION_EXPECTED` | `PRECIPITATION` |
| 2 | Any strong-wind signal | `NOT_RECOMMENDED` | `STRONG_WIND` | `WIND` |
| 3 | Any possible-precipitation signal | `POOR` | `PRECIPITATION_POSSIBLE` | `PRECIPITATION` |
| 4 | Any high-humidity signal | `POOR` | `HIGH_HUMIDITY` | `HUMIDITY` |
| 5 | No adverse signal and coverage not met | `INSUFFICIENT_DATA` | `INSUFFICIENT_FORECAST` | `null` |
| 6 | Coverage met, `maxHumidity <= 55` and `minTemperature >= 18` | `EXCELLENT` | `EXCELLENT_DRYING_CONDITIONS` | `TEMPERATURE_HUMIDITY` |
| 7 | Coverage met, `maxHumidity <= 70` and `minTemperature >= 10` | `GOOD` | `FAVORABLE_DRYING_CONDITIONS` | `TEMPERATURE_HUMIDITY` |
| 8 | Coverage met, otherwise | `FAIR` | `MARGINAL_DRYING_CONDITIONS` | `TEMPERATURE_HUMIDITY` |

Boundary notes:

- humidity `55` with temperature `18` → `EXCELLENT`; humidity above `55` or temperature below `18` is
  not `EXCELLENT`.
- humidity `70` with temperature `10` → `GOOD`; humidity above `70` or temperature below `10` is not
  `GOOD`.
- humidity `>= 85` (`POOR`, step 4) is evaluated before the positive bands, so it always outranks
  `GOOD`/`FAIR`.

The positive-band comparisons use the evidence `maximumHumidityPercent` and
`minimumTemperatureCelsius` — the window-wide conservative extremes across distinct instants.

## `firstAdverseAt`

The earliest instant that first produced the **selected** adverse reason code:

- strong precipitation → earliest strong-precipitation instant;
- strong wind → earliest strong-wind instant;
- possible precipitation → earliest possible-precipitation instant;
- high humidity → earliest high-humidity instant.

For a positive status (`FAIR`/`GOOD`/`EXCELLENT`) or `INSUFFICIENT_DATA`, `firstAdverseAt` is `null`.

## Data quality

- `INSUFFICIENT` — the status is `INSUFFICIENT_DATA`.
- `SUFFICIENT` — a real status is returned **and** `dryingCoverageMet` is `true` (a positive verdict
  is therefore always `SUFFICIENT`).
- `LIMITED` — a real adverse status is returned but `dryingCoverageMet` is `false`.

So, for example:

- a single clear precipitation forecast → `NOT_RECOMMENDED` / `LIMITED`;
- sufficient forecasts with rain → `NOT_RECOMMENDED` / `SUFFICIENT`;
- a positive FAIR/GOOD/EXCELLENT verdict → always `SUFFICIENT`;
- no signal and insufficient coverage → `INSUFFICIENT_DATA` / `INSUFFICIENT`.

## Insufficient-data handling

An `evaluatedAt` that is not a timezone-qualified ISO 8601 datetime throws a fixed `RangeError`
synchronously; the message never echoes the raw input. Beyond that, the engine never throws for bad
forecast data — malformed items and invalid numeric fields are excluded, and when no adverse signal
exists and coverage is not met the result is `INSUFFICIENT_DATA`.

The `evaluatedAt` and every `forecastAt` follow the contracts `isoDateTime` policy: seconds allowed,
exactly 3-digit milliseconds allowed, timezone required; minute precision, timezone-less local
datetimes, other fractional precisions, and impossible calendar dates are rejected. All evidence
timestamps are returned as canonical UTC ISO 8601 with 3-digit milliseconds and a `Z` suffix.

## Evidence

Computed only from valid, in-window forecasts:

| Field | Meaning |
| --- | --- |
| `windowStartAt` | Normalized `evaluatedAt` (canonical UTC ISO 8601). |
| `windowEndAt` | `evaluatedAt + 8h`. |
| `firstAdverseAt` | Earliest instant of the selected adverse reason, or `null`. |
| `peakPrecipitationProbabilityPercent` | Null-ignoring maximum of representative values, or `null`. |
| `peakPrecipitationAmountMillimeters` | Null-ignoring maximum of representative values, or `null`. |
| `peakSnowfallAmountCentimeters` | Null-ignoring maximum of representative values, or `null`. |
| `maximumHumidityPercent` | Maximum representative humidity, or `null`. |
| `minimumTemperatureCelsius` | Minimum representative temperature, or `null`. |
| `maximumWindSpeedMetersPerSecond` | Maximum representative wind, or `null`. |
| `consideredForecastCount` | Distinct valid in-window `forecastAt` instants. |
| `dryingForecastCount` | Distinct instants with usable temperature, humidity, and precipitation assessability. |
| `lastDryingForecastAt` | Latest drying-forecast instant, or `null`. |
| `dryingCoverageMet` | The coverage-policy result. |

The result deliberately does **not** copy: the raw `HourlyForecast` objects, `windDirectionDegrees`,
provider/source metadata, any extra input property, unknown-condition strings, or raw payloads.

## User-facing copy

The Korean `reason` / `recommendation` for each reason code is stored in one place so `status` /
`reasonCode` / `reason` / `recommendation` never drift:

| Reason code | `reason` | `recommendation` |
| --- | --- | --- |
| `PRECIPITATION_EXPECTED` | 평가 시간대에 비나 눈이 예상됩니다. | 실외 건조는 미루고 실내 건조를 준비하세요. |
| `STRONG_WIND` | 평가 시간대에 바람이 강해 빨래가 날리거나 떨어질 수 있습니다. | 실외 건조는 피하고 실내에서 건조하세요. |
| `PRECIPITATION_POSSIBLE` | 평가 시간대에 비나 눈이 올 가능성이 있습니다. | 실외 건조는 권하지 않으며 최신 강수예보를 다시 확인하세요. |
| `HIGH_HUMIDITY` | 평가 시간대의 습도가 높아 빨래가 잘 마르기 어렵습니다. | 환기가 가능한 실내 건조나 건조기 사용을 고려하세요. |
| `MARGINAL_DRYING_CONDITIONS` | 빨래를 말릴 수 있지만 건조 속도가 빠르지는 않겠습니다. | 통풍이 잘되는 곳에 널고 충분한 건조 시간을 확보하세요. |
| `FAVORABLE_DRYING_CONDITIONS` | 기온과 습도가 실외 건조에 무난한 편입니다. | 지금부터 실외에 널어 건조해도 좋습니다. |
| `EXCELLENT_DRYING_CONDITIONS` | 기온이 충분하고 습도가 낮아 빨래가 잘 마르겠습니다. | 실외 건조에 좋은 시간대입니다. |
| `INSUFFICIENT_FORECAST` | 빨래 건조 가능 여부를 판단할 시간별 예보가 부족합니다. | 최신 시간별 날씨를 다시 확인하세요. |

The copy makes no guarantee about garment safety, a drying-completion time, or general safety.

## Policy version

The current policy is `1.0.0`, returned as `LAUNDRY_POLICY.policyVersion` and on every decision as
`policyVersion`. **Any future change to how a decision is reached — thresholds, window sizes, signal
definitions, coverage rules, or the status mapping — must bump this version** so consumers can tell
decisions apart.

## Change history

- **1.0.0** — first outdoor laundry drying-suitability policy: 8h evaluation window; conservative
  same-instant merge; strong-precipitation / strong-wind / possible-precipitation / high-humidity
  signals at the 60 / 10 / 30 / 85 boundaries; the 4-instant / 4-hour drying-coverage rule; the
  EXCELLENT (`<= 55%` / `>= 18℃`), GOOD (`<= 70%` / `>= 10℃`), and FAIR bands.
