import { z } from 'zod';

import { apiErrorCode, isoDateTime, nonEmptyString } from './common';
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
