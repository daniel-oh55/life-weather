/**
 * The shared top-right saved-region control used by every weather screen (오늘 / 시간별 /
 * 생활날씨 / 상세기상).
 *
 * This module owns **presentation only**. It renders the currently selected region as a pressable
 * `중구 ▾` button, and — once pressed — a bottom-sheet style `Modal` listing the saved regions so
 * the user can switch to another one, delete one, or enter the existing `/locations` add screen.
 *
 * Everything about *what those actions mean* already belongs to
 * {@link mobileSavedLocationApplicationStore}: the single write lock behind `writeStatus`, the
 * persist-before-publish ordering, the fallback selection applied when the selected region is
 * removed, the `EMPTY` transition when the last region is removed, and the fixed, non-revealing
 * failure kinds. None of that is reproduced, second-guessed, or compensated for here — this
 * component dispatches `select()` / `remove()` and renders whatever the next snapshot says.
 *
 * It also deliberately does **not** subscribe to the store: each screen already reads its single
 * saved-location snapshot (and passes that exact reference to `useMobileWeatherQuery`), so the
 * snapshot arrives as a prop rather than through a second `useMobileSavedLocations()` call.
 *
 * Out of scope here: the weather-query lifecycle (owned by `app/(tabs)/_layout`), region search and
 * adding (owned by `/locations`), GPS/current location, reordering, and any storage access.
 */

import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type { MobileSavedLocation } from '../locations/mobile-saved-location';
import { mobileSavedLocationApplicationStore } from '../locations/mobile-saved-location-application-production';
import type { SavedLocationApplicationSnapshot } from '../locations/mobile-saved-location-application-store';

/** Which mutation the last dispatched write was, when it failed. */
type SavedLocationWriteFailure = 'SELECT' | 'REMOVE';

/** Fixed, generic copy per failed mutation. Never carries the store's error kind. */
const WRITE_FAILURE_MESSAGES: Record<SavedLocationWriteFailure, string> = {
  SELECT: '지역을 변경하지 못했습니다.',
  REMOVE: '지역을 삭제하지 못했습니다.',
};

/**
 * A short administrative context line for one saved region, or `null` when there is nothing useful
 * to add. `중구` alone is ambiguous across Korea, so the record's own `adminArea1`/`2`/`3` are
 * joined — skipping blanks, duplicates, and any part that merely repeats the display name.
 *
 * Presentation-only: no coordinate, KMA grid, or internal id is ever read here.
 */
function describeAdministrativeContext(location: MobileSavedLocation): string | null {
  const parts: string[] = [];
  for (const area of [location.adminArea1, location.adminArea2, location.adminArea3]) {
    if (area === null) {
      continue;
    }
    const trimmed = area.trim();
    if (trimmed.length === 0 || trimmed === location.displayName || parts.includes(trimmed)) {
      continue;
    }
    parts.push(trimmed);
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

export interface SavedLocationSwitcherProps {
  /** The exact snapshot the host screen already read — never re-read or copied here. */
  readonly savedLocations: SavedLocationApplicationSnapshot;
}

/**
 * Renders the selected-region button and its saved-region sheet, or nothing at all when the
 * snapshot cannot name a selected region.
 *
 * `READY` with a `selectedLocationId` that resolves to a record is the only state that produces a
 * button: `NOT_STARTED` / `LOADING` / `SELECTION_LOADING` / `EMPTY` / `ERROR` — and the defensive
 * `READY`-with-missing-record case — render `null`, leaving each screen's existing state UI to
 * speak for them rather than fabricating a region name.
 */
export function SavedLocationSwitcher({ savedLocations }: SavedLocationSwitcherProps) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  // Whether the *last* dispatched mutation failed, and which one. Local presentation state for one
  // generic message — the store owns the committed state itself.
  const [writeFailure, setWriteFailure] = useState<SavedLocationWriteFailure | null>(null);

  const selectedLocation =
    savedLocations.status === 'READY'
      ? (savedLocations.locations.find(
          (location) => location.id === savedLocations.selectedLocationId,
        ) ?? null)
      : null;

  if (savedLocations.status !== 'READY' || selectedLocation === null) {
    return null;
  }

  const isSaving = savedLocations.writeStatus === 'SAVING';

  function openSheet(): void {
    setWriteFailure(null);
    setIsOpen(true);
  }

  function closeSheet(): void {
    setIsOpen(false);
  }

  // A successful select is the only thing that closes the sheet on its own; a failure leaves it
  // open and usable. No weather request, reset, retry, timer, or storage write happens here — the
  // committed selection change is the whole effect.
  async function handleSelect(locationId: string): Promise<void> {
    setWriteFailure(null);
    const result = await mobileSavedLocationApplicationStore.select(locationId);
    if (result.ok) {
      setIsOpen(false);
      return;
    }
    setWriteFailure('SELECT');
  }

  // The sheet stays open after a successful removal so the remaining regions (and the store's own
  // fallback selection) stay visible. No next selection is computed here and the array is never
  // touched directly; when the last region goes the parent snapshot becomes `EMPTY` and this whole
  // component stops rendering.
  async function handleRemove(locationId: string): Promise<void> {
    setWriteFailure(null);
    const result = await mobileSavedLocationApplicationStore.remove(locationId);
    if (!result.ok) {
      setWriteFailure('REMOVE');
    }
  }

  function handleAddLocation(): void {
    setIsOpen(false);
    router.push('/locations');
  }

  return (
    <View style={styles.container}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`지역 선택, 현재 ${selectedLocation.displayName}`}
        accessibilityState={{ expanded: isOpen }}
        onPress={openSheet}
        style={styles.trigger}
      >
        <Text style={styles.triggerLabel} numberOfLines={1}>
          {selectedLocation.displayName}
        </Text>
        <Text style={styles.triggerChevron}>▾</Text>
      </Pressable>

      {isOpen ? (
        <Modal animationType="slide" transparent visible onRequestClose={closeSheet}>
          <View style={styles.backdrop}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="지역 선택 배경 닫기"
              onPress={closeSheet}
              style={styles.backdropFill}
            />
            <View style={styles.sheet}>
              <View style={styles.sheetHeader}>
                <Text accessibilityRole="header" style={styles.sheetTitle}>
                  지역 선택
                </Text>
                <View style={styles.sheetHeaderTrailing}>
                  {isSaving ? <ActivityIndicator /> : null}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="지역 선택 닫기"
                    onPress={closeSheet}
                    style={styles.closeButton}
                  >
                    <Text style={styles.closeButtonLabel}>닫기</Text>
                  </Pressable>
                </View>
              </View>

              <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
                {savedLocations.locations.map((location) => {
                  const isSelected = location.id === savedLocations.selectedLocationId;
                  const selectDisabled = isSelected || isSaving;
                  const context = describeAdministrativeContext(location);
                  return (
                    <View key={location.id} style={styles.row}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={
                          isSelected
                            ? `${location.displayName} 선택됨`
                            : `${location.displayName} 선택`
                        }
                        accessibilityState={{ selected: isSelected, disabled: selectDisabled }}
                        disabled={selectDisabled}
                        onPress={() => {
                          void handleSelect(location.id);
                        }}
                        style={styles.rowMain}
                      >
                        <View style={styles.rowCheck}>
                          {isSelected ? <Text style={styles.rowCheckMark}>✓</Text> : null}
                        </View>
                        <View style={styles.rowLabels}>
                          <Text style={styles.rowName} numberOfLines={1}>
                            {location.displayName}
                          </Text>
                          {context !== null ? (
                            <Text style={styles.rowContext} numberOfLines={1}>
                              {context}
                            </Text>
                          ) : null}
                        </View>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${location.displayName} 삭제`}
                        accessibilityState={{ disabled: isSaving }}
                        disabled={isSaving}
                        onPress={() => {
                          void handleRemove(location.id);
                        }}
                        style={styles.rowDeleteButton}
                      >
                        <Text style={styles.rowDeleteLabel}>삭제</Text>
                      </Pressable>
                    </View>
                  );
                })}
              </ScrollView>

              {writeFailure !== null ? (
                <Text style={styles.errorText}>{WRITE_FAILURE_MESSAGES[writeFailure]}</Text>
              ) : null}

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="지역 추가"
                accessibilityState={{ disabled: isSaving }}
                disabled={isSaving}
                onPress={handleAddLocation}
                style={styles.addButton}
              >
                <Text style={styles.addButtonLabel}>+ 지역 추가</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

const SHEET_BACKGROUND = '#FFFFFF';
const TRIGGER_BACKGROUND = '#FFFFFF';
const TEXT_PRIMARY = '#16202B';
const TEXT_SECONDARY = '#5B6472';
const BORDER_COLOR = '#E1E7EF';
const ACCENT_COLOR = '#2F6FED';
const ERROR_COLOR = '#B3261E';

const styles = StyleSheet.create({
  container: {
    flexShrink: 1,
    marginLeft: 12,
  },
  trigger: {
    minHeight: 48,
    minWidth: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: BORDER_COLOR,
    backgroundColor: TRIGGER_BACKGROUND,
  },
  triggerLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: TEXT_PRIMARY,
    flexShrink: 1,
  },
  triggerChevron: {
    fontSize: 13,
    color: TEXT_SECONDARY,
  },
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(16,24,35,0.35)',
  },
  backdropFill: {
    flex: 1,
  },
  sheet: {
    backgroundColor: SHEET_BACKGROUND,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 18,
    paddingTop: 14,
    // Safe-area-like bottom breathing room, without a native safe-area dependency.
    paddingBottom: 28,
    gap: 10,
    maxHeight: '70%',
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sheetTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: TEXT_PRIMARY,
  },
  sheetHeaderTrailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  closeButton: {
    minHeight: 48,
    minWidth: 48,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  closeButtonLabel: {
    fontSize: 15,
    color: ACCENT_COLOR,
    fontWeight: '600',
  },
  list: {
    flexGrow: 0,
  },
  listContent: {
    paddingBottom: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: BORDER_COLOR,
  },
  rowMain: {
    flexShrink: 1,
    flexGrow: 1,
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  rowCheck: {
    width: 18,
    alignItems: 'center',
  },
  rowCheckMark: {
    fontSize: 15,
    color: ACCENT_COLOR,
    fontWeight: '700',
  },
  rowLabels: {
    flexShrink: 1,
    gap: 2,
  },
  rowName: {
    fontSize: 16,
    color: TEXT_PRIMARY,
  },
  rowContext: {
    fontSize: 12,
    color: TEXT_SECONDARY,
  },
  rowDeleteButton: {
    minHeight: 48,
    minWidth: 48,
    alignItems: 'flex-end',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  rowDeleteLabel: {
    fontSize: 14,
    color: TEXT_SECONDARY,
    fontWeight: '600',
  },
  errorText: {
    fontSize: 13,
    color: ERROR_COLOR,
  },
  addButton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ACCENT_COLOR,
  },
  addButtonLabel: {
    fontSize: 15,
    color: ACCENT_COLOR,
    fontWeight: '600',
  },
});
