# Publish agent-email-guard-mcp

Do not run these. Nothing in this file has been executed. 0.2.0 is not published.

```bash
cd oss/agent-guard/mcp
pnpm install --ignore-workspace
pnpm test
pnpm run build
npm publish
```

The package name is the unscoped `agent-email-guard-mcp` at version 0.2.0. The only bin is `agent-email-guard-mcp`.

`agent-email-guard` 0.1.0 (published) owns the `agent-email-guard` bin and forwards `hook` and `mcp` to this package. This package depends on that library for `createGuard`, `check` / `record` / `release`, and `loadPolicy`.
