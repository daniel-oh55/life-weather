# KMA HTTP Forecast Provider

이 문서는 `apps/api`가 기상청(KMA) 단기·초단기예보를 **공공데이터포털 HTTP endpoint**에서 실제로
가져오는 Provider를 기록합니다. 이 Provider는 PR #4의 [원본 응답 경계](./kma-response-boundary.md)
(runtime schema·성공/오류 분류·slot 그룹화)를 실제 HTTPS `fetch`에 연결합니다.

이 PR(#5)의 범위는 **HTTP 호출과 응답 분류까지**입니다. KMA category를 공통 `HourlyForecast` /
`WeatherOverview` / contracts로 변환하는 최종 정규화, weather-core normalizer 연결, API route는
**아직 구현하지 않았으며** PR #6 이후 범위입니다.

구현 위치:

- [config.ts](../apps/api/src/providers/kma/config.ts) — 환경변수·Provider option 검증
- [request.ts](../apps/api/src/providers/kma/request.ts) — 요청 입력 검증, operation 매핑, URL 생성
- [read-response.ts](../apps/api/src/providers/kma/read-response.ts) — 응답 body 크기 제한 읽기
- [gateway-error.ts](../apps/api/src/providers/kma/gateway-error.ts) — 공공데이터포털 XML gateway 오류 최소 식별
- [provider.ts](../apps/api/src/providers/kma/provider.ts) — fetch·timeout·오류 분류·parse·correlation·grouping
- [validation.ts](../apps/api/src/providers/kma/validation.ts) — 날짜/시간/grid 검증 primitive (요청·응답 경계 공유)
- [index.ts](../apps/api/src/providers/kma/index.ts) — KMA 경계 공개 API

## 공식 자료

| 항목 | 값 |
| --- | --- |
| 공식 서비스명 | 기상청_단기예보 조회서비스 |
| 공공데이터 ID | `15084084` |
| 서비스(오퍼레이션) 버전 | `VilageFcstInfoService_2.0` |
| 공식 활용가이드 | `기상청41_단기예보 조회서비스_오픈API활용가이드_2607.zip` |
| 지원 형식 | JSON / XML (본 Provider는 JSON 고정) |
| endpoint (프로덕션) | `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0` |
| 확인 날짜 | 2026-07-17 |
| 확인 주체 | Claude (Claude Code) — 공공데이터포털 상세 페이지(오퍼레이션·요청 parameter·dataType 기본값·resultCode) 재확인. **인증된 실제 forecast JSON 응답은 미확보** |

### endpoint와 대상 operation

기본 base URL은 **HTTPS**입니다(평문 HTTP 대신 HTTPS 사용).

```text
https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0
```

이 PR이 지원하는 operation은 두 개뿐입니다.

| product | operation | 의미 |
| --- | --- | --- |
| `SHORT_FORECAST` | `getVilageFcst` | 단기예보 |
| `ULTRA_SHORT_FORECAST` | `getUltraSrtFcst` | 초단기예보 |

초단기실황(`getUltraSrtNcst`)·예보버전(`getFcstVersion`)은 이번 범위가 아닙니다. operation path는
고정 mapping에서만 선택하며, 사용자 입력을 URL path에 직접 연결하지 않습니다.

### 요청 parameter (`ServiceKey` vs `authKey`)

공공데이터포털 endpoint의 이름과 대소문자를 그대로 사용합니다.

```text
ServiceKey pageNo numOfRows dataType base_date base_time nx ny
```

- 공공데이터포털은 **`ServiceKey`** 를 사용합니다. 기상청 API 허브의 `authKey`와 **혼용하지
  않습니다.** 이번 구현은 공공데이터포털 endpoint를 사용하므로 반드시 `ServiceKey`입니다.
- `dataType`의 공식 **기본값은 XML**이므로, JSON을 받기 위해 `dataType=JSON`을 명시적으로
  전달합니다.

### HTTPS 및 gateway XML 확인 결과 (이번 PR의 실제 진단)

구현 전에 **명백한 가짜 키**로 HTTPS endpoint를 1회 진단했습니다(실제 사용자 키 미사용, 전체 URL·
전체 body 미출력·미커밋, tag 이름과 HTTP status만 확인).

- HTTPS endpoint(`apis.data.go.kr`)는 **연결됨**. operation path `getVilageFcst`는 유효(가짜/누락
  키에 대해 `404`가 아니라 인증 실패를 반환).
- 가짜 키 및 키 누락 모두 **HTTP `401`, `content-type: text/plain`, body `Unauthorized`(13 bytes)**
  를 반환했습니다. 즉 이 host의 front gateway는 `OpenAPI_ServiceResponse` XML을 내보내기 전에
  `401` 평문으로 단락(short-circuit)합니다.
- 따라서 **`200`+`OpenAPI_ServiceResponse` XML gateway 경로는 가짜 키로 재현하지 못했습니다.**
  이 경로는 등록된(그러나 제한/서명 문제 등이 있는) 키에서 나타날 수 있으나, 실제 키 없이
  확인할 수 없습니다. gateway XML detector의 wrapper tag 이름은 PR #4 경계 문서와 공공데이터포털의
  문서화된 gateway 구조를 근거로 구현했으며, **live `200`+XML 재확인은 하지 못했음**을 명시합니다.
  `401` 평문 경로는 아래 `HTTP_ERROR`로 처리됩니다.

공식 문서에 없는 동작은 추정하지 않고 아래 "구현 정책"으로 표시합니다.

## 설정 (`KMA_SERVICE_KEY`)

Provider는 두 가지 factory로 생성하며, **설정 오류로 throw하지 않고** 값(`{ ok: false, error }`)
으로 반환합니다.

```ts
createKmaForecastProvider(options): CreateKmaForecastProviderResult
createKmaForecastProviderFromEnv(env?, dependencies?): CreateKmaForecastProviderResult
```

- **module import 시 환경변수를 읽지 않습니다.** `createKmaForecastProviderFromEnv`는 호출 시점의
  `process.env`(또는 명시적으로 전달한 env 객체)에서 **`KMA_SERVICE_KEY`만** 읽습니다.
- 누락·빈 문자열·공백 문자열 키 → `CONFIG_ERROR`(`serviceKey`, `MISSING`).
- 앞뒤 공백이 있는 키는 **자동 trim하지 않고** `CONFIG_ERROR`(`serviceKey`, `INVALID`).
- 키 값은 오류 메시지·오류 객체에 **절대 포함하지 않습니다.**

### 인증키 형식 정책 (decoded key)

`KMA_SERVICE_KEY`에는 공공데이터포털의 **일반 인증키(Decoding)** 를 넣는 것으로 계약합니다.
Provider는 자동으로 다음을 하지 않습니다: 이미 인코딩된 키인지 추측, `decodeURIComponent` 자동
실행, 중복 decode, 문자열 일부 수정, 공백 trim.

URL 생성 시 `URLSearchParams`가 decoded 키를 **정확히 한 번** URL encoding합니다. 예를 들어
가짜 키 `test-key+with/slash==`는 직렬화된 URL에서 `%2B`·`%2F`·`%3D`로 인코딩되고,
`url.searchParams.get('ServiceKey')`로 읽으면 원래 키와 동일하며, `%`가 이중 인코딩되지 않습니다
(`%25` 없음).

### 방어적 운영 기본값 (공식값 아님)

```text
timeoutMs        = 10_000        (프로젝트 방어적 기본값)
maxResponseBytes = 4 * 1024 * 1024 (4 MiB, 프로젝트 방어적 기본값)
```

이 값은 KMA 공식값이 아니라 프로젝트의 방어적 운영 기본값입니다. `timeoutMs`·`maxResponseBytes`
는 양의 정수여야 하며, `0`·음수·비정수는 `CONFIG_ERROR`(`INVALID`)입니다.

## 요청 입력과 고정 pagination

```ts
interface KmaForecastRequest {
  product: 'SHORT_FORECAST' | 'ULTRA_SHORT_FORECAST';
  baseDate: string; // YYYYMMDD (실제 달력 날짜)
  baseTime: string; // HHmm (시 00–23, 분 00–59)
  nx: number;       // 안전 정수, >= 0
  ny: number;       // 안전 정수, >= 0
}
```

호출자는 위 다섯 값만 전달하고, Provider는 다음을 **내부 고정**합니다(외부에서 변경 불가).

```text
pageNo    = 1
numOfRows = 1000
dataType  = JSON
```

이유: downstream slot grouping에 필요한 한 발표분의 전체 category 확보, 임의 pagination으로 인한
불완전 데이터 방지, JSON response boundary와 일치.

### 요청 runtime validation

- `product`: 위 두 값만 허용, 그 외는 `INVALID_REQUEST`.
- `baseDate`: 정확히 `YYYYMMDD`, 실제 달력 날짜, 숫자 coercion 없음.
- `baseTime`: 정확히 `HHmm`, 시 00–23 / 분 00–59, 숫자 coercion 없음.
- `nx`/`ny`: 안전 정수(`Number.isSafeInteger`), `>= 0`, string coercion 없음.

**발표 schedule 자체는 강제하지 않습니다.** `1260`·`2400`은 거부하지만, 형식상 유효한 `0615`는
Provider가 임의로 거부하지 않습니다(발표시각 선택 로직은 후속 PR).

날짜·시간 검증은 PR #4 `raw-schema.ts`가 쓰는 것과 **동일한 predicate**(`validation.ts`의
`isCalendarDate`/`isClockTime`)를 재사용하므로, 요청 경계와 응답 경계가 같은 규칙을 씁니다. 이
추출은 PR #4 동작·테스트를 바꾸지 않았습니다(로직 위치만 이동).

## Transport (fetch)

Node.js 22 native `fetch`·`AbortController`·`ReadableStream`·`TextDecoder`를 사용하며, **신규
dependency를 추가하지 않습니다.** 테스트를 위해 `fetchImpl`을 주입할 수 있고, 기본값은
`globalThis.fetch`입니다.

```ts
fetchImpl(url, {
  method: 'GET',
  headers: { Accept: 'application/json' },
  redirect: 'error', // service key가 redirect 대상 host로 전달되지 않도록
  signal,            // 내부 AbortController signal
});
```

credentials·cookie·authorization header를 추가하지 않습니다.

### timeout과 caller abort

내부 `AbortController`와 timer로 처리합니다.

```text
Provider timeout 발생   → TIMEOUT
호출자 signal abort      → ABORTED
그 외 fetch reject       → NETWORK_ERROR
```

- timeout timer와 caller signal listener는 **항상 정리**합니다(`finally`).
- caller signal이 이미 aborted이면 **fetch를 호출하지 않고** `ABORTED`.
- timeout과 caller abort가 경합해도 **먼저 발생한 원인**을 결정론적으로 한 번만 반영합니다(첫 콜백이
  reason을 고정하고, 두 번째 콜백은 덮어쓰지 않음).
- abort exception message는 공개하지 않습니다.
- **자동 retry는 구현하지 않습니다.**

### response 최대 크기

`response.text()`로 무제한 body를 한 번에 읽지 않습니다(기본 4 MiB).

1. `Content-Length`가 유효하고 max 초과 → 즉시 `RESPONSE_TOO_LARGE`(한 byte도 읽지 않음).
2. body stream을 chunk별 `byteLength` 누적, max 초과 즉시 reader 취소.
3. `TextDecoder` streaming으로 multibyte UTF-8이 chunk 경계에 걸려도 손상되지 않음.
4. 정확히 max bytes는 성공, max+1은 실패.
5. body가 없거나 0 byte이면 empty string. raw body는 오류에 포함하지 않음.

## 오류 정책과 분류 순서

### HTTP status

`response.ok === false`이면 body를 읽지 않고 `HTTP_ERROR`(**status code만**)를 반환합니다.
statusText·body·URL을 포함하지 않고, KMA parser를 호출하지 않으며, 자동 retry하지 않습니다. 위
진단에서 관찰된 `401` 평문 경로가 여기에 해당합니다.

### 2xx body 분류 순서

1. trim 후 빈 문자열 → `EMPTY_RESPONSE`.
2. `<`로 시작하는 XML/HTML:
   - 공공데이터포털 gateway wrapper(`OpenAPI_ServiceResponse`/`cmmMsgHeader`/`returnReasonCode`/
     `returnAuthMsg`)로 식별되면 → `GATEWAY_ERROR`. `returnReasonCode`가 숫자면 그 값만 보존하고,
     없거나 malformed면 `reasonCode: null`. raw `returnAuthMsg`·raw XML은 절대 포함하지 않음.
     (XML parser dependency를 추가하지 않고 최소 구조만 탐지.)
   - gateway wrapper가 아니면 → `NON_JSON_RESPONSE`.
3. XML이 아니면 `JSON.parse` 시도, 실패 시 → `INVALID_JSON`(raw syntax error message 미노출).
4. parse 성공 → PR #4 `parseKmaForecastResponse(parsed)` 호출:
   - `UPSTREAM_ERROR` → `KMA_UPSTREAM_ERROR`(**2자리 `resultCode`만**).
   - `INVALID_RESPONSE` → `KMA_INVALID_RESPONSE`(**sanitized issues만**).
   - success → 아래 요청·응답 일관성 검증으로 진행.

### 요청·응답 일관성 검증 (PR #4 성공 이후)

검증 순서(첫 번째 결정론적 mismatch field만 반환):

```text
pageNo → numOfRows → baseDate → baseTime → nx → ny
```

- page metadata: `page.pageNo === 1`, `page.numOfRows === 1000`이어야 하며, 불일치 시
  `RESPONSE_MISMATCH`.
- item identity: 모든 item의 `baseDate`·`baseTime`·`nx`·`ny`가 요청과 같아야 함. field 단위로
  전체 item을 검사하므로 **입력 item 순서와 무관하게 동일한 mismatch**가 반환됩니다.
- 완전한 page 여부: `page.totalCount > page.items.length`이면 `INCOMPLETE_PAGE`(`totalCount`,
  `receivedCount` 포함). pagination 자동 순회는 구현하지 않습니다.
- `totalCount === 0` + `items.length === 0`은 **성공**할 수 있습니다. **공식 빈 success page
  사례는 여전히 미확인**입니다(PR #4에서 방어적 허용). `items.length > totalCount` 등은 PR #4
  schema가 이미 거부합니다.

### slot grouping

일관성 검증 통과 후 PR #4 `groupKmaForecastItems(product, items)`를 호출합니다. 성공 시
`forecast.slots`, 중복 category는 `DUPLICATE_CATEGORY`(덮어쓰기·무시 없음). PR #4의 grouping
코드는 변경하지 않았습니다.

### 전체 Provider 오류 목록

`INVALID_REQUEST` · `TIMEOUT` · `ABORTED` · `NETWORK_ERROR` · `HTTP_ERROR(status)` ·
`RESPONSE_TOO_LARGE` · `EMPTY_RESPONSE` · `NON_JSON_RESPONSE` · `INVALID_JSON` ·
`GATEWAY_ERROR(reasonCode|null)` · `KMA_UPSTREAM_ERROR(resultCode)` ·
`KMA_INVALID_RESPONSE(issues)` · `DUPLICATE_CATEGORY(category, slotKey)` ·
`RESPONSE_MISMATCH(field)` · `INCOMPLETE_PAGE(totalCount, receivedCount)`.

설정 단계 오류는 별도 타입 `KmaProviderConfigError`(`CONFIG_ERROR`, `field`, `reason`)입니다.

## 보안 (비밀정보 비노출)

어떤 error variant에도 다음을 넣지 않습니다: service key, 요청 URL·query string, raw response
body, raw gateway message(`returnAuthMsg`), raw KMA `resultMsg`, fetch exception message·`cause`·
`name`, stack trace. `HTTP_ERROR`에는 status code만 포함합니다. 성공 결과에도 ServiceKey·URL·raw
JSON·raw item array·upstream `resultMsg`·현재 시각을 넣지 않습니다.

## 성공 결과 구조

```ts
interface KmaForecastProviderSuccess {
  product: KmaForecastProduct;
  baseDate: string;
  baseTime: string;
  nx: number;
  ny: number;
  totalCount: number;
  slots: readonly KmaForecastSlot[];
}
```

`receivedAt` 같은 현재 시각을 결과에 추가하지 않습니다(결정론성 유지).

## 결정론성

I/O(`fetch`)를 제외한 결과 정책은 결정론적입니다: 동일한 mocked response → 동일한 결과, 요청/파싱
객체 불변, 오류 선택 순서 고정, global mutable state 없음, module import 시 env read 없음, system
clock 미사용.

## 미구현 (아직 없음)

- 자동 발표시각(base date/time) 선택, KST clock logic
- 위경도 → KMA grid 변환, 지역 registry
- retry, cache, circuit breaker, rate limit, telemetry, logger
- 공통 Provider interface, normalized contracts(`HourlyForecast`/`WeatherOverview`)
- weather-core SKY/PTY/PCP/SNO·TMP/REH/WSD/POP normalizer 연결
- `/weather` API route
- 초단기실황·중기예보·기상특보·AirKorea

## 실제 인증 API 검증 상태

- 실제 사용자/운영 `KMA_SERVICE_KEY`는 사용하지 않았습니다.
- 인증된 실제 forecast JSON 응답으로의 성공 경로 검증은 **하지 못했습니다**(실제 키 필요).
- 자동 테스트는 실제 네트워크를 호출하지 않고, 주입된 fake `fetch`와 in-memory `Response`만
  사용합니다.
- HTTPS endpoint·operation path·`401` 평문 경로는 가짜 키 진단으로 확인했으나, `200`+XML gateway
  경로와 정상 성공 JSON은 인증 키 없이 재확인하지 못했습니다.

## PR #6 후속 범위

KMA slot → normalized hourly forecast 조립(TMP/TMN/TMX·REH·WSD/VEC·POP·PCP·SNO·SKY+PTY),
field ABSENT/NULL/VALUE 처리, 단위·숫자 파싱, 부분 데이터 정책, contracts `HourlyForecast` 연결,
정규화 단위 테스트. API route·모바일 연결은 PR #6 이후 별도 PR.

## 변경 이력

```text
v1 / PR #5 / 2026-07
- KMA 공공데이터포털 HTTP Provider 최초 구현
- 서버 전용 ServiceKey 설정 검증 (import-time env access 없음, decoded key 정책, 1회 encoding)
- native fetch·timeout·caller abort·redirect error·response body size 제한 도입
- HTTP status·gateway XML·empty·non-JSON·invalid JSON 오류 분류
- PR #4 response boundary(parser) 및 slot grouping 연결, 요청·응답 consistency·incomplete page 검증
- 진단: HTTPS endpoint·operation path·401 평문 경로 확인 / 200+XML gateway·정상 JSON은 실제 키 부재로 미확인
- retry·cache·normalizer 연결·API route는 미구현(PR #6 이후)
```
