# Life Weather 프로젝트 상태

- 기준일: 2026-07-29
- State baseline: `f19c268c68fa6db82af6b432cc79e8466a3202b1`

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
- `KMA_SERVICE_KEY`는 server-only이며 누락 시 startup에서 fail-fast합니다.
- startup 과정에서는 외부 fetch를 수행하지 않습니다.
- `contracts`와 `weather-core`는 compiled `dist` entrypoint를 사용합니다.
- `postinstall`과 public checks의 build-first 흐름은 clean checkout과 stale `dist` 문제를
  방지합니다.
- `lifestyle-engine`에는 umbrella, outfit, mask와 laundry 정책이 구현되어 있습니다.
- baseline 시점에 열린 PR은 없습니다.

## 아직 구현되지 않은 항목

- daily section (아래 current-observation 관련 서술은 PR #63~#80의 historical implementation
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
- 이 문서는 다음 product PR을 임의로 확정하지 않습니다.
- 다음 product priority와 작업 scope는 Owner가 별도로 승인해야 합니다.
