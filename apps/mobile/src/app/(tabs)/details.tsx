import { useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { SavedLocationSwitcher } from '../../components/saved-location-switcher';
import {
  createMobileWeatherDetails,
  type MobileWeatherAlertCard,
  type MobileWeatherCurrentDetail,
  type MobileWeatherCurrentDetailId,
} from '../../details/create-mobile-weather-details';
import { mobileSavedLocationApplicationStore } from '../../locations/mobile-saved-location-application-production';
import type { SavedLocationApplicationSnapshot } from '../../locations/mobile-saved-location-application-store';
import { useMobileSavedLocations } from '../../locations/use-mobile-saved-locations';
import { mobileWeatherQueryStore } from '../../weather-query/mobile-weather-query-production';
import type { MobileWeatherQueryErrorPresentation } from '../../weather-query/mobile-weather-query-store';
import { useMobileWeatherQuery } from '../../weather-query/use-mobile-weather-query';

/** Decorative-only category glyph for the alert section. Severity is never derived from it. */
const ALERT_GLYPH = '⚠️';

/** Exhaustive, decorative glyph per current-condition detail id. No icon dependency. */
const CURRENT_DETAIL_GLYPHS: Record<MobileWeatherCurrentDetailId, string> = {
  FEELS_LIKE: '🌡️',
  HUMIDITY: '💧',
  WIND_SPEED: '💨',
  WIND_DIRECTION: '🧭',
  PRECIPITATION_LAST_HOUR: '🌧️',
  VISIBILITY: '👁️',
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
 * One AVAILABLE alert card: header (glyph / title / severity pill) → type → time information
 * (발표, and 발효/종료 only when non-null) → target areas → optional description.
 *
 * Every presenter value (`title`, `severityLabel`, `typeLabel`, the time labels, `areasLabel`,
 * `description`) is rendered verbatim, never truncated, re-derived, or given a developer-style
 * `key:` prefix. Severity colour is never invented from `severityLabel` text — every AVAILABLE
 * card shares one warm accent treatment, and severity stays visible as text either way.
 */
function renderAlertCard(card: MobileWeatherAlertCard, index: number) {
  return (
    <View key={`${card.title}-${index}`} style={styles.alertCard}>
      <View style={styles.alertCardHeader}>
        <Text style={styles.alertGlyph}>{ALERT_GLYPH}</Text>
        <Text accessibilityRole="header" style={styles.alertTitle}>
          {card.title}
        </Text>
        <View style={styles.severityPill}>
          <Text style={styles.severityPillText}>{card.severityLabel}</Text>
        </View>
      </View>

      <Text style={styles.alertType}>{card.typeLabel}</Text>

      <View style={styles.alertTimeBlock}>
        <View style={styles.alertTimeRow}>
          <Text style={styles.alertTimeLabel}>발표</Text>
          <Text style={styles.alertTimeValue}>{card.issuedAtLabel}</Text>
        </View>
        {card.effectiveAtLabel !== null ? (
          <View style={styles.alertTimeRow}>
            <Text style={styles.alertTimeLabel}>발효</Text>
            <Text style={styles.alertTimeValue}>{card.effectiveAtLabel}</Text>
          </View>
        ) : null}
        {card.expiresAtLabel !== null ? (
          <View style={styles.alertTimeRow}>
            <Text style={styles.alertTimeLabel}>종료</Text>
            <Text style={styles.alertTimeValue}>{card.expiresAtLabel}</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.alertBlock}>
        <Text style={styles.alertBlockLabel}>대상 지역</Text>
        <Text style={styles.alertBlockValue}>{card.areasLabel}</Text>
      </View>

      {card.description !== null ? (
        <View style={styles.alertBlock}>
          <Text style={styles.alertBlockLabel}>상세 안내</Text>
          <Text style={styles.alertBlockValue}>{card.description}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** One current-condition detail cell in the compact 2-column grid. `detail.text` stays verbatim. */
function renderCurrentDetail(detail: MobileWeatherCurrentDetail) {
  return (
    <View key={detail.id} style={styles.detailCell}>
      <Text style={styles.detailGlyph}>{CURRENT_DETAIL_GLYPHS[detail.id]}</Text>
      <Text style={styles.detailText}>{detail.text}</Text>
    </View>
  );
}

export default function DetailsScreen() {
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
            상세기상
          </Text>
          <SavedLocationSwitcher savedLocations={savedLocations} />
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
            <Text style={styles.cardBody}>지역을 추가하면 상세기상을 볼 수 있어요.</Text>
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
            <Text style={styles.cardBody}>상세기상을 준비하고 있습니다.</Text>
          </View>
        ) : null}

        {savedLocations.status === 'READY' && selectedLocation !== null ? (
          <>
            {weatherQuery.status === 'IDLE' ? (
              <View style={[styles.card, styles.cardCentered]}>
                <ActivityIndicator />
                <Text style={styles.cardBody}>상세기상을 준비하고 있습니다.</Text>
              </View>
            ) : null}

            {weatherQuery.status === 'LOADING' ? (
              <View style={[styles.card, styles.cardCentered]}>
                <ActivityIndicator />
                <Text style={styles.cardBody}>선택한 지역의 상세기상을 불러오는 중입니다.</Text>
              </View>
            ) : null}

            {weatherQuery.status === 'ERROR' ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>{describeWeatherError(weatherQuery.presentation)}</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="상세기상 다시 시도"
                  onPress={handleWeatherRetry}
                  style={styles.secondaryButton}
                >
                  <Text style={styles.secondaryButtonLabel}>다시 시도</Text>
                </Pressable>
              </View>
            ) : null}

            {weatherQuery.status === 'SUCCESS'
              ? (() => {
                  const details = createMobileWeatherDetails(
                    weatherQuery.data,
                    selectedLocation.timezone,
                  );

                  return (
                    <View style={styles.section}>
                      <View style={styles.subsection}>
                        <View style={styles.sectionHeaderRow}>
                          <Text style={styles.sectionGlyph}>{ALERT_GLYPH}</Text>
                          <Text accessibilityRole="header" style={styles.sectionTitle}>
                            기상특보
                          </Text>
                        </View>
                        {details.alerts.status === 'AVAILABLE' ? (
                          <View style={styles.section}>{details.alerts.cards.map(renderAlertCard)}</View>
                        ) : (
                          <View style={styles.card}>
                            <Text style={styles.cardBody}>{details.alerts.message}</Text>
                          </View>
                        )}
                      </View>

                      <View style={styles.subsection}>
                        <Text accessibilityRole="header" style={styles.sectionTitle}>
                          현재 관측
                        </Text>
                        {details.current.status === 'AVAILABLE' ? (
                          <View style={styles.card}>
                            <View style={styles.currentHero}>
                              <Text style={styles.currentCondition}>{details.current.conditionLabel}</Text>
                              <Text style={styles.currentTemperature}>{details.current.temperatureLabel}</Text>
                              <Text style={styles.currentObservedAt}>
                                {`관측 ${details.current.observedAtLabel}`}
                              </Text>
                            </View>
                            {details.current.details.length > 0 ? (
                              <View style={styles.detailGrid}>
                                {details.current.details.map(renderCurrentDetail)}
                              </View>
                            ) : null}
                          </View>
                        ) : (
                          <View style={styles.card}>
                            <Text style={styles.cardBody}>{details.current.message}</Text>
                          </View>
                        )}
                      </View>
                    </View>
                  );
                })()
              : null}
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
const ALERT_BACKGROUND = '#FFF8EF';
const ALERT_BORDER = '#F2C89B';
const ALERT_ACCENT = '#92400E';
const ALERT_PILL_BACKGROUND = '#FCEEDD';
const DETAIL_CELL_BACKGROUND = '#F4F7FC';
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
    flexShrink: 1,
    flexWrap: 'wrap',
  },
  cardBody: {
    fontSize: 14,
    color: TEXT_SECONDARY,
    flexShrink: 1,
    flexWrap: 'wrap',
  },
  primaryButton: {
    minHeight: 48,
    minWidth: 48,
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
  subsection: {
    gap: 10,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  sectionGlyph: {
    fontSize: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: TEXT_PRIMARY,
  },
  alertCard: {
    backgroundColor: ALERT_BACKGROUND,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: ALERT_BORDER,
    padding: 16,
    gap: 12,
  },
  alertCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  alertGlyph: {
    fontSize: 18,
  },
  alertTitle: {
    flex: 1,
    fontSize: 17,
    fontWeight: '700',
    color: TEXT_PRIMARY,
    flexShrink: 1,
    flexWrap: 'wrap',
  },
  severityPill: {
    backgroundColor: ALERT_PILL_BACKGROUND,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
    flexShrink: 1,
  },
  severityPillText: {
    fontSize: 13,
    fontWeight: '700',
    color: ALERT_ACCENT,
  },
  alertType: {
    fontSize: 14,
    fontWeight: '600',
    color: ALERT_ACCENT,
  },
  alertTimeBlock: {
    gap: 4,
  },
  alertTimeRow: {
    flexDirection: 'row',
    gap: 8,
  },
  alertTimeLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: TEXT_SECONDARY,
    width: 36,
  },
  alertTimeValue: {
    flex: 1,
    fontSize: 13,
    color: TEXT_PRIMARY,
    flexShrink: 1,
    flexWrap: 'wrap',
  },
  alertBlock: {
    gap: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: DIVIDER_COLOR,
    paddingTop: 10,
  },
  alertBlockLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: TEXT_SECONDARY,
  },
  alertBlockValue: {
    fontSize: 14,
    lineHeight: 21,
    color: TEXT_PRIMARY,
    flexShrink: 1,
    flexWrap: 'wrap',
  },
  currentHero: {
    alignItems: 'flex-start',
    gap: 4,
  },
  currentCondition: {
    fontSize: 16,
    fontWeight: '600',
    color: TEXT_SECONDARY,
  },
  currentTemperature: {
    fontSize: 44,
    fontWeight: '700',
    color: TEXT_PRIMARY,
  },
  currentObservedAt: {
    fontSize: 13,
    color: TEXT_SECONDARY,
  },
  detailGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 14,
  },
  detailCell: {
    width: '47%',
    flexGrow: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: DETAIL_CELL_BACKGROUND,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  detailGlyph: {
    fontSize: 16,
  },
  detailText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: TEXT_PRIMARY,
    flexShrink: 1,
    flexWrap: 'wrap',
  },
});
