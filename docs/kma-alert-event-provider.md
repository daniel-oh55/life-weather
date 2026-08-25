# KMA 기상특보 조회서비스 (Alert Event) Provider

이 문서는 기상청(KMA) **기상특보 조회서비스(`WthrWrnInfoService`) 특보코드조회(`getPwnCd`)** 의
provider boundary — request 검증·URL 생성, raw JSON runtime schema, 성공/확인된 no-data/upstream
error/invalid response 4-outcome 분류, 기존 KMA HTTP transport 정책을 재사용하는 provider — 를
기록합니다. 근거는 공식 활용가이드와 Owner-authorized live JSON 진단이며, 블로그·개인 저장소·비공식
정리 문서는 사용하지 않았습니다.

이 PR(#89)은 **provider boundary까지만** 구현합니다. 검증된 alert **lifecycle event record**를
반환할 뿐, `WeatherAlert[]`로 정규화하거나 활성 특보 상태로 접기(lifecycle folding)하지 않으며,
`POST /weather`·`apps/api/src/services`·`composition`·`routes`·`presenters`는 변경하지 않습니다.

## 공식 자료와 evidence

| 항목 | 값 |
| --- | --- |
| 공식 서비스명 | 기상청_기상특보 조회서비스 (`WthrWrnInfoService`) |
| 공식 활용가이드 파일명 | `기상청21_기상특보 조회서비스_오픈API활용가이드_260601` |
| 활용가이드 버전 | `260601` |
| 대상 operation | 특보코드조회 `getPwnCd` |
| endpoint (프로덕션) | `https://apis.data.go.kr/1360000/WthrWrnInfoService/getPwnCd` |

`getPwnCd`는 단기·초단기예보(`VilageFcstInfoService_2.0`)나 초단기실황(같은 서비스)과 **다른
서비스 패밀리**인 `WthrWrnInfoService`입니다. base URL을 공유하지 않으므로
[kma-http-provider.md](./kma-http-provider.md)/[kma-current-observation-provider.md](./kma-current-observation-provider.md)의
`KMA_BASE_URL`을 재사용하지 않고, 이 서비스 전용 `KMA_ALERT_BASE_URL`을 `alert-request.ts`에 새로
정의했습니다.

### Owner-authorized live JSON 진단 (2026-08-25)

기존 `기상청_기상특보 조회서비스`가 data.go.kr에서 새로 승인된 뒤, Owner가 승인한 예산(최대
`getPwnCd` 2회, retry 0)으로 읽기 전용 구조 진단을 1회 실행했습니다(진단 자체는 이 PR 이전에 완료된
별도 작업이며, 이 PR에서는 **추가 실호출을 하지 않았습니다** — 아래 "실제 인증 API 검증 상태"
참고). 기록하는 것은 구조적 evidence뿐이며, 실제 좌표·지역명·특보 값·raw response·service key는
기록하지 않습니다.

**Call #1 (필터 없음, 정상 결과, resultCode `00`):**

* HTTP 200, JSON parse 성공, `resultCode = '00'`, `response.body` 존재.
* `response.body.items` = OBJECT, `response.body.items.item` = ARRAY(항목 2개, `totalCount`와
  일치 — complete page).
* `totalCount`/`pageNo`/`numOfRows` 모두 JSON `NUMBER` 타입.
* item 별 관측된 JSON 타입(관측된 2건 모두에서 모든 필드가 present였고, 어떤 필드도 `NULL`
  변형이 관측되지 않음 — **단, 이 2건 evidence만으로 universal requiredness가 증명되지는
  않습니다**: 아래 "공식 가이드 vs live JSON evidence" 절 및 `command=2` 해제 예시가 `startTime`을
  생략하는 공식 문서 evidence 참고, present일 때의 JSON 타입만 이 표에서 확정합니다):

  | 필드 | 타입 |
  | --- | --- |
  | `stnId` | STRING |
  | `tmFc` | NUMBER |
  | `tmSeq` | NUMBER |
  | `areaCode` | STRING |
  | `areaName` | STRING |
  | `warnVar` | NUMBER |
  | `warnStress` | NUMBER |
  | `command` | STRING |
  | `startTime` | NUMBER |
  | `endTime` | NUMBER |
  | `allEndTime` | NUMBER |
  | `cancel` | STRING |

* **단일 positive 샘플은 2건이었습니다** — `items.item`이 ARRAY라는 것은 확인됐지만, 1건일 때
  단일 object로 직렬화되는지 여부는 **독립적으로 관측되지 않았습니다**. 이 provider는 그 가능성을
  추측해서 허용하지 않고(`alert-raw-schema.ts`가 `item`을 항상 ARRAY로만 요구), 이후 evidence가
  나오면 별도 correction으로 처리합니다.

**Call #2 (전략 A — 확인된 nationwide 데이터에 없는 공식 `warningType` 값으로 필터, `resultCode
'03'`):**

* HTTP 200, JSON parse 성공, `resultCode = '03'`, **`response.body` 자체가 없음**(pagination
  필드도, `items`도 없음).
* Call #1의 완전한(전량) nationwide 데이터셋에는 없는 것으로 확인된 공식 `warningType` 값으로
  필터링한 결과이므로, `03`이 실제로 "조건에 맞는 데이터 없음"을 의미하고 `warningType` 파라미터가
  실제로 필터링에 작동한다는 강한 evidence입니다.
* 결론: `warningType`(가이드 예시의 오탈자 `warninType`이 아님)이 documented spelling대로 동작함을
  확인했고, 가이드 예시의 `warninType`은 **문서 오탈자로 확인**됩니다.

이 evidence로부터 이 PR이 확정하는 것:

1. `getPwnCd`에서 `resultCode === '03'`은 이 operation에 한해 **유효한 zero-match 결과**이며,
   `response.body`가 전혀 없는 것이 confirmed shape입니다 — provider 실패가 아닙니다.
2. 요청 파라미터는 `warningType`을 사용하며 `warninType`은 절대 내보내지 않습니다.
3. positive 성공 페이지는 `items.item` **ARRAY**로만 모델링합니다(단일 object 미확인).
4. 위 표의 JSON 타입이 각 필드가 present일 때의 raw schema 타입이며, 어떤 필드도 nullable로
   모델링하지 않습니다(관측된 `NULL` 변형 없음 — forecast의 `fcstValue`/current의 `obsrValue`와
   다른 점). 이 2건 evidence는 타입만 확정하며, 어떤 필드가 항상 present여야 하는지는 별도로
   공식 가이드의 request/response 표를 근거로 판단합니다 — `stnId`/`tmFc`/`areaCode`/`areaName`/
   `allEndTime`은 required, `tmSeq`/`warnVar`/`warnStress`/`command`/`startTime`/`endTime`/
   `cancel`은 공식 가이드가 optional/조건부로 문서화하므로 absence를 허용합니다(자세한 내용은
   "Raw schema와 response parser 계약"의 "공식 가이드 vs live JSON evidence" 절 참고).

## Request 계약

`KmaAlertEventRequest`(`apps/api/src/providers/kma/alert-request.ts`)는 다섯 필드를 가지며,
**전부 optional 필터**입니다.

```ts
interface KmaAlertEventRequest {
  readonly fromTmFc?: string; // YYYYMMDD, optional — 생략 시 문서화된 upstream 기본값
  readonly toTmFc?: string; // YYYYMMDD, optional — 생략 시 문서화된 upstream 기본값
  readonly areaCode?: string; // 공식 가이드 max size 10
  readonly warningType?: KmaAlertWarningType; // 1 | 2 | ... | 13 (문서화된 값만)
  readonly stnId?: string; // 공식 가이드 max size 5
}
```

* `validateKmaAlertEventRequest(input: unknown)`은 non-object 입력에서도 total하며 throw하지
  않습니다 — forecast/current request validator와 동일한 totality 정책. 고정 필드 순서는
  `fromTmFc → toTmFc → areaCode → warningType → stnId`입니다.
* `fromTmFc`/`toTmFc`는 공식 260601 가이드 request 표에 `항목구분 = 0`(optional)으로 문서화되어
  있고, 생략 시 각각 "현재 날짜 00:00"/"현재 날짜 23:59"가 문서화된 upstream 기본값입니다. 이
  모듈은 그 기본값을 **절대 합성하지 않습니다** — `fromTmFc`/`toTmFc`가 `undefined`이면 유효한
  요청이며 쿼리에서 해당 파라미터가 완전히 생략되어 upstream이 자신의 문서화된 기본값을 적용하도록
  둡니다. present일 때는 `validation.ts`의 `isCalendarDate`를 forecast/current와 그대로
  공유합니다(coercion 없음). 두 날짜 사이의 순서 제약(`fromTmFc <= toTmFc`)은 공식 evidence가
  없으므로 강제하지 않습니다. 명시적 `null`은 `undefined`(생략)와 다르게 취급되어 거부됩니다.
* `areaCode`는 present일 때 non-empty string이며 공식 가이드가 문서화한 max size **10**을
  초과할 수 없습니다. `stnId`는 present일 때 non-empty string이며 공식 가이드가 문서화한 max
  size **5**를 초과할 수 없습니다 — 그 외 문자 클래스 spec은 확인하지 못했으므로 추가
  정규식/enum은 강제하지 않습니다(`category`의 `[A-Z0-9]+`처럼 근거가 있는 경우와 다름).
* `warningType`은 present일 때 공식 260601 가이드가 문서화한 값만 허용합니다:
  `KMA_ALERT_WARNING_TYPES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13]`. 숫자 문자열 coercion은 없습니다.
* 모든 optional 필드는 `undefined`(생략)만 허용하며, 명시적 `null`은 `undefined`와 다르게
  취급되어 거부됩니다.
* URL operation은 caller 입력이 아니라 고정 `KMA_ALERT_OPERATION = 'getPwnCd'`이고, base URL도
  이 서비스 전용 `KMA_ALERT_BASE_URL = 'https://apis.data.go.kr/1360000/WthrWrnInfoService'`입니다
  — forecast/current의 `VilageFcstInfoService_2.0`과 공유하지 않습니다.
* 고정 pagination(`pageNo=1`/`numOfRows=1000`/`dataType=JSON`)은 이 모듈이 독자적으로 정의합니다
  (다른 서비스 패밀리이므로 `request.ts`의 상수를 재사용하지 않음 — 값은 우연히 같지만 별도
  service의 별도 계약입니다).
* **service key 파라미터 이름은 `serviceKey`(소문자)이며, forecast/current의 `ServiceKey`(대문자
  S)와 다릅니다** — 이는 Owner-authorized live 진단으로 직접 확인된 값이며, 가이드 문서만으로
  추정한 것이 아닙니다. `ServiceKey`(대문자)가 이 operation에서 동작하는지는 테스트하지
  않았습니다(확인된 것만 사용).
* `URLSearchParams`로 정확히 한 번 encode됩니다. 파라미터는 고정 순서
  `serviceKey → pageNo → numOfRows → dataType → fromTmFc → toTmFc → areaCode → warningType →
  stnId`로 추가되되, `fromTmFc`/`toTmFc`를 포함한 모든 optional 필드는 **present일 때만** 그
  고정 위치에 추가됩니다 — absent 필드(생략된 날짜 포함)는 빈 문자열로 보내지 않고 쿼리에서
  완전히 생략됩니다. URL·query·service key·invalid raw value는 오류에 절대 포함하지 않습니다.

## Raw schema와 response parser 계약

`alert-raw-schema.ts`는 Zod 4 schema로 확인된 positive item shape을 모델링합니다.

```json
{
  "response": {
    "header": { "resultCode": "00", "resultMsg": "NORMAL_SERVICE" },
    "body": {
      "dataType": "JSON",
      "items": {
        "item": [
          {
            "stnId": "108",
            "tmFc": 202608251400,
            "tmSeq": 1,
            "areaCode": "L1010100",
            "areaName": "서울",
            "warnVar": 3,
            "warnStress": 2,
            "command": "발표",
            "startTime": 202608251400,
            "endTime": 202608261400,
            "allEndTime": 202608261400,
            "cancel": "0"
          }
        ]
      },
      "pageNo": 1,
      "numOfRows": 1000,
      "totalCount": 1
    }
  }
}
```

(위 JSON은 필드 shape 설명을 위한 synthetic 예시이며, 실제 live 응답 값이 아닙니다. 이 예시는
observed 2건 positive 샘플이 모든 필드를 포함했던 것을 보여줄 뿐이며, 아래 optionality 정책이
설명하듯 `tmSeq`/`warnVar`/`warnStress`/`command`/`startTime`/`endTime`/`cancel`이 **항상**
present임을 의미하지 않습니다 — 예를 들어 발표(command=1) 이벤트는 `endTime` 없이, 해제
(command=2) 이벤트는 `startTime` 없이 올 수 있습니다.)

### 공식 가이드 vs live JSON evidence

두 근거는 서로 다른 것을 확정하며, 이 provider는 둘을 함께 사용합니다.

**공식 260601 가이드 (optionality의 근거):**

* Request: `fromTmFc`/`toTmFc`는 `항목구분 = 0`(optional, 문서화된 기본값 존재).
  `areaCode`(max size 10)/`stnId`(max size 5)도 `항목구분 = 0`.
* Response: `tmSeq`/`warnVar`/`warnStress`/`command`/`cancel`은 `항목구분 = 0`(optional).
  `startTime`은 조건부(발표발효시각, **특보발표시에만 제공**), `endTime`은 조건부(해제발효시각,
  **특보해제시에만 제공**) — 가이드의 `command=2`(해제) 예시 자체가 `startTime`을 생략합니다.
  `stnId`/`tmFc`/`areaCode`/`areaName`/`allEndTime`은 required로 남습니다.

**Live JSON evidence (observed positive 2건, strict type의 근거 — optionality의 근거 아님):**

* 관측된 두 positive row는 이 문서 상단 표의 JSON 타입(NUMBER/STRING)으로 각 필드값을
  직렬화했습니다. 어떤 필드도 `NULL`로 관측되지 않았습니다.
* 이 evidence는 **field가 present일 때의 타입**만 확정하며, universal requiredness나
  `NULL`/empty-string 같은 다른 직렬화 변형의 존재/부재를 확정하지 않습니다 — 두 row 모두 우연히
  모든 필드를 가진 것일 수 있습니다.

**구현 정책 (두 근거의 결합):**

* 공식 가이드가 optional/conditional로 문서화한 필드는 **absence**를 허용합니다.
* present일 때는 live evidence가 확인한 strict JSON 타입만 허용합니다.
* `null`/empty-string 같은 미확인 대안 직렬화는 추가하지 않습니다(evidence 없음).
* `allEndTime`은 required NUMBER로 유지됩니다.
* 단일-item `items.item`의 object 직렬화는 여전히 독립적으로 관측되지 않았습니다.

* `z.coerce`를 쓰지 않습니다. `tmFc`/`allEndTime`은 required `NUMBER`이므로 `z.number().int()`로,
  `stnId`/`areaCode`/`areaName`은 required `STRING`이므로 non-empty `z.string()`으로 모델링합니다.
  `tmSeq`/`warnVar`/`warnStress`/`startTime`/`endTime`은 optional `NUMBER`(`z.number().int()
  .optional()`), `command`/`cancel`은 optional `STRING`(non-empty `z.string().optional()`)으로
  모델링합니다 — present일 때는 여전히 strict type이 강제되고, `null`이나 빈 문자열/coercion은
  허용되지 않습니다. **어떤 필드도 nullable이 아닙니다** — live 진단의 field-type matrix가 모든
  관측 item에서 단일하고 일관된 타입만 보였고 `NULL` 변형이 없었기 때문에, forecast의
  `fcstValue`/current의 `obsrValue`가 받는 방어적 `.nullable()` 허용을 이 필드들에는 추가하지
  않았습니다. optionality(`.optional()`)와 nullable은 별개 축입니다 — absence는 공식 가이드
  근거로 허용하되, 값이 present인데 `null`인 경우는 여전히 거부합니다.
* `response.header`와 성공 코드(`KMA_SUCCESS_RESULT_CODE`)는 `raw-schema.ts`의
  `kmaResponseHeaderSchema`/`kmaResponseEnvelopeSchema`를 **그대로** import해 재사용합니다 —
  header 판정은 세 KMA 경계(forecast/current/alert) 모두 항상 일치합니다.
* `items.item`은 forecast/current와 동일하게 **배열만** 허용합니다 — 단일 object는 거부됩니다
  (확인된 positive 샘플이 2건이라 단일-object 직렬화가 미확인이므로 추측 확장하지 않음). pagination
  self-contradiction 검증(`item.length > numOfRows`, `item.length > totalCount`, `totalCount ===
  0`인데 item 존재)은 forecast/current body schema와 동일한 강도로 적용합니다. `totalCount > 0` +
  빈 `item` 배열은 forecast/current와 동일하게 방어적으로 허용합니다(정상 페이지네이션).

### 4-outcome parser (forecast/current의 3-outcome과 다른 점)

`parseKmaAlertEventResponse(input: unknown)`(`parse-alert-response.ts`)는 forecast의
`parseKmaForecastResponse`/current의 `parseKmaCurrentObservationResponse`와 달리 **의도적으로**
`{ ok: boolean }` 2-way가 아닌 **flat 4-way discriminated union**(`kind: 'SUCCESS_PAGE' |
'NO_DATA' | 'UPSTREAM_ERROR' | 'INVALID_RESPONSE'`)을 반환합니다.

forecast/current 두 경계는 `resultCode !== '00'`인 모든 코드(`03` 포함)를 일괄
`UPSTREAM_ERROR`로 분류합니다 — 그 두 operation에 대해서는 `03`이 실제로 "데이터 없음
오류"라는 것 외에 다른 근거가 없기 때문입니다. 하지만 `getPwnCd`에 대해서는 위 Owner-authorized
live 진단이 `03` + body 없음이 **유효한 zero-match 결과**임을 직접 확인했으므로, 이 provider만
그 evidence를 반영해 `03`을 `NO_DATA`라는 별도 peer outcome으로 분리합니다.

판정 순서:

1. `response.header`가 유효한 KMA envelope이 아니면 → `INVALID_RESPONSE`.
2. `resultCode === '00'`이면 → 전체 성공 body를 검증(`kmaAlertEventSuccessResponseSchema`).
   실패하면 `INVALID_RESPONSE`(silent empty page 없음).
3. `resultCode === '03'`이면 → 확인된 no-body shape(`kmaAlertNoDataResponseSchema`, `response`에
   `.strict()`를 적용해 예기치 않은 `body` 키를 거부)과 일치해야 `NO_DATA`. **`03`인데 예기치
   않게 body를 포함하면** — 확인된 shape과 모순되므로 — 보수적으로 `INVALID_RESPONSE`로
   처리하고, `NO_DATA`나 성공 페이지로 조용히 받아들이지 않습니다. `totalCount`/`pageNo`/
  `numOfRows`/`body`/`items` 중 upstream이 생략한 값은 이 raw parser 단계에서 절대
   만들어내지 않습니다.
4. 그 외 모든 non-`00` 코드 → `UPSTREAM_ERROR`(2자리 `resultCode`만 보존, raw `resultMsg` 비노출
   — forecast/current와 동일한 보안 정책).

`NO_DATA`를 성공적인 빈 결과(`totalCount: 0`, `events: []`)로 바꾸는 것은 **provider 계층**
(`provider.ts`)의 책임입니다 — provider는 항상 고정 요청(`numOfRows=1000`)을 보낸다는 자신의
known context로 이 값을 합성하며, raw parser가 upstream이 주지 않은 값을 만들어내지 않는다는
규칙과 충돌하지 않습니다.

## Provider 계약

`createKmaAlertEventProvider`/`createKmaAlertEventProviderFromEnv`(`provider.ts`)는
forecast/current-observation provider와 **동일한** `KmaForecastProviderOptions`
(`serviceKey`/`fetchImpl`/`timeoutMs`/`maxResponseBytes`)와 `validateKmaProviderOptions`를
재사용합니다 — 세 provider가 같은 `KMA_SERVICE_KEY`와 같은 방어적 timeout/response-size 기본값을
쓰기 때문입니다. transport(timeout/caller-abort/HTTP-status/size-limited body read/redirect
거부)는 forecast/current와 완전히 같은 private helper `performKmaGetRequest()`를 그대로
재사용합니다 — 새 transport를 만들지 않았습니다.

`fetchAlertEvents(request, options)`의 흐름:

1. `validateKmaAlertEventRequest` → 실패 시 `fetch` 호출 없이 `INVALID_REQUEST`.
2. `buildKmaAlertEventRequestUrl` → `performKmaGetRequest`(공유 transport) → raw body text.
3. `classifyAlertBody`: 빈 응답 → gateway XML → 기타 XML/HTML(non-JSON) → `JSON.parse` →
   `parseKmaAlertEventResponse` → 결과별 분기:
   * `INVALID_RESPONSE` → `KMA_INVALID_RESPONSE`(sanitized issues).
   * `UPSTREAM_ERROR` → `KMA_UPSTREAM_ERROR`(resultCode만).
   * `NO_DATA` → **성공** 결과, `totalCount: 0`, `events: []`.
   * `SUCCESS_PAGE` → pagination correlation(`pageNo`/`numOfRows`만 — 이 응답 shape은 다른 요청
     필드를 echo하지 않으므로 `RESPONSE_MISMATCH`는 이 두 필드에만 적용됩니다) → `INCOMPLETE_PAGE`
     거부(`totalCount > items.length`, 자동 재페이지네이션 없음) → 성공.

성공 결과(`KmaAlertEventProviderSuccess`)는 요청 identity(`fromTmFc`/`toTmFc`를 포함한 모든
optional 필터 — 생략된 필드는 `null`로)와 `totalCount`, 검증된 `events`(field validated 그대로,
어떤 grouping도 하지 않음 — category grouping 개념 자체가 이 operation에는 없습니다)를 담습니다.
`fromTmFc`/`toTmFc`도 이제 optional이므로 `KmaAlertEventProviderSuccess.fromTmFc`/`toTmFc`의
타입은 `string | null`입니다 — `toAlertEventSuccess`는 `request.fromTmFc ?? null`/
`request.toTmFc ?? null`을 사용하며, 생략된 날짜를 현재 날짜 등으로 **합성하지 않습니다**. 이는
호출자가 upstream의 문서화된 기본값에 의존했다는 사실을 그대로 보존합니다. 이 provider에는
forecast/current의 `DUPLICATE_CATEGORY` 오류가 없습니다 — event record는 응답 순서 그대로
1:1로 반환되며 dedupe/합치기를 하지 않습니다.

## 왜 WeatherAlert가 아닌가

`getPwnCd`는 발표/해제/연장/정정/변경 등 **특보 lifecycle 이벤트**를 반환하며, "현재 유효한 특보
목록"의 snapshot이 아닙니다. `command`/`cancel`과 시간 필드(`startTime`/`endTime`/`allEndTime`)를
어떻게 조합해야 "지금 활성 상태인 특보"를 판정할 수 있는지는 이 evidence만으로 확정할 수 없습니다
— 그래서 이 PR은 검증된 raw event record를 provider 경계에 그대로 노출하고, `WeatherAlert`
ID/타입/심각도 매핑, 활성-특보 folding, 위치 적용성, `effectiveAt`/`expiresAt` 해석은 모두 후속
PR로 미룹니다.

## 오류·보안 요구사항

다음은 어떤 오류·테스트 출력·이 문서에도 포함하지 않습니다.

* serviceKey, 요청 URL 또는 query string
* raw response body, raw `resultMsg`
* 실제 areaName/areaCode/stnId/tmFc/tmSeq/warnVar/warnStress/command/시간 값
* 실제 운영 좌표·환경 값
* stack trace 또는 내부 exception text

오류는 고정된 discriminated union으로 유지됩니다: request validation(`INVALID_REQUEST`,
value-free field issues), transport/HTTP/timeout/abort/body-size/gateway/JSON error
(forecast/current와 동일한 kind 집합 공유), upstream KMA error(`KMA_UPSTREAM_ERROR`, 2자리
`resultCode`만), invalid response(`KMA_INVALID_RESPONSE`, sanitized issues만),
response/request mismatch(`RESPONSE_MISMATCH`, `pageNo`/`numOfRows` 필드 이름만),
incomplete page(`INCOMPLETE_PAGE`, count만).

## 구현된 범위와 후속 PR 범위

**이 PR(#89)에서 구현 완료:**

* alert-event request runtime validation과 deterministic URL builder(`alert-request.ts`)
* alert-event raw JSON runtime schema(`alert-raw-schema.ts`)
* 4-outcome(성공/확인된 no-data/upstream error/invalid response) response parser
  (`parse-alert-response.ts`)
* 기존 transport 정책을 재사용하는 alert-event HTTP provider
  (`createKmaAlertEventProvider`/`…FromEnv`, `provider.ts`)
* 이 문서와 unit test

**후속 PR 범위(이 PR에서 구현하지 않음):**

* alert event를 `WeatherAlert[]`로 정규화, 활성-특보 lifecycle folding, 위치 적용성
* `POST /weather`에 연결(composition, route), `SourceMetadata`
* 실제 KMA endpoint 재호출(이 PR 자체는 추가 실호출을 수행하지 않았습니다)
* 단일-object `items.item` 직렬화 재검증(발생 시)
* cache/retry/fallback 정책

## 실제 인증 API 검증 상태

* 이 PR(#89)의 구현/테스트/문서 작성 과정에서는 **실제 `KMA_SERVICE_KEY`를 사용한 추가 호출을
  전혀 수행하지 않았습니다** — 이 문서의 evidence는 이 PR 이전에 별도로 완료된 Owner-authorized
  진단(2026-08-25, 예산 `getPwnCd` 최대 2회, retry 0)의 결과입니다.
* 자동 테스트는 실제 네트워크를 호출하지 않고, 주입된 fake `fetch`와 in-memory `Response`,
  synthetic fixture만 사용합니다. 테스트 fixture의 `stnId`/`areaCode`/`areaName`/시간 값은 모두
  synthetic이며 실제 관측값이 아닙니다.
* `items.item`의 단일-object 직렬화, `fromTmFc`/`toTmFc`의 실제 최대 span 제약, `areaCode`/
  `stnId`의 실제 문자 클래스, `warnVar`/`command`/`cancel`의 실제 값 집합과 의미는 이 evidence만으로
  확정되지 않았으며, 후속 live 검증에서 재확인할 항목으로 남습니다.
