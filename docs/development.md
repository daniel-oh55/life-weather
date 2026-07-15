# 개발 가이드

## Node / pnpm 준비

- Node.js `22.x`를 사용하세요 (`.nvmrc` 참고). nvm 계열 도구를 사용한다면 저장소 루트에서
  `nvm use`를 실행하세요.
- 패키지 매니저는 pnpm입니다. Corepack을 사용하면 루트 `package.json`의 `packageManager` 필드에
  고정된 버전이 자동으로 활성화됩니다.

  ```bash
  corepack enable
  ```

## 설치

저장소 루트에서 한 번만 실행합니다. 하위 앱/패키지 디렉터리에서 개별적으로 `install`을 실행하지
마세요 — lockfile은 루트에 하나만 존재해야 합니다.

```bash
pnpm install
```

## 모바일 실행

```bash
pnpm dev:mobile
```

이 명령은 `expo start --dev-client`를 실행합니다. Expo Go가 아닌 **Development Build**에서
실행하는 것을 전제로 합니다.

### Development Build 준비 방식

- `expo-dev-client`가 이미 설치되어 있습니다.
- `apps/mobile/eas.json`에 최소한의 `development` 프로파일이 정의되어 있습니다. 이 PR에서는
  실제 EAS 프로젝트 연결이나 원격 빌드를 수행하지 않습니다.
- Android package name과 EAS project ID가 아직 확정되지 않았으므로, 실제 Development Build
  실행은 이 PR의 완료 조건이 아닙니다.
- Continuous Native Generation을 유지합니다: `android/`, `ios/` 디렉터리는 로컬에서
  `expo prebuild`로 생성할 수 있지만 저장소에는 커밋하지 않습니다.

## API 실행 방식

```bash
pnpm dev:api
```

이 명령은 `vercel dev`를 실행합니다. 처음 실행하면 Vercel CLI가 프로젝트 연결을 위한 로그인/링크
과정을 요구할 수 있습니다 — 이 PR에서는 실제 Vercel 프로젝트 연결을 하지 않으므로, 로컬 개발
환경에서 필요할 때 각자 진행하세요.

## 검사 명령

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm check   # lint → typecheck → test
```

## 환경변수 관리

- `apps/api/.env.example`을 복사해 `apps/api/.env.local`을 만들고 실제 값을 채우세요.
- `.env`, `.env.local`, `.env.*.local`은 Git에서 제외되므로 실수로 커밋되지 않습니다.
- 기상청/에어코리아 서비스 키는 `apps/api`에서만 사용하세요. 모바일 앱이나 공유 패키지에는
  절대 추가하지 마세요.

## 커밋하지 말아야 할 것

- 네이티브 디렉터리: `apps/mobile/android/`, `apps/mobile/ios/`
- 비밀정보: `.env`, `.env.local`, `.env.*.local`
- 로컬 도구 상태: `.vercel/`, `.expo/`
- 빌드 산출물과 테스트 커버리지 리포트
