import type { HourlyForecast, WeatherCondition } from '@life-weather/contracts';
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { mobileSavedLocationApplicationStore } from '../../locations/mobile-saved-location-application-production';
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

function datePart(parts: readonly Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPart['type']): string {
  return parts.find((part) => part.type === type)?.value ?? '';
}

/**
 * Format an ISO `forecastAt` in the given saved location's own timezone — never the device's —
 * as e.g. "8월 5일 (수) 14:00". Falls back to the raw ISO string on any formatter failure (an
 * unexpected/invalid timezone) rather than crashing the screen.
 */
function formatForecastAt(forecastAt: string, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('ko-KR', {
      timeZone,
      month: 'numeric',
      day: 'numeric',
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(forecastAt));

    const month = datePart(parts, 'month');
    const day = datePart(parts, 'day');
    const weekday = datePart(parts, 'weekday');
    const hour = datePart(parts, 'hour');
    const minute = datePart(parts, 'minute');

    return `${month}월 ${day}일 (${weekday}) ${hour}:${minute}`;
  } catch {
    return forecastAt;
  }
}

/**
 * One hourly row, in contract order: forecast time, condition, temperature, then only the
 * optional fields that are not `null` (a `0` value is always shown; only `null` is hidden).
 */
function renderHourlyRow(item: HourlyForecast, index: number, timeZone: string) {
  return (
    <View key={`${item.forecastAt}-${index}`} style={styles.hourlyRow}>
      <Text style={styles.hourlyTime}>{formatForecastAt(item.forecastAt, timeZone)}</Text>
      <Text style={styles.hourlyCondition}>{CONDITION_LABELS[item.condition]}</Text>
      <Text style={styles.hourlyTemperature}>{`${item.temperatureCelsius}°C`}</Text>
      {item.feelsLikeCelsius !== null ? (
        <Text style={styles.hourlyDetail}>{`체감 ${item.feelsLikeCelsius}°C`}</Text>
      ) : null}
      {item.precipitationProbabilityPercent !== null ? (
        <Text style={styles.hourlyDetail}>{`강수확률 ${item.precipitationProbabilityPercent}%`}</Text>
      ) : null}
      {item.precipitationAmountMillimeters !== null ? (
        <Text style={styles.hourlyDetail}>{`강수량 ${item.precipitationAmountMillimeters}mm`}</Text>
      ) : null}
      {item.snowfallAmountCentimeters !== null ? (
        <Text style={styles.hourlyDetail}>{`적설 ${item.snowfallAmountCentimeters}cm`}</Text>
      ) : null}
      {item.humidityPercent !== null ? (
        <Text style={styles.hourlyDetail}>{`습도 ${item.humidityPercent}%`}</Text>
      ) : null}
      {item.windSpeedMetersPerSecond !== null ? (
        <Text style={styles.hourlyDetail}>{`풍속 ${item.windSpeedMetersPerSecond}m/s`}</Text>
      ) : null}
      {item.windDirectionDegrees !== null ? (
        <Text style={styles.hourlyDetail}>{`풍향 ${item.windDirectionDegrees}°`}</Text>
      ) : null}
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
    <ScrollView contentContainerStyle={styles.container}>
      <Text accessibilityRole="header" style={styles.title}>
        시간별 날씨
      </Text>

      {savedLocations.status === 'NOT_STARTED' ||
      savedLocations.status === 'LOADING' ||
      savedLocations.status === 'SELECTION_LOADING' ? (
        <Text style={styles.text}>시간별 날씨를 준비하고 있습니다.</Text>
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
          <Text style={styles.text}>시간별 날씨를 준비하고 있습니다.</Text>
        ) : (
          <View style={styles.section}>
            {weatherQuery.status === 'IDLE' ? (
              <Text style={styles.text}>시간별 날씨를 준비하고 있습니다.</Text>
            ) : null}

            {weatherQuery.status === 'LOADING' ? (
              <Text style={styles.text}>선택한 지역의 시간별 날씨를 불러오는 중입니다.</Text>
            ) : null}

            {weatherQuery.status === 'ERROR' ? (
              <View style={styles.section}>
                <Text style={styles.text}>{describeWeatherError(weatherQuery.presentation)}</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="시간별 날씨 다시 시도"
                  onPress={handleWeatherRetry}
                  style={styles.button}
                >
                  <Text style={styles.buttonLabel}>다시 시도</Text>
                </Pressable>
              </View>
            ) : null}

            {weatherQuery.status === 'SUCCESS' ? (
              <View style={styles.section}>
                <Text style={styles.locationName}>{selectedLocation.displayName}</Text>
                {weatherQuery.data.data.hourly.length === 0 ? (
                  <Text style={styles.text}>표시할 시간별 예보가 없습니다.</Text>
                ) : (
                  weatherQuery.data.data.hourly.map((item, index) =>
                    renderHourlyRow(item, index, selectedLocation.timezone),
                  )
                )}
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
  hourlyRow: {
    gap: 4,
    paddingVertical: 8,
  },
  hourlyTime: {
    fontSize: 16,
    fontWeight: '600',
  },
  hourlyCondition: {
    fontSize: 16,
  },
  hourlyTemperature: {
    fontSize: 16,
  },
  hourlyDetail: {
    fontSize: 14,
    flexShrink: 1,
    flexWrap: 'wrap',
  },
});
