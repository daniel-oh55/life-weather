import { z } from 'zod';

import {
  isoDateTime,
  nonEmptyString,
  weatherAlertSeverity,
  weatherAlertType,
} from './common';

/**
 * A normalized weather alert.
 *
 * Provider-native alert codes and raw message structures are **not** exposed here; a
 * provider maps them onto {@link weatherAlertType} / {@link weatherAlertSeverity}
 * (mapping principles are documented in `docs/contracts.md`; the concrete KMA mapping is
 * a later provider PR).
 */
export const weatherAlert = z.object({
  /** Opaque, app-facing alert identifier. */
  id: nonEmptyString,
  type: weatherAlertType.compatible,
  severity: weatherAlertSeverity.compatible,
  title: nonEmptyString,
  /** Human-readable body, or `null` when the provider supplies no description. */
  description: nonEmptyString.nullable(),
  /** Affected areas; at least one entry. */
  areas: z.array(nonEmptyString).min(1),
  issuedAt: isoDateTime,
  effectiveAt: isoDateTime.nullable(),
  expiresAt: isoDateTime.nullable(),
});

export type WeatherAlert = z.infer<typeof weatherAlert>;
