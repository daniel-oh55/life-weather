import type { KmaForecastProduct } from '@life-weather/weather-core';

/**
 * The sanitized identity of one KMA forecast issuance actually associated with an execution attempt.
 *
 * It deliberately preserves only the logical product and provider-native base issuance date/time.
 * It contains no grid coordinates, ServiceKey, URL, query, response body, transport metadata,
 * retrieval timestamp, fallback strategy, or application-selection field.
 */
export interface KmaForecastIssuanceIdentity {
  readonly product: KmaForecastProduct;
  readonly baseDate: string;
  readonly baseTime: string;
}
