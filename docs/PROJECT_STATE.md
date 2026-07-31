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
- `POST /weather`는 현재 KMA `SHORT_FORECAST` 기반 location hourly overview를 제공합니다.
- `KMA_SERVICE_KEY`는 server-only이며 누락 시 startup에서 fail-fast합니다.
- startup 과정에서는 외부 fetch를 수행하지 않습니다.
- `contracts`와 `weather-core`는 compiled `dist` entrypoint를 사용합니다.
- `postinstall`과 public checks의 build-first 흐름은 clean checkout과 stale `dist` 문제를
  방지합니다.
- `lifestyle-engine`에는 umbrella, outfit, mask와 laundry 정책이 구현되어 있습니다.
- baseline 시점에 열린 PR은 없습니다.

## 아직 구현되지 않은 항목

- current/daily sections
- AirKorea air quality
- alerts
- response cache
- mobile API client의 화면 연결 (contract-safe `POST /weather` client boundary
  `apps/mobile/src/weather-api`는 구현됨 — 요청·응답 계약 소비와 typed 오류 경계까지; 화면 연결·실제
  호출은 미구현)
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
  않았습니다. 반면 지역 검색 데이터·검색/추가 UI: 미구현, 선택 지역 상태: 미구현, reorder UI:
  미구현, React Context/Provider: 미구현, migration execution: 미구현, 위치 권한: 미구현이고,
  development client rebuild 및 실제 기기 QA: 미수행입니다)
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
- 이 문서는 다음 product PR을 임의로 확정하지 않습니다.
- 다음 product priority와 작업 scope는 Owner가 별도로 승인해야 합니다.
