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

허용 import는 세 building block의 factory/type과, issuance identity 파생을 위한 두 type-only import 뿐입니다.

- `./kma-fallback-request-plan` — `KmaFallbackRequestPlanFactory`, `KmaFallbackRequestPlanFactoryInput`
- `./kma-hourly-forecast` — `KmaHourlyForecastService`, `KmaHourlyForecastServiceOptions`,
  `KmaHourlyForecastServiceResult`
- `./kma-hourly-fallback-eligibility` — `classifyKmaHourlyFallbackEligibility`,
  `KmaHourlyFallbackEligibility`, `KmaHourlyFallbackReason`
- `../providers/kma` — `KmaForecastRequest` (type-only, sanitized issuance identity 파생용)
- `./kma-forecast-issuance-identity` — `KmaForecastIssuanceIdentity` (type-only)

Provider 구현·composition·scheduled facade·location facade·Hono·zod·contracts runtime·weather-core
runtime·`process`/env·network/date library는 import하지 않습니다.

## 공개 API

```ts
export type KmaHourlyFallbackEligibilityClassifier = (
  result: KmaHourlyForecastServiceResult,
) => KmaHourlyFallbackEligibility;

export type KmaHourlyFallbackServiceInput = KmaFallbackRequestPlanFactoryInput;

export type KmaHourlyFallbackServiceOptions = KmaHourlyForecastServiceOptions;

export interface KmaForecastIssuanceIdentity {
  readonly product: KmaForecastProduct;
  readonly baseDate: string;
  readonly baseTime: string;
}

export type KmaHourlyFallbackServiceResult =
  | {
      readonly fallbackAttempted: false;
      readonly primaryIssuance: KmaForecastIssuanceIdentity;
      readonly primary: KmaHourlyForecastServiceResult;
    }
  | {
      readonly fallbackAttempted: true;
      readonly fallbackReason: KmaHourlyFallbackReason;
      readonly primaryIssuance: KmaForecastIssuanceIdentity;
      readonly primary: KmaHourlyForecastServiceResult;
      readonly previousIssuance: KmaForecastIssuanceIdentity;
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

### sanitized issuance identity (PR #25)

execution trace는 더 이상 result만 담지 않습니다. **실제** request plan에서 파생한 sanitized
`KmaForecastIssuanceIdentity`를 함께 보존합니다. 이 identity는 정확히 세 필드만 가집니다.

- `product`
- `baseDate`
- `baseTime`

포함하지 **않습니다**: `nx`/`ny`, request object, request plan, ServiceKey, URL, query, raw response
body, `resultMsg`, 그리고 `issuedAt`/`fetchedAt`/`sourceId`/`retrievalMode` 같은 provenance 필드
(그것들은 PR #26의 몫입니다).

- `primaryIssuance`는 **모든** branch에 존재하며 `plan.primary`에서 파생합니다.
- `previousIssuance`는 **fallback-attempted branch에만** 존재하며 `plan.previous`에서 파생합니다. previous
  hourly-service 호출이 발생하고 결과 union으로 정상 resolve된 branch에서만 노출하므로, 호출되지 않은
  previous attempt(planned-but-not-invoked previous request)의 identity는 trace에 절대 새어 나가지
  않습니다. 이는 HTTP 요청 전송 여부와는 별개의 application execution 정보입니다.
  - no-fallback branch에는 previous 호출 자체가 없으므로 identity도 없습니다.
  - pre-aborted signal은 네트워크 요청 없이 `ABORTED` result와 identity를 함께 만들 수 있습니다.
  - previous 호출이 throw하거나 Promise가 reject되면 result union으로 resolve되지 않아 execution trace
    자체가 반환되지 않고, 따라서 `previousIssuance`를 담은 결과도 없습니다.
- `PRIMARY`/`PREVIOUS` 구분은 이 identity가 아니라 이후 selection 단계(PR #22)가 표현합니다.

identity는 이미 만들어진 plan에서 한 번만 파생하므로, 이 service는 clock을 다시 읽거나 candidate
selector·request-plan factory를 추가로 호출하지 않습니다.

### result discriminated union

실행 trace이며 최종 API 선택 결과가 아닙니다. 두 branch 중 정확히 하나입니다.

#### no-fallback branch

```ts
{
  fallbackAttempted: false,
  primaryIssuance,
  primary,
}
```

own key는 정확히 `fallbackAttempted`, `primary`, `primaryIssuance`입니다. 의미:

- plan은 생성됨
- primary service는 실행됨
- classifier는 ineligible을 반환함
- previous service는 호출되지 않음

`previous`·`previousIssuance`·`fallbackReason` key는 없습니다. previous hourly-service 호출 자체가
발생하지 않았으므로 `previousIssuance`도 반드시 부재합니다.

#### fallback-attempted branch

```ts
{
  fallbackAttempted: true,
  fallbackReason,
  primaryIssuance,
  primary,
  previousIssuance,
  previous,
}
```

own key는 정확히 `fallbackAttempted`, `fallbackReason`, `primary`, `primaryIssuance`, `previous`,
`previousIssuance`입니다. 의미:

- primary service 실행 완료
- classifier가 eligible을 반환
- previous service가 정확히 한 번 호출되어 result를 반환
- `previousIssuance`는 previous attempt가 실제로 실행됐기 때문에 존재하며, previous 결과가 success·empty·
  Provider·Normalization·`ABORTED` 무엇이든 항상 존재합니다.

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
`maxAttempts`, `retryable`, `delayMilliseconds`, `primaryRequest`, `previousRequest`, `plan`, `nx`,
`ny`, `grid`, `coordinates`, `eligibility`, `classifierResult`.

`primaryIssuance`/`previousIssuance`는 위 금지 목록에서 제외됩니다 — full request/plan/grid는 아니고
sanitized identity(`product`/`baseDate`/`baseTime`)만 담기 때문입니다.

## execution order

Eligible 경로의 정확한 순서:

```text
1. PLAN              requestPlanFactory.createFallbackRequestPlan(input)
   → primaryIssuance = plan.primary의 product/baseDate/baseTime (fresh object)
2. PRIMARY_SERVICE   hourlyService.fetchHourlyForecast(plan.primary, options)
3. CLASSIFY_PRIMARY  eligibilityClassifier(primary)
4. PREVIOUS_SERVICE  hourlyService.fetchHourlyForecast(plan.previous, options)
   → previousIssuance = plan.previous의 product/baseDate/baseTime (previous attempt 후에만)
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
- `primaryIssuance`/`previousIssuance`는 매 호출마다 **fresh object**로 파생하며, plan request의 exact
  reference가 아닙니다(`primaryIssuance !== plan.primary`, `previousIssuance !== plan.previous`, 그리고
  둘은 서로 다른 객체). 값은 해당 request의 `product`/`baseDate`/`baseTime`과 정확히 같고 `nx`/`ny`는 복사하지
  않습니다. explicit field assignment만 사용하므로(spread 없음) frozen plan/request에서도 안전하게 동작하며
  입력을 mutate하지 않습니다.

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
result는 `fallbackAttempted: true`이고 `previous`는 PROVIDER/`ABORTED` service result이며, previous
invocation이 실제로 발생했으므로 `previousIssuance`도 존재합니다. 다시 강조하면 `fallbackAttempted: true`는
previous service invocation을 의미하며, 실제 HTTP transport 시작을 의미하지 않습니다.

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
- sanitized issuance identity 파생은 **새로운 failure path를 만들지 않습니다.** plan factory·primary/previous
  service·classifier가 throw/reject하면 기존과 동일하게 같은 error reference로 전파하며, issuance가 포함된
  partial trace를 반환하지 않습니다.
- primary/previous 결과를 병합하지 않고, 최종 source를 선택하지 않으며, `WeatherOverview`/`SourceMetadata`를
  조립하지 않습니다.
- `createKmaHourlyFallbackService(...)` 호출 자체는 side-effect-free입니다. construction 시 collaborator
  호출·environment 접근·network·timer/listener·logging이 없습니다. returned service의 own key는
  `fetchHourlyForecastWithFallback` 하나뿐이며, 반복 construction은 독립적인 service object와 method
  reference를 생성합니다. 반환 wrapper는 매 호출 fresh object이고, global mutable state·cache·result
  singleton·retry counter가 없습니다.

## PR #20~#21 갱신: production consumers

이 service는 PR #19에서 **어느 production composition에도 연결되지 않은** 상태였으나, **PR #20에서 신규
grid fallback composition**(`createKmaHourlyFallbackCompositionFromEnv`,
[kma-hourly-fallback-composition.md](./kma-hourly-fallback-composition.md))이 이 service를 소비합니다.
정확한 현재 상태:

- PR #20 grid fallback composition이 `createKmaHourlyFallbackService`를 fixed PR #16 candidate selector와
  PR #17 classifier가 주입된 그래프로 조립해 소비합니다.
- **이 service 자체의 공개 API·실행 계약·result union은 불변**입니다(아래 계약 그대로).
- 기존 scheduled/location single-request composition에는 **연결되지 않습니다**(그 두 root는 불변).
- **PR #21 location fallback facade/composition**도 이 PR #20 grid fallback root를 통해 이 service를
  소비합니다 — 좌표 → grid adapter일 뿐 실행 정책을 바꾸지 않습니다(아래 "PR #21 location fallback
  facade가 새로운 consumer" 참조).
- `apps/api/src/index.ts`·서버 startup·`/weather` route에는 **아직 연결되지 않았습니다.**
- primary/previous **final source selection** policy는 **PR #22 selector가 구현 완료**했으나(아래 "PR #22
  selector가 execution trace의 새로운 consumer" 참조), 이 selector를 소비해 `WeatherOverview`/
  `SourceMetadata`를 조립하는 result assembler·result assembly·cache는 여전히 **미구현**입니다(후속 PR).

## 보장하지 않는 것 (service 계약 범위 밖)

- **no production composition wiring in this service.** 이 service 자체는 environment-based factory·
  system clock·provider-from-env wiring을 수행하지 않습니다 — 그 조립은 PR #20 composition의 몫이며,
  service는 주입된 collaborator만 소비합니다.
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
- **이 service는 기존 동작을 바꾸지 않음.** Provider·parser·normalizer·기존 hourly service·classifier·
  request-plan factory·scheduled/location facade·composition은 변경되지 않았습니다. 기존 scheduled/location
  single-request facade는 여전히 호출당 KMA request 최대 1회이고, 이 service를 소비하는 PR #20/#21 fallback
  root만 eligible primary에 한해 Provider를 최대 2회 호출합니다.

## PR #21 location fallback facade가 새로운 consumer

PR #20 grid fallback composition에 이어, PR #21은 이 fallback service를 소비하는 두 번째 지점을
추가했습니다 — 위·경도 → grid 변환을 앞단에 두는 **location fallback facade**
([kma-location-hourly-fallback.md](./kma-location-hourly-fallback.md)).

- 이 fallback service의 공개 method(`fetchHourlyForecastWithFallback`)·result union·primary → classifier →
  optional previous 실행 계약(최대 2회 Provider 호출)은 **불변**입니다.
- location facade는 `{ product, latitude, longitude }`를 `{ product, nx, ny }`로 바꾸는 **input adapter일
  뿐**이며, 이 service를 요청당 정확히 한 번 호출합니다. base-time·eligibility·retry 정책을 다시 구현하지
  않습니다.
- 이 facade는 selection을 수행하지 않으며, 이 service는 계속 execution trace만 반환합니다. primary/previous
  **최종 선택**(final source selection)과 `fallbackUsed` 계산은 **PR #22 selector가 담당(구현 완료)**하며,
  이 selector를 소비해 `WeatherOverview`/`SourceMetadata`를 조립하는 result assembler는 여전히 **미구현**입니다.

## PR #22 selector가 execution trace의 새로운 consumer

PR #22는 이 fallback service가 반환하는 execution trace를 소비하는 **순수 selection policy**
(`selectKmaHourlyFallbackResult`,
[kma-hourly-fallback-selection.md](./kma-hourly-fallback-selection.md))를 추가했습니다.

- **이 fallback service 자체의 contract는 불변**입니다 — 공개 method(`fetchHourlyForecastWithFallback`)·
  result union·primary → classifier → optional previous 실행 계약(최대 2회 Provider 호출)이 그대로입니다.
- **fallback service는 여전히 selection을 수행하지 않습니다** — 계속 execution trace만 반환하며, 최종
  source 선택·merge·`fallbackUsed` 계산을 하지 않습니다.
- selector는 **별도 후처리 단계**에서 이 trace를 읽어 primary/previous/none을 고릅니다. 실행 이후 순수
  함수로 동작하므로, 실행 계층(execution)과 선택 계층(selection)이 분리됩니다.
- `fallbackAttempted`(previous **호출** 발생 여부, 이 trace가 소유)와 `fallbackUsed`(previous의 usable
  data가 실제 **선택**됐는지, selector가 계산)는 서로 다른 개념입니다 — previous가 실행됐어도 empty/error면
  `fallbackUsed`는 false입니다.
- selector는 이 service를 호출하지 않고 trace를 인자로 받기만 합니다. route·`WeatherOverview`/
  `SourceMetadata` assembler·cache는 selector에도 여전히 **없습니다**(후속 PR).

## 다음 production wiring PR 권장 범위

PR #20 grid fallback composition·PR #21 location fallback facade/composition·PR #22 selection policy는 모두
구현 완료 상태이므로, 남은 후속 범위는 selector를 소비하는 assembler와 그 production wiring입니다.

1. PR #22 selector(`selectKmaHourlyFallbackResult`)를 소비하는 `WeatherOverview`/`SourceMetadata` result
   assembler.
2. location fallback result에서 `LOCATION` branch를 먼저 처리하고 successful execution trace에 selector를
   적용하는 application-service assembler.
3. assembler를 PR #21 location fallback production pipeline에 조립하는 별도 composition.
4. `/weather` route, query validation과 HTTP mapping.
5. cache/stale-data.
6. authenticated KMA end-to-end verification.

## PR #25: sanitized issuance identity 보존

PR #25는 execution trace에 실제 request plan에서 파생한 sanitized `KmaForecastIssuanceIdentity`
(`primaryIssuance`, fallback 시 `previousIssuance`)를 additive sibling으로 추가했습니다. 위
"sanitized issuance identity (PR #25)" 참조.

- **정확한 현재 상태**: fallback service가 actual plan에서 sanitized primary/previous issuance identity를
  보존합니다(full request/plan/grid는 노출하지 않음). no-fallback은 `primaryIssuance`만, fallback-attempted는
  `primaryIssuance` + `previousIssuance`를 담습니다. **production metadata resolver는 아직 없습니다.**
- **아직 구현하지 않음 (PR #26 범위)**: KST `issuedAt` converter, fixed product `sourceId`, `retrievalMode`
  `LIVE`, `fetchedAt` resolver clock, 그리고 이 identity를 읽는 production selected-source metadata resolver.
- **selector 계약 불변**: PR #22 selector는 identity를 선택·복제하지 않고 execution reference만 보존합니다.
- **resolver seam(PR #24)**: injected resolver는 `selection.execution.primaryIssuance`(그리고
  `fallbackAttempted` narrow 후 `previousIssuance`)로 actual issuance에 접근할 수 있습니다. 실제 resolver
  로직은 이 PR에서 구현하지 않습니다.
- **future `/weather` route 보안 원칙**: `{ ok, selection, overview }` 전체를 그대로 mobile에 serialize하지
  않습니다. `selection.execution`은 internal application/observability 값이며, mobile-facing response는 별도
  mapper를 통해 `overview`만 반환해야 합니다. raw `baseDate`/`baseTime`은 execution trace 내부에만 존재하고,
  mobile에는 후속 resolver가 만든 ISO `issuedAt`만 노출합니다. 이 PR은 route mapper를 구현하지 않습니다.

## 변경 이력

```text
v1 / PR #19 / 2026-07
- request plan → primary execution → eligibility → optional previous execution 조합
- primary 최대 1회, previous 최대 1회
- PR #17의 두 eligible 신호(KMA_NO_DATA, EMPTY_HOURLY)만 fallback
- same options/AbortSignal pass-through
- previous 재분류 및 third attempt 제외
- production composition/route/response assembly 제외

v2 / PR #20 / 2026-07
- production grid fallback composition(createKmaHourlyFallbackCompositionFromEnv)에서 소비
- fixed PR #16 candidate selector / PR #17 classifier graph로 조립
- service 자체 공개 API·실행 계약·result union은 불변
- route/location fallback/final result selection은 여전히 제외

v3 / PR #21 / 2026-07
- PR #21 location fallback facade가 이 service를 소비(input adapter, 요청당 1회 호출)
- service 자체 공개 API·실행 계약·result union은 불변
- final result selection·route/startup은 여전히 제외

v4 / PR #22 / 2026-07 (execution trace consumer selector 추가; 이 service는 불변)
- PR #22 selectKmaHourlyFallbackResult가 이 service의 execution trace를 순수 함수로 소비
- fallbackAttempted(previous 호출)와 fallbackUsed(previous usable data 선택) 구분 확정
- 이 service는 여전히 selection을 수행하지 않고 execution trace만 반환(공개 API·실행 계약 불변)
- selector는 별도 후처리 단계이며 route/assembler/cache는 여전히 제외

v5 / PR #25 / 2026-07 (sanitized issuance identity를 execution trace에 보존)
- KmaForecastIssuanceIdentity(product/baseDate/baseTime) public type 추가
- no-fallback trace에 primaryIssuance, fallback-attempted trace에 primaryIssuance + previousIssuance
- previousIssuance는 previous hourly-service 호출이 발생하고 결과 union으로 resolve된 branch에만 존재(호출되지 않은 previous attempt는 노출 안 함)
- actual plan request에서 fresh object로 파생; clock 재읽기·plan/selector 재호출 없음; nx/ny 미포함
- primary/previous result reference·error/Promise/Abort 계약 불변; selector/assembler/PR #24 runtime 불변
- production metadata resolver·issuedAt/fetchedAt/sourceId/retrievalMode는 PR #26 범위
```
