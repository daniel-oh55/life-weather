# KMA 대한민국 지역 검색 카탈로그

이 문서는 `apps/mobile/src/locations`의 **KMA 대한민국 지역 검색 카탈로그**와 그 위의 검색·저장
경계를 설명합니다. 사용자가 지역명을 검색해 결과를 선택하면 검증된
`MobileSavedLocationCandidate`로 변환되어 기존 [application store](./mobile-saved-location-application.md)의
`add()`를 통해 저장됩니다.

## 공식 출처

| 항목 | 값 |
| --- | --- |
| 제공기관 | 기상청 |
| 공공데이터포털 데이터셋 | 기상청_단기예보 조회서비스 |
| dataset identifier | `15084084` |
| reference artifact | `기상청41_단기예보 조회서비스_오픈API활용가이드_2607.zip` |
| 포함된 좌표·격자 파일 | `기상청41_단기예보 조회서비스_오픈API활용가이드_격자_위경도(2607).xlsx` |
| portal 표기 수정일 | 2026-07-09 |
| license | 공공저작물 출처표시 제1유형 (KOGL_TYPE_1_ATTRIBUTION) |

이 artifact는 공공데이터포털의 `기상청_단기예보 조회서비스` 데이터셋 상세 페이지에서 인증키 없이
내려받을 수 있는 공식 참고문서이며, 실제 KMA 예보 API(서비스 키 필요)는 호출하지 않았습니다. ZIP은
`docx` 활용가이드 문서와 `xlsx` 행정구역·격자·위경도 표를 포함하며, 이 카탈로그는 `xlsx` 표만
사용합니다. 원본 ZIP/XLSX 바이너리는 이 저장소에 commit하지 않습니다 — 정규화된
`kma-korean-location-source.tsv`만 commit합니다.

## Provenance manifest

`apps/mobile/src/locations/catalog/kma-korean-location-source-manifest.ts`가 위 표의 값과 다음
카운트를 코드로 기록합니다.

- `sourceRowCount` — 정규화된 source TSV의 데이터 행 수 (`3838`).
- `sourceSha256` — 커밋된 `kma-korean-location-source.tsv` 파일 내용의 SHA-256 (원본 XLSX가 아닌,
  이 저장소에 실제로 있는 파일의 해시라서 누구나 재계산해 검증할 수 있습니다).
- `generatedRowCount` — 최종 카탈로그의 entry 수 (`3836`, 아래 제외 규칙 참고).

다운로드 URL, service key, 로컬 파일 경로는 어디에도 기록하지 않습니다.

## XLSX → TSV → generated catalog 파이프라인

```text
apps/mobile/src/locations/catalog/
  kma-korean-location-source.tsv            # 1) 기계적 추출 (전체 3838행)
  kma-korean-location-source-manifest.ts     # provenance
  kma-korean-location-catalog.generated.ts   # 2) 생성된 raw row (id 포함, 3836행)
  kma-korean-location-catalog.ts             # 3) runtime 검증 + public entry 매핑
apps/mobile/src/locations/
  kma-korean-location-search.ts              # 4) 검색
  kma-korean-location-candidate.ts           # 5) candidate 매핑
apps/mobile/src/app/
  locations.tsx                              # 6) 검색 화면
```

1. **Source TSV** — XLSX의 `구분`(`kor` 고정)·`행정구역코드`·`1/2/3단계`·`격자 X/Y`·
   `경도(초/100)`(십진 경도)·`위도(초/100)`(십진 위도) 열을 원본 스프레드시트 순서 그대로
   기계적으로 추출합니다. 좌표는 소수점 6자리로 반올림합니다(원본 60진→십진 변환의 부동소수점
   잡음을 제거할 뿐, 값 자체는 바꾸지 않습니다). 빈 2/3단계는 TSV에서 빈 문자열로 남기고(순수
   추출 단계이므로), `null` 정규화는 다음 단계에서 합니다. 수작업 좌표 수정은 없습니다.
2. **Generated catalog rows** — TSV 전체 3838행 중, 원본 스프레드시트가 좌표를
   `(0, 0)`(대한민국 범위를 벗어나는 placeholder 값)으로 남긴 **이어도** 2개 행(행정구역코드
   `5019000000`/`5019099000`)을 제외합니다. 이 두 행은 유효한 위경도가 없어 화면에 표시할 좌표가
   없으므로 제외했으며, 임의로 좌표를 만들어 채우지 않았습니다. 나머지 3836행 각각에 대해
   결정론적 opaque `id`를 계산해(§ID 정책) `[officialAdministrativeCode, id, adminArea1, adminArea2,
   adminArea3, latitude, longitude, nx, ny, officialOrder]` 튜플로 기록합니다. `officialOrder`는
   제외 후 남은 행에 대해 `1..3836`으로 다시 매깁니다.
3. **Runtime 검증** — `kma-korean-location-catalog.ts`가 모듈 로드 시 정확히 한 번, 생성된 raw row
   전체를 (a) `generatedRowCount`와 행 수 일치, (b) 소스 코드 중복 없음, (c) `officialOrder`가
   `1..N` 조밀·오름차순, (d) 각 row가 opaque id 형식(`kr_[0-9a-f]{24}`)이고 원본 코드를 포함하지
   않음을 검증한 뒤, `officialAdministrativeCode`를 제외한 public 필드만 명시적으로 매핑하고 최종
   배열 전체를 strict Zod schema로 재검증합니다. 하나라도 실패하면 **즉시 throw**합니다(일부만
   조용히 버리지 않음) — 이 fail-closed는 생성 단계의 무결성 문제에만 적용되고, 아래 검색 함수는
   사용자 입력으로는 절대 throw하지 않습니다. 성공하면 배열과 각 entry(및 `kmaGrid`)를
   deep-freeze해 export합니다.

### 소스 ↔ generated 전수 대조 (CI)

생성 절차는 일회성이고 생성 스크립트는 저장소에 없으므로, **committed source TSV와 committed
generated row가 여전히 서로 대응하는지는 CI가 증명합니다.**
`kma-korean-location-catalog.test.ts`의 verifier가 매 test 실행마다:

1. committed TSV를 파싱하면서 header가 예상 9개 열과 정확히 일치하는지, 각 데이터 행의 열 수가
   정확한지, 숫자 열이 유효한 number/integer인지 검증합니다(행 끝 `\r`만 안전하게 제거하므로 CRLF
   checkout이 값을 오염시킬 수 없습니다). 행 수는 manifest의 `sourceRowCount`(`3838`)와 일치해야
   합니다.
2. 좌표가 `(0, 0)`인 행을 TSV 전체에서 찾아 **정확히 두 행**(`5019000000`/`5019099000`, 둘 다
   이어도)만 존재함을 확인하고 그 두 행만 제외합니다 — 하드코딩된 코드 목록으로 유효한 행을
   조용히 걸러내지 않습니다.
3. 남은 3836행 각각에 대해 expected generated row를 재구성합니다: opaque id를 SHA-256으로 **모든
   행에 대해 다시 계산**하고(표본이 아님), 빈 2/3단계를 `null`로 정규화하고, `officialOrder`를
   제외 후 `1..3836`으로 다시 매깁니다.
4. `expect(KMA_KOREAN_LOCATION_CATALOG_RAW_ROWS).toEqual(expectedRows)` 한 번으로 3836행 전체를
   deep equality 비교합니다 — 행정구역 코드, opaque id, 1/2/3단계 행정구역명, `null` 변환, 위도,
   경도, `nx`, `ny`, `officialOrder`까지 **모든 필드가 전수 대응**해야 통과합니다.

따라서 generated file의 좌표·격자·지역명·id·순서 중 어느 하나라도 소스와 어긋나면 CI가 실패합니다
(negative control로 확인함).

### Generated catalog entry

```ts
interface KmaKoreanLocationCatalogEntry {
  readonly id: string;
  readonly displayName: string;
  readonly fullName: string;
  readonly countryCode: 'KR';
  readonly adminArea1: string;
  readonly adminArea2: string | null;
  readonly adminArea3: string | null;
  readonly latitude: number;
  readonly longitude: number;
  readonly timezone: 'Asia/Seoul';
  readonly kmaGrid: { readonly nx: number; readonly ny: number };
  readonly officialOrder: number;
}
```

`officialAdministrativeCode`는 이 public 타입에 없습니다 — id 생성과 소스 중복 검사에만
쓰이고, 화면이나 `MobileSavedLocationCandidate`에는 노출되지 않습니다.

## ID 정책

기존 `weatherLocation.id`(app-issued opaque id) 계약을 보존하기 위해, 원본 행정구역 코드·KMA
`nx`/`ny`·표시명·좌표·runtime random 값 중 어느 것도 그대로 id로 쓰지 않습니다. 대신 **생성
단계에서만** Node 내장 `crypto`로 결정론적 opaque id를 만듭니다.

```text
input:  life-weather:kma-location-v1:<officialAdministrativeCode>
digest: SHA-256(input) — hex
id:     "kr_" + digest의 앞 24자
```

같은 소스 행은 항상 같은 id를 만들고(재현 가능), 3836개 id는 모두 유일하며(충돌 시 생성
실패), id 문자열에 원본 코드가 부분 문자열로 나타나지 않습니다. 이 hash 계산은 **일회성 생성
절차에서만** 한 번 일어나며(생성 스크립트 자체는 이 저장소에 commit되어 있지 않습니다), React
Native 런타임에서는 계산하지 않습니다 — 런타임은 이미 계산된 id를
`kma-korean-location-catalog.generated.ts`에서 읽기만 합니다. 대신 아래 전수 verifier가 CI에서
모든 id를 소스 코드로부터 다시 계산해 대조합니다.

## 행정구역·표시명 정책

```text
countryCode: 'KR' 고정
timezone:    'Asia/Seoul' 고정
adminArea1:  공식 1단계 (필수)
adminArea2:  공식 2단계, 없으면 null (빈 문자열 아님)
adminArea3:  공식 3단계, 없으면 null (빈 문자열 아님)

displayName = adminArea3 ?? adminArea2 ?? adminArea1
fullName    = [adminArea1, adminArea2, adminArea3] 중 null이 아닌 값을 공백으로 연결
```

검색 화면은 `fullName`을 표시해 서로 다른 지역의 동일한 `displayName`(예: 서울특별시 관악구
중앙동 / 부산광역시 중구 중앙동 / 제주특별자치도 서귀포시 중앙동)을 구분합니다. 저장된 지역
목록(홈 화면)의 기존 `displayName` 동작은 이 PR에서 바뀌지 않았습니다. 위경도와 `nx`/`ny`는 공식
source 값을 그대로 쓰고, 런타임에서 투영 공식을 다시 구현하지 않습니다.

## Runtime 경계 (`kma-korean-location-catalog.ts`)

- strict Zod schema — `latitude`는 `[32, 39.5]`, `longitude`는 `[124, 132]`로 대한민국 범위를
  합리적으로 제한합니다(실제 생성 데이터 범위는 위도 `33.22~38.49`, 경도 `124.71~131.86`이며,
  여유를 둔 값입니다). `nx`/`ny`는 finite non-negative integer.
- 전체 배열 안전 검증, 중복 id 검사, 소스 코드 중복 검사, `officialOrder` 조밀·오름차순 검사.
- import 시 storage/network/environment I/O 없음. 배열과 각 entry, `kmaGrid`는 deep-freeze됩니다.

## 검색 (`kma-korean-location-search.ts`)

```ts
searchKmaKoreanLocations(
  queryInput: unknown,
  options?: { readonly limit?: number },
): KmaKoreanLocationSearchResult;

type KmaKoreanLocationSearchResult =
  | { readonly ok: true; readonly locations: readonly KmaKoreanLocationCatalogEntry[] }
  | { readonly ok: false; readonly error: { readonly kind: 'INVALID_QUERY' | 'INVALID_LIMIT' } };
```

- **정규화**: 문자열이 아니면 `INVALID_QUERY`. `NFKC` 정규화 → trim → 연속 공백을 하나로 축소.
  이 정규화된 길이가 2자 미만(빈 문자열 포함)이면 **성공한 빈 결과**를 반환합니다 — 아직 입력
  중인 상태는 오류가 아니라는 판단입니다. 비교용 key는 여기서 공백을 모두 제거하고
  소문자화합니다.
- **매칭**: `displayName`, `fullName`, 각 admin area, 공백 제거 `fullName`을 대상으로 substring
  검색합니다.
- **계층형 축약(hierarchy alias)**: `서울강남`처럼 각 행정구역 단계를 줄여 이어 쓴 질의도 실제
  결과를 찾습니다. 공식 명칭 key 끝에서 행정구역 suffix **하나만** 기계적으로 제거해 축약 key를
  만들고(`서울특별시`→`서울`, `강남구`→`강남`, `제주특별자치도`→`제주`, `경기도`→`경기`; 제거
  결과가 빈 문자열이면 원래 key 유지), 각 단계를 **공식 명칭 또는 축약형 중 어느 쪽으로도** 쓸 수
  있다고 보고 `adminArea1`부터 왼쪽에서 오른쪽으로 질의를 소비합니다. 그래서 `부산중구`(1단계만
  축약)와 `부산중`(양쪽 축약)이 모두 `부산광역시 중구`에 도달합니다. 질의는 반드시 1단계(시·도)에서
  시작해야 하므로 `강남`만으로는 이 tier에 걸리지 않습니다. 동의어 사전·별명 목록은 만들지
  않았습니다 — suffix 규칙 하나뿐입니다.
- **ranking** (동점은 `officialOrder` 오름차순):
  1. `displayName` exact
  2. admin 구성요소 exact (예: `강남구` 검색 시 강남구 자신과 강남구의 모든 동이 함께 매칭)
  3. `displayName` prefix
  4. `fullName` prefix
  5. hierarchy alias exact (예: `서울 강남`/`서울강남` → `서울특별시 강남구`)
  6. hierarchy alias prefix (같은 질의의 강남구 하위 동들 — 항상 강남구 자신보다 뒤)
  7. substring

  축약 tier가 5·6번에 있으므로 **공식 지역명에 대한 exact/prefix 매칭을 절대 앞지르지 않습니다.**
  공백은 비교 전에 모두 제거되므로 `서울 강남`과 `서울강남`은 동일한 결과 ID 배열을 반환합니다.
- **limit**: 기본 30, `options.limit`을 주면 `1..50` 정수만 허용하고 그 외는 `INVALID_LIMIT`.
- 반환된 entry는 카탈로그 자신의 frozen reference이고, 배열만 매 호출 새로 만듭니다. 어떤 입력에도
  throw하지 않고, network/storage I/O가 없으며, query 입력을 변형하지 않습니다.

1.0에는 초성 검색, fuzzy edit distance, 로마자 표기, 검색 이력, 인기 지역 추천, 위치 기반 정렬,
외부 자동완성을 포함하지 않습니다.

## Candidate 매핑 (`kma-korean-location-candidate.ts`)

```ts
createSavedLocationCandidateFromKmaCatalogEntry(
  input: unknown,
): SavedLocationCandidateFromCatalogResult;
```

`kmaKoreanLocationCatalogEntry`로 입력을 검증한 뒤, 9개 필드 + `kmaGrid` + `isCurrent: false`를
하나씩 명시적으로 매핑합니다(spread 없음) — `fullName`·`officialOrder`·원본 코드는 결과에 없고,
`sortOrder`도 포함하지 않습니다(기존 `addSavedLocation`이 정합니다). 결과는 방어적으로 기존
`mobileSavedLocationCandidate` schema로 재검증됩니다. throw 없이 고정된 비노출
`INVALID_CATALOG_ENTRY` 오류를 반환하고, 입력을 변형하지 않으며, 호출마다 fresh candidate와
fresh `kmaGrid`를 반환합니다.

## 검색 화면과 홈 진입점

- **홈 화면** (`apps/mobile/src/app/index.tsx`) — `EMPTY`/`READY` 상태에 `지역 추가` 버튼을
  추가했습니다. `SAVING` 중에는 기존 `삭제` 버튼과 함께 비활성화됩니다. 버튼은 Expo Router로
  `/locations`로 이동할 뿐이며, 렌더링만으로는 검색·저장·storage I/O가 없습니다. 기존
  retry/delete 동작과 다섯 상태 문구는 바뀌지 않았습니다.
- **검색 화면** (`apps/mobile/src/app/locations.tsx`) — 제목 `지역 추가`, 뒤로가기 버튼,
  `TextInput`, 결과 목록(각 `fullName` + `추가` 버튼)으로 구성됩니다. 결과 목록은 React Native 기본
  `ScrollView`에 담기고 `flex: 1`로 남은 화면을 채우므로, 기본 limit인 30개 결과가 모두 스크롤로
  도달 가능합니다(예: `중앙동` 검색 시 화면 아래쪽의 `제주특별자치도 서귀포시 중앙동`).
  `keyboardShouldPersistTaps="handled"`라서 키보드가 열린 상태에서도 첫 탭이 `추가`에 그대로
  전달됩니다. 결과가 30개로 제한되어 있어 `FlatList` 가상화는 쓰지 않았습니다. 검색은 정적 local
  카탈로그만 대상으로 하며 React Native 기본 컴포넌트만 사용합니다. `추가`를 누르면 candidate로 변환 →
  `mobileSavedLocationApplicationStore.add()` 호출 → 성공 시 이전 화면으로 복귀,
  실패 시 고정 문구를 표시합니다.

  ```text
  DUPLICATE_LOCATION_ID → "이미 저장된 지역입니다."
  WRITE_IN_PROGRESS     → "저장 중입니다."
  그 외 add/candidate 실패 → "지역을 저장하지 못했습니다."
  ```

  raw 오류 kind, id, 좌표, 격자, 행정구역 코드, storage 메시지는 어디에도 표시하지 않습니다.
  `SAVING` 중에는 모든 `추가` 버튼이 비활성화됩니다. 검색어가 바뀌면 이전 저장 실패 문구를
  지우지만, 별도의 공용 오류 프레임워크는 만들지 않았습니다.

## 이 PR에서 하지 않은 것

`selectedLocationId`, 현재 조회 지역 선택 UI, 선택 지역 persistence/hydration, 선택 지역 삭제
fallback, 저장 지역 reorder, 좌우 스와이프, `isCurrent` 의미 변경, 위치 권한/GPS, 실제
current-location record 추가, 실제 weather API 호출, KMA service key 사용, AirKorea, 새 dependency
/lockfile 변경, 기존 persistence envelope version 변경, `CONTRACT_VERSION` 변경.

## 갱신 절차

1. 공공데이터포털 `기상청_단기예보 조회서비스`(dataset `15084084`) 상세 페이지에서 최신
   `참고문서` ZIP을 내려받습니다(인증키 불필요).
2. ZIP 안의 `...격자_위경도(...).xlsx`를 확인하고, `구분`/`행정구역코드`/`1~3단계`/
   `격자 X`/`격자 Y`/`경도(초/100)`/`위도(초/100)` 열만 원본 순서 그대로 UTF-8 TSV로 추출해
   `kma-korean-location-source.tsv`를 교체합니다(좌표는 소수점 6자리 반올림, 빈 값은 빈 문자열
   유지).
3. `(0, 0)` 같은 placeholder 좌표를 가진 행이 있는지 확인하고, 있다면 이 문서와 동일하게 근거를
   남기고 생성 단계에서 제외합니다.
4. 남은 행 각각에 대해 `life-weather:kma-location-v1:<행정구역코드>`의 SHA-256 앞 24자를
   `kr_` 접두사로 붙여 `id`를 계산하고, `officialOrder`를 `1..N`으로 다시 매겨
   `kma-korean-location-catalog.generated.ts`를 재생성합니다.
5. `kma-korean-location-source-manifest.ts`의 `sourceModifiedDate`·`referenceFileName`·
   `sourceRowCount`·`sourceSha256`·`generatedRowCount`를 새 값으로 갱신합니다.
6. `pnpm --filter @life-weather/mobile test`로 dataset integrity 테스트와 위 **전수 verifier**를
   다시 통과시킵니다. verifier는 새 TSV로부터 generated row 전체를 재구성해 deep equality로
   비교하므로, 재생성이 한 행이라도 어긋나면 여기서 걸립니다.

이 절차는 일회성 수작업 생성 절차이며, 생성 스크립트는 저장소에 commit되어 있지 않습니다 —
저장소가 보증하는 것은 committed TSV와 committed generated file의 대응이고, 그 대응은 CI verifier가
검사합니다. 원본 XLSX/ZIP은 commit하지 않고, 실제 KMA 예보 API는 이 절차 어디에서도 호출하지
않습니다.

## 향후 상태

출처표시(공공저작물 출처표시 제1유형)는 향후 앱 설정의 "데이터 출처" 화면에도 노출되어야
합니다. 이 PR은 그 설정 화면 자체를 만들지 않았습니다 — `docs/PROJECT_STATE.md`에 후속 상태로
기록합니다.
