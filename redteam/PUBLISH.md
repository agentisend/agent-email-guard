# Publish commands

Do not run these from a development session. Nothing in this file has been executed.

Package name: `agent-email-guard-test`.
Bin: `agent-email-guard-test`.
Public invocation: `npx agent-email-guard test`, forwarded by the `agent-email-guard` CLI to this bin. This package does not publish that forwarder.

```bash
cd oss/agent-guard/redteam
# 1. Remove "private": true from package.json.
# 2. Confirm `pnpm test` and `pnpm typecheck` in this directory are green.
npm publish --access public
```

Do not `npm publish` any other name from this directory. Do not publish to PyPI from here.
