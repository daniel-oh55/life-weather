/**
 * The **injectable `POST /weather` route factory**: the HTTP boundary that connects the existing
 * request contract, application service, and response presenter into a single Hono sub-app.
 *
 * ### What it is
 *
 * {@link createWeatherRoute} returns a **mountable Hono sub-app** that registers exactly one handler —
 * `POST /` — so a startup wiring PR can mount it at `/weather`:
 *
 * ```ts
 * const app = new Hono();
 * app.route('/weather', createWeatherRoute(dependencies));
 * ```
 *
 * The request pipeline is:
 *
 * ```text
 * POST /weather
 *   → Content-Type must be application/json            (415 UNSUPPORTED_MEDIA_TYPE)
 *   → request body byte-size limit (16 KiB)            (413 PAYLOAD_TOO_LARGE)
 *   → JSON parse                                       (400 INVALID_REQUEST on malformed JSON)
 *   → WeatherRequestV1 strict validation               (400 INVALID_REQUEST on schema failure)
 *   → server-owned KMA product applied
 *   → injected application service (raw Request AbortSignal forwarded verbatim)
 *   → PR #29 presenter
 *   → WeatherResponseV1 JSON body + HTTP status mapping (200 / 422 / 500)
 * ```
 *
 * ### Design boundaries
 *
 * - **Server-owned product.** The public {@link WeatherRequestV1} carries no `product`; the KMA product
 *   is a typed route dependency, never read from the client body/headers/query. A client-supplied
 *   top-level `product` (or any provider-native key such as `nx`/`ny`/`serviceKey`/`baseDate`) is a
 *   strict-schema rejection (`400`), so a mobile client can never select or override it.
 * - **Dependency injection only.** The service execution port, the presenter, the server product, and
 *   the response `meta` provider are all injected. The factory reads **no** `process.env`, generates
 *   **no** clock/`requestId`, and calls **no** `Date.now`/`randomUUID`/`Math.random` — so it is fully
 *   testable independently of startup, and PR #31 supplies the production adapters.
 * - **AbortSignal pass-through.** The raw `Request` `AbortSignal` (`c.req.raw.signal`) is forwarded to
 *   the service port by the same reference — no new `AbortController`, no wrapping, no timeout.
 * - **Contract-shaped, leak-free errors.** Every request-layer failure is a `WeatherErrorResponseV1`
 *   validated by the contracts producer schema. Zod issues, stack traces, raw `Error` messages, and
 *   provider traces are never exposed; internal service/presenter exceptions collapse to a fixed
 *   `INTERNAL_ERROR` 500 body.
 *
 * ### What it is not
 *
 * It is **not** mounted into `apps/api/src/index.ts` in this PR, builds **no** production composition,
 * reads no environment, and adds no cache, CORS, rate-limit, auth, logging, or custom global
 * `onError`/`notFound`. See `docs/weather-route.md`.
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import {
  CONTRACT_VERSION,
  weatherErrorResponseV1,
  weatherRequestV1,
  type ApiErrorCode,
  type WeatherErrorResponseV1,
} from '@life-weather/contracts';

import type {
  presentKmaLocationHourlyOverviewResponseV1,
  WeatherResponsePresenterMetaV1,
} from '../presenters';
import type {
  KmaLocationHourlyOverviewInput,
  KmaLocationHourlyOverviewResult,
} from '../services';

/**
 * The maximum accepted `POST /weather` request body size: **16 KiB** (`16 * 1024 = 16384` bytes).
 * Exactly `16384` bytes is accepted; `16385` bytes or more is rejected with `413`. The limit is
 * enforced on the **actual byte length** of the body (via Hono's `bodyLimit`), never on a character
 * count or a trusted `Content-Length` alone.
 */
export const WEATHER_REQUEST_MAX_BYTES = 16 * 1024;

/**
 * The minimal service execution port the route depends on: it maps a validated
 * {@link KmaLocationHourlyOverviewInput} plus the raw request {@link AbortSignal} to the internal
 * {@link KmaLocationHourlyOverviewResult}.
 *
 * The route deliberately depends on this **narrow port** rather than the whole
 * `KmaLocationHourlyOverviewService` (whose method takes the signal inside an `options` object). A
 * PR #31 startup adapter can bind the production service to this port — e.g.
 * `(input, signal) => service.fetchHourlyWeatherOverviewForLocation(input, { signal })` — without the
 * route knowing how the service threads its signal.
 */
export type WeatherRouteExecuteOverview = (
  input: KmaLocationHourlyOverviewInput,
  signal: AbortSignal,
) => Promise<KmaLocationHourlyOverviewResult>;

/**
 * The route factory's injected dependencies. Every field is required and `readonly`; there is no
 * default, global singleton, or hidden fallback.
 *
 * - `executeOverview` — the {@link WeatherRouteExecuteOverview} application-service port.
 * - `presentResponse` — the PR #29 response presenter (bound by `typeof`, so the route cannot drift
 *   from its real signature).
 * - `product` — the **server-owned** KMA product, typed exactly as the service input's `product`.
 * - `createMeta` — the response `meta` provider (clock + `requestId`), called with the raw `Request`.
 *   It is route infrastructure and must return a valid {@link WeatherResponsePresenterMetaV1}.
 */
export type WeatherRouteDependencies = {
  readonly executeOverview: WeatherRouteExecuteOverview;
  readonly presentResponse: typeof presentKmaLocationHourlyOverviewResponseV1;
  readonly product: KmaLocationHourlyOverviewInput['product'];
  readonly createMeta: (request: Request) => WeatherResponsePresenterMetaV1;
};

/**
 * A request-layer error descriptor: the stable public `code`/`message`/`retryable` the route emits for
 * a boundary failure. `code` is a known {@link ApiErrorCode}; the values are fixed constants (never
 * derived from a caught error).
 */
type WeatherRouteErrorInput = {
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly retryable: boolean;
};

/** `415` — the `Content-Type` was absent/empty or not `application/json`. */
const UNSUPPORTED_MEDIA_TYPE_ERROR = {
  code: 'UNSUPPORTED_MEDIA_TYPE',
  message: 'Content-Type must be application/json.',
  retryable: false,
} satisfies WeatherRouteErrorInput;

/** `413` — the request body exceeded {@link WEATHER_REQUEST_MAX_BYTES}. */
const PAYLOAD_TOO_LARGE_ERROR = {
  code: 'PAYLOAD_TOO_LARGE',
  message: 'The request body is too large.',
  retryable: false,
} satisfies WeatherRouteErrorInput;

/** `400` — malformed JSON, or a body that fails {@link WeatherRequestV1} strict validation. */
const INVALID_REQUEST_ERROR = {
  code: 'INVALID_REQUEST',
  message: 'The request body is invalid.',
  retryable: false,
} satisfies WeatherRouteErrorInput;

/** `500` — a service/presenter exception, or an unexpected presenter error code. */
const INTERNAL_ERROR = {
  code: 'INTERNAL_ERROR',
  message: 'The weather request could not be completed.',
  retryable: false,
} satisfies WeatherRouteErrorInput;

/**
 * The single supported presenter error code the route maps to a non-500 status (`422`). Any other
 * `ok: false` code the presenter returns is treated as unexpected and collapsed to `INTERNAL_ERROR`
 * `500`, so an internal code/message is never exposed at an arbitrary HTTP status.
 */
const UNSUPPORTED_LOCATION_CODE: ApiErrorCode = 'UNSUPPORTED_LOCATION';

/**
 * Decide whether a `Content-Type` header selects `application/json`. The media type (everything before
 * the first `;`) is trimmed and compared case-insensitively against exactly `application/json`, so
 * `application/json`, `application/json; charset=utf-8`, and `APPLICATION/JSON` are accepted while an
 * absent/empty header, `text/plain`, `multipart/form-data`, `application/x-www-form-urlencoded`,
 * `application/problem+json`, and any other `application/*+json` are rejected.
 */
function isApplicationJsonContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) {
    return false;
  }

  const [mediaType] = contentType.split(';');
  return mediaType.trim().toLowerCase() === 'application/json';
}

/**
 * Build a request-layer {@link WeatherErrorResponseV1} from the caller `meta` and a fixed
 * {@link WeatherRouteErrorInput}. The route owns `contractVersion` (always {@link CONTRACT_VERSION});
 * `generatedAt`/`requestId` are read explicitly off `meta` (never spread) and the error fields are
 * assigned explicitly (never spread), so no extra runtime key leaks. The assembled body is validated
 * with the contracts producer schema `weatherErrorResponseV1.parse`, so a `meta` that fails producer
 * validation (invalid `generatedAt`, empty `requestId`) throws synchronously here — `createMeta` is
 * route infrastructure and must return a valid meta. Module-private on purpose.
 */
function createWeatherRouteErrorResponse(
  meta: WeatherResponsePresenterMetaV1,
  error: WeatherRouteErrorInput,
): WeatherErrorResponseV1 {
  return weatherErrorResponseV1.parse({
    ok: false,
    meta: {
      contractVersion: CONTRACT_VERSION,
      generatedAt: meta.generatedAt,
      requestId: meta.requestId,
    },
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    },
  });
}

/**
 * Create a mountable `POST /weather` Hono sub-app bound to the injected {@link WeatherRouteDependencies}.
 *
 * The returned app registers **only** `POST /` (no `GET`, wildcard, health, global `notFound`, or global
 * `onError`), so a parent mounts it with `app.route('/weather', createWeatherRoute(deps))`. Construction
 * is synchronous and side-effect-free: it reads no clock/env/network and merely closes over the
 * dependencies. Two factories with different dependencies never share mutable state.
 */
export function createWeatherRoute(dependencies: WeatherRouteDependencies): Hono {
  const app = new Hono();

  app.post(
    '/',
    // 1. Content-Type guard — runs BEFORE the body-size limit, so a large non-JSON body is a 415, not a
    //    413. On the happy path it calls next() and reads no meta (so createMeta stays once-per-request).
    async (c, next) => {
      if (!isApplicationJsonContentType(c.req.header('content-type'))) {
        const meta = dependencies.createMeta(c.req.raw);
        return c.json(
          createWeatherRouteErrorResponse(meta, UNSUPPORTED_MEDIA_TYPE_ERROR),
          415,
        );
      }

      await next();
    },
    // 2. Byte-based body-size limit (official Hono middleware). It rejects on Content-Length before
    //    reading the body when the header is present, and otherwise enforces the actual streamed byte
    //    size — so a missing or dishonest Content-Length cannot bypass the limit. onError builds the
    //    413 body (createMeta runs only on this terminal path).
    bodyLimit({
      maxSize: WEATHER_REQUEST_MAX_BYTES,
      onError: (c) => {
        const meta = dependencies.createMeta(c.req.raw);
        return c.json(
          createWeatherRouteErrorResponse(meta, PAYLOAD_TOO_LARGE_ERROR),
          413,
        );
      },
    }),
    // 3. Parse, validate, execute, present, and map to an HTTP status. createMeta is called exactly once
    //    here (this handler is the terminal path for 400/200/422/500).
    async (c) => {
      const meta = dependencies.createMeta(c.req.raw);

      // Malformed JSON → 400. The parser's raw message (SyntaxError / position / body) is never exposed.
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json(
          createWeatherRouteErrorResponse(meta, INVALID_REQUEST_ERROR),
          400,
        );
      }

      // Strict request validation → 400 on failure. Zod issues are never exposed. The strict top-level
      // and nested-location schemas reject any extra key (client product / provider-native keys).
      const parsed = weatherRequestV1.safeParse(body);
      if (!parsed.success) {
        return c.json(
          createWeatherRouteErrorResponse(meta, INVALID_REQUEST_ERROR),
          400,
        );
      }

      // Service + presenter + status mapping. Any throw here (service or presenter) collapses to a fixed
      // INTERNAL_ERROR 500 — the raw error, its message/stack/cause, and any Zod/provider detail never
      // reach the response.
      try {
        const result = await dependencies.executeOverview(
          {
            product: dependencies.product,
            location: parsed.data.location,
          },
          // The raw Request AbortSignal is forwarded by the exact same reference — no new controller.
          c.req.raw.signal,
        );

        const response = dependencies.presentResponse(result, meta);

        if (response.ok) {
          return c.json(response, 200);
        }

        // The only presenter error code the current service/presenter can produce is UNSUPPORTED_LOCATION.
        if (response.error.code === UNSUPPORTED_LOCATION_CODE) {
          return c.json(response, 422);
        }

        // An unexpected presenter error code is never surfaced verbatim at an arbitrary status.
        return c.json(
          createWeatherRouteErrorResponse(meta, INTERNAL_ERROR),
          500,
        );
      } catch {
        return c.json(createWeatherRouteErrorResponse(meta, INTERNAL_ERROR), 500);
      }
    },
  );

  return app;
}
