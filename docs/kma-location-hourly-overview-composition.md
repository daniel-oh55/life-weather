# KMA location hourly overview production composition

이 문서는 PR #27에서 추가한 **다섯 번째 callable production composition root**
(`createKmaLocationHourlyOverviewCompositionFromEnv`)의 책임과 경계를 기록합니다. 이 root는 PR #21
location fallback composition을 재사용하고, 그 앞단에 PR #26 live selected-source metadata resolver를
붙여, PR #24 location hourly `WeatherOverview` application service를 하나의 live
`KmaLocationHourlyOverviewService`로 조립합니다.

기존 네 root(grid scheduled·location scheduled·grid fallback·location fallback)를 **교체하지 않고 그
옆에 병렬로** 추가합니다. 이 PR로 callable production composition root 수는 **4 → 5**가 되며, services
계층 application component 수(12)는 **변하지 않습니다** — composition root는 service component가
아닙니다.

## 목적과 책임

- PR #24 application service(`createKmaLocationHourlyOverviewService`)와 PR #26 production resolver
  (`createKmaLiveSelectedHourlySourceMetadataResolver`)는 구현만 되어 있고, 둘을 실제 graph로 조립하는
  production composition이 없었습니다.
- 이 PR은 `WeatherLocation` + `product`에서 hourly-only partial `WeatherOverview`(또는 `LOCATION`
  실패)까지의 pipeline을 **한 번의 함수 호출로 조립**하는 production root를 추가합니다.
- 이 root는 새 정책을 구현하지 않습니다. base-time·candidate·eligibility·selection·assembly·provenance
  정책은 모두 재사용하는 component의 몫이고, 이 layer는 metadata resolver의 clock을 **선택**하고 세
  요소를 **배선**할 뿐입니다.

## 구현 위치

- [kma-location-hourly-overview.ts](../apps/api/src/composition/kma-location-hourly-overview.ts) — composition root
- [kma-location-hourly-overview.test.ts](../apps/api/src/composition/kma-location-hourly-overview.test.ts) — 테스트
- [index.ts](../apps/api/src/composition/index.ts) — composition barrel (export 추가)

composition은 `../providers/kma`(type)·`../services`·sibling composition·`./system-clock`의 공개
surface만 소비하며, 자기 barrel(`./index`)을 내부 import하지 않습니다(순환 없음).

## 공개 API

```ts
export type KmaLocationHourlyOverviewCompositionDependencies =
  KmaLocationHourlyFallbackCompositionDependencies;

export type CreateKmaLocationHourlyOverviewCompositionResult =
  | {
      readonly ok: true;
      readonly service: KmaLocationHourlyOverviewService;
    }
  | {
      readonly ok: false;
      readonly error: KmaProviderConfigError;
    };

export function createKmaLocationHourlyOverviewCompositionFromEnv(
  env?: NodeJS.ProcessEnv,
  dependencies?: KmaLocationHourlyOverviewCompositionDependencies,
): CreateKmaLocationHourlyOverviewCompositionResult;
```

- 추가 class는 만들지 않습니다.
- 성공 result의 own key는 정확히 **`ok`/`service`** 두 개입니다.
- config 실패 result의 own key는 정확히 **`ok`/`error`** 두 개입니다.
- 성공 result에는 internal `facade`·`resolver`·`selector`·`assembler`·`provider`·`clock`·`fetchImpl`·
  `environment`·`config`·`converter`·`request`·`plan`·`dependencies`·`serviceKey`를 노출하지
  **않습니다.**

## dependency graph

```text
createKmaLocationHourlyFallbackCompositionFromEnv (PR #21)  → live location fallback facade
createKmaLiveSelectedHourlySourceMetadataResolver (PR #26)  → live selected-source metadata resolver

location fallback facade + selected-source metadata resolver
  → createKmaLocationHourlyOverviewService (PR #24)         → live KmaLocationHourlyOverviewService
```

PR #21 location fallback composition은 그 내부에서 provider-from-env·PR #7 hourly service·PR #18
request-plan factory(explicit PR #16 candidate selector)·PR #6 normalizer·PR #17 classifier·PR #19
fallback orchestration·PR #12 위·경도 → grid converter·PR #21 location facade를 이미 조립합니다. 이
root는 그것을 재사용할 뿐 다시 구현하지 않습니다.

PR #22 selector(`selectKmaHourlyFallbackResult`)와 PR #23 assembler(`assembleKmaHourlyWeatherOverview`)
는 PR #24 service의 **고정된 기본 구현**이므로 이 composition에서 별도 인자로 전달하지 않습니다.

## 기존 location fallback composition 재사용

composition은 PR #21 grid→location fallback graph를 다시 구현하지 않고 기존 composition function을
소비합니다.

1. `createKmaLocationHourlyFallbackCompositionFromEnv(env, dependencies)`를 호출합니다 — `env`와
   `dependencies`를 **그대로**(clone·spread·mutation·직접 service key read 없이) 전달합니다.
2. config failure면 즉시 **같은 `KmaProviderConfigError` reference**를 반환합니다(overview service·
   resolver·resolver clock 생성 없음).
3. 성공하면 metadata resolver의 clock을 선택합니다.
4. `createKmaLiveSelectedHourlySourceMetadataResolver(clock)`로 resolver를 만들고,
   `createKmaLocationHourlyOverviewService(facade, resolver)`로 application service를 만듭니다.
5. `{ ok: true, service }`를 반환합니다.

## dependencies alias와 clock 의미

`KmaLocationHourlyOverviewCompositionDependencies`는 PR #21
`KmaLocationHourlyFallbackCompositionDependencies`(= `{ fetchImpl?, clock? }`)의 **직접 alias**입니다 —
이 root는 하위 location fallback root와 정확히 같은 두 production seam을 공유하므로 alias로 두 입력이
어긋나지 않게 하고 field를 재정의하지 않습니다. `fetchImpl`과 `clock`은 하위 composition에 그대로
전달됩니다.

### injected clock의 두 역할과 call-count

이 pipeline에서 clock은 두 역할로 읽힙니다.

- **첫 번째 read — request plan 기준시각**: request-plan factory가 primary/previous 후보를 만들기 위해
  clock을 정확히 1회 읽습니다.
- **두 번째 read — metadata materialization 시각**: selected source가 있을 때 resolver가 `fetchedAt`을
  만들기 위해 clock을 정확히 1회 읽습니다.

| 경로 | request-plan read | resolver read | injected clock 총 호출 | fetch |
| --- | --- | --- | --- | --- |
| PRIMARY selected | 1 | 1 | **2** | 1 |
| PREVIOUS selected | 1 (한 read로 primary+previous 후보 생성) | 1 | **2** | 2 |
| no-selection | 1 | 0 (resolver 미실행) | **1** | 1 또는 2 |
| LOCATION (미지원) | 0 | 0 | **0** | 0 |
| pre-aborted supported | 1 | 0 (selected source 없음) | **1** | 0 |

- 두 read가 같은 instant를 재사용해야 한다는 뜻이 **아닙니다.** clock mock이 호출별로 다른 값을 반환해도
  정상 동작합니다.
- **`issuedAt`은 두 번째 clock read에서 계산하지 않습니다.** PR #26 resolver는 PR #25 execution trace가
  보존한 실제 `primaryIssuance`/`previousIssuance`(발표시각 identity)를 소비해 `issuedAt`을 만듭니다.
  `fetchedAt`만 두 번째 read에서 나옵니다. (테스트는 첫 read와 두 번째 read를 서로 다른 instant로 주입해
  이 사실을 증명합니다.)
- no-selection에서는 resolver가 실행되지 않으므로 metadata용 두 번째 read가 없습니다.
- LOCATION failure에서는 request-plan clock과 metadata clock **모두** 읽지 않습니다.

### default clock일 때 하위 root의 캡슐화를 지키는 이유

clock 선택은 다음과 같습니다.

```ts
const sourceMetadataClock = dependencies?.clock ?? createKmaSystemClock();
```

- **`dependencies.clock`이 주입된 경우**: 하위 location fallback composition에도 **같은 dependencies
  object**가 전달되므로, request-plan clock과 metadata resolver clock은 **동일한 injected reference**
  입니다. wrapper·clone·별도 adapter를 만들지 않습니다.
- **`dependencies.clock`이 생략된 경우**: 하위 root는 기존 방식대로 자체 system clock을 선택하게 두고, 그
  내부 clock을 노출시키거나 공유하려고 캡슐화를 깨지 않습니다. 대신 metadata resolver에는 성공 조립 후
  **새 `createKmaSystemClock()` adapter**를 사용합니다. 두 adapter는 stateless이며 각 역할의 실제 호출
  시각을 독립적으로 읽습니다. 기존 location fallback composition을 수정해 default clock을 공유하게 만들지
  **않습니다.**

## config failure exact-reference pass-through

Provider 환경설정이 실패하면 하위 composition의 결과(`{ ok: false, error: KmaProviderConfigError }`)를
그대로 전달합니다.

```ts
if (!fallbackComposition.ok) {
  return { ok: false, error: fallbackComposition.error };
}
```

- **동일 error object reference**를 사용합니다(clone·message 추가·raw env·service key 추가·logging·throw
  없음).
- `COMPOSITION_ERROR`/`STARTUP_ERROR`/`UNKNOWN` 같은 새 error kind를 만들지 않습니다. missing 키는 기존
  `{ kind: 'CONFIG_ERROR', field: 'serviceKey', reason: 'MISSING' }`, 앞뒤 whitespace 키는
  `… reason: 'INVALID'`입니다(Provider의 기존 config 계약 그대로).
- config 실패 시 overview service·metadata resolver·resolver clock·fetch가 **모두 0회**입니다.

## construction side-effect 경계

`createKmaLocationHourlyOverviewCompositionFromEnv()` 성공 호출은 Provider configuration을 읽고 PR #21
graph·resolver·PR #24 service closure를 만들 뿐입니다. 다음은 **실행하지 않습니다**: converter 실행,
`Date.now` 실행, 주입된 clock 실행, network fetch, request-plan 생성, primary/previous 실행, selector
실행, resolver 실행, assembler 실행, timer/listener, logging, route 등록, global mutation.

실제 clock read·converter 실행·fetch는 반환된 service의 `fetchHourlyWeatherOverviewForLocation()` 호출
시에만 발생합니다. 같은 `env`/`dependencies`로 두 번 호출하면 result·service·method reference가 모두
서로 다릅니다(module-level singleton·shared cache 없음).

## PRIMARY / PREVIOUS / no-selection / LOCATION 동작

반환된 service의 호출당 동작(모두 PR #24 service 계약 그대로):

- **PRIMARY selected**: availability-aware primary issuance가 usable → `selection.selected: true`,
  `source: 'PRIMARY'`, `fallbackUsed: false`. overview.hourly가 채워지고 KMA `HOURLY` source 한 건
  (`provider: 'KMA'`, `sections: ['HOURLY']`, product별 고정 `sourceId`, `retrievalMode: 'LIVE'`,
  `issuedAt`은 `execution.primaryIssuance`에서 파생, `fetchedAt`은 두 번째 clock read). Provider 호출
  1회.
- **PREVIOUS selected**: primary가 fallback-eligible(no-data/empty)하고 previous가 usable →
  `source: 'PREVIOUS'`, `fallbackUsed: true`. overview.hourly는 previous 데이터, `issuedAt`은
  `execution.previousIssuance`에서 파생. Provider 호출 2회.
- **no-selection**: primary/previous 모두 unusable → `selection.selected: false`, `overview.hourly: []`,
  `overview.sources: []`, `missingSections`에 `HOURLY` 포함. resolver 미실행. 이는 여전히 application
  **성공**(`ok: true`)이며, Provider/Normalization 실패를 top-level error로 승격하지 않습니다.
- **LOCATION (미지원 위치)**: converter가 `null`을 반환하면 facade의 `LOCATION`/`UNSUPPORTED_LOCATION`
  결과를 **그대로**(exact reference) 반환합니다. overview·selection·좌표·grid를 추가하지 않습니다.
  Provider 0회, clock 0회.

## Promise와 synchronous error 경계

이 composition은 성공 이후의 오류를 catch하거나 재분류하지 않습니다(broad `try/catch`·logging 없음).
PR #24 service 계약이 그대로 유지됩니다.

- **동기 throw**: invalid `WeatherLocation`의 `weatherLocation.parse` `ZodError`, facade의 동기 throw(예
  converter `RangeError`)는 **동일 reference**로 동기 전파됩니다(Promise로 변환하지 않음).
- **returned Promise rejection**: facade Promise rejection, fulfillment handler 내부의 selector·
  resolver·assembler throw(예 resolver의 malformed-issuance `RangeError`, metadata clock throw,
  selected-empty assembler `ZodError`)는 returned Promise를 **동일 reference**로 reject시킵니다.
- metadata clock이 두 번째 read에서 throw하면 service method 호출 자체가 동기 throw로 바뀌지 않고,
  returned Promise가 sentinel exact reference로 reject되며 partial overview는 없습니다.

## security와 non-leakage

- config error·service success result·no-selection result·LOCATION result·`console.*` 어디에도 test
  service key·실제 ServiceKey·URL·query·raw body·upstream `resultMsg`·secret marker가 나타나지
  않습니다. service key는 bound Provider 내부에만 유지됩니다.
- overview는 caller가 제공한 `location`을 그대로 담으므로 그 안의 latitude/longitude는 **정상적으로**
  나타납니다(누출이 아님, caller 자신의 입력). raw grid(`nx`/`ny`)·raw KMA body는 노출하지 않습니다.
- composition과 system clock은 logging하지 않습니다.

## internal application result를 mobile response로 그대로 serialize 금지 (경고)

이 root가 노출하는 성공 result는 PR #24의 **internal application result**입니다.

```ts
{
  ok,
  selection,   // execution trace(primary/previous 결과·issuance identity) 포함
  overview,
}
```

`selection`/`execution` trace는 internal 진단 정보입니다. 향후 mobile-facing `/weather` route는 이
internal result를 **그대로 serialize하면 안 되고**, `overview`만 안전하게 매핑해야 합니다. 이 PR은
overview-only serialization mapper를 만들지 않습니다(범위 밖).

## route / cache / startup 미구현

- 이 root는 `apps/api/src/index.ts`·server startup·`/weather` route에 **연결되지 않았습니다**.
- query validation·HTTP status/envelope mapping·mobile response mapper·cache/stale-data는 이 PR 범위가
  아닙니다.
- 네 기존 callable root(grid/location scheduled·grid/location fallback)의 공개 API·runtime은 이 PR로
  변경되지 않습니다.

## 테스트 전략

composition 테스트는 network(주입된 in-memory `fetchImpl`)와 결정적 instant가 필요한 clock(주입된 fake
clock)을 제외한 **모든 실제 component**를 조립합니다: PR #21 location fallback composition(provider-from-env·
request-plan factory·PR #16 candidate selector·hourly service·normalizer·PR #17 classifier·PR #19
orchestration·PR #12 converter·PR #21 facade), PR #26 live resolver, PR #22 selector, PR #23 assembler,
PR #24 service. fake 또는 주입은 명백한 test-only service key·in-memory `fetchImpl`·결정론적 injected
clock·`AbortSignal`·console spy에 한정하며, 실제 네트워크와 운영 ServiceKey는 사용하지 않습니다.

- **config failure**: missing / whitespace / 앞뒤 whitespace(invalid) 키 → `{ ok: false, error }`, exact
  key, service 없음, clock 0·fetch 0·logging 0·key 비노출.
- **success construction laziness**: `{ ok, service }` exact key, method 존재, clock 0·fetch 0·logging 0.
- **PRIMARY selected full pipeline**: 서울 좌표 → grid `60/127`, primary 0500 complete, injected clock
  총 2회(첫 값 request plan·둘째 값 fetchedAt), fetch 1회, `issuedAt`은 `primaryIssuance` 파생·
  `fetchedAt`은 둘째 read 파생.
- **PREVIOUS selected fallback**: primary empty → previous 0200 complete, fetch 2회, injected clock 총
  2회(request plan은 최초 1회로 두 후보 생성), `issuedAt`은 `previousIssuance` 파생.
- **no-selection**: primary/previous 모두 empty, injected clock 총 1회(resolver 미실행), `HOURLY` missing.
- **unsupported location**: Null Island → `LOCATION`/`UNSUPPORTED_LOCATION`, clock 0·fetch 0.
- **invalid WeatherLocation**: timezone/위경도 범위/필수 field 오류 → 동기 `ZodError`, clock 0·fetch 0.
- **pre-aborted invocation**: 서울 + 사전 abort → primary `ABORTED` → no-selection, clock 1회·fetch 0회,
  metadata용 둘째 read 없음.
- **metadata clock throw**: 첫 read 정상·둘째 read sentinel throw → service method는 동기 throw하지 않고
  returned Promise가 sentinel exact reference로 reject, partial overview·logging 없음.
- **fresh graph**: 두 번 호출 시 result·service·method reference가 각각 다름.
- **exact keys / leakage**: composition result exact key, PR #24 internal result의 selection/execution
  trace 유지, service key/ServiceKey/URL/query/raw body/upstream `resultMsg` 비노출.

frozen env·frozen dependencies·deeply frozen input에서도 정상 동작하며 mutation이 없음을 확인합니다.

신규 test file은 **22개** 테스트를 포함합니다(이번 HEAD에서 관찰). Vitest shuffle seed 1/2/17에서도
통과합니다.

## 범위 밖

- `apps/api/src/index.ts` startup wiring / server startup
- `/weather` Hono route / query validation / HTTP status·envelope mapping
- mobile response mapper / overview-only serialization mapper
- cache / stale-data / current weather / daily forecast / AirKorea / alerts / lifestyle engine
- Provider timestamp / attempt별 transport timestamp / 세 번째 시도 / fallback·selector·assembler 정책
  변경
- `SourceMetadata`·contracts·weather-core·mobile 변경 / 새 환경변수 / 새 외부 dependency
- 기존 네 composition root의 공개 API 또는 runtime 변경
- PR #24 application result에서 selection 제거

## 변경 이력

```text
v1 / PR #27 / 2026-07
- createKmaLocationHourlyOverviewCompositionFromEnv (다섯 번째 callable production root) 추가
- PR #21 location fallback composition 재사용 + PR #26 live resolver + PR #24 service 조립
- dependencies는 PR #21 dependencies 직접 alias, 새 option 미추가
- injected clock 두 역할(request plan 기준시각·metadata materialization); default 시 resolver용 fresh system clock
- 성공 시 { ok, service }, config 실패는 KmaProviderConfigError exact reference pass-through
- construction network-free(clock/converter/fetch/selector/resolver/assembler 0회)
- 기존 네 callable root와 그 공개 API·runtime 불변; callable root 수 4 → 5, service component 수 12 불변
- startup/route/mobile mapper/cache는 후속(제외)
```
