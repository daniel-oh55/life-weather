# KMA location current + hourly WeatherOverview production composition

이 문서는 PR #78에서 추가한 **production composition root**
(`createKmaLocationCurrentHourlyOverviewCompositionFromEnv`)의 책임과 경계를 기록합니다. 이 root는
이전 building block 두 개를 실제 server 환경에서 조립합니다.

- PR #27 location hourly-overview production composition
- PR #75 location current-overview production composition

그리고 그 두 live application service를 PR #77 combined application orchestration에 연결합니다.

이 root는 hourly와 current를 각각 재구현하지 않는 **조립 전용(combining)** root입니다 —
[kma-location-hourly-overview-composition.md](./kma-location-hourly-overview-composition.md)와
[kma-location-current-overview-composition.md](./kma-location-current-overview-composition.md)의
기존 root를 그대로 재사용합니다.

구현 위치:

- [kma-location-current-hourly-overview.ts](../apps/api/src/composition/kma-location-current-hourly-overview.ts) — production composition root
- [kma-location-current-hourly-overview.test.ts](../apps/api/src/composition/kma-location-current-hourly-overview.test.ts) — 테스트
- [composition/index.ts](../apps/api/src/composition/index.ts) — composition barrel(이 root export 추가)

## 목적

- PR #77은 hourly service와 current service를 실제로 호출해 조합하는 application orchestration만
  구현했고, 이를 실제 server 환경(`process.env`, production 협력자)에서 조립하는 composition root가
  없었습니다.
- 이 PR은 environment에서 live `KmaLocationCurrentHourlyOverviewService`까지의 **production
  wiring만** 구현합니다. 새로운 KMA 데이터 규칙, provenance 정책, 조합 규칙을 추가하지 않습니다.
- 이 PR은 `POST /weather` route에 이 결합 root를 연결하지 **않습니다**(아래 "이 PR의 범위 밖" 참고).

## 정확한 조립 그래프

```text
environment / injected dependencies
  → createKmaLocationHourlyOverviewCompositionFromEnv(env, dependencies)    // PR #27, 그대로 재사용
      → ok:false → { ok:false, error }  (current composition 미호출)
      → ok:true  → live KmaLocationHourlyOverviewService
              ↓
          createKmaLocationCurrentOverviewCompositionFromEnv(env, dependencies)  // PR #75, 그대로 재사용
              → ok:false → { ok:false, error }  (PR #77 factory 미호출)
              → ok:true  → live KmaLocationCurrentOverviewService
                      ↓
                  createKmaLocationCurrentHourlyOverviewService(hourlyService, currentService)  // PR #77
                      → live KmaLocationCurrentHourlyOverviewService
```

## 공개 API

```ts
export type KmaLocationCurrentHourlyOverviewCompositionDependencies =
  KmaLocationHourlyOverviewCompositionDependencies &
  KmaLocationCurrentOverviewCompositionDependencies;

export type CreateKmaLocationCurrentHourlyOverviewCompositionResult =
  | {
      readonly ok: true;
      readonly service: KmaLocationCurrentHourlyOverviewService;
    }
  | {
      readonly ok: false;
      readonly error: KmaProviderConfigError;
    };

export function createKmaLocationCurrentHourlyOverviewCompositionFromEnv(
  env?: NodeJS.ProcessEnv,
  dependencies?: KmaLocationCurrentHourlyOverviewCompositionDependencies,
): CreateKmaLocationCurrentHourlyOverviewCompositionResult;
```

`Dependencies` 타입은 PR #27 `KmaLocationHourlyOverviewCompositionDependencies`와 PR #75
`KmaLocationCurrentOverviewCompositionDependencies`의 **intersection**입니다 — 두 타입 모두 이미
동일한 `{ fetchImpl?, clock? }` 구조이므로, 이 타입은 새 field를 하나도 직접 정의하지 않습니다.

## hourly가 먼저, 결정론적으로 조립됨

이 composition은 항상 PR #27 hourly composition을 **먼저** 호출합니다 — `env`/`dependencies`를
**exact reference**로 그대로 전달합니다(clone·spread·mutation·구조분해 후 재조립 없음).

PR #27이 `{ ok: false, error }`를 반환하면:

- 이 composition도 **동일 error reference**를 그대로 반환합니다.
- PR #75 current composition은 **호출되지 않습니다**.
- PR #77 service factory도 **호출되지 않습니다**.
- clock read, network, provider construction은 PR #27 내부 provider-config 검증 외에는 일어나지
  않습니다.

## current는 hourly 성공 이후에만 조립됨

PR #27이 성공한 뒤에만 PR #75 current composition을 호출합니다 — **동일한** `env`/`dependencies`
reference를 그대로 전달합니다(두 번째, clone된, 또는 부분(subset) dependencies object를 새로 만들지
않음).

PR #75가 `{ ok: false, error }`를 반환하면:

- 이 composition도 **동일 error reference**를 그대로 반환합니다.
- PR #77 service factory는 **호출되지 않습니다**.

### 중요한 경계 — composition 실패 vs PR #77의 runtime 강등(degradation)

PR #75 **composition** 실패(config error)는 PR #77의 runtime degradation 정책과 다른 층위입니다.

- PR #77의 강등 정책은 **이미 두 live service가 모두 존재하는 상태**에서, current service가
  **resolve**한 `ok: false` **application 결과**(`LOCATION`/`PROVIDER`/`NORMALIZATION`)를
  `current: null`로 균일하게 강등합니다.
- 하지만 PR #75 composition 자체의 config 실패는 production current service를 애초에 **구성할 수
  없었다는 뜻**입니다 — 강등할 live service가 없으므로, 이 경우는 runtime section-level degradation이
  아니라 **composition-level 실패**로 남습니다.

이 PR은 이 두 층위를 혼동하지 않습니다 — config 실패를 `current: null` 성공으로 위장하지 않습니다.

## clock/fetch identity — 두 root 모두에 동일 참조 전달

`dependencies`(주입된 경우)는 **동일 reference**로 PR #27과 PR #75 양쪽 composition에 모두
전달됩니다. 그 결과:

- 주입된 `dependencies.fetchImpl`은 hourly와 current 두 provider construction 모두에 동일 함수
  reference로 도달합니다 — 이 layer는 새 provider를 만들거나 공유하지 않습니다. 두 기존 root는 각자
  별도의 provider instance를 계속 구성하되, 둘 다 같은 injected `fetchImpl`로 구성됩니다.
- 주입된 `dependencies.clock`은 다음 네 역할 모두에 동일 reference로 도달합니다.
  1. hourly request-plan clock
  2. hourly PR #26 selected-source metadata resolver clock
  3. current PR #66 request factory clock
  4. current PR #73 metadata resolver clock
  이 composition은 그 clock을 wrap·clone·adapt·multiplex·snapshot하지 않고, 여기서 직접 읽지도
  않습니다.
- `dependencies.clock`이 없으면, 이 layer는 **새 clock을 만들지 않습니다** — system-clock factory를
  import하지 않습니다. 기존 PR #27/PR #75 root는 각자 자신의 독립된 default clock을 그대로
  선택합니다(encapsulation 보존).

## 성공 wiring

두 composition이 모두 성공하면, 두 개의 **exact live service reference**(wrap·clone·재정렬 없음)를
PR #77 `createKmaLocationCurrentHourlyOverviewService(hourlyService, currentService)`에 정확히 두
필수 인자로만 전달합니다. PR #77의 기본 assembler(`assembleKmaCurrentHourlyWeatherOverview`, 실제
PR #76 assembler)는 세 번째 인자로 override되지 않습니다.

## 성공 결과 표면

```ts
{
  ok: true,
  service,
}
```

own key는 정확히 `ok`/`service`뿐입니다. 노출하지 않는 것: `hourlyService`/`currentService`/
`hourlyComposition`/`currentComposition`/`provider`/`facade`/`resolver`/`clock`/`fetchImpl`/
`serviceKey`/`env`/`dependencies`/`assembler`/`converter`/request factory/selection·fallback 내부
값. `service`는 PR #77의 `fetchCurrentHourlyWeatherOverviewForLocation`만을 기존 공개 계약대로
제공합니다.

## callable / lazy composition

새 root는 **callable function**입니다 — module-scope singleton이 아닙니다. import만으로는 다음이
전혀 일어나지 않습니다: `process.env` read, provider construction, clock read, `Date.now()`,
converter/selector/resolver/assembler 실행, application service 실행, network, timer/listener,
logging, route registration.

composition **함수 호출** 시에는 두 기존 composition의 provider configuration 읽기/validation,
service construction만 허용됩니다 — `clock.nowEpochMilliseconds()`, converter 실행, provider fetch,
resolver 실행, assembler 실행, application service의 반환된 실행은 호출 시점에도 일어나지 않습니다.
첫 실제 실행은 반환된 `service.fetchCurrentHourlyWeatherOverviewForLocation()` 호출 때입니다.

매 호출은 독립된 그래프를 만듭니다(module-level singleton/cache 없음).

## runtime 최대 provider 호출 수 — 이 PR이 새로 만드는 정책 아님

이 layer는 새 한도·재시도 정책을 추가하지 않습니다. 다음은 기존 두 그래프를 그대로 조립했을 때의
observable 결과입니다.

- hourly PR #19 fallback graph: **최대 2회**(PRIMARY, 그리고 classifier가 no-data 신호를 보고할
  때만 단일 PREVIOUS 시도)
- current graph: **최대 1회**
- 지원되는 요청 한 건의 합계: **최대 3회** provider 호출
- hourly location boundary에서 미지원 위치로 판정되면 current 그래프는 전혀 실행되지 않으므로
  provider 호출은 0회로 유지됩니다(PR #77의 hourly-baseline-first 순서 때문).

## current 가용성 — PR #80부터 상속, 새 보장 없음

PR #75 composition(→ PR #71 → PR #69)을 통해 상속되는 current 분기는, **PR #80** 이후로는 PR #79
**availability-delay** selector(`selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay`)입니다
— PR #78 merge 시점에는 PR #64 schedule-only selector였습니다. 이 root(PR #78) 자체는 그 selector를
import·선택하지 않으며 코드도 전혀 바뀌지 않았습니다 — PR #69가 주입하는 값이 바뀌었을 뿐이고, PR #78은
PR #75 → PR #71 → PR #69 그래프를 그대로 재사용하므로 그 선택을 transitively 상속할 뿐입니다. 이
composition은 readiness retry를 추가하지 않으며, 이전 current issuance로 fallback하지 않습니다. 이
PR은 선택된 current issuance가 실제로 upstream에 게시되었다는 **어떤 보장도 하지 않습니다** — PR #79
selector는 결정론적 프로젝트 임계값(10분)일 뿐 공식 SLA나 live-readiness 보장이 아닙니다.

## 이 PR(#78)의 범위 밖

- **`POST /weather` route 연결** — 없음. production `POST /weather`는 이 PR 이후에도 계속
  hourly-only이며 `current`는 missing입니다.
- **current-observation availability-delay selector 자체의 구현/wiring** — 이 root의 범위가 아닙니다.
  (PR #79가 selector를 구현했고, PR #80이 PR #69에 wiring했습니다 — 이 root는 그 결과를 상속만
  합니다. 위 "current 가용성" 절 참고.)
- **cache / stale-data / retry / concurrency 최적화** — 없음.
- **`packages/contracts` / `packages/weather-core` / `packages/lifestyle-engine` 변경** — 없음.
- **`apps/api/src/providers/**` / `apps/api/src/services/**` 변경** — 없음(PR #77 service를 그대로
  소비만 합니다).
- **`apps/api/src/routes/**` / `presenters/**` / `index.ts` / `api-app.ts` / `weather-route.ts`
  변경** — 없음.
- **기존 PR #27/#75/#77 runtime 구현 변경** — 없음.
- **실제 인증 KMA API 호출 / 실사용자 위치 / mobile / native / 신규 dependency** — 없음.

## 변경 이력

```text
v1 / PR #78 / 2026-08
- location current + hourly WeatherOverview 결합 production composition root 추가
  (createKmaLocationCurrentHourlyOverviewCompositionFromEnv)
- PR #27 hourly composition을 먼저, exact reference로 조립
- PR #27 성공 이후에만 PR #75 current composition을 동일 reference로 조립
- 두 composition의 config 실패를 각각 동일 error reference로 pass-through
  (current composition 실패는 PR #77의 runtime degradation과 별개의 composition-level 실패로 유지)
- PR #77 서비스 factory에 두 live service를 정확한 참조로만 wiring
- injected clock/fetch가 hourly+current 네 역할 모두에 동일 참조로 공유됨을 보존
- 아홉 번째 병렬(결합) callable production root(기존 여덟 root는 불변)
- POST /weather 연결, availability-delay selector, cache/stale, 실제 인증 KMA 호출은 이 PR 범위 밖

v2 / PR #80 / 2026-08 (하위 PR #69가 PR #79 availability-delay selector로 전환; 이 root 자체는 불변)
- 이 composition의 코드·조립 순서·공개 계약·clock/fetch 공유·provider 호출 상한(hourly 최대 2 +
  current 최대 1)은 전혀 변경되지 않음
- PR #75 → PR #71 → PR #69를 그대로 재사용하므로, PR #69가 request factory에 주입하는 selector가
  PR #64 schedule-only에서 PR #79 availability-delay로 바뀐 것을 transitively 상속
- POST /weather 연결은 여전히 이 PR 범위 밖, current retry/fallback/readiness 보장 여전히 없음
```
