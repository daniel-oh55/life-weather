import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

const APP_NAME_FALLBACK = 'Life Weather';
const APP_VERSION_FALLBACK = '확인 불가';

function resolveAppName(): string {
  return Constants.expoConfig?.name ?? APP_NAME_FALLBACK;
}

function resolveAppVersion(): string {
  const version = Constants.expoConfig?.version;
  return version ? version : APP_VERSION_FALLBACK;
}

export default function SettingsScreen() {
  const router = useRouter();

  function handleAddLocation(): void {
    router.push('/locations');
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
        <Text style={styles.text}>대기질: 에어코리아 연동 예정</Text>
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
