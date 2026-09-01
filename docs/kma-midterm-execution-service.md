# KMA 중기예보 execution service

이 문서는 `apps/api/src/services/kma-midterm-execution.ts`의
`createKmaMidtermExecutionService`를 기록합니다. PR #100의
[`createKmaMidtermRequestPlanFactory`](./kma-midterm-request-plan.md)와 PR #98의
[`KmaMidtermForecastProvider.fetchMidtermForecast`](./kma-midterm-provider.md)를 잇는
**application-level execution service**입니다.

## 책임

한 호출에서 다음만 수행합니다.

```text
input
  → request-plan factory
  → TEMPERATURE provider invocation
  → LAND provider invocation
  → execution result
```

- request-plan factory를 **정확히 1회** 호출합니다.
- plan의 `temperature` request를 provider에 **정확히 1회** 전달합니다.
- 그 호출이 (성공/실패와 관계없이) **정상적으로 result union으로 resolve**되면, plan의 `land`
  request도 provider에 **정확히 1회** 전달합니다.
- 두 provider result를 그대로 보존한 execution result를 반환합니다.

이 서비스의 결과는 **execution trace**입니다 — 최종 daily forecast가 아닙니다.

## 정규화하지 않는다

이 PR은 다음을 하지 않습니다.

- `DailyForecast[]` 생성
- TEMPERATURE + LAND 병합
- 한국어 KMA 날씨 문구 해석, `WeatherCondition` mapping
- 최종 성공 source 선택, partial-data policy 결정
- `WeatherOverview` assembly, `SourceMetadata`
- 위치 → `regId` 매핑
- production composition, route wiring

## 실행 순서 — TEMPERATURE 다음 LAND, 결정적 순차 실행

이 PR은 `Promise.all`, race, concurrency limit, batching, worker abstraction을 도입하지 않습니다.
TEMPERATURE와 LAND는 항상 이 고정 순서로 순차 실행됩니다. 이는 최소 provider-execution 계약을
동시성 정책 없이 먼저 확립하기 위한 의도적 선택이며, 이 PR에는 성능 최적화가 범위에 없습니다.

## 두 resolved outcome을 독립적으로 보존한다

TEMPERATURE와 LAND는 서로 보완하는 데이터 source입니다. 이후 normalizer가 한쪽이 없어도 다른 쪽을
사용할 수 있어야 하므로, 이 PR은 두 resolved provider outcome을 독립적으로 보존합니다.

**정상적인 provider-domain 실패**(`{ ok: false, error }`)는 resolved된 application 값이지
예외가 아닙니다. 따라서 TEMPERATURE가 `ok: false`로 resolve되어도 LAND 호출을 막지 않습니다. 이
서비스는 error kind를 검사해 LAND 실행 여부를 결정하지 않습니다. 다음을 하지 않습니다.

- `temperature.ok === false`만으로 LAND를 short-circuit
- 두 outcome을 하나의 `ok: false`로 flatten
- 승자 선택
- `allSucceeded` 필드 발명
- retry/fallback policy 발명

## Result identity

두 provider invocation이 모두 완료되면 fresh wrapper를 반환합니다.

```ts
{
  temperature, // 첫 provider invocation이 반환한 정확한 result 참조
  land,        // 두 번째 provider invocation이 반환한 정확한 result 참조
}
```

nested result를 clone/spread/sanitize/재해석/재조립하지 않습니다 — provider result는 이미 sanitize된
provider boundary입니다. 다음을 노출하지 않습니다.

- request plan, request 객체
- regId, `referenceEpochMilliseconds`
- service key, URL, query, raw response body
- attempt count, success summary, source selection, retryability

## 오류/rejection 의미론

광범위한 `try/catch`가 없습니다.

- **plan factory throw**: 동일한 error reference가 그대로 전파되고, provider 호출은 0회입니다.
- **TEMPERATURE provider 동기 throw 또는 rejection**: 동일한 error reference가 그대로
  전파/reject되고, LAND provider 호출은 0회이며, partial execution result는 반환되지 않습니다.
  이는 정상적인 `{ ok: false }` provider-domain result와 명확히 다릅니다 — collaborator
  exception/rejection만 이 경로를 탑니다.
- **LAND provider 동기 throw 또는 rejection**: 동일한 error reference가 그대로 전파/reject되고,
  partial execution result는 반환되지 않으며, TEMPERATURE를 invented partial-success result로
  wrapping하지 않습니다.

로깅이나 오류 재작성은 없습니다.

## Abort policy

이 서비스는 abort policy를 소유하지 않습니다.

- 새 `AbortController`를 만들지 않습니다.
- abort listener를 등록하지 않습니다.
- `signal.aborted`를 검사하지 않습니다.
- `ABORTED`를 합성하지 않습니다.
- 두 번째 호출을 스스로 취소하지 않습니다.

caller의 `options`(그 안의 `AbortSignal` 포함)는 정확히 같은 참조로 두 호출 모두에 전달됩니다.
provider가 TEMPERATURE attempt를 `ABORTED` provider result로 resolve해도, 그것은 여전히 resolved된
result union이므로 이미 abort된 동일 signal로 LAND를 호출합니다. 실제 HTTP dispatch 여부는 provider가
소유합니다.

## 이 PR이 하지 않는 것 (`regId` 관련)

PR #100의 소유권을 그대로 유지합니다. Input은 여전히 `temperatureRegId`/`landRegId`이며, 이 서비스는
이를 plan factory에 그대로 전달합니다. 위치/좌표 매핑, regId table, allow-list, Seoul hardcode, 한
regId에서 다른 regId 추론은 하지 않습니다.

## 실제 KMA 호출 검증 상태

이 PR에서는 실제 KMA API 호출을 수행하지 않았습니다. 실제 service key, production 배포, Vercel/EAS
작업도 없습니다.

## 관련 파일

| 파일 | 역할 |
| --- | --- |
| `apps/api/src/services/kma-midterm-execution.ts` | execution service 구현 |
| `apps/api/src/services/kma-midterm-execution.test.ts` | 단위 테스트 |
| `apps/api/src/services/kma-midterm-request-plan.ts` | 소비하는 request-plan factory |
| `apps/api/src/providers/kma/provider.ts` | 소비하는 mid-term provider |
