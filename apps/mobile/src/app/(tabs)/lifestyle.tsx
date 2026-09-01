import { useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { SavedLocationSwitcher } from '../../components/saved-location-switcher';
import { WeatherFreshnessNotice } from '../../components/weather-freshness-notice';
import {
  createMobileLifestyleOverview,
  type MobileLifestyleCard,
  type MobileLifestyleCardId,
} from '../../lifestyle/create-mobile-lifestyle-overview';
import { mobileSavedLocationApplicationStore } from '../../locations/mobile-saved-location-application-production';
import type { SavedLocationApplicationSnapshot } from '../../locations/mobile-saved-location-application-store';
import { useMobileSavedLocations } from '../../locations/use-mobile-saved-locations';
import { mobileWeatherQueryStore } from '../../weather-query/mobile-weather-query-production';
import type { MobileWeatherQueryErrorPresentation } from '../../weather-query/mobile-weather-query-store';
import { useMobileWeatherQuery } from '../../weather-query/use-mobile-weather-query';

/** Exhaustive, decorative glyph per fixed lifestyle card id. No icon dependency, no image asset. */
const LIFESTYLE_GLYPHS: Record<MobileLifestyleCardId, string> = {
  UMBRELLA: '☂️',
  OUTFIT: '👕',
  MASK: '😷',
  LAUNDRY: '🧺',
};

/** Static UI section labels — never generated advice. The engine owns every judgement string. */
const REASON_LABEL = '왜 이렇게 판단했나요';
const ACTION_LABEL = '이렇게 해보세요';
const ADDITIONAL_LABEL = '추가 안내';

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
 * One detailed lifestyle card: header (glyph / title / status pill) → reason block → action block
 * → optional additional-guidance block.
 *
 * Every judgement string (`statusLabel`, `reason`, `recommendation`, `additionalRecommendation`) is
 * the presenter's own copy, rendered verbatim: never truncated (`numberOfLines` is deliberately
 * absent), summarized, re-classified, or re-derived here. The card carries no underlying status
 * enum at this presentation boundary, so the pill keeps one consistent neutral style rather than
 * parsing Korean status text to invent semantic colors, and `판단 보류` renders like any other
 * status. `additionalRecommendation === null` renders no additional section at all.
 */
function renderLifestyleCard(card: MobileLifestyleCard) {
  return (
    <View key={card.id} style={styles.lifestyleCard}>
      <View style={styles.lifestyleCardHeader}>
        <Text style={styles.lifestyleGlyph}>{LIFESTYLE_GLYPHS[card.id]}</Text>
        <Text accessibilityRole="header" style={styles.lifestyleTitle}>
          {card.title}
        </Text>
        <View style={styles.statusPill}>
          <Text style={styles.statusPillText}>{card.statusLabel}</Text>
        </View>
      </View>

      <View style={styles.reasonBlock}>
        <Text style={styles.reasonLabel}>{REASON_LABEL}</Text>
        <Text style={styles.reasonBody}>{card.reason}</Text>
      </View>

      <View style={styles.actionBlock}>
        <Text style={styles.actionLabel}>{ACTION_LABEL}</Text>
        <Text style={styles.actionBody}>{card.recommendation}</Text>
      </View>

      {card.additionalRecommendation !== null ? (
        <View style={styles.additionalBlock}>
          <Text style={styles.additionalLabel}>{ADDITIONAL_LABEL}</Text>
          <Text style={styles.additionalBody}>{card.additionalRecommendation}</Text>
        </View>
      ) : null}
    </View>
  );
}

export default function LifestyleScreen() {
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

  function handleWeatherRefresh(): void {
    mobileWeatherQueryStore.refresh();
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.scrollContent}>
      <View style={styles.page}>
        <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.headerTitle}>
            생활날씨
          </Text>
          <SavedLocationSwitcher savedLocations={savedLocations} />
        </View>

        <Text style={styles.intro}>오늘 생활에 필요한 준비를 항목별로 확인하세요.</Text>

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
            <Text style={styles.cardBody}>지역을 추가하면 생활날씨를 볼 수 있어요.</Text>
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
            <Text style={styles.cardBody}>생활날씨를 준비하고 있습니다.</Text>
          </View>
        ) : null}

        {savedLocations.status === 'READY' && selectedLocation !== null ? (
          <>
            {weatherQuery.status === 'IDLE' ? (
              <View style={[styles.card, styles.cardCentered]}>
                <ActivityIndicator />
                <Text style={styles.cardBody}>생활날씨를 준비하고 있습니다.</Text>
              </View>
            ) : null}

            {weatherQuery.status === 'LOADING' ? (
              <View style={[styles.card, styles.cardCentered]}>
                <ActivityIndicator />
                <Text style={styles.cardBody}>선택한 지역의 생활날씨를 불러오는 중입니다.</Text>
              </View>
            ) : null}

            {weatherQuery.status === 'ERROR' ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>{describeWeatherError(weatherQuery.presentation)}</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="생활날씨 다시 시도"
                  onPress={handleWeatherRetry}
                  style={styles.secondaryButton}
                >
                  <Text style={styles.secondaryButtonLabel}>다시 시도</Text>
                </Pressable>
              </View>
            ) : null}

            {weatherQuery.status === 'SUCCESS' ? (
              <WeatherFreshnessNotice
                generatedAt={weatherQuery.data.meta.generatedAt}
                onRefresh={handleWeatherRefresh}
              />
            ) : null}

            {weatherQuery.status === 'SUCCESS' ? (
              <View style={styles.section}>
                {createMobileLifestyleOverview(weatherQuery.data).map(renderLifestyleCard)}
              </View>
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
const ACTION_BACKGROUND = '#F4F7FC';
const DIVIDER_COLOR = '#DCE4F0';

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
    gap: 14,
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
  intro: {
    fontSize: 14,
    color: TEXT_SECONDARY,
    marginTop: -6,
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
    gap: 14,
  },
  lifestyleCard: {
    backgroundColor: CARD_BACKGROUND,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: BORDER_COLOR,
    paddingVertical: 16,
    paddingHorizontal: 16,
    gap: 14,
  },
  lifestyleCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  lifestyleGlyph: {
    fontSize: 24,
  },
  lifestyleTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: '700',
    color: TEXT_PRIMARY,
  },
  statusPill: {
    backgroundColor: PILL_BACKGROUND,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
    flexShrink: 1,
  },
  statusPillText: {
    fontSize: 13,
    fontWeight: '700',
    color: PILL_TEXT,
  },
  reasonBlock: {
    gap: 4,
  },
  reasonLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: TEXT_SECONDARY,
  },
  reasonBody: {
    fontSize: 14,
    lineHeight: 21,
    color: TEXT_SECONDARY,
    flexShrink: 1,
    flexWrap: 'wrap',
  },
  actionBlock: {
    backgroundColor: ACTION_BACKGROUND,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    gap: 4,
  },
  actionLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: ACCENT_COLOR,
  },
  actionBody: {
    fontSize: 15,
    lineHeight: 23,
    fontWeight: '600',
    color: TEXT_PRIMARY,
    flexShrink: 1,
    flexWrap: 'wrap',
  },
  additionalBlock: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: DIVIDER_COLOR,
    paddingTop: 12,
    gap: 4,
  },
  additionalLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: TEXT_SECONDARY,
  },
  additionalBody: {
    fontSize: 14,
    lineHeight: 21,
    color: TEXT_PRIMARY,
    flexShrink: 1,
    flexWrap: 'wrap',
  },
});
