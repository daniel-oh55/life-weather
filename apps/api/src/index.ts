/**
 * The **production composition root and deployment entrypoint** for `apps/api`.
 *
 * This is the one module that reads the server environment, builds the real KMA production graph, mounts
 * the PR #30 `POST /weather` route, and default-exports the assembled Hono app for Vercel's zero-config
 * function detection. As of PR #31 the callable production surface is:
 *
 * - `GET /health` — the unchanged deterministic health payload.
 * - `POST /weather` — the live weather route, wired to the production KMA location hourly-overview graph.
 *
 * ### Startup flow
 *
 * ```text
 * process.env.KMA_SERVICE_KEY (server-only)
 *   → createProductionWeatherRouteDependencies({ serviceKey })   // PR #31 production composition
 *        → KMA production graph + service→route adapter + server product + meta provider
 *   → createWeatherRoute(dependencies)                            // PR #30 mountable sub-app
 *   → createApiApp({ weatherRoute })                              // GET /health + app.route('/weather', …)
 *   → export default app
 * ```
 *
 * ### Fail-fast, network-free startup
 *
 * Building the app validates `KMA_SERVICE_KEY` **synchronously**: a missing/invalid key makes
 * `createProductionWeatherRouteDependencies` throw (a fixed safe message, never the key value), so the
 * module import fails rather than exposing an incomplete `/weather`. Building the graph issues **no**
 * external `fetch` — the KMA provider stays lazy, so the first upstream request happens only when a real
 * `POST /weather` arrives, never at import/startup. No clock is read and no `requestId` is generated at
 * startup either; those happen per request.
 *
 * ### Testability
 *
 * Env parsing + app composition live in the exported {@link createProductionApiApp}, so a test can build
 * the app with a controlled `env` (and assert the missing-key fail-fast) directly, and the module-level
 * default export is just `createProductionApiApp()` over `process.env`. See
 * `docs/weather-production-wiring.md`.
 */

import type { Hono } from 'hono';

import { createApiApp } from './app';
import { createProductionWeatherRouteDependencies } from './composition';
import { createWeatherRoute } from './routes';

/**
 * Build the production API app from an environment: read the server-only `KMA_SERVICE_KEY`, compose the
 * production `/weather` route dependencies, create the PR #30 weather route, and mount it (plus the
 * unchanged `GET /health`) into a fresh Hono app.
 *
 * Throws (fail-fast) when `KMA_SERVICE_KEY` is missing or invalid; the thrown message never contains the
 * key value. Reads the environment but issues no external `fetch`, reads no clock, and generates no
 * `requestId` — those are deferred to a real request. `env` defaults to `process.env`; a test passes a
 * controlled environment.
 */
export function createProductionApiApp(env: NodeJS.ProcessEnv = process.env): Hono {
  const weatherRoute = createWeatherRoute(
    createProductionWeatherRouteDependencies({
      // Server-only; never a public-prefixed variable. Coerced to '' so an unset key fails the provider's
      // own validation (→ fail-fast throw) rather than being read as `undefined`.
      serviceKey: env.KMA_SERVICE_KEY ?? '',
    }),
  );

  return createApiApp({ weatherRoute });
}

const app = createProductionApiApp();

export default app;
