# Life Weather

대한민국 사용자를 위한 생활밀착형 날씨 앱 — 기상청/에어코리아 데이터를 생활 속 결정(우산, 마스크, 옷차림, 빨래, 세차, 운동, 출퇴근)에 바로 쓸 수 있는 정보로 바꿔주는 것을 목표로 합니다.

## 현재 개발 단계

**PR #1 — 초기화 단계.** 실제 날씨 기능은 아직 없습니다. 이번 PR은 모바일 앱, 백엔드 API, 공통 도메인 패키지를 안전하게 개발할 수 있는 TypeScript 모노레포 기반만 구성합니다.

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
  contracts/         # 모바일-API 공유 요청/응답 계약 (스켈레톤)
  weather-core/      # 날씨 코드 정규화 및 기상 도메인 계산 (스켈레톤)
  lifestyle-engine/  # 생활 날씨 지수 계산 (스켈레톤)
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

## 개발 명령

```bash
pnpm dev:mobile   # Expo 개발 서버 (--dev-client)
pnpm dev:api      # Hono API 로컬 개발 서버 (vercel dev)
```

## 검사 명령

```bash
pnpm lint         # 존재하는 패키지에서 lint 실행
pnpm typecheck    # 전체 워크스페이스 타입체크
pnpm test         # 전체 워크스페이스 테스트
pnpm check        # lint → typecheck → test 순서로 실행
```

## API 키 보안 원칙

- 기상청/에어코리아 등 외부 API 키는 `apps/api`에서만 사용합니다. 모바일 앱과 공유 패키지에는 절대 포함하지 않습니다.
- 실제 키 값은 커밋하지 않습니다. `apps/api/.env.example`에 변수명만 정의되어 있으며 값은 비어 있습니다.
- `.env`, `.env.local`, `.env.*.local`은 Git에서 제외됩니다.
- `packages/config`는 비밀이 아닌 설정만 다루며, 서버 API 키나 AdMob 운영 ID를 두지 않습니다.

## 현재 구현 범위

- pnpm workspace 기반 모노레포 (apps/mobile, apps/api, packages/*)
- Expo SDK 57 + Expo Router 최소 실행 화면, `expo-dev-client` 설치
- Hono API의 `GET /health` 엔드포인트와 테스트
- 4개 공통 패키지의 컴파일 가능한 최소 스켈레톤과 README
- GitHub Actions CI (`lint` → `typecheck` → `test`)
- 환경변수 예시(`.env.example`)와 보안 관련 `.gitignore` 규칙

## PR #1에서 구현하지 않은 항목

- 기상청/에어코리아 API 연동, Provider 패턴
- 공통 날씨 데이터 모델, 날씨 코드 정규화, 생활지수 계산
- 지역 데이터 모델, 위치 권한, 지역 저장소
- 화면 탭 구조, 디자인 시스템, 날씨 배경 이미지
- Android 위젯, AdMob SDK, 푸시 알림, 캐시, 데이터베이스
- 실제 Vercel 프로젝트 연결/배포, 실제 EAS 빌드
- Android package name, 개인정보 처리방침, 운영 도메인

자세한 내용은 [`docs/product-scope.md`](docs/product-scope.md), [`docs/architecture.md`](docs/architecture.md), [`docs/development.md`](docs/development.md)를 참고하세요.
