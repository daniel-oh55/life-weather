# @life-weather/lifestyle-engine

Home for deterministic "life weather" calculations derived from normalized weather data — umbrella,
mask, outfit, laundry, car wash, exercise, and commute recommendations.

## Scope in this PR

This PR only creates the package skeleton (buildable entry point, strict TypeScript config). It
does not implement any scoring rules or calculation functions — that is deferred to the PR that
implements the first life-weather index.

## Principles

- Pure TypeScript, no runtime dependency on React Native, Node.js, or the browser.
- No side effects on import.
- No environment variable access.
- No network calls.
