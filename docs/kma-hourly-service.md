# KMA 시간별 예보 application service

이 문서는 PR #7에서 추가한 **application service** 한 개(`createKmaHourlyForecastService`)의 책임과
경계를 기록합니다. 이 PR은 새로운 KMA 데이터 변환 규칙을 도입하지 않습니다 — 이미 구현된 두 계층을
application 수준에서 순서대로 연결할 뿐입니다.

## 목적

- **PR #5 HTTP Provider**(`KmaForecastProvider.fetchForecast()`)와 **PR #6 시간별 정규화
  adapter**(`normalizeKmaHourlyForecast()`)를 하나의 orchestration 흐름으로 잇습니다.
- 흐름: 완성된 KMA forecast request → Provider 호출 → Provider 오류/성공 분기 → 성공 slot을
  `HourlyForecast[]`로 정규화 → Provider 단계 오류와 normalization 단계 오류를 **명확히 구분한**
  결과 반환.

이 service는 매번 "fetch → provider 오류 분기 → normalize → normalization 오류 분기"를 반복 구현하지
않도록 하는 얇은 조립 계층입니다.

## 계층 경계 (Provider / normalizer / service / future route)

| 계층 | 위치 | 책임 |
| --- | --- | --- |
| Provider | `apps/api/src/providers/kma` | 외부 KMA HTTPS 요청, 원본 응답 검증, upstream 분류, slot grouping |
| normalizer | `apps/api/src/providers/kma` | slot → contracts `HourlyForecast[]` (순수, throw 없음) |
| **service (PR #7)** | `apps/api/src/services` | Provider와 normalizer를 순서대로 호출하는 application orchestration |
| route (후속) | `apps/api/src/index.ts` | 아직 **미구현** — `/weather` HTTP route는 후속 PR |

- 의존 방향: `services → providers/kma`, `services → contracts`(type only).
- application service는 **Provider boundary의 일부가 아닙니다.** 따라서
  [services/index.ts](../apps/api/src/services/index.ts)에서만 export하고
  [providers/kma/index.ts](../apps/api/src/providers/kma/index.ts)에서는 export하지 않습니다.
- 이 PR은 `apps/api/src/index.ts`의 Hono route(`GET /health`)를 변경하지 않습니다.

## 요청은 이미 완성된 KMA request

이 service의 소비자는 **완성된** `KmaForecastRequest`(product, baseDate/baseTime, nx/ny)를 전달합니다.
service는 다음을 하지 않습니다.

- baseDate/baseTime 자동 선택 (발표시각 schedule) — 발표시각을 고르는 순수 함수 자체는 PR #8에서
  `weather-core`에 구현됐지만(`selectLatestKmaForecastBaseTime`,
  [kma-issue-time.md](./kma-issue-time.md)), 이 service는 그것을 **호출하지 않습니다.** service는
  여전히 완성된 request를 입력받습니다.
- 위경도 → KMA grid(nx/ny) 변환
- request runtime 재검증 (`validateKmaForecastRequest()`를 다시 호출하지 않음 — 요청 검증은
  Provider의 책임 유지)
- ServiceKey 처리·환경변수 읽기·Provider 생성

## service factory와 주입 방식

```ts
export function createKmaHourlyForecastService(
  provider: KmaForecastProvider,
): KmaHourlyForecastService;
```

- Provider는 **주입**됩니다. service는 Provider를 만들지 않고, `createKmaForecastProviderFromEnv()`를
  자동 호출하지 않으며, global singleton service도 만들지 않습니다.
- **factory 생성 시 side effect 없음:** `createKmaHourlyForecastService(provider)`는 Provider를
  호출하지 않고, 환경변수·clock을 읽지 않으며, `fetch`·timer·listener를 만들지 않습니다. 실제
  Provider 호출은 `fetchHourlyForecast()` 실행 시에만 발생합니다.
- 동일 service instance로 여러 번 호출할 수 있고, global mutable state가 없습니다.

## 공개 API

```ts
export interface KmaHourlyForecastServiceOptions {
  readonly signal?: AbortSignal;
}

export type KmaHourlyForecastServiceResult =
  | { readonly ok: true; readonly hourly: readonly HourlyForecast[] }
  | { readonly ok: false; readonly stage: 'PROVIDER'; readonly error: KmaForecastProviderError }
  | { readonly ok: false; readonly stage: 'NORMALIZATION'; readonly issues: readonly KmaHourlyNormalizationIssue[] };

export interface KmaHourlyForecastService {
  fetchHourlyForecast(
    request: KmaForecastRequest,
    options?: KmaHourlyForecastServiceOptions,
  ): Promise<KmaHourlyForecastServiceResult>;
}
```

핵심 구조:

```ts
async fetchHourlyForecast(request, options) {
  const fetched = await provider.fetchForecast(request, options);
  if (!fetched.ok) {
    return { ok: false, stage: 'PROVIDER', error: fetched.error };
  }
  const normalized = normalizeKmaHourlyForecast(fetched.forecast);
  if (!normalized.ok) {
    return { ok: false, stage: 'NORMALIZATION', issues: normalized.issues };
  }
  return { ok: true, hourly: normalized.hourly };
}
```

Provider는 **정확히 한 번** 호출하며, request와 `options`(signal 포함)를 그대로 전달합니다.
불필요한 abstraction이나 helper를 추가하지 않습니다.

## 성공 결과

```ts
{ ok: true, hourly: normalized.hourly }
```

성공 결과는 **정규화된 `HourlyForecast[]`만** 담습니다. 다음은 포함하지 않습니다: raw KMA slots,
raw category, raw `fcstValue`, Provider 전체 성공 객체, `totalCount`, baseDate/baseTime, nx/ny,
ServiceKey, request URL, response body, `SourceMetadata`, `WeatherOverview`. 소비자는 자신이 전달한
`KmaForecastRequest`를 이미 알고 있으므로, `SourceMetadata`·`issuedAt` 조립은 후속 PR에서 별도로
설계합니다.

## PROVIDER 단계 오류

```ts
{ ok: false, stage: 'PROVIDER', error: providerResult.error }
```

- Provider 오류를 **수정하거나 다른 이름으로 재분류하지 않고** 그대로 전달합니다. 현재 Provider
  오류 variant: `INVALID_REQUEST`, `TIMEOUT`, `ABORTED`, `NETWORK_ERROR`, `HTTP_ERROR`,
  `RESPONSE_TOO_LARGE`, `EMPTY_RESPONSE`, `NON_JSON_RESPONSE`, `INVALID_JSON`, `GATEWAY_ERROR`,
  `KMA_UPSTREAM_ERROR`, `KMA_INVALID_RESPONSE`, `DUPLICATE_CATEGORY`, `RESPONSE_MISMATCH`,
  `INCOMPLETE_PAGE`.
- Provider error object를 mutate하지 않고, raw URL·body·ServiceKey·exception·stack을 추가하지
  않으며, HTTP status를 application service에서 다시 해석하지 않습니다.
- Provider 오류에서는 normalizer를 호출하지 않고, partial hourly data를 반환하지 않습니다. retry
  없음.

## NORMALIZATION 단계 오류

```ts
{ ok: false, stage: 'NORMALIZATION', issues: normalized.issues }
```

- Provider가 **성공한 경우에만** `normalizeKmaHourlyForecast(fetched.forecast)`를 호출합니다.
- 모든 issue를 그대로 보존하고 순서를 변경하지 않습니다. raw slot·raw `fcstValue`를 추가하지 않고,
  Provider metadata나 raw forecast를 오류에 포함하지 않습니다.
- PR #6의 **all-or-nothing** 정책을 유지합니다: 일부 성공 slot만 반환하지 않습니다.

## AbortSignal 그대로 전달

- `options?.signal`을 별도로 감싸거나 복제하지 않고, `options`를 Provider에
  `provider.fetchForecast(request, options)`로 그대로 전달합니다.
- 이미 aborted인지 service에서 다시 판단하지 않고, 새 `AbortController`·별도 timeout·abort event
  listener를 만들지 않습니다. Provider의 기존 timeout/caller-abort 정책을 유지합니다.
- `options`가 생략되면 Provider에도 `undefined`가 전달됩니다.

## raw slot / value 비노출

- 성공 결과에는 정규화된 contracts 값만, 오류 결과에는 sanitized 기존 오류만 담깁니다.
- Provider success fixture에 고유 marker(예 무시되는 unknown category VALUE, 또는 normalization
  실패를 일으키는 malformed 온도)를 넣어도 결과 직렬화에 나타나지 않음을 테스트로 검증합니다
  (`JSON.stringify(result)`에 marker 부재). 실제 secret처럼 보이는 문자열은 사용하지 않습니다.

## 예외를 임의 domain error로 변환하지 않는 정책

- 정상 구현된 `KmaForecastProvider`와 `normalizeKmaHourlyForecast()`는 오류를 result union으로
  반환합니다(Provider는 transport failure를 sanitized result로 변환하고, normalizer는 순수하며
  throw하지 않는 계약).
- 따라서 이 service는 광범위한 `try { … } catch { … }`를 추가하지 않습니다. 비정상 collaborator의
  programmer error를 임의 domain error로 숨기거나 근거 없는 `INTERNAL_ERROR` variant를 새로 만들지
  않습니다.

## side-effect 없는 factory / retry·cache 없음

- factory 생성만으로는 어떤 I/O도 일어나지 않습니다(위 "service factory" 참조).
- 이 service는 retry·cache·fallback·stale data·두 상품 결과 병합을 하지 않습니다.

## 실제 key·외부 네트워크 테스트 없음

- 실제 `KMA_SERVICE_KEY`를 사용하지 않았습니다.
- 자동 테스트는 실제 네트워크를 호출하지 않고, interface 계약을 지키는 in-memory fake Provider와
  in-memory slot fixture만 사용합니다. live 통합 검증은 후속 과제입니다.

## PR #10 scheduled facade와의 관계

- PR #10의 **scheduled facade**(`createKmaScheduledHourlyForecastFacade`,
  [kma-scheduled-hourly-facade.md](./kma-scheduled-hourly-facade.md))가 PR #9 request factory로
  완성된 `KmaForecastRequest`를 만들어 이 hourly service의 `fetchHourlyForecast`에 그대로 전달합니다.
- 이 hourly service **자체의 공개 API(`fetchHourlyForecast(request, options)`, result union, stage
  구분, AbortSignal 계약)는 변경되지 않았습니다.** facade는 이 service를 감싸기만 하고 결과를 그대로
  반환합니다(Provider/Normalization stage·error·issues를 변형하지 않음).
- facade를 쓰지 않는 **직접 caller도 여전히** 완성된 `KmaForecastRequest`로 이 service를 호출할 수
  있습니다.
- facade는 injected collaborator만 연결하며, 실제 Provider/clock 인스턴스를 조립하는 **production
  composition root는 미구현**입니다(후속 PR).

## 후속 범위

이 PR 이후 후보 PR:

1. ~~KMA 발표시각을 결정론적으로 선택하는 pure scheduler~~ — **PR #8에서 완료**
   (`selectLatestKmaForecastBaseTime`, `weather-core`, [kma-issue-time.md](./kma-issue-time.md)).
2. ~~injected clock으로 selector를 호출해 selector 결과와 nx/ny를 합쳐 request를 자동 조립하는
   factory~~ — **PR #9에서 별도 component로 완료**(`createKmaForecastRequestFactory`,
   `apps/api/src/services`, [kma-forecast-request-factory.md](./kma-forecast-request-factory.md)).
   다만 이 hourly service는 그 factory를 **내부에서 자동 호출하지 않으며**, 여전히 완성된
   `KmaForecastRequest`를 입력받습니다. factory → service 순서로 잇는 일은 PR #10 application
   facade가 담당합니다(아래 3번). 이 PR은 hourly service의 `AbortSignal` 계약이나 Provider/
   normalizer 오류 stage를 변경하지 않았습니다.
3. ~~factory → hourly service를 잇는 application facade~~ — **PR #10에서 완료**
   (`createKmaScheduledHourlyForecastFacade`, [kma-scheduled-hourly-facade.md](./kma-scheduled-hourly-facade.md)).
4. ~~system clock adapter와 production composition root~~ — **PR #11에서 완료**
   (`createKmaSystemClock`·`createKmaScheduledHourlyCompositionFromEnv`,
   [kma-production-composition.md](./kma-production-composition.md)). composition이
   `createKmaForecastProviderFromEnv`로 Provider를 생성해 이 hourly service에 **주입**합니다 —
   hourly service 자체의 공개 API와 Provider/normalization stage 계약은 변경되지 않았습니다. 실제
   route 연결은 아직 없습니다.
5. 위경도 → KMA grid(nx/ny) 변환
6. `SourceMetadata`와 `WeatherOverview` 조립
7. `/weather` API route

## 변경 이력

```text
v1 / PR #7 / 2026-07
- KMA Provider와 hourly normalizer application service 연결
- Provider/normalization 단계 오류 구분
- AbortSignal 전달과 raw slot 비노출 정책

v2 / PR #11 / 2026-07 (production composition에서 소비)
- PR #11 composition이 Provider(from env)를 생성해 이 hourly service에 주입
- hourly service 공개 API와 stage contract 변경 없음, route 미연결
```
