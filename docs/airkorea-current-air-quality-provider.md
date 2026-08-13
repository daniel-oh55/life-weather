# AirKorea 측정소별 실시간 측정정보 (Current Air Quality) Provider

이 문서는 에어코리아(AirKorea) **측정소별 실시간 측정정보 조회
(`getMsrstnAcctoRltmMesureDnsty`)** 의 provider boundary — request 검증·URL 생성, raw JSON
runtime schema, 성공/upstream error/invalid response 분류, "최신 측정값" 선택 정책, 그리고
공유 contract `CurrentAirQuality`로의 정규화 — 를 기록합니다. 근거는 아래 공식 자료이며,
블로그·개인 저장소·비공식 정리 문서는 최종 request/response shape의 근거로 사용하지
않았습니다.

이 PR(#82)은 **provider boundary까지만** 구현합니다. 위경도 → 측정소 변환, station resolver,
application service/composition, `POST /weather` 연결, AirKorea 예보(forecast)는 이 PR
범위가 아닙니다.

## Owner-observed live JSON evidence (2026-08-13, PR #87)

PR #82 시점에는 공식 기술문서(XML 예제만 제공)만 근거였고, JSON 직렬화의 세부 사항은 여러 항목이
미검증 gap으로 남아 있었습니다(§ "실제 인증 API 검증 상태" 참고). 2026-08-13, Owner가 인증된
Public Data Portal preview 호출 3건을 직접 실행했고, 그중 하나가 이 operation
(`getMsrstnAcctoRltmMesureDnsty`)의 성공 응답이었습니다. 이 호출에서 다음 두 가지가 실측
확인되었습니다 — PR #82/#83/#84 당시에는 알려지지 않았던 사실이며, 아래에서 이 문서의 나머지
내용과 명확히 구분합니다.

* **`response.body.items`는 `{ item: [...] }` wrapper가 아니라 direct array입니다.** 이전
  구현은 문서에 명시되지 않은 상태에서 KMA provider의 관행을 따라 wrapper 형태를 가정했으나,
  실측 결과 direct array임이 확인되어 PR #87에서 raw schema를 수정했습니다.
* **`dataTime`에 자정을 `24:00`으로 표기하는 행이 실제로 존재합니다** (실측 예: `dataTime:
  "2026-08-12 24:00"`). 이전 문서(§ "측정 시각(dataTime) 정규화")는 이 표기가 확인되지 않은
  gap이라고 기록했으나, 이제 확인되었으므로 PR #87에서 `24:00`을 다음 날 `00:00`으로 정규화하는
  rollover를 구현했습니다. `24:01`/`24:59`/`25:00` 등 다른 값은 여전히 malformed로 거부됩니다.

이 두 사실은 **positive(성공) 응답에서만** 확인되었습니다 — 0건 결과(zero-result)의 실제 JSON
직렬화 형태는 이 preview 호출로 검증되지 않았습니다(§ "Zero-result" 참고). PM2.5/등급 sentinel의
JSON 직렬화 등 그 외 미검증 gap은 이 preview로 해소되지 않았으므로 § "실제 인증 API 검증 상태"에
계속 미검증으로 남습니다.

## 공식 자료

| 항목 | 값 |
| --- | --- |
| 공식 데이터셋명 | 한국환경공단_에어코리아_대기오염정보 |
| 공공데이터포털 dataset ID | `15073861` |
| 포털 메타데이터 수정일 | 2026-06-30 |
| 참고 문서 파일명 | `한국환경공단 에어코리아 OpenAPI 기술문서_20260630.zip` |
| 실제 사용 기술문서 | `한국환경공단_에어코리아_대기오염정보_기술문서_v1.4.docx` (개정이력: 1.4, 2026-07-01) |
| API명(영문) | `ArpltnInforInqireSvc` (대기오염정보 조회 서비스) |
| 대상 operation | 측정소별 실시간 측정정보 조회 `getMsrstnAcctoRltmMesureDnsty` |
| 공식 Call Back URL (문서 표기) | `http://apis.data.go.kr/B552584/ArpltnInforInqireSvc/getMsrstnAcctoRltmMesureDnsty` |
| 프로젝트 실사용 endpoint | `https://apis.data.go.kr/B552584/ArpltnInforInqireSvc/getMsrstnAcctoRltmMesureDnsty` (HTTPS — 기존 KMA provider와 동일한 이유로 평문 HTTP 대신 HTTPS 사용) |

문서는 공식 데이터셋 상세 페이지(`https://www.data.go.kr/data/15073861/openapi.do`)의
"참고문서" 다운로드 버튼(`atchFileId=FILE_000000003666340`, `fileDetailSn=1`,
`/cmm/cmm/fileDownload.do` 엔드포인트)을 통해 직접 내려받아 그 안의 `.docx`를 읽기 전용으로
추출·검토했습니다. **실제 인증 서비스키를 사용한 API 호출은 수행하지 않았습니다.**

## API 서비스 개요 (문서 발췌)

* 서비스 인증: `ServiceKey` (공공데이터포털 일반 인증키)
* 인터페이스: REST (GET), 교환 데이터: XML/JSON 모두 지원
  (`&returnType=json` 파라미터 추가 시 JSON 응답)
* 서비스 시작일/배포일: 2020-11-26 (GATEWAY 방식)
* 평균 응답 시간: 500ms, 초당 최대 트랜잭션: 50tps

## Request 계약

`AirKoreaCurrentAirQualityRequest`(`apps/api/src/providers/airkorea/current-request.ts`)는
필드 하나만 가집니다.

```ts
interface AirKoreaCurrentAirQualityRequest {
  readonly stationName: string; // 측정소명, 예: "종로구"
}
```

### 공식 요청 파라미터 (문서 발췌, 측정소별 실시간 측정정보 조회)

| 파라미터 | 항목구분 | 샘플 | 설명 |
| --- | --- | --- | --- |
| `serviceKey` | 필수 | - | 인증키(URL Encode) |
| `returnType` | 옵션 | `xml` | `xml` 또는 `json` |
| `numOfRows` | 옵션 | `100` | 한 페이지 결과 수 |
| `pageNo` | 옵션 | `1` | 페이지 번호 |
| `stationName` | **필수** | `종로구` | 측정소 이름 (항목크기 30) |
| `dataTerm` | **필수** | `DAILY` | 요청 데이터기간(1일: `DAILY`, 1개월: `MONTH`, 3개월: `3MONTH`) |
| `ver` | 옵션 | `1.0` | 오퍼레이션 버전 |

문서상 공식 필수(항목구분: 1) 요청 파라미터는 `serviceKey`, `stationName`, `dataTerm`
셋입니다. 이 중 caller가 요청마다 달리 지정해야 하는 값은 `stationName`뿐이므로, 이 PR의
요청 타입은 그 필드 하나만 caller에게 노출합니다. `dataTerm`은 공식 필수 파라미터이지만,
이 provider 자신이 고정값 `DAILY`를 항상 전송하는 **project-owned fixed request policy**로
소유합니다 — caller는 이 값을 설정하거나 생략할 수 없습니다. `returnType`/`numOfRows`/
`pageNo`/`ver` 역시 같은 정책으로 이 provider가 항상 고정 값으로 전송합니다
(`current-request.ts`의 `AIRKOREA_FIXED_*` 상수).

* `returnType=json` — 문서의 "JSON 방식 호출 방법" 안내(`&returnType=json` 추가) 그대로 사용.
* `pageNo=1`, `numOfRows=100` — `numOfRows`는 `dataTerm=DAILY`가 만드는 한 측정소의 하루치
  시간별 행(최대 약 24개)을 한 페이지에 담기에 충분한 값으로, 문서 예제 샘플값(100)과 동일하게
  고정했습니다.
* `dataTerm=DAILY` — 공식 최소 기간. "최신 측정값" 선택(아래 참고)이 고려해야 하는 행 수를
  최소화하기 위한 project-owned 정책입니다.

### `ver` 결정 (evidence gate 필수 확인 항목)

문서의 "버전(ver) 항목설명"을 그대로 옮기면:

> - 버전을 포함하지 않고 호출할 경우 : PM2.5 데이터가 포함되지 않은 원래 오퍼레이션 결과 표출.
> - 버전 1.0을 호출할 경우 : PM2.5 데이터가 포함된 결과 표출.
> - 버전 1.1을 호출할 경우 : PM10, PM2.5 24시간 예측이동 평균데이터가 포함된 결과 표출.
> - 버전 1.2을 호출할 경우 : 측정망 정보 데이터가 포함된 결과 표출.
> - 버전 1.3을 호출할 경우 : PM10, PM2.5 1시간 등급 자료가 포함된 결과 표출
> - 버전 1.4을 호출할 경우 : 측정소명, 측정소 코드 정보가 포함된 결과 표출
> - 버전 1.5을 호출할 경우 : 측정값 소수점 아래 자리 수 확대 (CO : 1 → 2, O3/SO2/NO2 : 3 → 4)

Fast-track 1.0 최소 요구사항은 PM10과 PM2.5입니다(`docs/product-scope.md`). PM2.5는 `ver`
없이는 **전혀 포함되지 않으므로**, 이 provider는 `ver`를 반드시 보냅니다. 문서의 각 버전 설명이
이전 버전 결과에 **누적**되는 방식으로 서술되어 있으므로(예: 1.4는 "측정소명, 측정소 코드
정보가 **포함된** 결과" — 이전 버전에서 빠졌던 정보가 추가된다는 의미이지 다른 필드가
빠진다는 의미가 아님), 이 provider가 정규화하는 모든 필드(PM10/PM2.5/O3/CAI와 그 등급,
`stationName`)를 문서상 보장하는 **가장 높은 버전인 `1.5`** 를 고정 사용합니다
(`current-request.ts`의 `AIRKOREA_FIXED_VERSION`, module-private, non-configurable).
`ver=1.0`/`1.3`/`1.4` 같은 과거 버전을 특별한 근거 없이 그대로 베끼지 않았습니다 — 이 결정은
위 표에 근거합니다.

`ver=1.5`를 고정 사용하므로, 응답에는 `stationName`(ver 1.4)도 항상 포함된다고 간주하고
raw schema에서 필수 필드로 다룹니다(아래 "Raw response 계약" 참고).

### stationName 검증

문서 항목크기(30)를 기준으로 `isAirKoreaStationName`이 다음을 강제합니다.

* 비어 있지 않은 문자열
* 앞뒤 공백 없음(trim 후 동일해야 함 — 자동 trim 없음)
* 최대 30 UTF-16 code unit
* C0 제어문자·DEL(U+0000–U+001F, U+007F) 금지

URL은 `URL` + `URLSearchParams`로만 구성하며, 서비스키와 `stationName`(한글 포함) 모두
`URLSearchParams`가 정확히 한 번 percent-encode합니다. 파라미터 순서는 `serviceKey`,
`returnType`, `pageNo`, `numOfRows`, `stationName`, `dataTerm`, `ver`로 고정됩니다.

## Raw response 계약

`response.body.items`는 **direct array**입니다(`{ item: [...] }` wrapper 아님) — 2026-08-13
Owner-observed live JSON evidence로 확인됨(§ "Owner-observed live JSON evidence" 참고). 문서의
응답 필드 표(측정소별 실시간 측정정보 조회) 전체를 옮기면 다음과 같습니다.

| 필드 | 항목구분 | 설명 |
| --- | --- | --- |
| `resultCode` | 필수 | 결과코드 (2자리, 성공은 `00`) |
| `resultMsg` | 필수 | 결과메세지 (미노출 정책 — 아래 참고) |
| `numOfRows` / `pageNo` / `totalCount` | 필수 | 페이지 메타데이터 |
| `dataTime` | 필수 | `YYYY-MM-DD HH:mm` (예: `2020-11-25 13:00`) |
| `stationName` / `stationCode` / `mangName` | 필수(ver 1.2/1.4 이상) | 이 provider는 `stationName`만 사용, 나머지는 raw schema에서 unknown-key strip |
| `so2Value`/`coValue`/`o3Value`/`no2Value`/`pm10Value` | 필수 | 각 오염물질 농도 |
| `pm10Value24`/`pm25Value24` | 옵션 | 24시간 예측이동농도 (이 provider는 미사용) |
| `pm25Value` | **옵션** | PM2.5 농도 |
| `khaiValue` | 필수 | 통합대기환경수치(CAI) |
| `khaiGrade`/`so2Grade`/`coGrade`/`o3Grade`/`no2Grade`/`pm10Grade` | 필수 | 등급(1~4) |
| `pm25Grade` | **옵션** | PM2.5 등급 |
| `pm10Grade1h`/`pm25Grade1h` | 옵션 | 1시간 등급 (이 provider는 미사용 — 아래 "1시간 등급 대신 24시간 등급을 쓴 이유" 참고) |
| `*Flag` (6종) | 필수 | 측정자료 상태정보 (이 provider는 미사용) |

이 provider가 실제로 소비하는 필드만 `airKoreaCurrentAirQualityItemSchema`
(`current-raw-schema.ts`)에 선언하며, 문서의 필수/옵션 구분을 그대로 반영합니다:

* **필수 문자열** (항목구분: 1 — 키 자체가 없으면 malformed 응답으로 거부): `dataTime`,
  `stationName`, `pm10Value`, `o3Value`, `khaiValue`, `khaiGrade`, `pm10Grade`, `o3Grade`.
* **옵션 문자열** (항목구분: 0 — 키 자체가 없어도 정상): `pm25Value`, `pm25Grade`.

문서상 필수인 나머지 필드(`so2Value`/`coValue`/`no2Value`/`so2Grade`/`coGrade`/`no2Grade`
등)는 이 provider가 전혀 소비하지 않으므로 raw schema에 선언하지 않고, Zod의 기본
unknown-key strip으로 다른 미사용 필드(`mangName`/`stationCode`/`*Value24`/`*Grade1h`/
`*Flag`)와 함께 제거됩니다.

**필수와 옵션의 실질적 차이는 "키의 부재"를 다루는 방식에만 있습니다** — 필수 필드는 키가
없으면 raw schema 단계에서 즉시 거부되고, 옵션 필드는 키가 없어도 통과합니다. 두 경우 모두
**키가 존재하되 문서화된 sentinel 값을 담고 있는 경우**는 이 raw schema 수준에서는 동일하게
유효한 문자열로 취급됩니다 — presence(키의 존재)와 value(값)는 서로 다른 개념이며, sentinel
값을 "결측치 없음(null)"으로 해석하는 것은 `normalize-current.ts`의 몫이지 이 raw
boundary의 몫이 아닙니다(아래 "결측치(sentinel) 표현" 참고).

**AirKorea 고유 raw 타입/스키마는 공개 계약으로 export되지 않습니다** — `CurrentAirQuality`만
export됩니다.

`response.body`에는 KMA와 달리 `dataType` 필드가 **없습니다**(문서 응답 표에 해당 필드가
없음) — KMA raw schema를 그대로 베끼지 않고 이 차이를 그대로 반영했습니다.

### 결측치(sentinel) 표현

문서의 요청/응답 예제(`d) 요청/응답 메시지 예제`)에서 다음을 직접 확인했습니다.

```xml
<khaiValue>-</khaiValue>       <!-- 측정값 결측: 리터럴 대시 -->
<so2Grade/>                     <!-- 등급 결측: self-closing (빈 문자열) -->
```

이 provider는 이 두 sentinel을 각각 다음과 같이 취급합니다.

* **측정값**(`pm10Value`/`pm25Value`/`o3Value`/`khaiValue`): 리터럴 `"-"` → `null`.
  `khaiValue`에서 직접 확인된 sentinel을 같은 오퍼레이션·같은 응답의 동일 "측정값" 필드군
  (PM10/PM2.5/O3)에도 동일하게 적용한 것으로, 제3자 자료가 아니라 **같은 공식 문서, 같은
  필드군**에 대한 최소한의 확장 해석입니다. 인증된 실응답으로 재확인이 필요한 항목으로
  남겨둡니다.
* **등급**(`khaiGrade`/`pm10Grade`/`pm25Grade`/`o3Grade`): 빈 문자열 `""` → `null`.
* 옵션 필드(`pm25Value`/`pm25Grade`)의 **부재**는 위와 동일하게 `null`로 취급합니다 —
  문서가 명시한 옵션 필드(항목구분: 0)이므로 malformed가 아니라 정상적인 결측치 표현입니다.
* **필수 필드**(`pm10Value`/`o3Value`/`khaiValue`/`khaiGrade`/`pm10Grade`/`o3Grade`)의
  **부재**는 옵션 필드와 다르게 취급합니다 — 문서가 항목구분: 1로 명시하므로 키 자체가 없는
  것은 업스트림 malformed 응답이며, raw schema 단계(`current-raw-schema.ts`)에서 즉시
  거부되고 `normalize-current.ts`도 (raw schema를 우회한 런타임 호출에 대한 방어적 재검사로)
  이를 정규화 실패(issue)로 처리합니다 — `null`로 조용히 흡수하지 않습니다. 반대로 **필수
  필드가 present이면서 그 값이 sentinel**인 경우(예: `khaiValue: "-"`, `pm10Grade: ""`)는
  키가 존재하므로 malformed가 아니라 정상적인 결측치 표현이며, 옵션 필드의 sentinel과
  동일하게 `null`로 정규화됩니다 — presence(키의 존재)와 value(값)는 서로 다른 개념입니다.
* 위 두 sentinel이 **아닌** 값이 파싱 규칙(측정값: `^\d+(\.\d+)?$`, 등급: `"1"`-`"4"`)을
  만족하지 못하면 **정규화 실패**(issue)로 처리하고, 절대 `0`이나 임의의 유효 등급으로
  치환하지 않습니다.

### 등급(Grade) 매핑

문서의 "항목별 Grade 값의 의미"를 그대로 사용합니다.

| Grade 값 | 의미 | 매핑 |
| --- | --- | --- |
| `1` | 좋음 | `GOOD` |
| `2` | 보통 | `MODERATE` |
| `3` | 나쁨 | `BAD` |
| `4` | 매우나쁨 | `VERY_BAD` |
| `""` (결측) | - | `null` |
| 그 외 모든 값 | 미문서화 | 정규화 실패 (조용히 `UNKNOWN`이나 임의 등급으로 승격하지 않음) |

이 PR에서는 농도 기반 등급을 자체 계산하지 않고, AirKorea가 이미 계산해 제공하는 native
등급만 그대로 매핑합니다.

### 1시간 등급 대신 24시간 등급을 쓴 이유

문서는 PM10/PM2.5 등급을 두 종류로 제공합니다 — `pm10Grade`/`pm25Grade`(24시간 이동평균
기준)와 `pm10Grade1h`/`pm25Grade1h`(1시간 값 기준, ver 1.3). `khaiGrade`(CAI)도 24시간
기준 데이터로 산출되는 것이 AirKorea의 표준 관행입니다. `CurrentAirQuality.overallGrade`
(khaiGrade)와의 의미적 일관성을 위해, `pm10Grade`/`pm25Grade` **24시간 등급**을 사용하고
1시간 등급은 정규화하지 않습니다(raw schema에도 선언하지 않아 자동으로 strip됨). CAI(24h
기반)와 PM 1시간 등급을 섞어 쓰면 "현재" 판단 기준이 필드마다 달라지는 비일관성이 생기기
때문입니다.

## 측정 시각(`dataTime`) 정규화

`dataTime`은 `YYYY-MM-DD HH:mm` 형식의 로컬(한국) 시각 문자열입니다(문서 샘플:
`2020-11-25 13:00`). 시간대 표기가 없으므로, 국내 전용 서비스라는 전제 하에 **KST
(UTC+09:00)** 로 명시적으로 해석하며, 시스템 시계나 로케일에 의존하지 않습니다
(`normalize-current.ts`의 `buildMeasuredAtKst`, `current-raw-schema.ts`의
`parseAirKoreaDataTime`이 담당). 결과는 `YYYY-MM-DDTHH:mm:00+09:00` 형태의 ISO-8601
절대 시각이며, `CurrentAirQuality.measuredAt`(contracts `isoDateTime`)을 만족합니다.

시각 `HH`는 `00`-`23`, `MM`은 `00`-`59`를 허용합니다. 추가로 일부 공공데이터포털 서비스에서
통용되는 자정을 `24:00`으로 표기하는 관행이 **이 오퍼레이션의 `dataTime`에서 2026-08-13
Owner-observed live JSON evidence로 실제 확인**되었습니다(실측 예: `dataTime: "2026-08-12
24:00"`) — PR #82 당시에는 미확인 gap이었으나, PR #87에서 이를 반영해 정확히 `24:00`(분은 반드시
`00`)만 유효한 end-of-day 표기로 허용하고, 순수 달력 연산(`Date`나 시스템 시계 사용 없음)으로 다음
날 `00:00`으로 canonicalize합니다 — 월말, 12월 31일 → 1월 1일, 윤년 2월 경계를 모두 올바르게
처리합니다. `24:01`/`24:59`/`25:00` 등 그 외 `24`시 초과 또는 `24:00`이 아닌 값은 여전히
malformed로 거부됩니다. 예:

* `2026-08-12 24:00` → `2026-08-13T00:00:00+09:00`
* `2026-12-31 24:00` → `2027-01-01T00:00:00+09:00`

## "최신 측정값" 선택 정책

`dataTerm=DAILY`로 요청해도 한 측정소에 대해 여러 시간대의 행(`item`)이 반환될 수 있습니다.
문서는 이 목록의 **정렬 순서를 명시하지 않습니다** — "정렬"이나 "내림차순" 같은 표현이 문서
어디에도 없습니다. 따라서 이 provider는 **`items[0]`을 암묵적으로 사용하지 않습니다.**

대신 `provider.ts`의 `selectLatestItem`이 각 item의 공식 `dataTime` **값**을 비교해 가장
늦은 시각의 item을 선택합니다. PR #87 이전에는 `dataTime` raw 문자열을 직접 사전식 비교했으나 —
`24:00` 표기 지원 이후에는 이 방식만으로는 부족합니다(§ "측정 시각(dataTime) 정규화" 참고): `24:00`
행과 다음 날 `00:00` 행은 서로 다른 raw 문자열이지만 **정확히 같은 순간**을 의미합니다. 따라서
PR #87부터는 각 item의 `dataTime`을 `parseAirKoreaDataTime`으로 파싱한(이미 `24:00` rollover가
적용된) **canonical parts**를 `formatAirKoreaDataTimeCanonical`로 다시 zero-padded
`YYYY-MM-DD HH:mm` 문자열로 만든 뒤 이 canonical 문자열을 비교합니다 — canonical 형식은 항상
`hour <= 23`이므로 문자열 사전식 비교가 시간 순서 비교와 동일하며, `24:00` 행과 다음 날 `00:00`
행은 같은 canonical 값으로 정확히 동점 처리됩니다(가짜 시간차를 만들지 않음). 이는 배열의
**위치**가 아니라 문서가 보장하는 **필드 값의 semantic 시각**만으로 최신 행을 결정하는 정책이며,
정렬 순서에 대한 어떤 가정도 하지 않습니다. 동일한 canonical 시각을 가진 행이 둘 이상 있는(리터럴
중복이든 `24:00`/다음날 `00:00`처럼 서로 다른 표기든) 경우 배열에서 먼저 나온 행을 결정적으로
선택합니다 — 이는 "정렬 정책"이 아니라 단순한 동점 처리이며, 여러 번 호출해도 같은 입력에는 항상
같은 출력을 냅니다.

응답이 유효하지만 `item` 목록이 비어 있으면(`totalCount === 0`) `NO_DATA`를 반환하고
`CurrentAirQuality`를 **조작(fabricate)하지 않습니다.** `totalCount`가 실제로 수신한 행 수를
초과하면(`numOfRows=100` 한도를 넘는 비정상적으로 많은 행이 있다는 뜻) `INCOMPLETE_PAGE`로
실패시켜, 불완전한 페이지에서 "최신"을 잘못 판단하지 않도록 방지합니다.

## Provider 공개 계약

```ts
interface AirKoreaCurrentAirQualityProvider {
  fetchCurrentAirQuality(
    request: AirKoreaCurrentAirQualityRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<AirKoreaCurrentAirQualityProviderResult>;
}
```

성공 결과(`AirKoreaCurrentAirQualityProviderSuccess`)는 선택된 최신 item의 필드
(`stationName`, `dataTime`, 4개 측정값, 4개 등급)만 노출합니다 — raw body, URL, 서비스키는
전혀 포함되지 않습니다. 이 타입의 필수/옵션 구분은 raw 계약을 그대로 따릅니다:
`pm10Value`/`o3Value`/`khaiValue`/`khaiGrade`/`pm10Grade`/`o3Grade`는 필수 문자열이고
(raw schema가 이미 그 존재를 보장), `pm25Value`/`pm25Grade`만 옵션입니다.

실패 kind: `INVALID_REQUEST`, `TIMEOUT`, `ABORTED`, `NETWORK_ERROR`, `HTTP_ERROR`,
`RESPONSE_TOO_LARGE`, `EMPTY_RESPONSE`, `NON_JSON_RESPONSE`, `INVALID_JSON`,
`AIRKOREA_UPSTREAM_ERROR`(2자리 `resultCode`만), `AIRKOREA_INVALID_RESPONSE`(sanitized
issues만), `RESPONSE_MISMATCH`, `INCOMPLETE_PAGE`, `NO_DATA`.

`createAirKoreaCurrentAirQualityProvider(options)` / `…FromEnv(env?, dependencies?)`는 KMA
provider와 같은 원칙을 따릅니다 — construction 시 fetch·환경변수 읽기·로깅 없음,
`FromEnv`는 호출 시점에만 `AIRKOREA_SERVICE_KEY` 하나만 읽음, 설정 실패는 값으로 반환(throw
없음), 서비스키는 어떤 에러에도 포함되지 않습니다.

## Transport / 보안

* `fetchImpl` 주입(기본 `globalThis.fetch`), `timeoutMs`(기본 10,000ms — 문서 평균응답시간
  500ms 대비 넉넉한 project defensive 값), `maxResponseBytes`(기본 4 MiB — project defensive
  값, 공식 문서에 명시된 값 아님).
* GET만, `Accept: application/json`, `redirect: 'error'`(서비스키가 redirect 대상으로
  전달되는 것을 방지).
* caller `AbortSignal`과 내부 timeout이 fetch·body read 전체를 감쌉니다. 이미 abort된
  signal은 fetch를 0회 수행하고 즉시 `ABORTED`를 반환합니다.
* `read-response.ts`가 `Content-Length` 사전 체크와 스트리밍 바이트 카운트 두 계층으로
  응답 크기를 제한합니다.
* 어떤 실패 variant도 서비스키·raw body·URL·업스트림 원문 메시지·예외 메시지/스택을 포함하지
  않습니다.
* 재시도·캐시 없음(이 PR 범위 아님).

이 transport는 `../kma/*`의 private helper를 import하지 않는 **독립 구현**입니다 — KMA
provider의 런타임 동작은 이 PR에서 전혀 변경되지 않았습니다.

## 실제 인증 API 검증 상태

PR #82 시점에는 실제 인증 서비스키를 사용한 AirKorea API 호출을 전혀 수행하지 않았습니다. PR #87
(2026-08-13)에서 Owner가 인증된 Public Data Portal preview 호출을 직접 실행해 아래 두 항목을
확인했습니다 — 자세한 내용은 § "Owner-observed live JSON evidence" 참고.

* ~~JSON 직렬화에서 `body.items`가 direct array인지 `{ item: [...] }` wrapper인지~~ —
  **2026-08-13 확인됨: direct array.**
* ~~`dataTime`에 자정을 `24:00`으로 표기하는 사례가 실제로 존재하는지~~ — **2026-08-13 확인됨:
  존재함(`"2026-08-12 24:00"`).**

이 preview 호출은 이 operation의 **positive(성공) 응답 하나만** 대상이었으므로, 아래 항목은
여전히 문서만으로는 100% 확정할 수 없어 향후 추가 인증된 실응답으로 재확인이 필요합니다.

* JSON 직렬화에서 결측 등급이 실제로 빈 문자열(`""`)로 나타나는지(문서 예제는 XML만 제공).
* `pm25Value`/`pm25Grade`가 `ver=1.5`에서 실제로 항상 키 자체는 존재하되 값만 sentinel인지,
  아니면 키 자체가 완전히 생략되는지.
* PM10/PM2.5/O3/CAI 각각에 `"-"` sentinel이 실제로 동일하게 적용되는지(문서에는 `khaiValue`
  예시만 있음).
* 0건 결과(zero-result)의 실제 JSON 직렬화 형태(§ "Zero-result" 관련 — 이 provider는 아직
  positive 응답만 확인했으므로, zero-result가 여전히 빈 direct array(`items: []`)로 직렬화되는지는
  구조적으로 자연스럽게 도출되는 가정일 뿐, 별도로 실측되지 않았습니다).

## 범위 확인 (이 PR에서 구현하지 않은 것)

* 위도/경도 → 측정소 변환, TM 좌표 변환, 근접 측정소 조회
* 측정소 caching, fallback
* application service, production composition
* `POST /weather` 연결, `WeatherOverview.airQuality.current` 조립
* AirKorea 대기질 예보(주간예보 등), CAI 별도 endpoint, 대기질 특보
* 재시도/backoff, 응답 캐시
* mobile UI
