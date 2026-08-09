# KMA 초단기실황 current-only `WeatherOverview` assembler

이 문서는 PR #72에서 추가하고 **PR #73에서 metadata-aware로 확장한** **pure, synchronous 함수**
한 개(`assembleKmaCurrentWeatherOverview`)의 책임과 경계를 기록합니다. 이 함수는
[kma-hourly-weather-overview.md](./kma-hourly-weather-overview.md)의 PR #23 hourly
`WeatherOverview` assembler(`assembleKmaHourlyWeatherOverview`)와 **같은 형태를 따르는 별도의,
병렬** 구현입니다 — 두 assembler를 generic abstraction으로 합치지 않습니다.

> **PR #72 → PR #73 evolution**: PR #72는 `sources: []`로 current provenance를 의도적으로
> 미루었습니다(아래 "PR #72 당시" 절 참고). PR #73은 그 provenance 정책을 확정하고 이 assembler를
> 확장해 `sources`가 정확히 하나의 `CURRENT` `SourceMetadata`를 담도록 만들었습니다. 자세한 정책과
> live resolver는 [kma-current-source-metadata.md](./kma-current-source-metadata.md)를 참고하세요.

구현 위치:

- [kma-current-weather-overview.ts](../apps/api/src/services/kma-current-weather-overview.ts) —
  assembler
- [kma-current-weather-overview 테스트](../apps/api/src/services/kma-current-weather-overview.test.ts)

## 목적

이미 정규화된 contracts `CurrentWeather`(PR #63 provider → PR #63 normalizer → PR #67 service
경로의 출력)를 `WeatherOverview.current`에 채워, **current 섹션만 있는 partial
`WeatherOverview`**를 만듭니다.

```text
WeatherLocation
  +
CurrentWeather
  →
WeatherOverview
  - current: present
  - hourly / daily / alerts: []
  - airQuality.current: null / airQuality.daily: []
  - missingSections: ['HOURLY', 'DAILY', 'AIR_QUALITY_CURRENT', 'AIR_QUALITY_FORECAST', 'ALERTS']
  - sources: []
```

## 공개 API

```ts
export type KmaCurrentSourceMetadataInput = Pick<
  SourceMetadata,
  'sourceId' | 'fetchedAt' | 'retrievalMode'
>;

export interface KmaCurrentWeatherOverviewInput {
  readonly location: WeatherLocation;
  readonly current: CurrentWeather;
  readonly source: KmaCurrentSourceMetadataInput;
}

export function assembleKmaCurrentWeatherOverview(
  input: KmaCurrentWeatherOverviewInput,
): WeatherOverview;
```

- 입력은 `location`/`current`/`source` 세 field를 갖는 `KmaCurrentWeatherOverviewInput`입니다 —
  새 result union, stage discriminator, execution trace를 요구하지 않습니다(hourly assembler의
  `KmaHourlyFallbackSelection` 소비 구조와 다른 지점: current-observation은 fallback 선택 단계가
  없으므로, 이 assembler는 caller가 이미 가진 단일 `CurrentWeather`만 받습니다).
- **PR #73부터** `source`는 caller가 제공하는 `KmaCurrentSourceMetadataInput`
  (`sourceId`/`fetchedAt`/`retrievalMode`)입니다. PR #72 당시에는 이 field가 없었습니다(아래 "PR
  #72 당시" 참고).
- `apps/api/src/services/index.ts`에서 `assembleKmaCurrentWeatherOverview`,
  `KmaCurrentWeatherOverviewInput`, `KmaCurrentSourceMetadataInput`을 export합니다.

## `missingSections` — 정확한 5개, CURRENT는 제외

```ts
[
  'HOURLY',
  'DAILY',
  'AIR_QUALITY_CURRENT',
  'AIR_QUALITY_FORECAST',
  'ALERTS',
]
```

- 이 순서가 canonical 출력입니다.
- `current`가 항상 존재하므로 `CURRENT`는 이 목록에 절대 포함하지 않습니다.
- 이 assembler는 오직 이 5개 섹션만 채우지 못하므로, 그 외 섹션을 missing으로 표시할 필요가
  없습니다.

## `CurrentWeather` 값을 재계산하지 않음

caller가 전달한 `CurrentWeather`를 그대로 `overview.current`에 씁니다. 다음을 하지 않습니다.

- `observedAt`을 현재 시각으로 덮어쓰기, `Date.now()`/`new Date()` 사용
- `condition` 재판정, `feelsLikeCelsius` 재계산
- 풍향/풍속 rounding, 강수량 단위 재변환
- `null` 값을 임의 기본값으로 변경

이 assembler는 이미 정규화된 contracts `CurrentWeather`를 소비하는 경계이며, 값과 의미를 그대로
보존합니다(reference identity는 계약이 아닙니다 — `weatherOverview.parse`가 fresh nested object를
만듭니다).

## PR #72 당시: `sources: []` — provenance는 후속 PR 책임 (historical)

**이 절은 PR #72 당시의 동작을 기록합니다. PR #73 이후 현재 동작이 아닙니다** — 현재 동작은 바로
아래 "PR #73: sources — 정확히 하나의 CURRENT SourceMetadata" 절을 참고하세요.

contracts `weatherOverview` schema는 `current === null ↔ 'CURRENT' ∈ missingSections`만 강제하고,
`current`가 존재할 때 `SourceMetadata`가 있어야 한다는 규칙은 **강제하지 않습니다.** PR #72
assembler는 그 여지를 이용해 provenance를 **발명하지 않았습니다** — 다음을 결정하거나 생성하지
않았습니다.

```text
sourceId
provider
sections: ['CURRENT']
issuedAt
SourceMetadata.observedAt
fetchedAt
retrievalMode
```

`CurrentWeather.observedAt`과 current `SourceMetadata.observedAt`의 관계도 PR #72에서는 새
규칙으로 정의하지 않았습니다 — "current `SourceMetadata` 조립은 후속 PR의 책임"이라고 명시했습니다.

## PR #73: sources — 정확히 하나의 CURRENT SourceMetadata

PR #73부터 `sources`는 정확히 하나의 KMA `CURRENT` `SourceMetadata` entry를 담습니다.
`provider`/`sections`/`issuedAt`/`observedAt`은 current-data semantics로부터 assembler가 고정하고,
`sourceId`/`fetchedAt`/`retrievalMode`는 caller가 제공한 `source`(전형적으로
`createKmaLiveCurrentSourceMetadataResolver`의 출력)에서 그대로 옵니다. 정책의 전체 근거와 각
field의 정확한 값은 [kma-current-source-metadata.md](./kma-current-source-metadata.md)를
참고하세요. `SourceMetadata`는 `{ ...input.source }` spread가 아니라 explicit named field로
구성되므로, `input.source`에 담긴 어떤 extra runtime property도 고정된 4개 field를 override하거나
output으로 leak될 수 없습니다.

## `weatherOverview.parse` runtime validation

반환 직전 전체 payload를 `weatherOverview.parse(overview)`로 runtime validate합니다(hourly
assembler와 동일한 boundary 소유 방식). 그 결과:

- malformed `WeatherLocation` 또는 malformed `CurrentWeather`는 synchronous Zod error로 실패합니다.
- 별도 validation policy나 새 error union을 만들지 않고, `currentWeather.parse()`를 중복 호출하지도
  않습니다 — `weatherOverview.parse()`가 유일한 contract boundary입니다.
- try/catch로 감싸거나 fallback을 반환하지 않습니다.

## pure / synchronous / no-I/O 경계

`assembleKmaCurrentWeatherOverview`는 다음을 절대 하지 않습니다.

- Provider, current-observation service, location facade, production composition 호출
- clock read(`Date.now()`/`new Date()`), `process.env`, `fetch`, `AbortController`, timer, listener
- `console.*` 호출
- retry, fallback, cache, stale-data, module singleton, global mutable state
- 넓은 `try/catch`

Module import 자체도 side-effect-free입니다.

## Immutability / fresh output

- `input`/`input.location`/`input.current`/`input.source`를 mutate하지 않습니다 — deep-frozen
  input에서도 정상 동작합니다.
- 동일한 input으로 두 번 호출해도 `result1 !== result2`이며, 모든 중첩 array/object가 매 호출마다
  새로 생성됩니다(module-level cache나 shared singleton 없음).
- caller object의 reference identity는 계약이 아닙니다 — `CurrentWeather`의 값과 의미만
  보존됩니다.

## route / composition 미연결

이 assembler는 어떤 application orchestration, composition root, `POST /weather` route에도
연결되지 않았습니다. PR #73으로 current `SourceMetadata` 정책과 live resolver는 구현되었지만,
다음은 여전히 미구현입니다.

- location current pipeline과 이 assembler를 잇는 application orchestration
- production composition integration
- `POST /weather` current wiring
- current-observation availability-delay selector
- 실제 인증 KMA API 호출을 통한 live 검증

즉 PR #73 이후에도 `POST /weather`의 production 응답에서 `current`는 계속 missing입니다.

## 실제 key·네트워크·좌표 미사용

- 실제 `KMA_SERVICE_KEY`를 사용하지 않았습니다.
- 자동 테스트는 실제 네트워크를 호출하지 않고, synthetic `WeatherLocation`/`CurrentWeather`
  fixture만 사용합니다. 실제 사용자 좌표는 사용하지 않습니다.

## 변경 이력

```text
v1 / PR #72 / 2026-08
- WeatherLocation + CurrentWeather → current-only partial WeatherOverview 순수 assembler 추가
- missingSections 정확히 5개(HOURLY/DAILY/AIR_QUALITY_CURRENT/AIR_QUALITY_FORECAST/ALERTS), CURRENT 제외
- sources: [] — current SourceMetadata는 후속 PR 책임
- weatherOverview.parse가 유일한 runtime validation boundary
- pure/synchronous/no-I/O, frozen input 지원, 매 호출 fresh output
- hourly assembler(PR #23)와 별도·병렬 구현, 어느 쪽도 리팩터하지 않음
- route/composition/SourceMetadata/POST 연결/availability-delay selector는 이 PR 범위 밖

v2 / PR #73 / 2026-08
- KmaCurrentWeatherOverviewInput에 source: KmaCurrentSourceMetadataInput 추가 (metadata-aware)
- sources: [] → 정확히 하나의 CURRENT SourceMetadata (provider/sections/issuedAt/observedAt 고정,
  sourceId/fetchedAt/retrievalMode는 caller-provided)
- explicit-field 구성(spread 없음) — extra runtime source property가 override/leak 불가
- createKmaLiveCurrentSourceMetadataResolver 신규 추가(별도 파일, nullary resolver)
- 자세한 정책 근거는 kma-current-source-metadata.md
- application orchestration/production composition/POST 연결/availability-delay selector는
  여전히 이 PR 범위 밖
```
