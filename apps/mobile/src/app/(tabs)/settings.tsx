import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { isValidHttpsUrl } from '../../ads/android-release-config';
import { mobileAdsRuntimeStore } from '../../ads/mobile-ads-runtime-production';
import { useMobileAdsRuntime } from '../../ads/use-mobile-ads-runtime';

const APP_NAME_FALLBACK = 'Life Weather';
const APP_VERSION_FALLBACK = '확인 불가';

function resolveAppName(): string {
  return Constants.expoConfig?.name ?? APP_NAME_FALLBACK;
}

function resolveAppVersion(): string {
  const version = Constants.expoConfig?.version;
  return version ? version : APP_VERSION_FALLBACK;
}

function openPrivacyPolicy(url: string): void {
  // Never let a raw URL-opening exception (e.g. no handler for the scheme) surface to the user.
  void Linking.openURL(url).catch(() => {});
}

export default function SettingsScreen() {
  const router = useRouter();
  const adsRuntime = useMobileAdsRuntime();
  const configuredPrivacyPolicyUrl = process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL;
  const privacyPolicyUrl = isValidHttpsUrl(configuredPrivacyPolicyUrl)
    ? configuredPrivacyPolicyUrl
    : null;

  function handleAddLocation(): void {
    router.push('/locations');
  }

  function handlePrivacyPolicyPress(): void {
    if (privacyPolicyUrl !== null) {
      openPrivacyPolicy(privacyPolicyUrl);
    }
  }

  function handlePrivacyOptionsPress(): void {
    void mobileAdsRuntimeStore.openPrivacyOptions();
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text accessibilityRole="header" style={styles.title}>
        설정
      </Text>

      <View style={styles.section}>
        <Text accessibilityRole="header" style={styles.sectionTitle}>
          지역
        </Text>
        <Text style={styles.text}>새 지역은 지역 검색 화면에서 추가할 수 있습니다.</Text>
        <Text style={styles.text}>
          저장한 지역의 선택과 삭제는 오늘, 시간별, 생활날씨, 상세기상 화면 상단의 지역 버튼에서 할 수
          있습니다.
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="지역 추가"
          onPress={handleAddLocation}
          style={styles.button}
        >
          <Text style={styles.buttonLabel}>지역 추가</Text>
        </Pressable>
      </View>

      <View style={styles.section}>
        <Text accessibilityRole="header" style={styles.sectionTitle}>
          단위
        </Text>
        <Text style={styles.text}>현재 다음 단위를 사용합니다.</Text>
        <Text style={styles.text}>기온: 섭씨(°C)</Text>
        <Text style={styles.text}>강수량: 밀리미터(mm)</Text>
        <Text style={styles.text}>적설: 센티미터(cm)</Text>
        <Text style={styles.text}>풍속: 미터/초(m/s)</Text>
      </View>

      <View style={styles.section}>
        <Text accessibilityRole="header" style={styles.sectionTitle}>
          데이터 출처
        </Text>
        <Text style={styles.text}>날씨 정보: 기상청</Text>
        <Text style={styles.text}>지역 검색 자료: 기상청_단기예보 조회서비스</Text>
        <Text style={styles.text}>지역 검색 자료 이용조건: 공공저작물 출처표시 제1유형</Text>
        <Text style={styles.text}>대기질: 에어코리아</Text>
      </View>

      <View style={styles.section}>
        <Text accessibilityRole="header" style={styles.sectionTitle}>
          개인정보 및 광고
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="개인정보 처리방침"
          disabled={privacyPolicyUrl === null}
          onPress={handlePrivacyPolicyPress}
          style={styles.button}
        >
          <Text style={styles.buttonLabel}>개인정보 처리방침</Text>
        </Pressable>
        {privacyPolicyUrl === null ? (
          <Text style={styles.text}>개인정보 처리방침 주소가 아직 설정되지 않았습니다.</Text>
        ) : null}
        {adsRuntime.privacyOptionsRequired ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="광고 개인정보 선택 관리"
            onPress={handlePrivacyOptionsPress}
            style={styles.button}
          >
            <Text style={styles.buttonLabel}>광고 개인정보 선택 관리</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.section}>
        <Text accessibilityRole="header" style={styles.sectionTitle}>
          앱 정보
        </Text>
        <Text style={styles.text}>{`앱 이름: ${resolveAppName()}`}</Text>
        <Text style={styles.text}>{`버전: ${resolveAppVersion()}`}</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    gap: 24,
    padding: 16,
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
  },
  section: {
    gap: 8,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  text: {
    fontSize: 16,
    flexShrink: 1,
    flexWrap: 'wrap',
  },
  button: {
    minHeight: 48,
    minWidth: 48,
    alignSelf: 'flex-start',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  buttonLabel: {
    fontSize: 16,
  },
});
