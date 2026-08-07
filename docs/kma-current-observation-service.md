# KMA 초단기실황 (Current Observation) application service

이 문서는 PR #67에서 추가한 **application service** 한 개
(`createKmaCurrentObservationService`)의 책임과 경계를 기록합니다. 이 service는
[kma-hourly-service.md](./kma-hourly-service.md)의 PR #7 hourly application service와 **같은
원칙을 따르는 별도의, 병렬** 구현입니다 — 새로운 KMA 데이터 변환 규칙을 도입하지 않고, 이미
구현된 두 계층(PR #63 provider, PR #63 normalizer)을 application 수준에서 순서대로 연결할
뿐입니다.

구현 위치:

- [kma-current-observation.ts](../apps/api/src/services/kma-current-observation.ts) — service
- [kma-current-observation 테스트](../apps/api/src/services/kma-current-observation.test.ts)

## 목적

- **PR #63 HTTP Provider**(`KmaCurrentObservationProvider.fetchCurrentObservation()`)와 **PR #63
  현재-관측 정규화 adapter**(`normalizeKmaCurrentObservation()`)를 하나의 orchestration 흐름으로
  잇습니다.
- 흐름: 완성된 KMA current-observation request → Provider 호출 → Provider 오류/성공 분기 → 성공
  observation을 `CurrentWeather`로 정규화 → Provider 단계 오류와 normalization 단계 오류를
  **명확히 구분한** 결과 반환.

```text
already-built KmaCurrentObservationRequest
  → KmaCurrentObservationProvider.fetchCurrentObservation()
  → provider failure 분기
  → normalizeKmaCurrentObservation()
  → normalization failure 분기
  → CurrentWeather success
```

## hourly service와의 차이

이 service는 hourly service(`kma-hourly-forecast.ts`)를 리팩터하거나 두 service가 공유하는
generic application service로 만들지 않았습니다 — 두 provider/normalizer 쌍이 이미 별도·병렬
구현이기 때문에 그대로 반영합니다.

- 성공 결과는 `hourly: readonly HourlyForecast[]`가 아니라 **단일** `current: CurrentWeather`를
  담습니다(초단기실황은 여러 시각의 배열이 아니라 한 시점의 관측입니다).
- `NORMALIZATION` 오류의 `issues` 타입은 `KmaCurrentNormalizationIssue[]`이며 hourly의
  `KmaHourlyNormalizationIssue[]`와 다른 필드 집합입니다.
- 나머지 구조(injected provider, side-effect-free 생성, 호출당 provider 1회·normalizer 최대
  1회, `PROVIDER`/`NORMALIZATION` stage 구분, 광범위한 `try/catch` 없음)는 hourly service와
  동일한 원칙입니다.

## 계층 경계 (Provider / normalizer / service / future route)

| 계층 | 위치 | 책임 |
| --- | --- | --- |
| Provider | `apps/api/src/providers/kma` | 외부 KMA HTTPS 요청, 원본 응답 검증, upstream 분류, slot grouping |
| normalizer | `apps/api/src/providers/kma` | slot → contracts `CurrentWeather` (순수, throw 없음) |
| **service (PR #67)** | `apps/api/src/services` | Provider와 normalizer를 순서대로 호출하는 application orchestration |
| route (후속) | `apps/api/src/index.ts` | 아직 **미구현** — `POST /weather`로의 current 연결은 후속 PR |

- 의존 방향: `services → providers/kma`, `services → contracts`(type only).
- application service는 **Provider boundary의 일부가 아닙니다.** 따라서
  [services/index.ts](../apps/api/src/services/index.ts)에서만 export하고
  [providers/kma/index.ts](../apps/api/src/providers/kma/index.ts)에서는 export하지 않습니다.
- 이 PR은 `apps/api/src/index.ts`/`apps/api/src/api-app.ts`의 기존 `POST /weather` route를
  변경하지 않습니다.

## 요청은 이미 완성된 KMA current-observation request

이 service의 소비자는 **완성된** `KmaCurrentObservationRequest`(baseDate/baseTime, nx/ny)를
전달합니다. service는 다음을 하지 않습니다.

- baseDate/baseTime 자동 선택 — 발표시각을 고르는 순수 selector 자체는 PR #64에서
  `weather-core`에 구현됐고(`selectLatestKmaCurrentObservationBaseTime`,
  [kma-current-observation-issue-time.md](./kma-current-observation-issue-time.md)), 이를
  소비하는 request factory는 PR #66에서 구현됐지만
  ([kma-current-observation-request-factory.md](./kma-current-observation-request-factory.md)),
  이 service는 그 factory를 **호출하지 않습니다.** service는 여전히 완성된 request를
  입력받습니다.
- 위경도 → KMA grid(nx/ny) 변환
- request runtime 재검증 (`validateKmaCurrentObservationRequest()`를 다시 호출하지 않음 — 요청
  검증은 Provider의 책임 유지)
- ServiceKey 처리·환경변수 읽기·Provider 생성

## service factory와 주입 방식

```ts
export function createKmaCurrentObservationService(
  provider: KmaCurrentObservationProvider,
): KmaCurrentObservationService;
```

- Provider는 **주입**됩니다. service는 Provider를 만들지 않고,
  `createKmaCurrentObservationProviderFromEnv()`를 자동 호출하지 않으며, global singleton
  service도 만들지 않습니다.
- **factory 생성 시 side effect 없음:** `createKmaCurrentObservationService(provider)`는
  Provider를 호출하지 않고, normalizer를 호출하지 않으며, 환경변수·clock을 읽지 않고,
  `fetch`·timer·listener를 만들지 않습니다. 실제 Provider 호출은 `fetchCurrentWeather()` 실행
  시에만 발생합니다.
- 동일 service instance로 여러 번 호출할 수 있고, global mutable state가 없습니다.

## 공개 API

```ts
export interface KmaCurrentObservationServiceOptions {
  readonly signal?: AbortSignal;
}

export type KmaCurrentObservationServiceResult =
  | { readonly ok: true; readonly current: CurrentWeather }
  | { readonly ok: false; readonly stage: 'PROVIDER'; readonly error: KmaCurrentObservationProviderError }
  | { readonly ok: false; readonly stage: 'NORMALIZATION'; readonly issues: readonly KmaCurrentNormalizationIssue[] };

export interface KmaCurrentObservationService {
  fetchCurrentWeather(
    request: KmaCurrentObservationRequest,
    options?: KmaCurrentObservationServiceOptions,
  ): Promise<KmaCurrentObservationServiceResult>;
}
```

핵심 구조:

```ts
async fetchCurrentWeather(request, options) {
  const fetched = await provider.fetchCurrentObservation(request, options);
  if (!fetched.ok) {
    return { ok: false, stage: 'PROVIDER', error: fetched.error };
  }
  const normalized = normalizeKmaCurrentObservation(fetched.observation);
  if (!normalized.ok) {
    return { ok: false, stage: 'NORMALIZATION', issues: normalized.issues };
  }
  return { ok: true, current: normalized.current };
}
```

Provider는 **정확히 한 번** 호출하며, request와 `options`(signal 포함)를 그대로 전달합니다.
불필요한 abstraction이나 helper를 추가하지 않습니다.

## 성공 결과

```ts
{ ok: true, current: normalized.current }
```

성공 결과는 own keys가 정확히 `ok`/`current`이며, **정규화된 `CurrentWeather` 하나만** 담습니다.
다음은 포함하지 않습니다: raw provider observation, raw `slot`, raw `fields`, raw `obsrValue`,
`totalCount`, baseDate/baseTime, nx/ny, ServiceKey, request URL, response body, `SourceMetadata`,
`WeatherOverview`. 소비자는 자신이 전달한 `KmaCurrentObservationRequest`를 이미 알고 있으므로,
`SourceMetadata`·`issuedAt` 조립은 후속 PR에서 별도로 설계합니다.

## PROVIDER 단계 오류

```ts
{ ok: false, stage: 'PROVIDER', error: providerResult.error }
```

- Provider 오류를 **수정하거나 다른 이름으로 재분류하지 않고** 그대로 전달합니다(exact reference
  보존). 현재 Provider 오류 variant: `INVALID_REQUEST`, `TIMEOUT`, `ABORTED`, `NETWORK_ERROR`,
  `HTTP_ERROR`, `RESPONSE_TOO_LARGE`, `EMPTY_RESPONSE`, `NON_JSON_RESPONSE`, `INVALID_JSON`,
  `GATEWAY_ERROR`, `KMA_UPSTREAM_ERROR`, `KMA_INVALID_RESPONSE`, `DUPLICATE_CATEGORY`,
  `RESPONSE_MISMATCH`, `INCOMPLETE_PAGE`.
- 결과 own keys는 정확히 `ok`/`stage`/`error`입니다.
- Provider error object를 mutate하지 않고, raw URL·body·ServiceKey·exception·stack을 추가하지
  않으며, HTTP status를 application service에서 다시 해석하지 않습니다.
- Provider 오류에서는 normalizer를 호출하지 않고, partial current data를 반환하지 않습니다.
  retry 없음.

## NORMALIZATION 단계 오류

```ts
{ ok: false, stage: 'NORMALIZATION', issues: normalized.issues }
```

- Provider가 **성공한 경우에만** `normalizeKmaCurrentObservation(fetched.observation)`을
  호출합니다.
- 모든 issue를 그대로(exact reference) 보존하고 순서를 변경하지 않습니다 — sort·clone·spread·
  filter·dedupe·재분류하지 않습니다. raw slot·raw `obsrValue`를 추가하지 않고, Provider metadata나
  raw observation을 오류에 포함하지 않습니다.
- 결과 own keys는 정확히 `ok`/`stage`/`issues`입니다.
- PR #63 normalizer의 **all-or-nothing** 정책을 유지합니다: partial `CurrentWeather`를 만들지
  않습니다.
- normalization failure를 PROVIDER-stage 오류로 재분류하지 않습니다.

## Empty observation semantics (`slot: null`)

Provider의 방어적 success는 `slot: null`을 포함할 수 있습니다(`totalCount > 0` + 빈 item, 또는
`totalCount === 0`인 documented defensive allowance —
[kma-current-observation-provider.md](./kma-current-observation-provider.md) 참고). 이 service는

- 이 경우를 Provider failure로 **재분류하지 않습니다**,
- invented `NO_DATA`나 fallback 결과를 만들지 않습니다,
- `fetched.observation`을 정규화 없이 **그대로** `normalizeKmaCurrentObservation`에 전달합니다.

`slot: null`이면 normalizer가 모든 category를 `ABSENT`로 취급하므로, 필수 `T1H`가 `ABSENT`가
되어 `NORMALIZATION` stage 실패로 이어집니다(정상적인 all-or-nothing 경로 — service는 이 분기를
따로 처리하지 않습니다).

## Reference forwarding / AbortSignal 그대로 전달

- `options?.signal`을 별도로 감싸거나 복제하지 않고, `options`를 Provider에
  `provider.fetchCurrentObservation(request, options)`로 그대로 전달합니다.
- `request`도 같은 reference로 전달합니다(spread·복제 없음).
- 이미 aborted인지 service에서 다시 판단하지 않고, 새 `AbortController`·별도 timeout·abort event
  listener를 만들지 않습니다. Provider의 기존 timeout/caller-abort 정책을 유지합니다.
- `options`가 생략되면 Provider에도 정확히 `undefined`가 전달됩니다.
- `request`/`options`를 mutate하지 않으며, frozen 입력에서도 동작합니다.

## raw value / secret 비노출

- 성공 결과에는 정규화된 contracts 값만, 오류 결과에는 sanitized 기존 오류만 담깁니다.
- Provider success fixture에 고유 marker(예: 무시되는 unknown category VALUE, 또는
  normalization 실패를 일으키는 malformed 온도)를 넣어도 결과 직렬화에 나타나지 않음을 테스트로
  검증합니다(`JSON.stringify(result)`에 marker 부재). 실제 secret처럼 보이는 문자열은 사용하지
  않습니다.
- ServiceKey, 요청 URL/query, raw response body는 이 service의 어떤 결과·테스트 출력에도
  포함되지 않습니다.

## throw/rejection 정책 — 광범위한 catch 없음

- 정상 구현된 `KmaCurrentObservationProvider`와 `normalizeKmaCurrentObservation()`은 오류를
  result union으로 반환합니다(Provider는 transport failure를 sanitized result로 변환하고,
  normalizer는 순수하며 throw하지 않는 계약).
- `fetchCurrentWeather`는 `async` 함수이므로, provider 호출이 동기적으로 throw하거나 provider가
  반환한 Promise가 reject하거나, provider 성공 이후 normalizer 호출이 throw하면, 그 **동일한
  error reference**로 이 service가 반환하는 Promise가 reject합니다 — 이 service는 광범위한
  `try { … } catch { … }`를 추가하지 않으므로, 어떤 경로에서도 catch·wrap·재메시지·logging이
  일어나지 않습니다.
- 비정상 collaborator의 programmer error를 임의 domain error로 숨기거나 근거 없는
  `INTERNAL_ERROR` variant를 새로 만들지 않습니다.
- service construction(`createKmaCurrentObservationService(provider)`) 자체는 throw하지 않고
  Provider를 호출하지 않습니다.

## side-effect 없는 factory / retry·cache 없음

- factory 생성만으로는 어떤 I/O도 일어나지 않습니다(위 "service factory" 참조).
- 이 service는 retry·cache·fallback·stale data를 하지 않습니다.

## 실제 key·외부 네트워크 테스트 없음

- 실제 `KMA_SERVICE_KEY`를 사용하지 않았습니다.
- 자동 테스트는 실제 네트워크를 호출하지 않고, interface 계약을 지키는 in-memory fake Provider와
  in-memory slot fixture, 그리고 실제 `normalizeKmaCurrentObservation` 함수만 사용합니다. live
  통합 검증은 후속 과제입니다.

## request factory와의 책임 분리

- PR #66 request factory(`createKmaCurrentObservationRequestFactory`,
  [kma-current-observation-request-factory.md](./kma-current-observation-request-factory.md))는
  **request 조립까지만** 담당하고 Provider를 호출하지 않습니다.
- 이 service는 **이미 조립된** request를 받아 Provider와 normalizer만 orchestrate합니다 —
  request factory를 import하거나 호출하지 않습니다.
- 두 factory→service를 잇는 scheduled facade(hourly의 PR #10과 같은 방식)는 **PR #68**에서
  완료됐습니다(`createKmaScheduledCurrentObservationFacade`,
  [kma-scheduled-current-observation-facade.md](./kma-scheduled-current-observation-facade.md)) —
  이 service의 **첫 application caller**입니다. 이어서 **PR #69**가 이 facade를 소비하는 production
  composition root(`createKmaScheduledCurrentObservationCompositionFromEnv`,
  [kma-current-observation-production-composition.md](./kma-current-observation-production-composition.md))를
  추가해, 이 service를 PR #63 Provider-from-env가 만든 실제 provider와 함께 조립합니다. 이 service
  자체의 책임과 공개 계약은 변경되지 않았고, route에는 여전히 연결되지 않았습니다.

## 후속 범위

이 PR 이후 후보 PR(순서 무관):

1. 위경도 → KMA grid(nx/ny) 변환을 이 request factory와 잇는 application adapter
2. ~~request factory + 이 service를 잇는 scheduled facade (hourly의 PR #10과 같은 방식)~~ —
   **PR #68에서 완료** (`createKmaScheduledCurrentObservationFacade`,
   [kma-scheduled-current-observation-facade.md](./kma-scheduled-current-observation-facade.md))
3. ~~current-observation 전용 system clock/provider composition~~ — **PR #69에서 완료**
   (`createKmaScheduledCurrentObservationCompositionFromEnv`,
   [kma-current-observation-production-composition.md](./kma-current-observation-production-composition.md)) —
   route에는 여전히 연결되지 않음
4. `CurrentWeather`를 `WeatherOverview.current` section에 조립
5. `SourceMetadata`(`sourceId`/`issuedAt`/`retrievalMode`) 조립
6. `POST /weather`로의 current 데이터 연결
7. current-observation availability-delay selector
8. 실제 인증 KMA API 호출을 통한 live 검증

이 PR이 production current 데이터를 제공한다고 표현하지 않습니다 — `POST /weather`는 이 PR
이후에도 계속 current를 missing으로 응답합니다.

## 변경 이력

```text
v1 / PR #67 / 2026-08
- PR #63 current-observation Provider와 PR #63 normalizer를 잇는 application service 추가
- Provider/normalization 단계 오류 구분(PROVIDER/NORMALIZATION stage)
- AbortSignal·request exact reference 전달과 raw slot/obsrValue 비노출 정책
- slot: null 방어적 성공을 재분류 없이 그대로 normalizer에 전달(정상 all-or-nothing 경로)
- hourly application service(PR #7)와 별도·병렬 구현, 어느 쪽도 리팩터하지 않음
- request factory 호출·grid 변환·composition·route·POST /weather 연결은 이 PR 범위 밖

v2 / PR #69 / 2026-08 (production composition이 이 service를 조립 — service 계약 불변)
- createKmaScheduledCurrentObservationCompositionFromEnv가 PR #63 provider-from-env가 만든 실제
  provider를 이 service에 주입해 조립
- 이 service의 공개 API·오류 정책·side-effect-free 생성은 v1과 동일하게 불변
- route(POST /weather) 연결은 여전히 없음
```
