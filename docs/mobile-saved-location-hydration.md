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

- app root wiring, React hook/context/provider, `useSyncExternalStore` 등 referential-stability나
  subscription 계약.
- 지역 추가·삭제·재정렬 UI, mutation 후 자동 저장.
- write queue, debounce, retry backoff.
- refresh, background rehydration, stale data 유지 정책.
- migration 실행, corrupt data repair/delete.
- 위치 권한, GPS, weather API 호출.
- native build, 실제 기기 QA.

## production composition

`mobile-saved-location-async-storage.ts`(concrete AsyncStorage binding)와 이 manager를 실제로
조립하는 module이 추가됐습니다.

- **module 경로**: `apps/mobile/src/locations/mobile-saved-location-hydration-production.ts`.
- 이 module은 위 두 기존 경계만 import합니다 — `mobileSavedLocationPersistence`
  (`./mobile-saved-location-async-storage`)와 `createSavedLocationHydrationManager`
  (`./mobile-saved-location-hydration-manager`).
- production persistence instance를 manager factory에 **정확히 한 번** 주입합니다.

  ```ts
  export const mobileSavedLocationHydrationManager: SavedLocationHydrationManager =
    createSavedLocationHydrationManager(mobileSavedLocationPersistence);
  ```

- **export 이름**: `mobileSavedLocationHydrationManager` — module scope singleton입니다.
- module import나 이 singleton을 참조하는 것만으로는 `hydrate()`를 호출하지 않고 어떤 storage
  I/O(`getItem`/`setItem`/`removeItem`)도 발생하지 않습니다 — 두 collaborator 생성 자체가
  side-effect-free이므로, export된 manager는 `hydrate()`를 호출하기 전까지 항상 `NOT_STARTED`입니다.
- storage key, envelope version, 오류 kind, collection 정책은 이 module에서 **재정의하지 않고**
  기존 두 경계가 그대로 소유합니다. `try/catch`, retry, logging, telemetry, environment/clock/
  random/network 접근이 없습니다.
- 이 production composition module은 **pure barrel `apps/mobile/src/locations/index.ts`에서
  export하지 않습니다** — AsyncStorage binding과 같은 이유로, native module을 transitively 끌어오기
  때문입니다. Node 기반 unit test와 pure domain consumer는 이 barrel을 통해 native module을 절대
  load하지 않으며, runtime consumer는 이 production module을 **직접** import합니다.
- app-start에서 `hydrate()`를 호출하는 wiring, React state/context/hook/UI 연결은 여전히
  **미구현**입니다.
- 이 변경은 native dependency나 native config를 추가하지 않았으므로, development client 재빌드나
  실제 기기 QA는 이번 PR에서도 수행하지 않았습니다.
