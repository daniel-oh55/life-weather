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
  page·`fcstValue` literal null은 방어적 정책으로 두고 PR #5 실제 JSON 응답에서 재검증합니다.
  실제 HTTP 호출·`KMA_SERVICE_KEY` 읽기는 아직 없습니다(PR #5 예정). 자세한 내용은
  [kma-response-boundary.md](./kma-response-boundary.md) 참고.
- `packages/contracts` — 모바일과 API가 공유할 정규화 요청/응답 계약의 위치입니다. **현재
  상태**: PR #2에서 Zod 4 기반 공유 기상 데이터 계약을 정의했습니다. 자세한 내용은
  [contracts.md](./contracts.md) 참고.
- `packages/weather-core` — 공급자별 날씨 코드를 공통 날씨 상태로 정규화하고 기상 도메인 계산을
  수행할 위치입니다. **현재 상태**: PR #2의 결정론적 freshness 판정(`classifyFreshness`)에 더해,
  PR #3에서 기상청(KMA) 단기·초단기예보 정규화 primitive(`normalizeKmaWeatherCondition`,
  `parseKmaPrecipitationAmountMillimeters`, `parseKmaSnowfallAmountCentimeters`)를
  순수 함수로 구현했습니다. PCP/SNO 파서는 공식 no-amount(`강수없음`/`적설없음`/`-`/`0`)를 `0`으로,
  Missing 센티넬(수치 `>= 900`)과 파싱 불가·미제공을 `null`로 정규화합니다(PCP만 범위 지원, SNO
  범위 거부). 실제 KMA Provider 및 HTTP 호출은 아직 미구현입니다. 매핑 근거는
  [kma-normalization.md](./kma-normalization.md) 참고.
- `packages/lifestyle-engine` — 생활 날씨 지수(우산, 마스크, 옷차림 등)를 순수 함수로 계산할
  위치입니다. **현재 상태**: 스켈레톤만 존재합니다.
- `packages/config` — 비밀이 아닌 공유 설정/상수의 위치입니다. **현재 상태**: 스켈레톤만
  존재합니다.

## 모바일이 외부 공공데이터 API를 직접 호출하지 않는 이유

기상청/에어코리아 서비스 키는 서버(`apps/api`)에서만 관리합니다. 모바일 앱에 키를 포함시키면
디컴파일을 통해 키가 노출될 수 있고, 공공데이터 API의 요청 형식(날짜 포맷, 페이징, 오류 코드 등)
변경에 앱 배포 없이 대응할 수 없습니다. 따라서 모바일은 항상 `apps/api`를 통해서만 날씨 데이터를
조회하도록 설계할 예정입니다.

## API Provider 패턴 (도입 예정, 미구현)

향후 `apps/api`는 기상청/에어코리아 같은 각 외부 데이터 소스를 "Provider"로 캡슐화하는 패턴을
도입할 예정입니다. 각 Provider는 외부 API의 원시 응답을 가져오는 역할만 하고, 그 응답을 공통
모델로 변환하는 책임은 `packages/weather-core`가 가집니다. Provider(HTTP 호출) 자체는 아직
코드로 존재하지 않지만, KMA 원본 SKY/PTY/PCP/SNO 값을 공통 값으로 바꾸는 정규화 함수는 PR #3에서
`weather-core`에 구현되어, 후속 Provider가 원본 값을 이 함수들에 전달하기만 하면 되도록
준비되어 있습니다.

## 정규화 원칙 (적용 예정)

외부 API 응답(기상청 날씨 코드, 에어코리아 대기질 등급 등)은 API 계층에서 바로 모바일로
전달하지 않고, `packages/weather-core`에서 공통 내부 모델로 정규화한 뒤 `packages/contracts`에
정의된 계약 형태로 모바일에 전달할 예정입니다. 이렇게 하면 특정 공급자의 API가 바뀌더라도
모바일 앱과 생활지수 로직은 영향을 받지 않습니다.

## 생활지수 로직의 위치 원칙

우산/마스크/옷차림/빨래/세차/운동/출퇴근 등 생활 날씨 판단 로직은 `packages/lifestyle-engine`에
순수 TypeScript 함수로 구현할 예정입니다. React Native나 Node.js 런타임에 종속되지 않게 하여,
모바일과 API 양쪽에서 동일한 로직을 재사용하고 독립적으로 테스트할 수 있도록 합니다.

## 패키지 의존 방향 (PR #4 기준)

패키지 의존은 아래 방향만 허용하며, **순환 의존을 금지**합니다.

현재 상태:

```text
contracts    → zod
weather-core → (런타임 의존 없음; contracts는 타입 검증용 devDependency)
apps/api     → weather-core, zod, hono
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

향후 허용 방향:

```text
apps/api          → contracts, weather-core
apps/mobile       → contracts
lifestyle-engine  → contracts
```

## 현재 구현 상태 요약 (PR #4 시점)

- `contracts`: PR #2에서 Zod 4 기반 공유 기상 계약을 정의했습니다.
- `weather-core`: `classifyFreshness`(PR #2)와 KMA 단기·초단기예보 정규화 primitive(PR #3)가
  구현되어 있습니다. KMA 코드(SKY/PTY)와 범주형 수치(PCP/SNO)의 공통 값 정규화를 담당합니다.
  실제 KMA Provider·HTTP 호출·`ServiceKey` 처리는 아직 **미구현**(PR #5 예정)입니다.
- `apps/api`: `GET /health`에 더해, PR #4에서 KMA **원본 JSON 검증 및 slot extraction**
  경계(`src/providers/kma`)를 구현했습니다. 이 경계는 원본의 **field presence(필드 존재 여부)**를
  보존해, 원본의 명시적 null 값(`NULL`)과 필드 누락(`ABSENT`), 실제 값(`VALUE`)을 각각 구분합니다
  (순수 파서 단독으로는 이 구분이 불가능하기 때문입니다). 실제 HTTP 계층은 아직 **미구현**입니다.
- Provider HTTP 계층(fetch·서비스 키·timeout/retry·normalizer 연결·API route), 생활지수 계산
  (`lifestyle-engine`), `config`는 아직 **미구현**이며 스켈레톤만 존재합니다.
- 이 문서의 나머지 "예정" 구조는 앞으로의 합의이며, 위 요약이 현재 코드베이스의 상태입니다.
