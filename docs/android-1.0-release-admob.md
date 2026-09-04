# Android 1.0 release / AdMob / consent / privacy integration

PR #105이 구현한 Fast-track 1.0의 마지막 구현 vertical slice를 기록합니다. 실제 operator-managed
값(Android package, AdMob ID, production URL)은 이 문서와 저장소 어디에도 commit되어 있지
않습니다. EAS project linkage는 PR #106에서 Owner가 생성한 project와 연결됐으며(아래 "EAS 설정"
참고) 실제 project ID는 이 문서에 중복 기록하지 않습니다.

## 저장소 구현 범위

### 의존성

- `react-native-google-mobile-ads@16.3.4` (`apps/mobile/package.json`, `pnpm-lock.yaml`). Firebase,
  별도 analytics SDK, `expo-build-properties`, `react-native-permissions`, tracking-transparency,
  다른 consent 패키지는 추가하지 않았습니다. PR #105는 이 의존성을 `16.5.0`으로 도입했고, PR
  #107이 아래 "Android Kotlin 호환성"의 이유로 exact `16.3.4`로 내렸습니다 — caret/tilde 없는
  정확한 버전 고정입니다.

### 동적 Expo 설정 (`apps/mobile/app.config.ts`)

`app.json`은 정적 base로 그대로 유지됩니다. `app.config.ts`가 release 전용 값을 얹습니다.

- `LIFE_WEATHER_ANDROID_PACKAGE`가 유효한 Android dotted identifier일 때만
  `expo.android.package`를 설정합니다. 값이 없거나 무효하면 필드를 생략합니다 — 가짜 fallback
  package는 만들지 않습니다.
- `react-native-google-mobile-ads` Expo config plugin을 Android `androidAppId`만으로
  구성합니다(iOS App ID·SKAdNetwork·ATT 문구·legacy measurement-delay 설정 없음).
- `EAS_BUILD === 'true' && EAS_BUILD_PROFILE === 'production'`일 때만 fail-fast 검증을
  수행합니다: 5개 필수 값(Android package, AdMob Android App ID, banner ad-unit ID, privacy 정책
  URL, `EXPO_PUBLIC_API_BASE_URL`) 중 하나라도 없거나 형식이 무효하면 네이티브 생성 전에
  `ProductionReleaseConfigError`를 던지며, 에러 메시지는 변수 **이름만** 담고 실제 값은 절대
  포함하지 않습니다. 이 검증은 외부 URL의 실제 도달 가능성을 확인하지 않습니다 — 이는 Owner
  release QA의 몫입니다.
- 이 파일은 의도적으로 `apps/mobile/src/ads/android-release-config.ts`(런타임/테스트가 쓰는
  canonical 검증 로직)를 import하지 않습니다 — Expo의 `app.config.ts` loader는 이 진입 파일 하나만
  transpile하므로, 같은 프로세스 안에 프로젝트 전역 TS loader가 없어 상대 TypeScript import가
  config 평가 시점에 해석되지 않습니다(실제로 `expo export`/`expo config` 실행 시
  `Cannot find module` 오류로 재현 확인). 따라서 두 파일은 동일한 최소 검증 규칙을 의도적으로
  각자 보유하며, 두 파일 모두 자체 테스트(`apps/mobile/app.config.test.ts`,
  `apps/mobile/src/ads/android-release-config.test.ts`)로 커버합니다.
- 비production(로컬/CI 통상 평가, 또는 production이 아닌 EAS profile) 평가에서 실제 AdMob Android
  App ID가 없거나 무효하면 Google이 공식 문서화한 **sample/test** Android App ID
  (`ca-app-pub-3940256099942544~3347511713`)만 사용합니다 — 이 저장소가 스스로 지어낸 `ca-app-pub`
  값은 어디에도 없습니다.

### Android Kotlin 호환성 (PR #107)

PR #106 이후 Owner가 실행한 **첫 Android Development Build는 native Gradle 단계에서
실패했습니다**. EAS project/package env 공급과 Android keystore 생성은 성공했고, 실패 지점은
`react-native-google-mobile-ads:compileDebugKotlin`이었습니다.

- 실패 조합: `react-native-google-mobile-ads@16.5.0` → Android Google Mobile Ads SDK
  `25.4.0`(`play-services-ads-25.4.0-api.jar`). 이 artifact의 Kotlin metadata binary version은
  `2.3.0`인데 현재 build가 기대하는 버전은 `2.1.0`이라 metadata 비호환 컴파일 실패가 납니다.
- 이 SDK 버전은 패키지 자신의 `sdkVersions.android.googleMobileAds` 값으로 결정됩니다
  (`android/build.gradle`이 그 값으로 `com.google.android.gms:play-services-ads`를 가져옵니다).
  `16.4.0`이 이 값을 `25.4.0`으로 올렸고, 그 직전 릴리스인 `16.3.4`는 아직 `25.0.0`입니다.
- 따라서 PR #107은 `react-native-google-mobile-ads`를 exact `16.3.4`로 고정하고 `pnpm-lock.yaml`을
  그 변경만큼만 갱신하는 **dependency rollback**으로 해결했습니다. Kotlin 버전, Gradle/AGP,
  Gradle wrapper, `expo-build-properties`, dependency resolution/force 블록, Kotlin metadata
  skip 플래그, patch-package 같은 **native override는 추가하지 않았습니다**.
- 필요한 광고 형식은 그대로 사용할 수 있습니다 — Today 배너가 쓰는
  `BannerAdSize.LARGE_ANCHORED_ADAPTIVE_BANNER`는 `16.2.0`부터 제공되므로 `16.3.4`에 존재하며,
  `AdsConsent`/`AdsConsentPrivacyOptionsRequirementStatus`/`mobileAds()`/`TestIds` 등 이 앱이
  사용하는 나머지 API 표면과 Expo config plugin도 동일합니다.
- AdMob runtime, UMP consent 흐름, privacy-options 노출 조건, 광고 gating과 targeting 금지 정책
  같은 **동작상의 계약은 전혀 바뀌지 않았습니다**. `app.config.ts`, `eas.json`, `app.json`,
  `.env.example`도 이 변경으로 수정되지 않았습니다.
- Kotlin metadata 비호환은 JS 레이어에서 재현·검증할 수 없으므로, **실제 native rebuild와 EAS
  Development Build 재시도는 merge 이후 Owner gate**로 남습니다.

### EAS 설정 (`apps/mobile/eas.json`)

PR #105은 기존 `development` 프로필을 그대로 두고 `production` 프로필만 추가했습니다
(`distribution: store`, `environment: production`, `android.buildType: app-bundle`). auto-submit,
credentials, Play service-account 설정, 실제 EAS Build 실행은 PR #105에서 하지 않았습니다.

PR #106에서는 Owner가 외부에서 생성·연결한 EAS project의 linkage 결과(`app.json`의 Expo `owner`와
`extra.eas.projectId`)를 저장소에 반영하고, `development` 프로필에 `environment: "development"`만
추가했습니다 — `developmentClient: true`, `distribution: internal`, `android.buildType: apk`
의미는 그대로입니다. Owner가 EAS Development environment에 `LIFE_WEATHER_ANDROID_PACKAGE`를
등록했으므로, Android package identifier는 저장소에 hard-code되지 않은 채 아래 build-time env
계약을 통해 Development Build의 app config 평가에 공급됩니다. 실제 Development APK/native build,
`eas build`, credentials, prebuild는 PR #106에서도 실행하지 않았습니다. production release 값,
AdMob/UMP 콘솔 설정, production environment와 Play release는 여전히 별도 Owner gate입니다.

### 환경 변수 계약 (`apps/mobile/.env.example`)

기존 `EXPO_PUBLIC_API_BASE_URL`을 보존하고 아래 4개를 빈 값 + 설명 주석으로 추가했습니다. 실제
값은 어디에도 없습니다.

- `LIFE_WEATHER_ANDROID_PACKAGE`
- `LIFE_WEATHER_ADMOB_ANDROID_APP_ID`
- `EXPO_PUBLIC_ADMOB_TODAY_BANNER_UNIT_ID`
- `EXPO_PUBLIC_PRIVACY_POLICY_URL`

### 모바일 ads runtime (`apps/mobile/src/ads/`)

- `mobile-ads-runtime-store.ts`: provider-neutral 상태 저장소(pure, injected UMP/Mobile Ads
  클라이언트). `canRequestAds`/`adsInitialized`/`privacyOptionsRequired` 세 boolean만 발행합니다.
  `start()`는 앱 실행마다(정확히는 이 store 인스턴스마다) 한 번만 UMP consent를 gather하고, 실패
  시 UMP의 현재/이전 세션 정보(`getConsentInfo()`)로 대체합니다(자동으로 광고를 허용하지 않음).
  `canRequestAds`가 true일 때만, 그리고 최대 한 번만 `mobileAds().initialize()`를 호출하며,
  동시/반복 트리거는 진행 중인 시도에 합류하거나 이미 초기화된 상태를 그대로 반환합니다.
  `openPrivacyOptions()`는 `AdsConsent.showPrivacyOptionsForm()`을 호출한 뒤 consent 정보를
  새로고침하고, 새로 허용됐다면 광고를 초기화합니다. 이 store는 어떤 consent도 자체적으로
  영속화하지 않습니다 — UMP/네이티브 SDK가 그 상태를 소유합니다.
- `mobile-ads-runtime-production.ts`: 이 앱에서 유일하게 `react-native-google-mobile-ads`의
  `AdsConsent`/`mobileAds`를 직접 import하는 파일이며, 그 store를 정확히 한 번 조립합니다.
- `use-mobile-ads-runtime.ts`: 읽기 전용 React 구독 hook(`useSyncExternalStore`).
- `today-banner-ad.tsx`: Today 탭 전용 단일 adaptive banner 배치. `canRequestAds && adsInitialized`
  이전에는 아무것도 렌더링하지 않습니다(영구 빈 광고 박스 없음). `__DEV__`에서는 라이브러리의
  `TestIds.ADAPTIVE_BANNER`만, 그 외에는 검증된 `EXPO_PUBLIC_ADMOB_TODAY_BANNER_UNIT_ID`만
  사용하며, 비-dev 런타임에 유효한 unit ID가 없으면 광고를 렌더링하지 않습니다(테스트 배너로
  자동 대체하지 않음). `BannerAdSize.LARGE_ANCHORED_ADAPTIVE_BANNER`를 사용하고, 저장 위치·좌표·
  날씨 상태 등 어떤 값도 `requestOptions`로 전달하지 않습니다.
- `android-release-config.ts`: Android package / AdMob App ID / ad-unit ID / HTTPS URL 검증과
  production fail-fast, sample-ID resolution을 담당하는 canonical pure 모듈. 앱 런타임
  (`today-banner-ad.tsx`, `settings.tsx`)과 테스트가 이 파일을 가져다 씁니다.

시작 시점 소유권: `apps/mobile/src/app/_layout.tsx`의 기존 단일 mount effect가 저장 지역
hydration/selection 시작과 함께 `mobileAdsRuntimeStore.start()`를 호출합니다 — 화면별 개별
초기화나 추가 effect는 두지 않았습니다.

앱 옵트인 상한: no app-open/interstitial/rewarded ad, no preload beyond the banner component's own
request, Today 화면 하나에만 배너 1개.

### Settings 변경 (`apps/mobile/src/app/(tabs)/settings.tsx`)

- 잘못된 `대기질: 에어코리아 연동 예정` 문구를 `대기질: 에어코리아`로 수정했습니다(AirKorea는
  이미 production에 연동되어 있습니다).
- 새 `개인정보 및 광고` section을 추가했습니다: `개인정보 처리방침` 버튼은
  `EXPO_PUBLIC_PRIVACY_POLICY_URL`이 유효한 HTTPS URL일 때만 활성화되어 `Linking.openURL`을
  안전하게 호출하고(원시 예외를 사용자에게 노출하지 않음), 값이 없으면 고정 placeholder 문구와
  함께 비활성 상태로 표시됩니다(추측 URL은 하드코딩하지 않음). `광고 개인정보 선택 관리` 버튼은
  UMP `privacyOptionsRequirementStatus`가 `REQUIRED`일 때만 렌더링되며, 누르면
  `mobileAdsRuntimeStore.openPrivacyOptions()`를 호출합니다 — TCF 문자열을 직접 해석하거나 커스텀
  GDPR 폼을 만들지 않습니다.

### 테스트

모든 신규/변경 테스트는 네이티브 UMP/Mobile Ads 모듈을 mock하며, 실제 광고 요청이나 네트워크
호출은 없습니다.

- `android-release-config.test.ts`: fail-fast 10개 시나리오 + positive/negative control.
- `mobile-ads-runtime-store.test.ts`: startup/초기화-once/consent 실패 fallback/privacy-options
  갱신/오류 비노출/구독 계약.
- `app.config.test.ts`: 실제 `app.config.ts` default export를 통한 production fail-fast와
  non-production fallback의 end-to-end 검증(추가로 `npx expo config`/`expo export` 실제 CLI
  실행으로도 수동 재현·확인함 — 값 노출 없이 변수명만 담은 에러, 유효한 synthetic 값에서의 정상
  resolve).
- `today-banner-ad.test.tsx`: gating, dev/production unit ID 분리, adaptive size, no
  requestOptions.
- `index.test.tsx`(Today): 배너 정확히 1개 마운트, 상태 무관.
- `hourly.test.tsx`/`lifestyle.test.tsx`/`details.test.tsx`: 배너 미도입 소스 검사.
- `settings.test.tsx`: AirKorea 문구 수정, privacy policy 버튼 활성/비활성/오류 비노출,
  privacy-options 버튼 표시 조건과 press 위임.
- `_layout.test.tsx`: 기존 단일 mount effect가 `mobileAdsRuntimeStore.start()`도 호출함을 확인.

## Owner release checklist (merge 이후)

아래 항목은 이 PR의 코드 구현 범위가 아니며, Owner가 외부에서 제공/설정해야 합니다.

1. 최종 Android application/package identifier
2. AdMob Android App ID
3. AdMob Today banner ad-unit ID
4. AdMob Privacy & Messaging(UMP) 설정
5. production `EXPO_PUBLIC_API_BASE_URL`
6. 공개 HTTPS privacy-policy URL(Play Console에도 동일하게 등록)
7. EAS project/link/environment 실제 연결 — project 생성·link와 Development environment의
   `LIFE_WEATHER_ANDROID_PACKAGE` 등록은 완료(PR #106). production environment 값은 미완료
8. Play Console 앱 생성/등록 정보
9. Play "광고 포함" 선언
10. Advertising ID(AD_ID) 선언 — 이 SDK는 자체 라이브러리 manifest로 `AD_ID` permission을
    선언합니다. 이 저장소는 그 permission을 수동으로 추가하거나 제거하지 않았습니다 — 실제
    생성된 manifest 검증은 Owner native-build QA의 몫입니다.
11. Data safety 검토 — 현재 Google Mobile Ads SDK의 Data safety 가이드는 다음과 같은 카테고리를
    포함할 수 있습니다: IP 주소/근사 위치 추론, 사용자 제품 상호작용, 진단 정보,
    광고 ID를 포함한 기기/계정 식별자. **이는 release-review 참고 입력일 뿐, 자동으로 완료된 Play
    Data safety 답변이 아닙니다.**
12. target-audience(대상 연령층) 선언 — 이 저장소는 `tagForChildDirectedTreatment`/
    `tagForUnderAgeOfConsent`/age gate를 설정하지 않았습니다(해당 product policy가 아직 확정되지
    않았기 때문). **Play 대상 연령층에 아동이 포함된다면, release 전에 반드시 별도의
    Families/광고 정책 검토를 먼저 수행해야 합니다.**
13. privacy-policy Play Console URL 등록
14. Development/production 네이티브 build QA — Development APK build/설치는 아직 미실행
15. 실제 광고/동의(consent) QA
16. 승인된 실제 KMA/AirKorea live 검증

이 PR에서 실제 KMA/AirKorea endpoint 호출, native prebuild, EAS Build, Play/AdMob 콘솔 변경,
production 배포는 수행하지 않았습니다.
