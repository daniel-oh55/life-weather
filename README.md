# Life Weather

대한민국 사용자를 위한 생활밀착형 날씨 앱 — 기상청/에어코리아 데이터를 생활 속 결정(우산, 마스크, 옷차림, 빨래, 세차, 운동, 출퇴근)에 바로 쓸 수 있는 정보로 바꿔주는 것을 목표로 합니다.

## 현재 개발 단계

TypeScript pnpm 모노레포 위에 Hono API가 올라가 있으며, `GET /health`와 함께 `POST /weather`가 프로덕션에 마운트되어 실제로 호출 가능한 엔드포인트입니다. 현재 `POST /weather`는 기상청 SHORT_FORECAST(단기예보) 기반 시간별 예보(location hourly overview)를 제공합니다. 공통 런타임 패키지(`@life-weather/contracts`, `@life-weather/weather-core`)는 컴파일된 Node ESM `dist`를 진입점으로 사용합니다.

현재(current)/일별(daily)/대기질/특보 예보 섹션, 서버 응답 캐시, 그리고 모바일 API 클라이언트는 아직 구현되지 않았습니다.

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
- 공통 런타임 패키지(`contracts`, `weather-core`)는 컴파일된 Node ESM `dist`를 진입점으로 사용
- GitHub Actions CI (`lint` → `typecheck` → `test`)
- 환경변수 예시(`.env.example`)와 보안 관련 `.gitignore` 규칙

## 아직 구현하지 않은 항목

- 에어코리아 대기질 연동, 기상 특보(alerts) 연동
- `current`(현재)/`daily`(일별) 예보 섹션, 서버 응답 캐시
- 모바일 API 클라이언트와 화면 연결, 지역 데이터 모델, 위치 권한, 지역 저장소
- 화면 탭 구조, 디자인 시스템, 날씨 배경 이미지
- Android 위젯, AdMob SDK, 푸시 알림, 데이터베이스
- 실제 운영 Vercel 배포/도메인 연결, 실제 EAS 빌드, Android package name, 개인정보 처리방침

자세한 내용은 [`docs/product-scope.md`](docs/product-scope.md), [`docs/architecture.md`](docs/architecture.md), [`docs/development.md`](docs/development.md)를 참고하세요.

## 저장소 운영 문서

- [AI 운영 정책](AGENTS.md)
- [AI 작업 흐름](docs/AI_WORKFLOW.md)
- [현재 프로젝트 상태](docs/PROJECT_STATE.md)
