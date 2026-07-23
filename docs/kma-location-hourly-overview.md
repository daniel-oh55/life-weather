# KMA location hourly WeatherOverview application service

이 문서는 PR #24에서 추가한 **location hourly `WeatherOverview` application service**
(`createKmaLocationHourlyOverviewService`)의 책임과 경계를 기록합니다. 이 service는 이전 네 building
block을 하나의 orchestration으로 연결하기만 합니다.

- PR #21 location hourly fallback facade
- PR #22 primary/previous result selector
- caller가 주입한 selected-source metadata resolver seam
- PR #23 hourly-only `WeatherOverview` assembler

## 목적

- 지금까지 selector(PR #22)와 assembler(PR #23)는 구현만 되어 있고 이를 실제로 소비하는
  application service가 없었습니다.
- 이 PR은 `WeatherLocation` + `product`에서 hourly-only partial `WeatherOverview`(또는 `LOCATION`
  실패)까지의 **application-level orchestration**을 구현합니다.
- 이 PR은 오직 orchestration만 담당합니다. production resolver·issuedAt 복원·production composition·
  `/weather` route는 포함하지 않습니다(아래 "범위 밖" 참조).

## 구현 위치

- [kma-location-hourly-overview.ts](../apps/api/src/services/kma-location-hourly-overview.ts) — service
- [kma-location-hourly-overview.test.ts](../apps/api/src/services/kma-location-hourly-overview.test.ts) — 테스트

이 위치(`apps/api/src/services`)에 두는 이유:

- location fallback trace를 selector·resolver seam·assembler로 연결하는 **application-layer
  orchestration**입니다.
- Provider boundary가 아니며, `weather-core` 순수 domain 계산도 아닙니다.

허용 import는 contracts public surface와 기존 services의 sibling public/local surface뿐입니다.

```ts
import {
  weatherLocation,
  type WeatherLocation,
  type WeatherOverview,
} from '@life-weather/contracts';

import {
  selectKmaHourlyFallbackResult,
  type KmaHourlyFallbackSelection,
} from './kma-hourly-fallback-selection';
import {
  assembleKmaHourlyWeatherOverview,
  type KmaHourlySourceMetadataInput,
} from './kma-hourly-weather-overview';
import type {
  KmaLocationHourlyFallbackFacade,
  KmaLocationHourlyFallbackInput,
  KmaLocationHourlyFallbackOptions,
  KmaLocationHourlyFallbackResult,
} from './kma-location-hourly-fallback';
```

Provider·composition·request-plan factory·weather-core·Hono·`process.env`·`fetch`·`Date`·
`AbortController`·`zod` 직접 import·신규 package는 import하지 않습니다.

## 전체 pipeline

```text
{ product, location }
  → weatherLocation.parse(location)                          // contracts runtime validation (upfront)
  → facade.fetchHourlyForecastWithFallbackForLocation(       // PR #21 location fallback facade
       { product, latitude, longitude }, options)
  → LOCATION 실패 → 그대로 반환 (verbatim)
  → execution trace → selectKmaHourlyFallbackResult(trace)   // PR #22 selector
                    → selected?  → sourceMetadataResolver(   // injected, selected-source only
                                     { product, location, selection })
                    → assembleKmaHourlyWeatherOverview(       // PR #23 assembler
                                     { location, selection, source })
                    → { ok: true, selection, overview }
```

## 공개 API

```ts
export interface KmaLocationHourlyOverviewInput {
  readonly product: KmaLocationHourlyFallbackInput['product'];
  readonly location: WeatherLocation;
}

export type KmaLocationHourlyOverviewOptions =
  KmaLocationHourlyFallbackOptions;

export interface KmaSelectedHourlySourceMetadataResolverInput {
  readonly product: KmaLocationHourlyOverviewInput['product'];
  readonly location: WeatherLocation;
  readonly selection: Extract<
    KmaHourlyFallbackSelection,
    { readonly selected: true }
  >;
}

export type KmaSelectedHourlySourceMetadataResolver = (
  input: KmaSelectedHourlySourceMetadataResolverInput,
) => KmaHourlySourceMetadataInput;

export type KmaLocationHourlyOverviewResult =
  | {
      readonly ok: true;
      readonly selection: KmaHourlyFallbackSelection;
      readonly overview: WeatherOverview;
    }
  | Extract<
      KmaLocationHourlyFallbackResult,
      { readonly stage: 'LOCATION' }
    >;

export interface KmaLocationHourlyOverviewService {
  readonly fetchHourlyWeatherOverviewForLocation: (
    input: KmaLocationHourlyOverviewInput,
    options?: KmaLocationHourlyOverviewOptions,
  ) => Promise<KmaLocationHourlyOverviewResult>;
}

export function createKmaLocationHourlyOverviewService(
  locationFallbackFacade: KmaLocationHourlyFallbackFacade,
  sourceMetadataResolver: KmaSelectedHourlySourceMetadataResolver,
  selectionPolicy?: typeof selectKmaHourlyFallbackResult,
  overviewAssembler?: typeof assembleKmaHourlyWeatherOverview,
): KmaLocationHourlyOverviewService;
```

추가 class는 만들지 않습니다.

## collaborator 구조

- **location fallback facade** (필수 주입) — PR #21 facade. LOCATION 판정과 primary/previous 실행을
  소유합니다.
- **source metadata resolver** (필수 주입) — selected source의 provenance를 결정하는 seam. 기본값이
  없습니다.
- **selectionPolicy** (선택, 기본값 `selectKmaHourlyFallbackResult`) — PR #22 selector.
- **overviewAssembler** (선택, 기본값 `assembleKmaHourlyWeatherOverview`) — PR #23 assembler.

`createKmaLocationHourlyOverviewService`는 collaborator reference를 closure에 저장할 뿐이며,
construction 시 어떤 collaborator도 호출하지 않고 clock/env/network도 건드리지 않습니다. 동일 instance를
여러 번 호출할 수 있고, 호출 간 mutable state가 없습니다.

## WeatherLocation upfront validation

service method 진입 직후, facade를 호출하기 **전에** 실행합니다.

```ts
const location = weatherLocation.parse(input.location);
```

- invalid timezone·범위 밖 latitude/longitude·empty id/displayName·invalid countryCode는 **synchronous
  `ZodError`**로 전파됩니다.
- invalid location이면 facade 0회, converter 0회, network 0회, selector 0회, resolver 0회, assembler
  0회입니다.
- 이후 모든 collaborator에는 **parsed** `location`을 사용합니다(facade에는 parsed latitude/longitude,
  resolver·assembler에는 parsed `location`). caller의 original input은 mutate하지 않습니다.
- contracts의 `weatherLocation` public schema만 사용하고 `zod`를 직접 import하지 않습니다.

## facade input mapping

facade에는 **fresh** object를 전달합니다.

```ts
{
  product: input.product,
  latitude: location.latitude,
  longitude: location.longitude,
}
```

- exact keys: `product` / `latitude` / `longitude`.
- `latitude`/`longitude`는 **parsed** location 값입니다.
- location object·id·displayName·countryCode·timezone·adminArea·selection·source metadata는 전달하지
  **않습니다.**
- `options`는 두 번째 argument로 **exact same reference**를 전달합니다. 생략된 options는 정확히
  `undefined`(합성한 `{}`가 아님)입니다.

## LOCATION branch

facade가 다음을 반환하면 그대로 반환합니다.

```ts
{
  ok: false,
  stage: 'LOCATION',
  error: { kind: 'UNSUPPORTED_LOCATION' },
}
```

- **exact facade result reference**를 반환합니다(clone/spread/mutate 없음).
- overview·selection·source·coordinates·message·provider·fallbackUsed를 추가하지 **않습니다.**
- selector 0회, resolver 0회, assembler 0회.

판정은 **top-level discriminator만** 사용합니다(`'stage' in result && result.stage === 'LOCATION'`).
`PROVIDER`/`NORMALIZATION` stage는 execution trace의 nested `primary`/`previous` 안에 있으므로 LOCATION과
혼동하지 않습니다. 이 module-local type guard(`isKmaLocationFailure`)는 export하지 않습니다.

## selector 적용

LOCATION이 아닌 모든 execution trace는 selector를 **정확히 1회** 호출합니다.

- selector 입력은 facade가 반환한 **exact execution trace reference**입니다.
- selector 결과는 clone/spread/mutate하지 않고, success result의 `selection`에 **exact reference**로
  포함됩니다.
- LOCATION branch에서는 selector를 호출하지 않습니다.

## selected / no-selection 분기

selector 결과의 `selection.selected`에 따라 분기합니다.

### selected (`selection.selected === true`)

1. resolver를 **정확히 1회** 호출합니다.
2. resolver output을 source context로 assembler에 전달합니다.
3. `{ ok: true, selection, overview }`를 반환합니다.

### no selection (`selection.selected === false`)

1. resolver를 호출하지 **않습니다.**
2. assembler에 `source: null`을 전달합니다.
3. `{ ok: true, selection, overview }`를 반환합니다.

`selection.selected === false`여도 결과는 `ok: true`입니다(아래 "application success 의미" 참조).

## resolver가 selected에서만 호출됨

resolver는 selected branch에서만 정확히 1회 호출됩니다.

- no-selection: resolver 0회.
- LOCATION: resolver 0회.

### resolver input exact fields

resolver input은 **fresh** object이며 exact keys입니다.

| field | 값 / reference |
| --- | --- |
| `product` | caller `product` 값 |
| `location` | `weatherLocation.parse` 결과 reference |
| `selection` | selector의 exact result reference (selected arm) |

- resolver가 결정하는 것: `selection.source`(PRIMARY/PREVIOUS)에 따른 source context, `sourceId`,
  `issuedAt` 또는 `null`, `fetchedAt`, `retrievalMode`.
- service는 resolver output을 수정하지 않고, assembler에 **exact reference**로 전달합니다.
- resolver가 throw하면 returned Promise가 **same error reference**로 reject되고 assembler는 실행되지
  않습니다(catch/wrap/log 없음).

## caller/injected provenance boundary

execution trace에는 **full** primary/previous request(및 `nx`/`ny`·request plan)가 포함되지 않습니다.
다만 PR #25부터는 실제 request plan에서 파생한 **sanitized issuance identity**
(`primaryIssuance`, fallback 시 `previousIssuance` — `product`/`baseDate`/`baseTime`만)가 execution trace
안에 보존됩니다. 그럼에도 이 service 자체는 여전히 다음을 계산하거나 추정하지 **않습니다.**

- issuedAt (ISO `+09:00` 조립)
- fetchedAt
- retrievalMode
- sourceId

이 service는 selected source를 알고 있는 **resolver seam만** 정의하고, provenance 결정은 주입된 resolver에
위임합니다. injected resolver는 PR #25 이후 `input.selection.execution.primaryIssuance`(그리고
`fallbackAttempted` narrow 후 `previousIssuance`)로 **실제 실행된 발표시각 identity**에 접근할 수 있습니다.
그 production resolver와 정확한 provenance 정책(issuedAt/fetchedAt/sourceId/retrievalMode)은 PR #26의
`createKmaLiveSelectedHourlySourceMetadataResolver`가 구현합니다
([kma-selected-hourly-source-metadata.md](./kma-selected-hourly-source-metadata.md)) — 이 service는 여전히
그 resolver를 injected dependency로만 받고 clock/base-time/sourceId 정책을 소유하지 않습니다. issuance
identity는 resolver input top-level에 복제하지 않습니다 — resolver input own key는 여전히
`product`/`location`/`selection` 세 개입니다.

### 별도 clock으로 issuedAt을 재계산하지 않는 이유

- fallback pipeline이 request plan을 만든 시각과, 별도 resolver가 clock을 읽는 시각이 달라질 수 있습니다.
- availability-delay 경계에서 primary/previous 후보가 달라질 수 있습니다.
- 그 결과 실제 실행된 request와 조립된 `SourceMetadata`가 불일치할 수 있습니다.

따라서 이 service는 별도 request-plan factory나 clock을 다시 호출해 발표시각을 복원하지 않습니다.
`issuedAt: null`은 PR #23 assembler가 이미 허용하므로, 알 수 없는 발표시각은 resolver가 명시적으로
`null`로 전달할 수 있습니다.

## application success 의미

LOCATION이 아닌 모든 trace는 selector·assembler까지 처리해 `{ ok: true, selection, overview }`를
반환합니다.

- **selected**: overview.hourly가 채워지고, KMA `HOURLY` source 한 건이 포함됩니다.
- **no selection**: overview.hourly가 `[]`, sources가 `[]`, `HOURLY`가 `missingSections`에 포함됩니다.

### no-selection도 ok:true인 이유

- application orchestration은 정상 완료되었습니다.
- "usable hourly data가 없다"는 사실은 top-level error가 아니라 다음으로 표현합니다.
  - `selection.selected: false`
  - `overview.hourly: []`
  - `overview.missingSections`의 `HOURLY`
- Provider/Normalization failure가 execution trace에 있더라도 LOCATION failure가 아니라면 partial
  `WeatherOverview` 조립은 정상 완료할 수 있습니다. 이 PR은 Provider failure를 새로운 top-level error로
  바꾸지 않습니다.

## selection + overview result

성공 결과는 `selection`과 `overview`를 함께 담습니다.

- `result.selection`은 selector 결과 **exact reference**입니다.
- `result.overview`는 assembler 결과 **exact reference**입니다.

## exact keys

### success branch (own keys, 정렬)

- `ok`
- `overview`
- `selection`

### LOCATION branch (own keys, 정렬)

- `error`
- `ok`
- `stage`

success에는 다음을 추가하지 **않습니다.**

`source`·`metadata`·`fallbackUsed`·`fallbackAttempted`·`fallbackReason`·`execution`·`primary`·
`previous`·`result`·`product`·`latitude`·`longitude`·`grid`·`request`·`plan`·`stale`·`error`·`stage`.

`fallbackUsed`와 execution trace는 `selection` 내부에만 존재합니다. overview에는 application trace를
넣지 않습니다.

## reference 정책

| 관계 | 계약 |
| --- | --- |
| success `result.selection` | selector 결과와 동일 reference |
| success `result.overview` | assembler 결과와 동일 reference |
| LOCATION `result` | facade 결과와 동일 reference |
| resolver `selection` input | selector 결과와 동일 reference (selected) |
| resolver output → assembler `source` | 동일 reference |

다음을 mutate하지 않습니다: service input, original/parsed location, options, facade result, execution
trace, selection, source metadata, overview. 각 호출은 **fresh** success wrapper를 만들며,
global/cache/singleton/counter가 없습니다.

## synchronous facade / location errors

method는 `async`가 아닙니다. 다음은 **동기 throw**를 유지합니다(동일 error reference).

- `weatherLocation.parse` error
- location facade의 synchronous throw(예: converter `RangeError`, injected facade programmer error)

이들은 Promise로 변환하지 않습니다.

## Promise rejection 정책

다음은 returned Promise **rejection**입니다(동일 error reference).

- facade Promise rejection
- fulfillment handler 내부의 selector throw
- fulfillment handler 내부의 resolver throw
- fulfillment handler 내부의 assembler throw
- fulfillment handler 내부에서 PR #23 assembler가 던지는 selected-empty `ZodError`(아래 "PR #23
  selected-empty guard 유지" 참조)

facade Promise identity는 `.then` transformation 때문에 **보존하지 않습니다**(정상 orchestration).

## no catch / logging

- broad `try`/`catch`가 없습니다.
- custom error union·error wrapping·message 변경·logging·partial result가 없습니다.

## no composition / route / cache

- 이 service는 어떤 production composition root에도 조립되지 않았습니다.
- callable production composition root 4개(grid scheduled·location scheduled·grid fallback·location
  fallback)는 이 PR로 변경되지 않습니다.
- `/weather` route·startup·HTTP status/envelope mapping·cache/stale-data와 무관합니다.
- contracts·weather-core·provider·기존 fallback trace를 변경하지 않으며, 신규 dependency를 추가하지
  않습니다.

## PR #23 selected-empty guard 유지

custom selection policy가 structurally valid한 selected-empty result(selected true, hourly `[]`)를
반환하더라도, 실제 PR #23 assembler의 nonempty guard가 integrated service에서도 그대로 동작합니다. 다만
그 오류가 관찰되는 경계는 assembler 호출 방식에 따라 다릅니다.

- assembler 함수를 **직접** 호출하면 selected-empty 입력은 assembler-local nonempty guard의 **동기
  `ZodError`** throw입니다.
- 이 service에서는 assembler가 facade Promise의 `.then` fulfillment handler 안에서 호출되므로, assembler의
  그 동기 throw는 service가 반환한 Promise를 **동일한 `ZodError` reference**로 reject시킵니다. 따라서 caller는
  `await` 또는 Promise rejection handling으로 관찰하며, service method 자체가 selected-empty 때문에 동기
  throw하는 것은 아닙니다.

이때 partial success result를 반환하지 않고, selected source metadata를 overview payload로 노출하지
않으며, input을 mutate하거나 logging하지 않습니다.

## selector / assembler 책임 대비

| | Service — PR #24 | Selector — PR #22 | Assembler — PR #23 |
| --- | --- | --- | --- |
| 입력 | `WeatherLocation` + `product` (+ options) | execution trace | precomputed selection + location + source |
| 역할 | validation → facade → LOCATION narrow → selector → resolver seam → assembler | primary/previous/none 선택 | hourly-only overview 조립 |
| 출력 | selection + overview 또는 LOCATION passthrough | selection | partial `WeatherOverview` |

## 후속 production resolver 계획

이 service는 orchestration seam만 구현합니다. 진행 상황:

1. ~~selected-source production provenance strategy 확정~~ — PR #26에서 확정.
2. ~~production resolver 구현~~ — PR #26 `createKmaLiveSelectedHourlySourceMetadataResolver`
   ([kma-selected-hourly-source-metadata.md](./kma-selected-hourly-source-metadata.md)).
3. PR #24 service + PR #26 resolver를 production composition에 조립 (PR #27).
4. `/weather` route.
5. cache/stale-data.
6. authenticated KMA E2E.

## 범위 밖 (이 PR #24 service 자체 기준)

- production resolver 자체의 로직 / default resolver / sourceId naming policy — resolver는 이 service가
  주입받는 별도 컴포넌트이며 PR #26이 구현합니다. 이 service는 여전히 resolver 로직을 소유하지 않습니다.
- issuedAt 계산 / baseDate·baseTime parsing / fetchedAt clock / retrievalMode 자동 선택 (이 service 내부에서)
- request-plan 재생성 / execution trace를 이 service에서 확장 / **full** primary·previous request·nx·ny 노출
  (sanitized issuance identity는 PR #25 fallback service가 이미 trace에 보존하며 이 service는 그것을 소비만
  하고 확장하지 않습니다)
- composition root / startup / `/weather` route / HTTP mapping / API envelope
- current / daily / air-quality / alerts
- cache / stale-data
- live KMA call / 신규 dependency

## 변경 이력

```text
v1 / PR #24 / 2026-07
- location fallback → selector → resolver → assembler orchestration
- LOCATION passthrough
- partial WeatherOverview success (no-selection도 ok:true)
- selected-only provenance resolution (injected resolver seam)
- 별도 clock/base-time으로 issuedAt 재계산 금지
- production wiring 제외 (resolver/composition/route)

v2 / PR #25 / 2026-07 (execution trace가 sanitized issuance identity 보존; 이 service runtime은 불변)
- injected resolver가 selection.execution.primaryIssuance / previousIssuance로 actual 발표시각 identity에 접근 가능
- resolver input own key는 여전히 product/location/selection 세 개(issuance 복제 없음)
- 이 service의 runtime/public types/resolver input은 불변; production resolver는 PR #26 범위

v3 / PR #26 / 2026-07 (live production resolver 구현; 이 service runtime은 불변)
- createKmaLiveSelectedHourlySourceMetadataResolver가 이 service가 주입받는 production resolver로 구현됨
- resolver가 selection.execution의 실제 issuance로 issuedAt(KST)/sourceId/fetchedAt/retrievalMode(LIVE)를 생성
- 이 service의 factory signature·runtime·public types·resolver input(product/location/selection)은 불변
- production composition·/weather route·cache는 여전히 후속(PR #27)
```
