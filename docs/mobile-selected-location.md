# 모바일 선택 지역(selected location) 상태

이 문서는 `apps/mobile/src/locations`의 **선택 지역 상태**를 설명합니다. 이 경계는 사용자가
저장 지역 중 현재 조회 대상으로 선택한 지역의 id(`selectedLocationId`)를 기기에 별도로 저장·
복원하고, 저장 지역 collection과의 정합성을 [application store](./mobile-saved-location-application.md)
계층에서 조정합니다.

## `isCurrent`와 `selectedLocationId`

두 개념은 절대 결합하지 않습니다.

```text
isCurrent
= GPS로 생성된 실제 기기 현재 위치 record 여부
= mobile-saved-location.ts가 소유, 이 PR에서 의미·값 변경 없음

selectedLocationId
= 사용자가 앱에서 현재 조회 대상으로 선택한 저장 지역 ID
= 이 PR이 추가한 별도 preference, 화면의 "선택됨" 표시가 참조하는 유일한 값
```

`isCurrent: true`인 record가 존재해도 그 record가 자동으로 선택되지 않으며, 홈 화면은 `isCurrent`를
선택 표시로 사용하지 않습니다.

## 별도 key와 V1 envelope

**module 경로**: `apps/mobile/src/locations/mobile-selected-location-persistence.ts`.

```ts
export const SELECTED_LOCATION_PERSISTENCE_KEY =
  '@life-weather/mobile/selected-location' as const;

export const SELECTED_LOCATION_PERSISTENCE_VERSION = 1 as const;
```

기존 저장 지역 key(`SAVED_LOCATION_PERSISTENCE_KEY`, `@life-weather/mobile/saved-locations`)와
분리되어 있어 두 preference는 독립적으로 읽기·쓰기·실패할 수 있습니다. Version은 key와 별도로
envelope 내부에 저장해 향후 migration이 같은 key에서 이전 버전을 읽을 수 있게 합니다.

Payload는 strict envelope입니다.

```ts
{ version: 1, selectedLocationId: string | null }
```

id schema는 기존 `mobileSavedLocation.shape.id`(공유 `nonEmptyString`)를 `.nullable()`로 감싼
것으로, 별도 문자열 규칙을 재선언하지 않습니다. Timestamp, device id, 좌표, KMA grid, `isCurrent`,
sortOrder, contract version은 어디에도 담기지 않습니다.

### Codec과 persistence 계약

`encodeSelectedLocationId`/`decodeSelectedLocationId`는 기존 saved-location codec과 동일한 순서로
동작합니다 — 입력 schema 검증 → canonical envelope 생성 → 재검증 → `JSON.stringify`, decode 시
`JSON.parse` → 정수 버전 우선 분류 → strict V1 parse. 동일 입력은 항상 동일한 직렬화 문자열을
만듭니다.

`SelectedLocationPersistence`는 `load()`/`save()` 두 메서드만 제공합니다(`clear()` 없음). 선택을
지우는 것은 `save(null)`로 명시적인 V1 envelope를 쓰는 것이며, `removeItem()`이나 `clear()`를
호출하지 않습니다.

```text
missing key                → 성공, selectedLocationId: null
INVALID_SELECTED_LOCATION_ID → save 시 id schema 위반
INVALID_STORED_SELECTION     → load 시 손상된/형식이 다른 저장값
UNSUPPORTED_STORED_VERSION   → load 시 지원하지 않는 정수 version
STORAGE_READ_FAILED          → load 시 injected storage의 동기 throw/rejection
STORAGE_WRITE_FAILED         → save 시 injected storage의 동기 throw/rejection
```

모든 실패는 `{ kind }`만 담는 고정 객체이며, raw stored value·storage key·입력 id·native error
message/stack/cause를 포함하지 않고, 어떤 입력에도 throw하지 않습니다. 손상된 stored value는
자동으로 삭제·repair·migration되지 않고 fail-closed합니다.

### AsyncStorage binding

**module 경로**: `apps/mobile/src/locations/mobile-selected-location-async-storage.ts`.

실제 `@react-native-async-storage/async-storage`의 `getItem`/`setItem` **두 메서드만** provider-
neutral port로 위임합니다(`removeItem`은 위임하지 않음 — 이 boundary는 `removeItem`을 전혀 쓰지
않습니다). `clear()`/`getAllKeys()`/`multi*` 같은 broad API는 쓰지 않고, key를 다시 선언하지
않으며, 오류를 변환하지 않고, import·instance 생성만으로는 storage I/O를 수행하지 않습니다. 새
dependency는 추가하지 않았습니다 — 기존 `@react-native-async-storage/async-storage` 인스턴스를
재사용합니다.

`mobileSelectedLocationPersistence` production instance와 이 binding 자체는 **pure barrel
`apps/mobile/src/locations/index.ts`에서 export하지 않습니다.** Provider-neutral codec/factory/타입만
pure barrel에서 export됩니다. 기존 `mobile-saved-location-async-storage.ts`는 generic storage
abstraction으로 리팩터링하지 않았습니다 — 두 개의 작은 concrete binding이 공유 추상화보다 기존
보호 경계를 덜 흔듭니다.

## Application store로의 통합

선택 상태의 조정 로직은 새 module을 만들지 않고 기존
[`mobile-saved-location-application-store.ts`](./mobile-saved-location-application.md)에
추가됐습니다. 이 store가 이미 committed collection·persist-before-publish·단일 write lock·
deep-freeze snapshot을 소유하므로, 선택 상태도 같은 계층에서 조정하는 것이 새 coordinator나 React
Context를 추가하는 것보다 안전합니다.

### Selected 초기화 상태 기계

내부적으로 별도의 작은 상태 기계를 둡니다(공개 snapshot과는 다른 내부 상태).

```text
NOT_STARTED → LOADING → READY(selectedLocationId: string | null)
                       → ERROR(fixed kind)
```

`initializeSelectedLocation()`이 명시적으로 호출되기 전까지는 construction/import만으로 selected
persistence를 읽지 않습니다. 저장 지역 hydration이 성공(즉 committed collection이 확정)하기 전에
호출되면 persistence를 건드리지 않는 안전한 no-op입니다.

### Application snapshot

```text
NOT_STARTED / LOADING       — 기존 saved-location hydration 상태(무변경)
SELECTION_LOADING           — saved hydration은 끝났지만 선택 preference가 아직 로딩 중
EMPTY  { selectedLocationId: null }
READY  { locations, selectedLocationId: string, writeStatus }
ERROR  { error: { scope: 'SAVED_LOCATIONS' | 'SELECTED_LOCATION'; kind }, writeStatus: 'IDLE' }
```

**불변조건.** `EMPTY`의 `selectedLocationId`는 항상 `null`입니다. `READY`의
`selectedLocationId`는 항상 non-empty string이며 `locations` 안에 동일 id의 record가 정확히
1개 존재합니다. `SELECTION_LOADING`을 거치지 않고는 `EMPTY`/`READY`가 공개되지 않으므로, 선택
preference를 아직 해석하지 못한 상태로 `READY`가 노출되는 경우는 없습니다.

### Resolution 알고리즘(fallback)

`initializeSelectedLocation()`은 저장된 raw preference와 committed collection을 다음 순서로
합칩니다.

```text
collection이 비어 있으면        → resolved selectedLocationId = null
persisted id가 collection에 있으면 → 그 id 그대로 사용
persisted id가 null/누락이면      → collection[0](sortOrder === 0) id
persisted id가 stale(없음)이면    → collection[0](sortOrder === 0) id
```

Fallback을 계산했다고 해서 그 값을 자동으로 저장소에 다시 쓰지는 않습니다. 이는 의도된
동작입니다.

- startup hydration을 read-only로 유지해 예상치 못한 write를 만들지 않습니다.
- 손상되었거나 오래된 데이터를 조용히 덮어써서 복구 여지를 없애지 않습니다.
- 이후 매 초기화 cycle마다 fallback은 항상 authoritative collection으로 다시 검증되므로, invalid한
  id가 `READY` snapshot에 노출될 위험이 없습니다.

사용자가 이후 명시적으로 선택하거나(§ select) collection mutation이 선택을 바꾸면(§ add/remove)
정상 write 경로로 새 preference가 저장됩니다.

### 앱 시작 순서

**module 경로**: `apps/mobile/src/locations/mobile-location-application-startup.ts`.
**export 이름**: `startMobileLocationApplicationOnce()`.

```text
1. startMobileSavedLocationHydrationOnce() 호출 (기존 one-shot 계약 무변경)
2. 그 Promise가 settle된 후, 저장 지역이 ERROR가 아니면
   mobileSavedLocationApplicationStore.initializeSelectedLocation() 호출
3. 전체 시퀀스는 module lifetime당 한 번만 실행되고, 반복·동시 호출은 같은 combined Promise를 공유
```

기존 `startMobileSavedLocationHydrationOnce()`의 정확한 one-shot Promise 계약, 그리고 그것이
호출하는 hydration **store**(manager 아님)와의 관계는 바뀌지 않았습니다. `apps/mobile/src/app/
_layout.tsx`는 이제 이 새 app-level startup 하나만 호출합니다 — import나 `<Stack />` render가
hydration·초기화 완료를 기다리지 않는 것도 그대로입니다.

저장 지역 hydration이 `ERROR`로 끝나면 이 시퀀스는 선택 preference를 읽지 않습니다. 이후 명시적
retry는 §「Retry 라우팅」을 따릅니다.

### Retry 라우팅

**export 이름**: `mobileSavedLocationApplicationStore.retryInitialization()`.

```text
현재 ERROR.scope === 'SAVED_LOCATIONS' → retryHydration()을 호출하고,
                                          그 retry가 성공한 뒤에만 selected 초기화를 실행
현재 ERROR.scope === 'SELECTED_LOCATION' → selected 초기화만 다시 실행
EMPTY/READY/그 외                        → no-op
```

`retryHydration()`의 기존 exact hydration-store Promise 반환 계약은 바뀌지 않았습니다. 홈 화면의
`다시 시도` 버튼은 이제 이 통합 `retryInitialization()`을 호출합니다. Timer, backoff, 자동 retry는
없습니다.

## Selection 정책

**export 이름**: `mobileSavedLocationApplicationStore.select(locationId: unknown)`.

`READY`에서만 허용됩니다. 검증 순서: `SAVING` 중이면 `WRITE_IN_PROGRESS` → non-string/blank id는
`INVALID_LOCATION_ID` → 현재 selected id와 같으면 **성공한 no-op**(selected persistence write
0회, saved-location persistence write 0회, notification 0회) → collection에 없으면
`LOCATION_NOT_FOUND`.

다른 지역을 선택하면: `SAVING` 공개 → `selectedLocationPersistence.save(newId)`를 정확히 1회 호출
→ 성공한 뒤에만 `selectedLocationId`를 공개(실패 시 기존 선택 유지, optimistic update 없음) →
`IDLE` 복귀. 이 과정에서 saved-location collection persistence는 전혀 호출되지 않습니다.

## Add/Remove와의 cross-key 조정

Add·remove의 pure collection 검증과 persist-before-publish는 [PR #50 문서](./mobile-saved-location-application.md)의
기존 계약을 그대로 따릅니다. 이 PR은 그 위에 선택 상태와의 조정만 추가합니다.

### 첫 지역 추가(EMPTY → READY)

```text
1. 순수 add 결과 계산
2. selected persistence에 candidate.id를 저장 (write #1)
3. 성공하면 saved collection을 저장 (write #2)
4. 두 write가 모두 성공한 뒤에만 새 READY snapshot(선택된 새 지역 포함)을 공개
```

`READY`에 추가할 때는 기존 selected id를 그대로 유지하며, selected persistence write는 0회입니다
(collection persistence write만 1회).

**Selected write(#1) 실패** — collection write(#2)는 시도되지 않고, snapshot은 `EMPTY`로
남습니다.

**Collection write(#2) 실패** — snapshot은 `EMPTY`로 남고, selected key에는 candidate.id가 이미
쓰였을 수 있습니다(residual). 이 잔여값은 안전합니다 — snapshot이 여전히 `EMPTY`이므로 다음
`initializeSelectedLocation()` cycle에서 collection이 EMPTY로 재확인되면 resolved
selectedLocationId는 항상 `null`로 재계산되어, stale한 candidate.id가 노출되지 않습니다. 보상
write나 rollback queue는 만들지 않습니다.

### 지역 삭제와 fallback

삭제 전 index를 기준으로 fallback을 정합니다(after collection 기준).

```text
after collection의 같은 index에 record가 있으면 → 그 record
없으면(꼬리가 비었으면)                          → after collection의 마지막 record
after가 비었으면                                 → null
```

예:

```text
[A(selected,0), B(1), C(2)]에서 A 삭제 → after=[B(0),C(1)] → fallback B
[A(0), B(selected,1), C(2)]에서 B 삭제 → after=[A(0),C(1)] → fallback C
[A(0), B(1), C(selected,2)]에서 C 삭제 → after=[A(0),B(1)] → fallback B
[A(selected,0)]에서 A 삭제             → after=[]          → fallback null
```

선택되지 않은 지역을 삭제할 때는 selected persistence write가 0회이고 selected id가 그대로
유지됩니다.

선택된 지역을 삭제할 때의 순서:

```text
1. 순수 remove 결과와 위 fallback을 계산
2. selected persistence에 fallback을 저장 (write #1)
3. 성공하면 saved collection을 저장 (write #2)
4. 둘 다 성공한 뒤에만 새 collection과 fallback을 공개
```

**Selected write(#1) 실패** — collection write(#2)는 시도되지 않고, 기존 snapshot(이전 selection
포함)이 그대로 유지됩니다.

**Collection write(#2) 실패** — 기존 snapshot이 유지됩니다. Persisted preference는 이미
fallback으로 바뀌어 있을 수 있습니다(residual). 이 fallback은 항상 (변경되지 않은) 기존
collection에도 존재하거나 `null`이므로 민감정보나 invalid id를 노출할 위험이 없습니다. 다음
초기화 cycle에서 이 fallback은 (여전히 이전과 동일한) collection에 대해 재검증되어 안전하게
재해석됩니다. 보상 write나 rollback queue는 만들지 않습니다.

## 단일 write lock

기존 `writeStatus: IDLE | SAVING`을 `add`/`remove`/`select` 세 mutation이 모두 공유합니다. 어느
write가 진행 중이든 다른 mutation은 persistence를 전혀 호출하지 않고 즉시 `WRITE_IN_PROGRESS`를
반환합니다. 두 번째 storage write, queue, debounce, batching, compare-and-swap은 만들지
않습니다.

## Production composition

`apps/mobile/src/locations/mobile-saved-location-application-production.ts`가 세 번째 singleton
`mobileSelectedLocationPersistence`(`./mobile-selected-location-async-storage`)를 기존 두
singleton(hydration store, saved-location persistence)과 함께 정확히 한 번씩 주입합니다. Import나
singleton 참조만으로는 storage I/O도 초기화도 발생하지 않습니다.

## 홈 화면

`apps/mobile/src/app/index.tsx`가 각 저장 지역 행에 선택 표시를 추가합니다.

- 선택된 행은 `선택됨` 레이블의 비활성 버튼(`accessibilityState={{ selected: true, disabled: true
  }}`)으로 표시됩니다.
- 다른 행은 `선택` 버튼(`accessibilityLabel="<지역명> 선택"`, `accessibilityState={{ selected:
  false, disabled: <SAVING 중 여부> }}`)을 제공합니다.
- `SELECTION_LOADING` 상태는 `선택 지역을 준비하는 중입니다.`만 표시합니다.
- 선택 저장 실패와 collection 저장 실패는 동일한 generic 문구
  (`저장 지역 변경을 저장하지 못했습니다.`)로만 표시되며, raw kind·storage key·위치 ID·좌표·grid는
  어디에도 노출되지 않습니다.
- 모든 터치 영역은 최소 48×48이고, `SAVING` 중에는 지역 추가·선택·삭제 컨트롤이 모두
  비활성화됩니다.
- `isCurrent`는 선택 표시로 쓰이지 않습니다.

## 이 경계에서 하지 않는 것(후속 범위)

- 실제 weather API 호출, API base URL, `EXPO_PUBLIC_*`, `createWeatherApiClient()` production
  composition.
- response loading/error/stale store.
- GPS·위치 권한, `isCurrent` 값의 변경.
- 지역 재정렬, 좌우 스와이프, 상단 dropdown 최종 디자인.
- native build, development client 재빌드, 실제 기기 QA.
