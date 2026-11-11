# Publishing the agent-email-guard GitHub Action

Published 2026-11-10: `agentisend/agent-email-guard-action`, tags `v1` and `v1.0.0`, listed on the Marketplace. Do not create a repository, push a tag, or change the listing from a cloud agent.

The action runtime is `lib/index.js` (built by `tsc -p tsconfig.build.json`). GitHub runs that file with Node 20. There is no `npm install` in the action.

## A. No tags on the library repository

Do not tag `v1` or `v1.0.0` on `github.com/agentisend/agent-email-guard`. Packagist reads every tag there as a version of the PHP library, so a `v1.0.0` tag published the 0.1 library as 1.0.0 (tags removed 2026-11-11). The only supported path is `uses: agentisend/agent-email-guard-action@v1`.

## B. List it on GitHub Marketplace

Marketplace requires `action.yml` at the root of a public repository, and a release tag.

1. Create an empty public repository `agentisend/agent-email-guard-action`. Decline the GitHub prompt that adds a README, a license, or a `.gitignore`. This document does not create the repository.
2. Push the contents of `oss/agent-guard/action/` so `action.yml` is at the root of that repository (the `action/` prefix is not part of the path there).
3. Tag and push `v1` and `v1.0.0`.
4. Open a GitHub Release for `v1.0.0`. Check **Publish this Action to the GitHub Marketplace**. Primary category: Security. Secondary: Utilities. Accept the Marketplace agreement.
5. The README on that repository is the listing. Users then write `uses: agentisend/agent-email-guard-action@v1`.

The badge in the README is a workflow badge for the repository that runs the check (`USER/REPO`). It is not a Marketplace badge. The check appears on pull requests as a warning annotation, or as a failed check when `fail` is `true`.

## Rebuild `lib/` before either tag

From the monorepo, with the root TypeScript install:

```bash
pnpm exec tsc -p oss/agent-guard/action/tsconfig.build.json
node --test oss/agent-guard/action/test/*.test.mjs
```

Commit `lib/` with the source. The public action does not compile on the runner.
