# Publish agent-email-guard-mcp

Do not run these until launch day. Nothing in this file has been executed.

```bash
cd oss/agent-guard/mcp
pnpm install --ignore-workspace
pnpm test
pnpm run build
npm publish
```

The package name is the unscoped `agent-email-guard-mcp`. Bins: `agent-email-guard` and `agent-email-guard-mcp`.

When `oss/agent-guard/node` publishes `agent-email-guard`, that package owns the `agent-email-guard` bin and should forward `hook` and `mcp` here. Drop this package's `agent-email-guard` bin in the same change so the two packages do not both install that name.
