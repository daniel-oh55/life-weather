# KMA current + hourly `WeatherOverview` aggregate assembler

이 문서는 **pure, synchronous 함수** 한 개(`assembleKmaCurrentHourlyWeatherOverview`)의 책임과
경계를 기록합니다. 이 함수는 PR #24 hourly overview application service
(`createKmaLocationHourlyOverviewService`)의 성공 결과와, PR #74 current overview application
service(`createKmaLocationCurrentOverviewService`)의 성공 결과(또는 `null`)를 받아 **current +
hourly** 두 section을 모두 담은 partial `WeatherOverview`를 조립합니다.

## 목적

Production에는 지금 두 개의 독립된 partial-overview pipeline이 있습니다.

- **hourly**: `WeatherLocation` + `product` → PR #24 hourly overview service → hourly-only
  `WeatherOverview`
- **current**: `WeatherLocation` → PR #74 current overview service → current-only
  `WeatherOverview`

PR #75까지 current pipeline은 production composable해졌지만, `POST /weather`는 여전히 hourly
pipeline만 소비합니다. route를 연결하기 전에, 다음을 조합할 수 있는 **순수 경계 하나**가
필요합니다.

```text
hourly partial WeatherOverview
  +
optional current partial WeatherOverview
  →
current + hourly partial WeatherOverview
```

이 PR은 **그 순수 aggregate assembler만** 구현합니다. hourly 또는 current service를 직접
호출하지 않고, current 실패를 degrade할지 결정하지 않으며, production composition을 만들지
않고, route/presenter를 수정하지 않고, 네트워크 작업을 하지 않습니다.

## 구현 위치

- [kma-current-hourly-weather-overview.ts](../apps/api/src/services/kma-current-hourly-weather-overview.ts)
  — assembler
- [kma-current-hourly-weather-overview.test.ts](../apps/api/src/services/kma-current-hourly-weather-overview.test.ts)
  — 테스트

허용 import는 contracts public surface와 services sibling **타입**뿐입니다.

```ts
import {
  weatherOverview,
  type WeatherLocation,
  type WeatherOverview,
} from '@life-weather/contracts';

import type { KmaLocationCurrentOverviewResult } from './kma-location-current-overview.js';
import type { KmaLocationHourlyOverviewResult } from './kma-location-hourly-overview.js';
```

`KmaLocationHourlyOverviewResult`/`KmaLocationCurrentOverviewResult`는 **타입만** 가져오고,
`createKmaLocationHourlyOverviewService`/`createKmaLocationCurrentOverviewService`나 그 안의
어떤 collaborator도 호출하지 않습니다. Provider·composition·route·presenter·weather-core·Hono·
`process.env`·`fetch`·`Date`·`AbortController`·신규 package는 import하지 않습니다. `zod`는
직접 import하지 않고, contracts public `weatherOverview` schema만 사용합니다.

## 공개 API

```ts
type KmaHourlyOverviewSuccess = Extract<
  KmaLocationHourlyOverviewResult,
  { readonly ok: true }
>;

type KmaCurrentOverviewSuccess = Extract<
  KmaLocationCurrentOverviewResult,
  { readonly ok: true }
>;

export interface KmaCurrentHourlyWeatherOverviewInput {
  readonly hourly: KmaHourlyOverviewSuccess;
  readonly current: KmaCurrentOverviewSuccess | null;
}

export function assembleKmaCurrentHourlyWeatherOverview(
  input: KmaCurrentHourlyWeatherOverviewInput,
): WeatherOverview;
```

`KmaHourlyOverviewSuccess`/`KmaCurrentOverviewSuccess`는 module-local 타입이며 export하지
않습니다. 추가 factory·interface·class·generic framework는 만들지 않습니다.

## `current: null`의 정확한 의미

`input.current === null`은 오직 다음만을 뜻합니다.

> "caller가 이미 이 aggregate에 current section을 기여시키지 않기로 결정했다."

이 assembler는 **왜** current가 없는지 절대 검사하거나 추론하지 않습니다 — 다음 중 어느
것도 입력으로 받지 않고 읽지 않습니다.

- LOCATION 실패
- PROVIDER 실패
- NORMALIZATION 실패
- provider error kind
- HTTP status
- abort 사유
- retryability

current 실패를 degrade할지 여부는 이 assembler의 책임이 아니라, 이후의 application
orchestration PR의 책임입니다. 이 assembler는 실패 result union을 새로 만들지 않습니다.

## hourly overview가 baseline

hourly 성공 overview(`input.hourly.overview`)가 current가 아닌 모든 section의 baseline입니다.
이 assembler가 읽는 것은 오직 `input.hourly.overview`뿐이며, **`input.hourly.selection`은 읽지
않습니다.**

`selection`(PR #22 execution trace / fallback 실행 기록)은 application-internal한 세부사항이며
public `WeatherOverview` 조립에 참여해서는 안 됩니다. baseline의 다음 값은 selection·fallback·
provenance 재해석 없이 그대로 상속됩니다.

- `hourly`
- `daily`
- `airQuality`
- `alerts`
- CURRENT가 아닌 나머지 `missingSections`
- hourly/non-current `sources`

## current 부재 (`current === null`)

```text
location            = hourly baseline location
current             = null
CURRENT             = 여전히 missing
hourly 및 나머지 section = hourly baseline의 semantics 그대로
sources             = hourly baseline의 sources만
```

새 current source를 발명하지 않습니다. 반환 값은 caller의 hourly overview 객체 참조가
**아니라** 새로 조립되어 `weatherOverview.parse`로 검증된 fresh 값입니다.

## current 존재 (`current !== null`)

`input.current.overview`의 **current slice만** baseline 위에 overlay합니다.

| field | 값 |
| --- | --- |
| `location` | hourly baseline location |
| `current` | current overview의 `current` |
| `hourly` | hourly baseline `hourly` |
| `daily` | hourly baseline `daily` |
| `airQuality` | hourly baseline `airQuality` |
| `alerts` | hourly baseline `alerts` |
| `missingSections` | hourly baseline `missingSections`에서 `CURRENT`만 제거 |
| `sources` | current overview sources **다음** hourly baseline sources |

다음은 절대 하지 않습니다.

- `CurrentWeather`/`HourlyForecast`를 재계산
- `SourceMetadata`를 재조립하거나 값을 다시 계산
- timestamp를 재포맷
- `sourceId`를 추론
- `issuedAt`/`observedAt`/`fetchedAt`/`retrievalMode`를 추론

## `missingSections` 정책 — 정확히 한 가지 변환만

이 assembler는 **딱 하나**의 missingSections 변환만 소유합니다.

- current가 존재하면: hourly baseline의 `missingSections`에서 `CURRENT`를 제거합니다.
- current가 없으면: hourly baseline이 표현하는 그대로 `CURRENT`가 missing으로 남습니다.

그 외 모든 section 상태는 hourly baseline에서 상속됩니다. **`currentOverview.missingSections`를
baseline과 union하지 않습니다.**

### 왜 union하면 안 되는가

current-only overview는 정당하게 `HOURLY`를 missing으로 표시합니다(current assembler는 hourly
데이터를 절대 만들지 않으므로). 이 `missingSections`를 hourly-success aggregate에 union하면,
hourly 데이터가 실제로 존재하는데도 `HOURLY`가 잘못 missing으로 표시됩니다 — 이는 즉시
`weatherOverview`의 list-section invariant("`HOURLY`가 missing이면 `hourly`는 비어 있어야
한다"의 역방향은 강제되지 않지만, `HOURLY`가 missing인데 `hourly`에 데이터가 있으면 거부됨)를
위반해 `weatherOverview.parse`가 synchronous `ZodError`를 던집니다.

같은 이유로, hourly baseline의 선택된/미선택 HOURLY semantics를 버리는 `missingSections`
전체를 처음부터 다시 하드코딩하지도 않습니다. 최종 `weatherOverview.parse`가 이 invariant의
유일한 guard입니다.

## Source 순서 — 결정론적, current 먼저

current가 있을 때 `sources`는 다음 순서로 조립됩니다.

1. current overview의 sources
2. hourly overview의 sources

각 배열 내부의 순서는 보존됩니다. 다음을 하지 않습니다.

- 정렬(sort)
- 중복 제거(dedupe)
- 서로 다른 `SourceMetadata` 객체 병합
- section 변경
- provider 변경
- timestamp 재작성

각 source의 provenance는 여전히 PR #23/#73 assembler의 소유입니다 — 이 aggregate assembler는
그 값을 그대로 이어붙일 뿐입니다.

## Location 일치 요구사항

current가 존재할 때, current overview와 hourly overview는 **값으로** 같은 `WeatherLocation`을
설명해야 합니다. 객체 reference identity는 요구하지 않습니다 — 두 source assembler는 각각
독립적으로 fresh parsed 객체를 만듭니다.

비교하는 필드는 `WeatherLocation`의 모든 contract field입니다.

- `id`
- `displayName`
- `countryCode`
- `adminArea1`
- `adminArea2`
- `adminArea3`
- `latitude`
- `longitude`
- `timezone`

하나라도 다르면 **synchronous `RangeError`**를 던집니다. 오류 메시지는 고정된 static
문자열이며 좌표·id·displayName·location 객체 등 어떤 값도 포함하지 않습니다.

비교는 다음을 사용하지 않습니다.

- `JSON.stringify` 동등성
- locale-dependent 비교
- 좌표 근사/허용오차(tolerance)
- 반올림(rounding)

정규화된 contract-value의 정확한 field-by-field `===` 비교로 충분합니다.

## Input validity — `weatherOverview.parse`가 유일한 boundary

`WeatherOverview`/`WeatherLocation` schema를 재정의하지 않습니다. 조립된 payload는 반환 전
반드시 contracts public `weatherOverview.parse(...)`로 검증합니다. `zod`를 직접 import하지
않습니다. malformed/inconsistent aggregate는 synchronous하게 throw합니다.

## PR #23 / #73 assembler 정책의 재구현 없음

hourly의 selected/no-selection 판정, `HOURLY` missing semantics, hourly `SourceMetadata`
정책은 PR #23(`assembleKmaHourlyWeatherOverview`)이 이미 소유합니다. current 존재 판정,
`CURRENT` `SourceMetadata` 정책, `observedAt` 정책은 PR #72/#73
(`assembleKmaCurrentWeatherOverview`)이 이미 소유합니다. 이 aggregate assembler는 그 두
assembler가 **이미 만든 결과**를 조합할 뿐이며, 그 정책을 재구현하지 않습니다.

## Purity

`assembleKmaCurrentHourlyWeatherOverview`는 다음을 절대 하지 않습니다.

- `Promise` 반환, `async` 사용
- `fetch`, network, Provider, service, facade, resolver 호출
- clock read(`Date.now()`/`new Date()`), `process.env`, `AbortSignal`
- `console.*` 호출
- cache, singleton, module-level mutable state
- 넓은 `try`/`catch`(`weatherOverview.parse`의 validation error는 caller가 처리하도록 그대로
  전파됩니다)

## Immutability / allocation

다음을 mutate하지 않습니다.

- `input`
- hourly 성공 wrapper, `input.hourly.selection`, hourly overview 및 그 안의 section/array
- current 성공 wrapper, current overview 및 그 안의 section/array
- 어떤 `WeatherLocation`이나 `SourceMetadata`도

Deep-frozen input에서도 정상 동작합니다. 매 성공 호출은 fresh `WeatherOverview` 객체를
반환하며, `weatherOverview.parse`가 nested object/array를 다시 생성하므로 output nested
reference identity는 계약이 아닙니다(값과 순서만 보존).

## `hourly.selection`은 절대 읽지 않음

`input.hourly` 값에는 `selection`(PR #22 execution trace)이 포함돼 있지만, 이 assembler는
`input.hourly.overview`만 읽습니다. 테스트는 `selection`에 접근 시 throw하는 getter를 가진
fixture로 이를 직접 검증합니다 — 그런 fixture로도 assembler는 정상 동작합니다.

이 assembler는 다음 중 어떤 것도 노출하거나 읽지 않습니다.

- service key, provider URL
- request/`baseDate`/`baseTime`
- raw provider result
- `WeatherOverview.location` contract를 벗어나는 좌표

## 범위 밖

이 assembler는 다음을 수행하지 않습니다.

- hourly/current application service 직접 호출
- current 실패(LOCATION/PROVIDER/NORMALIZATION) degradation 정책 결정
- 동시성/`Promise.all`/요청 순서 정책
- retry/fallback/cache/stale-data
- availability-delay/timeout 정책
- HTTP 오류 매핑, 새 `ApiErrorCode`
- production composition root 생성
- `POST /weather` route 연결
- `apps/api/src/routes/**`, `apps/api/src/presenters/**`, `apps/api/src/composition/**`,
  `apps/api/src/index.ts`, `apps/api/src/api-app.ts` 수정
- contracts/`CONTRACT_VERSION` 변경
- AirKorea, daily forecast, alerts, lifestyle policy, mobile wiring

## 실제 key·네트워크·좌표 미사용

- 실제 `KMA_SERVICE_KEY`를 사용하지 않았습니다.
- 자동 테스트는 실제 네트워크를 호출하지 않고, synthetic `WeatherLocation`/`CurrentWeather`/
  `HourlyForecast` fixture와 PR #23/#72/#73 실제 assembler 함수로 만든 fixture만 사용합니다.
  실제 사용자 좌표는 사용하지 않습니다.

## 변경 이력

```text
v1 / PR #76 / 2026-08
- hourly 성공 overview + optional current 성공 overview → current+hourly partial WeatherOverview
  순수 aggregate assembler 추가
- current: null은 caller가 이미 결정한 사실만 의미, 실패 사유를 검사/추론하지 않음
- missingSections: CURRENT 제거만(union 금지), 나머지는 hourly baseline 상속
- sources: current 먼저, hourly 다음(결정론적, sort/dedupe/merge 없음)
- location 값 일치 요구(field-by-field, reference identity 아님), 불일치는 static value-free
  RangeError
- input.hourly.selection은 절대 읽지 않음
- weatherOverview.parse가 유일한 runtime validation boundary
- pure/synchronous/no-I/O, frozen input 지원, 매 호출 fresh output
- PR #23/#72/#73 assembler의 정책을 재구현하지 않음
- route/composition/POST 연결/current 실패 degradation 정책은 이 PR 범위 밖
```
