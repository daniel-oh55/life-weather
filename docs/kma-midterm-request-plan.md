# KMA 중기예보 request-plan factory

이 문서는 `apps/api/src/services/kma-midterm-request-plan.ts`의
`createKmaMidtermRequestPlanFactory`를 기록합니다. PR #98의
[`KmaMidtermForecastRequest`](./kma-midterm-provider.md) provider boundary와 PR #99의
[`selectLatestKmaMidtermIssuance`](./kma-midterm-issue-time.md) selector를 잇는
**application-level request-plan factory**입니다.

## 책임

한 production mid-term daily fetch에는 서로 다른 `regId` code set을 쓰는 두 operation —
`TEMPERATURE`(`getMidTa`)와 `LAND`(`getMidLandFcst`) — 이 필요합니다. 이 factory는 그 두
요청을 **하나의 plan**으로 만듭니다. provider를 호출하지 않고, 요청을 조립할 뿐입니다.

## Single-reference invariant — 하나의 clock read, 하나의 selector 호출

`createScheduledRequestPlan(input)` 호출마다:

1. injected clock을 **정확히 1회** 읽고,
2. 그 epoch을 그대로 담은 fresh `{ referenceEpochMilliseconds }`로 injected issuance selector를
   **정확히 1회** 호출하고,
3. 그 하나의 `tmFc`로 TEMPERATURE와 LAND 두 complete request를 만듭니다.

두 independent single-request factory 호출로 구현하지 않습니다 — 클럭을 두 번 읽으면
06:00/18:00 KST 발표 경계를 사이에 두고 두 요청이 서로 다른 issuance를 가리킬 수 있기 때문입니다.
그 결과 다음이 매 성공적인 plan에서 항상 참입니다.

```
temperature.tmFc === land.tmFc
```

## TEMPERATURE/LAND는 별도로 이름 붙은 regId를 받는다

`temperatureRegId`와 `landRegId`는 명시적으로 분리된 입력 필드입니다 — `getMidTa`와
`getMidLandFcst`는 서로 다른 공식 중기예보 구역코드 code set을 쓰기 때문입니다. 이 factory는
위치/행정구역/좌표를 `regId`로 매핑하지 않고, 한 regId에서 다른 regId를 추론하지 않으며, Seoul
hardcode나 지역 테이블을 두지 않습니다. 두 값은 타입이 맞는 caller-supplied primitive로 그대로
통과됩니다 — provider의 기존 runtime request validator가 여전히 유일한 trust-boundary
validator입니다.

## Schedule-only — availability delay 없음

기본 `issuanceSelector`는 PR #99의 schedule-only `selectLatestKmaMidtermIssuance`입니다. 이
factory는 API availability delay, publication-delay threshold, previous-issuance fallback,
retry policy를 발명하지 않습니다 — 이 project는 아직 그런 근거를 확립하지 않았습니다
([kma-midterm-issue-time.md](./kma-midterm-issue-time.md) 참고). 근거 기반 정책이 확립되면
이후 composition이 다른 selector를 주입할 수 있습니다.

## 오류 전파

이 factory는 새 result union이나 새 application error 종류를 만들지 않습니다.

- injected clock이 throw하면 **동일한 error reference**가 그대로 전파됩니다.
- injected selector가 throw하면(PR #99 `RangeError` 포함) **동일한 error reference**가 그대로
  전파됩니다.
- 어느 경우든 partial plan은 반환되지 않습니다 — clock이 throw하면 selector는 호출되지 않고,
  selector가 throw하면 plan은 만들어지지 않습니다.
- collaborator 오류를 잡거나(catch), 재작성하거나, 로깅하지 않습니다.

## Provider I/O 없음

이 factory는 `KmaMidtermForecastProvider.fetchMidtermForecast`를 호출하지 않고, provider를
인스턴스화하지 않으며, `KMA_SERVICE_KEY`를 사용하지 않고, 어떤 네트워크 요청도 수행하지
않습니다. 이 plan은 어떤 요청이 만들어질지만 증명하며, 두 요청 중 하나가 실제로 dispatch됐다는
뜻은 아닙니다.

## 이 PR이 하지 않는 것

- 위치/행정구역/좌표 → `regId` 매핑, regId 조회 테이블, allow-list 검증
- provider HTTP 호출, provider 변경
- `DailyForecast[]` 정규화, 한국어 날씨 문구 → `WeatherCondition` 매핑
- 단기 daily와 중기 daily 병합, `WeatherOverview` 조립, `SourceMetadata`
- cache, `POST /weather`, routes, presenters, production composition
- 실제 KMA API 호출

## 관련 파일

| 파일 | 역할 |
| --- | --- |
| `apps/api/src/services/kma-midterm-request-plan.ts` | request-plan factory 구현 |
| `apps/api/src/services/kma-midterm-request-plan.test.ts` | 단위 테스트 |
| `apps/api/src/providers/kma/midterm-request.ts` | 소비하는 provider request 타입 |
| `packages/weather-core/src/kma/midterm-issue-time.ts` | 기본 issuance selector |
