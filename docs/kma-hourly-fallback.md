# KMA hourly fallback orchestration service

이 문서는 PR #19에서 추가한 **application-service orchestration** 한 개
(`createKmaHourlyFallbackService`)의 책임과 경계를 기록합니다. 이 service는 세 기존 building block을
application 계층에서 조합하여, 최신 발표시각으로 한 번 조회하고 그 결과가 no-data 신호이면 **직전 발표시각으로
정확히 한 번** fallback을 실행합니다. 이번 PR이 **최초로 실제 previous issuance service 호출**을 수행합니다.

## 목적

- PR #18 request-plan factory, 기존 PR #7 hourly service, PR #17 eligibility classifier를 조합하여
  primary 한 번 실행 → eligible이면 previous 최대 한 번 실행의 at-most-two-attempt 실행을 구성합니다.
- 여기서 "fallback"은 같은 transport 요청을 재시도하는 일반 retry가 **아닙니다.** 정확히 다음을 뜻합니다.
  - newest availability-aware issuance가 no-data 계열 신호(`EMPTY_HOURLY` 또는 upstream `03`)를 반환하면
  - 바로 이전 scheduled issuance를 **한 번** 조회하고
  - 그 이상 과거로 이동하지 않습니다.

이번 PR은 production composition wiring·기존 facade 교체·HTTP route·`WeatherOverview`/`SourceMetadata`
조립·최종 source/stale 표시·cache·third attempt·transport/timeout/HTTP retry·backoff·delay·다른
base-time 탐색·primary/previous 결과 병합·최종 성공 결과 선택/API status mapping을 포함하지 않습니다(아래
"보장하지 않는 것" 참조).

## 구현 위치

- [kma-hourly-fallback.ts](../apps/api/src/services/kma-hourly-fallback.ts) — orchestration service
- [kma-hourly-fallback.test.ts](../apps/api/src/services/kma-hourly-fallback.test.ts) — 테스트

이 위치(`apps/api/src/services`)에 두는 이유:

- request plan과 service result를 순서대로 조합하는 **application orchestration**입니다.
- Provider boundary 자체가 아니며, `weather-core` 순수 domain 계산도 아닙니다.
- route/composition보다 아래 계층으로, 후속 production composition에서 주입 가능합니다.

허용 import는 세 building block의 factory/type 뿐입니다.

- `./kma-fallback-request-plan` — `KmaFallbackRequestPlanFactory`, `KmaFallbackRequestPlanFactoryInput`
- `./kma-hourly-forecast` — `KmaHourlyForecastService`, `KmaHourlyForecastServiceOptions`,
  `KmaHourlyForecastServiceResult`
- `./kma-hourly-fallback-eligibility` — `classifyKmaHourlyFallbackEligibility`,
  `KmaHourlyFallbackEligibility`, `KmaHourlyFallbackReason`

Provider 구현·composition·scheduled facade·location facade·Hono·zod·contracts runtime·weather-core
runtime·`process`/env·network/date library는 import하지 않습니다.

## 공개 API

```ts
export type KmaHourlyFallbackEligibilityClassifier = (
  result: KmaHourlyForecastServiceResult,
) => KmaHourlyFallbackEligibility;

export type KmaHourlyFallbackServiceInput = KmaFallbackRequestPlanFactoryInput;

export type KmaHourlyFallbackServiceOptions = KmaHourlyForecastServiceOptions;

export type KmaHourlyFallbackServiceResult =
  | {
      readonly fallbackAttempted: false;
      readonly primary: KmaHourlyForecastServiceResult;
    }
  | {
      readonly fallbackAttempted: true;
      readonly fallbackReason: KmaHourlyFallbackReason;
      readonly primary: KmaHourlyForecastServiceResult;
      readonly previous: KmaHourlyForecastServiceResult;
    };

export interface KmaHourlyFallbackService {
  fetchHourlyForecastWithFallback(
    input: KmaHourlyFallbackServiceInput,
    options?: KmaHourlyFallbackServiceOptions,
  ): Promise<KmaHourlyFallbackServiceResult>;
}

export function createKmaHourlyFallbackService(
  requestPlanFactory: KmaFallbackRequestPlanFactory,
  hourlyService: KmaHourlyForecastService,
  eligibilityClassifier?: KmaHourlyFallbackEligibilityClassifier,
): KmaHourlyFallbackService;
```

실제 함수 선언은 optional classifier 대신 default parameter를 사용하며, 기본값은 PR #17
`classifyKmaHourlyFallbackEligibility`입니다. 모든 fallback 정책은 injected classifier에 위임하며,
orchestrator 자체는 `result.ok`/`resultCode`/`hourly.length`/provider error kind/normalization issues를
직접 검사하지 않습니다.

### input / options alias

- `KmaHourlyFallbackServiceInput`은 PR #18 `KmaFallbackRequestPlanFactoryInput`의 alias입니다
  (`product`/`nx`/`ny`). 필드를 재정의하지 않아 두 shape가 어긋나지 않습니다.
- `KmaHourlyFallbackServiceOptions`는 PR #7 `KmaHourlyForecastServiceOptions`의 alias입니다
  (`{ signal? }`). 새 options shape를 만들지 않습니다.

### result discriminated union

실행 trace이며 최종 API 선택 결과가 아닙니다. 두 branch 중 정확히 하나입니다.

#### no-fallback branch

```ts
{
  fallbackAttempted: false,
  primary,
}
```

own key는 정확히 `fallbackAttempted`, `primary`입니다. 의미:

- plan은 생성됨
- primary service는 실행됨
- classifier는 ineligible을 반환함
- previous service는 호출되지 않음

`previous`·`fallbackReason` key는 없습니다.

#### fallback-attempted branch

```ts
{
  fallbackAttempted: true,
  fallbackReason,
  primary,
  previous,
}
```

own key는 정확히 `fallbackAttempted`, `fallbackReason`, `primary`, `previous`입니다. 의미:

- primary service 실행 완료
- classifier가 eligible을 반환
- previous service가 정확히 한 번 호출되어 result를 반환

### `fallbackAttempted`의 정확한 의미

`fallbackAttempted: true`는 **previous hourly-service invocation이 발생했다**는 의미입니다.

- 실제 HTTP transport가 시작되었다는 의미가 **아닙니다.**
- network success를 의미하지 **않습니다.**
- previous 결과가 성공했다는 의미도 **아닙니다.**

### `fallbackReason`

`fallbackReason`은 primary eligibility의 reason(`KMA_NO_DATA` 또는 `EMPTY_HOURLY`)을 그대로 보존합니다.
previous 결과로 이 값을 변경하지 않습니다.

### 금지 필드

result union에는 다음 key를 노출하지 않습니다.

`fallbackUsed`, `fallbackSucceeded`, `selected`, `final`, `result`, `source`, `stale`, `attemptCount`,
`maxAttempts`, `retryable`, `delayMilliseconds`, `primaryRequest`, `previousRequest`, `plan`,
`eligibility`, `classifierResult`.

## execution order

Eligible 경로의 정확한 순서:

```text
1. PLAN              requestPlanFactory.createFallbackRequestPlan(input)
2. PRIMARY_SERVICE   hourlyService.fetchHourlyForecast(plan.primary, options)
3. CLASSIFY_PRIMARY  eligibilityClassifier(primary)
4. PREVIOUS_SERVICE  hourlyService.fetchHourlyForecast(plan.previous, options)
```

Ineligible 경로는 3단계에서 종료합니다.

```text
1. PLAN
2. PRIMARY_SERVICE
3. CLASSIFY_PRIMARY   → ineligible → 종료
```

previous는 primary 결과가 eligible임이 확인된 뒤에만 호출합니다. primary/previous를 병렬로 실행하거나
(`Promise.all` 등) previous를 미리 실행하지 않습니다.

## collaborator call counts

| 시점 | plan factory | hourly service | classifier |
| --- | --- | --- | --- |
| construction | 0 | 0 | 0 |
| method 1회 — primary ineligible | 1 | 1 (primary) | 1 (primary) |
| method 1회 — primary eligible | 1 | 2 (primary, previous) | 1 (primary) |

- request-plan factory는 method call당 정확히 1회 호출합니다(plan 재생성 없음).
- primary service는 정확히 1회 실행합니다.
- classifier는 **primary 결과에만** 정확히 1회 사용합니다.
- eligible이면 previous service를 정확히 1회 실행합니다.
- **maximum two attempts** — 그 이상 request가 없습니다(no third attempt).
- **previous 결과 재분류 없음** — previous 결과는 classifier에 다시 넣지 않습니다.

## previous result reference 보존

- primary service result는 classifier에 동일 reference로 전달되고, returned result의 `primary`에도 같은
  reference를 사용합니다.
- previous service result는 returned result의 `previous`에 같은 reference를 사용합니다.
- previous 결과는 nonempty success·empty success·upstream `03`·`ABORTED`·`TIMEOUT`·HTTP error·network
  error·normalization failure 등 **무엇이든 그대로 보존**합니다. 재분류·변환·병합·success 여부 판단을 하지
  않습니다. previous가 다시 no-data여도 한 단계 fallback으로 종료합니다.

## caller input / request / options reference pass-through

- `input`은 plan factory에 동일 reference로 전달합니다(clone/spread/destructure 재조립 없음).
- `plan.primary`는 primary service에, eligible일 때 `plan.previous`는 previous service에 동일 reference로
  전달합니다(request clone/mutation 없음).
- caller `options`는 primary service에 동일 reference로 전달하고, eligible 경로에서는 **같은 options
  reference를 previous service에도** 전달합니다. options 생략 시 두 호출 모두 정확히 `undefined`이며, 새
  options object를 만들지 않습니다.

기존 hourly service result는 이미 application boundary의 sanitized result이므로 clone하거나 sanitize하지
않습니다. exact reference pass-through가 계약입니다.

## same `AbortSignal` reference

이번 orchestration은 별도 abort 정책이나 error variant를 만들지 않습니다.

- caller options를 두 service 호출에 그대로 전달하며, 같은 `AbortSignal` reference를 사용합니다.
- 새 `AbortController`를 생성하지 않고, signal wrapping·listener 등록·signal 상태 변경을 하지 않습니다.
- `options.signal.aborted`를 orchestration에서 직접 검사하지 않으며, synthetic `ABORTED` result를
  생성하지 않습니다.

### already-aborted Provider ownership

primary 호출 전에 이미 aborted이면 hourly service와 Provider가 기존 계약대로 처리합니다. production
Provider는 네트워크 요청 없이 `ABORTED`를 반환하고, 기본 classifier는 `ABORTED`를 ineligible로 분류하므로
previous 호출은 없습니다. 이번 PR은 Provider의 existing abort ownership을 유지합니다.

### abort between attempts 정책

primary가 eligible인 뒤 previous 전에 signal이 aborted이면, previous hourly service는 동일한
already-aborted signal을 받고 production Provider는 네트워크 요청 없이 `ABORTED`를 반환합니다. execution
result는 `fallbackAttempted: true`이고 `previous`는 PROVIDER/`ABORTED` service result입니다. 다시 강조하면
`fallbackAttempted: true`는 previous service invocation을 의미하며, 실제 HTTP transport 시작을 의미하지
않습니다.

## async rejection / error propagation

이 service method는 async이며 항상 Promise를 반환합니다. 새 error union을 만들지 않으며, collaborator 오류는
returned Promise rejection으로 **같은 error reference를 전파**합니다.

- **plan factory 오류** — synchronous throw이면 returned Promise가 같은 error reference로 reject되고,
  hourly service·classifier는 0회 호출됩니다.
- **primary hourly service** — synchronous throw 또는 rejected Promise면 같은 reason/reference로
  reject되고, classifier·previous는 0회 호출됩니다.
- **classifier throw** — returned Promise가 같은 error reference로 reject되고, previous는 0회 호출됩니다.
- **previous hourly service** — primary eligible까지 완료한 뒤 previous invocation에서 synchronous throw
  또는 rejected Promise면 같은 reason/reference로 reject되고, third request는 없습니다.

## no broad catch / logging / merge / final selection

- broad `try/catch`가 없고, `{ ok: false }` 새 wrapper·error wrapping·re-message·logging·partial
  execution result 반환을 하지 않습니다. collaborator programmer error를 domain result로 숨기지 않습니다.
- primary/previous 결과를 병합하지 않고, 최종 source를 선택하지 않으며, `WeatherOverview`/`SourceMetadata`를
  조립하지 않습니다.
- `createKmaHourlyFallbackService(...)` 호출 자체는 side-effect-free입니다. construction 시 collaborator
  호출·environment 접근·network·timer/listener·logging이 없습니다. returned service의 own key는
  `fetchHourlyForecastWithFallback` 하나뿐이며, 반복 construction은 독립적인 service object와 method
  reference를 생성합니다. 반환 wrapper는 매 호출 fresh object이고, global mutable state·cache·result
  singleton·retry counter가 없습니다.

## 보장하지 않는 것 (이번 PR 범위 밖)

- **no production composition wiring.** environment-based factory·system clock wiring·provider-from-env
  wiring을 하지 않습니다.
- **no route / cache.** `/weather` route·query validation·HTTP status mapping·cache·persistence·
  telemetry·metrics·logs가 없습니다.
- **no result assembly.** `WeatherOverview`·`SourceMetadata`·`fallbackUsed` API field·stale-data field가
  없습니다.
- **no extra attempt / retry / delay.** third attempt·arbitrary retry·transport/timeout/HTTP retry·
  delay/backoff·다른 base-time 탐색이 없습니다.
- **no merge / final selection.** primary/previous 결과 병합·최종 성공 결과 선택·API status mapping이
  없습니다.
- **no authenticated live KMA test.** 실제 `ServiceKey`를 사용한 end-to-end 검증은 이 PR에서 수행하지
  않았습니다.
- **production 동작 불변.** Provider·parser·normalizer·기존 hourly service·classifier·request-plan
  factory·scheduled/location facade·composition은 변경되지 않았고, production은 여전히 facade 호출당 KMA
  request 최대 1회입니다.

## 다음 production wiring PR 권장 범위

1. PR #20 production fallback composition.
2. grid/location production wiring.
3. `WeatherOverview`/`SourceMetadata` result selection.
4. `/weather` route와 HTTP mapping.
5. cache/stale-data.
6. authenticated KMA end-to-end verification.

## 변경 이력

```text
v1 / PR #19 / 2026-07
- request plan → primary execution → eligibility → optional previous execution 조합
- primary 최대 1회, previous 최대 1회
- PR #17의 두 eligible 신호(KMA_NO_DATA, EMPTY_HOURLY)만 fallback
- same options/AbortSignal pass-through
- previous 재분류 및 third attempt 제외
- production composition/route/response assembly 제외
```
