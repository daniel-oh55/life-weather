# @life-weather/mobile

Life Weather의 모바일 앱입니다. Expo SDK 57 + Expo Router 기반이며, Expo Go가 아닌
**Development Build**(`expo-dev-client`) 방식으로 개발합니다.

## 실행

의존성 설치는 항상 **저장소 루트**에서 합니다. 이 디렉터리에서 개별적으로 install을 실행하지
마세요 — lockfile은 루트에 하나만 존재해야 합니다.

```bash
pnpm install
pnpm dev:mobile
```

`pnpm dev:mobile`은 `expo start --dev-client`를 실행합니다.

## 코드 위치

- 화면과 라우팅: `apps/mobile/src/app` (Expo Router file-based routing)
- 라우트가 아닌 코드는 `src` 아래의 다른 디렉터리에 둡니다.

## Development Build

- `eas.json`에 최소한의 `development` 프로파일이 정의되어 있습니다.
- 실제 Development Build(로컬 또는 EAS)는 Android package name과 EAS project ID가 확정된 후
  진행합니다. 현재는 둘 다 미확정 상태입니다.

## 주의

- Continuous Native Generation을 유지합니다. `android/`, `ios/` 디렉터리는 로컬에서
  `expo prebuild`로 생성할 수 있지만 **커밋하지 않습니다** (`.gitignore`에 포함됨).
- 기상청/에어코리아 등 외부 API 키를 이 앱에 절대 추가하지 마세요. 외부 API 호출은
  `apps/api`를 통해서만 합니다.
