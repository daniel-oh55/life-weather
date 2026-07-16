# @life-weather/contracts

Shared, normalized weather data contracts for the boundary between the mobile app, the
API, providers, and the lifestyle-index engine. Contracts are defined as
[Zod](https://zod.dev) 4 runtime schemas; every TypeScript type is inferred from a schema
with `z.infer` — there are no hand-written parallel interfaces.

See [`docs/contracts.md`](../../docs/contracts.md) for the full contract design: version
policy, enum strategy, null vs. optional, `0` vs. `null`, the `WeatherOverview`
invariants, units, and provider-normalization principles.

## What this package provides

- **Common primitives** (`common.ts`): ISO datetime/date schemas, bounded numeric schemas,
  and `createForwardCompatibleEnum` plus every enum (each exposing a `strict` and a
  `compatible` schema).

### Absolute timestamp precision

`isoDateTime` is an ISO 8601 instant with a **required** timezone designator (`Z` or a
numeric `±HH:MM` offset) and a **fixed precision**: seconds are required, and fractional
seconds are either absent or **exactly 3 digits** (milliseconds). Arbitrary-precision
timestamps are not allowed.

| Accepted | Rejected |
| --- | --- |
| `2026-07-15T12:00:00Z` | `2026-07-15T12:00Z` (no seconds) |
| `2026-07-15T12:00:00.123Z` | `2026-07-15T12:00:00.1Z` (1 digit) |
| `2026-07-15T21:00:00+09:00` | `2026-07-15T12:00:00.12Z` (2 digits) |
| `2026-07-15T21:00:00.123+09:00` | `2026-07-15T12:00:00.0001Z` / `...1234Z` (4+ digits) |

Implemented as `z.union` of a seconds schema (`precision: 0`) and a milliseconds schema
(`precision: 3`). This keeps the contract aligned with the JavaScript runtime's time
representation and with `classifyFreshness` in `@life-weather/weather-core`, whose freshness
comparison is millisecond-resolution and rejects any other precision — so a timestamp that
passes the contract can never be silently dropped or truncated downstream. Producers should
emit the UTC `Z` form at seconds or milliseconds precision.

This absolute-timestamp precision policy is **separate** from the timezone policy: an
absolute instant carries a numeric `Z`/`±HH:MM` offset, whereas `WeatherLocation.timezone`
(`ianaTimeZone`) must be a **named** IANA zone (e.g. `Asia/Seoul`) — a fixed offset is not a
valid zone identifier there. They are different concepts.
- **Location** (`location.ts`): `weatherLocation`.
- **Weather** (`weather.ts`): `sourceMetadata`, `currentWeather`, `hourlyForecast`,
  `forecastPeriod`, `dailyForecast`, and the aggregate `weatherOverview` (with cross-field
  invariants enforced via `superRefine`).
- **Air quality** (`air-quality.ts`): `currentAirQuality`, `dailyAirQualityForecast`.
- **Alerts** (`alerts.ts`): `weatherAlert`.
- **API envelope** (`api.ts`): `CONTRACT_VERSION`, the minimal `apiEnvelopeHeader`,
  `apiMetaV1`, and the `weatherResponseV1` discriminated union.

All exports are re-exported from `src/index.ts`.

## Scope in this PR

This PR defines the shared, already-normalized contracts only. It does **not** implement
KMA/AirKorea API calls, provider interfaces, provider raw-response schemas, code mappings
(e.g. PCP/SNO parsing), API endpoints, or any mobile usage — those are later provider PRs.

## Principles

- Runtime validation with Zod 4; types inferred from schemas (no duplicate interfaces).
- No `Date` objects and no `z.coerce` in the contracts — timestamps are ISO strings.
- Object schemas strip unknown fields (Zod default); `strictObject` is not the default
  policy.
- API-producer `strict` enums fail on unknown values; network-response `compatible` enums
  map unknown strings to a fallback while still rejecting missing fields, `null`, numbers,
  and booleans.
- Pure: no side effects on import, no environment variable access, no network calls, and
  no React Native / Node.js / browser-only APIs.
