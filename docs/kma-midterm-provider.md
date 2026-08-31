# KMA 중기예보 조회서비스 (Mid-term Forecast) Provider

이 문서는 기상청(KMA) **중기예보 조회서비스(`MidFcstInfoService`)** 의 D+4~D+10 두 operation —
중기기온조회(`getMidTa`)와 중기육상예보조회(`getMidLandFcst`) — provider boundary를 기록합니다.
request 검증·URL 생성, operation별 raw JSON runtime schema, 성공/upstream error/invalid response
3-outcome 분류, 기존 KMA HTTP transport·config 정책을 재사용하는 provider까지가 범위입니다.

이 PR(#98)은 **provider boundary까지만** 구현합니다. 검증된 raw mid-term record를 반환할 뿐,
`DailyForecast[]`로 정규화하거나 위치를 `regId`로 해석하지 않으며, `POST /weather`·
`apps/api/src/services`·`composition`·`routes`·`presenters`·`packages/**`·`apps/mobile/**` 은
변경하지 않습니다.

## 공식 자료와 evidence

| 항목 | 값 |
| --- | --- |
| 공식 서비스명 | 기상청_중기예보 조회서비스 (`MidFcstInfoService`) |
| 공공데이터 ID | `15059468` |
| 활용가이드 archive | `기상청28_중기예보 조회서비스_오픈API활용가이드_251212` |
| 대상 operation | 중기기온조회 `getMidTa`, 중기육상예보조회 `getMidLandFcst` |
| endpoint (프로덕션) | `https://apis.data.go.kr/1360000/MidFcstInfoService/{operation}` |

`MidFcstInfoService`는 단기·초단기예보/초단기실황(`VilageFcstInfoService_2.0`)이나 기상특보
(`WthrWrnInfoService`)와 **다른 서비스 패밀리**입니다. base URL을 공유하지 않으므로
[kma-http-provider.md](./kma-http-provider.md)의 `KMA_BASE_URL`이나
[kma-alert-event-provider.md](./kma-alert-event-provider.md)의 `KMA_ALERT_BASE_URL`을 재사용하지
않고, 이 서비스 전용 `KMA_MIDTERM_BASE_URL`을 `midterm-request.ts`에 새로 정의했습니다.

### 서비스가 제공하는 네 operation 중 두 개만 사용

공식 서비스는 중기전망조회(`getMidFcst`), 중기육상예보조회(`getMidLandFcst`),
중기기온조회(`getMidTa`), 중기해상예보조회(`getMidSeaFcst`) 네 operation을 제공합니다. 이 boundary는
공개 `DailyForecast` D+4~D+10 형태를 채우는 데 필요한 **`getMidTa`와 `getMidLandFcst` 두 개만**
모델링합니다. 나머지 둘은 이 제품 형태에 기여하지 않으므로 의도적으로 범위 밖입니다.

### 발표 주기와 예보 구간

* 공식 발표시각은 **06:00 KST와 18:00 KST**이며, `tmFc`는 `YYYYMMDD0600` / `YYYYMMDD1800`
  형태입니다. 서비스는 **최근 24시간 자료만** 제공합니다.
* 단기예보가 D+3까지 확대된 뒤 중기예보 제품은 **D+4에서 시작**합니다. 따라서 이 boundary는
  D+4~D+10만 다룹니다.
* 중기육상예보는 **D+4~D+7은 오전/오후로 분리**, **D+8~D+10은 하루 단위(종일)** 로 발표됩니다. 이
  비대칭이 공개 `DailyForecast` 계약이 이미 `morning`/`afternoon`과 `overall`을 함께 갖고 있는
  이유입니다.
* 이 PR은 발표 지연(publication delay)에 대한 retry/fallback 정책을 **정의하지 않습니다**.

### getMidTa vs getMidLandFcst 책임 분리

| operation | 반환 내용 | 이 boundary의 raw item |
| --- | --- | --- |
| `getMidTa` (TEMPERATURE) | D+4~D+10 최저/최고기온 | `regId`, `taMin4`…`taMin10`, `taMax4`…`taMax10` |
| `getMidLandFcst` (LAND) | D+4~D+7 오전/오후 + D+8~D+10 종일 날씨예보·강수확률 | `regId`, `rnSt4Am`/`rnSt4Pm`…`rnSt7Am`/`rnSt7Pm`, `rnSt8`/`rnSt9`/`rnSt10`, `wf4Am`/`wf4Pm`…`wf7Am`/`wf7Pm`, `wf8`/`wf9`/`wf10` |

두 item shape는 `regId` 외에 공통 필드가 없으므로 **완전히 분리된 schema와 분리된 parser**로
모델링했습니다. 한 operation의 payload가 다른 operation의 계약을 만족하는 일은 구조적으로
불가능합니다.

### D+4는 발표시각에 따라 달라지는 유일한 예외 필드 (PR #98 correction)

공식 발표시각은 06:00 KST와 18:00 KST 두 번이며, **06:00 발표는 D+4~D+10을 모두 포함**하지만
**18:00 발표는 D+5부터 시작할 수 있어 D+4 필드 전체를 생략**할 수 있습니다. 초기 구현은 이
비대칭을 반영하지 못해 D+4를 항상 필수로 요구했고, 그 결과 유효한 18:00 응답이 raw schema
단계에서 거부되는 P1 결함이 있었습니다. 이 correction으로 다음과 같이 바로잡았습니다.

* **D+5~D+10은 여전히 raw schema에서 무조건 필수**입니다. 바뀐 것은 D+4뿐입니다.
* **D+4는 raw schema 레벨에서 atomic optional group**입니다 —
  `midterm-raw-schema.ts`의 `kmaMidtermTemperatureItemSchema`/`kmaMidtermLandItemSchema`가
  `taMin4`/`taMax4`(TEMPERATURE)와 `rnSt4Am`/`rnSt4Pm`/`wf4Am`/`wf4Pm`(LAND)를 각각
  `.optional()`로 선언한 뒤 `superRefine`으로 "그룹 전체가 존재하거나 그룹 전체가 부재해야 한다"를
  강제합니다. `taMin4`만 있고 `taMax4`가 없는 것처럼 **부분적으로만 존재하는 D+4는 항상
  거부**됩니다 — 이는 발표시각과 무관한 규칙입니다.
* raw schema는 이 응답이 어떤 `tmFc`에 대한 것인지 알 수 없으므로, **06:00 발표는 D+4를 반드시
  포함해야 한다**는 request-aware 규칙은 raw schema가 아니라 `provider.ts`가 담당합니다.
  `tmFc`가 정확히 `0600`으로 끝나는 요청에 대해 item이 하나 이상 존재하면, provider가 모든
  item의 D+4 그룹이 완전한지 확인합니다. 완전하지 않으면 값·raw body·resultMsg를 노출하지 않는
  기존 `KMA_INVALID_RESPONSE` 오류 표면으로 안전하게 실패합니다(새 오류 variant를 추가하지
  않았습니다).
* `tmFc`가 `1800`으로 끝나는 요청은 D+4가 없어도, 완전한 D+4 그룹이 있어도 모두 성공으로
  받아들입니다 — 활용가이드 예시가 D+4를 생략한다는 사실 하나에 과적합하지 않고, KMA가 일부
  18:00 응답에 D+4를 포함하는 경우도 여전히 수용합니다.
* `202608310615`처럼 구조적으로는 유효하지만 06/18 공식 schedule과 무관한 `tmFc`는 request 계층의
  `isKmaMidtermIssuanceStamp` 정책을 그대로 따라 계속 허용되며(request semantics는 이
  correction에서 바꾸지 않았습니다), 이 D+4 completeness 규칙도 강제하지 않습니다 — 06:00/18:00
  스케줄 선택 정책을 여기서 새로 발명하지 않습니다.
* `totalCount === 0`인 진짜 빈 성공(`items.item: []`)은 완전성 검사 대상이 아닙니다 — 확인할
  레코드 자체가 없기 때문입니다.
* 어떤 계층도 부재한 D+4 값을 `null`/`0`/빈 문자열/D+5 값으로 날조하지 않습니다. 다음
  normalization 계층이 "이 18:00 발표에는 D+4가 없다"는 사실을 그대로 관찰할 수 있어야 합니다.

이 correction을 위해 **실호출은 수행하지 않았습니다** — 06:00/18:00 발표 구간과 `tmFc`
schedule은 이미 이 문서와 `validation.ts`가 기록한 공식 자료(공공데이터포털 API Hub의
"4일(최대5일)에서 10일까지" 설명과 활용가이드의 18:00 예시)에 근거합니다.

### 실제 인증 API 검증 상태

이 PR에서는 **실제 KMA `MidFcstInfoService` 호출을 수행하지 않았습니다.** 실제 service key,
production `/weather` 호출, 배포, Vercel/EAS 작업도 없습니다. 아래 "미확인 evidence" 절이 그
결과로 남은 유일한 공개 항목입니다.

### 미확인 evidence: `getMidTa`의 low/high 범위 필드

공공데이터포털의 `MidFcstInfoService` 서비스 페이지는 **중기전망조회(`getMidFcst`)의 요청/출력
표만** 렌더링하며, `getMidTa`/`getMidLandFcst`의 출력결과 표는 내려받는 활용가이드 archive
(`기상청28_중기예보 조회서비스_오픈API활용가이드_251212`) 안에 있습니다. 이 PR에서는 그 archive를
확인하지 않았고 실호출도 승인되지 않았습니다.

`getMidTa`가 일자별 예보 **범위** 필드(`taMin{N}Low`/`taMin{N}High`/`taMax{N}Low`/`taMax{N}High`
형태)를 함께 제공하는 것으로 알려져 있으나, **정확한 필드명과 JSON 타입을 공식 표로 확인하지
못했습니다.** 따라서 이 필드들은 schema에 **선언하지 않았습니다**:

* Zod의 기본 object strip이 이미 해당 키를 **무해하게 수용하고 버리므로**, 응답에 존재해도
  실패하지 않습니다.
* 반대로 타입을 추측해 선언하면 **정상 응답을 거부할 위험**이 있습니다(예: 실제로 문자열인데
  `z.number()`로 선언한 경우).
* 이 PR의 어떤 코드도 그 필드를 소비하지 않습니다.

공식 출력결과 표를 확인한 뒤 별도의 evidence 기반 correction으로 추가하는 것이 맞습니다. 이는
`alert-raw-schema.ts`가 미관측 단일 object `items.item` 직렬화에 대해 적용한 것과 동일한
discipline입니다.

## Request 계약

`KmaMidtermForecastRequest`(`apps/api/src/providers/kma/midterm-request.ts`)는 세 필드를 가지며,
**전부 필수**입니다(alert boundary와 달리 optional 필터가 없습니다).

```ts
interface KmaMidtermForecastRequest {
  readonly operation: 'TEMPERATURE' | 'LAND';
  readonly regId: string; // 공식 중기예보 구역코드
  readonly tmFc: string; // YYYYMMDDHHmm
}
```

* `validateKmaMidtermForecastRequest(input: unknown)`은 non-object 입력에서도 total하며 throw하지
  않습니다 — forecast/current/alert request validator와 동일한 totality 정책. 고정 필드 순서는
  `operation → regId → tmFc`이며, 매 호출마다 새 issue 배열/객체를 반환합니다.
* `operation`은 서비스 path가 아니라 **반환 내용**으로 이름 붙였습니다. upstream path는 내부
  detail로 유지됩니다.
* `regId`는 **구조 검증만** 합니다 — `validation.ts`의 `isKmaMidtermRegId`가
  `^\d{2}[A-Z]\d{5}$`(숫자 2 + 대문자 1 + 숫자 5)를 요구합니다. 이것은 **allow-list가 아니며**,
  Seoul을 포함한 어떤 지역도 hardcode하지 않습니다. 육상예보구역 코드 집합과 중기기온 도시 코드
  집합은 서로 다른 코드 집합이지만 같은 구조 형태를 공유합니다. 앞뒤 공백은 silent trim하지 않고
  거부합니다.
* `tmFc`는 **구조 검증만** 합니다 — `isKmaMidtermIssuanceStamp`가 12자리 숫자를 요구하고, 앞 8자리는
  `isCalendarDate`, 뒤 4자리는 `isClockTime`으로 검증합니다(forecast/current와 완전히 동일한
  윤년·`HH24MI` 규칙 재사용). **공식 06/18 KST 발표시각 schedule은 강제하지 않습니다** —
  `202608310615` 같은 구조상 유효하지만 비정규 stamp도 통과합니다. 이는 `request.ts`가 단기예보
  `baseTime`의 공식 발표시각을 강제하지 않는 것과 동일한 정책이며, 최신 issuance 선택은 이후
  selector/application 계층의 책임입니다. 이 validator는 시스템 시계를 읽지 않습니다.
* 숫자 coercion은 없습니다 — 숫자형 `tmFc`나 `regId`는 문자열로 변환되지 않고 거부됩니다.

### URL 생성

```
https://apis.data.go.kr/1360000/MidFcstInfoService/{getMidTa|getMidLandFcst}
  ?ServiceKey=…&pageNo=1&numOfRows=10&dataType=JSON&regId=…&tmFc=…
```

* operation → path 매핑은 **내부 고정 표**(`TEMPERATURE → getMidTa`,
  `LAND → getMidLandFcst`)에서만 선택됩니다. caller 입력이 path에 도달하는 경로는 없습니다.
* **service key 파라미터 이름은 `ServiceKey`(대문자)** 로, 공공데이터포털 상세기능 표가 이
  서비스의 요청을 그렇게 문서화하기 때문입니다 — forecast/current boundary와 동일합니다.
  alert boundary의 소문자 `serviceKey`는 **복사하지 않았습니다**: 그 casing은 다른 서비스
  패밀리에 대한 Owner-authorized live 진단으로 확립된 것이고, 이 PR에는 실호출이 승인되지
  않았습니다.
* 고정 파라미터: `pageNo=1`, `numOfRows=10`, `dataType=JSON`. `numOfRows=10`은 공공데이터포털
  상세기능 표의 문서화된 sample 값이며, 하나의 `regId`/`tmFc` 조합이 단일 item을 반환하므로
  완전한 응답을 받기에 충분합니다. caller가 이 값들을 바꿀 수 없습니다.
* `URL` + `URLSearchParams`만 사용하며 문자열 연결로 secret이 들어간 URL을 만들지 않습니다.
  service key는 정확히 **1회** percent-encoding 되고, `%`가 이중 인코딩되지 않습니다.
* 파라미터 순서는 결정적입니다: `ServiceKey → pageNo → numOfRows → dataType → regId → tmFc`.

### 이 PR이 하지 않는 것 (request 측)

* 위치/행정구역/위경도 → `regId` 매핑 (전국 매핑 테이블 없음)
* production Seoul 지역 hardcode
* 최신 06/18 issuance selector
* 발표 지연 retry/fallback

## Raw schema와 response parser 계약

### Envelope

`response.header.resultCode`/`resultMsg`와
`dataType`/`pageNo`/`numOfRows`/`totalCount`/`items.item` body 구조는 forecast/current/alert
boundary와 동일하므로, `midterm-raw-schema.ts`는 `raw-schema.ts`의 `kmaResponseHeaderSchema`·
`kmaResponseEnvelopeSchema`·`KMA_SUCCESS_RESULT_CODE`를 **재정의하지 않고 재사용**합니다.

page 자기모순 규칙도 동일합니다(거부): `items.item.length > numOfRows`,
`items.item.length > totalCount`, `totalCount === 0`인데 item 존재. `totalCount > 0`인데 item이
비어 있는 경우와 `item.length < totalCount`는 schema에서 허용하고, 후자는 provider가
`INCOMPLETE_PAGE`로 거부합니다.

### Item 타입 정책

* `z.coerce` 없음. 숫자 문자열을 숫자로 바꾸지 않고 그 반대도 하지 않습니다.
* `dataType`은 리터럴 `'JSON'`입니다.
* **어떤 필드도 nullable로 모델링하지 않습니다** — forecast의 `fcstValue`나 current의
  `obsrValue`와 달리, 두 공식 item spec 중 어느 쪽도 nullable 값을 문서화하지 않으므로 근거 없는
  방어적 `.nullable()` 허용을 추가하지 않았습니다. (D+4 그룹의 부재는 `.optional()`이지 `null`이
  아닙니다 — 위 "D+4는 발표시각에 따라 달라지는 유일한 예외 필드" 절 참고.)
* 기온(`taMin{N}`/`taMax{N}`)은 유한한 `z.number()`이며 `.int()`나 범위 제약을 두지 않습니다 —
  공식 필드 타입이 정수성을 명시하지 않고 최소/최대도 문서화되지 않았으므로 추측하지 않습니다
  (`raw-schema.ts`가 `nx`/`ny`에 상한을 두지 않는 것과 같은 입장).
* 강수확률(`rnSt…`)도 같은 이유로 `[0, 100]` 범위를 강제하지 않습니다. 계약 수준 범위 검사는
  이후 normalization 계층의 몫입니다.
* 날씨예보 문구(`wf…`)는 **비어 있지 않은 문자열**로만 검증합니다 — enum이 아니고 정규화하지
  않으므로 미래의 새 문구도 raw boundary를 그대로 통과합니다.
* `items.item`은 **배열만** 허용합니다. 단일 bare object 직렬화는 관측·문서화된 바 없고 이 PR은
  실호출을 하지 않으므로 추측해서 허용하지 않습니다.

### 3-outcome parser

`parse-midterm-response.ts`는 operation별로 두 진입점
(`parseKmaMidtermTemperatureResponse` / `parseKmaMidtermLandResponse`)을 제공하며, 각각
**3-outcome**(success page / `UPSTREAM_ERROR` / `INVALID_RESPONSE`)입니다. alert parser의
4-outcome과 **다릅니다**:

alert의 전용 `NO_DATA` 분기는 Owner-authorized live 진단이 `getPwnCd`의 `03`이 body 없이
"조건에 맞는 데이터 없음"을 의미한다고 **확인했기 때문에만** 존재합니다.
`getMidTa`/`getMidLandFcst`에 대해서는 그에 상응하는 전용 no-data 코드를 공식 문서가 확립하지
않았고 이 PR에 실호출 승인도 없으므로, **`03`을 포함한 모든 non-success `resultCode`는 일반적인
sanitized upstream-error 경계**를 거칩니다. 임의의 코드를 no-data로 추측하지 않습니다.

`resultCode === '00'`이면서 `totalCount === 0`인 정상 성공은 유효한 빈 page이며 데이터를
날조하지 않습니다.

결정 순서:

1. `response.header`가 유효한 KMA envelope이 아님 → `INVALID_RESPONSE`. 구조적으로 잘못된
   `resultCode`(`''`, `'0'`, `'000'`, `'AB'`)는 여기서 실패하며 upstream error로 오인되지 않습니다.
2. 유효한 header + non-success `resultCode` → `UPSTREAM_ERROR`(공식 2자리 코드만 보존). body가
   전혀 없어도 성립합니다.
3. success `resultCode` → 해당 operation의 body 검증. success 코드인데 body가 없거나 malformed면
   조용한 빈 page가 아니라 `INVALID_RESPONSE`입니다.

## Provider 계약

`createKmaMidtermForecastProvider` / `createKmaMidtermForecastProviderFromEnv`
(`apps/api/src/providers/kma/provider.ts`).

```ts
interface KmaMidtermForecastProvider {
  fetchMidtermForecast(
    request: KmaMidtermForecastRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<KmaMidtermForecastProviderResult>;
}
```

operation-discriminated 단일 메서드를 선택한 이유는 `fetchForecast`와 같은 형태이기 때문입니다 —
`product` 필드가 내부 고정 path 표를 통해 한 서비스 패밀리의 두 operation을 고르는 구조를 그대로
따릅니다. 기존 provider 패턴과 일관된 최소 API입니다.

### 성공 결과

```ts
type KmaMidtermForecastProviderSuccess =
  | { operation: 'TEMPERATURE'; regId; tmFc; totalCount; temperatures: readonly KmaMidtermTemperatureRecord[] }
  | { operation: 'LAND'; regId; tmFc; totalCount; landForecasts: readonly KmaMidtermLandRecord[] };
```

* request identity(`operation`/`regId`/`tmFc`), `totalCount`, 검증된 record만 노출합니다.
* record를 단일 item이 아니라 배열로 노출하는 이유: 하나의 `regId`/`tmFc`는 단일 item을 반환할
  것으로 기대되지만, `totalCount === 0`인 정상 성공에서 item을 **날조하지 않아야** 하고, 이 raw
  boundary가 근거를 댈 수 없는 "정확히 1건" 규칙을 발명하지 않기 위해서입니다. 단일 item 선택은
  다음 계층의 몫입니다.
* **노출하지 않는 것**: service key, URL, raw body, raw `resultMsg`.
* `DailyForecast[]`를 만들지 않고, 한국어 KMA 날씨 문구를 `WeatherCondition`으로 매핑하지 않으며,
  `tmFc`로부터 날짜를 파생하지도 않습니다. 전부 다음 normalization/composition PR의 책임입니다.

### 오류 경계

`INVALID_REQUEST` / `TIMEOUT` / `ABORTED` / `NETWORK_ERROR` / `HTTP_ERROR`(status만) /
`RESPONSE_TOO_LARGE` / `EMPTY_RESPONSE` / `NON_JSON_RESPONSE` / `INVALID_JSON` /
`GATEWAY_ERROR`(reasonCode만) / `KMA_UPSTREAM_ERROR`(2자리 resultCode만) /
`KMA_INVALID_RESPONSE`(value-free issue path/message만) / `RESPONSE_MISMATCH` /
`INCOMPLETE_PAGE`.

어떤 variant도 service key, 요청 URL/query string, raw response body, raw upstream `resultMsg`/
`returnAuthMsg`, fetch 예외 message/stack을 담지 않습니다.

### Request/response correlation

* 고정 pagination(`pageNo`, `numOfRows`)을 먼저 확인하고, 그다음 응답이 echo하는 **`regId`**를
  확인합니다. mismatch는 `RESPONSE_MISMATCH`(field: `pageNo` | `numOfRows` | `regId`)입니다.
* `regId`는 **모든 item에 대해** 확인하므로 item 순서와 무관합니다. 빈 item 배열은 통과합니다.
* `tmFc`는 두 item shape 중 어느 쪽도 echo하지 않으므로 correlation을 주장하지 않습니다.
* `totalCount`가 실제 수신 item 수보다 크면 조용히 부분 page를 반환하지 않고 `INCOMPLETE_PAGE`로
  **사실대로 실패**합니다(이 provider는 auto-pagination을 하지 않습니다).

### 공유 transport와 config 재사용

* HTTP transport는 forecast/current/alert가 쓰는 것과 **동일한 private `performKmaGetRequest`**
  입니다 — timeout, caller abort(전송·body read 전 구간), `redirect: 'error'`, HTTP status 분류,
  body-size cap, network-error sanitization, body-read abort 처리, gateway XML 감지. transport
  로직을 복제하지 않았습니다.
* config는 **동일한** `KmaForecastProviderOptions` / `validateKmaProviderOptions`이며 동일한
  `KMA_SERVICE_KEY`를 사용합니다. 두 번째 key 환경변수, MidFcst 전용 secret, 새 timeout 정책, 새
  body-size 정책을 도입하지 않았습니다.
* 환경변수 읽기는 **호출 시점**에만 일어납니다. import/startup 시 `process.env` 접근도 fetch도
  없습니다.

## 이 PR의 범위 밖 (후속 작업)

* 위치/행정구역/위경도 → 육상 `regId` / 기온 `regId` 전국 매핑
* 최신 06/18 KST issuance selector와 발표 지연 fallback
* `DailyForecast[]` 정규화, 한국어 날씨 문구 → `WeatherCondition` 매핑
* 단기 daily(PR #96)와 중기 daily 병합
* `POST /weather` production wiring, source metadata 통합
* AirKorea, alerts, cache, 실호출 smoke, Vercel/env 변경

## 관련 파일

| 파일 | 역할 |
| --- | --- |
| `apps/api/src/providers/kma/midterm-request.ts` | request 타입·검증·고정 operation path 매핑·URL 생성 |
| `apps/api/src/providers/kma/midterm-raw-schema.ts` | operation별 raw JSON runtime schema |
| `apps/api/src/providers/kma/parse-midterm-response.ts` | operation별 3-outcome response 분류 |
| `apps/api/src/providers/kma/provider.ts` | mid-term provider (공유 transport/config 재사용) |
| `apps/api/src/providers/kma/validation.ts` | `isKmaMidtermRegId` / `isKmaMidtermIssuanceStamp` |
| `apps/api/src/providers/kma/index.ts` | 최소 public provider API export |
