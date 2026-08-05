import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  createMobileWeatherDetails,
  type MobileWeatherAlertCard,
} from '../../details/create-mobile-weather-details';
import { mobileSavedLocationApplicationStore } from '../../locations/mobile-saved-location-application-production';
import { useMobileSavedLocations } from '../../locations/use-mobile-saved-locations';
import { mobileWeatherQueryStore } from '../../weather-query/mobile-weather-query-production';
import type { MobileWeatherQueryErrorPresentation } from '../../weather-query/mobile-weather-query-store';
import { useMobileWeatherQuery } from '../../weather-query/use-mobile-weather-query';

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

/** One alert card, in the fixed field order defined by the spec. */
function renderAlertCard(card: MobileWeatherAlertCard, index: number) {
  return (
    <View key={`${card.title}-${index}`} style={styles.card}>
      <Text accessibilityRole="header" style={styles.cardTitle}>
        {card.title}
      </Text>
      <Text style={styles.cardLine}>{`등급: ${card.severityLabel}`}</Text>
      <Text style={styles.cardLine}>{`종류: ${card.typeLabel}`}</Text>
      <Text style={styles.cardLine}>{`발표 시각: ${card.issuedAtLabel}`}</Text>
      {card.effectiveAtLabel !== null ? (
        <Text style={styles.cardLine}>{`발효 시각: ${card.effectiveAtLabel}`}</Text>
      ) : null}
      {card.expiresAtLabel !== null ? (
        <Text style={styles.cardLine}>{`종료 시각: ${card.expiresAtLabel}`}</Text>
      ) : null}
      <Text style={styles.cardLine}>{`대상 지역: ${card.areasLabel}`}</Text>
      {card.description !== null ? (
        <Text style={styles.cardLine}>{`설명: ${card.description}`}</Text>
      ) : null}
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
    <ScrollView contentContainerStyle={styles.container}>
      <Text accessibilityRole="header" style={styles.title}>
        상세기상
      </Text>

      {savedLocations.status === 'NOT_STARTED' ||
      savedLocations.status === 'LOADING' ||
      savedLocations.status === 'SELECTION_LOADING' ? (
        <Text style={styles.text}>상세기상을 준비하고 있습니다.</Text>
      ) : null}

      {savedLocations.status === 'EMPTY' ? (
        <View style={styles.section}>
          <Text style={styles.text}>저장된 지역이 없습니다.</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="지역 추가"
            onPress={handleAddLocation}
            style={styles.button}
          >
            <Text style={styles.buttonLabel}>지역 추가</Text>
          </Pressable>
        </View>
      ) : null}

      {savedLocations.status === 'ERROR' ? (
        <View style={styles.section}>
          <Text style={styles.text}>저장된 지역을 불러오지 못했습니다.</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="저장 지역 다시 불러오기"
            onPress={handleSavedLocationsRetry}
            style={styles.button}
          >
            <Text style={styles.buttonLabel}>다시 시도</Text>
          </Pressable>
        </View>
      ) : null}

      {savedLocations.status === 'READY' ? (
        selectedLocation === null ? (
          <Text style={styles.text}>상세기상을 준비하고 있습니다.</Text>
        ) : (
          <View style={styles.section}>
            <Text style={styles.locationName}>{selectedLocation.displayName}</Text>

            {weatherQuery.status === 'IDLE' ? (
              <Text style={styles.text}>상세기상을 준비하고 있습니다.</Text>
            ) : null}

            {weatherQuery.status === 'LOADING' ? (
              <Text style={styles.text}>선택한 지역의 상세기상을 불러오는 중입니다.</Text>
            ) : null}

            {weatherQuery.status === 'ERROR' ? (
              <View style={styles.section}>
                <Text style={styles.text}>{describeWeatherError(weatherQuery.presentation)}</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="상세기상 다시 시도"
                  onPress={handleWeatherRetry}
                  style={styles.button}
                >
                  <Text style={styles.buttonLabel}>다시 시도</Text>
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
                      <View style={styles.section}>
                        <Text accessibilityRole="header" style={styles.sectionTitle}>
                          기상특보
                        </Text>
                        {details.alerts.status === 'AVAILABLE' ? (
                          details.alerts.cards.map(renderAlertCard)
                        ) : (
                          <Text style={styles.text}>{details.alerts.message}</Text>
                        )}
                      </View>

                      <View style={styles.section}>
                        <Text accessibilityRole="header" style={styles.sectionTitle}>
                          현재 관측
                        </Text>
                        {details.current.status === 'AVAILABLE' ? (
                          <View style={styles.card}>
                            <Text style={styles.cardLine}>{`관측 시각: ${details.current.observedAtLabel}`}</Text>
                            <Text style={styles.cardLine}>{`상태: ${details.current.conditionLabel}`}</Text>
                            <Text style={styles.cardLine}>{`기온: ${details.current.temperatureLabel}`}</Text>
                            {details.current.details.map((detail) => (
                              <Text key={detail.id} style={styles.cardLine}>
                                {detail.text}
                              </Text>
                            ))}
                          </View>
                        ) : (
                          <Text style={styles.text}>{details.current.message}</Text>
                        )}
                      </View>
                    </View>
                  );
                })()
              : null}
          </View>
        )
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    gap: 16,
    padding: 16,
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
  },
  text: {
    fontSize: 16,
  },
  locationName: {
    fontSize: 18,
    fontWeight: '600',
    flexShrink: 1,
    flexWrap: 'wrap',
  },
  section: {
    gap: 12,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  button: {
    minHeight: 48,
    minWidth: 48,
    alignSelf: 'flex-start',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  buttonLabel: {
    fontSize: 16,
  },
  card: {
    gap: 6,
    padding: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    borderColor: '#8888',
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '600',
    flexShrink: 1,
    flexWrap: 'wrap',
  },
  cardLine: {
    fontSize: 15,
    flexShrink: 1,
    flexWrap: 'wrap',
  },
});
