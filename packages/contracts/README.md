# @life-weather/contracts

Shared request/response contracts and runtime validation models for the boundary between the
mobile app and the API.

This package will hold the types (and, later, runtime validators) that both `@life-weather/mobile`
and `@life-weather/api` import so the two apps agree on the same shape of data without duplicating
type definitions.

## Scope in this PR

This PR only creates the package skeleton (buildable entry point, strict TypeScript config). It
does not define any weather request/response contracts or add a schema validation library — that
is deferred to the PR that implements the first real API integration.

## Principles

- Pure TypeScript, no runtime dependency on React Native, Node.js, or the browser.
- No side effects on import.
- No environment variable access.
- No network calls.
