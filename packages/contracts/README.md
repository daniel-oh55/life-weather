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
  `apiMetaV1`, the `weatherResponseV1` discriminated union, and the provider-neutral
  `weatherRequestV1` request schema.

### `ApiErrorCode` — additive `UNSUPPORTED_LOCATION` (PR #29)

`apiErrorCode` gained the known value `UNSUPPORTED_LOCATION` (a physically valid coordinate the
server's forecast grid does not cover) **additively** in PR #29. Adding a known value is
non-breaking, so `CONTRACT_VERSION` stays `1`. Because `apiErrorV1.code` uses the `compatible`
enum, an unknown code is mapped to `UNKNOWN` — so a code must be a *known* value to survive
validation intact; every other unknown string still maps to `UNKNOWN` for older consumers, and the
pre-existing, distinct `LOCATION_NOT_FOUND` code is unchanged. See
[`docs/weather-response-presenter.md`](../../docs/weather-response-presenter.md) for the presenter
that emits this code.

All exports are re-exported from `src/index.ts`.

## Public schemas

| Schema | Inferred type | Purpose |
| --- | --- | --- |
| `weatherLocation` | `WeatherLocation` | A location the weather describes (app-issued opaque `id`). |
| `weatherOverview` | `WeatherOverview` | The aggregate normalized payload with cross-field invariants. |
| `weatherRequestV1` | `WeatherRequestV1` | The V1 `POST /weather` request body: `{ location }`, strict. |
| `weatherResponseV1` | `WeatherResponseV1` | The V1 response: a discriminated union on `ok`. |
| `apiEnvelopeHeader` | `ApiEnvelopeHeader` | Minimal header to read `meta.contractVersion` before a full parse. |

## Usage

The V1 request body is provider-neutral: it carries only a `WeatherLocation` and nothing
KMA-specific (no `product`, `nx`/`ny`, grid, base time, or service key — the server selects
the KMA product itself). Both the top-level object and the nested location are **strict**, so
an unknown key (a provider-native id or a local-only storage field such as `isCurrent`) is
rejected rather than stripped. There is no `contractVersion` in the request body.

```ts
import { weatherRequestV1 } from '@life-weather/contracts';

const request = weatherRequestV1.parse({
  location: {
    id: 'seoul-jongno',
    displayName: '서울 종로구',
    countryCode: 'KR',
    adminArea1: '서울특별시',
    adminArea2: '종로구',
    adminArea3: null, // required + nullable: send explicit `null`, never omit the field
    latitude: 37.5729,
    longitude: 126.9794,
    timezone: 'Asia/Seoul',
  },
});
```

The transport (`POST /weather` route, body-size limit, and HTTP status mapping) is a later
PR; this package ships only the shared schema, type, tests, and docs.

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
