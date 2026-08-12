# AirKorea TM-Coordinate Nearby-Station (Nearby Station) Provider

이 문서는 에어코리아(AirKorea) **근접측정소 목록 조회 (`getNearbyMsrstnList`)** 의 provider
boundary — TM(중부원점) 좌표 기반 request 검증·URL 생성, raw JSON runtime schema, 성공/upstream
error/invalid response 분류, 거리(km) 파싱, 그리고 validated station candidate 목록 반환 — 를
기록합니다. 근거는 아래 공식 자료이며, 블로그·개인 저장소·비공식 정리 문서는 최종
request/response shape의 근거로 사용하지 않았습니다.

이 PR(#83)은 [`docs/airkorea-current-air-quality-provider.md`](./airkorea-current-air-quality-provider.md)
(PR #82)에서 추가된 AirKorea current-air-quality provider 앞단에서, 향후 station resolver가 사용할
수 있는 **provider boundary까지만** 구현합니다. WGS84 위경도 → TM 좌표 변환, 행정구역 → TM 좌표
변환, 최종 closest-station 선택, application service/composition, `POST /weather` 연결은 이 PR
범위가 아닙니다.

## 공식 자료

| 항목 | 값 |
| --- | --- |
| 공식 데이터셋명 | 한국환경공단_에어코리아_측정소정보 |
| 공공데이터포털 dataset ID | `15073877` |
| 포털 메타데이터 수정일 | 2026-06-30 |
| 참고 문서 파일명 | `한국환경공단 에어코리아 OpenAPI 기술문서_20260630.zip` |
| 참고 문서 ZIP SHA-256 | `a7ade5483790051006d04359cfdd179e4e48d54e8345c8fd9d44ded2969936cb` |
| 실제 사용 기술문서 | `한국환경공단_에어코리아_측정소정보_기술문서_v1.2.docx` (제목: "한국환경공단 에어코리아 오픈API 활용가이드 (측정소정보 조회 서비스)") |
| 기술문서 SHA-256 | `f2387b7dd3e42f4dafdef7fb6f83ec8612e1d6bb34f1d20ac5706d4917ef3a51` |
| API명(영문) | `MsrstnInfoInqireSvc` (측정소정보 조회 서비스) |
| 대상 operation | 근접측정소 목록 조회 `getNearbyMsrstnList` (상세기능 번호 2, 상세기능 유형: 조회(목록)) |
| 공식 Call Back URL (문서 표기) | `http://apis.data.go.kr/B552584/MsrstnInfoInqireSvc/getNearbyMsrstnList` |
| 프로젝트 실사용 endpoint | `https://apis.data.go.kr/B552584/MsrstnInfoInqireSvc/getNearbyMsrstnList` (HTTPS — 기존 KMA/AirKorea current-air-quality provider와 동일한 이유로 평문 HTTP 대신 HTTPS 사용) |
| 상세기능 설명 (문서 표기) | "TM 좌표를 입력하여 입력된 좌표 주변 측정소 정보와 입력 좌표와의 거리 조회 기능 제공" |
| 최대 메시지 사이즈 / 평균 응답 시간 / 초당 최대 트랜잭션 | `[1000] byte` / `[500] ms` / `[50] tps` (문서 표기) |

문서는 공식 데이터셋 상세 페이지(`https://www.data.go.kr/data/15073877/openapi.do`)의
"참고문서" 다운로드 버튼(`atchFileId=FILE_000000003666341`, `fileDetailSn=1`,
`/cmm/cmm/fileDownload.do` 엔드포인트)을 통해 직접 내려받아, 그 ZIP 안의 여러 `.docx` 중
"측정소정보" 문서(`한국환경공단_에어코리아_측정소정보_기술문서_v1.2.docx`)만 읽기 전용으로
추출·검토했습니다 — PR #82의 대기오염정보 문서(`atchFileId=FILE_000000003666340`)와는 다른
dataset/문서입니다. **실제 인증 서비스키를 사용한 API 호출은 수행하지 않았습니다.**

## Request 계약

`AirKoreaNearbyStationRequest`(`apps/api/src/providers/airkorea/nearby-station-request.ts`)는
필드 두 개만 가집니다.

```ts
interface AirKoreaNearbyStationRequest {
  readonly tmX: number; // TM_X 좌표 (TM측정방식 X좌표)
  readonly tmY: number; // TM_Y 좌표 (TM측정방식 Y좌표)
}
```

### 공식 요청 파라미터 (문서 발췌, 근접측정소 목록 조회 § b)

| 파라미터 | 항목구분 | 항목크기 | 샘플데이터 | 설명 |
| --- | --- | --- | --- | --- |
| `serviceKey` | 필수(1) | - | - | 인증키(URL Encode) |
| `returnType` | 옵션(0) | 4 | `xml` | 데이터 표출방식 xml 또는 json |
| `tmX` | **필수(1)** | 16.6 | `244148.546388` | TM측정방식 X좌표 |
| `tmY` | **필수(1)** | 16.6 | `412423.75772` | TM측정방식 Y좌표 |
| `ver` | 옵션(0) | 4 | `1.0` | 오퍼레이션 버전 (버전별 상세 결과 아래쪽 참고) |

문서상 공식 필수(항목구분: 1) 요청 파라미터는 `serviceKey`, `tmX`, `tmY` 셋입니다. `stationName`이
필수였던 PR #82(측정소별 실시간 측정정보 조회)와 달리, 이 operation은 `pageNo`/`numOfRows`/
`dataTerm` 파라미터를 전혀 갖지 않습니다 — 문서 요청 표에 그 세 파라미터가 존재하지 않으므로
근거 없이 PR #82에서 복사하지 않았습니다.

### `ver` 결정 (evidence gate 필수 확인 항목)

문서의 "버전(ver) 항목설명"을 그대로 옮기면:

> - 버전을 포함하지 않고 호출할 경우: TM좌표(중부원점) 기반의 가까운 측정소 정보를 표출
> - 버전 1.0을 호출할 경우: 도로명주소검색(juso.go.kr) API가 제공하는 API의 X,Y 좌표로 가까운
>   측정소를 표출
> - 버전 1.1을 호출할 경우: 측정소 코드를 포함한 TM좌표(중부원점) 기반의 가까운 측정소 정보를 표출
> - 버전 1.2를 호출할 경우: 측정소 코드를 포함한 도로명주소검색(juso.go.kr) API가 제공하는 API의
>   X,Y 좌표로 가까운 측정소를 표출

이 PR의 입력은 **TM 좌표**입니다(작업 지시서 범위). `ver=1.0`/`1.2`는 `tmX`/`tmY`를 완전히 다른
좌표계(도로명주소API 좌표)로 재해석하므로 이 provider의 입력 계약과 맞지 않고, `ver=1.1`/`1.2`가
추가하는 `stationCode`는 이 provider가 소비하지 않습니다. 따라서 이 provider는 **`ver`를 전혀
전송하지 않습니다** — 문서가 명시한 "버전을 포함하지 않고 호출"이 정확히 TM(중부원점) 좌표 기반
결과를 표출한다고 문서에 근거가 있으므로, 이는 project-owned fixed request policy이자 근거
기반 결정입니다. PR #82가 `ver=1.5`를 고정한 것과 원리는 같지만("문서 근거에 기반해 필요한
결과를 얻는 버전 선택") 결론은 다릅니다 — 그 provider를 그대로 베끼지 않았습니다.

### tmX / tmY 검증

`isAirKoreaTmCoordinate`(`nearby-station-request.ts`)가 다음을 강제합니다.

* `typeof value === 'number'`
* `Number.isFinite(value)` — `NaN`/`Infinity`/`-Infinity` 거부
* `String(value)`가 지수(exponential) 표기가 아님 — 예: `1e+21`, `1e-8` 거부. 이런 값은 그대로
  query parameter 문자열로 보낼 수 없어 upstream이 파싱하지 못할 것이기 때문입니다.

문서의 항목크기 `16.6`(정수부·소수부 자릿수 힌트로 추정)은 **강제하지 않습니다** — JS `number`는
부동소수점이라 고정된 소수 자릿수를 신뢰성 있게 보존하지 않으므로, 이 항목크기를 자릿수 제한
규칙으로 재구성하는 것은 근거가 불충분한 발명이 됩니다. 문서가 명시한 범위(min/max) 제약은
없으므로(예: KMA `nx`/`ny`의 `[1,149]×[1,253]` 같은 명시적 격자 범위가 이 operation에는 없음),
finite-number 검증 이상의 boundary rule은 적용하지 않았습니다.

URL은 `URL` + `URLSearchParams`로만 구성하며, 서비스키가 `URLSearchParams`에 의해 정확히 한 번
percent-encode됩니다. 파라미터 순서는 `serviceKey`, `returnType`, `tmX`, `tmY`로 고정되며 `ver`는
전송되지 않습니다.

## Raw response 계약

문서의 응답 필드 표(근접측정소 목록 조회 § c) 전체를 옮기면 다음과 같습니다.

| 필드 | 항목구분 | 항목크기 | 샘플데이터 | 설명 |
| --- | --- | --- | --- | --- |
| `resultCode` | 필수 | 2 | `00` | 결과코드 |
| `resultMsg` | 필수 | 50 | `NORMAL SERVICE.` | 결과메세지 (미노출 정책) |
| `numOfRows` | 필수 | 4 | `100` | 한 페이지 결과 수 (서버가 결정 — 이 provider는 요청 파라미터로 보내지 않음) |
| `pageNo` | 필수 | 4 | `1` | 페이지 번호 |
| `totalCount` | 필수 | 4 | `3` | 전체 결과 수 |
| `items` | - | - | 0..n | 목록 |
| `items.stationCode` | 문서 표에는 필수(1)로 표기, 6 | `131442` | 측정소 코드 값 |
| `items.stationName` | 필수 | 30 | `창전동` | 측정소 이름 |
| `items.addr` | 필수 | 510 | `경기 이천시 창전동105-3` | 측정소가 위치한 주소 |
| `items.tm` | 필수 | 4,1 | `9.3` | 요청한 TM좌표와 측정소간의 거리(km 단위) |

### stationCode의 문서 내 모순 — 이 provider가 이를 다루지 않는 이유

응답 필드 표(§ c)는 `stationCode`를 필수(항목구분: 1)로 표기하지만, 같은 문서의 요청/응답
메시지 예제(§ d, `ver` 없이 호출한 요청에 대한 실제 XML 응답 예제)는 `stationCode`를 **전혀
포함하지 않습니다** — 각 item에는 `tm`/`stationName`/`addr` 세 필드만 있습니다. 이는 § b의
버전별 설명("버전을 포함하지 않고 호출할 경우"는 `stationCode`를 언급하지 않고, `ver=1.1`/`1.2`만
"측정소 코드를 포함한"이라고 명시)과 일치합니다. 즉 § c의 응답 표는 (아마도) 모든 버전의 합집합
필드를 나열한 것으로 보이며, 실제 no-version(이 provider가 사용하는) 응답에는 `stationCode`가
없습니다.

이 provider는 `ver`를 전송하지 않고 `stationCode`를 전혀 소비하지 않으므로, 이 모순은 이
provider의 동작에 영향을 주지 않습니다 — raw schema에 `stationCode`를 선언하지 않고, 다른
미사용 필드(`addr`)와 함께 Zod 기본 unknown-key strip으로 제거됩니다.

### 이 provider가 실제로 소비하는 필드

`airKoreaNearbyStationItemSchema`(`nearby-station-raw-schema.ts`)는 이 provider가 실제로
소비하는 필드만 선언하며, 문서의 필수/옵션 구분을 그대로 반영합니다:

* **필수 문자열** (항목구분: 1 — 키 자체가 없으면 malformed 응답으로 거부): `stationName`,
  `tm`.
* `stationCode`/`addr`는 선언하지 않으며(위 참고), Zod 기본 unknown-key strip으로 제거됩니다.

`stationName`의 항목크기(30)는 PR #82의 측정소별 실시간 측정정보 조회와 동일하게 문서화되어
있으므로, 이 provider는 `isAirKoreaStationName`(`current-request.ts`)을 재사용합니다 — 같은
namespace(`apps/api/src/providers/airkorea/`) 내부 재사용이며, KMA(`../kma/*`)로부터의
cross-provider import가 아닙니다.

**AirKorea 고유 raw 타입/스키마는 최소한만 export됩니다** — 원본 raw 타입(`AirKoreaNearbyStationItem`
등)은 이 provider의 provider-level 결과(`AirKoreaNearbyStationCandidate`)로 변환된 뒤에는 더 이상
필요하지 않습니다.

`response.header`/`response.body.numOfRows`/`pageNo`/`totalCount`의 envelope 스키마는 PR #82의
`current-raw-schema.ts`에서 정의한 `airKoreaResponseHeaderSchema`/`airKoreaResponseEnvelopeSchema`/
`AIRKOREA_SUCCESS_RESULT_CODE`를 그대로 재사용합니다 — 두 operation 모두 같은 `B552584`
공공데이터포털 서비스 계열이고 동일한 `resultCode`(2자리)/`resultMsg` header envelope를
문서화하므로, 이는 같은 provider namespace 내부의 정당한 재사용이며 KMA로부터의 cross-provider
import가 아닙니다.

### 거리(`tm`, km) 파싱

문서의 요청/응답 메시지 예제(§ d)는 `tm`을 XML 텍스트(`<tm>8.2</tm>`)로만 보여줍니다 — JSON
샘플은 제공되지 않습니다(PR #82의 `khaiValue` 등과 동일한 gap). PR #82의 선례를 따라, 이
provider는 `returnType=json` 요청에서도 `tm`을 문자열로 취급합니다 — raw schema는 문자열
존재만 검증하고(`airKoreaNearbyStationDistance = z.string()`), 실제 숫자 파싱은
`parseAirKoreaNearbyStationDistanceKm`(`nearby-station-raw-schema.ts`)가 담당합니다.

`tm`에는 (PR #82의 `khaiValue: "-"`와 달리) 문서에 명시된 "결측치" sentinel이 없습니다 — 반환된
측정소까지의 거리는 항상 계산 가능한 값이므로, 결측 표현을 허용하지 않습니다. 파싱 규칙:

* 정규식 `^\d+(\.\d+)?$` — 부호 없는 순수 십진 표기(정수 또는 소수)만 허용, 지수 표기·음수·빈
  문자열·AirKorea sentinel(`"-"`) 모두 거부.
* 위 정규식을 통과해도 `Number()` 변환 결과가 `Number.isFinite`가 아니면(예: 400자리 숫자
  문자열이 `Infinity`로 오버플로) 거부 — malformed 텍스트를 정상 거리로 승격하지 않습니다.
* 위 두 조건을 모두 만족하는 경우에만 finite, non-negative 숫자를 반환합니다.

## "가장 가까운 측정소" 미선택 정책

문서 어디에도 근접측정소 목록의 정렬 순서(정렬/오름차순/내림차순/가까운 순 등)를 보장하는
문구가 없습니다. § d의 요청/응답 예제는 우연히 `tm` 오름차순(`8.2`, `9.3`, `9.7`)으로 나타나지만,
이는 예제 하나의 우연한 관찰일 뿐 문서가 보장하는 계약이 아닙니다. 따라서:

* `stations[0]`을 "가장 가까운 측정소"로 간주하지 않습니다.
* 이 provider는 최종 station 하나를 선택하지 않습니다 — upstream이 반환한 순서 그대로
  `AirKoreaNearbyStationCandidate[]`를 반환합니다.
* upstream array order를 비즈니스 정책으로 사용하지 않습니다.

closest-station 선택 정책은 후속 resolver PR의 책임입니다.

## Incomplete result (fail-closed) 정책

이 operation은 `pageNo`/`numOfRows` 요청 파라미터를 전혀 노출하지 않으므로(§ "공식 요청
파라미터" 참고), caller는 나머지 결과를 다시 요청할 방법이 없습니다. 동시에 문서는 반환
순서를 보장하지 않으므로(위 "가장 가까운 측정소 미선택 정책" 참고), 후속 resolver는 "이미
반환된 후보들 중 최소 거리"가 아니라 "전체 후보들 중 최소 거리"를 계산해야 합니다. 따라서:

```
totalCount > items.length
```

인 응답(공식 `totalCount`가 실제 반환된 item 개수보다 큰 경우)은 **불완전한 candidate 집합**이며,
완전한 성공으로 취급하면 후속 resolver가 실제로는 더 가까울 수 있는 미반환 후보를 놓친 채 "최소
거리"를 계산하게 됩니다. 이 provider는 이 경우를 명시적인 실패로 처리합니다.

```ts
{ kind: 'INCOMPLETE_RESULT'; totalCount: number; receivedCount: number }
```

`interpretNearbyStationPage`의 판정 순서는 다음과 같습니다(이 순서가 중요합니다 — `totalCount`가
양수이면서 반환된 item이 0개인 응답은 "결과 없음"이 아니라 "불완전한 결과"입니다):

1. `totalCount > items.length` → `INCOMPLETE_RESULT { totalCount, receivedCount }`
2. `items.length === 0` (즉 `totalCount === 0`) → `NO_DATA`
3. 그 외 → 모든 item의 거리를 파싱해 성공 candidate 목록 반환

예:

| `totalCount` | `items.length` | 결과 |
| --- | --- | --- |
| 3 | 2 | `INCOMPLETE_RESULT { totalCount: 3, receivedCount: 2 }` |
| 1 | 0 | `INCOMPLETE_RESULT { totalCount: 1, receivedCount: 0 }` (NO_DATA 아님) |
| 0 | 0 | `NO_DATA` |
| 2 | 2 | 정상 성공 |

명확히 해 둘 것:

* 페이지네이션 프레임워크를 추가하지 않았습니다 — 이 provider는 여전히 요청 파라미터로
  `pageNo`/`numOfRows`를 보내지 않으며, 추가 API 호출도 수행하지 않습니다.
* 결측 후보를 만들어내지 않습니다 — `receivedCount`만큼만 반환되었다는 사실을 그대로 보고할
  뿐, 나머지 `totalCount - receivedCount`개를 추정/보간하지 않습니다.
* 이 provider는 여전히 최종 station을 선택하지 않습니다.
* raw schema(`nearby-station-raw-schema.ts`)의 `superRefine`은 여전히 `totalCount === 0`이면
  item이 없어야 한다는 것과 `itemCount`가 `totalCount`/`numOfRows`를 초과하지 않는다는 것만
  강제합니다 — `totalCount > itemCount`(불완전 페이지)는 구조적으로 유효한 응답이며, 이를
  malformed로 거부하지 않습니다. "totalCount === items.length여야 한다"는 인위적인 raw-schema
  불변식을 추가하지 않았습니다 — completeness 정책은 raw schema가 아니라 provider의
  semantic 책임입니다.

## Provider 공개 계약

```ts
interface AirKoreaNearbyStationProvider {
  fetchNearbyStations(
    request: AirKoreaNearbyStationRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<AirKoreaNearbyStationProviderResult>;
}
```

성공 결과는 validated station candidate 배열만 노출합니다 — raw body, URL, 서비스키,
`stationCode`/`addr`는 전혀 포함되지 않습니다.

```ts
interface AirKoreaNearbyStationCandidate {
  readonly stationName: string;
  readonly distanceKm: number;
}
```

실패 kind: `INVALID_REQUEST`, `TIMEOUT`, `ABORTED`, `NETWORK_ERROR`, `HTTP_ERROR`,
`RESPONSE_TOO_LARGE`, `EMPTY_RESPONSE`, `NON_JSON_RESPONSE`, `INVALID_JSON`,
`AIRKOREA_UPSTREAM_ERROR`(2자리 `resultCode`만), `AIRKOREA_INVALID_RESPONSE`(sanitized issues만),
`MALFORMED_DISTANCE`, `INCOMPLETE_RESULT { totalCount, receivedCount }`(위 "Incomplete result
(fail-closed) 정책" 참고), `NO_DATA`. PR #82의 `RESPONSE_MISMATCH`에 대응하는 kind는 없습니다 —
이 operation은 caller가 `pageNo`/`numOfRows`/`stationName`을 보내지 않으므로 request/response
correlation 검사 자체가 적용되지 않습니다. `INCOMPLETE_RESULT`는 PR #82의 `INCOMPLETE_PAGE`와
같은 원리(공식 `totalCount`가 반환된 item 개수보다 큰 경우 fail-closed)이지만 이 provider 고유의
completeness 정책이며, `numOfRows`/`totalCount`/item 개수 간의 구조적 self-consistency(예:
`itemCount`가 `totalCount`를 초과)는 PR #82와 동일한 defensive `superRefine`(raw schema 단계)이
여전히 `AIRKOREA_INVALID_RESPONSE`로 처리합니다.

`createAirKoreaNearbyStationProvider(options)` / `…FromEnv(env?, dependencies?)`는 PR #82의
current-air-quality provider와 완전히 같은 `AirKoreaProviderOptions`/`AIRKOREA_SERVICE_KEY`/
`timeoutMs`/`maxResponseBytes` 정책을 공유합니다(`config.ts` 재사용, 새 config 모듈 없음) —
construction 시 fetch·환경변수 읽기·로깅 없음, `FromEnv`는 호출 시점에만 `AIRKOREA_SERVICE_KEY`
하나만 읽음, 설정 실패는 값으로 반환(throw 없음), 서비스키는 어떤 에러에도 포함되지 않습니다.

## Transport / 보안

이 provider는 **새 transport를 만들지 않습니다** — `provider.ts` 안에 이미 있는(PR #82의)
module-private `performAirKoreaGetRequest`를 그대로 재사용합니다. 즉 다음 모두 PR #82와 동일한
단일 구현을 공유합니다:

* `fetchImpl` 주입(기본 `globalThis.fetch`), `timeoutMs`(기본 10,000ms), `maxResponseBytes`(기본
  4 MiB) — project defensive 값, 공식 문서에 명시된 값 아님(문서의 평균응답시간은 500ms).
* GET만, `Accept: application/json`, `redirect: 'error'`.
* caller `AbortSignal`과 내부 timeout이 fetch·body read 전체를 감쌈. 이미 abort된 signal은
  fetch를 0회 수행하고 즉시 `ABORTED`를 반환.
* `read-response.ts`의 `Content-Length` 사전 체크 + 스트리밍 바이트 카운트 응답 크기 제한.
* 어떤 실패 variant도 서비스키·raw body·URL·업스트림 원문 메시지·예외 메시지/스택을 포함하지
  않음.
* 재시도·캐시 없음.

PR #82의 current-air-quality provider의 runtime semantics는 이 PR에서 전혀 변경되지 않았습니다
(`provider.test.ts`/`read-response.test.ts`가 회귀 없이 그대로 통과).

## 실제 인증 API 검증 상태

**실제 인증 서비스키를 사용한 AirKorea API 호출은 수행하지 않았습니다.** 모든 request/response
shape 근거는 위 공식 기술문서의 텍스트·요청응답 예제에서만 가져왔습니다. 아래는 문서만으로는
100% 확정할 수 없어 향후 인증된 실응답으로 재확인이 필요한 항목입니다.

* JSON 직렬화에서 `tm`이 실제로 문자열로 나타나는지(문서 예제는 XML만 제공).
* `stationCode`가 no-version 요청에서 실제로 완전히 생략되는지(§ c 응답 표와 § d 예제 사이의
  문서 내 모순 — 위 "stationCode의 문서 내 모순" 참고).
* `numOfRows`의 실제 서버 기본값이 문서 예제와 같이 10인지, 아니면 다른 상황에서 달라지는지.
* 근접측정소 목록의 실제 정렬 순서(있다면)가 항상 일관되는지 — 이 provider는 이를 가정하지
  않으므로 검증 결과와 무관하게 동작이 바뀌지 않습니다.

### Zero-result(결과 없음) JSON 직렬화 — 미검증 evidence gap

**사실**: 응답 필드 표(§ c)는 `items`의 항목크기를 `0..n`으로 표기하여 0개 결과가 가능함을
시사하지만, 기술문서는 이 operation에 대해 0개 결과(zero-result) 응답의 예제를 전혀 제공하지
않습니다 — § d의 요청/응답 메시지 예제는 3개 결과가 반환되는 경우만 보여줍니다. 즉 zero-result
응답이 JSON으로 실제 어떻게 직렬화되는지에 대한 공식 자료(JSON 예제 포함)는 존재하지 않습니다.

**현재 프로젝트 가정 / fail-closed boundary**: 이 provider는 현재 다음 JSON 형태를 만났을 때만
"결과 없음"(`totalCount === 0`이고 반환된 item이 0개)을 성공적인 `NO_DATA`로 인식합니다:

```json
{ "items": { "item": [] } }
```

이 정확한 zero-result JSON 직렬화 형태는 **공식적으로 검증되지 않았습니다** — 문서가 제공하는
것은 항목크기 표기(`0..n`)뿐이며, 실제 zero-result JSON 예제가 아닙니다.

**결과**: 만약 실제 인증된 API가 0개 결과를 `items` 필드 자체를 생략하거나, `null`로 채우거나,
다른 형태로 직렬화한다면, 현재 runtime은 이를 `NO_DATA`가 아니라 `AIRKOREA_INVALID_RESPONSE`로
분류합니다(raw schema가 `items: { item: [...] }` 형태를 필수로 요구하므로). 이 프로젝트는 근거
없는 permissive 형태(예: `items`가 없거나 `null`인 경우까지 허용)를 추측만으로 미리 추가하지
않습니다 — 이는 향후 인증된 integration/QA 단계에서 반드시 재확인해야 할 항목입니다(위 "실제
인증 API 검증 상태" 목록에 포함).

이 gap을 공식적으로 검증된 no-data 표현으로 오인해서는 안 됩니다 — 이는 문서의 항목크기
표기(`0..n`)로부터 유추한 project-owned 가정일 뿐입니다.

## 범위 확인 (이 PR에서 구현하지 않은 것)

* WGS84 위도/경도 → TM 좌표 변환 (`getTMStdrCrdnt` 포함)
* 행정구역(읍면동) → TM 기준좌표 변환
* 최종 closest-station 선택(단일 station 결정) 정책
* 측정소 caching, fallback
* application service, production composition
* `POST /weather` 연결, `WeatherOverview.airQuality.current`/향후 대기질 조립에 이 provider를
  연결하는 작업
* AirKorea 측정소 목록 조회(`getMsrstnList`) — 이 dataset의 다른 operation
* 재시도/backoff, 응답 캐시
* mobile UI
* 실제 AirKorea endpoint 호출, 실제 `AIRKOREA_SERVICE_KEY`, 실제 사용자 좌표
