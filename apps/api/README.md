# @life-weather/api

Hono API for Life Weather, structured for Vercel's zero-configuration Node.js function detection.

To develop locally (from the repository root):

```
pnpm install
pnpm dev:api
```

To type-check and test:

```
pnpm --filter @life-weather/api typecheck
pnpm --filter @life-weather/api test
```

This PR does not link this app to a real Vercel project. `vercel dev` will prompt to link/create
a project on first run; that step is intentionally deferred to a later PR.
