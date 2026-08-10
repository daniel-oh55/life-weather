# KMA location current WeatherOverview application service

이 문서는 PR #74에서 추가한 **location current `WeatherOverview` application service**
(`createKmaLocationCurrentOverviewService`)의 책임과 경계를 기록합니다. 이 service는 이전 세 building
block을 하나의 orchestration으로 연결하기만 합니다.

- PR #70 location scheduled current-observation facade
- PR #73 nullary current source metadata resolver seam(caller가 주입)
- PR #72/#73 current-only `WeatherOverview` assembler

이 service는 [kma-location-hourly-overview.md](./kma-location-hourly-overview.md)의 PR #24 hourly
application service와 같은 형태를 따르는 **별도·병렬** 구현입니다 — hourly와 current를 generic
orchestrator로 합치지 않습니다. current는 fallback 선택이 없고, `PRIMARY`/`PREVIOUS` 소스도 없으며,
"사용 가능한 데이터 없음" success 분기도 없습니다: location facade의 결과는 단순한 `ok`/`ok:false`
union(`LOCATION`/`PROVIDER`/`NORMALIZATION`)이고, 모든 실패는 이 경계에서도 계속 실패로 남습니다.

## 목적

- 지금까지 PR #70 location facade와 PR #72/#73 assembler/resolver는 구현만 되어 있고 이를 실제로
  연결하는 application service가 없었습니다.
- 이 PR은 `WeatherLocation`에서 current-only partial `WeatherOverview`(또는 location facade가 만든
  실패)까지의 **application-level orchestration**을 구현합니다.
- 이 PR은 오직 orchestration만 담당합니다. production resolver 선택·production composition·
  `POST /weather` route는 포함하지 않습니다(아래 "범위 밖" 참조).

## 구현 위치

- [kma-location-current-overview.ts](../apps/api/src/services/kma-location-current-overview.ts) — service
- [kma-location-current-overview.test.ts](../apps/api/src/services/kma-location-current-overview.test.ts) — 테스트

허용 import는 contracts public surface와 기존 services의 sibling public/local surface뿐입니다.

```ts
import {
  weatherLocation,
  type WeatherLocation,
  type WeatherOverview,
} from '@life-weather/contracts';

import {
  assembleKmaCurrentWeatherOverview,
  type KmaCurrentWeatherOverviewInput,
} from './kma-current-weather-overview.js';
import type { KmaCurrentSourceMetadataResolver } from './kma-current-source-metadata.js';
import type {
  KmaLocationScheduledCurrentObservationFacade,
  KmaLocationScheduledCurrentObservationOptions,
  KmaLocationScheduledCurrentObservationResult,
} from './kma-location-scheduled-current-observation.js';
```

Provider·composition·weather-core·Hono·`process.env`·`fetch`·`Date`·`AbortController`·`zod` 직접
import·신규 package는 import하지 않습니다.

## 전체 pipeline

```text
{ location }
  → weatherLocation.parse(location)                          // contracts runtime validation (upfront)
  → locationCurrentFacade.fetchScheduledCurrentWeatherForLocation( // PR #70 location facade
       { latitude, longitude }, options)
  → ok:false → 그대로 반환 (LOCATION / PROVIDER / NORMALIZATION)
  → ok:true  → sourceMetadataResolver()                       // PR #73 nullary resolver
             → assembleKmaCurrentWeatherOverview({             // PR #72/#73 assembler
                    location, current: result.current, source })
             → { ok: true, overview }
```

## 공개 API

```ts
export interface KmaLocationCurrentOverviewInput {
  readonly location: WeatherLocation;
}

export type KmaLocationCurrentOverviewOptions =
  KmaLocationScheduledCurrentObservationOptions;

export type KmaLocationCurrentOverviewResult =
  | {
      readonly ok: true;
      readonly overview: WeatherOverview;
    }
  | Extract<
      KmaLocationScheduledCurrentObservationResult,
      { readonly ok: false }
    >;

export interface KmaLocationCurrentOverviewService {
  readonly fetchCurrentWeatherOverviewForLocation: (
    input: KmaLocationCurrentOverviewInput,
    options?: KmaLocationCurrentOverviewOptions,
  ) => Promise<KmaLocationCurrentOverviewResult>;
}

export function createKmaLocationCurrentOverviewService(
  locationCurrentFacade: KmaLocationScheduledCurrentObservationFacade,
  sourceMetadataResolver: KmaCurrentSourceMetadataResolver,
  overviewAssembler?: typeof assembleKmaCurrentWeatherOverview,
): KmaLocationCurrentOverviewService;
```

추가 class는 만들지 않습니다.

## collaborator 구조

- **location current facade** (필수 주입) — PR #70 facade. `LOCATION`/`PROVIDER`/`NORMALIZATION`
  판정을 소유합니다.
- **source metadata resolver** (필수 주입, 기본값 없음) — nullary seam. production PR #73 live
  resolver를 이 service가 스스로 선택하지 않습니다.
- **overviewAssembler** (선택, 기본값 `assembleKmaCurrentWeatherOverview`) — PR #72/#73 assembler.

`createKmaLocationCurrentOverviewService`는 collaborator reference를 closure에 저장할 뿐이며,
construction 시 어떤 collaborator도 호출하지 않고 clock/env/network도 건드리지 않습니다. 동일 instance를
여러 번 호출할 수 있고, 호출 간 mutable state가 없습니다.

## WeatherLocation upfront validation

service method 진입 직후, facade를 호출하기 **전에** 실행합니다.

```ts
const location = weatherLocation.parse(input.location);
```

- invalid timezone·범위 밖 latitude/longitude·empty id/displayName·invalid countryCode는 **synchronous
  `ZodError`**로 전파됩니다.
- 이 시점에 어떤 collaborator도 호출되지 않습니다(facade 0회, resolver 0회, assembler 0회).
- 호출자의 원본 `input.location`은 mutate되지 않습니다. 이후 모든 단계는 **parse된** location을
  사용합니다 — 호출자의 원본 object reference가 아닙니다.
- `zod`를 직접 import하지 않고 contracts public `weatherLocation` schema만 사용합니다.

## location facade 호출

```ts
locationCurrentFacade.fetchScheduledCurrentWeatherForLocation(
  { latitude: location.latitude, longitude: location.longitude },
  options,
);
```

- 정확히 한 번 호출합니다.
- input은 parse된 location의 `latitude`/`longitude` 두 field만 갖는 **fresh object**입니다 —
  `WeatherLocation` 전체를 spread하지 않고, 호출자의 원본 input object를 전달하지 않으며, 좌표를
  반올림·clamp·문자열화·재변환하지 않고, `kmaGrid`나 다른 mobile-local field를 들여다보지 않습니다.
- `options`는 호출자의 reference를 그대로 전달합니다. 생략 시 정확히 `undefined`를 전달합니다(임의의
  `{}` 생성 없음).

## 실패 경계 — 그대로 반환, 재해석 없음

location facade는 세 단계에서 실패할 수 있습니다 — `LOCATION`(미지원 좌표), `PROVIDER`(전송/upstream),
`NORMALIZATION`(관측값 형식 오류). 모든 `ok: false` 결과는 facade가 만든 **정확한 reference**로
그대로 반환됩니다 — `overview`/`location`/`coordinates`/`source`/message를 추가하지 않고, 어떤 stage도
합치거나 재해석하지 않습니다. 실패 시 resolver와 assembler는 **호출되지 않습니다** — assembler는 유효한
`CurrentWeather`를 요구하므로, 부재는 hourly처럼 빈-current success로 바뀌지 않고 이 경계에서 계속
실패로 남습니다.

## 성공 경계 — caller가 주입한 resolver, 추론 없음

facade 성공 시 이 service는 **주입된, 필수, nullary** `KmaCurrentSourceMetadataResolver`를 **정확히
한 번** 호출합니다 — location, current, 좌표, grid, request, base time 어느 것도 넘기지 않습니다
(current-observation resolver는 세 provenance 사실을 스스로 결정하므로 입력이 필요 없습니다). resolver의
출력은 **동일 reference**로 assembler에 전달됩니다. 이 service는 source metadata를 재해석하거나
`sourceId`를 재구성하거나 clock을 직접 읽지 않습니다 — 그 정책은 전적으로 주입된 resolver(production
PR #73 live resolver, 이 PR에서는 여전히 연결되지 않음)에 있습니다.

assembler는 다음 세 field만 받습니다.

```ts
overviewAssembler({
  location,               // parsed WeatherLocation
  current: result.current, // facade success의 정확한 CurrentWeather reference
  source,                  // resolver 출력의 정확한 reference
});
```

## 성공 결과

```ts
{
  ok: true,
  overview,
}
```

top-level own key는 정확히 `ok`/`overview` 두 개입니다. `current`/`source`/`request`/`grid`/좌표/facade
결과 어느 것도 top level에 노출하지 않습니다 — `CurrentWeather`와 `SourceMetadata`는 이미
`WeatherOverview` 안에 있습니다.

## Promise / 오류 semantics — no async

`fetchCurrentWeatherOverviewForLocation`은 `async`로 선언되지 않습니다. 위치를 동기적으로 parse하고
facade를 동기적으로 호출한 뒤, 반환된 Promise만 `.then(...)`합니다.

- **invalid `WeatherLocation`**: 동기 `ZodError`.
- **facade 동기 throw**: 동일한 error reference가 동기적으로 전파됩니다(Promise로 감싸지 않음).
- **facade Promise rejection**: 반환된 Promise가 동일한 reference로 reject됩니다.
- **resolver throw**: 반환된 Promise가 동일한 reference로 reject됩니다(assembler는 호출되지 않음).
- **assembler throw**: 반환된 Promise가 동일한 reference로 reject됩니다.

넓은 `try`/`catch`, error wrapping/재메시지, 새 error union, logging, 부분 결과가 없습니다. facade의
Promise identity는 의도적으로 **보존되지 않습니다**(`.then` 변환 자체가 orchestration입니다).

## 불변성 / reference

이 service는 호출자 input, parsed location, options, `AbortSignal`, facade 결과, `CurrentWeather`,
resolver 결과, assembler 결과 어느 것도 mutate하지 않습니다. frozen 호출자 input/options/fixture를
지원합니다. 반복 호출은 매번 fresh success wrapper를 반환합니다(module-level 공유 result object 없음).

## 생성은 side-effect-free

`createKmaLocationCurrentOverviewService(locationCurrentFacade, sourceMetadataResolver,
overviewAssembler?)`는 순수 생성입니다: facade를 호출하지 않고, resolver를 호출하지 않고, assembler를
호출하지 않으며, location을 parse하지 않고, clock·환경변수·network·listener·timer·cache·singleton·
counter가 없습니다. 반환된 객체는 collaborator reference를 close over할 뿐입니다.

## 이 PR(#74)의 범위 밖

- **production resolver 선택** — 없음. `createKmaLiveCurrentSourceMetadataResolver`를 이 service
  스스로 호출하지 않습니다.
- **system clock 주입** — 없음.
- **production composition root / `apps/api/src/composition/**` 변경** — 없음.
- **`POST /weather` route 연결 / `apps/api/src/routes/**` · `presenters/**` · `index.ts` ·
  `api-app.ts` 변경** — 없음.
- **contracts / weather-core / lifestyle-engine / providers 변경** — 없음.
- **availability-delay selector / cache / stale-data / retry / fallback / source selection** — 없음.
- **실제 인증 KMA API 호출 / 실사용자 위치 / mobile / native / 신규 dependency** — 없음.

이 PR 이후에도 production `POST /weather`의 `current`는 계속 missing입니다.

## 변경 이력

```text
v1 / PR #74 / 2026-08
- location current WeatherOverview application service 추가
- PR #70 location facade → PR #73 nullary resolver → PR #72/#73 assembler 순서로 연결
- 모든 facade 실패(LOCATION/PROVIDER/NORMALIZATION)를 그대로 반환, 빈-current success 없음
- production composition / POST /weather 연결 / availability-delay selector는 이 PR 범위 밖
```
