# KMA location current + hourly WeatherOverview application orchestration

이 문서는 PR #77에서 추가한 **location current + hourly `WeatherOverview` application
orchestration**(`createKmaLocationCurrentHourlyOverviewService`)의 책임과 경계를 기록합니다. 이
service는 이전 세 building block을 처음으로 실제 호출하는 orchestration입니다.

- PR #24 location hourly overview service
- PR #74 location current overview service
- PR #76 순수 current+hourly aggregate assembler(`assembleKmaCurrentHourlyWeatherOverview`) — 이
  service도, hourly/current service도 직접 호출하지 않습니다.

## 목적

- 지금까지 PR #76 assembler는 이미 계산된 hourly/current 결과를 조합만 할 뿐, 어느 service도 직접
  호출하지 않았습니다.
- 이 PR은 `{ product, location }`에서 hourly service와 current service를 **순서대로 실제로 호출**하고
  그 결과를 PR #76 assembler에 넘기는 **application-level orchestration**을 구현합니다.
- 이 PR은 오직 orchestration과 하나의 explicit degradation 정책(아래 참조)만 담당합니다. production
  composition·`POST /weather` route 연결은 포함하지 않습니다(아래 "범위 밖" 참조).

## 구현 위치

- [kma-location-current-hourly-overview.ts](../apps/api/src/services/kma-location-current-hourly-overview.ts) — service
- [kma-location-current-hourly-overview.test.ts](../apps/api/src/services/kma-location-current-hourly-overview.test.ts) — 테스트

허용 import는 기존 services의 sibling public 표면뿐입니다.

```ts
import {
  assembleKmaCurrentHourlyWeatherOverview,
  type KmaCurrentHourlyWeatherOverviewInput,
} from './kma-current-hourly-weather-overview.js';
import type { KmaLocationCurrentOverviewService } from './kma-location-current-overview.js';
import type {
  KmaLocationHourlyOverviewInput,
  KmaLocationHourlyOverviewOptions,
  KmaLocationHourlyOverviewResult,
  KmaLocationHourlyOverviewService,
} from './kma-location-hourly-overview.js';
```

Provider·composition·route·presenter·contracts·weather-core·Hono·`process.env`·`fetch`·`Date`·
`AbortController`·`zod` 직접 import·신규 dependency는 import하지 않습니다.

## 전체 pipeline

```text
{ product, location }
  → hourlyOverviewService.fetchHourlyWeatherOverviewForLocation(input, options)   // PR #24
  → ok:false (LOCATION) → 그대로 반환 (current는 시도되지 않음)
  → ok:true (선택 여부 무관) → currentOverviewService.fetchCurrentWeatherOverviewForLocation(  // PR #74
         { location: hourlyResult.overview.location }, options)
       → ok:true  → assembler({ hourly: hourlyResult, current: currentResult })   // PR #76
       → ok:false → assembler({ hourly: hourlyResult, current: null })            // 강등
  → { ok: true, selection: hourlyResult.selection, overview }
```

## 공개 API

```ts
export type KmaLocationCurrentHourlyOverviewInput = KmaLocationHourlyOverviewInput;
export type KmaLocationCurrentHourlyOverviewOptions = KmaLocationHourlyOverviewOptions;
export type KmaLocationCurrentHourlyOverviewResult = KmaLocationHourlyOverviewResult;

export interface KmaLocationCurrentHourlyOverviewService {
  readonly fetchCurrentHourlyWeatherOverviewForLocation: (
    input: KmaLocationCurrentHourlyOverviewInput,
    options?: KmaLocationCurrentHourlyOverviewOptions,
  ) => Promise<KmaLocationCurrentHourlyOverviewResult>;
}

export function createKmaLocationCurrentHourlyOverviewService(
  hourlyOverviewService: KmaLocationHourlyOverviewService,
  currentOverviewService: KmaLocationCurrentOverviewService,
  overviewAssembler?: typeof assembleKmaCurrentHourlyWeatherOverview,
): KmaLocationCurrentHourlyOverviewService;
```

`Input`/`Options`/`Result`는 모두 PR #24 hourly service의 대응 타입에 대한 **alias**입니다 — 새 request/
result 형태를 만들지 않습니다. 새 generic multi-section framework도 만들지 않습니다.

## hourly가 필수 baseline

실행은 항상 hourly service 호출로 시작합니다 — 호출자의 **정확한** `input`/`options` reference를
그대로 전달합니다(clone·재구성 없음). Hourly는 전체 application 요청이 사용 가능한 location baseline을
갖는지를 결정합니다.

hourly의 top-level `LOCATION` 실패는 **정확한 reference**로 그대로 반환되며, current service와
assembler는 **호출되지 않습니다**. current는 additive section이므로 필수 baseline이 이미 실패한
location에는 실행되지 않습니다.

hourly `{ ok: true }` 결과는 — `selection.selected === false`인 **no-selection 성공을 포함해** — 항상
current로 이어집니다. hourly에 사용 가능한 데이터가 없다는 사실이 current 시도를 막지 않습니다.

## current 입력 — hourly baseline location, 호출자 원본 아님

hourly 성공 후 이 service는 **fresh** input object `{ location: hourlyResult.overview.location }`로
current service를 호출합니다 — hourly application service가 이미 만든 parsed location을 **정확한
reference**로 사용하며, 호출자의 원본 `input.location`, grid 값, 다른 trace는 쓰지 않습니다. 호출자의
`options` reference(생략 시 정확히 `undefined`)는 clone·새 `AbortController`·combined signal 없이 그대로
전달됩니다.

## current 명시적 실패 강등(degradation) 정책

current service가 다음 stage 중 하나로 **resolve**되면 —

- `LOCATION`
- `PROVIDER`
- `NORMALIZATION`

이 실패는 **반환되지 않으며**, stage는 다른 동작을 선택하기 위해 검사되지 않습니다. 대신 PR #76
assembler를 `current: null`로 호출합니다 — 그 결과 overview는 current 부재를 `current: null`과
`missingSections`의 `CURRENT`로 표현합니다. 이는 service/HTTP 오류가 아니라 section-level degradation
입니다.

hourly가 이미 유효한 location baseline을 만든 이후이므로, current section의 명시적 실패가 이미 사용
가능한 hourly 데이터를 버리게 해서는 안 됩니다 — 이 service는 세 stage를 동일하게 다룹니다(stage/error
field가 결합 결과에 노출되지 않습니다).

current `{ ok: true }` 결과는 정확한 reference로 assembler에 전달됩니다(hourly 성공 reference와 함께).

## 예상치 못한 throw/rejection은 강등되지 않음

**resolve된** current `ok: false`만 `current: null`로 강등됩니다. hourly 동기 throw, hourly Promise
rejection, current 동기 throw, current Promise rejection, assembler throw는 절대 강등되지 않습니다 —
각각 동일한 error/rejection reference로 그대로 전파됩니다. 넓은 `try`/`catch`는 없습니다.

## 실행 순서 — 순차, 동시 아님

메서드는 의도적으로 `async`가 아닙니다. hourly service를 동기적으로 호출하고 결과를 `.then()`합니다.
current service 호출은 그 fulfillment handler **안에서만**, hourly 성공일 때만 일어나고, 그 결과도
`.then()`으로 assembler에 연결합니다. `Promise.all`/`Promise.allSettled`/eager parallel current 실행은
의도적으로 쓰지 않습니다 — hourly `LOCATION` 실패가 계속 authoritative해야 하고, 미지원 location에
불필요한 current 작업이 발생하지 않아야 하며, 오류 우선순위와 `AbortSignal`/rejection semantic이 단순하게
유지되어야 하기 때문입니다. 이 PR은 latency를 최적화하지 않습니다.

## 결과 계약 — `KmaLocationHourlyOverviewResult`와 정확히 호환

결합 결과의 공개 shape는 **의도적으로** {@link KmaLocationHourlyOverviewResult}와 동일합니다 — hourly
`LOCATION` 실패 그대로, 또는 `{ ok: true, selection: hourlyResult.selection, overview }`(hourly의
정확한 `selection` reference와 assembler의 정확한 반환 reference를 담은 fresh wrapper)입니다.
`currentResult`/`currentFailure`/`degraded`/`partial`/`warnings`/failure stage/provider error/source
trace/request trace/좌표는 추가되지 않습니다. 이 정확한 호환성은 의도적입니다 — 이후 production wiring
PR이 기존 hourly presenter 경계를 재설계 없이 재사용할 수 있도록 하기 위함이며, 이 PR은 presenter를
수정하지 않습니다.

## 순수성과 정책 재구현 없음

생성은 side-effect-free입니다 — collaborator를 호출하지 않고, clock/환경변수/network를 읽지 않고,
listener를 등록하지 않으며, mutable state·cache·counter·singleton이 없습니다(주입된 세 reference를
close over할 뿐). `input`/`options`/hourly 결과/hourly `selection`/`overview`/current 결과/overview 중
어느 것도 mutate하지 않고, 매 호출은 fresh success wrapper를 반환합니다. 이 service는 `WeatherOverview`
merging을 스스로 구현하지 않고(PR #76 assembler의 몫), hourly fallback/selection 정책을 재실행하지
않으며, current provider/normalization 세부사항을 검사하지 않습니다 — `currentResult.ok`만 읽어 current
성공 객체와 `null` 중 하나를 선택합니다.

## 이 PR(#77)의 범위 밖

- **production composition root / `apps/api/src/composition/**` 변경** — 없음.
- **`POST /weather` route 연결 / `apps/api/src/routes/**` · `presenters/**` · `index.ts` ·
  `api-app.ts` 변경** — 없음.
- **contracts / weather-core / lifestyle-engine / providers 변경** — 없음.
- **current availability-delay selector / cache / stale-data / retry / concurrency 최적화** — 없음.
- **실제 인증 KMA API 호출 / 실사용자 위치 / mobile / native / 신규 dependency** — 없음.

이 PR 이후에도 production `POST /weather`의 `current`는 계속 missing입니다.

## 변경 이력

```text
v1 / PR #77 / 2026-08
- location current + hourly WeatherOverview application orchestration 추가
- PR #24 hourly service → PR #74 current service → PR #76 assembler 순서로 실제 호출
- hourly LOCATION 실패는 그대로 반환, hourly 성공(no-selection 포함)은 항상 current 시도
- current의 모든 resolved ok:false stage(LOCATION/PROVIDER/NORMALIZATION)를 current:null로 균일하게 강등
- 예상치 못한 throw/rejection은 강등하지 않고 그대로 전파
- 결과는 KmaLocationHourlyOverviewResult와 정확히 호환되는 형태 유지
- production composition / POST /weather 연결 / availability-delay selector는 이 PR 범위 밖
```
