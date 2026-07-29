# 모바일 저장 지역 경계

이 문서는 `apps/mobile/src/locations`의 **모바일 저장 지역(saved-location) 경계** 중 지역 **한 건**을
설명합니다. 이 경계는 기기에 저장될 지역 한 건의 런타임 schema와, 저장 지역을 공유
`WeatherRequestV1`으로 안전하게 변환하는 순수 함수만 다룹니다. 실제 저장소·위치 권한·현재 위치
조회·화면 연결·실제 API 호출은 다루지 않습니다.

여러 지역을 canonical collection으로 관리하는 순수 경계(추가·삭제·재정렬·현재 위치 설정/해제와
그 불변조건)는 [저장 지역 collection 경계](./mobile-saved-location-collection.md)에서 별도로
설명합니다. 이 문서의 single-record schema는 그 collection 경계가 element schema로 재사용합니다.

## 목적과 경계

- 공유 `@life-weather/contracts`의 `weatherLocation`을 **재사용(확장)**합니다. 공유
  `WeatherLocation`이나 `WeatherRequestV1`을 모바일 안에서 복사·재정의하지 않습니다.
- 앱 로컬 전용 필드(`kmaGrid`, `isCurrent`, `sortOrder`)를 저장 모델에 additive하게 더합니다.
- 저장 지역의 unknown 입력을 strict schema로 검증합니다.
- 네트워크 요청에는 공유 `WeatherLocation` 필드만 **명시적으로 매핑**해 넣고, 로컬 전용·
  Provider 종속 필드는 요청에서 제거합니다.
- module import·함수 호출 시 network·환경변수·저장소 접근이 없고 logging/retry/cache/timeout도
  없습니다.

## 모바일 로컬 모델과 공유 `WeatherLocation`의 차이

`WeatherLocation`은 모바일과 API가 공유하는 정규화 계약으로, 앱 발급 opaque `id`와 표시명·국가·
행정구역·좌표·timezone만 가집니다(자세한 내용은 [contracts.md](./contracts.md)). 저장 지역
(`MobileSavedLocation`)은 이 공유 shape을 그대로 재사용하면서 기기 로컬 관심사 세 가지를 더합니다.

| 필드 | 타입 | 정책 |
| --- | --- | --- |
| `kmaGrid` | `MobileKmaGrid \| null` | required + nullable. `{ nx, ny }` strict object이며 `nx`/`ny`는 non-negative 정수. 아직 격자를 알 수 없으면 `null`. |
| `isCurrent` | `boolean` | required. 이 record가 기기의 현재 위치인지 여부. |
| `sortOrder` | `number` | required non-negative 정수. 저장 목록 내 표시 순서. |

공유 필드(`id`, `displayName`, `countryCode`, `adminArea1`/`2`/`3`, `latitude`, `longitude`,
`timezone`)는 `weatherLocation` 규칙을 그대로 상속합니다. 특히 `adminArea*`는 **required +
nullable**이라 값이 없으면 명시적 `null`을 저장해야 하고 필드를 누락하면 거부됩니다. `id`는
app-issued opaque ID이며 Provider-native ID(KMA 격자, AirKorea 측정소 등)가 아닙니다.

## `kmaGrid`·`isCurrent`·`sortOrder`가 local-only인 이유

- `kmaGrid`(nx/ny)는 특정 Provider(KMA)에 종속된 조회 hint입니다. 공유 계약에 넣으면 모바일과
  생활지수 엔진이 Provider 세부사항에 결합되므로, 격자는 기기 로컬 저장 모델에만 둡니다. KMA
  `product`·격자 선택은 서버 측 정책입니다.
- `isCurrent`·`sortOrder`는 저장·표시(UI) 관심사이며 서버가 지역을 특정하는 데 필요하지 않습니다.

이 세 필드의 정확한 KMA 격자 범위나 weather-core 정책값은 이 모델에 복사하지 않습니다. 로컬
저장 shape만 정의합니다.

## strict schema와 required + nullable 정책

- 최상위 object와 `kmaGrid` object 모두 **strict**입니다. 알 수 없는 키(실수로 섞여 들어온
  `nx`/`ny` 같은 Provider-native 키 포함)는 조용히 제거하지 않고 **검증을 실패**시킵니다.
- 로컬 전용 세 필드는 모두 **required**이며 optional로 만들지 않습니다. `kmaGrid`만 nullable입니다.
- `nx`/`ny`/`sortOrder`는 finite non-negative 정수만 허용합니다(음수·소수·`NaN`·`Infinity` 거부).

## 요청 변환과 explicit mapping 정책

`createWeatherRequestFromSavedLocation(input: unknown)`은 throw하지 않는 discriminated result를
반환합니다.

```ts
type SavedLocationWeatherRequestResult =
  | { ok: true; request: WeatherRequestV1 }
  | { ok: false; error: { kind: 'INVALID_SAVED_LOCATION' } };
```

처리 순서:

1. 입력을 `mobileSavedLocation.safeParse`로 검증합니다.
2. 실패하면 고정된 `INVALID_SAVED_LOCATION` 결과를 반환합니다.
3. 성공하면 공유 9개 필드(`id`, `displayName`, `countryCode`, `adminArea1`/`2`/`3`, `latitude`,
   `longitude`, `timezone`)를 **하나씩 명시적으로** 새 object로 매핑합니다. `{ ...savedLocation }`
   같은 spread는 로컬 전용·Provider 종속 필드를 요청에 흘려보내므로 사용하지 않습니다.
4. `{ location }`을 `weatherRequestV1.safeParse`로 방어적으로 재검증합니다.
5. 성공한 `WeatherRequestV1`을 반환하고, 방어적 parse가 실패해도 throw 없이 동일한 invalid
   결과를 반환합니다.

요청에는 `kmaGrid`·`isCurrent`·`sortOrder`·`nx`·`ny`가 절대 포함되지 않습니다.

## 불변성과 오류 경계

- 입력 object를 mutate하지 않습니다.
- 성공 request와 nested location은 매번 fresh object입니다.
- 오류 result에는 Zod issue, field path, 원본 object, 좌표, 표시명, secret marker 등 입력에서
  파생된 값을 담지 않습니다. `{ kind: 'INVALID_SAVED_LOCATION' }` 고정 shape만 반환합니다.
- runtime-invalid cast나 unknown 입력에도 throw하지 않습니다.

## 이 PR에서 하지 않는 것

이 경계는 지역 한 건의 모델과 변환 함수만 제공합니다. 여러 지역 collection, add/delete/reorder,
중복 ID 처리, `sortOrder` 재인덱싱, 현재 위치 record 유일성 정책은 이제 별도의 순수 경계인
[저장 지역 collection 경계](./mobile-saved-location-collection.md)에서 구현됐습니다(schema와 순수
operation 한정). 다음은 여전히 후속 PR 범위입니다.

- AsyncStorage 등 저장소 adapter, 새 storage dependency, 직렬화·마이그레이션·persisted read/write
- 위치 권한, GPS/Fused Location, geocoding·지역 검색, 현재 위치 조회
- 화면·navigation 연결, weather client 실제 호출

## 향후 소비

향후 location store / collection adapter가 `mobileSavedLocation`으로 저장 record를 검증하고,
화면 연결 시 `createWeatherRequestFromSavedLocation`으로 저장 지역을 contract-safe
`WeatherRequestV1`으로 변환한 뒤 [모바일 weather API client](./mobile-weather-api-client.md)에
전달합니다.
