# KMA 시간별 예보 정규화 (HourlyForecast)

이 문서는 PR #6에서 기상청(KMA) 단기·초단기예보 Provider가 반환하는 forecast slot을 공통
`@life-weather/contracts`의 `HourlyForecast` 배열로 정규화하는 규칙을 기록합니다. 근거는 아래
공식 자료이며, 블로그·개인 저장소·비공식 정리 문서는 사용하지 않았습니다.

## 목적과 책임 경계

이 PR은 **순수 정규화 adapter만** 추가합니다. 네트워크 호출을 새로 구현하지 않습니다.

- `packages/weather-core` — KMA 원본 scalar 문자열(TMP/T1H·POP/REH·WSD·VEC)을 공통 숫자로 바꾸는
  순수 함수. contracts·Zod 런타임 의존이 없습니다.
  - [scalar.ts](../packages/weather-core/src/kma/scalar.ts) — 일반 수치 category parser
  - [amount.ts](../packages/weather-core/src/kma/amount.ts) — PCP/RN1(mm)·SNO(cm) 범주형 parser (PR #3)
  - [condition.ts](../packages/weather-core/src/kma/condition.ts) — SKY/PTY → `WeatherCondition` (PR #3)
- `apps/api/src/providers/kma` — slot의 product·category·field presence를 해석하고 weather-core
  함수를 호출해 `HourlyForecast`를 조립.
  - [normalize-hourly.ts](../apps/api/src/providers/kma/normalize-hourly.ts) — slot adapter
- `packages/contracts` — 최종 `HourlyForecast` runtime schema와 타입.
  - [weather.ts](../packages/contracts/src/weather.ts) — `hourlyForecast`

이 PR에서 **구현하지 않는 것**: `WeatherOverview` 조립, `SourceMetadata`, `fetchedAt`/`issuedAt`,
현재 날씨(`CurrentWeather`), 일별 예보(`DailyForecast`, `TMN`/`TMX`), 체감온도 계산, 생활지수,
자동 발표시각 선택, 위경도→grid 변환, 공통 Provider interface, API route, 모바일 연결.

## 공식 자료

| 항목 | 값 |
| --- | --- |
| 공식 서비스명 | 기상청_단기예보 조회서비스 |
| 공공데이터 ID | `15084084` |
| 서비스(오퍼레이션) 버전 | `VilageFcstInfoService_2.0` |
| 공식 활용가이드 | `기상청41_단기예보 조회서비스_오픈API활용가이드_2607.zip` |
| 대상 operation | `getVilageFcst`(단기예보), `getUltraSrtFcst`(초단기예보) |
| 확인 날짜 | 2026-07-17 |
| 확인 주체 | Claude (Claude Code) |

재확인 방법: 공공데이터포털 데이터 상세(`publicDataPk=15084084`)의 활용가이드와, 동일 서비스의
기상청 API 허브(`apihub.kma.go.kr`, `VilageFcstInfoService_2.0`) 활용가이드 DOCX "코드값 정보" 및
"특정 요소의 코드값 및 범주" 절을 원문으로 확인했습니다. 공식 ZIP/DOCX는 저장소에 커밋하지
않습니다. SKY/PTY·PCP/SNO 규칙의 SHA-256 검증 기록은
[kma-normalization.md](./kma-normalization.md)에 있습니다.

## Product별 category mapping

공식 "코드값 정보" 표에서 재확인한 category와 단위입니다.

### 단기예보 `getVilageFcst` — `SHORT_FORECAST`

| HourlyForecast field | KMA category | 공식 단위/의미 |
| --- | --- | --- |
| `temperatureCelsius` | `TMP` | 1시간 기온 (℃) |
| `condition` | `SKY` + `PTY` | 하늘상태 + 강수형태 (코드값) |
| `precipitationProbabilityPercent` | `POP` | 강수확률 (%) |
| `precipitationAmountMillimeters` | `PCP` | 1시간 강수량 (범주, 1 mm) |
| `snowfallAmountCentimeters` | `SNO` | 1시간 신적설 (범주, 1 cm) |
| `humidityPercent` | `REH` | 습도 (%) |
| `windSpeedMetersPerSecond` | `WSD` | 풍속 (m/s) |
| `windDirectionDegrees` | `VEC` | 풍향 (deg) |

### 초단기예보 `getUltraSrtFcst` — `ULTRA_SHORT_FORECAST`

| HourlyForecast field | KMA category | 공식 단위/의미 |
| --- | --- | --- |
| `temperatureCelsius` | `T1H` | 기온 (℃) |
| `condition` | `SKY` + `PTY` | 하늘상태 + 강수형태 (코드값) |
| `precipitationProbabilityPercent` | `POP` | 강수확률(%), 2026-06-23 12 KST 이후 초단기예보 제공 |
| `precipitationAmountMillimeters` | `RN1` | 1시간 강수량 (범주, 1 mm) |
| `snowfallAmountCentimeters` | (없음) | 초단기예보는 신적설 미제공 → `null` |
| `humidityPercent` | `REH` | 습도 (%) |
| `windSpeedMetersPerSecond` | `WSD` | 풍속 (m/s) |
| `windDirectionDegrees` | `VEC` | 풍향 (deg) |

### TMP / T1H 차이

- 온도 category가 상품마다 다릅니다: 단기예보는 `TMP`(1시간 기온), 초단기예보는 `T1H`(기온).
  둘 다 ℃ 실수 문자열이며 동일한 `parseKmaTemperatureCelsius`로 파싱합니다. 정규화 로직은
  slot의 product에 따라 올바른 category를 선택합니다.

### 제외 category

다음 category는 이번 hourly 조립에 **사용하지 않으며**, raw 계약이나 공통 contract에 추가하지
않습니다.

| category | 이유 |
| --- | --- |
| `UUU` / `VVV` | 현재 contract에 바람 vector 성분 field가 없음 |
| `WAV` | 육상 HourlyForecast에 파고 field가 없음 |
| `TMN` / `TMX` | 일 최저·최고기온 → DailyForecast 범위 |
| `LGT` | SKY/PTY condition normalizer 범위에서 제외 결정 유지 (PR #3) |

알 수 없는(미지) category도 무시하며, raw category명·raw 값은 출력에 전달하지 않습니다.

## PCP / RN1 차이와 공식 근거

- **공식 근거:** 활용가이드 "특정 요소의 코드값 및 범주" 절은 강수량 범주를
  **"초단기예보, 단기예보 강수량(RN1, PCP) 범주 및 표시방법(값)"** 이라는 하나의 표로 제시합니다.
  즉 `RN1`(초단기)과 `PCP`(단기)는 **동일한 범주·문자열 표시·반환 단위(mm)** 를 씁니다.
- 확인한 범주/문자열:

  | 범주 | 문자열표시 |
  | --- | --- |
  | `0.1 ~ 1.0mm 미만` | `1.0mm 미만` |
  | `1.0mm 이상 30.0mm 미만` | 값 + `mm` (예 `1.0~29.0mm`) |
  | `30.0mm 이상 50.0mm 미만` | `30.0~50.0mm` |
  | `50.0mm 이상` | `50.0mm 이상` |
  | `-`, `null`, `0` | `강수없음` |

- **적용 방식:** RN1의 원본 grammar가 PCP와 동일함이 공식적으로 확인되므로, RN1을 위한 별도
  parser를 만들지 않고 기존 `parseKmaPrecipitationAmountMillimeters`를 **그대로 재사용**합니다.
  두 category 모두 반환 단위는 mm이며, 기존 PCP 동작은 회귀 없이 유지됩니다.
- 강수량 정책은 [kma-normalization.md](./kma-normalization.md)의 PCP 규칙과 동일합니다:
  `강수없음`/`-`/`0` → `0`, `T 미만` → `T/2`, 범위 → 하한, `T 이상` → 하한, Missing(`>= 900`)·파싱
  실패·미제공 → `null`.

## 초단기예보 POP 정책

- **공식 근거:** 기상청 API 허브(`apihub.kma.go.kr`, `seqApi=10`)의 `2.2 초단기예보` 예보변수
  목록은 **`POP(강수확률)`을 `2026.6.23. 12KST 이후부터 제공`** 한다고 명시합니다(확인일
  2026-07-17). 즉 초단기예보(`getUltraSrtFcst`)도 최신 발표분에서는 POP를 제공합니다.
- 따라서 최신 발표분의 초단기예보 slot에는 POP `VALUE`가 정상적으로 존재할 수 있습니다. 값이
  존재하면 다른 상품과 동일하게 `parseKmaPercentage`로 `0~100` percentage로 파싱합니다.
- POP가 `ABSENT`(rollout 이전 발표분·부분 응답·방어적 누락 등)이거나 `NULL`이면 오류가 아니라
  nullable field의 `null`로 처리합니다(`precipitationProbabilityPercent: null`). VALUE가
  malformed·out-of-range·Missing이면 마찬가지로 `null`이며, raw 값은 노출하지 않습니다.
- normalizer는 **발표일자 조건을 하드코딩하지 않고** slot의 field presence만 해석합니다. 단기·
  초단기 어느 상품이든 POP 조립 코드는 동일합니다(`getKmaForecastField` → presence 분기 →
  존재하면 `parseKmaPercentage`, 아니면 `null`).
- **live 검증 대상:** 실제 인증된 공공데이터포털 JSON에서 초단기예보 POP가 반환되는 구체적
  형태(키 존재·값 표기)는 실제 키를 이용한 후속 live 통합 검증으로 확인할 항목입니다.

> 공식 자료 시점 차이: 기존 활용가이드 DOCX "코드값 정보" 표에는 초단기예보 category에 POP가
> 빠져 있으나, 이는 rollout(2026-06-23) 이전의 오래된/동기화 전 표일 가능성이 있습니다. 현재 제공
> 상태의 근거로는 최신 API 허브의 운영 변수 목록을 사용하며, 두 공식 자료가 시점 차이를 보인다는
> 사실 자체를 숨기지 않고 기록합니다. 응답의 구체적 존재 형태는 인증 JSON 검증 전까지 과도하게
> 단정하지 않습니다.

## scalar parser grammar (weather-core)

`packages/weather-core/src/kma/scalar.ts`의 공개 함수:

| 함수 | category | 반환 |
| --- | --- | --- |
| `parseKmaTemperatureCelsius` | `TMP` / `T1H` | ℃ 숫자 또는 `null` |
| `parseKmaPercentage` | `POP` / `REH` | `[0, 100]` 숫자 또는 `null` |
| `parseKmaWindSpeedMetersPerSecond` | `WSD` | `[0, 900)` 숫자 또는 `null` |
| `parseKmaWindDirectionDegrees` | `VEC` | `[0, 360)` 숫자 또는 `null` |

공통 입력 정책:

- 입력 타입은 `string | null | undefined`이며, 문자열만 숫자를 만들 수 있습니다.
- 앞뒤 공백은 trim, 빈 문자열·공백 문자열 → `null`.
- **전체(트림 후) 문자열이 엄격한 십진수 grammar**(`^[+-]?\d+(?:\.\d+)?$`)와 일치해야 합니다.
  느슨한 `parseFloat` 사용 안 함, 단위/문구 suffix(`25℃`, `25 C`, `70%`, `3.4m/s`) 거부,
  exponent(`2.5e1`) 거부, `NaN`/`Infinity`/`-Infinity` 리터럴 거부. leading `+`/`-`는 허용.
- `NaN`/`Infinity`/`-Infinity`를 반환하지 않고, 입력을 변경하지 않으며, system clock·locale·
  environment를 쓰지 않습니다.

각 category별 규칙:

- **기온(TMP/T1H):** 음수 허용. 임의의 좁은 현실 범위를 적용하지 않고, 공식 Missing 센티넬만
  적용합니다(아래). 유효 범위는 `(-900, 900)`.
- **POP/REH(%):** `0 <= value <= 100`, 그 외(음수·초과·Missing·malformed) → `null`.
- **WSD(m/s):** finite, `>= 0`, Missing 미만. 음수·단위 포함·malformed → `null`.
- **VEC(deg):** 아래 "VEC 360 처리" 참고.

## Missing 처리

- **공식 근거:** 활용가이드는 **"+900 이상, –900 이하 값은 Missing 값으로 처리"**(관측장비 없음/
  결측)라고 명시합니다.
- 일반 수치 parser는 파싱된 값의 `|value| >= 900`이면 Missing으로 보고 `null`을 반환합니다.
  단순히 값이 크다는 이유로 임의 상한을 만들지 않고, 공식 `±900` 센티넬만 사용합니다. 이 정책은
  범주형 amount parser(`amount.ts`)의 `>= 900` 처리와 일치합니다.
- POP/REH는 유효 범위 `[0, 100]`이 이미 `>= 900`을 배제하고, VEC는 `[0, 360)`가 배제하므로,
  기온·WSD에서 Missing 센티넬이 실질적으로 작동합니다.

## VEC 360 처리

- **공식 근거:** 활용가이드 "풍향 구간별 표현단위" 표의 마지막 구간은 `315 – 360 → NW-N`이고,
  "풍향값에 따른 16방위 변환식"은 `0`과 `360`을 모두 `N`(북)으로 매핑합니다(변환값 0·16 = N).
- 즉 `360`은 `0`과 같은 북쪽을 의미하므로 **`360 → 0`으로 정규화**합니다. contracts의
  `windDirectionDegrees`는 반열림 `[0, 360)`(`0` 허용, `360` 불가)이므로 이 정규화가 필요합니다.
- 그 외 범위 밖 값(음수, `> 360`, Missing `>= 900`)은 `null`.

## forecastAt KST 생성

- KMA `forecastDate`(`YYYYMMDD`)와 `forecastTime`(`HHmm`)은 **KST 예보 시각**으로 해석합니다.
  기상청 국내 서비스의 모든 발표·예보 시각은 한국 표준시(KST, UTC+9)이며 DST가 없습니다.
- 출력 형식: `YYYY-MM-DDTHH:mm:00+09:00` (예: `20260717` + `1400` → `2026-07-17T14:00:00+09:00`).
- 규칙: system clock·실행 환경 timezone·`new Date(year, month, …)` 같은 local-timezone 생성·locale
  formatting을 쓰지 않습니다. 순수 문자열 조합이며 seconds는 항상 `00`, 오프셋은 고정 `+09:00`.
- raw schema가 날짜·시간을 이미 검증하지만, normalizer를 단독 호출해도 throw하지 않도록
  방어적으로 `isCalendarDate`/`isClockTime`(요청·응답 경계와 동일한 predicate)로 재검증합니다.
  malformed이면 `forecastAt` `INVALID` normalization issue를 반환합니다.
- 결과는 contracts `isoDateTime`(offset 필수, seconds precision)을 통과합니다.

## ABSENT / NULL / VALUE 정책

모든 category 조회는 `getKmaForecastField(slot, category)`로만 수행하며 세 상태를 구분합니다.

### 필수 temperature 오류 정책

`temperatureCelsius`는 contracts에서 필수입니다. 상품별 필수 category는 단기예보 `TMP`,
초단기예보 `T1H`입니다. 다음은 slot normalization error이며, 해당 slot을 조용히 삭제하거나 임의
기본값 `0`을 쓰지 않습니다.

| temperature 상태 | 결과 |
| --- | --- |
| `ABSENT` | issue `{field: temperatureCelsius, reason: ABSENT}` |
| `NULL` | issue `{field: temperatureCelsius, reason: NULL}` |
| `VALUE` + 파싱 실패(malformed·Missing) | issue `{field: temperatureCelsius, reason: INVALID}` |
| `VALUE` + 정상(음수 포함) | 성공 |

### nullable field 정책

`precipitationProbabilityPercent`, `precipitationAmountMillimeters`, `snowfallAmountCentimeters`,
`humidityPercent`, `windSpeedMetersPerSecond`, `windDirectionDegrees`는 contracts에서 nullable입니다.

| 상태 | 결과 |
| --- | --- |
| `ABSENT` | `null` |
| `NULL` | `null` |
| `VALUE` + 정상 parse | 숫자 |
| `VALUE` + parse 실패 | `null` |

raw 문자열은 어떤 경우에도 반환하지 않습니다.

## condition UNKNOWN 정책

SKY·PTY의 field presence를 다음처럼 condition normalizer에 전달합니다: `VALUE` → 값, `NULL` →
`null`, `ABSENT` → `undefined`. `normalizeKmaWeatherCondition({ product, skyCode,
precipitationTypeCode })`의 규칙(PTY 우선, PTY `0`일 때만 SKY, 누락·미지 PTY는 SKY fallback 없이
`UNKNOWN`, 상품별 PTY 차이)은 [kma-normalization.md](./kma-normalization.md)와 동일합니다. 결과가
`UNKNOWN`이어도 HourlyForecast 생성은 가능합니다(condition은 필수지만 `UNKNOWN`도 유효 값).

## feelsLike null 정책

이번 PR에서 `feelsLikeCelsius`는 항상 `null`로 고정합니다. 체감온도 계산은 검증된 공식으로 별도
PR(weather-core 또는 lifestyle-engine)에서 구현하며, 임의 계산식을 넣지 않습니다.

## contracts runtime validation

- 조립한 각 candidate는 `hourlyForecast.safeParse(candidate)`로 검증하고, **성공한 parsed
  output만** 결과에 넣습니다. 직접 만든 객체를 검증 없이 반환하지 않습니다.
- contract validation 실패는 throw하지 않고 sanitized issue(`field: contract`, `reason: INVALID`,
  Zod `path`·`message`만)로 표현합니다. raw candidate 전체나 raw KMA 값은 노출하지 않습니다.
- 실무상 이 branch는 **방어적 안전망**입니다: 모든 scalar/amount parser의 출력 범위는 대응하는
  contract 범위의 부분집합이므로(예 percent `[0,100]`, VEC `[0,360)`, WSD `[0,900) ⊂ >=0`), 정상
  slot에서 contract 위반이 발생하지 않습니다. 그럼에도 계약 위반이 생기면 조용히 통과시키지 않고
  issue로 보고합니다.
- `apps/api`는 이 검증을 위해 `@life-weather/contracts`를 runtime dependency로 추가했습니다.
  `weather-core`는 contracts runtime import를 하지 않습니다.

## 공개 normalization API

```ts
export function normalizeKmaHourlyForecast(
  forecast: KmaForecastProviderSuccess,
): NormalizeKmaHourlyForecastResult;

export type NormalizeKmaHourlyForecastResult =
  | { readonly ok: true; readonly hourly: readonly HourlyForecast[] }
  | { readonly ok: false; readonly issues: readonly KmaHourlyNormalizationIssue[] };

export interface KmaHourlyNormalizationIssue {
  readonly slotKey: string;
  readonly field: 'forecastAt' | 'temperatureCelsius' | 'contract';
  readonly reason: 'ABSENT' | 'NULL' | 'INVALID';
  readonly path?: string;    // contract issue 전용, sanitized
  readonly message?: string; // contract issue 전용, sanitized
}
```

- 첫 오류에서 즉시 종료하지 않고 모든 slot의 오류를 수집합니다. 결과는 all-or-nothing이며,
  하나라도 issue가 있으면 `{ ok: false, issues }`, 없으면 `{ ok: true, hourly }`입니다.
- issue는 raw slot·raw field 배열·원본 fcstValue·전체 Provider 응답·URL·service key·stack trace를
  포함하지 않습니다. `slotKey`는 grouping과 동일한 안전한 slot identity
  (`product|baseDate|baseTime|fcstDate|fcstTime|nx|ny`)입니다.

## 출력 정렬·입력 불변성·결정론성

- 성공 output은 `forecastAt` 오름차순(동률 시 slotKey)으로 정렬합니다. slot이 이미 정렬돼 있다는
  사실에 의존하지 않고 복사본을 결정론적으로 정렬합니다.
- issue는 `slotKey → field → reason → path → message` 순서로 결정론적 정렬합니다.
- 입력 forecast·slots·fields·field 객체를 mutation하지 않습니다. `.sort()`는 새 배열에만
  수행합니다. global mutable state·current time을 쓰지 않습니다.
- 동일한 slot 집합이 다른 입력 순서로 들어와도 동일한 결과가 나옵니다. 빈 `slots`는
  `{ ok: true, hourly: [] }`.

## 기존 PR #5 Provider와의 관계

`KmaForecastProvider.fetchForecast()`의 성공 타입·동작은 변경하지 않았습니다. normalizer는 별도
pure adapter이며, HTTP transport가 자동 호출하지 않습니다. 네트워크 오류와 domain normalization
오류는 같은 union에 섞지 않습니다.

```ts
const providerResult = await provider.fetchForecast(request);
if (!providerResult.ok) {
  // 기존 Provider transport/upstream error
}
const normalized = normalizeKmaHourlyForecast(providerResult.forecast);
```

## 실제 인증 JSON 검증 상태

- 실제 사용자/운영 `KMA_SERVICE_KEY`는 사용하지 않았습니다.
- 자동 테스트는 실제 네트워크를 호출하지 않고, in-memory slot fixture만 사용합니다.
- category·단위·범주·Missing 규칙은 공식 활용가이드 원문으로, 초단기예보 POP 제공 시작
  (2026-06-23 12 KST)은 기상청 API 허브 운영 변수 목록으로 확인했으나, 인증된 실제 JSON
  응답으로의 end-to-end 검증(방어적 허용 및 초단기 POP 반환 형태 포함)은 실제 키가 필요하며 후속
  live 통합 검증 과제입니다.

## 변경 이력

```text
v1 / PR #6 / 2026-07
- KMA forecast slot → contracts HourlyForecast normalization 도입
- 단기·초단기 product별 category 연결 (TMP/T1H, PCP/RN1, SNO/none, SKY+PTY, POP/REH/WSD/VEC)
- weather-core scalar parser(기온·%·WSD·VEC)와 Missing(±900)·VEC 360 정책 도입
- ABSENT/NULL/VALUE field-presence 정책, 필수 temperature 오류, nullable field null 정책
- KST forecastAt 생성, feelsLike null, contracts runtime validation, 결정론적 정렬·issue order
- 공식 근거: RN1=PCP 강수량 범주 동일, ±900 Missing, VEC 360=0(북)

v1.1 / PR #6 / 2026-07 (공식 POP rollout 정정)
- 초단기예보 POP 정책 정정: 기상청 API 허브 `2.2 초단기예보` 변수 목록이 POP를 2026-06-23 12 KST
  이후 제공한다고 명시(확인일 2026-07-17). "초단기예보 POP 미제공" 서술은 오래된 DOCX 표 기준의
  잘못된 설명이었으므로 제거.
- runtime 무변경: POP 존재 시 `parseKmaPercentage`로 파싱, ABSENT/NULL/malformed → `null`.
  발표일자 하드코딩 분기 없이 slot presence만 해석하는 기존 동작이 이미 이 정책을 충족.
- 실제 인증 JSON의 POP 반환 형태는 후속 live 통합 검증 항목으로 명시.
```
