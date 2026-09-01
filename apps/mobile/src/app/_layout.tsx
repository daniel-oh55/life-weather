import { useEffect } from 'react';
import { Stack } from 'expo-router';

import { mobileAdsRuntimeStore } from '../ads/mobile-ads-runtime-production';
import { startMobileLocationApplicationOnce } from '../locations/mobile-location-application-startup';

export default function RootLayout() {
  useEffect(() => {
    void startMobileLocationApplicationOnce();
    void mobileAdsRuntimeStore.start();
  }, []);

  return (
    <Stack>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
    </Stack>
  );
}
