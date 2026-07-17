# KMA 예보 코드 정규화

이 문서는 `@life-weather/weather-core`가 기상청(KMA) 단기예보·초단기예보의 원본 코드와
범주형 수치를 공통 값으로 정규화하는 규칙을 기록합니다. 매핑의 근거는 아래 공식 자료이며,
블로그·개인 저장소·비공식 정리 문서는 근거로 사용하지 않았습니다.

구현 위치:

- [condition.ts](../packages/weather-core/src/kma/condition.ts) — SKY/PTY → `WeatherCondition`
- [amount.ts](../packages/weather-core/src/kma/amount.ts) — PCP(mm) / SNO(cm) 범주형 수치 파서
- [scalar.ts](../packages/weather-core/src/kma/scalar.ts) — TMP/T1H, POP/REH, WSD, VEC scalar 파서

`weather-core`는 **순수 정규화 함수만** 제공합니다(HTTP 호출·`ServiceKey`·Provider 클래스·원본
응답 스키마는 이 패키지 범위 아님). 이 함수들을 실제 응답에 연결하는 파이프라인은 다음 순서로
구현되었습니다.

- **PR #3:** `weather-core` condition(SKY/PTY) + amount(PCP/SNO) primitive 구현.
- **PR #4:** `apps/api/src/providers/kma`에 raw JSON boundary와 ABSENT/NULL/VALUE slot grouping 구현.
- **PR #5:** 실제 공공데이터포털 HTTPS 호출을 수행하는 KMA HTTP Provider 구현.
- **PR #6:** `weather-core` scalar 파서(`scalar.ts`)를 추가하고, slot 값을 조건·범주·scalar 파서에
  연결해 contracts `HourlyForecast`로 정규화하는 adapter를 `apps/api`에 구현.
- **후속:** `WeatherOverview`, `/weather` API route, `CurrentWeather`, `DailyForecast`.

## 출처

| 항목 | 값 |
| --- | --- |
| 공식 서비스명 | 기상청_단기예보 조회서비스 |
| 공공데이터 ID | `15084084` |
| 공식 활용가이드 파일명 | `기상청41_단기예보 조회서비스_오픈API활용가이드_2607.zip` |
| 활용가이드 버전 | `2607` |
| 확인 날짜 | 2026-07-16 |
| 서비스(오퍼레이션) 버전 | `VilageFcstInfoService_2.0` (가이드 표기 서비스 버전 2023-07-24) |

검증된 공식 파일 SHA-256 (Codex 독립 리뷰가 확인):

| 파일 | SHA-256 |
| --- | --- |
| 공식 ZIP (`…_2607.zip`) | `07f53cd9d6d6512bce6ef870d54cb740046a0a949896e6855caecf739fb8842e` |
| 내부 DOCX | `20d855aa3071a2bdda6dce3c13bab6428ebb02f8d4a30688e26ed0851d6d0848` |

> 위 SHA-256은 Codex 독립 리뷰가 공식 배포본으로 검증한 값입니다. 같은 파일명이라도 내용이
> 교체되면 값이 달라지므로, 로컬에 보관한 ZIP/DOCX로 다시 계산해 위 값과 일치할 때만 근거로
> 사용해야 합니다. 값이 다르면 추정하지 말고 실제 해시를 재확인하십시오.

접근 경로:

- 공공데이터포털 데이터 상세: `data.go.kr` → `publicDataPk=15084084` → 참고문서의
  활용가이드(`…_2607.zip`). 페이지 수정일 2026-07-09.
- 코드값·범주 표는 동일 서비스의 기상청 API 허브 활용가이드 문서
  (`VilageFcstInfoService_2.0`, "특정 요소의 코드값 및 범주" 절)에서 원문으로 확인했습니다.

사용한 예보 상품(오퍼레이션):

- 단기예보 `getVilageFcst` — `SHORT_FORECAST`
- 초단기예보 `getUltraSrtFcst` — `ULTRA_SHORT_FORECAST`
- 초단기실황 `getUltraSrtNcst` — **이번 PR 범위 아님**

## 상태(condition) 매핑

공통 `WeatherCondition`(`@life-weather/contracts`)의 값 중 이 정규화가 생성할 수 있는 것은
`CLEAR`, `PARTLY_CLOUDY`, `CLOUDY`, `RAIN`, `SNOW`, `SLEET`, `SHOWER`, `UNKNOWN` 입니다.
`THUNDERSTORM`, `FOG`는 SKY/PTY 코드로 표현되지 않으므로(낙뢰 `LGT`, 안개·특보 등 별도 자료)
이 함수가 생성하지 않습니다.

### 하늘상태 SKY (단기·초단기 공통)

| 원본 코드 | 공식 의미 | 공통 WeatherCondition | 비고 |
| --- | --- | --- | --- |
| `1` | 맑음 | `CLEAR` | |
| `3` | 구름많음 | `PARTLY_CLOUDY` | |
| `4` | 흐림 | `CLOUDY` | |
| `2` | (구름조금) | `UNKNOWN` | 현행 가이드에서 미사용(폐지) — 미지 코드로 처리 |

SKY 코드 체계는 두 상품이 동일합니다.

### 강수형태 PTY — 단기예보 (`getVilageFcst`)

| 원본 코드 | 공식 의미 | 공통 WeatherCondition | 비고 |
| --- | --- | --- | --- |
| `0` | 없음 | (SKY로 판정) | 명시적 "강수 없음" → SKY 사용 |
| `1` | 비 | `RAIN` | |
| `2` | 비/눈 | `SLEET` | |
| `3` | 눈 | `SNOW` | |
| `4` | 소나기 | `SHOWER` | 두 예보 상품 공통 |

### 강수형태 PTY — 초단기예보 (`getUltraSrtFcst`)

| 원본 코드 | 공식 의미 | 공통 WeatherCondition | 비고 |
| --- | --- | --- | --- |
| `0` | 없음 | (SKY로 판정) | 명시적 "강수 없음" → SKY 사용 |
| `1` | 비 | `RAIN` | |
| `2` | 비/눈 | `SLEET` | |
| `3` | 눈 | `SNOW` | |
| `4` | 소나기 | `SHOWER` | 두 예보 상품 공통 |
| `5` | 빗방울 | `RAIN` | **초단기예보 전용** |
| `6` | 빗방울눈날림 | `SLEET` | **초단기예보 전용** |
| `7` | 눈날림 | `SNOW` | **초단기예보 전용** |

### 상품별 차이 / 특정 endpoint 전용 코드

- 강수형태 `0`~`4`(없음·비·비/눈·눈·소나기)는 **단기예보와 초단기예보에서 모두** 사용됩니다.
  따라서 소나기(`4`)는 두 상품 모두에서 `SHOWER`로 정규화됩니다.
- 빗방울(`5`)·빗방울눈날림(`6`)·눈날림(`7`)은 **초단기예보에만** 정의됩니다. 단기예보에서
  `5`/`6`/`7`은 정의되지 않은 코드이므로 `UNKNOWN` 입니다.
- 그래서 예보 상품(product)은 입력의 필수 항목입니다. 같은 숫자가 상품에 따라 다른 의미(또는
  미정의)일 수 있으므로 상품 없이 숫자만으로 판정하지 않습니다. (`5`/`6`/`7`은 단기예보에서
  미정의이며, `4`는 어느 상품에서도 미정의가 아닙니다.)

### 강수 상태와 하늘 상태의 우선순위

1. **PTY 우선.** 이 상품에서 인식되는 강수 PTY가 있으면 그 상태를 반환하고 SKY는 무시합니다.
   예: PTY 비 + SKY 맑음 → `RAIN`.
2. **명시적 "강수 없음"일 때만 SKY 사용.** PTY가 정확히 `0`(없음)일 때에만 SKY로 판정합니다.
   예: PTY 없음 + SKY 맑음 → `CLEAR`.
3. **누락·미지 PTY에서 SKY fallback 금지.** PTY가 `null`/`undefined`/빈 문자열/공백/이 상품에
   정의되지 않은 코드이면 SKY를 보지 않고 `UNKNOWN`을 반환합니다.
4. **강수 없음 + 미지·누락 SKY → `UNKNOWN`.** PTY `0`이지만 SKY가 `null`/`undefined`/빈
   문자열/미지 코드이면 `UNKNOWN`.

### 알 수 없는 코드 처리 / 입력 규칙

- 공식 문서에 없는 코드, 상품에 정의되지 않은 코드 → `UNKNOWN`.
- 문자열 앞뒤 공백은 제거합니다. 그 외에는 코드를 그대로 사용합니다.
- `"01"`을 `"1"`로 접지 않습니다. 정확히 일치하는 공식 코드 문자열만 매칭합니다.
- 숫자 `1`과 문자열 `"1"`을 자동 coercion하지 않습니다(입력 타입은 문자열).
- 빈 문자열·공백 문자열은 유효 코드로 취급하지 않습니다.

## 강수량(PCP)·신적설(SNO) 수치 파서

공식 가이드 "특정 요소의 코드값 및 범주"에 등장하는 문자열 표기만 지원합니다. 전체(트림 후)
문자열이 공식 패턴에 일치해야 하며, 앞부분만 느슨하게 읽지 않습니다. 반환값은 항상 유한한
`>= 0`이고 `< 900`인 숫자 또는 `null`이며 `NaN`/`Infinity`/`-Infinity`를 생성하지 않습니다.
입력 문자열은 변경하지 않습니다.

정규화 규칙:

| 원본 의미 | 반환값 |
| --- | --- |
| "없음"(`강수없음`/`적설없음`/`-`/`0`/`0.0`) | `0` |
| 명확한 숫자 | 해당 숫자 |
| `T 미만` | `T / 2` |
| `L~U` (범위, **PCP만**) | 하한 `L` |
| `T 이상` | 하한 `T` |
| Missing 센티넬(`>= 900`) · 미제공 · 파싱 불가 | `null` |

### 공식 no-amount 표기 `-`

- 가이드는 강수량/신적설 범주에서 `-`, `0`, `0.0`, `강수없음`/`적설없음`을 **"없음"**(강수 없음 /
  적설 없음)으로 설명합니다. 따라서 트림 후 정확히 `-`인 문자열은 `0`으로 정규화합니다
  (`" - "` → `0`).
- `-`는 **정확히 한 글자 하이픈**일 때만 no-amount입니다. `--`, `-1`, `-1mm` 등은 no-amount가
  아니며 `null` 입니다.

### 공식 Missing 센티넬 `+900 이상`/`-900 이하`

- 가이드는 `+900 이상`, `-900 이하`를 Missing(자료 없음)으로 설명합니다. 이 파서는 정상적으로
  non-negative amount만 반환하므로 음수·부호 있는 문자열은 정규식이 인식하지 않아 자연히 `null`이
  됩니다. 추가로, 파싱된 **모든 수치 성분**이 `>= 900`이면 Missing으로 보고 `null`을 반환합니다.
- `>= 900` 검증을 적용하는 성분: 단위 없는 숫자, 단위 있는 숫자, `T 미만`의 threshold, `T 이상`의
  threshold, 범위의 하한·상한. 예: `900`, `900mm`, `900mm 이상`, `30~900mm`(상한 900) → 모두
  `null`. 경계 바로 아래 값(`899`, `899.9`, `899.999mm`)은 정상 처리합니다.

### JavaScript `null`/`undefined` 과 공식 문서의 null 차이

공식 문서의 "null 값 → 없음"과, 이 파서 인자의 JavaScript `null`은 의미가 다릅니다. 이번 PR에서
공개 함수의 의미는 다음과 같이 유지합니다.

| 입력 | 의미 | 반환값 |
| --- | --- | --- |
| JavaScript `null` | 데이터 미제공 또는 호출자 측 결측 | `null` |
| JavaScript `undefined` | 데이터 미제공 | `null` |
| 문자열 `"-"` | 공식 no-amount 표현 | `0` |
| 문자열 `"0"`/`"0.0"` | 0 | `0` |
| `강수없음`/`적설없음` | 없음 | `0` |

- 이 파서는 함수 인자 `null`을 무조건 `0`으로 바꾸지 않습니다. 현재 서명이 `string | null |
  undefined`이고, 파서 단독으로는 "필드가 존재하며 값이 null"인 경우와 "필드 자체가 누락된
  경우"를 구분할 수 없기 때문입니다. 임의로 `null → 0`을 적용하면 실제 데이터 미제공이 강수/적설
  없음으로 잘못 바뀔 위험이 있습니다.
- **Provider 경계 요구사항(PR #3에서 식별, PR #4에서 해결).** KMA 원본 응답 runtime schema와
  Provider는 다음 네 경우를 각각 구분해
  처리해야 합니다: (1) 필드 존재 + 공식 null 값, (2) 필드 미존재, (3) 필드 존재 + 문자열 `-`,
  (4) 필드 존재 + 숫자/문자열 `0`. Provider는 원본 객체의 **field presence(필드 존재 여부)**를
  보존한 상태에서 공식 null 의미를 결정해야 합니다.
- **PR #4 반영.** KMA 원본 응답 경계는 PR #4에서 `apps/api/src/providers/kma`에 도입되었고,
  field presence를 `ABSENT`(필드 미존재) / `NULL`(필드 존재 + 명시적 null) / `VALUE`(필드 존재 +
  값)로 명시 보존합니다 — [kma-response-boundary.md](./kma-response-boundary.md) 참고.
- **PR #5 반영.** PR #5에서 실제 공공데이터포털 HTTP Provider가 이 경계 위에 구현되어, 검증된
  page를 forecast slot으로 그룹화합니다 — [kma-http-provider.md](./kma-http-provider.md) 참고.
- **PR #6 반영.** PR #6에서 위 정규화 함수(SKY/PTY·PCP/SNO)와 신규 일반 수치 scalar
  parser(TMP/T1H·POP/REH·WSD·VEC, `scalar.ts`)를 slot 값에 실제로 **호출하는 연결**을
  `apps/api`(`normalize-hourly.ts`)에 구현했습니다 —
  [kma-hourly-normalization.md](./kma-hourly-normalization.md) 참고. 이때 초단기예보 `RN1`(1시간
  강수량)은 공식 활용가이드가 **단기예보 `PCP`와 동일한 강수량 범주·표시방법**으로 정의하므로
  `parseKmaPrecipitationAmountMillimeters`를 그대로 재사용합니다(반환 단위 mm). 위 PR #3 규칙은
  PR #4·#5·#6에서 변경하지 않았습니다.

### PCP — 1시간 강수량 (반환 단위 **mm**)

`parseKmaPrecipitationAmountMillimeters(rawValue)`

| 공식 원본 표현 | 정규화 반환값 |
| --- | --- |
| `강수없음` / `-` / `0` / `0.0` | `0` |
| `1mm 미만` (공식 최소 범주, 미만) | `0.5` (T/2) |
| 정수·실수값 + `mm` (예 `6.2mm`) 또는 단위 없는 숫자(예 `6.2`) | 해당 숫자 |
| `1~29mm`, `30~50mm` (범위) | 하한 (`1`, `30`) |
| `50mm 이상` | 하한 `50` |

- **공식 최소 범주는 `1mm 미만`** 입니다(→ `0.5`). `1.0mm 미만`은 공식 표기는 아니지만 동일
  범주의 소수 표기이므로 방어적으로 허용합니다(→ `0.5`).
- 가이드는 `문자열표시`(예 `1mm 미만`, `50mm 이상`, `30~50mm`)와 원본 값 예시
  (`예) PCP = 6.2 → 6.2mm`)를 함께 보여줍니다. 그래서 **단위가 붙은 숫자**와 **단위가 없는
  숫자**를 모두 명확한 숫자로 받아들입니다.
- 공식 표기에서 확인된 **공백 차이**만 허용합니다: 숫자/단위/미만·이상 사이의 공백은 있어도
  없어도 됩니다.

### SNO — 1시간 신적설 (반환 단위 **cm**)

`parseKmaSnowfallAmountCentimeters(rawValue)`

| 공식 원본 표현 | 정규화 반환값 |
| --- | --- |
| `적설없음` / `-` / `0` / `0.0` | `0` |
| `0.5cm 미만` (공식 최소 범주, 미만) | `0.25` (T/2) |
| 실수값 + `cm` (예 `3.5cm`) 또는 단위 없는 숫자(예 `3.5`) | 해당 숫자 |
| `5cm 이상` | 하한 `5` |

- **공식 최소 범주는 `0.5cm 미만`** 입니다(→ `0.25`). `1.0cm 미만` 같은 소수 미만 표기도
  일반 grammar가 허용하지만, 공식 최소 범주와 방어적 허용 표현은 구분합니다.
- **SNO는 2607 가이드에 범위(`L~U cm`) 표기가 확인되지 않습니다.** 이 파서는 공식 표현을
  엄격히 정규화하는 것이 원칙이므로 SNO에서는 **범위 문자열을 거부**합니다(예: `1.0~4.9cm` →
  `null`). 범위를 공식적으로 제공하는 것은 PCP뿐입니다.

### 미만·범위·이상·없음·Missing·누락·파싱 실패 처리

- 미만: `T 미만` → `T / 2` (예 PCP `1` → `0.5`, SNO `0.5` → `0.25`). threshold `T`가 `>= 900`이면
  Missing → `null`.
- 범위: **PCP만** `L~U` → 하한 `L`. 하한이 상한보다 큰 범위(예 `50~30mm`)나 상한이 `>= 900`인
  범위(예 `30~900mm`)는 `null`. **SNO는 범위 문자열 자체를 거부**합니다(공식 범위 없음).
- 이상: `T 이상` → 하한 `T`. `T`가 `>= 900`이면 Missing → `null`.
- 없음: `강수없음`/`적설없음`/`-` → `0`. 원본 `0`/`0.0` → `0`.
- Missing: 파싱된 수치 성분이 `>= 900`(공식 `+900 이상`/`-900 이하` 센티넬)이면 `null`.
- 잘못된 단위: PCP에 `cm`, SNO에 `mm` → `null`.
- 음수 → `null`. 빈 문자열·공백 문자열 → `null`. JavaScript `null`/`undefined` → `null`.
- 알 수 없는 한국어/임의 영어 문구, 추가 문자가 붙은 값 → `null`.

## 데이터 부족 처리 요약

```text
알 수 없는 SKY 또는 PTY            → UNKNOWN
PTY 누락·미지 코드                 → SKY fallback 금지 (UNKNOWN)
PCP/SNO 파싱 불가·미제공·잘못된 단위 → null
PCP/SNO Missing 센티넬 (>= 900)    → null
SNO 범위 문자열 (공식 범위 없음)    → null
강수/적설 없음 (없음/-/0/0.0)      → 0
JavaScript null / undefined 인자   → null (0 아님)
```

## contracts와의 관계

- 공통 계약(`@life-weather/contracts`)에는 **정규화된 값만** 존재합니다. KMA 원본 코드
  (SKY/PTY/PCP/SNO 문자열)는 `weather-core` 내부 매핑에만 있고 계약에 추가하지 않습니다.
- 상태 정규화의 반환값은 `WeatherCondition`에 할당 가능한 리터럴 union입니다. 이 호환성은
  `weather-core`에 zod/contracts 런타임 의존을 추가하지 않고 **컴파일 타임 타입 테스트**로만
  검증합니다(`packages/weather-core/src/__tests__/kma-condition.test.ts`).

## 변경 이력

```text
v1 / PR #3 / 2026-07
- KMA 단기·초단기예보 SKY/PTY 매핑 최초 도입
- PCP(mm)/SNO(cm) 범주형 수치 parser 최초 도입
- 출처: 기상청_단기예보 조회서비스(15084084), 활용가이드 2607, 확인일 2026-07-16

v1.1 / PR #3 / 2026-07 (Codex 독립 리뷰 반영)
- 초단기예보 PTY 4(소나기) = SHOWER 로 수정. PTY 0~4는 단기·초단기 공통, 5~7은 초단기 전용으로 정정.
- 공식 no-amount 표기 `-`(및 `0`/`0.0`) → 0 으로 정규화 추가.
- 공식 Missing 센티넬(`+900 이상`/`-900 이하`) 반영: 수치 성분이 >= 900 이면 null.
- 공식 최소 범주 정정: PCP `1mm 미만 → 0.5`, SNO `0.5cm 미만 → 0.25`.
- SNO 비공식 범위(`L~U cm`) 지원 제거(범위 문자열 거부). PCP 범위만 공식 허용.
- JavaScript null/undefined 인자와 공식 문서상 null 의미의 차이를 명문화.
- 검증된 공식 ZIP/DOCX SHA-256 기록.
```
