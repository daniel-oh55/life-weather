# KMA 위·경도 → 동네예보 격자 변환 (grid conversion)

이 문서는 `@life-weather/weather-core`가 대한민국 위치의 **위도·경도**를 기상청(KMA)
동네예보 단기·초단기예보 요청에 필요한 **격자 좌표**(`nx` / `ny`)로 변환하는 순수 함수
(`convertKmaLatitudeLongitudeToGrid`)를 기록합니다. 변환 계약(상수·수식·범위)은 추측이나
블로그가 아니라 아래 공식 자료에서 직접 확인한 값만 사용합니다.

구현 위치:

- [grid.ts](../packages/weather-core/src/kma/grid.ts) — 위·경도 → 격자 변환 순수 함수
- [grid 테스트](../packages/weather-core/src/kma/grid.test.ts)

## 목적

호출자가 제공한 위도·경도를 기상청 동네예보 격자 좌표로 변환합니다.

```text
latitude / longitude
  → KMA DFS Lambert Conformal Conic projection
  → KMA forecast grid { nx, ny }
```

- 지원하는 위치이면 `{ nx, ny }`를 반환합니다.
- 지리적으로는 유효하지만 KMA 동네예보 격자가 지원하지 않는 위치이면 `null`을 반환합니다.
- 숫자 형식 또는 물리적 위·경도 자체가 잘못됐으면 `RangeError`를 던집니다.

이 PR은 **변환 함수만** 구현합니다. API route, query validation, application service 연결,
composition wiring, 역변환(격자 → 위·경도), 외부 KMA 좌표변환 API 호출은 포함하지 않습니다.

## 공개 API

```ts
export interface ConvertKmaLatitudeLongitudeToGridInput {
  readonly latitude: number;
  readonly longitude: number;
}

export interface KmaForecastGridCoordinate {
  readonly nx: number;
  readonly ny: number;
}

export function convertKmaLatitudeLongitudeToGrid(
  input: ConvertKmaLatitudeLongitudeToGridInput,
): KmaForecastGridCoordinate | null;
```

### 입력 (field 순서와 의미)

- `latitude` — 위도(십진 degree, WGS84, 북위 양수). 물리적으로 `[-90, 90]`.
- `longitude` — 경도(십진 degree, WGS84, 동경 양수). 물리적으로 `[-180, 180]`.

field 순서는 `latitude`, `longitude` 순입니다.

### 출력 (`nx` / `ny`)

- `nx` — 격자 동서(가로) 번호, `1 ~ 149` 정수.
- `ny` — 격자 남북(세로) 번호, `1 ~ 253` 정수.

출력 object의 own key는 **정확히 `nx`, `ny`** 두 개뿐입니다. `latitude`/`longitude`,
source metadata, raw 상수 같은 부가 필드는 노출하지 않습니다.

## 반환 정책: `null`과 `RangeError`의 경계

물리적 좌표 범위와 KMA coverage 범위는 **다른 개념**입니다.

### `RangeError` — 잘못된 호출자 입력

다음은 애초에 좌표로 쓸 수 없는 값이므로 `RangeError`입니다.

- `latitude`/`longitude`가 number가 아님(런타임 string·null·undefined 등)
- `NaN`, `Infinity`, `-Infinity`
- `latitude`가 `[-90, 90]` 밖
- `longitude`가 `[-180, 180]` 밖

오류 메시지는 **field와 정책만** 설명하고, raw 입력 값을 포함하거나 input object를 직렬화하지
않습니다. secret-shaped 런타임 값도 메시지에 반영되지 않습니다.

| 상황 | 메시지 |
| --- | --- |
| 위도가 유한 숫자가 아님 | `latitude must be a finite number` |
| 경도가 유한 숫자가 아님 | `longitude must be a finite number` |
| 위도가 물리 범위 밖 | `latitude must be within [-90, 90]` |
| 경도가 물리 범위 밖 | `longitude must be within [-180, 180]` |

### `null` — 유효하지만 지원하지 않는 위치

다음은 지리 좌표로는 유효하지만 현재 KMA 동네예보 격자가 지원하지 않는 위치이므로 `null`입니다
(throw하지 않습니다).

- 공식 KMA 위·경도 coverage 범위 밖 (예: 도쿄, 런던, 미국, 시드니).
- 물리적으로는 유효하지만 KMA 범위 밖인 값 (예: 위도 `90`/`-90`, 경도 `180`/`-180`).
- coverage 범위 안이더라도 **투영된 최종 격자**가 `1~149`·`1~253`를 벗어나는 경계 영역.

## 물리 범위 vs KMA coverage 범위

- **물리 범위** — `latitude ∈ [-90, 90]`, `longitude ∈ [-180, 180]`. 벗어나면 `RangeError`.
- **KMA coverage 범위** — 공식 위·경도 입력 안내 범위(inclusive):

  | 축 | 최소 | 최대 |
  | --- | --- | --- |
  | latitude | `31.651814` | `43.393490` |
  | longitude | `123.310165` | `132.774963` |

  이 box 밖이면 `null`.

단, 위도·경도가 각각 이 box 안이라는 사실만으로 항상 유효한 격자는 아닙니다. coverage box는 격자
좌표계에서 회전된 사각형이므로 box의 모서리 일부는 격자 밖으로 투영됩니다. 따라서 **투영된 최종
`nx`/`ny`도 반드시 `1~149`·`1~253` 안**이어야 하며, 벗어나면 clamp하지 않고 `null`을 반환합니다.

> 참고: 위 coverage 안내 값은 API 허브가 공개한 coverage endpoint이며, 실제로 **극단 격자 cell들의
> 중심 좌표**에 해당합니다. `31.651814`는 격자 `(149,1)`의 중심 위도, `43.393490`·`123.310165`는
> 격자 `(1,253)`의 중심 위도·경도, `132.774963`은 격자 `(149,253)`의 중심 경도입니다(공식 projection
> 상수를 이용한 독립 inverse DFS 계산으로 교차 확인).

## KMA 격자와 투영

- KMA 동네예보 격자는 전국을 **5km × 5km** 간격으로 나눈 `149`(동서) × `253`(남북) = `37,697`개
  cell입니다.
- 투영법은 공식 **DFS Lambert Conformal Conic (LCC)** 입니다.

### 격자 범위 (inclusive)

- `nx`: `1 ~ 149`
- `ny`: `1 ~ 253`

### Projection 상수 (전체)

| 상수 | 값 | 의미 (공식 표기) |
| --- | --- | --- |
| Earth radius | `6371.00877 km` | `RE` |
| Grid spacing | `5.0 km` | `GRID` |
| Standard latitude 1 | `30.0°` | `SLAT1` |
| Standard latitude 2 | `60.0°` | `SLAT2` |
| Origin longitude | `126.0°` | `OLON` |
| Origin latitude | `38.0°` | `OLAT` |
| Origin grid X | `43` | `XO` |
| Origin grid Y | `136` | `YO` |

이 상수들은 `grid.ts`의 module-private `const`로만 존재하며 공개 export하지 않습니다. 입력과
무관한 파생 항목(degree→radian, earth radius in grid units, cone constant, scale factor, origin
radial distance 등)은 module import 시 순수 `Math` 계산으로 한 번만 계산되고 외부에 노출되지
않습니다. import 시 environment·system clock·network·mutable cache·lazy 초기화 flag는 쓰지
않습니다.

### Rounding: `floor(value + 0.5)`

가장 가까운 정수 격자는 공식 DFS 구현과 동일하게 `Math.floor(value + 0.5)`로 선택합니다.
대칭 반올림 helper로 임의 단순화하지 않습니다.

```ts
const nx = Math.floor(radialDistance * Math.sin(theta) + ORIGIN_GRID_X + 0.5);
const ny = Math.floor(
  originRadialDistance - radialDistance * Math.cos(theta) + ORIGIN_GRID_Y + 0.5,
);
```

longitude는 임의로 clamp하거나 modulo 처리하지 않고, 공식 수식에 포함된 `±π` 각도 정규화만
적용합니다.

### clamp 없음 / 역변환 없음 / network 없음 / API key 없음

- **clamp 없음** — 투영 결과가 격자 밖이면 0·음수·초과 격자를 만들지 않고 `null`을 반환합니다.
- **역변환 없음** — 이 함수는 위·경도 → 격자 **정방향** 변환만 합니다. 격자 → 위·경도 역변환은
  구현하지 않습니다.
- **network 없음 / API key 없음** — 외부 KMA 좌표변환 API를 호출하지 않습니다. 순수한 로컬 계산만
  수행하므로 인증키·요청도 필요 없습니다.

## 순수성 (deterministic / pure)

- **deterministic** — 같은 입력은 항상 같은 값을 반환합니다.
- **system clock 없음** — 시각을 읽지 않습니다.
- **environment 없음 / locale·timezone 없음 / network 없음.**
- **input mutation 없음** — 입력 object(frozen 포함)를 변경하지 않습니다.
- **fresh result** — 성공 시 매 호출마다 새 결과 object를 반환하므로, 한 결과를 변경해도 다음
  호출 결과에 영향이 없습니다.
- **extra property 미노출** — 입력에 부가 property가 있어도 출력에 반영되지 않습니다.
- **raw value 미노출** — 원본 위·경도가 오류 메시지나 출력 metadata에 노출되지 않습니다.

유일한 의존은 JavaScript 표준 `Math`이며, `weather-core`는 계속 런타임 의존 0개를 유지합니다
(`Date`·`Intl`·`process.env`·`fetch`·`Math.random`·projection library·geocoding API 미사용).

## 대표 fixture와 근거

아래 기대값은 변환 함수 자신의 출력을 다시 복사한 자기검증이 **아닙니다**. 공식 DFS 수학 계약과
공개된 동네예보 격자 정보·공식 projection 상수에 대조해 준비한 값입니다.

| 위치 | 위도 | 경도 | 격자 (nx, ny) | 근거 |
| --- | --- | --- | --- | --- |
| origin 불변식 | `38` | `126` | `43, 136` | `OLAT`/`OLON` → `XO`/`YO` (투영 정의) |
| 서울 | `37.5665` | `126.978` | `60, 127` | 공개 동네예보 격자 정보 + 공식 DFS 계약 대조 |
| 부산 | `35.1796` | `129.0756` | `98, 76` | 공개 동네예보 격자 정보 + 공식 DFS 계약 대조 |
| 제주 | `33.4996` | `126.5312` | `53, 38` | 공개 동네예보 격자 정보 + 공식 DFS 계약 대조 |
| API 허브 예시 | `36.5` | `127.5` | `69, 104` | API 허브 예시 입력 + 공식 DFS 수식 결과 |
| 인천 | `37.4563` | `126.7052` | `55, 124` | 공개 동네예보 격자 정보 + 공식 DFS 계약 대조 |
| 대전 | `36.3504` | `127.3845` | `67, 100` | 공개 동네예보 격자 정보 + 공식 DFS 계약 대조 |
| 광주 | `35.1595` | `126.8526` | `58, 74` | 공개 동네예보 격자 정보 + 공식 DFS 계약 대조 |

### 네 격자 경계 fixture

극단 격자 cell들은 대부분 관할 행정구역이 없는 해상·국경 cell이라 행정구역 기반 격자 위치자료에
직접 나타나지 않습니다. 공식 KMA 격자영역 PDF는 네 극단 cell의 위치를 약 4자리 정밀도로 확인할 수
있게 합니다. 테스트에서 사용하는 6자리 위·경도 tuple은 공식 projection 상수를 이용한 별도의 inverse
DFS 계산으로 준비한 고정 검증 fixture이며, 테스트 실행 중이나 production forward 함수에서 생성하지
않습니다. 해당 값의 일부 극단 성분은 API 허브가 공개한 coverage endpoint
(`31.651814`·`43.393490`·`123.310165`·`132.774963`)와 일치합니다. 다만 이 저장소에는 네 tuple의 실제
인증 API 응답 artifact가 보존되어 있지 않으므로, 이를 "공식 API가 직접 반환한 6자리 좌표"라고
표현하지 않습니다.

| 위도 | 경도 | 격자 (nx, ny) |
| --- | --- | --- |
| `31.794423` | `123.761264` | `1, 1` |
| `31.651814` | `131.642258` | `149, 1` |
| `43.393490` | `123.310165` | `1, 253` |
| `43.217546` | `132.774963` | `149, 253` |

### bounding range 안이지만 격자 밖이면 `null`

`{ latitude: 31.651814, longitude: 123.310165 }`는 위도·경도가 각각 공식 coverage 최소값
(inclusive)이라 coverage box는 통과하지만, 투영하면 최종 격자가 `1~149`·`1~253`를 벗어납니다. 이때
clamp하지 않고 `null`을 반환합니다(음수·0·초과 격자를 만들지 않으며 throw하지도 않습니다). 공식
변환 서비스가 이 입력을 별도로 clamp하는 것으로 확인되면 정책을 재검토합니다.

## 공식 자료

| 항목 | 값 |
| --- | --- |
| 공식 서비스명 | 기상청_단기예보 조회서비스 |
| 공공데이터 ID | `15084084` |
| 참고문서(ZIP) | `기상청41_단기예보 조회서비스_오픈API활용가이드_2607.zip` |
| 공공데이터포털 페이지 수정일 | 2026-07-09 |
| 확인 날짜 | 2026-07-18 |
| 확인 주체 | Claude (Claude Code) |

- **공공데이터포털** — 데이터명 `기상청_단기예보 조회서비스`(ID `15084084`)의 활용가이드가 DFS
  격자 변환 상수·수식·샘플 코드를 제공합니다.
- **기상청 API 허브** — `동네예보 격자 번호 → 위·경도 변환`, `임의 위·경도 → 인근 동네예보 격자
  번호 변환`, 그리고 격자·위경도 지원 범위를 설명합니다.

블로그·개인 gist·Stack Overflow는 공식 근거로 사용하지 않았으며, 공식 자료의 언어별 샘플을 그대로
복사하기보다 수학 계약을 TypeScript로 옮겼습니다.

### 자료 hash

| 파일 | SHA-256 | 이번 세션 확인 |
| --- | --- | --- |
| 2607 ZIP | `07f53cd9d6d6512bce6ef870d54cb740046a0a949896e6855caecf739fb8842e` | 미확인 — 상세페이지 JS 게이트로 재다운로드하지 못함 |
| ZIP 내부 DOCX | `20d855aa3071a2bdda6dce3c13bab6428ebb02f8d4a30688e26ed0851d6d0848` | 미확인 (동일 사유) |

이번 세션에서는 공공데이터포털 상세페이지가 JS 게이트라 파일을 재다운로드해 hash를 대조하지
못했습니다. 다만 구현에 사용한 DFS 상수·격자 범위(`nx 1~149`, `ny 1~253`, 5km, LCC `30/60/126/38`,
origin `43/136`)와 위 공식 coverage 안내 범위는 공개 자료에서 교차 확인되며, 대표 지역 격자값·격자
모서리 좌표와도 일치합니다. 이전 프로젝트 기록의 hash 값과 위 표의 값은 동일합니다.

## 공식 API 허브 변환 서비스와의 관계 — runtime에서 호출하지 않는 이유

기상청 API 허브에는 위·경도 ↔ 격자 변환 서비스가 존재하지만, 이 함수는 그 **네트워크 API를
호출하지 않고** 동일한 공식 수식을 로컬에서 계산합니다. 이유:

- 변환은 상수·수식이 고정된 **결정론적 순수 계산**이라 네트워크 왕복이 불필요합니다.
- `weather-core`는 런타임 의존·network·API key가 없어야 하며, API·모바일 양쪽에서 재사용됩니다.
- 네트워크 호출은 지연·실패·인증 관심사를 끌어들이므로 순수 도메인 계층에 두지 않습니다.

## 향후 API service 연결

이 PR은 변환 함수만 제공합니다. 이 converter는 아직 API composition/route/facade에서 소비되지
않습니다. 후속 PR에서:

1. latitude/longitude → grid → scheduled facade를 잇는 application adapter.
2. `/weather` route 입력 계약과 query validation.
3. API availability fallback/retry.
4. `WeatherOverview`/`SourceMetadata` 조립.
5. cache/stale-data 정책.

관련 문서: [kma-forecast-request-factory.md](./kma-forecast-request-factory.md),
[kma-scheduled-hourly-facade.md](./kma-scheduled-hourly-facade.md),
[kma-production-composition.md](./kma-production-composition.md).

## 변경 이력

```text
v1 / PR #12 / 2026-07
- KMA 위·경도 → forecast grid 순수 변환 추가
- 지원 영역 밖 null 정책 정의
- invalid geospatial input RangeError 정책 정의
- 공식 grid와 대표 지역 fixture 테스트 추가
```
