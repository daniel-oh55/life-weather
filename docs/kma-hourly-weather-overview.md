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

`input.selection.selected === true`일 때 다음 의미로 조립합니다.

```ts
{
  location: input.location,
  current: null,
  hourly: [...input.selection.result.hourly],
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

`WeatherOverview`의 `superRefine` invariant는 "데이터 유무"와 "missing 여부"가 서로 모순되지 않도록
강제합니다.

- `current: null` ↔ `CURRENT` missing (biconditional)
- `airQuality.current: null` ↔ `AIR_QUALITY_CURRENT` missing (biconditional)
- `hourly` nonempty → `HOURLY` **미포함**
- `daily`/`airQuality.daily`/`alerts`가 비어 있으면 각각 `DAILY`/`AIR_QUALITY_FORECAST`/`ALERTS`를
  missing으로 표기

따라서:

- **selected**: hourly가 채워지므로 HOURLY는 missing이 **아니고**, 나머지 placeholder 다섯 section이
  missing입니다.
- **no selection**: hourly도 비므로 HOURLY까지 포함해 여섯 section 모두 missing입니다.

이 규칙 덕분에 partial overview가 항상 contract invariant를 통과합니다.

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

다음은 모두 `weatherOverview.parse`에서 **동기 Zod validation error**로 전파됩니다.

- malformed `location` (예: 비-IANA `timezone`, 범위 밖 `latitude`)
- malformed timestamp (`issuedAt`/`fetchedAt`)
- empty `sourceId`
- `WeatherOverview` invariant 위반

이때 partial output을 반환하지 않고, input을 mutate하지 않으며, logging하지 않습니다. no-selection
branch에서는 검증할 source가 없으므로 source validation을 수행하지 않습니다(location은 여전히 검증됨).

## input mutation 없음 / output allocation 정책

assembler는 output owner이므로 output array/object를 **새로** 조립합니다. 다음을 mutate하지 않습니다.

- input·location·selection·execution trace·selected result·selected result의 hourly·source input

`hourly`는 readonly service result 배열에서 `WeatherOverview` 배열로 옮기기 위해 **새 배열**을
만듭니다(`[...selection.result.hourly]`). 따라서 output.hourly 배열 reference는 input의 배열과 다릅니다.
또한 `weatherOverview.parse`가 nested object/array를 새로 생성하므로, 호출마다 output이 fresh합니다.

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
```
