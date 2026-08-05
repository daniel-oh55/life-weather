import type { WeatherCondition } from '@life-weather/contracts';
import { useState } from 'react';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { mobileSavedLocationApplicationStore } from '../../locations/mobile-saved-location-application-production';
import type { SavedLocationApplicationSnapshot } from '../../locations/mobile-saved-location-application-store';
import { useMobileSavedLocations } from '../../locations/use-mobile-saved-locations';
import { mobileWeatherQueryStore } from '../../weather-query/mobile-weather-query-production';
import type { MobileWeatherQueryErrorPresentation } from '../../weather-query/mobile-weather-query-store';
import { useMobileWeatherQuery } from '../../weather-query/use-mobile-weather-query';

/**
 * The single status line for each application state. `ERROR` deliberately carries no error kind,
 * scope, storage detail, or native message — only generic Korean copy.
 */
function describeSavedLocations(snapshot: SavedLocationApplicationSnapshot): string {
  switch (snapshot.status) {
    case 'NOT_STARTED':
      return '저장 지역을 준비하고 있습니다.';
    case 'LOADING':
      return '저장된 지역을 불러오는 중입니다.';
    case 'SELECTION_LOADING':
      return '선택 지역을 준비하는 중입니다.';
    case 'EMPTY':
      return '저장된 지역이 없습니다.';
    case 'READY':
      return `저장된 지역이 준비되었습니다.\n저장 지역 수: ${snapshot.locations.length}`;
    case 'ERROR':
      return '저장된 지역을 불러오지 못했습니다.';
  }
}

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
  const firstHourly =
    weatherQuery.status === 'SUCCESS' ? (weatherQuery.data.data.hourly[0] ?? null) : null;

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
    <View style={styles.container}>
      <Text style={styles.text}>{describeSavedLocations(savedLocations)}</Text>

      {savedLocations.status === 'EMPTY' || savedLocations.status === 'READY' ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="지역 추가"
          disabled={isSaving}
          onPress={handleAddLocation}
          style={styles.button}
        >
          <Text style={styles.buttonLabel}>지역 추가</Text>
        </Pressable>
      ) : null}

      {savedLocations.status === 'ERROR' ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="저장 지역 다시 불러오기"
          onPress={handleRetry}
          style={styles.button}
        >
          <Text style={styles.buttonLabel}>다시 시도</Text>
        </Pressable>
      ) : null}

      {savedLocations.status === 'READY' ? (
        <View style={styles.list}>
          {savedLocations.locations.map((location) => {
            const isSelected = location.id === savedLocations.selectedLocationId;
            const selectDisabled = isSelected || isSaving;
            return (
              <View key={location.id} style={styles.row}>
                <Text style={styles.rowLabel}>{location.displayName}</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={isSelected ? `${location.displayName} 선택됨` : `${location.displayName} 선택`}
                  accessibilityState={{ selected: isSelected, disabled: selectDisabled }}
                  disabled={selectDisabled}
                  onPress={() => {
                    void handleSelect(location.id);
                  }}
                  style={styles.button}
                >
                  <Text style={styles.buttonLabel}>{isSelected ? '선택됨' : '선택'}</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${location.displayName} 삭제`}
                  disabled={isSaving}
                  onPress={() => {
                    void handleRemove(location.id);
                  }}
                  style={styles.button}
                >
                  <Text style={styles.buttonLabel}>삭제</Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      ) : null}

      {writeFailed ? (
        <Text style={styles.text}>저장 지역 변경을 저장하지 못했습니다.</Text>
      ) : null}

      {savedLocations.status === 'READY' ? (
        <View style={styles.weatherSection}>
          {weatherQuery.status === 'LOADING' ? (
            <Text style={styles.text}>선택한 지역의 날씨를 불러오는 중입니다.</Text>
          ) : null}

          {weatherQuery.status === 'ERROR' ? (
            <View style={styles.weatherSection}>
              <Text style={styles.text}>{describeWeatherError(weatherQuery.presentation)}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="날씨 다시 시도"
                onPress={handleWeatherRetry}
                style={styles.button}
              >
                <Text style={styles.buttonLabel}>다시 시도</Text>
              </Pressable>
            </View>
          ) : null}

          {weatherQuery.status === 'SUCCESS' ? (
            <View style={styles.weatherSection}>
              <Text style={styles.text}>
                {selectedLocation !== null ? selectedLocation.displayName : ''}
              </Text>
              {firstHourly === null ? (
                <Text style={styles.text}>표시할 시간별 예보가 없습니다.</Text>
              ) : (
                <View style={styles.weatherSection}>
                  <Text style={styles.text}>{firstHourly.forecastAt}</Text>
                  <Text style={styles.text}>{`${firstHourly.temperatureCelsius}°C`}</Text>
                  <Text style={styles.text}>{CONDITION_LABELS[firstHourly.condition]}</Text>
                  {firstHourly.precipitationProbabilityPercent !== null ? (
                    <Text
                      style={styles.text}
                    >{`강수확률 ${firstHourly.precipitationProbabilityPercent}%`}</Text>
                  ) : null}
                </View>
              )}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 16,
  },
  text: {
    fontSize: 16,
  },
  list: {
    alignSelf: 'stretch',
    gap: 8,
  },
  weatherSection: {
    alignSelf: 'stretch',
    alignItems: 'center',
    gap: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  rowLabel: {
    flexShrink: 1,
    fontSize: 16,
  },
  button: {
    minHeight: 48,
    minWidth: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  buttonLabel: {
    fontSize: 16,
  },
});
