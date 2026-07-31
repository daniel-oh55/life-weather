import { useState } from 'react';
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import type { KmaKoreanLocationCatalogEntry } from '../locations/catalog/kma-korean-location-catalog';
import { createSavedLocationCandidateFromKmaCatalogEntry } from '../locations/kma-korean-location-candidate';
import { searchKmaKoreanLocations } from '../locations/kma-korean-location-search';
import { mobileSavedLocationApplicationStore } from '../locations/mobile-saved-location-application-production';
import { useMobileSavedLocations } from '../locations/use-mobile-saved-locations';

/** Fixed, non-revealing add-failure copy — never the raw error kind, id, coordinate, or grid. */
const ADD_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  DUPLICATE_LOCATION_ID: '이미 저장된 지역입니다.',
  WRITE_IN_PROGRESS: '저장 중입니다.',
};
const GENERIC_ADD_ERROR_MESSAGE = '지역을 저장하지 못했습니다.';

function describeAddError(kind: string): string {
  return ADD_ERROR_MESSAGES[kind] ?? GENERIC_ADD_ERROR_MESSAGE;
}

/**
 * KMA Korean location search screen ("지역 추가").
 *
 * Searches only the static local catalog (`searchKmaKoreanLocations`) — no network or storage read
 * happens while typing. Adding a result maps it to a saved-location candidate
 * (`createSavedLocationCandidateFromKmaCatalogEntry`) and persists it through the existing
 * application store's `add()`, which alone owns duplicate detection, the `SAVING` write dimension,
 * and the actual write to device storage.
 */
export default function LocationSearchScreen() {
  const router = useRouter();
  const savedLocations = useMobileSavedLocations();
  const isSaving = savedLocations.writeStatus === 'SAVING';

  const [query, setQuery] = useState('');
  const [addErrorMessage, setAddErrorMessage] = useState<string | null>(null);

  // Recomputed on every render rather than memoized: the catalog search is a synchronous, cheap
  // in-memory scan (no I/O), so there is no expensive work here to cache.
  const searchResult = searchKmaKoreanLocations(query);
  const results: readonly KmaKoreanLocationCatalogEntry[] = searchResult.ok
    ? searchResult.locations
    : [];

  function handleQueryChange(next: string): void {
    setQuery(next);
    // Clear a prior add failure once the user starts a new search — not a shared error framework,
    // just this screen's own local presentation state.
    setAddErrorMessage(null);
  }

  async function handleAdd(entry: KmaKoreanLocationCatalogEntry): Promise<void> {
    setAddErrorMessage(null);

    const candidateResult = createSavedLocationCandidateFromKmaCatalogEntry(entry);
    if (!candidateResult.ok) {
      setAddErrorMessage(GENERIC_ADD_ERROR_MESSAGE);
      return;
    }

    const addResult = await mobileSavedLocationApplicationStore.add(candidateResult.candidate);
    if (!addResult.ok) {
      setAddErrorMessage(describeAddError(addResult.error.kind));
      return;
    }

    router.back();
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>지역 추가</Text>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="뒤로 가기"
        onPress={() => router.back()}
        style={styles.button}
      >
        <Text style={styles.buttonLabel}>뒤로</Text>
      </Pressable>

      <TextInput
        accessibilityLabel="지역 검색어 입력"
        placeholder="지역명을 입력하세요"
        value={query}
        onChangeText={handleQueryChange}
        autoCorrect={false}
        style={styles.input}
      />

      {/*
        The result list is scrollable: a query can return up to the search default of 30 rows, which
        overflows the viewport. `keyboardShouldPersistTaps="handled"` keeps the first tap on an
        "추가" control working while the keyboard is still open, instead of being swallowed by the
        keyboard dismissal. A plain ScrollView is enough at this size — no virtualization needed.
      */}
      <ScrollView
        style={styles.results}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
      >
        {results.map((entry) => (
          <View key={entry.id} style={styles.row}>
            <Text style={styles.rowLabel}>{entry.fullName}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${entry.fullName} 추가`}
              disabled={isSaving}
              onPress={() => {
                void handleAdd(entry);
              }}
              style={styles.button}
            >
              <Text style={styles.buttonLabel}>추가</Text>
            </Pressable>
          </View>
        ))}
      </ScrollView>

      {addErrorMessage !== null ? <Text style={styles.text}>{addErrorMessage}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    gap: 16,
    padding: 16,
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
  },
  text: {
    fontSize: 16,
  },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: '#999999',
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 16,
  },
  results: {
    flex: 1,
  },
  list: {
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
