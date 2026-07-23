# KMA live selected-source metadata resolver

이 문서는 PR #26에서 추가한 **live selected-source metadata resolver**
(`createKmaLiveSelectedHourlySourceMetadataResolver`)와 공개 issuedAt converter
(`convertKmaForecastIssuanceToIssuedAt`)의 책임과 경계를 기록합니다.

## 목적

- PR #24 location hourly-overview application service는 selected source의 provenance를 결정하는
  **resolver seam**만 정의하고, 실제 resolver는 주입받도록 설계되어 있었습니다.
- PR #25 fallback execution trace는 실제 request plan에서 파생한 **sanitized issuance identity**
  (`primaryIssuance`, fallback 시 `previousIssuance` — `product`/`baseDate`/`baseTime`만)를 보존합니다.
- 이 PR은 그 보존된 identity를 소비해 PR #23 assembler가 필요로 하는 네 provenance 값
  (`sourceId`/`issuedAt`/`fetchedAt`/`retrievalMode`)을 생성하는 **live production resolver**를
  구현합니다.
- 이 PR은 resolver runtime과 그 unit/integration test만 추가합니다. production composition·`/weather`
  route·cache는 포함하지 않습니다(아래 "범위 밖" 참조).

## 구현 위치

- [kma-selected-hourly-source-metadata.ts](../apps/api/src/services/kma-selected-hourly-source-metadata.ts) — resolver + converter
- [kma-selected-hourly-source-metadata.test.ts](../apps/api/src/services/kma-selected-hourly-source-metadata.test.ts) — 테스트

이 위치(`apps/api/src/services`)에 두는 이유:

- selected execution trace identity를 `SourceMetadata` provenance로 변환하는 **application-layer**
  로직입니다.
- Provider boundary가 아니며, `weather-core` 순수 domain 계산도 아닙니다.

허용 import는 contracts public surface, weather-core `KmaForecastProduct`, 그리고 기존 services의 sibling
public type뿐입니다.

```ts
import { isoDateTime, type SourceMetadata } from '@life-weather/contracts';
import { KmaForecastProduct } from '@life-weather/weather-core';

import type { KmaForecastIssuanceIdentity } from './kma-forecast-issuance-identity';
import type {
  KmaSelectedHourlySourceMetadataResolver,
  KmaSelectedHourlySourceMetadataResolverInput,
} from './kma-location-hourly-overview';
```

Provider 호출·request/request-plan factory·selector·assembler·composition import·Hono·`process.env`·
`fetch`·`AbortController`·external timezone/date library·신규 dependency는 사용하지 않습니다. Provider
private validation deep import도 사용하지 않으며, 검증은 contracts public `isoDateTime` schema와
module-local structural parsing으로만 합니다.

## 공개 API

```ts
export interface KmaSelectedHourlySourceMetadataClock {
  readonly nowEpochMilliseconds: () => number;
}

export function convertKmaForecastIssuanceToIssuedAt(
  issuance: KmaForecastIssuanceIdentity,
): NonNullable<SourceMetadata['issuedAt']>;

export function createKmaLiveSelectedHourlySourceMetadataResolver(
  clock: KmaSelectedHourlySourceMetadataClock,
): KmaSelectedHourlySourceMetadataResolver;
```

추가 public class는 만들지 않습니다.

## selected PRIMARY / PREVIOUS identity mapping

resolver는 PR #22 selected selection arm(`selected: true`)에서 실제 실행된 issuance identity를 선택합니다.

| selection.source | 사용하는 identity | 비고 |
| --- | --- | --- |
| `PRIMARY` | `selection.execution.primaryIssuance` | 모든 trace branch에 존재. exact reference로 읽음 |
| `PREVIOUS` | `selection.execution.previousIssuance` | `execution.fallbackAttempted === true`인 경우에만 존재 |

- fallback execution 안에서 usable primary와 previous를 모두 가진 (구조적으로 유효한) trace라도, selection
  이 `PRIMARY`이면 반드시 `primaryIssuance`를 사용합니다(PRIMARY precedence).
- selection이 `PREVIOUS`인데 execution이 `fallbackAttempted: false`이면 static `RangeError`
  (`Selected PREVIOUS source requires a fallback execution`)를 던집니다.
- 이 resolver는 selector policy를 재실행하지 않고, hourly data usability·`resultCode`·error kind·fallback
  eligibility를 재검사하지 않습니다. selection 결과를 신뢰하되 source ↔ execution arm의 **구조적
  correlation**만 방어합니다.

## issuedAt — KST 변환

`convertKmaForecastIssuanceToIssuedAt`은 issuance의 provider-native `baseDate`(`YYYYMMDD`)와
`baseTime`(`HHmm`)을 KST ISO instant로 변환합니다.

- 형식: `YYYY-MM-DDTHH:mm:00+09:00`
- 예: `20260722` + `0200` → `2026-07-22T02:00:00+09:00`
- `+09:00`을 사용해 KMA provider-native 발표시각 의미를 보존합니다.
- seconds 필수, milliseconds 없음.
- **별도 clock을 사용하지 않고**, `Date` 객체로 KST 변환하지 않으며, `Date.parse`·locale formatting·
  coercion·default date/time도 사용하지 않습니다. explicit string assembly만 사용합니다.
- request plan 또는 candidate selector를 재호출하지 않습니다.
- `SHORT_FORECAST`와 `ULTRA_SHORT_FORECAST`는 동일 `baseDate`/`baseTime`에서 동일 `issuedAt`을 만듭니다.

### schedule canonicality 재검증 안 함

이 converter는 **공식 schedule canonicality를 재검증하지 않습니다.** 예를 들어 structurally valid한
non-canonical `0615`도 `2026-07-22T06:15:00+09:00`으로 변환됩니다. schedule 선택 책임은 기존 weather-core
selector에 있고, converter는 실제 request identity를 ISO instant로 표현하는 책임만 가집니다.

### 검증 예

허용: `20260722`/`0200`, `20240229`/`2359`, `20260101`/`0000`, structurally valid `0615`.

거부(모두 static `RangeError`): `20260229`(비윤년 2/29), `20261301`(월 13), `20260001`(월 00),
`20260700`(일 00), `2026-07-22`(dash 포함), `2400`, `1260`, `200`, empty string, unsupported product,
null/non-object runtime cast.

calendar/time/ISO validity는 contracts public `isoDateTime.safeParse`로 확인합니다(`isoDateTime`이
비윤년 2/29, 월 13, 일 00, 시 24, 분 60 등 불가능한 값을 거부).

## sourceId — exact mapping

product별 고정 app-internal `sourceId`이며, 고정 `switch`로 매핑합니다(object spread·dynamic string
assembly 없음).

| product | sourceId |
| --- | --- |
| `SHORT_FORECAST` | `kma-short-forecast-hourly` |
| `ULTRA_SHORT_FORECAST` | `kma-ultra-short-forecast-hourly` |

`sourceId`에는 다음을 포함하지 **않습니다.**

- `PRIMARY`/`PREVIOUS`
- `fallbackUsed`
- `baseDate`/`baseTime` / `issuedAt`
- location ID / latitude/longitude / nx/ny

`sourceId`는 **logical source**를 식별하고, 개별 발표본은 `issuedAt`이 식별합니다. unsupported product는
static `RangeError`(`Unsupported KMA forecast product`)이며 clock을 읽지 않습니다.

## fetchedAt — semantic

이 live resolver에서 `fetchedAt`은 다음을 의미합니다.

> "fallback execution과 source selection이 완료된 뒤, selected source의 metadata를 materialize한 서버
> 시각."

이는 다음이 **아닙니다.**

- HTTP request dispatch 시각
- response header 수신 시각
- body read 시작 시각
- exact Provider transport completion timestamp

현재 execution trace에는 attempt별 transport timestamp가 없으므로 resolver 호출 시각이 정직하고 사용
가능한 근사값입니다.

### 형식

- UTC `Z`
- 정확히 3자리 milliseconds
- 예: `2026-07-22T01:23:45.678Z`

`new Date`는 `fetchedAt` 변환에서만 사용하며, `issuedAt` 변환에는 사용하지 않습니다.

- `Number.isSafeInteger(epochMilliseconds)`로 값을 확인하고, `new Date(...)`의 `getTime()`이 finite인지
  확인한 뒤, `date.toISOString()` 결과를 다시 `isoDateTime.safeParse`로 확인합니다.
- 허용: `0`, negative valid epoch, current epoch, millisecond precision.
- 거부(모두 static `RangeError`, `Invalid KMA source metadata clock value`): `NaN`, `Infinity`,
  `-Infinity`, fractional number, unsafe integer, Date 범위 밖, ISO contract가 받지 못하는 결과.
- raw clock value는 error message에 포함하지 않습니다.

## resolver clock call policy

- **construction**: clock 0회, environment 0회, network 0회, `Date` 0회, selector 0회, state/cache 0개.
- **유효한 selected input 처리**: injected clock을 **정확히 1회** 읽습니다.
- **invalid input**: clock을 **0회** 읽습니다(모든 검증이 clock 읽기 전에 수행됨).

resolver 호출 순서:

1. selected input 구조 확인
2. selected issuance 결정
3. `input.product === issuance.product` 확인
4. `sourceId` 결정
5. `issuedAt` 변환
6. `clock.nowEpochMilliseconds()` 정확히 1회
7. `fetchedAt` 변환
8. fresh metadata object 반환

## LIVE-only 정책

`retrievalMode`는 고정 `LIVE`입니다. 이 resolver는 live KMA Provider pipeline 전용이며 `CACHE`·`UNKNOWN`을
반환하지 않습니다.

## cache future policy

향후 cache layer는 이 live resolver를 그대로 사용하지 **않습니다.** cache layer는:

- 저장된 upstream `fetchedAt`을 보존하고,
- `retrievalMode: 'CACHE'`를 사용하며,
- cache read 시각으로 upstream `fetchedAt`을 덮어쓰지 않습니다.

이번 PR에서는 cache를 구현하지 않습니다.

## product correlation

resolver는 selected issuance를 얻은 뒤 clock을 읽기 **전에** 다음을 확인합니다.

```text
input.product === selectedIssuance.product
```

불일치하면 static `RangeError`(`Selected KMA issuance product does not match resolver input`)를 던집니다.
목적은 caller product · actual request-plan product · sourceId mapping 간 drift 방지입니다.

`location`은 source metadata 생성에 **사용하지 않습니다.**

- location별 sourceId 금지
- location 재검증 금지
- location mutation 금지

PR #24가 이미 parsed `WeatherLocation`을 전달합니다.

## malformed identity defensive error

TypeScript 타입을 우회한 runtime input에 대해서도 방어합니다. 다음은 모두 static `RangeError`입니다.

- non-object issuance / unsupported product / malformed `baseDate`·`baseTime` → converter
- non-selected(`selected !== true`) / unknown source → `Invalid selected KMA hourly source selection`
- `PREVIOUS` + no-fallback execution → `Selected PREVIOUS source requires a fallback execution`
- product mismatch → `Selected KMA issuance product does not match resolver input`
- unsupported product(sourceId) → `Unsupported KMA forecast product`
- invalid clock value → `Invalid KMA source metadata clock value`

모든 error message는 **static**이며 원본 malformed 값을 포함하지 않습니다.

## direct sync error vs PR #24 Promise rejection

- converter/resolver를 **직접** 호출하면 위 모든 오류와 injected clock throw는 **synchronous**하게 동일
  error reference로 전파됩니다(broad catch·wrap·logging·result union·fallback/partial metadata 없음).
- PR #24 service 안에서 resolver는 facade Promise의 `.then` fulfillment handler 안에서 호출되므로, 그
  synchronous throw는 service가 반환한 Promise를 **동일 error reference**로 reject시킵니다.

invalid selection/issuance/product는 clock을 읽기 **전에** 실패합니다.

## exact output keys

resolver output own key는 정확히 다음 네 개이며 정렬 순서는 다음과 같습니다.

- `fetchedAt`
- `issuedAt`
- `retrievalMode`
- `sourceId`

```ts
{
  fetchedAt,   // UTC Z, ms
  issuedAt,    // +09:00, seconds
  retrievalMode: 'LIVE',
  sourceId,    // fixed per product
}
```

## no leakage

output에 다음 field가 없어야 합니다.

`provider`·`sections`·`observedAt`·`product`·`location`·`selection`·`execution`·`fallbackUsed`·
`fallbackAttempted`·`source`·`baseDate`·`baseTime`·`nx`·`ny`·`request`·`plan`·`ServiceKey`·`URL`·`query`·
raw body·`stale`.

`provider`/`sections`/`observedAt`은 PR #23 assembler가 소유합니다. output에는 issuance object reference를
포함하지 않습니다.

## purity / mutation / freshness

- resolver input·location·selection·execution·issuance·selected result·clock·hourly data를 mutate하지
  않습니다. frozen input에서도 정상 동작합니다.
- 호출마다 fresh metadata object를 반환합니다 — 동일 input과 동일 clock value라도 wrapper reference는
  다릅니다.
- 이전 output mutation이 다음 호출에 영향을 주지 않습니다.
- module-level mutable object가 없습니다. source ID table은 immutable constant뿐입니다.
- selected issuance는 읽기만 하며 clone하지 않아도 되고, output에 그 reference를 포함하지 않습니다.

## composition (PR #27에서 조립됨)

이 resolver 자체는 어떤 production composition을 내장하지 않습니다(factory는 clock만 close over). **PR #27
갱신**: PR #27의 다섯 번째 callable root(`createKmaLocationHourlyOverviewCompositionFromEnv`,
[kma-location-hourly-overview-composition.md](./kma-location-hourly-overview-composition.md))가 PR #21
location fallback root + 이 resolver + PR #24 service를 조립합니다. 이로써 callable production composition
root 수는 **5**개(grid scheduled·location scheduled·grid fallback·location fallback + location hourly
overview)가 됩니다. 이 resolver의 공개 API·runtime은 PR #27로도 **불변**입니다. 다섯 번째 root 역시 아직
`/weather` route·startup에 연결되지 않았습니다.

## route / cache 미구현

- `/weather` route 없음
- HTTP status/envelope mapper 없음
- cache / stale-data 없음
- mobile response mapper 없음

future route는 internal `{ selection, execution }`을 그대로 serialize하지 않고 overview-only mapping을
사용해야 한다는 기존 원칙을 유지합니다.

## tests

- unit: converter(valid/invalid/purity), resolver PRIMARY/PREVIOUS, invalid correlation(clock 0회),
  clock handling(throw/NaN/Infinity/-Infinity/fractional/unsafe/Date 범위/0/negative/UTC Z/3자리 ms).
- integration: 실제 `createKmaLocationHourlyOverviewService` + 기본 `selectKmaHourlyFallbackResult` +
  기본 `assembleKmaHourlyWeatherOverview` + 이 resolver로 PRIMARY/PREVIOUS/no-selection/LOCATION/malformed
  issuance/clock throw 경로를 검증합니다. facade만 fake합니다.
- shuffle seed 1/2/17에서 통과합니다.

## 범위 밖

- production composition / fifth callable composition root
- system-clock adapter 변경 / environment/config wiring
- route / HTTP status/envelope mapper
- cache / stale-data / attempt별 transport timestamp / Provider timestamp
- current / daily / AQ / alerts
- `SourceMetadata` contract 변경 / selection·public application result 변경
- ServiceKey E2E / logging/analytics
- sourceId에 issuance/location/fallback 정보 포함

## 변경 이력

```text
v1 / PR #26 / 2026-07
- live selected-source metadata resolver + 공개 issuedAt converter
- PRIMARY → primaryIssuance, PREVIOUS → previousIssuance
- issuedAt: KST +09:00 seconds (Date 미사용)
- sourceId: product별 고정 (kma-short-forecast-hourly / kma-ultra-short-forecast-hourly)
- retrievalMode: LIVE 고정
- fetchedAt: resolver-time clock, UTC Z ms
- clock: 유효 입력당 1회, invalid 입력 0회, throw는 동일 reference 전파
- production composition/route/cache 제외 (PR #27 예정)

v2 / PR #27 / 2026-07 (production composition 조립; 이 resolver runtime은 불변)
- createKmaLocationHourlyOverviewCompositionFromEnv(다섯 번째 callable root)가 이 resolver를 주입해 조립
  ([kma-location-hourly-overview-composition.md](./kma-location-hourly-overview-composition.md))
- injected clock 주입 시 request plan과 이 resolver가 같은 clock reference 공유, 생략 시 resolver용 fresh system clock
- callable production composition root 수 4 → 5; 이 resolver의 공개 API·runtime 불변
- /weather route·startup·cache는 여전히 미구현
```
