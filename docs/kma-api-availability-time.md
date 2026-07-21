# KMA API 제공 지연 반영 발표시각 선택 (availability-delay selector)

이 문서는 `@life-weather/weather-core`가 기상청(KMA) 활용가이드의 **근사 API 제공시각 안내**를 기반으로
프로젝트가 정의한 **결정론적 제공시각 임계값(availability threshold)을 이미 통과한 가장 최근
발표시각**(`base_date` / `base_time`)을, 호출자가 제공한 절대 시각을 기준으로 선택하는 순수 함수
(`selectLatestKmaForecastBaseTimeAfterAvailabilityDelay`)를 기록합니다.

이 selector는 PR #8의 schedule selector([kma-issue-time.md](./kma-issue-time.md),
`selectLatestKmaForecastBaseTime`)를 **조합**할 뿐, 발표 일정·KST 달력·날짜 rollover·연도 검증을 다시
구현하지 않습니다. schedule selector의 의미와 동작은 이 PR에서 **변경하지 않습니다.**

## 목적

- schedule selector는 "공식 발표 일정상 가장 최근 issuance"를 선택합니다.
- 이 selector는 거기에 활용가이드의 별도 `API 제공 시간 (~ 이후)` 근사 안내를 프로젝트 임계값으로
  모델링해 얹어, 다음 조건을 충족하는 가장 최근 issuance를 선택합니다.

```text
공식 발표시각 + product별 프로젝트 적용 threshold  ≤  reference instant
```

즉 "발표는 됐고, 프로젝트가 모델링한 제공시각 임계값도 지난" 가장 최근 발표시각을 고르는 **schedule
기반 availability 후보**입니다.

## 구현 위치

- [api-availability-time.ts](../packages/weather-core/src/kma/api-availability-time.ts) — availability-delay selector 순수 함수
- [api-availability-time 테스트](../packages/weather-core/src/__tests__/kma-api-availability-time.test.ts)

## 흐름 (adjusted-reference 알고리즘)

```text
호출자가 제공한 절대 instant
  → product별 프로젝트 적용 threshold만큼 reference를 과거로 이동 (reference − threshold)
  → schedule selector(selectLatestKmaForecastBaseTime)를 그 adjusted instant에 재사용
  → { baseDate, baseTime }
```

구체적으로 다음 순서로 동작합니다.

1. **원본 instant로 schedule selector를 1회 호출** — 호출자가 준 절대 reference 자체의 기존 검증 계약
   (epoch shape, `Date` 범위, KST 연도, product)을 재사용합니다.
2. product별 프로젝트 적용 threshold 밀리초를 선택합니다(SHORT 10분, ULTRA 15분).
3. adjusted reference `referenceEpochMilliseconds − threshold`를 계산합니다.
4. **fresh input 객체로 schedule selector를 다시 호출** — availability-adjusted instant의 발표시각
   선택과 rollover/연도 검증을 재사용합니다.
5. 그 결과를 그대로 반환합니다.

고정된 밀리초를 빼는 것뿐이므로 adjusted 값도 여전히 **절대 instant**이고, 모든 KST 달력 계산은
schedule selector가 소유합니다.

## 공개 API

```ts
export type SelectLatestKmaForecastBaseTimeAfterAvailabilityDelayInput =
  SelectLatestKmaForecastBaseTimeInput;

export function selectLatestKmaForecastBaseTimeAfterAvailabilityDelay(
  input: SelectLatestKmaForecastBaseTimeAfterAvailabilityDelayInput,
): KmaForecastBaseTime;
```

- **input/result type 재사용.** 신규 input type은 기존 `SelectLatestKmaForecastBaseTimeInput`의
  **alias**입니다(같은 `product` + `referenceEpochMilliseconds` shape). 이렇게 하면 두 selector의 input
  계약이 drift하지 않고, 새로운 optional 설정이나 safety-margin field를 추가하지 않습니다. 반환 type도
  기존 `KmaForecastBaseTime`을 그대로 사용하며 새 result type을 만들지 않습니다.

## 공식 제공시각 안내를 모델링한 프로젝트 임계값

활용가이드는 각 product의 발표 일정과 함께 `API 제공 시간 (~ 이후)`을 안내합니다. 이 프로젝트는 그
근사 제공시각 안내를 기반으로 SHORT 10분, ULTRA 15분의 정확한 millisecond-inclusive threshold를
정의합니다. 이 정확한 경계는 결정론적 선택을 위한 프로젝트 정책이며, 공식 SLA나 실제 API 가용성 완료
보장이 아닙니다.

| product | 발표시각(KST) | 공식 가이드 제공시각 안내 | 프로젝트 적용 threshold |
| --- | --- | --- | --- |
| `SHORT_FORECAST` (`getVilageFcst`) | `0200/0500/…/2300` (1일 8회) | `~02:10, ~05:10, … 이후` | 발표 후 **10분** |
| `ULTRA_SHORT_FORECAST` (`getUltraSrtFcst`) | 매시간 `HH30` | `~HH45 이후` | 발표 후 **15분** |

module-private 상수(`MINUTE_IN_MILLISECONDS`,
`SHORT_FORECAST_API_AVAILABILITY_DELAY_MILLISECONDS`,
`ULTRA_SHORT_FORECAST_API_AVAILABILITY_DELAY_MILLISECONDS`)로 두며 export하지 않습니다. mutable
object/Map/cache/module singleton을 만들지 않습니다. **safety margin은 추가하지 않습니다.** 공식
가이드의 근사 제공시각 안내를 SHORT 10분·ULTRA 15분으로 모델링한 프로젝트 threshold만 적용합니다.

## threshold는 inclusive

`발표시각 + threshold`와 정확히 같은 순간에 그 issuance가 선택 가능해집니다. 입력의 초·밀리초까지
비교에 반영합니다.

아래 `.999/.000/.001` 경계는 공식 문서가 millisecond 단위 SLA를 명시했다는 뜻이 아닙니다. 공식 가이드의
근사 제공시각을 코드에서 일관되게 계산하기 위해 프로젝트가 정의한 inclusive threshold입니다.

| product | reference (KST) | 결과 |
| --- | --- | --- |
| SHORT | `05:09:59.999` | 당일 `0200` (0500은 아직 제공 전) |
| SHORT | `05:10:00.000` | 당일 `0500` (제공시각 임계값 통과) |
| SHORT | `05:10:00.001` | 당일 `0500` |
| ULTRA | `06:44:59.999` | 당일 `0530` (0630은 아직 제공 전) |
| ULTRA | `06:45:00.000` | 당일 `0630` (제공시각 임계값 통과) |

## KST는 고정 UTC+09:00

- KST offset은 `+9시간` 고정이며 daylight saving time이 없습니다.
- host locale·host timezone·`process.env.TZ`·`Intl`에 의존하지 않습니다.
- KST 달력 계산은 schedule selector가 소유하며 이 함수는 이를 재사용합니다. 같은 절대 instant는
  `+09:00` 표기든 UTC `Z` 표기든 동일한 결과를 냅니다.

## 기존 scheduled selector와의 차이

| | schedule selector (PR #8) | availability-delay selector (PR #14) |
| --- | --- | --- |
| 의미 | reference와 같거나 이전인 가장 최근 **발표 예정** issuance | 프로젝트가 모델링한 제공시각 임계값을 이미 통과한 가장 최근 issuance |
| 계산 | reference에 직접 발표 일정 적용 | `reference − threshold`에 발표 일정 적용 |

동일 절대 reference를 두 selector에 각각 호출한 결과:

| product | reference (KST) | schedule selector | availability-delay selector |
| --- | --- | --- | --- |
| SHORT | `05:00` | `0500` | `0200` |
| SHORT | `05:10` | `0500` | `0500` |
| ULTRA | `06:30` | `0630` | `0530` |
| ULTRA | `06:45` | `0630` | `0630` |

schedule selector는 이 PR에서 availability threshold를 **얻지 않습니다.** availability threshold는 오직
이 신규 selector에서만 적용됩니다.

## 기존 selector 재사용 (일정·달력 로직 비복제)

이 selector는 다음을 **복제하지 않습니다.** 전부 schedule selector가 소유합니다.

- SHORT 발표시각 배열(`0200/…/2300`)·ULTRA `HH30` 배열
- KST offset 계산·`Date` 달력 계산
- previous-day rollover·month/year rollover·leap-year 로직
- year formatting·지원 연도 검증

이 파일은 오직 product별 고정 밀리초를 빼고 schedule selector를 두 번 호출하는 얇은 조합 계층입니다.

## RangeError 정책

기존 schedule selector의 오류 계약을 **그대로 재사용**합니다. 새 error class, 새 result union을 만들지
않고, 오류를 catch하거나 변환하지 않습니다.

`referenceEpochMilliseconds`가 다음이면 `RangeError`:

- number가 아님(런타임 우회), `NaN`, `Infinity`, `-Infinity`
- 소수(fractional) 밀리초
- unsafe integer(`Number.MAX_SAFE_INTEGER` 초과 / `Number.MIN_SAFE_INTEGER` 미만)
- `Date`가 표현할 수 있는 instant 범위 밖
- KST 지원 연도 `[1000, 9999]` 밖
- **availability adjustment 이후** 선택된 `base_date` 연도가 `[1000, 9999]` 밖(예 `1000-01-01` 하한에서
  `reference − threshold`가 첫 발표시각 이전으로 밀려 `0999`로 rollover)

`product`가 지원하는 두 값이 아니면(타입 우회 포함) `RangeError`. unsupported product에 임의 default
threshold를 적용하지 않습니다.

오류 메시지는 **값을 담지 않는 고정 메시지**입니다: 원본 input 값, 원본 product, adjusted epoch, 파생
연도, secret-shaped marker를 담지 않고 input 객체를 직렬화하지 않습니다. 비-number 타입의 reference
(타입 우회)도 `TypeError`가 아니라 `RangeError`입니다.

## 날짜·월·연·윤년 rollover와 지원 연도 하한

adjusted instant가 그 KST 날짜의 첫 발표시각보다 이르면 previous-day rollover가 일어나며,
month-end/year-end/leap-day 경계는 schedule selector가 정확히 처리합니다.

| product | reference (KST) | 결과 |
| --- | --- | --- |
| SHORT | `2026-01-01 02:09:59.999` | `20251231` / `2300` (연말 rollover) |
| SHORT | `2026-01-01 02:10:00.000` | `20260101` / `0200` |
| ULTRA | `2026-01-01 00:44:59.999` | `20251231` / `2330` |
| ULTRA | `2026-01-01 00:45:00.000` | `20260101` / `0030` |
| SHORT | `2026-08-01 02:09:59.999` | `20260731` / `2300` (월말 rollover) |
| ULTRA | `2026-08-01 00:44:59.999` | `20260731` / `2330` |
| SHORT | `2024-03-01 02:09:59.999` | `20240229` / `2300` (윤년) |
| ULTRA | `2024-03-01 00:44:59.999` | `20240229` / `2330` (윤년) |

지원 연도 하한 `[1000, 9999]`도 그대로 유지됩니다.

| product | reference (KST) | 결과 |
| --- | --- | --- |
| SHORT | `1000-01-01 02:09:59.999` | `RangeError` (adjusted 선택이 `0999`로 rollover) |
| SHORT | `1000-01-01 02:10:00.000` | `10000101` / `0200` |
| ULTRA | `1000-01-01 00:44:59.999` | `RangeError` (adjusted 선택이 `0999`로 rollover) |
| ULTRA | `1000-01-01 00:45:00.000` | `10000101` / `0030` |

`0999` 값을 반환하거나 clamp하지 않습니다.

## 보장하는 것과 보장하지 않는 것

공식 가이드의 근사 제공시각 안내(source)와 프로젝트가 그로부터 정의한 정확한 임계값(local policy)은
서로 구분됩니다. 아래 보장 범위는 그 프로젝트 임계값에 대한 것입니다.

이 selector가 **보장**하는 것:

- 프로젝트가 모델링한 제공시각 임계값(threshold)을 아직 통과하지 않은 최신 issuance를 선택하지 않음
- threshold를 통과한 가장 최근 scheduled issuance 선택
- KST 고정 UTC+09:00, 결정론적 결과, host timezone 독립, 외부 I/O 없음

이 selector가 **보장하지 않는** 것(따라서 `guaranteed available`/`live ready`/`upstream confirmed`/
`publication completed`/`API success guaranteed` 같은 과장 표현을 쓰지 않습니다):

- SHORT 10분·ULTRA 15분의 정확한 millisecond 경계가 공식 SLA라는 것 — 이는 프로젝트의 로컬 정책입니다
- 실제 upstream replication 완료
- 특정 호출 시점의 live API 성공, KMA 장애 없음, 공공데이터포털 gateway 정상
- 최신 issuance가 실제로 존재함, empty page가 반환되지 않음, partial publication이 발생하지 않음

이 selector는 **schedule 기반 availability 후보**이자 **deterministic availability policy**일
뿐입니다. **no safety margin**, **no live availability guarantee**, **no retry/fallback**입니다. 실제
가용성은 후속 probe/retry/fallback의 대상입니다.

## 순수성 / 런타임 의존 없음

- deterministic — 같은 input에 deep-equal result, 성공 시 매 호출마다 fresh result 객체.
- 시스템 clock 미사용(`Date.now`/`new Date` 없음), environment 미사용(`process.env` 없음),
  locale/timezone/`Intl` 미사용, network 미사용(`fetch`/`AbortController` 없음), timer/listener 없음,
  logging 없음, `try/catch` 없음, `Math.random` 없음.
- input mutation 없음, frozen input에서도 동작, extra input property는 output에 노출되지 않음, output
  own keys는 정확히 `baseDate`/`baseTime`.
- 런타임 의존은 `./condition`(`KmaForecastProduct`)과 `./issue-time`(schedule selector) 뿐이며,
  `@life-weather/contracts`·zod·Hono·React Native·Node 전용 API·외부 date/network library에 의존하지
  않습니다.

## 공식 자료

이 selector의 delay 값이 반영하는 **대상 endpoint**는 공공데이터포털 `VilageFcstInfoService_2.0`의
다음 두 오퍼레이션입니다.

- 단기예보: `VilageFcstInfoService_2.0/getVilageFcst`
- 초단기예보: `VilageFcstInfoService_2.0/getUltraSrtFcst`

| 항목 | 값 |
| --- | --- |
| 공식 서비스명 | 기상청_단기예보 조회서비스 |
| 공공데이터 ID | `15084084` |
| 서비스(오퍼레이션) 버전 | `VilageFcstInfoService_2.0` |
| 공공데이터포털 활용가이드 | 기상청41_단기예보 조회서비스_오픈API활용가이드_2607.zip |
| API 허브 활용가이드 | 단기예보조회서비스_API활용가이드_260623.docx |

프로젝트가 SHORT 10분·ULTRA 15분 threshold로 모델링한 직접 근거는 활용가이드 `# 예보 발표시각` 절의
근사 `API 제공 시간 (~ 이후)` 안내로, 단기예보 `~02:10, ~05:10, … 이후`, 초단기예보 `~HH45 이후`입니다.
이 안내는 이미 [kma-issue-time.md](./kma-issue-time.md)에 기록된 발표 일정 근거와 동일한 hash 검증
가이드에서 확인된 것입니다.

### DOCX/ZIP hash 상태

| 파일 | SHA-256 | 이번 PR 세션 확인 |
| --- | --- | --- |
| API 허브 활용가이드 `단기예보조회서비스_API활용가이드_260623.docx` | `99504eafccd7fef184f3e26a25a71de4804461826528ef2223ff72027e500d30` | 기존 기록값(이전 세션에서 직접 다운로드·해시 검증); 이번 세션 재다운로드·재검증 **미수행** |
| 공공데이터포털 `기상청41_단기예보 조회서비스_오픈API활용가이드_2607.zip` | `07f53cd9d6d6512bce6ef870d54cb740046a0a949896e6855caecf739fb8842e` | 기존 기록값(상세페이지 JS 게이트); 이번 세션 재다운로드·재검증 **미수행** |
| 위 ZIP 내부 DOCX | `20d855aa3071a2bdda6dce3c13bab6428ebb02f8d4a30688e26ed0851d6d0848` | 기존 기록값; 이번 세션 재검증 **미수행** |

> 위 SHA-256 값은 이전 프로젝트/세션에서 검증된 **기존 기록값**입니다. 이번 PR 세션에서는 파일을 다시
> 확보하지 못해 재다운로드·재해시하지 않았으므로 "이번 세션에 재검증했다"고 주장하지 않습니다. runtime
> delay 값(10/15분)은 이 기록된 근거를 따랐으며, 추측으로 변경하지 않았습니다. 확인 주체: Claude
> (Claude Code), 확인일 2026-07-20(기존 기록 근거 인용).

## 실제 live 검증 미수행

- 실제 `KMA_SERVICE_KEY`를 사용한 live 호출은 이번 검증에 포함하지 않았습니다. 모든 테스트는 순수
  in-memory 계산입니다(네트워크·fake clock·timer·`Date.now()` mock 없음).
- 이 selector는 프로젝트가 모델링한 제공시각 임계값만 적용할 뿐, 실제 API 가용성을 probe하거나 보장하지 않습니다.

## 연결 상태 / 후속 wiring

PR #14는 순수 selector만 추가했고, **PR #15에서 이 selector가 `apps/api` production에 실제 연결**됐습니다.

- **request factory selector seam 연결(PR #15).** `apps/api`의 `createKmaForecastRequestFactory`에
  주입 가능한 `baseTimeSelector` 인자가 추가됐습니다. selector를 **생략**하면 여전히 PR #8
  `selectLatestKmaForecastBaseTime`(schedule-only)이 default이고 method 이름 `createScheduledRequest`도
  그대로입니다. direct one-argument caller는 schedule-only 동작을 유지합니다
  ([kma-forecast-request-factory.md](./kma-forecast-request-factory.md)).
- **production composition에 주입(PR #15).** grid scheduled composition이 이 selector를 request factory에
  명시적으로 주입하며, location composition은 그 grid composition을 재사용하므로 정책을 자동 상속합니다.
  즉 두 production pipeline 모두 이 프로젝트 threshold(단기 10분·초단기 15분)를 적용합니다
  ([kma-production-composition.md](./kma-production-composition.md),
  [kma-location-scheduled-hourly.md](./kma-location-scheduled-hourly.md)).
- **exact threshold는 여전히 프로젝트 정책.** PR #15는 selector를 production에 연결할 뿐, threshold 숫자나
  근거를 변경하지 않습니다. 이는 공식 SLA가 아니며 live readiness를 보장하지 않습니다.
- **live fallback/retry는 여전히 미구현.** `/weather` route·HTTP status mapping·
  `WeatherOverview`/`SourceMetadata` 조립도 여전히 후속입니다.

후속 PR 권장 범위:

1. empty-data 또는 publication-in-progress fallback 정책
2. 이전 issuance 단일 fallback orchestration
3. `WeatherOverview`/`SourceMetadata` assembler
4. `/weather` route와 HTTP mapping
5. cache/stale-data

## 변경 이력

```text
v1 / PR #14 / 2026-07
- SHORT 프로젝트 제공시각 임계값 10분 모델링
- ULTRA 프로젝트 제공시각 임계값 15분 모델링
- availability-delay-aware base-time selector 추가
- 기존 scheduled selector 계약 유지
- live retry/fallback 및 Provider wiring 제외

v2 / PR #15 / 2026-07 (production wiring — selector 정책·근거 불변)
- 이 selector가 apps/api request factory selector seam을 통해 production scheduled composition에 주입됨
- location composition은 grid composition 재사용으로 정책 상속
- direct request factory default는 여전히 schedule-only(PR #8)
- threshold 값(10/15분)·프로젝트 정책 표현·live 미보장 문구 변경 없음
```
