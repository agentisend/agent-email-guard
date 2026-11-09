# Publishing agent-email-guard

Nothing here has been run. The orchestrating session runs launch day: the public repository first, then the four registries, then the announcement. Every command below is a human-approved, outward-facing action.

## 0. Before anything

From the monorepo, on `main`, clean tree:

```bash
cd oss/agent-guard/node
pnpm install --frozen-lockfile
pnpm typecheck && pnpm test && pnpm build && pnpm vectors:check
npm pack --dry-run        # expect dist/, README.md, LICENSE, package.json only
```

The Python, PHP and Go directories run their own suites (see CONTRIBUTING.md). All four must pass the same `spec/vectors`.

## 1. Mirror to github.com/agentisend/agent-email-guard

The public repository is `oss/agent-guard/` of this monorepo, split out with history:

```bash
scripts/oss-agent-guard-mirror.sh            # dry run: builds the split branch, prints what it would push
scripts/oss-agent-guard-mirror.sh --push     # pushes the split to github.com/agentisend/agent-email-guard main
```

What the script does:

```bash
git subtree split --prefix=oss/agent-guard -b agent-email-guard-public
git push git@github.com:agentisend/agent-email-guard.git agent-email-guard-public:main
```

The first push needs the empty repository to exist (`agentisend` org, no README/licence initialised by GitHub). After it, in the public repo's settings: description "Budgets, rate ceilings, loop detection, a kill switch and approval holds for AI agents that send email.", topics `ai-agents email rate-limiting human-in-the-loop nodemailer resend ses postmark`, and enable Actions so `.github/workflows/agent-email-guard.yml` runs. The `.github/` directory sits at the root of the split, which is where GitHub reads it.

Later syncs run the same script; `git subtree split` is deterministic, so the public history only grows. The first split walks the monorepo's whole history and takes many minutes (it did not finish inside 5 minutes under load on 2026-11-09); run it when the machine is quiet.

## 2. npm (with provenance)

Provenance needs the publish to run from GitHub Actions in the public repository (npm checks the workflow's OIDC token against the repository in `package.json`). Add this job to the public repo, or run it once by hand:

```yaml
# .github/workflows/release-node.yml (public repo)
on: { push: { tags: ['node-v*'] } }
permissions: { contents: read, id-token: write }
jobs:
  publish:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: node } }
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { package_json_file: node/package.json }
      - uses: actions/setup-node@v4
        with: { node-version: 22, registry-url: 'https://registry.npmjs.org' }
      - run: pnpm install --frozen-lockfile && pnpm test && pnpm build
      - run: npm publish --provenance --access public
        env: { NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}' }
```

Owner steps: create an npm automation token with publish rights on the `@agentisend` scope, store it as `NPM_TOKEN` in the public repo's secrets, then:

```bash
git tag node-v0.1.0 && git push origin node-v0.1.0     # in the public repo
```

Manual fallback (no provenance badge), from `oss/agent-guard/node`:

```bash
npm publish --access public
```

Check: `npm view agent-email-guard version` prints `0.1.0`, `npx agent-email-guard --help` prints the usage, and the npm page shows "Built and signed on GitHub Actions".

The npm name is the unscoped `agent-email-guard` (the scope is not needed; `agent-guard` itself is taken by an unrelated project). The private monorepo package `packages/agent-guard` (`@agentisend/agent-guard`, `"private": true`) is never published and is unrelated to this release.

The package also ships the `agent-email-guard` CLI (`bin`). Its `mcp`, `hook` and `test` subcommands run `npx --yes agent-email-guard-mcp` / `agent-email-guard-test`, so publish those two packages (oss/agent-guard/mcp and oss/agent-guard/redteam) on the same day or the forwarding fails.

## 3. PyPI, Packagist, Go

- **PyPI** `agent-email-guard`: see `python/` (build with `python -m build`, upload with `twine upload dist/*`, or trusted publishing from the public repo).
- **Packagist** `agentisend/agent-email-guard`: Packagist needs `composer.json` at the repository root, but it lives in `php/`. Either split `php/` to its own repo (`git subtree split --prefix=php`) and submit that, or keep a `composer.json` at the root that points `autoload` at `php/src`. The PHP session's notes say which.
- **Go** `github.com/agentisend/agent-email-guard/go`: no registry. Tag the module path: `git tag go/v0.1.0 && git push origin go/v0.1.0` in the public repo, then request `https://proxy.golang.org/github.com/agentisend/agent-email-guard/go/@v/v0.1.0.info` once to warm the proxy.

## 4. After publishing

- `npm view`, `pip index versions agent-email-guard`, the Packagist page and `go list -m github.com/agentisend/agent-email-guard/go@v0.1.0` each show 0.1.0.
- The public repo's Actions run is green on all four jobs.
- Install from each registry into an empty project and run the README example.
