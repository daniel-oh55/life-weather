# KMA hourly WeatherOverview assembler

이 문서는 PR #23에서 추가한 **순수·결정론적 partial-overview assembler** 한 개
(`assembleKmaHourlyWeatherOverview`)의 책임과 경계를 기록합니다. 이 함수는 PR #22
`selectKmaHourlyFallbackResult`가 이미 계산한 `KmaHourlyFallbackSelection`을 입력으로 받아,
contracts의 `WeatherOverview`를 **hourly section만** 조립합니다.

## 목적

- PR #22 selector는 execution trace에서 어느 hourly result(primary / previous / none)를 데이터
  source로 쓸지 **고르기만** 하고, `WeatherOverview`/`SourceMetadata`는 만들지 않습니다.
- 이 assembler는 그 selection의 **hourly slice 소비자**입니다. caller가 제공한 `WeatherLocation`,
  precomputed selection, 그리고 (선택된 source가 있을 때만) `SourceMetadata` provenance context를 받아
  다음을 조립합니다.
  1. contracts의 `WeatherOverview`
  2. 선택된 hourly source에 대응하는 KMA `HOURLY` `SourceMetadata` 한 건
  3. 아직 수집하지 않은 section의 정확한 `missingSections`

현재 pipeline이 공급할 수 있는 데이터는 KMA hourly forecast뿐이므로, 이 PR은 **hourly section만**
조립하는 partial overview assembler입니다. LOCATION branch 처리·selector 실행·source metadata 추론·
current/daily/air-quality/alerts 구현·production composition·route·cache는 포함하지 않습니다(아래 "범위
밖" 참조).

## 구현 위치

- [kma-hourly-weather-overview.ts](../apps/api/src/services/kma-hourly-weather-overview.ts) — assembler
- [kma-hourly-weather-overview.test.ts](../apps/api/src/services/kma-hourly-weather-overview.test.ts) — 테스트

이 위치(`apps/api/src/services`)에 두는 이유:

- application-service selection(`KmaHourlyFallbackSelection`)을 소비해 공유 contract payload를 조립하는
  **application-layer 정책**입니다.
- Provider boundary가 아니며, `weather-core` 순수 domain 계산도 아닙니다.

허용 import는 contracts public surface와 services sibling type뿐입니다.

```ts
import {
  weatherOverview,
  type SourceMetadata,
  type WeatherLocation,
  type WeatherOverview,
} from '@life-weather/contracts';

import type { KmaHourlyFallbackSelection } from './kma-hourly-fallback-selection';
```

Provider·composition·location facade·fallback service runtime·classifier·request-plan factory·
weather-core·Hono·`process.env`·`fetch`·`Date`·`AbortController`·신규 package는 import하지 않습니다.

## 공개 API

```ts
export type KmaHourlySourceMetadataInput = Pick<
  SourceMetadata,
  'sourceId' | 'issuedAt' | 'fetchedAt' | 'retrievalMode'
>;

export type KmaHourlyWeatherOverviewInput =
  | {
      readonly location: WeatherLocation;
      readonly selection: Extract<
        KmaHourlyFallbackSelection,
        { readonly selected: true }
      >;
      readonly source: KmaHourlySourceMetadataInput;
    }
  | {
      readonly location: WeatherLocation;
      readonly selection: Extract<
        KmaHourlyFallbackSelection,
        { readonly selected: false }
      >;
      readonly source: null;
    };

export function assembleKmaHourlyWeatherOverview(
  input: KmaHourlyWeatherOverviewInput,
): WeatherOverview;
```

추가 factory·interface·class는 만들지 않습니다.

### input union

input union은 selection arm과 source를 **correlate**합니다.

- **selected** (`selection.selected === true`) → `source`는 `KmaHourlySourceMetadataInput` provenance
  context입니다.
- **no selection** (`selection.selected === false`) → `source`는 정확히 `null`입니다. 선택되지 않은
  source의 metadata를 만들지 않기 위함입니다.

두 selection arm은 `KmaHourlyFallbackSelection`에서 `Extract`로 narrow하므로, "선택됐는데 source가
null"이거나 "선택 없는데 source context가 있는" 조합을 union이 허용하지 않습니다.

## selected branch

`input.selection.selected === true`일 때, overview를 만들기 **전에** selected `hourly`가 최소 한 건인지
먼저 검증합니다(빈 배열이면 여기서 synchronous `ZodError`).

```ts
const hourly = nonEmptyHourlyForecasts.parse(input.selection.result.hourly);
```

그 뒤 다음 의미로 조립합니다.

```ts
{
  location: input.location,
  current: null,
  hourly,
  daily: [],
  airQuality: {
    current: null,
    daily: [],
  },
  alerts: [],
  missingSections: [
    'CURRENT',
    'DAILY',
    'AIR_QUALITY_CURRENT',
    'AIR_QUALITY_FORECAST',
    'ALERTS',
  ],
  sources: [
    {
      sourceId: input.source.sourceId,
      provider: 'KMA',
      sections: ['HOURLY'],
      issuedAt: input.source.issuedAt,
      observedAt: null,
      fetchedAt: input.source.fetchedAt,
      retrievalMode: input.source.retrievalMode,
    },
  ],
}
```

- `hourly`: 선택된 result의 hourly data(값·순서 보존).
- `sources`: KMA `HOURLY` `SourceMetadata` **한 건**.
- `missingSections`: `CURRENT`·`DAILY`·`AIR_QUALITY_CURRENT`·`AIR_QUALITY_FORECAST`·`ALERTS`.
  **HOURLY는 포함하지 않습니다.**

## no-selection branch

`input.selection.selected === false`일 때 다음 의미로 조립합니다.

```ts
{
  location: input.location,
  current: null,
  hourly: [],
  daily: [],
  airQuality: {
    current: null,
    daily: [],
  },
  alerts: [],
  missingSections: [
    'CURRENT',
    'HOURLY',
    'DAILY',
    'AIR_QUALITY_CURRENT',
    'AIR_QUALITY_FORECAST',
    'ALERTS',
  ],
  sources: [],
}
```

- `hourly`: `[]`.
- `sources`: `[]`.
- `missingSections`: 여섯 section 전부(HOURLY 포함).
- 선택되지 않은 source의 metadata를 **만들지 않습니다.**

## WeatherOverview field mapping

| field | selected | no selection |
| --- | --- | --- |
| `location` | caller `location` | caller `location` |
| `current` | `null` | `null` |
| `hourly` | 선택된 result의 hourly | `[]` |
| `daily` | `[]` | `[]` |
| `airQuality.current` | `null` | `null` |
| `airQuality.daily` | `[]` | `[]` |
| `alerts` | `[]` | `[]` |
| `missingSections` | HOURLY 제외 5개 | HOURLY 포함 6개 |
| `sources` | KMA HOURLY 1건 | `[]` |

## missingSections 정책

`WeatherOverview`의 `superRefine` invariant가 무엇을 강제하고 무엇을 강제하지 **않는지**를 정확히
구분해야 합니다. object section(`current`/`airQuality.current`)만 양방향(biconditional)이고, list
section(`hourly`/`daily`/`airQuality.daily`/`alerts`)은 **단방향**입니다.

### contracts schema가 직접 강제하는 것

- `current: null` ↔ `CURRENT` missing (biconditional)
- `airQuality.current: null` ↔ `AIR_QUALITY_CURRENT` missing (biconditional)
- `HOURLY`가 missing이면 `hourly`는 empty여야 함
- `DAILY`가 missing이면 `daily`는 empty여야 함
- `AIR_QUALITY_FORECAST`가 missing이면 `airQuality.daily`는 empty여야 함
- `ALERTS`가 missing이면 `alerts`는 empty여야 함

즉 list section에서는 "missing으로 표시됐는데 데이터가 있는" 방향만 거부합니다.

### contracts schema가 직접 강제하지 **않는** 것

- `hourly` empty → `HOURLY` missing (반대 방향은 강제하지 않음)
- `daily` empty → `DAILY` missing
- `alerts` empty → `ALERTS` missing
- `sources`와 `sections`/`missingSections`의 상호 일치

따라서 contracts schema만으로는 "`HOURLY`가 missing이 아닌데 `hourly`가 empty인" payload를 **거부하지
않습니다.**

### PR #23 assembler가 추가로 강제하는 것

- **selected** selection은 `hourly`가 최소 한 건이어야 함(assembler-local `nonEmptyHourlyForecasts`).
- selected-empty 입력은 overview 생성 전에 **synchronous `ZodError`**로 거부됩니다.
- selected 성공 output은 `HOURLY`가 missing이 **아닙니다.**
- **no-selection** output은 `hourly []`이고 `HOURLY`가 missing입니다(정상).
- selected source일 때만 KMA `HOURLY` `SourceMetadata` **한 건**이 생성됩니다.

따라서:

- **selected**: hourly가 (최소 한 건으로) 채워지므로 HOURLY는 missing이 **아니고**, 나머지 placeholder
  다섯 section이 missing입니다.
- **no selection**: hourly도 비므로 HOURLY까지 포함해 여섯 section 모두 missing입니다.

이 두 규칙(contracts의 단방향 list invariant + assembler의 nonempty guard) 덕분에, assembler가 만든
output에서는 `HOURLY` presence와 selected/no-selection 상태가 정확히 일치하며 항상 contract invariant를
통과합니다.

### selected-empty 방어

- public `KmaHourlyFallbackSelection` selected arm의 `result.hourly`는 nonempty tuple이 아니라 일반
  `readonly HourlyForecast[]`입니다. 따라서 **직접 구성된** empty selected input(`hourly: []`)이
  TypeScript 타입상 허용됩니다.
- 정상적인 PR #22 selector는 empty 성공 result를 **usable로 선택하지 않으므로** 이런 selected-empty를
  만들지 않습니다. 그러나 이 assembler는 **public boundary**이므로 selector의 정상 동작만 신뢰하지
  않습니다.
- assembler-local `nonEmptyHourlyForecasts`(= `hourlyForecast.array().min(1)`) schema가 selected
  `hourly`를 검증하여 empty를 **synchronous `ZodError`**로 거부합니다. 이때 overview object도, source
  metadata도 만들지 않고, input을 mutate하지 않으며, logging하지 않습니다.
- 이 방어는 **contracts 변경이나 PR #22 selector/public type 변경 없이** 공개 assembler 경계에서만
  이뤄집니다.
- 한편 **no-selection**의 empty `hourly`는 오류가 아니라 정상입니다. 그 경우 `HOURLY`가 missing으로
  표기되므로 contracts invariant와 모순되지 않습니다.

## SourceMetadata field mapping

선택된 source의 `SourceMetadata`는 다음과 같이 구성됩니다.

| SourceMetadata field | 값 | 출처 |
| --- | --- | --- |
| `sourceId` | caller `source.sourceId` | **caller 제공** |
| `provider` | `'KMA'` | **assembler 고정** |
| `sections` | `['HOURLY']` | **assembler 고정** |
| `issuedAt` | caller `source.issuedAt` (nullable) | **caller 제공** |
| `observedAt` | `null` | **assembler 고정** |
| `fetchedAt` | caller `source.fetchedAt` | **caller 제공** |
| `retrievalMode` | caller `source.retrievalMode` | **caller 제공** |

### caller-provided metadata인 이유

현재 `KmaHourlyForecastServiceResult`는 정규화된 `hourly` 배열만 담고 있고, selected request·baseDate·
baseTime·`issuedAt`·`fetchedAt`·retrieval mode·app-internal `sourceId`를 갖고 있지 않습니다. 따라서
assembler가 이 값을 추정하거나 임의 생성하면 잘못된 provenance를 만들게 됩니다. selected source의
provenance context는 caller가 **명시적으로** 제공합니다.

### issuedAt이 null을 허용하는 이유

현재 fallback pipeline은 발표시각을 `WeatherOverview` 조립 시점에 알 수 없습니다(request plan/base time
복원은 이 PR의 범위 밖). 그래서 caller가 `issuedAt: null`을 **명시적으로** 전달할 수 있습니다. contracts의
`SourceMetadata`도 `issuedAt`을 nullable로 정의합니다(forecast는 `issuedAt`+`observedAt: null`, 관측은
그 반대). assembler는 현재 시각을 읽거나 KMA base time을 추정해 `issuedAt`을 채우지 않습니다.

### provider / sections / observedAt를 assembler가 고정하는 이유

- `provider: 'KMA'` — 이 assembler는 KMA hourly source만 다룹니다.
- `sections: ['HOURLY']` — 이 source가 기여하는 section은 hourly뿐입니다.
- `observedAt: null` — hourly forecast는 관측 데이터가 아니므로 관측 시각이 없습니다.

이 세 값은 이 pipeline에서 구조적으로 참이므로 assembler가 고정합니다.

## contract parsing

조립한 object는 반환 전 반드시 다음으로 검증합니다.

```ts
return weatherOverview.parse(overview);
```

- `safeParse` 후 임의 error union을 만들거나, broad `try`/`catch`로 감싸거나, error를 wrapping하거나,
  logging하거나, fallback/default timestamp를 생성하거나, invalid metadata를 `UNKNOWN`으로 직접
  교체하는 custom logic을 넣지 않습니다.
- contracts schema가 수행하는 정상적인 forward-compatible enum parsing(예: 알 수 없는 문자열 →
  `UNKNOWN`/`OTHER`)은 그대로 따릅니다.

### synchronous validation error

두 단계 검증이 각각 **동기 Zod validation error**로 전파됩니다.

- **selected arm의 nonempty precondition** — selected `hourly`가 empty면 overview 조립 **전에**
  assembler-local `nonEmptyHourlyForecasts.parse`가 던집니다(selected hourly element contract도 이때
  함께 검증). 정상 selected에서는 여기서 통과합니다.
- **최종 `weatherOverview.parse`** — 다음은 모두 최종 parse에서 전파됩니다.
  - malformed `location` (예: 비-IANA `timezone`, 범위 밖 `latitude`)
  - malformed timestamp (`issuedAt`/`fetchedAt`)
  - empty `sourceId`
  - `WeatherOverview` 전체 contract와 `missingSections` invariant 위반

어느 단계든 partial output을 반환하지 않고, input을 mutate하지 않으며, logging하지 않습니다. no-selection
branch에서는 검증할 source가 없고 selected nonempty guard도 적용되지 않으므로(empty `hourly`는 정상),
`weatherOverview.parse`만 수행합니다(location은 여전히 검증됨).

## input mutation 없음 / output allocation 정책

assembler는 output owner이므로 output array/object를 **새로** 조립합니다. 다음을 mutate하지 않습니다.

- input·location·selection·execution trace·selected result·selected result의 hourly·source input

selected arm에서 `hourly`는 `nonEmptyHourlyForecasts.parse(selection.result.hourly)`가 readonly service
result 배열로부터 **새 배열**을 만들어 냅니다(값·순서 보존). 따라서 이미 output.hourly 배열 reference는
input의 배열과 다르며, 최종 `weatherOverview.parse`가 nested object/array를 다시 새로 생성하므로 호출마다
output이 fresh합니다.

다음 reference identity는 **계약이 아닙니다**(값과 순서만 보장).

- location exact identity
- hourly array exact identity
- hourly item exact identity
- source metadata exact identity

## purity / side effects

- synchronous pure function입니다. `Promise`를 반환하지 않고 `async`가 아닙니다.
- network·Provider·service call·selector call·fallback execution이 없습니다.
- clock read(`Date.now`/`new Date`)·environment read(`process.env`)·`AbortSignal`·timer/listener가
  없습니다.
- logging·cache·singleton·global mutable state·broad catch가 없습니다.
- caller의 `location`·`selection`·(선택 시) `source`만 **읽습니다.**

## selector와 assembler의 책임 차이

| | Selector — PR #22 | Assembler — PR #23 |
| --- | --- | --- |
| 입력 | `KmaHourlyFallbackServiceResult` execution trace | precomputed selection + `WeatherLocation` + selected source context |
| 질문 | 어느 hourly result(primary/previous/none)를 쓸 것인가? | 그 선택으로 hourly-only `WeatherOverview`를 어떻게 조립할 것인가? |
| 출력 | PRIMARY / PREVIOUS / none selection | hourly-only partial `WeatherOverview` |
| 시점 | 실행 이후 | selection 이후 |

- PR #22 selector는 caller가 **먼저** 호출합니다. 이 assembler는 전달받은 selection을 **다시 계산하지
  않습니다** — eligibility를 재검사하지 않고, error 종류를 보지 않으며, PRIMARY/PREVIOUS 정책을 다시
  판단하지 않습니다(`selection.result.hourly`만 사용).

## LOCATION branch는 범위 밖

이 assembler는 `KmaLocationHourlyFallbackResult`의 `LOCATION`/`UNSUPPORTED_LOCATION` branch를 **직접
처리하지 않습니다.** 후속 application service가 먼저 location branch를 narrow하고, 성공적으로 grid로
변환된 뒤 반환된 successful trace를 selector로 변환한 다음, 이 assembler를 호출합니다.

## current/daily/AQ/alerts는 범위 밖

이 PR은 hourly section만 조립합니다. `current`·`daily`·`airQuality.current`·`airQuality.daily`·
`alerts`는 fixed placeholder(null/[])로 두고 `missingSections`에 표기할 뿐, 실제 데이터를 만들지
않습니다. current weather·daily forecast·air quality·alerts 정규화와 조립은 후속 PR입니다.

## no composition/route/cache

이 assembler는 어떤 production composition root에도 조립되지 않았고, `/weather` route·startup·HTTP
status/envelope mapping·cache/stale-data와도 무관합니다. contracts를 변경하지 않으며, 신규 dependency를
추가하지 않습니다.

## 다음 application-service 계획

이 assembler는 순수 조립 building block입니다. 후속 application service가 다음을 담당합니다.

1. `KmaLocationHourlyFallbackResult`의 LOCATION branch narrow.
2. successful trace에 PR #22 selector 적용.
3. selected source metadata context(provenance) 결정/wiring.
4. 이 PR #23 assembler 호출.
5. selection과 overview를 함께 application result로 반환.
6. production composition·`/weather` route·cache/stale-data·authenticated KMA E2E.

이번 PR에서 이 후속 service는 구현하지 않습니다.

## 변경 이력

```text
v1 / PR #23 / 2026-07
- PR #22 selection → hourly-only WeatherOverview assembly
- selected SourceMetadata assembly (KMA / HOURLY / observedAt null, caller-provided provenance)
- no-selection HOURLY missing
- no provenance inference (issuedAt null 명시 허용)
- weatherOverview.parse 동기 검증, input mutation 없음, output fresh
- no production wiring (composition/route/cache 제외)

v1 보완 / PR #23 / 2026-07 (same PR)
- selected arm nonempty runtime validation 추가 (assembler-local nonEmptyHourlyForecasts)
- contracts list invariant의 단방향 성격 명시 (empty→missing은 contracts가 강제하지 않음)
- selected-empty regression tests 추가 (PRIMARY/PREVIOUS 각각 synchronous ZodError)
```
