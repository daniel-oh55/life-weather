# KMA location hourly overview response presenter (PR #29)

`apps/api/src/presenters/kma-location-hourly-overview-response.ts` implements
`presentKmaLocationHourlyOverviewResponseV1`, the **pure, synchronous** boundary that maps the PR #24
internal application result to the mobile-facing `WeatherResponseV1` body. It is the single place where an
internal orchestration result becomes a public response.

This PR ships **only** the response-body presenter. It registers no HTTP route, decides no HTTP status,
reads no clock, and generates no `requestId` — those belong to a later `/weather` route PR.

## Why a presenter — internal result vs. mobile response

The PR #24 `KmaLocationHourlyOverviewService` returns an **internal** shape on success:

```ts
{ ok: true, selection, overview }
```

`selection` is server-side orchestration detail — the PR #22 fallback selection, the PR #19 execution
trace, the primary/previous attempts, the preserved PR #25 issuance identity
(`primaryIssuance`/`previousIssuance`), `fallbackUsed`, and the reason a fallback ran. Serializing that
result directly would leak all of it to the mobile client. The presenter stops that at the boundary: it
reads **only** `result.overview` and never touches `result.selection`.

```text
PR #28 WeatherRequestV1
  → (future) POST /weather route
  → server-side KMA product selection
  → PR #27 production composition
  → KmaLocationHourlyOverviewService  →  KmaLocationHourlyOverviewResult (internal)
  → this presenter                    →  WeatherResponseV1 (mobile-safe)
  → mobile
```

## Public API

```ts
export type WeatherResponsePresenterMetaV1 = Pick<ApiMetaV1, 'generatedAt' | 'requestId'>;

export function presentKmaLocationHourlyOverviewResponseV1(
  result: KmaLocationHourlyOverviewResult,
  meta: WeatherResponsePresenterMetaV1,
): WeatherResponseV1;
```

It is a plain function — no class, no factory, no stored state. `WeatherResponsePresenterMetaV1` carries
**only** `generatedAt` and `requestId`; `contractVersion` is deliberately absent (see below).

## Success mapping

A `{ ok: true, selection, overview }` result becomes a `WeatherSuccessResponseV1`:

```ts
{
  ok: true,
  meta: { contractVersion: CONTRACT_VERSION, generatedAt: meta.generatedAt, requestId: meta.requestId },
  data: result.overview,
}
```

- `result.overview` is the **only** data source. `result.selection` is neither read nor used to decide
  anything.
- Neither `result` nor `meta` is spread; every field is copied explicitly into a fresh object.
- `contractVersion` always comes from `CONTRACT_VERSION` — never from the caller.

## No-selection is still a success

A no-selection result — `selection.selected === false`, `overview.hourly === []`,
`overview.sources === []`, and `HOURLY` in `overview.missingSections` — is a valid public overview, not an
error. The presenter maps it to a normal `WeatherSuccessResponseV1`; "no usable hourly data" is expressed
inside the overview (an empty `hourly` plus `HOURLY` in `missingSections`), exactly as the
`WeatherOverview` contract intends. It is **never** promoted to an API error response.

## LOCATION failure mapping

The internal `{ ok: false, stage: 'LOCATION', error: { kind: 'UNSUPPORTED_LOCATION' } }` failure — a
physically valid coordinate the KMA forecast grid does not cover — becomes a stable
`WeatherErrorResponseV1`:

```ts
{
  ok: false,
  meta: { contractVersion: CONTRACT_VERSION, generatedAt: meta.generatedAt, requestId: meta.requestId },
  error: {
    code: 'UNSUPPORTED_LOCATION',
    message: 'The requested location is not supported.',
    retryable: false,
  },
}
```

The error body is built from constants; the internal `stage`/`kind`, coordinates, grid, provider, request
plan, URL/query, and upstream `resultMsg` are **never** copied out of the failure. `retryable` is `false`
because a retry cannot make an off-grid location supported.

### `UNSUPPORTED_LOCATION` is an additive contract code

`UNSUPPORTED_LOCATION` did not previously exist in `ApiErrorCode`, so PR #29 adds it **additively** to the
known values in `packages/contracts/src/common.ts`. This is required: `apiErrorV1.code` uses the
`compatible` enum, which maps any *unknown* string to `UNKNOWN` — without the additive value, a producer
that wrote `code: 'UNSUPPORTED_LOCATION'` would have it silently downgraded to `UNKNOWN` at validation.
Adding a known value is non-breaking, so `CONTRACT_VERSION` stays `1`; every other unknown string still
maps to `UNKNOWN` for older consumers. `LOCATION_NOT_FOUND` (a location that could not be resolved at all)
is a distinct, pre-existing code and is left unchanged.

## `contractVersion` is owned by the presenter; `generatedAt`/`requestId` come from the caller

The presenter always writes `contractVersion: CONTRACT_VERSION`; a caller cannot set or override it. The
caller supplies only `generatedAt` and `requestId`, and the presenter reads exactly those two fields
explicitly. Any extra runtime key on the `meta` object — including an attempt to pass
`contractVersion` — is ignored (the presenter never spreads `meta`, and the response schema strips stray
keys anyway).

## Producer-side validation

The assembled body is validated with the existing contracts response schema
(`weatherSuccessResponseV1.parse` / `weatherErrorResponseV1.parse`) before it is returned. This is a
**producer-side** check that:

- validates `generatedAt` against the `isoDateTime` contract (timezone + seconds precision required),
- validates `requestId` (non-empty string or `null`),
- fixes `contractVersion` to the literal `1`,
- re-checks the `WeatherOverview` invariants (the `superRefine` cross-field checks) and strips any stray
  key from the overview,
- validates the error `code`/`message`/`retryable` structure.

A validation failure surfaces as a **synchronous** `ZodError`. The presenter never catches, wraps, or
converts it — an invalid `generatedAt`/`requestId`, or an internally-inconsistent overview, throws rather
than producing a malformed success response. No new response schema is defined in `apps/api`; the presenter
reuses the contracts schemas.

## Serialization security boundary — allowed public provenance vs. forbidden internal trace

A success response must never contain, at any depth, an internal key such as `selection`, `execution`,
`primary`/`previous`, `primaryIssuance`/`previousIssuance`, `fallbackUsed`, `selected`, `baseDate`/
`baseTime`, `nx`/`ny`, `grid`/`kmaGrid`, `serviceKey`/`KMA_SERVICE_KEY`, `url`, `query`, `raw`/`rawBody`,
`resultMsg`, `product`, `plan`/`requestPlan`, `environment`, `dependencies`, or `providerConfig`. The
presenter guarantees this by copying only `overview` and never reading `selection`.

The normal public `SourceMetadata` fields inside `overview.sources[]` — `sourceId`, `provider`,
`sections`, `issuedAt`, `observedAt`, `fetchedAt`, `retrievalMode` — are **allowed**: they are already
the normalized, public provenance defined by the `WeatherOverview` contract, distinct from the internal
trace. The tests inject unique secret markers (e.g. `PR29_INTERNAL_SELECTION_SECRET_MUST_NOT_LEAK`) onto
the internal `selection` and confirm they never appear in `JSON.stringify(response)`.

## Purity and determinism

The presenter reads no `process.env`, filesystem, network, `fetch`, clock (`Date.now`/`new Date`),
`randomUUID`, `Math.random`, cache, or module state; it logs nothing, mutates neither input, and returns a
value (never a `Promise`). The same `result` + `meta` yield a structurally identical response, and each
call returns a fresh wrapper object. (Zod's `parse` clones nested objects, so reference identity of the
nested `overview`/`meta` is not part of the public contract.)

## Compile-time exhaustiveness

`KmaLocationHourlyOverviewResult` currently has two arms (success and the `LOCATION` failure). Because a
single remaining arm never narrows to `never`, the classic `assertNever(result)` pattern cannot compile
here; instead the presenter uses a `satisfies` guard on the non-success arm. If a future arm is added to
the union without being handled, the guard stops compiling — forcing the new arm to be mapped explicitly
rather than silently mis-serialized. No field is read off the guarded value, so it introduces no leak.

## Out of scope (later PRs)

- The `POST /weather` Hono route, its request-body parsing, and `Content-Type`/body-size checks.
- HTTP **status** mapping (the presenter decides only the response *body*, not the status code).
- The `generatedAt` clock and `requestId` generator (the caller supplies both).
- Startup wiring into `apps/api/src/index.ts`.
- Cache/stale-data handling and the mobile client.
