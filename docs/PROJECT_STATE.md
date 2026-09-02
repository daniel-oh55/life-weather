# Life Weather 프로젝트 상태

- 기준일: 2026-09-01
- State baseline: `afa35a2f9dc938aeda033d71b88edf89739b67bf` (PR #104 merge 이후 main)

이 문서는 baseline 시점의 저장소 사실, 미완료 범위와 다음 Owner 결정을 기록합니다.

## 현재 baseline

- Node 22 / pnpm 11 기반 TypeScript monorepo입니다.
- `apps/mobile`은 Expo Development Build 기반 Android-first 앱입니다.
- `apps/api`는 Hono API이며 Vercel-compatible structure를 사용합니다.
- PR #31은 merge되었습니다.
- PR #36에서 진행한 compiled Node ESM shared runtime package 작업은 PR #31을 통해 main에
  포함되었습니다.
- production app에 `GET /health`와 `POST /weather`가 mount되어 있습니다.
- `POST /weather`는 현재 KMA `SHORT_FORECAST` 기반 location hourly overview와 초단기실황
  (`getUltraSrtNcst`) 기반 current-observation을 함께 제공합니다(PR #81). current가 실패하면
  `current: null`과 `missingSections`의 `CURRENT`로 강등되며(PR #77의 기존 degradation 정책), 이
  경우에도 `HOURLY`는 그대로 유지됩니다.
- PR #96(**MERGED**, main `c3dc6518aaf069c76072dc53c957e7dae08efb63`)부터 `POST /weather`의
  `daily`는 이미 선택된 KMA 단기예보 hourly 데이터에서 파생됩니다(추가 provider 요청 없음).
  계약은 원래부터 존재했고 변경되지 않았습니다. 이 단기 daily 파생은 현재 main에 포함되어
  있습니다.
- `KMA_SERVICE_KEY`는 server-only이며 누락 시 startup에서 fail-fast합니다.
- startup 과정에서는 외부 fetch를 수행하지 않습니다.
- `contracts`와 `weather-core`는 compiled `dist` entrypoint를 사용합니다.
- `postinstall`과 public checks의 build-first 흐름은 clean checkout과 stale `dist` 문제를
  방지합니다.
- `lifestyle-engine`에는 umbrella, outfit, mask와 laundry 정책이 구현되어 있습니다.
- PR #97(**MERGED**)이 모바일 주간예보 뷰를 main에 포함시켰습니다.
- PR #98(**MERGED**)은 KMA 중기예보 조회서비스(`MidFcstInfoService`)의 D+4~D+10
  **provider boundary**를 추가했습니다 — 중기기온조회(`getMidTa`)와 중기육상예보조회
  (`getMidLandFcst`)의 request 검증·고정 operation path 매핑·URL 생성, operation별 raw JSON
  runtime schema, 성공/upstream error/invalid response 3-outcome parser, 기존 공유 HTTP
  transport(`performKmaGetRequest`)와 동일한 `KMA_SERVICE_KEY` config를 재사용하는
  provider(`createKmaMidtermForecastProvider`)까지입니다. 변경은
  `apps/api/src/providers/kma/**` 와 문서에 한정되며 `packages/**`·`CONTRACT_VERSION`·
  `services`·`composition`·`routes`·`presenters`·`apps/mobile/**`·dependency·env는 변경하지
  않았습니다. 위치 → `regId` resolver, 최신 06/18 KST issuance selector, `DailyForecast`
  정규화, 한국어 날씨 문구 → `WeatherCondition` 매핑, `POST /weather` production wiring은
  **여전히 후속 작업**입니다. 이 PR에서 실제 KMA API 호출·배포·env 변경은 수행하지 않았습니다.
  자세한 내용은 [kma-midterm-provider.md](./kma-midterm-provider.md) 참고. PR #98 merge 당시
  main은 `50d03e013589f5b4d73d33cc2497c7024a882aee`였습니다.
- PR #99(**MERGED**)는 PR #98이 추가한 mid-term provider boundary가 아직 다루지 않은 최신 06/18
  KST issuance selector — `selectLatestKmaMidtermIssuance`
  (`packages/weather-core/src/kma/midterm-issue-time.ts`)만 추가했습니다. forecast/current-observation
  selector와 같은 원칙(순수, 결정론적, clock/환경/I-O 없음, KST 고정 `UTC+09:00`, `RangeError`
  value-free 정책)을 따르는 별도·병렬 구현이며, 공식 06:00/18:00 KST 발표 스케줄만 선택하고 API
  가용성 지연은 발명하지 않습니다. `regId` 매핑, mid-term request factory, provider/service/
  composition, `POST /weather` 연결은 이 PR 범위가 아니었습니다. 자세한 내용은
  [kma-midterm-issue-time.md](./kma-midterm-issue-time.md) 참고. PR #99 merge 당시 main은
  `115e9c622b1a6b05dd4da89bd5769d00a39a1903`였습니다.
- PR #100(**MERGED**)은 PR #98의 `KmaMidtermForecastRequest` provider boundary와 PR #99의
  `selectLatestKmaMidtermIssuance`를 잇는 application-level **request-plan factory**
  (`createKmaMidtermRequestPlanFactory`, `apps/api/src/services/kma-midterm-request-plan.ts`)를
  추가했습니다. 이 factory는 injected clock을 정확히 1회 읽고 injected issuance selector를 정확히
  1회 호출해, 그 하나의 `tmFc`로 TEMPERATURE(`getMidTa`)와 LAND(`getMidLandFcst`) 두 complete
  request를 만듭니다 — 두 independent single-request factory 호출로 구현하지 않으므로
  `temperature.tmFc === land.tmFc`가 항상 보장됩니다. `temperatureRegId`/`landRegId`는 별도로
  이름 붙은 caller-supplied 입력이며, 이 PR은 위치/행정구역/좌표 → `regId` 매핑을 추가하지
  않습니다. 기본 issuance selector는 여전히 PR #99의 schedule-only
  `selectLatestKmaMidtermIssuance`이고, API availability delay/fallback/retry는 발명하지
  않습니다. provider를 호출하지 않고, 실제 KMA API 호출도 수행하지 않습니다. 자세한 내용은
  [kma-midterm-request-plan.md](./kma-midterm-request-plan.md) 참고. PR #100 merge 당시 main은
  `92ec4e1ce3df8e75df3a015a1939d8a35880c92c`였습니다.
- PR #101(**MERGED**, main `6c39d5e6703f63dfab8cf4ff2a53525455182be4`)은 PR #100의 request-plan factory와 PR #98의
  `KmaMidtermForecastProvider.fetchMidtermForecast`를 잇는 application-level **execution
  service**(`createKmaMidtermExecutionService`, `apps/api/src/services/kma-midterm-execution.ts`)를
  추가합니다. 한 호출에서 request-plan factory를 정확히 1회 호출하고, plan의 `temperature`
  request를 provider에 정확히 1회 전달하고, 그 호출이 정상적으로 result union으로 resolve되면
  성공/실패와 관계없이 plan의 `land` request도 provider에 정확히 1회 전달하며, 두 provider result를
  그대로 보존한 execution result를 반환합니다. 정상적인 provider-domain 실패(`{ ok: false, error }`)는
  resolved된 application 값이지 예외가 아니므로 TEMPERATURE가 `ok: false`로 resolve되어도 LAND
  호출을 막지 않습니다 — 이 서비스는 error kind를 검사해 LAND 실행 여부를 결정하지 않습니다.
  실행 순서는 TEMPERATURE → LAND 결정적 순차 실행이며 `Promise.all`/race/concurrency 정책은
  추가하지 않습니다. plan-factory/provider의 throw/rejection은 동일 error reference로 그대로
  전파되고 partial execution result는 반환되지 않습니다. caller의 `options`(`AbortSignal` 포함)는
  정확히 같은 참조로 두 호출 모두에 전달되며, 이 서비스는 abort policy를 소유하지 않습니다. 이
  PR은 정규화하지 않습니다 — `DailyForecast[]` 생성, TEMPERATURE/LAND 병합, 한국어 문구 →
  `WeatherCondition` 매핑, 최종 source 선택, `WeatherOverview`/`SourceMetadata` 조립, 위치 →
  `regId` 매핑, production composition/route 연결은 모두 여전히 후속 작업입니다. 자세한 내용은
  [kma-midterm-execution-service.md](./kma-midterm-execution-service.md) 참고.
- PR #102(**MERGED**, main `f41484228c4013ddb4b138f738d85c3deea0a31b`)는 KMA 중기육상예보(`getMidLandFcst`)의 한국어 `WF` 날씨 문구를
  공통 `WeatherCondition` subset으로 정규화하는 `weather-core` **순수 정책**만
  추가합니다(`normalizeKmaMidtermWeatherCondition`,
  `packages/weather-core/src/kma/midterm-condition.ts`) — 기존 단기·초단기 SKY/PTY 숫자 코드
  정규화(`condition.ts`)와는 별도·병렬인 sibling 정책입니다. 강수 semantic이 하늘상태 설명보다
  우선하고, 비/눈 혼합은 `SLEET`로, `소나기`는 `SHOWER`로 먼저 판정되며, 중기예보 공식 DB 정의가
  여전히 명시하는 `WB02 = 구름조금`을 단기예보의 폐지된 숫자 SKY 코드 `2`와 다르게
  `PARTLY_CLOUDY`로 지원합니다. 알 수 없는 문구는 예외 없이 `UNKNOWN`이며 `FOG`/`THUNDERSTORM`
  같은 새 값을 발명하지 않습니다. 이 PR은 `DailyForecast[]` 생성, TEMPERATURE/LAND 병합, 위치 →
  `regId` 매핑, production composition/route 연결을 포함하지 않으며, provider/service 변경과 실제
  KMA API 호출도 수행하지 않습니다. 자세한 내용은
  [kma-midterm-condition.md](./kma-midterm-condition.md) 참고.
- PR #103(**MERGED**, main `3e2cf49f7cc3d908a8d59eda5a09c4e3081d2a80`)은 docs-only PR로, 이
  `PROJECT_STATE.md`의 Fast-track 1.0 baseline을 재정리했습니다 — 코드 변경은 없습니다.
- PR #104(**MERGED**, main `afa35a2f9dc938aeda033d71b88edf89739b67bf`)는 1.0 남은 요구사항이었던 **모바일 weather response
  freshness/stale 표시**를 최소 vertical slice로 구현합니다 — `MobileWeatherQuerySnapshot`은
  여전히 정확히 `IDLE`/`LOADING`/`SUCCESS`/`ERROR`이며 새 `STALE` query-store variant는 추가하지
  않습니다. Staleness는 network/lifecycle state가 아니라 현재 `SUCCESS` snapshot의 **presentation
  freshness**로 취급되며, 오직 이미 계약 검증된 `data.meta.generatedAt`만 사용합니다(device 수신
  시각, KMA base time, AirKorea data time, 개별 `SourceMetadata`, provider-native timestamp는
  사용하지 않음). 고정 60분 임계값(`MOBILE_WEATHER_STALE_AFTER_MILLISECONDS`, 정확히 60분은
  stale)과 순수 classifier(`classifyMobileWeatherFreshness`), 그 자신의 presentation
  one-shot 타이머(폴링/`setInterval`/background task 아님)를 소유하는 새 공유 컴포넌트
  (`apps/mobile/src/components/weather-freshness-notice.tsx`, `WeatherFreshnessNotice`)가 네
  weather 탭(오늘/예보/생활날씨/상세기상) 모두에서 `weatherQuery.status === 'SUCCESS'`일 때만
  마운트되고, `FRESH`이면 아무것도 렌더링하지 않습니다. `MobileWeatherQueryStore`에는 additive
  `refresh(): void`만 추가됐습니다 — `SUCCESS`에서만 내부에 보존된 정확히 같은
  `WeatherRequestV1` 참조로 기존 `beginRequest()` 경로(기존 generation/abort/reentrancy 계약
  그대로)를 재시작하고, `IDLE`/`LOADING`/`ERROR`에서는 no-op이므로 `LOADING` 중 반복 tap은 중복
  요청을 만들 수 없습니다. `request()` 시그니처와 기존 `retry()`는 변경되지 않았습니다.
  `packages/contracts`, `CONTRACT_VERSION`, `packages/weather-core`, API, response
  cache/persistence는 이 PR에서 변경되지 않았습니다. 자세한 내용은
  [mobile-weather-freshness.md](./mobile-weather-freshness.md) 참고.
- PR #105(**Draft, 아직 MERGED 아님**)는 Fast-track 1.0의 마지막 남은 구현 vertical
  slice였던 **Android 1.0 release / AdMob / consent / privacy 통합**을 구현합니다 —
  `react-native-google-mobile-ads@16.5.0` 의존성, `app.json`을 정적 base로 유지하는 동적
  `apps/mobile/app.config.ts`(`EAS_BUILD === 'true' && EAS_BUILD_PROFILE === 'production'`일 때만
  5개 필수 release 값을 변수명만 노출하는 fail-fast로 검증하고, 그 외에는 Google 공식 sample AdMob
  Android App ID로 안전하게 대체), `eas.json`의 신규 `production` 프로필(EAS project 연결·실제
  Build는 미수행), `apps/mobile/src/ads/`의 provider-neutral ads runtime store(UMP consent
  gather/실패 시 이전 세션 정보로 대체, `canRequestAds`일 때만 최대 한 번
  `mobileAds().initialize()`, consent 자체 영속화 없음)와 그 store를 시작하는 `_layout.tsx`의 기존
  단일 mount effect, Today 탭 전용 단일 adaptive banner(`TodayBannerAd`, dev/production ad-unit
  분리, 위치·좌표·날씨 상태 targeting 없음), Settings의 `대기질: 에어코리아 연동 예정` → `대기질:
  에어코리아` 수정과 새 `개인정보 및 광고` section(환경변수 기반 개인정보 처리방침 링크, UMP
  `privacyOptionsRequirementStatus === REQUIRED`일 때만 노출되는 광고 개인정보 선택 관리
  버튼)까지입니다. 실제 operator-managed 값(package identifier, AdMob ID, EAS project ID,
  production URL)은 어디에도 commit되지 않았습니다. 실제 KMA/AirKorea endpoint 호출, native
  prebuild, EAS Build, Play/AdMob 콘솔 변경, production 배포는 이 PR에서 수행하지 않았습니다.
  자세한 내용은 [android-1.0-release-admob.md](./android-1.0-release-admob.md) 참고. Owner Ready
  전환과 merge 전까지는 1.0 미완료 항목으로 남습니다.

## Fast-track 1.0 활성 계획

이 섹션은 현재 진행 우선순위의 canonical summary입니다. 아래 PR별 상세 기록(과거 "아직 구현되지
않은 항목"과 이후 PR 서술)은 해당 PR 시점의 historical context를 포함할 수 있으며, 현재
완료/미완료 판단과 다음 우선순위는 `현재 baseline`과 이 섹션을 우선합니다.

### 1.0에서 이미 완료된 항목

- 대한민국 수동 지역 검색
- 여러 저장 지역 + selected location
- KMA current
- KMA hourly/short forecast
- short-forecast 기반 `WeatherOverview.daily`
- AirKorea current PM10/PM2.5 production integration
- Today / Hourly·Forecast / Lifestyle / Details / Settings 최소 화면
- 기존 lifestyle-engine 4개 정책(우산/옷차림/마스크/빨래)
- mobile weather API/query boundary
- 주요 loading/error/empty 상태

### 1.0 남은 구현 PR

Mobile freshness/stale handling은 **PR #104**(MERGED)로 구현되었습니다 — 위 "현재 baseline"의 PR
#104 항목 참고. Android 1.0 release / AdMob / consent / privacy integration은 **PR #105**(Draft,
아직 MERGED 아님)로 구현되었습니다 — 위 "현재 baseline"의 PR #105 항목 참고. Owner Ready 전환/merge
전까지는 완료로 표시하지 않지만, 코드 구현 자체는 더 이상 이 섹션의 "남은 구현 PR"에 해당하지
않습니다.

**PR #105 코드 구현이 완료되면, Fast-track 1.0에는 더 이상 계획된 feature PR이 남지 않습니다.**
남은 작업은 모두 아래 "코드 완료 이후 Owner gate"의 Owner 외부 작업이거나, blocker가 발견된 경우의
targeted remediation PR뿐입니다.

### 코드 완료 이후 Owner gate (PR 아님)

1. production/public API base URL 설정
2. Development Build
3. 실제 Android 실기기 QA
4. 승인된 실제 KMA/AirKorea endpoint 검증
5. 광고/동의 QA
6. Play / AdMob / Data safety / privacy 관련 외부 콘솔 작업
7. blocker가 발견된 경우에만 targeted remediation PR

QA 자체는 별도 기능 PR로 계획하지 않습니다.

### 1.1 이후 backlog (1.0 critical path에서 제외)

다음은 1.0 active TODO에서 제외되며, 1.1 이후로 이동합니다. **PR #98~#102가 구축한 KMA
mid-term(중기예보) 기반은 삭제되거나 deprecated 처리되지 않습니다** — 1.1용으로 검증된
기반으로 보존되며, 1.0 release critical path에서만 제외됩니다.

- KMA mid-term D+4~D+10 production 완성
- temperature/land regId resolver
- short + mid daily 통합
- KMA 1개월 전망(월간예보) — 1.1 최우선 확장 기능, [product-scope.md](./product-scope.md) 참고
- alerts production integration
- AirKorea forecast(예보)
- response cache
- Android widget
- GPS/current-location 권한 흐름
- push
- 추가 lifestyle 정책
- UV 상세 기능
- location 재정렬/스와이프
- 추가 광고 형식
- 정교한 일러스트/animation
- database/cloud sync

## 아직 구현되지 않은 항목

- daily section의 **중기예보(D+4~D+10)** 확장 (단기 daily 자체는 PR
  #96에서 기존 hourly 데이터 파생으로 구현되어 merge됐고, 이를 소비하는 **모바일 주간예보 UI**는
  PR #97에서 구현됐습니다 — 아래 PR #96·#97 항목 참고. 아래
  current-observation 관련 서술은 PR #63~#80의 historical implementation
  context이며, current가 현재도 미구현이라는 뜻이 아닙니다 — current는 PR #81부터 production
  `POST /weather`에 연결되어 있습니다. 위 "현재 baseline" 항목을 참고하세요. KMA
  초단기실황(`getUltraSrtNcst`) **provider boundary**는 **PR #63**에서
  구현됐습니다 — request 검증·URL 생성, raw JSON schema, 성공/upstream/invalid 분류, category
  grouping, 기존 HTTP transport 정책을 재사용하는 provider(`createKmaCurrentObservationProvider`),
  공유 `CurrentWeather`로의 순수 normalizer(`normalizeKmaCurrentObservation`)까지입니다. **PR
  #66**이 이 provider가 소비하는 request factory(`createKmaCurrentObservationRequestFactory`)를,
  **PR #67**이 이 provider와 normalizer를 잇는 application
  service(`createKmaCurrentObservationService`)를 각각 추가했고, **PR #68**이 이 request
  factory와 service를 순서대로 연결하는 얇은 scheduled
  facade(`createKmaScheduledCurrentObservationFacade`,
  `fetchScheduledCurrentWeather`)를 추가했습니다 — hourly의 PR #10 scheduled facade와 같은
  원칙(input/request/options/AbortSignal exact reference, 반환 Promise identity 유지, factory→
  service 순서, factory throw 시 service 0회, 새 result union·stage 없음)을 따르는 별도·병렬
  구현입니다. 이어서 **PR #69**가 이 facade를 소비하는 여섯 번째 callable production composition
  root(`createKmaScheduledCurrentObservationCompositionFromEnv`,
  `apps/api/src/composition/kma-scheduled-current-observation.ts`)를 추가했습니다 — PR #63
  provider-from-env, (injected 또는 기존 `createKmaSystemClock()` 재사용) system clock, PR #64
  schedule-only selector(explicit 주입, availability-delay selector는 아직 없음), PR #66 request
  factory, PR #67 service, PR #68 facade를 정해진 순서로 조립하는 **callable function**입니다(모듈
  import 시 조립 없음). 성공은 `{ ok, facade }`만 노출하고, config 실패는 Provider factory의
  `KmaProviderConfigError`를 동일 reference로 반환하며, construction 시 clock read·selector 실행·
  network fetch가 0회입니다. 이 composition은 여전히 `apps/api/src/index.ts`·`POST /weather`·
  location(위경도 → grid) adapter에 연결되지 않았으므로, production 응답의 `current`는 이 PR
  이후에도 계속 missing입니다. daily sections은 여전히 미구현입니다. 자세한 내용은
  [kma-current-observation-provider.md](./kma-current-observation-provider.md),
  [kma-current-observation-request-factory.md](./kma-current-observation-request-factory.md),
  [kma-current-observation-service.md](./kma-current-observation-service.md),
  [kma-scheduled-current-observation-facade.md](./kma-scheduled-current-observation-facade.md),
  [kma-current-observation-production-composition.md](./kma-current-observation-production-composition.md)
  참고. 이어서 **PR #70**이 기존 위경도 → KMA grid 변환 함수를 PR #68 scheduled facade 앞단에 잇는
  application-level location facade(`createKmaLocationScheduledCurrentObservationFacade`,
  `apps/api/src/services/kma-location-scheduled-current-observation.ts`)를 추가했습니다 — hourly의 PR
  #13 location scheduled facade와 같은 원칙(explicit `{ latitude, longitude }` 입력, fresh converter
  input, 지원 위치의 fresh `{ nx, ny }` 입력, options/AbortSignal exact reference, exact Promise
  pass-through, converter `null`만 value-free LOCATION/UNSUPPORTED_LOCATION result로 변환, converter
  throw는 동일 reference로 동기 전파)을 따르는 별도·병렬 구현입니다. 이 PR은 production converter를
  선택하지 않고 PR #69 grid-based production composition에도 연결하지 않으므로, production current
  데이터는 이 PR 이후에도 여전히 missing입니다. 자세한 내용은
  [kma-location-scheduled-current-observation.md](./kma-location-scheduled-current-observation.md) 참고.
- AirKorea air quality (측정소별 실시간 측정정보 조회 provider boundary는 **PR #82**에서, TM 좌표
  기반 근접측정소 목록 조회 provider boundary는 **PR #83**에서 구현됨 — 아래 각 PR 항목 참고. WGS84
  위경도 → TM 좌표 변환, 행정구역 → TM 좌표 변환, 최종 closest-station 선택, station resolver,
  application service/composition, `POST /weather` 연결, AirKorea 예보는 여전히 미구현이므로
  `AIR_QUALITY_CURRENT`는 production 응답에서 계속 missing입니다.)
- alerts
- response cache
- mobile API client의 화면 연결 (contract-safe `POST /weather` client boundary
  `apps/mobile/src/weather-api`는 구현됨 — 요청·응답 계약 소비와 typed 오류 경계까지. 이어서
  **PR #54**에서 선택된 저장 지역을 이 client에 연결하는 provider-neutral **weather-query 경계**
  (`apps/mobile/src/weather-query`)를 구현했습니다 — generation 기반 abort/stale-completion guard를
  가진 observable store(`createMobileWeatherQueryStore`, `IDLE`/`LOADING`/`SUCCESS`/`ERROR`, 단일
  active request, explicit `retry()`/`reset()`), `EXPO_PUBLIC_API_BASE_URL`(빈
  `apps/mobile/.env.example` placeholder)만 읽는 production composition, 그리고 화면이 이미 읽은
  saved-location snapshot을 인자로 받아 재구독 없이 request 시점을 결정하는 React hook
  (`useMobileWeatherQuery`). 홈 화면(`apps/mobile/src/app/index.tsx`)이 이를 소비해 선택된 저장
  지역이 `READY`일 때 loading/최소 hourly 요약(첫 시간대, 조건 한국어 라벨, 강수확률)/네 가지 고정
  오류 문구·재시도 버튼을 표시합니다. 실제 endpoint 호출과 실기기 QA는 미수행입니다. 자세한 내용은
  [mobile-weather-query.md](./mobile-weather-query.md) 참고)
- location permission/storage model (기기 저장 지역 로컬 경계 `apps/mobile/src/locations`는 구현됨 —
  지역 한 건의 공유 `weatherLocation` 확장 strict schema(로컬 전용 `kmaGrid`/`isCurrent`/`sortOrder`)와
  explicit `WeatherRequestV1` 변환 경계, 여러 지역을 canonical collection으로 다루는 순수 경계
  (collection schema 불변조건(ID 유일성, 현재 위치 0~1개, `sortOrder === array index`, 빈 배열 허용)과
  추가·삭제·재정렬·현재 위치 설정/해제 순수 operation; collection 우선 검증, throw 없는 고정 비노출
  오류, 입력 불변, fresh canonical output), 그리고 그 collection을 위한 provider-neutral persistence
  경계까지: 안정적인 storage key와 분리된 versioned **V1 envelope**·collection encode/decode codec,
  최소 key-value port(`getItem`/`setItem`/`removeItem`)를 주입받는 load/save/clear(missing key는
  성공한 빈 collection, 손상 데이터·미지원 정수 버전은 fail-closed, invalid collection은 write 차단,
  sync throw·async rejection을 고정 비노출 storage 오류로 분류, fresh output). 이 persistence 경계는
  이제 실제 AsyncStorage(`@react-native-async-storage/async-storage` 2.2.0)에 연결하는 concrete
  production binding까지 구현됐습니다 — 실제 AsyncStorage dependency: 구현됨, concrete binding
  (`mobile-saved-location-async-storage.ts`, `getItem`/`setItem`/`removeItem` 3-메서드 위임, pure
  barrel 미export): 구현됨. 이 persistence를 주입받아 hydration 진행 상태를
  `NOT_STARTED`/`LOADING`/`EMPTY`/`READY`/`ERROR`로 노출하는 provider-neutral hydration manager
  (`mobile-saved-location-hydration-manager.ts`, pure barrel export, 단일 in-flight 호출·성공 후
  idempotent·실패 후 retry·고정 비노출 오류)도 구현됐습니다. 그 위에 이 manager를 감싸는
  provider-neutral **observable hydration store**(`mobile-saved-location-hydration-store.ts`,
  `createSavedLocationHydrationStore`, pure barrel export)도 구현됐습니다 — stable하고 deep-frozen된
  cached snapshot(`getSnapshot()`), 등록 즉시 호출되지 않고 semantic transition에만 알리는 idempotent
  subscribe/unsubscribe, manager의 exact hydrate Promise를 그대로 반환하며 concurrency·reentrancy에도
  manager 호출·observer·알림을 중복시키지 않는 `hydrate()`를 제공합니다(React
  `useSyncExternalStore` hook이 소비할 수 있는 기반). 이 AsyncStorage binding과 hydration
  manager, 그리고 이 store의 production composition(`mobile-saved-location-hydration-production.ts`,
  `mobileSavedLocationHydrationManager`·`mobileSavedLocationHydrationStore`, pure barrel 미export,
  import 시 storage I/O·`hydrate()` 호출 없음)도 구현됐습니다. 이 composition의 **store**의
  `hydrate()`를 앱 시작 시 한 번만 호출하는 one-shot startup boundary
  (`mobile-saved-location-hydration-startup.ts`, `startMobileSavedLocationHydrationOnce`)와 root
  layout mount effect wiring(`apps/mobile/src/app/_layout.tsx`, 변경 없음)도 구현됐습니다 — 반복·동시
  effect 실행에도 실제 store `hydrate()`(→ manager `hydrate()`)와 그에 따른 storage read는 정확히
  한 번만 일어나고, 첫 결과가 `ERROR`여도 자동 재시도하지 않으며(향후 명시적 retry는 이 store의
  `hydrate()`를 경유), `<Stack />` 렌더링과 navigation은 차단하지 않습니다. 반면 이 store를 구독하는 React
  `useSyncExternalStore` hook(`use-mobile-saved-location-hydration.ts`,
  `useMobileSavedLocationHydration`)도 구현됐습니다 — store의 exact cached snapshot 참조를 그대로
  반환하고, 안정적인 module-scope subscribe/getSnapshot callback을 client/server 동일하게 쓰며,
  hook의 import·호출만으로는 `hydrate()`나 storage I/O가 없고 pure barrel에서는 export되지
  않습니다. 이 hook을 직접 소비하는 첫 홈 화면(`apps/mobile/src/app/index.tsx`)도 구현됐습니다 —
  다섯 hydration 상태를 각각 구분되는 최소 읽기 전용 텍스트로 표시하며, hydration 시작·retry나
  storage API 호출은 하지 않고 hook의 exact snapshot만 분기합니다. 그 위에 write 측을 소유하는
  provider-neutral **application store**(`mobile-saved-location-application-store.ts`,
  `createSavedLocationApplicationStore({ hydrationStore, persistence })`, pure barrel export)도
  구현됐습니다 — hydration 상태를 관찰해 write 차원(`IDLE`/`SAVING`)을 더한 stable·deep-frozen
  cached snapshot을 공개하고, hydration 성공 이후에는 자신이 소유한 committed collection에서
  `EMPTY`/`READY`를 파생하며, `add`(`EMPTY`/`READY`)·`remove`(`READY`)가 순수 collection operation을
  먼저 호출해 실패 시 persistence를 전혀 건드리지 않고, 성공 시 `persistence.save()`를 정확히 한 번
  호출한 뒤 **저장 성공 후에만** 새 collection을 공개합니다(optimistic update 없음 → 실패 시 이전
  collection 유지). 마지막 지역 삭제도 `clear()`가 아니라 `save([])`를 사용하고, `SAVING` 중의
  동시·재진입 mutation은 두 번째 write 없이 `WRITE_IN_PROGRESS`를 반환하며, `retryHydration()`은
  hydration store의 `hydrate()`에 위임해 exact Promise reference를 반환합니다(timer·backoff·자동
  retry 없음). 이 store의 production composition
  (`mobile-saved-location-application-production.ts`, `mobileSavedLocationApplicationStore`, 기존
  hydration store·AsyncStorage persistence를 한 번씩 주입, pure barrel 미export)과 React hook
  (`use-mobile-saved-locations.ts`, `useMobileSavedLocations`, pure barrel 미export)도 구현됐고,
  홈 화면(`apps/mobile/src/app/index.tsx`)이 이를 소비해 `ERROR`의 explicit `다시 시도` 버튼,
  `READY`의 저장 지역 목록과 지역별 `삭제` 버튼(`SAVING` 중 비활성화), 저장 실패 시 generic Korean
  문구를 표시합니다(raw 오류 kind·storage key·위치 ID·좌표 미노출). 기존 hydration manager/store,
  one-shot startup, collection/persistence schema와 `isCurrent` 의미는 이 작업에서 바뀌지
  않았습니다. 이어서 **PR #51**에서 공식 KMA 행정구역·예보격자 자료(공공데이터포털 dataset
  `15084084`, `기상청41_단기예보 조회서비스_오픈API활용가이드_2607.zip`, 공공저작물 출처표시
  제1유형)를 정적 모바일 카탈로그(`apps/mobile/src/locations/catalog`, 3836 entry)로 정규화하고,
  provider-neutral 검색(`searchKmaKoreanLocations`)과 candidate 매핑
  (`createSavedLocationCandidateFromKmaCatalogEntry`), 지역 검색 화면(`apps/mobile/src/app/locations.tsx`),
  홈 화면 `지역 추가` 진입점을 구현했습니다 — 검색 결과를 선택하면 기존
  `mobileSavedLocationApplicationStore.add()`를 통해 저장되고 홈 화면 `READY` 목록에 반영되며,
  중복 추가와 저장 실패는 고정 Korean 문구로만 표시됩니다(raw 오류 kind·행정구역 코드·좌표·격자
  미노출). id는 생성 단계에서만 계산하는 결정론적 opaque id(`kr_` + SHA-256 앞 24자)이고, 런타임은
  이미 계산된 id를 읽기만 합니다. 자세한 내용은
  [kma-korean-location-catalog.md](./kma-korean-location-catalog.md) 참고. 이어서 **PR #52**에서
  사용자가 현재 조회 중인 저장 지역을 나타내는 `selectedLocationId`를 별도로 저장·복원하는 **선택
  지역 상태**를 구현했습니다 — `isCurrent`(기기의 실제 GPS 현재 위치 record 여부)와는 절대 결합하지
  않는 별도 개념으로, 분리된 storage key(`@life-weather/mobile/selected-location`)와 독립된
  versioned V1 envelope(`{ version: 1, selectedLocationId }`, id schema는 기존 saved-location id
  schema를 재사용), provider-neutral codec·load/save 경계(`mobile-selected-location-persistence.ts`),
  그 위의 concrete AsyncStorage binding(`mobile-selected-location-async-storage.ts`,
  `getItem`/`setItem` 두 메서드만 위임, pure barrel 미export)으로 구성됩니다. 이 선택 상태의 조정은
  새 module이 아니라 기존 application store(`mobile-saved-location-application-store.ts`)에 추가돼
  `EMPTY`/`READY` snapshot에 항상 검증된 `selectedLocationId`(EMPTY는 항상 `null`, READY는 항상
  collection에 실존하는 non-empty id)를 더하고, saved hydration은 끝났지만 선택 preference가 아직
  로딩 중인 새 `SELECTION_LOADING` 상태와 `ERROR`에 scope(`SAVED_LOCATIONS`/`SELECTED_LOCATION`)를
  추가합니다. 저장된 preference가 없거나 stale하면 첫(`sortOrder === 0`) 저장 지역으로 자동
  fallback하되 그 fallback을 자동으로 다시 쓰지는 않고, 첫 지역 추가는 자동으로 선택되며(selected
  persistence write 후 collection write, 이 순서), 선택된 지역을 삭제하면 삭제 전 index 기준의
  fallback(같은 index → 마지막 → null)이 같은 순서로 저장됩니다. `select()`/`add()`/`remove()`는
  하나의 `writeStatus` write lock을 공유합니다. 앱 시작은 기존 저장 지역 hydration one-shot
  startup(`mobile-saved-location-hydration-startup.ts`, 계약 무변경)을 감싸는 새 app-level
  orchestrator(`mobile-location-application-startup.ts`,
  `startMobileLocationApplicationOnce`)가 저장 지역 hydration 성공 후에만 선택 초기화를 시작하도록
  순서를 정하고, 홈 화면은 통합 `retryInitialization()`으로 두 실패 scope 모두를 재시도합니다.
  홈 화면(`apps/mobile/src/app/index.tsx`)은 각 저장 지역 행에 `선택됨`(비활성)/`선택` 컨트롤을
  추가했습니다. 자세한 내용은 [mobile-selected-location.md](./mobile-selected-location.md) 참고.
  반면 선택 지역 삭제 fallback과 첫 지역 자동 선택은 이제 구현됐지만, reorder UI: 미구현, React
  Context/Provider: 미구현, migration execution: 미구현, 위치 권한: 미구현이고, development client
  rebuild 및 실제 기기 QA: 미수행입니다. 선택 지역을 실제 weather API client에 연결하는 작업은 위
  weather-query 경계 항목(PR #54)에서 다룹니다)
- 디자인 시스템과 주요 화면
- Android widget
- AdMob
- push
- database
- 실제 운영 domain, EAS와 Play release 관련 작업

## 상태 해석과 다음 결정

- PR #31의 Vercel Preview와 smoke 검증 이력은 과거 검증 근거이지만, 현재 public production
  release 완료를 의미하지 않습니다.
- 실제 key, domain 또는 project ID는 이 문서에 기록하지 않습니다.
- AI workflow harness는 제품 기능 stage가 아니라 repository 운영 기반입니다.
- Owner가 릴리스 범위를 Fast-track **1.0**과 **1.1 이후**로 확정했습니다 — 1.0은 수동 지역 검색,
  여러 저장 지역, KMA 현재/시간별/단기, AirKorea PM10/PM2.5 최소 지원, 오늘/시간별/생활날씨/설정
  최소 화면, 기존 생활정책 4개, loading/error/empty/stale, 오늘 화면 하단 adaptive banner 1개,
  개인정보·동의·Data safety, Development Build와 실제 Android QA, 필수 보안·contract·schema 검증
  유지이고, Android widget 전체·GPS 권한 흐름·추가 생활정책·push·추가 광고 형식·중기/자외선 상세·
  정교한 일러스트/animation·지역 재정렬 등 확장 UX는 1.1 이후입니다. 위젯은 제품 방향에서 삭제된
  것이 아니라 1.1로 이동했고, 필수 보안·개인정보·실기기 검증은 축소하지 않습니다. 자세한 내용은
  [product-scope.md](./product-scope.md) 참고.
- PR #51의 KMA 대한민국 지역 검색 카탈로그는 공공저작물 출처표시 제1유형을 따릅니다 — 이 출처
  표시는 향후 앱 설정의 "데이터 출처" 화면에도 노출되어야 하며, 그 설정 화면 자체는 아직
  구현되지 않았습니다.
- PR #52는 선택 지역 상태(`selectedLocationId`)의 저장·복원·fallback만 구현했습니다. 이어서 **PR
  #54**가 선택 지역을 실제 weather API client에 연결하는 provider-neutral weather-query 경계와
  Today 화면의 최소 loading/success/error 렌더링을 구현했습니다. 다음은 여전히 구현되지 않았습니다:
  실제 `EXPO_PUBLIC_API_BASE_URL` production 값 설정, 실제 endpoint 검증, 완성형 Today 디자인, 실제
  Android QA.
- **PR #55**는 `apps/mobile/src/app` 아래 co-located된 route 테스트 3개(`index.test.tsx`,
  `_layout.test.tsx`, `locations.test.tsx`)가 Expo Router app root의 production route graph에
  포함되어 Android JS export를 실패시키던 문제를 해결했습니다 — 테스트를 `src/app-tests`로 이동하고
  route import만 상대 경로로 조정했으며, production route/runtime 코드는 변경하지 않았습니다. Node
  22에서 빈 `EXPO_PUBLIC_API_BASE_URL`로 Android JS export가 성공하며, GitHub CI에 `pnpm check` 이후
  별도 `Verify Android JS export` step이 추가되어 이후 같은 회귀를 검출합니다. 실제 endpoint 호출,
  Development Build와 실기기 QA는 여전히 미수행입니다.
- **PR #57**은 Expo Router 기반의 5개 하단 탭 navigation shell(`오늘`/`시간별`/`생활날씨`/`상세기상`/
  `설정`)을 구현했습니다 — `apps/mobile/src/app/index.tsx`를 `apps/mobile/src/app/(tabs)/index.tsx`로
  이동해 새 `(tabs)` route group에 두었고, root Stack은 `(tabs)` 화면의 header만 숨겨 Tabs 자체
  header를 사용하게 했습니다. Today(`/`)의 기존 저장 지역·weather-query 동작과 화면 로직은 상대
  import 경로 조정 외에 변경되지 않았고, `/locations`는 여전히 tabs 밖 root Stack route로 남아
  기존 back navigation을 유지합니다. 나머지 네 화면(시간별/생활날씨/상세기상/설정)은 각각 고유
  한국어 제목과 "준비하고 있습니다" 문구만 표시하는 정직한 placeholder이며, API 호출·storage
  접근·startup 구독 등 실제 기능은 전혀 구현되지 않았습니다. 실제 API 호출, Development Build,
  native build와 실기기 QA는 이번 PR에서도 미수행입니다. AirKorea 연동, 생활날씨 카드 표시, 설정
  저장, 상세기상 데이터 구현은 모두 후속 PR 범위입니다.
- **PR #58**은 weather-query request/reset lifecycle의 React owner를 `(tabs)` layout 한 곳으로
  옮겼습니다 — PR #57 이후 여러 tab screen이 각자 `useMobileWeatherQuery`를 호출하면 동일 singleton
  query store에 lifecycle owner가 여러 개 생겨, 한 화면의 unmount cleanup이 다른 화면이 읽는 query를
  중단시킬 수 있는 문제를 해결합니다. 새 `useMobileWeatherQueryLifecycle(savedLocations)`
  (`apps/mobile/src/weather-query/use-mobile-weather-query-lifecycle.ts`)이 기존
  `useMobileWeatherQuery`가 갖고 있던 request/reset effect 책임 전부를 그대로 가져가고,
  `apps/mobile/src/app/(tabs)/_layout.tsx`가 `useMobileSavedLocations()`로 읽은 exact snapshot을 이
  hook에 넘겨 정확히 한 번 호출하는 production 상의 유일한 위치입니다. 기존
  `useMobileWeatherQuery(savedLocations)`는 이제 순수 read-only 구독/correlation hook으로 축소되어
  `useEffect`도, `request`/`reset`/`retry` 호출도 갖지 않으므로 여러 tab consumer가 독립적으로 읽어도
  lifecycle이 중복되지 않습니다. Today(`apps/mobile/src/app/(tabs)/index.tsx`)의 표시·동작과 사용자
  재시도(`mobileWeatherQueryStore.retry()`)는 변경되지 않았고, Hourly tab은 이번 PR에서도 여전히
  placeholder입니다. Store 상태 기계, API contract, saved-location lifecycle은 이 PR에서 변경되지
  않았습니다. 새 React Context/Provider는 추가되지 않았습니다. 실제 API 호출, Development Build와
  실기기 QA는 이번 PR에서도 미수행입니다.
- **PR #59**는 Hourly tab의 placeholder를 최소 실제 시간별 예보 화면으로 교체했습니다 —
  `apps/mobile/src/app/(tabs)/hourly.tsx`가 기존 `useMobileSavedLocations()`와 read-only
  `useMobileWeatherQuery(savedLocations)` 두 입력만 사용해 이미 검증된 query snapshot의
  `data.data.hourly` 전체를 응답 순서 그대로 표시합니다(임의 slice/sort/dedupe/grouping 없음).
  각 항목은 선택된 저장 지역의 `timezone`(device timezone 아님) 기준으로 포맷한 예보 시각과
  한국어 `WeatherCondition` 라벨(exhaustive `Record`, Today의 기존 로컬 매핑과 별개로 파일 안에
  동일 매핑을 둠), 필수 기온을 항상 표시하고, `null`이 아닌 optional 필드(체감/강수확률/강수량/
  적설/습도/풍속/풍향)만 표시하며 `0` 값은 항상 표시합니다. `hourly`가 비어 있으면 오류가 아니라
  "표시할 시간별 예보가 없습니다."를 표시합니다. NOT_STARTED/LOADING/SELECTION_LOADING, EMPTY(지역
  추가 진입점 포함), saved-location ERROR(`retryInitialization()`), READY 상태에서의 weather
  IDLE/LOADING/ERROR(Today와 동일한 네 가지 고정 문구, `mobileWeatherQueryStore.retry()`)와
  SUCCESS를 모두 구분해 표시하며, raw 오류 kind·URL·좌표·grid·provider 이름은 어디에도 노출하지
  않습니다. Hourly는 이 PR에서도 request/reset lifecycle을 소유하지 않습니다 — 계속
  `(tabs)/_layout.tsx` 한 곳이 소유하며, Hourly는 lifecycle hook을 import·호출하지 않습니다.
  Today, weather-query store/production, saved-location, API/contracts는 이 PR에서 변경되지
  않았습니다. AirKorea, current/daily/alerts, response cache는 여전히 이번 PR 범위가 아니고, 실제
  endpoint 호출과 Development Build, 실기기 QA도 미수행입니다.
- **PR #60**은 Lifestyle tab(`생활날씨`)의 placeholder를 최소 실제 생활날씨 화면으로 교체했습니다
  — `apps/mobile`에 기존 `packages/lifestyle-engine`을 `@life-weather/lifestyle-engine:
  workspace:*` 정식 dependency로 추가하고(외부 dependency 추가 없음), 새 pure mobile presentation
  boundary(`apps/mobile/src/lifestyle/create-mobile-lifestyle-overview.ts`,
  `createMobileLifestyleOverview`)가 이미 검증된 weather-query `SUCCESS` 응답을 기존 네 정책
  (`assessUmbrellaNeed`/`assessOutfitRecommendation`/`assessMaskNeed`/
  `assessLaundryDryingSuitability`)에 연결합니다. 네 정책 모두 `evaluatedAt`으로
  `response.meta.generatedAt`을 그대로 쓰고(기기 시각이나 `Date.now()` 없음), 우산·옷차림·빨래는
  `response.data.hourly`를, 마스크는 `response.data.airQuality.current`를(그대로, `null`이면
  `null`) 입력으로 사용합니다. `reason`/`recommendation`은 engine 출력을 그대로 쓰고, status
  라벨만 이 경계 안의 exhaustive `Record`로 매핑하며, `reasonCode`/`policyVersion`/evidence/
  provider-native 값은 카드에 없습니다. `apps/mobile/src/app/(tabs)/lifestyle.tsx`가 기존
  `useMobileSavedLocations()`/`useMobileWeatherQuery(savedLocations)` 두 read-only 입력만 사용해
  우산·옷차림·마스크·빨래 네 카드를 고정 순서로 표시하며, weather-query request/reset
  lifecycle은 이 PR에서도 여전히 `(tabs)/_layout.tsx` 한 곳이 소유합니다. `hourly`가 비어 있거나
  `airQuality.current`가 `null`이면 관련 카드가 engine의 `INSUFFICIENT_DATA`(판단 보류)를 그대로
  표시하며 화면이 별도로 숨기지 않습니다 — 현재 AirKorea가 미구현이므로 production KMA 응답에서는
  마스크 카드가 항상 판단 보류로 표시될 수 있습니다. `packages/lifestyle-engine`, contracts,
  weather-core, API, weather-query, saved-location 경계는 이 PR에서 변경되지 않았습니다. 자세한
  내용은 [mobile-lifestyle-overview.md](./mobile-lifestyle-overview.md) 참고. 실제 API 호출,
  Development Build와 실기기 QA는 이번 PR에서도 미수행입니다.
- **PR #61**은 Settings tab(`설정`)의 placeholder를 최소 실제 설정·정보 화면으로 교체했습니다 —
  `apps/mobile/src/app/(tabs)/settings.tsx`가 지역/단위/데이터 출처/앱 정보 네 section만 고정
  순서로 표시합니다. 지역 section은 `router.push('/locations')`로 이동하는 `지역 추가` 진입점만
  두고, `/locations`가 검색·추가 화면일 뿐 전체 지역 관리 화면이 아니라는 점을 과장하지 않으며,
  지역 선택·삭제는 여전히 Today 화면에서 이뤄집니다. 단위 section은 기온/강수량/적설/풍속 네 고정
  값을 보여주는 read-only 안내이며 선택 control은 없습니다. 데이터 출처 section은 날씨 정보(기상청),
  지역 검색 자료 명칭과 공공저작물 출처표시 제1유형 이용조건([kma-korean-location-catalog.md](./kma-korean-location-catalog.md)
  근거)을 표시하고, AirKorea는 아직 미구현이므로 "연동 예정"으로만 표시합니다(현재 제공 중인
  것으로 오인시키는 단독 표현 없음). 앱 정보 section은 기존 `expo-constants`의
  `Constants.expoConfig?.name`/`version`을 읽고(이름 누락 시 `Life Weather`, 버전 누락·빈 문자열
  시 `확인 불가`), 버전을 소스에 하드코딩하지 않습니다. 개인정보 처리방침, 광고·동의 설정, 지원
  연락처, 운영 ID, 오픈소스 라이선스 전체 목록은 이번 PR에서 다루지 않으며 별도 출시 준비 작업으로
  남습니다. 설정 persistence나 toggle은 없고, `apps/api`/`packages`/`app.json`/`package.json`/
  lockfile은 이 PR에서 변경되지 않았습니다. 자세한 내용은 [mobile-settings.md](./mobile-settings.md)
  참고. 실제 API 호출, Development Build와 실기기 QA는 이번 PR에서도 미수행입니다.
- **PR #62**는 Details tab(`상세기상`)의 마지막 placeholder를 최소 실제 상세기상 화면으로
  교체했습니다 — SUCCESS content는 항상 기상특보를 먼저, 현재 관측을 다음으로 표시합니다. 새 pure
  mobile presentation boundary(`apps/mobile/src/details/create-mobile-weather-details.ts`,
  `createMobileWeatherDetails`)가 이미 검증된 weather-query `SUCCESS` 응답의
  `response.data.current`/`response.data.alerts`/`response.data.missingSections`만 읽습니다.
  `missingSections`에 `ALERTS`가 있으면 UNAVAILABLE("기상특보 정보를 제공하지 못했습니다."),
  `ALERTS`가 없고 `alerts`가 빈 배열이면 NONE("현재 발표된 기상특보가 없습니다."), 하나 이상이면
  AVAILABLE로 응답 순서 그대로 모든 alert를 카드로 변환합니다(sort/filter/dedupe 없음). `current`가
  `null`이면 UNAVAILABLE("현재 관측 정보를 제공하지 못했습니다.")이고, 존재하면 관측
  시각·상태·기온을 항상 표시하며 optional 필드(체감온도/습도/풍속/풍향/최근 1시간 강수량/가시거리)는
  `null`이 아닐 때만 표시합니다(`0`은 항상 표시). `WeatherAlertSeverity`/`WeatherAlertType`/
  `WeatherCondition` 모두 이 경계 안의 독립적인 exhaustive 한국어 `Record`로만 매핑되고, alert
  `title`/non-null `description`은 그대로 보존되며, alert id/sourceId/provider/requestId/raw
  missingSections는 카드에 없습니다. `current.observedAt`/`alert.issuedAt`/non-null
  `alert.effectiveAt`/`alert.expiresAt`은 선택된 저장 지역의 `timezone`(기기 timezone 아님)으로
  포맷하며, formatter 실패 시 raw ISO 문자열로 대체해 화면을 crash시키지 않습니다.
  `apps/mobile/src/app/(tabs)/details.tsx`가 기존 `useMobileSavedLocations()`/
  `useMobileWeatherQuery(savedLocations)` 두 read-only 입력만 사용해 `createMobileWeatherDetails`를
  정확히 한 번 호출하고, weather-query request/reset lifecycle은 이 PR에서도 여전히
  `(tabs)/_layout.tsx` 한 곳이 소유합니다. `apps/mobile/src/app-tests/placeholder-screens.test.tsx`
  (마지막 placeholder test였던 details 케이스)를 삭제했습니다. `packages/contracts`,
  `packages/weather-core`, `apps/api`, weather-query, saved-location 경계는 이 PR에서 변경되지
  않았습니다. 자세한 내용은 [mobile-weather-details.md](./mobile-weather-details.md) 참고. 현재
  production KMA pipeline은 여전히 hourly-only이므로 `current`와 `alerts`는 실제 응답에서 계속
  missing으로 표시될 수 있습니다 — 실제 current/alert backend는 아직 미구현이며, 실제 API 호출과
  Development Build, 실기기 QA는 이번 PR에서도 미수행입니다.
- **PR #63**은 KMA 초단기실황(`getUltraSrtNcst`) provider boundary를 추가했습니다 — 기존
  단기·초단기예보 raw schema/parser/grouping/provider(PR #4/#5/#6)는 변경하지 않고, 별도
  request/response shape(`obsrValue`, 예보 대상 시각 없음)을 위한 병렬 모듈을 추가했습니다.
  provider는 기존 forecast provider의 timeout/abort/HTTP-status/response-size transport
  정책을 공유 helper로 재사용하며, `fetchForecast()`의 기존 계약과 테스트는 회귀 없이
  그대로 유지됩니다. current를 `POST /weather`에 연결하는 application service/composition/
  route는 이 PR 범위가 아닙니다. 이어서 Codex HIGH 독립 검토의 P2 findings 3건을 focused
  remediation으로 보정했습니다 — (1) current `baseTime`이 request/raw schema/normalization
  세 경계 모두에서 정시 `HH00`만 허용하도록 강제(`isKmaCurrentObservationBaseTime`), (2)
  current `nx`/`ny`가 request/raw schema 모두에서 공식 `[1,149]×[1,253]` 격자 범위로 제한
  (`KMA_CURRENT_OBSERVATION_GRID_*`, `validation.ts`의 provider-local single source), (3)
  공유 transport(`performKmaGetRequest`)가 `fetchImpl`/body reader가 abort signal을 완전히
  무시해도 timeout/caller-abort로 provider promise 자체를 확정 종료하도록 `raceAgainstAbort`
  helper로 보강(늦게 도착하는 settlement는 결과를 바꾸지 않고 raw error·unhandled rejection도
  없음). forecast의 공개 계약과 기존 회귀는 변경되지 않았습니다. 자세한 내용은
  [kma-current-observation-provider.md](./kma-current-observation-provider.md) 참고.
- **PR #64**는 KMA 초단기실황(`getUltraSrtNcst`)의 공식 발표시각(매시간 정시, `HH00`)을 caller가
  제공한 절대 epoch millisecond에서 선택하는 순수 weather-core selector
  (`selectLatestKmaCurrentObservationBaseTime`, `packages/weather-core/src/kma/current-observation-issue-time.ts`)를
  추가했습니다 — 기존 forecast selector(`selectLatestKmaForecastBaseTime`,
  [kma-issue-time.md](./kma-issue-time.md))와 별도·병렬 구현이며, `product` 선택이 없고(초단기실황은
  단일 operation), 발표 스케줄이 자정(`0000`)부터 시작하므로 forecast selector에 있는
  previous-day rollover 분기가 필요 없습니다. KST 고정 `UTC+09:00`, 지원 연도 `[1000, 9999]`,
  value-free `RangeError`, fresh output, 입력 불변은 forecast selector와 동일한 원칙을 따릅니다.
  API availability delay, safety margin, system-clock adapter, request factory, provider 호출,
  위치→격자 변환, application service/composition/route, `POST /weather` 연결, contracts 변경,
  mobile/native/deploy, 실제 KMA API 호출은 이 PR 범위가 아닙니다. 자세한 내용은
  [kma-current-observation-issue-time.md](./kma-current-observation-issue-time.md) 참고.
- **PR #66**은 PR #64 selector를 소비하는 KMA current-observation (초단기실황) **request factory**
  (`createKmaCurrentObservationRequestFactory`, `apps/api/src/services/kma-current-observation-request.ts`)를
  추가했습니다 — PR #9 forecast request factory와 같은 원칙(injected clock, 호출당 clock 정확히
  1회, fresh output, selector/clock 오류 그대로 전파)을 따르는 별도·병렬 구현입니다. 초단기실황은
  `product` 선택이 없으므로 이 factory의 `KmaCurrentObservationRequestFactoryInput`은 `product`
  필드를 갖지 않습니다. Focused remediation(2026-08)에서 factory는 forecast factory(PR #15)와
  동일한 모양의 **주입 가능한 base-time-selector seam**(`baseTimeSelector`, 두 번째 인자)을
  갖도록 시정했습니다 — 생략 시 `selectLatestKmaCurrentObservationBaseTime`으로 default되고,
  대응하는 availability-delay selector가 아직 없으므로 현재 어떤 production composition도
  non-default selector를 주입하지 않습니다. factory 자체는 availability 정책을 고정하지
  않습니다. forecast request factory(`kma-forecast-request.ts`)와 그 production wiring은
  변경하지 않았습니다. Provider 자동 호출, 위치→격자 변환, application
  service/composition/route, `POST /weather` 연결, availability-delay selector 구현 자체는 이
  PR 범위가 아닙니다. 자세한 내용은
  [kma-current-observation-request-factory.md](./kma-current-observation-request-factory.md) 참고.
- **PR #67**은 PR #63 KMA 초단기실황 provider와 PR #63 normalizer를 잇는 **application
  service**(`createKmaCurrentObservationService`,
  `apps/api/src/services/kma-current-observation.ts`)를 추가했습니다 — PR #7 hourly application
  service와 같은 원칙(injected provider, side-effect-free 생성, 호출당 provider 정확히 1회,
  provider 성공에만 normalizer 호출, `PROVIDER`/`NORMALIZATION` stage 구분, 광범위한 `try/catch`
  없음)을 따르는 별도·병렬 구현입니다. 성공 결과는 `hourly` 배열이 아니라 단일
  `current: CurrentWeather`를 담고, provider의 방어적 `slot: null` 성공은 재분류 없이 그대로
  normalizer에 전달되어(모든 category `ABSENT`) 필수 `T1H` 부재로 인한 `NORMALIZATION` 실패로
  자연스럽게 이어집니다. 이 service는 PR #66 request factory를 호출하지 않고 여전히 완성된
  `KmaCurrentObservationRequest`를 입력받으며, 위경도→grid 변환, composition, `POST /weather`
  연결은 이 PR 범위가 아닙니다. hourly service와 forecast request factory는 변경하지 않았습니다.
  자세한 내용은 [kma-current-observation-service.md](./kma-current-observation-service.md) 참고.
- **PR #68**은 PR #66 request factory와 PR #67 current-observation service를 연결하는 **scheduled
  current-observation facade**(`createKmaScheduledCurrentObservationFacade`,
  `apps/api/src/services/kma-scheduled-current-observation.ts`)를 추가했습니다 — PR #10 scheduled
  hourly facade와 같은 원칙을 따르는 별도·병렬 구현입니다. `input`(`nx`/`ny`)을 request factory에,
  factory가 반환한 request를 그대로 current-observation service에 넘기고, service가 반환한 Promise를
  `async`/`await`/`.then` 없이 그대로 반환합니다(성공·`PROVIDER`·`NORMALIZATION` 결과와 rejection의
  exact reference 보존). Factory가 throw하면 service는 호출되지 않고 같은 error reference가 그대로
  전파됩니다. Request factory·current-observation service·hourly facade는 이 PR에서 변경되지
  않았고, 새 generic scheduled facade abstraction도 추가되지 않았습니다. 이 facade는 여전히
  production composition, location→grid adapter, `POST /weather` route에 연결되지 않았으므로,
  production current 데이터는 이 PR 이후에도 여전히 missing입니다. 자세한 내용은
  [kma-scheduled-current-observation-facade.md](./kma-scheduled-current-observation-facade.md) 참고.
- **PR #69**는 PR #68 facade를 실제 server 환경에서 조립하는 **여섯 번째 callable production
  composition root**(`createKmaScheduledCurrentObservationCompositionFromEnv`,
  `apps/api/src/composition/kma-scheduled-current-observation.ts`)를 추가했습니다 — PR #63
  provider-from-env, PR #67 service, (injected 또는 기존 hourly composition과 동일한
  `createKmaSystemClock()` 재사용) system clock, PR #64 schedule-only selector(explicit 주입), PR
  #66 request factory, PR #68 facade를 정해진 순서로 조립합니다. Provider 환경설정 실패는 기존
  `KmaProviderConfigError`를 동일 reference로 반환하고, construction 시 clock read·selector 실행·
  network fetch는 0회이며, 성공 결과는 `{ ok, facade }`만 노출합니다. 이 selector는 여전히
  schedule-only이므로 upstream 자료가 실제로 준비됐음을 보장하지 않고, current 전용
  availability-delay selector는 이 PR에서도 구현되지 않았습니다. location(위경도 → grid)
  adapter·`WeatherOverview.current`·current `SourceMetadata`·`POST /weather` route 연결은 여전히
  이 PR 범위가 아니므로, production current 데이터는 이 PR 이후에도 여전히 missing입니다. 자세한
  내용은
  [kma-current-observation-production-composition.md](./kma-current-observation-production-composition.md)
  참고.
- **PR #70**은 기존 위·경도 → KMA grid 변환 함수(`convertKmaLatitudeLongitudeToGrid`)를 PR #68
  scheduled current-observation facade 앞단에 잇는 **application-level location
  facade**(`createKmaLocationScheduledCurrentObservationFacade`,
  `apps/api/src/services/kma-location-scheduled-current-observation.ts`)를 추가했습니다 — PR #13
  location scheduled hourly facade와 같은 원칙을 따르는 별도·병렬 구현입니다. 호출자가
  `latitude`/`longitude`만 제공하면, converter를 정확히 한 번 호출한 fresh `{ latitude, longitude }`
  결과로 지원 위치를 판정하고, 지원 위치이면 fresh `{ nx, ny }`와 caller의 `options`(그 안의
  `AbortSignal` 포함) 그대로를 PR #68 scheduled facade에 정확히 한 번 전달해 그 Promise를 그대로
  반환합니다(성공·`PROVIDER`·`NORMALIZATION`·동기 throw·rejection 모두 exact reference 보존).
  converter가 `null`이면 scheduled facade를 호출하지 않고 값이 없는(latitude/longitude/nx/ny 비노출)
  fresh `{ ok: false, stage: 'LOCATION', error: { kind: 'UNSUPPORTED_LOCATION' } }`를 반환하며,
  converter가 throw하면(`RangeError` 포함) 동일 reference가 동기적으로 전파됩니다. 이 PR은 production
  converter를 선택하지 않고 PR #69 grid-based production composition에도 연결하지 않으므로,
  `WeatherOverview.current`·current `SourceMetadata`·`POST /weather` 연결·availability-delay
  selector는 이 PR 이후에도 여전히 missing/미구현입니다. 자세한 내용은
  [kma-location-scheduled-current-observation.md](./kma-location-scheduled-current-observation.md)
  참고.
- **PR #71**은 PR #69 grid-based current-observation production composition과 PR #70 location
  application facade를 연결하는 **location production composition**
  (`createKmaLocationScheduledCurrentObservationCompositionFromEnv`,
  `apps/api/src/composition/kma-location-scheduled-current-observation.ts`)을 추가했습니다 —
  hourly의 PR #13 location composition과 같은 원칙을 따르는 별도·병렬 구현입니다. PR #69
  composition을 재구현하지 않고 `env`/`dependencies`를 exact reference로 그대로 전달해 호출하며,
  PR #69의 config 실패(`KmaProviderConfigError`)를 동일 reference로 pass-through하고(이 경우 location
  facade 생성·converter 실행·clock read·network가 0회), 성공하면 기존 production
  `convertKmaLatitudeLongitudeToGrid`(exact function reference)와 PR #69 결과의 exact scheduled
  facade reference를 PR #70 `createKmaLocationScheduledCurrentObservationFacade`에 그대로 전달해
  location facade를 조립합니다. 성공 결과는 `{ ok, facade }`만 노출하고, composition 호출 시점에도
  converter 실행·clock read·fetch는 0회입니다(모두 반환된 facade의
  `fetchScheduledCurrentWeatherForLocation()` 실행 시에만 발생). 매 호출은 독립된 그래프를
  만듭니다(module-level singleton/cache 없음). PR #69 composition과 PR #70 location facade의 공개
  계약은 이 PR에서 전혀 변경되지 않았습니다. 이 composition은 여전히 `apps/api/src/index.ts`·
  `POST /weather` route·`WeatherOverview.current`·current `SourceMetadata`·current-observation
  availability-delay selector에 연결/구현되지 않았으므로, production current 데이터는 이 PR
  이후에도 계속 missing입니다. 자세한 내용은
  [kma-location-scheduled-current-observation.md](./kma-location-scheduled-current-observation.md),
  [kma-current-observation-production-composition.md](./kma-current-observation-production-composition.md)
  참고.
- **PR #72**는 PR #63/#67 pipeline이 이미 반환하는 contracts `CurrentWeather`를 받아
  `WeatherOverview.current`만 채워진 **current-only partial `WeatherOverview`**를 만드는 pure
  synchronous assembler(`assembleKmaCurrentWeatherOverview`,
  `apps/api/src/services/kma-current-weather-overview.ts`)를 추가했습니다 — hourly의 PR #23
  assembler(`assembleKmaHourlyWeatherOverview`)와 같은 형태를 따르는 별도·병렬 구현입니다. 입력은
  `WeatherLocation`과 `CurrentWeather` 두 field뿐이며, caller가 전달한 `CurrentWeather`를 재계산
  없이 그대로 `current`에 쓰고, `missingSections`는 정확히 `HOURLY`/`DAILY`/`AIR_QUALITY_CURRENT`/
  `AIR_QUALITY_FORECAST`/`ALERTS` 5개(`CURRENT`는 항상 제외)이며, `sources`는 정확히 `[]`입니다 —
  contracts `weatherOverview` schema는 `current` 존재 시 `SourceMetadata` 존재를 강제하지 않으므로
  이 PR은 current provenance(`sourceId`/`issuedAt`/`observedAt`/`fetchedAt`/`retrievalMode`)를
  발명하지 않습니다. 최종 payload는 `weatherOverview.parse()`로 runtime validate되어 malformed
  location/current는 synchronous Zod error가 됩니다. pure/synchronous/no I/O(clock·env·fetch·
  console 없음), frozen input 지원, 매 호출 fresh output입니다. 이 assembler는 PR #67
  application service, PR #68/#70 scheduled/location facade, PR #69/#71 production composition
  어느 것도 호출하거나 연결하지 않는 독립 단위입니다 — location current pipeline과의 application
  orchestration, current `SourceMetadata` resolver, production composition integration,
  `POST /weather` current wiring, current-observation availability-delay selector, 실제 인증 KMA
  API 호출은 모두 여전히 미구현입니다. 자세한 내용은
  [kma-current-weather-overview.md](./kma-current-weather-overview.md) 참고. 따라서 PR #72 이후에도
  production `POST /weather`의 `current`는 계속 missing입니다.
- **PR #73**은 PR #72가 미룬 current `SourceMetadata` 정책을 확정하고, **live current source
  metadata resolver**(`createKmaLiveCurrentSourceMetadataResolver`,
  `apps/api/src/services/kma-current-source-metadata.ts`)를 신규 추가했으며, PR #72 assembler
  (`assembleKmaCurrentWeatherOverview`)를 **metadata-aware**로 확장했습니다 — hourly의 PR #26
  live resolver와 같은 원칙(injected clock, 유효 호출당 정확히 1회 read, invalid clock 값·throwing
  clock 모두 static/동일 reference synchronous 전파)을 따르는 별도·병렬 구현입니다. 이 resolver는
  PR #26과 달리 **입력을 받지 않습니다**(current observation에는 상관시킬 issuance identity나
  PRIMARY/PREVIOUS selection이 없음) — 매 유효 호출마다 고정 canonical `sourceId`
  (`kma-ultra-short-current-observation`, 기존 canonical id와 충돌 없음 확인됨), 고정
  `retrievalMode: 'LIVE'`, injected clock에서 materialize한 `fetchedAt`을 반환합니다. Assembler의
  `KmaCurrentWeatherOverviewInput`은 이제 caller-provided `source`
  (`KmaCurrentSourceMetadataInput` = `sourceId`/`fetchedAt`/`retrievalMode`)를 받아 `sources`에
  정확히 하나의 `CURRENT` `SourceMetadata`를 조립합니다 — `provider: 'KMA'`, `sections: ['CURRENT']`,
  `issuedAt: null`, `observedAt: CurrentWeather.observedAt`은 assembler가 explicit field로
  고정하며(spread 없음), `input.source`의 어떤 extra runtime property도 이 고정값을 override하거나
  leak시킬 수 없습니다. 이 PR은 resolver/assembler를 실제 location current pipeline에 연결하지
  않습니다 — location facade → current result → resolver → assembler를 잇는 application
  orchestration, PR #69/#71 production composition integration, `POST /weather` current wiring,
  current-observation availability-delay selector, 실제 인증 KMA API 호출은 모두 여전히
  미구현입니다. `packages/contracts/**`와 `CONTRACT_VERSION`은 변경되지 않았습니다. 자세한 내용은
  [kma-current-source-metadata.md](./kma-current-source-metadata.md),
  [kma-current-weather-overview.md](./kma-current-weather-overview.md) 참고. 따라서 PR #73 이후에도
  production `POST /weather`의 `current`는 계속 missing입니다.
- **PR #74**는 PR #70 location scheduled current-observation facade, PR #73 nullary current source
  metadata resolver seam, PR #72/#73 current-only `WeatherOverview` assembler를 하나의
  orchestration으로 잇는 **location current `WeatherOverview` application
  service**(`createKmaLocationCurrentOverviewService`,
  `apps/api/src/services/kma-location-current-overview.ts`)를 추가했습니다 — hourly의 PR #24
  location hourly overview service와 같은 원칙을 따르는 별도·병렬 구현입니다. `weatherLocation.parse`를
  facade 호출 전 upfront로 실행해 invalid location은 동기 `ZodError`로 전파하고(어떤 collaborator도
  호출되지 않음), PR #70 facade를 parsed `latitude`/`longitude`로 정확히 한 번 호출합니다. Current는
  fallback 선택이나 "사용 가능한 데이터 없음" success 분기가 없으므로, facade의 모든 `ok: false`
  결과(`LOCATION`/`PROVIDER`/`NORMALIZATION`)는 **그대로** 반환되고 resolver/assembler는 호출되지
  않습니다. facade 성공 시에만 주입된 **필수, nullary** source metadata resolver를 정확히 한 번, 이어서
  assembler를 정확히 한 번 호출해 `{ ok: true, overview }`를 반환합니다. `async` 없이 작성되어 invalid
  location과 facade 동기 throw는 동기 전파되고, facade rejection·resolver throw·assembler throw는
  반환된 Promise를 동일 reference로 reject합니다. Production live resolver(PR #73)를 스스로 선택하지
  않고 system clock을 주입하지 않으며, `apps/api/src/composition/**`·`routes/**`·`presenters/**`·
  `index.ts`·`api-app.ts`는 변경하지 않았습니다. 자세한 내용은
  [kma-location-current-overview.md](./kma-location-current-overview.md) 참고. 따라서 PR #74 이후에도
  production `POST /weather`의 `current`는 계속 missing이며, production composition integration,
  `POST /weather` current wiring, current-observation availability-delay selector, 실제 인증 KMA API
  호출은 모두 여전히 미구현입니다.
- **PR #75**는 PR #71 location scheduled current-observation composition, PR #73 live current source
  metadata resolver, PR #74 location current overview application service를 하나로 잇는 **여덟 번째
  callable production composition root**(`createKmaLocationCurrentOverviewCompositionFromEnv`,
  `apps/api/src/composition/kma-location-current-overview.ts`)를 추가했습니다 — hourly의 PR #27
  location hourly-overview composition과 같은 원칙을 따르는 별도·병렬 구현입니다. PR #71 composition을
  재구현하지 않고 `env`/`dependencies`를 exact reference로 그대로 전달해 호출하며, PR #71의 config
  실패(`KmaProviderConfigError`)를 동일 reference로 pass-through합니다(이 경우 resolver clock 선택·PR
  #73 resolver·PR #74 service 생성·network가 0회). 성공하면 injected `dependencies.clock`이 있을 때는
  그 동일 reference를 PR #73 resolver의 clock으로도 공유하고(정상 성공 current 요청 1회당 clock 정확히
  2회 read), 없을 때는 기존 PR #71/#69 그래프의 내부 clock은 건드리지 않고 resolver 전용 fresh
  `createKmaSystemClock()` adapter를 새로 만듭니다. 성공 결과는 `{ ok, service }`만 노출하고,
  composition 호출 시점에도 clock read·converter 실행·fetch는 0회입니다(모두 반환된 service의
  `fetchCurrentWeatherOverviewForLocation()` 실행 시에만 발생). 매 호출은 독립된 그래프를 만듭니다
  (module-level singleton/cache 없음). PR #69/#71/#73/#74의 공개 계약은 이 PR에서 전혀 변경되지
  않았습니다. 이 composition은 여전히 `apps/api/src/routes/**`·`presenters/**`·`index.ts`·
  `api-app.ts`·`weather-route.ts`에 연결되지 않았으므로, production `POST /weather`의 `current`는 이
  PR 이후에도 계속 missing입니다. current-observation availability-delay selector, cache/stale-data,
  실제 인증 KMA API 호출도 여전히 미구현입니다. 자세한 내용은
  [kma-location-current-overview-composition.md](./kma-location-current-overview-composition.md) 참고.
- **PR #76**은 PR #24 hourly overview application service의 성공 결과와 PR #74 current overview
  application service의 성공 결과(또는 `null`)를 조합하는 **순수 aggregate
  assembler**(`assembleKmaCurrentHourlyWeatherOverview`,
  `apps/api/src/services/kma-current-hourly-weather-overview.ts`)를 추가했습니다 — 어느 service도
  직접 호출하지 않고, 두 service의 이미 계산된 `overview` 값만 조합합니다. hourly 성공
  overview가 current가 아닌 모든 section(hourly/daily/airQuality/alerts/non-CURRENT
  missingSections/hourly sources)의 baseline이며, `input.hourly.overview`만 읽고
  `input.hourly.selection`(PR #22 execution trace)은 절대 읽지 않습니다. `input.current === null`은
  caller가 이미 current를 이 aggregate에 기여시키지 않기로 결정했다는 사실만 의미하며, 이
  assembler는 그 사유(LOCATION/PROVIDER/NORMALIZATION 실패 등)를 검사하거나 추론하지 않습니다 —
  current 실패 degradation 정책은 이후 application orchestration PR의 책임으로 남습니다. current가
  있으면 두 overview의 `WeatherLocation`이 **값으로** 일치해야 하며(field-by-field, reference
  identity 아님), 불일치는 synchronous하고 static하며 value-free한 `RangeError`가 됩니다. 일치하면
  `current`와 `sources`가 baseline 위에 overlay됩니다 — `missingSections`는 baseline에서 `CURRENT`만
  제거하고(current overview의 `missingSections`를 union하지 않음), `sources`는 current overview의
  sources 다음 hourly baseline의 sources 순서로 결정론적으로 이어붙입니다. 최종 payload는
  `weatherOverview.parse()`로 검증되는 것이 유일한 runtime invariant guard입니다. pure/synchronous/
  no-I/O(clock·env·fetch·console 없음), frozen input 지원, 매 호출 fresh output이며, PR #23/#72/#73
  assembler의 selection/provenance/SourceMetadata 정책을 재구현하지 않습니다. 자세한 내용은
  [kma-current-hourly-weather-overview.md](./kma-current-hourly-weather-overview.md) 참고. 이
  assembler는 어떤 hourly/current application service도 직접 호출하지 않고, current 실패 degradation
  정책·동시성/요청 순서 정책·`POST /weather` current wiring·availability-delay selector·cache/
  stale-data·실제 인증 KMA API 호출 중 어느 것도 구현하지 않습니다 — 이 PR 이후에도 production
  `POST /weather`의 `current`는 계속 missing입니다.
- **PR #77**은 PR #24 location hourly overview service와 PR #74 location current overview
  service를 처음으로 실제 호출해 PR #76 순수 assembler에 연결하는 **application
  orchestration**(`createKmaLocationCurrentHourlyOverviewService`,
  `apps/api/src/services/kma-location-current-hourly-overview.ts`)을 추가했습니다 — hourly service를
  호출자의 정확한 `input`/`options` reference로 먼저 실행하고, hourly의 top-level `LOCATION` 실패는
  그대로 반환하며(current/assembler 미호출), 모든 hourly 성공(`selection.selected === false`인
  no-selection 성공 포함)은 hourly baseline의 `overview.location`을 담은 fresh `{ location }` 입력으로
  current service를 호출합니다. current의 `LOCATION`/`PROVIDER`/`NORMALIZATION` 중 어떤 resolved
  `ok: false`도 stage를 노출하지 않고 균일하게 `current: null`로 강등되어 PR #76 assembler에
  전달되고, current 성공은 정확한 reference로 전달됩니다. hourly/current의 동기 throw나 Promise
  rejection, assembler throw는 강등되지 않고 동일 reference로 전파됩니다. 실행은 `Promise.all` 없이
  순차적입니다(hourly 완료 후에만 current 시작). 결과는 `{ ok: true, selection, overview }` 또는
  hourly `LOCATION` 실패로, 기존 `KmaLocationHourlyOverviewResult`와 정확히 호환되는 형태를
  유지합니다 — 이후 production wiring PR이 기존 hourly presenter 경계를 재사용할 수 있도록 하기
  위함입니다. `apps/api/src/composition/**`·`routes/**`·`presenters/**`·`index.ts`·`api-app.ts`는
  변경하지 않았습니다. 자세한 내용은
  [kma-location-current-hourly-overview.md](./kma-location-current-hourly-overview.md) 참고. 따라서
  PR #77 이후에도 production `POST /weather`의 `current`는 계속 missing이며, production composition
  integration, `POST /weather` current wiring, current-observation availability-delay selector,
  cache/stale-data, 실제 인증 KMA API 호출은 모두 여전히 미구현입니다.
- **PR #78**은 PR #27 location hourly-overview production composition과 PR #75 location
  current-overview production composition을 PR #77 combined application service에 연결하는
  **아홉 번째 callable production composition root**
  (`createKmaLocationCurrentHourlyOverviewCompositionFromEnv`,
  `apps/api/src/composition/kma-location-current-hourly-overview.ts`)를 추가했습니다 — hourly와
  current를 각각 재구현하지 않는 순수 조립(combining) root입니다. PR #27 hourly composition을
  `env`/`dependencies` exact reference로 먼저 호출하고, hourly config 실패는 동일 error reference로
  즉시 반환하며(PR #75 current composition과 PR #77 service factory 모두 미호출), hourly 성공
  이후에만 동일한 `env`/`dependencies` reference로 PR #75 current composition을 호출합니다. current
  config 실패도 동일 error reference로 반환되는 composition 실패이며 — 이미 두 live service가 존재할
  때만 적용되는 PR #77의 runtime `current: null` degradation과는 별개 층위임을 문서화했습니다. 두
  composition이 모두 성공하면 두 live service를 정확한 참조로만 PR #77
  `createKmaLocationCurrentHourlyOverviewService(hourlyService, currentService)`에 전달합니다(세
  번째 assembler 인자 override 없음). 주입된 `dependencies.clock`은 hourly request-plan/hourly
  metadata resolver/current request/current metadata resolver의 네 clock 역할에 동일 참조로
  전달되고, `dependencies.fetchImpl`은 PR #27 hourly와 PR #75 current의 두 provider root에 동일
  함수 참조로 전달됩니다. clock이 생략되면 이 layer는 새 clock을 만들지 않으며 두 기존 root가 각자
  독립된 default clock을 그대로 유지합니다. Construction은 lazy·network-free이며, 지원되는 요청 한 건의
  합계는 여전히 최대 hourly 2회 + current 1회 = 3회 provider 호출로 유지됩니다. 이 root는 여전히
  current-observation availability-delay selector를 상속하지 않으므로(PR #64 schedule-only 그대로)
  선택된 current issuance의 실제 게시를 보장하지 않으며, `apps/api/src/composition/**` 외의
  `routes/**`·`presenters/**`·`index.ts`·`api-app.ts`·`weather-route.ts`는 변경하지 않았습니다.
  자세한 내용은
  [kma-location-current-hourly-overview-composition.md](./kma-location-current-hourly-overview-composition.md)
  참고. 따라서 PR #78 이후에도 production `POST /weather`는 계속 hourly-only이며 `current`는
  missing입니다.
- **PR #79**는 KMA 초단기실황(`getUltraSrtNcst`)의 공식 발표시각(매시간 정시, `HH00`)에 프로젝트가
  모델링한 **10분 API 제공시각 임계값(availability threshold)**을 적용하는 순수 weather-core
  selector(`selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay`,
  `packages/weather-core/src/kma/current-observation-api-availability-time.ts`)를 추가했습니다 —
  forecast의 PR #14 `selectLatestKmaForecastBaseTimeAfterAvailabilityDelay`
  ([kma-api-availability-time.md](./kma-api-availability-time.md))와 같은 원칙(원본 reference로
  schedule selector를 1회 호출해 기존 검증 계약 재사용, `reference − threshold`로 다시 호출해
  schedule selection과 rollover/연도 검증 재사용, 새 error class·result union 없음)을 따르는
  별도·병렬 구현입니다. 근거는 Owner가 제공한 공식 공공데이터포털 참조 ZIP(`기상청41_단기예보
  조회서비스_오픈API활용가이드_2607.zip`, SHA-256
  `07f53cd9d6d6512bce6ef870d54cb740046a0a949896e6855caecf739fb8842e`; 내부 DOCX SHA-256
  `20d855aa3071a2bdda6dce3c13bab6428ebb02f8d4a30688e26ed0851d6d0848`, 저장소에 기존 기록된 hash와
  일치 확인됨)의 `# 예보 발표시각` → `초단기실황 발표시각` 절이 문서화하는 `API 제공 시간(~이후)`
  근사 안내(`HH00` → `~HH:10`)이며, 이를 모든 시간에 공통되는 정확한 10분 inclusive threshold로
  모델링합니다 — 공식 SLA나 live readiness 보장이 아닙니다. schedule-only selector(PR #64,
  `selectLatestKmaCurrentObservationBaseTime`)는 첫 발표시각이 자정(`0000`)이라 previous-day
  rollover가 없지만, 이 availability-delay selector는 reference를 10분 과거로 이동시키므로
  previous-day rollover 가능성이 새로 생기고(`00:09:59.999` → 전일 `2300`), `1000-01-01` 지원
  연도 하한에서도 adjusted instant가 `0999`로 rollover하면 `RangeError`가 됩니다(원본 reference
  자체는 하한 안이어도). 이 PR은 current-observation production composition
  (`createKmaScheduledCurrentObservationCompositionFromEnv`,
  [kma-current-observation-production-composition.md](./kma-current-observation-production-composition.md))에
  이 selector를 주입하지 않습니다 — 그 composition은 여전히 PR #64 schedule-only selector를
  명시적으로 주입하므로, production current-observation 동작은 전혀 바뀌지 않았습니다. `POST
  /weather`는 이 PR 이후에도 계속 hourly-only이며 `current`는 missing입니다. 자세한 내용은
  [kma-current-observation-api-availability-time.md](./kma-current-observation-api-availability-time.md)
  참고.
- **PR #80**은 KMA 초단기실황 production current-observation composition
  (`createKmaScheduledCurrentObservationCompositionFromEnv`,
  [kma-current-observation-production-composition.md](./kma-current-observation-production-composition.md))에
  PR #79의 availability-delay selector
  (`selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay`,
  [kma-current-observation-api-availability-time.md](./kma-current-observation-api-availability-time.md))를
  명시적으로 주입했습니다 — 이 composition은 더 이상 PR #64 schedule-only selector
  (`selectLatestKmaCurrentObservationBaseTime`)를 주입하지 않습니다. 변경은 정확히 이 한 파일의
  실행 코드(`apps/api/src/composition/kma-scheduled-current-observation.ts`)로 국한됩니다 —
  request factory(`createKmaCurrentObservationRequestFactory`,
  [kma-current-observation-request-factory.md](./kma-current-observation-request-factory.md))의
  두 번째 인자 default(직접 one-argument 호출 시 schedule-only selector)는 변경되지 않았고,
  provider/config/error 처리, clock 정책, construction의 lazy/network-free 성질, 성공 result
  `{ ok, facade }` 표면은 모두 그대로입니다. PR #71 location composition, PR #75 current-overview
  composition, PR #78 combined current+hourly composition은 모두 이 selector 선택을 코드 변경 없이
  **transitively 상속**합니다(각 root는 하위 composition을 재구현하지 않고 그대로 재사용하기
  때문입니다). `POST /weather`는 이 PR 이후에도 계속 hourly-only이며 `current`는 응답에서 여전히
  missing입니다 — 이 PR은 combined root를 route에 연결하지 않았습니다. current provider 시도는
  여전히 최대 1회이고, previous-issuance retry/fallback은 여전히 없으며, 이 selector는 upstream
  자료가 실제로 게시됐다는 보장이나 특정 호출의 성공을 보장하지 않는 결정론적 프로젝트 임계값(10분)일
  뿐입니다. 자세한 내용은
  [kma-current-observation-production-composition.md](./kma-current-observation-production-composition.md)
  참고.
- **PR #81**은 production `POST /weather` route composition
  (`createProductionWeatherRouteDependencies`, `apps/api/src/composition/weather-route.ts`)이 PR #80까지
  빌드하던 PR #27 hourly-only production root(`createKmaLocationHourlyOverviewCompositionFromEnv`) 대신
  PR #78 combined current+hourly production root
  (`createKmaLocationCurrentHourlyOverviewCompositionFromEnv`,
  [kma-location-current-hourly-overview-composition.md](./kma-location-current-hourly-overview-composition.md))를
  빌드하도록 연결했습니다 — service→route adapter가 이제
  `service.fetchCurrentHourlyWeatherOverviewForLocation(input, { signal })`를 호출합니다. PR #77 combined
  결과/입력/옵션 타입이 PR #24 hourly 타입의 의도적 alias이므로, 기존 route factory·presenter
  (`presentKmaLocationHourlyOverviewResponseV1`)는 **변경되지 않았습니다** — cast 없이 그대로
  assignable합니다. 이 PR로 production `POST /weather`는 더 이상 hourly-only가 아니며, hourly와 함께
  current-observation을 응답에 포함합니다. current가 resolve된 `LOCATION`/`PROVIDER`/`NORMALIZATION`
  실패를 만나면 PR #77의 기존 degradation 정책 그대로 `current: null` + `missingSections`의 `CURRENT`로
  강등되고(HTTP 500이 아님, 새 정책 아님), hourly가 이미 확보한 데이터는 그대로 유지됩니다. 지원되는
  요청 한 건의 provider 호출 상한은 hourly 최대 2회 + current 최대 1회 = 최대 3회로 늘었습니다(기존
  hourly-only 상한 2회에서 증가). 실행 코드 변경은 정확히 이 한 파일
  (`apps/api/src/composition/weather-route.ts`)로 국한되며,
  `apps/api/src/routes/**`·`presenters/**`·`index.ts`(실행 코드)·`api-app.ts`·`packages/contracts`·
  `packages/weather-core`·`packages/lifestyle-engine`·`apps/mobile`는 변경하지 않았습니다. 자세한 내용은
  [weather-production-wiring.md](./weather-production-wiring.md)의 "Current production state (PR #81)"
  절 참고. current retry/previous-issuance fallback, response cache, daily forecast, AirKorea air
  quality, alerts는 이 PR 이후에도 여전히 미구현입니다.
- **PR #82**는 첫 AirKorea(에어코리아) provider boundary — 측정소별 실시간 측정정보 조회
  (`getMsrstnAcctoRltmMesureDnsty`)의 request 검증·URL 생성, raw JSON runtime schema, 성공/upstream
  error/invalid response 분류, "최신 측정값" 선택 정책(배열 위치가 아닌 공식 `dataTime` 값 비교), 공유
  `CurrentAirQuality`로의 순수 정규화, 그리고 독립 HTTP transport(`apps/api/src/providers/airkorea`)
  — 를 추가했습니다. KMA current-observation provider(PR #63)와 같은 3계층 구조를 따르는 별도·병렬
  구현이며, `providers/kma/**`의 어떤 private helper도 import하지 않고 KMA 런타임 동작은 전혀
  변경하지 않았습니다. 공식 근거는 공공데이터포털 dataset `15073861`(한국환경공단_에어코리아_대기오염정보,
  메타데이터 수정일 2026-06-30)의 참고문서 `한국환경공단_에어코리아_대기오염정보_기술문서_v1.4.docx`이며,
  `ver` 파라미터는 문서가 PM2.5·모든 등급·측정소명을 포함하는 것으로 명시한 가장 높은 문서화 버전
  `1.5`를 고정 사용합니다(PM2.5는 `ver` 없이는 응답에 전혀 포함되지 않음). 공식 문서가 확인한 결측
  sentinel(`khaiValue`의 `"-"`, grade의 self-closing 빈 문자열)만 `null`로 매핑하고, 미문서화 값은
  절대 `0`이나 임의의 유효 등급으로 승격하지 않고 정규화 실패로 처리합니다. `dataTime`(`YYYY-MM-DD
  HH:mm`, 시간대 표기 없음)은 KST로 명시적으로 해석해 `measuredAt`을 만듭니다. 서비스키는
  `AIRKOREA_SERVICE_KEY`(기존 빈 `.env.example` placeholder, 변경 없음)에서만 호출 시점에 읽습니다.
  이 PR은 위경도 → 측정소 변환, station resolver, application service/composition, `POST /weather`
  연결, `WeatherOverview.airQuality.current` 조립, AirKorea 예보를 구현하지 않으므로,
  `AIR_QUALITY_CURRENT`는 production 응답에서 여전히 missing입니다. 실제 인증 API 호출은 수행하지
  않았습니다. 자세한 내용은
  [airkorea-current-air-quality-provider.md](./airkorea-current-air-quality-provider.md) 참고.
- **PR #83**은 PR #82 앞단에서, 향후 station resolver가 사용할 수 있는 두 번째 AirKorea provider
  boundary — TM(중부원점) 좌표 기반 **근접측정소 목록 조회**(`getNearbyMsrstnList`)의 request
  검증·URL 생성, raw JSON runtime schema, 성공/upstream error/invalid response 분류, 거리(km)
  파싱, validated station candidate 목록 반환 — 를 추가했습니다(`apps/api/src/providers/airkorea`).
  PR #82의 module-private HTTP transport(`performAirKoreaGetRequest`, `provider.ts`)를 그대로
  재사용하며 새 timeout/AbortController/body reader를 만들지 않았고, PR #82의 provider/테스트
  런타임 동작은 전혀 변경되지 않았습니다(회귀 없이 그대로 통과). 공식 근거는 공공데이터포털 dataset
  `15073877`(한국환경공단_에어코리아_측정소정보, 메타데이터 수정일 2026-06-30)의 참고문서
  `한국환경공단_에어코리아_측정소정보_기술문서_v1.2.docx`이며, 이 provider는 문서가 "TM좌표(중부원점)
  기반의 가까운 측정소 정보를 표출"한다고 명시한 no-version(default) 호출만 사용합니다 —
  `ver=1.0`/`1.2`는 `tmX`/`tmY`를 도로명주소API 좌표로 재해석하고 `ver=1.1`/`1.2`가 추가하는
  `stationCode`는 소비하지 않으므로 `ver`를 전혀 전송하지 않습니다. 이 operation은 문서상
  `pageNo`/`numOfRows`/`dataTerm` 요청 파라미터가 없으므로 PR #82에서 근거 없이 복사하지 않았습니다.
  성공 결과는 `stationName`과 거리(`tm`, km — `AirKoreaNearbyStationCandidate.distanceKm`)만
  노출하며, 문서가 정렬 순서를 보장하지 않으므로 `stations[0]`을 "가장 가까운 측정소"로 간주하지
  않고 upstream 순서 그대로 반환합니다 — closest-station 선택은 이 PR 범위가 아닙니다. malformed
  거리 텍스트는 정상 거리로 승격하지 않고 `MALFORMED_DISTANCE`로 페이지 전체를 실패시키며, 빈
  목록은 `NO_DATA`로 처리합니다(값 조작 없음). 이 PR은 WGS84 위경도 → TM 좌표 변환, 행정구역 → TM
  좌표 변환, 최종 closest-station 선택, application service/composition, `POST /weather` 연결을
  구현하지 않으므로, `AIR_QUALITY_CURRENT`는 production 응답에서 여전히 missing입니다. 실제 인증
  API 호출은 수행하지 않았습니다. 자세한 내용은
  [airkorea-nearby-station-provider.md](./airkorea-nearby-station-provider.md) 참고.
- **PR #84**는 PR #83 앞단에서, 행정구역명(읍면동, `umdName`)을 TM(중부원점) 좌표 candidate 목록으로
  바꾸는 세 번째 AirKorea provider boundary — **TM 기준좌표 조회**(`getTMStdrCrdnt`)의 request
  검증·URL 생성, raw JSON runtime schema, 성공/upstream error/invalid response 분류, TM 좌표
  파싱, validated candidate 목록 반환 — 를 추가했습니다(`apps/api/src/providers/airkorea`). PR
  #82의 module-private HTTP transport(`performAirKoreaGetRequest`, `provider.ts`)를 그대로
  재사용하며 새 timeout/AbortController/body reader를 만들지 않았고, PR #82/#83의 provider/테스트
  런타임 동작은 전혀 변경되지 않았습니다(회귀 없이 그대로 통과). 공식 근거는 공공데이터포털
  dataset `15073877`(한국환경공단_에어코리아_측정소정보, 메타데이터 수정일 2026-06-30)의 참고문서
  `한국환경공단_에어코리아_측정소정보_기술문서_v1.2.docx`이며 — PR #83이 근거로 삼은 것과 동일한
  파일임을 ZIP·DOCX 양쪽의 SHA-256을 재다운로드해 byte-identical하게 재확인했습니다. 이 operation의
  요청 표에는 `ver` 파라미터가 아예 존재하지 않으므로(PR #83처럼 "보내지 않기로 결정"한 것이
  아니라 애초에 옵션 자체가 없음) 전송하지 않고, `numOfRows`/`pageNo`는 이 operation에서는 문서상
  옵션이지만 동명이동(같은 `umdName`이 여러 시군구에 존재할 수 있음) 대비 고정값
  (`numOfRows=100`, `pageNo=1`)을 항상 전송하는 project-owned 정책을 채택했습니다. 성공 결과는
  `sidoName`/`sggName`/`umdName`/`tmX`/`tmY` 5개 필드(모두 문서상 필수) candidate 배열이며, 문서가
  정렬 순서를 보장하지 않고 하나의 `umdName`이 여러 행을 합법적으로 식별할 수 있으므로(동명이동)
  이 provider는 candidate 하나를 선택하지 않고 upstream 순서 그대로 반환합니다 — 행정구역
  disambiguation은 이 PR 범위가 아닙니다. malformed `tmX`/`tmY` 텍스트는 정상 좌표로 승격하지
  않고(특히 `0`으로 조작하지 않고) `MALFORMED_COORDINATE`로 페이지 전체를 실패시키며, PR #83과
  동일한 원리로 `totalCount > items.length`인 응답은 `INCOMPLETE_RESULT`로 fail-closed됩니다. 이
  PR은 WGS84 위경도 ↔ TM 좌표 변환, 행정구역 disambiguation, 최종 TM 좌표 선택,
  `getNearbyMsrstnList`(PR #83)와의 orchestration, application service/composition, `POST
  /weather` 연결을 구현하지 않으므로, `AIR_QUALITY_CURRENT`는 production 응답에서 여전히
  missing입니다. 실제 인증 API 호출은 수행하지 않았습니다. 자세한 내용은
  [airkorea-tm-coordinate-provider.md](./airkorea-tm-coordinate-provider.md) 참고.
- **PR #85**는 PR #82/#83/#84 세 AirKorea provider boundary를 순서대로 연결하는 첫 **application
  service**(`createAirKoreaLocationCurrentAirQualityService`,
  `apps/api/src/services/airkorea-location-current-air-quality.ts`)를 추가했습니다 — 이미 검증된
  `WeatherLocation`을 PR #84(행정구역명 → TM 좌표) → PR #83(TM 좌표 → 근접측정소) → PR #82(측정소명 →
  실시간 측정정보 + 기존 정규화) 순서로 호출해 `CurrentAirQuality`를 만듭니다. 지원 위치는
  `countryCode === 'KR'`이고 `adminArea1`/`adminArea3`가 모두 `null`이 아닌 대한민국 leaf
  행정구역뿐입니다 — `adminArea3`가 없는 시/도-구 수준 location(기존 모바일 카탈로그에 실재)은
  `adminArea2`나 `displayName`을 대신 사용하지 않고 `UNSUPPORTED_ADMINISTRATIVE_LEVEL`로
  fail-closed됩니다. PR #84가 선택하지 않는 TM candidate는 `sidoName`/`umdName`(그리고
  `adminArea2`가 `null`이 아닐 때만 `sggName`)의 **정확 일치**로 이 service가 좁히며(0개는
  `TM_COORDINATE_NOT_FOUND`, 2개 이상은 `AMBIGUOUS_TM_COORDINATE`, `candidates[0]` 사용 없음), PR
  #83이 선택하지 않는 최근접 측정소는 `distanceKm` 최소값(동점 시 `stationName` 오름차순
  tie-break, upstream 순서 무관)으로 이 service가 선택합니다. 실행은 순차적이며 지원 요청 한 건당
  provider 호출은 최대 3회(TM 1 + 근접측정소 1 + 현재 대기질 1)이고, 재시도·fallback·캐시는
  없습니다. `options`(그 안의 `AbortSignal` 포함)는 세 provider 모두에 정확히 같은 참조로
  전달됩니다. 각 provider 실패는 그 provider의 error를 그대로 반환하며 재분류하지 않고, 정규화
  실패는 기존 `normalizeAirKoreaCurrentAirQuality`의 issues를 그대로 사용합니다. 이 PR은 production
  composition, `POST /weather` 연결, `WeatherOverview.airQuality.current` 조립을 구현하지 않으므로,
  `AIR_QUALITY_CURRENT`는 production 응답에서 여전히 missing입니다. 실제 인증 API 호출은 수행하지
  않았습니다. 자세한 내용은
  [airkorea-location-current-air-quality-service.md](./airkorea-location-current-air-quality-service.md)
  참고.
- **PR #87**은 2026-08-13 Owner-executed authenticated Public Data Portal preview 호출 3건(각각
  `getTMStdrCrdnt`/`getNearbyMsrstnList`/`getMsrstnAcctoRltmMesureDnsty`의 성공 응답 1건씩)에서
  실측된 live JSON 형태에 PR #82/#83/#84 provider boundary를 맞추는 **compatibility
  remediation**입니다 — 새 기능이나 provider가 아니라 기존 세 provider의 raw schema/parser 수정만
  포함합니다. 세 provider 모두 `response.body.items`가 (이전에 문서에 근거 없이 가정했던 `{ item:
  [...] }` wrapper가 아니라) **direct array**임이 확인되어 raw schema를 수정했습니다. 근접측정소
  목록 조회(`getNearbyMsrstnList`)의 `tm`(거리, km)은 이전에 문자열로 가정했으나 실제로는 JSON
  **number**임이 확인되어(실측값 `1.5`/`1.7`/`1.9`) `z.coerce` 없이 정확히 number 타입만 허용하도록
  수정했고, TM 기준좌표 조회의 `tmX`/`tmY`는 기존 문자열 가정이 그대로 유지되었습니다. 측정소별
  실시간 측정정보 조회(`getMsrstnAcctoRltmMesureDnsty`)의 `dataTime`에 자정을 `24:00`으로 표기하는
  실제 사례(`"2026-08-12 24:00"`)가 확인되어, `parseAirKoreaDataTime`(`current-raw-schema.ts`)이
  정확히 `24:00`(다른 `24:xx`는 계속 거부)만 순수 달력 연산(월말·연말·윤년 처리 포함, `Date`나
  시스템 시계 없음)으로 다음 날 `00:00`으로 canonicalize합니다 — 단, 결과 연도가 `dataTime`의
  4자리 `YYYY`가 표현 가능한 최대값(`9999`)을 넘는 유일한 입력(`9999-12-31 24:00`)은 5자리 연도가
  되어 표현 불가능하므로 다른 malformed 값과 동일하게 거부됩니다. `normalizeAirKoreaCurrentAirQuality`가
  이를 그대로 다음 날 KST `measuredAt`으로 반영하도록 확장했습니다. "최신 측정값" 선택
  (`provider.ts`의 `selectLatestItem`)도 raw 문자열이 아닌 이 canonical(24:00-rollover 적용 후)
  시각을 비교하도록 바뀌어, `24:00` 행과 다음 날 `00:00` 행처럼 서로 다른 표기가 같은 순간을
  의미하는 경우에도 가짜 시간차를 만들지 않고 결정적으로 처리합니다. 이 세 사실은 각 provider의
  positive(성공) 응답에서만 확인되었으며, zero-result 응답의 실제 JSON 직렬화 형태는 여전히
  live-verified가 아닙니다(구조적으로 자연스럽게 도출되는 빈 direct array 가정만 유지). 이 PR은
  `apps/api/src/providers/airkorea/**`(및 그 문서) 밖의 어떤 파일도 변경하지 않습니다 —
  `packages/contracts`, `packages/weather-core`, KMA provider, PR #85 application
  orchestration/policy, PR #86 production 연결, `apps/api/src/routes/**`,
  `apps/api/src/presenters/**`는 모두 무변경입니다. 실제 인증 API 호출은 이 PR 자체에서는 수행하지
  않았습니다(위 실측은 Owner가 별도로 수행한 선행 사실입니다). PR #87은 2026-08-14 main에 squash
  merge(`e4f4556394968e423dc1456b4ef56df4148d7cbb`)됐습니다. 자세한 내용은
  [airkorea-current-air-quality-provider.md](./airkorea-current-air-quality-provider.md),
  [airkorea-nearby-station-provider.md](./airkorea-nearby-station-provider.md),
  [airkorea-tm-coordinate-provider.md](./airkorea-tm-coordinate-provider.md)의 각 "Owner-observed
  live JSON evidence" 절 참고.
- **PR #86**은 PR #85 AirKorea location current air-quality application service를 기존 production
  `POST /weather` 파이프라인에 연결했습니다 — 원래 base `main@77b37c64`(PR #85 baseline)에서
  개발을 시작했고, 이후 PR #87의 provider live-JSON remediation이 main에 병합된 뒤
  `main@e4f4556394968e423dc1456b4ef56df4148d7cbb`로 refresh되어 PR #87이 고친 AirKorea provider
  boundary(direct-array `items`, 근접측정소 numeric `tm`, `dataTime` `24:00` rollover)를 그대로
  소비합니다. 새 pure overlay
  assembler(`overlayAirKoreaCurrentAirQualityOnWeatherOverview`,
  `apps/api/src/services/weather-overview-air-quality-overlay.ts`)가 기존 KMA current+hourly
  overview에 optional `CurrentAirQuality`를 얹습니다 — AirKorea 실패는 `airQuality.current: null` +
  `missingSections`의 `AIR_QUALITY_CURRENT` 유지로 균일하게 강등되고, 성공은 `airQuality.current`를
  채우고 explicit field로 구성한 단일 `AIR_KOREA` `SourceMetadata`(`sections:
  ['AIR_QUALITY_CURRENT']`, `issuedAt: null`, `observedAt: CurrentAirQuality.measuredAt`)를
  추가합니다. 새 nullary live source metadata resolver
  (`createAirKoreaLiveCurrentSourceMetadataResolver`,
  `apps/api/src/services/airkorea-current-source-metadata.ts`)는 기존 KMA current resolver와 같은
  원칙(injected clock, 유효 호출당 정확히 1회 read, invalid clock 값·throwing clock 모두 static
  RangeError)을 따르는 별도·병렬 구현입니다. 새 cross-provider application
  service(`createKmaAirKoreaWeatherOverviewService`,
  `apps/api/src/services/kma-airkorea-weather-overview.ts`)는 기존 PR #77 KMA combined service를
  먼저 호출해 top-level `LOCATION` 실패는 그대로 반환하고(AirKorea 미호출), KMA 성공마다 KMA
  baseline의 파싱된 location으로 PR #85 AirKorea service를 호출하며, resolved AirKorea 실패는 stage
  무관 균일하게 강등되고 unexpected throw/rejection은 강등 없이 그대로 전파됩니다. 이 service의
  공개 method 이름·결과 형태는 기존 PR #77 service와 동일(`fetchCurrentHourlyWeatherOverviewForLocation`,
  `{ ok, selection, overview }`)해서 route/presenter는 새 계약이 필요 없습니다. 새 AirKorea
  production composition(`createAirKoreaLocationCurrentAirQualityCompositionFromEnv`,
  `apps/api/src/composition/airkorea-location-current-air-quality.ts`)이 PR #82/#83/#84
  provider-from-env 세 factory와 PR #85 service, 새 resolver를 조립하고, 새 combined production
  composition(`createKmaAirKoreaWeatherOverviewCompositionFromEnv`,
  `apps/api/src/composition/kma-airkorea-weather-overview.ts`)이 이를 기존 PR #78 KMA combined
  composition과 순서대로(KMA 먼저) 연결합니다 — KMA config 실패는 AirKorea composition을 전혀
  호출하지 않고, AirKorea config 실패는 partial graph를 반환하지 않습니다.
  `apps/api/src/composition/weather-route.ts`가 이제 이 combined root를 빌드하며,
  `apps/api/src/index.ts`가 `KMA_SERVICE_KEY`와 `AIRKOREA_SERVICE_KEY` 둘 다 읽어 각각 독립적인
  fail-fast(`KMA_SERVICE_KEY is required.` / `AIRKOREA_SERVICE_KEY is required.`)를 수행합니다.
  지원되는 요청 한 건의 provider 호출 상한은 KMA hourly 최대 2 + KMA current 최대 1 + AirKorea TM/
  근접측정소/현재대기질 각 최대 1 = **최대 6회**로 늘었습니다(PR #81 이후 상한 3에서 증가).
  `adminArea3`가 없는 시/도-구 수준 location은 KMA current/hourly는 그대로 받고 AirKorea만
  `UNSUPPORTED_ADMINISTRATIVE_LEVEL`로 강등되어 요청 전체가 실패하지 않습니다. `packages/contracts`,
  `CONTRACT_VERSION`, `packages/weather-core`, `apps/api/src/routes/**`, `apps/api/src/presenters/**`,
  `apps/api/src/providers/**`는 변경하지 않았습니다. 실제 인증 API 호출과 실제 키 사용은 수행하지
  않았습니다. 자세한 내용은 [weather-production-wiring.md](./weather-production-wiring.md)의
  "Current production state (PR #86)" 절 참고. AirKorea 예보·대기질 특보, response cache는 여전히
  미구현입니다.
- **PR #89**(`feat/pr-89-kma-alert-event-provider`, **MERGED**
  `dd2a006eb4def094f6fc5c391f464ca280073a8b`로 main에 병합됨)는 KMA 기상특보
  조회서비스(`WthrWrnInfoService`) 특보코드조회(`getPwnCd`)의 첫 provider boundary — request
  검증/URL 생성(`alert-request.ts`), raw JSON schema(`alert-raw-schema.ts`), 성공/확인된
  no-data/upstream error/invalid response 4-outcome parser(`parse-alert-response.ts`), 기존
  `performKmaGetRequest` transport를 재사용하는 HTTP provider
  (`createKmaAlertEventProvider`/`…FromEnv`, `provider.ts`)입니다. `WthrWrnInfoService`는
  `VilageFcstInfoService_2.0`과 다른 서비스 패밀리(자체 base URL, `serviceKey` 소문자 파라미터
  casing — Owner-authorized 2026-08-25 live 진단으로 확인)이며, `resultCode === '03'`은 이
  operation에 한해 확인된 유효한 zero-match 결과로 별도 모델링됩니다(forecast/current의 일괄
  `UPSTREAM_ERROR` 분류와 다름). Codex 초기 HIGH 리뷰의 finding을 반영해 request/response
  optionality를 공식 260601 가이드에 맞춰 정정했습니다: `fromTmFc`/`toTmFc`/`areaCode`/
  `warningType`/`stnId` 다섯 필드 모두 optional 필터(생략된 날짜는 upstream 문서화된 기본값에
  위임하며 이 provider가 합성하지 않음, 생략된 필터는 성공 결과에 `null`로 기록), `areaCode`
  max size 10/`stnId` max size 5 강제. raw item은 `stnId`/`tmFc`/`areaCode`/`areaName`/
  `allEndTime`만 required로 남고 `tmSeq`/`warnVar`/`warnStress`/`command`/`startTime`/`endTime`/
  `cancel`은 가이드가 문서화한 optional/조건부 필드라 absence를 허용하되(present일 때는 여전히
  evidenced strict 타입만 허용, `null`/coercion 없음) — 검증된 raw alert lifecycle event record까지만
  반환하며, `WeatherAlert[]` 정규화·활성-특보 folding·`POST /weather` 연결은 후속 PR로 미룹니다.
  `packages/contracts`, `packages/weather-core`, `apps/api/src/services`·`composition`·`routes`·
  `presenters`는 변경하지 않았습니다. 이 PR 자체는 추가 실제 KMA 호출을 수행하지 않았습니다.
  단일-item `items.item`의 object 직렬화는 여전히 독립적으로 관측되지 않았습니다. 자세한 내용은
  [kma-alert-event-provider.md](./kma-alert-event-provider.md) 참고. 이 PR은 provider boundary만
  추가했으므로, `WeatherAlert[]` 정규화·활성-특보 folding과 `POST /weather` alert 연결은 이 PR
  이후에도 여전히 미구현입니다.
- **PR #90**(**MERGED**, main `081dea04b68452370faf5dea38f77abcfd498617`)는 모바일 Today(`오늘`)
  화면을 기존 중앙정렬 debug 스타일 레이아웃에서 첫 제품 수준 visual layout으로 교체했습니다 —
  `apps/mobile/src/app/(tabs)/index.tsx`만 대상으로 한 presentation 전용 작업입니다. 스크롤
  가능한 header(선택 저장 지역 표시)/현재 날씨 hero(AirKorea 대기질 pill 포함)/기존 4개
  `생활 한눈에` 카드/제한된 `시간별` 미리보기/`저장 지역` 관리 섹션 순서로 재구성했고, 기존
  저장 지역 추가·선택·삭제·재시도 동작과 모든 loading/empty/error 상태는 그대로 보존됩니다.
  `packages/contracts`, `packages/lifestyle-engine`, `packages/weather-core`, `apps/api`,
  saved-location store/persistence, dependency는 변경하지 않았고, 실제 provider 호출과 배포는
  수행하지 않았습니다. Owner의 로컬 synthetic `/weather` 서버 기반 visual checkpoint(~412×915)는
  **완료(PASS)** — 실제 live API 호출 없음.
- **PR #91**(**MERGED**, new main `7fd40464613e0f766bd10fa9b3a74db12c6ef272`)는 모바일
  Hourly(`시간별`) 화면을 기존
  수직 텍스트 나열 레이아웃에서 제품 수준 시간별 타임라인으로 교체합니다 —
  `apps/mobile/src/app/(tabs)/hourly.tsx`와 `(tabs)/_layout.tsx`의 hourly route
  `headerShown: false`만 대상으로 한 presentation 전용 작업입니다. 화면이 소유하는
  header(`시간별` + READY일 때 선택 저장 지역 표시)/선택 저장 지역의 timezone(기기 timezone
  아님) 기준 로컬 캘린더 날짜 그룹 heading(`8월 25일 (화)` 형식, `오늘`/`내일` 라벨 없음)/
  compact 시간별 카드(시각·조건 글리프+한국어 라벨·온도 상단 행, optional 필드 pill 하단 행)
  순서로 재구성했습니다. 날짜 그룹핑과 시간 표기 모두 새 화면-local
  `Intl.DateTimeFormat`/`formatToParts` 기반 helper(`localDateKey`/`localDateLabel`/
  `localTime`/`groupHourlyByLocalDate`)로 구현했고, 원본 contract 순서는 그룹 간·그룹 내 모두
  보존하며, 날짜 key는 표시 텍스트와 독립적으로 계산합니다. 기존 saved-location
  (`NOT_STARTED`/`LOADING`/`SELECTION_LOADING`/`EMPTY`/`READY`/`ERROR`)과 weather-query
  (`IDLE`/`LOADING`/`SUCCESS`/`ERROR`, 네 가지 고정 오류 문구, 명시적 재시도) 상태 처리와
  `null` 비노출·`0` 값 노출 정책은 그대로 보존됩니다. `packages/contracts`,
  `packages/weather-core`, `apps/api`, weather-query/saved-location store·persistence,
  dependency는 변경하지 않았고, 실제 provider 호출과 배포는 수행하지 않았습니다. Owner의 로컬
  synthetic `/weather` 서버 기반 visual checkpoint(~412×915)는 **완료(PASS)** — 선택 저장 지역
  timezone 기준 자정 경계 날짜 그룹핑(`8월 25일 (화)` 23:00 종료 → `8월 26일 (수)` 00:00 시작)을
  시각적으로 확인했으며, 실제 live API 호출은 없습니다.
- **PR #92**(**MERGED**, new main `aba871b3a8105c5eee2635722ca12e5201a16f25`)는 모바일
  Lifestyle(`생활날씨`) 화면을 기존
  `상태 / 이유 / 행동` 개발자용 텍스트 나열에서 제품 수준 상세 생활 가이드로 교체합니다 —
  `apps/mobile/src/app/(tabs)/lifestyle.tsx`와 `(tabs)/_layout.tsx`의 lifestyle route
  `headerShown: false`만 대상으로 한 presentation 전용 작업입니다. 화면이 소유하는
  header(`생활날씨` + READY일 때 선택 저장 지역 표시)/정적 안내 문구/1열 상세 카드 4개 순서로
  재구성했고, 각 카드는 카드 header(카테고리 글리프 + 텍스트 제목 + compact status pill) →
  `왜 이렇게 판단했나요`(reason) → `이렇게 해보세요`(recommendation) → non-null일 때만 나타나는
  `추가 안내`(additionalRecommendation)의 시각적 위계를 따릅니다. 카드는 기존
  `createMobileLifestyleOverview(weatherQuery.data)`가 반환하는 고정 순서(우산/옷차림/마스크/빨래)
  그대로 렌더링하며, lifestyle-engine의 `statusLabel`·`reason`·`recommendation`·
  `additionalRecommendation` 문자열은 잘라내거나 요약·재작성하지 않고 그대로 출력합니다
  (`numberOfLines` 미사용). 카드 수준에서 status를 다시 분류하지 않고 한국어 status 텍스트로
  색을 유추하지 않으므로 pill은 단일 중립 스타일을 유지하며, `판단 보류` 카드도 숨기지 않습니다.
  기존 saved-location(`NOT_STARTED`/`LOADING`/`SELECTION_LOADING`/`EMPTY`/`READY`/`ERROR`)과
  weather-query(`IDLE`/`LOADING`/`SUCCESS`/`ERROR`, 네 가지 고정 오류 문구, 명시적 재시도,
  `지역 추가` 네비게이션) 상태 처리와 raw kind/message/URL/requestId/좌표/provider 비노출 정책은
  그대로 보존됩니다. `packages/lifestyle-engine`,
  `apps/mobile/src/lifestyle/create-mobile-lifestyle-overview.ts`의 동작,
  `packages/contracts`, `packages/weather-core`, `apps/api`,
  weather-query/saved-location store·persistence, dependency·env·native config는 변경하지
  않았고, 실제 provider 호출과 배포는 수행하지 않았습니다. Owner의 로컬 synthetic `/weather`
  서버 기반 visual checkpoint(~412×915)는 **완료(PASS)** — 화면 소유 header(중복 Tabs header
  없음), presenter 고정 순서(우산 → 옷차림 → 마스크 → 빨래) 4개 카드 위계,
  `왜 이렇게 판단했나요`/`이렇게 해보세요` 구분, 긴 한국어 정책 문구의 자연스러운 줄바꿈
  (시각적 잘림·고정 높이 clipping 없음), 마지막 빨래 카드가 고정 하단 탭 바 위로 완전히
  스크롤되는 bottom scroll safety를 시각적으로 확인했습니다. 이 checkpoint에 사용된 synthetic
  응답은 non-null `additionalRecommendation`을 만들지 않았으므로 optional `추가 안내` 블록은
  이번 checkpoint에서 시각적으로 직접 확인되지 않았습니다 — 조건부 렌더링(non-null일 때만 노출,
  문구 원문 보존, null 카드에서 안내 미생성)은 기존 test suite가 이미 검증하므로 non-blocking
  입니다. 실제 live KMA/AirKorea/production API 호출은 없었습니다. Owner Ready gate 이후
  merge되어 현재 main에 포함되어 있습니다.
- **PR #93**(**MERGED**, new main `5b4cf8323d73ea3e2fbc177565c80393a207d151`)는 모바일 Hourly(`시간별`) 화면의 성공 상태를
  세로 카드 나열에서 가로 스크롤 시간축 비교표로 교체합니다 —
  `apps/mobile/src/app/(tabs)/hourly.tsx`만 대상으로 한 presentation 전용 작업입니다. 화면이
  소유하는 기존 header(`시간별` + READY일 때 선택 저장 지역 표시) 아래에 하나의 timeline
  surface를 렌더링하며, 왼쪽에 고정된 row-label rail(`날짜`/`시간`/`날씨`/`기온`/`체감`/
  `강수확률`/`강수량`/`적설량`/`습도`/`풍속`/`풍향`)과 오른쪽에 **단일** horizontal
  `ScrollView`를 두어 모든 시간 종속 row가 하나의 동기화된 가로 축에서 함께 이동합니다(행별
  개별 가로 스크롤 없음). 날짜 band와 시각은 모두 선택 저장 지역의 timezone 기준이며(기기
  timezone·UTC·system clock 아님) 기존 `Intl.DateTimeFormat`/`formatToParts` helper 의미를
  유지합니다. 날짜 band는 원본 응답 순서를 보존한 연속(contiguous) 로컬 날짜 run 단위로 폭을
  차지하므로 자정 경계에서 새 band가 시작되고, 정렬·중복 제거·`오늘`/`내일` 라벨은 사용하지
  않습니다. `기온` row는 숫자 텍스트와 함께 React Native primitive View만으로 그린 연결
  polyline(시간별 column 중심에 정렬된 점 + 인접 점 사이 직선 segment)을 함께 보여주며, scale은
  실제 `temperatureCelsius` 최소·최대에서만 계산합니다(feels-like 미사용, 보간·평활 없음, 동일
  온도는 안정적인 중간 높이, 단일 항목은 segment 없이 점 1개, 음수 온도도 유한 좌표). chart는
  보조 표현이고 모든 온도는 텍스트로도 항상 노출되며 graph layer 자체는 접근성 트리에서
  제외됩니다. 고정 표에서는 cell을 제거할 수 없으므로 optional 값 정책이 바뀌었습니다 — non-null은
  실제 값, 숫자 `0`은 `0%`/`0mm`/`0cm`/`0m/s`/`0°`로 그대로 노출, `null`은 값을 지어내지 않고
  중립 미제공 marker `—`로 표시하며 row label은 항상 유지합니다. `풍향`은 원본 degree를 그대로
  보여주면서 presentation 전용 8방위 한국어 label(`북`/`북동`/`동`/`남동`/`남`/`남서`/`서`/
  `북서`)을 함께 표기합니다. 기존 saved-location(`NOT_STARTED`/`LOADING`/`SELECTION_LOADING`/
  `EMPTY`/`READY`/`ERROR`)과 weather-query(`IDLE`/`LOADING`/`SUCCESS`/`ERROR`, 네 가지 고정 오류
  문구, 두 종류의 명시적 재시도, `지역 추가` 네비게이션, selected-location 방어적 처리, 빈 hourly
  SUCCESS)와 raw kind/message/URL/requestId/좌표/provider 비노출 정책은 그대로 보존됩니다. Today
  (`오늘`) 탭의 기존 compact 시간별 미리보기와 `(tabs)/_layout.tsx`는 변경하지 않았습니다.
  `packages/contracts`, `packages/weather-core`, `packages/lifestyle-engine`, `apps/api`,
  weather-query/saved-location store·lifecycle·persistence, dependency·env·native config는
  변경하지 않았고 새 dependency(chart/SVG 라이브러리 포함)도 추가하지 않았습니다. 실제 provider
  호출과 배포는 수행하지 않았습니다. Owner의 로컬 synthetic `/weather` 서버 기반 visual
  checkpoint(~412×915, 자정을 넘는 확장 synthetic 데이터)는 **완료**되었고 결과는 **PASS**입니다 —
  고정 label rail, 연결 온도선, 시간별 column 정렬, 자정 날짜 경계 전환, `473e1df`의 label-rail
  폭 보정(`강수확률` 한 줄 표시)이 모두 확인되었습니다. 이 checkpoint는 Expo Web에서만
  수행되었으며, Expo Web 특성상 가로 스크롤이 임의 offset에서 멈춰 고정 label rail 오른쪽에 이전
  column의 일부가 겹쳐 보이는 현상이 있었습니다 — 따라서 `snapToInterval`/`snapToAlignment`
  기반 column 경계 스냅은 이 checkpoint로 독립 검증되지 않았습니다(production 코드는 여전히
  단일 horizontal `ScrollView`에 `snapToInterval=72`/`snapToAlignment="start"`/
  `decelerationRate="fast"`를 유지). 네이티브 Android 스냅 동작 확인은 이후 native QA 항목으로
  남습니다. 실제 live API는 사용되지 않았습니다. Owner Ready gate 이후 merge되어 현재 main에
  포함되어 있습니다.
- **PR #94**(**MERGED**, new main `c5e7e2ae431927ae139fe984d62a8f91d12a6dc1`)는 모바일 Details(`상세기상`) 화면을 기존
  개발자용 텍스트 나열 레이아웃에서 제품 수준 상세기상 화면으로 교체합니다 —
  `apps/mobile/src/app/(tabs)/details.tsx`와 `(tabs)/_layout.tsx`의 details route
  `headerShown: false`만 대상으로 한 presentation 전용 작업입니다. 화면이 소유하는
  header(`상세기상` + READY일 때 선택 저장 지역 표시) 아래에 기존 `기상특보` → `현재 관측`
  alert-first 순서를 그대로 유지하며, 각 section을 카드 기반 제품 UI로 재구성했습니다. 기상특보는
  UNAVAILABLE/NONE 각각 기존 presenter 고정 문구를 별도의 calm 정보 카드로, AVAILABLE은 카드
  header(글리프 + title(header semantics) + severity pill) → typeLabel → 시간 정보(발표, 발효/종료는
  non-null일 때만) → 대상 지역 → 상세 안내(non-null일 때만)의 위계로 표시하며, 기존 `등급:`/`종류:`
  developer-style prefix는 제거하고 presenter 값은 그대로 보존합니다(sort/filter/dedupe 없음).
  현재 관측은 UNAVAILABLE 정보 카드 또는 conditionLabel/temperatureLabel 중심 hero(관측 시각은
  보조 텍스트) + 6개 optional detail id의 글리프 있는 2열 grid(응답 순서 그대로, `0`은 항상 노출,
  `null`은 항상 생략)로 재구성했습니다. `createMobileWeatherDetails`(alert/current 매핑 정책)와
  saved-location(`NOT_STARTED`/`LOADING`/`SELECTION_LOADING`/`EMPTY`/`READY`/`ERROR`),
  weather-query(`IDLE`/`LOADING`/`SUCCESS`/`ERROR`, 네 가지 고정 오류 문구, 명시적 재시도, `지역
  추가` 네비게이션) 상태 처리와 raw kind/message/URL/requestId/좌표/provider 비노출 정책은 그대로
  보존됩니다. `packages/contracts`, `packages/weather-core`, `packages/lifestyle-engine`,
  `apps/api`, weather-query/saved-location store·lifecycle·persistence,
  `create-mobile-weather-details.ts`의 동작, dependency·env·native config는 변경하지 않았고 새
  dependency도 추가하지 않았습니다. 실제 provider 호출과 배포는 수행하지 않았습니다. Owner의 로컬
  synthetic `/weather` 서버 기반 visual checkpoint(~412×915)는 **완료**되었고 결과는 **PASS**입니다 — 화면이 소유하는 커스텀
  header(중복 Tabs header 없음), `기상특보` → `현재 관측` alert-first 위계, ALERTS UNAVAILABLE의
  calm 정보 카드(`특보 없음`/`안전` 등 성공 해석으로 오인되지 않는 문구), condition → temperature →
  observation time 순서의 현재 관측 hero(온도 시각적 우세, 관측 시각은 보조 텍스트), 6개 항목의
  자연스러운 2열 detail grid, 긴/일반 한국어 텍스트 가독성, 값이 0인 강수량(`0mm`)의 노출, 고정
  하단 탭 바 위로 완전히 스크롤되는 마지막 detail content, Today/Hourly/Lifestyle과 일관된 시각
  언어가 모두 확인되었습니다. 이 checkpoint에 사용된 synthetic 응답은 ALERTS UNAVAILABLE을
  반환했으므로 AVAILABLE alert 카드의 시각적 레이아웃은 이번 checkpoint에서 화면으로 직접
  검증되지 않았습니다 — alert card title/severityLabel/typeLabel/issuedAtLabel/optional
  effectiveAtLabel·expiresAtLabel/areasLabel/optional description/presenter 값 보존/nullable
  optional 필드 생략/alert-first 순서는 기존 test suite가 이미 검증하므로 non-blocking입니다.
  실제 live KMA/AirKorea/production API 호출은 없었습니다. Owner Ready gate 이후 merge되어 현재
  main에 포함되어 있습니다.
- **PR #95**(**MERGED**, new main `eb10a04fcdf1ff267dc98f4415ef2d0b66547e63`)는 저장 지역 전환·추가를 네 개의 주요 날씨
  화면 어디에서나 할 수 있도록 공용 우상단 지역 선택기를 추가합니다 — 새 presentation 컴포넌트
  `apps/mobile/src/components/saved-location-switcher.tsx`와 네 화면(`(tabs)/index.tsx`,
  `hourly.tsx`, `lifestyle.tsx`, `details.tsx`)의 header 우측, 그리고 Settings의 지역 안내 문구만
  대상으로 한 UI 작업입니다. 각 화면의 기존 좌측 title은 유지한 채 기존의 수동적인 선택 지역
  텍스트를 `중구 ▾` 형태의 pressable 버튼으로 교체했고, 버튼을 누르면 React Native 내장 `Modal`
  기반 bottom-sheet 형태의 세로 목록(`지역 선택` header, 닫기 컨트롤, backdrop 및 Android
  `onRequestClose` 닫기)이 열립니다. 목록은 snapshot의 기존 배열 순서를 그대로 렌더링하고(정렬·
  중복 제거·재정렬 없음), 선택된 행은 체크 표시와 `accessibilityState.selected`로 표시하며 중복
  select를 발행하지 않습니다. 다른 지역 선택은 기존 `select(locationId)`, 삭제는 기존
  `remove(locationId)`만 호출하고, `+ 지역 추가`는 sheet를 닫은 뒤 기존 `/locations` 화면으로
  이동합니다. 성공한 select만 sheet를 닫고, 실패 시에는 error kind를 노출하지 않는 고정 문구
  (`지역을 변경하지 못했습니다.` / `지역을 삭제하지 못했습니다.`)만 표시하며 자동 재시도는 하지
  않습니다. `writeStatus === 'SAVING'`일 때는 select/삭제/지역 추가 컨트롤이 비활성화됩니다.
  컴포넌트는 화면이 이미 읽어 `useMobileWeatherQuery`에 넘기는 **바로 그 snapshot**을 prop으로
  받으므로 header를 위한 두 번째 store 구독이 생기지 않습니다. Today 화면의 기존 READY 전용 하단
  `저장 지역` 관리 섹션(선택/선택됨·삭제·지역 추가)과 그에 딸린 로컬 write-failure 상태는
  중복이므로 제거했고, EMPTY 상태의 `지역 추가` CTA와 hero·`생활 한눈에`·시간별 preview·weather
  오류 동작은 그대로입니다. Settings의 `지역 선택과 삭제는 오늘 화면에서 할 수 있습니다.` 문구는
  네 날씨 화면 상단의 지역 버튼을 가리키도록 수정했습니다. saved-location application store,
  persistence, hydration, selected-location 초기화, `useMobileSavedLocations`, weather-query
  lifecycle(`(tabs)/_layout.tsx`), `/locations` 검색·추가 계약, contracts, `weather-core`,
  `lifestyle-engine`, `apps/api`, dependency·lockfile·env·native config는 변경하지 않았습니다.
  실제 provider 호출, 배포, native build, 실제 위치 요청은 수행하지 않았습니다. Owner의 로컬
  synthetic `/weather` 서버 기반 visual checkpoint(~412×915)는 **완료**되었고 결과는
  **PASS**입니다 — 저장 지역 2개(`중구`/서울특별시, `학성동`/울산광역시 중구)로 수행했고, 공용
  우상단 지역 선택기(Today의 pressable `중구 ▾`), bottom-sheet 형태의 지역 선택 UI(dimmed
  backdrop, `지역 선택` title, 닫기 컨트롤, 현재 지역 체크 표시, 지역명과 행정 보조 라벨, 절제된
  삭제 컨트롤, `+ 지역 추가` 액션, ~412×915에서 편안한 sheet 높이와 여백), 그리고 성공한 지역
  전환(`중구` → `학성동`, 선택 후 sheet 닫힘)이 모두 확인되었습니다. 변경된 선택 지역은 Today와
  Hourly header에서 모두 `학성동 ▾`으로 나타나 기존 saved-location selection 경계를 통해 날씨
  탭 전반에 전파되는 것이 확인되었습니다(local synthetic `/weather` 서버는 지역별 응답을 주지
  않으므로 날씨 수치 자체가 동일하게 남는 것은 예상된 동작입니다). Today 하단까지 스크롤해 기존
  READY 전용 `저장 지역` 관리 카드가 제거되고 READY 상태의 지역 관리가 공용 우상단 선택기만
  남았음도 확인했습니다. 다만 `학성동`으로 전환한 뒤 sheet를 다시 열어 `✓ 학성동`을 보여주는
  전환 후 스크린샷은 별도로 캡처되지 않았습니다 — 지속된 선택이 탭 전반에 시각적으로 반영된
  점과 선택 행/체크 표시 semantics를 switcher test suite가 이미 검증하는 점 때문에
  non-blocking입니다. 실제 live KMA/AirKorea/production API 호출은 없었습니다. Owner Ready gate
  이후 merge되어 현재 main에 포함되어 있습니다.
- **PR #96**(**MERGED**, new main `c3dc6518aaf069c76072dc53c957e7dae08efb63`)는 이미 존재하던
  `WeatherOverview.daily` 계약을, **이미 선택되고 정규화된 KMA 단기예보 hourly 데이터**에서
  파생해 채웁니다. **공개 계약과 `CONTRACT_VERSION`은 변경하지 않았고**(`DailyForecast`와
  `WeatherOverview.daily`, `DAILY` missing-section 검증은 원래부터 존재했습니다), **추가 provider
  요청도 없습니다**(새 KMA endpoint·두 번째 `getVilageFcst`·중기예보 API 없음). 새 순수 모듈
  `apps/api/src/services/kma-daily-from-hourly.ts`
  (`deriveKmaDailyForecastFromHourly`, 동기·clock-free·입력 불변)가 정책을 소유합니다 — 어떤 KST
  달력 일자는 `00:00`~`23:00` 24개 시각이 각각 정확히 한 건씩 있을 때만 발행되고, 부분적인 당일·
  잘린 마지막 날·시각 누락·같은 날짜/시각 중복·정시가 아닌 timestamp는 그 날짜를 통째로
  제외합니다(보간·값 생성 없음). `minimumTemperatureCelsius`/`maximumTemperatureCelsius`는 그 날
  **24개 hourly 기온**의 최소/최대이고, `morning`은 **09:00**, `afternoon`은 **15:00** 항목의
  `condition`과 `precipitationProbabilityPercent`를 그대로 복사하며(강수확률의 확정 `0`과 미제공
  `null` 의미 보존), `overall`·`sunriseAt`·`sunsetAt`은 항상 `null`입니다. 출력은 `date`
  오름차순이고 입력 순서와 무관하게 결정론적이며 각 항목은 contracts `dailyForecast` 스키마로
  검증합니다. production 연결은 기존 assembler
  `apps/api/src/services/kma-hourly-weather-overview.ts` 한 곳뿐입니다 — daily가 파생되면 `DAILY`가
  `missingSections`에서 빠지고 **같은** KMA source의 `sections`가 `['HOURLY', 'DAILY']`가 됩니다
  (가짜 `DERIVED` source 없음, `sourceId`/`provider`/`issuedAt`/`observedAt`/`fetchedAt`/
  `retrievalMode` 보존). 완전한 하루가 없으면 `daily: []`와 `DAILY` missing, `sections: ['HOURLY']`가
  유지되고, no-selection branch(hourly `[]`/daily `[]`/`HOURLY`+`DAILY` missing/sources `[]`)도
  그대로입니다. current/AirKorea overlay assembler는 baseline의 `daily`/`missingSections`/`sources`를
  이미 verbatim 보존하므로 재설계하지 않았습니다. `packages/contracts`, `CONTRACT_VERSION`,
  `packages/weather-core`, `apps/api/src/providers`, `routes`, `presenters`, `composition`,
  `index.ts`/`api-app.ts`, dependency·lockfile·env·Vercel config·모바일 앱은 변경하지 않았습니다.
  실제 KMA/AirKorea/production 호출, 배포, native build는 수행하지 않았습니다. 자세한 내용은
  [kma-hourly-weather-overview.md](./kma-hourly-weather-overview.md) 참고. 중기예보 D+4~D+10 확장은
  후속 작업이며, 이 `daily`를 소비하는 모바일 주간예보 UI는 PR #97입니다. 독립 Codex HIGH 리뷰와
  Owner Ready gate를 거쳐 merge되어 현재 main에 포함되어 있습니다.
- **PR #97**(현재 **OPEN Draft**, `feat/pr-97-mobile-weekly-forecast`, base
  `main@c3dc6518aaf069c76072dc53c957e7dae08efb63`)는 PR #96이 채우기 시작한 기존
  `WeatherOverview.daily`를 모바일에서 **읽기만** 해서 주간예보 화면으로 보여줍니다. **API·contract·
  `CONTRACT_VERSION`·provider·backend·store·dependency 변경이 없고**, 새 route 파일도 새 weather
  요청·query lifecycle도 추가하지 않습니다. 기존 `시간별` 하단 탭의 **표시 제목만 `예보`로**
  바뀌었고(탭 개수·순서·다른 탭 제목·navigation 구조는 그대로), 그 화면이 헤더 아래에
  `시간별 | 주간` 2-option segmented control을 갖습니다. 뷰 선택은 presentation 전용으로 기존
  `/hourly` route의 `view` search parameter에만 존재하며(`useLocalSearchParams` 읽기,
  `router.replace`로 전환, 저장하지 않음), 화면은 여전히 `useMobileSavedLocations()` 스냅샷 하나를
  그대로 `SavedLocationSwitcher`와 `useMobileWeatherQuery`에 넘깁니다 — 재구독·직접 fetch·
  generation/abort/retry/reset 의미 변경·TabsLayout lifecycle 소유권 변경이 없습니다. 기본값과
  인식되지 않는 값은 기존 시간별 timeline(고정 좌측 rail, 가로 snap, timezone 기반 local-date band,
  기온 그래프, null/0 표기)을 그대로 유지합니다. `view=weekly`는 `weatherQuery.data.data.daily`를
  **계약 순서 그대로** 하루 한 장의 카드로 렌더링합니다(모바일 재파생·정렬·dedupe·7일 padding 없음).
  `date`는 계약이 이미 검증한 달력 일자이므로 문자열에서 직접 읽고 요일만 UTC로 계산해 `M월 D일 (요일)`로
  표시하므로 host/device timezone이 날짜를 밀 수 없습니다. `최저`/`최고`는 공급된 값만 쓰고 `null`은
  `—`, `0`과 음수는 그대로 유지합니다. `overall`/`morning`/`afternoon`은 공급된 것만 각각 `종일`/
  `오전`/`오후`로 렌더링하고(누락 period를 다른 period로 유추하지 않음), 셋 다 `null`이면 기온은
  유지한 채 `날씨 정보 없음`만 표시합니다. 강수확률은 `null`이면 `강수 —`, `0`이면 `강수 0%`로 서로
  구분됩니다. `sunriseAt`/`sunsetAt`은 이번 PR UI에 노출하지 않습니다. SUCCESS인데 `daily`가 비어
  있으면 오류가 아니라 `표시할 주간 예보가 없습니다.` 카드를 보여주며 hourly로 대체하지 않습니다.
  변경 파일은 `apps/mobile/src/app/(tabs)/hourly.tsx`,
  `apps/mobile/src/app/(tabs)/_layout.tsx`와 대응 app-test 두 개뿐입니다. `packages/contracts`,
  `CONTRACT_VERSION`, `packages/weather-core`, `packages/lifestyle-engine`, `apps/api`,
  `apps/mobile/src/weather-api`, `weather-query`/`locations` production 파일,
  `SavedLocationSwitcher` 동작, package·lockfile·env·Expo/native config는 변경하지 않았습니다.
  실제 KMA/AirKorea/production 호출, 배포, EAS/native build는 수행하지 않았습니다. 중기예보
  D+4~D+10과 전체 하단 navigation 재구성은 여전히 후속 작업입니다. Owner의 로컬 synthetic
  `/weather` 서버 기반 Expo Web visual checkpoint(~412×915, synthetic 데이터만 사용)는
  **완료**되었고 결과는 **PASS**입니다 — Today 화면이 정상 렌더링되고, 하단 탭 라벨이 `예보`이며,
  `예보` 헤더와 우상단 저장 지역 선택기, `시간별 | 주간` segmented control이 모두 명확하게
  표시됨을 확인했습니다. `시간별` 선택 시 기존 가로 timeline이 고정 좌측 rail과 정렬을 유지한 채
  그대로 보존되고, `주간` 선택 시 synthetic daily 3건이 하루 한 장의 카드로 모바일 폭에 맞게
  렌더링되며 가로 clipping이 없음을 확인했습니다. 날짜(`8월 30일 (일)`, `8월 31일 (월)`,
  `9월 1일 (화)`), 최저·최고 기온, `오전`/`오후` 위계, 강수확률이 모두 가독 가능했고, `강수 0%`와
  누락 POP의 `강수 —`가 시각적으로 구분되는 것도 확인했습니다. 하단 navigation이 주간 콘텐츠를
  가리지 않았고, `시간별`로 되돌아가면 기존 timeline이 그대로 복원됐습니다. UI 수정은 필요하지
  않습니다. Ready 전환과 merge 승인은 여전히 Owner 결정이며, 그 전까지 PR은 OPEN Draft로
  유지됩니다.
- 이 문서는 다음 product PR을 임의로 확정하지 않습니다.
- 다음 product priority와 작업 scope는 Owner가 별도로 승인해야 합니다.
