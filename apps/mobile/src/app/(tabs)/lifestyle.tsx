import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  createMobileLifestyleOverview,
  type MobileLifestyleCard,
} from '../../lifestyle/create-mobile-lifestyle-overview';
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

/** One lifestyle card: title → status → reason → recommendation → additional guidance. */
function renderLifestyleCard(card: MobileLifestyleCard) {
  return (
    <View key={card.id} style={styles.card}>
      <Text accessibilityRole="header" style={styles.cardTitle}>
        {card.title}
      </Text>
      <Text style={styles.cardLine}>{`상태: ${card.statusLabel}`}</Text>
      <Text style={styles.cardLine}>{`이유: ${card.reason}`}</Text>
      <Text style={styles.cardLine}>{`행동: ${card.recommendation}`}</Text>
      {card.additionalRecommendation !== null ? (
        <Text style={styles.cardLine}>{`추가 안내: ${card.additionalRecommendation}`}</Text>
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

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text accessibilityRole="header" style={styles.title}>
        생활날씨
      </Text>

      {savedLocations.status === 'NOT_STARTED' ||
      savedLocations.status === 'LOADING' ||
      savedLocations.status === 'SELECTION_LOADING' ? (
        <Text style={styles.text}>생활날씨를 준비하고 있습니다.</Text>
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
          <Text style={styles.text}>생활날씨를 준비하고 있습니다.</Text>
        ) : (
          <View style={styles.section}>
            <Text style={styles.locationName}>{selectedLocation.displayName}</Text>

            {weatherQuery.status === 'IDLE' ? (
              <Text style={styles.text}>생활날씨를 준비하고 있습니다.</Text>
            ) : null}

            {weatherQuery.status === 'LOADING' ? (
              <Text style={styles.text}>선택한 지역의 생활날씨를 불러오는 중입니다.</Text>
            ) : null}

            {weatherQuery.status === 'ERROR' ? (
              <View style={styles.section}>
                <Text style={styles.text}>{describeWeatherError(weatherQuery.presentation)}</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="생활날씨 다시 시도"
                  onPress={handleWeatherRetry}
                  style={styles.button}
                >
                  <Text style={styles.buttonLabel}>다시 시도</Text>
                </Pressable>
              </View>
            ) : null}

            {weatherQuery.status === 'SUCCESS' ? (
              <View style={styles.section}>
                {createMobileLifestyleOverview(weatherQuery.data).map(renderLifestyleCard)}
              </View>
            ) : null}
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
    fontSize: 17,
    fontWeight: '600',
  },
  cardLine: {
    fontSize: 15,
    flexShrink: 1,
    flexWrap: 'wrap',
  },
});
