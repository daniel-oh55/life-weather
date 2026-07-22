# KMA fallback eligibility classifier

이 문서는 PR #17에서 추가한 **application-service classifier** 한 개
(`classifyKmaHourlyFallbackEligibility`)의 책임과 경계를 기록합니다. 이 classifier는 한 번의 KMA
hourly service 결과를 보고, 후속 orchestration이 **직전 발표시각 후보로 한 번 fallback을 시도해도
되는지**를 결정론적으로 분류합니다. 이번 PR은 **분류만** 수행하며 실제 fallback을 실행하지 않습니다.

## 목적

- KMA hourly service 결과(`KmaHourlyForecastServiceResult`)를 실제 fallback 실행 **전에**
  eligible / ineligible로 순수하게 분류합니다.
- fallback eligible 신호는 정확히 두 가지이며, 둘 다 "최신 발표자료가 아직 없음(no-data)"을 뜻합니다.
  transport·gateway·timeout·invalid response·malformed data는 이 신호가 아닙니다.

이번 PR은 request plan·candidate selector wiring·두 번째 HTTP 요청·retry·fallback 실행·delay를
포함하지 않습니다(아래 "보장하지 않는 것" 참조).

## 구현 위치

- [kma-hourly-fallback-eligibility.ts](../apps/api/src/services/kma-hourly-fallback-eligibility.ts) — classifier 순수 함수
- [kma-hourly-fallback-eligibility.test.ts](../apps/api/src/services/kma-hourly-fallback-eligibility.test.ts) — 테스트

이 위치(`apps/api/src/services`)에 두는 이유:

- 입력이 application 계층의 `KmaHourlyForecastServiceResult`이며 Provider raw boundary가 아니라
  **application result 정책**입니다.
- network 호출 없이 결과 union만 분류합니다.
- 후속 orchestration service가 재사용할 수 있습니다.
- `weather-core`에 `apps/api` result type 의존을 만들지 않습니다.

허용 import는 `./kma-hourly-forecast`의 `type KmaHourlyForecastServiceResult` 하나뿐입니다.
Provider 구현·request factory·facade·composition·weather-core fallback candidate runtime·contracts
runtime·zod·Hono·Node environment API·network/date library는 import하지 않습니다.

## 공개 API

```ts
export type KmaHourlyFallbackReason =
  | 'KMA_NO_DATA'
  | 'EMPTY_HOURLY';

export type KmaHourlyFallbackEligibility =
  | { readonly eligible: true; readonly reason: KmaHourlyFallbackReason }
  | { readonly eligible: false };

export function classifyKmaHourlyFallbackEligibility(
  result: KmaHourlyForecastServiceResult,
): KmaHourlyFallbackEligibility;
```

### 입력 type

입력은 기존 [kma-hourly-service.md](./kma-hourly-service.md)의 service result union입니다.

```ts
type KmaHourlyForecastServiceResult =
  | { readonly ok: true; readonly hourly: readonly HourlyForecast[] }
  | { readonly ok: false; readonly stage: 'PROVIDER'; readonly error: KmaForecastProviderError }
  | { readonly ok: false; readonly stage: 'NORMALIZATION'; readonly issues: readonly KmaHourlyNormalizationIssue[] };
```

### 출력 discriminated union

- eligible: `{ eligible: true, reason }` — `reason`은 `KMA_NO_DATA` 또는 `EMPTY_HOURLY`.
- ineligible: `{ eligible: false }` — **`reason` key를 넣지 않습니다.**

출력에는 retry/attempt/delay/selected candidate/original resultCode/original error/original
hourly/source metadata/stale flag를 노출하지 않습니다.

## eligible 신호

### `KMA_NO_DATA`

다음 조건을 **모두** 만족할 때만 eligible입니다.

- `result.ok === false`
- `result.stage === 'PROVIDER'`
- `result.error.kind === 'KMA_UPSTREAM_ERROR'`
- `result.error.resultCode === '03'`

`'03'`은 기상청 공식 결과코드 `NODATA_ERROR`입니다. module-private 상수
`KMA_NO_DATA_RESULT_CODE = '03'`으로 exact string 비교합니다(export하지 않음).

### `EMPTY_HOURLY`

다음 조건일 때 eligible입니다.

- `result.ok === true`
- `result.hourly.length === 0`

## exact resultCode `03` matching (no trim / coercion)

KMA no-data code는 **exact string `'03'`만** 인정합니다. 다음은 모두 ineligible입니다.

`'3'`, `'003'`, `' 03'`, `'03 '`, `' 03 '`, `'00'`, `'01'`, `'02'`, `'04'`, `'05'`, `'10'`, `'11'`,
`'12'`, `'20'`, `'21'`, `'22'`, `'30'`, `'31'`, `'32'`, `'33'`, `'99'`, 그리고 알려지지 않은 미래
두 자리 코드(예 `98`).

classifier는 `trim`·`padStart`·`Number()`·`parseInt`·loose equality·code range 분류·raw
`resultMsg` 사용을 하지 않습니다.

## nonempty success는 ineligible

`hourly` 원소가 하나 이상인 success는 ineligible입니다. classifier는 `hourly.length`만 관찰하고 원소
내용을 검사하거나 재분류하지 않으며, 원소를 mutate하지 않습니다.

## 그 외 Provider error는 모두 ineligible

`KMA_UPSTREAM_ERROR`/`03`을 제외한 현재 Provider error variant는 모두 ineligible입니다.

`INVALID_REQUEST`, `TIMEOUT`, `ABORTED`, `NETWORK_ERROR`, `HTTP_ERROR`, `RESPONSE_TOO_LARGE`,
`EMPTY_RESPONSE`, `NON_JSON_RESPONSE`, `INVALID_JSON`, `GATEWAY_ERROR`, `KMA_UPSTREAM_ERROR`(정확히
`03`이 아닌 모든 resultCode), `KMA_INVALID_RESPONSE`, `DUPLICATE_CATEGORY`, `RESPONSE_MISMATCH`,
`INCOMPLETE_PAGE`.

특히 **Abort / Timeout / HTTP(503 포함) / Network** 는 모두 ineligible입니다.

정책 이유:

- transport·gateway·timeout·invalid response·malformed data는 "최신 발표자료가 아직 없음"과 동일한
  신호가 아닙니다.
- `ABORTED` 이후 자동 fallback을 시도하면 caller 취소 계약을 위반합니다.

## Normalization failure는 모두 ineligible

모든 `NORMALIZATION`-stage failure는 ineligible입니다. issue reason이 `ABSENT`·`NULL`·`INVALID`
어느 것이든 ineligible이며, classifier는 issues 배열 내용을 기준으로 재분류하지 않습니다.
normalization failure를 이전 발표자료 재호출로 숨기지 않습니다.

## service-level empty-hourly 정책 (`totalCount`를 직접 검사하지 않음)

- classifier는 `totalCount`를 **직접 읽지 않습니다.** `KmaHourlyForecastServiceResult`는 raw Provider
  success나 `totalCount`를 노출하지 않기 때문입니다(기존 Provider/normalizer/service 책임 경계 유지).
- `EMPTY_HOURLY`는 **service-level empty-success 신호**입니다. 빈 정상 페이지의 observable
  application-level 신호는 `hourly.length === 0`입니다.
- 현재 pipeline에서는 Provider의 `totalCount === 0` 성공 페이지가 빈 slots → 빈 `hourly` → service
  success(`{ ok: true, hourly: [] }`)로 이어질 수 있습니다. 즉 `totalCount 0 → slots [] → hourly []`
  경로가 가능합니다.
- 다만 classifier가 raw `totalCount`를 검사한다고 표현하지 않으며, 모든 empty-hourly가 실제 upstream
  `totalCount 0`이었다고 단정하지 않습니다. 실제 인증 KMA 응답으로 빈 success 형태가 나오는지는 아직
  별도 live 검증 대상입니다.

## raw response / resultMsg 비노출

classifier 출력에는 raw response·raw `resultMsg`·raw body·raw URL·service key·original provider
error·original normalization issues·original hourly가 나타나지 않습니다. eligible 출력은 정확히
`eligible`·`reason`, ineligible 출력은 정확히 `eligible` key만 가집니다.

## deterministic / pure / fresh / no mutation

- deterministic·synchronous. 같은 입력에 deep-equal 결과, 매 호출 fresh result object.
- system clock 미사용(`Date.now`/`new Date` 없음), environment 미사용(`process.env` 없음), network
  미사용(`fetch` 없음), `Promise` 없음, logging 없음, `try/catch` 없음, timer/listener 없음.
- input mutation 없음(중첩된 error/issues/hourly도 불변), frozen input에서도 동작, global mutable
  state·cache 없음.
- original result/error/issues/hourly reference를 출력에 노출하지 않고, extra runtime input
  property를 출력에 노출하지 않습니다.

## 보장하지 않는 것 (이번 PR 범위 밖)

- **no retry / no fallback execution.** 분류만 하며 실제 재호출·대체를 수행하지 않습니다.
- **no request plan / no second request.** primary/previous request 객체를 만들지 않고 두 번째 HTTP
  요청을 실행하지 않습니다.
- **no PR #16 candidate selector wiring.** base-time 후보를 계산하지 않으며, PR #16
  `selectKmaForecastBaseTimeCandidatesAfterAvailabilityDelay`
  ([kma-fallback-candidates.md](./kma-fallback-candidates.md))와 **아직 연결되지 않았습니다.**
- **no delay / AbortSignal orchestration / error precedence.**
- **no WeatherOverview / SourceMetadata / route / cache.**
- **production 동작 불변.** Provider·parser·normalizer·service·facade·composition은 변경되지
  않았고, production은 여전히 facade 호출당 KMA request 최대 1회입니다.

## 다음 orchestration PR 권장 범위

1. PR #16 candidates + PR #17 eligibility를 조합하는 request plan.
2. primary 한 번 + previous 최대 한 번의 fallback orchestration.
3. AbortSignal / error precedence 계약.
4. `WeatherOverview` / `SourceMetadata` assembler.
5. `/weather` route와 HTTP mapping.
6. cache / stale-data.

## 공식 근거

- `resultCode 03` = `NODATA_ERROR`는 공공데이터포털 공통 결과코드 안내의 공식 의미입니다. 그 외
  코드(인증·access·기타)는 no-data 신호가 아니므로 ineligible입니다.
- 실제 `ServiceKey`를 사용한 live 검증은 이 PR에서 수행하지 않았습니다. 실제 인증 응답의 빈 success
  형태(`totalCount 0`)는 여전히 후속 live 검증 대상입니다.

## 변경 이력

```text
v1 / PR #17 / 2026-07
- KMA upstream resultCode 03 fallback eligibility 추가 (KMA_NO_DATA)
- empty hourly success eligibility 추가 (EMPTY_HOURLY)
- 그 외 Provider/Normalization 결과 명시적 ineligible
- actual retry/fallback orchestration 제외
```
