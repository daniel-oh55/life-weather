import type { HourlyForecast, WeatherCondition } from '@life-weather/contracts';
import { useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { mobileSavedLocationApplicationStore } from '../../locations/mobile-saved-location-application-production';
import type { SavedLocationApplicationSnapshot } from '../../locations/mobile-saved-location-application-store';
import { useMobileSavedLocations } from '../../locations/use-mobile-saved-locations';
import { mobileWeatherQueryStore } from '../../weather-query/mobile-weather-query-production';
import type { MobileWeatherQueryErrorPresentation } from '../../weather-query/mobile-weather-query-store';
import { useMobileWeatherQuery } from '../../weather-query/use-mobile-weather-query';

/** Exhaustive Korean label per shared `WeatherCondition` value. Never a provider-native string. */
const CONDITION_LABELS: Record<WeatherCondition, string> = {
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
};

/** Exhaustive, provider-neutral glyph per shared `WeatherCondition` value. No icon dependency. */
const CONDITION_EMOJI: Record<WeatherCondition, string> = {
  CLEAR: '☀️',
  PARTLY_CLOUDY: '🌤️',
  CLOUDY: '☁️',
  RAIN: '🌧️',
  SNOW: '🌨️',
  SLEET: '🌧️❄️',
  SHOWER: '🌦️',
  THUNDERSTORM: '⛈️',
  FOG: '🌫️',
  UNKNOWN: '❓',
};

/** Fixed, safe copy per weather-query error presentation. No raw kind/message/URL/id. */
function describeWeatherError(presentation: MobileWeatherQueryErrorPresentation): string {
  switch (presentation) {
    case 'CONFIGURATION':
      return '날씨 서비스를 준비하지 못했습니다.';
    case 'NETWORK':
      return '날씨 정보를 불러오지 못했습니다. 네트워크 연결을 확인해 주세요.';
    case 'API':
      return '날씨 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.';
    case 'INVALID_RESPONSE':
      return '날씨 정보를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.';
  }
}

/** Fixed loading copy for the saved-location boundary's three non-terminal states. */
function describeSavedLocationsLoading(
  status: Extract<
    SavedLocationApplicationSnapshot['status'],
    'NOT_STARTED' | 'LOADING' | 'SELECTION_LOADING'
  >,
): string {
  return status === 'SELECTION_LOADING'
    ? '선택 지역을 준비하는 중입니다.'
    : '저장된 지역을 불러오는 중입니다.';
}

function datePart(parts: readonly Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPart['type']): string {
  return parts.find((part) => part.type === type)?.value ?? '';
}

/**
 * Deterministic local calendar-date key (`YYYY-MM-DD`) for `forecastAt` in `timeZone`, computed
 * independently of any display text, or `null` if the formatter fails (e.g. an invalid timezone).
 */
function localDateKey(forecastAt: string, timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(forecastAt));
    const year = datePart(parts, 'year');
    const month = datePart(parts, 'month');
    const day = datePart(parts, 'day');
    return year !== '' && month !== '' && day !== '' ? `${year}-${month}-${day}` : null;
  } catch {
    return null;
  }
}

/** Local calendar-date heading, e.g. "8월 25일 (화)". Falls back to the raw ISO string on failure. */
function localDateLabel(forecastAt: string, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('ko-KR', {
      timeZone,
      month: 'numeric',
      day: 'numeric',
      weekday: 'short',
    }).formatToParts(new Date(forecastAt));
    const month = datePart(parts, 'month');
    const day = datePart(parts, 'day');
    const weekday = datePart(parts, 'weekday');
    return month !== '' && day !== '' && weekday !== '' ? `${month}월 ${day}일 (${weekday})` : forecastAt;
  } catch {
    return forecastAt;
  }
}

/** Local `HH:mm`. Falls back to the raw ISO string on failure. */
function localTime(forecastAt: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('ko-KR', {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(forecastAt));
  } catch {
    return forecastAt;
  }
}

interface HourlyDateGroup {
  readonly dateKey: string;
  readonly dateLabel: string;
  readonly entries: readonly { readonly item: HourlyForecast; readonly index: number }[];
}

/**
 * Groups hourly entries by calendar date in `timeZone`, preserving the original contract order
 * both across and within groups (no sort/dedupe). The date key is computed independently of the
 * display label so a label-formatting quirk never affects grouping. If the timezone is invalid,
 * each entry falls back to its own group (keyed by index) instead of crashing or silently
 * merging distinct days.
 */
function groupHourlyByLocalDate(hourly: readonly HourlyForecast[], timeZone: string): HourlyDateGroup[] {
  const groups: { dateKey: string; dateLabel: string; entries: { item: HourlyForecast; index: number }[] }[] = [];
  const groupIndexByKey = new Map<string, number>();

  hourly.forEach((item, index) => {
    const key = localDateKey(item.forecastAt, timeZone) ?? `__unresolved_${index}`;
    let groupIndex = groupIndexByKey.get(key);
    if (groupIndex === undefined) {
      groupIndex = groups.length;
      groupIndexByKey.set(key, groupIndex);
      groups.push({ dateKey: key, dateLabel: localDateLabel(item.forecastAt, timeZone), entries: [] });
    }
    groups[groupIndex].entries.push({ item, index });
  });

  return groups;
}

/** Optional detail-pill texts for one hourly entry, in a fixed order. `null` is omitted, `0` is shown. */
function hourlyDetailTexts(item: HourlyForecast): string[] {
  const details: string[] = [];
  if (item.feelsLikeCelsius !== null) details.push(`체감 ${item.feelsLikeCelsius}°`);
  if (item.precipitationProbabilityPercent !== null) details.push(`강수 ${item.precipitationProbabilityPercent}%`);
  if (item.precipitationAmountMillimeters !== null) details.push(`강수량 ${item.precipitationAmountMillimeters}mm`);
  if (item.snowfallAmountCentimeters !== null) details.push(`적설 ${item.snowfallAmountCentimeters}cm`);
  if (item.humidityPercent !== null) details.push(`습도 ${item.humidityPercent}%`);
  if (item.windSpeedMetersPerSecond !== null) details.push(`바람 ${item.windSpeedMetersPerSecond}m/s`);
  if (item.windDirectionDegrees !== null) details.push(`풍향 ${item.windDirectionDegrees}°`);
  return details;
}

/** One compact hourly card: time / condition / temperature top row, then optional detail pills. */
function renderHourlyCard(entry: { item: HourlyForecast; index: number }, timeZone: string) {
  const { item, index } = entry;
  const details = hourlyDetailTexts(item);

  return (
    <View key={`${item.forecastAt}-${index}`} style={styles.hourlyCard}>
      <View style={styles.hourlyCardTopRow}>
        <Text style={styles.hourlyCardTime}>{localTime(item.forecastAt, timeZone)}</Text>
        <View style={styles.hourlyCardConditionGroup}>
          <Text style={styles.hourlyCardGlyph}>{CONDITION_EMOJI[item.condition]}</Text>
          <Text style={styles.hourlyCardConditionLabel} numberOfLines={1}>
            {CONDITION_LABELS[item.condition]}
          </Text>
        </View>
        <Text style={styles.hourlyCardTemperature}>{`${item.temperatureCelsius}°`}</Text>
      </View>
      {details.length > 0 ? (
        <View style={styles.hourlyDetailRow}>
          {details.map((detail) => (
            <View key={detail} style={styles.hourlyDetailPill}>
              <Text style={styles.hourlyDetailPillText}>{detail}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function renderDateGroup(group: HourlyDateGroup, timeZone: string) {
  return (
    <View key={group.dateKey} style={styles.dateGroup}>
      <Text accessibilityRole="header" style={styles.dateGroupHeading}>
        {group.dateLabel}
      </Text>
      <View style={styles.dateGroupCards}>{group.entries.map((entry) => renderHourlyCard(entry, timeZone))}</View>
    </View>
  );
}

export default function HourlyScreen() {
  const router = useRouter();
  const savedLocations = useMobileSavedLocations();
  const weatherQuery = useMobileWeatherQuery(savedLocations);

  const selectedLocation =
    savedLocations.status === 'READY'
      ? (savedLocations.locations.find(
          (location) => location.id === savedLocations.selectedLocationId,
        ) ?? null)
      : null;

  function handleAddLocation(): void {
    router.push('/locations');
  }

  function handleSavedLocationsRetry(): void {
    void mobileSavedLocationApplicationStore.retryInitialization();
  }

  function handleWeatherRetry(): void {
    mobileWeatherQueryStore.retry();
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.scrollContent}>
      <View style={styles.page}>
        <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.headerTitle}>
            시간별
          </Text>
          {savedLocations.status === 'READY' && selectedLocation !== null ? (
            <Text style={styles.headerLocation} numberOfLines={1}>
              {selectedLocation.displayName}
            </Text>
          ) : null}
        </View>

        {savedLocations.status === 'NOT_STARTED' ||
        savedLocations.status === 'LOADING' ||
        savedLocations.status === 'SELECTION_LOADING' ? (
          <View style={[styles.card, styles.cardCentered]}>
            <ActivityIndicator />
            <Text style={styles.cardBody}>{describeSavedLocationsLoading(savedLocations.status)}</Text>
          </View>
        ) : null}

        {savedLocations.status === 'ERROR' ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>저장된 지역을 불러오지 못했습니다.</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="저장 지역 다시 불러오기"
              onPress={handleSavedLocationsRetry}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonLabel}>다시 시도</Text>
            </Pressable>
          </View>
        ) : null}

        {savedLocations.status === 'EMPTY' ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>저장된 지역이 없습니다.</Text>
            <Text style={styles.cardBody}>지역을 추가하면 시간별 날씨를 볼 수 있어요.</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="지역 추가"
              onPress={handleAddLocation}
              style={styles.primaryButton}
            >
              <Text style={styles.primaryButtonLabel}>지역 추가</Text>
            </Pressable>
          </View>
        ) : null}

        {savedLocations.status === 'READY' && selectedLocation === null ? (
          <View style={[styles.card, styles.cardCentered]}>
            <ActivityIndicator />
            <Text style={styles.cardBody}>시간별 날씨를 준비하고 있습니다.</Text>
          </View>
        ) : null}

        {savedLocations.status === 'READY' && selectedLocation !== null ? (
          <>
            {weatherQuery.status === 'IDLE' || weatherQuery.status === 'LOADING' ? (
              <View style={[styles.card, styles.cardCentered]}>
                <ActivityIndicator />
                <Text style={styles.cardBody}>선택한 지역의 시간별 날씨를 불러오는 중입니다.</Text>
              </View>
            ) : null}

            {weatherQuery.status === 'ERROR' ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>{describeWeatherError(weatherQuery.presentation)}</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="시간별 날씨 다시 시도"
                  onPress={handleWeatherRetry}
                  style={styles.secondaryButton}
                >
                  <Text style={styles.secondaryButtonLabel}>다시 시도</Text>
                </Pressable>
              </View>
            ) : null}

            {weatherQuery.status === 'SUCCESS' ? (
              weatherQuery.data.data.hourly.length === 0 ? (
                <View style={styles.card}>
                  <Text style={styles.cardBody}>표시할 시간별 예보가 없습니다.</Text>
                </View>
              ) : (
                <View style={styles.section}>
                  {groupHourlyByLocalDate(weatherQuery.data.data.hourly, selectedLocation.timezone).map((group) =>
                    renderDateGroup(group, selectedLocation.timezone),
                  )}
                </View>
              )
            ) : null}
          </>
        ) : null}
      </View>
    </ScrollView>
  );
}

const PAGE_BACKGROUND = '#EEF2F7';
const CARD_BACKGROUND = '#FFFFFF';
const TEXT_PRIMARY = '#16202B';
const TEXT_SECONDARY = '#5B6472';
const BORDER_COLOR = '#E1E7EF';
const ACCENT_COLOR = '#2F6FED';
const PILL_BACKGROUND = '#EEF2F7';
const PILL_TEXT = '#33404E';

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: PAGE_BACKGROUND,
  },
  scrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    paddingTop: 20,
    paddingBottom: 96,
  },
  page: {
    width: '100%',
    maxWidth: 480,
    paddingHorizontal: 18,
    gap: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerTitle: {
    fontSize: 26,
    fontWeight: '700',
    color: TEXT_PRIMARY,
  },
  headerLocation: {
    fontSize: 15,
    color: TEXT_SECONDARY,
    flexShrink: 1,
    marginLeft: 12,
  },
  card: {
    backgroundColor: CARD_BACKGROUND,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: BORDER_COLOR,
    padding: 16,
    gap: 10,
  },
  cardCentered: {
    alignItems: 'center',
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: TEXT_PRIMARY,
  },
  cardBody: {
    fontSize: 14,
    color: TEXT_SECONDARY,
  },
  primaryButton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ACCENT_COLOR,
    borderRadius: 10,
    paddingHorizontal: 20,
    alignSelf: 'flex-start',
  },
  primaryButtonLabel: {
    fontSize: 15,
    color: '#FFFFFF',
    fontWeight: '600',
  },
  secondaryButton: {
    minHeight: 48,
    minWidth: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ACCENT_COLOR,
    borderRadius: 10,
    paddingHorizontal: 16,
    alignSelf: 'flex-start',
  },
  secondaryButtonLabel: {
    fontSize: 14,
    color: ACCENT_COLOR,
    fontWeight: '600',
  },
  section: {
    gap: 20,
  },
  dateGroup: {
    gap: 10,
  },
  dateGroupHeading: {
    fontSize: 16,
    fontWeight: '700',
    color: TEXT_PRIMARY,
  },
  dateGroupCards: {
    gap: 10,
  },
  hourlyCard: {
    backgroundColor: CARD_BACKGROUND,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: BORDER_COLOR,
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 8,
  },
  hourlyCardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  hourlyCardTime: {
    fontSize: 15,
    fontWeight: '600',
    color: TEXT_PRIMARY,
    minWidth: 48,
  },
  hourlyCardConditionGroup: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  hourlyCardGlyph: {
    fontSize: 18,
  },
  hourlyCardConditionLabel: {
    flexShrink: 1,
    fontSize: 14,
    color: TEXT_SECONDARY,
  },
  hourlyCardTemperature: {
    fontSize: 20,
    fontWeight: '700',
    color: TEXT_PRIMARY,
  },
  hourlyDetailRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  hourlyDetailPill: {
    backgroundColor: PILL_BACKGROUND,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  hourlyDetailPillText: {
    fontSize: 12,
    color: PILL_TEXT,
    fontWeight: '600',
  },
});
