# KMA location current WeatherOverview production composition

이 문서는 PR #75에서 추가한 **production composition root**
(`createKmaLocationCurrentOverviewCompositionFromEnv`)의 책임과 경계를 기록합니다. 이 root는 이전
building block 두 개를 실제 server 환경에서 조립합니다.

- PR #71 location scheduled current-observation composition
- PR #73 live current source metadata resolver

이 root는 [kma-location-hourly-overview-composition.md](./kma-location-hourly-overview-composition.md)의
PR #27 location hourly-overview composition과 같은 원칙을 따르는 **별도·병렬** 구현입니다 —
hourly와 current composition을 generic abstraction으로 합치지 않습니다.

구현 위치:

- [kma-location-current-overview.ts](../apps/api/src/composition/kma-location-current-overview.ts) — production composition root
- [kma-location-current-overview.test.ts](../apps/api/src/composition/kma-location-current-overview.test.ts) — 테스트
- [composition/index.ts](../apps/api/src/composition/index.ts) — composition barrel(이 root export 추가)

## 목적

- 지금까지 PR #71 location current facade, PR #73 live resolver, PR #74 application service는 각각
  구현만 되어 있고 실제 server 환경(`process.env`, production 협력자)에서 이들을 실제로 연결하는
  composition root가 없었습니다.
- 이 PR은 environment에서 live `KmaLocationCurrentOverviewService`까지의 **production wiring만**
  구현합니다. 새로운 KMA 데이터 규칙, provenance 정책, `WeatherOverview` 조립 규칙을 추가하지
  않습니다.
- 이 PR은 `POST /weather` route에 current를 연결하지 않습니다(아래 "이 PR의 범위 밖" 참고).

## 정확한 조립 그래프

```text
environment / injected dependencies
  → createKmaLocationScheduledCurrentObservationCompositionFromEnv   // PR #71, 그대로 재사용
  → live KmaLocationScheduledCurrentObservationFacade
          +
injected dependencies.clock 또는 fresh createKmaSystemClock()        // resolver 전용 clock 선택
          ↓
createKmaLiveCurrentSourceMetadataResolver                          // PR #73
  → live KmaCurrentSourceMetadataResolver
          +
location current facade + resolver
          ↓
createKmaLocationCurrentOverviewService                             // PR #74
  → live KmaLocationCurrentOverviewService
```

## 공개 API

```ts
export type KmaLocationCurrentOverviewCompositionDependencies =
  KmaLocationScheduledCurrentObservationCompositionDependencies;

export type CreateKmaLocationCurrentOverviewCompositionResult =
  | {
      readonly ok: true;
      readonly service: KmaLocationCurrentOverviewService;
    }
  | {
      readonly ok: false;
      readonly error: KmaProviderConfigError;
    };

export function createKmaLocationCurrentOverviewCompositionFromEnv(
  env?: NodeJS.ProcessEnv,
  dependencies?: KmaLocationCurrentOverviewCompositionDependencies,
): CreateKmaLocationCurrentOverviewCompositionResult;
```

`dependencies`는 PR #71 composition의 `{ fetchImpl?, clock? }`를 그대로 alias합니다 — 이 PR은 새
dependency field를 추가하지 않습니다. PR #74 service의 default assembler(`assembleKmaCurrentWeatherOverview`)는
이 composition에서 별도로 선택·주입하지 않습니다.

## PR #71 그래프 재사용 — 재조립하지 않음

이 PR은 다음을 직접 다시 조립하지 **않습니다**.

- provider-from-env
- request factory
- current-observation service
- scheduled facade
- latitude/longitude → grid converter
- location scheduled current facade

모두 기존 `createKmaLocationScheduledCurrentObservationCompositionFromEnv(env, dependencies)`를 그대로
호출해서 재사용합니다. `env`/`dependencies`는 **exact reference**로 전달됩니다(clone·spread·mutation·
구조분해 후 재조립 없음). 이 함수 호출은 정확히 1회입니다.

## config 실패 — exact reference pass-through

PR #71 composition이 `{ ok: false, error }`를 반환하면:

- 이 composition도 **동일 error reference**를 그대로 반환합니다.
- 새 error type을 만들지 않고, throw로 전환하지 않고, message를 추가하지 않고, logging하지 않습니다.
- 이 경우 다음은 **실행/생성되지 않습니다**: resolver clock 선택, `createKmaSystemClock`, current
  metadata resolver, overview service, network.

## clock 소유권

### injected clock 공유 (dependencies.clock 존재)

`dependencies.clock`이 주입되면, 그 **동일 reference**가 PR #71 composition(→ PR #69 request
factory)에 이미 전달된 clock이자, PR #73 resolver의 clock으로도 재사용됩니다 — wrapper·clone·별도
adapter를 만들지 않습니다. 정상 지원 위치의 성공한 current 요청 한 번은 이 injected clock을 정확히
**2회** 읽습니다.

1. 첫 read — request factory / base-time 선택
2. 두 번째 read — current SourceMetadata resolver / `fetchedAt`

### default clock — encapsulation 보존

`dependencies.clock`이 없으면:

- 기존 PR #71 → PR #69 그래프는 자신의 내부 production system clock을 계속 선택합니다. 그 내부
  clock을 꺼내거나 기존 composition contract를 변경해 공유하지 않습니다.
- 이 composition은 resolver 전용으로 `createKmaSystemClock()`을 **새로** 한 번 호출해 fresh
  stateless adapter를 만듭니다.

즉 default path는 서로 독립된 두 adapter입니다 — existing current graph의 내부 adapter와, resolver
전용 fresh adapter. 둘 다 construction 시 `Date.now()`를 읽지 않습니다. 이는
[kma-location-hourly-overview-composition.md](./kma-location-hourly-overview-composition.md)의 PR #27
선례와 동일합니다.

## runtime outcome별 clock 횟수

| 시나리오 | request clock | resolver clock | 합계 | fetch |
| --- | --- | --- | --- | --- |
| 지원 위치 성공 | 1 | 1 | 2 | 1 |
| `LOCATION` 미지원 | 0 | 0 | 0 | 0 |
| `PROVIDER` 실패 | 1 | 0 | 1 | 1(또는 pre-aborted 시 0) |
| `NORMALIZATION` 실패 | 1 | 0 | 1 | 1 |
| pre-aborted signal | 1 | 0 | 1 | 0 |
| resolver 두 번째 read throw | 1 | 1(throw) | 2 | 1 |

이 정책은 이 PR이 새로 만드는 것이 아니라, 기존 그래프와 PR #73/#74 component를 정확히 조립했을 때의
observable behavior입니다.

## 성공 결과 표면

```ts
{
  ok: true,
  service,
}
```

own key는 정확히 `ok`/`service`뿐입니다. 노출하지 않는 것: `facade`/`resolver`/`clock`/`provider`/
`requestFactory`/`currentObservationService`/`converter`/`assembler`/`env`/`dependencies`/`fetchImpl`/
`serviceKey`/URL/request/baseDate/baseTime. `service`는 PR #74의
`fetchCurrentWeatherOverviewForLocation`만을 기존 공개 계약대로 제공합니다.

## callable / lazy composition

새 root는 **callable function**입니다 — module-scope singleton이 아닙니다. import만으로는 다음이
전혀 일어나지 않습니다: `process.env` read, provider construction, `createKmaSystemClock`, clock
read, `Date.now()`, converter, resolver, assembler, network, timer/listener, logging, route
registration.

composition **함수 호출** 시에는 기존 provider configuration 읽기/validation, collaborator
construction/wiring, system-clock adapter object construction만 허용됩니다 — `clock.nowEpochMilliseconds()`,
`Date.now()`, converter 실행, provider fetch, resolver 실행, assembler 실행은 호출 시점에도 일어나지
않습니다. 첫 실제 실행은 반환된 `service.fetchCurrentWeatherOverviewForLocation()` 호출 때입니다.

매 호출은 독립된 그래프를 만듭니다(module-level singleton/cache 없음).

## 이 PR(#75)의 범위 밖

- **`POST /weather` route 연결** — 없음. production `POST /weather`의 `current`는 이 PR 이후에도
  계속 missing입니다.
- **current-observation availability-delay selector** — 없음. PR #69의 schedule-only selector를 그대로
  상속합니다. 이 selector가 upstream 자료의 실제 게시를 보장한다고 주장하지 않습니다.
- **cache / stale-data / retry / fallback / source selection** — 없음.
- **`packages/contracts` / `packages/weather-core` / `packages/lifestyle-engine` 변경** — 없음.
- **`apps/api/src/providers/**` / `apps/api/src/services/**` 변경** — 없음(PR #73/#74를 그대로
  소비만 합니다).
- **`apps/api/src/routes/**` / `presenters/**` / `index.ts` / `api-app.ts` / `weather-route.ts`
  변경** — 없음.
- **기존 PR #69/#71/#73/#74 runtime 구현 변경** — 없음.
- **실제 인증 KMA API 호출 / 실사용자 위치 / mobile / native / 신규 dependency** — 없음.

## 변경 이력

```text
v1 / PR #75 / 2026-08
- location current WeatherOverview production composition root 추가
  (createKmaLocationCurrentOverviewCompositionFromEnv)
- PR #71 location scheduled current-observation composition을 exact reference로 재사용
- PR #73 live current source metadata resolver를 injected/default clock 정책으로 연결
- PR #74 location current-overview application service로 최종 조립
- 여덟 번째 병렬 callable production root(기존 일곱 root는 불변)
- POST /weather 연결, availability-delay selector, cache/stale, 실제 인증 KMA 호출은 이 PR 범위 밖
```
