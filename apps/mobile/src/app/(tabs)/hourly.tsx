import { StyleSheet, Text, View } from 'react-native';

export default function HourlyScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>시간별 날씨</Text>
      <Text style={styles.body}>시간별 상세 화면을 준비하고 있습니다.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 16,
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
  },
  body: {
    fontSize: 16,
  },
});
