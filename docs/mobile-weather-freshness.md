# Mobile weather response freshness (PR #104)

Minimal 1.0 vertical slice for presenting how old the app's last successful weather response is,
and letting the user explicitly refresh it.

## What this is

- A **60-minute mobile presentation threshold** (`MOBILE_WEATHER_STALE_AFTER_MILLISECONDS`,
  `apps/mobile/src/components/weather-freshness-notice.tsx`): `age < 60m` is `FRESH`,
  `age >= 60m` is `STALE`. Exactly 60 minutes counts as stale.
- Derived only from the already-validated response's own `data.meta.generatedAt`
  (`WeatherSuccessResponseV1`). This is the age of the app's last successful `/weather`
  response — **not** a claim that every upstream observation the response carries is itself
  exactly that old, and not a KMA/AirKorea provider validity policy.
- A shared presentation component, `WeatherFreshnessNotice`, mounted by all four
  weather-consuming tabs (오늘 / 예보 / 생활날씨 / 상세기상) whenever their weather query is
  `SUCCESS`. It renders nothing while `FRESH`; while `STALE` it shows one compact, non-alarming
  notice ("마지막 날씨 업데이트가 1시간 이상 지났어요.") plus a `새로고침` button, alongside the
  existing weather content — which stays exactly as already rendered.

## What this is not

- **No new `STALE` query-store state.** `MobileWeatherQuerySnapshot` remains exactly
  `IDLE` / `LOADING` / `SUCCESS` / `ERROR`. A stale snapshot is still a valid `SUCCESS`; staleness
  is a presentation property of that snapshot, not a network/lifecycle state.
- No device receipt timestamp, KMA base time, AirKorea data time, individual
  `SourceMetadata`, or provider-native timestamp is used or added.
- No `packages/contracts` change and no `CONTRACT_VERSION` bump.
- No automatic refresh, polling, `setInterval`, background task, push, or server-side
  cache/persistence.

## Presentation timer

`WeatherFreshnessNotice` classifies freshness synchronously on mount (`useState` initializer) and,
only while still `FRESH`, schedules exactly **one** `setTimeout` for the exact remaining time until
the response's `generatedAt + 60m` deadline — never a `setInterval` or polling loop. The timer is
cleared on unmount and whenever `generatedAt` changes (a new `SUCCESS` response). This lets a
screen that keeps showing an unchanged `SUCCESS` snapshot still turn visually stale with no new
network or store event.

## Query-store `refresh()`

`MobileWeatherQueryStore` gained one additive operation:

```ts
refresh(): void;
```

- **`SUCCESS`**: restarts the exact internally retained `WeatherRequestV1` (the same object
  reference `retry()` would use) through the existing `beginRequest()` path — the same
  generation/abort/reentrancy contract as `request()`/`retry()`, publishing `LOADING` and then
  settling to `SUCCESS`/`ERROR` through the existing result mapping. No refresh-specific error
  kind is introduced.
- **`IDLE` / `LOADING` / `ERROR`**: no-op. Because a second `refresh()` call while the first is
  still `LOADING` sees a non-`SUCCESS` snapshot, repeated taps can never start a duplicate request.
- `request()`'s signature and semantics are unchanged; `retry()` is unchanged and still owns the
  `ERROR` recovery path.

This PR intentionally does not introduce stale-while-revalidate presentation, a `REFRESHING`
state, a `refreshError`, or a combined stale-data-plus-network-error state — a refresh press is the
existing, already-tested `SUCCESS → LOADING → SUCCESS/ERROR` transition, which briefly replaces the
visible content with the screen's existing `LOADING` view. That tradeoff is accepted for 1.0.

## Files

- `apps/mobile/src/weather-query/mobile-weather-query-store.ts` — `refresh()`.
- `apps/mobile/src/components/weather-freshness-notice.tsx` — classifier, threshold, component.
- `apps/mobile/src/app/(tabs)/index.tsx`, `hourly.tsx`, `lifestyle.tsx`, `details.tsx` — mount the
  shared notice on `SUCCESS`, wired to `data.meta.generatedAt` and `mobileWeatherQueryStore.refresh()`.
