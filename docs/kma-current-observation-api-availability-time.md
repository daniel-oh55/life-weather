# KMA 초단기실황 API 제공 지연 반영 발표시각 선택 (current-observation availability-delay selector)

이 문서는 `@life-weather/weather-core`가 기상청(KMA) 활용가이드의 **근사 API 제공시각 안내**를
기반으로 프로젝트가 정의한 **결정론적 제공시각 임계값(availability threshold)을 이미 통과한
가장 최근 발표시각**(`base_date` / `base_time`)을, 호출자가 제공한 절대 시각을 기준으로
선택하는 순수 함수
(`selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay`)를 기록합니다.

이 selector는 PR #64의 schedule selector
([kma-current-observation-issue-time.md](./kma-current-observation-issue-time.md),
`selectLatestKmaCurrentObservationBaseTime`)를 **조합**할 뿐, 발표 일정·KST 달력·날짜
rollover·연도 검증을 다시 구현하지 않습니다. schedule selector의 의미와 동작은 이 PR에서
**변경하지 않습니다.**

forecast 쪽의 대응 selector
([kma-api-availability-time.md](./kma-api-availability-time.md),
`selectLatestKmaForecastBaseTimeAfterAvailabilityDelay`)와 같은 원칙을 따르는 **별도의, 병렬**
구현입니다 — 초단기실황은 `product` 선택이 없는 단일 operation이고 발표 스케줄(매시간 정시
`HH00`)도 다르므로, 두 selector를 공유하는 generic abstraction으로 합치지 않았습니다.

## 구현 위치

- [current-observation-api-availability-time.ts](../packages/weather-core/src/kma/current-observation-api-availability-time.ts)
  — availability-delay selector 순수 함수
- [current-observation-api-availability-time 테스트](../packages/weather-core/src/kma/current-observation-api-availability-time.test.ts)

## 목적

- schedule selector는 "공식 발표 일정상 가장 최근 issuance"를 선택합니다.
- 이 selector는 거기에 활용가이드의 별도 `API 제공 시간(~이후)` 근사 안내를 프로젝트 임계값으로
  모델링해 얹어, 다음 조건을 충족하는 가장 최근 issuance를 선택합니다.

```text
공식 HH00 발표시각 + 10분 프로젝트 threshold  ≤  reference instant
```

즉 "발표는 됐고, 프로젝트가 모델링한 제공시각 임계값도 지난" 가장 최근 발표시각을 고르는
**schedule 기반 availability 후보**입니다.

## 흐름 (adjusted-reference 알고리즘)

```text
호출자가 제공한 절대 instant
  → 10분 프로젝트 threshold만큼 reference를 과거로 이동 (reference − 10분)
  → schedule selector(selectLatestKmaCurrentObservationBaseTime)를 그 adjusted instant에 재사용
  → { baseDate, baseTime }
```

구체적으로 다음 순서로 동작합니다.

1. **원본 instant로 schedule selector를 1회 호출** — 호출자가 준 절대 reference 자체의 기존
   검증 계약(epoch shape, `Date` 범위, KST 연도)을 재사용합니다. 반환값은 버립니다.
2. adjusted reference `referenceEpochMilliseconds − 10분(밀리초)`를 계산합니다.
3. **fresh input 객체로 schedule selector를 다시 호출** — availability-adjusted instant의
   발표시각 선택과 rollover/연도 검증을 재사용합니다.
4. 그 결과를 그대로 반환합니다.

고정된 밀리초를 빼는 것뿐이므로 adjusted 값도 여전히 **절대 instant**이고, 모든 KST 달력 계산은
schedule selector가 소유합니다.

## 공개 API

```ts
export type SelectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelayInput =
  SelectLatestKmaCurrentObservationBaseTimeInput;

export function selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay(
  input: SelectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelayInput,
): KmaCurrentObservationBaseTime;
```

- **input/result type 재사용.** 신규 input type은 기존
  `SelectLatestKmaCurrentObservationBaseTimeInput`의 **alias**입니다(같은
  `referenceEpochMilliseconds` 하나뿐인 shape). 이렇게 하면 두 selector의 input 계약이
  drift하지 않고, 새로운 optional 설정이나 safety-margin field를 추가하지 않습니다. 반환 type도
  기존 `KmaCurrentObservationBaseTime`을 그대로 사용하며 새 result type을 만들지 않습니다.
- `product` 필드는 없습니다 — 초단기실황은 `getUltraSrtNcst` 단일 operation이므로 schedule
  selector와 마찬가지로 `product` 선택 개념 자체가 없습니다.

## 공식 근거와 10분 threshold

공식 Public Data Portal 서비스와 오퍼레이션:

| 항목 | 값 |
| --- | --- |
| 공식 서비스명 | 기상청_단기예보 조회서비스 |
| 서비스(오퍼레이션) 버전 | `VilageFcstInfoService_2.0` |
| 오퍼레이션 | `getUltraSrtNcst` (초단기실황조회) |

Owner가 제공한 공식 Public Data Portal 참조 ZIP과 그 안의 DOCX의 SHA-256은 다음과 같으며, 이
값은 저장소에 기존에 기록된 hash와 정확히 일치합니다.

| 파일 | SHA-256 |
| --- | --- |
| 공공데이터포털 활용가이드 ZIP `기상청41_단기예보 조회서비스_오픈API활용가이드_2607.zip` | `07f53cd9d6d6512bce6ef870d54cb740046a0a949896e6855caecf739fb8842e` |
| ZIP 내부 DOCX `기상청41_단기예보 조회서비스_오픈API활용가이드_260623.docx` | `20d855aa3071a2bdda6dce3c13bab6428ebb02f8d4a30688e26ed0851d6d0848` |

관련 가이드 절: `# 예보 발표시각` → `초단기실황 발표시각`.

가이드는 초단기실황이 **매시간 정시(`HH00`)** 에 생성되고(`0000, 0100, … , 2300`, 하루 24회),
별도의 `API 제공 시간(~이후)` 컬럼으로 다음과 같은 근사 제공시각을 안내한다고 문서화합니다.

| 발표시각(`base_time`) | 가이드 `API 제공 시간(~이후)` |
| --- | --- |
| `0000` | `~00:10` |
| `0100` | `~01:10` |
| `0200` | `~02:10` |
| … | … |
| `2300` | `~23:10` |

이 프로젝트는 이 근사 안내를 **모든 시간(0000~2300)에 공통으로 적용되는 정확한 10분** 값으로
모델링합니다. 이 정확한 millisecond 경계는 결정론적 선택을 위한 **프로젝트 정책**이며, 다음이
**아닙니다**:

- 공식 SLA
- live readiness 보장
- upstream replication 완료 보장

## threshold는 inclusive

`발표시각 + 10분`과 정확히 같은 순간에 그 issuance가 선택 가능해집니다. 입력의 초·밀리초까지
비교에 반영합니다.

| reference (KST) | 결과 |
| --- | --- |
| `05:09:59.999` | 당일 `0400` (`0500`은 아직 제공 전) |
| `05:10:00.000` | 당일 `0500` (제공시각 임계값 통과) |
| `05:10:00.001` | 당일 `0500` |

## 자정/날짜 rollover

schedule-only selector(`selectLatestKmaCurrentObservationBaseTime`) 자체는 첫 발표시각이
`0000`(자정)이라서 previous-day rollover 분기가 필요 없습니다
([kma-current-observation-issue-time.md](./kma-current-observation-issue-time.md) 참고). 하지만
이 availability-delay selector는 reference를 10분 **과거로** 이동시키므로, 그 adjusted instant가
자정 이전으로 밀려날 수 있어 previous-day rollover 가능성이 **새로 생깁니다.**

| reference (KST) | 결과 |
| --- | --- |
| `00:09:59.999` | 전일 `2300` (adjusted가 `23:59:59.999`로 밀림) |
| `00:10:00.000` | 당일 `0000` |

month-end/year-end/leap-day 경계도 schedule selector가 그대로 정확히 처리합니다(예:
`2026-01-01 00:09:59.999` → `20251231`/`2300`, `2024-03-01 00:09:59.999` → `20240229`/`2300`).
rollover 로직은 이 selector에서 별도로 구현하지 않습니다 — schedule selector가 adjusted instant
에 대해 그대로 재사용됩니다.

## 지원 연도 하한 `[1000, 9999]` — schedule-only selector와의 계약 차이

schedule-only selector는 previous-day rollover 자체가 없으므로 reference의 KST 연도 하나만
검증하면 충분합니다. 이 availability-delay selector는 reference를 10분 과거로 이동시키므로,
**원본 reference 자체는 지원 범위 안**이더라도 **adjusted instant가 지원 범위 밖으로 밀려날 수
있습니다.**

| reference (KST) | 결과 |
| --- | --- |
| `1000-01-01 00:09:59.999` | `RangeError` (adjusted가 `0999-12-31 23:59:59.999`로 밀려 연도 `0999`) |
| `1000-01-01 00:10:00.000` | `10000101` / `0000` |

`0999` 값을 반환하거나 clamp하지 않습니다 — 새 error class나 result union도 만들지 않고, 기존
schedule selector의 `RangeError`를 그대로 전파합니다.

## 기존 selector 재사용 (일정·달력 로직 비복제)

이 selector는 다음을 **복제하지 않습니다.** 전부 schedule selector
(`selectLatestKmaCurrentObservationBaseTime`)가 소유합니다.

- 매시간 정시(`HH00`) 발표 스케줄
- KST offset 계산·`Date` 달력 계산
- day/month/year/leap-day rollover
- year formatting·지원 연도 검증

이 파일은 오직 고정 10분(밀리초)을 빼고 schedule selector를 두 번 호출하는 얇은 조합
계층입니다. module-private 상수(`MINUTE_IN_MILLISECONDS`,
`CURRENT_OBSERVATION_API_AVAILABILITY_DELAY_MILLISECONDS`)로 두며 export하지 않습니다. mutable
object/Map/cache/module singleton을 만들지 않습니다. **safety margin은 추가하지 않습니다.**

## RangeError 정책

기존 schedule selector의 오류 계약을 **그대로 재사용**합니다. 새 error class, 새 result union을
만들지 않고, 오류를 catch하거나 변환하지 않습니다.

`referenceEpochMilliseconds`가 다음이면 `RangeError`:

- number가 아님(런타임 우회), `NaN`, `Infinity`, `-Infinity`
- 소수(fractional) 밀리초
- unsafe integer(`Number.MAX_SAFE_INTEGER` 초과 / `Number.MIN_SAFE_INTEGER` 미만)
- `Date`가 표현할 수 있는 instant 범위 밖
- 원본 reference의 KST 연도가 `[1000, 9999]` 밖
- **availability adjustment 이후** 선택된 `base_date` 연도가 `[1000, 9999]` 밖(예
  `1000-01-01` 하한에서 `reference − 10분`이 첫 발표시각 이전으로 밀려 `0999`로 rollover)

오류 메시지는 **값을 담지 않는 고정 메시지**입니다: 원본 input 값, adjusted epoch, 파생 연도,
secret-shaped marker를 담지 않고 input 객체를 직렬화하지 않습니다. 비-number 타입의 reference
(타입 우회)도 `TypeError`가 아니라 `RangeError`입니다.

## 순수성 / 런타임 의존 없음

- deterministic — 같은 input에 deep-equal result, 성공 시 매 호출마다 fresh result 객체.
- 시스템 clock 미사용(`Date.now`/`new Date` 없음), environment 미사용(`process.env` 없음),
  locale/timezone/`Intl` 미사용, network 미사용, timer/listener 없음, logging 없음, `try/catch`
  없음, `Math.random` 없음.
- input mutation 없음, frozen input에서도 동작, extra input property는 output에 노출되지 않음,
  output own keys는 정확히 `baseDate`/`baseTime`.
- 런타임 의존은 `./current-observation-issue-time`(schedule selector) 뿐이며,
  `@life-weather/contracts`·zod·Hono·React Native·Node 전용 API·외부 date/network library에
  의존하지 않습니다.

## 보장하는 것과 보장하지 않는 것

이 selector가 **보장**하는 것:

- 프로젝트가 모델링한 10분 제공시각 임계값을 아직 통과하지 않은 최신 issuance를 선택하지 않음
- threshold를 통과한 가장 최근 scheduled issuance 선택
- KST 고정 UTC+09:00, 결정론적 결과, host timezone 독립, 외부 I/O 없음

이 selector가 **보장하지 않는** 것(따라서 `guaranteed available`/`live ready`/`upstream
confirmed`/`publication completed`/`API success guaranteed` 같은 과장 표현을 쓰지 않습니다):

- 정확한 10분 millisecond 경계가 공식 SLA라는 것 — 이는 프로젝트의 로컬 정책입니다
- 실제 upstream replication 완료
- 특정 호출 시점의 live API 성공, KMA 장애 없음, 공공데이터포털 gateway 정상
- 최신 issuance가 실제로 존재함, empty page가 반환되지 않음, partial publication이 발생하지
  않음

## 실제 live 검증 미수행

- 실제 `KMA_SERVICE_KEY`를 사용한 live 호출은 이번 검증에 포함하지 않았습니다. 모든 테스트는
  순수 in-memory 계산입니다(네트워크·fake clock·timer·`Date.now()` mock 없음).

## 연결 상태 / 후속 wiring

PR #79는 순수 selector만 추가했습니다. **PR #80**이 이 selector를 production current-observation
composition (`createKmaScheduledCurrentObservationCompositionFromEnv`,
[kma-current-observation-production-composition.md](./kma-current-observation-production-composition.md))에
명시적으로 주입했습니다 — 그 composition은 더 이상 PR #64 schedule-only selector를 주입하지
않습니다. request factory(`createKmaCurrentObservationRequestFactory`)의 직접 one-argument 호출
default는 여전히 schedule-only selector입니다.

다음은 PR #80 이후에도 여전히 **범위 밖**입니다:

- `POST /weather` route wiring (production `current`는 여전히 응답에서 missing)
- current retry/fallback, previous-issuance fallback orchestration
- cache/stale-data
- application service/composition/route/presenter의 추가 변경
- `packages/contracts`·mobile/native/deploy 변경
- 실제 KMA API 호출, 실제 key/좌표

## 변경 이력

```text
v1 / PR #79 / 2026-08
- 초단기실황(getUltraSrtNcst) 10분 프로젝트 제공시각 임계값 모델링
- availability-delay-aware base-time selector 추가
  (selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay)
- 기존 schedule-only selector(selectLatestKmaCurrentObservationBaseTime) 계약 유지, 재구현 없음
- inclusive 10분 경계, previous-day rollover 가능성, [1000, 9999] 하한에서의 adjusted
  RangeError 문서화
- production composition에는 아직 미주입(explicit schedule-only selector 그대로), POST
  /weather 미연결, live retry/fallback 제외

v1.1 / PR #80 / 2026-08
- production current-observation composition
  (createKmaScheduledCurrentObservationCompositionFromEnv)이 이 selector를 explicit 주입
- 그 composition은 더 이상 PR #64 schedule-only selector를 주입하지 않음
- request factory의 직접 one-argument 호출 default는 schedule-only selector로 유지
- POST /weather는 여전히 미연결(hourly-only), live retry/fallback 여전히 제외
```
