# KMA 초단기실황 (Current Observation) Provider

이 문서는 기상청(KMA) **초단기실황조회(`getUltraSrtNcst`)** 의 provider boundary — request
검증·URL 생성, raw JSON runtime schema, 성공/upstream error/invalid response 분류,
category grouping과 field-presence 모델, 기존 KMA HTTP transport 정책을 재사용하는 provider,
그리고 공유 contract `CurrentWeather`로의 정규화 — 를 기록합니다. 근거는 아래 공식 자료이며,
블로그·개인 저장소·비공식 정리 문서는 사용하지 않았습니다.

이 PR(#63)은 **provider boundary까지만** 구현합니다. current 데이터를 실제 `POST /weather`에
연결하지 않으며, `apps/api/src/services`·`composition`·`routes`·`presenters`는 변경하지
않습니다.

## 공식 자료

| 항목 | 값 |
| --- | --- |
| 공식 서비스명 | 기상청_단기예보 조회서비스 |
| 공공데이터 ID | `15084084` |
| 공식 활용가이드 파일명 | `기상청41_단기예보 조회서비스_오픈API활용가이드_2607.zip` |
| 활용가이드 버전 | `2607` |
| 서비스(오퍼레이션) 버전 | `VilageFcstInfoService_2.0` |
| 대상 operation | 초단기실황조회 `getUltraSrtNcst` |
| endpoint (프로덕션) | `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0` |

`getUltraSrtNcst`는 [kma-response-boundary.md](./kma-response-boundary.md)와
[kma-http-provider.md](./kma-http-provider.md)에서 이미 "이번 PR 범위 아님"으로 명시적으로
제외됐던 세 번째 operation입니다. 공식 envelope(`response.header`/`response.body`) 구조, 인증
방식(`ServiceKey`), HTTPS endpoint, 방어적 timeout·gateway XML 정책은 단기·초단기예보와 같은
서비스(`VilageFcstInfoService_2.0`)를 공유하므로 재확인하지 않고 재사용합니다. 이 PR에서 새로
확인한 것은 **초단기실황 고유의 request/item shape**입니다. 인증된 실제 초단기실황 JSON
응답은 이번 PR에서도 확보하지 못했습니다 — 아래 "실제 인증 API 검증 상태" 참고.

## current와 forecast의 분리 이유

초단기실황은 단기·초단기예보와 **다른 shape**입니다.

* request: `base_date`, `base_time`, `nx`, `ny`만 있고 `product` 선택이 없습니다(operation이
  `getUltraSrtNcst` 하나뿐).
* item: `baseDate`, `baseTime`, `category`, `obsrValue`, `nx`, `ny`만 있고, forecast 전용
  `fcstDate`/`fcstTime`/`fcstValue`가 없습니다 — 초단기실황은 예보 대상 시각이 아니라 **관측
  자체의 시각**(`baseDate`+`baseTime`)만 가집니다.
* `base_time`은 정시 단위 `HHmm`입니다(예보의 3시간/1시간 발표 스케줄과 다른 정시 관측
  스케줄). **P2 remediation (이 문서 갱신 시점)**: 이 정시 제약은 이제 request/raw
  schema/normalization 세 경계 모두에서 실제로 강제됩니다 — 아래 "Request 계약"과
  "CurrentWeather normalization 계약" 참고.

이 차이 때문에 기존 forecast raw schema(`raw-schema.ts`)·parser(`parse-response.ts`)·grouping
(`group-forecast-items.ts`)을 current 전용 필드로 확장하거나 union으로 바꾸지 않고, **독립된
병렬 모듈**(`current-raw-schema.ts`/`parse-current-response.ts`/
`group-current-observation-items.ts`)로 구현했습니다. 기존 `KmaForecastProduct`,
`KmaForecastRequest`, `KmaForecastSlot`의 의미와 동작은 이 PR에서 변경하지 않았습니다.

재사용한 부분은 **shape이 실제로 동일한 것**뿐입니다.

* `response.header`(`resultCode`/`resultMsg`) 스키마와 성공 코드(`KMA_SUCCESS_RESULT_CODE`) —
  `raw-schema.ts`의 `kmaResponseHeaderSchema`/`kmaResponseEnvelopeSchema`를 그대로 import.
* `baseDate`(`YYYYMMDD`) 검증 predicate — `validation.ts`의 `isCalendarDate`를 forecast와
  그대로 공유(같은 KST 달력 규칙). `baseTime`은 forecast의 일반 `isClockTime`이 아니라
  current-observation 전용 `isKmaCurrentObservationBaseTime`(정시 `HH00`만 허용)을 쓰며,
  `nx`/`ny`도 forecast의 무제한 `isNonNegativeSafeInteger`가 아니라 current 전용
  `isKmaCurrentObservationGridNx`/`Ny`(공식 `[1,149]×[1,253]` 격자)를 씁니다 — 세 predicate
  모두 `validation.ts`에 있는 하나의 provider-local single source of truth이며, request/raw
  schema/normalization 세 경계가 이 값을 공유합니다.
* HTTPS endpoint, 고정 pagination(`pageNo=1`/`numOfRows=1000`/`dataType=JSON`) 값,
  timeout/abort/response-size/gateway-XML transport 정책 — 아래 "provider와 transport 재사용"
  참고.

## Request 계약

`KmaCurrentObservationRequest`(`apps/api/src/providers/kma/current-request.ts`)는 네 필드만
가집니다.

```ts
interface KmaCurrentObservationRequest {
  readonly baseDate: string; // YYYYMMDD
  readonly baseTime: string; // HHmm (정시)
  readonly nx: number;
  readonly ny: number;
}
```

* `validateKmaCurrentObservationRequest(input: unknown)`은 non-object 입력에서도 total하며
  throw하지 않습니다 — `null`/`undefined`/문자열/숫자/boolean/배열/함수는 네 field 모두
  `INVALID`로 고정 순서 반환(forecast request validator와 동일한 totality 정책,
  `request.ts` 참고).
* `baseDate`는 `isCalendarDate`를 재사용합니다. `baseTime`은 forecast의 일반 `isClockTime`이
  아니라 current 전용 `isKmaCurrentObservationBaseTime`(정시 `HH00`만 허용)을 씁니다 —
  `0530`처럼 구조적으로 `HHmm` 형식이어도 정시가 아니면 `INVALID_REQUEST`입니다. 실제 정시
  발표 스케줄 *선택*(예: 현재 시각으로부터 최신 정시를 자동 계산하는 것) 자체는 여전히 이
  PR 범위가 아닙니다(후속 base-time selector PR) — 여기서 강제하는 것은 caller가 제공한
  `baseTime`이 이미 정시 형식이어야 한다는 값 검증일 뿐입니다.
* `nx`/`ny`는 forecast의 무제한 `isNonNegativeSafeInteger`가 아니라 current 전용
  `isKmaCurrentObservationGridNx`/`Ny`(공식 `[1,149]×[1,253]` 격자, string coercion 없음)로
  검증합니다 — `0`, `150`, `254` 등 범위 밖 값은 `INVALID_REQUEST`입니다.
* URL operation은 caller 입력이 아니라 고정 `KMA_CURRENT_OBSERVATION_OPERATION =
  'getUltraSrtNcst'`입니다 — forecast의 `KMA_OPERATION_BY_PRODUCT`처럼 고정 mapping에서만
  선택되며 절대 caller 입력으로 URL path를 만들지 않습니다.
* base URL과 고정 pagination(`pageNo=1`/`numOfRows=1000`/`dataType=JSON`)은 `request.ts`가
  export하는 `KMA_BASE_URL`/`KMA_FIXED_PAGE_NO`/`KMA_FIXED_NUM_OF_ROWS`/`KMA_FIXED_DATA_TYPE`
  상수를 그대로 재사용합니다 — 두 request가 실제로 같은 공식 값을 쓰기 때문입니다.
* `ServiceKey`는 `URLSearchParams`로 정확히 한 번 encode됩니다(forecast와 동일한 encoding
  정책). URL·query·service key·invalid raw value는 오류에 절대 포함하지 않습니다.
* 정시가 아닌 `baseTime` 또는 격자 범위 밖 `nx`/`ny`는 `INVALID_REQUEST`로 거부되고
  `buildKmaCurrentObservationRequestUrl`도 URL을 만들지 않습니다 — provider는 이 경우 `fetch`를
  호출하지 않습니다.

## Raw schema와 response parser 계약

`current-raw-schema.ts`는 Zod 4 schema로 초단기실황 item을 모델링합니다.

```json
{
  "response": {
    "header": { "resultCode": "00", "resultMsg": "NORMAL_SERVICE" },
    "body": {
      "dataType": "JSON",
      "items": {
        "item": [
          {
            "baseDate": "20260716",
            "baseTime": "0600",
            "category": "T1H",
            "obsrValue": "23.5",
            "nx": 60,
            "ny": 127
          }
        ]
      },
      "pageNo": 1,
      "numOfRows": 1000,
      "totalCount": 8
    }
  }
}
```

* `z.coerce`를 쓰지 않습니다. `obsrValue`는 forecast의 `fcstValue`와 동일한 근거 수준으로
  **문자열**로 모델링합니다(공식 명세는 문자열 인코딩, 공식 JSON literal `null` 사례는
  forecast와 마찬가지로 미확인 — field-presence 모델을 위한 방어적 허용이며 후속 live
  검증 대상). `category`는 forecast와 동일한 `/^[A-Z0-9]+$/` 문자 클래스(enum 아님)입니다.
  `baseTime`은 current 전용 `isKmaCurrentObservationBaseTime`(정시 `HH00`)으로, `nx`/`ny`는
  forecast의 무제한 정수 `>= 0`이 아니라 공식 격자 범위 `nx ∈ [1,149]`/`ny ∈ [1,253]`으로
  검증합니다(`validation.ts`의 `KMA_CURRENT_OBSERVATION_GRID_*` 상수 — request 검증과 같은
  source).
* `response.header`와 성공 코드 정책은 `raw-schema.ts`의 `kmaResponseHeaderSchema`/
  `KMA_SUCCESS_RESULT_CODE`/`kmaResponseEnvelopeSchema`를 **그대로** import해 재사용합니다 —
  별도 정의를 만들지 않으므로 두 경계가 header 판정에서 항상 일치합니다.
* non-success 2자리 `resultCode`는 forecast와 동일하게 `UPSTREAM_ERROR`로 분류하고 **2자리
  resultCode만** 보존합니다(raw `resultMsg` 비노출). malformed header/`resultCode`/body는
  `INVALID_RESPONSE`(sanitized `path`+`message`만, Zod issue를 결정론적으로 정렬).
* pagination self-contradiction 검증(`item.length > numOfRows`, `item.length > totalCount`,
  `totalCount === 0`인데 item 존재)은 forecast body schema와 동일한 강도로 적용합니다.
  `totalCount > 0` + 빈 `item` 배열은 forecast와 동일하게 **방어적으로 허용**합니다(공식
  empty-page 사례 미확인) — provider가 이 경우 slot을 `null`로 두고 임의 current 값을
  만들지 않습니다(아래 "grouping" 참고).
* `parseKmaCurrentObservationResponse(input: unknown)`은 forecast의
  `parseKmaForecastResponse`와 동일한 3단계 판정 순서(envelope 유효성 → 성공 코드 여부 → body
  검증)를 따르며, throw하지 않고 discriminated result를 반환합니다.

## Grouping 계약

`group-current-observation-items.ts`는 검증된 item 배열을 하나의 관측 **slot**으로 묶습니다.

* slot identity는 `baseDate | baseTime | nx | ny` **4개**입니다 — forecast의 7개(product 포함,
  fcstDate/fcstTime 포함)보다 적은 것은 초단기실황에 product 선택과 예보 대상 시각이 없기
  때문입니다. `category`는 identity에서 제외합니다(여러 category가 한 slot에 모임).
* category당 item은 최대 1개이며, duplicate category는 last-write-wins가 아니라 결정론적
  `DUPLICATE_CATEGORY` 오류입니다(forecast와 동일한 정책 — 값이 같아도 오류, 중복이 여럿이면
  `(slotKey, category)` 최솟값을 보고).
* `ABSENT`/`NULL`/`VALUE` field-presence 모델을 그대로 사용합니다. `obsrValue`가 명시적
  `null`이면 `NULL`, category 자체가 없으면 `ABSENT`, 값이 있으면 `VALUE`(raw 문자열은 이
  provider 내부 field에만 보존되고 normalizer가 파싱한 결과만 공개 contract로 나갑니다).
* fields는 category code-unit ascending으로, slots는 `baseDate → baseTime → nx → ny` 순으로
  정렬합니다(입력 순서 무관, 결정론적).
* 입력 array/item을 mutate하지 않습니다.

**Provider 단의 request/response correlation.** `provider.ts`의
`fetchCurrentObservation()`은 응답의 모든 item이 request와 동일한
`baseDate`/`baseTime`/`nx`/`ny`를 갖는지 먼저 검증합니다(`findCurrentResponseMismatch`,
forecast의 `findResponseMismatch`와 동일한 고정 순서: `pageNo → numOfRows → baseDate →
baseTime → nx → ny`, 실제 mismatched 값은 오류에 넣지 않고 field 이름만). 이 correlation을
통과하면 남은 모든 item이 정확히 같은 4-part identity를 공유하므로, grouping은 **최대 1개
slot**만 만들 수 있습니다. `totalCount > page.items.length`이면 `INCOMPLETE_PAGE`로
거부합니다(자동 재페이지네이션 없음, forecast와 동일).

`KmaCurrentObservationProviderSuccess.slot`은 `KmaCurrentObservationSlot | null`입니다 — 방어적
빈 성공 page(`totalCount > 0` + 빈 item, 또는 `totalCount === 0`)에서는 `null`이며,
`normalizeKmaCurrentObservation()`은 이 경우 모든 category를 `ABSENT`로 취급합니다(임의 값
생성 없음).

## CurrentWeather normalization 계약

`normalizeKmaCurrentObservation()`(`normalize-current.ts`)은 provider success를 공유 contract
`CurrentWeather`로 변환하는 **순수 adapter**입니다. HTTP provider는 이 함수를 자동 호출하지
않습니다.

| category | contract field | 정책 |
| --- | --- | --- |
| (없음, `baseDate`+`baseTime`) | `observedAt` | 필수. KST `YYYY-MM-DDTHH:mm:00+09:00` |
| `T1H` | `temperatureCelsius` | 필수. `parseKmaTemperatureCelsius` 재사용 |
| `PTY` | `condition` | current 전용 PTY normalizer, `PTY=0` → `UNKNOWN` |
| `REH` | `humidityPercent` | optional, `parseKmaPercentage` 재사용 |
| `WSD` | `windSpeedMetersPerSecond` | optional, `parseKmaWindSpeedMetersPerSecond` 재사용 |
| `VEC` | `windDirectionDegrees` | optional, `parseKmaWindDirectionDegrees` 재사용 |
| `RN1` | `precipitationLastHourMillimeters` | optional, `parseKmaPrecipitationAmountMillimeters` 재사용 (아래 참고) |
| (계산 안 함) | `feelsLikeCelsius` | 이 PR에서는 항상 `null` |
| (미제공) | `visibilityMeters` | 초단기실황이 제공하지 않으므로 항상 `null` |

### observedAt (KST)

grouped observation의 `baseDate`+`baseTime`을 `YYYY-MM-DDTHH:mm:00+09:00`으로 조합합니다.
`normalize-hourly.ts`의 `forecastAt` 생성과 동일한 원칙 — 순수 문자열 조합이며 `Date`, system
clock, locale, host timezone을 쓰지 않습니다(seconds는 항상 `00`, offset은 고정 `+09:00`).
`baseDate`/`baseTime`이 malformed이면(방어적 재검증, raw schema가 이미 보장하지만 normalizer
단독 호출도 안전하도록) `observedAt` `INVALID` issue를 반환합니다.

### temperatureCelsius (필수)

`T1H`가 `ABSENT`/`NULL`/파싱 실패(`INVALID`)면 normalization 전체가 실패합니다. 음수·`0`을
포함한 정상 값은 그대로 보존합니다(기존 `parseKmaTemperatureCelsius` 재사용, forecast의
`TMP`/`T1H` 정책과 동일).

### condition (PTY, current 전용 정책)

초단기실황에는 현재 하늘상태를 나타내는 SKY 항목이 없습니다. 그래서 별도의 current 전용
PTY normalizer(`normalizeKmaCurrentWeatherCondition`,
`packages/weather-core/src/kma/current-condition.ts`)를 추가했고, forecast의
`normalizeKmaWeatherCondition`(SKY+PTY, product별 분기)은 변경하지 않았습니다.

| PTY code | 공식 의미 | 결과 |
| --- | --- | --- |
| `1`, `5` | 비, 빗방울 | `RAIN` |
| `2`, `6` | 비/눈, 빗방울눈날림 | `SLEET` |
| `3`, `7` | 눈, 눈날림 | `SNOW` |
| `0` | 없음 | `UNKNOWN` (아래 이유) |
| missing/blank/unknown/malformed 또는 current에 미정의된 code | — | `UNKNOWN` |

**PTY `0`에서 `UNKNOWN`인 이유.** forecast normalizer는 PTY `0`(강수 없음)일 때 SKY 코드로
`CLEAR`/`PARTLY_CLOUDY`/`CLOUDY`를 판정합니다. 초단기실황에는 그 SKY 항목 자체가 없으므로,
"강수 없음"이라는 사실만으로 맑음/구름많음/흐림 중 무엇인지 **추측할 근거가 없습니다**.
그래서 이 normalizer는 PTY `0`을 forecast처럼 SKY fallback으로 풀지 않고 `UNKNOWN`으로
고정합니다. `4`(소나기)는 초단기실황 PTY 코드 집합에 없으므로(forecast 전용) 미정의 코드로
`UNKNOWN`입니다. 숫자로 coercion하지 않고 trim한 뒤 exact string만 매칭합니다(forecast
normalizer와 동일한 입력 규칙).

### RN1 (precipitationLastHourMillimeters)

기존 `parseKmaPrecipitationAmountMillimeters`(`weather-core/src/kma/amount.ts`)를 **그대로
재사용**했습니다. 이 함수의 grammar가 current의 strict 실수값 표기를 이미 안전하게 처리하기
때문입니다.

* bare 실수 문자열(`'0'`, `'1.5'`)은 `BARE_NUMBER` 패턴으로 그대로 파싱됩니다.
* `'0'`/`'0.0'`은 no-amount token으로 확인된 `0`을 반환합니다(`0`이 항상 `0`으로 보존).
* 이 parser의 정규식은 부호 문자를 허용하지 않으므로, 음수 문자열(`'-1'`)은 어떤 패턴에도
  매치되지 않아 자연히 `null`이 됩니다(negative amount → null).
* Missing 센티넬(`>= 900`)과 forecast 전용 범위/미만/이상 bucket 표기(`'1mm 미만'` 등)도
  이 parser가 이미 처리하므로, 실제 current 응답이 순수 실수 표기만 보내더라도 동작에
  문제가 없습니다.

별도의 current 전용 amount parser는 추가하지 않았습니다. 초단기실황 RN1의 실제 공식
表기(threshold bucket을 쓰는지 여부 등)는 공식 자료로 완전히 재확인하지 못했으므로, 이
재사용 결정은 방어적이며 실제 인증 API 응답으로 재검증할 대상입니다(아래 "실제 인증 API
검증 상태" 참고).

### optional field 공통 정책

`REH`/`WSD`/`VEC`/`RN1`의 `ABSENT`, `NULL`, 또는 파싱 불가(malformed·out-of-range·Missing)는
모두 `null`입니다. 이 중 어떤 것도 normalization 전체를 실패시키지 않습니다 — `observedAt`과
`temperatureCelsius` 문제만 실패시킵니다.

### contract validation

완성한 candidate는 항상 공유 `currentWeather.safeParse()`로 검증합니다. 검증 실패는 raw 값을
포함하지 않는 sanitized issue(`field: 'contract'`, Zod `path`+`message`만)로 보고합니다. issue는
`(field, reason, path, message)` 순서로 결정론적으로 정렬됩니다.

## Provider와 transport 재사용

`provider.ts`는 기존 forecast provider(`fetchForecast`)의 timeout/caller-abort/HTTP-status/
size-limited body reading 정책을 **완전히 재설계하지 않고**, 그 lifecycle을 담당하던 코드를
`performKmaGetRequest()`라는 하나의 private helper로 추출해 forecast와 current-observation
provider가 함께 호출하도록 했습니다. 이 helper는 다음을 소유합니다.

* 이미 aborted된 caller signal을 fetch 없이 즉시 `ABORTED`로 처리.
* 내부 `AbortController` + timeout timer + caller-abort listener — lifecycle이 response
  header뿐 아니라 body 완독까지 덮으며, 모든 return/throw 경로에서 `finally`로 정리.
* `redirect: 'error'`(service key가 redirect 대상 host로 전달되지 않도록).
* HTTP status 분류(`response.ok === false` → `HTTP_ERROR`, status만 보존, body 미독).
* size-limited body reading(`read-response.ts` 재사용) — `RESPONSE_TOO_LARGE`가 동시 발생한
  abort보다 우선하고, `BODY_READ_ERROR`는 abort reason에 따라 `TIMEOUT`/`ABORTED`/
  `NETWORK_ERROR`로 매핑.
* **종료 보장 (첫 번째 P2 remediation).** 위 lifecycle은 `controller.abort()`가 호출되면 주입된
  `fetchImpl`이 **실제로 반응한다는 것**에 의존하지 않습니다. `fetchImpl` 호출은 내부
  `raceAgainstAbort` helper로 "timeout/caller-abort가 발생했다"는 별도 promise와 경쟁합니다 —
  signal을 완전히 무시하고 영구히 pending인 `fetchImpl`이라도, 이 경쟁에서 timeout/abort 쪽이
  이기면 provider는 그 즉시 `TIMEOUT`/`ABORTED`로 반환합니다. 경쟁에서 진 원래 promise가
  나중에(또는 다시는) settle되더라도: 이미 결정된 결과는 바뀌지 않고, 늦게 도착한 `Response`의
  body는 best-effort로 cancel되며, 늦은 rejection은 raw error나 unhandled rejection으로
  노출되지 않습니다(late-settlement 전용 handler가 붙습니다). `fetchForecast`/
  `fetchCurrentObservation`의 기존 공개 결과·오류 union은 이 remediation으로 변경되지 않았습니다.
* **Cleanup 분리 (두 번째 P2 remediation).** provider 결과 확정, best-effort transport cleanup
  시작, outstanding async work의 late settlement 처리는 서로 다른 세 단계로 분리됩니다 —
  cleanup이 끝나야 결과를 반환하는 구조도, cleanup을 전혀 시작하지 않는 구조도 아닙니다.
  * fetch 직후 이미 abort/timeout이 관찰된 경로와 non-2xx HTTP 경로의 response body
    cancellation(`cancelBody`)은 완전히 non-blocking입니다 — `body.cancel()`이 pending,
    reject, 또는 synchronous throw여도 이미 결정된 `TIMEOUT`/`ABORTED`/`HTTP_ERROR` 결과를
    지연시키지 않습니다.
  * `RESPONSE_TOO_LARGE`는 감지되는 즉시(Content-Length precheck 또는 streaming 누적 모두)
    cleanup을 시작하기 **전에** latch됩니다.
* **Body read의 신호 기반 bounded 종료와 단일 abort 구독 (세 번째 P2 remediation).**
  `read-response.ts`가 소유하는 body reader는 이제 provider의 내부 `controller.signal`을 직접
  전달받습니다 — provider는 body read 주위에 별도의 outer `raceAgainstAbort`를 쓰지 않습니다
  (fetch 호출 주위의 race는 그대로 유지됩니다). `read-response.ts`는 reader의 전체 lifecycle
  동안 이 signal에 `abort` listener를 **정확히 한 번만** 등록합니다 — 읽은 chunk 수와 무관하게
  구독 횟수는 늘어나지 않으며(0-byte chunk가 반복돼도 마찬가지), 모든 종료 경로(성공, overflow,
  read 오류, abort, 이미 aborted된 signal)에서 `finally`로 listener를 제거합니다. pending
  `reader.read()`가 이 signal보다 늦게 settle되면(non-cooperative stream), best-effort
  `reader.cancel()`을 즉시 시작하되 완료를 기다리지 않고 반환합니다. 원래의 pending read에는
  handler가 붙어 있어, 나중에(또는 reject로) settle되면 lock release가 다시 시도됩니다 — 처음
  시도가 pending read 때문에 성공하지 못했을 수 있기 때문입니다. 동일 reader에 대한 중복
  cancel/release는 안전합니다. `RESPONSE_TOO_LARGE`의 latch-then-cancel 순서(위 항목)는 이 signal
  기반 설계에서도 유지됩니다 — overflow의 자체 cleanup(`reader.cancel()`)이 (예를 들어 그 취소
  콜백이 caller의 `AbortController.abort()`를 동기 호출하는 등으로) 같은 signal을 동기적으로
  fire시키더라도, `RESPONSE_TOO_LARGE`는 이미 latch되어 반환되는 중이므로 그 abort가 결과를
  가로챌 수 없습니다.
  * 이 cleanup 분리는 best-effort입니다 — 실제 stream/reader가 얼마나 빨리(또는 전혀) 반응해
    정리되는지까지 보장하지 않으며, 오직 provider 결과가 그 반응을 기다리지 않는다는 것만
    보장합니다.

이 helper 이후의 로직 — JSON parse, gateway XML 탐지, KMA response parser 호출, request/response
correlation, slot grouping — 은 operation마다 분리된 채로 유지됩니다(forecast:
`classifyBody`/`interpretPage`, current: `classifyCurrentBody`/`interpretCurrentPage`). 두
response shape이 실제로 다르기 때문에 이 부분은 공유하지 않습니다.

**기존 `fetchForecast()`의 공개 계약은 변경되지 않았습니다** — 요청/응답 타입, 오류 kind, 성공
결과 shape, request correlation 순서, 기존 테스트 전체가 리팩터 전후 동일하게 통과합니다(이
문서 작성 시점 기준 forecast provider 테스트 전체 회귀 확인 완료).

`createKmaCurrentObservationProvider`/`createKmaCurrentObservationProviderFromEnv`는
forecast provider와 동일한 `KmaForecastProviderOptions`(serviceKey/fetchImpl/timeoutMs/
maxResponseBytes)를 받고 동일한 `validateKmaProviderOptions`로 검증합니다 — 두 provider가
같은 서비스·같은 `KMA_SERVICE_KEY`·같은 방어적 timeout/response-size 기본값을 쓰기 때문에
별도 옵션 타입을 만들지 않았습니다. `KMA_SERVICE_KEY`는 호출 시점에만
`process.env`에서 읽습니다(import-time env access 없음, forecast provider와 동일).

## Provider와 normalization 오류 분리

Provider transport/raw-response 오류(`KmaCurrentObservationProviderError`)와 normalization
오류(`KmaCurrentNormalizationIssue`)는 하나의 error kind로 합치지 않습니다 — forecast의
`KmaForecastProviderError`/`KmaHourlyNormalizationIssue` 분리와 동일한 원칙입니다. HTTP
provider(`fetchCurrentObservation`)는 `normalizeKmaCurrentObservation`을 자동 호출하지
않으며, 이 둘을 잇는 application service는 이 PR 범위가 아닙니다.

## 오류·보안 요구사항

다음은 어떤 오류·테스트 출력·이 문서에도 포함하지 않습니다.

* ServiceKey, 요청 URL 또는 query string
* raw response body, raw `resultMsg`, raw `obsrValue`
* 실제 좌표·실제 운영 환경 값
* stack trace 또는 내부 exception text

오류는 고정된 discriminated union으로 유지됩니다.

* request validation error (`INVALID_REQUEST`, value-free field issues)
* transport/HTTP/timeout/abort/body-size/gateway/JSON error (forecast와 동일한 kind 집합을
  공유: `TIMEOUT`/`ABORTED`/`NETWORK_ERROR`/`HTTP_ERROR`/`RESPONSE_TOO_LARGE`/
  `EMPTY_RESPONSE`/`NON_JSON_RESPONSE`/`INVALID_JSON`/`GATEWAY_ERROR`)
* upstream KMA error (`KMA_UPSTREAM_ERROR`, 2자리 `resultCode`만)
* invalid response (`KMA_INVALID_RESPONSE`, sanitized issues만)
* response/request mismatch (`RESPONSE_MISMATCH`, field 이름만)
* duplicate category (`DUPLICATE_CATEGORY`, category+slotKey만 — 실제 값 없음)
* normalization error (`KmaCurrentNormalizationIssue`, field+reason(+sanitized contract
  path/message)만)

기존 provider의 caller abort와 internal timeout 구분(`ABORTED` vs `TIMEOUT`)은 current
provider에도 동일하게 적용됩니다.

## 구현된 범위와 후속 PR 범위

**이 PR(#63)에서 구현 완료:**

* weather-core current PTY normalizer(`normalizeKmaCurrentWeatherCondition`)
* current request runtime validation과 deterministic URL builder
* current raw JSON runtime schema, 성공/upstream error/invalid response parser
* current category grouping과 ABSENT/NULL/VALUE field-presence 모델
* 기존 transport 정책을 재사용하는 current HTTP provider
  (`createKmaCurrentObservationProvider`/`…FromEnv`)
* current → 공유 `CurrentWeather` pure normalizer(`normalizeKmaCurrentObservation`)
* 이 문서와 unit test

**후속 PR 범위(이 PR에서 구현하지 않음):**

* current를 `POST /weather`에 연결(application service, composition, route)
* ~~current observation base-time selector(정시 발표 스케줄 자동 선택)~~ — **PR #64에서 pure
  weather-core selector로 완료**(`selectLatestKmaCurrentObservationBaseTime`,
  [kma-current-observation-issue-time.md](./kma-current-observation-issue-time.md)). 이 selector를
  소비하는 request factory/production wiring/`POST /weather` 연결은 여전히 후속입니다.
* `WeatherOverview`의 `current` section 조립, `SourceMetadata`(`sourceId`/`issuedAt`/
  `retrievalMode` 등)
* 실제 KMA endpoint 호출, 실제 service key 사용, 실기기/실제 API smoke 검증
* AirKorea, alert provider, cache/retry/fallback 정책
* mobile 변경(current 표시 화면은 이미 `apps/mobile/src/details`가 `response.data.current`를
  소비하도록 구현돼 있으나 — [mobile-weather-details.md](./mobile-weather-details.md) 참고 —
  production KMA pipeline이 여전히 hourly-only이므로 이 PR 이후에도 current는 계속 missing으로
  응답됩니다)

## 실제 인증 API 검증 상태

* 실제 사용자/운영 `KMA_SERVICE_KEY`는 사용하지 않았습니다.
* 자동 테스트는 실제 네트워크를 호출하지 않고, 주입된 fake `fetch`와 in-memory `Response`,
  synthetic fixture만 사용합니다.
* 초단기실황의 envelope 구조·`ServiceKey` 인증 방식·HTTPS endpoint·gateway XML 형식은 단기·
  초단기예보(PR #4/#5에서 진단됨)와 같은 서비스를 공유하므로 재사용했지만, **초단기실황
  고유의 실제 JSON 응답**(item 배열 실제 개수·순서, `obsrValue`의 실제 표기, RN1의 실제 grammar,
  base-time의 실제 정시 스케줄)은 인증된 실제 API 호출로 확인하지 못했습니다.
* `obsrValue`의 JSON literal `null` 가능성, RN1이 순수 실수 표기만 쓰는지 여부, PTY `0`이 실제로
  반환되는 상황 등은 방어적으로 모델링했으며, 실제 service key를 이용한 후속 live integration
  검증에서 재확인할 항목으로 남습니다.
