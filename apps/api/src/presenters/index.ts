/**
 * Public surface of `apps/api`'s **response presenters** — the pure boundary that maps an internal
 * application result to a mobile-facing `@life-weather/contracts` response body.
 *
 * One presenter lives here so far:
 *
 * 1. The PR #29 KMA **location hourly overview response presenter**
 *    (`presentKmaLocationHourlyOverviewResponseV1`): the pure, synchronous mapping from the PR #24
 *    internal `KmaLocationHourlyOverviewResult` (`{ ok, selection, overview }` on success, or a
 *    `LOCATION`/`UNSUPPORTED_LOCATION` failure) to a `WeatherResponseV1` body. A success exposes **only**
 *    `overview` as `data` — the `selection`, its PR #19 execution trace, PR #25 issuance identity, and
 *    fallback detail are never serialized — and a no-selection success stays a success. A `LOCATION`
 *    failure maps to a stable error with the additive `UNSUPPORTED_LOCATION` code. The presenter owns
 *    `contractVersion` (always `CONTRACT_VERSION`); the caller supplies only `generatedAt`/`requestId`.
 *    The output is validated with the contracts response schema (a synchronous `ZodError` on invalid
 *    input). It decides no HTTP status/header/body-size, registers no route, and does no startup wiring.
 *    See `docs/weather-response-presenter.md`.
 *
 * Presenters deliberately live **outside** `services` (they are not application orchestration) and
 * `composition` (they build no graph), and are exported only from here. This barrel is **not** re-exported
 * from `apps/api/src/index.ts`; no HTTP route consumes the presenter yet — that is a later PR.
 */

export {
  presentKmaLocationHourlyOverviewResponseV1,
  type WeatherResponsePresenterMetaV1,
} from './kma-location-hourly-overview-response';
