# 모바일 상세기상(Details) 화면

이 문서는 `apps/mobile/src/details`의 **pure mobile weather-details presentation boundary**와
`/details` (상세기상) 탭 화면을 설명합니다. 이 경계는 이미 검증된
[weather-query 경계](./mobile-weather-query.md)의 `SUCCESS` 응답에서 현재 관측(`current`)과
기상특보(`alerts`)만 읽어, 기상특보를 먼저·현재 관측을 다음으로 표시합니다.

## 목적과 범위

- `/details` 화면의 마지막 placeholder를 최소 실제 상세기상 화면으로 교체합니다.
- KMA current observation, KMA alert provider, 새 API endpoint, response contract 변경은 이번
  PR 범위가 아닙니다 — 이미 검증된 `WeatherSuccessResponseV1`의 `current`/`alerts`/
  `missingSections`만 읽습니다.
- 현재 production `POST /weather`는 KMA `SHORT_FORECAST` 기반 hourly-only 응답이므로,
  `current: null`과 `alerts: []` + `missingSections`에 `CURRENT`/`ALERTS` 포함이 정상적으로
  발생합니다. 이 PR은 향후 current/alert provider가 연결되면 같은 contract로 실제 데이터를 표시할
  수 있는 mobile presentation 경계를 구축하는 작업입니다.

## 기상특보 우선 순서

Details 화면의 SUCCESS content는 항상 다음 순서입니다.

1. 기상특보
2. 현재 관측

이 순서는 `create-mobile-weather-details.ts`가 반환하는 `{ alerts, current }` 객체의 key 순서와
화면의 렌더링 순서 양쪽에서 유지됩니다.

## Weather-query read-only consumer

Details 화면은 기존 두 read-only hook만 사용합니다.

- `useMobileSavedLocations()`
- `useMobileWeatherQuery(savedLocations)`

Weather-query의 request/reset **lifecycle owner는 여전히 `apps/mobile/src/app/(tabs)/_layout.tsx`
한 곳**입니다 (`useMobileWeatherQueryLifecycle`). Details 화면은 이 lifecycle hook을
import/호출하지 않고, `mobileWeatherQueryStore.request()` / `reset()`을 직접 호출하지 않으며,
직접 fetch나 timer/polling/automatic retry도 갖지 않습니다. 사용자 명시적 재시도만 기존 store
method를 통해 이뤄집니다.

- saved-location 오류: `mobileSavedLocationApplicationStore.retryInitialization()`
- weather 오류: `mobileWeatherQueryStore.retry()`

## Pure mobile presentation boundary

새 파일 `apps/mobile/src/details/create-mobile-weather-details.ts`가
`createMobileWeatherDetails(response: WeatherSuccessResponseV1, timeZone: string)`를 export합니다.
이 함수는 **pure TypeScript**입니다 — React/React Native import, Expo Router, storage/store,
API/fetch, environment variable, timer, logging, `Date.now()`, 인자 없는 `new Date()`,
provider-native parsing, runtime schema 재검증, input mutation이 전혀 없습니다. ISO timestamp를
인자로 받는 `new Date(timestamp)`와 `Intl.DateTimeFormat`만 사용하며, 이는 system clock을 읽지
않는 deterministic formatting입니다.

### ALERTS unavailable / none / available

`response.data.missingSections`와 `response.data.alerts`만으로 세 상태를 구분합니다 — 화면이나
경계가 만료 여부, 활성 여부, severity를 자체 재판정하지 않습니다.

- **UNAVAILABLE** (`missingSections`에 `ALERTS` 포함): "기상특보 정보를 제공하지 못했습니다.",
  `cards: []`. 현재 production hourly-only KMA 응답은 이 상태입니다.
- **NONE** (`ALERTS`가 missing이 아니고 `alerts`가 빈 배열): "현재 발표된 기상특보가 없습니다." —
  데이터를 받았고 현재 활성 특보가 없음을 의미합니다.
- **AVAILABLE** (`ALERTS`가 missing이 아니고 `alerts`가 하나 이상): 응답 순서 그대로 모든 alert를
  card로 변환합니다 — sort/filter/dedupe/grouping 없음.

### Current unavailable / available

`response.data.current`가 `null`이면 **UNAVAILABLE**("현재 관측 정보를 제공하지 못했습니다.")을
반환합니다. hourly 첫 항목을 current로 쓰거나, 현재 시각과 가장 가까운 hourly를 찾거나,
`response.meta.generatedAt`을 관측 시각으로 대체하지 않습니다.

`current`가 존재하면 **AVAILABLE**이며 관측 시각·상태·기온을 항상 표시하고, optional 필드
(체감온도/습도/풍속/풍향/최근 1시간 강수량/가시거리)는 `null`이 아닐 때만 detail 항목을 생성합니다.
`0`은 유효한 값이므로 항상 표시되고, 오직 `null`만 숨겨집니다. 가시거리를 km로 변환하거나 풍향을
방위명으로 변환하지 않습니다.

### Label mapping은 mobile presentation에만 존재

`WeatherAlertSeverity`, `WeatherAlertType`, `WeatherCondition` 각각을 exhaustive `Record`로 이
경계 안에서만 한국어로 매핑합니다(default fallback이나 `as string` 우회 없음 — 새 값이 추가되면
typecheck가 즉시 깨집니다). Hourly 화면의 기존 `WeatherCondition` 매핑과 별개로, 이 파일 안에
독립적인 매핑을 둡니다. Alert의 `title`과 non-null `description`은 검증된 contract 값을 그대로
보존하며 재작성하지 않습니다. `areas`는 순서를 보존해 `, `로 연결합니다.

### 노출하지 않는 원본 필드

alert card는 `id`, `sourceId`, `provider`, `requestId`, raw `missingSections`, source metadata를
전혀 반환하지 않습니다.

### 선택 지역 timezone formatting

`current.observedAt`, `alert.issuedAt`, non-null `alert.effectiveAt`/`alert.expiresAt`은
**선택된 저장 지역의 `timezone`**(`createMobileWeatherDetails`의 두 번째 인자)으로 포맷합니다 —
기기 timezone이나 응답 location의 timezone으로 임의 대체하지 않습니다. 권장 출력 형식은 Hourly
화면과 동일한 `8월 5일 (수) 14:00`입니다. formatter 실패나 예상하지 못한 timezone 문제가 발생하면
raw ISO 문자열을 반환해 화면이 crash하지 않습니다. `Date.now()`, 현재 시각 비교, 만료 여부 자체
계산, 활성/비활성 특보 판정은 하지 않습니다.

## Details 화면

`apps/mobile/src/app/(tabs)/details.tsx`는 Today/Hourly/Lifestyle과 동일한 상태 분기 패턴을
재사용합니다.

- Saved-location 준비 중(`NOT_STARTED`/`LOADING`/`SELECTION_LOADING`): "상세기상을 준비하고
  있습니다."
- `EMPTY`: "저장된 지역이 없습니다." + `지역 추가` 버튼(`/locations`로 push)
- Saved-location `ERROR`: 고정 안내 문구 + `다시 시도` 버튼(`retryInitialization()`)
- `READY`이지만 선택된 record가 목록에 없음(방어적 상태): "상세기상을 준비하고 있습니다." — raw
  `selectedLocationId`나 임의 첫 지역 fallback 없음
- `READY` + weather `IDLE`/`LOADING`: 선택 지역명 + 고정 준비/로딩 문구
- `READY` + weather `ERROR`: 선택 지역명 + Today/Hourly/Lifestyle과 동일한 네 가지 고정 안전 문구
  (`CONFIGURATION`/`NETWORK`/`API`/`INVALID_RESPONSE`) + `다시 시도` 버튼(`retry()`)
- `READY` + weather `SUCCESS`: 선택 지역명 + `createMobileWeatherDetails(weatherQuery.data,
  selectedLocation.timezone)`를 정확히 한 번 호출한 결과를 기상특보 → 현재 관측 순서로 렌더링

선택 지역명은 `READY`의 모든 weather 상태에서 표시되며, `SUCCESS`에서도 정확히 한 번만
표시됩니다. 화면 제목과 각 section 제목, 각 alert card 제목에는 `accessibilityRole="header"`를
사용하고, 버튼은 48×48 이상의 터치 영역을 갖습니다. 색상만으로 alert 등급을 표현하지 않고, 새
아이콘/이미지/애니메이션이나 공통 design system은 도입하지 않았습니다.

## 이 작업에서 하지 않은 것

- KMA current observation 구현, KMA alert provider 구현, 새 API endpoint, response contract
  변경은 전혀 하지 않았습니다. `packages/contracts`, `packages/weather-core`,
  `packages/lifestyle-engine`, `apps/api`, weather-query, saved-location 경계는 변경하지
  않았습니다.
- alert polling, stale/cache 정책, alert push notification, alert 만료 여부 자체 계산, severity
  재판정, 위치별 alert filtering은 구현하지 않았습니다.
- daily/air quality 표시, 위성·레이더·태풍 화면은 이번 PR 범위가 아닙니다.
- 실제 `POST /weather` 호출, dev-server QA, Expo Development Build, prebuild/native build, 실기기
  QA는 수행하지 않았습니다.
- 실제 current/alert backend는 여전히 미구현이므로, production 응답에서는 두 section이 계속 데이터
  미제공 문구를 표시할 수 있습니다. 이는 정상 동작이며 이번 PR의 결함이 아닙니다.
