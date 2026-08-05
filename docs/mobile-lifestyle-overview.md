# 모바일 생활날씨(Lifestyle) 개요 화면

이 문서는 `apps/mobile/src/lifestyle`의 **pure mobile lifestyle presentation boundary**와
`/lifestyle` (생활날씨) 탭 화면을 설명합니다. 이 경계는 이미 검증된
[weather-query 경계](./mobile-weather-query.md)의 `SUCCESS` 응답을 기존
`@life-weather/lifestyle-engine` 네 개 정책(우산/옷차림/마스크/빨래)에 연결해, 각 정책의 결정을
고정 순서 네 개 카드로 렌더링합니다.

## 목적과 범위

- `/lifestyle` 화면의 placeholder를 최소 실제 생활날씨 화면으로 교체합니다.
- 정책 계산(threshold, status, reasonCode, copy)은 이 PR에서 전혀 다시 구현하지 않습니다 — 기존
  `assessUmbrellaNeed` / `assessOutfitRecommendation` / `assessMaskNeed` /
  `assessLaundryDryingSuitability`만 호출합니다.
- `apps/mobile`에 `@life-weather/lifestyle-engine`을 `workspace:*` 정식 dependency로 추가합니다
  (외부 dependency 추가 없음).

## Weather-query read-only consumer

Lifestyle 화면은 기존 두 read-only hook만 사용합니다.

- `useMobileSavedLocations()`
- `useMobileWeatherQuery(savedLocations)`

Weather-query의 request/reset **lifecycle owner는 여전히 `apps/mobile/src/app/(tabs)/_layout.tsx`
한 곳**입니다 (`useMobileWeatherQueryLifecycle`). Lifestyle 화면은 이 lifecycle hook을
import/호출하지 않고, `mobileWeatherQueryStore.request()` / `reset()`을 직접 호출하지 않습니다.
사용자 명시적 재시도만 기존 store method를 통해 이뤄집니다.

- saved-location 오류: `mobileSavedLocationApplicationStore.retryInitialization()`
- weather 오류: `mobileWeatherQueryStore.retry()`

## Pure mobile presentation boundary

새 파일 `apps/mobile/src/lifestyle/create-mobile-lifestyle-overview.ts`가
`createMobileLifestyleOverview(response: WeatherSuccessResponseV1)`를 export합니다. 이 함수는
**pure TypeScript**입니다 — React/React Native import, `Date.now()`, 인자 없는 `new Date()`,
timer, storage, environment variable, 네트워크 호출, mutation, navigation, logging이 전혀
없습니다. 같은 입력에는 항상 deep-equal한 새 배열을 반환하며, 입력 `response`와 그 중첩
array/object를 절대 mutate하지 않습니다.

### 평가 기준 시각

네 정책 모두 `evaluatedAt`으로 **`response.meta.generatedAt`**을 그대로 사용합니다. 기기의 현재
시각이나 module import 시각은 전혀 읽지 않습니다.

### 각 engine 입력 연결

| Card | 호출 | 입력 |
| --- | --- | --- |
| 우산 | `assessUmbrellaNeed` | `evaluatedAt`, `response.data.hourly` |
| 옷차림 | `assessOutfitRecommendation` | `evaluatedAt`, `response.data.hourly` |
| 마스크 | `assessMaskNeed` | `evaluatedAt`, `response.data.airQuality.current` (그대로, `null`이면 `null`) |
| 빨래 | `assessLaundryDryingSuitability` | `evaluatedAt`, `response.data.hourly` |

`current`, `daily`, `airQuality.daily`, `alerts`, `missingSections`, `sources`, `requestId`,
provider metadata는 이 경계에서 전혀 읽지 않습니다.

### 카드 결과와 copy passthrough

`createMobileLifestyleOverview`는 정확히 네 개의 `MobileLifestyleCard`를 고정 순서
(`UMBRELLA`, `OUTFIT`, `MASK`, `LAUNDRY`)로 반환합니다. 각 카드는 `id` / `title` / `statusLabel`
/ `reason` / `recommendation` / `additionalRecommendation`만 담습니다.

- `reason`과 `recommendation`은 engine 결과를 **그대로** 사용합니다 — copy를 재작성하지 않습니다.
- `additionalRecommendation`은 Outfit 결정의 값을 그대로 전달하고, 나머지 세 카드는 항상 `null`입니다.
- `reasonCode`, `policyVersion`, evidence, provider-native 값은 카드에 절대 포함되지 않습니다.
- 카드는 threshold를 재계산하지 않고, 의료 진단이나 질환 위험 문구를 추가하지 않습니다.

### Status label mapping

각 engine의 status는 이 경계 안의 exhaustive `Record`로만 한국어 라벨로 매핑됩니다(default
fallback이나 `as string` 우회 없음 — 새 engine status가 추가되면 typecheck가 즉시 깨집니다).

- 우산: `REQUIRED_NOW` 지금 필요 / `REQUIRED_LATER` 나중에 필요 / `RECOMMENDED` 챙기기 권장 /
  `NOT_NEEDED` 필요 낮음 / `INSUFFICIENT_DATA` 판단 보류
- 옷차림: `EXTREME_COLD` 매우 추움 / `VERY_COLD` 추움 / `COLD` 쌀쌀함 / `COOL` 선선함 / `MILD` 온화함
  / `WARM` 따뜻함 / `HOT` 더움 / `VERY_HOT` 매우 더움 / `INSUFFICIENT_DATA` 판단 보류
- 마스크: `REQUIRED` 착용 필요 / `RECOMMENDED` 착용 권장 / `NOT_NEEDED` 필요 낮음 /
  `INSUFFICIENT_DATA` 판단 보류
- 빨래: `NOT_RECOMMENDED` 실외 건조 비추천 / `POOR` 좋지 않음 / `FAIR` 보통 / `GOOD` 좋음 /
  `EXCELLENT` 매우 좋음 / `INSUFFICIENT_DATA` 판단 보류

### 부족한 데이터는 숨기지 않는다

`hourly`가 비어 있으면 우산·옷차림·빨래 카드가 engine의 `INSUFFICIENT_DATA`(판단 보류)를 그대로
표시합니다. `airQuality.current`가 `null`이면 마스크 카드가 판단 보류를 표시합니다. 화면은 이
사실을 별도로 재판단하지 않고 engine 결과를 그대로 렌더링합니다.

현재 production KMA 응답에는 AirKorea 연동이 아직 구현되어 있지 않으므로, 실제 서비스에서는
`airQuality.current`가 항상 `null`일 수 있습니다 — 이 경우 마스크 카드는 항상 판단 보류로
표시됩니다. 이는 정상 동작이며 이번 PR의 결함이 아닙니다.

## Lifestyle 화면

`apps/mobile/src/app/(tabs)/lifestyle.tsx`는 Today/Hourly와 동일한 상태 분기 패턴을
재사용합니다.

- Saved-location 준비 중(`NOT_STARTED`/`LOADING`/`SELECTION_LOADING`): "생활날씨를 준비하고
  있습니다."
- `EMPTY`: "저장된 지역이 없습니다." + `지역 추가` 버튼(`/locations`로 push)
- Saved-location `ERROR`: 고정 안내 문구 + `다시 시도` 버튼(`retryInitialization()`)
- `READY`이지만 선택된 record가 목록에 없음(방어적 상태): "생활날씨를 준비하고 있습니다." — raw
  `selectedLocationId`나 임의 첫 지역 fallback 없음
- `READY` + weather `IDLE`/`LOADING`: 선택 지역명 + 고정 준비/로딩 문구
- `READY` + weather `ERROR`: 선택 지역명 + Today/Hourly와 동일한 네 가지 고정 안전 문구
  (`CONFIGURATION`/`NETWORK`/`API`/`INVALID_RESPONSE`) + `다시 시도` 버튼(`retry()`)
- `READY` + weather `SUCCESS`: 선택 지역명 + `createMobileLifestyleOverview(weatherQuery.data)`가
  반환한 네 카드를 고정 순서로 렌더링

각 카드는 `상태: {statusLabel}`, `이유: {reason}`, `행동: {recommendation}` 세 줄을 항상 표시하고,
`additionalRecommendation`이 `null`이 아닐 때만 `추가 안내: {additionalRecommendation}`를
추가로 표시합니다. 화면 제목과 각 카드 제목에는 `accessibilityRole="header"`를 사용하고, 버튼은
48×48 이상의 터치 영역을 갖습니다. 색상만으로 상태를 구분하지 않고, 새 아이콘/이미지/애니메이션이나
공통 design system은 도입하지 않았습니다.

## 이 작업에서 하지 않은 것

- `packages/lifestyle-engine`, contracts, weather-core, API, weather-query, saved-location 경계는
  전혀 변경하지 않았습니다.
- AirKorea 실제 연동, `current`/`daily`/`alerts`, response cache는 이번 PR 범위가 아닙니다.
- 실제 `POST /weather` 호출, dev-server QA, Expo Development Build, prebuild/native build, 실기기
  QA는 수행하지 않았습니다.
- 지역 재정렬, personalization, 사용자 설정, lifestyle 결과 persistence는 구현하지 않았습니다.
