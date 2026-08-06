# KMA current-observation request factory (injected clock)

이 문서는 PR #66에서 추가한 **application-level request factory**
(`createKmaCurrentObservationRequestFactory`)의 책임과 경계를 기록합니다. 이 factory는
[kma-forecast-request-factory.md](./kma-forecast-request-factory.md)의 PR #9 forecast request
factory와 **같은 원칙을 따르는 별도의, 병렬** 구현입니다 — 주입된 clock의 현재시각과 PR #64 순수
selector(`selectLatestKmaCurrentObservationBaseTime`)를 사용해 `baseDate`/`baseTime`을 고르고,
호출자가 이미 계산한 격자 좌표(nx/ny)와 결합해 완성된 `KmaCurrentObservationRequest`를
**조립**할 뿐입니다.

구현 위치:

- [kma-current-observation-request.ts](../apps/api/src/services/kma-current-observation-request.ts)
  — request factory
- [kma-current-observation-request 테스트](../apps/api/src/services/kma-current-observation-request.test.ts)

## 목적

- **주입된 clock**의 현재시각(절대 epoch milliseconds)과 PR #64
  `selectLatestKmaCurrentObservationBaseTime`을 사용해 `baseDate`/`baseTime`을 고르고, 호출자가
  공급한 `nx`/`ny`와 결합해 완성된 `KmaCurrentObservationRequest`를 만듭니다.

## 현재 pipeline에서의 위치

```text
injected clock
  → reference epoch milliseconds
  → selectLatestKmaCurrentObservationBaseTime (PR #64) → baseDate / baseTime
  → caller-supplied nx / ny 결합
  → 완성된 KmaCurrentObservationRequest
```

이 factory는 요청 **조립까지만** 담당합니다. Provider 호출, application service 연결, 위경도 →
격자 변환, retry/fallback, HTTP route는 이 factory에 포함하지 않습니다.

## forecast request factory와의 차이

이 factory는 [kma-forecast-request-factory.md](./kma-forecast-request-factory.md)의 forecast
factory를 리팩터하거나 두 factory가 공유하는 generic factory로 만들지 않았습니다 — 초단기실황
자체가 forecast와 다른 두 가지 이유를 그대로 반영합니다
([kma-current-observation-issue-time.md](./kma-current-observation-issue-time.md)):

- **`product` 필드가 없습니다.** `getUltraSrtNcst`는 초단기실황의 유일한 operation이므로 factory
  input(`KmaCurrentObservationRequestFactoryInput`)은 `nx`/`ny` 두 필드만 가집니다.
- **주입 가능한 base-time selector seam이 없습니다.** forecast factory는 PR #15에서 두 번째 인자
  `baseTimeSelector`(default: PR #8 schedule-only selector, production은 PR #14
  availability-delay selector를 주입)를 추가했지만, 초단기실황에는 대응하는 availability-delay
  selector가 아직 없습니다 — [kma-current-observation-issue-time.md](./kma-current-observation-issue-time.md)가
  이를 명시적으로 범위 밖이라고 기록합니다. 그래서 이 factory는 `selectLatestKmaCurrentObservationBaseTime`을
  직접 호출하며, 존재하지 않는 policy를 위한 주입 seam을 미리 만들지 않습니다. 이후 초단기실황
  availability-delay selector가 추가되면 그때 이 factory에 같은 모양의 seam을 추가할 수
  있습니다 — 지금 사용되지 않는 seam을 추가하는 것은 미리 앞서가는 abstraction이므로 하지
  않았습니다.

factory의 나머지 구조(injected clock, side-effect-free 생성, 호출당 clock 1회, 새 result union·
error type 없음, fresh output)는 forecast factory와 동일한 원칙입니다.

## 공개 API

```ts
export interface KmaCurrentObservationRequestClock {
  readonly nowEpochMilliseconds: () => number;
}

export interface KmaCurrentObservationRequestFactoryInput {
  readonly nx: number;
  readonly ny: number;
}

export interface KmaCurrentObservationRequestFactory {
  createScheduledRequest(
    input: KmaCurrentObservationRequestFactoryInput,
  ): KmaCurrentObservationRequest;
}

export function createKmaCurrentObservationRequestFactory(
  clock: KmaCurrentObservationRequestClock,
): KmaCurrentObservationRequestFactory;
```

메서드 이름이 `createScheduledRequest`인 이유는 forecast factory와 동일합니다: selector가 최신
공식 **발표 schedule**만 선택하며, 실제 API 자료가 준비됐음(availability)을 보장하지 않기
때문입니다.

## injected clock contract

clock은 **외부에서 주입**하며, factory는 시스템 clock을 직접 읽지 않습니다.

- `nowEpochMilliseconds()`는 현재 instant를 **절대 epoch milliseconds(UTC)** 로 반환합니다.
- **factory 생성 시 clock을 호출하지 않습니다**(side-effect-free 생성).
- `createScheduledRequest()`를 호출할 때마다 clock을 **정확히 한 번** 호출합니다.
- clock callback에는 **argument를 전달하지 않습니다.**
- 한 호출에서 얻은 epoch value를 selector에 **그대로** 전달합니다 — 반올림·truncate·보정·coercion을
  하지 않습니다.

## 생성은 side-effect-free

`createKmaCurrentObservationRequestFactory(clock)`는 순수 생성입니다: clock을 호출하지 않고,
환경변수를 읽지 않고, I/O·timer·listener를 만들지 않습니다. 반환된 객체는 `clock` reference를
close over할 뿐입니다. 같은 instance를 여러 번 사용할 수 있고, mutable state를 갖지 않으며, 각
호출은 이전 호출의 결과·기록과 무관합니다.

## 요청 조립

결과는 기존 `KmaCurrentObservationRequest`이며 정확히 네 필드만 포함합니다.

```ts
{
  baseDate,  // selector 결과
  baseTime,  // selector 결과
  nx,        // caller-supplied
  ny,        // caller-supplied
}
```

- 필드는 명시적으로 작성하며 **input 전체를 object spread로 반환하지 않습니다.** runtime에서 추가
  property가 들어와도 결과에 유출되지 않고, 요청 shape가 고정됩니다.
- 결과에는 다음을 넣지 않습니다: `referenceEpochMilliseconds`, clock, URL, ServiceKey, Provider
  metadata, raw input object, 그 밖의 임의 property.

## fresh output / 불변성

- 매 호출마다 **새로운 request 객체**를 반환합니다.
- input을 읽기만 하고 **mutate하지 않으며**, frozen input에서도 동작합니다.
- 첫 결과를 runtime cast로 mutate해도 이후 호출 결과에 영향이 없습니다.
- 같은 input과 같은 clock value에 대해 deep-equal 결과를 반환하되, 반환 reference는 서로 다릅니다.
- 서로 다른 격자 좌표를 번갈아 호출해도 state가 누적되지 않습니다.

## nx/ny는 이미 계산돼 있어야 함

- 이 request factory는 **nx/ny를 직접 입력받습니다.** 위·경도 → 격자 변환은 이 factory가 하지
  않습니다. forecast 쪽과 마찬가지로, 그 변환을 이 factory와 잇는 location adapter는 이 PR
  범위가 아닙니다.
- factory는 valid·typed 격자 좌표가 공급된다고 가정하고, nx/ny를 변환·반올림·문자열화·기본값
  적용·swap·clamp하지 않습니다.
- **runtime trust-boundary validation은 Provider가 계속 소유합니다.** factory는
  `validateKmaCurrentObservationRequest`를 다시 호출하지 않습니다.

## 오류 전파 (selector/clock 오류 그대로)

이 factory는 새로운 result union도, 새로운 오류 type도 만들지 않습니다.

- **selector 오류**: PR #64의 `RangeError`(invalid epoch milliseconds, 지원 연도 범위 밖)를
  catch하거나 다른 오류로 wrapping하지 않고 **그대로** 전파합니다.
- **clock 오류**: 주입된 clock이 throw하면 **동일한 error reference**가 그대로 전파됩니다.
- 광범위한 `try/catch`, invented 오류, 오류 메시지 재작성, raw input 추가, logging을 하지
  않습니다.

## 시스템 clock 직접 사용 없음

- `Date.now()`·`new Date()`·`performance.now()`·`process.hrtime()`·`process.env`·global clock·기본
  clock fallback·timer·fake timer runtime을 사용하지 않습니다.
- clock은 오직 주입으로만 제공됩니다.

## Provider 자동 연결 없음 / 후속 wiring 없음

- factory는 Provider를 생성·호출하지 않습니다.
- factory output도 Provider에서 기존과 동일하게 runtime validate됩니다(schedule selection과
  Provider validation의 책임 구분 유지 — [kma-current-observation-provider.md](./kma-current-observation-provider.md)).
- 이 factory를 hourly-forecast의 PR #10 scheduled facade와 같은 방식으로 application
  service/composition/route에 연결하는 작업은 이 PR 범위가 아닙니다.

## 실제 key·외부 네트워크 테스트 없음

- 실제 `KMA_SERVICE_KEY`를 사용하지 않았습니다.
- 자동 테스트는 실제 네트워크를 호출하지 않고, 실제 selector와 작은 in-memory clock callback만
  사용합니다. Provider를 생성·mock하지 않고, fake timer를 사용하지 않습니다.

## 후속 wiring

1. latitude/longitude 입력을 격자로 변환해 이 request factory와 연결하는 application adapter
2. current-observation을 소비하는 application service/composition
3. current-observation 전용 system clock 주입(또는 forecast와 동일한 clock adapter 재사용) —
   composition 선택 사항
4. `WeatherOverview`의 `current` section 조립, `SourceMetadata`
5. `POST /weather`로의 current 데이터 연결
6. current-observation availability-delay selector(존재하게 되면)를 위한 injectable selector
   seam 추가 여부 재검토

## 변경 이력

```text
v1 / PR #66 / 2026-08
- injected clock 기반 KMA current-observation request factory 추가
- PR #64 issue-time selector(selectLatestKmaCurrentObservationBaseTime)와 nx/ny 결합
- product 필드 없음, 주입 가능한 base-time selector seam 없음(대응 availability-delay selector가
  아직 없으므로 미리 추가하지 않음)
- forecast request factory(PR #9)와 별도·병렬 구현, 어느 쪽도 리팩터하지 않음
- Provider 자동 호출·격자 변환·application service·composition·route·POST /weather 연결은
  이 PR 범위 밖
```
