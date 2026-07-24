# Injectable `POST /weather` route factory (PR #30)

`apps/api/src/routes/weather.ts` implements `createWeatherRoute`, the **HTTP boundary** that connects the
existing pieces at the `/weather` endpoint:

- the PR #28 provider-neutral `WeatherRequestV1` request contract,
- the PR #24 `KmaLocationHourlyOverviewService` (via a narrow injected execution port),
- the PR #29 `presentKmaLocationHourlyOverviewResponseV1` response presenter,
- and the existing `WeatherResponseV1` / `WeatherSuccessResponseV1` / `WeatherErrorResponseV1` envelopes.

It ships **only** the route factory and its HTTP-boundary policy. It is **not** mounted into
`apps/api/src/index.ts`, builds no production composition, reads no environment, and generates no clock or
`requestId` — the production adapters and the real startup mount are **PR #31**.

## What the factory is

`createWeatherRoute(dependencies)` returns a **mountable Hono sub-app** that registers exactly one handler,
`POST /`. A parent app mounts it at `/weather`:

```ts
const app = new Hono();
app.route('/weather', createWeatherRoute(dependencies));
```

so the public endpoint is `POST /weather`. The factory itself registers **only** `POST /` — no `GET /`,
no `GET /weather`, no wildcard, no health route, no global `notFound`, and no global `onError`. Two
factories built with different dependencies share no mutable module state.

The tests mount it the same way (`app.route('/weather', createWeatherRoute(fakeDeps))`) and drive it with
`app.request('/weather', …)`, so the route is fully exercised without touching `apps/api/src/index.ts`.

## Public API

```ts
export const WEATHER_REQUEST_MAX_BYTES = 16 * 1024; // 16384

export type WeatherRouteExecuteOverview = (
  input: KmaLocationHourlyOverviewInput,
  signal: AbortSignal,
) => Promise<KmaLocationHourlyOverviewResult>;

export type WeatherRouteDependencies = {
  readonly executeOverview: WeatherRouteExecuteOverview;
  readonly presentResponse: typeof presentKmaLocationHourlyOverviewResponseV1;
  readonly product: KmaLocationHourlyOverviewInput['product'];
  readonly createMeta: (request: Request) => WeatherResponsePresenterMetaV1;
};

export function createWeatherRoute(dependencies: WeatherRouteDependencies): Hono;
```

Every dependency is required and `readonly`; there is **no** default, global singleton, or hidden
fallback. The factory returns a `Hono` synchronously (never a `Promise`).

### The narrow execution port

The route depends on a minimal `WeatherRouteExecuteOverview` port — `(input, signal) => Promise<result>` —
rather than the whole `KmaLocationHourlyOverviewService` (whose method takes the `AbortSignal` inside an
`options` object). This keeps the route decoupled from how the service threads its signal. PR #31's startup
wiring supplies a production adapter that binds the real service to this port, e.g.:

```ts
const executeOverview: WeatherRouteExecuteOverview = (input, signal) =>
  service.fetchHourlyWeatherOverviewForLocation(input, { signal });
```

The port forbids `any` / broad `Function` / `unknown` duck typing: `input` is the real
`KmaLocationHourlyOverviewInput`, `signal` is an `AbortSignal`, and the result is the real
`KmaLocationHourlyOverviewResult`.

## Request pipeline

```text
POST /weather
  → Content-Type must be application/json            → else 415 UNSUPPORTED_MEDIA_TYPE
  → request body byte-size limit (16 KiB)            → else 413 PAYLOAD_TOO_LARGE
  → JSON parse                                       → malformed → 400 INVALID_REQUEST
  → WeatherRequestV1 strict validation               → invalid   → 400 INVALID_REQUEST
  → server-owned KMA product applied
  → executeOverview(input, c.req.raw.signal)          (raw AbortSignal forwarded by exact reference)
  → presentResponse(result, meta)                     (PR #29 presenter)
  → WeatherResponseV1 body + HTTP status              (200 / 422 / 500)
```

### Content-Type policy

Only `application/json` is accepted. The media type (everything before the first `;`) is **trimmed** and
compared **case-insensitively** against exactly `application/json`, so these are accepted:

- `application/json`
- `application/json; charset=utf-8`
- `application/json ; charset=utf-8` (whitespace before `;`)
- `APPLICATION/JSON`

and these are rejected with `415`:

- an absent or empty `Content-Type`
- `text/plain`, `multipart/form-data`, `application/x-www-form-urlencoded`
- `application/problem+json` and any other `application/*+json`

The Content-Type check runs **before** the body-size limit, so a large `text/plain` body is a `415`, not a
`413`. On a `415`, the JSON parser, the service, and the presenter are **not** called.

### Body-size policy

The maximum request body size is **16 KiB** — `WEATHER_REQUEST_MAX_BYTES = 16 * 1024 = 16384` bytes. The
limit is enforced on the **actual number of bytes read from the request stream** by a route-private reader
(`readRequestBodyWithinLimit`), **not** by Hono's `bodyLimit` middleware and **never** on a trusted
`Content-Length`:

- **`Content-Length` is only an early-rejection hint, never a trust boundary.** A `Content-Length` that is
  a plain decimal integer over the limit lets the route reject before reading a single byte. A missing,
  under-reported, non-decimal, or otherwise untrustworthy `Content-Length` is ignored for this purpose.
- **The real stream is always measured.** Even when a `Content-Length` is present and within the limit, the
  route reads `request.body` chunk by chunk and counts the actual bytes, stopping the instant the running
  count exceeds the limit. A **dishonest / under-reported `Content-Length` therefore cannot bypass** the
  byte limit — an oversized body is a `413` regardless of what the header claims.
- **Retained payload vs. process memory.** The accepted chunk payload the route retains sums to **at most
  16 KiB**, and an oversized *actual* body is always a `413`, so this policy bounds the request payload the
  route accepts. It does **not** guarantee that total process memory stays at exactly 16 KiB: combining the
  accepted chunks into one contiguous buffer may temporarily duplicate the allowed payload, and the memory
  of a chunk already produced by the upstream `ReadableStream` is outside the route's direct control.
- **JSON parsing happens after the limited read.** The accepted bytes are decoded as UTF-8 and
  `JSON.parse`d directly (the route does **not** call `c.req.json()`), so an oversized body never reaches
  the parser or the service.
- **The raw `Request` is never rebuilt.** The route consumes only the original `request.body` stream and
  never clones, wraps, or replaces `c.req.raw` — so the raw `AbortSignal` keeps its identity (Hono's
  `bodyLimit` rebuilds the request on its streaming path, which is one reason it is not used here).
- Exactly `16384` bytes is accepted (trailing JSON whitespace is valid); `16385` bytes or more is
  rejected.
- The limit is on **UTF-8 byte length**, not character count: a multi-byte body whose character count is
  under the limit but whose byte length exceeds it is rejected (a naive `text.length` check would wrongly
  pass it).

On a `413`, JSON parsing, schema validation, the service, and the presenter are **not** called. The error
body is a `PAYLOAD_TOO_LARGE` `WeatherErrorResponseV1`.

> Why not Hono's `bodyLimit`: for Hono `4.12.30`, when a `Content-Length` header is present (and there is no
> `Transfer-Encoding`), `bodyLimit` compares only the header value and skips measuring the body stream — so
> a client that forges a `Content-Length` under-reporting the real body can push an oversized body past the
> limit into JSON parsing and the service. This runtime keeps such a forged `Content-Length` verbatim (it is
> not recomputed), so the bypass is real; the route-private reader measures the actual stream to close it,
> and a regression test (`rejects an oversized actual body even when Content-Length underreports it`) pins
> the fix.

### JSON parsing and request validation

After the Content-Type and body-size checks pass, the body is parsed as JSON. Malformed JSON (`{`, an empty
body, a truncated object, trailing garbage) is a `400 INVALID_REQUEST`; the parser's raw message
(`SyntaxError`, line/column, the raw body) is never exposed.

The parsed value is then validated with the existing `weatherRequestV1` schema (never re-defined in
`apps/api`). A validation failure is a `400 INVALID_REQUEST`, and **Zod issues are never included** in the
response. The strict top-level object and strict nested location reject, among others:

`null`, a string/number/boolean, an array, an empty object, a missing `location`, an invalid
`latitude`/`longitude`/`timezone`/`countryCode`, **any** extra top-level key, and **any** extra nested
location key — including a client-provided `product`, `provider`, `nx`/`ny`, `serviceKey`, or
`baseDate`/`baseTime`.

### Server-owned product

The public `WeatherRequestV1` carries **no** `product`. The KMA product is a typed route dependency
(`dependencies.product`) and is the only product that reaches the service input:

```ts
const serviceInput = { product: dependencies.product, location: request.location };
```

The route never reads a `product` from the client body, headers, or query, hardcodes no product string,
and creates no default product. A client-supplied top-level `product` is an extra key → strict-schema
rejection → `400`, so a mobile client can neither select nor override the product. PR #31's startup wiring
provides the concrete server-side product.

### AbortSignal pass-through

The raw request `AbortSignal` (`c.req.raw.signal`) is forwarded to the execution port **by the exact same
reference** — the route creates no new `AbortController`, does not clone or wrap the signal, and adds no
timeout. The service is called only for a valid request. This PR defines no cancellation-specific HTTP
status; if the service throws (aborted or otherwise) it follows the internal-error policy below.

### Response `meta` (clock + `requestId`)

The route does not generate the current time, a UUID, or a `requestId`. The injected
`createMeta(request: Request)` returns a `WeatherResponsePresenterMetaV1` (`generatedAt` + `requestId`).
The route reads only those two fields (it never spreads `meta`), and `contractVersion` is always written by
the route/presenter as `CONTRACT_VERSION`. `createMeta` is called **exactly once per request** — once on
the single terminal path a request takes (415, 413, 400, 200, 422, or 500).

`createMeta` is trusted route infrastructure and must return a **valid** meta. A meta that fails
producer-side validation (an invalid `generatedAt`, an empty `requestId`) cannot produce a contract-shaped
body, so the producer validation throws and the request fails as a generic `500` — the route does not
fabricate a response from invalid meta, and adds no logging of its own. An extra runtime key on `meta`
(e.g. an attempt to set `contractVersion: 999`) is simply ignored, and the response `contractVersion` stays
`1`.

## HTTP status mapping

| Status | When |
| --- | --- |
| `200` | presenter success (`WeatherSuccessResponseV1`), **including a no-selection overview** |
| `400` | malformed JSON, or `WeatherRequestV1` validation failure (`INVALID_REQUEST`) |
| `413` | request body over 16 KiB (`PAYLOAD_TOO_LARGE`) |
| `415` | missing/empty `Content-Type` or not `application/json` (`UNSUPPORTED_MEDIA_TYPE`) |
| `422` | presenter `error.code === 'UNSUPPORTED_LOCATION'` |
| `500` | service throw, presenter throw, or an unexpected presenter error code (`INTERNAL_ERROR`) |

`401`, `403`, custom `404`/`405` envelopes, `408`, `409`, `429`, `499`, `502`, `503`, and `504` are **out
of scope** for this PR.

A **no-selection** result (the service returns a success whose `overview.hourly` is empty and `HOURLY` is
in `missingSections`) is a normal `200` success — "no usable hourly data" is a valid public overview, never
promoted to an error.

An **unsupported location** (the service returns the `LOCATION` / `UNSUPPORTED_LOCATION` failure, which the
presenter maps to a `WeatherErrorResponseV1` with code `UNSUPPORTED_LOCATION`) is a `422`; the presenter's
body is returned verbatim (no added keys), and no internal `stage`/`kind`/coordinate leaks.

An **unexpected presenter error code** — the presenter returns `ok: false` with any code other than
`UNSUPPORTED_LOCATION` — is never surfaced at an arbitrary status. The route converts it to a fixed
`INTERNAL_ERROR` `500` and does not expose the original code or message.

## Stable error bodies

Every request-layer failure is a `WeatherErrorResponseV1` built by a module-private helper that writes
`contractVersion = CONTRACT_VERSION`, reads `generatedAt`/`requestId` explicitly off `meta` (no spread),
assigns the error fields explicitly (no spread), and validates the whole body with the contracts producer
schema `weatherErrorResponseV1.parse`. The stable codes/messages are:

| Code | Message | `retryable` |
| --- | --- | --- |
| `INVALID_REQUEST` | `The request body is invalid.` | `false` |
| `UNSUPPORTED_MEDIA_TYPE` | `Content-Type must be application/json.` | `false` |
| `PAYLOAD_TOO_LARGE` | `The request body is too large.` | `false` |
| `UNSUPPORTED_LOCATION` | `The requested location is not supported.` (from the presenter) | `false` |
| `INTERNAL_ERROR` | `The weather request could not be completed.` | `false` |

`UNSUPPORTED_MEDIA_TYPE` and `PAYLOAD_TOO_LARGE` were added **additively** to `ApiErrorCode` in this PR;
adding known values is non-breaking, so `CONTRACT_VERSION` stays `1`, the `WeatherErrorResponseV1`/
`ApiErrorV1` shapes are unchanged, and every other unknown string still maps to `UNKNOWN` for older
consumers. See [contracts.md](./contracts.md).

## Internal-error boundary (no leaks)

Service execution, presenter invocation, and the expected response-status mapping run inside a `try/catch`.
Any throw collapses to a fixed `500 INTERNAL_ERROR`, and the response never contains:

- an `Error` message, name, stack, or cause,
- a `ZodError`'s issues,
- a provider `resultMsg`, a service key, or a URL/query,
- a service/presenter secret marker,
- the internal `selection`, execution trace, `fallbackUsed`, or issuance identity.

Request parsing and schema-validation failures are handled as `400` on their own paths — they are **not**
routed through the catch-all internal error. The route adds no `console`/logger. (`createMeta` throwing is
route infrastructure misuse and is not specially recovered.)

## Dependency injection and testability

The service port, presenter, server product, and `meta` provider are all injected. The route reads no
`process.env` and calls no `Date.now`, `new Date`, `randomUUID`, or `Math.random`; it adds no cache, CORS,
`Cache-Control`, `ETag`, `Retry-After`, `X-Request-ID`, logging, or global middleware. The response is
returned with `c.json`, so its `Content-Type` is `application/json`; `requestId` lives only in the response
body's `meta`. This makes the factory testable independently of startup — the tests inject typed fakes (no
`as any`) for the service, presenter, and `meta` provider.

## Not in this PR

- Mounting the route into `apps/api/src/index.ts` (startup wiring) — **PR #31**.
- The production service adapter binding `KmaLocationHourlyOverviewService` to `WeatherRouteExecuteOverview`.
- The real server-side product policy, the real clock, and the real `requestId` generator.
- Reading `KMA_SERVICE_KEY` / `process.env`, building any production composition.
- Cache, stale fallback, rate-limiting, auth, CORS, compression, response headers, telemetry, request
  duration, OpenAPI/Swagger, and the mobile client.

## Next PR

**PR #31 startup wiring** will provide the production service adapter, the real server-owned product
policy, the real clock and `requestId` generator, and mount `createWeatherRoute(...)` into
`apps/api/src/index.ts`, plus production integration tests.
