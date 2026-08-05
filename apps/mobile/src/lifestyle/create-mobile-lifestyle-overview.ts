/**
 * Pure mobile presentation boundary connecting a validated `WeatherSuccessResponseV1` to the
 * four existing `@life-weather/lifestyle-engine` policies (umbrella, outfit, mask, laundry).
 *
 * This module is pure TypeScript: no React/React Native import, no system clock (`Date.now()` /
 * argument-less `new Date()`), no network, no storage, no environment variable, no timer, no
 * logging, and no mutation of its input. Every engine's `evaluatedAt` is the response's own
 * `meta.generatedAt` — never a device-read instant. `reason` / `recommendation` /
 * `additionalRecommendation` are the engine's own copy, passed through unmodified; only the
 * status label is computed here, via an exhaustive `Record` per engine so a future engine status
 * fails typecheck instead of silently falling back. No `reasonCode`, `policyVersion`, evidence, or
 * provider-native value is exposed on a card.
 *
 * See `docs/mobile-lifestyle-overview.md`.
 */

import {
  assessLaundryDryingSuitability,
  assessMaskNeed,
  assessOutfitRecommendation,
  assessUmbrellaNeed,
  type LaundryStatus,
  type MaskStatus,
  type OutfitStatus,
  type UmbrellaStatus,
} from '@life-weather/lifestyle-engine';
import type { WeatherSuccessResponseV1 } from '@life-weather/contracts';

/** Fixed card identity and display order. */
export type MobileLifestyleCardId = 'UMBRELLA' | 'OUTFIT' | 'MASK' | 'LAUNDRY';

/** One lifestyle card ready for direct rendering. */
export interface MobileLifestyleCard {
  readonly id: MobileLifestyleCardId;
  readonly title: string;
  readonly statusLabel: string;
  readonly reason: string;
  readonly recommendation: string;
  readonly additionalRecommendation: string | null;
}

const UMBRELLA_STATUS_LABELS: Readonly<Record<UmbrellaStatus, string>> = Object.freeze({
  REQUIRED_NOW: '지금 필요',
  REQUIRED_LATER: '나중에 필요',
  RECOMMENDED: '챙기기 권장',
  NOT_NEEDED: '필요 낮음',
  INSUFFICIENT_DATA: '판단 보류',
});

const OUTFIT_STATUS_LABELS: Readonly<Record<OutfitStatus, string>> = Object.freeze({
  EXTREME_COLD: '매우 추움',
  VERY_COLD: '추움',
  COLD: '쌀쌀함',
  COOL: '선선함',
  MILD: '온화함',
  WARM: '따뜻함',
  HOT: '더움',
  VERY_HOT: '매우 더움',
  INSUFFICIENT_DATA: '판단 보류',
});

const MASK_STATUS_LABELS: Readonly<Record<MaskStatus, string>> = Object.freeze({
  REQUIRED: '착용 필요',
  RECOMMENDED: '착용 권장',
  NOT_NEEDED: '필요 낮음',
  INSUFFICIENT_DATA: '판단 보류',
});

const LAUNDRY_STATUS_LABELS: Readonly<Record<LaundryStatus, string>> = Object.freeze({
  NOT_RECOMMENDED: '실외 건조 비추천',
  POOR: '좋지 않음',
  FAIR: '보통',
  GOOD: '좋음',
  EXCELLENT: '매우 좋음',
  INSUFFICIENT_DATA: '판단 보류',
});

/**
 * Build the four fixed-order lifestyle cards (우산 / 옷차림 / 마스크 / 빨래) from a validated
 * `WeatherSuccessResponseV1`. Every policy is evaluated at `response.meta.generatedAt`; umbrella,
 * outfit, and laundry read `response.data.hourly`, and mask reads
 * `response.data.airQuality.current` (passed through as-is, including `null` — never a fabricated
 * fallback). The engine's own `reason` / `recommendation` copy is reused unchanged; only the
 * status label is resolved here via an exhaustive mapping. `INSUFFICIENT_DATA` is never hidden —
 * it renders as a normal card with the "판단 보류" label.
 */
export function createMobileLifestyleOverview(
  response: WeatherSuccessResponseV1,
): readonly MobileLifestyleCard[] {
  const evaluatedAt = response.meta.generatedAt;
  const hourlyForecasts = response.data.hourly;
  const airQuality = response.data.airQuality.current;

  const umbrella = assessUmbrellaNeed({ evaluatedAt, hourlyForecasts });
  const outfit = assessOutfitRecommendation({ evaluatedAt, hourlyForecasts });
  const mask = assessMaskNeed({ evaluatedAt, airQuality });
  const laundry = assessLaundryDryingSuitability({ evaluatedAt, hourlyForecasts });

  return [
    {
      id: 'UMBRELLA',
      title: '우산',
      statusLabel: UMBRELLA_STATUS_LABELS[umbrella.status],
      reason: umbrella.reason,
      recommendation: umbrella.recommendation,
      additionalRecommendation: null,
    },
    {
      id: 'OUTFIT',
      title: '옷차림',
      statusLabel: OUTFIT_STATUS_LABELS[outfit.status],
      reason: outfit.reason,
      recommendation: outfit.recommendation,
      additionalRecommendation: outfit.additionalRecommendation,
    },
    {
      id: 'MASK',
      title: '마스크',
      statusLabel: MASK_STATUS_LABELS[mask.status],
      reason: mask.reason,
      recommendation: mask.recommendation,
      additionalRecommendation: null,
    },
    {
      id: 'LAUNDRY',
      title: '빨래',
      statusLabel: LAUNDRY_STATUS_LABELS[laundry.status],
      reason: laundry.reason,
      recommendation: laundry.recommendation,
      additionalRecommendation: null,
    },
  ];
}
