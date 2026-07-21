# KMA 위경도 예정 시간별 예보 facade (location scheduled hourly facade)

이 문서는 PR #13에서 추가한 **application-level facade**
(`createKmaLocationScheduledHourlyForecastFacade`)와 그 **production composition**
(`createKmaLocationScheduledHourlyCompositionFromEnv`)의 책임과 경계를 기록합니다. 이 facade는 PR #12의
순수 위·경도 → KMA 격자 변환 함수를 PR #10 scheduled hourly facade 앞단에 두는 **얇은 adapter**일
뿐입니다 — `LOCATION` 미지원 위치 결과 하나를 제외하면 새로운 KMA 데이터 규칙이나 오류 정책을
도입하지 않습니다.

구현 위치:

- [kma-location-scheduled-hourly-forecast.ts](../apps/api/src/services/kma-location-scheduled-hourly-forecast.ts) — application facade
- [kma-location-scheduled-hourly-forecast 테스트](../apps/api/src/services/kma-location-scheduled-hourly-forecast.test.ts)
- [kma-location-scheduled-hourly.ts](../apps/api/src/composition/kma-location-scheduled-hourly.ts) — production composition
- [kma-location-scheduled-hourly.test.ts](../apps/api/src/composition/kma-location-scheduled-hourly.test.ts)

## 목적

- 호출자가 `product`/`latitude`/`longitude`만 제공하면 시간별 예보 pipeline을 실행할 수 있도록,
  위·경도 → 격자 변환과 scheduled hourly facade 배선을 한 번에 이어 줍니다.
- 위·경도 → 격자 변환(PR #12 converter)과 scheduled facade(PR #10)는 **모두 주입**되며, facade는
  scheduled facade의 결과·오류 계약을 **그대로** 전달합니다.
- 기존 `product`/`nx`/`ny` 기반 facade와 composition은 **그대로 유지**되며, 이 PR은 그 앞단에 별도의
  location facade/composition을 추가할 뿐입니다.

## 전체 pipeline

```text
caller input (product / latitude / longitude)
  → gridConverter({ latitude, longitude })                 // PR #12 (주입)
  → { nx, ny } | null
  → scheduledFacade.fetchScheduledHourlyForecast(          // PR #10
       { product, nx, ny }, options)
  → request factory → hourly service → KMA Provider
  → 정규화된 KmaScheduledHourlyForecastResult (그대로 반환)
```

- 위 흐름에서 location facade는 converter와 scheduled facade를 잇는 앞단 adapter입니다.
- converter의 투영 수식([kma-grid-conversion.md](./kma-grid-conversion.md)), request factory의 selector
  소비([kma-forecast-request-factory.md](./kma-forecast-request-factory.md)), hourly service의
  Provider/normalizer 배선([kma-hourly-service.md](./kma-hourly-service.md))은 변경하지 않습니다.
- **PR #15 상속.** location production composition은 grid production composition을 그대로 재사용하므로,
  PR #15에서 grid composition에 주입된 PR #14 availability-delay selector 정책(단기 10분·초단기 15분)을
  **자동으로 상속**합니다. location facade/composition은 selector를 따로 import하거나 중복 주입하지
  않습니다([kma-production-composition.md](./kma-production-composition.md)).

## application facade 공개 API

```ts
export type KmaLocationForecastGridConverter = (
  input: ConvertKmaLatitudeLongitudeToGridInput,
) => KmaForecastGridCoordinate | null;

export interface KmaLocationScheduledHourlyForecastInput {
  readonly product: KmaForecastProduct;
  readonly latitude: number;
  readonly longitude: number;
}

export type KmaLocationScheduledHourlyForecastOptions =
  KmaScheduledHourlyForecastOptions;

export interface KmaUnsupportedLocationError {
  readonly kind: 'UNSUPPORTED_LOCATION';
}

export type KmaLocationScheduledHourlyForecastResult =
  | KmaScheduledHourlyForecastResult
  | {
      readonly ok: false;
      readonly stage: 'LOCATION';
      readonly error: KmaUnsupportedLocationError;
    };

export interface KmaLocationScheduledHourlyForecastFacade {
  readonly fetchScheduledHourlyForecastForLocation: (
    input: KmaLocationScheduledHourlyForecastInput,
    options?: KmaLocationScheduledHourlyForecastOptions,
  ) => Promise<KmaLocationScheduledHourlyForecastResult>;
}

export function createKmaLocationScheduledHourlyForecastFacade(
  gridConverter: KmaLocationForecastGridConverter,
  scheduledFacade: KmaScheduledHourlyForecastFacade,
): KmaLocationScheduledHourlyForecastFacade;
```

- `input`은 `product`/`latitude`/`longitude` 세 field만 갖는, location facade가 정의하는 유일한 shape
  입니다. converter와 scheduled facade에 넘길 shape로 내부에서 변환하며, 두 collaborator 어느 쪽에도
  원본 input을 그대로 전달하지 않습니다.
- `options`/scheduled 성공·실패 result type은 별도로 재설계하지 않고 기존 scheduled facade의 type을
  **재사용**합니다. 여기에 `LOCATION` 미지원 위치 result 하나만 union에 추가합니다.

## converter 주입과 production converter 선택

```ts
createKmaLocationScheduledHourlyForecastFacade(
  gridConverter: KmaLocationForecastGridConverter,  // PR #12 구조의 주입 collaborator
  scheduledFacade: KmaScheduledHourlyForecastFacade, // PR #10
);
```

- converter는 **주입**됩니다. application facade는 PR #12 concrete converter를 직접 import하거나
  선택하지 않습니다.
- 실제 production converter(`convertKmaLatitudeLongitudeToGrid`) 선택은 **composition 계층의 책임**
  입니다(아래 참조).

## 실행 순서

한 번의 `fetchScheduledHourlyForecastForLocation(input, options)` 호출은 다음 순서로 진행됩니다.

1. grid converter를 **정확히 한 번** 호출합니다. converter input은 `latitude`/`longitude` 두 field만
   갖는 **새 object**입니다.
2. converter가 `null`을 반환하면 `LOCATION` 미지원 위치 result를 반환합니다(scheduled facade 미호출).
3. converter가 grid를 반환하면 `product`/`nx`/`ny` 세 field만 갖는 **새 object**로 scheduled facade를
   **정확히 한 번** 호출합니다. `options`는 동일 reference로 전달합니다.
4. scheduled facade가 반환한 Promise를 **그대로** 반환합니다.

- converter 호출은 요청당 정확히 1회입니다.
- converter가 성공(grid 반환)하면 scheduled facade 호출은 정확히 1회입니다.
- converter가 `null`을 반환하거나 throw하면 scheduled facade는 **호출되지 않습니다**.

## reference 그대로 전달 (converter input / scheduled input / options / Promise)

- **converter input**: `{ latitude, longitude }` 두 field만 갖는 **fresh object**입니다. 원본 input을
  spread하지 않고 `product`나 그 외 property를 포함하지 않으며, input을 mutate하지 않습니다.
- **scheduled facade input**: `{ product, nx, ny }` 세 field만 갖는 **fresh object**입니다. 원본
  input을 spread하지 않고 `latitude`/`longitude`를 포함하지 않으며, converter result를 spread하지
  않습니다. converter가 반환한 `nx`/`ny`는 default/swap/clamp/round/string 변환 없이 **그대로**
  전달합니다.
- **options / AbortSignal**: 호출자의 options reference(그 안의 `signal` 포함)를 scheduled facade에
  그대로 전달합니다. options clone·새 `AbortController` 생성·signal wrapping을 하지 않습니다.
- **options 생략 시**: scheduled facade에 정확히 `undefined`를 전달합니다. 임의의 `{}`를 만들지
  않습니다.

## 지원 위치 Promise identity 유지 (no async/await)

`fetchScheduledHourlyForecastForLocation`는 지원 위치일 때 scheduled facade가 반환한 Promise와
**동일한 reference**를 반환합니다. 이를 위해 `async` 표기·`await`·`.then`/`.catch`·`try/catch`·성공
result의 Promise wrapping을 사용하지 않습니다.

이 정책의 목적은 기존 scheduled facade의 결과·오류 계약을 **바꾸지 않는 것**입니다: location facade는
지원 위치에서 추가 async boundary를 만들지 않고, 성공·`PROVIDER` 실패·`NORMALIZATION` 실패·동기
throw·rejection을 어떤 형태로도 wrapping하지 않으며, collaborator가 만든 결과를 그대로 통과시킵니다.

## 결과·오류 계약

- **success**: scheduled facade의 `{ ok: true, hourly }`를 그대로 반환합니다.
- **`PROVIDER`-stage 실패**: scheduled facade의 `{ ok: false, stage: 'PROVIDER', error }`를 그대로
  반환합니다. `LOCATION`으로 재분류하지 않습니다.
- **`NORMALIZATION`-stage 실패**: scheduled facade의 `{ ok: false, stage: 'NORMALIZATION', issues }`를
  그대로 반환합니다. `LOCATION`으로 재분류하지 않습니다.
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
- scheduled facade는 **호출되지 않습니다**.
- throw를 Promise나 `LOCATION` result로 변환하지 않고, logging도 하지 않습니다.

예: 비-number/비-finite 좌표 `RangeError`, 물리 범위 밖 `RangeError`(예 `latitude must be within
[-90, 90]`), 주입된 converter의 sentinel error. `RangeError`와 미지원 위치(`null`)를 **같은 결과로
합치지 않습니다** — `null`만 `LOCATION` result로 변환합니다.

## 생성은 side-effect-free

`createKmaLocationScheduledHourlyForecastFacade(gridConverter, scheduledFacade)`는 순수 생성입니다:
converter를 호출하지 않고, scheduled facade를 호출하지 않으며, clock·환경변수·network를 건드리지 않고,
timer·listener·logging·mutation이 없습니다. 반환된 객체는 두 collaborator reference를 close over할 뿐
다른 상태를 갖지 않습니다. module singleton이나 cache를 만들지 않으며, 같은 instance를 반복 호출할 수
있고 각 호출은 이전 호출과 독립적입니다.

## production composition 공개 API

```ts
export type KmaLocationScheduledHourlyCompositionDependencies =
  KmaScheduledHourlyCompositionDependencies;

export type CreateKmaLocationScheduledHourlyCompositionResult =
  | {
      readonly ok: true;
      readonly facade: KmaLocationScheduledHourlyForecastFacade;
    }
  | {
      readonly ok: false;
      readonly error: KmaProviderConfigError;
    };

export function createKmaLocationScheduledHourlyCompositionFromEnv(
  env?: NodeJS.ProcessEnv,
  dependencies?: KmaLocationScheduledHourlyCompositionDependencies,
): CreateKmaLocationScheduledHourlyCompositionResult;
```

- `dependencies` type은 기존 grid-based composition의 dependencies를 **그대로 alias**합니다. 이 PR에서
  새로운 dependency option을 추가하지 않습니다.
- 성공 result는 **정확히 `ok`/`facade` 두 field만** 공개합니다. 내부 scheduled facade·grid
  converter·provider·request factory·hourly service·clock·env·dependencies·fetchImpl·serviceKey·URL을
  노출하지 않습니다.

## production converter 선택과 composition 순서

composition은 기존 production graph를 다시 구현하지 않고 기존 composition function을 소비합니다.

1. `createKmaScheduledHourlyCompositionFromEnv(env, dependencies)`를 호출합니다(grid-based
   composition을 그대로 재사용).
2. config failure면 즉시 **같은 `KmaProviderConfigError` reference**를 반환합니다.
3. 성공하면 PR #12 `convertKmaLatitudeLongitudeToGrid`를 선택합니다.
4. `createKmaLocationScheduledHourlyForecastFacade(converter, scheduledFacade)`를 호출합니다.
5. `{ ok: true, facade }`를 반환합니다.

- PR #12 converter는 **public package surface**에서 import합니다.

  ```ts
  import { convertKmaLatitudeLongitudeToGrid } from '@life-weather/weather-core';
  ```

  private file deep import는 하지 않습니다.
- `env`와 `dependencies`는 기존 composition에 **그대로** 전달합니다 — clone·spread·mutation·직접
  service key read·`process.env.KMA_SERVICE_KEY` 접근·validation 복제·fetch/clock option 복제를 하지
  않습니다.
- Provider creation·service-key validation·clock 선택·request factory/hourly service/scheduled facade
  생성·KMA URL 생성·fetch·normalization·issue-time 계산·projection 수식·retry/fallback·route는 이
  composition에서 **직접 구현하지 않습니다**(모두 기존 composition/component의 몫).

## composition 생성은 lazy

`createKmaLocationScheduledHourlyCompositionFromEnv()` 성공 호출은 Provider configuration을 읽고 기존
collaborator graph와 location facade closure를 만들 뿐입니다. 다음은 **실행하지 않습니다**: converter
실행, `Date.now` 실행, 주입된 clock 실행, network fetch, request 생성, scheduled facade 실행,
timer/listener, logging, route 등록, global mutation. 실제 converter·clock·fetch는 facade method 호출
시에만 실행됩니다. config failure 시에는 converter·clock·fetch·location facade construction이 모두 0회
이고 기존 `KmaProviderConfigError` 동일 reference가 그대로 전달됩니다.

두 composition function의 차이: `createKmaScheduledHourlyCompositionFromEnv`는 `product`/`nx`/`ny`를
받는 grid-based facade를, `createKmaLocationScheduledHourlyCompositionFromEnv`는
`product`/`latitude`/`longitude`를 받는 location-based facade를 만듭니다. 후자는 전자를 재사용하고 그
앞단에 PR #12 converter를 조립할 뿐입니다.

## full in-memory pipeline 테스트

composition 테스트는 network(주입된 in-memory `fetchImpl`)와 결정적 instant가 필요한 clock(주입된
fake clock)을 제외한 **모든 실제 component**를 사용합니다: PR #12 converter, provider-from-env, request
factory, PR #14 availability-delay selector, hourly service, hourly normalizer, scheduled facade,
location facade, location composition. reference clock `2026-07-18T05:00:00.000+09:00`, 서울 좌표
`{ latitude: 37.5665, longitude: 126.978 }`가 PR #12 기대 grid `{ nx: 60, ny: 127 }`로 투영되고,
상속된 production selector가 `base_date=20260718`/`base_time=0200`(0500의 10분 threshold 미도달)을 선택해
`getVilageFcst`를 호출한 뒤 하나의 정규화된 `HourlyForecast`(`2026-07-18T06:00:00+09:00`, `CLEAR`,
25.5 ℃ …)를 만드는 것을 검증합니다. Tokyo 미지원 좌표는 clock/fetch 0회, invalid 좌표 `RangeError`
경계와 `AbortSignal` 경계도 그대로 유지됩니다.

## 보안 경계

- **미지원 위치(`LOCATION`) / Provider 실패 / Normalization 실패 / success result / `RangeError`
  message / `console.*`** 어디에도 raw 좌표·격자·KMA body·URL·service key·secret marker가 나타나지
  않습니다.
- 실제 `KMA_SERVICE_KEY`를 사용하지 않고, 자동 테스트는 실제 네트워크를 호출하지 않습니다.
- runtime은 logging하지 않습니다.

## 이 PR의 범위 밖

- **HTTP route / `/weather` / query schema / URL query parsing / HTTP status·envelope mapping** —
  없음.
- **country/provider 선택 / location ID / 지역명 / 행정구역 검색 / reverse geocoding / GPS / location
  storage** — 없음.
- **기존 facade/composition 교체** — 없음(추가만 함). PR #15에서도 location facade/composition
  **runtime은 변경하지 않고**, grid composition을 통해 PR #14 availability 정책을 상속만 합니다.
- **grid converter 수식·request factory·Provider·normalizer·issue-time 변경** — 없음.
- **live availability guarantee / retry / fallback / cache / stale-data** — 없음. production은 상속된
  PR #14 availability-delay selector(프로젝트 정책 threshold)로 issuance를 고를 뿐입니다.
- **`WeatherOverview` / `SourceMetadata` / `CurrentWeather` / `DailyForecast`** — 없음.
- **AirKorea / mobile / 신규 dependency** — 없음.

## 후속 범위

1. `/weather` route와 query validation.
2. HTTP error/status mapping.
3. live availability fallback/retry(publication-in-progress·empty-data 대응).
4. `WeatherOverview`/`SourceMetadata` 조립.
5. cache / stale-data.

## 변경 이력

```text
v1 / PR #13 / 2026-07
- latitude/longitude application facade 추가
- PR #12 converter와 기존 scheduled facade 연결
- unsupported KMA location result(LOCATION/UNSUPPORTED_LOCATION) 정의
- location production composition 추가(기존 composition 재사용, PR #12 converter 선택)
- 기존 product/nx/ny facade·composition API 유지

v2 / PR #15 / 2026-07 (grid composition의 availability selector 정책 상속)
- location facade/composition runtime·API·LOCATION 계약 변경 없음
- grid production composition이 PR #14 availability-delay selector를 주입하므로 location pipeline도
  자동 상속(별도 selector import/주입 없음)
- 서울 05:00 KST pipeline base_time이 0200으로 갱신됨(문서·테스트 기대만 조정)
```
