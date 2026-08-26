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

/**
 * Neutral marker for an hourly value the provider did not supply. A fixed table cannot drop a
 * cell without breaking column alignment, so a `null` is shown as missing — never as a `0`.
 */
const NO_VALUE = '—';

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

/** Korean 8-sector compass labels, starting at 북 and advancing clockwise every 45°. */
const COMPASS_LABELS = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'] as const;

/**
 * Presentation-only Korean label for a wind bearing. The source degrees are never replaced — the
 * caller keeps showing them alongside this label — so this stays a readability aid, not a contract.
 */
function windDirectionLabel(degrees: number): string {
  if (!Number.isFinite(degrees)) {
    return NO_VALUE;
  }
  const normalized = ((degrees % 360) + 360) % 360;
  return COMPASS_LABELS[Math.round(normalized / 45) % COMPASS_LABELS.length];
}

// ---------------------------------------------------------------------------
// Timeline geometry. Every time-dependent row is laid out on the same fixed-width column grid so
// the fixed left label rail, each data row and the temperature chart stay aligned while the single
// horizontal ScrollView moves them together.
// ---------------------------------------------------------------------------

const LABEL_RAIL_WIDTH = 68;
const COLUMN_WIDTH = 72;

const DATE_ROW_HEIGHT = 32;
const TIME_ROW_HEIGHT = 30;
const WEATHER_ROW_HEIGHT = 50;
const TEMPERATURE_ROW_HEIGHT = 92;
const DETAIL_ROW_HEIGHT = 32;
const WIND_DIRECTION_ROW_HEIGHT = 44;

/** Vertical plot band inside the temperature row, leaving room for the value text above a point. */
const CHART_PLOT_TOP = 30;
const CHART_PLOT_HEIGHT = 48;
const CHART_POINT_SIZE = 8;
const CHART_LINE_THICKNESS = 2;
/** Distance from a point's centre up to the top of its value text. */
const CHART_VALUE_OFFSET = 26;

interface HourlyDateRun {
  readonly dateKey: string;
  readonly dateLabel: string;
  readonly startIndex: number;
  readonly columnCount: number;
}

/**
 * Contiguous local-date runs across the hourly timeline, in original contract order (no sort, no
 * dedupe): each run spans the consecutive entries sharing a calendar date in `timeZone`. The date
 * key is computed independently of the display label so a label-formatting quirk never affects
 * grouping, and an unresolvable timezone degrades to one run per entry rather than merging
 * distinct days or falling back to the device timezone.
 */
function buildLocalDateRuns(hourly: readonly HourlyForecast[], timeZone: string): HourlyDateRun[] {
  const runs: { dateKey: string; dateLabel: string; startIndex: number; columnCount: number }[] = [];

  hourly.forEach((item, index) => {
    const dateKey = localDateKey(item.forecastAt, timeZone) ?? `__unresolved_${index}`;
    const previous = runs[runs.length - 1];
    if (previous !== undefined && previous.dateKey === dateKey) {
      previous.columnCount += 1;
      return;
    }
    runs.push({
      dateKey,
      dateLabel: localDateLabel(item.forecastAt, timeZone),
      startIndex: index,
      columnCount: 1,
    });
  });

  return runs;
}

interface TemperatureChartPoint {
  readonly x: number;
  readonly y: number;
  readonly label: string;
}

interface TemperatureChartSegment {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly rotationDegrees: number;
}

interface TemperatureChart {
  readonly points: readonly TemperatureChartPoint[];
  readonly segments: readonly TemperatureChartSegment[];
}

/**
 * Pure point/segment geometry for the temperature polyline: one point per hourly entry centred on
 * that entry's column, warmer values higher, plus one straight segment per adjacent pair. Values
 * are never smoothed, reordered or substituted. A flat series (or a single entry) sits on a stable
 * middle level, and a single entry produces no segment at all.
 */
function buildTemperatureChart(hourly: readonly HourlyForecast[]): TemperatureChart {
  const temperatures = hourly.map((item) => item.temperatureCelsius);
  const minimum = temperatures.reduce((low, value) => (value < low ? value : low), temperatures[0]);
  const maximum = temperatures.reduce((high, value) => (value > high ? value : high), temperatures[0]);
  const span = maximum - minimum;
  const scalable = Number.isFinite(span) && span > 0;

  const points = temperatures.map((temperature, index) => ({
    x: index * COLUMN_WIDTH + COLUMN_WIDTH / 2,
    y: scalable
      ? CHART_PLOT_TOP + (1 - (temperature - minimum) / span) * CHART_PLOT_HEIGHT
      : CHART_PLOT_TOP + CHART_PLOT_HEIGHT / 2,
    label: `${temperature}°`,
  }));

  const segments = points.slice(1).map((point, index) => {
    const previous = points[index];
    const deltaX = point.x - previous.x;
    const deltaY = point.y - previous.y;
    const length = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    return {
      left: (previous.x + point.x) / 2 - length / 2,
      top: (previous.y + point.y) / 2 - CHART_LINE_THICKNESS / 2,
      width: length,
      rotationDegrees: (Math.atan2(deltaY, deltaX) * 180) / Math.PI,
    };
  });

  return { points, segments };
}

interface DetailRowSpec {
  readonly key: string;
  readonly label: string;
  readonly height: number;
  /** One or two lines of cell text. `null` becomes {@link NO_VALUE}; a numeric `0` stays visible. */
  readonly cell: (item: HourlyForecast) => readonly string[];
}

/** The fixed detail rows below the temperature chart, in display order. */
const DETAIL_ROWS: readonly DetailRowSpec[] = [
  {
    key: 'feelsLike',
    label: '체감',
    height: DETAIL_ROW_HEIGHT,
    cell: (item) => [item.feelsLikeCelsius === null ? NO_VALUE : `${item.feelsLikeCelsius}°`],
  },
  {
    key: 'precipitationProbability',
    label: '강수확률',
    height: DETAIL_ROW_HEIGHT,
    cell: (item) => [
      item.precipitationProbabilityPercent === null ? NO_VALUE : `${item.precipitationProbabilityPercent}%`,
    ],
  },
  {
    key: 'precipitationAmount',
    label: '강수량',
    height: DETAIL_ROW_HEIGHT,
    cell: (item) => [
      item.precipitationAmountMillimeters === null ? NO_VALUE : `${item.precipitationAmountMillimeters}mm`,
    ],
  },
  {
    key: 'snowfall',
    label: '적설량',
    height: DETAIL_ROW_HEIGHT,
    cell: (item) => [
      item.snowfallAmountCentimeters === null ? NO_VALUE : `${item.snowfallAmountCentimeters}cm`,
    ],
  },
  {
    key: 'humidity',
    label: '습도',
    height: DETAIL_ROW_HEIGHT,
    cell: (item) => [item.humidityPercent === null ? NO_VALUE : `${item.humidityPercent}%`],
  },
  {
    key: 'windSpeed',
    label: '풍속',
    height: DETAIL_ROW_HEIGHT,
    cell: (item) => [
      item.windSpeedMetersPerSecond === null ? NO_VALUE : `${item.windSpeedMetersPerSecond}m/s`,
    ],
  },
  {
    key: 'windDirection',
    label: '풍향',
    height: WIND_DIRECTION_ROW_HEIGHT,
    cell: (item) =>
      item.windDirectionDegrees === null
        ? [NO_VALUE]
        : [windDirectionLabel(item.windDirectionDegrees), `${item.windDirectionDegrees}°`],
  },
];

/** The fixed left rail: one label per timeline row, at exactly that row's height. */
function renderLabelRail() {
  return (
    <View style={styles.labelRail}>
      <View style={[styles.labelCell, { height: DATE_ROW_HEIGHT }]}>
        <Text style={styles.labelText}>날짜</Text>
      </View>
      <View style={[styles.labelCell, styles.rowDivider, { height: TIME_ROW_HEIGHT }]}>
        <Text style={styles.labelText}>시간</Text>
      </View>
      <View style={[styles.labelCell, styles.rowDivider, { height: WEATHER_ROW_HEIGHT }]}>
        <Text style={styles.labelText}>날씨</Text>
      </View>
      <View style={[styles.labelCell, styles.rowDivider, { height: TEMPERATURE_ROW_HEIGHT }]}>
        <Text style={styles.labelText}>기온</Text>
      </View>
      {DETAIL_ROWS.map((row) => (
        <View key={row.key} style={[styles.labelCell, styles.rowDivider, { height: row.height }]}>
          <Text style={styles.labelText}>{row.label}</Text>
        </View>
      ))}
    </View>
  );
}

function renderDateBandRow(runs: readonly HourlyDateRun[]) {
  return (
    <View key="date" style={[styles.timelineRow, { height: DATE_ROW_HEIGHT }]}>
      {runs.map((run, runIndex) => (
        <View
          key={`${run.dateKey}-${run.startIndex}`}
          style={[
            styles.dateBandCell,
            { width: run.columnCount * COLUMN_WIDTH },
            runIndex > 0 ? styles.dateBoundary : null,
          ]}
        >
          <Text accessibilityRole="header" style={styles.dateBandText} numberOfLines={1}>
            {run.dateLabel}
          </Text>
        </View>
      ))}
    </View>
  );
}

function renderTimeRow(hourly: readonly HourlyForecast[], timeZone: string, boundaries: ReadonlySet<number>) {
  return (
    <View key="time" style={[styles.timelineRow, styles.rowDivider, { height: TIME_ROW_HEIGHT }]}>
      {hourly.map((item, index) => (
        <View
          key={`time-${index}`}
          style={[styles.columnCell, boundaries.has(index) ? styles.dateBoundary : null]}
        >
          <Text style={styles.timeText} numberOfLines={1}>
            {localTime(item.forecastAt, timeZone)}
          </Text>
        </View>
      ))}
    </View>
  );
}

function renderWeatherRow(hourly: readonly HourlyForecast[], boundaries: ReadonlySet<number>) {
  return (
    <View key="weather" style={[styles.timelineRow, styles.rowDivider, { height: WEATHER_ROW_HEIGHT }]}>
      {hourly.map((item, index) => (
        <View
          key={`weather-${index}`}
          style={[styles.columnCell, boundaries.has(index) ? styles.dateBoundary : null]}
        >
          <Text style={styles.conditionGlyph}>{CONDITION_EMOJI[item.condition]}</Text>
          <Text style={styles.conditionLabel} numberOfLines={2}>
            {CONDITION_LABELS[item.condition]}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * The temperature row: the same column grid as every other row, with the polyline drawn over it
 * from plain Views and each value repeated as text so the chart stays supplementary.
 */
function renderTemperatureRow(hourly: readonly HourlyForecast[], boundaries: ReadonlySet<number>) {
  const { points, segments } = buildTemperatureChart(hourly);

  return (
    <View key="temperature" style={[styles.timelineRow, styles.rowDivider, { height: TEMPERATURE_ROW_HEIGHT }]}>
      {hourly.map((_item, index) => (
        <View
          key={`temperature-cell-${index}`}
          style={[styles.columnCell, boundaries.has(index) ? styles.dateBoundary : null]}
        />
      ))}
      <View
        style={styles.chartLayer}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {segments.map((segment, index) => (
          <View
            key={`temperature-segment-${index}`}
            style={[
              styles.chartSegment,
              {
                left: segment.left,
                top: segment.top,
                width: segment.width,
                transform: [{ rotate: `${segment.rotationDegrees}deg` }],
              },
            ]}
          />
        ))}
        {points.map((point, index) => (
          <View
            key={`temperature-point-${index}`}
            style={[
              styles.chartPoint,
              { left: point.x - CHART_POINT_SIZE / 2, top: point.y - CHART_POINT_SIZE / 2 },
            ]}
          />
        ))}
      </View>
      {points.map((point, index) => (
        <Text
          key={`temperature-value-${index}`}
          style={[styles.chartValue, { left: point.x - COLUMN_WIDTH / 2, top: point.y - CHART_VALUE_OFFSET }]}
          numberOfLines={1}
        >
          {point.label}
        </Text>
      ))}
    </View>
  );
}

function renderDetailRow(
  row: DetailRowSpec,
  hourly: readonly HourlyForecast[],
  boundaries: ReadonlySet<number>,
) {
  return (
    <View key={row.key} style={[styles.timelineRow, styles.rowDivider, { height: row.height }]}>
      {hourly.map((item, index) => (
        <View
          key={`${row.key}-${index}`}
          style={[styles.columnCell, boundaries.has(index) ? styles.dateBoundary : null]}
        >
          {row.cell(item).map((line, lineIndex) => (
            <Text
              key={`${row.key}-${index}-${lineIndex}`}
              style={lineIndex === 0 ? styles.detailText : styles.detailSubText}
              numberOfLines={1}
            >
              {line}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

/**
 * The detailed hourly comparison surface: a fixed label rail plus a single horizontal ScrollView
 * that owns every time-dependent row, so all hourly columns move together on one shared axis.
 */
function renderTimeline(hourly: readonly HourlyForecast[], timeZone: string) {
  const runs = buildLocalDateRuns(hourly, timeZone);
  const boundaries = new Set(runs.slice(1).map((run) => run.startIndex));

  return (
    <View style={styles.timelineCard}>
      <View style={styles.timelineBody}>
        {renderLabelRail()}
        <ScrollView
          horizontal={true}
          showsHorizontalScrollIndicator={false}
          nestedScrollEnabled={true}
          accessibilityLabel="시간별 예보 비교표입니다. 좌우로 넘기면 다음 시간을 볼 수 있습니다."
          style={styles.timelineViewport}
          contentContainerStyle={styles.timelineScrollContent}
          snapToInterval={COLUMN_WIDTH}
          snapToAlignment="start"
          decelerationRate="fast"
        >
          <View style={styles.timelineContent}>
            {renderDateBandRow(runs)}
            {renderTimeRow(hourly, timeZone, boundaries)}
            {renderWeatherRow(hourly, boundaries)}
            {renderTemperatureRow(hourly, boundaries)}
            {DETAIL_ROWS.map((row) => renderDetailRow(row, hourly, boundaries))}
          </View>
        </ScrollView>
      </View>
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
                renderTimeline(weatherQuery.data.data.hourly, selectedLocation.timezone)
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
const RAIL_BACKGROUND = '#F7F9FC';
const DATE_BOUNDARY_COLOR = '#C3CEDC';

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
  timelineCard: {
    backgroundColor: CARD_BACKGROUND,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: BORDER_COLOR,
    overflow: 'hidden',
  },
  timelineBody: {
    flexDirection: 'row',
  },
  labelRail: {
    width: LABEL_RAIL_WIDTH,
    backgroundColor: RAIL_BACKGROUND,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: BORDER_COLOR,
  },
  labelCell: {
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  labelText: {
    fontSize: 12,
    fontWeight: '600',
    color: TEXT_SECONDARY,
  },
  timelineViewport: {
    flex: 1,
    overflow: 'hidden',
  },
  timelineScrollContent: {
    flexGrow: 1,
  },
  timelineContent: {
    flexDirection: 'column',
  },
  timelineRow: {
    flexDirection: 'row',
  },
  rowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: BORDER_COLOR,
  },
  columnCell: {
    width: COLUMN_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: BORDER_COLOR,
    paddingHorizontal: 2,
  },
  dateBandCell: {
    justifyContent: 'center',
    paddingHorizontal: 8,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: BORDER_COLOR,
    backgroundColor: RAIL_BACKGROUND,
  },
  dateBoundary: {
    borderLeftWidth: 2,
    borderLeftColor: DATE_BOUNDARY_COLOR,
  },
  dateBandText: {
    fontSize: 12,
    fontWeight: '700',
    color: TEXT_PRIMARY,
  },
  timeText: {
    fontSize: 13,
    fontWeight: '600',
    color: TEXT_PRIMARY,
  },
  conditionGlyph: {
    fontSize: 18,
  },
  conditionLabel: {
    fontSize: 11,
    color: TEXT_SECONDARY,
    textAlign: 'center',
  },
  chartLayer: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  },
  chartSegment: {
    position: 'absolute',
    height: CHART_LINE_THICKNESS,
    borderRadius: CHART_LINE_THICKNESS / 2,
    backgroundColor: ACCENT_COLOR,
  },
  chartPoint: {
    position: 'absolute',
    width: CHART_POINT_SIZE,
    height: CHART_POINT_SIZE,
    borderRadius: CHART_POINT_SIZE / 2,
    backgroundColor: ACCENT_COLOR,
  },
  chartValue: {
    position: 'absolute',
    width: COLUMN_WIDTH,
    textAlign: 'center',
    fontSize: 14,
    fontWeight: '700',
    color: TEXT_PRIMARY,
  },
  detailText: {
    fontSize: 12,
    fontWeight: '600',
    color: TEXT_PRIMARY,
  },
  detailSubText: {
    fontSize: 11,
    color: TEXT_SECONDARY,
  },
});
