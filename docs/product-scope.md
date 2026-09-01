# 제품 범위

이 문서는 Life Weather의 확정된 제품 방향을 요약합니다. PR #1 시점에는 아래 방향에 맞춰 개발할 수 있는
모노레포 기반만 존재하며, 아래 항목 자체는 아직 구현되지 않았습니다.

## 제품 방향

- **대상**: 대한민국 사용자를 위한 생활밀착형 날씨 앱
- **플랫폼**: Android / Google Play 우선 (iOS는 후순위)
- **비즈니스 모델**: 무료 앱 + AdMob 광고
- **로그인**: 초기 버전에는 로그인 없음
- **지역**: 다중 지역 조회 지원
- **데이터 소스**: 기상청(KMA), 에어코리아(AirKorea) 공공데이터
- **핵심 가치**: 원시 기상 데이터가 아닌 생활 날씨 분석(우산, 마스크, 옷차림, 빨래, 세차, 운동, 출퇴근 등)
- **위젯**: Android 홈 화면 위젯 지원

## 확정 기능 (후속 PR에서 구현 예정, 현재 미구현)

지역 관리:

- 여러 지역 추가·삭제·정렬
- 상단 지역 선택과 좌우 스와이프로 지역 전환

날씨 정보:

- 현재 날씨
- 시간별 예보
- 주간예보
- 대기질
- 기상특보
- 날씨와 시간대에 따라 변하는 배경

생활 날씨:

- 출퇴근 날씨
- 오늘 저녁 운동 가능 여부
- 주말 나들이 가능 여부

## Fast-track 릴리스 범위 (Owner 확정)

위 "확정 기능"은 제품 방향 전체이며, 실제 릴리스는 다음 두 단계로 나눕니다.

### 1.0

- 대한민국 수동 지역 검색
- 여러 저장 지역
- KMA 현재/시간별/단기
- AirKorea PM10/PM2.5 최소 지원
- 오늘/시간별/생활날씨/설정 최소 화면
- 기존 생활정책 4개(우산, 옷차림, 마스크, 빨래)
- loading/error/empty/stale 상태 처리
- 오늘 화면 하단 adaptive banner 1개
- 개인정보·동의·Data safety
- Development Build와 실제 Android QA
- 필수 보안·contract·schema 검증 유지

### 1.1 이후

- Android widget 전체
- GPS/current-location 권한 흐름
- 추가 생활정책
- push 알림
- 추가 광고 형식
- 중기·자외선 상세
- **월간예보**(1.1 최우선 확장 기능 — 아래 참고)
- 정교한 일러스트/animation
- 지역 재정렬·스와이프 등 확장 UX

### 1.1 최우선 확장: 월간예보 (Owner 확정)

- 약 4~5주를 캘린더 형태로 한눈에 보는 화면
- 기존 Forecast 화면의 확장으로 고려: `시간별 | 주간 | 월간`
- 신뢰 가능한 일별 예보 범위에서는 날짜, 대표 날씨, 최고기온, 최저기온을 표시
- 장기 범위에는 가짜 일별 날씨/기온을 생성하지 않음
- KMA 장기전망이 주 단위 정보만 제공하는 범위에서는 주 단위 전망으로 표시
- 일별 예보와 장기 전망의 데이터 정밀도 차이를 UI에서 숨기지 않음
- 생활밀착형 요약과 향후 연결 가능

**Technical sequencing note**: PR #98~#102의 existing KMA mid-term foundation을 이후 재사용합니다.
1.1에서 구현할 때도 mid-term `DailyForecast` completion, `regId` resolution, production
integration, monthly outlook, monthly presentation을 여러 micro-PR로 기계적으로 분할하지
않는 방향을 기록합니다 — 독립 contract/policy 위험이 없다면 vertical slice 단위로 합칠 수
있습니다. 정확한 future PR 번호는 지정하지 않습니다.

### 원칙

- 위젯은 제품 방향에서 삭제된 것이 아니라 1.1로 이동한 것입니다.
- 1.0 광고는 오늘 화면 하단 adaptive banner만입니다.
- 필수 보안·개인정보·실기기 검증은 축소하지 않습니다.
- "여러 저장 지역"은 현재 조회 중인 지역(`selectedLocationId`)의 저장·복원·삭제 시 fallback을
  포함합니다 — 이 선택 상태 자체는 1.0 범위이며, 지역 재정렬·좌우 스와이프·상단 dropdown의 최종
  디자인만 1.1 이후 확장 UX입니다. 자세한 내용은
  [mobile-selected-location.md](./mobile-selected-location.md) 참고.

## PR 구성 원칙

PR을 단순히 계층별로(`factory → service → facade → composition → wiring`) 기계적으로 분리하지
않습니다. 별도 PR이 필요한 경우는 주로 새 외부 provider boundary, 새 public contract, 독립적인
domain/policy decision, 별도 검증이 필요한 HIGH-risk boundary입니다. 그 외 glue/assembler/
composition은 가능하면 하나의 사용자 가치 또는 production vertical slice에서 함께 구현합니다.
단, one PR = one purpose, protected boundary, HIGH independent review, Owner Ready/merge gate는
그대로 유지합니다.

## 후속 확장 (MVP 이후)

- 위성/레이더 이미지
- 태풍 정보
- 해외 지역을 위한 해외 기상 API 연동

## MVP 제외 범위

다음은 MVP 범위에 포함되지 않습니다.

- 로그인/계정 시스템
- 유료 구독 모델
- iOS 우선 대응
- 위성·레이더·태풍 정보
- 해외 기상 API 연동
- 소셜 공유, 커뮤니티 기능

## PR #1과의 관계

이 문서는 제품 방향에 대한 합의를 기록하는 것이며, PR #1은 이 방향으로 개발을 시작할 수 있는
모노레포 초기화만 다룹니다. 기상청/에어코리아 연동, 생활 날씨 계산, Android 위젯, AdMob 등은
후속 PR에서 구현합니다.
