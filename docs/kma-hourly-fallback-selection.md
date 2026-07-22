# KMA hourly fallback result selection

이 문서는 PR #22에서 추가한 **순수·결정론적 selection policy** 한 개
(`selectKmaHourlyFallbackResult`)의 책임과 경계를 기록합니다. 이 함수는 PR #19 fallback service가
반환하는 **execution trace**(primary + optional previous)를 입력으로 받아, 후속
`WeatherOverview`/`SourceMetadata` 조립 단계가 실제 데이터 source로 사용할 수 있는 hourly result가
무엇인지(primary / previous / none)를 결정합니다.

## 목적

- PR #19 execution trace는 **무엇이 실행됐는지**(primary만, 또는 primary 이후 previous까지)와 **왜
  시도했는지**(eligibility `fallbackReason`)만 설명합니다. 실제 사용할 result를 고르지 않습니다.
- 이 selector는 execution trace가 답하지 않는 세 가지를 답합니다.
  1. primary와 previous 중 어느 것이 **usable**한 hourly data source인가?
  2. previous(fallback) result가 실제 최종 source로 **채택**됐는가?
  3. 둘 다 usable하지 않은 **선택 없음** 상태인가?
- 이 selector가 `fallbackAttempted`와 `fallbackUsed`의 구분을 **소유**합니다(아래 참조).

이번 PR은 selection만 구현합니다. Provider 호출·fallback 실행·retry·composition wiring·location facade
변경·`WeatherOverview`/`SourceMetadata` 조립·API response contract·`/weather` route·HTTP status
mapping·cache/stale-data·current/daily weather·실제 ServiceKey live call은 **포함하지 않습니다**(아래
"범위 밖" 참조).

## 구현 위치

- [kma-hourly-fallback-selection.ts](../apps/api/src/services/kma-hourly-fallback-selection.ts) — selector
- [kma-hourly-fallback-selection.test.ts](../apps/api/src/services/kma-hourly-fallback-selection.test.ts) — 테스트

이 위치(`apps/api/src/services`)에 두는 이유:

- application-service result(`KmaHourlyForecastServiceResult`/`KmaHourlyFallbackServiceResult`)를
  선택하는 **application-layer 정책**입니다.
- Provider boundary가 아니며, `weather-core` 순수 domain 계산도 아닙니다(application service result에
  의존하므로 `weather-core`에 두지 않습니다).

허용 import는 services 내부의 두 result **타입**뿐입니다.

```ts
import type { KmaHourlyForecastServiceResult } from './kma-hourly-forecast';
import type { KmaHourlyFallbackServiceResult } from './kma-hourly-fallback';
```

Provider 구현·composition·weather-core·contracts runtime schema·Hono·zod·`fetch`·`process.env`·
`Date`·`AbortController`·신규 package는 import하지 않습니다.

## 공개 API

```ts
export type KmaHourlyFallbackSelectionSource = 'PRIMARY' | 'PREVIOUS';

export type KmaHourlyFallbackSelection =
  | {
      readonly selected: true;
      readonly source: 'PRIMARY';
      readonly fallbackUsed: false;
      readonly result: Extract<KmaHourlyForecastServiceResult, { readonly ok: true }>;
      readonly execution: KmaHourlyFallbackServiceResult;
    }
  | {
      readonly selected: true;
      readonly source: 'PREVIOUS';
      readonly fallbackUsed: true;
      readonly result: Extract<KmaHourlyForecastServiceResult, { readonly ok: true }>;
      readonly execution: KmaHourlyFallbackServiceResult;
    }
  | {
      readonly selected: false;
      readonly source: null;
      readonly fallbackUsed: false;
      readonly result: null;
      readonly execution: KmaHourlyFallbackServiceResult;
    };

export function selectKmaHourlyFallbackResult(
  execution: KmaHourlyFallbackServiceResult,
): KmaHourlyFallbackSelection;
```

- `KmaHourlyFallbackSelectionSource`는 공개 export하며, selected result의 source(`'PRIMARY'` 또는
  `'PREVIOUS'`)를 나타냅니다. no-selection branch의 `source`는 `null`입니다.
- selection union의 selected branch `result` type은 `KmaHourlyForecastServiceResult`의 success branch
  (`{ ok: true }`)로 narrow됩니다 — 소비자는 재검사 없이 `hourly`에 접근할 수 있습니다(usable 정의상
  nonempty).

### selection union의 `source`

- selected primary → `'PRIMARY'`
- selected previous → `'PREVIOUS'`
- no selection → `null`

## exact result keys

세 branch 모두 own key는 정확히 동일합니다. `Object.keys` 정렬 결과는 다음과 같습니다.

```text
execution
fallbackUsed
result
selected
source
```

다음 field는 **어느 branch에도 추가하지 않습니다**(중복 top-level field 금지).

`fallbackAttempted`, `fallbackReason`, `primary`, `previous`, `selectedResult`, `selectedSource`,
`final`, `finalResult`, `usable`, `reason`, `error`, `stage`, `status`, `stale`, `provider`, `request`,
`metadata`, `sourceMetadata`, `attemptCount`.

`fallbackAttempted`·`fallbackReason`·`primary`·`previous`는 이미 `execution` 안에 존재하므로 wrapper
top-level에 중복하지 않습니다.

## usable result 정의

`KmaHourlyForecastServiceResult`가 다음 **두 조건을 모두** 만족할 때만 usable입니다.

1. `result.ok === true`
2. `result.hourly.length > 0`

다음은 모두 **unusable**입니다.

- success + empty hourly(`{ ok: true, hourly: [] }`)
- PROVIDER-stage error (`ABORTED`/`TIMEOUT`/`NETWORK_ERROR`/`HTTP_ERROR`/`KMA_UPSTREAM_ERROR`
  — `resultCode` `'03'` 포함 어떤 값이든 — 등 모든 provider error)
- NORMALIZATION-stage error
- 그 외 모든 error result

이 함수는 **error 종류 간 우선순위를 정하지 않습니다.** `resultCode`·provider error kind·normalization
issue를 검사하지 않고, 오직 `ok`·`hourly.length`·`fallbackAttempted`만 봅니다.

### successful empty는 unusable

`totalCount === 0` 같은 상황에서 나온 empty success(`{ ok: true, hourly: [] }`)는 성공 result이지만
**데이터가 없으므로 usable하지 않습니다.** primary가 empty success이고 previous가 nonempty success면
previous가 선택됩니다.

## 선택 우선순위 (deterministic)

1. `primary`가 usable이면 `primary`를 선택합니다(`source: 'PRIMARY'`, `fallbackUsed: false`).
2. 그렇지 않고, trace가 fallback을 시도했으며(`fallbackAttempted: true`) `previous`가 usable이면
   `previous`를 선택합니다(`source: 'PREVIOUS'`, `fallbackUsed: true`).
3. 그 외에는 선택하지 않습니다(`selected: false`, `source: null`, `result: null`,
   `fallbackUsed: false`).

정리:

| primary | previous | 결과 |
| --- | --- | --- |
| usable | usable | primary (`fallbackUsed: false`) |
| usable | error | primary (`fallbackUsed: false`) |
| usable | empty | primary (`fallbackUsed: false`) |
| unusable | usable | previous (`fallbackUsed: true`) |
| unusable | empty/error | none |
| unusable | (no fallback) | none |

## primary precedence

fallback execution trace에 usable한 previous가 존재하더라도 **primary가 usable하면 primary가
우선**입니다. 현재 production classifier는 usable primary에 previous를 시도하지 않지만:

- custom classifier
- test collaborator
- future policy
- 직접 구성한 structurally-valid execution trace

에서도 selector가 안정적으로 동작해야 하므로, precedence를 production wiring 가정이 아니라 selector
자체에서 고정합니다. primary usable이면 `previous`는 무시되지만 `execution` 안에 그대로 보존됩니다.

## previous selection

primary가 unusable이고 trace가 fallback을 시도했으며 previous가 usable(nonempty success)일 때만
previous가 선택됩니다. 이때 `source`는 `'PREVIOUS'`, `fallbackUsed`는 `true`, `result`는
`execution.previous`의 exact reference입니다. Selection은 eligibility reason을 다시 검사하지 않으므로,
primary가 `03`이든 empty든 다른 error든 관계없이 usable previous가 있으면 선택합니다.

## no-selection

다음 경우 선택이 없습니다.

- fallback 없이 primary가 unusable
- fallback 시도했지만 primary·previous 둘 다 unusable

`selected: false`, `source: null`, `fallbackUsed: false`, `result: null`이며 `execution`은 그대로
보존됩니다.

## `fallbackAttempted`와 `fallbackUsed`의 차이

이 selector는 두 개념을 **명확히 구분**합니다.

### fallbackAttempted (PR #19 trace 소유)

- previous hourly service가 **호출됐는가**.
- previous의 success 여부·데이터 유무와 무관합니다.
- PR #19 execution trace가 소유하는 필드입니다.

### fallbackUsed (이 selector가 계산)

- previous의 **usable hourly data가 최종 selection으로 채택됐는가**.
- previous 요청이 실행됐다는 사실만으로 true가 되지 **않습니다**.

예:

| 상황 | fallbackAttempted | fallbackUsed |
| --- | --- | --- |
| previous HTTP 503 | true | false |
| previous empty success | true | false |
| previous nonempty success (채택) | true | true |
| primary usable + previous nonempty | true | **false** (primary 우선) |
| no fallback | false | false |

`fallbackUsed`는 오직 다음일 때만 true입니다.

- `source === 'PREVIOUS'`
- previous가 success
- previous.hourly가 nonempty
- previous가 실제 selected result

### 불변식

다음 불변식을 tests로 검증합니다.

- `fallbackUsed === true` → `selected === true`
- `fallbackUsed === true` → `source === 'PREVIOUS'`
- `source === 'PREVIOUS'` → `fallbackUsed === true`
- `source === 'PRIMARY'` → `fallbackUsed === false`
- `selected === false` → `fallbackUsed === false`
- `selected === false` → `source === null`
- `selected === false` → `result === null`

## execution exact-reference 보존

모든 branch에서:

- `execution`은 caller가 전달한 **exact reference**입니다(clone·spread·nested mutation 없음).
- primary selected면 `result === execution.primary`.
- previous selected면 `result === execution.previous`.
- no selection이면 `result === null`, `source === null`.

selection wrapper 객체만 새로 만들어집니다(fresh wrapper). 같은 execution을 여러 번 selector에 전달하면:

- wrapper reference는 매번 다릅니다.
- `execution` reference는 동일합니다.
- selected result reference는 동일합니다.
- 결과는 deep-equal입니다.

selected result의 `hourly` 배열도 원본 reference 그대로 보존됩니다(새 배열을 만들지 않음).

## selected result exact-reference 보존

selected result는 execution 안의 `primary`/`previous` service result **그 자체**입니다. selector는 그
result를 clone·sanitize·재조립하지 않습니다 — 이미 application boundary의 sanitized result이기
때문입니다.

## eligibility와 selection의 차이

| | Eligibility — PR #17 | Selection — PR #22 |
| --- | --- | --- |
| 질문 | primary 결과를 보고 previous request를 시도할 것인가? | 모든 실행 후 어느 nonempty success result를 실제 데이터 source로 쓸 것인가? |
| 입력 | primary service result 하나 | PR #19 전체 execution trace |
| 출력 | eligible / reason | primary / previous / none |
| 시점 | previous 실행 **전** | previous 실행 여부·결과가 모두 확정된 **뒤** |

Selection 함수는 PR #17 classifier(`classifyKmaHourlyFallbackEligibility`)를 **호출하지 않고**
eligibility 규칙을 다시 구현하지 않습니다. `resultCode`·Provider error kind·normalization issue를
검사하지 않습니다.

## error 종류를 ranking하지 않음

selector는 error result를 모두 동일하게 "unusable"로 취급합니다. `ABORTED`/`TIMEOUT`/`HTTP_ERROR`/
`KMA_UPSTREAM_ERROR`/normalization error 사이에 우선순위를 두지 않으며, error 종류에 따라 selection
output shape가 달라지지 않습니다(모든 unusable-primary·unusable-previous 경우가 동일한 no-selection
shape를 반환).

## LOCATION branch는 범위 밖

이 selector의 입력은 정확히 `KmaHourlyFallbackServiceResult`(primary/previous hourly trace)입니다.
`KmaLocationHourlyFallbackResult`를 **직접 받지 않습니다.**

- location result에는 `LOCATION`/`UNSUPPORTED_LOCATION` branch가 포함됩니다.
- coordinate support 판정은 location facade의 책임입니다.
- selector는 primary/previous hourly trace만 선택합니다.
- 후속 assembler가 location branch를 먼저 narrow한 뒤 selector를 사용합니다.

이번 PR은 LOCATION branch 선택·unsupported location mapping·`RangeError` mapping·location response
assembler를 구현하지 않습니다.

## pure·synchronous·no side effects

- synchronous pure function입니다. `Promise`를 반환하지 않고 `async`가 아닙니다.
- network·Provider·service call·fallback execution·classifier invocation이 없습니다.
- clock read(`Date.now`/`new Date`)·environment read(`process.env`)·logging·timer/listener·
  `AbortSignal` 검사가 없습니다.
- mutation·cache·singleton·global state·broad catch가 없습니다.
- 기존 execution을 **읽기만** 합니다.

## 첫 consumer (PR #23 assembler)와 후속 계획

이 selector의 **첫 consumer**는 PR #23 hourly `WeatherOverview` assembler
(`assembleKmaHourlyWeatherOverview`, [kma-hourly-weather-overview.md](./kma-hourly-weather-overview.md))
입니다. 그 assembler는 이 selector가 반환한 `KmaHourlyFallbackSelection`을 입력으로 받아 hourly section만
조립한 partial `WeatherOverview`를 만듭니다. 이때 두 component의 책임 경계는 다음과 같습니다.

- **selector contract는 불변**입니다 — PR #23은 이 selector의 공개 API·branch shape·exact key·reference
  보존 정책을 전혀 바꾸지 않습니다.
- assembler는 이 selector를 **호출하지 않습니다.** caller가 먼저 selector를 실행해 selection을 얻고, 그
  precomputed selection을 assembler에 전달합니다. assembler는 selection을 **재계산하지 않고**(eligibility
  재검사·error 종류·PRIMARY/PREVIOUS 정책 판단 없음) `selection.result.hourly`만 사용합니다.
- selected source의 **`SourceMetadata` provenance context**(`sourceId`/`issuedAt`/`fetchedAt`/
  `retrievalMode`)는 이 selector가 아니라 **caller가 assembler에 제공**합니다 — selector는 execution
  trace만 읽고 provenance를 만들지 않으며, assembler도 이를 추정하지 않습니다.

selector와 assembler는 모두 순수 함수로 구현 완료됐지만, 아직 어떤 production composition·facade·route에도
연결되지 않았습니다. 후속 계획:

1. `KmaLocationHourlyFallbackResult`의 `LOCATION` branch를 먼저 narrow하고, successful trace에 이 selector를
   적용한 뒤 PR #23 assembler를 호출해 selection과 overview를 함께 반환하는 **application service**.
2. selected source provenance resolver/wiring과 그 production location fallback composition.
3. `/weather` route와 HTTP status mapping.
4. cache / stale-data 정책.
5. authenticated KMA end-to-end verification.

## 변경 이력

```text
v1 / PR #22 / 2026-07
- execution trace → primary/previous/none selection
- nonempty success만 usable
- primary precedence
- fallbackUsed 의미 확정 (previous usable data가 실제 선택됐을 때만 true)
- execution/result exact-reference 보존, fresh wrapper
- pure/synchronous, no Provider/network/clock/classifier
- no composition/route/result assembly wiring

v2 / PR #23 / 2026-07 (첫 consumer 추가; selector 불변)
- PR #23 assembleKmaHourlyWeatherOverview가 이 selection의 첫 consumer(selector 공개 API·계약 불변)
- assembler는 selector를 호출하지 않고 precomputed selection을 소비(selection 재계산 없음)
- selected source의 SourceMetadata provenance context는 caller가 assembler에 제공(selector 무관)
- production integration(location narrow + selector + assembler application service)은 후속
```
