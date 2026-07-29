# 모바일 weather API client 경계

이 문서는 `apps/mobile/src/weather-api`의 **contract-safe weather API client 경계**를 설명합니다.
이 경계는 `apps/api`의 production `POST /weather` 계약(`WeatherRequestV1` /
`WeatherResponseV1`)을 모바일 앱이 안전하게 소비하도록 하는 얇은 client이며, 화면·네비게이션·실제
호출은 다루지 않습니다.

## 목적과 경계

- 공유 `@life-weather/contracts` schema를 **직접** 소비합니다. schema나 type을 모바일 안에서 복사·
  재정의하지 않습니다.
- 요청은 전송 전에, 응답은 사용 전에 네트워크 경계에서 런타임 검증합니다.
- transport·consumer 오류(네트워크·중단·비-JSON 등)를 API 자체의 `WeatherErrorResponseV1`과
  명확히 구분합니다.
- class 계층이나 범용 HTTP framework를 도입하지 않고, retry/timeout/cache/auth/logging도 없습니다.
- `baseUrl`과 `fetchImpl`을 caller가 주입하므로 module import·factory construction 시 network 호출,
  실제 URL, 환경변수 접근이 없습니다.

## 공개 API

```ts
import { createWeatherApiClient } from './weather-api';

const client = createWeatherApiClient({ baseUrl, fetchImpl });

const result = await client.fetchWeather(request, { signal });
```

- `createWeatherApiClient({ baseUrl, fetchImpl })` — client를 생성합니다. `fetchImpl`은 선택이며
  생략 시 런타임 global `fetch`를 사용합니다. construction은 side effect가 없으며 잘못된 설정에도
  throw하지 않습니다(자세한 정책은 아래 "설정(config) 검증" 참고).
- `fetchWeather(request, options?)` — 단일 weather fetch method. `request`는 `WeatherRequestV1`,
  `options.signal`은 caller의 `AbortSignal`입니다.

### 반환 result

`fetchWeather`는 세 갈래 discriminated result(`WeatherApiResult`)를 반환하며 절대 throw하지
않습니다(transport 실패도 result로 반환).

| `kind` | 의미 | payload |
| --- | --- | --- |
| `success` | `ok: true`인 유효한 `WeatherResponseV1` | `data: WeatherSuccessResponseV1` |
| `apiError` | `ok: false`인 유효한 `WeatherResponseV1` (API 자체의 계약 오류) | `error: WeatherErrorResponseV1` |
| `clientError` | 유효한 계약 응답을 얻거나 신뢰하지 못함 (transport·검증·설정 실패) | `error: WeatherApiClientError` |

`success`/`apiError` 구분은 공개 계약의 `ok` discriminator만으로 수행하며, HTTP status별 error
mapping을 모바일에서 재작성하지 않습니다.

## 설정(config) 검증

`createWeatherApiClient`는 construction 시 `baseUrl`과 `fetchImpl`을 side effect 없이 정규화·검증하며,
runtime-invalid 설정에도 throw하지 않습니다. 설정이 사용 불가하면 fetch를 호출하지 않고 첫 `fetchWeather`
호출에서 `clientError`(`invalidClientConfiguration`)를 반환하며, 오류 객체에는 URL이나 config 원문을 담지
않습니다.

`baseUrl` 정책:

URL parser(`new URL()`)는 raw 입력을 조용히 정규화해 **다른 endpoint**로 바꿀 수 있으므로(빠진 scheme
slash 보완, backslash→slash 변환, `.`/`..`·`%2e` dot segment 제거 등), parser는 최종 구조 검증에만
사용하고 parser가 재작성할 수 있는 raw syntax는 **parser 호출 전에** 거부합니다.

- 앞뒤 whitespace는 trim(무시)하며 endpoint에 raw whitespace를 보존하지 않습니다. trim 후 남은 internal
  whitespace나 ASCII control character는 거부합니다.
- 정확히 `http://` 또는 `https://`(scheme는 대소문자 무시)로 시작해야 합니다. slash가 부족하거나
  (`https:/`, `https:`) 과도한(`https:///`, `https:////`) 형태, 다른 scheme·malformed·상대 경로는 거부합니다.
- raw `?`·`#`는 내용 유무와 무관하게 거부합니다. 빈 delimiter(`?`, `#`)만 있어도 거부합니다.
- raw backslash(`\`)를 포함하면 거부합니다(parser가 slash로 바꾸기 때문).
- endpoint 구조를 바꾸는 dot segment를 거부합니다. literal `.`·`..`뿐 아니라 parser가 dot segment로
  취급하는 percent-encoded 형태(`%2e`·`%2E`·`%2e%2e`·`.%2e`·`%2e.` 등 대소문자 혼합 포함)도 거부합니다.
  단, 독립 dot segment가 아닌 `%2e`(예: `/api%2ev1`, `/%2econfig`)나 non-dot encoded path(예:
  `/api%20v1`)는 그대로 허용합니다.
- embedded credentials(`user:pass@`)가 포함된 URL은 거부합니다.
- parser normalization 방지: raw syntax 선검증 후 `new URL()`로 parse하고, path가 없던 경우의 `/` 보완만
  허용한 뒤 parser가 반환한 `url.pathname`이 raw path와 동일한지 확인합니다. 다르면(= parser가 endpoint를
  재작성했으면) 거부합니다.
- 의도된 path 조정은 앞뒤 whitespace trim과 trailing slash 제거뿐입니다. optional base path는 보존하고,
  trailing slash 유무·개수와 무관하게 정확히 한 번 `/weather`를 추가합니다.
- invalid 설정은 fetch를 0회 호출하고, 첫 `fetchWeather`에서 URL·secret을 노출하지 않는 safe typed
  error(`invalidClientConfiguration`)만 반환합니다.

`fetchImpl` 정책: caller가 제공하면 runtime에서도 함수인지 확인하고(비함수면 global fetch로 fallback하지
않고 invalid 설정), 생략된 경우에만 함수인 global `fetch`를 사용합니다.

## Outbound request 검증

전송 전에 기존 `weatherRequestV1`(strict)로 request를 런타임 parse합니다. request는 정확히
`{ location: WeatherLocation }`만 허용하며, KMA product·provider·nx/ny/grid·baseDate/baseTime·service
key·현재위치 flag·정렬·저장 전용 필드·`contractVersion` 등 어떤 추가 필드도 넣지 않습니다.

app-only 필드나 provider-native lookup key가 섞이면 strict schema가 이를 거부하므로, client는 parse된
request만 serialize하고 caller 입력을 그대로 spread해 전송하지 않습니다. 검증에 실패하면 fetch를 호출하지
않고 `clientError`(`invalidRequest`)를 반환합니다.

## Response 계약 검증

응답 처리 순서는 고정되어 있습니다.

1. response `Content-Type`의 media type(첫 `;` 이전, trim·case-insensitive)이 정확히
   `application/json`인지 확인한 뒤 body를 읽습니다. `application/jsonp`·`application/json-extra`·
   `application/problem+json` 같은 lookalike/`+json` 계열은 거부합니다.
2. parsed JSON을 최소 `apiEnvelopeHeader`로 먼저 검사합니다.
3. envelope의 `meta.contractVersion`을 `CONTRACT_VERSION`과 비교합니다.
4. version이 다르면 full V1 parse를 **하지 않고** `unsupportedContractVersion`으로 종료합니다.
5. version이 같을 때만 `weatherResponseV1`로 전체 parse합니다.
6. `ok` discriminator로 `success` 또는 `apiError` variant를 반환합니다.

HTTP status는 보지 않습니다. API는 오류도 구조화된 `WeatherErrorResponseV1` body로 반환하므로 body가
권위입니다.

## Mobile-local 오류 경계

다음 transport/consumer 오류를 API의 `WeatherErrorResponseV1`과 구분해 `clientError`로 반환합니다.
각 오류는 안정적인 machine-readable `kind`와 **고정된 안전 메시지**만 가집니다.

| `kind` | 발생 시점 |
| --- | --- |
| `invalidClientConfiguration` | `baseUrl`/`fetchImpl`이 사용 불가 |
| `invalidRequest` | outbound request가 `weatherRequestV1` 검증 실패 |
| `networkError` | `fetch`가 abort 외 사유로 reject |
| `aborted` | caller `AbortSignal`로 취소됨 |
| `nonJsonResponse` | 응답 `Content-Type`이 JSON이 아님 |
| `malformedJson` | JSON으로 선언됐으나 parse 불가 |
| `invalidEnvelope` | `apiEnvelopeHeader` 형태 불일치 |
| `unsupportedContractVersion` | envelope의 contract version이 지원 버전과 다름 |
| `invalidResponse` | envelope는 맞지만 full `weatherResponseV1` parse 실패 |

오류 객체는 `{ kind, message }`뿐이며 raw response body, request/response URL, stack, `cause`, 원본
fetch error message, 전체 headers, request location/좌표, secret marker, provider 내부 정보를 **포함하지
않습니다**. 사용자용 문구는 이 경계에서 설계하지 않고, UI가 `kind`를 자신의 문자열로 매핑합니다.

## AbortSignal

caller의 `AbortSignal`은 wrapping 없이 **동일 reference**로 `fetch`에 전달합니다. 이미 abort된
signal은 fetch를 호출하지 않고 `aborted`로 즉시 종료합니다. body read 도중 실패한 경우에도 error가
`AbortError`이거나 caller signal이 이미 aborted면 `aborted`로 분류하고, 그 외에는 `networkError`로
분류합니다(일부 런타임은 body read 취소를 `AbortError`가 아닌 일반 error로 표면화하기 때문). client는
자체 timeout이나 controller를 만들지 않습니다.

## Build-first 계약

모바일이 compiled `@life-weather/contracts` `dist`의 runtime consumer가 되므로, mobile public
`typecheck`/`test`는 다른 compiled-contracts consumer와 동일하게 shared runtime package를 먼저 빌드한 뒤
`typecheck:workspace`/`test:workspace`를 실행합니다. root `pnpm check`의 shared build는 여전히 정확히 한
번만 수행됩니다.

## 테스트

`apps/mobile`의 Vitest tests는 주입된 `fetchImpl` 또는 in-memory `Response`만 사용하고 외부 network를
호출하지 않습니다. fixtures는 `example.test` origin과 synthetic ID·display name·좌표만 사용하며, 실제
사용자 좌표·저장 위치·device identifier를 쓰지 않습니다. 검증 항목에는 exact `/weather` URL·POST·JSON
header·exact request body·invalid 입력 거부·extra field 비전송·success/apiError parse·no-selection
parse·envelope-first ordering·malformed/non-JSON·network reject·pre-aborted·AbortSignal exact
forwarding·입력 무변경·호출 간 무공유 상태·raw/URL/secret 비노출이 포함됩니다.

## 범위 제외

화면 연결, navigation, 디자인 시스템, 실제 API base URL/도메인, `EXPO_PUBLIC_*` 변수, 실제 endpoint
호출, 위치 권한·현재 위치·실제 좌표·지역 저장소, current/daily/AirKorea/alerts, response cache,
retry/timeout/offline, lifestyle-engine 호출, contracts source/version/export 변경은 이 PR의 범위가
아닙니다.
