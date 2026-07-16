# 공유 기상 데이터 계약 (contracts)

이 문서는 `@life-weather/contracts`가 정의하는 정규화 기상 데이터 계약의 목적, 경계,
그리고 소비자·생산자가 지켜야 할 규칙을 설명합니다. 계약은 [Zod](https://zod.dev) 4 런타임
스키마로 정의하며, 모든 TypeScript 타입은 스키마에서 `z.infer`로 추론합니다. 별도의
interface/type을 중복 작성하지 않습니다.

## 목적과 경계

- 이 패키지는 모바일 앱(`apps/mobile`), API(`apps/api`), 향후 Provider와 생활지수
  엔진(`packages/lifestyle-engine`)이 공유할 **정규화된** 기상 데이터의 형태를 정의합니다.
- 이 계약은 이미 공통 모델로 정규화된 데이터를 다룹니다. 기상청(KMA)·에어코리아(AirKorea)
  원본 응답 스키마, Provider 인터페이스, 실제 API 호출, 코드 매핑은 **이 PR의 범위가
  아니며** 후속 Provider PR에서 다룹니다.
- 계약은 런타임 검증(스키마)과 컴파일 타임 타입(추론)을 동시에 제공합니다. 네트워크 경계에서
  들어오는 데이터는 반드시 스키마로 파싱한 뒤 사용합니다.

## Contract version 정책

```ts
export const CONTRACT_VERSION = 1 as const;
```

- **Additive 변경은 버전을 올리지 않습니다.** optional/nullable 필드 추가처럼 기존 소비자를
  깨뜨리지 않는 변경은 버전 유지.
- **Breaking 변경일 때만** contract version을 증가시킵니다(필드 제거·의미 변경·필수화 등).
- Breaking 변경 시에는 API 경로도 `/v2`처럼 분리합니다. 기존 `/v1`은 구버전 모바일 앱을 위해
  일정 기간 병행 제공합니다.
- 소비자는 먼저 **최소 header 스키마**(`apiEnvelopeHeader`)로 `meta.contractVersion`을 확인한
  뒤, 해당 버전의 전체 응답 스키마(`weatherResponseV1` 등)로 파싱합니다. 최소 header 스키마의
  `contractVersion`은 리터럴 `1`이 아니라 **양의 정수**이므로, v1 소비자도 v2 이상의 응답을
  읽어 버전 불일치를 감지할 수 있습니다.
- `ok` 판별자와 `contractVersion`에는 forward-compatible fallback을 적용하지 않습니다. 이
  값들이 어긋나면 조용히 기본값으로 대체하지 않고 **파싱을 실패**시킵니다.
- 이번 PR에서는 모바일 업데이트 UI나 API version route를 구현하지 않습니다. 위 정책은 향후
  구현이 따라야 할 합의입니다.

## strict enum과 compatible enum

각 enum은 `createForwardCompatibleEnum` 헬퍼로 **두 개의 스키마**를 제공합니다.

- **strict**: 알려진 값만 허용합니다. 알 수 없는 문자열은 거부합니다. API 생산자 코드와 Provider
  정규화 테스트에서 매핑 누락을 즉시 드러내기 위해 사용합니다.
- **compatible**: 알려진 값은 그대로 두고, **알 수 없는 문자열만** fallback 값으로 바꿉니다.
  서버가 새 enum 값을 추가하더라도 구버전 소비자가 응답을 계속 파싱할 수 있게 합니다.

네트워크 응답 object 스키마의 enum 필드에는 **compatible**을 사용합니다.

### 왜 `.catch()`를 쓰지 않는가

```ts
// 사용하지 않음
z.enum(values).catch('UNKNOWN')
```

`.catch()`는 알 수 없는 문자열뿐 아니라 **필드 누락, null, 숫자, boolean 등 모든 validation
error**를 fallback으로 삼킵니다. 이는 구조적 오류(예: 필드 자체가 사라짐)를 숨겨 디버깅을
어렵게 만듭니다. compatible 스키마는 오직 "문자열이지만 알 수 없는 값"만 fallback으로
매핑하고, 다음은 모두 실패시킵니다.

| 입력 | strict | compatible |
| --- | --- | --- |
| 알려진 값 | 원래 값 | 원래 값 |
| 알 수 없는 문자열 | 실패 | fallback |
| 필드 누락(undefined) | 실패 | 실패 |
| null | 실패 | 실패 |
| 숫자·boolean·object | 실패 | 실패 |

compatible 스키마의 출력 타입은 항상 정의된 리터럴 union이며 `string`이 아닙니다.

### 알 수 없는 enum 값 처리 (fallback)

| enum | fallback |
| --- | --- |
| WeatherDataSection | `UNKNOWN` |
| SourceProvider | `OTHER` |
| RetrievalMode | `UNKNOWN` |
| WeatherCondition | `UNKNOWN` |
| AirQualityGrade | `UNKNOWN` |
| WeatherAlertType | `OTHER` |
| WeatherAlertSeverity | `UNKNOWN` |
| ApiErrorCode | `UNKNOWN` |

## null과 optional의 차이

이 계약은 **optional(필드 자체의 부재)을 사용하지 않습니다.** 값이 있을 수도 없을 수도 있는
필드는 **required + nullable**로 정의합니다. 즉 필드는 항상 존재하고, 값이 없으면 `null`입니다.

- "필드 누락"은 구조가 잘못된 것으로 간주하여 파싱을 실패시킵니다.
- "값 없음"은 명시적으로 `null`로 표현합니다.

이렇게 하면 소비자는 모든 필드가 존재한다고 신뢰할 수 있고, "누락"과 "없음"을 혼동하지 않습니다.

## `0`과 `null`의 차이

수치 측정값에서 `0`과 `null`은 의미가 다릅니다.

- `0` — 확인된 값이 0. 예: 확인된 무강수·무강설, 강수확률 0%.
- `null` — 원본 미제공, 통신장애, 파싱 불가 등으로 값을 알 수 없음.

Provider는 이 둘을 절대 혼동하지 않아야 합니다.

## 빈 배열과 `missingSections`의 차이

리스트 섹션(hourly, daily, air quality forecast, alerts)은 항상 배열이며 `null`을 쓰지
않습니다. "데이터 없음"과 "조회 실패"는 배열 자체가 아니라 `missingSections`로 구분합니다.

- 빈 배열 + 해당 섹션이 `missingSections`에 **없음** → 조회 성공, 해당 데이터 없음.
  - 예: `alerts: []` + ALERTS not missing → 특보 조회 성공, 발효 중 특보 없음.
- 빈 배열 + 해당 섹션이 `missingSections`에 **있음** → 해당 섹션 조회 실패.
  - 예: `alerts: []` + ALERTS missing → 특보 데이터 조회 실패.

## WeatherOverview 불변식

`weatherOverview` 스키마는 `superRefine`으로 데이터 존재 여부와 `missingSections`가 모순되지
않도록 검증합니다. 오류 path는 어느 필드가 모순인지 가리킵니다. `missingSections`의 `UNKNOWN`
항목은 알려진 섹션 불변식 검사에 사용하지 않습니다.

- **current ⇔ CURRENT** (양방향): `current === null`은 `missingSections`에 `CURRENT`가 포함된
  경우와 정확히 일치해야 합니다.
- **airQuality.current ⇔ AIR_QUALITY_CURRENT** (양방향): 위와 동일한 양방향 일치.
- **HOURLY**: `HOURLY`가 missing이면 `hourly`는 빈 배열이어야 하고, `hourly`에 데이터가 있으면
  `HOURLY`는 missing일 수 없습니다. (`hourly: []` + not missing은 허용)
- **DAILY**: `DAILY`가 missing이면 `daily`는 빈 배열이어야 하고, 데이터가 있으면 missing 금지.
- **AIR_QUALITY_FORECAST**: missing이면 `airQuality.daily`는 빈 배열, 데이터가 있으면 missing
  금지.
- **ALERTS**: missing이면 `alerts`는 빈 배열, 데이터가 있으면 missing 금지.
- **중복 금지**: `missingSections`에 중복 섹션이 있으면 거부합니다.

`current`와 `airQuality.current`가 **양방향**인 이유는 단일 객체(null이거나 존재)이기 때문에
missing 표기와 정확히 대응해야 하기 때문입니다. 리스트 섹션은 "조회 성공했지만 데이터 없음"이
정당하므로, "missing인데 데이터가 있음"만 모순으로 봅니다.

### section 배열의 중복 검사와 UNKNOWN 축약

`SourceMetadata.sections`와 `missingSections`는 forward-compatible 매핑 **이전의 raw 문자열**
기준으로 중복을 검사합니다. compatible 변환을 먼저 적용하면 서로 다른 신규 문자열(예: `UV`,
`POLLEN`)이 모두 `UNKNOWN`이 되어 잘못 중복으로 거부되기 때문입니다. 규칙:

- 요소는 반드시 문자열이어야 합니다(숫자·null·boolean·object 거부).
- 동일한 raw 문자열이 중복되면 거부합니다. 서로 다른 신규 문자열은 허용합니다.
- 검사 후 각 요소를 compatible enum으로 매핑하고, `UNKNOWN` 충돌은 하나로 축약합니다. 예:
  `['UV', 'POLLEN']` → `['UNKNOWN']`, `['HOURLY', 'UV']` → `['HOURLY', 'UNKNOWN']`.
- `SourceMetadata.sections`는 최소 한 항목이 필요하고, `missingSections`는 빈 배열을 허용합니다.

### DailyForecast 온도 불변식

`minimumTemperatureCelsius`와 `maximumTemperatureCelsius`가 **모두 null이 아닐 때** 최저기온이
최고기온보다 크면 거부합니다. 둘 중 하나라도 `null`이면 검사하지 않습니다.

## 날짜·시간 형식

- **절대 시각**(`isoDateTime`): timezone designator가 반드시 있는 ISO 8601. UTC `Z` 형태와
  `+09:00` 같은 숫자 offset을 허용합니다. timezone이 없는 로컬 datetime은 거부합니다.
  - 서버의 **정상 출력 규범은 UTC `Z` 형태**입니다. (예: `2026-07-15T12:00:00Z`)
  - **timestamp 정밀도 정책**: 절대 시각에는 **초(seconds)가 필수**이며, 소수 초는 **없거나
    정확히 밀리초 3자리**여야 합니다. 그 외 정밀도는 허용하지 않습니다.

    | 허용 | 거부 |
    | --- | --- |
    | `2026-07-15T12:00:00Z` | `2026-07-15T12:00Z` (초 없음) |
    | `2026-07-15T12:00:00.123Z` | `2026-07-15T12:00:00.1Z` (1자리) |
    | `2026-07-15T21:00:00+09:00` | `2026-07-15T12:00:00.12Z` (2자리) |
    | `2026-07-15T21:00:00.123+09:00` | `2026-07-15T12:00:00.0001Z` (4자리, sub-ms) |
    | | `2026-07-15T12:00:00.1234Z` (4자리) |

  - 구현: `isoDateTime`은 초 정밀도(`precision: 0`)와 밀리초 정밀도(`precision: 3`) 두
    스키마의 `z.union`입니다. 서버는 초 또는 밀리초 중 하나의 정밀도로 출력합니다.
  - **이유**: 계약을 JavaScript 기반 런타임의 시간 표현 및 freshness 판정 정밀도와 일치시키기
    위함입니다. `Date`/`Date.parse`는 밀리초 해상도이고 `classifyFreshness`
    (`@life-weather/weather-core`)의 비교도 밀리초 단위입니다. **임의 정밀도** timestamp를
    허용하면, 계약은 통과하지만 freshness가 거부하거나(초 없는 형태), sub-millisecond 정보가
    조용히 손실됩니다(4자리 이상). 두 계층이 같은 형식만 받도록 맞춥니다.
- **지역 일자**(`isoDate`): ISO 8601 `YYYY-MM-DD`.
- **timezone**(`ianaTimeZone`): `WeatherLocation.timezone`은 **named IANA timezone 식별자**여야
  합니다(예: `Asia/Seoul`, `UTC`). 런타임 `Intl`의 timezone 데이터베이스로 검증하며(별도 timezone
  라이브러리 미사용), `Seoul` 같은 비-IANA 문자열이나 빈 문자열은 거부합니다.
  - **고정 UTC offset은 허용하지 않습니다.** 최신 ECMA-402 `Intl`은 `+09:00`, `-05:30`, `+0900`
    같은 offset 문자열도 `timeZone`으로 받아들이므로, 이를 명시적으로 거부합니다.
  - 이유: named zone만이 해당 지역의 **DST(일광절약시간)** 및 **과거·미래 timezone 규칙**을 담고
    있습니다. 고정 offset은 이런 규칙을 표현할 수 없어 지역 시각을 정확히 계산할 수 없습니다.
  - **주의**: 지역 timezone(`ianaTimeZone`)의 **named IANA** 정책과, 절대 시각(`isoDateTime`)의
    **numeric offset** 정책은 서로 다른 개념입니다. 전자는 `WeatherLocation.timezone`이 어느
    지역인지(DST·역사적 규칙 포함)를 나타내는 zone 식별자이고, 후자는 하나의 절대 순간을
    가리키는 timestamp의 offset(`Z` 또는 `±HH:MM`)입니다. 절대 시각에는 named zone을 쓰지 않고,
    zone 식별자에는 `+09:00` 같은 고정 offset을 쓰지 않습니다.
- 계약에는 `Date` 객체를 포함하지 않으며, `z.coerce`를 사용하지 않습니다. 시각은 항상 문자열로
  전달됩니다.

## 측정 단위

| 필드 | 단위 | 범위 |
| --- | --- | --- |
| latitude | 도(°) | `-90 ~ 90` |
| longitude | 도(°) | `-180 ~ 180` |
| temperatureCelsius / feelsLikeCelsius / min·maxTemperatureCelsius | ℃ | 음수 허용 |
| humidityPercent | % | `0 ~ 100` |
| precipitationProbabilityPercent | % | `0 ~ 100` |
| windSpeedMetersPerSecond | m/s | `>= 0` |
| windDirectionDegrees | 도(°) | `0 이상 360 미만` |
| precipitationLastHourMillimeters / precipitationAmountMillimeters | mm | `>= 0` |
| snowfallAmountCentimeters | cm | `>= 0` |
| visibilityMeters | m | `>= 0` |
| pm10MicrogramsPerCubicMeter / pm25MicrogramsPerCubicMeter | ㎍/㎥ | `>= 0` |
| ozonePartsPerMillion | ppm | `>= 0` |
| comprehensiveAirQualityIndex (CAI) | Provider 정의 지수 | `>= 0` |

모든 숫자는 `z.number()`로 정의하여 `NaN`과 `Infinity`를 허용하지 않습니다(Zod 4의
`z.number()`는 유한한 수만 받습니다).

## Provider 원본 코드 비노출

정규화 계약에는 Provider 원본 코드·원문 구조를 그대로 담지 않습니다.

- `WeatherLocation.id`, `SourceMetadata.sourceId`, `WeatherAlert.id`는 앱이 발급·관리하는
  opaque 식별자입니다. 기상청 격자(nx/ny), 에어코리아 측정소 ID, Provider 원본 특보 코드 등을
  노출하지 않습니다.
- 기상 상태·대기질 등급·특보 종류/심각도는 공통 enum으로 정규화합니다. Provider 원본 범주
  문자열을 계약에 추가하지 않습니다.

## 강수량·적설량 정규화 규범 (향후 Provider가 따를 규칙)

이번 PR에서는 Provider 매핑 함수를 구현하지 않습니다. 향후 Provider가 원본 강수량·적설량
범주 문자열을 계약의 수치(mm/cm)로 변환할 때 아래 규칙을 동일하게 따릅니다.

| 원본 표현 | 정규화 값 |
| --- | --- |
| 명확한 숫자 | 해당 숫자 |
| 없음 | `0` |
| `T 미만` (예: `1.0mm 미만`) | `T / 2` |
| `L~U` (범위) | 하한 `L` |
| `T 이상` | 하한 `T` |
| 미제공·통신장애·파싱 불가 | `null` |

- Provider 원본 범주 문자열은 공통 계약에 추가하지 않습니다.
- 수치 + qualifier 구조는 이번 PR에서 추가하지 않습니다.

## 기상특보 severity 매핑 규범 (향후 Provider가 따를 원칙)

| 원본 수준 | severity |
| --- | --- |
| 주의보 | `ADVISORY` |
| 경보 | `WARNING` |
| 긴급재난 수준 | `EMERGENCY` |
| 단순 정보·예비 정보 | `INFO` |
| 매핑 불가 | `UNKNOWN` |

실제 KMA 코드 매핑은 후속 Provider PR 범위입니다.

## `kmaGrid`가 공유 계약에서 제외된 이유

기상청 격자 좌표(`kmaGrid`, nx/ny)는 특정 Provider(KMA)에 종속된 조회 키입니다. 이를 공유
계약에 넣으면 모바일·생활지수 엔진이 특정 Provider 세부사항에 결합됩니다. 따라서
`WeatherLocation`은 앱 발급 opaque `id`만 가지며, `kmaGrid`는 필요 시 **모바일 로컬 저장
모델**이나 **서버 내부 위치 레지스트리**에서 별도로 다룹니다. `isCurrentLocation`,
`sortOrder` 같은 UI/저장 관심사도 공유 계약에서 제외합니다.

object 스키마는 Zod 기본 동작을 사용하여 알 수 없는 추가 필드를 제거합니다. 따라서 실수로
`kmaGrid` 같은 필드가 섞여 들어와도 파싱 결과에서 제거됩니다.

## 일별 예보의 `overall` vs `morning`/`afternoon`

- 중기예보 **D+8~D+10**처럼 하루 단일 상태만 있는 경우 상태를 `overall`에 저장합니다. 단일
  상태를 `morning`과 `afternoon`에 복제하지 않습니다.
- **D+3~D+7**처럼 오전·오후 상태가 구분되는 경우 `morning`/`afternoon`을 사용합니다.
- 세 period(`overall`/`morning`/`afternoon`)가 모두 `null`인 daily entry도 허용합니다. 온도
  데이터만 있고 상태 데이터가 없는 경우를 표현합니다.

## 향후 additive 확장 예정 항목

아래 항목들은 향후 **버전을 올리지 않는 additive nullable** 데이터로 추가될 예정입니다.

- **자외선(UV)**: 추후 nullable 데이터로 추가.
- **현재 condition(DERIVED)**: 현재 날씨의 `condition`은 향후 KMA Provider에서 실황과
  초단기예보를 조합한 `DERIVED` 데이터가 될 수 있습니다. 계약 형태는 동일하게 유지되며 출처는
  `SourceMetadata.provider = DERIVED`로 표기됩니다.
- **CAI(comprehensiveAirQualityIndex)**: 에어코리아 등 Provider가 정의하는 종합지수입니다.
  해외 Provider에서는 값이 없을 수 있으므로 `null`이 될 수 있습니다.
