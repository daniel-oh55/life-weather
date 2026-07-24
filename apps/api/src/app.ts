/**
 * The **production API app factory**: the one place that assembles the callable Hono application from an
 * **injected** `/weather` sub-app plus the existing `GET /health` route. Splitting the app assembly out of
 * `apps/api/src/index.ts` keeps the composition root (which reads the environment and builds the real KMA
 * production graph) separate from the pure, dependency-injected app wiring, so the whole app can be
 * exercised with `app.request(...)` and a **fake** weather sub-app — no `process.env`, no KMA service, no
 * clock, and no network.
 *
 * ### What it does
 *
 * ```ts
 * const app = new Hono();
 * app.get('/health', existingHealthHandler);          // unchanged deterministic health payload
 * app.route('/weather', dependencies.weatherRoute);   // the injected PR #30 weather sub-app, mounted once
 * return app;
 * ```
 *
 * The `/health` route is byte-for-byte the same handler `apps/api/src/index.ts` registered before PR #31 —
 * a `200` JSON `{ status: 'ok', service: 'life-weather-api' }` — so mounting the weather route is purely
 * additive and cannot regress health.
 *
 * ### Design boundaries
 *
 * - **Injection only.** The `/weather` sub-app is the sole dependency. The factory reads **no**
 *   `process.env`, builds **no** KMA service, creates **no** clock or `requestId`, and holds **no**
 *   module-level mutable state — the production composition root (`apps/api/src/index.ts`) supplies the
 *   real sub-app, and a test supplies a fake one. Two apps built from different dependencies never share
 *   state.
 * - **`/weather` mounted exactly once.** `app.route('/weather', weatherRoute)` maps the sub-app's own
 *   `POST /` to the public `POST /weather` — never `POST /weather/weather`, and never a hidden default
 *   weather route the factory invents itself.
 * - **No new global policy.** The factory registers no custom global `onError`/`notFound`, no logging, no
 *   CORS, and no middleware — Hono's defaults stand, exactly as before PR #31.
 *
 * See `docs/weather-production-wiring.md`.
 */

import { Hono } from 'hono';

/**
 * The app factory's injected dependencies. The single field is the **mountable** PR #30 `/weather` Hono
 * sub-app (`createWeatherRoute(...)`); the factory mounts it and adds nothing else provider-specific.
 * `readonly` and required — there is no default, singleton, or hidden fallback.
 */
export type ApiAppDependencies = {
  readonly weatherRoute: Hono;
};

/**
 * Build the callable API app: register the unchanged `GET /health` route and mount the injected
 * `/weather` sub-app at `/weather` (its `POST /` therefore answers `POST /weather`).
 *
 * Pure construction: it reads no environment, builds no KMA service, reads no clock, generates no
 * `requestId`, issues no network request, and adds no global `onError`/`notFound`/logging. Every call
 * returns a fresh `Hono` app closing over the injected sub-app only.
 */
export function createApiApp(dependencies: ApiAppDependencies): Hono {
  const app = new Hono();

  // The deterministic health payload, unchanged from the pre-PR-31 `apps/api/src/index.ts`.
  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      service: 'life-weather-api',
    });
  });

  // Mount the injected weather sub-app exactly once. Its own `POST /` becomes the public `POST /weather`.
  app.route('/weather', dependencies.weatherRoute);

  return app;
}
