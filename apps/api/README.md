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
- **No real HTTP calls yet.** This boundary performs no `fetch`, reads no `KMA_SERVICE_KEY`, and
  exposes no `/weather` route. The real HTTP provider (fetch, service key, timeout/retry, and
  wiring into `@life-weather/weather-core`) is deferred to PR #5.

### Dependencies

- `zod` — runtime validation of the raw KMA response (same workspace version as
  `@life-weather/contracts`).
- `@life-weather/weather-core` (workspace) — shares `KmaForecastProduct` for slot identity. The
  dependency direction is `apps/api → weather-core`; `weather-core` never depends on `apps/api`.
