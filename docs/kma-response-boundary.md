# KMA 원본 응답 경계 (Response Boundary)

이 문서는 `apps/api`가 기상청(KMA) 단기예보·초단기예보의 **원본 JSON 응답**을 백엔드 내부에서
런타임 검증하고, 성공·오류를 분류하며, forecast slot으로 그룹화하는 경계를 기록합니다. 매핑의
근거는 아래 공식 자료이며, 블로그·개인 저장소·Stack Overflow·비공식 샘플은 근거로 사용하지
않았습니다.

이 PR(#4)은 **원본 JSON 구조 검증과 slot 추출까지만** 구현합니다. 실제 HTTP 호출, `fetch`,
`KMA_SERVICE_KEY` 읽기, query/URL 인코딩, timeout, retry, Provider class, weather-core
normalizer 연결, API route는 **아직 존재하지 않으며** 후속 PR 범위입니다.

구현 위치:

- [raw-schema.ts](../apps/api/src/providers/kma/raw-schema.ts) — 외부 JSON 구조의 런타임(Zod) 검증
- [parse-response.ts](../apps/api/src/providers/kma/parse-response.ts) — 성공·upstream error·invalid response 분류
- [group-forecast-items.ts](../apps/api/src/providers/kma/group-forecast-items.ts) — 검증된 item 배열의 slot 그룹화 및 field-presence 모델
- [index.ts](../apps/api/src/providers/kma/index.ts) — KMA 경계 공개 API

## 출처

| 항목 | 값 |
| --- | --- |
| 공식 서비스명 | 기상청_단기예보 조회서비스 |
| 공공데이터 ID | `15084084` |
| 공식 활용가이드 파일명 | `기상청41_단기예보 조회서비스_오픈API활용가이드_2607.zip` |
| 활용가이드 버전 | `2607` |
| 서비스(오퍼레이션) 버전 | `VilageFcstInfoService_2.0` |
| 확인 날짜 | 2026-07-16 |
| 확인 주체 | Claude (Claude Code) — 공식 문서(응답 명세·상세기능 표) 확인. **인증된 실제 JSON 응답 fixture는 PR #5에서도 확보하지 못함** — 실제 service key를 이용한 후속 live integration 검증 대상 |

### 검증된 공식 파일 SHA-256

| 파일 | SHA-256 | 검증 주체 |
| --- | --- | --- |
| 공식 ZIP (`…_2607.zip`) | `07f53cd9d6d6512bce6ef870d54cb740046a0a949896e6855caecf739fb8842e` | Codex 독립 리뷰(PR #3), 이번 PR에서는 재확인 못함 |
| 내부 DOCX (2607) | `20d855aa3071a2bdda6dce3c13bab6428ebb02f8d4a30688e26ed0851d6d0848` | Codex 독립 리뷰(PR #3), 이번 PR에서는 재확인 못함 |

> **이번 PR의 ZIP 확보 여부.** 이번 PR 작업 환경에서는 `…_2607.zip`(및 내부 DOCX)을 로컬로
> 확보하지 못해 위 SHA-256을 **재계산하지 못했습니다.** 위 값은 PR #3에서 Codex 독립 리뷰가
> 공식 배포본으로 검증한 값을 그대로 재기록한 것입니다. 같은 파일명이라도 내용이 교체되면 값이
> 달라지므로, 로컬에 보관한 ZIP/DOCX로 다시 계산해 위 값과 일치할 때만 근거로 사용해야 합니다.
> 공식 ZIP/DOCX 자체는 저장소에 커밋하지 않습니다.

### 이번 PR에서 실제로 확인에 사용한 공식 자료와 근거 수준

이 경계의 envelope 구조와 각 필드의 **명세(항목명/타입/시각 형식/에러코드)** 는 아래 **공식**
자료에서 확인했습니다. 다만 **직렬화된 실제 JSON 응답 sample과 JSON scalar 타입 전체를 공식 자료가
완전히 제공하지는 않습니다.** 공식 응답 예제는 **XML 중심**이고, 공공데이터포털 상세기능 표는 필드
타입 명세는 주지만 완전한 JSON sample을 주지 않습니다. 따라서 아래 JSON boundary 타입은 **공식
응답 명세와 공공데이터포털 필드 타입을 기준으로 설정**했습니다. **인증된 실제 JSON 응답 fixture는
PR #5에서도 확보하지 못했으며, JSON scalar 형태·`fcstValue` literal null·빈 success page 및
초단기예보 POP의 실제 반환 형태는 실제 service key를 이용한 후속 live integration 검증 대상으로
남아 있습니다.** 이 문서는 어디까지가 공식 명세 근거이고 어디부터가 방어적 정책인지를 아래에서
명시적으로 구분합니다.

1. 공공데이터포털 데이터 상세: `data.go.kr` → `publicDataPk=15084084` (성공 응답 `resultCode`
   `"00"` 및 상세기능 필드/타입 목록 확인).
2. 기상청 API 허브 공식 활용가이드 문서
   `단기예보 조회서비스_API활용가이드.docx`(`https://apihub.kma.go.kr/getAttachFile.do`,
   `VilageFcstInfoService_2.0`) — 응답 메시지 명세(항목명/타입/샘플), 시각 형식(`HH24MI`),
   에러코드 표를 원문으로 확인. 이 파일의 SHA-256:
   `6e110dd509703c259ee15e2930dcf1569acc2f708bcb38c40e954232661cbe54`.

> 위 apihub 가이드는 동일 서비스(`VilageFcstInfoService_2.0`)의 **공식** 문서이지만 파일명·버전이
> `…_2607.zip`과 다른 별도 배포본입니다(그래서 SHA-256도 다릅니다). item 구조·타입·시각 형식·
> 에러코드는 두 자료에서 일치합니다. 이 공식 파일 역시 저장소에 커밋하지 않습니다.
>
> **근거 수준 요약.** 공식 문서에서 envelope와 필드 명세는 확인했으나, (1) 공식 예시는 XML 중심이고,
> (2) 완전한 JSON sample과 일부 JSON scalar 세부(특히 `fcstValue`의 literal `null` 여부)는 공식
> 자료에서 재현 가능하게 확인하지 못했습니다. 이 부분은 **방어적으로** 모델링했고, 인증된 실제 JSON
> 응답으로 재확인하는 작업은 실제 service key를 이용한 후속 live integration 검증 대상입니다(특정
> 완료 PR에서 검증되지 않음).

## 대상 operation

- 단기예보 `getVilageFcst` — `SHORT_FORECAST`
- 초단기예보 `getUltraSrtFcst` — `ULTRA_SHORT_FORECAST`
- 초단기실황 `getUltraSrtNcst` — **이번 PR 범위 아님** (item 구조가 다름: `obsrValue`)

두 대상 operation의 **item 구조는 동일**합니다(`baseDate`, `baseTime`, `category`, `fcstDate`,
`fcstTime`, `fcstValue`, `nx`, `ny`). 사용되는 category 코드 집합만 다르므로 하나의 item 스키마로
두 operation을 모두 검증합니다.

## JSON envelope 구조

성공 응답의 전체 envelope(공식 형태):

```json
{
  "response": {
    "header": { "resultCode": "00", "resultMsg": "NORMAL_SERVICE" },
    "body": {
      "dataType": "JSON",
      "items": {
        "item": [
          {
            "baseDate": "20240127",
            "baseTime": "0500",
            "category": "TMP",
            "fcstDate": "20240127",
            "fcstTime": "0600",
            "fcstValue": "-2",
            "nx": 61,
            "ny": 126
          }
        ]
      },
      "pageNo": 1,
      "numOfRows": 12,
      "totalCount": 809
    }
  }
}
```

### JSON scalar 타입과 스키마 (근거: 공식 명세 + 공공데이터포털 필드 타입)

아래 타입은 **공식 응답 명세와 공공데이터포털 상세기능 필드 타입을 기준**으로 설정했습니다(위
"근거 수준" 참조). `z.coerce`를 쓰지 않아 문자열↔숫자 자동 변환을 하지 않습니다. 단기예보와
초단기예보 item의 타입은 **동일**합니다.

| 필드 | 위치 | JSON 타입 | 스키마 | 근거 수준 |
| --- | --- | --- | --- | --- |
| `resultCode` | header | string (예 `"00"`) | **정확히 2자리 숫자** `/^\d{2}$/` (coercion 금지) | 명세(에러코드 표는 모두 2자리) |
| `resultMsg` | header | string | `z.string()` (구조 검증용, 공개 오류에는 비노출) | 명세 |
| `dataType` | body | string (예 `"JSON"`) | **`z.literal('JSON')`** (이 경계는 JSON 전용) | 명세 + 경계 성격 |
| `pageNo` | body | number | 정수 `>= 1` | 명세 |
| `numOfRows` | body | number | 정수 `>= 1` | 명세 |
| `totalCount` | body | number | 정수 `>= 0` | 명세 |
| `baseDate` | item | string `YYYYMMDD` | 실제 달력 날짜 검증 | 명세/샘플 |
| `baseTime` | item | string `HHmm` (`HH24MI`) | 시 00–23 / 분 00–59 | 명세/샘플 |
| `category` | item | string | **`/^[A-Z0-9]+$/`** (ASCII 대문자·숫자만) | 공식 현재 코드 형식 |
| `fcstDate` | item | string `YYYYMMDD` | 실제 달력 날짜 검증 | 명세/샘플 |
| `fcstTime` | item | string `HHmm` (`HH24MI`) | 시 00–23 / 분 00–59 | 명세/샘플 |
| `fcstValue` | item | string 또는 `null` | `z.string().nullable()` | 문자열=명세 / **`null`=방어적(미확인)** |
| `nx` | item | number | 정수 `>= 0` | 명세/샘플 |
| `ny` | item | number | 정수 `>= 0` | 명세/샘플 |

주요 강화(이번 PR):

- **`dataType`는 정확히 `"JSON"`만 성공**입니다. 이 경계는 이미 `JSON.parse`된 JSON 응답 전용이므로
  `"XML"`·빈 문자열·`"json"`·임의 문자열은 성공 body가 아니라 `INVALID_RESPONSE`입니다.
- **`resultCode`는 정확히 두 자리 숫자**(`00`/`03`/`30`/`99` 등)만 유효합니다. enum이 아니므로
  알려지지 않은 **미래 두 자리 오류 코드**도 구조적으로 유효하지만, `""`/`"0"`/`"000"`/`"AB"`/
  `" 03 "`/`"03 "`/`"+3"` 같은 malformed 코드는 header 자체가 무효이므로 `INVALID_RESPONSE`이며,
  절대 upstream error로 오분류하지 않습니다.
- **`category`는 ASCII 대문자·숫자(`[A-Z0-9]+`)** 로 제한합니다. 내부 space/tab/newline, 앞뒤 공백,
  제어문자, 소문자, 하이픈·underscore, 한글은 거부합니다. 여전히 enum이 아니므로 **패턴에 맞는
  미지·미래 코드는 통과**합니다(공식 현재 코드가 이 문자 클래스를 벗어난다는 근거는 없음).

### 문서와 sample 간 타입/표기 충돌 및 선택

| 충돌 필드 | 공식 원문/샘플 | 선택한 스키마 | 이유 / 남은 위험 |
| --- | --- | --- | --- |
| `baseTime` 자릿수 | 응답 명세 "항목크기" 열이 단기예보에서 `6`으로 표기되나 샘플은 `"0500"`(4자리)이고 형식은 `HH24MI` | `HHmm` 4자리, 시 00–23·분 00–59 | 샘플·형식·초단기예보 명세(4)와 일치. "6"은 문서 오타로 판단 |
| `resultCode` | 응답 명세 항목크기 `2`, 샘플 `"00"`, 에러코드 표는 모두 2자리. XML 예시 본문은 `0`으로 축약 표기 | **정확히 2자리 숫자** `/^\d{2}$/` (coercion 금지) | 명세·에러코드 표(모두 2자리) 우선. XML 축약은 근거로 쓰지 않음. malformed 코드는 upstream error가 아니라 invalid response |
| `nx`/`ny` 범위 | 항목크기 `2`로 표기되나 샘플이 `127`(3자리) | 정수 `>= 0`, 상한 미적용 | 문서가 유효 범위를 신뢰성 있게 명시하지 않아 상한을 추측하지 않음. 위경도→grid 변환은 이 PR 범위 아님 |
| `fcstValue` 타입 | 명세상 문자열(TMP 등 "실수로 제공" 자료도 `"-2"` 형태). **공식 JSON에 number·literal `null` 표기는 확인 안 됨** | `string \| null` (number 불가) | 아래 "fcstValue 정책" 참조. **근거 성격**: 문자열은 명세 근거, `null`은 field-presence 모델용 **방어적 허용**(미확인). 실제 키를 이용한 후속 live 통합 검증에서 재확인 대상(완료된 PR에서 검증되지 않음) |

원문과 샘플이 충돌할 때는 임의로 하나를 고르지 않고, 위 표처럼 실제 공식 샘플·형식 설명을
우선하고 선택 근거와 남은 위험을 기록했습니다.

## 성공·오류·잘못된 응답 분류

공개 함수: `parseKmaForecastResponse(input: unknown): ParseKmaForecastResponseResult`.

이 함수는 **throw하지 않고**, `unknown` 입력(호출자가 `JSON.parse` 완료)을 받아 discriminated
result를 반환하며, 입력을 변경하지 않습니다. 판정 순서:

1. `response.header`(**2자리 숫자** `resultCode` + `resultMsg` 문자열)가 유효하지 않으면 →
   `INVALID_RESPONSE`. malformed `resultCode`(`""`/`"0"`/`"000"`/`"AB"`/`" 03 "` 등)는 여기서
   걸러져 invalid response가 되며, upstream error로 오분류하지 않습니다.
2. header는 유효하지만 `resultCode`가 성공 코드가 아니면 → `UPSTREAM_ERROR`(**공식 2자리
   `resultCode`만** 보존, raw `resultMsg`는 비노출).
3. `resultCode`가 성공 코드(`"00"`)이면 body 전체를 검증 → 실패 시 `INVALID_RESPONSE`, 성공 시
   `ok: true`와 page.

```ts
type ParseKmaForecastResponseResult =
  | { ok: true; page: KmaForecastPage }
  | { ok: false; error: KmaForecastResponseError };

type KmaForecastResponseError =
  // raw resultMsg는 공개 오류에 포함하지 않는다 (resultCode만 보존)
  | { kind: 'UPSTREAM_ERROR'; resultCode: string }
  | { kind: 'INVALID_RESPONSE'; issues: readonly KmaResponseIssue[] };
```

### 성공 응답 판정

`response.header`가 구조적으로 유효하고 `resultCode === "00"`(NORMAL_SERVICE)이며 body가
스키마에 통과할 때만 성공(`ok: true`)입니다. 성공 page:

```ts
interface KmaForecastPage {
  dataType: 'JSON';
  pageNo: number;
  numOfRows: number;
  totalCount: number;
  items: readonly KmaForecastItem[];
}
```

`totalCount`와 현재 page의 item 수가 같다고 **가정하지 않습니다.** pagination 때문에 현재 page의
item 수가 `totalCount`보다 작을 수 있으며, 스키마는 이 둘의 동일성을 검증하지 않습니다.

#### pagination 불변조건 (명백한 모순만 거부)

개별 필드 검증에 더해, **한 page 안에서 자기모순**인 조합만 `superRefine`으로 거부합니다(정책
추측이 아니라 산술적 모순).

```text
items.item.length <= numOfRows          (page는 자기 page 크기보다 많은 row를 담을 수 없음)
items.item.length <= totalCount         (page는 전체 개수보다 많은 item을 담을 수 없음)
totalCount === 0 이면 items.item === []  (총 0건인데 item이 있으면 모순)
```

거부 예: `totalCount = 0` + item 존재, `item.length > numOfRows`, `item.length > totalCount`.

허용 예(정상 pagination): `numOfRows=100, totalCount=809, item.length=100`(가득 찬 page),
`numOfRows=100, totalCount=809, item.length=9`(마지막 page), `totalCount > item.length`.

**강제하지 않는 관계**: `item.length === totalCount`는 pagination 때문에 강제하지 않습니다. 또한
다음은 **방어적으로 허용**합니다(뒤 "빈 성공 page 정책" 참조).

```text
totalCount > 0 이면서 item.length === 0
```

이 경우 공식 empty success page 근거는 부족하지만 page 범위를 넘긴 요청 등의 가능성을 배제할 수
없어 이번 PR에서는 **merge 차단 규칙으로 만들지 않고 허용**하며, 실제 service key를 이용한 후속 live
integration 검증에서 재평가합니다.

### upstream error 판정

`response.header`가 구조적으로 유효하고 `resultCode`가 성공 코드가 **아닌** 모든 경우입니다.
공식 에러코드 표(아래) 기준으로 `03`(NODATA_ERROR, "데이터없음") 역시 성공 코드가 아니므로
**UPSTREAM_ERROR**로 분류합니다. 이렇게 하면 데이터 없음 응답의 body 형태가 어떻든(빈 배열/빈
문자열 등) body를 파싱하지 않고 안전하게 처리합니다.

- throw하지 않습니다.
- body가 없더라도 header가 유효한 오류 형태이면 upstream error로 분류합니다.
- 임의의 KMA 오류 코드를 enum으로 제한하지 않고 **공식 2자리 `resultCode`만** 보존합니다.
  알려지지 않은 유효한 두 자리 오류 code(예: `99`)도 그대로 upstream error입니다.
- **raw `resultMsg`는 공개 오류에 포함하지 않습니다.** upstream이 보낸 `resultMsg`는 신뢰할 수
  없는 문자열이라 service-key 형태 토큰·CR/LF·log-injection·비정상적으로 긴 내부 메시지를 담을 수
  있으므로, 공개 오류 surface에 그대로 복사하지 않습니다(정상 공식 message도 복사하지 않음).
  필요하면 `resultCode`로부터 안전한 canonical message를 앱 내부에서 생성할 수 있습니다. logger가
  없는 이번 PR에서는 raw `resultMsg` 로깅을 추가하지 않으며, 내부 보안 로깅(길이·제어문자 제한)은
  PR #5에서 별도 설계합니다.
- 서비스 키·요청 URL·raw response 전체를 error에 포함하지 않습니다.

공식 에러코드 표(가이드 원문, `resultCode`는 2자리 숫자 문자열):

| resultCode | resultMsg | 의미 | 분류 |
| --- | --- | --- | --- |
| `00` | NORMAL_SERVICE | 정상 | 성공 |
| `01` | APPLICATION_ERROR | 어플리케이션 에러 | upstream error |
| `02` | DB_ERROR | 데이터베이스 에러 | upstream error |
| `03` | NODATA_ERROR | 데이터없음 | upstream error |
| `04` | HTTP_ERROR | HTTP 에러 | upstream error |
| `05` | SERVICETIME_OUT | 서비스 연결실패 에러 | upstream error |
| `10`~`12` | INVALID/NO_MANDATORY/NO_OPENAPI… | 요청 파라미터/서비스 오류 | upstream error |
| `20`~`22` | SERVICE_ACCESS/…_authKey/LIMITED… | 접근/키/횟수 오류 | upstream error |
| `30`~`33` | SERVICE_KEY_IS_NOT_REGISTERED / DEADLINE / IP / UNSIGNED | 키/IP/서명 오류 | upstream error |
| `99` | UNKNOWN_ERROR | 기타에러 | upstream error |

> 참고: 공공데이터포털 **게이트웨이** 오류(`OpenAPI_ServiceResponse`/`cmmMsgHeader` 형태, 예
> 서비스키 미등록)는 `response.header` 구조가 아니므로 이 경계에서는 `INVALID_RESPONSE`로
> 분류됩니다. 게이트웨이 오류 매핑은 서비스 키/HTTP 계층과 함께 PR #5에서 다룹니다.

### invalid response 판정

다음은 모두 `INVALID_RESPONSE`입니다.

- outer envelope·header 누락, `response`가 객체가 아님, 원시값/`null`/배열 입력
- **malformed `resultCode`**(2자리 숫자가 아님) — upstream error가 아니라 invalid response
- 성공 code인데 body 누락 또는 body 구조 오류
- 성공 code인데 **`dataType`가 `"JSON"`이 아님**(`"XML"`/빈 문자열/`"json"`/임의 값)
- `items.item`이 배열이 아님, item 필수 필드 누락
- 잘못된 날짜/시간, 잘못된 scalar 타입, **pagination 명백한 모순**(위 불변조건), 오염된 category
  (`[A-Z0-9]+` 위반)

`INVALID_RESPONSE`는 Zod error 객체를 그대로 노출하지 않고 **sanitized issue** 배열로 반환합니다.

```ts
interface KmaResponseIssue {
  path: readonly (string | number)[];
  message: string;
}
```

- issue에는 `path`와 (값이 포함되지 않은) `message`만 담습니다.
- raw input value, 전체 response body, service key 형태 문자열, stack trace는 포함하지 않습니다.
- issue 순서는 `(path, message)` 기준 코드유닛 비교로 정렬해 **결정론적**입니다. path segment는
  segment 경계가 사라지지 않도록 **구분자(U+001F)로 join**해 비교하므로 `['a','bc']`와
  `['ab','c']`가 같은 key로 뭉개지지 않습니다. 테스트는 이 정렬을 재구현하지 않고 **명시적 기대
  순서**로 고정합니다.

### 보안: raw body를 오류에 넣지 않는 이유

오류 객체에 원본 응답을 그대로 담으면 (1) 신뢰할 수 없는 외부 payload가 로그·모니터링·응답
경로로 전파되고, (2) 인접 요청 컨텍스트의 민감 값이 함께 섞여 나갈 위험이 있습니다. 서비스 키는
요청 URL에만 있고 응답 본문에는 없지만, "값을 통째로 담지 않는다"는 규칙을 경계에서 강제하면
어떤 값도 오류로 새어나갈 수 없습니다. 그래서 upstream error는 **공식 2자리 `resultCode`만**
(raw `resultMsg` 비노출), invalid response는 `path`+`message`만 보존합니다.

특히 raw `resultMsg`는 upstream이 보낸 untrusted 문자열이라 secret 형태 토큰·CR/LF·log-injection
payload를 담을 수 있으므로, 공식 message가 실제 key를 포함할 가능성과 무관하게 공개 오류 surface에
그대로 복사하지 않습니다(정상 message도 마찬가지).

## Forecast item 그룹화

공개 함수: `groupKmaForecastItems(product, items): GroupKmaForecastItemsResult`,
`getKmaForecastField(slot, category): KmaForecastFieldLookup`.

검증된 item 배열을 시간별 slot으로 묶는 **순수·결정론적** 함수입니다. 네트워크·시스템 시각·전역
mutable state를 쓰지 않으며 입력 배열·item 객체를 변경하지 않습니다.

### Slot identity

동일 slot의 식별 기준(7개):

```text
product · baseDate · baseTime · fcstDate · fcstTime · nx · ny
```

`category`는 slot key에 포함하지 않습니다. 같은 slot 안에 여러 category item이 들어갑니다.
내부 slotKey는 `product|baseDate|baseTime|fcstDate|fcstTime|nx|ny` 형태 문자열이며(각 성분에
`|`가 나타날 수 없어 충돌 없음), duplicate 오류에 그대로 노출됩니다.

### field presence: ABSENT / NULL / VALUE

PR #3가 남긴 세 상태를 명시적으로 구분합니다. `undefined`로 상태를 암묵 표현하지 않습니다.

```text
category item 자체가 없음      → ABSENT
item은 있으나 fcstValue null   → NULL
item과 값이 존재               → VALUE
```

slot의 `fields`에는 존재하는 category만 담기고(각 항목은 `NULL` 또는 `VALUE`), 존재하지 않는
category는 `getKmaForecastField`가 `ABSENT`로 답합니다.

```ts
type KmaForecastField =
  | { category: string; state: 'NULL' }
  | { category: string; state: 'VALUE'; value: KmaForecastScalar };

type KmaForecastFieldLookup =
  | { state: 'ABSENT' }
  | { state: 'NULL' }
  | { state: 'VALUE'; value: KmaForecastScalar };
```

### fcstValue 정책과 scalar 타입

- **근거 수준.** `fcstValue`는 명세상 **문자열**입니다(TMP 등 "실수로 제공" 자료도 `"-2"`,
  `"6.2"`처럼 문자열 인코딩). 따라서 **number는 허용하지 않고**(coercion 금지), object/array도
  거부합니다. `KmaForecastScalar = string`으로 정의합니다. 다만 **공식 JSON literal `null` 사례는
  미확인**입니다(공식 예시가 XML 중심).
- `fcstValue` **필드 키 자체는 item에 필수**입니다. 값은 명시적 `null`일 수 있습니다.
  `z.string().nullable()`은 (1) 문자열 → 통과, (2) 명시적 `null` → 통과, (3) 키 누락 → 실패,
  (4) number/object/array → 실패로 동작합니다. 즉 **필드 누락과 명시적 null을 구분**합니다.
- **`fcstValue: null`은 방어적 허용입니다(공식 보장 아님).** 명시적 `null`을 허용하는 이유는
  field-presence 모델이 "필드 존재+null"(`NULL`)과 "필드 미존재"(`ABSENT`)를 구분해야 하기
  때문입니다(PR #3 [kma-normalization.md](./kma-normalization.md)가 요구한 항목). 이번 PR에서
  `null`을 거부하거나 다른 synthetic 상태로 변환하지 않으며, `null`을 값으로 강제 변환하지도
  않습니다. 실제로 `null`이 오지 않는다면 `NULL` 상태가 파싱 결과에서 도달 불가능해질 뿐 모델은
  그대로 유효합니다. 이 PR은 `fcstValue`를 PCP/SNO parser에 넘기지 않습니다(PR #5).
  **정리:** 공식 JSON literal null 사례는 미확인 → field-presence 경계를 위해 방어적으로 허용 →
  실제 키를 이용한 후속 live 통합 검증에서 인증된 실제 JSON 응답으로 재확인(특정 완료된 PR에서
  검증되지 않음).

### 빈 성공 page 정책 (공식 사례 미확인)

- **거부(명백한 모순):** `totalCount = 0`인데 `items.item`에 값이 존재 / `item.length > numOfRows`
  / `item.length > totalCount`.
- **방어적 허용(공식 근거 부족):** `resultCode = 00` + `totalCount > 0` + `items.item = []`. 공식
  empty success page 사례는 확인하지 못했지만 page 범위를 넘긴 요청 등의 가능성을 배제할 수 없어
  이번 PR에서는 **merge 차단 규칙으로 만들지 않고 허용**합니다. 실제 service key를 이용한 후속 live
  integration 검증에서 공식 API 응답으로 재평가합니다.
- **정상 허용:** `totalCount = 0` + `item = []`, 그리고 `totalCount > item.length`(일반 pagination).

### duplicate category 정책

같은 slot 안에 같은 category가 두 번 이상 나타나면 **마지막 값으로 덮어쓰지 않고**
`DUPLICATE_CATEGORY` 오류를 반환합니다. 값이 서로 같아도 오류입니다.

```ts
type GroupKmaForecastItemsResult =
  | { ok: true; slots: readonly KmaForecastSlot[] }
  | { ok: false; error: { kind: 'DUPLICATE_CATEGORY'; category: string; slotKey: string } };
```

이유: pagination 중복·upstream 이상 응답을 조용히 삼키지 않고, 무의식적 last-write-wins를
방지하며 결정론성을 보장하기 위함입니다. 중복이 여럿이면 `(slotKey, category)` 오름차순 최솟값을
보고해 입력 순서와 무관하게 동일한 오류를 냅니다.

### 정렬 정책

입력 item 순서와 무관하게 output은 결정론적으로 정렬합니다. locale 의존 정렬(`localeCompare`)을
쓰지 않고 UTF-16 코드유닛 비교(문자열)·수치 비교(nx/ny)를 사용합니다.

- slot 정렬 우선순위: `forecastDate → forecastTime → baseDate → baseTime → nx → ny → product`.
- 각 slot의 `fields`: `category` 오름차순.

서로 다른 slot은 7개 식별자 중 하나가 반드시 다르므로 정렬 비교에서 동률이 없어 순서가 유일하게
결정됩니다.

### unknown category 처리

`category`는 strict enum이 아니라 **`[A-Z0-9]+` 패턴**으로만 검증하므로, KMA가 새 category를
추가해도(같은 문자 클래스인 한) raw boundary는 이를 **보존**합니다. 내부 공백·tab·newline·제어문자·
소문자·하이픈·underscore 등 오염된 값은 거부합니다. 공통 상태 변환(SKY/PTY/PCP/SNO 등)은
weather-core의 별도 책임입니다([kma-normalization.md](./kma-normalization.md)).

## 데이터 부족 처리 요약

```text
envelope/header 없음, 원시값·배열·null 입력      → INVALID_RESPONSE
malformed resultCode(2자리 숫자 아님)            → INVALID_RESPONSE (upstream error 아님)
성공 코드 + body 누락/오류                        → INVALID_RESPONSE
성공 코드 + dataType != "JSON"                   → INVALID_RESPONSE
pagination 명백한 모순(0인데 item 존재 등)        → INVALID_RESPONSE
resultCode "03"(NODATA) 등 유효 비성공 코드      → UPSTREAM_ERROR (2자리 resultCode만 보존)
성공 코드 + item 빈 배열                          → ok:true, slots 없음 (totalCount>0+빈 배열은 방어적 허용)
category item 미존재                              → getKmaForecastField → ABSENT
item 존재 + fcstValue null                       → NULL (공식 미확인, 방어적 허용)
item 존재 + 값                                   → VALUE
```

## 실제 HTTP Provider (PR #5에서 구현됨)

이 PR(#4)은 원본 JSON 구조 검증·분류·slot 추출까지만 구현했습니다. 이후 **PR #5에서** `fetch`,
`KMA_SERVICE_KEY` 읽기, query/URL 인코딩, timeout/`AbortSignal`, HTTP status·gateway XML·JSON
오류 처리, 요청/응답 consistency 검증을 하는 **KMA HTTP Provider**가 이 경계 위에 구현되었습니다 —
[kma-http-provider.md](./kma-http-provider.md) 참고. PR #5 Provider는 이 문서의 parser
(`parseKmaForecastResponse`)와 slot grouping(`groupKmaForecastItems`)을 **변경 없이** 호출합니다.

**PR #6에서 weather-core normalizer 연결과 contracts `HourlyForecast` 정규화(normalized
contracts)는 구현 완료되었습니다**([kma-hourly-normalization.md](./kma-hourly-normalization.md)).
지금까지의 **구현 완료** 범위:

- PR #3: SKY/PTY/PCP/SNO weather-core primitive
- PR #6: TMP/T1H/POP/REH/WSD/VEC scalar parser
- PR #6: provider slot과 weather-core parser 연결
- PR #6: contracts `HourlyForecast` runtime 검증 및 정규화 adapter

여전히 **미구현**인 것: 자동 발표시각 선택, retry, cache, 공통 다중 Provider interface,
`/weather` API route, 위경도→KMA grid 변환, `CurrentWeather`, `DailyForecast`, `WeatherOverview`.
`fcstValue` literal null과 빈 success page는 여전히 인증된 실제 JSON 응답으로 재확인이 필요합니다
(PR #5 진단에서 가짜 키는 HTTP `401` 평문을 반환해 정상 성공 JSON을 재현하지 못함).

## 변경 이력

```text
v1 / PR #4 / 2026-07
- KMA 단기·초단기예보 JSON runtime schema 최초 도입
- 성공·upstream error·invalid response 분류 도입 (parser는 throw하지 않는 discriminated result)
- forecast slot 그룹화 및 field-presence 모델(ABSENT/NULL/VALUE) 도입
- duplicate category를 last-write-wins 대신 명시적 오류로 처리
- 결정론적 정렬(slot / fields)과 sanitized invalid-response issue 도입
- 출처: 기상청_단기예보 조회서비스(15084084), 활용가이드 2607(SHA-256 재계산은 이번 PR에서 못함),
  apihub VilageFcstInfoService_2.0 공식 가이드로 JSON 타입·에러코드 교차 확인, 확인일 2026-07-16

v2 / PR #4 / 2026-07 (Codex 독립 리뷰 반영 — runtime boundary 강화)
- dataType를 z.literal('JSON')로 제한 (XML/빈 값/소문자/임의 값 → INVALID_RESPONSE)
- resultCode를 정확히 2자리 숫자(/^\d{2}$/)로 제한. malformed 코드는 UPSTREAM_ERROR가 아니라
  INVALID_RESPONSE (미래 두 자리 오류 code는 계속 허용)
- KmaUpstreamError에서 raw resultMsg 제거 (2자리 resultCode만 보존). secret 형태 토큰·CR/LF가
  공개 오류로 새지 않음
- pagination 명백한 모순 거부(item>numOfRows, item>totalCount, totalCount=0인데 item 존재)
- category를 [A-Z0-9]+로 제한(내부 공백·tab·newline·제어문자·소문자·하이픈·underscore 거부)
- issue 정렬 테스트를 comparator 재구현 대신 명시적 기대 순서로 고정. 정렬 join 구분자(U+001F)로
  segment 경계 보존
- 근거 수준 정정: 공식 예시는 XML 중심이며 JSON scalar/빈 success page/fcstValue literal null은
  미확인 → 방어적 정책과 공식 명세 근거를 분리 기록, PR #5 실제 JSON 재검증 명시

v3 / PR #6 branch / 2026-07 (live 검증 상태 문구 정정)
- PR #5가 병합된 뒤에도 인증된 실제 forecast JSON fixture는 확보되지 않았음을 명시. 특정 후속 PR을
  fixture 검증 시점으로 지정하던 미래형 문구를 현재 상태 설명에서 제거.
- JSON scalar 형태·fcstValue literal null·빈 success page·초단기예보 POP 실제 반환 형태는 특정 완료
  PR이 아니라 실제 service key를 이용한 후속 live integration 검증 대상으로 통일해 기록.
- runtime 코드·스키마·테스트 assertion 무변경(문서 문구 한정).
```
