# KMA 예정 초단기실황 facade (scheduled current-observation facade)

이 문서는 PR #68에서 추가한 **application-level facade**
(`createKmaScheduledCurrentObservationFacade`)의 책임과 경계를 기록합니다. 이 facade는 새로운 KMA 데이터
규칙이나 오류 정책을 도입하지 않습니다 — 이미 존재하는 두 component(PR #66 request factory, PR #67
current-observation service)를 순서대로 연결하는 **얇은 연결 계층**일 뿐입니다. 이 facade는
[kma-scheduled-hourly-facade.md](./kma-scheduled-hourly-facade.md)의 PR #10 scheduled hourly facade와
**같은 원칙을 따르는 별도의, 병렬** 구현입니다.

구현 위치:

- [kma-scheduled-current-observation.ts](../apps/api/src/services/kma-scheduled-current-observation.ts) — facade
- [kma-scheduled-current-observation 테스트](../apps/api/src/services/kma-scheduled-current-observation.test.ts)

## 목적

- 호출자가 매번 "request factory 호출 → 완성된 request → current-observation service 호출"을 직접
  배선하지 않도록, `nx`/`ny` 입력에서 `KmaCurrentObservationServiceResult`까지 한 번에 이어 줍니다.
- 두 collaborator(PR #66 request factory, PR #67 current-observation service)는 **모두 주입**되며,
  facade는 그 둘의 결과·오류 계약을 **그대로** 전달합니다.

## 현재 pipeline에서의 위치

```text
caller input (nx / ny)
  → requestFactory.createScheduledRequest(input)   // PR #66
  → 완성된 KmaCurrentObservationRequest
  → currentObservationService.fetchCurrentWeather(request, options)   // PR #67
  → KmaCurrentObservationServiceResult (그대로 반환)
```

selector → request factory → **scheduled facade** → current-observation service 순서에서, facade는
factory와 service를 잇는 마지막 연결 고리입니다. request factory 내부의 selector 소비
([kma-current-observation-request-factory.md](./kma-current-observation-request-factory.md))와
current-observation service 내부의 Provider/normalizer 배선
([kma-current-observation-service.md](./kma-current-observation-service.md))은 변경하지 않습니다.

## 공개 API

```ts
export type KmaScheduledCurrentObservationInput =
  KmaCurrentObservationRequestFactoryInput;

export type KmaScheduledCurrentObservationOptions =
  KmaCurrentObservationServiceOptions;

export type KmaScheduledCurrentObservationResult =
  KmaCurrentObservationServiceResult;

export interface KmaScheduledCurrentObservationFacade {
  fetchScheduledCurrentWeather(
    input: KmaScheduledCurrentObservationInput,
    options?: KmaScheduledCurrentObservationOptions,
  ): Promise<KmaScheduledCurrentObservationResult>;
}

export function createKmaScheduledCurrentObservationFacade(
  requestFactory: KmaCurrentObservationRequestFactory,
  currentObservationService: KmaCurrentObservationService,
): KmaScheduledCurrentObservationFacade;
```

- input/options/result type은 별도로 재설계하지 않고 기존 factory·service의 type을 **type alias로
  재사용**합니다. 따라서 facade의 입출력 shape는 두 collaborator와 결코 어긋날 수 없습니다.
- 새로운 result union도, 새로운 facade error type도 만들지 않습니다.
- 메서드 이름은 `fetchScheduledCurrentWeather`로 고정합니다 — `scheduled`는 request factory가 선택한
  발표시각을 사용한다는 뜻이고, `currentWeather`는 raw KMA observation이 아니라 PR #67 service의
  normalized `CurrentWeather` 결과를 반환한다는 뜻입니다.

## 두 injected collaborator

```ts
createKmaScheduledCurrentObservationFacade(
  requestFactory: KmaCurrentObservationRequestFactory,   // PR #66
  currentObservationService: KmaCurrentObservationService,   // PR #67
);
```

- 두 collaborator는 **주입**됩니다. facade는 Provider를 생성하지 않고, request factory나
  current-observation service를 내부에서 새로 만들지 않으며, global singleton도 만들지 않습니다.
- 실제 production 인스턴스(system clock adapter, Provider-from-env)를 조립하는 일은 이 facade의
  책임이 아닙니다. current-observation 전용 production composition은 이 PR 범위가 아닙니다.

## facade 생성은 side-effect-free

`createKmaScheduledCurrentObservationFacade(requestFactory, currentObservationService)`는 순수
생성입니다: request factory를 호출하지 않고, current-observation service를 호출하지 않으며,
clock·환경변수를 읽지 않고, I/O·`fetch`·timer·listener를 만들지 않습니다. 반환된 객체는 두
collaborator reference를 close over할 뿐 다른 상태를 갖지 않습니다. 같은 instance를 여러 번 호출할
수 있고, 각 호출은 이전 호출의 성공·실패·request·result와 무관합니다. Frozen collaborator object에서도
생성할 수 있고, 여러 facade instance는 서로 독립적입니다(global mutable state 없음).

## 호출 순서 계약 (request factory → current-observation service)

한 번의 `fetchScheduledCurrentWeather()` 호출은 다음 순서로 진행됩니다.

1. `requestFactory.createScheduledRequest(input)`를 **정확히 한 번** 호출한다.
2. 반환된 request를 로컬 변수에 담는다.
3. `currentObservationService.fetchCurrentWeather(request, options)`를 **정확히 한 번** 호출한다.
4. current-observation service가 반환한 Promise를 그대로 반환한다.

- factory 호출은 요청당 정확히 1회입니다.
- factory가 성공하면 service 호출은 정확히 1회입니다.
- factory가 throw하면 service는 **호출되지 않습니다**(아래 오류 경계 참조). Service 호출을
  factory보다 먼저 실행하거나 두 collaborator를 병렬로 실행하지 않습니다.

## reference 그대로 전달 (input / request / options / AbortSignal)

facade는 어떤 값도 복제·spread·mutate하지 않고 reference를 그대로 넘깁니다.

- **input**: 호출자의 input object reference를 request factory에 그대로 전달합니다. clone·object
  spread·destructuring 후 재조립·nx/ny 변환·swap·validation·기본값 적용을 하지 않습니다. facade가
  input shape를 직접 읽거나 해석하지 않습니다.
- **request**: request factory가 반환한 `KmaCurrentObservationRequest` reference를
  current-observation service에 그대로 전달합니다. clone·spread·mutation·재검증·baseDate/baseTime/
  nx/ny 변경·request factory 재호출을 하지 않습니다.
- **options / AbortSignal**: 호출자의 options reference(그 안의 `signal` 포함)를
  current-observation service에 그대로 전달합니다. options clone·새 `AbortController` 생성·signal
  wrapping·default options 객체 생성·options mutation을 하지 않습니다.
- **options 생략 시**: current-observation service에 정확히 `undefined`를 전달합니다. 임의의 `{}`를
  만들지 않습니다.

## Promise identity 유지 (no async/await)

`fetchScheduledCurrentWeather`는 current-observation service가 반환한 Promise와 **동일한
reference**를 반환합니다. 이를 위해 다음을 사용하지 않습니다.

- 메서드에 `async` 표기
- `await`
- `.then` / `.catch` / `.finally`
- `Promise.resolve` / 새 Promise 생성

이 정책의 목적은 기존 service의 결과·오류 계약을 **바꾸지 않는 것**입니다: facade는 추가 async
boundary를 만들지 않고, 성공·실패·rejection을 어떤 형태로도 wrapping하지 않으며, collaborator가
만든 결과를 그대로 통과시킵니다. success result object reference, provider-stage failure result
reference, normalization-stage failure result reference, rejected Promise identity, service
rejection 이유의 exact reference를 모두 그대로 유지합니다.

## 결과 pass-through

current-observation service의 result union을 그대로 반환합니다.

- **success**: `{ ok: true, current }`를 그대로 반환합니다. `current` reference 유지, result
  clone·spread·raw request/observation 추가·source metadata 추가 없음.
- **Provider-stage 실패**: `{ ok: false, stage: 'PROVIDER', error }`를 그대로 반환합니다. exact
  result/error reference, stage 변경 없음. normalization stage로 재분류하지 않습니다.
- **Normalization-stage 실패**: `{ ok: false, stage: 'NORMALIZATION', issues }`를 그대로 반환합니다.
  exact result reference, exact issues array와 issue-object reference·순서 유지. sort·clone·filter·
  dedupe 없음. Provider stage로 재분류하지 않습니다.

새로운 facade stage나 새로운 error 종류(`REQUEST_FACTORY`/`FACADE`/`INTERNAL_ERROR`/`UNKNOWN` 등)를
추가하지 않습니다.

## 오류 경계 (factory throw / service throw·rejection)

facade는 새로운 result union도, 새로운 error type도 만들지 않으며, 광범위한 `try`/`try...catch`를
추가하지 않습니다.

- **request factory throw**: factory가 동기적으로 throw하면(예 injected clock의 invalid epoch
  `RangeError`, clock/selector collaborator가 던진 임의의 오류) **동일한 error reference**가
  caller에게 동기적으로 그대로 전파되고, current-observation service는 호출되지 않으며, logging도
  domain result 변환도 하지 않습니다.
- **clock/selector 오류**: 이 오류들은 request factory가 소유하며, factory를 통해 그대로 전파됩니다
  (facade는 clock을 직접 읽지 않습니다).
- **current-observation service 동기 throw**: 동일한 error reference가 그대로 전파됩니다.
- **current-observation service rejected Promise**: 동일한 Promise가 facade에서 반환되고,
  rejection을 가로채거나 변환하지 않습니다(catch/wrap/re-message/log 없음).

## 상태와 불변성

- global mutable state·call counter·cache·last request/result 저장이 없습니다.
- input·options·request·service result를 mutate하지 않습니다.
- frozen input/options/request/result에서도 동작합니다.
- 같은 facade instance를 반복 호출할 수 있으며, 각 호출은 독립적입니다(반복 호출 시 request/result
  교차 없음). 매 호출당 factory/service 각각 정확히 1회 호출합니다.

## 이 PR의 범위 밖

이 facade는 연결만 담당합니다. 다음은 구현하지 않습니다(후속 PR).

- **system clock adapter** — 없음.
- **`Date.now()` 기반 default clock** — 없음(clock은 request factory에 주입되는 collaborator의 몫).
- **Provider 생성** — 없음.
- **environment variable / `KMA_SERVICE_KEY`** — 읽지 않음.
- **HTTP route** — 없음(`POST /weather`로의 current 연결 없음).
- **위경도 → KMA grid(nx/ny) 변환** — 이 facade에는 없음(계속 `nx`/`ny`만 받음).
- **API availability delay / safety margin** — 없음(availability-delay selector 자체가 아직
  존재하지 않습니다).
- **retry / fallback / cache / stale data** — 없음. 여러 발표시각을 시도하지 않습니다.
- **`WeatherOverview.current` / `SourceMetadata` 조립** — 없음.
- **production composition root** — 이 facade 자체는 여전히 두 collaborator를 연결만 하며 Provider·
  env·system clock을 직접 만들지 않습니다. PR #69가 이 facade를 소비하는 별도의 composition root를
  추가했습니다(위 "PR #69" 절 참고) — 그 composition의 provider/clock/selector 조립 책임은 facade
  밖에 있습니다.
- **기존 hourly facade/route** — 이 PR은
  [kma-scheduled-hourly-forecast.ts](../apps/api/src/services/kma-scheduled-hourly-forecast.ts)와 그
  테스트, `kma-forecast-request.ts`, `kma-hourly-forecast.ts`를 수정하지 않습니다. Current-observation
  facade는 hourly facade와 완전히 별도·병렬 구현이며, forecast/current를 합치는 generic scheduled
  facade나 공통 base interface를 도입하지 않습니다.

## request factory / service와의 책임 분리

- PR #66 request factory(`createKmaCurrentObservationRequestFactory`,
  [kma-current-observation-request-factory.md](./kma-current-observation-request-factory.md))는
  **request 조립까지만** 담당하고 Provider를 호출하지 않습니다.
- PR #67 current-observation service(`createKmaCurrentObservationService`,
  [kma-current-observation-service.md](./kma-current-observation-service.md))는 **이미 조립된**
  request를 받아 Provider와 normalizer만 orchestrate합니다.
- 이 facade는 이 둘을 순서대로 부를 뿐, 어느 쪽의 책임도 가져오지 않습니다. 두 collaborator의 실제
  동작(clock/selector 정책, Provider transport, normalizer 규칙)은 각자의 기존 테스트가 계속
  소유합니다.

## 실제 key·외부 네트워크 테스트 없음

- 실제 `KMA_SERVICE_KEY`를 사용하지 않았습니다.
- 자동 테스트는 실제 네트워크를 호출하지 않고, 실제 Provider나 실제 request factory 구현을 함께
  호출하지 않습니다. facade의 wiring 계약만 검증하므로 작은 fake collaborator(`vi.fn`, sentinel
  request/result, controlled Promise, frozen input/options)만 사용합니다. fake timer·environment·
  system clock을 사용하지 않습니다.

## PR #69: 첫 production composition consumer

**PR #69**가 이 facade를 소비하는 첫 production composition root
(`createKmaScheduledCurrentObservationCompositionFromEnv`,
[kma-current-observation-production-composition.md](./kma-current-observation-production-composition.md))를
추가했습니다 — 이 composition은 Provider-from-env, injected/default system clock, 명시적 PR #64
schedule-only selector, PR #66 request factory, PR #67 current-observation service를 조립한 뒤
**이 facade의 exact `createKmaScheduledCurrentObservationFacade(requestFactory,
currentObservationService)` 호출로** 마무리합니다. 이 PR은 facade 자체의 공개 계약(입력/옵션/결과
pass-through, Promise identity, 호출 순서)을 **전혀 변경하지 않습니다** — composition은 facade를
그대로 소비할 뿐입니다. route(`/weather`)·location(위경도 → grid) adapter는 이 composition에서도
여전히 연결되지 않았으므로, production current 데이터는 PR #69 이후에도 계속 missing입니다.

## PR #70: 첫 위경도 location facade consumer

**PR #70**이 이 facade를 소비하는 새 application-level location facade
(`createKmaLocationScheduledCurrentObservationFacade`,
[kma-location-scheduled-current-observation.md](./kma-location-scheduled-current-observation.md))를
추가했습니다 — 기존 위·경도 → KMA 격자 변환 함수를 이 facade 앞에 두는 얇은 adapter입니다. 이 PR은
facade 자체의 공개 계약(`nx`/`ny` 입력, 입력/옵션/결과 pass-through, Promise identity, 호출 순서)을
**전혀 변경하지 않습니다** — location facade는 이 facade를 그대로 소비할 뿐입니다. 이 location
facade를 PR #69 grid-based production composition에 연결하는 production location composition은
여전히 없으므로, production current 데이터는 PR #70 이후에도 계속 missing입니다.

## 후속 범위

1. ~~current-observation 전용 system clock/provider composition~~ — PR #69에서 구현(기존 system
   clock adapter를 재사용).
2. ~~위경도 → KMA grid(nx/ny) 변환을 이 facade 앞단에 잇는 location adapter~~ — PR #70에서 구현
   (production converter 선택과 PR #69 composition 연결은 아직 없음).
3. `WeatherOverview.current` section 조립
4. current `SourceMetadata`(`sourceId`/`issuedAt`/`retrievalMode`) 조립
5. `POST /weather`로의 current 데이터 연결
6. current-observation availability-delay selector
7. 실제 인증 KMA API 호출을 통한 live 검증

이 PR이 production current 데이터를 제공한다고 표현하지 않습니다 — `POST /weather`는 이 PR 이후에도
계속 current를 missing으로 응답합니다.

## 변경 이력

```text
v1 / PR #68 / 2026-08
- PR #66 request factory와 PR #67 current-observation service를 연결하는 얇은 application facade 추가
- request/options/result/Promise pass-through 계약 정의(hourly scheduled facade와 동일 원칙)
- product 필드 없음(초단기실황은 단일 operation) — 새 nx/ny 이외 필드 없음
- production composition root, location adapter, POST /weather 연결은 이 PR 범위 밖
- 기존 hourly facade/request factory/service는 변경하지 않음, generic 공통 abstraction 없음

v2 / PR #70 / 2026-08 (첫 위경도 location facade consumer 추가; 이 facade는 불변)
- 이 facade의 공개 계약(nx/ny 입력, pass-through, Promise identity, 호출 순서) 변경 없음
- 새 location facade(createKmaLocationScheduledCurrentObservationFacade)가 이 facade를 그대로 소비
- production location composition·WeatherOverview.current·SourceMetadata·POST /weather 연결·
  availability-delay selector는 여전히 이 PR 범위 밖
```
