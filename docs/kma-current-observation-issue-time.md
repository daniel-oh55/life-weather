# KMA 초단기실황 발표시각 선택 (current-observation issue-time selector)

이 문서는 `@life-weather/weather-core`가 기상청(KMA) **초단기실황(`getUltraSrtNcst`)** 의 가장
최근 공식 발표시각(`base_date` / `base_time`)을 결정하는 순수 함수
(`selectLatestKmaCurrentObservationBaseTime`)를 기록합니다. 이 함수는
[kma-issue-time.md](./kma-issue-time.md)의 forecast selector
(`selectLatestKmaForecastBaseTime`)와 같은 원칙을 따르는 **별도의, 병렬** selector입니다 —
초단기실황은 `product` 선택이 없는 단일 operation이고 발표 스케줄도 다르므로, 기존 forecast
selector를 확장하거나 두 selector가 공유하는 generic scheduler로 리팩터하지 않았습니다.

구현 위치:

- [current-observation-issue-time.ts](../packages/weather-core/src/kma/current-observation-issue-time.ts)
  — 발표시각 선택 순수 함수
- [current-observation-issue-time 테스트](../packages/weather-core/src/kma/current-observation-issue-time.test.ts)

## 목적

- 호출자가 제공한 **절대 시각**(epoch milliseconds)을 기준으로, 초단기실황의 공식 발표 일정에서
  **그 시각과 같거나 이전인 가장 최근 발표시각**을 선택합니다.
- 결과는 기존 `KmaCurrentObservationRequest`
  ([kma-current-observation-provider.md](./kma-current-observation-provider.md))에 그대로 넣을 수
  있는 `{ baseDate, baseTime }`입니다. `baseTime`은 그 request validator가 요구하는
  `isKmaCurrentObservationBaseTime`(정시 `HH00`만 허용) 형식을 항상 만족합니다.

흐름:

```text
호출자가 제공한 절대 instant
  → KST 변환 (고정 UTC+09:00)
  → 초단기실황 공식 발표 일정(매시간 정시, HH00) 적용
  → 같거나 이전인 가장 최근 발표시각 선택 (inclusive)
  → { baseDate, baseTime }
```

## 발표 일정 — 매시간 정시(`HH00`), 하루 24회

초단기실황(`getUltraSrtNcst`)은 **매시간 정시**에 생성됩니다: `0000, 0100, 0200, … , 2300` —
하루 24회, 항상 분(`mm`)이 `00`입니다. 이는 초단기**예보**(`getUltraSrtFcst`)의 `HH30`(매시간
30분) 일정과 다르며, 단기예보(`getVilageFcst`)의 `0200/…/2300`(3시간 간격, 1일 8회) 일정과도
다릅니다. 이 스케줄은 [kma-current-observation-provider.md](./kma-current-observation-provider.md)의
"current와 forecast의 분리 이유"에서 이미 기술한 정시 제약과 같은 근거를 사용합니다 — 같은
`VilageFcstInfoService_2.0` 서비스 활용가이드(공공데이터 ID `15084084`)가 대상입니다.

> **초단기예보(`getUltraSrtFcst`)와 혼동 주의.** 초단기예보는 `HH30`(매시간 30분)에 발표되며
> [kma-issue-time.md](./kma-issue-time.md)의 `selectLatestKmaForecastBaseTime`이 담당합니다.
> 초단기실황은 `HH00`(매시간 정시)이며 이 문서의 selector가 담당합니다. 두 스케줄은 겹치지
> 않습니다.

## `product` 필드가 없는 이유

`getUltraSrtNcst`는 초단기실황의 유일한 operation입니다 — 단기예보/초단기예보처럼 두 개의
`KmaForecastProduct` 중 하나를 고르는 개념이 없습니다
([kma-current-observation-provider.md](./kma-current-observation-provider.md)의
`KmaCurrentObservationRequest`도 같은 이유로 `product` 필드가 없습니다). 그래서 이 selector의
입력은 `referenceEpochMilliseconds` 하나뿐이며, forecast selector의
`SelectLatestKmaForecastBaseTimeInput`(`product` + `referenceEpochMilliseconds`)과 다른 별도
타입(`SelectLatestKmaCurrentObservationBaseTimeInput`)입니다.

## 선택 규칙 — inclusive latest issuance, previous-day rollover 없음

reference instant와 **같거나 이전**인 가장 최근 발표시각을 선택합니다(inclusive). 입력의 초·
밀리초까지 경계 비교에 반영합니다.

forecast selector([kma-issue-time.md](./kma-issue-time.md))는 하루의 **첫 발표시각**이
`0200`(SHORT) 또는 `0030`(ULTRA)이라서, reference가 그보다 이르면 **전일** 마지막 발표시각으로
넘어가는 previous-day rollover가 필요합니다. 초단기실황은 하루의 첫 발표시각이 `0000`(자정)
자체이므로, reference가 자신의 KST 날짜 범위(`00:00:00.000`~`23:59:59.999`) 안에 있는 한 **항상
그날 안에서** 발표시각을 찾을 수 있습니다 — 별도의 previous-day rollover 분기가 필요 없습니다.
`H:00:00.000`에서 1ms를 빼면 `Date`의 UTC getter가 스스로 이전 시/일/월/년을 정확히 계산하므로
(예: 자정 1ms 전은 전일 `23:00`), 이는 여전히 "reference가 속한 그 순간의 KST 시각"을 직접 읽는
것이지, 발표 스케줄 배열을 거슬러 올라가는 별도의 rollover 로직이 아닙니다.

예:

| reference (KST) | 결과 |
| --- | --- |
| `00:00:00.000` | 당일 `0000` |
| `05:59:59.999` | 당일 `0500` |
| `06:00:00.000` | 당일 `0600` |
| `23:59:59.999` | 당일 `2300` |
| 당일 `00:00:00.000` 1ms 전 | 전일 `2300` |

### 월말/연말/윤년 처리

`Date`의 UTC getter가 shifted instant에서 직접 시/일/월/년을 읽으므로 별도의 "하루를 빼는" 계산
없이 정확히 처리됩니다.

| reference (KST) | 결과 baseDate | baseTime |
| --- | --- | --- |
| `2026-01-01 00:00:00.000` 1ms 전 | `20251231` | `2300` |
| `2025-03-01 00:00:00.000` 1ms 전 | `20250228` | `2300` (평년) |
| `2024-03-01 00:00:00.000` 1ms 전 | `20240229` | `2300` (윤년) |
| `2026-05-01 00:00:00.000` 1ms 전 | `20260430` | `2300` |

같은 절대 instant가 UTC 표현상 전날이어도 KST 달력 날짜로 올바르게 선택됩니다(예:
`2026-07-16T20:00:00Z` = KST `2026-07-17T05:00:00` → `20260717`/`0500`).

### 지원 연도 하한(`[1000, 9999]`)에서 previous-day rollover가 없는 이유

forecast selector는 previous-day rollover 때문에 reference의 KST 연도와 **최종 선택된
`base_date` 연도**를 각각 검증해야 합니다(`1000-01-01` 하한에서 rollover가 `0999`로 넘어갈 수
있기 때문). 이 selector는 위에서 설명한 대로 previous-day rollover 자체가 존재하지 않으므로 —
`baseDate`는 항상 reference 자신의 KST 달력 날짜와 같으므로 — reference의 KST 연도 하나만
검증하면 충분합니다.

| reference (KST) | 결과 |
| --- | --- |
| `1000-01-01 00:00:00.000` | `10000101` / `0000` (그 날 첫 발표, 하한 그대로 유효) |
| `1000-01-01 00:00:00.000` 1ms 전 | `RangeError` (KST 연도가 `999`로 `1000` 미만) |

## KST는 고정 UTC+09:00

- KST offset은 `+9시간` 고정이며 daylight saving time이 없습니다.
- host locale·host timezone에 의존하지 않습니다. `Date#getHours()`/`getDate()`/`getMonth()` 같은
  local getter, `Intl.DateTimeFormat`, `process.env.TZ`를 사용하지 않습니다.
- 계산 방식: 절대 epoch milliseconds를 검증한 뒤 KST offset(+9h)을 더한 shifted instant를 만들고,
  그 `Date`에 **UTC getter**(`getUTCFullYear`/`getUTCMonth`/`getUTCDate`/`getUTCHours`)를 사용해
  KST 달력 성분을 읽습니다. 결과는 고정 padding으로 format합니다(`baseTime`은 항상 시 2자리 +
  고정 `'00'`).

## 왜 호출자가 reference instant를 공급하는가

forecast selector와 동일한 원칙입니다 — 이 함수는 시스템 clock을 읽지 않습니다
(`Date.now()`·`process.env.TZ`·`Intl` 미사용). "현재 시각"은 **입력**으로 받습니다. 결정론적이고,
host timezone/locale과 무관하며, clock 주입 정책은 호출 계층(후속 request factory)이 결정합니다
— 이 PR은 그 clock 주입을 구현하지 않습니다.

## 입력과 출력

```ts
interface SelectLatestKmaCurrentObservationBaseTimeInput {
  readonly referenceEpochMilliseconds: number; // 절대 instant (UTC epoch ms)
}

interface KmaCurrentObservationBaseTime {
  readonly baseDate: string; // 정확히 YYYYMMDD
  readonly baseTime: string; // 정확히 HH00
}

function selectLatestKmaCurrentObservationBaseTime(
  input: SelectLatestKmaCurrentObservationBaseTimeInput,
): KmaCurrentObservationBaseTime;
```

- `baseDate`는 정확히 8자리 숫자, `baseTime`은 정확히 4자리 숫자이며 항상 분(`mm`)이 `00`입니다.
- 매 호출마다 **새로운 결과 객체**를 반환합니다. 입력을 mutate하지 않으며, frozen 입력에서도
  동작합니다. 반환값을 runtime cast로 mutate해도 이후 호출 결과에 영향이 없습니다.

## RangeError 정책

다음은 programmer/configuration 오류이므로 새로운 result union이나 `UNKNOWN` 상태를 만들지 않고
`RangeError`를 던집니다(forecast selector 및 `classifyFreshness`와 동일한 스타일).

`referenceEpochMilliseconds`가 다음이면 `RangeError`:

- `NaN`, `Infinity`, `-Infinity`
- 소수(fractional) 밀리초
- unsafe integer(`Number.MAX_SAFE_INTEGER` 초과 / `Number.MIN_SAFE_INTEGER` 미만)
- `Date`가 표현할 수 있는 instant 범위를 벗어남
- KST 변환 후 4자리 연도(`YYYY`)를 만들 수 없는 범위(`[1000, 9999]` 밖)

`product` 검증은 없습니다 — 이 selector에는 `product` 입력 자체가 없습니다.

오류 메시지는 **값을 담지 않는 고정 메시지**입니다: 잘못된 `referenceEpochMilliseconds`의 원본
값, 파생 연도, secret, **전체 input 객체**를 직렬화하지 않고, 필드명 또는 정책 이름만 담습니다.
비-number 타입의 `referenceEpochMilliseconds`(타입 우회)도 `TypeError`가 아니라 `RangeError`이며,
메시지에 그 원본 값을 포함하지 않습니다. 메시지는 결정론적입니다.

## 발표 일정과 API 가용성 구분

forecast 쪽과 동일한 원칙으로, 이 함수는 "공식 발표 일정상 가장 최근 issuance"만 선택합니다.
다음을 **보장하지 않습니다**: 해당 자료가 공공데이터 API에 이미 업로드됨, 발표시각 직후 호출이
성공함, upstream replication 완료, 공식 발표자료가 지연되지 않음.

이 PR(#64)은 forecast의 `selectLatestKmaForecastBaseTimeAfterAvailabilityDelay`
([kma-api-availability-time.md](./kma-api-availability-time.md))에 대응하는 **availability-delay
selector를 초단기실황에 추가하지 않았습니다** — 명시적으로 범위 밖이었습니다. **PR #79**가 이
대응 selector(`selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay`,
[kma-current-observation-api-availability-time.md](./kma-current-observation-api-availability-time.md))를
별도 함수로 추가했습니다 — 이 schedule-only selector 자체(공개 API, previous-day rollover 없음,
`RangeError` 정책)는 PR #79에서도 전혀 변경되지 않았습니다. **PR #80**이 production
current-observation composition에 그 PR #79 selector를 explicit 주입했으므로, production은 더
이상 이 schedule-only selector를 주입하지 않습니다. 이 schedule-only selector는 여전히
current-observation request factory(`createKmaCurrentObservationRequestFactory`)의 **직접
one-argument 호출 default**로 남아 있습니다.

## weather-core에 두는 이유

- KMA 초단기실황 공식 발표 일정에 관한 **순수 규칙**이며 네트워크·환경과 무관합니다.
- weather-core는 시스템 clock을 읽지 않고 런타임 의존이 없다는 원칙을 유지합니다(zod·contracts
  런타임 의존 없음, Node 전용 API 없음, Hono 없음) —
  [kma-current-observation-provider.md](./kma-current-observation-provider.md)의 provider
  boundary(`apps/api`)와 이 selector(`weather-core`)는 계속 분리됩니다.

## 실제 live 검증 미수행 / 후속 통합 범위

- 실제 `KMA_SERVICE_KEY`를 사용한 live 호출은 이번 검증에 포함하지 않았습니다. 모든 테스트는
  순수 in-memory 계산입니다(네트워크·fake clock·timer·`Date.now()` mock 없음).
- 이 PR은 selector만 추가합니다. 다음은 명시적으로 **범위 밖**입니다: API availability delay,
  safety margin, system-clock adapter, request factory, provider 호출, 위치→격자 변환,
  fallback/retry/cache, application service/composition/route/presenter, `POST /weather` 연결,
  contracts 변경, mobile/native/deploy, 실제 KMA API 호출, 실제 key/좌표, 기존 forecast
  selector(`selectLatestKmaForecastBaseTime`) 리팩터, current/forecast 공용 generic scheduler.
- ~~남은 후속: 이 selector를 소비하는 current-observation request factory~~ — **PR #66에서
  완료**(`createKmaCurrentObservationRequestFactory`,
  [kma-current-observation-request-factory.md](./kma-current-observation-request-factory.md)).
  production composition wiring과 `POST /weather`로의 current 데이터 연결은 여전히 후속입니다
  ([kma-current-observation-provider.md](./kma-current-observation-provider.md)의 "후속 PR
  범위" 참고).

## 변경 이력

```text
v1 / PR #64 / 2026-08
- 초단기실황(getUltraSrtNcst) 공식 발표시각(매시간 정시, HH00) 선택 함수 추가
- caller-supplied epoch milliseconds와 고정 KST(UTC+09:00) 계산
- forecast selector(selectLatestKmaForecastBaseTime)와 별도·병렬 구현, product 필드 없음
- 발표 스케줄이 자정(0000)부터 시작하므로 previous-day rollover 분기 불필요
- 발표시각과 API 가용성 책임 분리(availability-delay counterpart는 이 PR 범위 밖)

v2 / PR #66 / 2026-08 (request factory에서 소비)
- apps/api/src/services의 KMA current-observation request factory
  (createKmaCurrentObservationRequestFactory,
  kma-current-observation-request-factory.md)가 이 selector를 **injectable
  baseTimeSelector 인자의 default**로 소비 — 인자를 생략한 호출만 이 selector를 사용
- 이 selector 자체(공개 API, previous-day rollover 없음, RangeError 정책)는 변경되지 않음

v3 / PR #79 / 2026-08 (대응하는 availability-delay selector 추가; 이 selector 자체는 불변)
- 별도 함수 selectLatestKmaCurrentObservationBaseTimeAfterAvailabilityDelay
  (kma-current-observation-api-availability-time.md)가 이 selector를 조합해 10분 프로젝트
  제공시각 임계값을 적용
- 이 schedule-only selector 자체(공개 API, previous-day rollover 없음, RangeError 정책)는
  변경되지 않음, production composition은 여전히 이 selector를 명시적으로 주입

v4 / PR #80 / 2026-08 (production이 PR #79 selector로 전환; 이 selector 자체는 불변)
- production current-observation composition
  (createKmaScheduledCurrentObservationCompositionFromEnv)이 PR #79 availability-delay selector를
  explicit 주입, 이 schedule-only selector는 더 이상 production에 주입되지 않음
- 이 schedule-only selector는 request factory의 직접 one-argument 호출 default로 유지
- 이 selector 자체(공개 API, previous-day rollover 없음, RangeError 정책)는 변경되지 않음
```
