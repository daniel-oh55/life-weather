# KMA 중기예보 발표시각 선택 (mid-term issue-time selector)

이 문서는 `@life-weather/weather-core`가 기상청(KMA) **중기예보 조회서비스**
(`MidFcstInfoService`)의 가장 최근 공식 발표시각(`tmFc`)을 결정하는 순수 함수
(`selectLatestKmaMidtermIssuance`)를 기록합니다. 이 함수는 [kma-issue-time.md](./kma-issue-time.md)의
forecast selector(`selectLatestKmaForecastBaseTime`)와
[kma-current-observation-issue-time.md](./kma-current-observation-issue-time.md)의 current-observation
selector와 같은 원칙을 따르는 **별도의, 병렬** selector입니다 — 중기예보는 발표 스케줄이 다르고
(하루 두 번, `06:00`/`18:00`), 결과 shape도 다르므로(`baseDate`/`baseTime` 분리가 아니라 단일
`tmFc`), 기존 selector를 확장하거나 세 selector가 공유하는 generic scheduler로 리팩터하지
않았습니다.

구현 위치:

- [midterm-issue-time.ts](../packages/weather-core/src/kma/midterm-issue-time.ts) — 발표시각 선택
  순수 함수
- [midterm-issue-time 테스트](../packages/weather-core/src/kma/midterm-issue-time.test.ts)

## 목적

- 호출자가 제공한 **절대 시각**(epoch milliseconds)을 기준으로, 중기예보의 공식 발표 일정에서
  **그 시각과 같거나 이전인 가장 최근 발표시각**을 선택합니다.
- 결과는 [kma-midterm-provider.md](./kma-midterm-provider.md)의
  `KmaMidtermForecastRequest.tmFc`(`apps/api/src/providers/kma/midterm-request.ts`)에 그대로 넣을
  수 있는 `{ tmFc }`입니다.

흐름:

```text
호출자가 제공한 절대 instant
  → KST 변환 (고정 UTC+09:00)
  → 중기예보 공식 발표 일정(06:00, 18:00 KST) 적용
  → 같거나 이전인 가장 최근 발표시각 선택 (inclusive)
  → { tmFc }
```

## 발표 일정 — 하루 두 번, `06:00 KST`와 `18:00 KST`

`getMidTa`(중기기온조회)와 `getMidLandFcst`(중기육상예보조회)는 같은 중기예보 공식 발표 일정을
공유합니다 — `06:00 KST`와 `18:00 KST`, 하루 두 번뿐입니다. 이는 단기예보(`getVilageFcst`,
`0200/…/2300`, 1일 8회)나 초단기예보(`getUltraSrtFcst`, `HH30`, 1일 24회), 초단기실황
(`getUltraSrtNcst`, `HH00`, 1일 24회)과 완전히 다른, 훨씬 성긴 일정입니다. 자세한 evidence는
[kma-midterm-provider.md](./kma-midterm-provider.md)의 "발표 주기와 예보 구간" 절을 참고하세요.

## `product` 필드가 없는 이유

`getMidTa`와 `getMidLandFcst`는 반환 내용(기온 vs 육상예보)만 다를 뿐 같은 `06:00`/`18:00`
발표 일정을 공유합니다 — forecast selector의 단기예보/초단기예보처럼 서로 다른 스케줄 중 하나를
고르는 개념이 아닙니다. 그래서 이 selector의 입력은 `referenceEpochMilliseconds` 하나뿐입니다.

## 선택 규칙 — inclusive latest issuance, previous-day rollover 있음

reference instant와 **같거나 이전**인 가장 최근 발표시각을 선택합니다(inclusive). 입력의 초·
밀리초까지 경계 비교에 반영합니다.

중기예보 하루의 **첫 발표시각**은 `06:00`이므로 — 초단기실황의 `0000`과 달리 — reference가 그보다
이르면(즉 자정부터 `05:59:59.999`까지) **전일** `18:00` 발표시각으로 넘어가는 previous-day
rollover가 필요합니다. 이는 forecast selector([kma-issue-time.md](./kma-issue-time.md))가 이미
구현한 것과 같은 종류의 rollover입니다.

예:

| reference (KST) | 결과 `tmFc` |
| --- | --- |
| 당일 `00:10:00.000` | 전일 `1800` |
| `05:59:59.999` | 전일 `1800` |
| `06:00:00.000` | 당일 `0600` |
| `17:59:59.999` | 당일 `0600` |
| `18:00:00.000` | 당일 `1800` |
| `23:59:59.999` | 당일 `1800` |

### 월말/연말/윤년 처리

Previous-day rollover는 shifted KST instant에서 하루(`86_400_000`ms)를 뺀 뒤 `Date`의 UTC getter로
다시 읽으므로, forecast selector와 동일하게 월말/연말/윤년 경계가 정확히 처리됩니다.

| reference (KST) | 결과 `tmFc` |
| --- | --- |
| `2026-01-01 01:00:00.000` | `2025-12-31 1800` |
| `2025-03-01 01:00:00.000` | `2025-02-28 1800` (평년) |
| `2024-03-01 01:00:00.000` | `2024-02-29 1800` (윤년) |
| `2026-05-01 01:00:00.000` | `2026-04-30 1800` |

같은 절대 instant가 UTC 표현상 전날이어도 KST 달력 날짜로 올바르게 선택됩니다.

### 지원 연도 범위(`[1000, 9999]`)와 lower-bound rollover

forecast selector와 동일하게, previous-day rollover 때문에 reference의 KST 연도와 **최종 선택된
issuance 날짜의 연도**를 각각 검증해야 합니다(`1000-01-01` 하한에서 rollover가 `0999`로 넘어갈 수
있기 때문).

| reference (KST) | 결과 |
| --- | --- |
| `1000-01-01 06:00:00.000` | `100001010600` (그 날 첫 발표, 하한 그대로 유효) |
| `1000-01-01 05:59:59.999` | `RangeError` (rollover가 `0999`로 넘어감) |

## KST는 고정 UTC+09:00

- KST offset은 `+9시간` 고정이며 daylight saving time이 없습니다.
- host locale·host timezone에 의존하지 않습니다. `Date#getHours()`/`getDate()`/`getMonth()` 같은
  local getter, `Intl.DateTimeFormat`, `process.env.TZ`를 사용하지 않습니다.
- 계산 방식: 절대 epoch milliseconds를 검증한 뒤 KST offset(+9h)을 더한 shifted instant를 만들고,
  그 `Date`에 **UTC getter**(`getUTCFullYear`/`getUTCMonth`/`getUTCDate`/`getUTCHours`)를 사용해
  KST 달력 성분을 읽습니다. 결과는 고정 padding으로 format합니다.

## 발표 일정과 API 가용성 구분

forecast/current-observation 쪽과 동일한 원칙으로, 이 함수는 "공식 발표 일정상 가장 최근
issuance"만 선택합니다. 다음을 **보장하지 않습니다**: 해당 자료가 공공데이터 API에 이미 업로드됨,
발표시각 직후 호출이 성공함, upstream replication 완료, 공식 발표자료가 지연되지 않음.

이 PR은 forecast의 `selectLatestKmaForecastBaseTimeAfterAvailabilityDelay`
([kma-api-availability-time.md](./kma-api-availability-time.md))에 대응하는 **availability-delay
selector를 추가하지 않습니다** — [kma-midterm-provider.md](./kma-midterm-provider.md)가 이미
기록했듯, 공식 자료가 06/18 발표와 "최근 24시간" 제공만 확립할 뿐 단기예보의 "~10분 후" 같은
근거 있는 정확한 지연 값을 이 프로젝트에 아직 제공하지 않으므로, 5/10/15분 같은 값을 발명하지
않습니다.

## `regId` 책임 없음

이 selector는 위치를 중기예보 구역코드(`regId`)로 해석하지 않습니다. `regId` 매핑은
[kma-midterm-provider.md](./kma-midterm-provider.md)가 기록한 대로 여전히 후속 작업입니다.

## Provider I/O 없음

이 selector는 순수 함수이며 `apps/api`의 provider·request factory·service·composition을 호출하지
않고, 실제 KMA API도 호출하지 않습니다. 이 selector를 소비하는 mid-term request factory(clock 주입
포함)는 후속 작업입니다.

## 입력과 출력

```ts
interface SelectLatestKmaMidtermIssuanceInput {
  readonly referenceEpochMilliseconds: number; // 절대 instant (UTC epoch ms)
}

interface KmaMidtermIssuance {
  readonly tmFc: string; // 정확히 YYYYMMDD0600 또는 YYYYMMDD1800
}

function selectLatestKmaMidtermIssuance(
  input: SelectLatestKmaMidtermIssuanceInput,
): KmaMidtermIssuance;
```

- `tmFc`는 정확히 12자리 숫자이며 항상 `0600` 또는 `1800`으로 끝납니다.
- 매 호출마다 **새로운 결과 객체**를 반환합니다. 입력을 mutate하지 않으며, frozen 입력에서도
  동작합니다. 반환값을 runtime cast로 mutate해도 이후 호출 결과에 영향이 없습니다.

## RangeError 정책

다음은 programmer/configuration 오류이므로 새로운 result union이나 `UNKNOWN` 상태를 만들지 않고
`RangeError`를 던집니다(forecast selector 및 current-observation selector와 동일한 스타일).

`referenceEpochMilliseconds`가 다음이면 `RangeError`:

- `NaN`, `Infinity`, `-Infinity`
- 소수(fractional) 밀리초
- unsafe integer(`Number.MAX_SAFE_INTEGER` 초과 / `Number.MIN_SAFE_INTEGER` 미만)
- `Date`가 표현할 수 있는 instant 범위를 벗어남
- KST 변환 후 4자리 연도(`YYYY`)를 만들 수 없는 범위(`[1000, 9999]` 밖) — reference 연도 또는
  previous-day rollover 후 선택된 issuance 날짜의 연도

오류 메시지는 **값을 담지 않는 고정 메시지**입니다: 잘못된 `referenceEpochMilliseconds`의 원본
값, 파생 연도, secret, **전체 input 객체**를 직렬화하지 않고, 필드명 또는 정책 이름만 담습니다.
비-number 타입의 `referenceEpochMilliseconds`(타입 우회)도 `TypeError`가 아니라 `RangeError`이며,
메시지에 그 원본 값을 포함하지 않습니다. 메시지는 결정론적입니다.

## weather-core에 두는 이유

- KMA 중기예보 공식 발표 일정에 관한 **순수 규칙**이며 네트워크·환경과 무관합니다.
- weather-core는 시스템 clock을 읽지 않고 런타임 의존이 없다는 원칙을 유지합니다(zod·contracts
  런타임 의존 없음, Node 전용 API 없음, Hono 없음) —
  [kma-midterm-provider.md](./kma-midterm-provider.md)의 provider boundary(`apps/api`)와 이
  selector(`weather-core`)는 계속 분리됩니다.

## 이 PR의 범위 밖 (후속 작업)

- 위치/행정구역/위경도 → 육상 `regId` / 기온 `regId` 매핑
- API availability delay / publication-delay threshold
- mid-term request factory(clock 주입), service, composition, `POST /weather` 연결
- `DailyForecast[]` 정규화, 한국어 날씨 문구 → `WeatherCondition` 매핑
- 실제 KMA API 호출, mobile/native/deploy

## 실제 live 검증 미수행

실제 `KMA_SERVICE_KEY`를 사용한 live 호출은 이번 검증에 포함하지 않았습니다. 모든 테스트는 순수
in-memory 계산입니다(네트워크·fake clock·timer·`Date.now()` mock 없음).
