# Weather route production wiring (PR #31; combined current+hourly graph as of PR #81)

PR #31 connects the PR #30 mountable `POST /weather` route factory to the real production Hono app, so
`POST /weather` is now a **live production endpoint** alongside the unchanged `GET /health`. Before this PR
the route existed only as a factory exercised by tests; it was **not** mounted into `apps/api/src/index.ts`
and the only callable production endpoint was `GET /health`.

PR #31 added **production startup wiring only**. It did not change the PR #30 route runtime, the KMA
service/provider/presenter runtimes, the request/response contracts, or the mobile app; it added no new
dependency; and it implemented no cache, rate-limit, auth, CORS, logging, or telemetry.

**As of PR #81**, the production KMA graph this wiring builds changed from the PR #27 hourly-only root to
the PR #78 combined current+hourly root — see [Current production state (PR #81)](#current-production-state-pr-81)
below. The rest of this document (through "Vercel Hono deployment build configuration") is the historical
PR #31 record and is preserved as originally written; where it says "hourly-overview graph" or
"hourly-only", read that as the PR #81 update describes.

## The three pieces

| File | Responsibility |
| --- | --- |
| `apps/api/src/api-app.ts` | **App factory** `createApiApp({ weatherRoute })` — registers `GET /health` and mounts the injected `/weather` sub-app. Pure DI; no env/KMA/clock/network. |
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
  → createApiApp({ weatherRoute })                                     // api-app.ts
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

- `api-app.test.ts` drives `createApiApp` with a **fake** `/weather` sub-app — health regression, the exact
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

## Vercel Hono deployment build configuration

Several deployment blockers surfaced only in the Vercel Hono build (the repo-local
`pnpm --filter @life-weather/api typecheck` never reproduced them), and all were resolved without changing
any runtime behaviour. The first two are TypeScript build-configuration fixes:

1. **Zero-config entrypoint collision** — Vercel's Hono preset scans the package root and `src/` for an
   `app`/`index`/`server` basename and warned `Multiple entrypoints found` while silently picking the first,
   which let the pure DI factory shadow the real composition root. The factory was moved from `src/app.ts` to
   the non-recognized `src/api-app.ts`, leaving `src/index.ts` as the sole recognized entrypoint. Locked by
   `apps/api/src/deployment-entrypoint.test.ts`.
2. **Effective TypeScript compiler options resolving differently in the build** — the Vercel build reported
   two error groups the local typecheck did not:
   - **Web `Request`/`Response` types missing** — `Request.headers`/`body`/`signal` and
     `Response.headers`/`body`/`ok`/`status` were unresolved (no DOM lib), across `routes/weather.ts`,
     `services/kma-hourly-forecast.ts`, `services/kma-hourly-fallback-eligibility.ts`,
     `services/kma-location-hourly-overview.ts`, `providers/kma/provider.ts`, `providers/kma/read-response.ts`,
     and `providers/kma/request.ts`.
   - **`boolean` literal discriminated unions failing to narrow** — `result.error`/`issues`/`stage`, the
     selected `true`/`false` arm, and the success/failure union arm in the same files.

   These are not individual runtime bugs; they are the symptom of `apps/api`'s effective compiler options
   being resolved differently in the deployment sandbox than by the repo-local typecheck (the `extends` chain
   or a preset override not landing the same way). Rather than narrowing each source file, the
   deployment-critical options are **pinned directly** on `apps/api/tsconfig.json` so they hold regardless of
   how the build resolves `extends`:

   ```jsonc
   "target": "ES2022",
   "lib": ["ES2022", "DOM", "DOM.Iterable"],   // provides Web Request/Response types
   "module": "ESNext",
   "moduleResolution": "Bundler",
   "strict": true,
   "strictNullChecks": true,                    // enables boolean-literal union narrowing
   "types": ["node"],
   "rootDir": "./src"
   ```

   `noEmit`/`isolatedModules`/`skipLibCheck`/`esModuleInterop` continue to be inherited from
   `tsconfig.base.json` (the base is **not** duplicated). Locked by `apps/api/src/deployment-tsconfig.test.ts`,
   which parses the tsconfig as JSON and asserts each pinned value.

The default-export Hono app, the KMA runtime, the request/response contracts, and the f88bf27 result
narrowing are all unchanged by this configuration fix.

## Node ESM relative-specifier and shared-package resolution

The Vercel build then runs the **emitted ES modules** under Node's native ESM resolver, which is stricter
than the repo-local type-checker in two further ways that surfaced only in the deployment sandbox. Both were
resolved without changing any runtime behaviour:

3. **Extensionless relative imports fail under emitted Node ESM.** A TypeScript-source relative import
   written without a file extension type-checks fine but throws `ERR_MODULE_NOT_FOUND` once emitted and run
   as Node ESM. Every `apps/api` local relative specifier was made explicit — an `./name.js` file specifier
   or a `./dir/index.js` directory-barrel specifier — so the emitted module graph resolves natively. An AST
   regression test asserts that local relative specifiers stay extension-explicit, so this class of failure
   cannot silently return.
4. **Shared runtime packages must expose a compiled ESM entrypoint.** `@life-weather/contracts` and
   `@life-weather/weather-core` previously pointed their package entrypoints at raw TypeScript, which the
   Node ESM runtime cannot import. Each package now builds a NodeNext ESM `dist/index.js` plus a
   `dist/index.d.ts`, and its `main`/`types`/`exports` point at `dist`, so a consumer resolves and imports
   the compiled artifact rather than the source. Node-native resolve/import of the built entrypoints is
   verified.

## Bootstrap and stale-`dist` protection

5. **Clean-checkout bootstrap and build-first checks.** Because the shared packages now resolve to `dist`
   (which stays gitignored/untracked), a clean checkout or the deployment sandbox could otherwise run against
   a missing or stale `dist`. A root `postinstall` bootstraps the shared `dist` on a clean checkout; the
   Vercel build runs an explicit shared build → verify step; the standalone `typecheck`/`test` scripts are
   build-first; and `pnpm check` builds the shared `dist` **exactly once** before verify/lint/typecheck/test,
   so no run reuses a stale `dist`.

## Current deployment status

As of the current branch HEAD the deployment is green and behaviourally verified on Vercel's Node 22 runtime,
using an already-registered server-only `KMA_SERVICE_KEY` (never printed anywhere):

- **CI** — the GitHub Actions pipeline completes successfully (the full workspace test suite passes).
- **Vercel Preview READY** — the Node 22 Preview build (install → build → verify) reaches `READY`.
- **`GET /health` → 200** — the deterministic health payload is unchanged.
- **Invalid `POST /weather` → 400** — a malformed/invalid body is a leak-free `INVALID_REQUEST`.
- **Valid `POST /weather` → 200** — a valid body returns a `WeatherResponseV1` that parses against the
  contracts producer schema, carrying a live 기상청 hourly overview.
- **Secret/internal non-exposure** — no response or error surfaces the service key, `process.env`, the
  provider URL/query, the raw KMA payload, or the internal `selection`/execution trace.

## Current production state (PR #81)

**PR #81** changed exactly one thing about the wiring this document describes: which production KMA graph
`apps/api/src/composition/weather-route.ts` builds and which service method the adapter calls. Everything
else in this document (the route factory, the presenter, `index.ts`/`api-app.ts` runtime, the deployment
configuration sections above) is unchanged.

- **Combined root, not hourly-only.** `createProductionWeatherRouteDependencies` now builds the PR #78
  `createKmaLocationCurrentHourlyOverviewCompositionFromEnv` root (hourly **and** current-observation)
  instead of the PR #27 `createKmaLocationHourlyOverviewCompositionFromEnv` hourly-only root it built
  through PR #80.
- **Adapter method changed accordingly:**
  ```ts
  const executeOverview: WeatherRouteExecuteOverview = (input, signal) =>
    service.fetchCurrentHourlyWeatherOverviewForLocation(input, { signal });
  ```
  The PR #77 combined service's result/input/options types are deliberate aliases of the PR #24 hourly
  types (see `docs/kma-location-current-hourly-overview.md`), so this stays assignable to the route's
  existing `WeatherRouteExecuteOverview` port with **no cast**.
- **Presenter reused, unchanged.** The route still calls `presentKmaLocationHourlyOverviewResponseV1`,
  which reads only `result.overview` — since the combined result is exactly
  `KmaLocationHourlyOverviewResult`-compatible, no new presenter was needed.
- **Server-owned product unchanged.** `PRODUCTION_WEATHER_PRODUCT` (`SHORT_FORECAST`) still selects only
  the hourly forecast source; the current-observation branch has no client-selectable product and is not
  affected by it.
- **Current-failure degradation is inherited, not reimplemented here.** A resolved current
  `LOCATION`/`PROVIDER`/`NORMALIZATION` failure becomes `current: null` (and `CURRENT` in
  `missingSections`) through the existing PR #77 policy — the route composition does not inspect or
  duplicate it.
- **Provider-attempt ceiling raised.** A representative supported request now makes **at most 3** provider
  attempts (hourly's existing PR #19 fallback: at most 2, plus current: at most 1) — up from the
  hourly-only maximum of 2.
- **Public response shape.** `POST /weather` now returns `data.current` populated (or `null` on a
  degraded/unavailable current), and `data.sources` carries the current source first, then the hourly
  source (the PR #76 assembler's fixed ordering), when both are present.

See `docs/kma-location-current-hourly-overview-composition.md` for the combined root's own wiring and
`docs/kma-location-current-hourly-overview.md` for the PR #77 orchestration/degradation policy this route
now serves.

## Current deployment status

As of the current branch HEAD the deployment is green and behaviourally verified on Vercel's Node 22 runtime,
using an already-registered server-only `KMA_SERVICE_KEY` (never printed anywhere):

- **CI** — the GitHub Actions pipeline completes successfully (the full workspace test suite passes).
- **Vercel Preview READY** — the Node 22 Preview build (install → build → verify) reaches `READY`.
- **`GET /health` → 200** — the deterministic health payload is unchanged.
- **Invalid `POST /weather` → 400** — a malformed/invalid body is a leak-free `INVALID_REQUEST`.
- **Valid `POST /weather` → 200** — a valid body returns a `WeatherResponseV1` that parses against the
  contracts producer schema, carrying a live 기상청 hourly overview. (This status record predates PR #81's
  current-observation wiring; it has not been re-verified against a live 기상청 current-observation call.)
- **Secret/internal non-exposure** — no response or error surfaces the service key, `process.env`, the
  provider URL/query, the raw KMA payload, or the internal `selection`/execution trace.

## Not in this PR (later work)

- A **server-side response cache** / stale fallback — `retrievalMode` stays `LIVE`.
- The **mobile API client** and screen wiring.
- **Current-observation retry/previous-issuance fallback, cache, or stale-data policy** — still absent as
  of PR #81; a resolved current failure degrades to `current: null` rather than retrying.
- **Daily forecast, AirKorea air quality, and alerts** — still not implemented; `POST /weather` still
  reports them as missing in `missingSections`.
- Product selection by environment/request, additional products, rate-limiting, auth/authorization, CORS
  changes, logging/telemetry, retry/timeout policy changes, the lifestyle engine, and OpenAPI.
- A **production (non-Preview) deployment and a linked production domain** — the current verification is on
  the Vercel Node 22 Preview with a registered server-only `KMA_SERVICE_KEY`.
