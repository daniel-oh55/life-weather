/**
 * The shared stale-data notice used by every weather-consuming tab (오늘 / 예보 / 생활날씨 /
 * 상세기상).
 *
 * Staleness is not a network/query lifecycle state — the store's `IDLE`/`LOADING`/`SUCCESS`/`ERROR`
 * union is unchanged. It is a *presentation* property of the current `SUCCESS` snapshot: how old the
 * app's last successful `/weather` response is, derived only from that response's own
 * `meta.generatedAt`. This is the age of the app's last successful response — not a claim that every
 * upstream observation it carries is itself exactly that old.
 *
 * This module owns the small pure classifier ({@link classifyMobileWeatherFreshness}) and the
 * one-shot presentation timer that re-evaluates it when the fixed threshold is crossed, so a screen
 * that keeps showing an unchanged `SUCCESS` snapshot still turns visually stale without any new
 * network/store event. It never calls the API itself — `onRefresh` is the caller's exact dispatch
 * (the query store's `refresh()`), invoked at most once per press.
 *
 * A host screen renders this component only while its own `weatherQuery.status === 'SUCCESS'`; it
 * renders nothing itself (`null`) while `FRESH`, so mounting it unconditionally on every `SUCCESS`
 * render is safe and never shows anything for `IDLE`/`LOADING`/`ERROR`.
 */

import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

/** Presentation-only freshness of the current `SUCCESS` snapshot. Never a query-store state. */
export type MobileWeatherFreshness = 'FRESH' | 'STALE';

/** Fixed 1.0 mobile presentation threshold: 60 minutes. Exactly 60 minutes counts as stale. */
export const MOBILE_WEATHER_STALE_AFTER_MILLISECONDS = 60 * 60 * 1000;

/**
 * Pure, deterministic, defensive classification of `generatedAt`'s age against
 * {@link MOBILE_WEATHER_STALE_AFTER_MILLISECONDS} as of `referenceEpochMilliseconds`. Never throws.
 *
 * - age below the threshold → `FRESH`; age at or over it → `STALE`.
 * - a `generatedAt` in the future (negative age) → `FRESH`, tolerating ordinary server/device clock
 *   skew rather than a naive "always stale" collapse.
 * - an unparseable `generatedAt` → `STALE` (defensive only: a `SUCCESS` response's `meta.generatedAt`
 *   is already contract-validated, so this path is not expected in production).
 * - a non-finite `referenceEpochMilliseconds` → `STALE`, defensively.
 */
export function classifyMobileWeatherFreshness(
  generatedAt: string,
  referenceEpochMilliseconds: number,
): MobileWeatherFreshness {
  if (!Number.isFinite(referenceEpochMilliseconds)) {
    return 'STALE';
  }
  const generatedAtEpochMilliseconds = Date.parse(generatedAt);
  if (!Number.isFinite(generatedAtEpochMilliseconds)) {
    return 'STALE';
  }
  const ageMilliseconds = referenceEpochMilliseconds - generatedAtEpochMilliseconds;
  return ageMilliseconds >= MOBILE_WEATHER_STALE_AFTER_MILLISECONDS ? 'STALE' : 'FRESH';
}

export interface WeatherFreshnessNoticeProps {
  /** The current `SUCCESS` snapshot's `data.meta.generatedAt`, verbatim — never re-derived. */
  readonly generatedAt: string;
  /** Invoked at most once per press. Never called automatically by this component's own timer. */
  readonly onRefresh: () => void;
}

/**
 * Renders nothing while `FRESH`. While `STALE`, renders one compact, non-alarming notice plus an
 * explicit `새로고침` button — the existing weather content stays exactly as the host screen already
 * rendered it; this component never re-renders, hides, or fabricates any of it.
 *
 * `freshness` is real state, seeded once from a `useState` lazy initializer (the one place a render
 * may read the impure `Date.now()`, since it runs during this component's own initial render, before
 * commit) and afterwards updated only from inside a `setTimeout` callback — never synchronously in
 * the effect body itself, so every update is a genuine set-state-in-a-callback, never a render-time
 * or effect-body side effect.
 *
 * On the initial mount and on every `generatedAt` change, the effect always arms a same-tick (`0ms`)
 * reconcile timer first. Its callback reclassifies against the current time, updates `freshness` to
 * match, and — only if that reclassification is still `FRESH` — arms exactly one further `setTimeout`
 * for the remaining time until the threshold, which reclassifies (and, by then, necessarily settles
 * to `STALE`) when it fires. So a mounted instance's visible freshness is corrected on the very next
 * tick for any `generatedAt` change — it is never left showing a stale notice (or a fresh one) until
 * some unrelated future deadline — while at most one `setTimeout` (never `setInterval`) is ever
 * pending at a time. Each reconcile step reassigns the same `timer` variable the effect closes over,
 * so the effect's cleanup — on unmount or the next `generatedAt` change — always clears whichever
 * timer is currently outstanding.
 */
export function WeatherFreshnessNotice({ generatedAt, onRefresh }: WeatherFreshnessNoticeProps) {
  const [freshness, setFreshness] = useState<MobileWeatherFreshness>(() =>
    classifyMobileWeatherFreshness(generatedAt, Date.now()),
  );

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    const reconcile = () => {
      const now = Date.now();
      const current = classifyMobileWeatherFreshness(generatedAt, now);
      setFreshness(current);

      if (current === 'FRESH') {
        const generatedAtEpochMilliseconds = Date.parse(generatedAt);
        const delayMilliseconds = Number.isFinite(generatedAtEpochMilliseconds)
          ? Math.max(0, generatedAtEpochMilliseconds + MOBILE_WEATHER_STALE_AFTER_MILLISECONDS - now)
          : 0;
        timer = setTimeout(reconcile, delayMilliseconds);
      }
    };

    timer = setTimeout(reconcile, 0);

    return () => {
      clearTimeout(timer);
    };
  }, [generatedAt]);

  if (freshness !== 'STALE') {
    return null;
  }

  return (
    <View style={styles.container}>
      <Text style={styles.message}>마지막 날씨 업데이트가 1시간 이상 지났어요.</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="날씨 새로고침"
        onPress={onRefresh}
        style={styles.button}
      >
        <Text style={styles.buttonLabel}>새로고침</Text>
      </Pressable>
    </View>
  );
}

const NOTICE_BACKGROUND = '#FFF8EF';
const NOTICE_BORDER = '#F2C89B';
const NOTICE_TEXT = '#7A5A22';
const BUTTON_BACKGROUND = '#FFFFFF';
const BUTTON_BORDER = '#E7B876';

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 10,
    backgroundColor: NOTICE_BACKGROUND,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: NOTICE_BORDER,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  message: {
    flexShrink: 1,
    flexBasis: 180,
    fontSize: 13,
    lineHeight: 19,
    color: NOTICE_TEXT,
    flexWrap: 'wrap',
  },
  button: {
    minHeight: 48,
    minWidth: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: BUTTON_BORDER,
    backgroundColor: BUTTON_BACKGROUND,
  },
  buttonLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: NOTICE_TEXT,
  },
});
