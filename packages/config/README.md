# @life-weather/config

Home for shared, non-secret configuration and constants that are safe to reuse across the
monorepo (e.g. supported regions, feature flags, shared numeric thresholds).

## Scope in this PR

This PR only creates the package skeleton (buildable entry point, strict TypeScript config). It
does not define any constants yet.

## Principles

- Pure TypeScript, no runtime dependency on React Native, Node.js, or the browser.
- No side effects on import.
- No environment variable access.
- No network calls.
- Never put server API keys or AdMob production IDs in this package — those belong only in the
  API app's environment configuration (see `apps/api/.env.example`), never in shared/client code.
