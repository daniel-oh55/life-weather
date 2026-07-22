# KMA fallback request-plan factory (primary/previous request pair)

이 문서는 PR #18에서 추가한 **application-level fallback request-plan factory**
(`createKmaFallbackRequestPlanFactory`)의 책임과 경계를 기록합니다. 이 factory는 새로운 KMA 데이터
규칙을 도입하지 않습니다 — **하나의 절대 기준시각**에서 PR #16 candidate selector가 고른
`primary`/`previous` 후보를, 호출자가 이미 계산한 격자 좌표(nx/ny)·product와 결합해 **두 개의 완성된**
`KmaForecastRequest`로 **조립**할 뿐입니다.

기존 PR #9 single request factory([kma-forecast-request-factory.md](./kma-forecast-request-factory.md))는
**한 개의** base time으로 **한 개의** request를 만듭니다. 이 factory는 그와 **별개의** building block으로,
PR #16 candidate pair로 **두 개의** request를 만듭니다. 기존 factory의 공개 API·default·production wiring은
변경하지 않으며, 이 factory가 기존 factory를 (한 번도, 두 번도) 호출하지 않습니다.

구현 위치:

- [kma-fallback-request-plan.ts](../apps/api/src/services/kma-fallback-request-plan.ts) — request-plan factory
- [kma-fallback-request-plan 테스트](../apps/api/src/services/kma-fallback-request-plan.test.ts)

## 목적

- **주입된 clock**의 현재시각(절대 epoch milliseconds)을 **정확히 한 번** 읽고, PR #16
  candidate selector(default: `selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay`)를
  **정확히 한 번** 호출해 `{ primary, previous }` 후보 pair를 얻은 뒤, 호출자가 공급한
  `product`/`nx`/`ny`와 결합해 완성된 `KmaForecastRequest` **두 개**(`primary`, `previous`)를 만듭니다.
- 후속 orchestration(PR #19)이 primary 실행 → PR #17 eligibility 검사 → 필요 시 previous 최대 1회 실행에
  사용할 **재료**를 만드는 것이 목적입니다. 이 factory 자체는 어떤 실행도 하지 않습니다.

## 현재 pipeline에서의 위치

```text
injected clock
  → reference epoch milliseconds                              // 정확히 한 번 읽음
  → candidate selector   // default: PR #16 selector → { primary, previous } base-time candidates
  → 각 candidate를 caller-supplied product / nx / ny 와 결합
  → { primary: KmaForecastRequest, previous: KmaForecastRequest }
```

이 factory는 요청 **계획 조립까지만** 담당합니다. Provider 호출, hourly service 호출, PR #17 classifier
호출, primary 결과 검사, previous 실행, retry, fallback orchestration, `AbortSignal` 정책, HTTP route,
cache는 이 factory에 포함하지 않습니다. availability threshold(단기 10분·초단기 15분) 및 issuance
schedule **계산 자체**도 factory가 하지 않습니다 — 주입된 selector(default: PR #16 selector)가 소유하며,
factory는 그 결과를 조립할 뿐입니다.

## 공개 API

```ts
export type KmaForecastBaseTimeCandidatesSelector = (
  input: SelectKmaForecastBaseTimeCandidatesAfterAvailabilityDelayInput,
) => KmaForecastBaseTimeCandidates;

export type KmaFallbackRequestPlanFactoryInput = KmaForecastRequestFactoryInput;

export interface KmaFallbackRequestPlan {
  readonly primary: KmaForecastRequest;
  readonly previous: KmaForecastRequest;
}

export interface KmaFallbackRequestPlanFactory {
  createFallbackRequestPlan(
    input: KmaFallbackRequestPlanFactoryInput,
  ): KmaFallbackRequestPlan;
}

export function createKmaFallbackRequestPlanFactory(
  clock: KmaForecastRequestClock,
  candidatesSelector?: KmaForecastBaseTimeCandidatesSelector, // default: PR #16 selector
): KmaFallbackRequestPlanFactory;
```

- `KmaForecastBaseTimeCandidatesSelector`는 `{ product, referenceEpochMilliseconds }`를 받아
  `{ primary, previous }` 후보 pair를 반환하는 함수로, PR #16 순수 selector
  (`selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay`) 호출 signature와 정확히 일치하므로
  adapter 없이 주입할 수 있습니다.
- **input alias.** `KmaFallbackRequestPlanFactoryInput`은 기존 PR #9
  `KmaForecastRequestFactoryInput`(`{ product, nx, ny }`)의 **alias**입니다 — 같은 caller-supplied shape를
  공유하므로 필드를 재정의하지 않고 두 factory의 입력 shape가 어긋나지 않게 합니다.
- `KmaForecastRequestClock`은 기존 PR #9 clock type을 그대로 재사용합니다.

## PR #16 selector 기본값

- 이 factory의 이름·목적 자체가 **availability-aware fallback plan**이므로, `candidatesSelector`를
  생략하면 default로 PR #16 `selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay`가 쓰입니다.
  이는 **availability-aware primary**와 바로 **이전 scheduled issuance인 previous**를 생성합니다.
- 이는 기존 PR #9 single request factory의 default(schedule-only PR #8 selector)와 **다릅니다.** 이
  factory는 기존 factory의 default selector를 **변경하지 않습니다.**
- 이 default는 **아직 production composition에 연결하지 않습니다.** default가 존재해도 현재 production
  동작은 바뀌지 않습니다. 호출자는 test나 다른 정책을 위해 custom candidates selector를 주입할 수
  있습니다.
- 실제 declaration은 optional parameter가 아니라 **default parameter**로 작성합니다:

  ```ts
  createKmaFallbackRequestPlanFactory(
    clock,
    candidatesSelector = selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay,
  )
  ```

## single absolute reference — clock 1회 / selector 1회

- 두 request(`primary`, `previous`)는 반드시 **같은 절대 기준시각**에서 선택된 **한** candidate pair를
  사용합니다.
- `createFallbackRequestPlan()` 한 번 호출에서 clock을 **정확히 한 번**(argument 없이) 읽고, 그 epoch를
  **그대로** selector에 전달하며, selector를 **정확히 한 번** 호출합니다.
- factory **생성 시**에는 clock·selector를 **각각 0회** 호출합니다.

### 왜 기존 single request factory를 두 번 호출하지 않는가

primary와 previous를 각각 만들기 위해 PR #9 single request factory를 **두 번 호출하지 않습니다.** 만약
그렇게 하면:

- clock이 **두 번** 읽힐 수 있고,
- availability threshold 경계를 사이에 두고 primary/previous가 **서로 다른 기준시각**에 고정될 수 있으며,
- selector가 불필요하게 여러 번 호출되고,
- PR #16 pair invariant(한 기준시각에서 나온 연속한 두 issuance)를 잃을 수 있습니다.

대신 이 factory는 clock을 한 번 읽고 PR #16 selector를 한 번 호출해, 그 pair의 두 후보를 각각의 request로
조립합니다. 중복되는 5필드 request 조립은 작고 명확하므로, 대규모 helper 추상화보다 **책임 분리**를
우선해 기존 factory 내부를 이번 PR에서 공통 helper로 리팩터링하지 않습니다.

## 결과 shape

`KmaFallbackRequestPlan`의 own key는 정확히 `primary`, `previous` 두 개입니다. 각 request는 기존
`KmaForecastRequest`이며 정확히 다섯 필드만 포함합니다.

**primary request**

```ts
{
  product,   // = input.product
  baseDate,  // = candidates.primary.baseDate
  baseTime,  // = candidates.primary.baseTime
  nx,        // = input.nx
  ny,        // = input.ny
}
```

**previous request**

```ts
{
  product,   // = input.product
  baseDate,  // = candidates.previous.baseDate
  baseTime,  // = candidates.previous.baseTime
  nx,        // = input.nx
  ny,        // = input.ny
}
```

- 두 request의 `product`/`nx`/`ny`는 동일하고(caller input 그대로), `baseDate`/`baseTime`만 후보에 따라
  다릅니다.
- plan·request에는 다음을 넣지 않습니다: `referenceEpochMilliseconds`, candidate object, `eligible`,
  `reason`, `fallbackUsed`, `selected`, `attempt`, `maxAttempts`, `retryable`, `stale`, source metadata,
  raw input object, error/result union, 그 밖의 임의 property.

## product / nx / ny explicit pass-through

- 필드는 명시적으로 작성하며 **input 전체나 candidate를 object spread로 반환하지 않습니다.** runtime에서
  추가 property가 들어와도 결과에 유출되지 않고, request shape가 고정되며, secret-shaped extra property가
  노출되지 않습니다.
- selector 결과의 `baseDate`/`baseTime` **primitive만** 새 request에 복사하고, candidate nested object
  reference는 결과에 노출하지 않습니다.
- factory는 valid·typed 격자 좌표가 공급된다고 가정하고, nx/ny를 변환·반올림·문자열화·기본값
  적용·swap·clamp·coercion하지 않습니다. 일반 값, 경계 성격의 typed integer, runtime fractional/negative,
  `NaN`, `Infinity` 모두 **그대로** request에 들어가며 factory는 이 때문에 throw하지 않습니다.

## request validation은 Provider 책임

- 이 factory는 request runtime validation을 수행하지 않습니다(`validateKmaForecastRequest`를 호출하지
  않음). **runtime trust-boundary validation은 Provider가 계속 소유합니다**
  ([kma-http-provider.md](./kma-http-provider.md)). 위 좌표 pass-through 테스트는 해당 좌표가 **유효하다고
  주장하지 않으며**, factory가 기존 책임 경계를 유지하며 pass-through한다는 것만 검증합니다. Provider가
  실제 호출될 경우 기존 validation이 처리합니다.

## deterministic collaborator 기준 순수 조립

- deterministic한 clock·selector가 주어지면 결과도 deterministic합니다.
- clock과 selector 외의 ambient source를 사용하지 않습니다: `Date.now()`·`new Date()`·`Intl`·
  `process.env`·`fetch`·`AbortController`·logging·cache·global mutable state를 사용하지 않습니다.
- 생성은 side-effect-free입니다: clock·selector 호출, 환경 접근, network, timer/listener가 없습니다.

## fresh output / 불변성

- 매 호출마다 **새로운 plan wrapper**와 **새로운 primary/previous request** 객체를 반환합니다.
- 한 plan 안에서 `primary`와 `previous`는 서로 **다른 reference**입니다(previous를 primary와 같은 object로
  재사용하지 않음).
- input·candidate를 읽기만 하고 **mutate하지 않으며**, frozen input·deep-frozen candidate에서도
  동작합니다. candidate/caller input에 property를 추가하지 않습니다.
- 첫 plan을 runtime cast로 mutate해도 이후 호출 결과에 영향이 없습니다(shared singleton·cached request
  없음). 같은 clock value·같은 input에 대해 deep-equal 결과를 반환하되, 반환 reference는 서로 다릅니다.

## 오류 전파 (clock/selector 오류 그대로)

이 factory는 새로운 result union도, 새로운 오류 type도 만들지 않습니다.

- **clock 오류**: 주입된 clock이 throw하면 **동일한 error reference**가 그대로 전파되고, selector는 **0회**
  호출되며, partial plan을 반환하지 않습니다.
- **selector 오류**: PR #16 selector의 `RangeError`(invalid epoch, unsupported product, 지원 연도 범위 밖)나
  custom selector 오류를 catch/wrap/re-message/logging 없이 **그대로** 전파합니다. 이때 clock은 1회,
  selector는 1회 호출된 뒤 throw하며, partial plan·fallback/default candidate를 반환하지 않습니다.
- `{ ok: false }` result, null, partial plan, previous를 primary로 대체하는 동작은 없습니다.

## PR #17 classifier 호출 없음 — 실행 순서

이 factory는 PR #17 fallback-eligibility classifier를 import하거나 호출하지 않습니다
(`classifyKmaHourlyFallbackEligibility`·`KmaHourlyFallbackEligibility`·`KmaHourlyFallbackReason`·
`KmaHourlyForecastServiceResult` 미사용). 이유와 실행 순서:

- request plan은 network/service 호출 **이전**에 만들어집니다(clock → PR #16 candidate selector →
  primary/previous request).
- PR #17 classifier의 입력은 `KmaHourlyForecastServiceResult`이므로, **primary request 실행 → primary
  service result → classifier** 순서 **이후에만** 호출할 수 있습니다.
- 따라서 이 factory에서 classifier를 직접 호출하거나 eligibility 값을 plan에 포함하면 실행 전 단계와 실행
  후 단계가 섞입니다. 이 factory는 eligibility를 **계산하지도 저장하지도 않습니다.**
- request plan에 `previous` request가 있다고 해서 previous를 **무조건 실행하는 것은 아닙니다.** previous
  request는 classifier가 **eligible**로 판정한 경우에만 후속 orchestration(PR #19)에서 최대 1회 사용됩니다.

정확한 단계 분리:

- PR #16: primary/previous base-time 후보 계산
- PR #17: primary 결과의 fallback eligibility 분류
- PR #18: primary/previous 완성 request plan 생성 (이 문서)
- PR #19: primary 실행 → eligibility 검사 → 필요한 경우 previous 최대 1회 실행

## Provider / service / fallback 실행 없음 · production 미연결

- factory는 Provider를 생성·호출하지 않고, hourly service를 호출하지 않으며, 실제 fallback을 실행하지
  않습니다. `createFallbackRequestPlan`은 Promise가 아니라 **동기 결과**를 반환합니다.
- **PR #19가 이 plan을 실제로 실행하는 consumer**입니다
  ([kma-hourly-fallback.md](./kma-hourly-fallback.md)): `createKmaHourlyFallbackService`가
  `createFallbackRequestPlan`을 method당 1회 호출해 얻은 plan에서 `primary`를 hourly service로 먼저
  소비하고, 그 결과가 PR #17 classifier로 eligible일 때만 `previous`를 hourly service로 소비합니다(primary
  → previous 순서, previous는 조건부). 즉 plan에 `previous` request가 있다는 사실이 previous의 **무조건
  실행**을 의미하지는 않습니다. 다만 그 orchestration이 PR #19에 생겼어도 **이 factory 자체는 여전히**
  network·Provider·hourly service·PR #17 classifier를 호출하지 않습니다 — 조립만 합니다.
- 이 factory는 **PR #20 grid fallback composition의 실제 consumer가 됐습니다**
  ([kma-hourly-fallback-composition.md](./kma-hourly-fallback-composition.md)):
  `createKmaHourlyFallbackCompositionFromEnv`가 이 factory를 **injected/system clock**과 **명시적으로
  주입한 PR #16 candidate selector**(`selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay`)로 생성해
  PR #19 fallback service에 넣습니다. 즉 이 fallback root의 실행당 실제 Provider request는 primary
  ineligible이면 **최대 1회**, eligible이면 **최대 2회**입니다. 반면 기존 grid/location scheduled
  composition은 계속 PR #9 single request factory를 사용하며 facade 호출당 실제 Provider request **최대
  1회**로 **불변**입니다([kma-production-composition.md](./kma-production-composition.md)). 이 factory
  **자체의 공개 API·clock 1회/selector 1회 계약은 변경되지 않았습니다.** location(위·경도) fallback과
  `/weather` route에는 아직 연결되지 않았습니다.

## 실제 key·외부 네트워크 테스트 없음

- 실제 `KMA_SERVICE_KEY`를 사용하지 않았습니다.
- 자동 테스트는 실제 네트워크를 호출하지 않고, 실제 default selector 또는 작은 test-local recording/
  throwing selector와 in-memory clock callback만 사용합니다. Provider를 생성·mock하지 않고, fake
  timer·`Date.now` mock을 사용하지 않습니다. expected 값은 production selector/factory로 생성하지 않고
  literal로 고정합니다. shuffle seed 1·2·17에서 통과합니다.

## orchestration 진행 상태 (PR #19 완료 / 이후 후속)

1. ~~PR #18 plan + PR #17 classifier + hourly service orchestration~~ — **PR #19에서 완료**
   (`createKmaHourlyFallbackService`, [kma-hourly-fallback.md](./kma-hourly-fallback.md))
2. ~~primary 실행 1회~~ — **PR #19에서 완료**
3. ~~classifier가 eligible인 경우 previous 최대 1회 실행(same `AbortSignal` pass-through 포함)~~ —
   **PR #19에서 완료**
4. ~~production composition wiring~~ — **PR #20에서 완료** (grid fallback composition,
   [kma-hourly-fallback-composition.md](./kma-hourly-fallback-composition.md))
5. location(위·경도) fallback facade/composition
6. `WeatherOverview`/`SourceMetadata` 조립 및 final result selection
7. `/weather` API route와 HTTP status mapping
8. cache / stale-data 정책

## 변경 이력

```text
v1 / PR #18 / 2026-07
- 한 clock reference에서 primary/previous request plan 생성
- PR #16 availability-aware candidate selector 기본 적용
- clock 1회 / selector 1회 계약(생성 시 각각 0회)
- 기존 PR #9 single request factory 불변(두 번 호출하지 않음)
- PR #17 eligibility 및 실제 fallback 실행은 제외, production 미연결

v2 / PR #20 / 2026-07
- PR #20 grid fallback composition의 실제 consumer가 됨
- production root가 injected/system clock과 명시적 PR #16 selector로 이 factory를 생성
- 이 factory 자체의 공개 API·clock 1회/selector 1회 계약은 불변
- location fallback·/weather route에는 미연결
```
