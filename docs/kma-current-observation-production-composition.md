# KMA current-observation production composition root

이 문서는 PR #69에서 추가한 **server-side production composition** function
(`createKmaScheduledCurrentObservationCompositionFromEnv`)의 책임과 경계를 기록합니다. 이 함수는
[kma-production-composition.md](./kma-production-composition.md)에 기록된 기존 hourly composition
root와 **같은 원칙을 따르는 별도의, 병렬** 구현입니다 — hourly composition을 일반화하거나
공통 abstraction으로 합치지 않습니다.

구현 위치:

- [kma-scheduled-current-observation.ts](../apps/api/src/composition/kma-scheduled-current-observation.ts) — composition root
- [kma-scheduled-current-observation 테스트](../apps/api/src/composition/kma-scheduled-current-observation.test.ts)
- [index.ts](../apps/api/src/composition/index.ts) — composition barrel(export 추가)

## 목적과 dependency graph

지금까지 구현한 current-observation component(PR #63 Provider-from-env, PR #64 schedule-only
selector, PR #66 request factory, PR #67 current-observation service, PR #68 scheduled facade)와
기존 system clock adapter를, 실제 서버 시작 시점(또는 향후 route composition 시점)에 **한 번의 함수
호출**로 조립합니다.

```text
environment
  → createKmaCurrentObservationProviderFromEnv (PR #63)   → KmaCurrentObservationProvider
  → createKmaCurrentObservationService (PR #67)           → KmaCurrentObservationService

system clock adapter / injected clock
  + selectLatestKmaCurrentObservationBaseTime (PR #64)   // explicit schedule-only production choice
  → createKmaCurrentObservationRequestFactory (PR #66)   → KmaCurrentObservationRequestFactory

request factory + current-observation service
  → createKmaScheduledCurrentObservationFacade (PR #68) → live KmaScheduledCurrentObservationFacade
```

조립은 **호출 시점**에 명시적으로 수행되므로, 모듈 import만으로 `process.env`를 읽거나 Provider를
생성하지 않습니다.

## 공개 API

```ts
export interface KmaScheduledCurrentObservationCompositionDependencies {
  readonly fetchImpl?: typeof fetch;
  readonly clock?: KmaCurrentObservationRequestClock;
}

export type CreateKmaScheduledCurrentObservationCompositionResult =
  | { readonly ok: true; readonly facade: KmaScheduledCurrentObservationFacade }
  | { readonly ok: false; readonly error: KmaProviderConfigError };

export function createKmaScheduledCurrentObservationCompositionFromEnv(
  env?: NodeJS.ProcessEnv,
  dependencies?: KmaScheduledCurrentObservationCompositionDependencies,
): CreateKmaScheduledCurrentObservationCompositionResult;
```

- `KmaCurrentObservationRequestClock`은 PR #66의 기존 type을 재사용합니다(별도 clock interface를
  중복 정의하지 않음).
- 새로운 configuration error type도, 새로운 throw 기반 config 정책도 만들지 않습니다. config 실패는
  Provider factory의 기존 `KmaProviderConfigError` 값을 그대로 반환합니다.
- 새 stage나 error kind(`COMPOSITION_ERROR`/`STARTUP_ERROR`/`CURRENT_CONFIG_ERROR`/`INTERNAL_ERROR`/
  `UNKNOWN` 등)를 만들지 않습니다.

## provider-from-env 책임

- composition은 Provider를 `createKmaCurrentObservationProviderFromEnv(env, …)`로 **실제로
  생성**합니다.
- `env` argument가 제공되면 그 object reference를 Provider factory에 **그대로** 전달합니다(clone·
  spread·mutation 없음, `KMA_SERVICE_KEY` property 직접 읽기 없음).
- `env`가 생략되면 Provider factory가 **호출 시점에** `process.env`를 사용합니다. composition
  module을 import할 때는 `process.env`를 읽지 않습니다.
- `KMA_SERVICE_KEY`의 읽기·검증(존재/형태) 책임은 계속 **Provider factory**가 소유합니다.
  composition은 환경변수 이름이나 key validation 규칙을 복제하지 않고, key를 trim/decode/encode
  하지 않으며, error/result에 key를 포함하지 않습니다.
- `fetchImpl`이 생략되면 Provider factory의 두 번째 positional argument로 정확히 `undefined`를
  전달합니다 — `{ fetchImpl: undefined }`를 만들지 않습니다. `fetchImpl`이 제공되면 exact function
  reference만 포함한 새 options object(`{ fetchImpl }`, own key는 정확히 `fetchImpl` 하나)를
  전달합니다.

### config error pass-through

Provider 환경설정이 실패하면 Provider factory의 결과를 composition이 그대로 전달합니다.

```ts
if (!providerResult.ok) {
  return { ok: false, error: providerResult.error };
}
```

- **동일 error object reference**를 사용합니다(clone·message 추가·raw env·service key 추가·
  logging·throw 없음).
- config 실패 시에는 clock 생성·request factory 생성·current-observation service 생성·facade
  생성·fetch가 **모두 일어나지 않습니다.**

## injected/default clock

- `clock?: KmaCurrentObservationRequestClock`가 제공되면 그 reference를 request factory에 그대로
  전달합니다(clone·wrapper·호출·validation 없음).
- 생략되면 기존 [`createKmaSystemClock()`](../apps/api/src/composition/system-clock.ts)을
  사용합니다 — **새로운 current 전용 system clock implementation을 만들지 않습니다.** 기존 clock
  adapter는 `nowEpochMilliseconds()`라는 동일한 structural port를 충족하므로 forecast/current가
  함께 재사용합니다(`system-clock.ts`의 docblock 참고).
- composition 생성 시점에는 clock의 `nowEpochMilliseconds()`를 **호출하지 않습니다.** 실제 clock
  read는 반환된 facade의 `fetchScheduledCurrentWeather()`가 실행되어 request factory가 호출될 때
  처음 발생합니다.

## explicit schedule-only selector production 선택

Production current-observation composition은 PR #64
[`selectLatestKmaCurrentObservationBaseTime`](./kma-current-observation-issue-time.md)을
**명시적으로** request factory에 주입합니다.

```ts
createKmaCurrentObservationRequestFactory(
  clock,
  selectLatestKmaCurrentObservationBaseTime,
);
```

Selector argument를 생략해 request factory의 implicit default에 암묵적으로 의존하지 않습니다 — 두
인자 호출은 request factory의 한 인자 호출과 **결과적으로 동일한 값**을 고르지만, 이 composition은
production 선택을 explicit하게 남겨 향후 availability-delay selector로 교체할 때 이 한 줄만 바뀌게
합니다.

**중요 — 이 selector는 availability를 보장하지 않습니다.**

- 이 schedule-only selector는 매시간 정시(`HH00`) 중 reference 시각과 같거나 이전인 최신 issuance를
  고릅니다.
- upstream API에 그 issuance의 자료가 **이미 제공됐음을 보장하지 않습니다.**
- 이 composition은 availability delay, safety margin, live-readiness claim을 추가하지 않습니다.
- threshold 숫자를 composition에 넣지 않습니다.
- current-observation availability-delay selector 자체가 이 PR에서 구현되지 않습니다 — hourly
  composition이 사용하는 PR #14
  [`selectLatestKmaForecastBaseTimeAfterAvailabilityDelay`](./kma-production-composition.md)에
  대응하는 current 전용 selector는 아직 없습니다.

## composition 순서

성공 경로는 다음 순서로 진행됩니다.

1. `createKmaCurrentObservationProviderFromEnv(env, …)`
2. provider config result 확인 — 실패면 즉시 `{ ok: false, error }` 반환(동일 reference)
3. injected clock 또는 `createKmaSystemClock()` 선택
4. `createKmaCurrentObservationRequestFactory(clock, selectLatestKmaCurrentObservationBaseTime)`
5. `createKmaCurrentObservationService(providerResult.provider)`
6. `createKmaScheduledCurrentObservationFacade(requestFactory, currentObservationService)`
7. `{ ok: true, facade }` 반환

## success result `{ ok, facade }`

성공 result는 정확히 두 field(`ok`, `facade`)만 공개합니다.

- internal `provider`·`requestFactory`·`currentObservationService`·`clock`·`env`·`fetchImpl`·
  `serviceKey`·`config`·`url`·`dependencies`·`selector`는 **노출하지 않습니다.**
- service key는 bound Provider 내부에만 유지되어 composition result로 새어 나가지 않습니다.
- 매 composition 호출은 fresh facade graph를 만듭니다 — module-level singleton이나 global cache가
  없습니다. 같은 env/dependencies로 두 번 호출해도 반환된 facade·중간 collaborator는 서로 다른
  reference입니다.

## construction side-effect 경계

`createKmaScheduledCurrentObservationCompositionFromEnv()` 호출 시 허용되는 것: 환경 object에서
Provider 설정 읽기, Provider config validation, collaborator object 생성, closure 조립.

호출 시 **일어나지 않는** 것: `Date.now()` 실행·clock read·selector 실행·network fetch·Provider
`fetchCurrentObservation`·request factory `createScheduledRequest`·current-observation service
`fetchCurrentWeather`·facade `fetchScheduledCurrentWeather`·timer 시작·listener 등록·logging·route
등록·global mutation.

Module import 시에도 동일하게 env read·provider 생성·system clock 생성·`Date.now()`·fetch·timer/
listener·logging·route 등록이 **없습니다.**

최초 clock read, selector 실행과 network fetch는 반환된 facade의 `fetchScheduledCurrentWeather()`가
호출될 때만 발생합니다.

## throw와 rejection

Broad `try/catch`를 추가하지 않습니다. 예상 밖 collaborator factory throw가 발생하면 같은 error
reference를 동기적으로 전파합니다.

- Provider factory throw → 이후 collaborator 생성 0회
- System clock factory throw → request factory/service/facade 생성 0회
- Request factory construction throw → service/facade 생성 0회
- Service construction throw → facade 생성 0회
- Facade construction throw → 그대로 전파

Facade 호출 이후의 clock/selector/provider/normalization throw·result·rejection 계약은 기존
component(PR #63/#64/#66/#67/#68)가 그대로 소유합니다 — 이 composition은 재분류·wrapping·logging을
하지 않습니다.

## 불변성

- env mutation 없음
- dependencies mutation 없음
- fetchImpl wrapping 없음
- injected clock wrapping/clone/mutation 없음
- selector wrapping 없음
- provider/request factory/service/facade mutation 없음
- frozen env/dependencies/clock에서도 construction 가능
- repeated composition calls independent(이전 facade나 config result 저장 없음)

## full-pipeline result/error pass-through

Layer B 테스트는 **실제** component(Provider-from-env, current-observation service, request
factory, PR #64 selector, Provider raw-response parser/grouping, current normalizer, scheduled
facade)를 조립해 검증합니다 — 이들을 mock하지 않고, injected in-memory `fetchImpl`과 결정론적
clock만 사용합니다.

- **성공**: 정규화된 `CurrentWeather`가 계약 스키마를 통과하고, `getUltraSrtNcst` URL·쿼리 round-
  trip·`GET`·`Accept: application/json`·`redirect: 'error'`·`AbortSignal` 존재를 검증합니다.
- **Provider-stage 실패**(예: HTTP 503) — 기존 `{ ok: false, stage: 'PROVIDER', error }` 그대로.
- **Normalization-stage 실패**(예: 필수 `T1H` 부재) — 기존 `{ ok: false, stage: 'NORMALIZATION',
  issues }` 그대로.
- **Pre-aborted signal** — request 생성을 위해 clock은 1회 읽히고 fetch는 0회, `PROVIDER`/
  `ABORTED`.
- 모든 경로에서 service key·raw URL·raw response·raw KMA 필드(`obsrValue` 등)가 result에 나타나지
  않고, `console.log`/`console.error`/`console.warn`이 호출되지 않습니다.

## 실제 key·네트워크 미사용

- 실제 `KMA_SERVICE_KEY`를 사용하지 않았습니다(명백한 테스트 키만 사용).
- 자동 테스트는 실제 네트워크를 호출하지 않습니다.
- 실제 좌표를 사용하지 않았습니다(고정 테스트 `nx`/`ny`만 사용).

## production route 미연결

이 composition은 `apps/api/src/index.ts`·`apps/api/src/api-app.ts`·어떤 route에도 연결되지
않았습니다. `POST /weather`는 이 PR 이후에도 `current` section이 계속 missing으로 응답합니다.

## PR #70과의 관계 — location application facade는 추가됐지만 이 composition에는 아직 미연결

**PR #70**이 latitude/longitude → KMA grid(nx/ny) 변환을 PR #68 scheduled current-observation
facade 앞단에 잇는 application-level location facade
(`createKmaLocationScheduledCurrentObservationFacade`,
[kma-location-scheduled-current-observation.md](./kma-location-scheduled-current-observation.md))를
추가했습니다. 이 composition(`createKmaScheduledCurrentObservationCompositionFromEnv`) 자체의 공개
계약, 조립 순서, construction side-effect 경계는 **전혀 변경되지 않았습니다** — PR #70의 location
facade는 이 composition이 반환하는 `facade`를 아직 소비하지 않는 독립된 단위 구성 요소입니다.
production converter 선택과 이 composition에 location facade를 연결하는 production location
composition은 여전히 없습니다.

PR #70 이후 상태:

- location application facade: 구현됨(PR #70, production composition 미연결)
- production converter 선택/production location composition: 여전히 없음
- `WeatherOverview.current`: 여전히 없음
- current `SourceMetadata`: 여전히 없음
- `POST /weather` 연결: 여전히 없음
- current-observation availability-delay selector: 여전히 없음
- 실제 인증 KMA API 검증: 여전히 없음

## 후속 범위

1. ~~latitude/longitude → KMA grid(nx/ny) 변환을 이 composition 앞단에 잇는 location adapter~~ —
   PR #70에서 application facade 자체는 구현(이 composition에 대한 production 연결은 아직 없음).
2. 이 composition을 소비하는 production location composition(PR #70 location facade에 production
   converter를 선택해 조립).
3. `WeatherOverview.current` section 조립
4. current `SourceMetadata`(`sourceId`/`issuedAt`/`retrievalMode`) 조립
5. `POST /weather`로의 current 데이터 연결
6. current-observation availability-delay selector(hourly의 PR #14에 대응하는 current 전용 정책)
7. 실제 인증 KMA API 호출을 통한 live 검증

이 PR이 production current 데이터를 제공한다고 표현하지 않습니다 — `POST /weather`는 이 PR
이후에도 계속 current를 missing으로 응답합니다.

## 변경 이력

```text
v1 / PR #69 / 2026-08
- PR #63 provider-from-env + PR #67 current-observation service + injected/default system clock +
  explicit PR #64 schedule-only selector + PR #66 request factory + PR #68 scheduled facade를
  조립하는 callable production composition root 추가
- 성공 { ok, facade }, config 실패는 KmaProviderConfigError exact reference pass-through
- construction 시 clock/fetch/selector 0회; 최초 read/fetch는 facade 호출 시에만 발생
- location adapter/WeatherOverview.current/SourceMetadata/POST 연결/availability-delay selector는
  이 PR 범위 밖
- 기존 hourly composition, current provider/request factory/service/facade는 변경하지 않음, 새
  generic 공통 abstraction 없음

v2 / PR #70 / 2026-08 (location application facade 추가; 이 composition 자체는 불변)
- 이 composition의 공개 계약·조립 순서·construction side-effect 경계 변경 없음
- PR #70 location facade(createKmaLocationScheduledCurrentObservationFacade)는 이 composition이
  반환하는 facade를 아직 소비하지 않는 독립된 application-level 단위
- production converter 선택/production location composition은 여전히 이 PR 범위 밖
```
