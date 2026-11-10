# Publishing the agent-email-guard GitHub Action

Nothing here has been run. Do not create a repository, push a tag, or open a Marketplace listing from a cloud agent. The supervisor does that after this branch is on `main` and the public tree includes `action/`.

The action runtime is `lib/index.js` (built by `tsc -p tsconfig.build.json`). GitHub runs that file with Node 20. There is no `npm install` in the action.

## A. Use it from the existing public repository

`github.com/agentisend/agent-email-guard` is the split of `oss/agent-guard/` (`scripts/oss-agent-guard-mirror.sh --push` in the parent [PUBLISH.md](../PUBLISH.md)). After this directory is in that repository:

```bash
# in the public repository, on the commit that contains action/action.yml
git tag v1
git tag v1.0.0
git push origin v1 v1.0.0
```

Users then write:

```yaml
uses: agentisend/agent-email-guard/action@v1
```

Pin `v1` to the newest 1.x commit when you ship a later tag, and leave `v1.0.0` on this commit. This path does not appear in the GitHub Marketplace. Marketplace reads `action.yml` from the repository root, and this file lives at `action/action.yml`.

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
