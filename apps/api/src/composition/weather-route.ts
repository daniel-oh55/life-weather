/**
 * The **production composition** for the PR #30 `POST /weather` route — the one place that turns a
 * server-only `KMA_SERVICE_KEY` (plus optional production seams) into the concrete
 * {@link WeatherRouteDependencies} the route factory needs. It is the adapter layer between the existing
 * PR #27 `createKmaLocationHourlyOverviewCompositionFromEnv` production graph and the route's narrow
 * injected ports; the route factory itself (PR #30) is **not** modified here.
 *
 * It assembles four things and nothing else:
 *
 * 1. **The production KMA service.** It builds the existing PR #27 location hourly-overview production
 *    graph via {@link createKmaLocationHourlyOverviewCompositionFromEnv}, feeding the caller's
 *    `serviceKey` in as `KMA_SERVICE_KEY` and forwarding the optional `fetchImpl`/`clock` seams
 *    unchanged. This reuses the whole KMA graph (provider-from-env + service-key validation, request-plan
 *    factory, hourly service, PR #17 classifier, PR #19 fallback orchestration, PR #12 converter, PR #21
 *    location facade, PR #26 resolver, PR #24 service) — none of it is re-implemented.
 * 2. **The service→route adapter.** A {@link WeatherRouteExecuteOverview} that binds the service's
 *    `fetchHourlyWeatherOverviewForLocation(input, { signal })` to the route's `(input, signal)` port —
 *    forwarding `input` unchanged and the `AbortSignal` by the **same reference** inside `{ signal }`. It
 *    creates no `AbortController`, adds no timeout, transforms no result, catches/re-wraps no error, and
 *    never puts the service key on the adapter input or the response.
 * 3. **The server-owned product.** The fixed {@link PRODUCTION_WEATHER_PRODUCT} (`SHORT_FORECAST`). It is
 *    owned here, in one place — never read from an environment variable, the request body/query/headers,
 *    or anywhere a mobile client could set it.
 * 4. **The production `meta` provider.** A `createMeta(request)` that stamps a fresh `generatedAt`
 *    (current UTC, `Date.prototype.toISOString()` — millisecond `Z`) and a server-generated `requestId`
 *    (`globalThis.crypto.randomUUID()`), **per request**. It never trusts an inbound `x-request-id` /
 *    `x-vercel-id` header or a request-body value, and never falls back to `Math.random`. The route owns
 *    `contractVersion` (always `CONTRACT_VERSION`); the `meta` provider owns only `generatedAt`/
 *    `requestId`.
 *
 * ### Fail-fast on a missing/invalid service key
 *
 * A missing, empty, whitespace-only, or whitespace-padded `serviceKey` makes the underlying provider
 * composition fail its own validation; this function turns that value failure into a **thrown** error so
 * an incomplete `/weather` route is never silently built. The thrown message is a fixed, safe constant
 * ({@link KMA_SERVICE_KEY_REQUIRED_MESSAGE}) — the offending key value, the `process.env` contents, and
 * the provider URL/query never appear in it. Construction reads no clock, generates no `requestId`, and
 * issues **no** external `fetch` (the KMA graph is network-free until the returned adapter is invoked by
 * a real request); the clock and UUID factory are called only inside `createMeta`, per request.
 *
 * See `docs/weather-production-wiring.md`.
 */

import { KmaForecastProduct } from '@life-weather/weather-core';

import {
  presentKmaLocationHourlyOverviewResponseV1,
  type WeatherResponsePresenterMetaV1,
} from '../presenters';
import type { KmaForecastRequestClock } from '../services';
import type {
  WeatherRouteDependencies,
  WeatherRouteExecuteOverview,
} from '../routes';
import {
  createKmaLocationHourlyOverviewCompositionFromEnv,
  type KmaLocationHourlyOverviewCompositionDependencies,
} from './kma-location-hourly-overview';

/**
 * The **server-owned** production KMA forecast product for `/weather`: `SHORT_FORECAST` (단기예보). It is
 * imported from the `@life-weather/weather-core` `KmaForecastProduct` value (never re-typed as a bare
 * string), so it cannot drift from the enum. `/weather` serves the current and later hourly overview, and
 * 단기예보 is the initial production source; the product is a server decision, not a mobile request field.
 * It is selected in this one place — no environment variable, request body/query/header, or route-internal
 * re-decision can change it.
 */
export const PRODUCTION_WEATHER_PRODUCT = KmaForecastProduct.SHORT_FORECAST;

/**
 * The fixed, safe error message thrown when the production composition cannot be built because
 * `KMA_SERVICE_KEY` is absent or invalid. It names only the environment variable — never the offending
 * value, a partial key, the environment, or a provider URL/query.
 */
export const KMA_SERVICE_KEY_REQUIRED_MESSAGE = 'KMA_SERVICE_KEY is required.';

/**
 * The options for building the production `/weather` route dependencies.
 *
 * - `serviceKey` — the server-only 기상청 서비스 키. Read from `process.env.KMA_SERVICE_KEY` by the
 *   composition root (`apps/api/src/index.ts`) and handed in here as a plain string. It is validated by
 *   the existing provider policy (empty / whitespace-only / whitespace-padded are rejected) and never
 *   trimmed, decoded, or re-encoded here.
 * - `fetchImpl` — an injectable `fetch` forwarded to the KMA provider. Omitted in production (the
 *   provider uses `globalThis.fetch`); a test injects an in-memory `fetch` so no real external request is
 *   made.
 * - `clock` — an injectable KMA request-plan clock forwarded to the KMA graph (the base-time selector and
 *   the resolver's `fetchedAt`). Omitted in production (a system clock is used); a test injects a fixed
 *   clock for a deterministic issuance. This is the KMA data clock, **distinct** from `now` below.
 * - `now` — the response `meta` clock, used **only** for `generatedAt`. Defaults to `() => new Date()`.
 * - `createRequestId` — the response `meta` `requestId` factory. Defaults to
 *   `() => globalThis.crypto.randomUUID()`.
 *
 * `now` and `createRequestId` are injectable purely so a test can make the response `meta` deterministic;
 * production omits them and gets the real clock and UUID generator.
 */
export type ProductionWeatherRouteOptions = {
  readonly serviceKey: string;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly clock?: KmaForecastRequestClock;
  readonly now?: () => Date;
  readonly createRequestId?: () => string;
};

/**
 * Build the production {@link WeatherRouteDependencies} for `POST /weather` from a validated
 * `serviceKey` and the optional production seams.
 *
 * Throws {@link KMA_SERVICE_KEY_REQUIRED_MESSAGE} (fail-fast) when the service key is missing or invalid,
 * so an incomplete route is never returned. On success it returns the four route dependencies described in
 * the module comment. Construction is side-effect-free beyond the provider's synchronous key validation:
 * it reads no clock, generates no `requestId`, and issues no external `fetch` — the KMA graph stays lazy,
 * and `now`/`createRequestId` are called only per request inside `createMeta`.
 */
export function createProductionWeatherRouteDependencies(
  options: ProductionWeatherRouteOptions,
): WeatherRouteDependencies {
  // Reuse the existing PR #27 production graph. The caller's serviceKey is fed in as KMA_SERVICE_KEY, and
  // the fetch/clock seams are forwarded unchanged (both undefined in production, so the graph keeps its
  // native fetch and system clock defaults).
  const compositionDependencies: KmaLocationHourlyOverviewCompositionDependencies = {
    fetchImpl: options.fetchImpl,
    clock: options.clock,
  };
  const composition = createKmaLocationHourlyOverviewCompositionFromEnv(
    { KMA_SERVICE_KEY: options.serviceKey },
    compositionDependencies,
  );

  // Fail-fast: a provider config failure (missing / empty / whitespace-only / padded key) becomes a
  // thrown error with a fixed safe message — no partial route, no key value, no env dump, no network.
  if (!composition.ok) {
    throw new Error(KMA_SERVICE_KEY_REQUIRED_MESSAGE);
  }

  const service = composition.service;

  // Bind the service's `(input, { signal })` method to the route's narrow `(input, signal)` port: input
  // forwarded unchanged, the AbortSignal forwarded by the exact same reference inside `{ signal }`, and
  // the service's Promise returned verbatim — no new controller, no timeout, no result/error rewrapping.
  const executeOverview: WeatherRouteExecuteOverview = (input, signal) =>
    service.fetchHourlyWeatherOverviewForLocation(input, { signal });

  // The response `meta` clock and `requestId` factory. Defaults are the real system clock and Web Crypto
  // UUID generator; both are called only inside `createMeta`, once per request.
  const now = options.now ?? (() => new Date());
  const createRequestId =
    options.createRequestId ?? (() => globalThis.crypto.randomUUID());

  // Produce a fresh response `meta` per request. The inbound Request is intentionally unused: the
  // `requestId` is always server-generated, never read from `x-request-id` / `x-vercel-id` / the body.
  const createMeta = (_request: Request): WeatherResponsePresenterMetaV1 => ({
    generatedAt: now().toISOString(),
    requestId: createRequestId(),
  });

  return {
    executeOverview,
    presentResponse: presentKmaLocationHourlyOverviewResponseV1,
    product: PRODUCTION_WEATHER_PRODUCT,
    createMeta,
  };
}
