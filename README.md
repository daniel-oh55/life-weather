# Life Weather

대한민국 사용자를 위한 생활밀착형 날씨 앱 — 기상청/에어코리아 데이터를 생활 속 결정(우산, 마스크, 옷차림, 빨래, 세차, 운동, 출퇴근)에 바로 쓸 수 있는 정보로 바꿔주는 것을 목표로 합니다.

## 현재 개발 단계

TypeScript pnpm 모노레포 위에 Hono API가 올라가 있으며, `GET /health`와 함께 `POST /weather`가 프로덕션에 마운트되어 실제로 호출 가능한 엔드포인트입니다. 현재 `POST /weather`는 기상청 SHORT_FORECAST(단기예보) 기반 시간별 예보(location hourly overview)를 제공합니다. 공통 런타임 패키지(`@life-weather/contracts`, `@life-weather/weather-core`)는 컴파일된 Node ESM `dist`를 진입점으로 사용합니다.

현재(current)/일별(daily)/대기질/특보 예보 섹션과 서버 응답 캐시는 아직 구현되지 않았습니다. 모바일에는 `POST /weather` 계약을 안전하게 소비하는 contract-safe API 클라이언트 경계가 추가되었지만, 아직 화면에는 연결되어 있지 않습니다. 또한 기기에 저장될 지역 한 건의 로컬 모델과 이를 공유 `WeatherRequestV1`으로 변환하는 순수 경계, 여러 지역을 canonical collection으로 관리하는 순수 경계(추가·삭제·재정렬·현재 위치 설정/해제와 그 불변조건), 그리고 그 collection을 버전된 V1 envelope로 encode/decode하고 주입된 key-value 경계로 load·save·clear하는 persistence 경계(`apps/mobile/src/locations`)가 추가되었습니다. 이 persistence 경계는 이제 실제 `@react-native-async-storage/async-storage`(2.2.0) 기기 저장소에 연결하는 concrete production binding(`mobile-saved-location-async-storage.ts`, `mobileSavedLocationPersistence`)을 갖췄습니다. 그 위에 이 persistence를 주입받아 collection을 hydrate하고 `NOT_STARTED`/`LOADING`/`EMPTY`/`READY`/`ERROR` 상태로 노출하는 provider-neutral hydration manager(`mobile-saved-location-hydration-manager.ts`)가 추가되었고, 그 위에 이 manager를 감싸 안정적인 deep-frozen cached snapshot과 semantic transition에만 알리는 subscribe/unsubscribe 계약을 제공하는 provider-neutral observable hydration store(`mobile-saved-location-hydration-store.ts`, 향후 React `useSyncExternalStore` 소비를 겨냥)가 추가되었습니다. 이제 이 manager와 store를 실제로 조립하는 production composition(`mobile-saved-location-hydration-production.ts`, `mobileSavedLocationHydrationManager`·`mobileSavedLocationHydrationStore`)이 추가되었고, 이 store의 `hydrate()`를 앱 시작(root layout mount effect) 시 한 번만 호출하는 one-shot startup boundary(`mobile-saved-location-hydration-startup.ts`, `startMobileSavedLocationHydrationOnce`)도 추가되었습니다. 이제 이 production store를 구독하는 React `useSyncExternalStore` hook(`use-mobile-saved-location-hydration.ts`, `useMobileSavedLocationHydration`)도 추가되었습니다 — store의 exact cached snapshot을 그대로 반환하고, 안정적인 module-scope subscribe/getSnapshot callback을 client/server 동일하게 사용하며, hook의 import·호출만으로는 `hydrate()`나 storage I/O가 발생하지 않습니다. 다만 이 hook을 소비하는 화면, React Context/Provider, 지역 mutation/save, 마이그레이션 실행, 위치 권한은 아직 구현되지 않았고, 현재 설치된 development build는 재빌드하기 전까지 이 새 native module을 포함하지 않으며 실제 기기 QA는 수행되지 않았습니다.

## 확정 기술 스택

- **런타임/패키지 매니저**: Node.js 22.x, pnpm 11.x (pnpm workspace, Turborepo/Nx 미사용)
- **모바일**: Expo SDK 57, React Native 0.86, Expo Router, `expo-dev-client` (Development Build, Continuous Native Generation), TypeScript strict, Android 우선
- **API**: Hono, Vercel 배포 호환 구조, TypeScript strict
- **공통 패키지**: `@life-weather/contracts`, `@life-weather/weather-core`, `@life-weather/lifestyle-engine`, `@life-weather/config`
- **테스트**: Vitest

## 디렉터리 구조

```
apps/
  mobile/    # Expo SDK 57 + Expo Router 모바일 앱
  api/       # Hono API (Vercel 배포 대상)
packages/
  contracts/         # 모바일-API 공유 요청/응답 계약
  weather-core/      # 날씨 코드 정규화 및 기상 도메인 계산
  lifestyle-engine/  # 생활 날씨 지수 계산 (우산/옷차림/마스크/빨래)
  config/            # 비밀이 아닌 공유 설정/상수 (스켈레톤)
docs/        # 제품 범위, 아키텍처, 개발 가이드 문서
```

## 요구 버전

- Node.js: `22.x` (`.nvmrc` 참고)
- pnpm: `11.x` (루트 `package.json`의 `packageManager` 참고)

## 설치 방법

```bash
pnpm install
```

`pnpm install`은 설치 직후 루트 `postinstall`로 공유 런타임 패키지(`@life-weather/contracts`, `@life-weather/weather-core`)를 컴파일해 `dist/`를 자동 생성합니다. 따라서 새로 클론한 clean checkout에서도 별도의 수동 빌드 없이 `pnpm typecheck`/`pnpm test`가 바로 동작합니다. `dist/`는 계속 Git에 커밋하지 않습니다(gitignored).

## 개발 명령

```bash
pnpm dev:mobile   # Expo 개발 서버 (--dev-client)
pnpm dev:api      # 공유 패키지 dist 재빌드 후 Hono API 로컬 개발 서버 (vercel dev)
```

## 검사 명령

```bash
pnpm lint         # 존재하는 패키지에서 lint 실행
pnpm typecheck    # 공유 dist를 먼저 재빌드한 뒤 전체 워크스페이스 타입체크
pnpm test         # 공유 dist를 먼저 재빌드한 뒤 전체 워크스페이스 테스트
pnpm check        # 공유 dist를 한 번만 빌드 → verify → lint → typecheck → test 순서로 실행
```

공유 런타임 패키지(`@life-weather/contracts`, `@life-weather/weather-core`)는 컴파일된 `dist/`를 진입점으로 사용하므로, 검사 명령은 항상 최신 소스로 `dist`를 먼저 재빌드하도록 구성되어 있습니다.

- `pnpm typecheck`/`pnpm test`는 실행 시 공유 `dist`를 먼저 재빌드합니다. 따라서 공유 패키지 소스를 수정한 뒤 이 명령만 단독으로 실행해도 항상 최신 소스를 검사하며, 오래된(stale) `dist`를 그대로 재사용하지 않습니다.
- `pnpm check`는 공유 `dist`를 **정확히 한 번만** 빌드하고, 내부적으로는 build 단계가 없는 워크스페이스 전용 검사 명령(`typecheck:workspace`, `test:workspace`)을 사용합니다. 따라서 한 번의 `check` 안에서 공유 빌드가 중복 실행되지 않습니다.
- `apps/api` 및 공유 컴파일 패키지를 소비하는 패키지(`packages/weather-core`, `packages/lifestyle-engine`)의 개별 `typecheck`/`test`도 build-first입니다. 예를 들어 `pnpm --filter @life-weather/api run typecheck`처럼 패키지 범위로 실행해도 공유 `dist`를 먼저 재빌드합니다.
- `dist/`는 계속 Git에 커밋하지 않습니다(gitignored/untracked).

## API 키 보안 원칙

- 기상청/에어코리아 등 외부 API 키는 `apps/api`에서만 사용합니다. 모바일 앱과 공유 패키지에는 절대 포함하지 않습니다.
- 실제 키 값은 커밋하지 않습니다. `apps/api/.env.example`에 변수명만 정의되어 있으며 값은 비어 있습니다.
- `.env`, `.env.local`, `.env.*.local`은 Git에서 제외됩니다.
- `packages/config`는 비밀이 아닌 설정만 다루며, 서버 API 키나 AdMob 운영 ID를 두지 않습니다.

## 현재 구현 범위

- pnpm workspace 기반 모노레포 (apps/mobile, apps/api, packages/*)
- Expo SDK 57 + Expo Router 최소 실행 화면, `expo-dev-client` 설치
- Hono API의 `GET /health` 엔드포인트와 프로덕션에 마운트된 `POST /weather` 엔드포인트, 그리고 각 테스트
- 기상청 SHORT_FORECAST(단기예보) 기반 시간별 예보(location hourly overview) 프로덕션 그래프를 `POST /weather` 라우트에 연결
- 모바일 `POST /weather` contract-safe API 클라이언트 경계(`apps/mobile/src/weather-api`): 공유 계약을 직접 소비해 요청·응답을 런타임 검증하고 전송/검증 오류를 typed result로 구분(화면 연결·실제 호출 없음)
- 모바일 저장 지역 경계(`apps/mobile/src/locations`): 공유 `weatherLocation`을 확장한 저장 지역 한 건 strict schema(`kmaGrid`/`isCurrent`/`sortOrder` 로컬 전용 필드)와 저장 지역을 공유 `WeatherRequestV1`으로 명시적으로 변환하는 순수 함수, 여러 지역을 canonical collection으로 관리하는 순수 경계(collection schema 불변조건 + 추가·삭제·재정렬·현재 위치 설정/해제 operation; 입력 불변·fresh output·고정 비노출 오류), 그리고 그 collection을 위한 versioned V1 persistence codec + 주입된 key-value 경계의 load·save·clear(안정적인 storage key·손상/미지원 버전 fail-closed·저장 실패 시 무결성 보존). 이 persistence 경계는 이제 실제 `@react-native-async-storage/async-storage`(2.2.0, unencrypted key-value 저장소) 기기 저장소에 연결하는 concrete production binding(`mobile-saved-location-async-storage.ts`)을 갖췄습니다 — pure barrel(`index.ts`)은 이 native binding을 export하지 않으며, import·instance 생성만으로는 storage I/O를 수행하지 않습니다. 이 persistence를 주입받아 hydration을 `NOT_STARTED`/`LOADING`/`EMPTY`/`READY`/`ERROR` 상태로 관리하는 provider-neutral hydration manager(`mobile-saved-location-hydration-manager.ts`, 같은 pure barrel에서 export)도 추가되었습니다 — 단일 in-flight hydration, 성공 후 idempotent, 실패 후 retry, 고정 비노출 오류를 제공합니다. 그 위에 이 manager를 감싸는 provider-neutral observable hydration store(`mobile-saved-location-hydration-store.ts`, 같은 pure barrel에서 export)도 추가되었습니다 — `getSnapshot()`은 실제 semantic transition까지 동일 object reference를 반환하는 stable하고 deep-frozen된 cached snapshot이고(값 비교는 참조가 아닌 field 단위 semantic equality), `subscribe(listener)`는 등록 즉시 호출되지 않고 transition에만 알리며 idempotent한 unsubscribe를 반환하고, `hydrate()`는 manager의 exact Promise reference를 그대로 반환하면서 concurrent·reentrant 호출에도 manager 호출과 settlement observer를 중복시키지 않습니다. React `useSyncExternalStore` hook 자체는 이 PR 범위 밖입니다. 이 AsyncStorage binding·hydration manager·store를 실제로 조립하는 production composition(`mobile-saved-location-hydration-production.ts`, `mobileSavedLocationHydrationManager`·`mobileSavedLocationHydrationStore`)도 추가되었습니다 — production persistence를 manager factory에, 그 manager를 store factory에 각각 정확히 한 번 주입하는 module scope singleton 두 개이며, import만으로는 storage I/O나 `hydrate()` 호출이 없고, 둘 다 pure barrel에서는 export되지 않습니다. 이 store의 `hydrate()`를 실제 앱 시작 시 호출하는 one-shot startup boundary(`mobile-saved-location-hydration-startup.ts`, `startMobileSavedLocationHydrationOnce`)도 추가되었습니다 — root layout의 mount effect(`apps/mobile/src/app/_layout.tsx`)에서 호출되고, module scope에 첫 store Promise를 저장해 반복·동시 호출에도 실제 `hydrate()`는 정확히 한 번만 실행되며, 첫 결과가 `ERROR`여도 자동 재시도하지 않습니다(향후 명시적 retry는 이 store의 `hydrate()`를 직접 호출). 이제 이 store를 `useSyncExternalStore`로 구독하는 React hook(`use-mobile-saved-location-hydration.ts`, `useMobileSavedLocationHydration()`)도 추가되었습니다 — 안정적인 module-scope subscribe/client·server getSnapshot callback을 사용하고, store의 exact cached snapshot 참조를 그대로 반환하며, hook은 `hydrate()`를 호출하지 않고 pure barrel에서는 export되지 않습니다. 화면 연결·React Context/Provider·지역 mutation/save·마이그레이션 실행·위치 권한은 아직 없고, 현재 development build는 재빌드 전까지 이 native module을 포함하지 않습니다(EAS/native build·실제 기기 QA 미수행)
- 공통 런타임 패키지(`contracts`, `weather-core`)는 컴파일된 Node ESM `dist`를 진입점으로 사용
- GitHub Actions CI (`lint` → `typecheck` → `test`)
- 환경변수 예시(`.env.example`)와 보안 관련 `.gitignore` 규칙

## 아직 구현하지 않은 항목

- 에어코리아 대기질 연동, 기상 특보(alerts) 연동
- `current`(현재)/`daily`(일별) 예보 섹션, 서버 응답 캐시
- 모바일 API 클라이언트의 화면 연결, 저장 지역의 React state/화면 연결과 마이그레이션 실행, 위치 권한, 현재 위치 조회 (지역 저장소의 concrete AsyncStorage provider binding, provider-neutral hydration manager, 그 manager를 감싸는 provider-neutral observable hydration store, 이 셋의 production composition, 그 store를 경유하는 app-start one-shot `hydrate()` 호출, 그리고 그 store를 구독하는 React `useSyncExternalStore` hook(`useMobileSavedLocationHydration`)은 구현됨; hook을 소비하는 화면, React Context/Provider, 지역 mutation/save는 미구현)
- 화면 탭 구조, 디자인 시스템, 날씨 배경 이미지
- Android 위젯, AdMob SDK, 푸시 알림, 데이터베이스
- 실제 운영 Vercel 배포/도메인 연결, 실제 EAS 빌드, Android package name, 개인정보 처리방침

자세한 내용은 [`docs/product-scope.md`](docs/product-scope.md), [`docs/architecture.md`](docs/architecture.md), [`docs/development.md`](docs/development.md)를 참고하세요.

## 저장소 운영 문서

- [AI 운영 정책](AGENTS.md)
- [AI 작업 흐름](docs/AI_WORKFLOW.md)
- [현재 프로젝트 상태](docs/PROJECT_STATE.md)
