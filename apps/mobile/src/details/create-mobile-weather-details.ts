/**
 * Pure mobile presentation boundary connecting a validated `WeatherSuccessResponseV1` to the
 * Details screen's alert-first / current-second content.
 *
 * This module is pure TypeScript: no React/React Native import, no Expo Router, no storage, no
 * network, no environment variable, no timer, no logging, and no mutation of its input. The only
 * clock-shaped operations are `new Date(timestamp)` on an ISO string already present in the
 * response and `Intl.DateTimeFormat` — both deterministic, never reading the system clock. This
 * boundary trusts the validated contract invariant between `data.current` / `data.alerts` and
 * `data.missingSections` (`packages/contracts/src/weather.ts`) rather than re-deriving it.
 *
 * See `docs/mobile-weather-details.md`.
 */

import type {
  WeatherAlert,
  WeatherAlertSeverity,
  WeatherAlertType,
  WeatherCondition,
  WeatherSuccessResponseV1,
} from '@life-weather/contracts';

/** Fixed, non-provider-native id for one optional current-condition detail line. */
export type MobileWeatherCurrentDetailId =
  | 'FEELS_LIKE'
  | 'HUMIDITY'
  | 'WIND_SPEED'
  | 'WIND_DIRECTION'
  | 'PRECIPITATION_LAST_HOUR'
  | 'VISIBILITY';

/** One optional current-condition detail line, ready for direct rendering. */
export interface MobileWeatherCurrentDetail {
  readonly id: MobileWeatherCurrentDetailId;
  readonly text: string;
}

/** Alert-availability status: `data.missingSections` includes `ALERTS`, or the alerts list itself. */
export type MobileWeatherAlertStatus = 'UNAVAILABLE' | 'NONE' | 'AVAILABLE';

/** One weather alert, mapped to display-ready Korean labels and text. */
export interface MobileWeatherAlertCard {
  readonly title: string;
  readonly severityLabel: string;
  readonly typeLabel: string;
  readonly issuedAtLabel: string;
  readonly effectiveAtLabel: string | null;
  readonly expiresAtLabel: string | null;
  readonly areasLabel: string;
  readonly description: string | null;
}

/** The alerts section of the presentation result. `alerts` is always rendered before `current`. */
export interface MobileWeatherAlertsPresentation {
  readonly status: MobileWeatherAlertStatus;
  readonly message: string | null;
  readonly cards: readonly MobileWeatherAlertCard[];
}

/** Current-condition availability status: whether `data.current` is present. */
export type MobileWeatherCurrentStatus = 'UNAVAILABLE' | 'AVAILABLE';

/** The current-conditions section of the presentation result. */
export type MobileWeatherCurrentPresentation =
  | { readonly status: 'UNAVAILABLE'; readonly message: string }
  | {
      readonly status: 'AVAILABLE';
      readonly message: null;
      readonly observedAtLabel: string;
      readonly conditionLabel: string;
      readonly temperatureLabel: string;
      readonly details: readonly MobileWeatherCurrentDetail[];
    };

/** The full Details-screen presentation result: alerts first, current second. */
export interface MobileWeatherDetailsPresentation {
  readonly alerts: MobileWeatherAlertsPresentation;
  readonly current: MobileWeatherCurrentPresentation;
}

const SEVERITY_LABELS: Readonly<Record<WeatherAlertSeverity, string>> = Object.freeze({
  INFO: '안내',
  ADVISORY: '주의보',
  WARNING: '경보',
  EMERGENCY: '긴급',
  UNKNOWN: '등급 미확인',
});

const ALERT_TYPE_LABELS: Readonly<Record<WeatherAlertType, string>> = Object.freeze({
  HEAVY_RAIN: '호우',
  HEAVY_SNOW: '대설',
  HIGH_WIND: '강풍',
  HIGH_SEAS: '풍랑',
  TYPHOON: '태풍',
  HEAT_WAVE: '폭염',
  COLD_WAVE: '한파',
  DRY: '건조',
  STORM_SURGE: '폭풍해일',
  YELLOW_DUST: '황사',
  FOG: '안개',
  THUNDERSTORM: '뇌우',
  OTHER: '기타',
});

const CONDITION_LABELS: Readonly<Record<WeatherCondition, string>> = Object.freeze({
  CLEAR: '맑음',
  PARTLY_CLOUDY: '구름 조금',
  CLOUDY: '흐림',
  RAIN: '비',
  SNOW: '눈',
  SLEET: '진눈깨비',
  SHOWER: '소나기',
  THUNDERSTORM: '천둥·번개',
  FOG: '안개',
  UNKNOWN: '상태 미확인',
});

const ALERTS_UNAVAILABLE_MESSAGE = '기상특보 정보를 제공하지 못했습니다.';
const ALERTS_NONE_MESSAGE = '현재 발표된 기상특보가 없습니다.';
const CURRENT_UNAVAILABLE_MESSAGE = '현재 관측 정보를 제공하지 못했습니다.';

function datePart(parts: readonly Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPart['type']): string {
  return parts.find((part) => part.type === type)?.value ?? '';
}

/**
 * Format an ISO instant in the given saved location's own timezone as e.g. "8월 5일 (수) 14:00".
 * Falls back to the raw ISO string on any formatter failure (an unexpected/invalid timezone or
 * unparsable instant) rather than throwing.
 */
function formatInstantLabel(isoTimestamp: string, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('ko-KR', {
      timeZone,
      month: 'numeric',
      day: 'numeric',
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(isoTimestamp));

    const month = datePart(parts, 'month');
    const day = datePart(parts, 'day');
    const weekday = datePart(parts, 'weekday');
    const hour = datePart(parts, 'hour');
    const minute = datePart(parts, 'minute');

    return `${month}월 ${day}일 (${weekday}) ${hour}:${minute}`;
  } catch {
    return isoTimestamp;
  }
}

function formatNullableInstantLabel(isoTimestamp: string | null, timeZone: string): string | null {
  return isoTimestamp === null ? null : formatInstantLabel(isoTimestamp, timeZone);
}

function buildAlertCard(alert: WeatherAlert, timeZone: string): MobileWeatherAlertCard {
  return {
    title: alert.title,
    severityLabel: SEVERITY_LABELS[alert.severity],
    typeLabel: ALERT_TYPE_LABELS[alert.type],
    issuedAtLabel: formatInstantLabel(alert.issuedAt, timeZone),
    effectiveAtLabel: formatNullableInstantLabel(alert.effectiveAt, timeZone),
    expiresAtLabel: formatNullableInstantLabel(alert.expiresAt, timeZone),
    areasLabel: alert.areas.join(', '),
    description: alert.description,
  };
}

function buildAlertsPresentation(
  response: WeatherSuccessResponseV1,
  timeZone: string,
): MobileWeatherAlertsPresentation {
  const alertsMissing = response.data.missingSections.includes('ALERTS');

  if (alertsMissing) {
    return { status: 'UNAVAILABLE', message: ALERTS_UNAVAILABLE_MESSAGE, cards: [] };
  }

  if (response.data.alerts.length === 0) {
    return { status: 'NONE', message: ALERTS_NONE_MESSAGE, cards: [] };
  }

  return {
    status: 'AVAILABLE',
    message: null,
    cards: response.data.alerts.map((alert) => buildAlertCard(alert, timeZone)),
  };
}

function buildCurrentDetails(current: NonNullable<WeatherSuccessResponseV1['data']['current']>): MobileWeatherCurrentDetail[] {
  const details: MobileWeatherCurrentDetail[] = [];

  if (current.feelsLikeCelsius !== null) {
    details.push({ id: 'FEELS_LIKE', text: `체감온도 ${current.feelsLikeCelsius}°C` });
  }
  if (current.humidityPercent !== null) {
    details.push({ id: 'HUMIDITY', text: `습도 ${current.humidityPercent}%` });
  }
  if (current.windSpeedMetersPerSecond !== null) {
    details.push({ id: 'WIND_SPEED', text: `풍속 ${current.windSpeedMetersPerSecond}m/s` });
  }
  if (current.windDirectionDegrees !== null) {
    details.push({ id: 'WIND_DIRECTION', text: `풍향 ${current.windDirectionDegrees}°` });
  }
  if (current.precipitationLastHourMillimeters !== null) {
    details.push({
      id: 'PRECIPITATION_LAST_HOUR',
      text: `최근 1시간 강수량 ${current.precipitationLastHourMillimeters}mm`,
    });
  }
  if (current.visibilityMeters !== null) {
    details.push({ id: 'VISIBILITY', text: `가시거리 ${current.visibilityMeters}m` });
  }

  return details;
}

function buildCurrentPresentation(
  response: WeatherSuccessResponseV1,
  timeZone: string,
): MobileWeatherCurrentPresentation {
  const current = response.data.current;

  if (current === null) {
    return { status: 'UNAVAILABLE', message: CURRENT_UNAVAILABLE_MESSAGE };
  }

  return {
    status: 'AVAILABLE',
    message: null,
    observedAtLabel: formatInstantLabel(current.observedAt, timeZone),
    conditionLabel: CONDITION_LABELS[current.condition],
    temperatureLabel: `${current.temperatureCelsius}°C`,
    details: buildCurrentDetails(current),
  };
}

/**
 * Build the Details-screen presentation (alerts first, current second) from a validated
 * `WeatherSuccessResponseV1` and the selected saved location's own IANA `timeZone`.
 *
 * Alert availability distinguishes `missingSections` containing `ALERTS` (`UNAVAILABLE`) from a
 * validated empty alert list (`NONE`) from one or more alerts (`AVAILABLE`, response order
 * preserved, no sort/filter/dedupe). Current-conditions availability distinguishes
 * `data.current === null` (`UNAVAILABLE`) from a present record (`AVAILABLE`, required fields
 * always shown, optional fields shown only when non-`null` — `0` is always shown). Neither
 * section is fabricated from `hourly` or `meta.generatedAt`.
 */
export function createMobileWeatherDetails(
  response: WeatherSuccessResponseV1,
  timeZone: string,
): MobileWeatherDetailsPresentation {
  return {
    alerts: buildAlertsPresentation(response, timeZone),
    current: buildCurrentPresentation(response, timeZone),
  };
}
