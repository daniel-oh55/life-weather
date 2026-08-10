# KMA current-observation source metadata policy / resolver

이 문서는 PR #73에서 추가한 **current `SourceMetadata` 정책**과 **live current source metadata
resolver** (`createKmaLiveCurrentSourceMetadataResolver`), 그리고 그 정책을 반영하도록 확장된
current-only `WeatherOverview` assembler(`assembleKmaCurrentWeatherOverview`)의 책임과 경계를
기록합니다.

이 문서는 [kma-selected-hourly-source-metadata.md](./kma-selected-hourly-source-metadata.md)의
PR #26 hourly resolver와 **같은 형태를 따르는 별도, 병렬** 구현입니다 — 두 resolver를 generic
abstraction으로 합치지 않습니다. current와 forecast는 provenance semantics가 다릅니다
(forecast → `issuedAt`, current → `observedAt`).

## 목적

- PR #72 current-only `WeatherOverview` assembler는 `sources: []`로 provenance를
  **의도적으로 미루었습니다** — current `SourceMetadata` 정책과 resolver는 후속 PR 책임이라고
  명시했습니다.
- 이 PR은 그 정책을 확정합니다: current `SourceMetadata`가 존재할 때 정확히 어떤 값을
  가져야 하는지(`provider`/`sections`/`issuedAt`/`observedAt`은 고정, `sourceId`/`fetchedAt`/
  `retrievalMode`는 live resolver가 materialize)를 정의하고, assembler를 그 정책을 소비하도록
  확장하며, live resolver 구현을 추가합니다.
- 이 PR은 resolver·assembler 확장과 그 unit test만 추가합니다. location current pipeline과의
  application orchestration, production composition integration, `POST /weather` wiring,
  current-observation availability-delay selector, 실제 인증 KMA API 호출은 포함하지 않습니다
  (아래 "범위 밖" 참조).

## 구현 위치

- [kma-current-source-metadata.ts](../apps/api/src/services/kma-current-source-metadata.ts) —
  live resolver
- [kma-current-source-metadata.test.ts](../apps/api/src/services/kma-current-source-metadata.test.ts)
  — resolver 테스트
- [kma-current-weather-overview.ts](../apps/api/src/services/kma-current-weather-overview.ts) —
  metadata-aware assembler (PR #72에서 확장)
- [kma-current-weather-overview.test.ts](../apps/api/src/services/kma-current-weather-overview.test.ts)
  — assembler 테스트 (강화됨)

이 위치(`apps/api/src/services`)에 두는 이유: current observation 결과를 `SourceMetadata`
provenance로 변환하는 **application-layer** 로직입니다. Provider boundary가 아니며, `weather-core`
순수 domain 계산도 아닙니다.

허용 import는 contracts public surface와 sibling service의 public type뿐입니다.

```ts
import { isoDateTime, type SourceMetadata } from '@life-weather/contracts';

import type { KmaCurrentSourceMetadataInput } from './kma-current-weather-overview.js';
```

Provider 호출·request factory·location facade·current-observation service·composition import·
Hono·`process.env`·`fetch`·`AbortController`·external timezone/date library·신규 dependency는
사용하지 않습니다.

## 공개 API

```ts
// kma-current-weather-overview.ts
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

// kma-current-source-metadata.ts
export interface KmaCurrentSourceMetadataClock {
  readonly nowEpochMilliseconds: () => number;
}

export type KmaCurrentSourceMetadataResolver = () => KmaCurrentSourceMetadataInput;

export function createKmaLiveCurrentSourceMetadataResolver(
  clock: KmaCurrentSourceMetadataClock,
): KmaCurrentSourceMetadataResolver;
```

추가 public class는 만들지 않습니다.

## 정책 — current `SourceMetadata`의 7 field

Observed current data의 `SourceMetadata`는 다음과 같이 고정됩니다.

| field | 값 | 결정 주체 |
| --- | --- | --- |
| `sourceId` | 고정 canonical id, live resolver가 반환 | resolver → assembler가 caller `source`에서 그대로 사용 |
| `provider` | 고정 `'KMA'` | assembler |
| `sections` | 고정 `['CURRENT']` | assembler |
| `issuedAt` | 고정 `null` | assembler |
| `observedAt` | `CurrentWeather.observedAt` 그대로 | assembler |
| `fetchedAt` | live resolver가 clock에서 materialize | resolver → assembler가 caller `source`에서 그대로 사용 |
| `retrievalMode` | 고정 `'LIVE'` (resolver가 결정) | resolver → assembler가 caller `source`에서 그대로 사용 |

즉 assembler의 `KmaCurrentSourceMetadataInput` caller 입력은 정확히 3개 field
(`sourceId`/`fetchedAt`/`retrievalMode`)뿐이며, 나머지 4개(`provider`/`sections`/`issuedAt`/
`observedAt`)는 assembler가 current-data semantics로부터 고정합니다.

### `issuedAt: null` — 초단기실황은 발표시각이 아님

초단기실황(current observation)은 forecast issuance metadata로 표현하지 않습니다. request
factory가 사용한 `baseDate`/`baseTime`을 `issuedAt`으로 복사하거나 재구성하지 않습니다. 이는
hourly의 `issuedAt`(발표시각)과 개념적으로 다른 축입니다 — current는 "언제 관측되었는가"만
의미가 있고, "언제 발표되었는가"는 없습니다.

### `observedAt` — `CurrentWeather.observedAt` 그대로

Assembler는 `SourceMetadata.observedAt`을 `input.current.observedAt`에서 **그대로** 읽습니다.

금지:

- `Date.now()`/`new Date()`로 생성
- resolver clock으로 생성
- request factory base time으로 재조립
- timezone 재변환
- rounding/defaulting
- 값 추정

이미 정규화된 `CurrentWeather`가 관측 시각의 단일 source of truth입니다.

### `fetchedAt` — resolver materialization 시각

live resolver가 source metadata provenance를 materialize한 server instant입니다. 다음의 exact
timestamp라고 주장하지 않습니다.

- HTTP dispatch instant
- response header received instant
- response body read completion instant
- exact provider transport completion instant

현재 pipeline은 그런 transport timestamp를 보존하지 않기 때문에, resolver 호출 시각이 정직하고
사용 가능한 근사값입니다.

### `retrievalMode: 'LIVE'` — cache 미구현

live resolver는 항상 `'LIVE'`를 반환합니다. `CACHE`/`UNKNOWN`을 반환하지 않습니다. 향후 cache
layer는 저장된 upstream `fetchedAt`을 보존해야 하며, cache read 시각으로 덮어쓰지 않습니다. 이
live resolver를 cache path에 재사용하지 않습니다. 이번 PR에서는 cache를 구현하지 않습니다.

## sourceId — canonical, 충돌 확인 완료

캐노니컬 id는:

```text
kma-ultra-short-current-observation
```

구현 전 `apps/api/src`, `packages`, `docs` 전체에서 이미 정의된 current-observation용
canonical `sourceId`가 있는지 확인했고, 존재하지 않았습니다(hourly의
`kma-short-forecast-hourly`/`kma-ultra-short-forecast-hourly`만 존재).

이 id는 app-internal logical source identifier이며 다음을 절대 포함하지 않습니다.

- location / location ID
- latitude / longitude
- nx / ny
- baseDate / baseTime
- observedAt
- fetchedAt
- request ID
- PRIMARY / PREVIOUS
- service key
- URL / query

## resolver — 입력 없음(nullary)

PR #26 hourly resolver와 달리 이 resolver는 **입력을 받지 않습니다.** 초단기실황에는 상관시켜야
할 issuance identity나 `PRIMARY`/`PREVIOUS` selection이 없기 때문입니다. resolver가 결정하는
사실은 고정 상수이거나 injected clock에서 옵니다.

- `sourceId` → 고정 canonical id
- `retrievalMode` → 고정 `'LIVE'`
- `fetchedAt` → injected clock에서 정확히 1회 읽어 materialize

`provider`/`sections`/`issuedAt`/`observedAt`은 resolver가 아니라 assembler가 결정합니다.
resolver에는 다음을 전달하지 않습니다 — `WeatherLocation`, latitude/longitude, nx/ny,
`CurrentWeather`, request, baseDate/baseTime, provider result, raw response.

## exact output keys

resolver output own key는 정확히 다음 세 개이며 정렬 순서는 다음과 같습니다.

- `fetchedAt`
- `retrievalMode`
- `sourceId`

```ts
{
  fetchedAt,   // UTC Z, ms
  retrievalMode: 'LIVE',
  sourceId,    // 고정 canonical id
}
```

다음을 절대 반환하지 않습니다: `provider`, `sections`, `issuedAt`, `observedAt`, `location`,
`latitude`, `longitude`, `nx`, `ny`, `request`, `baseDate`, `baseTime`, `serviceKey`, `URL`,
`query`, raw provider data.

## resolver clock call policy

- **construction**: clock 0회, environment 0회, network 0회, `Date` 0회, state/cache 0개.
- **유효한 호출**: injected clock을 **정확히 1회** 읽습니다.
- **invalid clock 값**: clock을 읽은 **뒤**(값을 읽어야 판단 가능하므로) static `RangeError`로
  거부합니다.
- **clock이 throw**: 동일 error reference가 그 1회 읽기 뒤 synchronous하게 전파됩니다.

### fetchedAt 형식

- `Number.isSafeInteger(epochMilliseconds)`로 값을 확인하고, `new Date(...)`의 `getTime()`이
  finite인지 확인한 뒤, `date.toISOString()` 결과를 다시 `isoDateTime.safeParse`로 확인합니다.
- 허용: `0`, negative valid epoch, current epoch, millisecond precision.
- 거부(모두 static `RangeError`, `Invalid KMA current source metadata clock value`): `NaN`,
  `Infinity`, `-Infinity`, fractional number, unsafe integer, Date 범위 밖, ISO contract가 받지
  못하는 결과.
- raw clock value는 error message에 포함하지 않습니다.

## 오류 / privacy / secret 정책

static resolver error message에는 절대 다음을 넣지 않습니다.

- raw clock value
- location / location id / latitude / longitude / nx / ny
- request / baseDate / baseTime
- service key / URL / query
- raw KMA response / upstream message

실제 `KMA_SERVICE_KEY`를 읽거나 출력하지 않습니다. 실제 외부 endpoint를 호출하지 않습니다.
실제 사용자 좌표를 사용하지 않습니다. 테스트는 synthetic fixture만 사용합니다.

## explicit-field 구성 — assembler는 spread하지 않음

Assembler는 `SourceMetadata`를 `{ ...input.source }`처럼 만들지 않습니다. `sourceId`/
`fetchedAt`/`retrievalMode`만 caller `source`에서 읽고, 나머지 4 field는 명시적으로 고정값을
씁니다.

이유: TypeScript 타입을 우회한 runtime 값이 `input.source`에 `provider`/`sections`/
`issuedAt`/`observedAt` 등 extra property를 담아도, output의 fixed current-data policy를
override하거나 leak시킬 수 없습니다. Output `SourceMetadata`는 항상 contracts 기준 정확한 7개
key만 가집니다.

## purity / mutation / freshness

### assembler

- `input`/`input.location`/`input.current`/`input.source`를 mutate하지 않습니다. frozen input
  에서도 정상 동작합니다.
- 호출마다 fresh overview를 반환합니다 — `sources[0]`을 포함해 모든 nested object/array가 매
  호출 새로 생성됩니다.
- clock/environment/network를 읽지 않고, `console.*`를 호출하지 않습니다.
- `weatherOverview.parse`가 유일한 runtime validation boundary입니다 — 별도
  `currentWeather.parse()` 중복 호출이나 새 error union, broad `try`/`catch`, fallback payload가
  없습니다.

### resolver

- resolver input이 없으므로 mutate할 대상도 없습니다. clock을 mutate하지 않습니다.
- 호출마다 fresh metadata object를 반환합니다 — 동일 clock 값이라도 wrapper reference는
  다릅니다.
- module-level mutable state가 없습니다. construction은 clock을 closure로 잡을 뿐입니다.

## application orchestration — 이번 PR 금지, PR #74에서 연결됨

다음 pipeline은 이 PR(#73)에서 연결하지 않았습니다.

```text
location facade → current result → resolver → assembler
```

`createKmaLocationCurrentWeatherOverviewService` 또는 이에 준하는 orchestration component는
이 PR 범위 밖이었습니다 — resolver와 assembler는 독립된 building block으로만 존재했습니다. **PR
#74**가 `createKmaLocationCurrentOverviewService`
([kma-location-current-overview.md](./kma-location-current-overview.md))로 이 pipeline을
연결했습니다 — 다만 PR #74도 production resolver를 스스로 선택하지 않고(resolver는 여전히 필수
주입) production composition에도 연결하지 않으므로, `POST /weather`의 `current`는 PR #74 이후에도
계속 missing입니다.

## production composition / route — 이번 PR 금지

- PR #69/#71 current composition(`createKmaLocationScheduledCurrentObservationCompositionFromEnv`
  등)은 변경하지 않았습니다 — 여전히 기존 facade만 반환합니다.
- `apps/api/src/routes/**`, `presenters/**`, `index.ts`, `api-app.ts`는 변경하지 않았습니다.
- `POST /weather`의 `current`는 이 PR 이후에도 계속 missing입니다.

이어서 **PR #75**가 이 live resolver를 PR #71 location composition, PR #74 application service와
함께 조립하는 production composition root(`createKmaLocationCurrentOverviewCompositionFromEnv`,
[kma-location-current-overview-composition.md](./kma-location-current-overview-composition.md))를
추가했습니다 — 이 resolver 자체의 공개 계약(nullary, injected clock, 1회 read, 3-key output)은
변경되지 않았습니다. PR #75도 `POST /weather` route는 연결하지 않으므로, production `current`는 PR
#75 이후에도 계속 missing입니다.

## contracts — 변경 없음

`packages/contracts/**`, `CONTRACT_VERSION`은 변경하지 않았습니다. 기존 `SourceMetadata`와
`WeatherOverview` schema만으로 이 정책을 표현할 수 있습니다. "current 존재 시 CURRENT
SourceMetadata 필수"라는 새 invariant는 contracts에 추가하지 않았습니다 — 이 정책은
application-layer(assembler) 결정이지 contract 강제 규칙이 아닙니다.

## tests

- resolver unit: construction(clock 0회), valid output(고정 sourceId/LIVE/clock-derived
  fetchedAt), clock read count(1회/2회 + fresh reference), exact output shape(3 keys), no
  leakage, invalid clock 값(NaN/Infinity/-Infinity/fractional/unsafe/Date 범위 밖, 모두 static
  RangeError, raw 값 미노출), throwing clock(동일 reference 전파).
- assembler unit(PR #72 기존 테스트 + 확장): valid assembly, CURRENT present, missingSections
  exact 5개, CurrentWeather 값 보존, 다른 section 고정, **sources 정확히 1개 + 7 key + provider/
  sections/issuedAt/observedAt 고정값 + caller sourceId/fetchedAt/retrievalMode 보존**, exact
  top-level keys, validation failures(location/current/sourceId/fetchedAt/retrievalMode 각각
  synchronous ZodError), immutability, fresh output per call, synchronous/no-I/O 계약,
  **explicit-field 구성 — extra runtime source property가 leak되지도 override하지도 않음**.
- 대표 non-vacuity mutant 7개 검증 완료(아래 "non-vacuity" 참조).
- shuffle seed 1/17에서 통과합니다.

### non-vacuity 검증

다음 대표 mutant를 임시 적용해 targeted test가 실제로 실패하는지 확인한 뒤 즉시 원복하고
`git diff`로 잔여가 없음을 확인했습니다.

- assembler `sources`를 `[]`로 변경 → 15개 테스트 실패
- assembler `SourceMetadata.observedAt`을 `null`로 변경 → 2개 테스트 실패
- assembler가 explicit field 대신 `{ ...input.source }` spread로 fixed field를 override
  가능하게 변경 → 1개 테스트 실패
- assembler에서 `weatherOverview.parse` 제거 → 9개 테스트 실패
- resolver canonical `sourceId`를 다른 값으로 변경 → 1개 테스트 실패
- resolver `retrievalMode`를 `'UNKNOWN'`으로 변경 → 1개 테스트 실패
- resolver가 clock을 무시하고 고정 `fetchedAt`을 반환하도록 변경 → 18개 테스트 실패

## 범위 밖

- ~~location current pipeline과 resolver/assembler를 잇는 application orchestration~~ — PR #74에서
  구현
- ~~production composition integration~~ — PR #75에서 구현
- `POST /weather` current wiring
- current-observation availability-delay selector
- 실제 인증 KMA API 호출을 통한 live 검증
- cache / stale-data
- retry / fallback
- hourly resolver와의 generic 통합·리팩터

## 변경 이력

```text
v1 / PR #73 / 2026-08
- current SourceMetadata 정책 확정: provider/sections/issuedAt/observedAt은 assembler 고정,
  sourceId/fetchedAt/retrievalMode는 live resolver가 materialize
- canonical current sourceId: kma-ultra-short-current-observation (충돌 없음 확인)
- createKmaLiveCurrentSourceMetadataResolver 추가 — nullary, injected clock, fetchedAt 1회 read
- assembleKmaCurrentWeatherOverview가 KmaCurrentSourceMetadataInput(source)을 받아 metadata-aware가
  됨 — PR #72의 sources: [] 정책을 대체
- explicit-field SourceMetadata 구성(spread 없음) — 나머지 4 field override/leak 방지
- application orchestration / production composition / POST /weather wiring / availability-delay
  selector / 실제 KMA 호출은 이 PR 범위 밖 (후속 PR)

v2 / PR #74 / 2026-08 (이 resolver/assembler 자체는 불변)
- 이 문서의 resolver·assembler 공개 계약 변경 없음
- application orchestration을 createKmaLocationCurrentOverviewService가 구현(별도 파일/PR)
- production composition/POST 연결/availability-delay selector는 여전히 범위 밖

v3 / PR #75 / 2026-08 (이 resolver/assembler 자체는 불변)
- 이 문서의 resolver·assembler 공개 계약 변경 없음
- production composition root(createKmaLocationCurrentOverviewCompositionFromEnv)가 이 live
  resolver를 PR #71/#74와 함께 조립(별도 파일/PR)
- POST /weather 연결/availability-delay selector는 여전히 범위 밖
```
