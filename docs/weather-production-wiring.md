# Weather route production wiring (PR #31)

PR #31 connects the PR #30 mountable `POST /weather` route factory to the real production Hono app, so
`POST /weather` is now a **live production endpoint** alongside the unchanged `GET /health`. Before this PR
the route existed only as a factory exercised by tests; it was **not** mounted into `apps/api/src/index.ts`
and the only callable production endpoint was `GET /health`.

This PR adds **production startup wiring only**. It does not change the PR #30 route runtime, the KMA
service/provider/presenter runtimes, the request/response contracts, or the mobile app; it adds no new
dependency; and it implements no cache, rate-limit, auth, CORS, logging, or telemetry.

## The three pieces

| File | Responsibility |
| --- | --- |
| `apps/api/src/app.ts` | **App factory** `createApiApp({ weatherRoute })` — registers `GET /health` and mounts the injected `/weather` sub-app. Pure DI; no env/KMA/clock/network. |
| `apps/api/src/composition/weather-route.ts` | **Production route composition** `createProductionWeatherRouteDependencies(options)` — builds the KMA production graph, the service→route adapter, the server product, and the response `meta` provider. |
| `apps/api/src/index.ts` | **Composition root + entrypoint** — reads `KMA_SERVICE_KEY`, builds the dependencies, creates the route, mounts it via the app factory, and `export default`s the Hono app. |

## Startup composition flow

```text
process.env.KMA_SERVICE_KEY (server-only)
  → createProductionWeatherRouteDependencies({ serviceKey })          // composition/weather-route.ts
       → createKmaLocationHourlyOverviewCompositionFromEnv(...)        // PR #27 KMA production graph
       → executeOverview adapter: (input, signal) => service.fetch…(input, { signal })
       → product: PRODUCTION_WEATHER_PRODUCT (SHORT_FORECAST)
       → createMeta(request): { generatedAt: now().toISOString(), requestId: crypto.randomUUID() }
  → createWeatherRoute(dependencies)                                   // PR #30 mountable sub-app
  → createApiApp({ weatherRoute })                                     // app.ts
       → app.get('/health', …)
       → app.route('/weather', weatherRoute)
  → export default app                                                 // index.ts (Hono default export)
```

The app is a **default-export Hono app**, which is how the app already deploys to Vercel's zero-config
function detection. PR #31 adds **no** `hono/vercel` adapter, `@hono/node-server`, Vercel wrapper, server
bootstrap, or separate HTTP listener — the deployment contract is unchanged.

## Endpoints after PR #31

- `GET /health` — the deterministic `200` JSON `{ status: 'ok', service: 'life-weather-api' }`, byte-for-byte
  unchanged. The `/weather` mount is purely additive and cannot regress it.
- `POST /weather` — the PR #30 route, wired to the production KMA location hourly-overview graph. Its
  request pipeline (Content-Type / body-size / JSON / `WeatherRequestV1` validation / status mapping) is
  entirely PR #30's and is documented in [weather-route.md](./weather-route.md).

`app.route('/weather', weatherRoute)` maps the sub-app's own `POST /` to the public `POST /weather` — it is
mounted **exactly once**, never as `POST /weather/weather`, and the factory invents no hidden default
weather route.

## `KMA_SERVICE_KEY` — server-only, fail-fast, network-free startup

- **Server-only.** `KMA_SERVICE_KEY` is read from `process.env` in `index.ts` only. It is never exposed to
  the mobile bundle and never uses a public prefix.
- **Validation reused, not re-implemented.** The key is validated by the existing provider policy
  (`validateKmaProviderOptions`): empty, whitespace-only, and whitespace-padded keys are rejected; the key
  is never trimmed, decoded, or re-encoded here.
- **Fail-fast.** A missing/invalid key makes `createProductionWeatherRouteDependencies` **throw** at app
  build time (a fixed safe message, `KMA_SERVICE_KEY is required.`), so an incomplete `/weather` is never
  silently enabled. Because the module builds the app at import, the deployment fails to boot on a
  misconfigured key rather than serving a half-wired route.
- **No startup network.** Building the app validates config and wires collaborators only — it issues **no**
  external `fetch`, reads no clock, and generates no `requestId`. The KMA graph is lazy: the first upstream
  request happens only when a real `POST /weather` arrives.
- The key value, `process.env` contents, and the provider URL/query never appear in the thrown error or any
  response.

## Production service adapter

The route depends on a narrow `WeatherRouteExecuteOverview` port — `(input, signal) => Promise<result>` —
rather than the whole service. The production composition binds the real service to it:

```ts
const executeOverview: WeatherRouteExecuteOverview = (input, signal) =>
  service.fetchHourlyWeatherOverviewForLocation(input, { signal });
```

The adapter forwards the caller's `input` unchanged and the raw request `AbortSignal` **by the same
reference** inside `{ signal }`. It creates **no** new `AbortController`, adds **no** timeout, transforms
**no** result, catches/re-wraps **no** error, and never puts the service key on the adapter input or the
response. (The KMA provider has its own internal timeout/abort controller — that is pre-existing and
untouched; the adapter itself adds none.)

## Server-owned forecast product policy

The production product is fixed to **`SHORT_FORECAST` (단기예보)**, owned in one place as the
`PRODUCTION_WEATHER_PRODUCT` constant imported from the `@life-weather/weather-core` `KmaForecastProduct`
value (never re-typed as a bare string):

```ts
export const PRODUCTION_WEATHER_PRODUCT = KmaForecastProduct.SHORT_FORECAST;
```

- **Why `SHORT_FORECAST`.** `/weather` serves the current and later hourly overview, and 단기예보 is the
  initial production source. This is the first explicit production product decision — no prior doc had
  fixed one — and it is recorded here.
- **Server-decided, not client-controlled.** The product is **not** selected by an environment variable,
  the request body/query/headers, or a route-internal re-decision. The public `WeatherRequestV1` carries no
  `product`, and its strict schema rejects a client-supplied `product` with `400`, so a mobile client can
  neither select nor override it.

## Response `meta` (server clock + server `requestId`)

The production `createMeta(request)` produces a fresh `meta` per request:

```ts
const createMeta = (_request: Request) => ({
  generatedAt: now().toISOString(),               // default now = () => new Date()
  requestId: createRequestId(),                   // default = () => globalThis.crypto.randomUUID()
});
```

- **`generatedAt`** is the current UTC instant via `Date.prototype.toISOString()` — the `Z` millisecond
  form the contracts `isoDateTime` schema accepts (never a timezone offset).
- **`requestId`** is **server-generated** with `globalThis.crypto.randomUUID()`. It is never read from an
  inbound `x-request-id` / `x-vercel-id` header or a request-body value, and there is **no** `Math.random`
  fallback and no new Node-only UUID dependency.
- `createMeta` is called **once per request** (the clock and UUID factory are read per request, never at
  module load). The route owns `contractVersion` (always `CONTRACT_VERSION`); the `meta` provider owns only
  `generatedAt`/`requestId`.
- `now` and `createRequestId` are injectable **only** so tests can make the response `meta` deterministic;
  production omits them and gets the real clock and UUID generator.

## Responsibility split: route factory vs production composition

- The **PR #30 route factory** (`createWeatherRoute`) owns the HTTP boundary policy (Content-Type,
  body-size, JSON parse, strict validation, status mapping, leak-free error bodies). It is unchanged.
- The **PR #31 production composition** owns the concrete production dependencies (the KMA graph, the
  service adapter, the server product, the `meta` provider) and the `KMA_SERVICE_KEY` fail-fast. It reaches
  into no route internals.

## External-detail non-exposure

No response or error surfaces the `KMA_SERVICE_KEY`, `process.env`, the provider URL/query, the KMA raw
upstream body/`resultMsg`, the service composition object, a stack/cause, the generated UUID's source, the
inbound headers, or the internal `selection`/execution trace. The presenter (PR #29) already strips the
`selection`/trace to `overview`-only; the route (PR #30) collapses internal errors to a fixed
`INTERNAL_ERROR` `500`.

## Testing (no external network)

- `app.test.ts` drives `createApiApp` with a **fake** `/weather` sub-app — health regression, the exact
  `/weather` mount, factory isolation, and the absence of any new global `onError`/`notFound`.
- `composition/weather-route.test.ts` builds the **real** production composition with an **injected
  in-memory `fetch`** and a fixed KMA clock — the product policy, the service adapter (input + exact
  `AbortSignal` + verbatim result), the `meta` provider (server clock/`requestId`, inbound headers
  ignored), the `KMA_SERVICE_KEY` fail-fast, construction side effects, the full app integration
  (`POST /weather` success / 400 / 413 / 415 / 422 / pre-aborted signal, `GET /health`), and the
  secret-leak boundary.
- `index.test.ts` exercises the real entrypoint via `vi.resetModules()` + a controlled `process.env` +
  dynamic import — the default-export Hono app, `/health`, the `/weather` mount (via a pre-network `400`),
  the missing-key fail-fast, and no fetch at startup — restoring the environment and module cache each
  test.

No test calls the real 기상청 / 공공데이터포털 / 에어코리아 / Vercel / any external URL: every KMA response
is served by an injected in-memory `fetch` over the existing fixtures.

## Not in this PR (later work)

- A **server-side response cache** / stale fallback — `retrievalMode` stays `LIVE`.
- The **mobile API client** and screen wiring.
- Product selection by environment/request, additional products, rate-limiting, auth/authorization, CORS
  changes, logging/telemetry, retry/timeout policy changes, AirKorea, alerts, the lifestyle engine, and
  OpenAPI.
- The real deployment: registering the production `KMA_SERVICE_KEY` in Vercel and running post-deploy
  `/health` and controlled `/weather` smoke tests.
