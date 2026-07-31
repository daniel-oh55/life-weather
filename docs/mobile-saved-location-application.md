# 모바일 저장 지역 application store

이 문서는 `apps/mobile/src/locations`의 **저장 지역 application store**를 설명합니다. 이 경계는
[hydration 경계](./mobile-saved-location-hydration.md)가 제공하는 observable
`SavedLocationHydrationStore`, [persistence 경계](./mobile-saved-location-persistence.md)가 제공하는
`SavedLocationPersistence`, 그리고 [선택 지역 persistence 경계](./mobile-selected-location.md)가
제공하는 `SelectedLocationPersistence` — 이렇게 세 개의 provider-neutral collaborator를 주입받아
**write 측 책임**을 소유합니다 — hydration된 collection과 선택 preference 위에서 mutation과 초기화를
계산하고, 저장/로드에 성공한 뒤에야 새 상태를 React consumer에 공개합니다.

기존 hydration manager·hydration store·startup boundary·hydration hook의 공개 계약은 이 PR에서
바뀌지 않았습니다.

> **PR #52 갱신**: 이 store는 이제 사용자가 현재 조회 중인 저장 지역을 나타내는
> `selectedLocationId`도 함께 소유합니다 — `isCurrent`(기기의 실제 GPS 현재 위치 record 여부)와는
> 절대 결합하지 않는 별도 preference입니다. 아래 snapshot·mutation 설명은 이 확장을 반영해
> 갱신됐습니다. 선택 상태의 별도 key/envelope, resolution(fallback) 알고리즘, 앱 시작 순서,
> add/remove의 cross-key write 순서 같은 세부 계약은
> [mobile-selected-location.md](./mobile-selected-location.md)에서 다룹니다.

## 목적

- hydration 상태를 관찰해 하나의 application snapshot으로 노출합니다.
- 명시적 사용자 retry를 hydration store의 `hydrate()`로 위임합니다.
- 선택 지역 preference 초기화(selected initialization)를 소유합니다(`initializeSelectedLocation()`).
- persistence를 사용하는 `add`/`remove`/`select` mutation을 제공합니다.
- 빈 collection에 첫 지역을 추가하면 자동으로 그 지역을 선택합니다(first-add auto-selection).
- 선택된 지역을 삭제하면 문서화된 index 기반 fallback으로 선택을 갱신합니다(selected-delete
  fallback).
- `select`/`add`/`remove`의 cross-key write 순서를 소유합니다.
- **저장 성공 후에만** 새 상태를 공개합니다(optimistic update 없음).
- 저장 실패 시 이전 committed collection/선택을 그대로 유지합니다.
- `add`/`remove`/`select`가 하나의 write lock을 공유해, 동시/재진입 mutation이 두 번째 write를
  시작하지 않게 합니다.

## 공개 계약

- **module 경로**: `apps/mobile/src/locations/mobile-saved-location-application-store.ts`.
- **export 이름**: `createSavedLocationApplicationStore({ hydrationStore, persistence,
  selectedLocationPersistence })`.

```ts
interface SavedLocationApplicationStore {
  getSnapshot(): SavedLocationApplicationSnapshot;
  subscribe(listener: SavedLocationApplicationStoreListener): () => void;
  retryHydration(): Promise<void>;
  initializeSelectedLocation(): Promise<void>;
  retryInitialization(): Promise<void>;
  select(locationId: unknown): Promise<SavedLocationApplicationMutationResult>;
  add(candidate: unknown): Promise<SavedLocationApplicationMutationResult>;
  remove(locationId: unknown): Promise<SavedLocationApplicationMutationResult>;
}
```

이 경계는 provider-neutral합니다 — 주입 타입은 `SavedLocationHydrationStore`,
`SavedLocationPersistence`, `SelectedLocationPersistence` 세 개이고, 셋 다 provider-neutral
interface입니다. 이 module은 React·Expo·AsyncStorage concrete module·production
singleton·logging/telemetry를 import하지 않습니다. module import와 factory 호출만으로는
`hydrate()`도 선택 지역 read도 어떤 storage I/O도 발생하지 않습니다(hydration store의 부작용 없는
`getSnapshot()`을 생성 시 한 번 읽고 subscribe할 뿐이며, 선택 지역 초기화는 명시적
`initializeSelectedLocation()` 호출로만 시작됩니다).

`reorder`, `setCurrent`(기기의 실제 GPS 현재 위치 의미 — `isCurrent`를 갱신하는 동작이며 선택
preference와는 무관합니다), clear-all, migration, background refresh, weather
request/network는 이 경계에 포함되지 않습니다.

## Application snapshot

```ts
type SavedLocationApplicationWriteStatus = 'IDLE' | 'SAVING';

type SavedLocationApplicationSnapshot =
  | { readonly status: 'NOT_STARTED'; readonly writeStatus: 'IDLE' }
  | { readonly status: 'LOADING'; readonly writeStatus: 'IDLE' }
  | { readonly status: 'SELECTION_LOADING'; readonly writeStatus: 'IDLE' }
  | {
      readonly status: 'EMPTY';
      readonly selectedLocationId: null;
      readonly writeStatus: SavedLocationApplicationWriteStatus;
    }
  | {
      readonly status: 'READY';
      readonly locations: readonly MobileSavedLocation[];
      readonly selectedLocationId: string;
      readonly writeStatus: SavedLocationApplicationWriteStatus;
    }
  | {
      readonly status: 'ERROR';
      readonly error: {
        readonly scope: 'SAVED_LOCATIONS' | 'SELECTED_LOCATION';
        readonly kind: SavedLocationHydrationErrorKind | SelectedLocationInitializationErrorKind;
      };
      readonly writeStatus: 'IDLE';
    };
```

- `NOT_STARTED`/`LOADING`/`SELECTION_LOADING`/`ERROR`는 항상 `IDLE`입니다 — mutation은 saved
  hydration과 선택 preference 초기화가 모두 성공한 이후에만 가능하므로, 이 네 상태에서는 write가
  진행 중일 수 없습니다.
- **`SELECTION_LOADING`**(PR #52)은 saved-location hydration은 끝났지만
  ([mobile-selected-location.md](./mobile-selected-location.md)의) 선택 preference 초기화가 아직
  끝나지 않은 상태입니다. `READY`가 항상 검증된 `selectedLocationId`를 동반하도록, 이 상태를
  거치지 않고는 `EMPTY`/`READY`가 공개되지 않습니다.
- `EMPTY`/`READY`는 hydration snapshot이 아니라 **committed collection**에서 파생됩니다. 따라서
  마지막 지역을 삭제하면 `EMPTY`가, 빈 collection에 추가하면 `READY`가 공개됩니다. `EMPTY`의
  `selectedLocationId`는 항상 `null`이고, `READY`의 `selectedLocationId`는 항상 `locations` 안에
  동일 id의 record가 정확히 1개 존재하는 non-empty string입니다.
- `ERROR.error.scope`(PR #52)는 실패한 경계를 구분합니다 — `SAVED_LOCATIONS`는 hydration
  manager의, `SELECTED_LOCATION`은 선택 preference 초기화의 고정 discriminator를 **그대로
  통과**시키며 재해석하지 않습니다. raw storage error, native message, stack, Zod issue, 저장
  문자열, 위치 ID, 표시명, 좌표, grid는 어디에도 담기지 않습니다.

### snapshot 참조와 immutability

- `getSnapshot()`은 실제 semantic transition 전까지 항상 **동일 object reference**를 반환합니다.
  비교는 참조가 아니라 `status`·`writeStatus`·`error.kind`·`locations`의 field-by-field 값으로
  판정하는 내부 semantic equality helper로 이뤄집니다(`JSON.stringify`나 새 dependency 없음).
- 반환되는 snapshot은 최상위 객체, `ERROR.error`, `READY.locations` 배열, 각 record, 각 non-null
  `kmaGrid`까지 **deep-frozen**입니다.
- `READY.locations`는 committed collection **그 자체**입니다. 이를 freeze하면 store의 committed
  값도 immutable해지는데, 이는 의도된 것입니다 — 순수 collection operation과 persistence codec은
  모두 입력을 mutate하지 않고 deep-frozen 입력을 명시적으로 허용하며, 새 collection은 이 배열을
  수정하는 것이 아니라 항상 fresh array로 만들어집니다.
- hydration store가 이미 deep-frozen 배열을 공개하므로, hydration에서 넘겨받은 collection은 clone
  없이 그대로 재사용합니다.

## Hydration 연결, 선택 지역 초기화, explicit retry

- 생성 시 hydration store의 현재 snapshot을 **동기적으로 한 번** 읽고 subscribe합니다. 선택 지역
  persistence는 생성 시 전혀 읽지 않습니다.
- hydration transition은 그대로 application snapshot에 반영됩니다.
- `retryHydration()`은 hydration store의 `hydrate()`에 위임하고 그 **exact Promise reference**를
  그대로 반환합니다(그래서 `async` 메서드가 아닙니다). timer·backoff·자동 retry가 없고, 동시 retry는
  기존 single-flight 계약을 그대로 사용하며, 오류 kind를 재해석하지 않습니다.
- hydration transition마다 committed collection을 다시 채택하는 것이 저장된 mutation을 지울 수는
  없습니다 — hydration store는 `NOT_STARTED`/`ERROR`(committed가 없고 mutation도 허용되지 않는
  상태)에서만 전이하고, `EMPTY`/`READY`는 terminal이므로 collection이 commit된 뒤에는 다시 알리지
  않습니다.

### 선택 지역 초기화 state machine

- `initializeSelectedLocation()`은 생성자나 import가 아니라 **명시적 호출로만** 시작되는 내부
  `NOT_STARTED`/`LOADING`/`READY`/`ERROR` state machine을 소유합니다. saved hydration이 성공하기
  전(committed collection이 없는 동안)에는 storage를 건드리지 않는 안전한 no-op입니다.
- 내부 `LOADING`은 이미 hydration이 끝났다면 항상 공개 `SELECTION_LOADING`으로 노출됩니다 — 내부
  `NOT_STARTED`도 마찬가지로 `SELECTION_LOADING`으로 노출되므로, 최초 호출이 만드는 `NOT_STARTED`
  → `LOADING` 전이 자체는 공개 snapshot을 바꾸지 않습니다.
- 선택 지역 read는 cycle당 **정확히 한 번** single-flight입니다. 진행 중인 cycle의 tracked
  Promise는 그 cycle이 시작한 `republish()` 알림보다 **먼저** 기록되므로, 그 알림을 받은 listener가
  같은 stack에서 `initializeSelectedLocation()`을 재진입 호출해도(예: retry를 관찰하는 listener가
  `SELECTION_LOADING`을 보고 즉시 다시 호출하는 경우) 새 read를 시작하지 않고 **동일한 Promise
  reference**를 반환합니다.
- terminal 상태(`READY` 또는 `ERROR`)는 identity guard로 보호됩니다 — cycle의 tracked Promise가
  여전히 현재 tracker와 같을 때만 그 cycle이 상태를 확정하고 tracker를 지웁니다. tracker는 terminal
  `republish()` **이전에** 비워지므로, 그 알림 안에서 즉시 재시도하는 listener가 시작한 새 cycle의
  tracker를 이전 cycle의 뒷정리가 덮어쓰지 않습니다.
- `selectedLocationPersistence.load()`의 synchronous throw와 반환된 Promise의 rejection은 모두
  동일하게 고정 `STORAGE_READ_FAILED` 실패로 처리됩니다. public Promise 자체는 어느 경우에도
  reject하지 않습니다.
- 성공 시 기존 resolution 알고리즘(빈 collection → `null`, 유효한 persisted id는 그대로, `null`/
  누락/stale id는 `sortOrder === 0` fallback, fallback을 절대 자동으로 다시 쓰지 않음)은 바뀌지
  않았습니다 — 자세한 내용은 [mobile-selected-location.md](./mobile-selected-location.md) 참고.

### 앱 시작 순서

- app-root one-shot startup은 `apps/mobile/src/locations/mobile-location-application-startup.ts`의
  `startMobileLocationApplicationOnce()`가 소유합니다 — 이 module은 saved-location hydration
  startup(`mobile-saved-location-hydration-startup.ts`의 `startMobileSavedLocationHydrationOnce()`)을
  먼저 호출해 그 **exact Promise 계약**(module lifetime당 정확히 한 번, 동시/반복 호출은 같은
  Promise)을 그대로 사용하고, 그 Promise가 성공으로 settle된 뒤에만 이 application store의
  `initializeSelectedLocation()`을 호출합니다. saved hydration이 `ERROR`로 settle되면 선택 지역
  초기화는 시작되지 않고, 이후 명시적 `retryInitialization()`/UI retry가 담당합니다.
- `startMobileLocationApplicationOnce()` 자체도 동일한 one-shot 계약을 가집니다 — module
  lifetime당 정확히 한 번만 시퀀스를 실행하고, 동시·반복·settle 이후 호출은 모두 같은 Promise
  reference를 반환합니다.
- `retryInitialization()`은 현재 `ERROR` 상태의 scope로 라우팅되는 단일 UI 진입점입니다 —
  `SAVED_LOCATIONS` 오류는 hydration을 재시도하고 그 성공 시에만 선택 지역 초기화를 시작하며,
  `SELECTED_LOCATION` 오류는 선택 지역 read만 재시도합니다. `ERROR` 밖에서는 no-op이고, 절대
  reject하지 않으며, timer·backoff·자동 retry를 추가하지 않습니다.

## Mutation 계약

### 허용 상태

| operation | 허용 상태 |
| --- | --- |
| `add` | `EMPTY`, `READY` |
| `remove` | `READY` |
| `select`(PR #52) | `READY` |

그 외 상태에서는 persistence를 전혀 호출하지 않고 고정 오류를 반환합니다. 세 operation은 하나의
`writeStatus` write lock을 공유합니다 — 자세한 내용은
[mobile-selected-location.md](./mobile-selected-location.md) 참고.

### 고정 오류 kind

```ts
type SavedLocationApplicationErrorKind =
  | 'NOT_READY'
  | 'WRITE_IN_PROGRESS'
  | 'INVALID_COLLECTION'
  | 'INVALID_LOCATION'
  | 'DUPLICATE_LOCATION_ID'
  | 'CURRENT_LOCATION_CONFLICT'
  | 'INVALID_LOCATION_ID'
  | 'LOCATION_NOT_FOUND'
  | 'STORAGE_WRITE_FAILED';
```

`INVALID_LOCATION`~`LOCATION_NOT_FOUND`는 순수 collection operation이 돌려준 kind를 그대로
사용합니다. 이 store가 `reorderSavedLocations`를 호출하지 않으므로 `INVALID_REORDER`는 도달할 수
없으며, 방어적으로 `INVALID_COLLECTION`으로 collapse합니다. 결과는 항상 `{ kind }`만 담는 fresh
객체이고 raw 오류·입력 데이터를 노출하지 않습니다.

### mutation 순서와 cross-key write 계약

각 mutation은 다음 순서를 지키며, 첫 `await` 이전 단계는 호출 안에서 **동기적으로** 실행됩니다.

1. 이미 `SAVING`이면 `WRITE_IN_PROGRESS`, 허용되지 않는 상태면 `NOT_READY` — 둘 다 어느 persistence도
   호출하지 않습니다.
2. `add`/`remove`는 committed collection에 대해 해당 순수 collection operation을 호출하고, 실패는
   고정 오류를 그대로 반환합니다(여전히 persistence 미호출). `select`는 대신 자신의 id 인자를
   검증합니다 — 이미 선택된 id를 다시 선택하는 호출은 write·notification 없이 곧바로 성공을
   반환합니다.
3. `writeStatus`를 `SAVING`으로 전환하고 알립니다.
4. **정확히 다음 key만** 문서화된 순서로 씁니다. 하나의 mutation이 두 key를 모두 쓸 때는 항상
   **선택 지역 key를 먼저, collection key를 나중에** 씁니다 — 실제 계약은 mutation마다 다르며,
   "모든 mutation이 collection key를 정확히 한 번 쓴다"는 식으로 일반화되지 않습니다:

   | mutation | 쓰는 key |
   | --- | --- |
   | `select` | 선택 지역 key만 |
   | `add`(빈 collection에 첫 지역) | 선택 지역 key **먼저**, 그다음 collection key |
   | `add`(그 외) | collection key만 |
   | `remove`(선택되지 않은 지역) | collection key만 |
   | `remove`(선택된 지역) | 선택 지역 key(index 기반 fallback) **먼저**, 그다음 collection key |

5. write 성공 후에**만** 새 collection/선택을 committed로 채택합니다.
6. 순서상 앞선 write가 실패하면 이후 write는 시도하지 않고 이전 committed 값을 그대로 둡니다 —
   optimistic 값을 공개한 적이 없으므로 rollback할 대상이 없습니다. 같은 mutation의 두 write 사이에
   실패가 나면 선택 지역 key가 아직 반영되지 않은 collection과 다른 fallback을 가리킬 수 있지만,
   다음 `initializeSelectedLocation()`이 항상 (쓰이지 않은, 이전 그대로인) collection에 대해
   persisted id를 다시 검증하므로 안전합니다.
7. `writeStatus`를 `IDLE`로 되돌리고 알린 뒤 고정 결과를 반환합니다.

`add`/`remove`/`select`는 하나의 `writeStatus` write lock을 공유합니다 — 세 operation 중 어느
것이든 write가 진행 중이면 나머지 호출은 persistence를 건드리지 않고 즉시 `WRITE_IN_PROGRESS`를
반환합니다.

### 빈 collection 저장

마지막 지역 삭제도 `persistence.save([])`를 사용하며 **`clear()`를 호출하지 않습니다.** 모든
mutation이 동일한 versioned envelope write 경로를 사용하므로, 저장소에는 `{ version: 1,
locations: [] }`가 기록됩니다.

### 동시성과 재진입

- write가 `SAVING`인 동안의 다른 `add`/`remove`/`select`는 — 알림 도중 listener가 재진입적으로
  호출한 경우를 포함해 — 두 번째 write를 시작하지 않고 `WRITE_IN_PROGRESS`를 반환하며, 첫
  mutation의 collection/선택이나 Promise를 건드리지 않습니다.
- write queue, debounce, batching, compare-and-swap은 만들지 않습니다.
- 모든 store 상태는 terminal 알림 **이전에** 확정되므로, 그 알림 안에서 새 mutation을 시작하는
  listener는 항상 일관된 store를 관찰합니다.

## Notification과 exception safety

- `subscribe(listener)`는 등록 즉시 호출되지 않고 실제 semantic transition에만 호출합니다.
- 반환된 unsubscribe는 여러 번 호출해도 안전합니다.
- notification은 listener Set의 **snapshot 복사본**을 순회하므로 알림 도중의 unsubscribe나
  재진입 mutation이 iteration을 깨지 않습니다.
- listener는 각자 `try/catch`로 격리되어 한 listener의 throw가 나머지 listener나 mutation
  lifecycle을 손상시키지 않습니다. listener 오류는 저장·노출·logging되지 않습니다.
- module-level global listener registry가 없고 logging/telemetry가 없습니다.

## production composition

- **module 경로**: `apps/mobile/src/locations/mobile-saved-location-application-production.ts`.
- **export 이름**: `mobileSavedLocationApplicationStore`(module scope singleton).
- 기존 세 production singleton을 각각 **정확히 한 번** 주입합니다 — hydration production
  composition의 `mobileSavedLocationHydrationStore`, saved-location AsyncStorage binding의
  `mobileSavedLocationPersistence`, 선택 지역 AsyncStorage binding의
  `mobileSelectedLocationPersistence`.
- 기존 hydration production composition은 **바뀌지 않았습니다** — 두 번째 manager나 두 번째
  hydration store를 만들지 않고 그 store를 재사용하므로, app-root one-shot startup·hydration
  hook·이 application store가 모두 같은 hydration instance를 관찰합니다.
- storage key, envelope version, 오류 kind, collection 정책, hydration 상태 기계, snapshot·
  notification·mutation 계약을 재정의하지 않습니다.
- import나 singleton 참조만으로는 storage I/O도 `hydrate()` 호출도 없습니다.
- AsyncStorage binding과 같은 이유로 **pure barrel `apps/mobile/src/locations/index.ts`에서
  export하지 않습니다.** runtime consumer가 이 module을 직접 import합니다(pure factory와 그 타입은
  provider-neutral하므로 barrel에서 export됩니다).

## React hook

- **module 경로**: `apps/mobile/src/locations/use-mobile-saved-locations.ts`.
- **export 이름**: `useMobileSavedLocations()`.
- production application store를 `useSyncExternalStore`로 구독합니다 — subscribe·client
  `getSnapshot`·server `getSnapshot` provider function은 module scope에 정확히 한 번 정의되고,
  client와 server getter는 **동일한 함수 reference**입니다.
- 반환값은 store의 **exact cached snapshot reference**입니다(복사·spread·매핑·재검증 없음).
- hook의 import나 호출만으로는 hydration·mutation·storage I/O가 발생하지 않습니다.
- production composition을 직접 import하므로 pure barrel에서 **export되지 않습니다.**
- mutation/retry action은 hook이 반환하지 않습니다 — 화면이 production store singleton의
  `retryInitialization()`/`select()`/`add()`/`remove()`를 직접 호출합니다. `retryHydration()`은
  여전히 존재하지만 화면이 직접 부르는 API가 아니라, `SAVED_LOCATIONS` 오류 재시도에 그대로
  위임하는 `retryInitialization()`이 내부에서 사용하는 기존 low-level exact-Promise-delegation
  API로 유지됩니다. 그래서 React Context/Provider나 generic action framework, 테스트 편의를 위한
  production export가 필요하지 않습니다.

## 홈 화면 consumer

`apps/mobile/src/app/index.tsx`는 이 hook을 직접 소비하며, 이전 상태별 문구를 유지하면서 다음을
추가합니다.

- **ERROR** — `다시 시도` 버튼이 `retryInitialization()`을 호출합니다.
  `SAVED_LOCATIONS` 오류를 재시도하면 saved-location hydration이 다시 시작되며 공개 상태는
  `LOADING`이 됩니다. `SELECTED_LOCATION` 오류를 재시도하면 선택 preference read만 다시
  시작되며 공개 상태는 `SELECTION_LOADING`이 됩니다. 두 상태 모두 버튼이 사라지고,
  각 경계의 single-flight 계약 때문에 반복 입력이 두 번째 read를 시작하지 못합니다.
  raw error kind/message는 표시하지 않습니다.
- **READY** — 저장 지역 `displayName` 목록과 각 지역의 `삭제` 버튼, 그리고(PR #52) 선택 표시/
  선택 버튼을 표시합니다 — 선택된 지역은 비활성 `선택됨` 버튼, 나머지는 `선택` 버튼입니다. 목록
  위에는 `지역 추가` 버튼도 표시되며, 누르면 `/locations` 지역 검색 화면으로 이동합니다. `SAVING`
  중에는 모든 컨트롤(`지역 추가`, 선택, 삭제 포함)이 비활성화되고, optimistic 변경이 없으므로
  목록/선택은 저장이 성공한 뒤에만 갱신됩니다. 마지막 지역을 삭제하면 `EMPTY` 문구로 전환됩니다.
  선택 컨트롤의 정확한 계약은 [mobile-selected-location.md](./mobile-selected-location.md) 참고.
- **SELECTION_LOADING**(PR #52) — `선택 지역을 준비하는 중입니다.`만 표시합니다.
- **저장 실패** — `저장 지역 변경을 저장하지 못했습니다.`라는 generic 문구만 표시합니다. 오류
  kind, storage key, 위치 ID, 좌표, native error message, stack은 표시하지 않습니다. 이 문구는
  이 화면에서 다음 삭제를 시작할 때 사라지고, 그 삭제가 실패하면 다시 표시됩니다. 다른
  consumer의 mutation 결과와 자동으로 동기화하는 presentation 정책은 후속 다중-consumer UI
  범위입니다.
- **EMPTY** — `저장된 지역이 없습니다.` 문구와 `지역 추가` 버튼을 표시합니다.
  버튼을 누르면 `/locations` 지역 검색 화면으로 이동하며, 검색 결과의 `추가` control을 통해
  첫 저장 지역을 추가할 수 있습니다.
- **접근성** — React Native `Pressable`과 의미 있는 `accessibilityRole`/`accessibilityLabel`을
  사용하고 최소 터치 영역(48×48)을 확보합니다. 외부 UI dependency, animation, icon, image는
  없습니다.

## 이 경계에서 하지 않는 것(후속 범위)

- 위치 권한·GPS·current-location 조회.
- reorder UI, 좌우 스와이프.
- weather API 호출, KMA/AirKorea 변경, AdMob, Android widget.
- migration, write queue, cache/background refresh.
- native build, development client 재빌드, 실제 기기 QA.
