# KMA 위경도 예정 초단기실황 facade (location scheduled current-observation facade)

이 문서는 PR #70에서 추가한 **application-level facade**
(`createKmaLocationScheduledCurrentObservationFacade`)의 책임과 경계를 기록합니다. 이 facade는 기존
위·경도 → KMA 격자 변환 함수([kma-grid-conversion.md](./kma-grid-conversion.md))를 PR #68 scheduled
current-observation facade 앞단에 두는 **얇은 adapter**일 뿐입니다 — `LOCATION` 미지원 위치 결과
하나를 제외하면 새로운 KMA 데이터 규칙이나 오류 정책을 도입하지 않습니다. 이 facade는
[kma-location-scheduled-hourly.md](./kma-location-scheduled-hourly.md)의 PR #13 location scheduled
hourly facade와 **같은 원칙을 따르는 별도의, 병렬** 구현입니다 — hourly location facade와 current
location facade를 generic abstraction으로 합치지 않습니다. 이어서 **PR #71**이 이 facade에 production
converter를 선택해 연결하는 production composition을 추가했습니다 — 아래 "PR #71: production
composition" 절 참고.

구현 위치:

- [kma-location-scheduled-current-observation.ts (facade)](../apps/api/src/services/kma-location-scheduled-current-observation.ts) — application facade
- [kma-location-scheduled-current-observation 테스트 (facade)](../apps/api/src/services/kma-location-scheduled-current-observation.test.ts)
- [kma-location-scheduled-current-observation.ts (composition)](../apps/api/src/composition/kma-location-scheduled-current-observation.ts) — PR #71 production composition root
- [kma-location-scheduled-current-observation 테스트 (composition)](../apps/api/src/composition/kma-location-scheduled-current-observation.test.ts)
- [composition/index.ts](../apps/api/src/composition/index.ts) — composition barrel(PR #71 export 추가)

## 목적

- 호출자가 `latitude`/`longitude`만 제공하면 초단기실황 pipeline을 실행할 수 있도록, 위·경도 → 격자
  변환과 PR #68 scheduled current-observation facade 배선을 한 번에 이어 줍니다.
- 위·경도 → 격자 변환(기존 `convertKmaLatitudeLongitudeToGrid`)과 scheduled current-observation
  facade(PR #68)는 **모두 주입**되며, facade는 scheduled facade의 결과·오류 계약을 **그대로**
  전달합니다.
- 기존 `nx`/`ny` 기반 scheduled current-observation facade는 **그대로 유지**되며, 이 PR은 그 앞단에
  별도의 location facade를 추가할 뿐입니다.

## 전체 pipeline

```text
caller input (latitude / longitude)
  → gridConverter({ latitude, longitude })                 // 기존 converter (주입)
  → { nx, ny } | null
  → scheduledFacade.fetchScheduledCurrentWeather(           // PR #68
       { nx, ny }, options)
  → request factory → current-observation service → KMA Provider
  → 정규화된 KmaScheduledCurrentObservationResult (그대로 반환)
```

- 위 흐름에서 location facade는 converter와 scheduled current-observation facade를 잇는 앞단
  adapter입니다.
- converter의 투영 수식([kma-grid-conversion.md](./kma-grid-conversion.md)), request factory의
  selector 소비([kma-current-observation-request-factory.md](./kma-current-observation-request-factory.md)),
  current-observation service의 Provider/normalizer 배선
  ([kma-current-observation-service.md](./kma-current-observation-service.md))은 변경하지 않습니다.
- 이 PR은 **production converter를 선택하지 않습니다.** production location composition(PR #69
  grid-based composition에 이 facade를 연결하는 작업)은 이 PR 범위 밖입니다 — 아래 "이 PR의 범위 밖"
  참고.

## 공개 API

```ts
export type KmaLocationCurrentObservationGridConverter = (
  input: ConvertKmaLatitudeLongitudeToGridInput,
) => KmaForecastGridCoordinate | null;

export interface KmaLocationScheduledCurrentObservationInput {
  readonly latitude: number;
  readonly longitude: number;
}

export type KmaLocationScheduledCurrentObservationOptions =
  KmaScheduledCurrentObservationOptions;

export interface KmaCurrentObservationUnsupportedLocationError {
  readonly kind: 'UNSUPPORTED_LOCATION';
}

export type KmaLocationScheduledCurrentObservationResult =
  | KmaScheduledCurrentObservationResult
  | {
      readonly ok: false;
      readonly stage: 'LOCATION';
      readonly error: KmaCurrentObservationUnsupportedLocationError;
    };

export interface KmaLocationScheduledCurrentObservationFacade {
  readonly fetchScheduledCurrentWeatherForLocation: (
    input: KmaLocationScheduledCurrentObservationInput,
    options?: KmaLocationScheduledCurrentObservationOptions,
  ) => Promise<KmaLocationScheduledCurrentObservationResult>;
}

export function createKmaLocationScheduledCurrentObservationFacade(
  gridConverter: KmaLocationCurrentObservationGridConverter,
  scheduledFacade: KmaScheduledCurrentObservationFacade,
): KmaLocationScheduledCurrentObservationFacade;
```

- `input`은 `latitude`/`longitude` 두 field만 갖는, location facade가 정의하는 유일한 shape입니다.
  converter와 scheduled facade에 넘길 shape로 내부에서 변환하며, 두 collaborator 어느 쪽에도 원본
  input을 그대로 전달하지 않습니다.
- 초단기실황은 `product` 선택이 없으므로(단일 operation) 이 facade의 input에도 `product` field가
  없습니다 — hourly location facade의 `product`/`latitude`/`longitude` 세 field와 다른 지점입니다.
- `options`/scheduled 성공·실패 result type은 별도로 재설계하지 않고 기존 scheduled current-observation
  facade의 type을 **재사용**합니다. 여기에 `LOCATION` 미지원 위치 result 하나만 union에 추가합니다.

## converter 주입과 production converter 선택

```ts
createKmaLocationScheduledCurrentObservationFacade(
  gridConverter: KmaLocationCurrentObservationGridConverter,  // 기존 converter 구조
  scheduledFacade: KmaScheduledCurrentObservationFacade,       // PR #68
);
```

- converter는 **주입**됩니다. application facade는 concrete converter(`convertKmaLatitudeLongitudeToGrid`)를
  직접 import하거나 선택하지 않습니다.
- 실제 production converter 선택과 production location composition은 이 PR 범위가 아닙니다(아래
  "이 PR의 범위 밖" 참고).

## 실행 순서

한 번의 `fetchScheduledCurrentWeatherForLocation(input, options)` 호출은 다음 순서로 진행됩니다.

1. grid converter를 **정확히 한 번** 호출합니다. converter input은 `latitude`/`longitude` 두 field만
   갖는 **새 object**입니다.
2. converter가 `null`을 반환하면 `LOCATION` 미지원 위치 result를 반환합니다(scheduled facade
   미호출).
3. converter가 grid를 반환하면 `nx`/`ny` 두 field만 갖는 **새 object**로 scheduled current-observation
   facade를 **정확히 한 번** 호출합니다. `options`는 동일 reference로 전달합니다.
4. scheduled facade가 반환한 Promise를 **그대로** 반환합니다.

- converter 호출은 요청당 정확히 1회입니다.
- converter가 성공(grid 반환)하면 scheduled facade 호출은 정확히 1회입니다.
- converter가 `null`을 반환하거나 throw하면 scheduled facade는 **호출되지 않습니다**.

## reference 그대로 전달 (converter input / scheduled input / options / Promise)

- **converter input**: `{ latitude, longitude }` 두 field만 갖는 **fresh object**입니다. 원본 input을
  spread하지 않고 `nx`/`ny`/`options`/`signal` 그 외 property를 포함하지 않으며, input을 mutate하지
  않습니다.
- **scheduled facade input**: `{ nx, ny }` 두 field만 갖는 **fresh object**입니다. 원본 input을
  spread하지 않고 `latitude`/`longitude`를 포함하지 않으며, converter result를 spread하지 않습니다.
  converter가 반환한 `nx`/`ny`는 default/swap/clamp/round/string 변환 없이 **그대로** 전달합니다.
- **options / AbortSignal**: 호출자의 options reference(그 안의 `signal` 포함)를 scheduled facade에
  그대로 전달합니다. options clone·새 `AbortController` 생성·signal wrapping을 하지 않습니다.
- **options 생략 시**: scheduled facade에 정확히 `undefined`를 전달합니다. 임의의 `{}`를 만들지
  않습니다.

## 지원 위치 Promise identity 유지 (no async/await)

`fetchScheduledCurrentWeatherForLocation`는 지원 위치일 때 scheduled facade가 반환한 Promise와
**동일한 reference**를 반환합니다. 이를 위해 `async` 표기·`await`·`.then`/`.catch`·`try/catch`·성공
result의 Promise wrapping을 사용하지 않습니다.

이 정책의 목적은 기존 scheduled facade의 결과·오류 계약을 **바꾸지 않는 것**입니다: location facade는
지원 위치에서 추가 async boundary를 만들지 않고, 성공·`PROVIDER` 실패·`NORMALIZATION` 실패·동기
throw·rejection을 어떤 형태로도 wrapping하지 않으며, collaborator가 만든 결과를 그대로 통과시킵니다.

## 결과·오류 계약

- **success**: scheduled facade의 `{ ok: true, current }`를 그대로 반환합니다.
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

주입된 converter가 throw하면:

- **동일한 error reference**가 **동기적으로** 전파됩니다.
- scheduled facade는 **호출되지 않습니다**.
- throw를 Promise나 `LOCATION` result로 변환하지 않고, logging도 하지 않습니다.

예: 비-number/비-finite 좌표 `RangeError`, 물리 범위 밖 `RangeError`(예 `latitude must be within
[-90, 90]`), 주입된 converter의 sentinel error. `RangeError`와 미지원 위치(`null`)를 **같은 결과로
합치지 않습니다** — `null`만 `LOCATION` result로 변환합니다.

## 생성은 side-effect-free

`createKmaLocationScheduledCurrentObservationFacade(gridConverter, scheduledFacade)`는 순수
생성입니다: converter를 호출하지 않고, scheduled facade를 호출하지 않으며, clock·환경변수·network를
건드리지 않고, timer·listener·logging·mutation이 없습니다. 반환된 객체는 두 collaborator reference를
close over할 뿐 다른 상태를 갖지 않습니다. module singleton이나 cache를 만들지 않으며, 같은 instance를
반복 호출할 수 있고 각 호출은 이전 호출과 독립적입니다.

## 실제 converter 통합 (synthetic coordinates)

대부분의 테스트는 fake collaborator(`vi.fn`, sentinel grid/result)만 사용해 facade의 wiring 계약만
검증합니다. 여기에 더해, 실제 public `convertKmaLatitudeLongitudeToGrid`를 주입한 최소 focused
integration 테스트 하나를 두어 shape drift를 방지합니다 — 서울 좌표(기존 grid fixture와 동일한
`{ latitude: 37.5665, longitude: 126.978 }` → `{ nx: 60, ny: 127 }`)로 supported 경로를, 물리 범위 밖
좌표(`latitude: 999`)로 `RangeError` 전파를 각각 확인합니다. 실제 좌표나 실사용자 위치는 사용하지
않습니다.

## 보안 경계

- **미지원 위치(`LOCATION`) / Provider 실패 / Normalization 실패 / success result / `RangeError`
  message / `console.*`** 어디에도 raw 좌표·격자·KMA body·URL·service key·secret marker가 나타나지
  않습니다.
- 실제 `KMA_SERVICE_KEY`를 사용하지 않고, 자동 테스트는 실제 네트워크를 호출하지 않습니다.
- runtime은 logging하지 않습니다.

## 이 PR(#70)의 범위 밖

- **production converter 선택 / production location composition** — 없음. PR #69의 grid-based
  production composition(`createKmaScheduledCurrentObservationCompositionFromEnv`)에 이 facade를
  연결하는 작업은 후속 PR입니다.
- **`WeatherOverview.current` / current `SourceMetadata` 조립** — 없음.
- **`POST /weather` route 연결 / query validation / HTTP status·envelope mapping** — 없음.
- **API availability-delay selector** — 없음(current-observation 전용 selector 자체가 아직
  존재하지 않습니다. hourly location facade가 grid production composition을 통해 상속하는 PR #14
  availability-delay 정책과 달리, 이 PR은 production composition에 아직 연결되지 않았으므로 상속할
  대상도 없습니다).
- **retry / fallback / cache / stale-data** — 없음.
- **실제 KMA API 호출 / 실사용자 위치 / mobile / native / 신규 dependency** — 없음.
- **`packages/weather-core/**` 변경 / grid projection math 변경** — 없음(기존 converter 계약을 그대로
  소비만 합니다).
- **기존 hourly location facade/scheduled current facade 변경** — 없음. current와 hourly의 location
  facade를 합치는 generic abstraction도 추가하지 않습니다.

## PR #71: production composition

**PR #71**이 이 facade에 production converter를 선택해 연결하는 **production composition root**
(`createKmaLocationScheduledCurrentObservationCompositionFromEnv`,
[apps/api/src/composition/kma-location-scheduled-current-observation.ts](../apps/api/src/composition/kma-location-scheduled-current-observation.ts))를
추가했습니다 — hourly의 PR #13
([kma-location-scheduled-hourly.md](./kma-location-scheduled-hourly.md)) composition과 같은
원칙을 따르는 별도·병렬 구현입니다.

```text
environment / injected dependencies
  → createKmaScheduledCurrentObservationCompositionFromEnv   // PR #69, 그대로 재사용
  → live KmaScheduledCurrentObservationFacade
          +
convertKmaLatitudeLongitudeToGrid                            // 기존 production converter
          ↓
createKmaLocationScheduledCurrentObservationFacade            // PR #70, 이 문서의 facade
  → live KmaLocationScheduledCurrentObservationFacade
```

- PR #69의 provider-from-env, clock 선택, request factory, current-observation service, scheduled
  facade 조립 그래프를 **재구현하지 않고** `createKmaScheduledCurrentObservationCompositionFromEnv(env,
  dependencies)`를 그대로 호출합니다 — `env`/`dependencies`는 exact reference로 전달됩니다(clone·
  spread·mutation·구조분해 후 재조립 없음).
- PR #69 composition이 config 실패(`{ ok: false, error }`)를 반환하면 **동일 error reference**를
  그대로 반환하고, 이 경우 이 facade factory 호출·converter 실행·clock read·network가 **0회**입니다.
  `LOCATION_CONFIG`/`CURRENT_CONFIG`/`COMPOSITION_ERROR`/`STARTUP_ERROR`/`INTERNAL_ERROR`/`UNKNOWN`
  같은 새 error kind를 만들지 않습니다.
- 성공하면 기존 production `convertKmaLatitudeLongitudeToGrid`(exact function reference, wrapper
  없음)와 PR #69 결과의 exact facade reference를 `createKmaLocationScheduledCurrentObservationFacade(
  gridConverter, scheduledFacade)`에 그대로 전달해 이 문서의 location facade를 조립합니다.
- 성공 result는 정확히 `{ ok, facade }`만 노출합니다 — `scheduledFacade`/`provider`/`requestFactory`/
  `clock`/`env`/`dependencies`/`serviceKey` 등 내부 그래프는 노출하지 않습니다.
- module import 시점에는 env read·provider 생성·converter 실행·clock read·fetch가 없고, composition
  함수 호출 시점에도 converter 실행·clock read·fetch는 **0회**입니다 — 이들은 반환된 facade의
  `fetchScheduledCurrentWeatherForLocation()`이 실행될 때만 발생합니다.
- 매 호출은 독립된 그래프를 만듭니다(module-level singleton/cache 없음) — 같은 env/dependencies로
  두 번 호출해도 반환된 facade는 서로 다른 reference입니다.
- 이 PR도 **`WeatherOverview.current` / current `SourceMetadata` / `POST /weather` route 연결 /
  availability-delay selector**를 구현하지 않습니다 — production current 데이터는 이 PR 이후에도
  계속 missing입니다. 자세한 계약은
  [kma-current-observation-production-composition.md](./kma-current-observation-production-composition.md)의
  "PR #71" 절 참고.

## 후속 범위

1. ~~production converter 선택과 이 facade를 PR #69 grid-based composition에 연결하는 location
   production composition root~~ — PR #71에서 구현.
2. ~~`WeatherOverview.current` section 조립~~ — **PR #72**가 별도 pure
   assembler(`assembleKmaCurrentWeatherOverview`,
   [kma-current-weather-overview.md](./kma-current-weather-overview.md))를 추가했지만, 이
   assembler는 이 facade나 PR #71 production composition을 소비/연결하지 않는 독립 단위입니다 —
   location current pipeline과의 application orchestration은 여전히 미구현입니다.
3. current `SourceMetadata`(`sourceId`/`issuedAt`/`retrievalMode`) 조립.
4. `POST /weather`로의 current 데이터 연결.
5. current-observation availability-delay selector.
6. 실제 인증 KMA API 호출을 통한 live 검증.

이 PR들이 production current 데이터를 제공한다고 표현하지 않습니다 — `POST /weather`는 PR #72
이후에도 계속 current를 missing으로 응답합니다.

## 변경 이력

```text
v1 / PR #70 / 2026-08
- latitude/longitude 초단기실황 application facade 추가
- 기존 위·경도 → 격자 converter와 PR #68 scheduled current-observation facade 연결
- unsupported KMA location result(LOCATION/UNSUPPORTED_LOCATION) 정의(hourly location facade와 동일
  형태, current 전용 별도 error type)
- production converter 선택/composition, WeatherOverview.current, SourceMetadata, POST /weather,
  availability-delay selector는 이 PR 범위 밖
- 기존 nx/ny 기반 scheduled current-observation facade·request factory·service·hourly location
  facade는 변경하지 않음, 새 generic 공통 abstraction 없음

v2 / PR #71 / 2026-08 (production composition 추가; 이 facade 자체는 불변)
- 이 facade의 공개 계약(latitude/longitude 입력, pass-through, Promise identity, 호출 순서) 변경 없음
- 새 production composition(createKmaLocationScheduledCurrentObservationCompositionFromEnv)이 PR #69
  grid production composition을 그대로 재사용하고 production converter를 선택해 이 facade에 연결
- WeatherOverview.current·SourceMetadata·POST /weather 연결·availability-delay selector는 여전히 이
  범위 밖
```
