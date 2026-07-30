import { useEffect } from 'react';
import { Stack } from 'expo-router';

import { startMobileSavedLocationHydrationOnce } from '../locations/mobile-saved-location-hydration-startup';

export default function RootLayout() {
  useEffect(() => {
    void startMobileSavedLocationHydrationOnce();
  }, []);

  return <Stack />;
}
