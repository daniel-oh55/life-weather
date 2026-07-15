import { z } from 'zod';

import { ianaTimeZone, latitude, longitude, nonEmptyString } from './common';

/**
 * A location the weather data describes.
 *
 * `id` is an opaque, app-issued identifier — it is intentionally **not** a KMA grid
 * coordinate, an AirKorea station id, or any provider-native id. Those provider-internal
 * lookup keys live in the mobile local store / server-side location registry, not in this
 * shared contract (see `docs/contracts.md`).
 */
export const weatherLocation = z.object({
  /** Stable opaque identifier issued and owned by the app. */
  id: nonEmptyString,
  /** Human-readable label to show in the UI. */
  displayName: nonEmptyString,
  /** Uppercase ISO 3166-1 alpha-2 country code (e.g. `KR`). */
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  /** First-level administrative area, or `null` if not applicable. Field is required. */
  adminArea1: z.string().nullable(),
  /** Second-level administrative area, or `null` if not applicable. Field is required. */
  adminArea2: z.string().nullable(),
  /** Third-level administrative area, or `null` if not applicable. Field is required. */
  adminArea3: z.string().nullable(),
  latitude,
  longitude,
  /** Valid IANA timezone name (e.g. `Asia/Seoul`). */
  timezone: ianaTimeZone,
});

export type WeatherLocation = z.infer<typeof weatherLocation>;
