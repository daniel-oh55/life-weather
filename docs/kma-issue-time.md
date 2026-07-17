# KMA 예보 발표시각 선택 (issue-time selector)

이 문서는 `@life-weather/weather-core`가 기상청(KMA) 단기예보·초단기예보의 **가장 최근 공식
발표시각**(`base_date` / `base_time`)을 결정하는 순수 함수(`selectLatestKmaForecastBaseTime`)를
기록합니다. 발표 일정은 운영 요청의 `base_date`/`base_time`을 결정하므로, 추측이나 블로그가 아니라
아래 공식 자료에서 직접 확인한 값만 사용합니다.

구현 위치:

- [issue-time.ts](../packages/weather-core/src/kma/issue-time.ts) — 발표시각 선택 순수 함수
- [issue-time 테스트](../packages/weather-core/src/__tests__/kma-issue-time.test.ts)

## 목적

- 호출자가 제공한 **절대 시각**(epoch milliseconds)을 기준으로, 해당 forecast product의 공식 발표
  일정에서 **그 시각과 같거나 이전인 가장 최근 발표시각**을 선택합니다.
- 결과는 기존 `KmaForecastRequest`에 그대로 넣을 수 있는 `{ baseDate, baseTime }`입니다.

흐름:

```text
호출자가 제공한 절대 instant
  → KST 변환 (고정 UTC+09:00)
  → product별 공식 발표 일정 적용
  → 같거나 이전인 가장 최근 발표시각 선택 (inclusive)
  → { baseDate, baseTime }
```

## 왜 호출자가 reference instant를 공급하는가

이 함수는 시스템 clock을 읽지 않습니다(`Date.now()`·`process.env.TZ`·`Intl` 미사용). 판정에 쓸
"현재 시각"은 **입력**으로 받습니다. 이렇게 하면:

- 결정론적입니다 — 동일 입력은 항상 동일 결과이므로 단위 테스트에서 fake clock이 필요 없습니다.
- host의 timezone/locale과 무관합니다 — 절대 instant만 다루므로 서버가 어디서 실행되든 동일합니다.
- clock 주입 정책을 호출 계층(후속 request factory)이 결정할 수 있습니다. 이 PR은 그 clock 주입을
  구현하지 않습니다.

이는 `classifyFreshness`가 `referenceAt`를 입력으로 받고 시스템 clock을 읽지 않는 weather-core
스타일과 동일합니다.

## API request의 `baseDate`/`baseTime`과의 관계

KMA 공공데이터포털 요청(`getVilageFcst`/`getUltraSrtFcst`)은 `base_date`(YYYYMMDD)와
`base_time`(HHmm)을 요구합니다. 이 함수의 출력이 바로 그 두 값입니다. 다만 이 PR은 요청 전체를
조립하지 **않습니다** — nx/ny 결합, `KmaForecastRequest` 생성, Provider 호출, application service
연결은 모두 후속 PR 범위입니다. 기존 `validateKmaForecastRequest`(구조 검증)와 이 selector(일정
선택)는 경계가 분리되어 있으며, 이 PR은 Provider의 request validator를 변경하지 않습니다.

## weather-core에 두는 이유

- KMA 공급자별 공식 발표 일정에 관한 **순수 규칙**이며 네트워크·환경과 무관합니다.
- `KmaForecastProduct`가 이미 weather-core KMA 모듈(`condition.ts`)에 정의되어 있고, 이 함수는 같은
  패키지의 그 값만 사용합니다.
- weather-core는 시스템 clock을 읽지 않고 런타임 의존이 없다는 원칙을 유지합니다(zod·contracts
  런타임 의존 없음, Node 전용 API 없음, Hono 없음).

## 공식 자료

| 항목 | 값 |
| --- | --- |
| 공식 서비스명 | 기상청_단기예보 조회서비스 |
| 공공데이터 ID | `15084084` |
| 서비스(오퍼레이션) 버전 | `VilageFcstInfoService_2.0` |
| 확인 날짜 | 2026-07-17 |
| 확인 주체 | Claude (Claude Code) |

확인한 공식 자료:

1. **API 허브 웹** — `https://apihub.kma.go.kr/apiList.do?seqApi=10` (단기·초단기예보 오퍼레이션과
   `base_time` 파라미터 확인).
2. **API 허브 활용가이드(DOCX)** — 아래 파일. 이번 확인에서 직접 다운로드해 SHA-256이 이전 확인값과
   **일치**함을 검증했고, `# 예보 발표시각` 절의 원문에서 발표 일정을 읽었습니다.
3. **공공데이터포털 활용가이드(ZIP)** — 아래 파일. 이전 프로젝트 검증에서 확인된 SHA-256과 동일한
   자료이며, 같은 서비스(`VilageFcstInfoService_2.0`)의 동일 일정을 담습니다.

### 다운로드 파일명과 SHA-256

| 파일 | SHA-256 | 이번 세션 확인 |
| --- | --- | --- |
| API 허브 활용가이드 `단기예보조회서비스_API활용가이드_260623.docx` | `99504eafccd7fef184f3e26a25a71de4804461826528ef2223ff72027e500d30` | 직접 다운로드·해시 재계산, 이전 확인값과 일치 |
| 공공데이터포털 `기상청41_단기예보 조회서비스_오픈API활용가이드_2607.zip` | `07f53cd9d6d6512bce6ef870d54cb740046a0a949896e6855caecf739fb8842e` | 페이지가 JS 게이트라 이번 세션 재다운로드 불가; 이전 프로젝트 검증값 재기록 |
| 위 ZIP 내부 DOCX | `20d855aa3071a2bdda6dce3c13bab6428ebb02f8d4a30688e26ed0851d6d0848` | 위와 동일(이전 프로젝트 검증값) |

> 같은 파일명이라도 내용이 교체되면 해시가 달라집니다. 로컬 파일로 다시 계산해 위 값과 일치할 때만
> 근거로 사용하고, 다르면 추정하지 말고 실제 해시와 내용을 재확인하십시오.

## 단기예보 발표 일정 (`SHORT_FORECAST` / `getVilageFcst`)

활용가이드 `# 예보 발표시각` 절은 다음을 **KST 기준**(`발표시각(KST)`으로 명시)으로 정의합니다.

```text
Base_time : 0200, 0500, 0800, 1100, 1400, 1700, 2000, 2300  (1일 8회)
```

즉 02시부터 3시간 간격, 하루 8회입니다. (가이드의 `API 제공 시간 (~ 이후) : 02:10, 05:10, …`은
자료의 API 제공 시각이며, 발표시각과는 별개입니다 — 아래 "발표 일정과 API 가용성 구분" 참고.)

## 초단기예보 발표 일정 (`ULTRA_SHORT_FORECAST` / `getUltraSrtFcst`)

활용가이드 `❍ 초단기예보 발표시각` 절은 `※ 매시간 30분에 생성`이라고 명시하며, 표는 다음과 같이
매시간 `HH30` **한 번씩** 발표됨을 보여줍니다.

```text
기준시간 00시 → Base_time 0030
기준시간 01시 → Base_time 0130
기준시간 02시 → Base_time 0230
        …
기준시간 23시 → Base_time 2330
```

즉 `0030, 0130, 0230, … , 2330`으로 하루 24회입니다. 이는 매시간 30분에 **한 번** 발표되는 것이며,
30분마다 두 번 발표되는 것이 **아닙니다**.

> **초단기실황(`getUltraSrtNcst`)과 혼동 주의.** 실황은 `매시간 정시`(`HH00`)에 생성되며 이 selector의
> 범위가 아닙니다. 초단기**예보**만 `HH30`입니다.

## KST는 고정 UTC+09:00

- KST offset은 `+9시간` 고정이며 daylight saving time이 없습니다.
- host locale·host timezone에 의존하지 않습니다. `Date#getHours()`/`getDate()`/`getMonth()` 같은
  local getter, `Intl.DateTimeFormat`, `process.env.TZ`를 사용하지 않습니다.
- 계산 방식: 절대 epoch milliseconds를 검증한 뒤 KST offset(+9h)을 더한 shifted instant를 만들고,
  그 `Date`에 **UTC getter**(`getUTCFullYear`/`getUTCMonth`/`getUTCDate`/`getUTCHours` …)를 사용해 KST
  달력 성분을 읽습니다. 결과는 고정 padding으로 format합니다.

## 선택 규칙 — inclusive latest issuance

reference instant와 **같거나 이전**인 가장 최근 공식 발표시각을 선택합니다(inclusive). 입력의 초·
밀리초까지 경계 비교에 반영하므로, 단순히 "현재 시" 만 보고 경계 초를 잃지 않습니다.

예:

| product | reference (KST) | 결과 |
| --- | --- | --- |
| SHORT | `02:00:00.000` | 당일 `0200` |
| SHORT | `01:59:59.999` | 전일 `2300` |
| SHORT | `04:59:59.999` | 당일 `0200` |
| SHORT | `05:00:00.000` | 당일 `0500` |
| ULTRA | `00:29:59.999` | 전일 `2330` |
| ULTRA | `00:30:00.000` | 당일 `0030` |
| ULTRA | `01:29:59.999` | 당일 `0030` |
| ULTRA | `01:30:00.000` | 당일 `0130` |

### 전일(previous-day) rollover

reference가 해당 KST 날짜의 **첫 발표시각보다 이르면**, 이전 KST 날짜의 해당 product **마지막
발표시각**을 선택합니다.

- SHORT: 당일 `02:00` 이전 → 전일 `2300`.
- ULTRA: 당일 `00:30` 이전 → 전일 `2330`.

### 월말/연말/윤년 처리

전일 계산은 shifted instant에서 하루(`86,400,000 ms`)를 빼서 수행합니다. DST가 없으므로 KST 달력이
정확히 하루 뒤로 이동하고, `Date`의 UTC 달력이 다음 경계를 정확히 처리합니다.

| reference (KST) | product | 결과 baseDate | baseTime |
| --- | --- | --- | --- |
| `2026-01-01 01:00:00` | SHORT | `20251231` | `2300` |
| `2025-03-01 01:00:00` | SHORT | `20250228` | `2300` (평년) |
| `2024-03-01 01:00:00` | SHORT | `20240229` | `2300` (윤년) |
| `2026-07-01 00:10:00` | ULTRA | `20260630` | `2330` |

같은 절대 instant가 UTC 표현상 전날이어도 KST 달력 날짜로 올바르게 선택됩니다(예:
`2026-07-16T20:00:00Z` = KST `2026-07-17T05:00:00` → SHORT `20260717`/`0500`).

## 입력과 출력

```ts
interface SelectLatestKmaForecastBaseTimeInput {
  readonly product: KmaForecastProduct;      // SHORT_FORECAST | ULTRA_SHORT_FORECAST
  readonly referenceEpochMilliseconds: number; // 절대 instant (UTC epoch ms)
}

interface KmaForecastBaseTime {
  readonly baseDate: string; // 정확히 YYYYMMDD
  readonly baseTime: string; // 정확히 HHmm
}

function selectLatestKmaForecastBaseTime(
  input: SelectLatestKmaForecastBaseTimeInput,
): KmaForecastBaseTime;
```

- `baseDate`는 정확히 8자리 숫자, `baseTime`은 정확히 4자리 숫자입니다.
- 매 호출마다 **새로운 결과 객체**를 반환합니다. 입력을 mutate하지 않으며, frozen 입력에서도
  동작합니다. 반환값을 runtime cast로 mutate해도 이후 호출 결과에 영향이 없습니다.
- 내부 발표 일정 배열과 KST 계산 helper는 export하지 않으며, 호출자가 mutate할 경로도 없습니다.

## RangeError 정책

다음은 programmer/configuration 오류이므로 새로운 result union이나 `UNKNOWN` 상태를 만들지 않고
`RangeError`를 던집니다(이는 `classifyFreshness`가 잘못된 필수 설정을 `RangeError`로 거부하는
스타일과 동일합니다).

`referenceEpochMilliseconds`가 다음이면 `RangeError`:

- `NaN`, `Infinity`, `-Infinity`
- 소수(fractional) 밀리초
- unsafe integer(`Number.MAX_SAFE_INTEGER` 초과 / `Number.MIN_SAFE_INTEGER` 미만)
- `Date`가 표현할 수 있는 instant 범위를 벗어남
- KST 변환 후 4자리 연도(`YYYY`)를 만들 수 없는 범위(`[1000, 9999]` 밖)

`product`가 지원하는 두 값(`SHORT_FORECAST`·`ULTRA_SHORT_FORECAST`)이 아니면(타입 우회 포함)
`RangeError`. default 분기에서 임의 product로 fallback하지 않습니다.

오류 메시지에는 secret이나 **전체 input 객체**를 직렬화하지 않습니다.

## 발표 일정과 API 가용성 구분

이 함수는 "공식 발표 일정상 가장 최근 issuance"를 선택합니다. 다음을 **보장하지 않습니다**:

- 해당 자료가 공공데이터 API에 이미 업로드됨
- 발표시각 직후 호출이 성공함
- upstream replication 완료
- 공식 발표자료가 지연되지 않음

따라서 이 PR은 다음을 추가하지 않습니다: 임의의 publication lag(예 10/15/20분), safety margin,
직전 발표시각 fallback, retry, live availability probe. 활용가이드의 `API 제공 시간`(단기 `~02:10`,
초단기 `~HH45`)은 이 자료 제공 지연을 뜻하며 이 함수의 관심사가 아닙니다. 정확한 API 가용성 지연은
실제 인증 JSON 통합 검증과 후속 orchestration 정책에서 다룹니다.

함수명과 문서는 `available`/`ready`/`published successfully` 같은 보장 표현을 쓰지 않고, "latest
scheduled base time"(가장 최근 발표 예정시각)의 의미를 유지합니다.

## 시스템 clock·host timezone 미사용

- `Date.now()`·시스템 clock을 읽지 않습니다.
- host-local `Date` getter(`getHours`/`getDate`/`getMonth` …), `Intl.DateTimeFormat`,
  `process.env`를 사용하지 않습니다.
- 신규 timezone library를 추가하지 않습니다.

## 실제 live 검증 미수행 / 후속 통합 범위

- 실제 `KMA_SERVICE_KEY`를 사용한 live 호출은 이번 검증에 포함하지 않았습니다. 모든 테스트는 순수
  in-memory 계산입니다(네트워크·fake clock·timer·`Date.now()` mock 없음).
- 후속:
  1. injected clock과 이 selector를 사용하는 KMA request factory
  2. 위경도 → KMA grid(nx/ny) 변환
  3. API availability fallback/retry 정책
  4. `WeatherOverview`/`SourceMetadata` 조립
  5. `/weather` API route

## 변경 이력

```text
v1 / PR #8 / 2026-07
- KMA 단기·초단기예보 공식 발표시각 선택 함수 추가
- caller-supplied epoch milliseconds와 고정 KST(UTC+09:00) 계산
- 발표시각과 API 가용성 책임 분리
```
