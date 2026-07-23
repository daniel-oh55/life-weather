# KMA production composition root

이 문서는 PR #11에서 추가한 **server-side production composition** 계층
(`apps/api/src/composition`)의 책임과 경계를 기록합니다. 이 계층은 앞선 PR에서 만든 KMA
component들을 실제 서버 환경에서 하나의 live `KmaScheduledHourlyForecastFacade`로 조립하는
**명시적으로 호출 가능한 composition function**을 제공합니다. import만으로 자동 조립되는 singleton은
만들지 않습니다.

구현 위치:

- [system-clock.ts](../apps/api/src/composition/system-clock.ts) — production system clock adapter
- [kma-scheduled-hourly.ts](../apps/api/src/composition/kma-scheduled-hourly.ts) — composition root
- [index.ts](../apps/api/src/composition/index.ts) — composition barrel
- [system-clock 테스트](../apps/api/src/composition/system-clock.test.ts)
- [kma-scheduled-hourly 테스트](../apps/api/src/composition/kma-scheduled-hourly.test.ts)

## 목적

- 지금까지 구현한 KMA component(PR #5 Provider-from-env, PR #7 hourly service, PR #9 request
  factory, PR #10 scheduled facade, PR #14 availability-delay selector)와 system clock adapter를, 실제
  서버 시작 시점(또는 향후 route composition 시점)에 **한 번의 함수 호출**로 조립할 수 있게 합니다.
- production base-time 정책을 이 계층이 **선택**합니다: request factory에 PR #14 availability-delay
  selector를 주입해, 모든 production 요청이 availability-threshold-aware issuance로 dating됩니다.
- 조립을 **호출 시점**에 명시적으로 수행하므로, 모듈 import만으로 `process.env`를 읽거나 Provider를
  생성하지 않습니다. 테스트와 `/health` import가 KMA 설정에 종속되지 않습니다.

## composition 계층 위치

`apps/api`의 계층은 다음과 같습니다.

```text
providers/kma   — KMA 원본 경계 + HTTP Provider (PR #4·#5·#6)
services        — request factory / hourly service / scheduled facade (PR #7·#9·#10)
composition     — production 조립 (PR #11, 이 문서)
```

composition은 `providers/kma`와 `services`의 **공개 surface만** 소비합니다. 의존 방향은
`composition → providers/kma`, `composition → services`이며, 역방향(`providers/kma → composition`,
`services → composition`, `weather-core/contracts/mobile → composition`)은 금지합니다. composition은
자기 barrel(`./index`)이 아니라 concrete file에서 내부 import합니다.

## 전체 dependency graph

```text
environment
  → createKmaForecastProviderFromEnv (PR #5)        → KmaForecastProvider
  → createKmaHourlyForecastService  (PR #7)         → KmaHourlyForecastService

system clock adapter / injected clock
  + selectLatestKmaForecastBaseTimeAfterAvailabilityDelay (PR #14)   // production selector choice
  → createKmaForecastRequestFactory (PR #9)         → KmaForecastRequestFactory

request factory + hourly service
  → createKmaScheduledHourlyForecastFacade (PR #10) → live KmaScheduledHourlyForecastFacade
```

**PR #15 갱신.** 이 composition은 request factory의 base-time selector seam에 PR #14
`selectLatestKmaForecastBaseTimeAfterAvailabilityDelay`를 **명시적으로 주입**합니다(고정된 production
선택). 즉 `system clock → request factory → PR #14 availability-delay selector` 흐름이 이 composition에서
조립됩니다. request factory **default 자체**는 여전히 PR #8 schedule-only
`selectLatestKmaForecastBaseTime`이며([kma-forecast-request-factory.md](./kma-forecast-request-factory.md)),
selector들은 모두 순수하고 clock을 직접 읽지 않습니다([kma-issue-time.md](./kma-issue-time.md),
[kma-api-availability-time.md](./kma-api-availability-time.md)). composition은 threshold 숫자(10분/15분)나
KST 계산을 복제하지 않습니다 — 그 정책은 전적으로 PR #14 selector가 소유합니다.

## production base-time 선택 (PR #14 selector)

composition이 request factory에 PR #14 selector를 주입한 결과, production 요청의 issuance는
availability threshold(단기 10분·초단기 15분, exact inclusive)가 이미 지난 최신 발표로 선택됩니다.

| product | injected clock (KST)   | selected base_time |
| ------- | ---------------------- | ------------------ |
| SHORT   | `05:00`                | `0200`             |
| SHORT   | `05:09:59.999`         | `0200`             |
| SHORT   | `05:10:00.000`         | `0500`             |
| ULTRA   | `06:30:00.000`         | `0530`             |
| ULTRA   | `06:45:00.000`         | `0630`             |

- 이 exact millisecond boundary는 **프로젝트 정책**이며 공식 SLA가 아니고, live readiness를
  보장하지 않습니다([kma-api-availability-time.md](./kma-api-availability-time.md)).
- composition은 이 정책을 request factory 생성 시 selector 주입으로 **선택**할 뿐이며, threshold 숫자·
  SHORT/ULTRA 시간표·KST 계산·rollover를 복제하지 않습니다.
- location composition은 이 grid-based composition을 재사용하므로 같은 정책을 자동으로 상속합니다
  ([kma-location-scheduled-hourly.md](./kma-location-scheduled-hourly.md)).

## 공개 API

```ts
export function createKmaSystemClock(): KmaForecastRequestClock;

export interface KmaScheduledHourlyCompositionDependencies {
  readonly fetchImpl?: typeof fetch;
  readonly clock?: KmaForecastRequestClock;
}

export type CreateKmaScheduledHourlyCompositionResult =
  | { readonly ok: true; readonly facade: KmaScheduledHourlyForecastFacade }
  | { readonly ok: false; readonly error: KmaProviderConfigError };

export function createKmaScheduledHourlyCompositionFromEnv(
  env?: NodeJS.ProcessEnv,
  dependencies?: KmaScheduledHourlyCompositionDependencies,
): CreateKmaScheduledHourlyCompositionResult;
```

- `KmaForecastRequestClock`은 PR #9의 기존 type을 재사용합니다(별도 clock interface를 중복 정의하지
  않음).
- 새로운 configuration error type도, 새로운 throw 기반 config 정책도 만들지 않습니다. config 실패는
  Provider factory의 기존 `KmaProviderConfigError` 값을 그대로 반환합니다.
- `KmaScheduledHourlyCompositionDependencies`는 **변경되지 않았습니다.** PR #14 selector는 고정된
  production 선택이므로 `baseTimeSelector`/availability mode/safety margin/feature flag 같은 dependency
  option을 추가하지 않습니다. composition 함수 이름(`createKmaScheduledHourlyCompositionFromEnv`)도 그대로
  입니다.

## system clock adapter

```ts
export function createKmaSystemClock(): KmaForecastRequestClock {
  return {
    nowEpochMilliseconds() {
      return Date.now();
    },
  };
}
```

이 adapter는 composition 계층에서 **시스템 시간을 읽는 유일한 위치**입니다. composition root 본문은
`Date.now()`를 직접 호출하지 않습니다.

clock 계약:

- `createKmaSystemClock()` 생성 시 `Date.now()` 호출 **0회** — 시간 읽기·timer·환경 read·I/O·global
  mutation·listener 없음. 객체만 생성합니다.
- `nowEpochMilliseconds()` 호출 시 `Date.now()`를 **정확히 1회**, argument 없이 호출하고 반환값을
  **그대로** 반환합니다 — 반올림·truncation·coercion·timezone 계산·offset·cache 없음.
- 매 호출마다 `Date.now()`를 **다시 읽어** 항상 현재 시각을 반영합니다(이전 값 cache 없음).
- `Date.now()`가 throw하면 **동일 error reference**가 그대로 전파됩니다(catch/wrapping 없음).
- 두 clock instance 사이에 mutable state가 없습니다.

## composition 생성 시 clock read 없음

`createKmaScheduledHourlyCompositionFromEnv()`가 default system clock을 사용하든 injected clock을
사용하든, **생성 시점에는 clock의 `nowEpochMilliseconds()`를 호출하지 않습니다.** 실제 clock read는
반환된 facade의 `fetchScheduledHourlyForecast()`가 실행되어 request factory가 호출될 때 처음
발생합니다.

## Provider-from-env 사용과 config boundary

- composition은 Provider를 `createKmaForecastProviderFromEnv(env, …)`로 **실제로 생성**합니다.
- `env` argument가 제공되면 그 object reference를 Provider factory에 **그대로** 전달합니다(clone·
  spread·mutation 없음, `KMA_SERVICE_KEY` property 직접 읽기 없음).
- `env`가 생략되면 기존 Provider factory가 **호출 시점에** `process.env`를 사용합니다. composition
  module을 import할 때는 `process.env`를 읽지 않습니다(import-time env read 없음).
- `KMA_SERVICE_KEY`의 읽기·검증(존재/형태) 책임은 계속 **Provider factory**가 소유합니다.
  composition은 환경변수 이름이나 key validation 규칙을 복제하지 않고, key를 trim/decode/encode 하지
  않으며, error/result에 key를 포함하지 않습니다.

### config error pass-through

Provider 환경설정이 실패하면 Provider factory의 결과(`{ ok: false, error: KmaProviderConfigError }`)를
composition이 그대로 전달합니다.

```ts
if (!providerResult.ok) {
  return { ok: false, error: providerResult.error };
}
```

- **동일 error object reference**를 사용합니다(clone·message 추가·raw env·service key 추가·logging·
  throw 없음).
- config 실패 시에는 clock 호출·request factory 생성·hourly service 생성·facade 생성·fetch가 **모두
  일어나지 않습니다.**
- `COMPOSITION_ERROR`/`STARTUP_ERROR`/`UNKNOWN` 같은 새 error kind를 만들지 않습니다. missing 키는
  기존 `{ kind: 'CONFIG_ERROR', field: 'serviceKey', reason: 'MISSING' }`, leading/trailing whitespace
  키는 `… reason: 'INVALID'`입니다(Provider의 기존 config 계약 그대로).

## success result `{ ok, facade }`

성공 result는 정확히 두 field(`ok`, `facade`)만 공개합니다.

- internal `provider`·`requestFactory`·`hourlyService`·`clock`·`env`·`fetchImpl`·`serviceKey`·`config`·
  `url`·`dependencies`는 **노출하지 않습니다.**
- service key는 bound Provider 내부에만 유지되어 composition result로 새어 나가지 않습니다.
- 매 composition 호출은 fresh facade graph를 만듭니다 — module-level singleton이나 global cache가
  없습니다.

## dependency injection (explicit fetch/clock)

`KmaScheduledHourlyCompositionDependencies`로 두 dependency를 주입할 수 있습니다.

- `fetchImpl?: typeof fetch` — 제공되면 Provider factory에 전달합니다. 제공되지 않으면 Provider
  factory가 `globalThis.fetch`(native fetch)를 사용합니다. composition은 직접 `fetch`를 호출하지
  않고 URL도 만들지 않습니다. 이번 PR에서는 `timeoutMs`/`maxResponseBytes` composition override를
  추가하지 않으며, Provider의 기존 timeout·body-size 기본 정책을 유지합니다.
- `clock?: KmaForecastRequestClock` — 제공되면 그 reference를 request factory에 그대로 전달합니다
  (clone·wrapper·호출·validation 없음). 생략되면 `createKmaSystemClock()`을 사용합니다.

**production default는 native fetch + system clock**입니다. 두 dependency는 주로 테스트에서
in-memory fetch와 결정론적 clock을 주입하기 위한 것입니다.

## construction side-effect 경계

`createKmaScheduledHourlyCompositionFromEnv()` 호출 시 허용되는 것: 환경 object에서 Provider 설정
읽기, Provider config validation, collaborator object 생성, closure 조립.

호출 시 **일어나지 않는** 것: `Date.now()` 실행·clock read·network fetch·Provider `fetchForecast`·
request factory `createScheduledRequest`·hourly service `fetchHourlyForecast`·facade
`fetchScheduledHourlyForecast`·timer 시작·listener 등록·logging·route 등록·global mutation.

Provider 객체 생성은 허용되지만 network I/O는 facade method가 호출될 때까지 발생하지 않습니다. 즉
**live facade를 호출할 때에만** request/fetch pipeline이 실행됩니다.

## 오류 전파 (facade 호출 단계)

composition은 성공 이후의 오류를 catch하거나 재분류하지 않습니다(broad `try/catch` 없음). 기존 계층
계약이 그대로 유지됩니다.

- clock/selector 오류(invalid epoch `RangeError`, unsupported product `RangeError`, injected clock
  throw)는 request factory 계약대로 **동일 reference**로 전파됩니다.
- Provider 오류는 기존 `PROVIDER` stage 결과(`{ ok: false, stage: 'PROVIDER', error }`)입니다.
- normalization 오류는 기존 `NORMALIZATION` stage 결과(`{ ok: false, stage: 'NORMALIZATION',
  issues }`)입니다.
- pre-aborted `AbortSignal`은 Provider의 기존 정책대로 `PROVIDER` stage `ABORTED`가 되며, 이때
  request 생성을 위해 clock은 정확히 1회 읽히고 fetch는 0회입니다.

## security boundary

- config error·facade success result·Provider failure result·normalization failure result·throw된
  `RangeError` message·`console.log`/`console.error`/`console.warn` 어디에도 service key나 secret
  marker가 나타나지 않습니다.
- composition과 system clock은 logging하지 않습니다. injected fetch 내부에서 Provider가 만든 URL을
  관찰하는 것은 정상 경로이지만(key는 그 URL 쿼리로만 round-trip), URL/key를 result·error·로그로
  내보내지 않습니다.

## 테스트 (fake fetch full-pipeline, no external network)

- composition 테스트는 **실제** component(Provider-from-env, hourly service, request factory, PR #14
  availability-delay selector, Provider response parser/grouping, hourly normalizer, scheduled facade)를
  조립합니다 — 이들을 mock하지 않습니다.
- 외부 network 대신 injected in-memory `fetchImpl`만 사용하고, 결정론적 instant가 필요할 때만 fake
  clock을 주입합니다. fake timer를 사용하지 않습니다.
- 실제 `KMA_SERVICE_KEY`를 사용하지 않습니다(명백한 테스트 키만 사용). 자동 테스트는 실제 네트워크를
  호출하지 않습니다.
- full SHORT pipeline 테스트는 injected clock `2026-07-18T05:00:00+09:00`에서 production selector가
  `base_date=20260718`·`base_time=0200`(0500의 10분 threshold 미도달)을 고르고, fake fetch가 한
  slot(TMP/SKY/PTY/POP/PCP/SNO/REH/WSD/VEC)을 반환하면, `getVilageFcst` URL·쿼리 round-trip·GET·Accept를
  검증하고 정규화된 `HourlyForecast` 한 건(`forecastAt 2026-07-18T06:00:00+09:00`, `CLEAR`, `25.5℃`, …)을
  확인합니다.
- exact production boundary 테스트: SHORT `05:09:59.999`→`0200`·`05:10:00.000`→`0500`, ULTRA
  `06:30`→`getUltraSrtFcst 0530`·`06:45`→`getUltraSrtFcst 0630`. 이 경계 테스트는 HTTP 503 in-memory
  응답으로 URL 선택만 검증하며(normalization fixture 없이), 결과는 기존 `PROVIDER`/`HTTP_ERROR` 계약으로
  통과합니다(새 result type 없음).

## 아직 하지 않는 것 (이 PR의 범위 밖)

- **module-scope production singleton / import-time composition** — 없음(명시적 함수 호출 필요).
- **app startup wiring** — `apps/api/src/index.ts`에서 composition을 실행하지 않습니다. index는
  변경하지 않았습니다.
- **route 연결** — composition root는 아직 어떤 route에도 연결되지 않았습니다. `/weather`는 없고,
  `/health`와도 무관합니다.
- **위경도 → KMA grid(nx/ny) 변환** — 이 **grid-based** production composition
  (`createKmaScheduledHourlyCompositionFromEnv`)은 순수 converter(`convertKmaLatitudeLongitudeToGrid`)를
  **조립하지 않습니다.** 반환된 facade는 여전히 caller가 이미 계산한 nx/ny를 요구합니다. 위·경도를
  받는 wiring은 PR #13이 추가한 **별도의** location composition
  (`createKmaLocationScheduledHourlyCompositionFromEnv`)에 있습니다 — 그것은 이 grid-based composition을
  **그대로 재사용**하고 그 앞단에 PR #12 converter를 조립하며, 이 grid-based composition function과 그
  `{ ok, facade }` result·API는 변경하지 않습니다([kma-location-scheduled-hourly.md](./kma-location-scheduled-hourly.md)).
  두 composition 모두 아직 startup/route에는 연결되지 않았습니다.
  - 두 composition function의 차이: `createKmaScheduledHourlyCompositionFromEnv`는 `product`/`nx`/`ny`
    facade를, `createKmaLocationScheduledHourlyCompositionFromEnv`는 `product`/`latitude`/`longitude`
    facade를 만들며, 후자는 전자의 결과를 소비하고 converter를 선택할 뿐 env/config/clock/network
    경계는 동일하게 유지합니다(config 실패 시 같은 `KmaProviderConfigError` reference 그대로 전달, 생성
    시 converter·clock·fetch 0회).
- **live availability guarantee / retry / fallback / cache / stale data** — 없음. production은 PR #14
  availability-delay selector(단기 10분·초단기 15분 프로젝트 정책 threshold)로 issuance를 선택할 뿐,
  실제 upstream readiness를 보장하지 않고 publication-in-progress·empty-data 재시도/대체를 하지
  않습니다.
- **PR #16 primary/previous candidate selector** — 이 composition은 PR #16
  `selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay`([kma-fallback-candidates.md](./kma-fallback-candidates.md))를
  **아직 소비하지 않습니다.** 현재 production selector는 여전히 PR #14 single selector이고, facade 호출당
  KMA request는 **최대 1회**입니다. candidate selector의 primary/previous 후보를 이용한 두 번째 요청·단일
  fallback orchestration은 후속 PR에서 명시적으로 wiring할 예정입니다(live guarantee/retry/fallback 없음
  유지).
- **PR #17 fallback eligibility classifier** — 이 composition은 PR #17
  `classifyKmaHourlyFallbackEligibility`([kma-fallback-eligibility.md](./kma-fallback-eligibility.md))도
  **아직 소비하지 않습니다.** classifier는 service result를 순수 분류만 하며 실제 fallback을 실행하지
  않습니다. PR #16 candidate 후보와 PR #17 classifier를 조합하는 wiring은 후속 PR의 몫이고, 그때까지
  production은 facade 호출당 KMA request **최대 1회**를 유지합니다(retry/fallback/live readiness 없음).
- **PR #18 fallback request-plan factory** — 이 composition은 PR #18
  `createKmaFallbackRequestPlanFactory`([kma-fallback-request-plan.md](./kma-fallback-request-plan.md))를
  **아직 소비하지 않습니다.** current production은 여전히 PR #9 single request factory
  (`createKmaForecastRequestFactory` + PR #14 availability-delay selector)를 사용하며, facade 호출당
  Provider는 **최대 1회** 호출됩니다.
- **PR #19 fallback orchestration service** — PR #16 candidate selector · PR #17 classifier · PR #18
  request-plan factory · PR #7 hourly service를 하나의 orchestration으로 조립하는
  `createKmaHourlyFallbackService`([kma-hourly-fallback.md](./kma-hourly-fallback.md))가 PR #19에서
  추가됐습니다. 이 grid scheduled composition(및 location composition)은 여전히 그것을 소비하지 않고 각각
  facade 호출당 **Provider 최대 1회**를 유지하지만, **PR #20에서 별도의 (세 번째) grid fallback
  composition root가 추가되어** 이 orchestration service를 소비합니다(아래 "PR #20: 세 번째 callable
  root" 참조). 두 single-request root의 runtime·result·동작은 그 PR에서도 **불변**입니다.
- **timeout/max-response composition override** — 없음(Provider 기본 정책 유지).
- **`WeatherOverview`/`SourceMetadata`/`CurrentWeather`/`DailyForecast`/response envelope** — 없음.
- **별도 general config package** — 여전히 미구현(composition은 이 계층과 무관).

## PR #20: 세 번째 callable root — grid fallback composition

PR #20은 위 grid scheduled root와 location scheduled root를 **교체하지 않고 그 옆에 병렬로** 세 번째
callable production root를 추가합니다. 이 root는 PR #16~#19 fallback building block을 실제 서버용으로
조립합니다. 자세한 계약은 [kma-hourly-fallback-composition.md](./kma-hourly-fallback-composition.md)를
참고하세요.

- **구현 위치**: [kma-hourly-fallback.ts](../apps/api/src/composition/kma-hourly-fallback.ts) 및
  [kma-hourly-fallback.test.ts](../apps/api/src/composition/kma-hourly-fallback.test.ts). barrel
  [index.ts](../apps/api/src/composition/index.ts)에 export를 추가합니다.
- **공개 API**:

  ```ts
  export type KmaHourlyFallbackCompositionDependencies =
    KmaScheduledHourlyCompositionDependencies; // { fetchImpl?, clock? } 직접 alias

  export type CreateKmaHourlyFallbackCompositionResult =
    | { readonly ok: true; readonly service: KmaHourlyFallbackService }
    | { readonly ok: false; readonly error: KmaProviderConfigError };

  export function createKmaHourlyFallbackCompositionFromEnv(
    env?: NodeJS.ProcessEnv,
    dependencies?: KmaHourlyFallbackCompositionDependencies,
  ): CreateKmaHourlyFallbackCompositionResult;
  ```

  dependencies는 기존 scheduled dependencies의 **직접 alias**이며 selector/classifier/timeout/retry
  override를 추가하지 않습니다. 성공 result는 정확히 `{ ok, service }`, config 실패는 `{ ok, error }`(기존
  `KmaProviderConfigError` exact reference)입니다.

- **dependency graph**:

  ```text
  environment
    → createKmaForecastProviderFromEnv (PR #5)        → KmaForecastProvider
    → createKmaHourlyForecastService  (PR #7)         → KmaHourlyForecastService

  system clock adapter / injected clock
    + selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay (PR #16)   // explicit production selector
    → createKmaFallbackRequestPlanFactory (PR #18)    → KmaFallbackRequestPlanFactory

  request-plan factory + hourly service + classifyKmaHourlyFallbackEligibility (PR #17)
    → createKmaHourlyFallbackService (PR #19)         → live KmaHourlyFallbackService
  ```

- **explicit production policy**: 이 root는 PR #16 candidate selector와 PR #17 classifier를 factory/service
  default에 암묵적으로 의존하지 않고 **명시적으로 주입**합니다(기존 PR #15의 explicit production selector
  선택 원칙과 일관). PR #14 availability threshold(단기 10분·초단기 15분)는 selector가 소유하며 이 root는
  복제하지 않습니다.
- **기존 root와의 parallel 관계**: 기존 grid scheduled root와 location scheduled root, 그 `{ ok, facade }`
  result·API·facade 호출당 Provider 최대 1회 동작은 **변경되지 않습니다.** 세 root는 서로 병렬로 존재하고,
  이 fallback root는 서로 다른 공개 method(`fetchHourlyForecastWithFallback`)와 result union을 노출합니다.
- **construction/실행 경계**: root construction은 **network-free**이며 clock read 0회입니다. 반환된
  service 실행 시 primary ineligible이면 fetch **최대 1회**, eligible이면 **최대 2회**(clock 호출당 1회,
  previous 재분류 없음, third attempt 없음)입니다.
- **미연결**: 이 root는 `apps/api/src/index.ts`·startup·`/weather` route에 연결되지 않았고, location(위·
  경도) fallback root는 **PR #21**에서 추가됩니다(아래 참조).

## PR #21: 네 번째 callable root — location fallback composition

PR #21은 위 세 root(grid scheduled·location scheduled·grid fallback)를 **교체하지 않고 그 옆에 병렬로**
네 번째 callable production root를 추가합니다. 이 root는 PR #20 grid fallback root를 그대로 재사용하고 그
앞단에 PR #12 converter를 조립해 위·경도 입력을 받습니다. 자세한 계약은
[kma-location-hourly-fallback.md](./kma-location-hourly-fallback.md)를 참조하십시오.

- **구현 위치**: [kma-location-hourly-fallback.ts](../apps/api/src/composition/kma-location-hourly-fallback.ts)
  및 [kma-location-hourly-fallback.test.ts](../apps/api/src/composition/kma-location-hourly-fallback.test.ts).
- **공개 API**:

  ```ts
  export type KmaLocationHourlyFallbackCompositionDependencies =
    KmaHourlyFallbackCompositionDependencies;

  export type CreateKmaLocationHourlyFallbackCompositionResult =
    | { readonly ok: true; readonly facade: KmaLocationHourlyFallbackFacade }
    | { readonly ok: false; readonly error: KmaProviderConfigError };

  export function createKmaLocationHourlyFallbackCompositionFromEnv(
    env?: NodeJS.ProcessEnv,
    dependencies?: KmaLocationHourlyFallbackCompositionDependencies,
  ): CreateKmaLocationHourlyFallbackCompositionResult;
  ```

- **dependency graph**: `createKmaHourlyFallbackCompositionFromEnv (PR #20)` → live grid fallback
  service, `convertKmaLatitudeLongitudeToGrid (PR #12)` → production converter, 그 둘을
  `createKmaLocationHourlyFallbackFacade (PR #21)`로 조립. 이 root는 `../services`·PR #20 sibling
  composition·`@life-weather/weather-core` converter의 공개 surface만 소비합니다(순환 없음).
- **config/laziness**: config failure면 PR #20 composition의 `KmaProviderConfigError`를 **동일 reference**로
  반환하고 facade를 만들지 않습니다. construction은 **network-free**이며 converter·clock·fetch 0회 —
  최초 converter/clock/fetch는 반환된 facade method 호출 시에만 발생합니다. 같은 env/dependencies로 두 번
  호출하면 wrapper·facade·method reference가 모두 서로 다릅니다.
- **supported/unsupported 동작**: 지원 위치는 grid로 변환되어 grid fallback service를 실행하고(호출당
  Provider **최대 2회**), 물리적으로 유효하지만 grid 밖인 위치는 `LOCATION`/`UNSUPPORTED_LOCATION` 결과로
  Provider **0회**, 물리 범위 밖 좌표는 converter `RangeError`를 **동기적으로** throw합니다(clock/fetch 0회).
- **기존 root와의 parallel 관계**: grid scheduled·location scheduled·grid fallback 세 root와 그
  API·result·동작은 **변경되지 않습니다.** 네 root는 서로 병렬로 존재하고, 이 location fallback root의 성공
  result key는 `service`가 아니라 `facade`입니다.
- **미연결**: 이 root도 `apps/api/src/index.ts`·startup·`/weather` route에 연결되지 않았습니다.

## PR #22: execution trace selector (composition root 추가 없음)

PR #22는 새 composition root를 추가하지 않습니다. 대신 PR #19 execution trace에서 primary/previous/none
usable source를 고르는 **순수 selector**(`selectKmaHourlyFallbackResult`,
[kma-hourly-fallback-selection.md](./kma-hourly-fallback-selection.md))를 services 계층에 추가합니다.

- **네 callable root(grid scheduled·location scheduled·grid fallback·location fallback)는 모두
  불변**입니다 — 공개 API·result·runtime 변경 없음.
- 두 fallback root는 계속 PR #19 **execution trace**(`{ ok, service }`의 `service`가 반환하는 trace,
  또는 location facade가 반환하는 trace)를 반환합니다.
- **PR #22 pure selector는 구현 완료**됐지만, 어느 composition root에도 **아직 조립되지 않았습니다** —
  selector는 실행 이후 순수 함수로 동작하며 composition·route·startup에 연결되지 않습니다.
- final `WeatherOverview`/`SourceMetadata` assembly는 여전히 **미구현**이고, `/weather` route·cache도
  **미구현**입니다(후속 PR에서 selector를 소비하는 assembler를 조립할 예정).

## PR #23: hourly WeatherOverview assembler (composition root 추가 없음)

PR #23도 새 composition root를 추가하지 않습니다. 대신 PR #22 selection을 소비해 hourly section만 조립하는
**순수 assembler**(`assembleKmaHourlyWeatherOverview`,
[kma-hourly-weather-overview.md](./kma-hourly-weather-overview.md))를 services 계층에 추가합니다.

- **네 callable root(grid scheduled·location scheduled·grid fallback·location fallback)는 모두
  불변**입니다 — 공개 API·result·runtime 변경 없음.
- 이 assembler는 순수 함수로 caller의 `WeatherLocation`·precomputed PR #22 selection·(선택 시) selected
  source provenance를 받아 hourly-only `WeatherOverview`를 조립하고 `weatherOverview.parse`로 동기
  검증합니다. clock·network·환경·Provider·composition을 건드리지 않으며 PR #22 selector도 호출하지
  않습니다(caller가 먼저 selection을 계산).
- **PR #23 pure assembler는 구현 완료**됐지만, **어느 composition root에도 아직 조립되지 않았습니다** —
  두 fallback root는 계속 PR #19 execution trace를 반환하고, assembler는 composition·route·startup에
  연결되지 않습니다.
- selector(PR #22)와 assembler(PR #23)를 location result narrow와 함께 엮는 **application service와 그
  production composition**은 여전히 **미구현**이고, `/weather` route·cache도 **미구현**입니다.

## PR #24: location hourly overview application service (composition root 추가 없음)

PR #24도 새 composition root를 추가하지 않습니다. 대신 PR #21 facade·PR #22 selector·주입된 metadata
resolver·PR #23 assembler를 하나로 잇는 **application service**
(`createKmaLocationHourlyOverviewService`,
[kma-location-hourly-overview.md](./kma-location-hourly-overview.md))를 services 계층에 추가합니다.

- **네 callable production root(grid scheduled·location scheduled·grid fallback·location fallback)는
  모두 불변**입니다 — 공개 API·result·runtime 변경 없음.
- 이 service는 호출당 contracts `weatherLocation.parse`를 선행 실행하고, PR #21 location fallback facade를
  실행하며, top-level `LOCATION` 실패는 그대로 통과시키고, 지원 trace에 PR #22 selector를 적용한 뒤,
  selected일 때만 주입된 resolver로 provenance를 결정해 PR #23 assembler로 `{ ok, selection, overview }`를
  조립합니다. clock·network·환경·Provider·composition을 소유하지 않고 provenance를 추정하지 않습니다.
- **PR #24 application service는 구현 완료**됐지만, **어느 production composition root에도 아직 조립되지
  않았습니다**. PR #26이 이 service가 주입받는 **production metadata resolver**
  (`createKmaLiveSelectedHourlySourceMetadataResolver`)를 구현했으나, 둘을 실제 graph로 조립하는 production
  composition은 아직 없습니다. service·resolver는 composition·`/weather` route·startup에 연결되지 않습니다.

## PR #25: execution trace의 sanitized issuance identity (composition root 추가 없음)

PR #25도 새 composition root를 추가하지 않습니다. 대신 PR #19 execution trace가 **실제 request plan**에서
파생한 sanitized `KmaForecastIssuanceIdentity`(`product`/`baseDate`/`baseTime`만)를 보존하도록 하고, 그 public
type을 services 계층에 추가합니다([kma-hourly-fallback.md](./kma-hourly-fallback.md)).

- **네 callable production root(grid scheduled·location scheduled·grid fallback·location fallback)는
  모두 불변**입니다 — 공개 API·result·runtime 변경 없음. composition runtime 파일은 전혀 수정하지 않습니다.
- 두 fallback root는 계속 PR #19 execution trace를 반환하며, 그 trace가 이제 no-fallback branch에
  `primaryIssuance`를, fallback-attempted branch에 `primaryIssuance` + `previousIssuance`를 함께 담습니다.
  `previousIssuance`는 previous가 실제 실행된 branch에만 존재합니다.
- identity는 이미 만들어진 plan에서 fresh object로 파생하므로 composition의 clock 호출 수는 변하지 않고(호출당
  1회 그대로), full request/plan/grid·ServiceKey·URL·query·raw body는 노출하지 않습니다.
- **production metadata resolver는 PR #26에서 구현됐습니다** — issuedAt/fetchedAt/sourceId/retrievalMode를
  만드는 `createKmaLiveSelectedHourlySourceMetadataResolver`가 이 identity를 소비합니다
  ([kma-selected-hourly-source-metadata.md](./kma-selected-hourly-source-metadata.md)). 다만 아직 어떤
  composition root에도 조립되지 않았습니다.

## 후속 범위

primary/previous selection policy(PR #22)·hourly-only `WeatherOverview` assembler(PR #23)·이 셋을
`LOCATION` narrow와 함께 엮는 application service(PR #24)·selected-source provenance를 만드는 production
metadata resolver(PR #26)는 모두 구현 완료됐고, 네 callable composition root(grid/location ×
scheduled/fallback)는 그대로 4개로 유지됩니다 — 이 문서 수정에서 새 composition root를 제안하거나 구현하지
않습니다. 남은 후속 범위와 dependency 순서:

1. ~~selected-source **production provenance strategy** 확정~~ — PR #26에서 확정(발표시각은 PR #25 trace의
   보존된 issuance identity에서 파생; 별도 clock 복원 없음).
2. ~~그 strategy를 구현하는 **production metadata resolver**~~ — PR #26에서 구현
   (`createKmaLiveSelectedHourlySourceMetadataResolver`).
3. **(PR #27)** 기존 PR #21 location fallback root와 PR #24 application service·PR #26 production resolver를
   조립하는 별도의 application-facing **production composition**(다섯 번째 callable root).
4. `apps/api/src/index.ts` startup wiring.
5. `/weather` route, query validation과 HTTP status/envelope mapping.
6. cache/stale-data 정책.
7. authenticated KMA E2E verification.

## 변경 이력

```text
v1 / PR #11 / 2026-07
- KMA system clock adapter 추가
- Provider-from-env, request factory, hourly service, scheduled facade production composition 추가
- import-time singleton 없이 명시적 composition function 제공
- HTTP route 연결은 후속 PR로 분리

v2 / PR #13 / 2026-07 (location composition 추가)
- 위·경도 → 격자 wiring을 담당하는 별도 location composition
  (createKmaLocationScheduledHourlyCompositionFromEnv)이 이 grid-based composition을 재사용하고 그
  앞단에 PR #12 converter를 조립
- 이 grid-based composition function과 그 { ok, facade } result·API는 변경 없음
- 두 composition 모두 route 미연결

v3 / PR #15 / 2026-07 (production availability selector wiring)
- 이 composition이 request factory에 PR #14 selectLatestKmaForecastBaseTimeAfterAvailabilityDelay를
  명시적으로 주입(고정 production 선택). SHORT 05:00→0200, 05:10→0500, ULTRA 06:30→0530, 06:45→0630
- KmaScheduledHourlyCompositionDependencies·composition 함수 이름 불변(selector option 미추가)
- location composition은 이 composition 재사용으로 정책 자동 상속(별도 selector 주입 없음)
- threshold 정책은 여전히 weather-core PR #14 selector 소유, live guarantee/retry/fallback 없음

v4 / PR #16 / 2026-07 (candidate selector 미연결 — composition 불변)
- weather-core에 PR #16 primary/previous candidate selector가 추가됐으나 이 composition은 소비하지 않음
- 현재 production selector는 여전히 PR #14 single selector, facade 호출당 KMA request 최대 1회
- composition 함수·dependencies·runtime 변경 없음, live guarantee/retry/fallback 없음 유지

v5 / PR #17 / 2026-07 (fallback eligibility classifier 미연결 — composition 불변)
- apps/api services에 PR #17 fallback eligibility classifier가 추가됐으나 이 composition은 소비하지 않음
- production selector·facade 호출당 KMA request 최대 1회 유지, PR #16 candidate와 조합도 미연결
- composition 함수·dependencies·runtime 변경 없음, retry/fallback 실행·live readiness 없음 유지

v6 / PR #18 / 2026-07 (fallback request-plan factory 미연결 — composition 불변)
- apps/api services에 PR #18 fallback request-plan factory가 추가됐으나 이 composition은 소비하지 않음
- current production은 여전히 PR #9 single request factory 사용, facade 호출당 Provider 최대 1회
- PR #16/#17/#18 조합 wiring은 후속(PR #19), composition 함수·dependencies·runtime 변경 없음
- retry/fallback 실행·live readiness 보장 없음 유지

v7 / PR #19 / 2026-07 (fallback orchestration service 미연결 — composition 불변)
- apps/api services에 PR #19 createKmaHourlyFallbackService가 추가돼 PR #18 plan·PR #7 hourly service·
  PR #17 classifier를 처음으로 조합하지만, 이 production composition은 아직 소비하지 않음
- 두 production facade(scheduled·location)는 그대로 facade 호출당 Provider 최대 1회 유지
- 별도 production fallback composition은 후속(PR #20), composition 함수·dependencies·runtime 변경 없음
- route/live readiness 보장/cache 없음 유지

v8 / PR #20 / 2026-07 (세 번째 callable root — grid fallback composition 추가)
- createKmaHourlyFallbackCompositionFromEnv가 PR #16~#19 fallback graph를 기존 두 single-request root
  옆에 병렬로 조립(environment + production clock + Provider + explicit PR #16 selector/PR #17 classifier)
- 성공 시 { ok, service }, config 실패는 KmaProviderConfigError exact reference pass-through
- 실행 시 primary ineligible fetch 최대 1회·eligible 최대 2회, construction network-free
- 기존 grid scheduled root·location scheduled root와 그 { ok, facade } 계약·동작 불변
- location fallback·startup/route·result assembly·cache는 후속(제외)

v9 / PR #21 / 2026-07 (네 번째 callable root — location fallback composition 추가)
- createKmaLocationHourlyFallbackCompositionFromEnv가 PR #20 grid fallback root를 재사용하고 그 앞단에
  PR #12 converter를 조립(위·경도 입력 → grid → grid fallback service)
- 성공 시 { ok, facade }, config 실패는 KmaProviderConfigError exact reference pass-through
- 지원 위치 Provider 최대 2회, 미지원 위치 0회, 물리 범위 밖 좌표 converter RangeError 동기 throw
- 기존 grid scheduled·location scheduled·grid fallback 세 root와 그 계약·동작 불변
- startup/route·final result selection·result assembly·cache는 후속(제외)

v10 / PR #22 / 2026-07 (execution trace selector; composition root 추가 없음)
- PR #22 selectKmaHourlyFallbackResult(순수 selector)가 services 계층에 구현됨
- 네 callable root 모두 불변(공개 API·result·runtime 변경 없음), roots는 계속 execution trace 반환
- selector는 어느 composition root에도 아직 조립되지 않음
- WeatherOverview/SourceMetadata assembly·route·cache는 여전히 미구현

v11 / PR #23 / 2026-07 (hourly WeatherOverview assembler; composition root 추가 없음)
- PR #23 assembleKmaHourlyWeatherOverview(순수 assembler)가 services 계층에 구현됨(PR #22 selection →
  hourly-only WeatherOverview)
- 네 callable root 모두 불변(공개 API·result·runtime 변경 없음)
- assembler는 어느 composition root에도 아직 조립되지 않음(PR #22 selector도 호출하지 않음)
- 다음 단계는 location fallback + selector + assembler를 엮는 application service/composition
- route·cache는 여전히 미구현

v12 / PR #24 / 2026-07 (location hourly overview application service; composition root 추가 없음)
- PR #24 createKmaLocationHourlyOverviewService가 services 계층에 구현됨(facade → selector → resolver
  seam → assembler orchestration)
- 네 callable production root 모두 불변(공개 API·result·runtime 변경 없음)
- 이 application service는 아직 production composition에 조립되지 않음
- selected-source provenance를 결정하는 production metadata resolver도 아직 production 구현 없음
- 다음 단계는 provenance strategy 확정 → production resolver → PR #24 application service의 production
  composition
- startup/route·cache는 여전히 미구현

v13 / PR #25 / 2026-07 (execution trace가 sanitized issuance identity 보존; composition root 추가 없음)
- PR #19 execution trace가 실제 plan에서 파생한 KmaForecastIssuanceIdentity를 보존(primaryIssuance,
  fallback 시 previousIssuance — product/baseDate/baseTime만; nx/ny·full request/plan 미포함)
- 네 callable root 모두 불변(공개 API·result·composition runtime 변경 없음); clock 호출 수 불변
- production metadata resolver·issuedAt/fetchedAt/sourceId/retrievalMode는 이 시점까지 미구현(PR #26)
- startup/route·cache는 여전히 미구현

v14 / PR #26 / 2026-07 (live selected-source metadata resolver; composition root 추가 없음)
- PR #26 createKmaLiveSelectedHourlySourceMetadataResolver + convertKmaForecastIssuanceToIssuedAt가 services 계층에 구현됨
- PR #25 trace가 보존한 issuance identity를 소비: PRIMARY→primaryIssuance, PREVIOUS→previousIssuance
- KST +09:00 issuedAt, product별 고정 sourceId, retrievalMode LIVE, resolver-time fetchedAt(유효 입력당 clock 1회)
- 네 callable production root 모두 불변(공개 API·result·runtime 변경 없음); production composition root 수 여전히 4
- application service + production resolver 모두 구현 완료됐으나 아직 어느 composition root에도 조립되지 않음
- 다음 단계(PR #27)는 location fallback root + PR #24 service + PR #26 resolver를 조립하는 다섯 번째 callable root
- startup/route·cache는 여전히 미구현
```
