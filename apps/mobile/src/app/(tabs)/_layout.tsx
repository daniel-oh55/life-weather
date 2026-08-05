import { Tabs } from 'expo-router';

export default function TabsLayout() {
  return (
    <Tabs>
      <Tabs.Screen name="index" options={{ title: '오늘' }} />
      <Tabs.Screen name="hourly" options={{ title: '시간별' }} />
      <Tabs.Screen name="lifestyle" options={{ title: '생활날씨' }} />
      <Tabs.Screen name="details" options={{ title: '상세기상' }} />
      <Tabs.Screen name="settings" options={{ title: '설정' }} />
    </Tabs>
  );
}
