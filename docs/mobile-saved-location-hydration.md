# 모바일 저장 지역 hydration manager

이 문서는 `apps/mobile/src/locations`의 **저장 지역 hydration manager**를 설명합니다. 이 경계는
[persistence 경계](./mobile-saved-location-persistence.md)(PR #41/#42)가 제공하는
`SavedLocationPersistence`를 주입받아, 저장 지역 collection을 앱 상태로 안전하게 hydrate하고 그
진행 상태를 하나의 discriminated union으로 노출하는 책임만 가집니다. React state, 화면, navigation
또는 AsyncStorage production composition은 이 경계에 포함되지 않습니다.

## 목적

- persistence 경계를 소비해 collection을 hydrate하는 **provider-neutral manager**를 제공합니다.
- hydration 진행 상태를 `NOT_STARTED`/`LOADING`/`EMPTY`/`READY`/`ERROR` 5개 상태로 노출합니다.
- 중복 `hydrate()` 호출이 동일한 in-flight 작업을 공유하도록 해 `persistence.load()`가 사이클당
  정확히 한 번만 호출되게 합니다.
- 성공 이후의 반복 호출은 idempotent no-op으로, 실패 이후의 반복 호출은 retry로 동작합니다.
- 주입된 `load()`의 동기 throw와 Promise rejection을 모두 고정된 비노출 오류로 변환합니다.

## 공개 상태 계약

```ts
type SavedLocationHydrationErrorKind =
  | 'STORAGE_READ_FAILED'
  | 'INVALID_STORED_LOCATIONS'
  | 'UNSUPPORTED_STORED_VERSION';

type SavedLocationHydrationState =
  | { readonly status: 'NOT_STARTED' }
  | { readonly status: 'LOADING' }
  | { readonly status: 'EMPTY' }
  | { readonly status: 'READY'; readonly locations: readonly MobileSavedLocation[] }
  | {
      readonly status: 'ERROR';
      readonly error: { readonly kind: SavedLocationHydrationErrorKind };
    };
```

- `NOT_STARTED` — manager가 생성됐지만 `hydrate()`가 아직 호출되지 않았습니다.
- `LOADING` — hydration이 진행 중입니다.
- `EMPTY` — hydration이 성공했고 저장된 collection에 지역이 없습니다.
- `READY` — hydration이 성공했고 `locations`에 저장된 지역이 있습니다(빈 배열이 아님).
- `ERROR` — hydration이 실패했습니다. `error.kind`는 persistence의 load 오류 kind 중 세 가지
  (`STORAGE_READ_FAILED`/`INVALID_STORED_LOCATIONS`/`UNSUPPORTED_STORED_VERSION`)만 노출하는 고정
  discriminator입니다. raw storage error, Zod issue, 저장 문자열, 위치 ID, 표시명, 좌표, grid는 어느
  것도 담지 않습니다.

## Manager 계약

```ts
interface SavedLocationHydrationManager {
  getState(): SavedLocationHydrationState;
  hydrate(): Promise<void>;
}

function createSavedLocationHydrationManager(
  persistence: SavedLocationPersistence,
): SavedLocationHydrationManager;
```

### 초기 상태와 side-effect 없음

- 생성 직후 `getState()`는 항상 `NOT_STARTED`입니다.
- module import와 `createSavedLocationHydrationManager()` 호출만으로는 `load`/`save`/`clear` 어느
  것도 호출되지 않습니다.
- environment, network, clock, random, native module에 접근하지 않습니다.

### hydrate()

첫 호출 시 다음 순서로 동작합니다.

1. 상태를 **동기적으로** `LOADING`으로 전환합니다(반환된 Promise가 아직 pending이어도 `getState()`는
   즉시 `LOADING`을 보고합니다).
2. `persistence.load()`를 **정확히 한 번** 호출합니다.
3. 빈 collection 성공 결과는 `EMPTY`.
4. 비어 있지 않은 collection 성공 결과는 `READY`(저장된 지역을 보존).
5. persistence 오류는 그 `kind`를 그대로 담은 `ERROR`.
6. `hydrate()`가 반환하는 Promise는 **reject하지 않고** 항상 완료됩니다 — 실패는 상태로만
   드러납니다.

### 동시 호출(single-flight)

- hydration이 진행 중일 때 추가 `hydrate()` 호출은 새 load를 시작하지 않고 **같은 in-flight
  Promise 참조**를 반환합니다.
- 따라서 몇 번을 동시에 호출하든 `persistence.load()`는 사이클당 정확히 한 번만 실행됩니다.
- `hydrate()`는 의도적으로 `async` 함수가 아닌 일반 함수로 작성되어 있습니다 — `async` wrapper로
  작성하면 in-flight Promise를 그대로 반환하는 분기에서도 매 호출마다 새 Promise가 감싸져 반환되므로
  "동일 in-flight 작업 공유" 계약이 참조 동일성 차원에서 우연히 깨질 수 있기 때문입니다.

### 반복 호출

- `READY` 또는 `EMPTY` 상태에 도달한 뒤의 `hydrate()`는 **idempotent no-op**입니다 — 성공 상태를
  유지한 채 새 `load()`를 실행하지 않고 즉시 resolve하는 Promise를 반환합니다.
- `ERROR` 상태에서의 `hydrate()`는 **retry**를 허용합니다 — 새 in-flight load를 시작합니다.
- retry가 성공하면 `EMPTY` 또는 `READY`로 전환되는 terminal success 상태에 도달합니다.

### 방어적 실패 처리

주입된 `persistence.load()`가 다음 중 무엇을 하더라도:

- 동기적으로 throw하거나,
- 반환한 Promise가 reject되면,

manager는 이를 `{ status: 'ERROR', error: { kind: 'STORAGE_READ_FAILED' } }`로 변환합니다. raw
오류 메시지, stack, cause는 노출되지도 logging되지도 않습니다.

## 상태와 참조 안전성

- manager의 내부 상태는 caller가 직접 mutate할 수 없습니다.
- `getState()`는 매 호출마다 **새로운 최상위 객체**를 반환합니다(내부 mutable 참조를 그대로
  노출하지 않음). `EMPTY`처럼 데이터가 없는 상태도, `ERROR`의 nested `error` 객체도 호출마다
  fresh입니다.
- `READY.locations`는 매 `getState()` 호출마다 새 배열이며, 각 record와 null이 아닌 `kmaGrid`도
  새 객체입니다 — caller가 이전에 받은 snapshot이나 `persistence.load()`가 반환한 원본 배열/객체와
  참조를 공유하지 않습니다.
- persistence가 반환한 collection은 절대 mutate하지 않으며, **deep-frozen 상태로 반환돼도** 정상
  처리합니다(clone은 항상 spread로 새 객체를 만들 뿐, 원본을 변경하지 않습니다).
- module-level mutable cache, singleton result, 공유 empty array/error object는 없습니다.

## Pure boundary

manager는 다음만 import합니다.

- 저장 지역 record 타입과 clone에 필요한 pure `mobile-saved-location` 모듈.
- `SavedLocationPersistence` 타입(`mobile-saved-location-persistence`).

다음은 import하지 않습니다.

- `@react-native-async-storage/async-storage`, `mobile-saved-location-async-storage.ts`.
- React, Expo, navigation.
- Zustand/Redux 등 상태 라이브러리.
- API client, environment, logging/telemetry.

manager는 provider-neutral한 pure barrel `apps/mobile/src/locations/index.ts`에서 export됩니다.
AsyncStorage production binding(`mobileSavedLocationPersistence`)은 계속 이 barrel에서 export되지
않으므로, 이 pure barrel을 import해도 native AsyncStorage 모듈은 전이적으로 로드되지 않습니다.

## 이 경계에서 하지 않는 것(후속 범위)

- React context/provider(아래 observable store와 [hook](#react-usesyncexternalstore-hook)은
  provider-neutral 기반과 얇은 subscription 경계이지 context/provider 구현은 아닙니다).
- 지역 추가·삭제 mutation과 그 저장 — 이는 이 경계 위의 **application store**가 소유합니다
  ([mobile-saved-location-application.md](./mobile-saved-location-application.md)). 재정렬 UI는
  여전히 후속 범위입니다.
- write queue, debounce, retry backoff.
- refresh, background rehydration, stale data 유지 정책.
- migration 실행, corrupt data repair/delete.
- 위치 권한, GPS, weather API 호출.
- native build, 실제 기기 QA.

## 관찰 가능한 hydration store

manager 위에 provider-neutral **observable store**가 추가됐습니다 — manager가 노출하는 discriminated
union 상태를 React `useSyncExternalStore`가 안전하게 소비할 수 있는 작은 계약으로 감쌉니다. 이 store를
구독하는 hook은 [아래](#react-usesyncexternalstore-hook)에서 설명하며, 화면은 여전히 구현하지
않습니다.

- **module 경로**: `apps/mobile/src/locations/mobile-saved-location-hydration-store.ts`.
- **export 이름**: `createSavedLocationHydrationStore(manager)`.
- **public 계약**:

  ```ts
  type SavedLocationHydrationStoreListener = () => void;

  interface SavedLocationHydrationStore {
    getSnapshot(): SavedLocationHydrationState;
    subscribe(listener: SavedLocationHydrationStoreListener): () => void;
    hydrate(): Promise<void>;
  }
  ```

### 캐시된 snapshot과 deep-freeze

- store 생성 시 manager의 현재 상태를 **한 번** 읽어 초기 snapshot으로 캐싱합니다. module import나
  이 factory 호출만으로는 `hydrate()`도 storage I/O도 발생하지 않습니다.
- `getSnapshot()`은 실제 semantic state transition이 일어나기 전까지 항상 **동일 object reference**를
  반환합니다 — manager의 `getState()`는 매 호출마다 새 객체를 반환하지만, store는 그 값을 semantic하게
  비교해 실제로 달라졌을 때만 캐시를 교체합니다.
- 반환되는 snapshot은 최상위 state 객체, `ERROR.error`, `READY.locations` 배열, 각 saved-location
  record, null이 아닌 각 `kmaGrid`까지 **deep-frozen**되어 있어 caller가 mutate할 수 없습니다.
  `getSnapshot()`은 이 캐시된 객체를 그대로 반환하므로(매 호출마다 새로 복사하지 않음), 참조 안정성과
  runtime immutability를 동시에 만족합니다.
- 상태 비교는 참조가 아니라 내부 **semantic equality helper**로 이뤄집니다 — `status`가 다르면
  unequal, `ERROR`는 `error.kind`만, `READY`는 `locations`의 길이·순서와 모든 field 값을 비교합니다
  (`JSON.stringify`나 hashing, 새 dependency는 쓰지 않습니다).

### subscribe / unsubscribe

- `subscribe(listener)`는 등록 즉시 listener를 호출하지 않고, 실제 semantic transition에만 호출합니다.
- 반환된 unsubscribe 함수는 여러 번 호출해도 안전(idempotent)하며, 호출 이후에는 더 이상 알림을
  받지 않습니다.
- notification은 listener Set의 **snapshot 복사본**을 순회하므로, 알림 도중 어떤 listener가
  unsubscribe하거나 reentrant하게 `hydrate()`를 호출해도 iteration이 깨지지 않습니다.
- module-level global registry는 없고, listener 오류를 logging하거나 raw data와 함께 변환하지
  않습니다.

### hydrate() 위임과 동시성

- `store.hydrate()`는 manager의 `hydrate()`를 호출하고 그 **exact Promise reference**를 그대로
  반환합니다. Manager가 동기적으로 전환한 상태는 이 호출 안에서 즉시 읽어 필요하면 캐시를 갱신하고
  알리며, Promise가 settle된 뒤에도 manager의 terminal 상태를 다시 읽어 같은 방식으로 처리합니다.
- store는 내부적으로 in-flight promise 하나만 추적합니다 — 이미 추적 중인 promise가 있으면 concurrent
  호출이든, LOADING notification 도중의 reentrant 호출이든 manager를 다시 호출하지 않고 그 추적된
  promise를 그대로 반환하므로, 실제 hydration cycle당 manager 호출과 settlement observer가 정확히
  하나만 존재합니다.
- 이 추적된 promise 참조는 terminal 처리(알림) **직전**에 비웁니다 — terminal listener가 그 알림
  안에서 즉시 새 retry를 시작해 새 promise를 등록하더라도, 뒤이어 계속되는 이전 settlement 처리가
  그 새 참조를 지우지 않습니다.
- `READY`/`EMPTY`에서의 `hydrate()`는 manager의 기존 no-op 계약을 그대로 통과시켜 snapshot
  reference와 listener 호출 수를 바꾸지 않고, `ERROR`에서의 explicit `hydrate()`는 manager의 기존
  retry 계약(`ERROR → LOADING → EMPTY/READY/ERROR`)을 그대로 통과시킵니다. store 자신은 timer,
  debounce, backoff, 자동 retry, `catch`, logging, telemetry를 갖지 않고 manager의 고정 오류 계약을
  재해석하지 않습니다.

### Pure boundary

store는 다음만 import합니다.

- saved-location record 타입(`mobile-saved-location`).
- `SavedLocationHydrationManager`/`SavedLocationHydrationState` 타입(`mobile-saved-location-hydration-manager`).

다음은 import하지 않습니다.

- React, Expo, AsyncStorage.
- production composition, API client, environment, logging/telemetry.

store는 provider-neutral하므로 manager와 같은 pure barrel(`apps/mobile/src/locations/index.ts`)에서
export됩니다.

## production composition

`mobile-saved-location-async-storage.ts`(concrete AsyncStorage binding)와 이 manager, 그리고 위
observable store를 실제로 조립하는 module이 추가됐습니다.

- **module 경로**: `apps/mobile/src/locations/mobile-saved-location-hydration-production.ts`.
- 이 module은 위 세 기존 경계만 import합니다 — `mobileSavedLocationPersistence`
  (`./mobile-saved-location-async-storage`), `createSavedLocationHydrationManager`
  (`./mobile-saved-location-hydration-manager`), `createSavedLocationHydrationStore`
  (`./mobile-saved-location-hydration-store`).
- production persistence instance를 manager factory에, 그 manager를 store factory에 각각
  **정확히 한 번** 주입합니다.

  ```ts
  export const mobileSavedLocationHydrationManager: SavedLocationHydrationManager =
    createSavedLocationHydrationManager(mobileSavedLocationPersistence);

  export const mobileSavedLocationHydrationStore: SavedLocationHydrationStore =
    createSavedLocationHydrationStore(mobileSavedLocationHydrationManager);
  ```

- **export 이름**: `mobileSavedLocationHydrationManager`와 `mobileSavedLocationHydrationStore` —
  둘 다 module scope singleton이며, manager가 먼저, 그 위에 store가 조립되는 단일 방향입니다.
- module import나 두 singleton을 참조하는 것만으로는 `hydrate()`를 호출하지 않고 어떤 storage
  I/O(`getItem`/`setItem`/`removeItem`)도 발생하지 않습니다 — 세 collaborator 생성 자체가
  side-effect-free이므로, export된 manager의 `getState()`와 store의 `getSnapshot()` 모두
  `hydrate()`를 호출하기 전까지 항상 `NOT_STARTED`입니다.
- storage key, envelope version, 오류 kind, collection 정책, snapshot/notification 계약은 이
  module에서 **재정의하지 않고** 기존 세 경계가 그대로 소유합니다. `try/catch`, retry, logging,
  telemetry, environment/clock/random/network 접근이 없습니다.
- 이 production composition module은 **pure barrel `apps/mobile/src/locations/index.ts`에서
  export하지 않습니다** — AsyncStorage binding과 같은 이유로, native module을 transitively 끌어오기
  때문입니다. Node 기반 unit test와 pure domain consumer는 이 barrel을 통해 native module을 절대
  load하지 않으며, runtime consumer는 이 production module을 **직접** import합니다.
- app-start에서 `hydrate()`를 호출하는 wiring은 아래 [app-start hydration](#app-start-hydration)
  절에서 설명하는 one-shot startup boundary로 **구현됐습니다** — 이제 이 export된 **store**를
  경유합니다. React `useSyncExternalStore` hook은
  [아래](#react-usesyncexternalstore-hook) 절에서 구현됐으며, 화면 consumer·React
  Context/Provider·상태별 UI 연결은 여전히 **미구현**입니다.
- 이 변경은 native dependency나 native config를 추가하지 않았으므로, development client 재빌드나
  실제 기기 QA는 이번 PR에서도 수행하지 않았습니다.

## app-start hydration

production composition의 **store**를 실제 앱 시작 시 호출하는 **one-shot startup boundary**가
추가됐습니다.

- **module 경로**: `apps/mobile/src/locations/mobile-saved-location-hydration-startup.ts`.
- **export 이름**: `startMobileSavedLocationHydrationOnce`.
- 이 module은 production composition(`mobileSavedLocationHydrationStore`,
  `./mobile-saved-location-hydration-production`)만 import합니다 — manager를 직접 import하지
  않습니다.
- root layout(`apps/mobile/src/app/_layout.tsx`)이 mount effect(`useEffect(() => { void
  startMobileSavedLocationHydrationOnce(); }, [])`)에서 이 함수를 호출합니다.
- `startMobileSavedLocationHydrationOnce()`는 module scope에 첫 호출의 store Promise를 저장하는
  one-shot guard입니다 — 첫 호출에서만 실제 `mobileSavedLocationHydrationStore.hydrate()`를
  호출하고, 이후의 모든 호출(동시 호출, pending 중 반복 호출, 완료 이후 반복 호출)은 항상 그
  **동일한 첫 Promise reference**를 반환합니다.
- React Strict Mode, remount 또는 root effect의 반복 실행으로 이 함수가 여러 번 호출되더라도, 실제
  store `hydrate()`(→ manager `hydrate()`) 호출과 그에 따른 storage read는 앱 runtime당(module
  lifetime당) **정확히 한 번**만 일어납니다.
- store를 경유하므로, store를 구독하는 subscriber는 이 startup 호출이 만드는 `LOADING`과 terminal
  상태 전환을 모두 관찰할 수 있습니다.
- 첫 hydration 결과가 `EMPTY`/`READY`/`ERROR` 무엇이든, 이 startup boundary는 **자동 재시도를 하지
  않습니다** — store(그 아래 manager)의 기존 `hydrate()` 계약(`ERROR` 이후 retry 허용)은 그대로
  유지되지만, 그 retry를 시작하는 것은 이 startup module의 책임이 아닙니다. **향후 명시적 사용자
  retry는 manager가 아니라 이 store의 `hydrate()`를 직접 호출해야** subscription 일관성이
  유지됩니다 — 이전에 이 문서가 설명했던 "manager를 직접 호출" 방식은 더 이상 유효하지 않습니다.
- module import만으로는 `hydrate()`를 호출하지 않고, storage I/O도 발생하지 않습니다.
- storage key, envelope version, 오류 kind, collection·retry 정책을 재정의하지 않고, `catch`,
  logging, telemetry, timer, backoff가 없으며 environment/clock/random/network에 접근하지 않고
  React를 import하지 않습니다.
- root layout의 mount effect는 hydration 완료를 기다리지 않고 navigation을 차단하지 않습니다 —
  `<Stack />` 렌더링은 그대로 유지되고, `EMPTY`/`READY`/`ERROR`에 따른 화면 분기·loading/error UI·
  splash screen 제어·effect cleanup은 없습니다.
- React state/context, 화면 consumer, 저장 지역 표시와 사용자 retry UI는 여전히 **미구현**이며,
  `useSyncExternalStore` hook은 [아래](#react-usesyncexternalstore-hook) 절에서 구현됐습니다.
- 이 startup module과 root layout wiring 모두 pure barrel
  (`apps/mobile/src/locations/index.ts`)에서 export되지 않습니다 — root layout은 startup module을
  직접 import하고, startup module은 production composition을 직접 import합니다.
- 이 변경은 native dependency나 native config를 추가하지 않았으므로, development client 재빌드나
  실제 기기 QA는 이번 PR에서도 수행하지 않았습니다.

## React `useSyncExternalStore` hook

production observable hydration store([위](#관찰-가능한-hydration-store))를 React가 구독할 수 있는
얇은 runtime hook이 추가됐습니다.

- **module 경로**: `apps/mobile/src/locations/use-mobile-saved-location-hydration.ts`.
- **export 이름**: `useMobileSavedLocationHydration()`.
- 이 module은 `react`의 `useSyncExternalStore`와, 같은 `src/locations` 디렉터리의 hydration
  manager 상태 타입(`SavedLocationHydrationState`, type-only)·production composition의
  **store** singleton(`mobileSavedLocationHydrationStore`,
  `./mobile-saved-location-hydration-production`)만 import합니다.
- `subscribe`/client `getSnapshot`/server `getSnapshot` provider function은 module scope에 정확히
  한 번 정의되어(`export`하지 않음) `useSyncExternalStore`에 매 render마다 새 callback이 전달되지
  않고, client와 server getter는 동일한 함수 reference입니다 — 이 store의 캐시된 snapshot은 양쪽
  모두에서 안전하게 읽을 수 있기 때문입니다.
- hook의 반환값은 store의 `getSnapshot()`이 반환하는 **exact cached snapshot reference**입니다 —
  복사·spread·매핑·재검증이 없고, hook 자체의 local/derived state도 없습니다.
- hook은 `hydrate()`를 호출하지 않고, app-root one-shot startup 정책이나 `ERROR` retry 정책을
  재정의하지 않으며, listener·error·location logging이 없습니다. hook의 import나 호출만으로는
  storage I/O(`getItem`/`setItem`/`removeItem`)가 발생하지 않습니다 — store가 이미 hydrate된 이후에
  호출됐을 때만 그 terminal snapshot을 반영합니다.
- 이 hook은 production composition을 직접 import하므로 pure boundary가 아니며, pure barrel
  (`apps/mobile/src/locations/index.ts`)에서 **export되지 않습니다.** 향후 화면 consumer는 이
  hook module을 직접 import해야 합니다.
- **이 경계에서 하지 않는 것**: 지역 mutation/save, explicit retry 위임, 위치 권한/GPS, weather
  API 호출, timer/effect/memo/reducer, development client 재빌드, 실제 기기 QA. explicit retry와
  persistence 기반 `add`/`remove`는 이 hydration store 위에 쌓인 **application store**가
  소유합니다 — 이 경계의 공개 계약은 그대로 둔 채 위에서 관찰·위임하며, 자세한 내용은
  [mobile-saved-location-application.md](./mobile-saved-location-application.md) 참고.
