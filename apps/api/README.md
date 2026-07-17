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
    success page are **defensive** allowances (no confirmed official sample). These — together with
    the concrete shape of the newly-provided 초단기예보 `POP` in a real response — remain to be
    confirmed by a **follow-up live integration check using a real service key**; no already-merged
    PR performed that authenticated-JSON verification.
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
  - The **timeout and caller-abort lifecycle spans the whole transport** — the `fetch`, the
    HTTP-status decision, *and* the full response-body read — so a stalled or aborted body after a
    header has arrived still resolves promptly (`TIMEOUT` / `ABORTED`), never hanging. A body-stream
    failure resolves to `NETWORK_ERROR` (or `TIMEOUT` / `ABORTED` if an abort caused it), never a
    rejected promise, and the raw stream/cancel/lock-release error is never surfaced. A
    `Content-Length` that already exceeds the cap cancels the body without reading a byte.
  - Once a body reader is acquired, `releaseLock()` is **attempted** on every exit path — normal
    completion, overflow, a read error, or a cancel error — because a `cancel()` or a drained stream
    does not release the lock on its own; on standard Node Web Streams the lock is released. If
    `releaseLock()` itself throws, the failure is swallowed (the decided result is preserved and no
    raw error leaks), but the lock release itself is not guaranteed in that case.
  - Both runtime validators (`validateKmaForecastRequest`, `validateKmaProviderOptions`) are
    **total** on non-object input: a `null`/string/array/function/etc. yields `INVALID_REQUEST` /
    `CONFIG_ERROR` instead of throwing. `INVALID_REQUEST` issues for a non-object request are built
    **fresh per call** (a new array of new objects), so mutating one returned result cannot corrupt
    a later call — there is no shared mutable state between calls. (`isRecord` here is a non-null,
    non-array object check, not a strict plain-object check; hostile-prototype/`Proxy` hardening is
    a later follow-up.)
  - Classifies errors as `TIMEOUT` / `ABORTED` / `NETWORK_ERROR` / `HTTP_ERROR(status)` /
    `RESPONSE_TOO_LARGE` / `EMPTY_RESPONSE` / `NON_JSON_RESPONSE` / `INVALID_JSON` /
    `GATEWAY_ERROR` / `KMA_UPSTREAM_ERROR` / `KMA_INVALID_RESPONSE` / `RESPONSE_MISMATCH` /
    `INCOMPLETE_PAGE` / `DUPLICATE_CATEGORY` — none carrying the key, URL, raw body, or exception.
- **KMA hourly forecast normalization** — PR #6 adds `normalizeKmaHourlyForecast`, a **pure adapter**
  that turns a provider success's slots into the common `@life-weather/contracts` `HourlyForecast[]`.
  See [docs/kma-hourly-normalization.md](../../docs/kma-hourly-normalization.md). Highlights:
  - Per-product category selection: 단기예보 `TMP`/`PCP`/`SNO`, 초단기예보 `T1H`/`RN1` (no 신적설).
    `SKY`+`PTY`→condition, `POP`/`REH`→%, `WSD`/`VEC`→wind — via `@life-weather/weather-core` parsers.
    `RN1` reuses the `PCP` parser (the guide shares one 강수량 범주 for both). 초단기예보 POP는
    2026-06-23 12 KST 이후 공식 제공되므로, POP가 존재하면 다른 상품과 동일하게 정규화하고,
    이전/부분 응답 등에서 ABSENT 또는 NULL이면 nullable contract에 따라 `null`입니다(발표일자
    하드코딩 분기 없음). `UUU`/`VVV`/`WAV`/`TMN`/`TMX`/`LGT` and unknown codes are ignored, and no
    raw KMA value reaches the output.
  - `forecastAt` is composed as fixed-KST ISO (`YYYY-MM-DDTHH:mm:00+09:00`) with no `Date`, clock, or
    time-zone dependency; `feelsLikeCelsius` is fixed `null` (a derived value deferred to a later PR).
  - `temperatureCelsius` is required: an ABSENT/NULL/unparseable `TMP`/`T1H` is a normalization issue
    (the slot is never silently dropped nor defaulted to `0`). Every other field is nullable: ABSENT,
    NULL, or an unparseable/out-of-range/Missing value all become `null`.
  - Each candidate is validated with `hourlyForecast.safeParse`; output is sorted by `forecastAt` and
    issues by `(slotKey, field, reason)`. It never mutates the input and reads no clock. The HTTP
    provider does **not** call it automatically — network and domain errors stay in separate unions.
- **Still not implemented.** `WeatherOverview` assembly, `SourceMetadata`, current weather, daily
  forecast (incl. `TMN`/`TMX`), feels-like computation, a common provider interface, automatic base
  date/time selection, lat/long → grid conversion, retry, cache, and the `/weather` route are **not**
  here — those are later PRs.

### Dependencies

- `zod` — runtime validation of the raw KMA response (same workspace version as
  `@life-weather/contracts`).
- `@life-weather/contracts` (workspace) — PR #6 adds this so the hourly normalizer can validate its
  output with the `hourlyForecast` schema. Direction is `apps/api → contracts`.
- `@life-weather/weather-core` (workspace) — shares `KmaForecastProduct` for slot identity and, from
  PR #6, the scalar/condition/amount parsers the normalizer calls. The dependency direction is
  `apps/api → weather-core`; `weather-core` never depends on `apps/api` or `contracts` at runtime.
- The HTTP provider and the PR #6 normalizer add **no new external dependency** — the provider uses
  Node 22 native `fetch`, `AbortController`, `ReadableStream`, and `TextDecoder`.
