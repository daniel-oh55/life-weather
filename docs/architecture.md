# 아키텍처

이 문서는 Life Weather 모노레포의 의도된 구조를 설명합니다. 아래에 설명된 구조 중 상당수는
**아직 구현되지 않았습니다.** 각 항목에 현재 상태를 명시합니다.

## apps와 packages의 책임

- `apps/mobile` — Expo Router 기반 모바일 앱. 화면, 네비게이션, 사용자 입력 처리를 담당합니다.
  외부 공공데이터 API를 직접 호출하지 않습니다 (아래 참고).
- `apps/api` — Hono 기반 백엔드. 외부 공공데이터 API 호출, API 키 보관, 응답 정규화를 담당할
  위치입니다. **현재 상태**: `GET /health`에 더해, PR #4에서 기상청(KMA) **원본 응답 경계**
  (`src/providers/kma`)를 구현했습니다 — 단기·초단기예보 원본 JSON의 Zod 런타임 검증, 성공·
  upstream error·invalid response 분류, forecast slot 그룹화 및 field-presence(ABSENT/NULL/
  VALUE) 모델. 경계는 방어적으로 강화되어 `dataType`는 정확히 `"JSON"`, `resultCode`는 정확히
  2자리 숫자(malformed → invalid response), `category`는 `[A-Z0-9]+`만 허용하고, 명백한
  pagination 모순을 거부하며, upstream error에는 **2자리 `resultCode`만** 노출하고 untrusted raw
  `resultMsg`는 공개 오류에 포함하지 않습니다. 공식 예시는 XML 중심이라 JSON scalar·빈 success
  page·`fcstValue` literal null은 방어적 정책으로 두고 인증된 실제 JSON 응답에서 재검증할
  항목으로 남아 있습니다. PR #5에서는 이 경계를 실제 공공데이터포털 **HTTPS** 호출에 연결하는
  **KMA HTTP Provider**(`createKmaForecastProvider`/`…FromEnv`)를 구현했습니다 — 서버 전용
  `KMA_SERVICE_KEY`(import-time env access 없음, decoded key 1회 encoding), native `fetch`,
  timeout·caller abort(response header뿐 아니라 response body 완독까지 적용)·`redirect: 'error'`·
  response body size 제한, body stream 오류의 명시적 결과화, HTTP/gateway XML/JSON 오류
  분류, PR #4 parser·slot grouping 연결, 요청·응답 consistency·incomplete page 검증. PR #6에서는
  provider slot을 공통 `HourlyForecast`로 정규화하는 **순수 adapter**(`normalizeKmaHourlyForecast`)를
  추가했습니다 — product별 category 선택, KST `forecastAt`, weather-core parser 연결, contracts
  runtime 검증. PR #7에서는 이 Provider와 normalizer를 순서대로 호출하는 **application service**
  (`src/services`, `createKmaHourlyForecastService`)를 추가했습니다 — 주입된 Provider를 정확히 한 번
  호출하고 request·AbortSignal을 그대로 전달하며, Provider 단계 오류와 normalization 단계 오류를
  `stage`로 구분한 결과를 반환합니다(side-effect 없는 factory, retry·cache 없음, raw slot 비노출).
  PR #9에서는 주입된 clock·주입 가능한 base-time selector·caller가 공급한 nx/ny를 결합해 완성된
  `KmaForecastRequest`를 만드는 **application-level request factory**(`src/services`,
  `createKmaForecastRequestFactory`)를 추가했습니다 — 생성 시 side-effect 없음, `createScheduledRequest()`
  호출당 injected clock 1회, selector 1회 사용, product/baseDate/baseTime/nx/ny만 반환(input spread
  없음). (**PR #15**에서 두 번째 인자 `baseTimeSelector` seam이 추가됐고, 생략 시 default는 PR #8
  `selectLatestKmaForecastBaseTime`입니다 — 아래 참조.) PR #10에서는 이 request factory와 hourly service를 순서대로 잇는 얇은 **application
  facade**(`src/services`, `createKmaScheduledHourlyForecastFacade`)를 추가했습니다 — caller
  input(product/nx/ny) → request factory → 완성된 request → hourly service → 결과 순서로 연결하며,
  input/request/options/Promise를 reference 그대로 전달하고 새로운 result union이나 오류 type을
  만들지 않습니다(생성 시 side-effect 없음). PR #11에서는 이 component들과 신규 **system clock
  adapter**를 실제 서버 환경에서 조립하는 **production composition root**(`src/composition`,
  `createKmaSystemClock`·`createKmaScheduledHourlyCompositionFromEnv`)를 추가했습니다 — env →
  Provider-from-env → hourly service, system clock/injected clock → request factory, 그리고 이 둘을
  잇는 scheduled facade를 한 번의 함수 호출로 조립해 live facade를 반환합니다. **호출 가능한
  composition function**이며 module-scope singleton이나 import-time composition을 만들지 않고,
  import 시 `process.env`를 읽거나 Provider를 생성하지 않습니다(config 실패는 Provider의 기존
  `KmaProviderConfigError`를 값으로 전달, 성공 시 `{ ok, facade }`만 공개). 다만 이 composition
  root는 아직 `apps/api/src/index.ts`나 어떤 route에도 **연결되지 않았습니다**(`/health` 무관).
  PR #13에서는 PR #12의 위·경도 → 격자 converter를 PR #10 scheduled facade 앞단에 두는 **location
  application facade**(`src/services`, `createKmaLocationScheduledHourlyForecastFacade`)와 그
  **location production composition**(`src/composition`,
  `createKmaLocationScheduledHourlyCompositionFromEnv`)을 추가했습니다 — caller input(product/
  latitude/longitude) → 주입된 converter → `{ nx, ny }` → scheduled facade → 결과 순서로 연결하며,
  converter를 호출당 정확히 한 번 부르고(fresh `{ latitude, longitude }` input) 지원 밖 위치는
  `{ ok: false, stage: 'LOCATION', error: { kind: 'UNSUPPORTED_LOCATION' } }`(값 없는 discriminator)로,
  물리적으로 잘못된 좌표의 converter `RangeError`는 동기적으로 그대로 전파합니다. 지원 위치의 성공·
  `PROVIDER`·`NORMALIZATION` 결과와 Promise는 reference 그대로 통과시킵니다. location facade는 기존
  scheduled result의 success·`PROVIDER`·`NORMALIZATION` variant를 수정하지 않고, 기존 scheduled
  result 전체를 재사용하면서 `LOCATION`/`UNSUPPORTED_LOCATION` variant 하나만 추가한 **별도의 확장
  result union**을 정의합니다. location composition은 기존 `createKmaScheduledHourlyCompositionFromEnv`를 그대로
  재사용하고 그 앞단에 production converter `convertKmaLatitudeLongitudeToGrid`(weather-core 공개
  surface)를 조립할 뿐, 기존 grid-based facade·composition과 그 결과·API는 변경하지 않습니다.
  PR #15에서는 위 request factory의 base-time selector seam(신규 `KmaForecastBaseTimeSelector` type,
  선택적 두 번째 인자)을 통해 **production scheduled composition이 PR #14 availability-delay selector
  (`selectLatestKmaForecastBaseTimeAfterAvailabilityDelay`)를 명시적으로 주입**하도록 배선했습니다 —
  factory default는 여전히 schedule-only(PR #8)이라 direct one-argument caller는 불변이고, location
  composition은 grid composition 재사용으로 이 정책을 자동 상속합니다(location runtime 불변). 그 결과
  두 production pipeline 모두 availability-threshold-aware(단기 10분·초단기 15분, exact inclusive
  프로젝트 정책)이며(예 SHORT 05:00→0200·05:10→0500, ULTRA 06:30→0530·06:45→0630), 이는 공식 SLA·live
  readiness 보장이 아닙니다. request factory 공개 API의 `createScheduledRequest` 이름·input/output
  shape과 composition dependencies type은 변경하지 않았습니다.
  PR #20에서는 PR #16~#19 fallback building block을 실제 서버용으로 조립하는 **세 번째 composition
  root**(`src/composition`, `createKmaHourlyFallbackCompositionFromEnv`)를 기존 두 single-request root
  옆에 **병렬로** 추가했습니다 — env → Provider-from-env → hourly service, system clock/injected clock +
  **명시적으로 주입한 PR #16 candidate selector**(`selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay`)
  → PR #18 request-plan factory, 그리고 plan factory + hourly service + **명시적으로 주입한 PR #17
  classifier**(`classifyKmaHourlyFallbackEligibility`) → PR #19 `createKmaHourlyFallbackService`를 한 번의
  함수 호출로 조립해 live `KmaHourlyFallbackService`를 반환합니다(생성 시 clock read·network 0회, config
  실패는 Provider의 `KmaProviderConfigError` 값 그대로, 성공 시 `{ ok, service }`만 공개, 실행 시 primary
  ineligible이면 fetch 최대 1회·eligible이면 최대 2회, third attempt 없음). 기존 grid/location scheduled
  root와 그 `{ ok, facade }` 계약은 **불변**입니다. 이어서 **PR #21**에서는 이 PR #20 grid fallback
  pipeline 앞에 PR #12 위·경도 → grid converter를 두는 **네 번째 병렬 production
  root**(`createKmaLocationHourlyFallbackCompositionFromEnv`)를 추가했습니다 — 지원되는 위치는 grid
  fallback service를 통해 Provider/fetch를 최대 2회 호출할 수 있고, 지원되지 않거나 잘못된 위치는
  clock·Provider 실행 전에 종료됩니다(fetch 0회). 기존 세 root(grid/location scheduled·grid fallback)는
  변경되지 않았으며, 네 root 모두 아직 `apps/api/src/index.ts`·startup·route에 **연결되지 않았습니다**.
  PR #22에서는 PR #19 execution trace에서 primary/previous/none usable source를 고르는 **순수 selection
  정책**(`selectKmaHourlyFallbackResult`, `src/services`)을 추가했습니다 — 이로써 execution 계층(무엇이
  실행됐는지)과 selection 계층(무엇을 실제 사용하는지)이 분리되지만, 이 selector는 어느 composition
  root·route에도 **연결되지 않았고** 네 composition root의 계약·runtime도 **불변**입니다. 따라서 final
  primary/previous **selection 정책은 순수 함수로 구현 완료**됐으나 이를 소비하는 **production result
  assembly**(`WeatherOverview`/`SourceMetadata` assembler)는 PR #22 시점에는 미구현이었습니다.
  PR #23에서는 이 PR #22 selection을 소비해 hourly section만 조립하는 **순수 partial-overview
  assembler**(`assembleKmaHourlyWeatherOverview`, `src/services`)를 추가했습니다 — caller가 제공한
  `WeatherLocation`·precomputed selection·(선택 시) selected source provenance를 받아 contracts
  `WeatherOverview`를 조립합니다(selected면 hourly + KMA `HOURLY` `SourceMetadata` 1건 + HOURLY 제외
  missingSections, no-selection이면 빈 hourly/sources + HOURLY 포함 missingSections, 나머지 section은
  fixed placeholder). provenance(`sourceId`/`issuedAt`/`fetchedAt`/`retrievalMode`)는 caller가 제공하고
  assembler는 `provider: 'KMA'`·`sections: ['HOURLY']`·`observedAt: null`만 고정하며 clock·base time을
  추정하지 않습니다. `weatherOverview.parse`로 동기 검증하는 순수·동기 함수로, PR #22 selector를 호출하지
  않고 LOCATION branch·current/daily/AQ/alerts·composition·route를 다루지 않습니다.
  PR #24에서는 이 네 building block을 하나로 잇는 **location hourly `WeatherOverview` application
  service**(`createKmaLocationHourlyOverviewService`, `src/services`)를 추가했습니다 — 호출당 (1) contracts
  `weatherLocation.parse`를 **선행** 실행하고(invalid location이면 collaborator 0회로 동기 `ZodError`),
  (2) parsed 위·경도로 PR #21 location fallback facade를 실행하고, (3) top-level `LOCATION` 실패는 facade
  결과 그대로 반환하며, (4) 지원되는 trace에는 PR #22 selector를 적용하고, (5) **주입된** selected-source
  metadata resolver를 selected trace에서만 **정확히 1회** 호출한 뒤, (6) PR #23 assembler로 `{ ok: true,
  selection, overview }`를 조립합니다. 서비스 내부 dependency 방향은 **location facade → selector →
  resolver seam → assembler** 한 방향이며(cycle 없음), 이 계층은 `apps/api/src/composition`에 대한 의존이
  전혀 없습니다. no-selection trace도 application **성공**(`ok: true`)이고 Provider/Normalization 실패를
  새 top-level error로 승격하지 않습니다. method는 `async`가 아니어서 location/facade 동기 throw는 동기로,
  facade rejection과 selector/resolver/assembler throw는 Promise rejection으로 전파되며(동일 error
  reference), broad catch·wrapping·logging이 없고 clock/env/network를 소유하지 않습니다(provenance는
  주입된 resolver가 결정, 별도 clock으로 issuedAt을 재계산하지 않음). PR #26은 그 주입 대상인
  **live selected-source metadata resolver**(`createKmaLiveSelectedHourlySourceMetadataResolver`)와 공개
  issuedAt converter(`convertKmaForecastIssuanceToIssuedAt`)를 추가해, PR #25 trace가 보존한 실제 issuance
  identity를 소비합니다(PRIMARY→primaryIssuance·PREVIOUS→previousIssuance, KST `+09:00` issuedAt, product별
  고정 sourceId `kma-short-forecast-hourly`/`kma-ultra-short-forecast-hourly`, `LIVE`, resolver-time
  `fetchedAt` clock 1회). 따라서 이제 `apps/api` services 계층에는 **application component 12개**가
  존재하며, PR #21 facade·PR #22 selection 정책·PR #23 assembler를 location result narrow와 함께 엮는
  **application service**와 그것이 주입받는 **production metadata resolver(PR #26)** 모두 구현 완료됐으나,
  이를 실제 graph로 조립하는 **production composition**은 **PR #27**에서 구현됐습니다
  (`createKmaLocationHourlyOverviewCompositionFromEnv`, 다섯 번째 callable root — PR #21 location fallback
  composition을 재사용하고 PR #26 resolver + PR #24 service를 조립). 기존 네 callable composition
  root(grid/location scheduled·grid/location fallback)와 그 공개 API·runtime은 **불변**이며, production
  composition root 수는 이제 **5**개(+ location hourly overview)이고, services 계층 application component
  수(**12**)는 변하지 않습니다(composition root는 service component가 아님). PR #30에서는 이 request
  contract·application service·PR #29 presenter를 HTTP 경계에서 잇는 **injectable `POST /weather`
  route factory**(`src/routes`, `createWeatherRoute`)를 추가했습니다 — mountable Hono sub-app으로
  `POST /`만 등록하고(`app.route('/weather', createWeatherRoute(deps))`로 mount), Content-Type
  검증(415)·16 KiB **byte** body-size 한도(413)·JSON parsing과 `WeatherRequestV1` strict 검증(400)·
  server-owned KMA product 적용·주입된 service port 호출(raw Request AbortSignal을 exact reference로
  전달)·PR #29 presenter·HTTP status mapping(200/422/500)을 수행합니다. service·presenter·server
  product·`meta` provider(clock/`requestId`)를 모두 주입받고 clock/env/randomness를 직접 읽지 않아
  startup과 무관하게 테스트 가능하며, request-layer 오류도 기존 `WeatherErrorResponseV1` 형태로만
  반환하고 Zod issue·raw error·provider trace를 노출하지 않습니다. 다만 이 route factory는 아직
  `apps/api/src/index.ts`에 **mount되지 않았고**(유일한 호출 가능 endpoint는 여전히 `GET /health`),
  production service adapter·server product 정책·실제 clock/`requestId` 생성은 **PR #31 startup
  wiring**의 몫입니다. 다섯 composition root도 모두 아직 `apps/api/src/index.ts`·startup에 **연결되지
  않았습니다.** live availability fallback/retry 정책·production `/weather` mount·cache·mobile
  client는 여전히 **미구현**(후속 PR)이며, 별도 general `config` package도 여전히 미구현입니다.
  자세한 내용은
  [kma-response-boundary.md](./kma-response-boundary.md),
  [kma-http-provider.md](./kma-http-provider.md),
  [kma-hourly-normalization.md](./kma-hourly-normalization.md),
  [kma-hourly-service.md](./kma-hourly-service.md),
  [kma-forecast-request-factory.md](./kma-forecast-request-factory.md),
  [kma-scheduled-hourly-facade.md](./kma-scheduled-hourly-facade.md),
  [kma-production-composition.md](./kma-production-composition.md),
  [kma-location-scheduled-hourly.md](./kma-location-scheduled-hourly.md),
  [kma-hourly-fallback-composition.md](./kma-hourly-fallback-composition.md),
  [kma-location-hourly-fallback.md](./kma-location-hourly-fallback.md),
  [kma-hourly-fallback-selection.md](./kma-hourly-fallback-selection.md),
  [kma-hourly-weather-overview.md](./kma-hourly-weather-overview.md),
  [kma-location-hourly-overview.md](./kma-location-hourly-overview.md),
  [kma-selected-hourly-source-metadata.md](./kma-selected-hourly-source-metadata.md),
  [kma-location-hourly-overview-composition.md](./kma-location-hourly-overview-composition.md),
  [weather-response-presenter.md](./weather-response-presenter.md),
  [weather-route.md](./weather-route.md) 참고.
- `packages/contracts` — 모바일과 API가 공유할 정규화 요청/응답 계약의 위치입니다. **현재
  상태**: PR #2에서 Zod 4 기반 공유 기상 데이터 계약을 정의했습니다. 자세한 내용은
  [contracts.md](./contracts.md) 참고.
- `packages/weather-core` — 공급자별 날씨 코드를 공통 날씨 상태로 정규화하고 기상 도메인 계산을
  수행할 위치입니다. **현재 상태**: PR #2의 결정론적 freshness 판정(`classifyFreshness`)에 더해,
  PR #3에서 기상청(KMA) 단기·초단기예보 정규화 primitive(`normalizeKmaWeatherCondition`,
  `parseKmaPrecipitationAmountMillimeters`, `parseKmaSnowfallAmountCentimeters`)를
  순수 함수로 구현했습니다. PCP/SNO 파서는 공식 no-amount(`강수없음`/`적설없음`/`-`/`0`)를 `0`으로,
  Missing 센티넬(수치 `>= 900`)과 파싱 불가·미제공을 `null`로 정규화합니다(PCP만 범위 지원, SNO
  범위 거부). PR #6에서 일반 수치 category(TMP/T1H·POP/REH·WSD·VEC) scalar parser(`scalar.ts`)를
  추가했습니다(±900 Missing, VEC 360→0). PR #8에서 KMA 단기·초단기예보의 최신 공식 발표시각을
  선택하는 **순수 함수**(`selectLatestKmaForecastBaseTime`, `kma/issue-time.ts`)를 추가했습니다 —
  호출자가 제공한 절대 epoch milliseconds를 고정 KST(UTC+09:00)로 변환해 `{ baseDate, baseTime }`을
  반환하며, 시스템 clock을 읽지 않습니다. PR #12에서는 위도·경도를 KMA 동네예보 격자 좌표
  `{ nx, ny }`로 변환하는 **순수 함수**(`convertKmaLatitudeLongitudeToGrid`, `kma/grid.ts`)를
  추가했습니다 — 공식 DFS Lambert Conformal Conic 투영을 표준 `Math`만으로 계산하며, 지원 위치는
  `{ nx, ny }`, 지원 밖 위치는 `null`, 물리적으로 잘못된 위·경도는 `RangeError`입니다(clamp 없음,
  역변환 없음, network·API key 없음). PR #14에서는 공식 API 제공 지연(단기예보 +10분, 초단기예보
  +15분)을 반영해, `reference − delay`에 PR #8 selector를 재사용하는 **별도 순수 함수**
  (`selectLatestKmaForecastBaseTimeAfterAvailabilityDelay`, `kma/api-availability-time.ts`)를
  추가했습니다 — 발표 일정·KST 달력·rollover·연도 검증을 복제하지 않고 조합만 하며, 기존 schedule
  selector의 계약은 변경하지 않습니다(threshold inclusive, no safety margin, no live availability
  guarantee, runtime dependency 0개). 이 selector는 순수하게 유지되며, **PR #15에서 `apps/api`
  production scheduled composition이 이를 request factory에 주입**해 소비합니다(아래 `apps/api` 항목·
  의존 방향 참조). PR #16에서는 이 availability-delay selector를 **두 reference에 재사용**해 하나의
  절대 시각에서 primary/previous 두 후보를 만드는 **또 다른 순수 함수**
  (`selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay`, `kma/fallback-candidates.ts`)를
  추가했습니다 — SHORT 3시간·ULTRA 1시간 issuance interval만 소유하고 schedule 배열·threshold·KST
  달력을 복제하지 않으며, 아직 `apps/api`의 어느 계층에도 연결되지 않았습니다(production 동작 불변,
  retry/fallback 실행 없음). 이로써 weather-core에는 책임이 구분된 **세 selector**(schedule selector·
  availability-delay single selector·primary/previous candidate selector)가 공존합니다. weather-core는
  순수 함수만 제공하고 HTTP 호출·slot 조립은 하지 않으며, 이 파서들을 slot 값에 연결하는 정규화는
  `apps/api`(PR #6)에 있습니다. 매핑·발표시각·격자 변환·API 제공 지연·후보 생성 근거는
  [kma-normalization.md](./kma-normalization.md),
  [kma-hourly-normalization.md](./kma-hourly-normalization.md),
  [kma-issue-time.md](./kma-issue-time.md),
  [kma-grid-conversion.md](./kma-grid-conversion.md),
  [kma-api-availability-time.md](./kma-api-availability-time.md),
  [kma-fallback-candidates.md](./kma-fallback-candidates.md) 참고.
- `packages/lifestyle-engine` — 생활 날씨 지수(우산, 마스크, 옷차림 등)를 순수 함수로 계산할
  위치입니다. **현재 상태**: 스켈레톤만 존재합니다.
- `packages/config` — 비밀이 아닌 공유 설정/상수의 위치입니다. **현재 상태**: 스켈레톤만
  존재합니다.

## 모바일이 외부 공공데이터 API를 직접 호출하지 않는 이유

기상청/에어코리아 서비스 키는 서버(`apps/api`)에서만 관리합니다. 모바일 앱에 키를 포함시키면
디컴파일을 통해 키가 노출될 수 있고, 공공데이터 API의 요청 형식(날짜 포맷, 페이징, 오류 코드 등)
변경에 앱 배포 없이 대응할 수 없습니다. 따라서 모바일은 항상 `apps/api`를 통해서만 날씨 데이터를
조회하도록 설계할 예정입니다.

## API Provider 패턴 (KMA 도입 완료, 추가 Provider 확장 예정)

`apps/api`는 기상청/에어코리아 같은 각 외부 데이터 소스를 "Provider"로 캡슐화하는 패턴을 씁니다.
각 Provider는 외부 API의 원시 응답을 가져오는 역할(HTTP 호출·raw boundary·slot 그룹화)만 하고, 그
응답을 공통 모델로 변환하는 책임은 정규화 계층(`packages/weather-core`의 순수 파서 + `apps/api`의
slot adapter)이 가집니다. **KMA HTTP Provider는 PR #5에서 구현 완료**되어 실제 공공데이터포털
HTTPS 호출·raw boundary·forecast slot 그룹화를 담당하고, **KMA 시간별 정규화 adapter는 PR #6에서
구현 완료**되어 provider-native raw 값을 contracts `HourlyForecast`로 정규화합니다(원본 SKY/PTY/PCP
등의 정규화 primitive는 PR #3의 `weather-core`). **PR #7에서는 Provider와 normalizer를 순서대로
호출하는 application service 계층(`apps/api/src/services`)을 추가**했습니다 — Provider(원시 응답
취득)와 normalizer(공통 모델 변환)의 책임 경계는 그대로 두고, service는 둘을 조립하기만 하며
`providers/kma` 밖에 위치합니다(의존 방향 `services → providers/kma`). 아직 구현되지 않은 것은
`AirKoreaProvider`와 여러 Provider를 아우르는 **공통 다중 Provider interface**이며, 이는 후속 PR에서
도입할 예정입니다. Provider(원시 응답 취득)와 normalizer(공통 모델 변환)의 책임 경계는 그대로
유지합니다.

## 정규화 원칙 (KMA 시간별 예보에 적용, 범위 확장 예정)

외부 API 응답(기상청 날씨 코드, 에어코리아 대기질 등급 등)은 API 계층에서 바로 모바일로
전달하지 않고, `packages/weather-core`에서 공통 내부 모델로 정규화한 뒤 `packages/contracts`에
정의된 계약 형태로 모바일에 전달합니다. 이렇게 하면 특정 공급자의 API가 바뀌더라도 모바일 앱과
생활지수 로직은 영향을 받지 않습니다. **KMA 시간별 예보에는 이미 적용 완료**입니다: SKY/PTY/PCP/
RN1/SNO/TMP/T1H/POP/REH/WSD/VEC를 공통 값으로 정규화하고 contracts `HourlyForecast`로 조립합니다
(PR #3·#6). 아직 정규화가 연결되지 않은 `CurrentWeather`, `DailyForecast`, `WeatherOverview`,
에어코리아(AirKorea) 대기질은 후속 PR 범위입니다. 어느 경우든 provider raw 값을 모바일에 직접
노출하지 않는 원칙은 동일하게 유지합니다.

## 생활지수 로직의 위치 원칙

우산/마스크/옷차림/빨래/세차/운동/출퇴근 등 생활 날씨 판단 로직은 `packages/lifestyle-engine`에
순수 TypeScript 함수로 구현할 예정입니다. React Native나 Node.js 런타임에 종속되지 않게 하여,
모바일과 API 양쪽에서 동일한 로직을 재사용하고 독립적으로 테스트할 수 있도록 합니다.

## 패키지 의존 방향 (PR #15 기준)

패키지 의존은 아래 방향만 허용하며, **순환 의존을 금지**합니다.

현재 상태:

```text
contracts    → zod
weather-core → (런타임 의존 없음; contracts는 타입 검증용 devDependency)
apps/api     → contracts, weather-core, zod, hono
```

`weather-core`는 런타임에 zod에도 contracts에도 의존하지 않습니다. PR #3에서 상태 정규화의
반환 타입이 contracts의 `WeatherCondition`에 할당 가능한지를 **컴파일 타임 타입 테스트**로만
검증하기 위해 `@life-weather/contracts`를 **devDependency**로 추가했습니다. 실제 배포 모듈은
contracts 타입이나 런타임을 import하지 않으므로 소비자에게 미선언 의존을 강제하지 않습니다.

PR #4에서 `apps/api`는 KMA 원본 응답 경계를 위해 `zod`(런타임 검증)와
`@life-weather/weather-core`(slot 식별에 쓰는 `KmaForecastProduct` 공유)를 런타임 의존으로
추가했습니다. 의존 방향은 `apps/api → weather-core`이며, `weather-core`나 `contracts`가
`apps/api`에 의존하지 않습니다(역방향·순환 금지). 신규 HTTP client 라이브러리는 추가하지
않았습니다.

PR #5의 KMA HTTP Provider는 **신규 dependency를 추가하지 않았습니다.** Node.js 22 native
`fetch`·`AbortController`·`ReadableStream`·`TextDecoder`만 사용합니다. HTTP·환경변수 코드는
`apps/api` 내부 관심사이므로 `weather-core`·`contracts`·`lifestyle-engine`·`apps/mobile`에 넣지
않습니다.

PR #6에서 `apps/api`는 시간별 정규화 결과를 contracts schema로 검증하기 위해
`@life-weather/contracts`를 **workspace runtime 의존으로 추가**했습니다(방향 `apps/api →
contracts`). scalar/조건/범주 파서는 `weather-core`에 두고 `apps/api`가 호출하므로,
`weather-core`는 여전히 contracts·zod에 **런타임 의존하지 않습니다**(contracts는 타입 검증용
devDependency 유지). 신규 외부 npm dependency는 추가하지 않았습니다.

PR #7의 application service(`apps/api/src/services`)는 **신규 dependency도, 신규 package-level 의존도
추가하지 않습니다.** service는 `apps/api` 내부의 `providers/kma`(Provider·normalizer)와
`@life-weather/contracts`의 `HourlyForecast` **타입만** 사용합니다(의존 방향 `services →
providers/kma`, `services → contracts` type-only). `providers/kma → services`, `contracts →
apps/api`, `weather-core → apps/api` 같은 역방향은 금지합니다.

PR #8의 KMA issue-time selector는 **신규 dependency도, 신규 package-level 의존도 추가하지
않습니다.** `weather-core` 내부의 `KmaForecastProduct`만 사용하며 위 의존 방향을 그대로 유지합니다
(`weather-core`는 여전히 contracts·zod에 런타임 의존하지 않음).

PR #9의 KMA request factory(`apps/api/src/services`)는 **신규 dependency도, 신규 package-level 의존도
추가하지 않습니다.** 이 factory는 `@life-weather/weather-core`의 `selectLatestKmaForecastBaseTime`·
`KmaForecastProduct`(즉 **PR #8 selector를 application request factory에서 소비**)와, `apps/api` 내부
`providers/kma`의 `KmaForecastRequest` **타입만** 사용합니다(의존 방향 `services → weather-core`,
`services → providers/kma` type-only). `providers/kma → services`, `weather-core → apps/api`,
`contracts → apps/api` 같은 역방향은 금지합니다. `apps/api` request factory는 `weather-core`의 기존
PR #8 public selector를 소비만 하므로, PR #9에서는 `packages/weather-core`를 변경하지 않았습니다.

PR #10의 KMA scheduled hourly facade(`apps/api/src/services`)는 **신규 dependency도, 신규
package-level 의존도 추가하지 않습니다.** 이 facade는 같은 `services` 계층의 두 concrete
file(`kma-forecast-request`의 `KmaForecastRequestFactory`, `kma-hourly-forecast`의
`KmaHourlyForecastService`)에서 **타입만** import해 두 collaborator를 연결합니다. 허용 방향은
`facade → request factory`, `facade → hourly service`이며, `providers/kma → services`,
`weather-core → apps/api`, `contracts → apps/api` 같은 역방향과 route가 provider 세부 구현을 직접
조립하는 방향은 금지합니다. facade는 자기 barrel(`./index`)이 아니라 concrete file에서 import합니다.
factory와 hourly service의 기존 runtime·공개 API는 변경하지 않았습니다.

PR #11의 KMA production composition(`apps/api/src/composition`)은 **신규 dependency도, 신규
package-level 의존도 추가하지 않습니다.** 이 계층은 `apps/api` 내부의 `providers/kma` 공개
surface(`createKmaForecastProviderFromEnv`, `KmaProviderConfigError`)와 `services` 공개
surface(`createKmaForecastRequestFactory`·`createKmaHourlyForecastService`·
`createKmaScheduledHourlyForecastFacade`·`KmaForecastRequestClock`·`KmaScheduledHourlyForecastFacade`)
만 소비합니다. 허용 방향은 `composition → providers/kma`, `composition → services`이며,
`providers/kma → composition`·`services → composition`·`weather-core → composition`·
`contracts → composition`·`mobile → composition` 같은 역방향은 금지합니다. composition은 자기
barrel(`./index`)이 아니라 concrete file에서 내부 import합니다. system clock adapter만이
composition 계층에서 `Date.now()`를 읽는 유일한 위치이며(생성 시 0회, read당 1회), Provider·
factory·service·facade의 기존 runtime·공개 API는 변경하지 않았습니다.

PR #12의 KMA 위·경도 → 격자 converter(`packages/weather-core/src/kma/grid.ts`)는 **신규 dependency도,
신규 package-level 의존도 추가하지 않습니다.** 이 함수는 JavaScript 표준 `Math`에만 의존하므로
`weather-core → Math only`이며, `weather-core`는 여전히 contracts·zod에 런타임 의존하지 않습니다
(`weather-core → (런타임 의존 없음)`). PR #12 자체는 `apps/api`의 Provider·request factory·facade·
composition runtime을 변경하지 않았고, converter를 `apps/api`의 어느 계층에도 연결하지 않았습니다 —
request factory와 기존 grid-based facade는 여전히 이미 계산된 `nx`/`ny`를 받습니다. converter를 실제로
소비하는 wiring은 PR #13의 location facade/composition에서 추가됩니다(아래 참조). `weather-core → apps/api`
같은 역방향은 계속 금지합니다.

PR #13의 KMA location facade(`apps/api/src/services`)와 location composition(`apps/api/src/composition`)은
**신규 dependency도, 신규 package-level 의존도 추가하지 않습니다.** location facade는
`@life-weather/weather-core`의 converter **타입**(`ConvertKmaLatitudeLongitudeToGridInput`·
`KmaForecastGridCoordinate`·`KmaForecastProduct`, type-only)과 sibling scheduled-facade file의
**타입만** import합니다(자기 barrel `./index` import 없음). location composition은 `services` 공개
surface(`createKmaLocationScheduledHourlyForecastFacade`·`KmaLocationScheduledHourlyForecastFacade`),
기존 `createKmaScheduledHourlyCompositionFromEnv`, 그리고 **production converter를 위해
`@life-weather/weather-core`의 `convertKmaLatitudeLongitudeToGrid` 공개 export**를 소비합니다(private
deep import 없음). 따라서 이 PR에서 새로 생긴 방향은 `composition → weather-core`(converter 선택)뿐이며,
`services → weather-core`(type-only)는 PR #9부터 이미 허용된 방향입니다. `providers/kma → services`·
`services → composition`·`weather-core → apps/api`·`contracts → apps/api`·`mobile → apps/api` 같은
역방향은 계속 금지하고, 순환 의존은 없습니다. 이 PR은 `weather-core` converter runtime·기존 Provider·
request factory·scheduled facade·scheduled composition의 runtime과 공개 API를 변경하지 않았습니다.

PR #14의 KMA availability-delay selector(`packages/weather-core/src/kma/api-availability-time.ts`)는
**신규 dependency도, 신규 package-level 의존도 추가하지 않습니다.** 이 함수는 같은 패키지 내부의
`./condition`(`KmaForecastProduct`)과 `./issue-time`(PR #8 schedule selector)만 사용하므로
`weather-core`는 여전히 contracts·zod에 런타임 의존하지 않습니다(`weather-core → (런타임 의존 없음)`).
PR #14 자체는 `apps/api`의 Provider·request factory·facade·composition runtime을 변경하지 않았고,
신규 selector를 `apps/api`의 어느 계층에도 연결하지 않았습니다 — request factory는 여전히 PR #8
schedule selector를 사용합니다. `weather-core → apps/api` 같은 역방향은 계속 금지합니다.

PR #15의 KMA availability selector production wiring은 **신규 dependency도, 신규 package-level 의존도
추가하지 않습니다.** 변경은 `apps/api` 내부에 국한됩니다: `services` request factory에 base-time
selector 주입 seam(`KmaForecastBaseTimeSelector`)을 추가하고, `composition`의 grid scheduled
composition이 `@life-weather/weather-core`의 PR #14 selector
(`selectLatestKmaForecastBaseTimeAfterAvailabilityDelay`) 공개 export를 소비해 그 seam에 주입합니다.
따라서 이 PR에서 강화되는 방향은 `composition → weather-core`(이제 converter에 더해 availability-delay
selector도 선택)뿐이며, 이는 PR #13부터 이미 존재한 방향입니다. request factory 파일은 concrete PR #14
selector를 직접 import하지 않고(selector-agnostic) default로 PR #8 selector만 사용하며, location
composition은 grid composition 재사용으로 정책을 상속할 뿐 selector를 따로 import/주입하지 않습니다.
`providers/kma → services`·`services → composition`·`weather-core → apps/api`·`contracts → apps/api`·
`mobile → apps/api` 같은 역방향은 계속 금지하고, 순환 의존은 없습니다. Provider·normalizer·facade
result·LOCATION 계약·weather-core runtime은 변경하지 않았습니다.

PR #16의 KMA primary/previous candidate selector(`packages/weather-core/src/kma/fallback-candidates.ts`)는
**신규 dependency도, 신규 package-level 의존도 추가하지 않습니다.** 이 함수는 같은 패키지 내부의
`./condition`(`KmaForecastProduct`)·`./issue-time`(`KmaForecastBaseTime` type)·`./api-availability-time`
(PR #14 selector와 type)만 사용하므로 `weather-core`는 여전히 contracts·zod에 런타임 의존하지 않습니다
(`weather-core → (런타임 의존 없음)`). PR #16 자체는 `apps/api`의 Provider·request factory·facade·
composition runtime을 변경하지 않았고, 이 candidate selector를 `apps/api`의 어느 계층에도 연결하지
않았습니다. `weather-core → apps/api` 같은 역방향은 계속 금지합니다.

PR #17의 KMA fallback eligibility classifier(`apps/api/src/services/kma-hourly-fallback-eligibility.ts`)는
**신규 dependency도, 신규 package-level 의존도 추가하지 않습니다.** 이 순수 함수는 같은 `services`
계층의 `kma-hourly-forecast`에서 `KmaHourlyForecastServiceResult` **타입만** import해 service result를
분류합니다(자기 barrel `./index` import 없음, weather-core candidate runtime import 없음). 따라서
`weather-core`에 `apps/api` result type 의존을 만들지 않으며, 새로 생기는 방향은 `services → services`
(type-only) 하나뿐입니다. `providers/kma → services`·`services → composition`·`weather-core → apps/api`·
`contracts → apps/api`·`mobile → apps/api` 같은 역방향은 계속 금지하고, 순환 의존은 없습니다. PR #16
candidate selector와 PR #17 classifier는 PR #17 시점에는 아직 production graph에서 조합되지 않았고(이후
**PR #20 grid fallback composition**에서 조립됨), Provider raw error·normalization issue surface·기존
service result 계약은 변경되지 않았습니다(classifier는 orchestration 전 단계의 순수 정책 component이며
route·startup·cache는 여전히 미구현).

PR #18의 KMA fallback request-plan factory(`apps/api/src/services/kma-fallback-request-plan.ts`)는
**신규 dependency도, 신규 package-level 의존도 추가하지 않습니다.** 이 application-layer factory는
`@life-weather/weather-core`의 PR #16 candidate selector
(`selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay`와 그 input/result **타입**)와, `apps/api`
내부 `providers/kma`의 `KmaForecastRequest` **타입**, 그리고 sibling `kma-forecast-request` file의 clock·
input **타입**만 사용합니다(자기 barrel `./index` import 없음). 따라서 강화되는 방향은
`services → weather-core`(PR #9부터 이미 허용)와 `services → providers/kma`(type-only) 뿐이며,
`weather-core → apps/api` 같은 역방향은 계속 금지합니다(weather-core candidate selector → apps/api
request plan 방향으로만 흐르며, 순환 의존 없음). PR #18 request-plan factory와 PR #17 eligibility
classifier는 **서로 독립적인 building block**이며(plan은 실행 전 조립, classifier는 primary 결과 이후
분류), PR #18 시점에는 아직 production graph에서 조합되지 않았습니다(이후 **PR #20 grid fallback
composition**에서 조립됨) — PR #18 자체는 기존 Provider·service·facade·composition의 runtime과 공개 API를
변경하지 않았고(당시 production 동작 불변, 기존 scheduled facade 호출당 KMA request 최대 1회 유지), 실제
fallback 실행·retry·route·startup·cache는 여전히 미구현이었습니다.

PR #19의 KMA fallback orchestration service(`apps/api/src/services/kma-hourly-fallback.ts`)는 **신규
dependency도, 신규 package-level 의존도 추가하지 않습니다.** 이 service는 같은 `services` 계층의 세 sibling
file에서만 import합니다 — `kma-fallback-request-plan`(PR #18 factory·input **타입**),
`kma-hourly-forecast`(hourly service·options·result **타입**), `kma-hourly-fallback-eligibility`(PR #17
classifier **함수**와 그 eligibility·reason 타입)(자기 barrel `./index` import 없음). 따라서 이 PR에서
새로 생기는 방향은 `services → services`(fallback service → request-plan factory·hourly service·
eligibility classifier) 하나뿐이며, **Provider 의존은 hourly service를 통해서만 간접적**입니다(fallback
service는 `providers/kma`를 직접 import하지 않음). PR #18 request-plan factory가 소비하는
`weather-core → apps/api` 아님 방향(즉 `services → weather-core`)은 이 orchestration에 그대로 남고, 순환
의존은 없습니다. 이로써 PR #18 plan·PR #7 hourly service·PR #17 classifier가 **처음으로 조합**되어 primary
1회 후 eligible이면 previous 최대 1회를 실행합니다. PR #19 시점에는 이 orchestration이 아직 어떤 production
composition root에도 연결되지 않았으나, 이후 **PR #20 grid fallback composition root**가 이를 실제 graph로
조립했습니다 — 기존 grid/location scheduled composition은 계속 호출당 KMA request 최대 1회로 불변이고,
PR #19 자체는 기존 Provider·service·facade·composition의 runtime과 공개 API를 변경하지 않았습니다. result
merge·final source selection·`WeatherOverview`/`SourceMetadata`·route·startup 연결·cache는 여전히
미구현입니다.

PR #20의 KMA grid fallback composition(`apps/api/src/composition/kma-hourly-fallback.ts`)은 **신규
dependency도, 신규 package-level 의존도 추가하지 않습니다.** 이 composition root는 `apps/api` 내부
`providers/kma` 공개 surface(`createKmaForecastProviderFromEnv`·`KmaProviderConfigError`)와 `services`
공개 surface(`classifyKmaHourlyFallbackEligibility`·`createKmaFallbackRequestPlanFactory`·
`createKmaHourlyForecastService`·`createKmaHourlyFallbackService`·`KmaHourlyFallbackService`), 그리고
`@life-weather/weather-core` 공개 selector(`selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay`)를
소비하며, concrete `./system-clock`(`createKmaSystemClock`)와 type-only로 sibling
`./kma-scheduled-hourly`(`KmaScheduledHourlyCompositionDependencies`)를 사용합니다(자기 barrel `./index`
import 없음). 따라서 강화되는 방향은 `composition → providers/kma`·`composition → services`·
`composition → weather-core`뿐이며 모두 기존에 허용된 방향이고, `providers/kma → composition`·
`services → composition`·`weather-core → composition`·`contracts → composition`·`mobile → composition`
같은 역방향은 계속 금지합니다(순환 의존 없음 — 특히 **services는 composition을 import하지 않습니다**).
이 fallback root는 기존 grid/location single-request root를 **교체하지 않고 병렬로** 추가한 것이며,
Provider·request-plan factory·hourly service·classifier·PR #19 orchestration·두 기존 composition의
runtime과 공개 API를 변경하지 않았습니다. location(위·경도) fallback root는 **PR #21**에서 추가됐고(아래),
route/cache는 여전히 미구현입니다.

PR #21의 KMA location fallback facade(`apps/api/src/services/kma-location-hourly-fallback.ts`)와 location
fallback composition(`apps/api/src/composition/kma-location-hourly-fallback.ts`)은 **신규 dependency도, 신규
package-level 의존도 추가하지 않습니다.** location facade는 sibling service file의 **타입만**
import합니다 — `./kma-location-scheduled-hourly-forecast`의 converter·input·result **타입**(`Extract`로
`LOCATION` branch 재사용)과 `./kma-hourly-fallback`의 fallback service·options·result **타입**(자기 barrel
`./index` import 없음, concrete converter·Provider·composition import 없음). location composition은
`services` 공개 surface(`createKmaLocationHourlyFallbackFacade`·`KmaLocationHourlyFallbackFacade`), 기존
sibling `createKmaHourlyFallbackCompositionFromEnv`(PR #20 grid fallback root), 그리고 **production
converter를 위해** `@life-weather/weather-core`의 `convertKmaLatitudeLongitudeToGrid` 공개 export를
소비합니다(private deep import 없음). 따라서 강화되는 방향은 `services → services`(type-only)와
`composition → services`·`composition → composition`(sibling)·`composition → weather-core`(converter
선택)뿐이며 모두 기존에 허용된 방향이고, `providers/kma → composition`·`services → composition`·
`weather-core → apps/api`·`contracts → apps/api`·`mobile → apps/api` 같은 역방향은 계속 금지합니다(순환
의존 없음). 이 location fallback root는 기존 세 root(grid scheduled·location scheduled·grid fallback)를
**교체하지 않고 병렬로** 추가한 네 번째 root이며, PR #20 grid fallback root와 두 single-request root의
runtime·공개 API를 변경하지 않았습니다. `apps/api/src/index.ts`·startup·`/weather` route·final result
selection·cache는 여전히 미구현입니다.

PR #22의 KMA hourly fallback result selector(`apps/api/src/services/kma-hourly-fallback-selection.ts`)는
**신규 dependency도, 신규 package-level 의존도 추가하지 않습니다.** 이 순수 함수는 같은 `services` 계층의
두 sibling file에서 **타입만** import합니다 — `kma-hourly-forecast`(`KmaHourlyForecastServiceResult`)와
`kma-hourly-fallback`(`KmaHourlyFallbackServiceResult`)(자기 barrel `./index` import 없음, Provider·
composition·weather-core·contracts runtime import 없음). 따라서 새로 생기는 방향은
`services → services`(type-only) 하나뿐이고 **composition 의존은 없습니다**(순환 없음). 이 selector는
실행 계층(PR #19 orchestration)과 분리된 selection 계층으로, PR #19 execution trace를 순수 함수로 소비할
뿐 어떤 것도 실행하지 않으며 eligibility classifier(PR #17)를 호출하지 않습니다. 네 composition root와
그 공개 API·runtime은 **불변**이고, selector는 아직 어느 root·route에도 연결되지 않았습니다 — 이를
소비하는 `WeatherOverview`/`SourceMetadata` assembler는 후속 PR입니다.

PR #23의 KMA hourly `WeatherOverview` assembler(`apps/api/src/services/kma-hourly-weather-overview.ts`)는
**신규 dependency도, 신규 package-level 의존도 추가하지 않습니다.** 이 순수 함수는 `@life-weather/contracts`
공개 surface의 runtime schema `weatherOverview`(+ `SourceMetadata`/`WeatherLocation`/`WeatherOverview`
**타입**)와, 같은 `services` 계층의 `kma-hourly-fallback-selection`에서 `KmaHourlyFallbackSelection`
**타입만** import합니다(자기 barrel `./index` import 없음, Provider·composition·weather-core·fallback
service runtime import 없음). 따라서 이 PR에서 사용되는 방향은 `services → contracts`(PR #6부터 이미
허용된 runtime 방향)와 `services → services`(type-only, PR #22 selector와 동일) 뿐이며 **composition
의존은 없습니다**(순환 없음 — assembler는 selector를 실행하지도, composition을 import하지도 않습니다).
assembler는 PR #22 selector가 이미 계산한 selection을 소비할 뿐 selector를 호출하지 않고, LOCATION
branch를 다루지 않으며, 네 composition root와 그 공개 API·runtime은 **불변**입니다. selector → assembler를
엮어 소비하는 application-service integration은 후속 PR입니다.

PR #24의 KMA location hourly `WeatherOverview` application service
(`apps/api/src/services/kma-location-hourly-overview.ts`)는 **신규 dependency도, 신규 package-level 의존도
추가하지 않습니다.** 이 service는 `@life-weather/contracts` 공개 surface의 runtime schema
`weatherLocation`(+ `WeatherLocation`/`WeatherOverview` **타입**)과, 같은 `services` 계층의 세 sibling에서
runtime/타입을 import합니다 — `kma-hourly-fallback-selection`(`selectKmaHourlyFallbackResult` +
`KmaHourlyFallbackSelection` 타입), `kma-hourly-weather-overview`(`assembleKmaHourlyWeatherOverview` +
`KmaHourlySourceMetadataInput` 타입), `kma-location-hourly-fallback`(타입만)(자기 barrel `./index` import
없음, Provider·composition·weather-core·request-plan factory runtime import 없음). 따라서 이 PR에서
사용되는 방향은 `services → contracts`(이미 허용된 runtime 방향)와 `services → services`(PR #22/#23와
동일) 뿐이며 서비스 내부 dependency 방향은 **location facade → selector → resolver seam → assembler**
한 방향입니다(**composition 의존 없음**, 순환 없음). provenance는 주입된 resolver seam이 결정하고 이 service는
clock/env/network를 소유하지 않으며, 네 composition root와 그 공개 API·runtime은 **불변**입니다. production
metadata resolver와 이 service를 조립하는 production composition은 후속 PR입니다.

PR #27의 KMA location hourly overview composition
(`apps/api/src/composition/kma-location-hourly-overview.ts`)은 **신규 dependency도, 신규 package-level
의존도 추가하지 않습니다.** 이 composition root는 `apps/api` 내부 `providers/kma` 공개 surface(type-only
`KmaProviderConfigError`)와 `services` 공개 surface(`createKmaLiveSelectedHourlySourceMetadataResolver`·
`createKmaLocationHourlyOverviewService`·`KmaLocationHourlyOverviewService`), sibling
`createKmaLocationHourlyFallbackCompositionFromEnv`(PR #21 location fallback root), 그리고 concrete
`./system-clock`(`createKmaSystemClock`)만 소비합니다(자기 barrel `./index` import 없음,
`@life-weather/weather-core`·contracts runtime import 없음). 따라서 강화되는 방향은
`composition → providers/kma`·`composition → services`·`composition → composition`(sibling)뿐이며 모두
기존에 허용된 방향이고, `providers/kma → composition`·`services → composition`·`weather-core → apps/api`·
`contracts → apps/api`·`mobile → apps/api` 같은 역방향은 계속 금지합니다(순환 없음 — services는 composition을
import하지 않습니다). 이 다섯 번째 root는 기존 네 root를 **교체하지 않고 병렬로** 추가한 것이며, 재사용하는
PR #21 location fallback root·PR #26 resolver·PR #24 service의 runtime과 공개 API를 변경하지 않았습니다.

PR #29의 KMA location hourly overview **response presenter**(`apps/api/src/presenters/kma-location-hourly-overview-response.ts`)는
**신규 dependency도, 신규 package-level 의존도 추가하지 않습니다.** 이 presenter는 새 **presenters 계층**
(`src/presenters`)에 속하며, `@life-weather/contracts` 공개 surface의 runtime schema
`weatherSuccessResponseV1`·`weatherErrorResponseV1`·상수 `CONTRACT_VERSION`(+ `ApiMetaV1`/`WeatherResponseV1`
**타입**)과, `services` 공개 surface의 `KmaLocationHourlyOverviewResult` **타입만** 소비합니다(자기 barrel
`./index` import 없음, composition·providers/kma·weather-core runtime import 없음). 따라서 강화되는 방향은
`presenters → contracts`(runtime)와 `presenters → services`(type-only)뿐이며, `services → presenters`·
`composition → presenters`·`presenters → composition`·`weather-core → apps/api`·`contracts → apps/api`·
`mobile → apps/api` 같은 역방향은 금지합니다(순환 없음 — presenter는 순수 mapping 경계이지 orchestration도
composition도 아님). presenter 계층은 PR #27 composition이 만드는 **내부 application result**와 향후
`/weather` route가 모바일에 돌려줄 **공개 response body** 사이의 **serialization 경계**로, 성공 시 `overview`만
`data`로 노출하고 `selection`/execution trace는 절대 serialize하지 않으며 `LOCATION` 실패는 안정적인
`UNSUPPORTED_LOCATION` 오류로 매핑합니다. `UNSUPPORTED_LOCATION`은 `ApiErrorCode`에 **additive**로 추가한
known value이므로 `CONTRACT_VERSION`은 계속 **1**입니다. presenter는 아직 `apps/api/src/index.ts`·startup·
`/weather` route에 **연결되지 않았고**, HTTP status/헤더/body-size·clock(`generatedAt`)·`requestId` 생성은
후속 route PR의 몫입니다. callable production composition root 수(**5**)와 services 계층 application component
수(**12**)는 변하지 않습니다(presenter는 composition root도 service component도 아닌 별도 계층).

PR #30의 KMA `POST /weather` **route factory**(`apps/api/src/routes/weather.ts`)는 **신규 dependency도,
신규 package-level 의존도 추가하지 않습니다.** 이 route는 새 **routes 계층**(`src/routes`)에 속하며,
이미 설치된 `hono`의 공개 surface(`Hono`와 subpath `hono/body-limit`의 `bodyLimit` — 새 패키지가 아니라
기존 hono의 subpath export)와, `@life-weather/contracts` 공개 surface의 runtime schema
`weatherErrorResponseV1`·`weatherRequestV1`·상수 `CONTRACT_VERSION`(+ `ApiErrorCode`/`WeatherErrorResponseV1`
**타입**), `services` 공개 surface의 `KmaLocationHourlyOverviewInput`/`KmaLocationHourlyOverviewResult`
**타입**, `presenters` 공개 surface의 presenter **함수 타입**(`typeof`)과 `WeatherResponsePresenterMetaV1`
**타입**만 소비합니다(자기 barrel `./index` import 없음, composition·providers/kma·weather-core runtime
import 없음). 따라서 강화되는 방향은 `routes → contracts`(runtime)·`routes → services`(type-only)·
`routes → presenters`(type-only)·`routes → hono`뿐이며, `services → routes`·`presenters → routes`·
`composition → routes`·`routes → composition`·`weather-core → apps/api`·`contracts → apps/api`·
`mobile → apps/api` 같은 역방향은 금지합니다(순환 없음 — route는 HTTP adapter일 뿐 composition root가
아니고 service/presenter를 생성하지 않으며 주입만 받습니다). route factory는 `apps/api/src/index.ts`에
아직 **mount되지 않았고** production service adapter·server product·clock/`requestId` 생성(PR #31 startup
wiring)은 여전히 미구현입니다. callable production composition root 수(**5**)와 services 계층 application
component 수(**12**)는 변하지 않습니다(route는 별도 계층).

향후 허용 방향:

```text
apps/api          → contracts, weather-core
apps/mobile       → contracts
lifestyle-engine  → contracts
```

## 현재 구현 상태 요약 (PR #30 시점)

- `contracts`: PR #2에서 Zod 4 기반 공유 기상 계약을 정의했습니다.
- `weather-core`: `classifyFreshness`(PR #2)와 KMA 단기·초단기예보 정규화 primitive(PR #3)에 더해,
  PR #6에서 일반 수치 category(TMP/T1H·POP/REH·WSD·VEC) scalar parser를 추가했고, PR #8에서 KMA
  최신 공식 발표시각을 선택하는 **순수 함수**(`selectLatestKmaForecastBaseTime`)를, PR #12에서 위·경도를
  KMA 동네예보 격자 `{ nx, ny }`로 변환하는 **순수 함수**(`convertKmaLatitudeLongitudeToGrid`)를,
  PR #14에서 공식 API 제공 지연(단기 +10분·초단기 +15분)을 반영하는 **별도 순수 함수**
  (`selectLatestKmaForecastBaseTimeAfterAvailabilityDelay`, PR #8 selector를 조합)를, PR #16에서 하나의
  절대 시각에서 primary/previous 두 후보를 만드는 **또 다른 순수 함수**
  (`selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay`, PR #14 selector를 두 reference에 재사용)를
  추가했습니다. KMA 코드(SKY/PTY)와 범주형 수치(PCP/RN1/SNO), 일반 수치를 공통 값으로 정규화하고, 절대
  instant를 고정 KST 발표시각으로 매핑하며(schedule selector·availability-delay single selector·
  primary/previous candidate selector 세 가지 책임 분리; candidate selector는 SHORT 3시간·ULTRA 1시간
  issuance interval만 소유하며 PR #20 grid fallback composition이 이를 apps/api에서 소비),
  위·경도를 공식 DFS LCC 투영으로 격자에 매핑하는 순수 함수를 제공하고(표준 `Math`만 사용,
  network·API key 없음), contracts·zod에 런타임 의존하지 않습니다.
- `apps/api`: `GET /health`에 더해, PR #4에서 KMA **원본 JSON 검증 및 slot extraction**
  경계(`src/providers/kma`)를 구현했고, PR #5에서 이를 실제 공공데이터포털 **HTTPS 호출**에
  연결하는 **KMA HTTP Provider**를 구현했으며, PR #6에서 provider slot을 공통 `HourlyForecast`로
  바꾸는 **순수 시간별 정규화 adapter**(`normalizeKmaHourlyForecast`)를 추가했고, PR #7에서 이 둘을
  순서대로 호출하는 **application service**(`src/services`, `createKmaHourlyForecastService`)를
  추가했습니다 — 주입된 Provider를 정확히 한 번 호출, request·AbortSignal 그대로 전달, Provider/
  normalization 단계 오류 구분, side-effect 없는 factory. PR #9에서는 주입된 clock·PR #8 selector·caller
  nx/ny를 결합해 완성된 `KmaForecastRequest`를 만드는 **request factory**(`src/services`,
  `createKmaForecastRequestFactory`)를 추가했습니다 — 생성 시 clock 미호출, `createScheduledRequest()`
  호출당 clock 1회·selector 1회, product/baseDate/baseTime/nx/ny만 반환. PR #10에서는 이 request
  factory와 hourly service를 순서대로 잇는 **application facade**(`src/services`,
  `createKmaScheduledHourlyForecastFacade`)를 추가했습니다 — caller input → factory 1회 → 완성된
  request → hourly service 1회 → 결과 순서로 연결하고, input/request/options/Promise를 reference
  그대로 전달하며 새로운 result union·오류 type을 만들지 않습니다(생성 시 side-effect 없음). 경계는
  여전히 원본의 **field presence**를 보존합니다. PR #11에서는 신규 **system clock adapter**와
  **production composition root**(`src/composition`, `createKmaSystemClock`·
  `createKmaScheduledHourlyCompositionFromEnv`)를 추가했습니다 — env → Provider-from-env → hourly
  service, system clock/injected clock → request factory, scheduled facade를 한 번의 함수 호출로
  조립해 live facade를 반환합니다(clock 생성 시 `Date.now` 0회·read당 1회, composition 생성 시 clock
  read·network 0회, config 실패는 Provider의 config error 값 그대로, 성공 시 `{ ok, facade }`만 공개).
- 발표시각 선택 순수 함수는 PR #8에서 `weather-core`에 구현됐고, PR #9의 **request factory가 이 selector를
  소비**합니다(injected clock으로 현재시각 → selector → baseDate/baseTime → nx/ny 결합 → request). PR #10의
  **scheduled facade가 factory와 hourly service를 연결**해 caller input → request factory → 완성된 request →
  hourly service → 결과 흐름을 완성합니다(selector → request factory → scheduled facade → hourly service).
  PR #11의 **production composition root가 이 흐름 전체를 실제 dependency로 조립**합니다(system clock →
  request factory → selector, Provider-from-env → hourly service, request factory + hourly service →
  live facade). 이 composition root는 **호출 가능한 function**이며 module-scope singleton·import-time
  env read·import-time composition이 없고, 아직 `apps/api/src/index.ts`나 어떤 route에도 **연결되지
  않았습니다.** hourly service는 직접 caller가 완성된 `KmaForecastRequest`로도 여전히 호출할 수
  있으며, 그 공개 API는 변경되지 않았습니다. PR #14에서는 공식 API 제공 지연(단기 +10분·초단기 +15분)을
  반영하는 **별도 순수 selector**(`selectLatestKmaForecastBaseTimeAfterAvailabilityDelay`)를
  `weather-core`에 추가했습니다 — `reference − delay`에 PR #8 selector를 재사용할 뿐이며, 기존 schedule
  selector는 **변경되지 않았습니다.** PR #15에서는 request factory에 base-time selector 주입
  seam(`KmaForecastBaseTimeSelector`, 선택적 두 번째 인자)을 추가하고, **production scheduled composition이
  PR #14 availability-delay selector를 명시적으로 주입**하도록 배선했습니다 — factory default는 여전히
  PR #8 schedule selector(`createScheduledRequest` 이름 유지)라 selector를 생략한 direct caller는
  불변이고, location composition은 grid composition 재사용으로 이 정책을 자동 상속합니다(location runtime
  불변). 두 production pipeline 모두 availability-threshold-aware가 됩니다(SHORT 05:00→0200·05:10→0500,
  ULTRA 06:30→0530·06:45→0630; exact inclusive는 프로젝트 정책, live 보장 아님). request factory
  input/output shape·composition dependencies type은 변경하지 않았습니다. PR #16에서는 이 availability-delay
  selector를 **두 reference**(원본 → primary, `reference − one issuance interval` → previous)에 재사용해
  하나의 절대 시각에서 primary/previous 두 후보를 만드는 순수 함수
  (`selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay`)를 `weather-core`에 추가했습니다 — SHORT
  3시간·ULTRA 1시간 issuance interval만 소유합니다. PR #16 시점에는 request factory·composition·route
  어디에도 연결되지 않았으나, 이후 **PR #20 grid fallback composition**이 이 candidate selector를
  request-plan factory에 명시적으로 주입해 소비합니다(기존 scheduled facade는 계속 호출당 KMA request 최대
  1회, 신규 fallback root는 eligible primary에 한해 최대 2회이며 startup/route 미연결).
- 위경도→grid **순수 변환**(`convertKmaLatitudeLongitudeToGrid`)은 PR #12에서 `weather-core`에 구현
  완료됐고, **PR #13에서 이를 실제 소비하는 latitude/longitude application adapter**(location facade
  `createKmaLocationScheduledHourlyForecastFacade`와 location composition
  `createKmaLocationScheduledHourlyCompositionFromEnv`)를 추가했습니다 — caller input(product/latitude/
  longitude) → converter → `{ nx, ny }` → 기존 scheduled facade → 결과 흐름을 완성하고, 지원 밖 위치는
  `LOCATION`/`UNSUPPORTED_LOCATION` 결과로, 물리적으로 잘못된 좌표는 converter `RangeError`로 처리합니다.
  location composition은 기존 grid-based composition을 재사용하고 그 앞단에 production converter를
  조립할 뿐, 기존 facade·composition의 result·API는 그대로입니다. 다만 두 composition root 모두 아직
  `apps/api/src/index.ts`나 어떤 route에도 **연결되지 않았습니다**. `WeatherOverview` 조립,
  `SourceMetadata`, 현재 날씨, 일별 예보(`TMN`/`TMX`), 체감온도·생활지수 계산, 공통 Provider interface,
  production composition root를 **app startup/route에 연결**하는 wiring, HTTP status mapping, live
  availability fallback/retry(publication-in-progress·empty-data 대응), cache, `/weather` route, 별도
  general `config` package는 아직 **미구현**입니다(후속 PR).
- PR #17에서는 `apps/api` services 계층에 **순수 fallback eligibility classifier**
  (`classifyKmaHourlyFallbackEligibility`)를 추가했습니다 — hourly service result를 입력받아
  `PROVIDER`/`KMA_UPSTREAM_ERROR`/`03`은 `KMA_NO_DATA`, empty hourly success는 `EMPTY_HOURLY`,
  그 외는 ineligible로 분류합니다. Provider raw error·normalization issue surface·기존 service result
  계약은 불변이고, classifier는 orchestration 전 단계의 정책 component입니다. PR #16 candidate
  selector와 이 classifier는 PR #17 시점에는 아직 production graph에서 조합되지 않았으나, 이후 **PR #20 grid
  fallback composition**에서 조립됐습니다(dependency cycle 없음). 실제 fallback 실행·route·startup 연결·
  cache는 여전히 미구현입니다([kma-fallback-eligibility.md](./kma-fallback-eligibility.md)).
- PR #18에서는 주입된 clock·candidate selector·caller nx/ny를 결합해 한 기준시각에서 `{ primary, previous }`
  complete request 쌍을 만드는 **request-plan factory**(`createKmaFallbackRequestPlanFactory`)를 추가했고,
  PR #19에서는 이 plan factory·PR #7 hourly service·PR #17 classifier를 조합하는 **fallback orchestration
  service**(`createKmaHourlyFallbackService`)를 추가했습니다 — plan 1회 → primary hourly service 1회 →
  primary classifier 1회 → ineligible이면 종료, eligible이면 previous hourly service 최대 1회(maximum two
  service calls, previous 재분류 없음, third attempt 없음). 같은 options/AbortSignal reference를 두 호출에
  전달하고, input/request/두 service result를 reference 그대로 통과시키며, 새로운 error union·broad
  catch·logging이 없습니다. Provider 의존은 hourly service를 통해서만 간접적이고 dependency cycle은
  없습니다. PR #19 시점에는 이 orchestration이 아직 어떤 production composition root에도 연결되지 않았으나,
  이후 **PR #20 grid fallback composition root**가 이를 실제 graph로 조립했습니다 — 기존 두 scheduled
  composition은 계속 호출당 KMA request 최대 1회로 불변입니다. result merge·final source selection·
  `WeatherOverview`/`SourceMetadata`·route·startup 연결·cache는 여전히
  미구현입니다([kma-hourly-fallback.md](./kma-hourly-fallback.md)).
- PR #20에서는 위 PR #16~#19 building block을 실제 서버용으로 조립하는 **세 번째 (grid) production
  composition root**(`src/composition`, `createKmaHourlyFallbackCompositionFromEnv`)를 기존 두
  single-request root 옆에 **병렬로** 추가했습니다 — env → Provider-from-env → hourly service, system
  clock/injected clock + 명시적으로 주입한 PR #16 candidate selector → PR #18 request-plan factory,
  plan factory + hourly service + 명시적으로 주입한 PR #17 classifier → PR #19 fallback service를 한 번의
  함수 호출로 조립해 live `KmaHourlyFallbackService`(성공 시 `{ ok, service }`만 공개)를 반환합니다.
  생성 시 clock read·network 0회, config 실패는 Provider의 `KmaProviderConfigError` 값 그대로 전달,
  실행 시 primary ineligible이면 fetch 최대 1회·eligible이면 최대 2회(clock 호출당 1회, previous 재분류
  없음, third attempt 없음)입니다. 기존 grid/location scheduled composition과 그 `{ ok, facade }`
  계약·runtime은 **불변**이고, `/weather` route·startup 연결·result assembly·cache는 여전히
  **미구현**입니다([kma-hourly-fallback-composition.md](./kma-hourly-fallback-composition.md)).
- PR #21에서는 위 PR #20 grid fallback root 앞단에 PR #12 위·경도 → grid converter를 두는 **네 번째 (location)
  production composition root**(`src/composition`, `createKmaLocationHourlyFallbackCompositionFromEnv`)와 그
  **location fallback facade**(`src/services`, `createKmaLocationHourlyFallbackFacade`)를 기존 세 root 옆에
  **병렬로** 추가했습니다 — caller input(product/latitude/longitude) → 주입된 converter → `{ nx, ny }` →
  PR #20 grid fallback service 흐름을 완성하고, 지원 밖 위치는 `LOCATION`/`UNSUPPORTED_LOCATION` 결과(Provider
  0회)로, 물리적으로 잘못된 좌표는 converter `RangeError`(동기)로 처리합니다. facade는 fallback service의
  execution trace를 그대로 통과시키고(지원 위치 Provider 최대 2회), 새로운 base-time·eligibility·final
  selection 정책을 만들지 않습니다. location composition은 PR #20 grid fallback composition을 재사용하고 그
  앞단에 production converter를 조립할 뿐, 기존 세 root의 result·API·runtime은 그대로입니다(성공 result key는
  `facade`, config 실패는 `KmaProviderConfigError` 동일 reference). 다만 네 composition root 모두 아직
  `apps/api/src/index.ts`·startup·`/weather` route에 **연결되지 않았고**, final primary/previous selection·
  `WeatherOverview`/`SourceMetadata`·cache는 여전히 **미구현**입니다([kma-location-hourly-fallback.md](./kma-location-hourly-fallback.md)).
- PR #22에서는 `apps/api` services 계층에 **순수 fallback result selector**
  (`selectKmaHourlyFallbackResult`)를 추가했습니다 — PR #19 execution trace를 입력받아 nonempty success만
  usable로 보고 primary를 우선 선택하며, primary가 unusable이고 previous가 usable이면 previous를,
  둘 다 unusable이면 none을 반환합니다. `fallbackAttempted`(previous 호출)와 `fallbackUsed`(previous
  usable data 실제 선택)를 구분하고, execution/selected result의 exact reference를 보존하는 fresh wrapper를
  반환합니다. 순수·동기 함수로 Provider·network·clock·environment·eligibility classifier(PR #17)를 호출하지
  않고 `LOCATION` branch를 처리하지 않으며, 실행 계층(PR #19)과 분리된 selection 계층입니다. 이 selector는
  아직 어느 composition root·`/weather` route에도 연결되지 않았고(네 root 불변), 이를 소비하는
  `WeatherOverview`/`SourceMetadata` assembler·cache는 여전히 미구현입니다
  ([kma-hourly-fallback-selection.md](./kma-hourly-fallback-selection.md)).
- PR #23에서는 `apps/api` services 계층에 **순수 hourly `WeatherOverview` assembler**
  (`assembleKmaHourlyWeatherOverview`)를 추가했습니다 — PR #22 selection을 입력받아 hourly section만 조립한
  partial `WeatherOverview`를 만듭니다. selected면 선택된 result의 hourly를 overview로 옮기고 KMA `HOURLY`
  `SourceMetadata` 한 건을 조립하며 HOURLY를 missing에서 제외하고, no-selection이면 빈 hourly/sources에
  HOURLY까지 포함한 여섯 section을 missing으로 표기합니다(나머지 section은 fixed placeholder).
  provenance(`sourceId`/`issuedAt`/`fetchedAt`/`retrievalMode`)는 caller가 제공하고 assembler는
  `provider: 'KMA'`·`sections: ['HOURLY']`·`observedAt: null`만 고정하며(issuedAt은 caller가 null도 명시
  가능), clock·base time을 추정하지 않습니다. `weatherOverview.parse`로 동기 검증하는 순수·동기 함수로
  input을 mutate하지 않고 호출마다 fresh output을 만들며, PR #22 selector를 호출하지 않고 LOCATION
  branch·current/daily/AQ/alerts·composition·route를 다루지 않습니다. 이로써 services 계층 application
  component는 **10개**가 됐고, selector(PR #22)와 assembler(PR #23)를 location result narrow와 함께 엮어
  소비하는 application service·production composition·`/weather` route·cache는 여전히 미구현입니다
  ([kma-hourly-weather-overview.md](./kma-hourly-weather-overview.md)).
- PR #24에서는 `apps/api` services 계층에 **location hourly `WeatherOverview` application service**
  (`createKmaLocationHourlyOverviewService`)를 추가했습니다 — 위 네 building block을 하나의 호출로
  잇습니다. 호출당 contracts `weatherLocation.parse`를 **선행** 실행하고(invalid location이면 collaborator
  0회로 동기 `ZodError`), parsed 위·경도로 PR #21 location fallback facade를 실행하고, top-level `LOCATION`
  실패는 facade 결과 그대로 반환하며, 지원 trace에는 PR #22 selector를 적용하고, **주입된** selected-source
  metadata resolver를 selected trace에서만 정확히 1회 호출한 뒤 PR #23 assembler로 `{ ok: true, selection,
  overview }`를 조립합니다. 서비스 내부 방향은 **location facade → selector → resolver seam → assembler**
  한 방향이고(composition 의존 없음, 순환 없음), no-selection도 성공(`ok: true`)이며 Provider/Normalization
  실패를 top-level error로 승격하지 않습니다. method는 `async`가 아니어서 location/facade 동기 throw는 동기로,
  facade rejection·selector/resolver/assembler throw는 Promise rejection으로 전파되며(동일 reference),
  broad catch·wrapping·logging이 없고 clock/env/network를 소유하지 않습니다(provenance는 주입된 resolver가
  결정, 별도 clock으로 issuedAt 재계산 없음). 이로써 services 계층 application component는 **11개**가 됐고, PR
  #21 facade·PR #22 selector·PR #23 assembler를 엮는 **application service는 구현 완료**됐으나, 이를 조립하는
  **production metadata resolver·PR #24 production composition·`/weather` route·cache는 여전히
  미구현**입니다(네 composition root 불변)
  ([kma-location-hourly-overview.md](./kma-location-hourly-overview.md)).
- PR #25에서는 `apps/api` services 계층에 **sanitized issuance identity** public type
  (`KmaForecastIssuanceIdentity`, `product`/`baseDate`/`baseTime`만)을 추가하고, PR #19 execution trace가
  **실제 request plan**에서 파생한 이 identity를 보존하도록 확장했습니다 — no-fallback trace는
  `primaryIssuance`, fallback-attempted trace는 `primaryIssuance` + `previousIssuance`를 담고,
  `previousIssuance`는 previous가 실제 실행된 branch에만 존재합니다. identity는 이미 만들어진 plan에서 fresh
  object로 파생하므로 clock을 다시 읽거나 selector/plan factory를 재호출하지 않으며, `nx`/`ny`·full
  request·plan·ServiceKey·URL·query·raw body는 노출하지 않습니다. PR #22 selector는 이 identity를 복제하지 않고
  execution reference만 보존하고, PR #24 resolver seam은 `selection.execution.primaryIssuance`(그리고
  `fallbackAttempted` narrow 후 `previousIssuance`)로 실제 발표시각 identity에 접근할 수 있습니다. 이 새 type은
  application component가 아니라 model이므로 services 계층 application component 수는 **여전히 11개**이고,
  production metadata resolver·issuedAt/fetchedAt/sourceId/retrievalMode는 이 시점까지는 미구현입니다(PR #26
  범위; 네 composition root·PR #22/#23/#24 runtime 불변) ([kma-hourly-fallback.md](./kma-hourly-fallback.md)).
- PR #26에서는 `apps/api` services 계층에 **live selected-source metadata resolver**
  (`createKmaLiveSelectedHourlySourceMetadataResolver`)와 공개 issuedAt converter
  (`convertKmaForecastIssuanceToIssuedAt`)를 추가했습니다 — PR #24 service가 주입받는 production resolver로,
  PR #25 trace가 보존한 실제 issuance identity를 소비합니다. `PRIMARY`→`primaryIssuance`,
  `PREVIOUS`→`previousIssuance`(fallback-attempted에만 존재), `issuedAt`은 `baseDate`/`baseTime`을 KST
  `+09:00` seconds instant로(`Date` 미사용, `isoDateTime`로 calendar 검증), `sourceId`는 product별 고정
  (`kma-short-forecast-hourly`/`kma-ultra-short-forecast-hourly`, PRIMARY/PREVIOUS·fallbackUsed·location
  미반영), `retrievalMode`는 `LIVE` 고정, `fetchedAt`은 resolver materialization 시각으로 주입 clock을 유효
  입력당 정확히 1회 읽어 UTC `Z` ms로 생성합니다(정확한 transport timestamp 아님; future cache는 upstream
  `fetchedAt` 보존). clock 읽기 전에 `input.product === issuance.product`를 확인하고, malformed
  issuance/selection·PREVIOUS+no-fallback·product mismatch·invalid clock은 static `RangeError`로 실패하며
  (invalid 입력은 clock 0회), throwing clock은 동일 reference로 전파됩니다. 이로써 services 계층 application
  component는 **12개**가 됐고, application service와 그것이 주입받는 **production metadata resolver 모두 구현
  완료**됐으나, 이를 실제 graph로 조립하는 **PR #24 production composition·`/weather` route·cache는 여전히
  미구현**입니다(production composition root 수 여전히 4개; PR #27 예정)
  ([kma-selected-hourly-source-metadata.md](./kma-selected-hourly-source-metadata.md)).
- PR #27에서는 위 세 요소를 실제 graph로 잇는 **다섯 번째 callable production composition root**
  (`createKmaLocationHourlyOverviewCompositionFromEnv`, `src/composition`)를 기존 네 root 옆에 **병렬로**
  추가했습니다 — PR #21 location fallback composition을 재사용하고, PR #26 live selected-source metadata
  resolver를 붙여, PR #24 application service를 하나의 live `KmaLocationHourlyOverviewService`로
  조립합니다. dependencies는 PR #21 dependencies의 직접 alias이고, PR #22 selector·PR #23 assembler는
  PR #24 service의 고정 default입니다. injected clock을 주입하면 하위 fallback root와 **같은 reference**가
  request plan과 metadata resolver 양쪽에 쓰이고(supported selected 호출당 clock 2회), 생략하면 하위 root의
  캡슐화를 깨지 않고 resolver에 **fresh system clock adapter**를 새로 만듭니다. `issuedAt`은 두 번째 clock
  read가 아니라 PR #25 trace가 보존한 issuance identity에서 파생되고, `fetchedAt`만 두 번째 read에서
  나옵니다. 성공 시 `{ ok, service }`만 공개하고 config 실패는 Provider의 `KmaProviderConfigError` 동일
  reference를 전달하며, construction은 network-free(clock/converter/fetch/selector/resolver/assembler
  0회)입니다. 결과는 PR #24 **internal application result**(`{ ok, selection, overview }` 또는 `LOCATION`
  verbatim)이며, future mobile-facing route는 이를 그대로 serialize하지 않고 `overview`만 매핑해야 합니다(이
  PR은 그 mapper 미구현). 이로써 callable production composition root 수는 **4 → 5**가 되고, services 계층
  application component 수(**12**)는 변하지 않습니다(composition root는 service component가 아님). 다섯 root
  모두 아직 `apps/api/src/index.ts`·startup·`/weather` route에 **연결되지 않았습니다**
  ([kma-location-hourly-overview-composition.md](./kma-location-hourly-overview-composition.md)).
- PR #29에서는 `apps/api`에 새 **presenters 계층**(`src/presenters`)과 그 첫 component인 **response
  presenter**(`presentKmaLocationHourlyOverviewResponseV1`)를 추가했습니다 — PR #24 **내부 application
  result**(`{ ok, selection, overview }` 또는 `LOCATION` 실패)를 모바일용 `WeatherResponseV1` body로
  변환하는 순수·동기 mapping입니다. 성공은 `{ ok: true, meta, data: overview }`로 매핑하며 `overview`만
  `data`로 노출하고 `selection`(PR #22 selection·PR #19 execution trace·PR #25 issuance identity·
  `fallbackUsed`)은 절대 읽거나 serialize하지 않습니다(result·meta spread 없음). no-selection도 error가
  아니라 **성공**이고, `LOCATION` 실패는 상수로 만든 안정적인 `UNSUPPORTED_LOCATION` 오류
  (`retryable: false`)로 매핑합니다. `contractVersion`은 presenter가 소유(`CONTRACT_VERSION` 고정)하고
  caller는 `generatedAt`/`requestId`만 제공하며 여분 meta key는 무시합니다. 출력은 contracts response
  schema로 producer-side 검증하므로 invalid `generatedAt`/`requestId`/overview는 동기 `ZodError`로
  전파됩니다(catch·wrap 없음). presenter는 PR #27 composition의 내부 result와 향후 `/weather` route의 공개
  response 사이의 **serialization 경계**이며, `apps/api/src/index.ts`·startup·route에는 아직 **연결되지
  않았습니다**(HTTP status/헤더/body-size·clock·`requestId` 생성은 후속 route PR). 이 presenter는
  composition root도 service component도 아닌 별도 계층이므로 callable production composition root
  수(**5**)와 services 계층 application component 수(**12**)는 변하지 않습니다. `UNSUPPORTED_LOCATION`은
  `ApiErrorCode`에 additive로 추가한 known value이므로 `CONTRACT_VERSION`은 계속 **1**입니다
  ([weather-response-presenter.md](./weather-response-presenter.md)).
- PR #30에서는 `apps/api`에 새 **routes 계층**(`src/routes`)과 그 첫 component인 **injectable
  `POST /weather` route factory**(`createWeatherRoute`)를 추가했습니다 — request contract·application
  service·PR #29 presenter를 HTTP 경계에서 잇는 mountable Hono sub-app으로, `POST /`만 등록하고
  (`app.route('/weather', createWeatherRoute(deps))`) Content-Type을 `application/json`으로 제한(415)·
  16 KiB **byte** 한도(413, `text.length`가 아닌 실제 byte)·malformed JSON과 `WeatherRequestV1` strict
  검증(둘 다 400, top-level·nested extra key 거부로 client product/nx/ny/serviceKey 차단)·server-owned
  KMA product 적용·주입된 service port 호출(raw Request AbortSignal을 exact reference로 전달, 새
  AbortController 없음)·PR #29 presenter·HTTP status mapping을 수행합니다(성공 200, `UNSUPPORTED_LOCATION`
  422, service/presenter throw 및 예상 밖 presenter error code는 고정 `INTERNAL_ERROR` 500). no-selection은
  200 성공이고, request-layer 오류도 producer-side로 검증한 `WeatherErrorResponseV1` 형태로만 반환하며 Zod
  issue·raw error·provider trace·secret을 노출하지 않습니다. service·presenter·server product·`meta`
  provider(clock/`requestId`)를 모두 주입받고 `process.env`·`Date.now`·`randomUUID`·`Math.random`을 직접
  읽거나 호출하지 않으며 console/logger·global `onError`/`notFound`를 추가하지 않아, startup과 무관하게
  단위/통합 테스트가 가능합니다. request-layer 오류 코드를 위해 `ApiErrorCode`에 `UNSUPPORTED_MEDIA_TYPE`·
  `PAYLOAD_TOO_LARGE`를 **additive**로 추가했으므로 `CONTRACT_VERSION`은 계속 **1**입니다. 이 route는
  composition root도 service component도 아닌 별도 계층이므로 callable production composition root 수(**5**)와
  services 계층 application component 수(**12**)는 변하지 않습니다. route factory는 아직
  `apps/api/src/index.ts`에 **mount되지 않았고**(유일한 호출 가능 endpoint는 여전히 `GET /health`),
  production service adapter·server product 정책·실제 clock/`requestId` 생성·production `/weather` mount는
  **PR #31 startup wiring**의 몫입니다 ([weather-route.md](./weather-route.md)).
- 이 문서의 나머지 "예정" 구조는 앞으로의 합의이며, 위 요약이 현재 코드베이스의 상태입니다.
