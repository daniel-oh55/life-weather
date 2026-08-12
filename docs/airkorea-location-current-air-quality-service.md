# AirKorea Location Current Air-Quality Application Service

이 문서는 이미 검증된 `WeatherLocation`을 세 AirKorea provider boundary — PR #84
(행정구역명 → TM 좌표), PR #83(TM 좌표 → 근접측정소), PR #82(측정소명 → 실시간
측정정보 + 기존 정규화) — 를 순서대로 연결해 공유 contract `CurrentAirQuality`를
만드는 **application service**
(`createAirKoreaLocationCurrentAirQualityService`,
`apps/api/src/services/airkorea-location-current-air-quality.ts`)를 기록합니다.

이 PR(#85)은 **application 계층까지만** 구현합니다. production composition,
`POST /weather` 연결, `WeatherOverview.airQuality.current` 조립은 이 PR 범위가
아닙니다.

## PR #82/#83/#84 ownership 경계

이 service는 세 provider 중 어느 것도 재구현하지 않습니다.

* **PR #84** (`tmCoordinateProvider.fetchTmCoordinates`) — request 검증·URL
  생성·raw schema·성공/upstream/invalid 분류·TM 좌표 파싱을 소유합니다. 하나의
  `umdName`이 여러 후보(candidate)를 합법적으로 반환할 수 있음(동명이동)을
  이유로 candidate를 하나로 좁히지 않습니다.
* **PR #83** (`nearbyStationProvider.fetchNearbyStations`) — request
  검증·URL 생성·raw schema·성공/upstream/invalid 분류·거리(km) 파싱을
  소유합니다. upstream이 정렬 순서를 보장하지 않으므로 "가장 가까운 측정소"를
  선택하지 않습니다.
* **PR #82** (`currentAirQualityProvider.fetchCurrentAirQuality` +
  `normalizeAirKoreaCurrentAirQuality`) — request 검증·URL 생성·raw
  schema·"최신 측정값" 선택·`CurrentAirQuality`로의 정규화를 소유합니다. 이
  service는 정규화 규칙(sentinel 처리, 등급 매핑, KST `measuredAt` 계산 등)을
  전혀 재구현하지 않고 기존 `normalizeAirKoreaCurrentAirQuality`를 그대로
  호출합니다.

이 service가 새로 추가하는 것은 정확히 두 application-owned 결정뿐입니다 — 어떤
TM candidate가 `WeatherLocation`의 행정구역과 일치하는지, 그리고 어떤 근접
측정소가 가장 가까운지.

## Pipeline

```text
{ location }
  → weatherLocation.parse(location)                     // contracts runtime validation (upfront)
  → 지원 위치 검증 (KR, adminArea1/adminArea3 non-null)
  → tmCoordinateProvider.fetchTmCoordinates({ umdName: adminArea3 })   // PR #84, 1회
  → 정확 일치 candidate 해소 (sidoName/sggName/umdName)
  → nearbyStationProvider.fetchNearbyStations({ tmX, tmY })            // PR #83, 1회
  → 최근접 측정소 선택 (distanceKm, 동점 시 stationName)
  → currentAirQualityProvider.fetchCurrentAirQuality({ stationName })  // PR #82, 1회
  → normalizeAirKoreaCurrentAirQuality                                  // 기존 정규화기
  → { ok: true, current }
```

## Supported-location 정책

이 PR에서 AirKorea 현재 대기질 조회는 PR #84 boundary를 호출하기에 충분한
행정구역 정보를 가진 대한민국 `WeatherLocation`만 지원합니다.

* `countryCode === 'KR'` — 아니면 `UNSUPPORTED_COUNTRY`.
* `adminArea1 !== null`, `adminArea3 !== null` — 공식 계약(shared
  `weatherLocation` schema)이 세 administrative area 모두를 `string | null`로
  허용하고, 기존 모바일 카탈로그가 의도적으로 시/도-구 수준(예: `서울특별시
  중구`, `adminArea3: null`)의 location도 포함하기 때문에, `adminArea3`가
  없는 location은 fail-closed됩니다 — `UNSUPPORTED_ADMINISTRATIVE_LEVEL`.
* `adminArea2`는 `null`일 수 있습니다 — 공유 계약이 2단계 행정구역 계층을
  허용하므로, `adminArea2 === null`인 location은 그 필드만 비교에서
  제외됩니다(아래 "TM candidate 해소 정책" 참고).

이 service는 `adminArea2`나 `displayName`을 대신 `umdName`으로 사용하거나,
임의의 하위 동을 추측하거나, 위도/경도를 TM 좌표처럼 취급하거나, WGS84→TM
변환을 발명하지 않습니다. `LOCATION` 오류는 정적이고 값이 없는(value-free)
`kind`만 노출하며 위도/경도/행정구역명/`displayName`/provider URL/raw 값을
전혀 포함하지 않습니다.

## TM candidate 해소 정책

PR #84는 candidate를 선택하지 않고 구조적으로 유효한 모든 candidate를 그대로
반환합니다(동명이동으로 인해 하나의 `umdName`이 여러 시군구에 존재할 수
있음). 이 service는 다음 **정확 일치**(exact match) 규칙으로 candidate를
좁힙니다 — trim/fuzzy/prefix/alias/locale 정규화 없음:

* `candidate.sidoName === location.adminArea1`
* `candidate.umdName === location.adminArea3`
* `location.adminArea2 !== null`일 때만: `candidate.sggName ===
  location.adminArea2`

결과:

| 정확 일치 개수 | 결과 |
| --- | --- |
| 정확히 1 | 해당 candidate 선택 |
| 0 | `LOCATION` / `TM_COORDINATE_NOT_FOUND` |
| 2 이상 | `LOCATION` / `AMBIGUOUS_TM_COORDINATE` |

`candidates[0]`을 정답으로 가정하지 않습니다. PR #84 문서가 기록한 "정확
일치 대 partial/fuzzy 매칭"에 대한 evidence gap은 그대로 남아 있습니다 — 이
service는 그 gap을 해결하지 않고, 대신 최종 해소 단계에서 완전한 행정구역
일치를 요구하는 보수적인 정책을 선택했을 뿐입니다. PR #84 provider 자체의
응답 검증 동작은 변경하지 않았습니다.

## 최근접 측정소 정책

PR #83은 upstream 정렬 순서를 보장하지 않으므로 `stations[0]`을 사용하지
않습니다. 대신:

1. **주 키**: `distanceKm`이 가장 작은 candidate.
2. **동점 tie-break**: `distanceKm`이 같으면 `stationName`을 오름차순(`<`/
   `>`에 의한 locale-independent 비교, `localeCompare` 아님)으로 비교해 더
   작은 쪽을 선택합니다. 이는 upstream 배열 순서와 무관한 project-owned
   결정론적 규칙입니다.

PR #83은 provider 성공이 항상 비어 있지 않은 candidate 목록을 반환한다고
보장합니다. 만약 이 불변조건이 런타임에 깨진다면(방어적 케이스), 이
service는 존재하지 않는 측정소를 조작(fabricate)하지 않고 정적인 `LOCATION`
/ `NEARBY_STATION_NOT_FOUND` 오류로 fail-closed됩니다.

## Provider 호출 순서 / 최대 호출 수

실행은 엄격히 순차적입니다 — `Promise.all` 없음:

```
TM 조회 → candidate 해소 → 근접측정소 조회 → 최근접 선택 → 현재 대기질 조회 → 정규화
```

지원되는 요청 한 건이 성공할 때 provider 호출은 **최대 3회**(TM 1 +
근접측정소 1 + 현재 대기질 1)입니다. 재시도, 이전 candidate로의 fallback,
두 번째 TM/측정소 시도, 캐시, 타이머, system clock, 환경변수 읽기, 로깅은
없습니다.

각 provider 호출은 fresh request 객체(`{ umdName }` / `{ tmX, tmY }` /
`{ stationName }`)를 사용하며, caller의 `options`(그 안의 `AbortSignal`
포함)를 정확히 같은 참조로 세 provider 모두에 전달합니다 — 새
`AbortController`를 생성하지 않습니다.

## 결과 / 오류 stage

```ts
type AirKoreaLocationCurrentAirQualityResult =
  | { ok: true; current: CurrentAirQuality }
  | { ok: false; stage: 'LOCATION'; error: AirKoreaLocationCurrentAirQualityLocationError }
  | { ok: false; stage: 'TM_COORDINATE_PROVIDER'; error: AirKoreaTmCoordinateProviderError }
  | { ok: false; stage: 'NEARBY_STATION_PROVIDER'; error: AirKoreaNearbyStationProviderError }
  | { ok: false; stage: 'CURRENT_PROVIDER'; error: AirKoreaCurrentAirQualityProviderError }
  | { ok: false; stage: 'NORMALIZATION'; issues: readonly AirKoreaCurrentNormalizationIssue[] };
```

`LOCATION` kind는 application-owned 정적 값입니다: `UNSUPPORTED_COUNTRY`,
`UNSUPPORTED_ADMINISTRATIVE_LEVEL`, `TM_COORDINATE_NOT_FOUND`,
`AMBIGUOUS_TM_COORDINATE`, `NEARBY_STATION_NOT_FOUND`(방어적 케이스). 세
provider stage는 해당 provider의 error 타입/reference를 그대로 재사용하며
재분류하지 않습니다. `NORMALIZATION`은 기존 PR #82
`normalizeAirKoreaCurrentAirQuality`의 issues를 그대로 사용합니다. 성공
결과는 `current: CurrentAirQuality` 하나만 노출하며 `stationName`, TM 좌표,
candidate 목록, 거리, raw provider observation, URL/body/key는 전혀
포함하지 않습니다.

## 실행 semantics

* `weatherLocation.parse`가 첫 연산입니다 — invalid location은 동기
  `ZodError`로 전파되고 어떤 provider도 호출되지 않습니다.
* 이 method는 `async`가 아닙니다 — 첫 provider(TM)의 동기 throw는 동기
  전파되고, 이후의 모든 Promise rejection이나 collaborator throw는 반환된
  Promise를 동일 reference로 reject합니다. 광범위한 `try`/`catch`는
  없습니다.
* 어떤 provider도 재시도되지 않고, 어떤 provider의 response도 재분류되지
  않습니다.
* caller input(`location`)과 provider가 반환한 candidate 배열은 변경되지
  않습니다. 매 호출은 fresh output을 만듭니다.

## Construction

`createAirKoreaLocationCurrentAirQualityService(tmCoordinateProvider,
nearbyStationProvider, currentAirQualityProvider)`는 side-effect-free입니다
— construction 시 fetch·환경변수 읽기·clock read·timer·logging이 없고, 세
주입된 provider reference만 closure로 보관합니다.

## 범위 확인 (이 PR에서 구현하지 않은 것)

* production composition, `POST /weather` route 연결
* KMA + AirKorea `WeatherOverview` aggregate 조립(`airQuality.current` 채우기)
* WGS84 위경도 → TM 좌표 변환, `getMsrstnList`, 현재 위치(GPS)
* 지역 검색/district→dong UX 변경
* source metadata, 재시도/backoff, 응답 캐시
* AirKorea 예보(forecast), 대기질 특보
* mobile UI
* 실제 AirKorea endpoint 호출, 실제 `AIRKOREA_SERVICE_KEY`, 실제 사용자 위치
