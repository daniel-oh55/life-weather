# KMA forecast request factory (injected clock)

이 문서는 PR #9에서 추가한 **application-level request factory**
(`createKmaForecastRequestFactory`)의 책임과 경계를 기록합니다. 이 factory는 새로운 KMA 데이터
규칙을 도입하지 않습니다 — 주입된 clock의 현재시각, PR #8의 발표시각 selector, 호출자가 이미 계산한
격자 좌표(nx/ny)를 하나의 완성된 `KmaForecastRequest`로 **조립**할 뿐입니다.

구현 위치:

- [kma-forecast-request.ts](../apps/api/src/services/kma-forecast-request.ts) — request factory
- [kma-forecast-request 테스트](../apps/api/src/services/kma-forecast-request.test.ts)

## 목적

- **주입된 clock**의 현재시각(절대 epoch milliseconds)과 PR #8 selector
  (`selectLatestKmaForecastBaseTime`)를 사용해 최신 **공식 발표 예정시각**(`baseDate`/`baseTime`)을
  고르고, 호출자가 공급한 `product`/`nx`/`ny`와 결합해 완성된 `KmaForecastRequest`를 만듭니다.

## 현재 pipeline에서의 위치

```text
injected clock
  → reference epoch milliseconds
  → selectLatestKmaForecastBaseTime (PR #8)   // baseDate / baseTime
  → caller-supplied product / nx / ny 결합
  → 완성된 KmaForecastRequest
```

이 factory는 요청 **조립까지만** 담당합니다. Provider 호출, hourly service 자동 연결, PR #12
converter를 소비해 위경도를 nx/ny로 바꾸는 adapter 연결, API availability delay, retry/fallback,
HTTP route는 이 factory에 포함하지 않습니다. 변환 함수 자체는 PR #12에서 이미 존재하며, 이를 소비해
lat/lon을 nx/ny로 바꾸는 adapter는 **PR #13의 location facade**(이 factory 밖, 앞단)가 담당합니다 —
factory 계약은 그대로입니다. 나머지(availability delay, retry/fallback, HTTP route)는 여전히 후속 PR입니다.

## 공개 API

```ts
export interface KmaForecastRequestClock {
  readonly nowEpochMilliseconds: () => number;
}

export interface KmaForecastRequestFactoryInput {
  readonly product: KmaForecastProduct;
  readonly nx: number;
  readonly ny: number;
}

export interface KmaForecastRequestFactory {
  createScheduledRequest(
    input: KmaForecastRequestFactoryInput,
  ): KmaForecastRequest;
}

export function createKmaForecastRequestFactory(
  clock: KmaForecastRequestClock,
): KmaForecastRequestFactory;
```

메서드 이름이 `createScheduledRequest`인 이유: 최신 공식 **발표 schedule**을 사용하지만, 해당 API
자료가 실제로 준비됐음(availability)을 보장하지 않기 때문입니다. `available`/`ready`가 아니라
`scheduled`라는 이름으로 이 구분을 유지합니다.

## injected clock contract

clock은 **외부에서 주입**하며, factory는 시스템 clock을 직접 읽지 않습니다.

- `nowEpochMilliseconds()`는 현재 instant를 **절대 epoch milliseconds(UTC)** 로 반환합니다.
- **factory 생성 시 clock을 호출하지 않습니다**(side-effect-free 생성).
- `createScheduledRequest()`를 호출할 때마다 clock을 **정확히 한 번** 호출합니다.
- clock callback에는 **argument를 전달하지 않습니다.**
- 한 호출에서 얻은 epoch value를 selector에 **그대로** 전달합니다 — 반올림·truncate·보정·coercion을
  하지 않고, 같은 호출에서 clock을 두 번 읽지 않습니다.

이 clock 주입 스타일은 selector가 `referenceEpochMilliseconds`를 입력으로 받고 시스템 clock을 읽지
않는 것과 동일한 결정론성 원칙입니다: selector 자체도 clock을 읽지 않고, factory도 시스템 clock을
직접 읽지 않으며, "현재 시각"의 단일 출처는 주입된 clock뿐입니다.

## 생성은 side-effect-free

`createKmaForecastRequestFactory(clock)`는 순수 생성입니다: clock을 호출하지 않고, selector를 호출하지
않으며, 환경변수를 읽지 않고, I/O·timer·listener를 만들지 않습니다. 반환된 객체는 `clock`을 close
over할 뿐입니다. 같은 instance를 여러 번 사용할 수 있고, mutable state를 갖지 않으며, 각 호출은 이전
호출의 결과·기록과 무관합니다.

## PR #8 selector 사용

- 발표시각 선택 규칙(SHORT `0200/…/2300`, ULTRA `HH30`, 고정 KST(UTC+09:00) 계산, 전일 rollover)은
  전적으로 `@life-weather/weather-core`의 `selectLatestKmaForecastBaseTime`가 소유합니다
  ([kma-issue-time.md](./kma-issue-time.md)).
- factory는 그 selector를 요청당 **정확히 한 번** 호출하는 단순 조립 계층입니다. SHORT/ULTRA
  schedule 배열, KST offset, baseDate/baseTime 계산, issue-time 경계 로직을 **복제하지 않습니다.**
- production 코드에 selector mock을 주입하지 않으며, 10/15분 safety delay를 넣지 않습니다.

## 요청 조립

결과는 기존 `KmaForecastRequest`이며 정확히 다섯 필드만 포함합니다.

```ts
{
  product,   // caller-supplied
  baseDate,  // selector 결과
  baseTime,  // selector 결과
  nx,        // caller-supplied
  ny,        // caller-supplied
}
```

- 필드는 명시적으로 작성하며 **input 전체를 object spread로 반환하지 않습니다.** runtime에서 추가
  property가 들어와도 결과에 유출되지 않고, 요청 shape가 고정되며, secret-shaped extra property가
  노출되지 않습니다.
- 결과에는 다음을 넣지 않습니다: `referenceEpochMilliseconds`, clock, availability 상태, retry
  count, fallback 여부, URL, ServiceKey, Provider metadata, raw input object, 그 밖의 임의 property.

## fresh output / 불변성

- 매 호출마다 **새로운 request 객체**를 반환합니다.
- input을 읽기만 하고 **mutate하지 않으며**, frozen input에서도 동작합니다.
- 첫 결과를 runtime cast로 mutate해도 이후 호출 결과에 영향이 없습니다.
- 같은 input과 같은 clock value에 대해 deep-equal 결과를 반환하되, 반환 reference는 서로 다릅니다.
- SHORT와 ULTRA를 번갈아 호출해도 state가 누적되지 않습니다.

## nx/ny는 이미 계산돼 있어야 함

- 이 request factory는 계속 **nx/ny를 직접 입력받습니다.** 위·경도 → 격자 변환은 이 factory가
  하지 않으며, PR #12의 순수 converter(`convertKmaLatitudeLongitudeToGrid`)는 **별도 `weather-core`
  함수**입니다 — factory는 그것을 호출하지 않고 latitude/longitude를 직접 변환하지도 않습니다. 둘을
  잇는 연결은 **PR #13의 location facade**(`createKmaLocationScheduledHourlyForecastFacade`)가 담당합니다:
  그 adapter가 lat/lon을 converter로 `nx/ny`에 바꾼 뒤 scheduled facade → request factory 경로에
  공급합니다. 그래도 **이 factory의 입력 shape와 공개 API는 변경되지 않습니다**(계속 `product`/`nx`/`ny`
  만 받음, [kma-location-scheduled-hourly.md](./kma-location-scheduled-hourly.md)).
- factory는 valid·typed 격자 좌표가 공급된다고 가정하고, nx/ny를 변환·반올림·문자열화·기본값
  적용·swap·clamp하지 않습니다.
- **runtime trust-boundary validation은 Provider가 계속 소유합니다.** factory는
  `validateKmaForecastRequest`를 다시 호출하지 않습니다 — validation을 중복하지 않고 새로운 error
  union도 만들지 않습니다. (Provider를 직접 사용하는 caller를 위해 그 validator는 독립적으로 유지됩니다.)

## 오류 전파 (selector/clock 오류 그대로)

이 factory는 새로운 result union도, 새로운 오류 type도 만들지 않습니다.

- **selector 오류**: PR #8의 `RangeError`(invalid epoch milliseconds, unsupported product, 지원 연도
  범위 밖, 최종 선택 base year 범위 밖)를 catch하거나 다른 오류로 wrapping하지 않고 **그대로**
  전파합니다.
- **clock 오류**: 주입된 clock이 throw하면 **동일한 error reference**가 그대로 전파됩니다.
- 광범위한 `try/catch`, `INTERNAL_ERROR`/`UNKNOWN`/`CLOCK_ERROR` 같은 invented 오류, 오류 메시지
  재작성, raw input 추가, logging을 하지 않습니다. programmer/configuration collaborator 오류를 임의
  domain result로 숨기지 않습니다.

unsupported product의 경우에도 clock은 해당 request에서 **정확히 한 번** 호출됩니다(selector가 epoch을
먼저 검증한 뒤 product를 거부).

## 시스템 clock 직접 사용 없음

- `Date.now()`·`new Date()`·`performance.now()`·`process.hrtime()`·`process.env`·global clock·기본
  clock fallback·timer·fake timer runtime을 사용하지 않습니다.
- clock은 오직 주입으로만 제공됩니다.

## 발표 schedule과 API availability 구분

- factory는 최신 **공식 발표 예정시각(scheduled issuance)** 만 선택합니다.
- 해당 자료가 공공데이터 API에 이미 준비됐는지는 **보장하지 않습니다.**
- 따라서 publication delay/safety margin, retry, fallback, live availability probe를 추가하지
  않습니다. 활용가이드의 `API 제공 시간`(단기 `~02:10`, 초단기 `~HH45`) 반영은 후속 orchestration
  정책의 몫입니다.

> **PR #14 갱신.** 위 `API 제공 시간`(단기 +10분·초단기 +15분)을 반영하는 순수 selector
> (`selectLatestKmaForecastBaseTimeAfterAvailabilityDelay`, [kma-api-availability-time.md](./kma-api-availability-time.md))가
> PR #14에서 `weather-core`에 추가됐습니다. 다만 이 factory는 계속 PR #8
> `selectLatestKmaForecastBaseTime`만 호출하며, method 이름도 `createScheduledRequest` 그대로입니다 —
> PR #14 신규 selector는 아직 이 factory에 **주입/사용되지 않습니다.** 따라서 이 factory의 공개 API는
> availability를 보장하지 않으며(계속 scheduled issuance만 선택), availability-delay selector를 소비하는
> 별도 availability-aware request factory 또는 명시적 wiring은 다음 PR에서 검토합니다.

## Provider 자동 연결 없음 / hourly service 연결은 PR #10 facade가 담당

- factory는 Provider를 생성·호출하지 않습니다.
- factory output도 Provider에서 기존과 동일하게 runtime validate됩니다(schedule selection과 Provider
  validation의 책임 구분 유지 — [kma-http-provider.md](./kma-http-provider.md)).
- factory → hourly service 연결은 PR #10의 **scheduled facade**
  (`createKmaScheduledHourlyForecastFacade`, [kma-scheduled-hourly-facade.md](./kma-scheduled-hourly-facade.md))가
  담당합니다: facade가 이 factory의 `createScheduledRequest` output을 그대로 hourly service의
  `fetchHourlyForecast`에 전달합니다([kma-hourly-service.md](./kma-hourly-service.md)). 이 factory
  **자체의 계약(injected clock 정확히 1회, selector 1회, product/baseDate/baseTime/nx/ny만 반환)은
  변경되지 않았습니다.**
- 실제 production clock과 factory 조립은 PR #11의 **production composition root**
  (`createKmaScheduledHourlyCompositionFromEnv`)에서 구현되었습니다. 이 factory 자체는 계속 system
  clock을 직접 읽지 않고 주입된 clock만 사용하며, facade도 production dependency를 직접 만들지
  않습니다. composition root는 아직 API app startup이나 route에는 연결되지 않았습니다.

## 실제 key·외부 네트워크 테스트 없음

- 실제 `KMA_SERVICE_KEY`를 사용하지 않았습니다.
- 자동 테스트는 실제 네트워크를 호출하지 않고, 실제 selector와 작은 in-memory clock callback만
  사용합니다. Provider를 생성·mock하지 않고, fake timer를 사용하지 않습니다.

## 후속 wiring

1. ~~factory와 hourly service를 연결하는 application facade~~ — **PR #10에서 완료**
   (`createKmaScheduledHourlyForecastFacade`, [kma-scheduled-hourly-facade.md](./kma-scheduled-hourly-facade.md)).
2. ~~system clock adapter와 production composition root~~ — **PR #11에서 완료**
   (`createKmaSystemClock`·`createKmaScheduledHourlyCompositionFromEnv`,
   [kma-production-composition.md](./kma-production-composition.md)). composition이 default system
   clock 또는 injected clock을 이 factory에 **제공**합니다 — factory 자체는 여전히 system clock을
   직접 읽지 않고 주입된 clock만 사용하며, 그 계약은 변경되지 않았습니다. 실제 route 연결은 아직
   없습니다.
3. ~~latitude/longitude 입력을 PR #12 converter(`convertKmaLatitudeLongitudeToGrid`)로 `nx/ny`로
   변환해 이 request factory와 연결하는 application adapter~~ — **PR #13에서 완료**(location facade가
   lat/lon을 converter로 변환한 뒤 scheduled facade → request factory 경로에 공급, factory 계약 불변,
   [kma-location-scheduled-hourly.md](./kma-location-scheduled-hourly.md)).
4. ~~공식 API 제공 지연(단기 +10분·초단기 +15분)을 반영하는 순수 selector~~ — **PR #14에서 별도
   함수로 완료**(`selectLatestKmaForecastBaseTimeAfterAvailabilityDelay`,
   [kma-api-availability-time.md](./kma-api-availability-time.md)). 이 factory는 아직 그 selector를
   주입하지 않으며(계속 PR #8 `selectLatestKmaForecastBaseTime` 사용), 소비하는 availability-aware
   request factory/wiring은 후속 PR입니다.
5. availability-delay selector를 소비하는 request factory/wiring과 live availability fallback/retry 정책
6. `WeatherOverview`/`SourceMetadata` 조립
7. `/weather` API route

## 변경 이력

```text
v1 / PR #9 / 2026-07
- injected clock 기반 KMA forecast request factory 추가
- PR #8 issue-time selector와 nx/ny 결합
- scheduled issuance와 API availability 책임 분리 유지

v2 / PR #11 / 2026-07 (production composition에서 소비)
- PR #11 composition이 default system clock(createKmaSystemClock) 또는 injected clock을 이 factory에
  제공
- factory 자체는 계속 system clock을 직접 읽지 않으며, injected clock 사용 계약 유지
- factory 공개 API 변경 없음, route 미연결

v3 / PR #14 / 2026-07 (availability-delay selector는 별도, 이 factory는 불변)
- PR #14가 weather-core에 순수 availability-delay selector를 추가했으나, 이 factory는 계속 PR #8
  selectLatestKmaForecastBaseTime만 사용(method 이름 createScheduledRequest 유지)
- PR #14 신규 selector는 아직 이 factory에 주입/사용되지 않음(공개 API·runtime 변경 없음)
```
