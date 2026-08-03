# 모바일 weather-query 경계

이 문서는 `apps/mobile/src/weather-query`의 **weather-query 경계**를 설명합니다. 이 경계는
현재 선택된 저장 지역(`selectedLocationId`, [mobile-selected-location.md](./mobile-selected-location.md))을
기존 contract-safe [mobile weather API client](./mobile-weather-api-client.md)에 연결해 Today
화면이 최소 weather block을 렌더링할 수 있게 합니다.

## 전체 흐름

```text
SavedLocationApplicationSnapshot READY
→ selectedLocationId로 저장 지역 record 조회
→ createWeatherRequestFromSavedLocation(record)
→ mobileWeatherQueryStore.request(request)
→ WeatherApiClient.fetchWeather()
→ observable MobileWeatherQuerySnapshot (IDLE/LOADING/SUCCESS/ERROR)
→ apps/mobile/src/app/index.tsx의 weather block
```

- **store** (`mobile-weather-query-store.ts`, `createMobileWeatherQueryStore`) — provider-neutral
  상태 기계. `WeatherApiClient`만 주입받으며 React, Expo, `process.env`, saved-location store,
  AsyncStorage, logging를 import하지 않습니다.
- **production composition** (`mobile-weather-query-production.ts`) — `EXPO_PUBLIC_API_BASE_URL`을
  읽어 실제 `WeatherApiClient`를 구성하고 store에 주입하는 유일한 지점.
- **hook** (`use-mobile-weather-query.ts`, `useMobileWeatherQuery`) — 화면이 이미 읽은
  `SavedLocationApplicationSnapshot`을 인자로 받아 store를 구독하고, request/reset 시점을
  결정합니다. `useMobileSavedLocations()`를 다시 호출하지 않습니다.
- **pure barrel** (`index.ts`) — store 팩토리와 타입만 export합니다. production singleton과 hook은
  export하지 않습니다(native/React 의존을 pure barrel에 새지 않기 위함, 기존
  saved-location/hydration 경계와 동일한 원칙).

## `EXPO_PUBLIC_API_BASE_URL` 계약

`apps/mobile/.env.example`에 빈 placeholder로 선언되어 있습니다. Production 코드는 반드시 exact
static property access(`process.env.EXPO_PUBLIC_API_BASE_URL`)만 사용하며, 동적 key나
`Object.keys(process.env)` 같은 environment dump는 하지 않습니다. 값이 없거나 blank/invalid여도
import·construction 시 throw하지 않습니다 — 기존 [weather API client](./mobile-weather-api-client.md)의
`invalidClientConfiguration` `clientError`로 흡수되고, store는 이를 `ERROR`/`CONFIGURATION`으로
매핑합니다. 실제 Vercel domain이나 service key는 이 문서·예시·코드 어디에도 담지 않습니다.

## Request 시작 조건 (hook)

`useMobileWeatherQuery(savedLocations)`는 다음이 모두 참일 때만 request합니다.

```text
savedLocations.status === 'READY'
selectedLocationId와 같은 record가 locations에 존재
createWeatherRequestFromSavedLocation(record).ok === true
```

그 밖의 모든 상태와 reset 시점은 다음과 같이 구분됩니다.

- **초기 non-READY mount** (`NOT_STARTED`/`LOADING`/`SELECTION_LOADING`/`EMPTY`/`ERROR`로 처음
  mount) — request 0회이며, 이전에 시작된 query가 없으므로 `reset()`도 호출하지 않습니다(effect가
  `return undefined`로 끝남).
- **`READY` → non-READY로 전이** — 직전 `READY` effect의 cleanup이 이미 store를 `reset()`/abort하며,
  새 non-READY effect 자신은 추가로 reset하지 않습니다.
- **`READY`이지만 invariant가 깨진 synthetic snapshot** (선택 id가 `locations`에 없거나
  `createWeatherRequestFromSavedLocation`의 mapping이 실패하는 경우) — 현재 effect가 request 대신
  명시적으로 `reset()`을 호출합니다.

Effect dependency는 semantic key(`savedLocations.status`와 `READY`일 때의 `selectedLocationId`)만
사용하므로, 선택되지 않은 지역을 추가/삭제해 snapshot object만 바뀌어도 같은 선택의 weather를 다시
요청하지 않습니다.

## Request identity

`mobileWeatherQueryStore.request(request: WeatherRequestV1)`는 `locationId`를 별도 인자로 받지
않습니다 — `request.location.id`가 이 query의 유일한 identity이며, snapshot의 `locationId`도
여기서 파생됩니다. 별도 `locationId` 인자가 없으므로 호출자가 서로 다른 `locationId`/`request`
쌍을 전달할 수 없습니다. `retry()`도 내부에 보관된 동일 `WeatherRequestV1` 하나만 재사용하므로
같은 이유로 identity 불일치가 구조적으로 불가능합니다.

## Response location correlation

`SUCCESS`를 공개하기 전에 store는 응답의 `data.data.location`이 이 generation을 시작한
`WeatherRequestV1.location`과 아홉 개 공유 필드(`id`/`displayName`/`countryCode`/`adminArea1`/
`adminArea2`/`adminArea3`/`latitude`/`longitude`/`timezone`) 모두에서 정확히 일치하는지 explicit
field-by-field 비교로 검증합니다(`JSON.stringify`나 spread 비교 아님). 하나라도 다르면 client를
다시 호출하지 않고 `ERROR`/`INVALID_RESPONSE`로 매핑하며, 요청/응답 어느 쪽의 raw 값도 snapshot에
노출하지 않습니다. 모든 필드가 일치할 때만 `{ status: 'SUCCESS', locationId, data }`를 공개합니다.

## Single active request, generation guard, abort

Store는 한 시점에 논리적으로 하나의 request만 유지합니다. 새 `request()`/`retry()`는 내부
generation counter를 먼저 증가시켜 이전 completion을 무효화한 뒤에야 이전 `AbortController`를
abort합니다 — 그래서 superseded된 이전 request의 지연된 성공/오류(그리고 계약과 달리 client가
reject하는 out-of-contract 상황)는 stale generation으로 감지되어 조용히 버려지고 현재 상태를 절대
덮어쓰지 않습니다. 현재 generation에서 예상 밖으로 `aborted` clientError가 관측돼도 `ERROR`로
표시하지 않고 `IDLE`로 정리해 `LOADING`에 영구 고착되지 않게 합니다. `reset()`은 generation
무효화 → 활성 request abort → retry용 내부 context 제거 → `IDLE` 공개 순서이며, 이미 `IDLE`이고
활성 request가 없으면 semantic no-op입니다(listener 알림 없음).

`LOADING` publish는 subscribed listener를 동기적으로 실행할 수 있고, 그 listener가 재진입적으로
`reset()`/`request()`/`retry()`를 호출해 generation을 다시 증가시킬 수 있습니다. Store는 이
publish(및 그 직후의 이전 controller abort) 이후, `client.fetchWeather`를 호출하기 *전에* generation을
한 번 더 확인합니다 — 그래서 이런 재진입 reset/supersede가 발생한 generation은 stale client call을
전혀 만들지 않습니다(응답이 도착한 뒤 버려지는 것이 아니라 애초에 호출되지 않습니다).

## Retry 정책

`retry()`는 `ERROR`에서만 store 내부에 보관된 동일 `WeatherRequestV1`으로 새 generation을
시작합니다. `WeatherRequestV1`은 이 목적에만 보관되며 snapshot이나 오류에 노출되지 않습니다.
`IDLE`/`LOADING`/`SUCCESS`에서는 no-op이고, timer·backoff·자동 retry는 없습니다.

## Safe error presentation

Snapshot의 `ERROR` variant는 고정된 `MobileWeatherQueryErrorPresentation`
(`CONFIGURATION`/`NETWORK`/`API`/`INVALID_RESPONSE`)만 담습니다 — raw client error kind, API
`code`/`message`/`retryable`, URL, `requestId`, 좌표, grid는 어디에도 노출되지 않습니다. 화면은
`presentation`만 고정 한국어 문구로 매핑합니다.

## Hourly 빈 배열과 `current: null`

`SUCCESS` snapshot의 `data`는 client가 이미 검증한 `WeatherSuccessResponseV1` 그대로이며 복사·
재정의하지 않습니다. 화면은 `data.data.hourly[0]`이 있으면 최소 필드(`forecastAt`,
`temperatureCelsius`, 한국어 condition 라벨, `precipitationProbabilityPercent`가 `null`이 아닐 때만
강수확률)를 표시합니다. `hourly`가 비어 있으면 오류가 아니라 "표시할 시간별 예보가 없습니다."를
표시하고, `current: null`도 정상 success로 처리해 아무것도 렌더링하지 않습니다(현재 화면은
`current`를 표시하지 않습니다).

## 이 경계에서 하지 않는 것

- 실제 network 호출과 실제 device QA — 모든 테스트는 injected `fetchImpl`/mock client만 사용합니다.
- current/daily/AirKorea/alerts, response cache, lifestyle-engine 연동.
- 실제 `EXPO_PUBLIC_API_BASE_URL` 운영 값 설정과 실제 endpoint 검증.
- 완성형 Today 디자인, 위치 권한, reorder UI.
