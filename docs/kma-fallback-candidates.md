# KMA primary/previous 발표시각 후보 (fallback candidates)

이 문서는 `@life-weather/weather-core`가 하나의 절대 시각으로부터 **두 개의 KMA 발표시각 후보**
(`primary`·`previous`)를 결정론적으로 생성하는 순수 함수
(`selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay`)를 기록합니다.

이 함수는 PR #14 availability-delay selector([kma-api-availability-time.md](./kma-api-availability-time.md),
`selectLatestKmaForecastBaseTimeAfterAvailabilityDelay`)를 **두 reference에 조합**할 뿐, 발표 일정
배열·KST 달력·날짜 rollover·연도 검증·availability threshold를 다시 구현하지 않습니다. PR #8 schedule
selector와 PR #14 availability-delay selector의 의미와 동작은 이 PR에서 **변경하지 않습니다.**

## 목적

후속 orchestration PR이 no-data 또는 publication-in-progress 상황에서 **직전 발표시각으로 단 한 번
fallback**할 수 있도록, caller가 제공한 하나의 절대 시각에서 다음 두 후보를 미리 계산합니다.

- `primary` — 현재 기준시각에서 PR #14 availability-delay selector가 선택하는 최신 후보.
- `previous` — `primary` 바로 이전의 공식 scheduled issuance(단 한 개).

이번 PR은 **후보 생성만** 담당합니다. Provider 호출, 두 번째 HTTP 요청, retry, fallback
orchestration, `resultCode === '03'`·`totalCount === 0`·`hourly.length === 0`·normalization failure
판정, live availability probe는 모두 이 함수의 범위 밖이며 후속 PR의 몫입니다.

## 구현 위치

- [fallback-candidates.ts](../packages/weather-core/src/kma/fallback-candidates.ts) — candidate selector 순수 함수
- [fallback-candidates 테스트](../packages/weather-core/src/__tests__/kma-fallback-candidates.test.ts)

이 위치에 두는 이유: KMA 발표 schedule과 availability 후보에 관한 **순수 도메인 계산**이며
Provider/application/network와 무관하고, `apps/api`와 mobile에서 재사용 가능한 결정론적 함수이자
runtime dependency가 없기 때문입니다.

## 공개 API

```ts
export type SelectKmaForecastBaseTimeCandidatesAfterAvailabilityDelayInput =
  SelectLatestKmaForecastBaseTimeAfterAvailabilityDelayInput;

export interface KmaForecastBaseTimeCandidates {
  readonly primary: KmaForecastBaseTime;
  readonly previous: KmaForecastBaseTime;
}

export function selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay(
  input: SelectKmaForecastBaseTimeCandidatesAfterAvailabilityDelayInput,
): KmaForecastBaseTimeCandidates;
```

- **input type 재사용.** 신규 input type은 PR #14 input type의 **alias**입니다(즉 schedule selector
  input의 alias이기도 함). 같은 `product` + `referenceEpochMilliseconds` shape을 공유하므로 새로운
  optional 설정을 추가하지 않습니다.
- **result / nested type.** result는 정확히 `primary`·`previous` 두 key만 가집니다. 각 후보는 기존
  `KmaForecastBaseTime`(정확히 `baseDate`·`baseTime`)을 재사용합니다. 새 error union, retry result,
  attempt metadata, 배열, `fallbackUsed` 같은 상태 field를 만들지 않습니다.

## `primary`와 `previous`의 의미

- `primary`는 PR #14 selector를 **원본 reference**에 호출한 결과입니다 — availability threshold(단기
  10분·초단기 15분, exact inclusive)를 이미 통과한 최신 issuance입니다.
- `previous`는 `primary` **바로 이전** 한 개의 공식 scheduled issuance입니다. 후속 PR이 한 번만
  사용할 수 있는 단일 fallback 후보이며, 여러 이전 후보를 생성하지 않습니다.

## 알고리즘 — `reference − one issuance interval`

```text
caller-supplied 절대 instant
  → PR #14 selector를 원본 reference에 호출                → primary
  → product별 한 issuance interval을 원본 reference에서 차감
  → PR #14 selector를 shifted reference에 재호출           → previous
  → { primary, previous }
```

1. 원본 input으로 PR #14 selector를 먼저 호출해 `primary`를 얻습니다(원본 reference의 기존 검증
   계약도 이 호출이 재사용).
2. product별 한 issuance interval 밀리초를 선택합니다(SHORT 3시간·ULTRA 1시간).
3. 원본 reference에서 정확히 한 interval을 차감합니다.
4. fresh two-key input(`product` + `referenceEpochMilliseconds`)으로 PR #14 selector를 다시 호출해
   `previous`를 얻습니다.
5. fresh wrapper `{ primary, previous }`를 반환합니다.

### 왜 한 interval을 차감하면 되는가

현재 지원 schedule은 product별로 **균일**합니다(SHORT 항상 3시간, ULTRA 항상 1시간). PR #14
availability threshold도 product별로 모든 issuance에 동일합니다. 따라서 같은 절대 reference에서 한
issuance interval을 차감하면 availability bucket도 정확히 하나 전으로 이동합니다.

| product | reference (KST) | primary | previous |
| --- | --- | --- | --- |
| SHORT | `05:10:00.000` | `20260718` / `0500` | `20260718` / `0200` |
| SHORT | `05:09:59.999` | `20260718` / `0200` | `20260717` / `2300` |
| SHORT | `02:10:00.000` | `20260718` / `0200` | `20260717` / `2300` |
| SHORT | `23:10:00.000` | `20260718` / `2300` | `20260718` / `2000` |
| ULTRA | `00:45:00.000` | `20260718` / `0030` | `20260717` / `2330` |
| ULTRA | `06:45:00.000` | `20260718` / `0630` | `20260718` / `0530` |
| ULTRA | `06:44:59.999` | `20260718` / `0530` | `20260718` / `0430` |
| ULTRA | `23:45:00.000` | `20260718` / `2330` | `20260718` / `2230` |

(예시 날짜는 `2026-07-18` KST.)

이번 PR은 다음을 **하지 않습니다**: `primary`의 문자열 `baseDate`/`baseTime`을 다시 epoch로 parsing,
schedule 배열 복제, KST calendar 계산, Date rollover 계산, 임의 search loop, 여러 이전 후보 생성.

## 기존 selector 재사용 (일정·달력·threshold 비복제)

이 파일이 소유하는 **유일한 product 정책**은 현재 schedule의 균일한 issuance interval(SHORT 3시간·
ULTRA 1시간)뿐입니다. 다음은 전부 PR #8 schedule selector와 PR #14 availability-delay selector가
소유하며 여기서 복제하지 않습니다.

- SHORT 발표시각 배열(`0200/…/2300`)·ULTRA 24시간 `HH30` 배열
- 10분·15분 availability threshold
- KST `UTC+09:00` offset·`Date` 달력 계산
- previous-day / month / year / leap-day rollover
- 지원 연도 검증·`baseDate`/`baseTime` formatting

module-private 상수(`HOUR_IN_MILLISECONDS`, `SHORT_FORECAST_ISSUANCE_INTERVAL_MILLISECONDS`,
`ULTRA_SHORT_FORECAST_ISSUANCE_INTERVAL_MILLISECONDS`)와 helper(`issuanceIntervalMillisecondsFor`)는
export하지 않으며, mutable object/Map/Set/cache/singleton을 만들지 않습니다.

> **주의: 3시간·1시간은 현재 공식 발표 schedule의 균일한 issuance 간격**이고, 10분·15분 threshold는
> PR #14가 공식 가이드의 근사 제공시각 안내를 모델링한 **프로젝트 정책**입니다. 어느 쪽도 millisecond
> 단위 공식 SLA를 뜻하지 않습니다.

## 날짜·월·연·윤일 rollover

`previous` reference가 그 KST 날짜의 첫 발표시각보다 이르면 previous-day rollover가 일어나며,
month-end/year-end/leap-day 경계는 composed selector가 정확히 처리합니다(이 파일은 계산하지 않음).

| product | reference (KST) | primary | previous |
| --- | --- | --- | --- |
| SHORT | `2026-01-01 02:10` | `20260101` / `0200` | `20251231` / `2300` (연말) |
| ULTRA | `2026-01-01 00:45` | `20260101` / `0030` | `20251231` / `2330` (연말) |
| SHORT | `2026-08-01 02:10` | `20260801` / `0200` | `20260731` / `2300` (월말) |
| ULTRA | `2026-08-01 00:45` | `20260801` / `0030` | `20260731` / `2330` (월말) |
| SHORT | `2024-03-01 02:10` | `20240301` / `0200` | `20240229` / `2300` (윤일) |
| ULTRA | `2024-03-01 00:45` | `20240301` / `0030` | `20240229` / `2330` (윤일) |

## 지원 연도 `[1000, 9999]`와 lower-bound previous 후보 오류

지원 연도 정책 `[1000, 9999]`은 PR #8 selector가 소유하며, `primary`와 `previous` 모두에 적용됩니다.
`previous`는 원본 reference에서 한 interval을 더 뒤로 이동하므로, `1000-01-01` 하한 근처에서는
`primary`가 유효해도 `previous`가 `0999`로 rollover할 수 있습니다.

이때는 **전체 candidate 함수가 `RangeError`로 거부**됩니다 — `primary`만 부분 반환하지 않습니다.

| product | reference (KST) | 결과 |
| --- | --- | --- |
| SHORT | `1000-01-01 05:10` | `primary 10000101/0500`, `previous 10000101/0200` |
| SHORT | `1000-01-01 02:10` | `RangeError` (previous가 `0999-12-31/2300`) |
| ULTRA | `1000-01-01 01:45` | `primary 10000101/0130`, `previous 10000101/0030` |
| ULTRA | `1000-01-01 00:45` | `RangeError` (previous가 `0999-12-31/2330`) |
| SHORT | `9999-12-31 23:10` | `primary 99991231/2300`, `previous 99991231/2000` |

## 오류 정책

PR #14 selector의 `RangeError` 계약을 **그대로 전파**합니다(catch·변환·wrapping 없음, 새 error union
없음). 다음이면 `RangeError`입니다.

- `referenceEpochMilliseconds`가 number 아님(런타임 우회)·`NaN`·`Infinity`·`-Infinity`·소수·unsafe
  integer·`Date` 표현 범위 밖·KST 지원 연도 밖
- `primary` 또는 `previous` 후보가 지원 연도 아래로 rollover
- unsupported `product`(임의 default interval 없음)

정상 실행 경로에서는 공개 함수가 먼저 PR #14 selector를 **원본 input**에 호출하므로, product와 epoch의
validation 순서는 기존 selector 계약을 따릅니다(epoch 우선 검증). 오류 메시지는 값을 담지 않는 고정
메시지이며 원본 input 값·product·파생 epoch/year·secret marker를 담지 않고 input을 직렬화하지
않습니다. 반환하지 않는 것: `null`, partial result, clamp, duplicate primary, error result union.

## deterministic / pure / fresh / no mutation

- deterministic — 같은 input에 deep-equal result, 매 호출마다 fresh wrapper·fresh `primary`·fresh
  `previous`. `primary`와 `previous`는 서로 다른 object reference이며 값도 서로 다른 issuance입니다.
- 시스템 clock 미사용(`Date.now`/`new Date` 없음), environment 미사용(`process.env` 없음),
  locale/timezone/`Intl` 미사용, network 미사용, timer/listener 없음, logging 없음, `try/catch` 없음,
  `Math.random` 없음.
- input mutation 없음, frozen input에서도 동작, extra input property는 output에 노출되지 않음.
- runtime 의존은 `./condition`(`KmaForecastProduct`)·`./issue-time`(type)·`./api-availability-time`
  (PR #14 selector·type)뿐이며, `@life-weather/contracts`·zod·Hono·React Native·Node 전용 API·외부
  date/network library에 의존하지 않습니다.

## 보장하지 않는 것

- **no Provider/network.** 두 번째 HTTP 요청을 실행하지 않습니다.
- **no system clock / environment.** "현재 시각"은 caller가 입력으로 제공합니다.
- **no retry / no fallback execution.** 후보만 생성하며 실제 재호출·대체를 수행하지 않습니다.
- **no trigger classification.** `resultCode 03`·`totalCount 0`·empty `hourly`·normalization failure를
  판정하지 않습니다.
- **no live availability guarantee / no official SLA.** 3시간·1시간 interval과 10분·15분 threshold는
  각각 현재 공식 schedule 간격과 프로젝트 정책일 뿐, 특정 호출 시점의 실제 가용성을 보장하지 않습니다.

## 연결 상태

- 이 candidate selector는 **아직 `apps/api`에서 소비하지 않습니다.** production 동작은 불변입니다 —
  production은 PR #15에서 연결된 PR #14 single selector로 계속 facade 호출당 최대 1회 KMA 요청만
  수행합니다([kma-production-composition.md](./kma-production-composition.md),
  [kma-forecast-request-factory.md](./kma-forecast-request-factory.md)).

## 다음 orchestration PR 권장 범위

1. fallback eligibility classifier(no-data / publication-in-progress 판정)
2. primary + previous request plan factory
3. 이전 issuance 단일 fallback orchestration
4. `WeatherOverview`/`SourceMetadata` assembler
5. `/weather` route와 HTTP mapping
6. cache / stale-data

## 변경 이력

```text
v1 / PR #16 / 2026-07
- availability-aware primary 후보 생성
- 한 issuance 이전 previous 후보 생성
- SHORT 3시간 / ULTRA 1시간 interval 적용
- 기존 schedule 및 availability selector 재사용
- Provider/result 판정과 재호출은 제외
```
