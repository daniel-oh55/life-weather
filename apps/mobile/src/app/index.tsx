import { useState } from 'react';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { mobileSavedLocationApplicationStore } from '../locations/mobile-saved-location-application-production';
import type { SavedLocationApplicationSnapshot } from '../locations/mobile-saved-location-application-store';
import { useMobileSavedLocations } from '../locations/use-mobile-saved-locations';

/**
 * The single status line for each application state. `ERROR` deliberately carries no error kind,
 * scope, storage detail, or native message — only generic Korean copy.
 */
function describeSavedLocations(snapshot: SavedLocationApplicationSnapshot): string {
  switch (snapshot.status) {
    case 'NOT_STARTED':
      return '저장 지역을 준비하고 있습니다.';
    case 'LOADING':
      return '저장된 지역을 불러오는 중입니다.';
    case 'SELECTION_LOADING':
      return '선택 지역을 준비하는 중입니다.';
    case 'EMPTY':
      return '저장된 지역이 없습니다.';
    case 'READY':
      return `저장된 지역이 준비되었습니다.\n저장 지역 수: ${snapshot.locations.length}`;
    case 'ERROR':
      return '저장된 지역을 불러오지 못했습니다.';
  }
}

export default function HomeScreen() {
  const router = useRouter();
  const savedLocations = useMobileSavedLocations();
  // Whether the *last* dispatched mutation failed. Kept local to the screen rather than in the
  // store's snapshot: it is presentation state for one generic message, not shared app state.
  const [writeFailed, setWriteFailed] = useState(false);

  const isSaving = savedLocations.writeStatus === 'SAVING';

  // Explicit, user-initiated retry only — no timer, no backoff, no automatic retry. A repeated tap
  // cannot start a second load: the button exists only in ERROR, and the store's retryInitialization
  // routes to whichever boundary (saved-location hydration or selected-location initialization) is
  // actually failing, joining its single-flight in-progress read instead of restarting it.
  function handleRetry(): void {
    void mobileSavedLocationApplicationStore.retryInitialization();
  }

  async function handleSelect(locationId: string): Promise<void> {
    setWriteFailed(false);
    const result = await mobileSavedLocationApplicationStore.select(locationId);
    setWriteFailed(!result.ok);
  }

  async function handleRemove(locationId: string): Promise<void> {
    setWriteFailed(false);
    const result = await mobileSavedLocationApplicationStore.remove(locationId);
    setWriteFailed(!result.ok);
  }

  function handleAddLocation(): void {
    router.push('/locations');
  }

  return (
    <View style={styles.container}>
      <Text style={styles.text}>{describeSavedLocations(savedLocations)}</Text>

      {savedLocations.status === 'EMPTY' || savedLocations.status === 'READY' ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="지역 추가"
          disabled={isSaving}
          onPress={handleAddLocation}
          style={styles.button}
        >
          <Text style={styles.buttonLabel}>지역 추가</Text>
        </Pressable>
      ) : null}

      {savedLocations.status === 'ERROR' ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="저장 지역 다시 불러오기"
          onPress={handleRetry}
          style={styles.button}
        >
          <Text style={styles.buttonLabel}>다시 시도</Text>
        </Pressable>
      ) : null}

      {savedLocations.status === 'READY' ? (
        <View style={styles.list}>
          {savedLocations.locations.map((location) => {
            const isSelected = location.id === savedLocations.selectedLocationId;
            const selectDisabled = isSelected || isSaving;
            return (
              <View key={location.id} style={styles.row}>
                <Text style={styles.rowLabel}>{location.displayName}</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={isSelected ? `${location.displayName} 선택됨` : `${location.displayName} 선택`}
                  accessibilityState={{ selected: isSelected, disabled: selectDisabled }}
                  disabled={selectDisabled}
                  onPress={() => {
                    void handleSelect(location.id);
                  }}
                  style={styles.button}
                >
                  <Text style={styles.buttonLabel}>{isSelected ? '선택됨' : '선택'}</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${location.displayName} 삭제`}
                  disabled={isSaving}
                  onPress={() => {
                    void handleRemove(location.id);
                  }}
                  style={styles.button}
                >
                  <Text style={styles.buttonLabel}>삭제</Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      ) : null}

      {writeFailed ? (
        <Text style={styles.text}>저장 지역 변경을 저장하지 못했습니다.</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 16,
  },
  text: {
    fontSize: 16,
  },
  list: {
    alignSelf: 'stretch',
    gap: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  rowLabel: {
    flexShrink: 1,
    fontSize: 16,
  },
  button: {
    minHeight: 48,
    minWidth: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  buttonLabel: {
    fontSize: 16,
  },
});
