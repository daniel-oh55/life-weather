# KMA 중기육상예보 날씨 문구(WF) 정규화

이 문서는 `@life-weather/weather-core`가 기상청(KMA) **중기육상예보**(`getMidLandFcst`)가
제공하는 한국어 날씨 문구 `WF`를 공통 `WeatherCondition` subset으로 정규화하는 규칙을
기록합니다.

구현 위치: [midterm-condition.ts](../packages/weather-core/src/kma/midterm-condition.ts)

## 책임

`normalizeKmaMidtermWeatherCondition(weatherPhrase)`는 중기육상예보가 반환하는 사람이 읽는
한국어 문구(`WF`) 하나를 입력받아, 공통 `WeatherCondition`에 할당 가능한 좁은 literal union
(`KmaMidtermWeatherCondition`)으로 정규화하는 **순수·결정론적 정책**만 제공합니다. 실제 KMA 호출,
`regId` 매핑, `DailyForecast` 조립은 이 모듈의 책임이 아닙니다(아래 "이번 PR의 경계" 참고).

## 출처

| 항목 | 값 |
| --- | --- |
| 공식 서비스명 | 기상청_중기예보 조회서비스 |
| 자료 | 중기예보 DB정보 |
| 테이블 | `FCT_AFS_WL` : 중기육상 |
| 필드 | `WF_SKY_CD`, `WF_PRE_CD`, `WF` |
| 확인 날짜 | 2026-09-01 |

이 문서는 공식 자료가 가능한 모든 완전한 한국어 `WF` 문장을 나열한다고 주장하지 않습니다.
공식 자료는 sky/precipitation 코드의 의미만 정의하며, `WF`는 그 의미를 사람이 읽도록 표현한
한국어 문구입니다. `WF`가 임의의 자연어라는 뜻은 아닙니다 — 이 정규화는 공식 의미 token만
보수적으로 해석하며, 그 덕분에 `한때`/`가끔` 같은 KMA modifier가 나타나도 모든 문장을 나열할
필요가 없습니다.

### 공식 하늘상태(Sky) semantic 값

| 원본 코드 | 공식 의미 |
| --- | --- |
| `WB01` | 맑음 |
| `WB02` | 구름조금 |
| `WB03` | 구름많음 |
| `WB04` | 흐림 |

### 공식 강수(Precipitation) semantic 값

| 원본 코드 | 공식 의미 |
| --- | --- |
| `WB00` | 강수없음 |
| `WB09` | 비 |
| `WB10` | 소나기 |
| `WB11` | 비/눈 |
| `WB13` | 눈/비 |
| `WB12` | 눈 |

외부 제공에서는 비/눈과 눈/비를 같은 의미로 취급할 수 있다고 공식 자료가 설명합니다. 공식 예시
문구는 `구름많고 비`입니다. 실제 KMA 자료에는 `흐리고 비`, `흐리고 한때 비`, `흐리고 가끔 비` 같은
modifier 형태도 나타납니다.

## 정규화 정책

이 정규화는 **좁게 anchor된 grammar**만 인식합니다. 임의의 substring 포함 여부(`includes('비')`,
`includes('눈')` 같은 검사)는 사용하지 않습니다 — `비교적 맑음`, `비슷함`, `비정상`, `눈부심`,
`눈부신 날`, `눈높이`처럼 강수 음절을 우연히 포함하는 무관한 단어를 강수로 오분류하지 않기
위해서입니다.

1. **입력 처리.** 문자열이 아닌 값, `null`, `undefined`, 빈 문자열, 공백만 있는 문자열은 모두
   `UNKNOWN`입니다. `WF`는 opaque 코드가 아니라 사람이 읽는 텍스트이므로 표현상의 공백 차이는
   의미를 바꾸지 않습니다 — 매칭 목적으로만 `weatherPhrase.replace(/\s+/gu, '')`로 공백을
   제거하며, 호출자 문자열은 변경하지 않습니다.
2. **하늘상태만 있는 문구는 정규화한 문구 전체가 정확히 일치할 때만 인식합니다(exact
   whole-string match, substring match 아님).** 지원하는 값은 `맑음` → `CLEAR`,
   `구름조금`/`구름많음` → `PARTLY_CLOUDY`, `흐림` → `CLOUDY`뿐입니다. 따라서 `매우맑음주의`,
   `구름많음주의`, `흐림예상외문구`처럼 지원 문구가 지원되지 않는 주변 텍스트 안에 완전히
   포함되어 있어도 전체 문자열이 일치하지 않으므로 `UNKNOWN`입니다.
3. **강수는 좁게 anchor된 grammar 전체와 일치할 때만 인식하고, 하늘상태보다 우선합니다.**
   정규화한 문구 전체가 다음 구조와 정확히 일치해야 합니다.

   ```text
   [선택: 지원하는 하늘/연결 접두어] [선택: 지원하는 modifier] [강수 atom]
   ```

   - 지원하는 접두어: `맑고`, `구름많고`, `흐리고`
   - 지원하는 modifier: `한때`, `가끔`
   - 강수 atom(정확히 하나): `비`, `눈`, `소나기`, `비/눈`, `눈/비`

   `맑고 비`처럼 하늘/강수 표현이 기상학적으로 모순되어 보여도 거부하지 않고 `RAIN`을
   반환합니다. 이 grammar 전체와 일치하지 않으면(예: 지원하지 않는 접두어·modifier가 붙거나,
   강수 음절이 무관한 단어의 일부인 경우) 강수로 인식하지 않습니다.
4. **강수 atom → `WeatherCondition` 매핑.** grammar가 문구 전체와 일치했을 때만, 캡처한 atom을
   다음과 같이 정확히 매핑합니다: `비/눈` → `SLEET`, `눈/비` → `SLEET`, `소나기` → `SHOWER`,
   `비` → `RAIN`, `눈` → `SNOW`. 두 음절이 문구 어딘가에 각각 나타난다고 해서(예:
   `소나기 후 비`처럼 grammar에 없는 문장) 혼합 강수로 추론하지 않습니다.
5. **알 수 없는 문구 → `UNKNOWN`.** 위 두 grammar(하늘상태 exact match, 강수 anchored grammar)
   중 어느 것과도 전체 일치하지 않는 모든 문구(`안개`, `천둥번개`, 강수 음절을 포함한 무관한
   단어, 지원 문구가 포함된 미지원 주변 텍스트, 인식되지 않는 미래 문구, 임의 영어, 손상된
   텍스트 포함)는 예외를 던지지 않고 `UNKNOWN`을 반환합니다. 이 정책은 현재 중기예보 상품이
   제공하지 않는 `FOG`/`THUNDERSTORM` 같은 새 값을 발명하지 않으며, 일반적인 한국어 문장 해석을
   목표로 하지 않습니다 — 이 PR이 근거로 삼는 공식 semantic token과 evidence-backed
   connector/modifier 형태만 좁게 인식합니다.

### `구름조금`이 단기예보와 다른 이유

기존 단기·초단기예보 SKY 정규화(`condition.ts`)는 현재 단기예보 가이드에서 폐지된 숫자 SKY
코드 `2`(구름조금)를 `UNKNOWN`으로 처리합니다([kma-normalization.md](./kma-normalization.md)
참고). 그러나 현재 공식 **중기예보** DB 정의는 `WB02 = 구름조금`을 여전히 명시적으로 나열하므로,
이 mid-term 모듈은 `구름조금`을 공식 값으로 지원합니다. 두 정규화는 서로 다른 KMA 상품의 서로
다른 공식 코드 집합을 다루는 **별도·병렬 정책**이며, 한쪽의 폐지 규칙이 다른 쪽으로 복사되지
않습니다.

## 순수·결정론적 경계

`normalizeKmaMidtermWeatherCondition`은 다음을 보장합니다.

- 동기 함수이며 `fetch`, `Date.now()`/현재 `Date`, `Intl`, `process.env`, 로깅, 캐시, 전역
  가변 상태, singleton을 전혀 사용하지 않습니다.
- 입력 문자열을 mutate하지 않습니다.
- 동일 입력은 항상 동일 결과를 반환합니다.
- 알 수 없거나 손상된 입력에도 절대 throw하지 않습니다.

## Runtime dependency 경계

이 모듈은 기존 단기·초단기 KMA 정규화 모듈과 동일하게 runtime에서 `@life-weather/contracts`나
Zod를 import하지 않습니다. `KmaMidtermWeatherCondition`이 공통 `WeatherCondition`에 할당
가능하다는 사실은 `packages/weather-core/src/__tests__/kma-midterm-condition.test.ts`의 컴파일
타임 타입 테스트(Method B)로만 검증합니다.

## 이번 PR의 경계

이번 PR은 다음을 포함하지 **않습니다**.

- `DailyForecast[]` 생성 또는 D+4~D+10 정규화 파이프라인 조립(후속 PR #103 범위).
- 위치 → `regId` resolver.
- provider/service/composition/route 변경.
- 실제 KMA API 호출.

## 변경 이력

```text
v1 / PR #102 / 2026-09
- KMA 중기육상예보 WF 한국어 문구 → WeatherCondition 정규화 최초 도입.
- 출처: 기상청_중기예보 조회서비스, 중기예보 DB정보, FCT_AFS_WL(중기육상), 확인일 2026-09-01.

v1.1 / PR #102 remediation / 2026-09
- 하늘상태/강수 판정을 substring 포함 검사에서 exact whole-string match / anchored grammar로
  강화. 강수 음절을 포함하지만 무관한 단어(`비교적 맑음`, `눈부심` 등)와 지원 문구가 미지원
  주변 텍스트에 포함된 경우(`매우맑음주의` 등)가 오분류되던 fail-open 결함을 fail-closed로
  수정.
```
