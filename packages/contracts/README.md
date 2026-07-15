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
