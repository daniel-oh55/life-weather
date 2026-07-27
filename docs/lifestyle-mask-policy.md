# Mask recommendation policy (PR #34)

`packages/lifestyle-engine/src/mask.ts` implements `assessMaskNeed`, the third **pure, synchronous**
life-weather calculation. Given a normalized current air-quality observation and an explicit
evaluation instant, it deterministically decides whether a 보건용 마스크 (health mask) is needed for
the current particulate levels.

> **This is general lifestyle guidance for the public, not a medical diagnosis or a personalised
> health instruction.** The concentration → grade bands are the current **공식 AirKorea 실시간 등급
> 구간** used as reference data, but the grade → mask-status mapping is Life Weather's **initial
> product heuristic**, not an official 기상청 / AirKorea 행동요령. The engine never assesses symptoms,
> never targets sensitive groups, and never prescribes a specific KF mask grade.

The engine reads no clock, makes no network call, reads no environment variable, and never mutates
its input. The "current" instant is always the `evaluatedAt` input.

## Purpose

Turn an already-normalized air-quality observation into a single, explainable mask recommendation the
mobile app can render directly — a status, a machine-readable reason code, stable Korean user copy,
the pollutant that drove the decision, the per-pollutant evidence behind it, a data-quality grade,
and the policy version — without leaking any raw provider payload. The copy avoids any medical,
illness-risk, or symptom phrasing.

## Input source data

The input is `MaskAssessmentInput`:

- `evaluatedAt` — the ISO 8601 instant (timezone required) the assessment is anchored to.
- `airQuality` — the normalized `CurrentAirQuality` from `@life-weather/contracts`, or `null`.

Only five fields of the observation are consulted:

- `measuredAt` — the ISO 8601 instant the observation was measured (timezone required).
- `pm10MicrogramsPerCubicMeter` — PM10 mass concentration (㎍/㎥); nullable.
- `pm25MicrogramsPerCubicMeter` — PM2.5 mass concentration (㎍/㎥); nullable.
- `pm10Grade` — the provider's PM10 grade; a forward-compatible enum, nullable.
- `pm25Grade` — the provider's PM2.5 grade; a forward-compatible enum, nullable.

The engine never fetches data.

### Why only PM10 and PM2.5 — and why ozone, `overallGrade`, and the CAI are excluded

This policy covers **보건용 마스크 안내 for particulate matter only** — the pollutants a health mask
actually filters. Therefore:

- `ozonePartsPerMillion` / `ozoneGrade` are **not** used: a mask does not address ozone, and ozone
  guidance is a different behaviour (reduce outdoor activity), out of scope here.
- `overallGrade` is **not** used: it is a composite that can be driven worse by ozone or another
  pollutant, so using it would over-warn for masks. A particulate-mask decision must rest on
  particulate data only.
- `comprehensiveAirQualityIndex` (AirKorea CAI) is **not** used: a high composite index alone never
  produces a mask status.

None of these excluded fields is copied into the result.

## Concentration → grade bands (AirKorea reference)

The concentration-to-grade bands are the current AirKorea real-time grade bands. Upper bounds are
**inclusive** and pinned by tests.

| Grade | PM10 (㎍/㎥) | PM2.5 (㎍/㎥) |
| --- | --- | --- |
| `GOOD` | `≤ 30` | `≤ 15` |
| `MODERATE` | `30 < c ≤ 80` | `15 < c ≤ 35` |
| `BAD` | `80 < c ≤ 150` | `35 < c ≤ 75` |
| `VERY_BAD` | `> 150` | `> 75` |

The bounds are exposed as the frozen `MASK_POLICY` constants
(`pm10GoodMaximumMicrogramsPerCubicMeter`, …, `pm25BadMaximumMicrogramsPerCubicMeter`).

## Official reference vs Life Weather product policy

Two distinct layers, kept separate on purpose:

- **AirKorea official** — the concentration → grade bands above (`GOOD`/`MODERATE`/`BAD`/`VERY_BAD`).
- **Life Weather product heuristic** — how a grade becomes a mask status:
  - `VERY_BAD` → `REQUIRED`
  - `BAD` → `RECOMMENDED`
  - `GOOD` or `MODERATE` → `NOT_NEEDED`
  - a stale / invalid / future / missing measurement, or a fresh observation with no usable
    particulate grade → `INSUFFICIENT_DATA`
- **Not medical** — this is not a medical diagnosis and not a personalised health instruction.

## Concentration normalization

A concentration is *usable* only when it is `typeof === 'number'`, `Number.isFinite`, and `>= 0`. A
`null`, `undefined`, `NaN`, `±Infinity`, negative, or non-number runtime value is treated as `null`
(the pollutant simply has no concentration) — the engine never throws on a bad value. Usable
concentrations keep the input's precision; they are **never rounded**.

## Provider grade normalization

For evidence, a provider grade is normalized to a known `AirQualityGrade` when it is one, to
`UNKNOWN` for any other string (a raw unmapped provider string is **never echoed verbatim**), and to
`null` for a non-string / absent value. Only `GOOD`/`MODERATE`/`BAD`/`VERY_BAD` are *actionable*;
`UNKNOWN` never contributes to a decision, consistent with the contracts' forward-compatible enum
behaviour.

## Effective grade and provider/concentration conflict

Each pollutant's **effective grade** combines its usable provider grade and its
concentration-derived grade:

1. both usable → the **worse** (higher-severity) grade wins;
2. only the provider grade usable → the provider grade;
3. only the derived grade usable → the derived grade;
4. neither → no effective grade (`null`).

Severity order is `GOOD < MODERATE < BAD < VERY_BAD`. `gradeSource` records which inputs were used
(`PROVIDER_GRADE` / `CONCENTRATION` / `BOTH` / `null`), and `gradeDisagreement` is `true` only when a
usable provider grade and a derived grade both exist and differ. Taking the worse of the two is a
**conservative Life Weather policy**: when the provider grade and the concentration disagree, the
engine deliberately avoids under-warning.

## Measurement time and freshness

The current instant is always `evaluatedAt`; `Date.now()` is never called. Both `evaluatedAt` and
`measuredAt` must be timezone-qualified ISO 8601 datetimes — seconds precision or exactly 3-digit
millisecond precision — matching the contracts `isoDateTime` policy (a timezone is required; a
minute-only datetime, an impossible calendar date, or any malformed string is rejected).

- An **invalid `evaluatedAt`** throws a fixed `RangeError` synchronously whose message never echoes
  the raw input.
- A **missing** observation (`null`, or a runtime non-object such as a number, string, or array) →
  freshness `MISSING`, `INSUFFICIENT_DATA` / `INSUFFICIENT_PARTICULATE_DATA`, `INSUFFICIENT` quality.
- An **invalid `measuredAt`** (unparseable) → freshness `INVALID`, `INVALID_MEASUREMENT_TIME`; the
  function does not crash.
- A **future `measuredAt`** (later than `evaluatedAt`) → not trusted as a current reading; freshness
  `INVALID`, `INVALID_MEASUREMENT_TIME`, `observationAgeMinutes` `null`.

Observation age is `(evaluatedAt − measuredAt) / 60000` minutes and is **not rounded**. Freshness:

- `0 ≤ age ≤ 180` → `FRESH` (exactly 180 minutes is still `FRESH`).
- `age > 180` → `STALE` → `STALE_AIR_QUALITY`, `INSUFFICIENT_DATA`, `INSUFFICIENT` quality.

A `STALE` observation does **not** confirm a current recommendation even if its PM data is `BAD` or
`VERY_BAD`.

`maximumObservationAgeMinutes` is `180`, exposed on `MASK_POLICY`.

## Status, driver, and priority

Order of reasoning:

1. validate `evaluatedAt`, then the observation's presence and measurement time / freshness;
2. derive each pollutant's effective grade;
3. take the worse of the two effective grades as the overall grade;
4. map the overall grade to a status and compute the driver.

| Overall effective grade | Status | Reason code |
| --- | --- | --- |
| `VERY_BAD` | `REQUIRED` | `PARTICULATE_VERY_BAD` |
| `BAD` | `RECOMMENDED` | `PARTICULATE_BAD` |
| `GOOD` / `MODERATE` | `NOT_NEEDED` | `PARTICULATE_ACCEPTABLE` |
| fresh but no usable grade | `INSUFFICIENT_DATA` | `INSUFFICIENT_PARTICULATE_DATA` |

The **driver** is the pollutant behind the overall grade:

- `PM10` when PM10 alone holds the highest severity,
- `PM25` when PM2.5 alone does,
- `BOTH` when both are usable and tie at the highest severity,
- `null` when the observation is not fresh or no grade is available.

The `REQUIRED` / `RECOMMENDED` Korean copy names the driving pollutant (초미세먼지 = PM2.5, 미세먼지
= PM10, or both). `NOT_NEEDED` and the data-shortage reasons use fixed copy. Status, reason code,
`reason`, and `recommendation` are resolved from one place so they can never drift apart.

## Data quality

For a `FRESH` observation:

- **`SUFFICIENT`** — both PM10 and PM2.5 have an effective grade.
- **`LIMITED`** — exactly one does. A real `REQUIRED` / `RECOMMENDED` / `NOT_NEEDED` status is still
  returned from that single pollutant.
- **`INSUFFICIENT`** — neither does (the status is `INSUFFICIENT_DATA`).

Any non-fresh observation — `MISSING`, `INVALID`, future, or `STALE` — is `INSUFFICIENT` regardless
of the PM values it carries.

## Evidence

Derived only from the input:

| Field | Meaning |
| --- | --- |
| `measuredAt` | Canonical UTC ISO 8601 when the input time is parseable, else `null`. |
| `observationAgeMinutes` | Age in minutes for a valid, non-future `measuredAt` (unrounded); else `null`. |
| `freshness` | `FRESH` / `STALE` / `INVALID` / `MISSING`. |
| `driver` | `PM10` / `PM25` / `BOTH` when fresh and decidable, else `null`. |
| `availablePollutantCount` | Number of pollutants (0–2) with an effective grade, independent of freshness. |
| `pm10` / `pm25` | Per-pollutant evidence (below). |

Per-pollutant evidence: the sanitized `concentrationMicrogramsPerCubicMeter`, the normalized
`providerGrade`, the `derivedGrade`, the `effectiveGrade`, the `gradeSource`, and `gradeDisagreement`.

The result never copies the raw `CurrentAirQuality`, the ozone value or grade, `overallGrade`, the
composite index, any provider internal detail, any extra input property, or an unknown raw grade
string.

## Data-shortage handling

`INSUFFICIENT_DATA` is returned — with `INSUFFICIENT` data quality — whenever the reading cannot be
trusted as *current*: a missing/non-object observation, an invalid or future measurement time, a
stale observation, or a fresh observation with no usable particulate grade. The reason code
distinguishes the cause (`INVALID_MEASUREMENT_TIME`, `STALE_AIR_QUALITY`,
`INSUFFICIENT_PARTICULATE_DATA`). The function never crashes on malformed runtime input, and no raw
malformed value appears in the message or result.

## Policy version

The current policy is `1.0.0`, returned as `MASK_POLICY.policyVersion` and on every decision as
`policyVersion`. **Any future change to how a decision is reached — the bands, the boundaries, the
provider/concentration combination rule, the freshness window, the status mapping, the driver rule,
or the data-quality rules — must bump this version** so consumers can tell decisions apart.

## Change history

- **1.0.0** — first mask recommendation policy: PM10 / PM2.5 only (ozone, `overallGrade`, and the CAI
  excluded); the AirKorea concentration bands with inclusive upper bounds; a conservative
  worse-of-provider-and-concentration effective grade; a 180-minute freshness window with
  invalid/future/stale handling; the `VERY_BAD` → `REQUIRED`, `BAD` → `RECOMMENDED`,
  `GOOD`/`MODERATE` → `NOT_NEEDED` product mapping; the PM10 / PM25 / BOTH driver; and the
  two-pollutant `SUFFICIENT` / `LIMITED` / `INSUFFICIENT` data-quality rule.

## Official references

Reference data consulted for the concentration bands and the general behaviour guidance
(확인일 / verified 2026-07-27):

1. AirKorea — PM10 · PM2.5 실시간 등급 구간 (real-time grade bands). <https://airkorea.or.kr/web/>
2. AirKorea — 고농도 미세먼지 대응요령 (high-concentration particulate response guidance).
   <https://m.airkorea.or.kr/info/behavior>
3. AirKorea — 고농도 미세먼지 단계별 행동요령 상세.
   <https://m.airkorea.or.kr/info/behaviorInfo1>

The concentration → grade bands follow reference (1). The mask-status mapping is Life Weather product
policy and is **not** copied from any AirKorea 행동요령; references (2)–(3) are recorded as background
for the general (non-medical) framing only.
