import type {
  CurrentAirQuality,
  HourlyForecast,
  AirQualityGrade,
  WeatherCondition,
} from '@life-weather/contracts';
import { useState } from 'react';
import { useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  createMobileLifestyleOverview,
  type MobileLifestyleCard,
  type MobileLifestyleCardId,
} from '../../lifestyle/create-mobile-lifestyle-overview';
import { mobileSavedLocationApplicationStore } from '../../locations/mobile-saved-location-application-production';
import type { SavedLocationApplicationSnapshot } from '../../locations/mobile-saved-location-application-store';
import { useMobileSavedLocations } from '../../locations/use-mobile-saved-locations';
import { mobileWeatherQueryStore } from '../../weather-query/mobile-weather-query-production';
import type {
  MobileWeatherQueryErrorPresentation,
  MobileWeatherQuerySnapshot,
} from '../../weather-query/mobile-weather-query-store';
import { useMobileWeatherQuery } from '../../weather-query/use-mobile-weather-query';

/** How many upcoming hourly entries the Today preview shows. The Hourly tab owns the full list. */
const HOURLY_PREVIEW_LIMIT = 6;

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

/** Exhaustive, provider-neutral glyph per shared `WeatherCondition` value. */
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

/** Exhaustive Korean label per shared `AirQualityGrade` value. Never a provider-native code. */
const AIR_QUALITY_GRADE_LABELS: Record<AirQualityGrade, string> = {
  GOOD: '좋음',
  MODERATE: '보통',
  BAD: '나쁨',
  VERY_BAD: '매우 나쁨',
  UNKNOWN: '확인 불가',
};

/** Exhaustive glyph per fixed lifestyle card id. */
const LIFESTYLE_GLYPHS: Record<MobileLifestyleCardId, string> = {
  UMBRELLA: '☂️',
  OUTFIT: '👕',
  MASK: '😷',
  LAUNDRY: '🧺',
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

/**
 * The compact air-quality pill's text, or `null` when nothing real is available. Never fabricates
 * a grade: `overallGrade` is preferred, and only when it is `null` does a present CAI value show.
 */
function describeAirQualityPill(airQuality: CurrentAirQuality): string | null {
  if (airQuality.overallGrade !== null) {
    return AIR_QUALITY_GRADE_LABELS[airQuality.overallGrade];
  }
  if (airQuality.comprehensiveAirQualityIndex !== null) {
    return `CAI ${airQuality.comprehensiveAirQualityIndex}`;
  }
  return null;
}

/** Format an ISO instant as `HH:mm` in the given saved location's own timezone — never device. */
function formatHourlyPreviewTime(forecastAt: string, timeZone: string): string {
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

/** The current-weather hero card, covering every `weatherQuery` state including degraded SUCCESS. */
function renderHero(weatherQuery: MobileWeatherQuerySnapshot, onRetry: () => void) {
  if (weatherQuery.status === 'IDLE' || weatherQuery.status === 'LOADING') {
    return (
      <View style={[styles.hero, styles.heroCentered]}>
        <ActivityIndicator color="#FFFFFF" />
        <Text style={styles.heroStatusText}>날씨 정보를 불러오는 중입니다.</Text>
      </View>
    );
  }

  if (weatherQuery.status === 'ERROR') {
    return (
      <View style={[styles.hero, styles.heroCentered]}>
        <Text style={styles.heroStatusText}>{describeWeatherError(weatherQuery.presentation)}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="날씨 다시 시도"
          onPress={onRetry}
          style={styles.heroRetryButton}
        >
          <Text style={styles.heroRetryButtonLabel}>다시 시도</Text>
        </Pressable>
      </View>
    );
  }

  const current = weatherQuery.data.data.current;
  if (current === null) {
    return (
      <View style={[styles.hero, styles.heroCentered]}>
        <Text style={styles.heroStatusText}>현재 관측 정보를 확인할 수 없습니다.</Text>
      </View>
    );
  }

  const airQuality = weatherQuery.data.data.airQuality.current;
  const airQualityPillText = airQuality !== null ? describeAirQualityPill(airQuality) : null;

  return (
    <View style={styles.hero}>
      <View style={styles.heroTopRow}>
        <Text style={styles.heroGlyph}>{CONDITION_EMOJI[current.condition]}</Text>
        <Text style={styles.heroTemperature}>{`${current.temperatureCelsius}°`}</Text>
      </View>
      <Text style={styles.heroConditionLabel}>{CONDITION_LABELS[current.condition]}</Text>
      <View style={styles.heroDetailRow}>
        {current.feelsLikeCelsius !== null ? (
          <Text style={styles.heroDetailText}>{`체감 ${current.feelsLikeCelsius}°C`}</Text>
        ) : null}
        {current.humidityPercent !== null ? (
          <Text style={styles.heroDetailText}>{`습도 ${current.humidityPercent}%`}</Text>
        ) : null}
        {current.windSpeedMetersPerSecond !== null ? (
          <Text style={styles.heroDetailText}>{`풍속 ${current.windSpeedMetersPerSecond}m/s`}</Text>
        ) : null}
      </View>
      {airQualityPillText !== null ? (
        <View style={styles.airQualityPill}>
          <Text style={styles.airQualityPillText}>{airQualityPillText}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** One lifestyle card: glyph, title, status pill, then the engine's own reason copy. */
function renderLifestyleCard(card: MobileLifestyleCard) {
  return (
    <View key={card.id} style={styles.lifestyleCard}>
      <Text style={styles.lifestyleGlyph}>{LIFESTYLE_GLYPHS[card.id]}</Text>
      <Text style={styles.lifestyleTitle}>{card.title}</Text>
      <View style={styles.lifestylePill}>
        <Text style={styles.lifestylePillText}>{card.statusLabel}</Text>
      </View>
      <Text style={styles.lifestyleReason}>{card.reason}</Text>
    </View>
  );
}

/** One compact hourly-preview item: local time, condition glyph, temperature, precipitation. */
function renderHourlyPreviewItem(item: HourlyForecast, index: number, timeZone: string) {
  return (
    <View key={`${item.forecastAt}-${index}`} style={styles.hourlyPreviewItem}>
      <Text style={styles.hourlyPreviewTime}>{formatHourlyPreviewTime(item.forecastAt, timeZone)}</Text>
      <Text style={styles.hourlyPreviewGlyph}>{CONDITION_EMOJI[item.condition]}</Text>
      <Text style={styles.hourlyPreviewTemperature}>{`${item.temperatureCelsius}°`}</Text>
      {item.precipitationProbabilityPercent !== null ? (
        <Text style={styles.hourlyPreviewDetail}>{`${item.precipitationProbabilityPercent}%`}</Text>
      ) : null}
    </View>
  );
}

export default function HomeScreen() {
  const router = useRouter();
  const savedLocations = useMobileSavedLocations();
  const weatherQuery = useMobileWeatherQuery(savedLocations);
  // Whether the *last* dispatched mutation failed. Kept local to the screen rather than in the
  // store's snapshot: it is presentation state for one generic message, not shared app state.
  const [writeFailed, setWriteFailed] = useState(false);

  const isSaving = savedLocations.writeStatus === 'SAVING';
  const selectedLocation =
    savedLocations.status === 'READY'
      ? (savedLocations.locations.find(
          (location) => location.id === savedLocations.selectedLocationId,
        ) ?? null)
      : null;

  function handleWeatherRetry(): void {
    mobileWeatherQueryStore.retry();
  }

  // Explicit, user-initiated retry only — no timer, no backoff, no automatic retry. A repeated tap
  // cannot start a second load: the button exists only in ERROR, and the store's retryInitialization
  // routes to whichever boundary (saved-location hydration or selected-location initialization) is
  // actually failing, joining its single-flight in-progress read instead of restarting it.
  function handleRetry(): void {
    void mobileSavedLocationApplicationStore.retryInitialization();
  }

  async function handleSelect(locationId: string): Promise<void> {
    setWriteFailed(false);
    const result = await mobileSavedLocationApplicationStore.select(locationId);
    setWriteFailed(!result.ok);
  }

  async function handleRemove(locationId: string): Promise<void> {
    setWriteFailed(false);
    const result = await mobileSavedLocationApplicationStore.remove(locationId);
    setWriteFailed(!result.ok);
  }

  function handleAddLocation(): void {
    router.push('/locations');
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.scrollContent}>
      <View style={styles.page}>
        <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.headerTitle}>
            오늘
          </Text>
          {selectedLocation !== null ? (
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
              onPress={handleRetry}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonLabel}>다시 시도</Text>
            </Pressable>
          </View>
        ) : null}

        {savedLocations.status === 'EMPTY' ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>저장된 지역이 없습니다.</Text>
            <Text style={styles.cardBody}>지역을 추가하면 오늘의 날씨를 볼 수 있어요.</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="지역 추가"
              disabled={isSaving}
              onPress={handleAddLocation}
              style={styles.primaryButton}
            >
              <Text style={styles.primaryButtonLabel}>지역 추가</Text>
            </Pressable>
          </View>
        ) : null}

        {savedLocations.status === 'READY' && selectedLocation !== null ? (
          <>
            {renderHero(weatherQuery, handleWeatherRetry)}

            {weatherQuery.status === 'SUCCESS' ? (
              <View style={styles.section}>
                <Text accessibilityRole="header" style={styles.sectionTitle}>
                  생활 한눈에
                </Text>
                <View style={styles.lifestyleGrid}>
                  {createMobileLifestyleOverview(weatherQuery.data).map(renderLifestyleCard)}
                </View>
              </View>
            ) : null}

            {weatherQuery.status === 'SUCCESS' ? (
              <View style={styles.section}>
                <Text accessibilityRole="header" style={styles.sectionTitle}>
                  시간별
                </Text>
                {weatherQuery.data.data.hourly.length === 0 ? (
                  <Text style={styles.cardBody}>표시할 시간별 예보가 없습니다.</Text>
                ) : (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.hourlyPreviewRow}
                  >
                    {weatherQuery.data.data.hourly
                      .slice(0, HOURLY_PREVIEW_LIMIT)
                      .map((item, index) =>
                        renderHourlyPreviewItem(item, index, selectedLocation.timezone),
                      )}
                  </ScrollView>
                )}
              </View>
            ) : null}
          </>
        ) : null}

        {savedLocations.status === 'READY' ? (
          <View style={styles.section}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>
              저장 지역
            </Text>
            <View style={styles.card}>
              {savedLocations.locations.map((location) => {
                const isSelected = location.id === savedLocations.selectedLocationId;
                const selectDisabled = isSelected || isSaving;
                return (
                  <View key={location.id} style={styles.locationRow}>
                    <Text style={styles.locationRowLabel} numberOfLines={1}>
                      {location.displayName}
                    </Text>
                    <View style={styles.locationRowActions}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={
                          isSelected ? `${location.displayName} 선택됨` : `${location.displayName} 선택`
                        }
                        accessibilityState={{ selected: isSelected, disabled: selectDisabled }}
                        disabled={selectDisabled}
                        onPress={() => {
                          void handleSelect(location.id);
                        }}
                        style={styles.smallButton}
                      >
                        <Text style={styles.smallButtonLabel}>{isSelected ? '선택됨' : '선택'}</Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${location.displayName} 삭제`}
                        disabled={isSaving}
                        onPress={() => {
                          void handleRemove(location.id);
                        }}
                        style={styles.smallButton}
                      >
                        <Text style={styles.smallButtonLabel}>삭제</Text>
                      </Pressable>
                    </View>
                  </View>
                );
              })}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="지역 추가"
                disabled={isSaving}
                onPress={handleAddLocation}
                style={styles.secondaryButton}
              >
                <Text style={styles.secondaryButtonLabel}>지역 추가</Text>
              </Pressable>
            </View>
            {writeFailed ? (
              <Text style={styles.errorText}>저장 지역 변경을 저장하지 못했습니다.</Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}

const PAGE_BACKGROUND = '#EEF2F7';
const CARD_BACKGROUND = '#FFFFFF';
const HERO_BACKGROUND = '#4A90D9';
const TEXT_PRIMARY = '#16202B';
const TEXT_SECONDARY = '#5B6472';
const TEXT_ON_HERO = '#FFFFFF';
const BORDER_COLOR = '#E1E7EF';
const ACCENT_COLOR = '#2F6FED';
const PILL_BACKGROUND = '#EEF2F7';
const PILL_TEXT = '#33404E';
const ERROR_COLOR = '#B3261E';

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: PAGE_BACKGROUND,
  },
  scrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    paddingVertical: 20,
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
  errorText: {
    fontSize: 13,
    color: ERROR_COLOR,
  },
  hero: {
    backgroundColor: HERO_BACKGROUND,
    borderRadius: 22,
    padding: 20,
    gap: 8,
  },
  heroCentered: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 120,
  },
  heroTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  heroGlyph: {
    fontSize: 36,
  },
  heroTemperature: {
    fontSize: 48,
    fontWeight: '700',
    color: TEXT_ON_HERO,
  },
  heroConditionLabel: {
    fontSize: 16,
    color: TEXT_ON_HERO,
  },
  heroDetailRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  heroDetailText: {
    fontSize: 14,
    color: TEXT_ON_HERO,
  },
  heroStatusText: {
    fontSize: 15,
    color: TEXT_ON_HERO,
    textAlign: 'center',
  },
  heroRetryButton: {
    minHeight: 48,
    minWidth: 48,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: 10,
  },
  heroRetryButtonLabel: {
    fontSize: 15,
    color: TEXT_ON_HERO,
    fontWeight: '600',
  },
  airQualityPill: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,255,255,0.25)',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  airQualityPillText: {
    fontSize: 13,
    color: TEXT_ON_HERO,
    fontWeight: '600',
  },
  section: {
    gap: 10,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: TEXT_PRIMARY,
  },
  lifestyleGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  lifestyleCard: {
    flexBasis: '47%',
    flexGrow: 1,
    backgroundColor: CARD_BACKGROUND,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: BORDER_COLOR,
    padding: 12,
    gap: 6,
  },
  lifestyleGlyph: {
    fontSize: 22,
  },
  lifestyleTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: TEXT_PRIMARY,
  },
  lifestylePill: {
    alignSelf: 'flex-start',
    backgroundColor: PILL_BACKGROUND,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  lifestylePillText: {
    fontSize: 12,
    color: PILL_TEXT,
    fontWeight: '600',
  },
  lifestyleReason: {
    fontSize: 13,
    color: TEXT_SECONDARY,
    flexShrink: 1,
    flexWrap: 'wrap',
  },
  hourlyPreviewRow: {
    flexDirection: 'row',
    gap: 10,
  },
  hourlyPreviewItem: {
    backgroundColor: CARD_BACKGROUND,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: BORDER_COLOR,
    paddingVertical: 12,
    paddingHorizontal: 10,
    alignItems: 'center',
    gap: 4,
    minWidth: 64,
  },
  hourlyPreviewTime: {
    fontSize: 12,
    color: TEXT_SECONDARY,
  },
  hourlyPreviewGlyph: {
    fontSize: 20,
  },
  hourlyPreviewTemperature: {
    fontSize: 15,
    fontWeight: '600',
    color: TEXT_PRIMARY,
  },
  hourlyPreviewDetail: {
    fontSize: 11,
    color: ACCENT_COLOR,
  },
  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: BORDER_COLOR,
  },
  locationRowLabel: {
    flexShrink: 1,
    fontSize: 15,
    color: TEXT_PRIMARY,
  },
  locationRowActions: {
    flexDirection: 'row',
    gap: 8,
  },
  smallButton: {
    minHeight: 48,
    minWidth: 48,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallButtonLabel: {
    fontSize: 14,
    color: ACCENT_COLOR,
    fontWeight: '600',
  },
});
