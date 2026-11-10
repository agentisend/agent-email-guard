# Publishing agent-email-guard-proxy

Not run. The supervisor publishes. Do not publish from a cloud agent.

The package name is `agent-email-guard-proxy`. It is not prefixed with `resend-`.

From a checkout that already contains `oss/agent-guard/` (the public mirror is that directory as the repo root, so the path there is `resend-proxy/`):

```bash
cd resend-proxy
pnpm install --frozen-lockfile
pnpm typecheck && pnpm test && pnpm build
npm pack --dry-run
```

Publish from the public repository so npm provenance matches `github.com/agentisend/agent-email-guard`:

```bash
npm publish --access public
```

The dependency is `agent-email-guard@0.1.0`, which is already on npm. The mirror script (`scripts/oss-agent-guard-mirror.sh` in the monorepo) includes this directory because it splits `oss/agent-guard/`. Run the mirror before the first publish so the README on GitHub matches the tarball.
