# @life-weather/weather-core

Home for weather-domain logic: normalizing provider-specific weather codes (e.g. KMA) into a
common internal weather state, and other weather domain calculations.

## Scope in this PR

This PR only creates the package skeleton (buildable entry point, strict TypeScript config). It
does not implement any KMA code mapping or weather calculations — that is deferred to the PR that
implements the first real weather provider integration.

## Principles

- Pure TypeScript, no runtime dependency on React Native, Node.js, or the browser.
- No side effects on import.
- No environment variable access.
- No network calls.
