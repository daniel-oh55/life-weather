# KMA 위경도 시간별 fallback pipeline (location hourly fallback)

이 문서는 PR #21에서 추가한 **application-level facade**
(`createKmaLocationHourlyFallbackFacade`)와 그 **production composition**
(`createKmaLocationHourlyFallbackCompositionFromEnv`)의 책임과 경계를 기록합니다. 이 facade는 PR #12의
순수 위·경도 → KMA 격자 변환 함수를 PR #20에서 완성한 **grid fallback service**(PR #19
`KmaHourlyFallbackService`) 앞단에 두는 **얇은 adapter**일 뿐입니다 — `LOCATION` 미지원 위치 결과 하나를
제외하면 새로운 KMA 데이터 규칙·base-time·eligibility·retry 정책을 도입하지 않습니다.

이 pipeline은 PR #13의 위경도 **single-request** pipeline
([kma-location-scheduled-hourly.md](./kma-location-scheduled-hourly.md))과 **별도로 병렬 존재**합니다.
전자는 scheduled facade(호출당 Provider 최대 1회)를, 이 fallback pipeline은 fallback service(지원 위치에서
Provider 최대 2회)를 fronts한다는 점만 다릅니다.

## 목적

- 호출자가 `product`/`latitude`/`longitude`만 제공하면 primary + optional previous fallback pipeline을
  실행할 수 있도록, 위·경도 → 격자 변환과 grid fallback service 배선을 한 번에 이어 줍니다.
- 위·경도 → 격자 변환(PR #12 converter)과 fallback service(PR #19)는 **모두 주입**되며, facade는 fallback
  service의 execution-trace 결과를 **그대로** 전달합니다.
- 기존 grid/location scheduled pipeline과 PR #20 grid fallback root는 **그대로 유지**되며, 이 PR은 PR #20
  grid fallback root 앞단에 별도의 location facade/composition을 추가할 뿐입니다.

## 구현 위치

- [kma-location-hourly-fallback.ts](../apps/api/src/services/kma-location-hourly-fallback.ts) — application facade
- [kma-location-hourly-fallback.test.ts](../apps/api/src/services/kma-location-hourly-fallback.test.ts)
- [kma-location-hourly-fallback.ts (composition)](../apps/api/src/composition/kma-location-hourly-fallback.ts) — production composition
- [kma-location-hourly-fallback.test.ts (composition)](../apps/api/src/composition/kma-location-hourly-fallback.test.ts)

## 전체 pipeline

```text
caller input (product / latitude / longitude)
  → gridConverter({ latitude, longitude })                       // PR #12 (주입)
  → { nx, ny } | null
  → fallbackService.fetchHourlyForecastWithFallback(             // PR #19
       { product, nx, ny }, options)
  → request-plan factory → hourly service(primary) → classifier → optional hourly service(previous)
  → KmaHourlyFallbackServiceResult (primary + optional previous 실행 trace, 그대로 반환)
```

- 이 흐름에서 location facade는 converter와 grid fallback service를 잇는 앞단 adapter입니다.
- converter의 투영 수식([kma-grid-conversion.md](./kma-grid-conversion.md)), candidate selector·request-plan
  factory([kma-fallback-request-plan.md](./kma-fallback-request-plan.md)), primary → classifier → optional
  previous orchestration([kma-hourly-fallback.md](./kma-hourly-fallback.md)), 그리고 그것을 조립하는 grid
  fallback composition([kma-hourly-fallback-composition.md](./kma-hourly-fallback-composition.md))은 변경하지
  않습니다.

## application facade 공개 API

```ts
export type KmaLocationHourlyFallbackInput =
  KmaLocationScheduledHourlyForecastInput;

export type KmaLocationHourlyFallbackOptions =
  KmaHourlyFallbackServiceOptions;

export type KmaLocationHourlyFallbackResult =
  | KmaHourlyFallbackServiceResult
  | Extract<
      KmaLocationScheduledHourlyForecastResult,
      {
        readonly stage: 'LOCATION';
      }
    >;

export interface KmaLocationHourlyFallbackFacade {
  readonly fetchHourlyForecastWithFallbackForLocation: (
    input: KmaLocationHourlyFallbackInput,
    options?: KmaLocationHourlyFallbackOptions,
  ) => Promise<KmaLocationHourlyFallbackResult>;
}

export function createKmaLocationHourlyFallbackFacade(
  gridConverter: KmaLocationForecastGridConverter,
  fallbackService: KmaHourlyFallbackService,
): KmaLocationHourlyFallbackFacade;
```

- **input alias.** `KmaLocationHourlyFallbackInput`은 PR #13
  `KmaLocationScheduledHourlyForecastInput`(`{ product, latitude, longitude }`)의 **직접 alias**입니다 —
  두 위경도 entry point가 하나의 caller shape를 공유하므로 field를 재정의하지 않습니다.
- **options alias.** `KmaLocationHourlyFallbackOptions`는 PR #19
  `KmaHourlyFallbackServiceOptions`(`{ signal? }`)의 **직접 alias**입니다.
- **result union.** 지원 위치는 PR #19 `KmaHourlyFallbackServiceResult`를 그대로, 미지원 위치는 기존
  location scheduled result에서 `LOCATION` branch를 **`Extract`로 재사용**합니다. `UNSUPPORTED_LOCATION`
  wrapper shape나 `KmaUnsupportedLocationError`를 **재정의하지 않습니다** — 두 facade가 미지원 위치 shape에
  대해 어긋날 수 없습니다.
- converter type(`KmaLocationForecastGridConverter`)은 PR #13 정의를 그대로 재사용합니다.

## converter 주입과 production converter 선택

- converter는 **주입**됩니다. application facade는 PR #12 concrete converter를 직접 import하거나 선택하지
  않습니다.
- 실제 production converter(`convertKmaLatitudeLongitudeToGrid`) 선택은 **composition 계층의 책임**입니다
  (아래 참조).

## 실행 순서

한 번의 `fetchHourlyForecastWithFallbackForLocation(input, options)` 호출은 다음 순서로 진행됩니다.

1. grid converter를 **정확히 한 번** 호출합니다. converter input은 `latitude`/`longitude` 두 field만
   갖는 **새 object**입니다.
2. converter가 `null`을 반환하면 `LOCATION` 미지원 위치 result를 반환합니다(fallback service 미호출).
3. converter가 grid를 반환하면 `product`/`nx`/`ny` 세 field만 갖는 **새 object**로 fallback service를
   **정확히 한 번** 호출합니다. `options`는 동일 reference로 전달합니다.
4. fallback service가 반환한 Promise를 **그대로** 반환합니다.

- converter 호출은 요청당 정확히 1회입니다.
- converter가 성공(grid 반환)하면 fallback service 호출은 정확히 1회입니다.
- converter가 `null`을 반환하거나 throw하면 fallback service는 **호출되지 않습니다**.

## Provider 최대 호출 횟수 (fallback service가 소유)

한 번의 fallback service 호출 안에서 실제 Provider fetch 횟수는 PR #19 orchestration이 결정합니다.

- primary ineligible: **최대 1회** (previous 미실행).
- primary eligible(`KMA_NO_DATA` 또는 `EMPTY_HOURLY`): previous까지 **최대 2회**.
- **third attempt 없음**, previous 재분류 없음.

location facade는 fallback service를 **한 번만** 호출할 뿐, 그 안의 primary/previous 실행 정책을 다시
구현하지 않습니다.

## reference 그대로 전달 (converter input / service input / options / Promise)

- **converter input**: `{ latitude, longitude }` 두 field만 갖는 **fresh object**입니다. 원본 input을
  spread하지 않고 `product`나 그 외 property를 포함하지 않으며, input을 mutate하지 않습니다.
- **fallback service input**: `{ product, nx, ny }` 세 field만 갖는 **fresh object**입니다. 원본 input을
  spread하지 않고 `latitude`/`longitude`를 포함하지 않으며, converter result를 spread하지 않습니다.
  converter가 반환한 `nx`/`ny`는 default/swap/clamp/round/string 변환 없이 **그대로** 전달합니다.
- **options / AbortSignal**: 호출자의 options reference(그 안의 `signal` 포함)를 fallback service에 그대로
  전달합니다. options clone·새 `AbortController` 생성·signal wrapping·signal 검사를 하지 않습니다. Abort
  정책은 fallback service와 Provider가 소유합니다.
- **options 생략 시**: fallback service에 정확히 `undefined`를 전달합니다. 임의의 `{}`를 만들지 않습니다.

## 지원 위치 Promise identity 유지 (no async/await)

`fetchHourlyForecastWithFallbackForLocation`는 지원 위치일 때 fallback service가 반환한 Promise와
**동일한 reference**를 반환합니다. 이를 위해 `async` 표기·`await`·`.then`/`.catch`·`try/catch`·성공 result의
Promise wrapping을 사용하지 않습니다.

이 정책의 목적은 grid fallback service의 execution-trace·rejection 계약을 **바꾸지 않는 것**입니다:
location facade는 지원 위치에서 추가 async boundary를 만들지 않고, no-fallback trace·fallback trace·동기
throw·rejection을 어떤 형태로도 wrapping하지 않으며, collaborator가 만든 결과를 그대로 통과시킵니다.

## 결과·오류 계약

- **지원 위치 (no fallback)**: fallback service의 `{ fallbackAttempted: false, primary }`를 그대로
  반환합니다.
- **지원 위치 (fallback)**: fallback service의 `{ fallbackAttempted: true, fallbackReason, primary,
  previous }`를 그대로 반환합니다. `fallbackAttempted: true`는 previous hourly-service 호출이 **일어났다**는
  뜻이지 previous가 데이터를 담았다는 뜻이 아닙니다.
- location facade는 어느 branch에도 `locationResolved`·`grid`·`latitude`·`longitude`·`selected`·`final`·
  `fallbackUsed`·`source`·`stale`·`provider`·`request`·`plan` 같은 field를 **추가하지 않습니다**.
- **미지원 위치 (`LOCATION`)**: converter가 `null`을 반환하면 다음 result를 반환합니다.

  ```ts
  {
    ok: false,
    stage: 'LOCATION',
    error: {
      kind: 'UNSUPPORTED_LOCATION',
    },
  }
  ```

  이 result는 **값이 없는 discriminator**입니다: latitude/longitude/nx/ny/country/provider/URL/raw
  input/error message/cause/stack/service key/converter reference를 담지 않습니다. 의미는 "입력은
  converter가 처리할 수 있는 물리적으로 유효한 좌표이지만, 현재 KMA forecast grid에서 지원하지 않는다"
  뿐입니다. HTTP 상태·사용자 메시지는 이 facade에서 결정하지 않습니다.

  미지원 위치는 호출마다 **fresh Promise / fresh result object / fresh error object**를 만듭니다
  (module-level shared failure singleton 없음).

## converter throw는 동기 전파 (RangeError 포함)

PR #12 converter(또는 주입된 converter)가 throw하면:

- **동일한 error reference**가 **동기적으로** 전파됩니다.
- fallback service는 **호출되지 않습니다**.
- throw를 Promise나 `LOCATION` result로 변환하지 않고, logging도 하지 않습니다.

예: 비-number/비-finite 좌표 `RangeError`, 물리 범위 밖 `RangeError`(예 `latitude must be within
[-90, 90]`), 주입된 converter의 sentinel error. `RangeError`와 미지원 위치(`null`)를 **같은 결과로 합치지
않습니다** — `null`만 `LOCATION` result로 변환합니다. converter의 `RangeError` message는 값이 없어 raw 좌표를
노출하지 않습니다.

## 생성은 side-effect-free

`createKmaLocationHourlyFallbackFacade(gridConverter, fallbackService)`는 순수 생성입니다: converter를
호출하지 않고, fallback service를 호출하지 않으며, clock·환경변수·network를 건드리지 않고,
timer·listener·logging·mutation이 없습니다. 반환된 객체는 두 collaborator reference를 close over할 뿐 다른
상태를 갖지 않습니다. module singleton이나 cache를 만들지 않으며, 같은 instance를 반복 호출할 수 있고 각
호출은 이전 호출과 독립적입니다(반복 생성 시 facade·method reference가 서로 다름).

## production composition 공개 API

```ts
export type KmaLocationHourlyFallbackCompositionDependencies =
  KmaHourlyFallbackCompositionDependencies;

export type CreateKmaLocationHourlyFallbackCompositionResult =
  | {
      readonly ok: true;
      readonly facade: KmaLocationHourlyFallbackFacade;
    }
  | {
      readonly ok: false;
      readonly error: KmaProviderConfigError;
    };

export function createKmaLocationHourlyFallbackCompositionFromEnv(
  env?: NodeJS.ProcessEnv,
  dependencies?: KmaLocationHourlyFallbackCompositionDependencies,
): CreateKmaLocationHourlyFallbackCompositionResult;
```

- `dependencies` type은 PR #20 grid fallback composition의 dependencies(`{ fetchImpl?, clock? }`)를
  **그대로 alias**합니다. 이 PR에서 새로운 dependency option을 추가하지 않습니다.
- 성공 result는 **정확히 `ok`/`facade` 두 field만** 공개합니다. 내부 grid fallback service·grid
  converter·provider·request-plan factory·hourly service·classifier·selector·clock·env·dependencies·
  fetchImpl·serviceKey·URL을 노출하지 않습니다.

## production converter 선택과 composition 순서

composition은 PR #20 grid fallback graph를 다시 구현하지 않고 기존 composition function을 소비합니다.

1. `createKmaHourlyFallbackCompositionFromEnv(env, dependencies)`를 호출합니다(PR #20 grid fallback graph를
   그대로 재사용).
2. config failure면 즉시 **같은 `KmaProviderConfigError` reference**를 반환합니다(facade 생성 없음).
3. 성공하면 PR #12 `convertKmaLatitudeLongitudeToGrid`를 선택합니다.
4. `createKmaLocationHourlyFallbackFacade(converter, fallbackService)`를 호출합니다 —
   `fallbackComposition.service`를 **동일 reference**로 전달합니다.
5. `{ ok: true, facade }`를 반환합니다.

- PR #12 converter는 **public package surface**에서 import합니다.

  ```ts
  import { convertKmaLatitudeLongitudeToGrid } from '@life-weather/weather-core';
  ```

  private file deep import는 하지 않습니다.
- `env`와 `dependencies`는 PR #20 composition에 **그대로** 전달합니다 — clone·spread·mutation·직접 service
  key read·`process.env.KMA_SERVICE_KEY` 접근·validation 복제·fetch/clock option 복제를 하지 않습니다.
- Provider creation·service-key validation·clock 선택·request-plan factory·hourly service·classifier·
  fallback orchestration·KMA URL 생성·fetch·normalization·candidate 계산·projection 수식·retry·route는 이
  composition에서 **직접 구현하지 않습니다**(모두 기존 composition/component의 몫).

## composition 생성은 lazy

`createKmaLocationHourlyFallbackCompositionFromEnv()` 성공 호출은 Provider configuration을 읽고 PR #20
grid fallback graph와 location facade closure를 만들 뿐입니다. 다음은 **실행하지 않습니다**: converter
실행, `Date.now` 실행, 주입된 clock 실행, network fetch, request-plan 생성, primary/previous 실행,
classifier 실행, timer/listener, logging, route 등록, global mutation. 실제 converter·clock·fetch는 facade
method 호출 시에만 실행됩니다. config failure 시에는 converter·clock·fetch·location facade construction이
모두 0회이고 PR #20 composition의 `KmaProviderConfigError` 동일 reference가 그대로 전달됩니다.

같은 `env`/`dependencies`로 두 번 호출하면 wrapper·facade·method reference가 모두 서로 다르며, 한 graph
실행이 다른 graph 결과를 재사용하지 않습니다(module-level singleton·cache 없음).

## full in-memory pipeline 테스트

composition 테스트는 network(주입된 in-memory `fetchImpl`)와 결정적 instant가 필요한 clock(주입된 fake
clock)을 제외한 **모든 실제 component**를 사용합니다: PR #12 converter, PR #20 grid fallback composition,
provider-from-env, request-plan factory, PR #16 candidate selector, hourly service, hourly normalizer,
PR #17 classifier, PR #19 fallback orchestration, location fallback facade. 서울 좌표
`{ latitude: 37.5665, longitude: 126.978 }`가 PR #12 기대 grid `{ nx: 60, ny: 127 }`로 투영되고, clock
`2026-07-22T05:10:00.000+09:00`에서 production selector가 SHORT candidate pair `0500 → 0200`을 고릅니다.

- **지원 서울 no-fallback**: primary 0500 complete → `fallbackAttempted: false`, clock 1회, fetch 1회.
- **지원 서울 EMPTY_HOURLY fallback**: primary 0500 empty → previous 0200 complete, `fallbackAttempted:
  true`, fetch 2회(0500 → 0200), third fetch 없음.
- **지원 서울 KMA_NO_DATA fallback**: primary upstream `03` → previous 0200 success, fetch 2회.
- **미지원 위치**: Null Island `{ 0, 0 }`는 `LOCATION`/`UNSUPPORTED_LOCATION`, clock/fetch 0회.
- **invalid 위치**: NaN 위도·Infinity 경도·위도 91·경도 181은 converter `RangeError` 동기 throw, clock/fetch
  0회.
- **pre-aborted**: 서울 좌표 + 사전 abort된 signal → primary `PROVIDER`/`ABORTED`, clock 1회, fetch 0회.

## 보안 경계

- **미지원 위치(`LOCATION`) / no-fallback trace / fallback trace / `RangeError` message / `console.*`**
  어디에도 raw 좌표·격자·KMA body·URL·service key·`resultMsg`·secret marker가 나타나지 않습니다.
- 실제 `KMA_SERVICE_KEY`를 사용하지 않고, 자동 테스트는 실제 네트워크를 호출하지 않습니다.
- runtime은 logging하지 않습니다.

## 이 PR의 범위 밖

- **HTTP route / `/weather` / query schema / URL query parsing / HTTP status·envelope mapping** — 없음.
- **`apps/api/src/index.ts` wiring / server startup** — 없음(composition은 존재하나 route/startup 미연결).
- **primary/previous 최종 선택 / result merge / `fallbackUsed` API field** — 이 facade에는 **없음**.
  facade는 계속 PR #19 execution trace(또는 `LOCATION` branch)를 그대로 반환합니다. PR #22에서 primary/
  previous/none을 고르는 **순수 selector**(`selectKmaHourlyFallbackResult`,
  [kma-hourly-fallback-selection.md](./kma-hourly-fallback-selection.md))가, PR #23에서 그 selection을
  hourly-only `WeatherOverview`로 조립하는 **순수 assembler**(`assembleKmaHourlyWeatherOverview`,
  [kma-hourly-weather-overview.md](./kma-hourly-weather-overview.md))가 추가됐지만, 둘 다 **facade에 아직
  내장되지 않았습니다** — selector도 assembler도 이 facade가 반환하는 `LOCATION` branch를 **직접 처리하지
  않습니다.** 책임 분담은 다음과 같습니다: 후속 application service가 먼저 `LOCATION` branch를 narrow하고,
  성공적으로 grid로 변환된 뒤 반환된 `KmaHourlyFallbackServiceResult` trace를 selector로 변환한 다음, 그
  selection을 PR #23 assembler에 전달합니다. facade의 공개 API·Promise identity·unsupported/invalid
  location 처리는 **불변**입니다(facade는 selection도 assembly도 수행하지 않음).
- **기존 facade/composition 교체** — 없음(추가만 함). 기존 grid/location scheduled pipeline과 PR #20 grid
  fallback root의 runtime·API는 불변입니다.
- **grid converter 수식·candidate selector·request-plan factory·classifier·orchestration 변경** — 없음.
- **`WeatherOverview` / `SourceMetadata` / `CurrentWeather` / `DailyForecast`** — 없음.
- **cache / stale-data / live availability guarantee** — 없음.
- **AirKorea / mobile / 신규 dependency** — 없음.
- **실제 ServiceKey live 호출** — 수행하지 않음.

## facade consumer (PR #24)

PR #24에서 이 facade의 **application-service consumer**
(`createKmaLocationHourlyOverviewService`)가 추가됐습니다. 그 service는:

1. `KmaLocationHourlyFallbackResult`의 top-level `LOCATION` branch를 narrow해 facade 결과를 **그대로
   통과**(passthrough)시키고(overview/selection/좌표 추가 없음),
2. 지원되는 `KmaHourlyFallbackServiceResult` trace는 PR #22 selector(`selectKmaHourlyFallbackResult`)로,
3. 그 결과를 PR #23 assembler(`assembleKmaHourlyWeatherOverview`)로 연결합니다.

이 facade의 공개 API·Promise contract(supported location에서 fallback service Promise 그대로 반환,
converter 동기 throw 전파, `LOCATION` 값-free discriminator)는 PR #24로 **불변**입니다. selector·resolver·
assembler는 여전히 facade에 내장되지 않고 application service가 facade **바깥에서** 순서대로 호출합니다.

## 후속 범위

primary/previous selection policy(PR #22)·hourly-only `WeatherOverview` assembler(PR #23)·location
fallback facade/composition(PR #21)·PR #20 grid fallback wiring·이들을 `LOCATION` narrow와 함께 엮는
application service(PR #24)는 모두 구현 완료 상태입니다. 남은 책임:

1. selected source provenance resolver의 production 구현.
2. PR #24 application service의 production composition wiring.
3. `/weather` route와 HTTP status mapping.
4. cache / stale-data 정책.
5. authenticated KMA E2E verification.

## 변경 이력

```text
v1 / PR #21 / 2026-07
- location fallback facade 추가
- PR #12 converter + PR #19 fallback service 연결
- PR #20 grid fallback composition을 재사용하는 location production root 추가
- 기존 scheduled roots·PR #20 grid fallback root 불변
- route/result assembly/cache 제외

v2 / PR #22 / 2026-07 (execution trace selector 별도 구현; 이 facade는 불변)
- PR #22 selectKmaHourlyFallbackResult는 LOCATION branch가 아닌 successful location trace에만 적용
- location facade 공개 API·Promise identity·unsupported/invalid location 처리 불변
- selector는 facade에 내장되지 않음(후속 assembler가 LOCATION narrow 후 소비)
- route/result assembly/cache는 여전히 제외

v3 / PR #23 / 2026-07 (hourly WeatherOverview assembler 별도 구현; 이 facade는 불변)
- PR #23 assembleKmaHourlyWeatherOverview는 LOCATION branch가 아닌 successful trace의 selection에만 적용
- assembler도 selector도 facade에 내장되지 않음(후속 application service가 LOCATION narrow → selector →
  assembler 순으로 호출)
- location facade 공개 API·Promise identity·unsupported/invalid location 처리 불변
- route/production integration/cache는 여전히 제외

v4 / PR #24 / 2026-07 (application-service consumer 추가; 이 facade는 불변)
- PR #24 createKmaLocationHourlyOverviewService가 이 facade를 consumer로 추가
- top-level LOCATION result는 그대로 통과(passthrough); 지원 trace는 selector/assembler로 연결
- facade 공개 API·Promise contract·unsupported/invalid location 처리 불변
- selector/resolver/assembler는 facade 바깥에서 호출(facade에 내장되지 않음)
- production resolver/composition·route/cache는 여전히 제외
```
