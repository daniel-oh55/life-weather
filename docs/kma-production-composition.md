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
- **timeout/max-response composition override** — 없음(Provider 기본 정책 유지).
- **`WeatherOverview`/`SourceMetadata`/`CurrentWeather`/`DailyForecast`/response envelope** — 없음.
- **별도 general config package** — 여전히 미구현(composition은 이 계층과 무관).

## 후속 범위

1. 이 composition root(및 PR #13 location composition)를 소비하는 `/weather` route 계약과 query
   validation.
2. HTTP status mapping.
3. live availability fallback/retry(publication-in-progress·empty-data 대응).
4. `WeatherOverview`/`SourceMetadata` 조립.
5. cache/stale-data 정책.

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
```
