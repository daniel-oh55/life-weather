import { useEffect } from 'react';
import { Stack } from 'expo-router';

import { startMobileLocationApplicationOnce } from '../locations/mobile-location-application-startup';

export default function RootLayout() {
  useEffect(() => {
    void startMobileLocationApplicationOnce();
  }, []);

  return <Stack />;
}
