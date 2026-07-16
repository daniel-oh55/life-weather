/**
 * Public surface of the KMA (기상청) raw-response boundary for `apps/api`.
 *
 * This boundary validates the raw `getVilageFcst` / `getUltraSrtFcst` JSON at runtime, classifies
 * it (success / upstream error / invalid response), and groups a validated page into per-time
 * forecast slots with an explicit `ABSENT` / `NULL` / `VALUE` field-presence model. It performs
 * **no** network I/O and reads **no** environment variables — the real HTTP provider (fetch,
 * `KMA_SERVICE_KEY`, timeout/retry, and wiring into `weather-core`) is deferred to PR #5.
 *
 * See `docs/kma-response-boundary.md` for the official-source evidence and policy details.
 */

export {
  parseKmaForecastResponse,
  type KmaForecastPage,
  type KmaForecastResponseError,
  type KmaInvalidResponse,
  type KmaResponseIssue,
  type KmaUpstreamError,
  type ParseKmaForecastResponseResult,
} from './parse-response';

export {
  getKmaForecastField,
  groupKmaForecastItems,
  type GroupKmaForecastItemsResult,
  type KmaForecastField,
  type KmaForecastFieldLookup,
  type KmaForecastScalar,
  type KmaForecastSlot,
} from './group-forecast-items';

export {
  KMA_SUCCESS_RESULT_CODE,
  kmaForecastBodySchema,
  kmaForecastItemSchema,
  kmaForecastItemsSchema,
  kmaForecastSuccessResponseSchema,
  kmaResponseEnvelopeSchema,
  kmaResponseHeaderSchema,
  type KmaForecastBody,
  type KmaForecastItem,
  type KmaResponseHeader,
} from './raw-schema';
