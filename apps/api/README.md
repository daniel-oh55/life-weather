# @life-weather/api

Hono API for Life Weather, structured for Vercel's zero-configuration Node.js function detection.

To develop locally (from the repository root):

```
pnpm install
pnpm dev:api
```

To type-check and test:

```
pnpm --filter @life-weather/api typecheck
pnpm --filter @life-weather/api test
```

This PR does not link this app to a real Vercel project. `vercel dev` will prompt to link/create
a project on first run; that step is intentionally deferred to a later PR.

## Current state

- `GET /health` returns a deterministic health payload (unchanged).
- **KMA raw-response boundary** — `src/providers/kma/` validates the raw 기상청 `getVilageFcst` /
  `getUltraSrtFcst` JSON at runtime with **Zod**, classifies it (success / upstream error /
  invalid response), and groups a validated page into per-time forecast slots with an explicit
  `ABSENT` / `NULL` / `VALUE` field-presence model. See
  [docs/kma-response-boundary.md](../../docs/kma-response-boundary.md). Boundary rules worth noting:
  - `dataType` must be exactly `"JSON"` (this boundary only validates already-parsed JSON); `"XML"`,
    `""`, `"json"`, or any other value is an invalid response.
  - `resultCode` must be exactly two digits (`/^\d{2}$/`). `"00"` is success; any other valid
    two-digit code (incl. unknown future ones like `99`) is an upstream error; a malformed code
    (`""`, `"0"`, `"000"`, `"AB"`, `" 03 "`) is an invalid response, never an upstream error.
  - An upstream error exposes **only** the two-digit `resultCode` — the untrusted raw `resultMsg`
    is dropped, so a secret-shaped token, CR/LF, or log-injection payload cannot leak.
  - Obvious pagination self-contradictions are rejected (`item > numOfRows`, `item > totalCount`,
    `totalCount === 0` with items present).
  - `category` is restricted to ASCII uppercase/digits (`/^[A-Z0-9]+$/`); unknown/future codes
    still pass as long as they match the pattern.
  - Evidence level: envelope/field **spec** is official, but the official examples are XML-centric,
    so the JSON serialization is modelled from the field-type spec; `fcstValue: null` and an empty
    success page are **defensive** allowances (no confirmed official sample) to be re-verified
    against an authenticated JSON response in PR #5.
- **KMA HTTP forecast provider** — PR #5 connects the boundary above to the real 공공데이터포털
  **HTTPS** endpoint. `createKmaForecastProvider` / `createKmaForecastProviderFromEnv` perform the
  `fetch` for `getVilageFcst` / `getUltraSrtFcst`, then run the PR #4 parser + slot grouping and
  correlate the response against the request. See
  [docs/kma-http-provider.md](../../docs/kma-http-provider.md). Highlights:
  - Server-only `KMA_SERVICE_KEY` (일반 인증키/Decoding). Read only when a factory is **called**
    (never at import); missing/empty/whitespace/leading-or-trailing-whitespace keys return a
    `CONFIG_ERROR` value (never a throw), and the key never appears in any error.
  - The key is placed via `URLSearchParams` and encoded **exactly once**; fixed `pageNo=1`,
    `numOfRows=1000`, `dataType=JSON` (a caller cannot override these).
  - Node-native `fetch` (`redirect: 'error'`), a default 10s timeout, caller-`AbortSignal` support,
    and a default 4 MiB response-body cap — all project defensive defaults, no new dependency,
    **no retry / no cache**.
  - Classifies errors as `TIMEOUT` / `ABORTED` / `NETWORK_ERROR` / `HTTP_ERROR(status)` /
    `RESPONSE_TOO_LARGE` / `EMPTY_RESPONSE` / `NON_JSON_RESPONSE` / `INVALID_JSON` /
    `GATEWAY_ERROR` / `KMA_UPSTREAM_ERROR` / `KMA_INVALID_RESPONSE` / `RESPONSE_MISMATCH` /
    `INCOMPLETE_PAGE` / `DUPLICATE_CATEGORY` — none carrying the key, URL, raw body, or exception.
- **Still not implemented.** The final weather-domain normalization (KMA categories → common
  `HourlyForecast` / contracts), `@life-weather/weather-core` normalizer wiring, a common provider
  interface, automatic base date/time selection, lat/long → grid conversion, retry, cache, and the
  `/weather` route are **not** here — those are PR #6 and later.

### Dependencies

- `zod` — runtime validation of the raw KMA response (same workspace version as
  `@life-weather/contracts`).
- `@life-weather/weather-core` (workspace) — shares `KmaForecastProduct` for slot identity. The
  dependency direction is `apps/api → weather-core`; `weather-core` never depends on `apps/api`.
- The HTTP provider adds **no new dependency** — it uses Node 22 native `fetch`, `AbortController`,
  `ReadableStream`, and `TextDecoder`.
