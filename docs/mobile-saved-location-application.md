# 모바일 저장 지역 application store

이 문서는 `apps/mobile/src/locations`의 **저장 지역 application store**를 설명합니다. 이 경계는
[hydration 경계](./mobile-saved-location-hydration.md)가 제공하는 observable hydration store와
[persistence 경계](./mobile-saved-location-persistence.md)가 제공하는 `SavedLocationPersistence`를
주입받아, **write 측 책임**을 소유합니다 — hydration된 collection 위에서 mutation을 계산하고,
저장에 성공한 뒤에야 새 collection을 React consumer에 공개합니다.

기존 hydration manager·hydration store·startup boundary·hydration hook의 공개 계약은 이 PR에서
바뀌지 않았습니다.

## 목적

- hydration 상태를 관찰해 하나의 application snapshot으로 노출합니다.
- 명시적 사용자 retry를 hydration store의 `hydrate()`로 위임합니다.
- persistence를 사용하는 `add`/`remove` mutation을 제공합니다.
- **저장 성공 후에만** 새 collection을 공개합니다(optimistic update 없음).
- 저장 실패 시 이전 committed collection을 그대로 유지합니다.
- 동시/재진입 mutation이 두 번째 write를 시작하지 않게 합니다.

## 공개 계약

- **module 경로**: `apps/mobile/src/locations/mobile-saved-location-application-store.ts`.
- **export 이름**: `createSavedLocationApplicationStore({ hydrationStore, persistence })`.

```ts
interface SavedLocationApplicationStore {
  getSnapshot(): SavedLocationApplicationSnapshot;
  subscribe(listener: SavedLocationApplicationStoreListener): () => void;
  retryHydration(): Promise<void>;
  add(candidate: unknown): Promise<SavedLocationApplicationMutationResult>;
  remove(locationId: unknown): Promise<SavedLocationApplicationMutationResult>;
}
```

이 경계는 provider-neutral합니다 — 주입 타입은 기존 `SavedLocationHydrationStore`와
`SavedLocationPersistence`뿐이고, React·Expo·AsyncStorage concrete module·production
singleton·logging/telemetry를 import하지 않습니다. module import와 factory 호출만으로는
`hydrate()`도 storage I/O도 발생하지 않습니다(hydration store의 부작용 없는 `getSnapshot()`을
생성 시 한 번 읽고 subscribe할 뿐입니다).

`reorder`, `setCurrent`, 선택 지역 상태, clear-all, migration, refresh/background hydration,
weather request는 이 경계에 포함되지 않습니다.

## Application snapshot

```ts
type SavedLocationApplicationWriteStatus = 'IDLE' | 'SAVING';

type SavedLocationApplicationSnapshot =
  | { readonly status: 'NOT_STARTED'; readonly writeStatus: 'IDLE' }
  | { readonly status: 'LOADING'; readonly writeStatus: 'IDLE' }
  | { readonly status: 'EMPTY'; readonly writeStatus: SavedLocationApplicationWriteStatus }
  | {
      readonly status: 'READY';
      readonly locations: readonly MobileSavedLocation[];
      readonly writeStatus: SavedLocationApplicationWriteStatus;
    }
  | {
      readonly status: 'ERROR';
      readonly error: { readonly kind: SavedLocationHydrationErrorKind };
      readonly writeStatus: 'IDLE';
    };
```

- `NOT_STARTED`/`LOADING`/`ERROR`는 항상 `IDLE`입니다 — mutation은 hydration 성공 이후에만
  가능하므로 이 세 상태에서는 write가 진행 중일 수 없습니다.
- `EMPTY`/`READY`는 hydration snapshot이 아니라 **committed collection**에서 파생됩니다. 따라서
  마지막 지역을 삭제하면 `EMPTY`가, 빈 collection에 추가하면 `READY`가 공개됩니다.
- `ERROR.error.kind`는 hydration manager의 고정 discriminator를 **그대로 통과**시키며 재해석하지
  않습니다. raw storage error, native message, stack, Zod issue, 저장 문자열, 위치 ID, 표시명,
  좌표, grid는 어디에도 담기지 않습니다.

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

## Hydration 연결과 explicit retry

- 생성 시 hydration store의 현재 snapshot을 **동기적으로 한 번** 읽고 subscribe합니다.
- hydration transition은 그대로 application snapshot에 반영됩니다.
- app-root one-shot startup은 기존 `mobile-saved-location-hydration-startup.ts`가 계속 **단독으로**
  소유합니다 — 이 store는 앱 시작 hydration을 시작하지 않습니다.
- `retryHydration()`은 hydration store의 `hydrate()`에 위임하고 그 **exact Promise reference**를
  그대로 반환합니다(그래서 `async` 메서드가 아닙니다). timer·backoff·자동 retry가 없고, 동시 retry는
  기존 single-flight 계약을 그대로 사용하며, 오류 kind를 재해석하지 않습니다.
- hydration transition마다 committed collection을 다시 채택하는 것이 저장된 mutation을 지울 수는
  없습니다 — hydration store는 `NOT_STARTED`/`ERROR`(committed가 없고 mutation도 허용되지 않는
  상태)에서만 전이하고, `EMPTY`/`READY`는 terminal이므로 collection이 commit된 뒤에는 다시 알리지
  않습니다.

## Mutation 계약

### 허용 상태

| operation | 허용 상태 |
| --- | --- |
| `add` | `EMPTY`, `READY` |
| `remove` | `READY` |

그 외 상태에서는 persistence를 전혀 호출하지 않고 고정 오류를 반환합니다.

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

### mutation 순서

각 mutation은 다음 순서를 지키며, 첫 `await` 이전 단계는 호출 안에서 **동기적으로** 실행됩니다.

1. 이미 `SAVING`이면 `WRITE_IN_PROGRESS`, 허용되지 않는 상태면 `NOT_READY` — 둘 다 persistence를
   호출하지 않습니다.
2. committed collection에 대해 해당 순수 collection operation을 호출합니다.
3. operation 실패는 고정 오류를 그대로 반환합니다(여전히 persistence 미호출).
4. snapshot을 `SAVING`으로 전환하고 알립니다.
5. 새 canonical collection으로 `persistence.save()`를 **정확히 한 번** 호출합니다.
6. save 성공 후에**만** 새 collection을 committed로 채택합니다.
7. save 실패 시 이전 committed collection을 그대로 둡니다 — optimistic 값을 공개한 적이 없으므로
   rollback할 대상이 없습니다.
8. `writeStatus`를 `IDLE`로 되돌리고 알린 뒤 고정 결과를 반환합니다.

### 빈 collection 저장

마지막 지역 삭제도 `persistence.save([])`를 사용하며 **`clear()`를 호출하지 않습니다.** 모든
mutation이 동일한 versioned envelope write 경로를 사용하므로, 저장소에는 `{ version: 1,
locations: [] }`가 기록됩니다.

### 동시성과 재진입

- write가 `SAVING`인 동안의 다른 `add`/`remove`는 — 알림 도중 listener가 재진입적으로 호출한
  경우를 포함해 — 두 번째 `persistence.save()`를 시작하지 않고 `WRITE_IN_PROGRESS`를 반환하며,
  첫 mutation의 collection이나 Promise를 건드리지 않습니다.
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
- 기존 두 production singleton을 각각 **정확히 한 번** 주입합니다 — hydration production
  composition의 `mobileSavedLocationHydrationStore`와 AsyncStorage binding의
  `mobileSavedLocationPersistence`.
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
- mutation action은 hook이 반환하지 않습니다 — 화면이 production store singleton의
  `retryHydration()`/`add()`/`remove()`를 직접 호출합니다. 그래서 React Context/Provider나 generic
  action framework, 테스트 편의를 위한 production export가 필요하지 않습니다.

## 홈 화면 consumer

`apps/mobile/src/app/index.tsx`는 이 hook을 직접 소비하며, 이전 상태별 문구를 유지하면서 다음을
추가합니다.

- **ERROR** — `다시 시도` 버튼이 explicit retry를 한 번 호출합니다. retry가 시작되면 상태가
  즉시 `LOADING`이 되어 버튼이 사라지고, store의 single-flight 계약 덕분에 반복 탭이 두 번째
  load를 시작하지 못합니다. raw error kind/message는 표시하지 않습니다.
- **READY** — 저장 지역 `displayName` 목록과 각 지역의 `삭제` 버튼을 표시합니다. `SAVING` 중에는
  모든 삭제 버튼이 비활성화되고, optimistic 변경이 없으므로 목록은 저장이 성공한 뒤에만 갱신됩니다.
  마지막 지역을 삭제하면 `EMPTY` 문구로 전환됩니다.
- **저장 실패** — `저장 지역 변경을 저장하지 못했습니다.`라는 generic 문구만 표시합니다. 오류
  kind, storage key, 위치 ID, 좌표, native error message, stack은 표시하지 않습니다. 이 문구는
  이후 mutation이 성공하면 사라집니다.
- **EMPTY** — `저장된 지역이 없습니다.`만 표시합니다. 지역 검색·추가 UI는 후속 범위이며, 이를
  개발용 문구로 사용자에게 노출하지 않습니다.
- **접근성** — React Native `Pressable`과 의미 있는 `accessibilityRole`/`accessibilityLabel`을
  사용하고 최소 터치 영역(48×48)을 확보합니다. 외부 UI dependency, animation, icon, image는
  없습니다.

## 이 경계에서 하지 않는 것(후속 범위)

- 대한민국 지역 검색 데이터와 검색 UI, 실제 add 버튼.
- 사용자 선택 지역/활성 지역 상태(`isCurrent`는 기기의 실제 현재 위치 record 여부로 유지되며 선택
  표시로 쓰이지 않습니다).
- 위치 권한·GPS·current-location 조회.
- reorder UI, 좌우 스와이프.
- weather API 호출, KMA/AirKorea 변경, AdMob, Android widget.
- migration, write queue, cache/background refresh.
- native build, development client 재빌드, 실제 기기 QA.
