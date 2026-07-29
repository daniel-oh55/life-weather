# 모바일 저장 지역 collection 경계

이 문서는 `apps/mobile/src/locations`의 **저장 지역 collection 경계**를 설명합니다. 이 경계는
여러 저장 지역을 하나의 **정규(canonical)·결정론적** 값으로 관리하는 런타임 schema와 순수
operation만 다룹니다. 실제 저장소·직렬화·마이그레이션·React 상태·화면·위치 권한·GPS·현재 위치
조회·KMA 격자 계산·실제 API 호출은 다루지 않습니다.

[저장 지역 한 건 경계](./mobile-saved-location.md)(PR #39)가 지역 하나의 모델과 요청 변환을
정의했다면, 이 collection 경계(PR #40)는 그 위에서 여러 건을 안전하게 다루는 경계를 더합니다.
기존 single-record schema를 **재사용**하며 어떤 위치 필드도 다시 선언하지 않습니다.

## 목적

- 여러 저장 지역을 하나의 canonical collection 값으로 표현합니다.
- collection이 항상 만족해야 하는 불변조건을 런타임 schema로 강제합니다.
- 지역 추가·삭제·재정렬·현재 위치 설정/해제를 **순수 함수**로 제공합니다.
- 모든 operation은 throw하지 않고, 입력을 mutate하지 않으며, 성공 시 fresh canonical collection을,
  실패 시 고정된 비노출 오류만 반환합니다.
- 이후 storage adapter가 이 collection schema를 **persistence boundary**로 사용해, 일관성이 깨진
  collection이 기기에 저장되는 것을 사전에 차단합니다.

## collection 후보(candidate)

지역 추가 caller는 표시 순서를 직접 정하지 않습니다. `mobileSavedLocationCandidate`는
`mobileSavedLocation`에서 **`sortOrder`만 제거하고 다시 strict로 만든** schema입니다.

```ts
mobileSavedLocation.omit({ sortOrder: true }).strict()
```

- 후보에는 공유 `WeatherLocation` 필드 + `kmaGrid` + `isCurrent`가 포함됩니다.
- 후보에 `sortOrder`(또는 다른 unknown key)가 들어오면 strict validation이 실패합니다.
- `kmaGrid` 등 나머지 필드 정책은 PR #39 single-record 규칙을 그대로 상속합니다.

`sortOrder`는 삽입 시 collection에서 파생되고, 모든 operation이 canonical `0..n-1`로 다시 씁니다.

## collection schema와 불변조건

`mobileSavedLocationCollection`은 기본적으로 `z.array(mobileSavedLocation)`이며 **빈 배열을
허용**합니다. 여기에 세 가지 불변조건을 더합니다.

### A. ID 유일성

모든 `id`는 collection 안에서 유일해야 합니다. 중복 `id`가 하나라도 있으면 validation이
실패합니다. `displayName`·좌표·`adminArea*`·`kmaGrid`는 **중복 판정 기준이 아닙니다** — 표시명이나
좌표가 같아도 opaque ID가 다르면 서로 다른 지역으로 허용합니다.

### B. 현재 위치 유일성

`isCurrent: true`인 record는 **0개 또는 1개**입니다. 2개 이상이면 실패합니다. "반드시 하나가
존재해야 한다"는 정책은 두지 않습니다 — 위치 권한 거부, 수동 지역만 사용, 현재 위치 삭제 상태를
모두 표현할 수 있어야 하기 때문입니다.

### C. canonical `sortOrder`

배열 index와 각 record의 `sortOrder`가 정확히 같아야 합니다.

```ts
locations[index].sortOrder === index
```

따라서 정상 collection은 항상 `0, 1, 2, …`로 읽힙니다. 중복 `sortOrder`, gap, 0이 아닌 시작값,
배열 순서와의 불일치, 역순·임의 순서는 모두 거부됩니다. 이 정책은 저장 데이터를 단일 canonical
representation으로 유지하기 위한 것입니다.

개별 element가 유효한 `mobileSavedLocation`이 아니면 위 cross-element 검사 이전에 element parse에서
먼저 실패합니다.

## 오류 모델

모든 operation은 다음 고정 discriminated result를 반환합니다.

```ts
type SavedLocationCollectionResult =
  | { ok: true; locations: MobileSavedLocation[] }
  | { ok: false; error: { kind: SavedLocationCollectionErrorKind } };
```

`kind`는 다음 중 하나입니다.

| kind | 의미 |
| --- | --- |
| `INVALID_COLLECTION` | 입력 collection이 schema 검증 실패. 다른 인자 오류보다 **우선**. |
| `INVALID_LOCATION` | add 후보가 candidate schema 검증 실패. |
| `DUPLICATE_LOCATION_ID` | 후보 `id`가 이미 collection에 존재. |
| `CURRENT_LOCATION_CONFLICT` | 현재 위치가 이미 있는데 current 후보를 추가. |
| `INVALID_LOCATION_ID` | id 인자가 사용 가능한 non-empty string이 아님. |
| `LOCATION_NOT_FOUND` | id가 collection에 없음. |
| `INVALID_REORDER` | ordered id 목록이 collection id 집합의 정확한 순열이 아님. |

오류는 throw하지 않고 고정 discriminator만 반환합니다. 동적 message, Zod issue, field path, 원문
ID·표시명·좌표·grid, 원본 collection, stack/cause를 담지 않으며, 호출마다 **fresh error object**를
반환합니다.

## 공통 처리 원칙

1. 먼저 입력 collection을 `mobileSavedLocationCollection.safeParse`로 검증합니다.
2. collection이 잘못됐으면 다른 인자와 무관하게 `INVALID_COLLECTION`을 반환합니다(우선순위 고정).
3. 그 뒤 operation별 인자를 검증합니다.
4. 성공 시 canonical collection을 반환하고, 반환 collection은 다시 schema 검증을 통과합니다.
5. 입력 collection과 record를 mutate하지 않습니다.
6. 성공 output array·모든 top-level record·null이 아닌 `kmaGrid` nested object는 모두 fresh입니다.
7. import·호출 시 storage·network·environment·logging 접근이 없습니다.

## operation

### 추가 — `addSavedLocation(collection, candidate)`

collection 검증 → candidate 검증(`INVALID_LOCATION`) → 중복 id(`DUPLICATE_LOCATION_ID`) →
current 충돌(`CURRENT_LOCATION_CONFLICT`) 순으로 확인한 뒤, 후보를 **끝에 append**합니다. 새
record의 `sortOrder`는 caller 값이 아니라 기존 collection length로 결정합니다. 기존 current record는
그대로 두며(현재 위치 교체는 `setCurrentSavedLocation`의 책임), non-current 후보는 current가 있어도
추가할 수 있고, 빈 collection에는 두 종류 모두 추가할 수 있습니다.

### 삭제 — `removeSavedLocation(collection, locationId)`

`locationId`는 non-empty string이어야 하며(공백-only는 거부), trim해 다른 ID로 바꾸지 않고 원문으로
매칭합니다. current record 포함 어떤 record든 삭제에 성공하고, 남은 record의 `sortOrder`는
`0..n-1`로 재인덱싱됩니다. 마지막 record를 지우면 허용되는 빈 collection이 됩니다.

### 재정렬 — `reorderSavedLocations(collection, orderedIds)`

`orderedIds`는 non-empty string 배열이며, 중복이 없고, 길이가 collection과 같고, 그 구성원이
collection의 id와 **정확히 같은 집합**(누락·추가 없음)이어야 합니다. 하나라도 어긋나면
`INVALID_REORDER`입니다. record를 요청 순서로 재배치하고 `sortOrder`를 새 index로 다시 쓰며,
`isCurrent`·`kmaGrid`를 비롯한 나머지 필드는 보존합니다. 빈 collection + 빈 id 목록과, 같은 순서의
no-op 재정렬도 성공하며 fresh output을 반환합니다.

### 현재 위치 설정/해제 — `setCurrentSavedLocation(collection, locationId | null)`

non-empty string id를 주면 해당 record만 `isCurrent: true`, 나머지는 모두 false가 됩니다. `null`을
주면 모든 record의 `isCurrent`를 false로 해제합니다. null이 아닌 비-string·빈 string은
`INVALID_LOCATION_ID`, collection에 없는 string id는 `LOCATION_NOT_FOUND`입니다. 이미 그 record만
current인 상태의 재설정과, 이미 current가 없을 때의 null 해제는 성공적인 no-op이며 fresh output을
반환합니다. 배열 순서와 `sortOrder`는 바뀌지 않고 `isCurrent` flag만 결정론적으로 바뀝니다. 이
함수는 record를 새로 추가하거나 GPS를 조회하지 않습니다.

## 입력 불변성과 fresh output

- 입력 collection·record·후보를 mutate하지 않습니다(caller가 freeze한 입력에도 throw하지 않음).
- 성공 output array는 새 배열이며, 모든 top-level record는 fresh object입니다.
- `kmaGrid`가 null이 아니면 nested object도 `{ ...kmaGrid }`로 fresh하게 복제됩니다. JSON
  stringify/parse 기반 clone은 사용하지 않습니다.

## 이 PR에서 하지 않는 것

이 경계는 schema와 순수 operation만 제공합니다. 다음은 후속 PR 범위입니다.

- AsyncStorage/SecureStore/SQLite/MMKV 등 storage adapter, storage key, 직렬화 버전, 마이그레이션,
  persisted JSON read/write
- React context, 상태 라이브러리(Zustand/Redux 등), hook
- 화면·navigation, 지역 추가/삭제/재정렬 UI, 위치 권한, GPS, geocoding, 지역 검색, 현재 위치 조회
- KMA 격자 계산, weather API client 실제 호출, API base URL
- collection 최대 개수 제한이나 표시명·좌표 중복 금지 같은 추가 정책

## 향후 소비

이 collection schema는 이미 [persistence 경계](./mobile-saved-location-persistence.md)(PR #41)가
**persistence boundary**로 사용합니다 — collection을 버전된 V1 envelope로 감싸 encode/decode하고,
저장 전에 이 schema로 검증해 일관성이 깨진 collection이 기기에 저장되지 않게 합니다. 다만 그 경계는
provider-neutral key-value port에만 의존하며, **실제 storage provider binding은 여전히 후속
작업**입니다. collection operation 자체의 책임(추가·삭제·재정렬·현재 위치 설정/해제와 불변조건)은
persistence 도입으로 바뀌지 않습니다.

화면 연결 시에는 개별 저장 지역을 [single-record 경계](./mobile-saved-location.md)의
`createWeatherRequestFromSavedLocation`으로 contract-safe `WeatherRequestV1`으로 변환한 뒤 [모바일
weather API client](./mobile-weather-api-client.md)에 전달합니다.
