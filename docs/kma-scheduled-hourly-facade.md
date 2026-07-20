# KMA 예정 시간별 예보 facade (scheduled hourly facade)

이 문서는 PR #10에서 추가한 **application-level facade**
(`createKmaScheduledHourlyForecastFacade`)의 책임과 경계를 기록합니다. 이 facade는 새로운 KMA 데이터
규칙이나 오류 정책을 도입하지 않습니다 — 이미 존재하는 두 component(PR #9 request factory, PR #7
hourly service)를 순서대로 연결하는 **얇은 연결 계층**일 뿐입니다.

구현 위치:

- [kma-scheduled-hourly-forecast.ts](../apps/api/src/services/kma-scheduled-hourly-forecast.ts) — facade
- [kma-scheduled-hourly-forecast 테스트](../apps/api/src/services/kma-scheduled-hourly-forecast.test.ts)

## 목적

- 호출자가 매번 "request factory 호출 → 완성된 request → hourly service 호출"을 직접 배선하지 않도록,
  `product`/`nx`/`ny` 입력에서 `KmaHourlyForecastServiceResult`까지 한 번에 이어 줍니다.
- 두 collaborator(PR #9 request factory, PR #7 hourly service)는 **모두 주입**되며, facade는 그 둘의
  결과·오류 계약을 **그대로** 전달합니다.

## 현재 pipeline에서의 위치

```text
caller input (product / nx / ny)
  → requestFactory.createScheduledRequest(input)   // PR #9
  → 완성된 KmaForecastRequest
  → hourlyService.fetchHourlyForecast(request, options)   // PR #7
  → KmaHourlyForecastServiceResult (그대로 반환)
```

selector → request factory → **scheduled facade** → hourly service 순서에서, facade는 factory와
service를 잇는 마지막 연결 고리입니다. request factory 내부의 selector 소비
([kma-issue-time.md](./kma-issue-time.md), [kma-forecast-request-factory.md](./kma-forecast-request-factory.md))와
hourly service 내부의 Provider/normalizer 배선([kma-hourly-service.md](./kma-hourly-service.md))은
변경하지 않습니다.

## 공개 API

```ts
export type KmaScheduledHourlyForecastInput =
  KmaForecastRequestFactoryInput;

export type KmaScheduledHourlyForecastOptions =
  KmaHourlyForecastServiceOptions;

export type KmaScheduledHourlyForecastResult =
  KmaHourlyForecastServiceResult;

export interface KmaScheduledHourlyForecastFacade {
  fetchScheduledHourlyForecast(
    input: KmaScheduledHourlyForecastInput,
    options?: KmaScheduledHourlyForecastOptions,
  ): Promise<KmaScheduledHourlyForecastResult>;
}

export function createKmaScheduledHourlyForecastFacade(
  requestFactory: KmaForecastRequestFactory,
  hourlyService: KmaHourlyForecastService,
): KmaScheduledHourlyForecastFacade;
```

- input/options/result type은 별도로 재설계하지 않고 기존 factory·service의 type을 **type alias로
  재사용**합니다. 따라서 facade의 입출력 shape는 두 collaborator와 결코 어긋날 수 없습니다.
- 새로운 result union도, 새로운 facade error type도 만들지 않습니다.

## 두 injected collaborator

```ts
createKmaScheduledHourlyForecastFacade(
  requestFactory: KmaForecastRequestFactory,   // PR #9
  hourlyService: KmaHourlyForecastService,      // PR #7
);
```

- 두 collaborator는 **주입**됩니다. facade는 Provider를 생성하지 않고, request factory나 hourly
  service를 내부에서 새로 만들지 않으며, global singleton도 만들지 않습니다.
- 실제 production 인스턴스(system clock adapter, Provider-from-env)를 조립하는 일은 이 facade의
  책임이 아닙니다. 이 조립은 PR #11의 별도 production composition root
  (`createKmaScheduledHourlyCompositionFromEnv`)가 담당하며, 해당 composition은 아직 API app
  startup이나 route에는 연결되지 않았습니다.

## facade 생성은 side-effect-free

`createKmaScheduledHourlyForecastFacade(requestFactory, hourlyService)`는 순수 생성입니다: request
factory를 호출하지 않고, hourly service를 호출하지 않으며, clock·환경변수를 읽지 않고, I/O·`fetch`·
timer·listener를 만들지 않습니다. 반환된 객체는 두 collaborator reference를 close over할 뿐 다른
상태를 갖지 않습니다. 같은 instance를 여러 번 호출할 수 있고, 각 호출은 이전 호출의 성공·실패·
request·result와 무관합니다.

## 호출 순서 계약 (request factory → hourly service)

한 번의 `fetchScheduledHourlyForecast()` 호출은 다음 순서로 진행됩니다.

1. `requestFactory.createScheduledRequest(input)`를 **정확히 한 번** 호출한다.
2. 반환된 request를 로컬 변수에 담는다.
3. `hourlyService.fetchHourlyForecast(request, options)`를 **정확히 한 번** 호출한다.
4. hourly service가 반환한 Promise를 그대로 반환한다.

- factory 호출은 요청당 정확히 1회입니다.
- factory가 성공하면 service 호출은 정확히 1회입니다.
- factory가 throw하면 service는 **호출되지 않습니다**(아래 오류 경계 참조).

## reference 그대로 전달 (input / request / options / AbortSignal)

facade는 어떤 값도 복제·spread·mutate하지 않고 reference를 그대로 넘깁니다.

- **input**: 호출자의 input object reference를 request factory에 그대로 전달합니다. clone·object
  spread·destructuring 후 재조립·product/nx/ny 변환·validation·기본값 적용을 하지 않습니다.
- **request**: request factory가 반환한 `KmaForecastRequest` reference를 hourly service에 그대로
  전달합니다. clone·spread·mutation·재검증·baseDate/baseTime/nx/ny 변경을 하지 않습니다.
- **options / AbortSignal**: 호출자의 options reference(그 안의 `signal` 포함)를 hourly service에
  그대로 전달합니다. options clone·새 `AbortSignal` 생성·signal wrapping·default options 객체 생성·
  options mutation을 하지 않습니다.
- **options 생략 시**: hourly service에 정확히 `undefined`를 전달합니다. 임의의 `{}`를 만들지
  않습니다.

## Promise identity 유지 (no async/await)

`fetchScheduledHourlyForecast`는 hourly service가 반환한 Promise와 **동일한 reference**를
반환합니다. 이를 위해 다음을 사용하지 않습니다.

- 메서드에 `async` 표기
- `await`
- `.then` / `.catch` / `.finally`
- `Promise.resolve` / 새 Promise 생성

이 정책의 목적은 기존 service의 결과·오류 계약을 **바꾸지 않는 것**입니다: facade는 추가 async
boundary를 만들지 않고, 성공·실패·rejection을 어떤 형태로도 wrapping하지 않으며, collaborator가
만든 결과를 그대로 통과시킵니다.

## 결과 pass-through

hourly service의 result union을 그대로 반환합니다.

- **success**: `{ ok: true, hourly }`를 그대로 반환합니다. 배열 clone·raw data 추가 없음.
- **Provider-stage 실패**: `{ ok: false, stage: 'PROVIDER', error }`를 그대로 반환합니다. stage
  변경 없음, error reference 그대로. normalization stage로 변환하지 않습니다.
- **Normalization-stage 실패**: `{ ok: false, stage: 'NORMALIZATION', issues }`를 그대로
  반환합니다. issues 배열·issue object reference 그대로. Provider stage로 변환하지 않습니다.

새로운 facade stage나 새로운 error 종류를 추가하지 않습니다.

## 오류 경계 (factory throw / service throw·rejection)

facade는 새로운 result union도, 새로운 error type도 만들지 않으며, 광범위한 `try`/`try...catch`를
추가하지 않습니다.

- **request factory throw**: factory가 동기적으로 throw하면(예 injected clock의 invalid epoch
  `RangeError`, unsupported product `RangeError`, clock collaborator가 던진 오류) **동일한 error
  reference**가 그대로 전파되고, hourly service는 호출되지 않습니다.
- **clock/selector 오류**: 이 오류들은 request factory가 소유하며, factory를 통해 그대로 전파됩니다
  (facade는 clock을 직접 읽지 않습니다).
- **hourly service 동기 throw**: 동일한 error reference가 그대로 전파됩니다.
- **hourly service rejected Promise**: 동일한 Promise가 facade에서 반환되고, rejection을 가로채거나
  변환하지 않습니다.

`INTERNAL_ERROR`/`FACADE_ERROR`/`REQUEST_FACTORY` 같은 invented stage, `UNKNOWN`, 오류 메시지
재작성, raw input 직렬화, logging을 하지 않습니다.

## 상태와 불변성

- global mutable state·call counter·cache·last request/result 저장이 없습니다.
- input·options·request·service result를 mutate하지 않습니다.
- 같은 facade instance를 반복 호출할 수 있으며, 각 호출은 독립적입니다(반복 호출 시 request/result
  교차 없음).

## 이 PR의 범위 밖

이 facade는 연결만 담당합니다. 다음은 구현하지 않습니다(후속 PR).

- **system clock adapter** — 없음.
- **`Date.now()` 기반 default clock** — 없음(clock은 request factory에 주입되는 collaborator의 몫).
- **Provider 생성** — 없음(`createKmaForecastProviderFromEnv` 호출 없음).
- **environment variable / ServiceKey** — 읽지 않음.
- **HTTP route** — 없음.
- **위경도 → KMA grid(nx/ny) 변환** — 이 facade에는 없음(계속 `product`/`nx`/`ny`만 받음). PR #13은
  이 facade **앞단**에 별도의 location facade(`createKmaLocationScheduledHourlyForecastFacade`)를
  adapter로 추가해 위·경도를 격자로 바꾼 뒤 이 facade에 넘깁니다. 즉 이 grid facade가 lat/lon 변환
  책임을 얻은 것이 아니며, 이 facade의 공개 API와 입력 shape는 **변경되지 않습니다**
  ([kma-location-scheduled-hourly.md](./kma-location-scheduled-hourly.md)).
- **API availability delay / safety margin** — 없음.
- **retry / fallback / cache / stale data** — 없음.
- **`WeatherOverview` / `SourceMetadata` / `CurrentWeather` / `DailyForecast` 조립** — 없음.
- **production composition root** — **PR #11에서 구현 완료**
  ([kma-production-composition.md](./kma-production-composition.md)). facade는 두 collaborator를
  연결만 하며 Provider·env·system clock을 직접 만들지 않습니다. 실제 production 인스턴스(system clock
  adapter, Provider-from-env wiring, live facade graph)는 PR #11의 composition root
  (`createKmaScheduledHourlyCompositionFromEnv`)가 생성합니다 — 이는 **호출 가능한 function**이며
  module singleton이 아니고, 아직 어떤 route에도 연결되지 않았습니다.

## 실제 key·외부 네트워크 테스트 없음

- 실제 `KMA_SERVICE_KEY`를 사용하지 않았습니다.
- 자동 테스트는 실제 네트워크를 호출하지 않고, 실제 Provider나 실제 request factory 구현을 함께
  호출하지 않습니다. facade의 wiring 계약만 검증하므로 작은 fake collaborator(`vi.fn`, sentinel
  request/result, controlled Promise, frozen input/options)만 사용합니다. fake timer·environment·
  system clock을 사용하지 않습니다.

## 후속 범위

1. ~~system clock adapter와 production composition root~~ — **PR #11에서 완료**
   (`createKmaSystemClock`·`createKmaScheduledHourlyCompositionFromEnv`,
   [kma-production-composition.md](./kma-production-composition.md)).
2. ~~위경도 → KMA grid(nx/ny) 변환~~ — 순수 변환은 **PR #12에서 완료**
   ([kma-grid-conversion.md](./kma-grid-conversion.md)), 이를 이 facade 앞단에 잇는 location adapter는
   **PR #13에서 완료**([kma-location-scheduled-hourly.md](./kma-location-scheduled-hourly.md)).
3. API availability fallback/retry 정책.
4. `WeatherOverview`/`SourceMetadata` 조립.
5. `/weather` API route.

## 변경 이력

```text
v1 / PR #10 / 2026-07
- scheduled request factory와 hourly service를 연결하는 application facade 추가
- request/options/result/Promise pass-through 계약 정의
- production composition root와 system clock adapter는 후속 PR로 분리

v2 / PR #11 / 2026-07 (production composition root 추가)
- PR #11 composition root(createKmaScheduledHourlyCompositionFromEnv)가 live facade graph를 생성
- facade 자체는 Provider·env·system clock을 직접 만들지 않음(계약 변경 없음)
- composition은 호출 가능한 function이며 module singleton 없음, route 미연결
```
