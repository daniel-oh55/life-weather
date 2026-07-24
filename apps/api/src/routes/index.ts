/**
 * Public surface of `apps/api`'s **HTTP routes** — the Hono adapter boundary that connects the request
 * contract, application service, and response presenter at the HTTP layer.
 *
 * One route factory lives here so far:
 *
 * 1. The PR #30 **injectable `POST /weather` route factory** (`createWeatherRoute`): a mountable Hono
 *    sub-app that registers exactly `POST /`, validates `Content-Type` and body size, strictly parses
 *    the provider-neutral `WeatherRequestV1`, applies the server-owned KMA product, calls an injected
 *    application-service port (forwarding the raw request `AbortSignal`), runs the PR #29 presenter, and
 *    maps the `WeatherResponseV1` body to an HTTP status. The service, presenter, server product, and
 *    response `meta` provider are all injected — the factory reads no clock/env/randomness — so it is
 *    testable independently of startup. See `docs/weather-route.md`.
 *
 * This barrel is **not** re-exported from `apps/api/src/index.ts`; the route is not mounted into app
 * startup yet — that is a later PR. The only callable production endpoint remains `GET /health`.
 */

export {
  createWeatherRoute,
  WEATHER_REQUEST_MAX_BYTES,
  type WeatherRouteDependencies,
  type WeatherRouteExecuteOverview,
} from './weather';
