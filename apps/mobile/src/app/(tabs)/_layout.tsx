import { Tabs } from 'expo-router';

import { useMobileSavedLocations } from '../../locations/use-mobile-saved-locations';
import { useMobileWeatherQueryLifecycle } from '../../weather-query/use-mobile-weather-query-lifecycle';

/**
 * Sole production owner of the weather-query request/reset lifecycle
 * ({@link useMobileWeatherQueryLifecycle}, see `../../weather-query/use-mobile-weather-query.ts` for
 * why that ownership lives here and not in individual tab screens). Every tab screen may still read
 * the query independently via the read-only `useMobileWeatherQuery` hook.
 */
export default function TabsLayout() {
  const savedLocations = useMobileSavedLocations();
  useMobileWeatherQueryLifecycle(savedLocations);

  return (
    <Tabs>
      <Tabs.Screen name="index" options={{ title: '오늘', headerShown: false }} />
      <Tabs.Screen name="hourly" options={{ title: '시간별', headerShown: false }} />
      <Tabs.Screen name="lifestyle" options={{ title: '생활날씨' }} />
      <Tabs.Screen name="details" options={{ title: '상세기상' }} />
      <Tabs.Screen name="settings" options={{ title: '설정' }} />
    </Tabs>
  );
}
