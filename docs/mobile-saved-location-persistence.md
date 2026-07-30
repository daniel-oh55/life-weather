# 모바일 저장 지역 persistence 경계

이 문서는 `apps/mobile/src/locations`의 **저장 지역 persistence 경계**를 설명합니다. 이 경계는
[collection 경계](./mobile-saved-location-collection.md)(PR #40)가 만든 canonical collection을
**하나의 저장 문자열로 encode/decode**하고, 주입된 최소 key-value port를 통해 load·save·clear하는
책임만 가집니다. 이 codec 경계 자체는 어떤 concrete native store도 import하지 않습니다 — 실제
AsyncStorage 연결은 별도 module이 담당하며(아래 [concrete AsyncStorage production
binding](#concrete-asyncstorage-production-binding) 참고), migration 실행, 화면·상태·권한 연결은
여전히 후속 PR로 남습니다.

## 목적

- collection을 device에 저장할 수 있는 **provider-neutral persistence 경계**를 제공합니다.
- collection을 버전된 **V1 envelope**로 감싸 저장하고, 저장 문자열을 다시 collection으로 복원합니다.
- 어떤 concrete native storage package도 import·설치하지 않고, 최소 key-value port만 의존합니다.
- 손상 데이터·미지원 버전을 **fail closed**로 처리하고, 저장 실패 시 데이터 무결성을 지킵니다.
- 모든 함수는 throw하지 않고, 입력을 mutate하지 않으며, 성공 시 fresh output을, 실패 시 고정된
  비노출 오류만 반환합니다.

## provider-neutral key-value port

이 경계는 다음 세 메서드만 갖는 최소 interface에 의존합니다.

```ts
interface SavedLocationKeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
```

- AsyncStorage·SecureStore 등 **native package 타입을 import하지 않습니다.**
- `clear()`(store 전체 비우기)·batch·key enumeration은 port에 포함하지 않습니다.
- provider-neutral persistence module 자체는 실제 기기 store를 만들거나 import하지 않습니다. 실제
  기기 store 주입은 별도 concrete binding
  `apps/mobile/src/locations/mobile-saved-location-async-storage.ts`에 구현되어 있으며,
  `mobileSavedLocationPersistence`를 제공합니다. 이 binding의 module import와 instance 생성만으로는
  storage I/O가 발생하지 않습니다.
- 테스트는 이 interface를 구현한 in-memory fake 또는 call-recording spy로 검증합니다.

## 안정적인 storage key와 버전 분리

```ts
export const SAVED_LOCATION_PERSISTENCE_VERSION = 1 as const;
export const SAVED_LOCATION_PERSISTENCE_KEY =
  '@life-weather/mobile/saved-locations' as const;
```

- storage key는 **버전과 분리된 안정적인 상수**입니다.
- 버전은 key가 아니라 envelope **내부**에 저장합니다.
- 이렇게 분리한 이유: 향후 migration 시 **같은 key에서 이전 버전 envelope를 읽어** 어떻게 변환할지
  결정할 수 있어야 하기 때문입니다. 버전을 key에 넣으면 이전 데이터를 찾을 수 없게 됩니다.
- key에는 사용자 ID·device ID·좌표·운영 식별자를 넣지 않고, 환경변수로 만들지 않으며, 호출자가
  임의로 전달하지 않습니다.

## V1 envelope

```ts
z.object({
  version: z.literal(SAVED_LOCATION_PERSISTENCE_VERSION),
  locations: mobileSavedLocationCollection,
}).strict()
```

```json
{ "version": 1, "locations": [] }
```

- top-level `.strict()`로 unknown key를 거부합니다.
- `locations`는 기존 `mobileSavedLocationCollection`을 **그대로 재사용**합니다 — ID 유일성·현재
  위치 0~1개·canonical `sortOrder` 불변조건을 여기서 다시 작성하지 않습니다.
- timestamp·`updatedAt`·device ID·installation ID·API URL·복사한 계약 version을 두지 않습니다.
- empty collection은 유효한 payload입니다.

## encode 정책

`encodeSavedLocationCollection(input)`은 다음 순서로 동작합니다.

1. `mobileSavedLocationCollection.safeParse(input)`으로 검증합니다.
2. 검증 실패(또는 hostile 입력 처리 중 예외)는 `INVALID_COLLECTION`입니다.
3. schema가 반환한 **canonical 데이터**로 V1 envelope를 만듭니다(raw input을 그대로 쓰지 않습니다).
4. envelope를 schema로 방어적으로 재검증합니다.
5. `JSON.stringify`로 단일-line 문자열을 만듭니다.

`sortOrder`를 자동 수정하거나 collection을 조용히 고치지 않고, timestamp 등 nondeterministic 값을
추가하지 않으므로 **동일한 canonical 입력은 항상 동일한 문자열**을 만듭니다. 입력을 mutate하지 않고
storage에 접근하지 않으며, 예상 밖 실패도 throw 대신 `INVALID_COLLECTION`으로 collapse합니다.

## decode 정책

`decodeSavedLocationCollection(rawInput)`은 다음 순서로 동작합니다.

1. string이 아니거나 빈 string이면 `INVALID_STORED_LOCATIONS`.
2. `JSON.parse` 실패는 `INVALID_STORED_LOCATIONS`.
3. parse 결과가 일반 object이고 `version`이 **1이 아닌 정수**이면 `UNSUPPORTED_STORED_VERSION`.
4. 그 외에는 V1 envelope schema로 검증하고, 실패는 `INVALID_STORED_LOCATIONS`.

성공 시 fresh `locations`를 반환하며, 이 값은 collection schema를 통과하고 호출마다 array·record·
non-null `kmaGrid`가 모두 새 reference입니다. 미지원 버전을 V1로 추측해 읽지 않고, malformed
데이터를 빈 collection으로 바꾸거나 자동 repair하지 않으며, raw input을 반환·logging하지 않습니다.

### 버전 분류

| 저장값 | 분류 |
| --- | --- |
| `{ version: 1, locations: … }`(유효) | 성공 |
| `{ version: 2, … }` / `{ version: 0, … }` | `UNSUPPORTED_STORED_VERSION` |
| `{ version: "2", … }`(문자열) | `INVALID_STORED_LOCATIONS` |
| version 누락 / `null` / 소수 | `INVALID_STORED_LOCATIONS` |
| 배열·primitive·malformed JSON | `INVALID_STORED_LOCATIONS` |

JSON은 `NaN`·`Infinity`를 표현하지 못하므로 실제 JSON 입력 기준으로 처리합니다.

## load / save / clear 정책

`createSavedLocationPersistence(storage)`가 `load`/`save`/`clear`를 제공합니다. factory 생성·module
import만으로는 어떤 storage 메서드도 호출하지 않습니다.

### load

- `getItem(KEY)`를 **정확히 한 번** 호출합니다.
- 동기 throw·Promise rejection은 `STORAGE_READ_FAILED`.
- `null`(key 없음)은 오류가 아니라 **성공한 fresh empty collection**입니다.
- null이 아닌 값은 decode codec으로 처리해 그 결과를 그대로 반환합니다.
- 손상 데이터·미지원 버전은 fail closed이며, load 중 `setItem`·`removeItem`을 호출하거나 자동
  삭제·migration을 수행하지 않습니다.
- runtime에서 잘못된 non-string 값을 반환해도 throw하지 않고 `INVALID_STORED_LOCATIONS`.

### save

- encode codec을 먼저 호출합니다. invalid collection은 `INVALID_COLLECTION`이며 **storage를 전혀
  호출하지 않습니다** — 잘못된 값이 기존 저장값을 덮어쓰지 못합니다.
- 성공 시 `setItem(KEY, serialized)`를 **정확히 한 번** 호출합니다(read-modify-write 없음).
- 동기 throw·Promise rejection은 `STORAGE_WRITE_FAILED`.
- raw input이 아니라 검증된 canonical collection을 저장하고, 입력을 mutate하지 않습니다.

### clear

- `removeItem(KEY)`를 **정확히 한 번** 호출합니다.
- **store 전체 `clear()`를 사용하지 않으며**, 다른 app key에 영향을 주지 않습니다.
- key가 없어도 provider가 정상 resolve하면 성공입니다.
- 동기 throw·Promise rejection은 `STORAGE_CLEAR_FAILED`.

## 고정 안전 오류

공개 오류 kind는 다음과 같으며, 모두 `{ kind }`만 담는 고정 discriminator입니다.

```ts
type SavedLocationPersistenceErrorKind =
  | 'INVALID_COLLECTION'
  | 'INVALID_STORED_LOCATIONS'
  | 'UNSUPPORTED_STORED_VERSION'
  | 'STORAGE_READ_FAILED'
  | 'STORAGE_WRITE_FAILED'
  | 'STORAGE_CLEAR_FAILED';
```

오류에는 dynamic message·Zod issue·validation path·JSON parse 오류·native error·stack/cause·raw
저장 문자열·storage key·저장 지역 ID/표시명/좌표/grid·원본 collection을 담지 않습니다. 오류 원인을
logging하거나 telemetry로 전송하지 않으며, 호출마다 **fresh result·fresh nested error object**를
반환합니다.

## 입력 불변성과 fresh output

- encode·save 입력을 mutate하지 않습니다(deep-frozen 입력도 처리 가능).
- decode·load 성공 output array·모든 record·null이 아닌 `kmaGrid`는 fresh이며, null grid는 null을
  유지합니다.
- 두 번의 decode/load 성공 결과 간에도 reference를 공유하지 않습니다.
- module-level mutable cache·singleton result·shared empty array·shared error object가 없습니다.

JSON 직렬화는 persistence codec의 목적이므로 이 경계 안에서 사용하지만, collection 연산의 clone
helper를 대체하거나 바꾸지 않습니다.

## concrete AsyncStorage production binding

provider-neutral persistence 경계는 **정책만** 소유하고, 실제 기기 저장소 연결은 별도 module이
담당합니다.

- **concrete provider**: `@react-native-async-storage/async-storage` **2.2.0**(Expo SDK 57 호환,
  `pnpm exec expo install`로 설치).
- **binding 파일**: `apps/mobile/src/locations/mobile-saved-location-async-storage.ts`.
- 이 binding은 AsyncStorage의 `getItem`/`setItem`/`removeItem` **세 메서드만** 위 key-value port로
  위임하고, 기존 `createSavedLocationPersistence()`로 production instance
  `mobileSavedLocationPersistence`를 만듭니다.

### pure persistence와 concrete binding의 경계

- 안정적인 storage key, V1 envelope, encode/decode codec, 고정 오류 kind는 **모두 persistence
  경계**가 소유합니다. binding은 key literal을 다시 쓰지 않고, `try/catch`로 오류를 변환하지 않으며
  (동기 throw·Promise rejection을 그대로 port에 전달해 기존 경계가 `STORAGE_READ_FAILED`/
  `STORAGE_WRITE_FAILED`/`STORAGE_CLEAR_FAILED`로 분류), logging·telemetry도 하지 않습니다.
- binding은 `clear()`·`getAllKeys()`·`multiGet`/`multiSet`/`multiRemove`·`mergeItem` 같은 **광범위
  API를 사용하지 않습니다.** 특히 store 전체를 지우는 `clear()`는 이 앱의 AsyncStorage에서 다른
  기능이 소유한 저장값까지 제거할 수 있어 금지입니다.

### pure barrel이 native binding을 export하지 않는 이유

`mobileSavedLocationPersistence`는 pure barrel `apps/mobile/src/locations/index.ts`에서 **export하지
않습니다.** 기존 single-record·collection·persistence 테스트와 pure domain consumer가 native module을
전이적으로 load하지 않도록 하기 위함이며, Node 기반 unit test에도 native runtime dependency가 새지
않습니다. runtime consumer는 binding 파일을 **직접** import합니다.

### 저장 특성과 보안

- AsyncStorage는 **asynchronous·persistent·unencrypted** key-value storage입니다. OS-level app
  sandbox를 저장소 암호화와 혼동하지 않으며, encryption은 이 PR 범위가 아닙니다.
- 이 key에는 **저장 지역 collection만** 기록합니다. API key·token·password·authentication secret은
  저장하지 않습니다. raw 오류·저장값을 logging하지 않습니다.
- 저장 지역명·좌표는 개인정보로 취급합니다(문서에 실제 값·예시를 기록하지 않습니다).
- module import·instance 참조만으로는 어떤 storage I/O도 수행하지 않습니다(`getItem`/`setItem`/
  `removeItem` 0회, hydration·migration·삭제·network·환경변수 접근 없음). provider object와
  persistence instance 생성만 import 시 일어납니다.

### 아직 하지 않은 것(후속 범위)

- app-start hydration, React state/context, 지역 관리 화면·navigation, 자동 저장 orchestration,
  migration 실행, 위치 권한.
- 이 dependency는 native module을 포함하므로, 현재 기기에 설치된 development client는 **재빌드 전까지**
  새 native module을 포함하지 않습니다. 이 PR은 development build·EAS build·native prebuild를
  실행하지 않았고, 실제 Galaxy 기기 runtime QA는 아직 수행하지 않았습니다.

## 이 PR에서 하지 않는 것

- production store instance를 넘어선 그 밖의 native storage binding(`expo-secure-store`·
  `expo-sqlite`·MMKV 등), app config plugin, native build.
- storage encryption·key 관리, backup/restore.
- migration 실행·legacy key 검색·corrupt data 자동 repair/삭제.
- concurrent write queue·transaction·compare-and-swap, collection 최대 개수 정책.
- React context·상태 라이브러리·hook, 화면·navigation, 위치 권한·GPS·현재 위치 조회, 실제 API 호출.
