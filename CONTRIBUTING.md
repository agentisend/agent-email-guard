# Contributing

Thanks for helping. agent-email-guard is four implementations of one specification, so most changes touch more than one directory.

## The rule

`spec/SPEC.md` and `spec/vectors/*.json` are the contract. A change in behaviour, a reason token or a message is a spec change first:

1. Edit `spec/SPEC.md`.
2. Change the Node implementation (`node/src`) and the scenario list in `node/scripts/gen-vectors.ts`.
3. Regenerate the vectors: `cd node && npm run vectors`. Never edit an `expect` block by hand.
4. Make Python, PHP and Go pass the new vectors in the same pull request, or open it as a draft and say which ports are left.

A bug fix that makes one port match the spec needs no spec change; add a vector case that would have caught it.

## Running the tests

| Directory | Command |
|---|---|
| `node/` | `npm ci && npm run typecheck && npm test` |
| `python/` | `pip install -e '.[test]' && pytest` |
| `php/` | `composer install && vendor/bin/phpunit` |
| `go/` | `go test -race ./...` |

Every suite runs every file in `spec/vectors/`. CI (`.github/workflows/agent-email-guard.yml`) runs all four on each pull request.

## Scope

In scope: limits, loop signals, approval rules and stores that help an agent send the email its users asked for, safely. Out of scope: anything that makes unsolicited bulk sending easier (list building, rotation to dodge limits, evading a provider's checks). Pull requests of that kind are closed.

## Style

- Messages are one sentence ending in a period, with numbers rather than adjectives.
- No runtime dependencies in any core package. Stores that need a client take it as an optional dependency.
- Tests are named for the behaviour they pin.

## Releases

Maintainers release all four packages together at the same minor version (see the spec's versioning section).
