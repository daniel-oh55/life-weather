# KMA hourly fallback composition root

이 문서는 PR #20에서 추가한 **grid 기반 production fallback composition** root의 책임과 경계를
기록합니다. 이 root는 앞선 PR #16~#19에서 완성한 fallback building block을 실제 서버 환경용으로 조립하는
**명시적으로 호출 가능한 composition function**을 제공합니다. import만으로 자동 조립되는 singleton은 만들지
않습니다.

이 root는 기존 두 single-request root(PR #11 grid scheduled root, PR #13 location scheduled root)를
**교체하지 않고 그 옆에 병렬로** 추가됩니다. 세 root의 전체 관계는
[kma-production-composition.md](./kma-production-composition.md)를 참고하세요.

## 목적

- PR #16 candidate selector, PR #17 eligibility classifier, PR #18 request-plan factory, PR #19
  fallback orchestration service를 environment·production clock·KMA Provider와 함께 **한 번의 함수
  호출**로 조립합니다.
- production candidate 정책(PR #16 selector)과 eligibility 정책(PR #17 classifier)을 이 root가
  **명시적으로 선택하고 주입**합니다 — factory/service의 default에 암묵적으로 의존하지 않습니다.
- 조립을 **호출 시점**에 명시적으로 수행하므로, 모듈 import만으로 `process.env`를 읽거나 Provider를
  생성하지 않습니다. 테스트와 `/health` import가 KMA 설정에 종속되지 않습니다.

"production composition"은 native fetch·system clock·environment default를 조립할 수 있다는 뜻이며,
현재 앱 startup이나 route에서 자동 실행된다는 뜻이 **아닙니다**.

## 구현 위치

- [kma-hourly-fallback.ts](../apps/api/src/composition/kma-hourly-fallback.ts) — fallback composition root
- [kma-hourly-fallback.test.ts](../apps/api/src/composition/kma-hourly-fallback.test.ts) — 테스트
- [index.ts](../apps/api/src/composition/index.ts) — composition barrel (신규 export 추가)
- [system-clock.ts](../apps/api/src/composition/system-clock.ts) — production system clock adapter (재사용)

## 공개 API

```ts
export type KmaHourlyFallbackCompositionDependencies =
  KmaScheduledHourlyCompositionDependencies;

export type CreateKmaHourlyFallbackCompositionResult =
  | { readonly ok: true; readonly service: KmaHourlyFallbackService }
  | { readonly ok: false; readonly error: KmaProviderConfigError };

export function createKmaHourlyFallbackCompositionFromEnv(
  env?: NodeJS.ProcessEnv,
  dependencies?: KmaHourlyFallbackCompositionDependencies,
): CreateKmaHourlyFallbackCompositionResult;
```

### dependencies alias

`KmaHourlyFallbackCompositionDependencies`는 기존
`KmaScheduledHourlyCompositionDependencies`의 **직접 alias**입니다 — 새 dependency interface를 복제하지
않습니다. 현재 shape는 다음과 같습니다.

```ts
{
  fetchImpl?: typeof fetch;
  clock?: KmaForecastRequestClock;
}
```

이번 PR에서는 selector override·classifier override·timeout override·maxResponseBytes override·retry
option·fallback option·feature flag·environment mode·safety margin·logging option·cache option을
**추가하지 않습니다.** PR #16 selector와 PR #17 classifier는 고정된 production 선택이므로 dependency
option으로 노출하지 않고 composition 본문에서 주입합니다.

### result union

- **success**: `{ ok: true, service }` — own key는 정확히 `ok`, `service` 두 개. `service`의 own key는
  `fetchHourlyForecastWithFallback` 하나. internal collaborator(provider·requestPlanFactory·
  hourlyService·classifier·selector·clock·env·fetchImpl·serviceKey·config·URL·dependencies)는 노출하지
  않습니다. `service`라는 key 이름을 정확히 사용하며 `facade`/`fallbackService`/`pipeline`/`client`/
  `handler`/`runtime` 등으로 바꾸지 않습니다.
- **config failure**: `{ ok: false, error }` — own key는 정확히 `ok`, `error` 두 개. 실패 result에는
  `service` key를 넣지 않습니다.

## production graph

정확한 조립 순서:

```text
environment
  → createKmaForecastProviderFromEnv (PR #5)        → KmaForecastProvider
  (config 실패 시 즉시 { ok: false, error } 반환)
  → createKmaHourlyForecastService  (PR #7)         → KmaHourlyForecastService

injected clock 또는 createKmaSystemClock
  + selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay (PR #16)   // production selector choice
  → createKmaFallbackRequestPlanFactory (PR #18)    → KmaFallbackRequestPlanFactory

request-plan factory + hourly service + classifyKmaHourlyFallbackEligibility (PR #17)
  → createKmaHourlyFallbackService (PR #19)         → live KmaHourlyFallbackService
```

- **Provider-from-env**: composition은 Provider를 `createKmaForecastProviderFromEnv(env, …)`로 실제로
  생성합니다. `env`가 제공되면 동일 reference를 그대로 전달합니다(clone·spread·mutation 없음,
  `KMA_SERVICE_KEY` 직접 읽기 없음, trim/decode/encode 없음). `env`가 생략되면 Provider factory가 호출
  시점에 `process.env`를 사용합니다.
- **injected/native fetch**: `dependencies.fetchImpl`이 제공되면 `{ fetchImpl: dependencies.fetchImpl }`
  로 Provider factory에 전달하고, 미제공이면 정확히 `undefined`를 전달합니다(`{ fetchImpl: undefined }`를
  넘기지 않음). composition은 `fetch`를 직접 호출하지 않고 URL도 만들지 않습니다. production default는
  Provider factory의 native `globalThis.fetch`입니다.
- **injected/system clock**: `dependencies.clock`이 제공되면 동일 reference를 request-plan factory에
  그대로 전달합니다(clone·wrapper·validation·construction 시 호출 없음). 미제공이면 `createKmaSystemClock()`
  을 사용합니다. production default는 system clock입니다.
- **explicit PR #16 selector**: request-plan factory에
  `selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay`를 명시적으로 주입합니다. availability-aware
  primary + 바로 이전 scheduled issuance previous, SHORT 3시간 간격·ULTRA 1시간 간격, PR #14 availability
  threshold(단기 10분·초단기 15분) 재사용. 이는 live readiness 보장이 아닙니다.
- **explicit PR #17 classifier**: fallback service에 `classifyKmaHourlyFallbackEligibility`를 명시적으로
  주입합니다. exact upstream resultCode `03`(`KMA_NO_DATA`) 또는 empty hourly success(`EMPTY_HOURLY`)만
  eligible, 그 외 모든 결과는 ineligible. classifier 자체는 순수 함수입니다.
- **PR #18 request-plan factory / PR #7 hourly service / PR #19 orchestration**은 각각의 public factory를
  소비만 합니다. eligibility 검사·primary/previous 실행 순서·maximum attempt·AbortSignal 전달·previous
  재분류 방지·result union·error propagation을 composition에서 재구현하지 않습니다.

## config error exact-reference pass-through

Provider configuration이 실패하면 Provider factory의 결과를 그대로 전달합니다.

```ts
if (!providerResult.ok) {
  return { ok: false, error: providerResult.error };
}
```

- 기존 `KmaProviderConfigError`의 **exact reference**를 보존합니다(clone·message 추가·raw env/key 추가·
  logging·throw 없음, 새 composition error union 없음).
- config 실패 시에는 clock read 0회·fallback graph 실행 0회·fetch 0회이며 partial service를 만들지
  않습니다.
- missing/whitespace-only 키는 `{ kind: 'CONFIG_ERROR', field: 'serviceKey', reason: 'MISSING' }`,
  leading/trailing whitespace 키는 `… reason: 'INVALID'`입니다(Provider의 기존 config 계약 그대로).

## success result `{ ok, service }`

성공 result는 정확히 두 field(`ok`, `service`)만 공개합니다. service key는 bound Provider 내부에만
유지되어 composition result로 새어 나가지 않습니다. 매 composition 호출은 fresh dependency graph(새
Provider·새 request-plan factory·새 hourly service·새 fallback service)를 만듭니다 — module-level
singleton이나 graph 간 cache/state가 없습니다. 동일 env/dependencies로 두 번 composition해도 success
wrapper·service·service method reference가 모두 다릅니다.

## construction side-effect 경계

**모듈 import 시**: env read·`process.env` read·Provider 생성·clock 생성 요구·clock read·fetch·
timer/listener·logging·singleton이 **없습니다.**

**composition function 호출 시 허용**: Provider config 읽기/검증, Provider 객체 생성, clock adapter
선택/생성, factory/service 객체 생성, closure wiring.

**composition function 호출 시 금지**: clock read·`Date.now`·request plan 생성·primary service 실행·
previous service 실행·classifier 호출·network fetch·`AbortController` 생성·timer/listener 등록·route
등록·logging.

실제 clock read와 network는 반환된 `service.fetchHourlyForecastWithFallback(...)` 호출 시점까지
지연됩니다.

## runtime 실행 계약

반환된 service는 PR #19 계약을 그대로 유지합니다
([kma-hourly-fallback.md](./kma-hourly-fallback.md)).

- **Primary ineligible**: clock 1회·plan factory 1회·primary service 1회·classifier 1회·Provider/fetch
  최대 1회·previous service 0회 → `{ fallbackAttempted: false, primary }`.
- **Primary eligible**: clock 1회·plan factory 1회·primary service 1회·classifier primary에 1회·previous
  service 1회·Provider/fetch 최대 2회·previous 재분류 없음·third attempt 없음 →
  `{ fallbackAttempted: true, fallbackReason, primary, previous }`.
- fallback service method 1회당 request-plan factory가 clock을 정확히 1회 읽습니다. primary와 previous는
  동일 clock reference에서 생성된 한 candidate pair를 사용합니다.
- `fallbackAttempted: true`는 previous service invocation이 **일어났다**는 의미이며, 실제 fetch 횟수나
  성공을 뜻하지 않습니다.
- **AbortSignal ownership**: composition은 `AbortController`를 만들지 않고 signal을 직접 검사하지 않으며
  listener를 등록하지 않습니다. caller의 signal은 PR #19 service를 통해 verbatim 전달되고, 실제 Provider가
  기존 ownership에 따라 pre-aborted signal에서 fetch 없이 `ABORTED`를 반환합니다.

### 오류 정책

- **composition config 단계**: config failure는 result value(`{ ok: false, error }`)로 반환합니다.
- **service execution 단계**: clock error·selector `RangeError`·Provider/service programmer throw·
  classifier throw는 기존 PR #19 Promise rejection 계약을 그대로 따릅니다.
- composition에서 금지: broad `try/catch`·error wrapping·re-message·`COMPOSITION_ERROR`/`STARTUP_ERROR`/
  `UNKNOWN`·logging·partial execution result·fallback용 synthetic error.

## parallel composition root인 이유

기존 grid scheduled root(`createKmaScheduledHourlyCompositionFromEnv`)와 location scheduled root
(`createKmaLocationScheduledHourlyCompositionFromEnv`)는 `KmaScheduledHourlyForecastFacade`와
`{ ok, facade }` result를 노출하고 호출당 Provider **최대 1회**를 유지합니다. PR #19 fallback service는
공개 method(`fetchHourlyForecastWithFallback`)와 result union(primary + optional previous execution
trace, 최대 2회 Provider 호출)이 서로 다릅니다. 따라서 기존 result에 field를 추가하거나 기존 shape를
바꾸는 대신 **새 parallel root를 추가**하여 기존 public contract와 production 동작을 보존합니다.

## 아직 하지 않는 것 (이 PR의 범위 밖)

- **location fallback** — 이 root는 grid(`product`/`nx`/`ny`) 입력만 받습니다. 위·경도 → grid 변환을
  신규 fallback service 앞단에 연결하는 별도 location fallback facade/composition은 후속 PR(PR #21)입니다.
- **apps/api startup/route 미연결** — 이 root는 `apps/api/src/index.ts`·서버 startup·`/weather` route에
  연결되지 않았습니다. 기존 scheduled facade·기존 location facade와도 연결하지 않습니다.
- **WeatherOverview / SourceMetadata / final primary·previous selection** — 없음. fallback service는
  execution trace만 반환하며 최종 source 선택·merge·`fallbackUsed`/stale field를 만들지 않습니다.
- **cache / persistence / telemetry / metrics / logging / feature flag** — 없음.
- **provider timeout/body-size override, arbitrary retry, third attempt, delay/backoff** — 없음.
- **실제 인증 ServiceKey live test** — 없음. 자동 테스트는 fake key·in-memory fetch·deterministic
  clock만 사용하며 external network를 호출하지 않습니다.
- 기존 scheduled/location composition graph·result·runtime은 **불변**입니다.

## 테스트 (real components, no external network)

- 테스트는 **실제** production component(Provider-from-env, PR #18 request-plan factory, PR #16 selector,
  PR #7 hourly service, PR #6 normalizer, PR #17 classifier, PR #19 orchestration)를 조립합니다 — 이들을
  mock하지 않습니다.
- 가짜로 주입하는 것: fake KMA service key, in-memory `fetchImpl`, deterministic clock. 실제 ServiceKey·
  external network·mock collaborator·fake timer·`process.env` mutation·Date global monkey patch·`as any`는
  사용하지 않습니다.
- 커버리지: config errors, construction/laziness, fresh graphs, primary non-empty success,
  EMPTY_HOURLY E2E, KMA_NO_DATA E2E, HTTP/Network/Normalization ineligible primary, previous
  failure/no-data termination, SHORT `05:10`/`05:09:59.999` candidate pair, ULTRA `06:45` candidate pair,
  pre-aborted signal, clock errors, exact keys/leakage, logging cleanup. shuffle seed 1·2·17 통과.

## 변경 이력

```text
v1 / PR #20 / 2026-07
- environment + production clock + Provider + PR #16~#19 fallback graph 조립
- fixed production candidate selector(PR #16)와 eligibility classifier(PR #17) 명시적 주입
- config failure exact-reference pass-through, success result { ok, service }
- 기존 scheduled/location roots 불변 (parallel root 추가)
- route/location fallback/result assembly 제외
```
