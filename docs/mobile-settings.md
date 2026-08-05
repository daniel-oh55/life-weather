# 모바일 최소 설정(Settings) 화면

이 문서는 `/settings`(설정 탭)의 최소 실제 화면을 설명합니다. 이 화면은 저장소에서 현재 사실로
확인되는 정보만 표시하는 **읽기 전용 안내 화면**이며, 사용자 설정 값을 저장하거나 변경하는 기능은
이 PR 범위가 아닙니다.

## 목적과 범위

- `/settings`의 placeholder("설정 화면을 준비하고 있습니다.")를 네 section으로 구성된 최소 실제
  화면으로 교체합니다.
- 네 section 외 다른 항목(단위 선택, 알림/위젯 toggle, 출퇴근·운동시간 설정, 위치 권한, 광고 설정,
  개인정보 동의, theme/locale 설정)은 이 화면에 없습니다.
- 이 화면은 어떤 storage, network, native config API도 호출하지 않습니다. `useRouter()` 외의
  hook이나 store를 사용하지 않습니다.

## 네 section

### 1. 지역

- 안내 문구 두 개: "새 지역은 지역 검색 화면에서 추가할 수 있습니다." / "지역 선택과 삭제는 오늘
  화면에서 할 수 있습니다."
- `지역 추가` 버튼은 `router.push('/locations')`만 호출합니다.
- `/locations`는 [KMA 대한민국 지역 검색 카탈로그](./kma-korean-location-catalog.md)의 **검색·추가
  화면**이지 전체 지역 관리 화면이 아닙니다 — 이 설정 화면은 "저장 지역 관리"/"지역 정렬"/"지역
  편집"/"전체 지역 관리"처럼 과장된 표현을 쓰지 않습니다. 지역 선택과 삭제는 여전히 Today(오늘)
  화면의 기존 컨트롤에서 이뤄집니다. 이 PR은 `/locations`와 Today 화면 자체를 수정하지 않습니다.

### 2. 단위

- 안내 문구: "현재 다음 단위를 사용합니다."
- 고정 네 항목: `기온: 섭씨(°C)` / `강수량: 밀리미터(mm)` / `적설: 센티미터(cm)` /
  `풍속: 미터/초(m/s)`.
- 이 section은 read-only 안내이며 선택 control, toggle, dropdown, radio, 저장 상태, 단위 변환
  정책, contract 변경이 전혀 없습니다.

### 3. 데이터 출처

- 고정 네 항목: `날씨 정보: 기상청` / `지역 검색 자료: 기상청_단기예보 조회서비스` /
  `지역 검색 자료 이용조건: 공공저작물 출처표시 제1유형` / `대기질: 에어코리아 연동 예정`.
- 지역 검색 자료 명칭과 이용조건은 [kma-korean-location-catalog.md](./kma-korean-location-catalog.md)의
  공식 출처 표에 근거합니다.
- AirKorea는 현재 미구현이므로 **"연동 예정"으로만** 표시하며, "에어코리아 제공"이나
  "대기질 정보: 에어코리아"처럼 현재 제공 중인 것으로 오인시킬 수 있는 단독 표현은 쓰지 않습니다.
- 외부 URL, dataset identifier, artifact 파일명, 수정일, manifest hash, KMA service key, provider
  URL, requestId, source metadata는 화면에 표시하지 않습니다.

### 4. 앱 정보

- `앱 이름: {name}` / `버전: {version}`을 기존 dependency `expo-constants`의
  `Constants.expoConfig?.name` / `Constants.expoConfig?.version`에서 읽습니다.
- `name`이 없으면 `Life Weather`로, `version`이 없거나(`undefined`/`null`) 빈 문자열이면
  `확인 불가`로 표시합니다.
- 버전 문자열을 소스에 하드코딩하지 않습니다 — 항상 런타임의 expo config 값을 읽습니다.
- 새 package dependency나 `app.json`/native config 변경은 없습니다.

## 이 화면에서 명시적으로 제외한 정보

다음 항목은 이 화면에 없습니다 — 개인정보 처리방침, 위치기반서비스 이용약관, 광고·동의 설정, 지원
이메일, 사업자명, domain, package name, EAS project ID, AdMob ID, Play Store URL, 오픈소스 라이선스
전체 목록. 이 값들은 `AGENTS.md`상 operator-managed이거나 최신 공식 정책 검토가 필요한 영역이며,
별도 출시 준비 작업에서 다룹니다. 이 화면은 placeholder URL, `example.com`, 가짜 이메일, 빈
pressable을 만들지 않습니다.

## 이 작업에서 하지 않은 것

- Storage, API, weather-query lifecycle, native config는 전혀 변경하지 않았습니다.
- 설정 persistence나 toggle은 구현하지 않았습니다 — 이 화면은 순수 읽기 전용 안내입니다.
- `/locations`와 Today 화면은 변경하지 않았습니다.
- 실제 `POST /weather` 호출, dev-server QA, Expo Development Build, prebuild/native build, 실기기
  QA는 수행하지 않았습니다.
