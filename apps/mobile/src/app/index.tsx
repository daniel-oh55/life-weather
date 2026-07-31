import { StyleSheet, Text, View } from 'react-native';

import { useMobileSavedLocationHydration } from '../locations/use-mobile-saved-location-hydration';

function describeSavedLocationHydration(
  hydration: ReturnType<typeof useMobileSavedLocationHydration>,
): string {
  switch (hydration.status) {
    case 'NOT_STARTED':
      return '저장 지역을 준비하고 있습니다.';
    case 'LOADING':
      return '저장된 지역을 불러오는 중입니다.';
    case 'EMPTY':
      return '저장된 지역이 없습니다.';
    case 'READY':
      return `저장된 지역이 준비되었습니다.\n저장 지역 수: ${hydration.locations.length}`;
    case 'ERROR':
      return '저장된 지역을 불러오지 못했습니다.';
  }
}

export default function HomeScreen() {
  const hydration = useMobileSavedLocationHydration();

  return (
    <View style={styles.container}>
      <Text style={styles.text}>{describeSavedLocationHydration(hydration)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    fontSize: 16,
  },
});
