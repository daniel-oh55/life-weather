# AirKorea Administrative-Name TM-Coordinate (TM 기준좌표 조회) Provider

이 문서는 에어코리아(AirKorea) **TM 기준좌표 조회 (`getTMStdrCrdnt`)** 의 provider boundary —
읍면동(umd) 행정구역명 기반 request 검증·URL 생성, raw JSON runtime schema, 성공/upstream
error/invalid response 분류, TM 좌표 파싱, 그리고 validated TM-coordinate candidate 목록 반환 — 를
기록합니다. 근거는 아래 공식 자료이며, 블로그·개인 저장소·비공식 정리 문서는 최종
request/response shape의 근거로 사용하지 않았습니다.

이 PR(#84)은 [`docs/airkorea-nearby-station-provider.md`](./airkorea-nearby-station-provider.md)
(PR #83)의 TM-coordinate 근접측정소 목록 조회(`getNearbyMsrstnList`) 앞단에서, 행정구역명(umdName)을
TM 좌표 candidate 목록으로 바꾸는 **provider boundary까지만** 구현합니다. WGS84 위경도 ↔ TM 좌표
변환, 행정구역 disambiguation, 최종 TM 좌표 하나 선택, `getNearbyMsrstnList`와의 orchestration,
application service/composition, `POST /weather` 연결은 이 PR 범위가 아닙니다.

## 공식 자료 — 재검증 기록

이 PR은 구현 전 공식 데이터를 **다시 다운로드하여** PR #83이 기록한 evidence와 byte-identical한지
확인했습니다.

| 항목 | 값 |
| --- | --- |
| 공식 데이터셋명 | 한국환경공단_에어코리아_측정소정보 |
| 공공데이터포털 dataset ID | `15073877` |
| 포털 메타데이터 수정일 | 2026-06-30 |
| 참고 문서 파일명 | `한국환경공단 에어코리아 OpenAPI 기술문서_20260630.zip` |
| 참고 문서 ZIP SHA-256 (재검증) | `a7ade5483790051006d04359cfdd179e4e48d54e8345c8fd9d44ded2969936cb` — PR #83 기록과 **byte-identical** |
| 실제 사용 기술문서 | `한국환경공단_에어코리아_측정소정보_기술문서_v1.2.docx` (제목: "한국환경공단 에어코리아 오픈API 활용가이드 (측정소정보 조회 서비스)") |
| 기술문서 SHA-256 (재검증) | `f2387b7dd3e42f4dafdef7fb6f83ec8612e1d6bb34f1d20ac5706d4917ef3a51` — PR #83 기록과 **byte-identical** |
| API명(영문) | `MsrstnInfoInqireSvc` (측정소정보 조회 서비스) |
| 대상 operation | TM 기준좌표 조회 `getTMStdrCrdnt` (상세기능 번호 3, 상세기능 유형: 조회(목록)) |
| 공식 Call Back URL (문서 표기) | `http://apis.data.go.kr/B552584/MsrstnInfoInqireSvc/getTMStdrCrdnt` |
| 프로젝트 실사용 endpoint | `https://apis.data.go.kr/B552584/MsrstnInfoInqireSvc/getTMStdrCrdnt` (HTTPS — 기존 KMA/AirKorea provider와 동일한 이유로 평문 HTTP 대신 HTTPS 사용) |
| 상세기능 설명 (문서 표기) | "TM 좌표를 알 수 없는 사용자를 위해 읍면동 이름으로 검색하여 TM기준좌표 내역을 조회하는 기능 제공" |
| 최대 메시지 사이즈 / 평균 응답 시간 / 초당 최대 트랜잭션 | `[1000] byte` / `[500] ms` / `[50] tps` (문서 표기) |

**재검증 방법**: 공식 데이터셋 상세 페이지(`https://www.data.go.kr/data/15073877/openapi.do`)의
"참고문서" 다운로드 엔드포인트(`atchFileId=FILE_000000003666341`, `fileDetailSn=1`,
`/cmm/cmm/fileDownload.do`)에서 ZIP을 다시 받아 SHA-256을 계산했고, PR #83이 기록한 해시와 완전히
일치했습니다. 그 ZIP 안의 9개 `.docx`/`.pdf` 중 "측정소정보" 문서(§ 안에서
`MsrstnInfoInqireSvc`/`getTMStdrCrdnt`/`getNearbyMsrstnList` 텍스트를 포함하는 파일)를 다시 식별해
SHA-256을 계산했고, 이 역시 PR #83이 기록한 해시와 완전히 일치했습니다 — 이 PR이 근거로 삼은
문서는 PR #83이 근거로 삼은 문서와 **바이트 단위로 동일한 파일**입니다. 문서 내부 개정이력에는
GATEWAY 방식 v1.2(2023-10-23, "측정소 목록 조회 좌표(dmX, dmY) 기능개선")가 최신 항목으로
기록되어 있습니다. **실제 인증 서비스키를 사용한 API 호출은 수행하지 않았습니다.**

## Request 계약

`AirKoreaTmCoordinateRequest`(`apps/api/src/providers/airkorea/tm-coordinate-request.ts`)는 필드
하나만 가집니다.

```ts
interface AirKoreaTmCoordinateRequest {
  readonly umdName: string; // 읍면동명, 예: "혜화동"
}
```

### 공식 요청 파라미터 (문서 발췌, TM 기준좌표 조회 § b)

| 파라미터 | 항목구분 | 항목크기 | 샘플데이터 | 설명 |
| --- | --- | --- | --- | --- |
| `serviceKey` | 필수(1) | - | - | 인증키(URL Encode) |
| `returnType` | 옵션(0) | 4 | `xml` | 데이터 표출방식 xml 또는 json |
| `numOfRows` | 옵션(0) | 4 | `100` | 한 페이지 결과 수 |
| `pageNo` | 옵션(0) | 4 | `1` | 페이지 번호 |
| `umdName` | **필수(1)** | 60 | `혜화동` | 읍면동명 |

문서상 공식 필수(항목구분: 1) 요청 파라미터는 `serviceKey`, `umdName` 둘입니다. **이 operation의
요청 표에는 `ver` 파라미터가 아예 존재하지 않습니다** — `getNearbyMsrstnList`(PR #83)처럼 "문서
근거로 `ver`를 보내지 않기로 결정"한 것이 아니라, 애초에 이 operation에 `ver`라는 옵션 자체가
없습니다. 따라서 이 provider는 `ver`를 전혀 전송하지 않습니다(전송할 방법 자체가 문서에 없음).

`numOfRows`/`pageNo`는 이 operation에서 **문서상 옵션(항목구분: 0)** 입니다 — `getNearbyMsrstnList`
(요청 파라미터 자체가 없음)와도, `getMsrstnAcctoRltmMesureDnsty`(PR #82, `numOfRows`/`pageNo`
옵션이지만 provider가 고정 전송)와도 다른 조합입니다. 각 operation은 자신만의 공식 계약을
가지므로 다른 PR의 파라미터 집합을 그대로 베끼지 않았습니다.

### `numOfRows`/`pageNo` 고정 정책 (evidence-backed project decision)

이 provider는 `numOfRows`/`pageNo`를 caller에게 노출하지 않고 고정값(`pageNo=1`,
`numOfRows=100`)을 항상 전송합니다 — `numOfRows=100`은 이 operation 자신의 요청 표 샘플데이터
값(`100`)과 동일하며, PR #82(측정소별 실시간 측정정보 조회)가 자신의 요청 표 샘플값을 그대로 쓴
것과 같은 원리입니다(§ "공식 요청 파라미터" 참고 — PR #83을 그대로 베낀 것이 아니라 각 operation
자신의 문서 값을 사용).

이 고정값을 선택한 이유는 **동명이동(同名異洞)** 때문입니다 — 하나의 `umdName`(예: "중앙동")은
전국에 걸쳐 서로 다른 시군구에 동시에 존재할 수 있으므로, 한 번의 조회가 여러 행을 반환할 수
있습니다. `numOfRows=100`은 이 프로젝트가 선택한 방어적 상한이며, 문서가 이 operation에 대해
"한 umdName이 최대 몇 건을 반환할 수 있는지"를 명시하지 않으므로 **완전성 보장이 아닙니다** — 아래
"Pagination / completeness" 절의 fail-closed 정책이 실제 안전장치입니다.

### umdName 검증

`isAirKoreaAdministrativeDongName`(`tm-coordinate-request.ts`)가 다음을 강제합니다(문서 항목크기:
60, 이 operation의 요청 표 자체 값 — 응답 표의 `umdName` 항목크기 20과는 다름, 아래 "Raw response
계약" 참고).

* 비어 있지 않은 문자열
* 앞뒤 공백 없음(trim 후 동일해야 함 — 자동 trim 없음, `isAirKoreaStationName`과 동일한 정책)
* 최대 60 UTF-16 code unit
* C0 제어문자·DEL(U+0000–U+001F, U+007F) 금지

URL은 `URL` + `URLSearchParams`로만 구성하며, 서비스키와 `umdName`(한글 포함) 모두
`URLSearchParams`가 정확히 한 번 percent-encode합니다. 파라미터 순서는 `serviceKey`,
`returnType`, `pageNo`, `numOfRows`, `umdName`으로 고정됩니다.

## Raw response 계약

문서의 응답 필드 표(TM 기준좌표 조회 § c) 전체를 옮기면 다음과 같습니다.

| 필드 | 항목구분 | 항목크기 | 샘플데이터 | 설명 |
| --- | --- | --- | --- | --- |
| `resultCode` | 필수 | 2 | `00` | 결과코드 |
| `resultMsg` | 필수 | 50 | `NORMAL SERVICE.` | 결과메세지 (미노출 정책) |
| `numOfRows` | 필수 | 4 | `100` | 한 페이지 결과 수 |
| `pageNo` | 필수 | 4 | `1` | 페이지 번호 |
| `totalCount` | 필수 | 4 | `1` | 전체 결과 수 |
| `items` | - | - | 0..n | 목록 |
| `items.sidoName` | 필수 | 20 | `서울특별시` | 시도 |
| `items.sggName` | 필수 | 20 | `종로구` | 시군구 |
| `items.umdName` | 필수 | 20 | `혜화동` | 읍면동 |
| `items.tmX` | 필수 | 13,6 | `200089.126044` | TM측정방식 X좌표 |
| `items.tmY` | 필수 | 13,6 | `453946.42329` | TM측정방식 Y좌표 |

### 응답 `umdName`의 항목크기(20)가 요청 `umdName`의 항목크기(60)와 다른 이유

문서는 요청 표(§ b)의 `umdName` 항목크기를 `60`으로, 응답 표(§ c)의 `items.umdName` 항목크기를
`20`으로 각각 명시합니다 — 이는 프로젝트의 불일치가 아니라 문서 자체가 같은 필드명에 대해
요청/응답에서 서로 다른 두 값을 기술하는 것입니다. 따라서 `tm-coordinate-request.ts`의
`isAirKoreaAdministrativeDongName`(요청 측, 최대 60)과 `tm-coordinate-raw-schema.ts`의
응답 측 administrative-name predicate(최대 20, `sidoName`/`sggName`/`umdName` 셋 모두 공유)를
**서로 다른 predicate**로 분리했습니다 — 두 값을 하나로 합치거나 더 큰 쪽으로 완화하지 않았습니다.

### 이 provider가 실제로 소비하는 필드

`airKoreaTmCoordinateItemSchema`(`tm-coordinate-raw-schema.ts`)는 이 provider가 실제로 소비하는
필드만 선언하며, 문서의 필수/옵션 구분을 그대로 반영합니다:

* **필수 문자열** (항목구분: 1 — 키 자체가 없으면 malformed 응답으로 거부): `sidoName`,
  `sggName`, `umdName`, `tmX`, `tmY` — 5개 필드 **모두** 이 operation에서는 필수입니다(PR #82의
  `pm25Value`/`pm25Grade` 같은 옵션 필드가 이 operation에는 없음).
* `response.header`/`response.body.numOfRows`/`pageNo`/`totalCount`의 envelope 스키마는 PR #82의
  `current-raw-schema.ts`에서 정의한 `airKoreaResponseHeaderSchema`/`AIRKOREA_SUCCESS_RESULT_CODE`를
  그대로 재사용합니다 — 같은 `B552584` 공공데이터포털 서비스 계열의 동일한 header envelope이므로
  intra-namespace 재사용입니다(cross-provider import 아님).

**AirKorea 고유 raw 타입/스키마는 최소한만 export됩니다** — 원본 raw 타입
(`AirKoreaTmCoordinateItem`)은 provider-level 결과(`AirKoreaTmCoordinateCandidate`)로 변환된 뒤에는
더 이상 필요하지 않습니다.

### TM 좌표(`tmX`/`tmY`) 파싱

문서의 요청/응답 메시지 예제(§ d)는 `tmX`/`tmY`를 XML 텍스트(`<tmX>200089.126044</tmX>`)로만
보여줍니다 — JSON 샘플은 제공되지 않습니다(PR #82/#83과 동일한 gap). 이 provider는
`returnType=json` 요청에서도 `tmX`/`tmY`를 문자열로 취급합니다 — raw schema는 문자열 존재만
검증하고, 실제 숫자 파싱은 `parseAirKoreaTmCoordinateValue`(`tm-coordinate-raw-schema.ts`)가
담당합니다.

`tmX`/`tmY`에는 문서에 명시된 "결측치" sentinel이 없습니다 — 반환된 행의 좌표는 항상 계산 가능한
값이므로, 결측 표현을 허용하지 않습니다. 파싱 규칙:

* 정규식 `^-?\d+(\.\d+)?$` — 선택적 부호(`-`)와 순수 십진 표기(정수 또는 소수)만 허용, 지수
  표기·선행 `+`·빈 문자열 모두 거부.
* 음수 부호를 허용하는 것은 PR #83의 `tm`(거리, 항상 비음수)과의 의도적인 차이입니다 — `tmX`/`tmY`는
  거리가 아니라 Cartesian 좌표이고, 이 프로젝트의 기존 요청측 TM 좌표 predicate
  (`isAirKoreaTmCoordinate`, `nearby-station-request.ts`)가 이미 음수 TM 좌표를 유효한 값으로
  취급하므로, "TM 좌표"라는 개념을 요청측과 응답측에서 일관되게 유지하기 위함입니다(문서 예제
  자체는 양수만 보여주지만, 더 좁은 제약을 새로 발명하지 않았습니다).
* 위 정규식을 통과해도 `Number()` 변환 결과가 `Number.isFinite`가 아니면 거부 — malformed 텍스트를
  정상 좌표로 승격하지 않습니다.
* 위 조건을 모두 만족하는 경우에만 finite 좌표 숫자를 반환합니다. **`0`을 조작(fabricate)하지
  않습니다** — malformed 값은 항상 `null`이 되어 provider가 `MALFORMED_COORDINATE`로 페이지 전체를
  실패시킵니다.

## "하나의 TM 좌표" 미선택 정책 (동명이동)

문서 어디에도 `umdName`이 전국에서 유일함을 보장하는 문구가 없습니다 — 오히려 같은 읍면동명이
서로 다른 시도/시군구에 반복되는 것(동명이동)은 한국 행정구역 체계의 일반적인 사실입니다. 이 PR의
작업 지시서(§ "IMPORTANT ARCHITECTURE DECISION")도 이를 명시적으로 요구합니다. 따라서:

* 이 provider는 `candidates[0]`을 "정답"으로 간주하지 않습니다.
* `sidoName`/`sggName`으로 candidate를 좁히거나 앱의 `adminArea1`/`adminArea2`와 상관시키지
  않습니다 — 이는 후속 resolver PR의 책임입니다.
* upstream이 반환한 순서를 그대로 `AirKoreaTmCoordinateCandidate[]`로 반환합니다(정렬/필터/dedupe
  없음).

## Pagination / completeness 정책

PR #83이 발견한 completeness 버그와 같은 원리를 적용합니다. 이 operation은 `numOfRows`/`pageNo`가
**문서상 옵션**이지만, 이 provider는 이를 caller에게 노출하지 않고 고정값(`numOfRows=100`,
`pageNo=1`)만 전송합니다(§ "numOfRows/pageNo 고정 정책" 참고) — 즉 caller가 추가 페이지를 요청할
방법이 없습니다. 동시에 문서는 반환 순서를 보장하지 않으므로, 후속 resolver는 "이미 반환된
candidate 중 올바른 것"이 아니라 "전체 candidate 중 올바른 것"을 판단해야 합니다. 따라서:

```
totalCount > items.length
```

인 응답은 **불완전한 candidate 집합**이며, 완전한 성공으로 취급하지 않고 명시적으로 실패시킵니다.

```ts
{ kind: 'INCOMPLETE_RESULT'; totalCount: number; receivedCount: number }
```

`interpretTmCoordinatePage`의 판정 순서(PR #83의 `interpretNearbyStationPage`와 동일한 순서 —
`totalCount`가 양수이면서 반환된 item이 0개인 응답은 "결과 없음"이 아니라 "불완전한 결과"):

1. `totalCount > items.length` → `INCOMPLETE_RESULT { totalCount, receivedCount }`
2. `items.length === 0` (즉 `totalCount === 0`) → `NO_DATA`
3. 그 외 → 모든 item의 TM 좌표를 파싱해 성공 candidate 목록 반환

명확히 해 둘 것:

* 페이지네이션 루프를 추가하지 않았습니다 — 이 provider는 여전히 한 번의 HTTP 요청만 수행하며,
  고정된 `numOfRows=100`을 넘는 동명이동은 `INCOMPLETE_RESULT`로 fail-closed됩니다.
* 결측 candidate를 만들어내지 않습니다.
* 이 provider는 여전히 최종 TM 좌표를 선택하지 않습니다.
* raw schema(`tm-coordinate-raw-schema.ts`)의 `superRefine`은 PR #82/#83과 동일한 구조적
  self-consistency(`itemCount`가 `numOfRows`/`totalCount`를 초과하지 않음, `totalCount === 0`이면
  item이 없어야 함)만 강제합니다 — `totalCount > itemCount`(불완전 페이지)는 구조적으로 유효한
  응답이며 malformed로 거부하지 않습니다. Completeness 정책은 raw schema가 아니라 provider의
  semantic 책임입니다.

## Zero-result(결과 없음) JSON 직렬화 — 미검증 evidence gap

PR #83과 동일한 gap입니다. 응답 필드 표(§ c)는 `items`의 항목크기를 `0..n`으로 표기해 0개 결과가
가능함을 시사하지만, 기술문서는 이 operation에 대해 0개 결과 응답의 예제를 전혀 제공하지
않습니다 — § d의 예제는 1개 결과가 반환되는 경우만 보여줍니다. 이 provider는 PR #83과 동일하게
다음 JSON 형태를 만났을 때만 `NO_DATA`로 인식합니다.

```json
{ "items": { "item": [] } }
```

이 정확한 zero-result JSON 직렬화 형태는 **공식적으로 검증되지 않았습니다**. 실제 인증된 API가
0개 결과를 다른 형태(`items` 필드 생략, `null` 등)로 직렬화한다면, 현재 runtime은 이를 `NO_DATA`가
아니라 `AIRKOREA_INVALID_RESPONSE`로 분류합니다 — 근거 없는 permissive 형태를 추측만으로 미리
추가하지 않았습니다.

## Provider 공개 계약

```ts
interface AirKoreaTmCoordinateProvider {
  fetchTmCoordinates(
    request: AirKoreaTmCoordinateRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<AirKoreaTmCoordinateProviderResult>;
}
```

성공 결과는 validated TM-coordinate candidate 배열만 노출합니다 — raw body, URL, 서비스키는 전혀
포함되지 않습니다.

```ts
interface AirKoreaTmCoordinateCandidate {
  readonly sidoName: string;
  readonly sggName: string;
  readonly umdName: string;
  readonly tmX: number;
  readonly tmY: number;
}
```

실패 kind: `INVALID_REQUEST`, `TIMEOUT`, `ABORTED`, `NETWORK_ERROR`, `HTTP_ERROR`,
`RESPONSE_TOO_LARGE`, `EMPTY_RESPONSE`, `NON_JSON_RESPONSE`, `INVALID_JSON`,
`AIRKOREA_UPSTREAM_ERROR`(2자리 `resultCode`만), `AIRKOREA_INVALID_RESPONSE`(sanitized issues만),
`MALFORMED_COORDINATE`, `INCOMPLETE_RESULT { totalCount, receivedCount }`(위 "Pagination /
completeness 정책" 참고), `NO_DATA`. PR #82의 `RESPONSE_MISMATCH`에 대응하는 kind는 없습니다 — 이
provider는 caller가 지정한 값이 응답에 echo되는지 검사할 필요가 있는 correlation 대상 필드가
없습니다(요청 `umdName`이 응답 각 item의 `umdName`과 일치하는지는 검사하지 않습니다 — 여러 행이
합법적으로 같은 `umdName`을 가지므로, 이는 상관관계 오류가 아니라 정상적인 동명이동입니다).

`createAirKoreaTmCoordinateProvider(options)` / `…FromEnv(env?, dependencies?)`는 PR #82/#83과
완전히 같은 `AirKoreaProviderOptions`/`AIRKOREA_SERVICE_KEY`/`timeoutMs`/`maxResponseBytes` 정책을
공유합니다(`config.ts` 재사용, 새 config 모듈 없음) — construction 시 fetch·환경변수 읽기·로깅
없음, `FromEnv`는 호출 시점에만 `AIRKOREA_SERVICE_KEY` 하나만 읽음, 설정 실패는 값으로
반환(throw 없음), 서비스키는 어떤 에러에도 포함되지 않습니다.

## Transport / 보안

이 provider는 **새 transport를 만들지 않습니다** — `provider.ts` 안에 이미 있는(PR #82의)
module-private `performAirKoreaGetRequest`를 그대로 재사용합니다. PR #82/#83과 완전히 동일한 단일
구현을 공유합니다:

* `fetchImpl` 주입(기본 `globalThis.fetch`), `timeoutMs`(기본 10,000ms), `maxResponseBytes`(기본
  4 MiB) — project defensive 값, 공식 문서에 명시된 값 아님(문서의 평균응답시간은 500ms).
* GET만, `Accept: application/json`, `redirect: 'error'`.
* caller `AbortSignal`과 내부 timeout이 fetch·body read 전체를 감쌈. 이미 abort된 signal은
  fetch를 0회 수행하고 즉시 `ABORTED`를 반환.
* `read-response.ts`의 `Content-Length` 사전 체크 + 스트리밍 바이트 카운트 응답 크기 제한.
* 어떤 실패 variant도 서비스키·raw body·URL·업스트림 원문 메시지·예외 메시지/스택을 포함하지
  않음.
* 재시도·캐시 없음.

PR #82/#83 provider의 runtime semantics는 이 PR에서 전혀 변경되지 않았습니다
(`provider.test.ts`/`read-response.test.ts`/`nearby-station-provider.test.ts`가 회귀 없이 그대로
통과).

## 실제 인증 API 검증 상태

**실제 인증 서비스키를 사용한 AirKorea API 호출은 수행하지 않았습니다.** 모든 request/response
shape 근거는 위 공식 기술문서의 텍스트·요청응답 예제에서만 가져왔습니다. 아래는 문서만으로는
100% 확정할 수 없어 향후 인증된 실응답으로 재확인이 필요한 항목입니다.

* JSON 직렬화에서 `tmX`/`tmY`가 실제로 문자열로 나타나는지(문서 예제는 XML만 제공).
* `tmX`/`tmY`가 실제로 음수를 반환하는 경우가 존재하는지(대한민국 TM 중부원점 좌표계의 실무 범위는
  항상 양수이지만, 문서에 명시적 범위 제약은 없음 — 이 provider는 이를 이유로 음수를 거부하지
  않습니다).
* 동명이동 `umdName`이 실제로 `numOfRows=100` 상한을 초과해 `INCOMPLETE_RESULT`를 유발하는 사례가
  존재하는지.
* zero-result의 실제 JSON 직렬화 형태(위 "Zero-result" 절 참고).

## 범위 확인 (이 PR에서 구현하지 않은 것)

* WGS84 위도/경도 → TM 좌표 변환
* 행정구역(읍면동) 이름 disambiguation — `adminArea1`/`adminArea2`/`adminArea3` 상관관계
* 최종 TM 좌표 하나 선택(단일 candidate 결정) 정책
* `getNearbyMsrstnList`(PR #83)와의 orchestration
* 최종 closest-station 선택
* current-air-quality(PR #82) 호출
* application service, production composition
* `POST /weather` 연결, `WeatherOverview.airQuality.current`/향후 대기질 조립에 이 provider를
  연결하는 작업
* 재시도/backoff, 응답 캐시
* mobile UI
* 실제 AirKorea endpoint 호출, 실제 `AIRKOREA_SERVICE_KEY`, 실제 사용자 좌표
