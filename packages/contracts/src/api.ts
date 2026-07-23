import { z } from 'zod';

import { apiErrorCode, isoDateTime, nonEmptyString } from './common';
import { weatherLocation } from './location';
import { weatherOverview } from './weather';

/**
 * Current contract version. Bumped only on a breaking change; additive changes
 * (new optional/nullable fields) keep the same version. See `docs/contracts.md`.
 */
export const CONTRACT_VERSION = 1 as const;

/**
 * Minimal envelope header: enough to read the contract version *before* parsing the full
 * payload. `contractVersion` here is any positive integer — deliberately not `literal(1)` —
 * so a v1 consumer can detect a v2+ response and route it appropriately.
 */
export const apiEnvelopeHeader = z.object({
  ok: z.boolean(),
  meta: z.object({
    contractVersion: z.number().int().positive(),
  }),
});

export type ApiEnvelopeHeader = z.infer<typeof apiEnvelopeHeader>;

/**
 * V1 response metadata. `contractVersion` is the literal `1`, so a full-response parse
 * rejects any other version.
 */
export const apiMetaV1 = z.object({
  contractVersion: z.literal(CONTRACT_VERSION),
  generatedAt: isoDateTime,
  requestId: nonEmptyString.nullable(),
});

export type ApiMetaV1 = z.infer<typeof apiMetaV1>;

/** A V1 error body. */
export const apiErrorV1 = z.object({
  code: apiErrorCode.compatible,
  message: nonEmptyString,
  retryable: z.boolean(),
});

export type ApiErrorV1 = z.infer<typeof apiErrorV1>;

/** A V1 success response carrying a {@link weatherOverview}. */
export const weatherSuccessResponseV1 = z.object({
  ok: z.literal(true),
  meta: apiMetaV1,
  data: weatherOverview,
});

export type WeatherSuccessResponseV1 = z.infer<typeof weatherSuccessResponseV1>;

/** A V1 error response. */
export const weatherErrorResponseV1 = z.object({
  ok: z.literal(false),
  meta: apiMetaV1,
  error: apiErrorV1,
});

export type WeatherErrorResponseV1 = z.infer<typeof weatherErrorResponseV1>;

/**
 * The full V1 weather response: a discriminated union on `ok`. Narrowing on `ok`
 * distinguishes the success and error variants. Because both variants use
 * {@link apiMetaV1}, the whole response is rejected unless `contractVersion === 1`.
 */
export const weatherResponseV1 = z.discriminatedUnion('ok', [
  weatherSuccessResponseV1,
  weatherErrorResponseV1,
]);

export type WeatherResponseV1 = z.infer<typeof weatherResponseV1>;

// ---------------------------------------------------------------------------
// V1 request contract
// ---------------------------------------------------------------------------

/**
 * The request-boundary location schema: {@link weatherLocation} with unknown keys
 * **rejected** instead of stripped.
 *
 * Derived from the shared {@link weatherLocation} with `.strict()`, which returns a new
 * schema and leaves the exported `weatherLocation` (and its Zod-default strip behavior used
 * everywhere else) untouched. It reuses every field rule unchanged — the `adminArea*` fields
 * stay required-and-nullable, so an explicit `null` is accepted but a missing field is not.
 *
 * Kept module-private on purpose: the request boundary is `weatherRequestV1`. A mobile client
 * must map its local region-store object — which may carry app-only fields such as
 * `isCurrent` / `sortOrder` or provider-native lookup keys such as `kmaGrid` / `nx` / `ny` —
 * down to exactly the shared WeatherLocation fields. Anything extra is a validation failure
 * here rather than being silently dropped.
 */
const weatherRequestLocationV1 = weatherLocation.strict();

/**
 * The V1 `POST /weather` request body (transport is defined in a later PR; this PR ships the
 * shared schema, type, tests, and docs only).
 *
 * The body carries **only** a {@link weatherLocation} and is deliberately provider-neutral:
 * it never includes KMA-specific policy such as `product`, `nx` / `ny`, grid, base date/time,
 * issuance, fallback, a service key, or a provider id. The server selects the KMA product
 * itself, so the mobile client stays decoupled from any provider. There is no
 * `contractVersion` in the request body — request-side versioning is out of scope and the
 * response envelope's {@link CONTRACT_VERSION} policy is unchanged.
 *
 * Both the top-level object and the nested location are strict, so any unknown key — a
 * provider-native identifier or a local-only storage field — is rejected, not stripped. This
 * is the one strict boundary; it does not change the shared {@link weatherLocation}. See
 * `docs/contracts.md`.
 */
export const weatherRequestV1 = z
  .object({
    location: weatherRequestLocationV1,
  })
  .strict();

export type WeatherRequestV1 = z.infer<typeof weatherRequestV1>;
