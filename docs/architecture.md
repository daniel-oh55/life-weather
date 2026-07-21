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
  live availability fallback/retry 정책·`WeatherOverview` 조립·`/weather` API route·HTTP status
  mapping은 여전히 **미구현**(후속 PR)이며, 별도 general `config` package도 여전히 미구현입니다.
  자세한 내용은
  [kma-response-boundary.md](./kma-response-boundary.md),
  [kma-http-provider.md](./kma-http-provider.md),
  [kma-hourly-normalization.md](./kma-hourly-normalization.md),
  [kma-hourly-service.md](./kma-hourly-service.md),
  [kma-forecast-request-factory.md](./kma-forecast-request-factory.md),
  [kma-scheduled-hourly-facade.md](./kma-scheduled-hourly-facade.md),
  [kma-production-composition.md](./kma-production-composition.md),
  [kma-location-scheduled-hourly.md](./kma-location-scheduled-hourly.md) 참고.
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
candidate selector와 PR #17 classifier는 **아직 production graph에서 조합되지 않았고**, Provider raw
error·normalization issue surface·기존 service result 계약은 변경되지 않았습니다(classifier는
orchestration 전 단계의 순수 정책 component이며 route·cache는 여전히 미구현).

향후 허용 방향:

```text
apps/api          → contracts, weather-core
apps/mobile       → contracts
lifestyle-engine  → contracts
```

## 현재 구현 상태 요약 (PR #17 시점)

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
  issuance interval만 소유하고 아직 apps/api 미연결),
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
  3시간·ULTRA 1시간 issuance interval만 소유하고, **아직 request factory·composition·route 어디에도
  연결되지 않았습니다**(production은 여전히 facade 호출당 KMA request 최대 1회, retry/fallback 실행 없음).
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
  selector와 이 classifier는 **아직 production graph에서 조합되지 않았으며**(dependency cycle 없음),
  실제 fallback 실행·retry·route·cache는 없습니다([kma-fallback-eligibility.md](./kma-fallback-eligibility.md)).
- 이 문서의 나머지 "예정" 구조는 앞으로의 합의이며, 위 요약이 현재 코드베이스의 상태입니다.
